/**
 * Resolves the tools' `object_type` (+ optional `schema_id`) to a workspace
 * base schema. Base schemas are listed once per server instance and cached;
 * a miss (unknown id, or no schema for a type) refreshes the cache once, so a
 * schema created after startup is still found.
 */
import * as z from "zod/v4";
import type { HeliyosClient } from "../client/http.js";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";

/** The object categories a tool can target: the three built-in ones plus custom objects. */
export const OBJECT_TYPES = ["company", "person", "deal", "custom"] as const;
/** One of the values in OBJECT_TYPES. */
export type ObjectCategory = (typeof OBJECT_TYPES)[number];

/** Stored `objectType` values per category (the platform uses both spellings). */
const CATEGORY_BY_STORED_TYPE: Record<string, Exclude<ObjectCategory, "custom">> = {
  company: "company",
  companies: "company",
  person: "person",
  people: "person",
  deal: "deal",
  deals: "deal",
};

/** Maps a stored `objectType` value, in singular or plural form, to its category. Anything unknown or not a string is "custom". */
export function categoryOf(storedObjectType: unknown): ObjectCategory {
  return typeof storedObjectType === "string"
    ? (CATEGORY_BY_STORED_TYPE[storedObjectType.toLowerCase()] ?? "custom")
    : "custom";
}

/** One field of a base schema, as the tools need it. */
export interface SchemaField {
  name: string;
  displayName?: string;
  sequence: number;
}

/** A workspace base schema reduced to what the tools use: id, names, category and ordered fields. */
export interface BaseSchemaInfo {
  id: string;
  name: string;
  objectType: string;
  category: ObjectCategory;
  /** "base" | "computed" | "custom" on the platform. */
  kind?: string;
  /** Sorted by sequence. */
  fields: SchemaField[];
}

const RawField = z.looseObject({
  name: z.string().min(1),
  displayName: z.string().optional().catch(undefined),
  sequence: z.number().optional().catch(undefined),
});

const RawSchema = z.looseObject({
  id: z.string().optional(),
  _id: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  objectType: z.string(),
  type: z.string().optional(),
  fields: z.array(z.unknown()).optional(),
});

function toSchemaInfo(raw: unknown): BaseSchemaInfo | undefined {
  const parsed = RawSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  const id = s.id ?? s._id;
  if (!id) return undefined;
  const fields = (s.fields ?? [])
    .map((f) => RawField.safeParse(f))
    .filter((r) => r.success)
    .map((r, index) => ({
      name: r.data.name,
      ...(r.data.displayName ? { displayName: r.data.displayName } : {}),
      sequence: r.data.sequence ?? Number.MAX_SAFE_INTEGER - 1000 + index,
    }))
    .sort((a, b) => a.sequence - b.sequence);
  return {
    id,
    name: s.name ?? s.slug ?? s.objectType,
    objectType: s.objectType,
    category: categoryOf(s.objectType),
    ...(s.type ? { kind: s.type } : {}),
    fields,
  };
}

const describe = (s: BaseSchemaInfo) => `${s.name} (schema_id ${s.id})`;

/** How long, in milliseconds, a loaded schema list stays fresh before it is read again. */
export const SCHEMA_CACHE_TTL_MS = 5 * 60_000;
const MAX_LISTED_FIELD_KEYS = 60;

/** Looks up base schemas for the tools, backed by a short-lived cache of the workspace's schema list. */
export interface SchemaResolver {
  /** The schema a tool call targets. Throws VALIDATION_FAILED / NOT_FOUND with the available schemas. */
  resolve(objectType: ObjectCategory, schemaId?: string): Promise<BaseSchemaInfo>;
  /** Best-effort lookup by id (for rendering); undefined when unknown or the list fails. */
  find(schemaId: string | undefined): Promise<BaseSchemaInfo | undefined>;
  /**
   * Throws VALIDATION_FAILED when `keys` contains keys that are not fields of
   * `schema`, after re-reading the schema list once (a field may be new).
   */
  assertFieldKeys(schema: BaseSchemaInfo, keys: readonly string[]): Promise<void>;
  /** Drops the cached list; the next call re-reads it (after an object is created, renamed or deleted). */
  invalidate(): void;
}

