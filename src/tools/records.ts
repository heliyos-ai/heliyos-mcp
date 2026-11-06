/**
 * Records: rows of the workspace's objects (companies, people, deals and custom
 * objects). Six tools, one operation each: list, get, create, update, delete,
 * lookup. `object_type` (+ `schema_id` for custom objects) picks the object;
 * see baseSchemas.ts for how that resolves.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitBlocks, fitTable, formatValue, MAX_TEXT_CHARS, renderRecord, type TableLayout } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  categoryOf,
  OBJECT_TYPES,
  type BaseSchemaInfo,
  type ObjectCategory,
} from "./baseSchemas.js";
import {
  CREATES,
  cursorInput as cursor,
  dateOf,
  hexId,
  idOf,
  label,
  LIST_TRUNCATION_HINT,
  OBJECT_ID,
  pageLimit as pageLimitOf,
  pagedQuery,
  plural,
  responseFormat as responseFormatOf,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";


// ---------------------------------------------------------------- inputs

const LOOKUP_INDEX_SIZE = 2000;
const CONCISE_FIELD_COUNT = 5;
const CONCISE_VALUE_CHARS = 200;
/** One record's block in a detailed list; longer blocks point to heliyos_records_get. */
const DETAILED_BLOCK_CHARS = 4000;

const recordId = hexId;

/** The `object_type` tool input: which kind of record the call targets. */
export const objectType = z
  .enum(OBJECT_TYPES)
  .describe('Which object: "company", "person", "deal", or "custom" (custom objects also need schema_id).');

/** The optional `schema_id` tool input, needed to pick a custom object. */
export const schemaId = z
  .string()
  .regex(OBJECT_ID, "schema_id must be a 24-character hex id")
  .optional()
  .describe("Object schema id. Required when object_type is \"custom\"; the error lists the available ones.");

const responseFormat = responseFormatOf("the name and key fields", "every field and linked records");

const pageLimit = pageLimitOf("Records");

const fieldValues = z
  .record(z.string().min(1), z.unknown())
  .refine((v) => Object.keys(v).length > 0, "fields must contain at least one field")
  .describe(
    "Field values keyed by the object's field keys (for example company_name, domain, people_name, email, deal_name, stage). " +
      "Unknown keys are rejected with the list of valid keys. " +
      "`relationships` takes an array of record ids to link to this record (for example a person's company); " +
      "linking adds to the existing links, and updates never remove links."
  );

const TEXT_OPERATORS = ["contains", "notContains", "startsWith", "endsWith"] as const;
const NO_VALUE_OPERATORS = ["empty", "notEmpty"] as const;
const FILTER_OPERATORS = [
  ...TEXT_OPERATORS,
  "equals",
  "notEquals",
  ...NO_VALUE_OPERATORS,
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "after",
  "before",
] as const;

const filterCondition = z.strictObject({
  field: z
    .string()
    .min(1)
    .max(200)
    .describe("Field key, for example stage or domain. createdAt, updatedAt and isAgentAssigned also work."),
  operator: z
    .enum(FILTER_OPERATORS)
    .describe(
      "How to compare: contains, notContains, startsWith, endsWith (text); equals, notEquals; empty, notEmpty (no value); " +
        "greaterThan, greaterThanOrEqual, lessThan, lessThanOrEqual (numbers); after, before (dates)."
    ),
  value: z
    .union([z.string().max(1000), z.number(), z.boolean()])
    .optional()
    .describe(
      "Value to compare with. Text operators (contains, notContains, startsWith, endsWith) need text; " +
        "a comma in a contains value matches any of the parts. Omit for empty and notEmpty. Dates as ISO 8601."
    ),
});
type FilterCondition = z.infer<typeof filterCondition>;

/**
 * Rules the platform does not enforce but silently widens results on: a text
 * operator with a non-text value matches every record, and so on.
 */
export function assertValidFilters(filters: readonly FilterCondition[]): void {
  const problems: string[] = [];
  filters.forEach((f, i) => {
    const where = `filters[${i}] (${f.field} ${f.operator})`;
    if ((TEXT_OPERATORS as readonly string[]).includes(f.operator)) {
      if (typeof f.value !== "string" || f.value.trim() === "") problems.push(`${where} needs a non-empty text value`);
    } else if ((NO_VALUE_OPERATORS as readonly string[]).includes(f.operator)) {
      if (f.value !== undefined) problems.push(`${where} takes no value`);
    } else if (f.value === undefined || (typeof f.value === "string" && f.value.trim() === "")) {
      problems.push(`${where} needs a value`);
    }
  });
  if (problems.length > 0) {
    throw new HeliyosApiError("VALIDATION_FAILED", `Invalid filters: ${problems.join("; ")}`, 0);
  }
}