/** Optional settings for createSchemaResolver; both exist mainly so tests can control cache expiry. */
export interface SchemaResolverOptions {
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Keys a record's `data` accepts: non-dotted field names, `<field>_image`, and `relationships`. */
export function writableFieldKeys(schema: BaseSchemaInfo): Set<string> {
  const names = schema.fields.map((f) => f.name).filter((name) => !name.includes("."));
  return new Set([...names, ...names.map((name) => `${name}_image`), "relationships"]);
}

function unknownKeys(schema: BaseSchemaInfo, keys: readonly string[]): string[] {
  const valid = writableFieldKeys(schema);
  return keys.filter((key) => !valid.has(key));
}

/** Creates a SchemaResolver that reads schemas through `client`. `options` can change the cache lifetime and the clock. */
export function createSchemaResolver(client: HeliyosClient, options: SchemaResolverOptions = {}): SchemaResolver {
  const ttlMs = options.ttlMs ?? SCHEMA_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cache: BaseSchemaInfo[] | undefined;
  let loadedAt = 0;
  let inflight: Promise<BaseSchemaInfo[]> | undefined;
  /** Lookups that missed since the last load; they do not trigger another reload until the TTL expires. */
  let missed = new Set<string>();

  const isFresh = () => cache !== undefined && now() - loadedAt < ttlMs;

  const reload = (): Promise<BaseSchemaInfo[]> => {
    if (!inflight) {
      inflight = callOperation(client, "listBaseSchemas")
        .then(({ data }) => {
          cache = expectArray(data, "base schema list")
            .map(toSchemaInfo)
            .filter((s): s is BaseSchemaInfo => s !== undefined);
          loadedAt = now();
          missed = new Set();
          return cache;
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  };

  /**
   * Runs `pick` on the schema list. A miss on a list that was not loaded by
   * this call re-reads it once, unless the same miss already happened since the
   * last load (negative cache), so a bad id cannot cost a request every call.
   */
  const withRefresh = async <T>(missKey: string, pick: (list: BaseSchemaInfo[]) => T | undefined) => {
    const loadedNow = !isFresh();
    let list = loadedNow ? await reload() : cache!;
    let found = pick(list);
    if (found === undefined && !loadedNow && !missed.has(missKey)) {
      list = await reload();
      found = pick(list);
    }
    if (found === undefined) missed.add(missKey);
    return { found, list };
  };

  return {
    invalidate() {
      cache = undefined;
      loadedAt = 0;
      missed = new Set();
    },

    async resolve(objectType, schemaId) {
      if (schemaId !== undefined) {
        const { found, list } = await withRefresh(`id:${schemaId}`, (all) => all.find((s) => s.id === schemaId));
        if (!found) {
          throw new HeliyosApiError(
            "VALIDATION_FAILED",
            `No object schema has schema_id ${schemaId}. Available: ${list.map(describe).join(", ") || "none"}`,
            0
          );
        }
        if (objectType !== "custom" && found.category !== objectType) {
          throw new HeliyosApiError(
            "VALIDATION_FAILED",
            `schema_id ${schemaId} is the ${found.name} object (object_type ${found.category}), not ${objectType}`,
            0
          );
        }
        return found;
      }

      if (objectType === "custom") {
        const list = isFresh() ? cache! : await reload();
        const custom = list.filter((s) => s.category === "custom");
        throw new HeliyosApiError(
          "VALIDATION_FAILED",
          custom.length > 0
            ? `object_type "custom" needs schema_id. Custom objects in this workspace: ${custom.map(describe).join(", ")}`
            : `object_type "custom" needs schema_id, and this workspace has no custom objects`,
          0
        );
      }

      const { found, list } = await withRefresh(`type:${objectType}`, (all) => {
        const matches = all.filter((s) => s.category === objectType);
        return matches.find((s) => s.kind === "base") ?? matches[0];
      });
      if (!found) {
        throw new HeliyosApiError(
          "NOT_FOUND",
          `This workspace has no ${objectType} object. Available: ${list.map(describe).join(", ") || "none"}`,
          0
        );
      }
      return found;
    },

    async find(schemaId) {
      if (!schemaId) return undefined;
      try {
        return (await withRefresh(`id:${schemaId}`, (all) => all.find((s) => s.id === schemaId))).found;
      } catch {
        return undefined;
      }
    },

    async assertFieldKeys(schema, keys) {
      if (unknownKeys(schema, keys).length === 0) return;
      // A field may have been added since the list was read: re-read once.
      const { found } = await withRefresh(`fields:${schema.id}:${keys.join(",")}`, (all) => {
        const fresh = all.find((s) => s.id === schema.id);
        return fresh && unknownKeys(fresh, keys).length === 0 ? fresh : undefined;
      });
      if (found) return;
      const current = (cache ?? []).find((s) => s.id === schema.id) ?? schema;
      const unknown = unknownKeys(current, keys);
      const names = current.fields.map((f) => f.name).filter((name) => !name.includes("."));
      const listed = names.slice(0, MAX_LISTED_FIELD_KEYS).join(", ");
      const more = names.length > MAX_LISTED_FIELD_KEYS ? `, and ${names.length - MAX_LISTED_FIELD_KEYS} more` : "";
      throw new HeliyosApiError(
        "VALIDATION_FAILED",
        `${unknown.length === 1 ? "Unknown field key" : "Unknown field keys"} for the ${current.name} object: ${unknown.join(", ")}. ` +
          `Valid field keys: ${listed || "none"}${more} (plus relationships, and <field>_image for image fields)`,
        0
      );
    },
  };
}