// ---------------------------------------------------------------- outputs

const linkOut = z.object({
  id: z.string(),
  object_type: z.enum(OBJECT_TYPES),
  schema_id: z.string().optional(),
  name: z.string().optional(),
});
type LinkOut = z.infer<typeof linkOut>;

/** Output shape of one record in tool results: ids, name, fields, links and timestamps. */
export const recordOut = z.object({
  id: z.string(),
  object_type: z.enum(OBJECT_TYPES),
  schema_id: z.string().optional(),
  name: z.string(),
  fields: z.record(z.string(), z.unknown()),
  relationship_count: z.number().int(),
  relationships: z.array(linkOut).optional().describe("Linked records; only with response_format detailed."),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
/** The TypeScript type of a record in tool output, inferred from recordOut. */
export type RecordOut = z.infer<typeof recordOut>;

// ---------------------------------------------------------------- record shape

interface NormalizedRecord {
  id: string;
  category: ObjectCategory;
  schemaId?: string;
  data: Record<string, unknown>;
  links: LinkOut[];
  createdAt?: string;
  updatedAt?: string;
}

/** Relationships live beside `data` as [{objectId, schemaId, objectType, data?}]. */
function linksOf(raw: unknown): LinkOut[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((rel) => {
    const id = idOf(rel.objectId);
    if (!id) return [];
    const schema = idOf(rel.schemaId);
    const name = isRecord(rel.data) ? nameOf(rel.data) : "";
    return [
      {
        id,
        object_type: categoryOf(rel.objectType),
        ...(schema ? { schema_id: schema } : {}),
        ...(name ? { name } : {}),
      },
    ];
  });
}

/**
 * Reads a raw record from the Heliyos API into a NormalizedRecord. `fallbackCategory` is used when the record does not say its type.
 * Throws an INTERNAL HeliyosApiError when the value is not an object or has no id.
 */
export function normalizeRecord(raw: unknown, fallbackCategory?: ObjectCategory): NormalizedRecord {
  if (!isRecord(raw)) throw new HeliyosApiError("INTERNAL", "The API returned a record that is not an object", 0);
  const id = idOf(raw._id) ?? idOf(raw.id);
  if (!id) throw new HeliyosApiError("INTERNAL", "The API returned a record without an id", 0);
  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const created = isRecord(meta.created) ? meta.created.at : undefined;
  const updated = isRecord(meta.updated) ? meta.updated.at : undefined;
  const schemaId = idOf(raw.baseSchemaId);
  const createdAt = dateOf(created) ?? dateOf(raw.createdAt);
  const updatedAt = dateOf(updated) ?? dateOf(raw.updatedAt);
  return {
    id,
    category: raw.objectType !== undefined ? categoryOf(raw.objectType) : (fallbackCategory ?? "custom"),
    data: isRecord(raw.data) ? raw.data : {},
    links: linksOf(raw.relationships),
    ...(schemaId ? { schemaId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

const NAME_KEYS = ["company_name", "people_name", "deal_name", "name", "title"];

/** The field that names a record: the schema's first field, then the platform's fallback chain. */
function nameKeyOf(data: Record<string, unknown>, schema?: BaseSchemaInfo): string | undefined {
  const candidates = [schema?.fields[0]?.name, ...NAME_KEYS];
  return candidates.find((key) => key !== undefined && typeof data[key] === "string" && !isEmpty(data[key]));
}

function nameOf(data: Record<string, unknown>, schema?: BaseSchemaInfo): string {
  const key = nameKeyOf(data, schema);
  return key ? String(data[key]) : "";
}

const PREFERRED_KEYS = ["domain", "email", "job_title", "stage", "status", "amount", "website", "phone"];

/** Name field first, then the schema's fields in order (or common keys), skipping empty values. */
function keyFieldNames(data: Record<string, unknown>, schema?: BaseSchemaInfo): string[] {
  const ordered = [
    nameKeyOf(data, schema),
    ...(schema?.fields.map((f) => f.name) ?? []),
    ...(schema ? [] : PREFERRED_KEYS),
  ];
  const keys: string[] = [];
  for (const key of ordered) {
    if (key === undefined || keys.includes(key) || isEmpty(data[key])) continue;
    keys.push(key);
    if (keys.length === CONCISE_FIELD_COUNT) break;
  }
  return keys;
}

const clipValue = (value: unknown) => (typeof value === "string" ? clip(value, CONCISE_VALUE_CHARS) : value);

/**
 * Converts a normalized record into the tool output shape. `schema` orders and names the fields when known.
 * Concise output keeps only the key fields with long text clipped; `detailed` returns every field.
 */
export function toOut(record: NormalizedRecord, schema: BaseSchemaInfo | undefined, detailed: boolean): RecordOut {
  const fields = detailed
    ? record.data
    : Object.fromEntries(keyFieldNames(record.data, schema).map((key) => [key, clipValue(record.data[key])]));
  return {
    id: record.id,
    object_type: record.category,
    ...(record.schemaId ? { schema_id: record.schemaId } : {}),
    name: nameOf(record.data, schema),
    fields,
    relationship_count: record.links.length,
    ...(detailed ? { relationships: record.links } : {}),
    ...(detailed && record.createdAt ? { created_at: record.createdAt } : {}),
    ...(detailed && record.updatedAt ? { updated_at: record.updatedAt } : {}),
  };
}

/** "company", "person", "deal", or the custom object's own name. */
const objectNoun = (schema: BaseSchemaInfo | undefined, fallback: ObjectCategory) =>
  schema ? (schema.category === "custom" ? schema.name : schema.category) : fallback;

/** Text lines for a record's links: a count in concise, one line per link in detailed. */
function linksText(out: RecordOut): string {
  if (out.relationship_count === 0) return "";
  if (!out.relationships) return `Linked records: ${out.relationship_count} (response_format "detailed" lists them).`;
  return ["Linked records:", ...out.relationships.map((l) => `- ${l.object_type} ${label(l)}`)].join("\n");
}

function detailedBlock(out: RecordOut): string {
  const block = [`Record ${label(out)}`, renderRecord(out.fields), linksText(out)].filter(Boolean).join("\n");
  return block.length <= DETAILED_BLOCK_CHARS
    ? block
    : `${block.slice(0, DETAILED_BLOCK_CHARS)}\n… record cut; heliyos_records_get with id ${out.id} returns all of it.`;
}

/** Concise list table layouts, widest first; the last always fits 100 rows in the budget. */
export function listLayouts(records: RecordOut[], schema: BaseSchemaInfo): TableLayout[] {
  const nameKeys = new Set(records.map((r) => nameKeyOf(r.fields, schema)).filter(Boolean));
  const extra: string[] = [];
  for (const field of schema.fields) {
    if (nameKeys.has(field.name) || field.name === "id" || field.name === "name") continue;
    if (records.some((r) => !isEmpty(r.fields[field.name]))) extra.push(field.name);
    if (extra.length === 3) break;
  }
  const cols = (n: number) => ["id", "name", ...extra.slice(0, n)];
  return [
    { columns: cols(3), maxCell: 60 },
    { columns: cols(3), maxCell: 40 },
    { columns: cols(2), maxCell: 30 },
    { columns: cols(1), maxCell: 24 },
    { columns: cols(0), maxCell: 30 },
  ];
}

// ---------------------------------------------------------------- tools

/** Builds the record tools (list, get, lookup, create, update, delete and more), from the shared tool context. */
export function recordTools({ client, schemas }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_records_list",
    title: "List records",
    description:
      "Lists records of one object (companies, people, deals, or a custom object) in the Heliyos workspace, newest first. " +
      "Use it to browse or filter records; use heliyos_records_lookup to find a record by name and heliyos_records_get for one record. " +
      "Filter with `search` (free text) and `filters` (field conditions joined by `match`); order with `sort`. Returns a table of id, name and key fields plus " +
      "structuredContent {records:[{id, object_type, name, fields}], next_cursor}. When next_cursor is present, call again with " +
      "`cursor` set to it for the next page. Record ids feed heliyos_records_get, _update and _delete.",
    input: z.strictObject({
      object_type: objectType,
      schema_id: schemaId,
      search: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Plain words matched across the record's text fields. Symbols such as + ( ) [ ] * ? can cause an error."),
      filters: z
        .array(filterCondition)
        .max(20)
        .optional()
        .describe('Field conditions, for example [{field:"stage", operator:"equals", value:"Won"}]. Joined by `match`.'),
      match: z
        .enum(["all", "any"])
        .default("all")
        .describe('"all" (default): a record must meet every filter condition. "any": at least one condition.'),
      sort: z
        .strictObject({
          field: z
            .string()
            .min(1)
            .max(200)
            .describe("Field key to sort by (from heliyos_objects_get), or createdAt / updatedAt."),
          direction: z.enum(["asc", "desc"]).default("desc").describe('"asc" or "desc" (default).'),
        })
        .optional()
        .describe(
          "Sort order. Omit for newest updated first. With a sort, next_cursor is a page cursor from this tool; pass it back unchanged."
        ),
      limit: pageLimit,
      cursor,
      response_format: responseFormat,
    }),
    output: z.object({ records: z.array(recordOut), next_cursor: z.string().optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      if (args.filters?.length) assertValidFilters(args.filters);
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      const conjunction = args.match === "any" ? "or" : "and";
      if (args.sort && !["createdAt", "updatedAt"].includes(args.sort.field)) {
        await schemas.assertFieldKeys(schema, [args.sort.field]);
      }
      const paging = pagedQuery(args, args.sort !== undefined);
      const filterObject = {
        ...(args.search ? { search: args.search } : {}),
        // The platform ORs every condition when any has conjunction "or", so all share one.
        ...(args.filters?.length ? { filters: args.filters.map((f) => ({ ...f, conjunction })) } : {}),
        ...(args.sort ? { sort: [args.sort] } : {}),
      };
      const { data, meta } = await callOperation(client, "listRecords", {
        params: { id: schema.id },
        query: {
          ...paging.query,
          ...(Object.keys(filterObject).length ? { filters: JSON.stringify(filterObject) } : {}),
        },
      });

      const detailed = args.response_format === "detailed";
      const records = expectArray(data, "record list").map((raw) =>
        toOut(normalizeRecord(raw, schema.category), schema, detailed)
      );
      const nextCursor = paging.next(meta);

      const noun = objectNoun(schema, schema.category);
      const header = `${plural(records.length, `${noun} record`)} (object ${schema.name}, schema_id ${schema.id}):`;
      const footer = nextCursor
        ? `More records: call heliyos_records_list again with cursor "${nextCursor}".`
        : "No more pages.";

      let body: string;
      if (records.length === 0) {
        body = `No ${noun} records matched${args.cursor ? " on this page" : ""}.`;
      } else if (detailed) {
        body = [header, fitRecordBlocks(records, MAX_TEXT_CHARS - header.length - footer.length - 4)].join("\n\n");
      } else {
        const closing = "Use heliyos_records_get with an id for every field.";
        const rows = records.map((r) => ({ id: r.id, name: r.name, ...r.fields }));
        const budget = MAX_TEXT_CHARS - header.length - closing.length - footer.length - 6;
        body = [header, fitTable(rows, listLayouts(records, schema), budget), closing].join("\n");
      }
      return {
        text: `${body}\n\n${footer}`,
        structuredContent: { records, ...(nextCursor ? { next_cursor: nextCursor } : {}) },
      };
    },
  });

  const get = tool({
    name: "heliyos_records_get",
    title: "Get a record",
    description:
      "Fetches one record (a company, person, deal, or custom object row) by id. Use it after heliyos_records_list or " +
      "heliyos_records_lookup gives you an id. \"concise\" returns the name, key fields and a count of linked records; " +
      "\"detailed\" returns every field, the linked records (for example a person's company or a company's deals) with their ids, " +
      "and created and updated times. Returns structuredContent {record:{id, object_type, schema_id, name, fields, relationships}}.",
    input: z.strictObject({ record_id: recordId("record_id"), response_format: responseFormat }),
    output: z.object({ record: recordOut }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    truncationHint: 'Use response_format "concise" for the key fields only.',
    async handler(args) {
      const { data } = await callOperation(client, "getRecord", { params: { id: args.record_id } });
      const record = normalizeRecord(data);
      const schema = await schemas.find(record.schemaId);
      const detailed = args.response_format === "detailed";
      const out = toOut(record, schema, detailed);
      const heading = `${titleCase(objectNoun(schema, record.category))} record ${label(out)}${
        out.schema_id ? `, schema_id ${out.schema_id}` : ""
      }`;
      const lines = [heading, renderRecord(out.fields), linksText(out)];
      if (detailed) {
        lines.push(renderRecord({ created_at: out.created_at, updated_at: out.updated_at }));
      } else {
        lines.push('Use response_format "detailed" for every field.');
      }
      return { text: lines.filter(Boolean).join("\n"), structuredContent: { record: out } };
    },
  });

  const create = tool({
    name: "heliyos_records_create",
    title: "Create a record",
    description:
      "Creates one record (a company, person, deal, or custom object row) with the given field values. Check first with " +
      "heliyos_records_lookup that the record does not already exist; calling this twice creates two records. " +
      "Creating a company can start automatic enrichment, which uses credits when automatic enrichment is on (Settings, Autopilot). " +
      "Returns the new record's id and key fields as structuredContent {record}.",
    input: z.strictObject({ object_type: objectType, schema_id: schemaId, fields: fieldValues }),
    output: z.object({ record: recordOut.optional() }),
    annotations: CREATES,
    async handler(args) {
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      await schemas.assertFieldKeys(schema, Object.keys(args.fields));
      const { data } = await callOperation(client, "createRecord", { params: { id: schema.id }, body: args.fields });
      const noun = objectNoun(schema, schema.category);
      if (!isRecord(data) || !idOf(data._id ?? data.id)) {
        // Created, but no id came back: do not report failure (a retry would duplicate it).
        return {
          text: `Created a ${noun} record, but the response did not include its id. Use heliyos_records_lookup to find it.`,
          structuredContent: {},
        };
      }
      const out = toOut(normalizeRecord(data, schema.category), schema, false);
      return {
        text: [`Created ${noun} record ${label(out)}.`, renderRecord(out.fields), linksText(out)].filter(Boolean).join("\n"),
        structuredContent: { record: out },
      };
    },
  });

  const update = tool({
    name: "heliyos_records_update",
    title: "Update a record",
    description:
      "Updates some fields of one record by id; fields you leave out keep their values. Set a field to null to clear it. " +
      "Field keys are checked against the record's object first, and unknown keys are rejected with the valid ones. " +
      "`relationships` adds links and never removes existing ones. " +
      "Get the id from heliyos_records_list or heliyos_records_lookup. Returns the changed fields and the record's key " +
      "fields as structuredContent {record}.",
    input: z.strictObject({ record_id: recordId("record_id"), fields: fieldValues }),
    output: z.object({ record: recordOut }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args) {
      // Read first: the record's object decides which field keys are valid (one extra request).
      const before = normalizeRecord((await callOperation(client, "getRecord", { params: { id: args.record_id } })).data);
      const beforeSchema = await schemas.find(before.schemaId);
      if (beforeSchema) await schemas.assertFieldKeys(beforeSchema, Object.keys(args.fields));

      const { data } = await callOperation(client, "updateRecord", {
        params: { id: args.record_id },
        body: { data: args.fields },
      });
      const record = normalizeRecord(data);
      const schema = (await schemas.find(record.schemaId)) ?? beforeSchema;
      const out = toOut(record, schema, false);
      const changedKeys = Object.keys(args.fields).filter((key) => key !== "relationships");
      // Report what the API returned, never the input echoed back.
      const changed = Object.fromEntries(
        changedKeys.filter((key) => key in record.data).map((key) => [key, record.data[key]])
      );
      const lines = [`Updated ${objectNoun(schema, record.category)} record ${label(out)}.`];
      if (changedKeys.length) {
        lines.push(
          "Changed fields:",
          ...changedKeys.map((key) =>
            key in record.data
              ? `${key}: ${formatValue(record.data[key]) || "(cleared)"}`
              : args.fields[key] === null
                ? `${key}: (cleared)`
                : `${key}: (not returned by the API; check with heliyos_records_get)`
          )
        );
      }
      if ("relationships" in args.fields) lines.push(`Linked records now: ${out.relationship_count}.`);
      if (!beforeSchema) lines.push("Field keys were not checked: the object's schema could not be read.");
      return {
        text: lines.join("\n"),
        structuredContent: { record: { ...out, fields: { ...out.fields, ...changed } } },
      };
    },
  });

  const remove = tool({
    name: "heliyos_records_delete",
    title: "Delete records",
    description:
      "Permanently deletes up to 100 records of one object by id. This cannot be undone: confirm with the user first. " +
      "All ids must belong to the given object_type; the API ignores ids from other objects and does not confirm a count. " +
      "Returns structuredContent {deleted_count (ids sent), record_ids}.",
    input: z.strictObject({
      object_type: objectType,
      schema_id: schemaId,
      record_ids: z
        .array(recordId("each record_ids entry"))
        .min(1)
        .max(100)
        .describe("Ids of the records to delete, 1 to 100."),
    }),
    output: z.object({
      deleted_count: z.number().int().describe("Number of distinct ids sent; the API does not confirm the count."),
      record_ids: z.array(z.string()),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async handler(args) {
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      const ids = [...new Set(args.record_ids)];
      await callOperation(client, "bulkDeleteRecords", { params: { id: schema.id }, body: { objectIds: ids } });
      const noun = objectNoun(schema, schema.category);
      return {
        text:
          `Sent ${plural(ids.length, "id")} for deletion from ${noun} records; the API does not confirm the count. ` +
          `Ids that are not ${noun} records are ignored. Ids: ${ids.join(", ")}.`,
        structuredContent: { deleted_count: ids.length, record_ids: ids },
      };
    },
  });

  const lookup = tool({
    name: "heliyos_records_lookup",
    title: "Find records by name",
    description:
      "Finds records of one object whose name contains `query` (case-insensitive; exact and prefix matches rank first), " +
      "or whose secondary value does (the first of domain, email, job title or stage that the object has). " +
      "Use it to turn a name the user mentions into a record id. It searches the " +
      `${LOOKUP_INDEX_SIZE} most recently updated records; for older ones use heliyos_records_list with search. ` +
      "Returns structuredContent {matches:[{id, name, secondary}], total_matches}.",
    input: z.strictObject({
      object_type: objectType,
      schema_id: schemaId,
      query: z.string().trim().min(1).max(200).describe('Name or part of a name, for example "acme".'),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum matches to return, 1 to 100. Default 20."),
      response_format: responseFormat,
    }),
    output: z.object({
      matches: z.array(
        z.object({ id: z.string(), name: z.string(), secondary: z.string().optional(), updated_at: z.string().optional() })
      ),
      total_matches: z.number().int(),
      index_truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    truncationHint: "Lower limit or use a more specific query.",
    async handler(args) {
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      const { data } = await callOperation(client, "listRecordLookup", {
        params: { id: schema.id },
        query: { limit: LOOKUP_INDEX_SIZE },
      });
      const rows = expectArray(data, "lookup");

      const q = args.query.toLowerCase();
      const detailed = args.response_format === "detailed";
      const scored = rows
        .filter(isRecord)
        .map((row, index) => {
          const id = idOf(row.id) ?? idOf(row._id) ?? "";
          const name = typeof row.name === "string" ? row.name : "";
          const secondary = formatValue(row.secondary);
          const n = name.toLowerCase();
          const score =
            n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : secondary.toLowerCase().includes(q) ? 3 : -1;
          const updatedAt = dateOf(row.updatedAt);
          return {
            score,
            index,
            match: {
              id,
              name,
              ...(secondary ? { secondary } : {}),
              ...(detailed && updatedAt ? { updated_at: updatedAt } : {}),
            },
          };
        })
        .filter((s) => s.score >= 0 && s.match.id)
        .sort((a, b) => a.score - b.score || a.index - b.index);
      const matches = scored.slice(0, args.limit).map((s) => s.match);
      const indexTruncated = rows.length >= LOOKUP_INDEX_SIZE;

      const what = `${objectNoun(schema, schema.category)} records`;
      const lines: string[] = [];
      if (matches.length === 0) {
        lines.push(`No ${what} match "${args.query}".`);
        lines.push(
          indexTruncated
            ? `Only the ${LOOKUP_INDEX_SIZE} most recently updated records were searched; try heliyos_records_list with search.`
            : "Try a shorter query, or heliyos_records_list with search."
        );
      } else {
        const columns = detailed ? ["id", "name", "secondary", "updated_at"] : ["id", "name", "secondary"];
        lines.push(`${plural(scored.length, "match", "matches")} in ${what} for "${args.query}":`);
        lines.push(
          fitTable(
            matches,
            [
              { columns, maxCell: 60 },
              { columns, maxCell: 30 },
              { columns: ["id", "name"], maxCell: 30 },
            ],
            MAX_TEXT_CHARS - 500
          )
        );
        if (scored.length > matches.length) lines.push(`Showing ${matches.length}; raise limit or refine the query.`);
        lines.push("Use heliyos_records_get with an id for details.");
      }
      return {
        text: lines.join("\n"),
        structuredContent: { matches, total_matches: scored.length, index_truncated: indexTruncated },
      };
    },
  });

  return [list, get, create, update, remove, lookup];
}

/** Detailed list text: whole record blocks while they fit; the rest are named (see fitBlocks). */
function fitRecordBlocks(records: RecordOut[], budget: number): string {
  return fitBlocks(
    records.map(detailedBlock),
    records.map((r) => r.id),
    budget,
    {
      items: "records",
      key: "records",
      readHint: 'Read them with heliyos_records_get, or repeat this call with response_format "concise".',
    }
  );
}

const titleCase = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

// ---------------------------------------------------------------- shared with notes and tasks

/** How notes and tasks store a link to a record. */
export interface RecordRef {
  objectId: string;
  schemaId?: string;
  objectType?: string;
}

/** The most records a single note or task can be linked to in one call. */
export const MAX_LINKED_RECORDS = 10;

/** The `record_ids` input listing records to link to something. `owner` names that thing, for example "note", in the description. */
export const linkedRecordIds = (owner: string) =>
  z
    .array(recordId("each record_ids entry"))
    .min(1)
    .max(MAX_LINKED_RECORDS)
    .describe(
      `Ids of records (companies, people, deals) to link the ${owner} to, 1 to ${MAX_LINKED_RECORDS}. ` +
        "Each id is checked first; an unknown id fails the call and nothing is written."
    );

/**
 * Reads each record once (in parallel) so a link carries the object type and
 * schema the platform's triggers rely on, and an unknown id fails before any write.
 */
export async function readRecordRefs(
  client: ToolContext["client"],
  ids: readonly string[],
  /** How the error names the input, for example "record_ids entry" or "record_id". */
  what = "record_ids entry"
): Promise<RecordRef[]> {
  const unique = [...new Set(ids)];
  return Promise.all(
    unique.map(async (id) => {
      try {
        const { data } = await callOperation(client, "getRecord", { params: { id } });
        const raw = isRecord(data) ? data : {};
        const schemaId = idOf(raw.baseSchemaId);
        const storedType = typeof raw.objectType === "string" && raw.objectType ? raw.objectType : undefined;
        return { objectId: id, ...(schemaId ? { schemaId } : {}), ...(storedType ? { objectType: storedType } : {}) };
      } catch (err) {
        if (err instanceof HeliyosApiError && err.code === "NOT_FOUND") {
          throw new HeliyosApiError("NOT_FOUND", `${what} ${id} is not a record in this workspace`, err.status);
        }
        throw err;
      }
    })
  );
}

/** Experimental: person enrichment (createRecordEnrichment). Registered right after the records tools. */
export function recordEnrichTool({ client, schemas }: ToolContext): ToolSpec {
  return tool({
    name: "heliyos_records_enrich",
    title: "Enrich a person",
    description:
      "Experimental. Looks up public profile data for one person record (job title, LinkedIn and similar) and writes it " +
      "to the record. Only person records can be enriched; companies are enriched automatically when watched. " +
      "Each call uses 20 credits and fails when fewer remain, so confirm with the user first. " +
      "Returns the updated record's key fields as structuredContent {record}.",
    input: z.strictObject({ record_id: recordId("record_id") }),
    output: z.object({ record: recordOut }),
    annotations: CREATES,
    async handler(args) {
      const { data } = await callOperation(client, "createRecordEnrichment", { params: { id: args.record_id } });
      const record = normalizeRecord(data, "person");
      const schema = await schemas.find(record.schemaId);
      const out = toOut(record, schema, false);
      return {
        text: [`Enriched person record ${label(out)}.`, renderRecord(out.fields)].filter(Boolean).join("\n"),
        structuredContent: { record: out },
      };
    },
  });
}
