/**
 * Building blocks every resource file shares: id and paging inputs, the
 * response_format switch, annotation presets, response-shape readers and the
 * paging cursors. One definition each, so every tool reads the same way.
 */
import { randomBytes } from "node:crypto";
import * as z from "zod/v4";
import type { HeliyosClient } from "../client/http.js";
import { HeliyosApiError } from "../client/http.js";
import { isRecord } from "../util.js";
import { categoryOf, type SchemaResolver } from "./baseSchemas.js";
import type { ToolAnnotationsStrict } from "./define.js";

/** What every resource's tool factory receives. */
export interface ToolContext {
  client: HeliyosClient;
  schemas: SchemaResolver;
}

// ---------------------------------------------------------------- inputs

/** Matches a 24-character hexadecimal object id, the id format the Heliyos API uses. */
export const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** A 24-character hex id input named `what` (for example "record_id"). */
export const hexId = (what: string) =>
  z.string().regex(OBJECT_ID, `${what} must be a 24-character hex id`).describe(`${what}: a 24-character hex id.`);

/** The concise/detailed switch on read tools; the texts say what each mode returns. */
export const responseFormat = (concise: string, detailed: string) =>
  z
    .enum(["concise", "detailed"])
    .default("concise")
    .describe(`"concise" (default) returns ${concise}; "detailed" returns ${detailed}.`);

/** A page-size input, 1 to 100 with a default of 20. `items` names what is being paged, for the description. */
export const pageLimit = (items: string) =>
  z.number().int().min(1).max(100).default(20).describe(`${items} per page, 1 to 100. Default 20.`);

/** The optional paging cursor input: the `next_cursor` of the previous page, passed back with the same limit. */
export const cursorInput = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("next_cursor from the previous page, with the same limit. Omit for the first page.");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO 8601 date (YYYY-MM-DD) or date-time, passed through as given. */
export const isoDate = (what: string) =>
  z
    .string()
    .max(40)
    .refine((v) => ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)), `${what} must be an ISO 8601 date, for example 2026-03-01`)
    .describe(`${what} as an ISO 8601 date (2026-03-01) or date-time (2026-03-01T09:00:00Z).`);

/**
 * An inclusive upper bound: a date-only value means the end of that day (UTC),
 * so "until 2026-03-01" includes March 1. Date-times pass through unchanged.
 */
export const endOfDay = (value: string) => (DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);

/** A free-text search box; the platform matches it as a pattern, so plain words are safest. */
export const searchInput = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(`Plain words matched against ${what}. Symbols such as + ( ) [ ] * ? can cause an error.`);

// ---------------------------------------------------------------- annotations

/** Annotations for tools that only read: no writes, safe to repeat. */
export const READ_ONLY: ToolAnnotationsStrict = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Creates, invitations and runs: each call does something new. */
export const CREATES: ToolAnnotationsStrict = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Updates: repeating the same call changes nothing more. */
export const UPDATES: ToolAnnotationsStrict = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/**
 * Updates that replace a set (for example a label's values) and so can drop data that
 * cannot be restored by repeating the call: destructive, but a repeat changes nothing more.
 */
export const REPLACES: ToolAnnotationsStrict = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
/**
 * Worker runs (heliyos_ask, heliyos_tasks_run): a run can change records, tasks and email
 * (consequential actions wait for approval in Heliyos), so it is destructive, and every call
 * can start a new run. It only talks to Heliyos, so openWorldHint stays false.
 */
export const STARTS_RUN: ToolAnnotationsStrict = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
/**
 * Review decisions: approving sends the email, changes the deal or lets the
 * paused worker act, so it is destructive; a review is decided once, so a
 * repeat fails rather than repeating it.
 */
export const DECIDES: ToolAnnotationsStrict = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
/** Deletes and removals: irreversible, and a repeat changes nothing more. */
export const DESTROYS: ToolAnnotationsStrict = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

// ---------------------------------------------------------------- response readers

/** A Mongo id from a string, an ObjectId-like `{id|_id}`, or undefined. */
export const idOf = (value: unknown): string | undefined => {
  if (typeof value === "string" && value) return value;
  if (isRecord(value)) return idOf(value.id) ?? idOf(value._id);
  return undefined;
};

/** The id of an API document (`_id` or `id`), or INTERNAL naming what was missing it. */
export function requireId(doc: Record<string, unknown>, what: string): string {
  const id = idOf(doc._id) ?? idOf(doc.id);
  if (!id) throw new HeliyosApiError("INTERNAL", `The API returned a ${what} without an id`, 0);
  return id;
}

/** An API payload that must be an object, or INTERNAL naming what was expected. */
export function expectObject(data: unknown, what: string): Record<string, unknown> {
  if (!isRecord(data)) throw new HeliyosApiError("INTERNAL", `The ${what} response was not an object`, 0);
  return data;
}

/** `{[key]: value}` when value is defined, else `{}`: for spreading optional output fields. */
export const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** The non-empty `key` strings of a list of objects, for example the names in `[{name}]`. */
export const namesOf = (list: unknown, key: string): string[] =>
  Array.isArray(list) ? list.filter(isRecord).map((x) => stringOf(x[key]) ?? "").filter(Boolean) : [];

/** Returns `value` when it is a non-blank string, otherwise undefined. */
export const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Returns `value` when it is a finite number, otherwise undefined. */
export const numberOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A date-ish value (ISO string or Date JSON) as a string. */
export const dateOf = (value: unknown): string | undefined => stringOf(value);

/** `metadata.created.at` / `metadata.updated.at`, falling back to `createdAt` / `updatedAt`. */
export function timestampsOf(doc: Record<string, unknown>): { created_at?: string; updated_at?: string } {
  const meta = isRecord(doc.metadata) ? doc.metadata : {};
  const created = dateOf(isRecord(meta.created) ? meta.created.at : undefined) ?? dateOf(doc.createdAt);
  const updated = dateOf(isRecord(meta.updated) ? meta.updated.at : undefined) ?? dateOf(doc.updatedAt);
  return { ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}) };
}

// ---------------------------------------------------------------- paging

/** The truncation hint of every paged list. */
export const LIST_TRUNCATION_HINT = 'Lower limit or use response_format "concise"; next_cursor continues after the whole page.';

/** `meta.pagination` of a list response, or an empty object. */
export const paginationOf = (meta: Record<string, unknown>): Record<string, unknown> =>
  isRecord(meta.pagination) ? meta.pagination : {};

/** `meta.pagination.next_cursor` of a keyset-paged list, when there is a next page. */
export function nextCursorOf(meta: Record<string, unknown>): string | undefined {
  return stringOf(paginationOf(meta).next_cursor);
}

/**
 * The query of a keyset-paged list with a JSON `filters` object: limit, the
 * cursor when given, and filters only when there is at least one.
 */
export function keysetListQuery(
  args: { limit: number; cursor?: string | undefined },
  filters: Record<string, unknown>
): { limit: number; cursor?: string; filters?: string } {
  return {
    limit: args.limit,
    ...(args.cursor ? { cursor: args.cursor } : {}),
    ...(Object.keys(filters).length ? { filters: JSON.stringify(filters) } : {}),
  };
}

/**
 * Cursors for the few lists the platform pages by page number only (timeline,
 * usage, team members). The tool hands out "page:<n>:<limit>" so every list
 * pages the same way. The server's offset is (page - 1) * limit, so a cursor
 * is only valid with the limit it was issued for; another limit would skip or
 * repeat items, and is refused.
 */
export const pageCursor = {
  encode: (page: number, limit: number) => `page:${page}:${limit}`,
  decode(cursor: string | undefined, limit: number): number {
    if (cursor === undefined) return 1;
    const match = /^page:([1-9]\d{0,5}):([1-9]\d{0,2})$/.exec(cursor);
    if (!match) {
      throw new HeliyosApiError(
        "VALIDATION_FAILED",
        `cursor "${cursor}" was not issued by this tool. Pass the next_cursor value from the previous page, or omit cursor for the first page`,
        0
      );
    }
    const issuedFor = Number(match[2]);
    if (issuedFor !== limit) {
      throw new HeliyosApiError(
        "VALIDATION_FAILED",
        `cursor "${cursor}" was issued for limit ${issuedFor}, but this call has limit ${limit}. ` +
          `Repeat with limit ${issuedFor} to continue, or drop cursor to start again from the first page with the new limit`,
        0
      );
    }
    return Number(match[1]);
  },
  /**
   * next_cursor for a page-number list: from the server's `hasMore` when it
   * sends one, otherwise from its total `count`/`total`.
   */
  next(page: number, limit: number, pagination: Record<string, unknown>): string | undefined {
    const total = numberOf(pagination.count) ?? numberOf(pagination.total);
    const more = typeof pagination.hasMore === "boolean" ? pagination.hasMore : total !== undefined && page * limit < total;
    return more ? pageCursor.encode(page + 1, limit) : undefined;
  },
};

// ---------------------------------------------------------------- sorting

/** The sort directions a `sort` input accepts. */
export const SORT_DIRECTIONS = ["asc", "desc"] as const;
/** One of the values in SORT_DIRECTIONS. */
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * A `sort` input: one field and a direction. Lists are newest first by default;
 * a sort switches the platform to page-number paging, so the tool hands out
 * page cursors instead of keyset cursors (the platform refuses a keyset cursor
 * with a non-default sort).
 */
export const sortInput = <F extends readonly [string, ...string[]]>(fields: F, hint: string) =>
  z
    .strictObject({
      field: z.enum(fields).describe(hint),
      direction: z.enum(SORT_DIRECTIONS).default("desc").describe('"asc" or "desc" (default).'),
    })
    .optional()
    .describe(
      `Sort order. Omit for newest first. With a sort, next_cursor is a page cursor from this tool; pass it back unchanged.`
    );

/**
 * Paging for a list that is keyset-paged by default and page-paged when sorted.
 * `page` is 1-based (only with a sort); `query` is what to send; `next(meta)`
 * reads the next cursor from the response in either mode.
 */
export function pagedQuery(args: { limit: number; cursor?: string | undefined }, sorted: boolean) {
  if (!sorted) {
    return {
      query: { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) },
      next: (meta: Record<string, unknown>) => nextCursorOf(meta),
    };
  }
  const page = pageCursor.decode(args.cursor, args.limit);
  return {
    query: { limit: args.limit, page },
    next: (meta: Record<string, unknown>) => pageCursor.next(page, args.limit, paginationOf(meta)),
  };
}

/** The closing line of a list: how to get the next page, or that there is none. */
export const pagingFooter = (tool: string, nextCursor: string | undefined) =>
  nextCursor ? `More results: call ${tool} again with cursor "${nextCursor}".` : "No more pages.";

// ---------------------------------------------------------------- text

/** Formats a count with its noun, for example "1 note" or "3 notes". `many` overrides the default plural of adding an s. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `"Name" (id …)`, or `id …` when there is no name. */
export const label = (out: { name?: string; id: string }) => (out.name ? `"${out.name}" (id ${out.id})` : `id ${out.id}`);

/** The date part of an ISO timestamp, for compact tables. */
export const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "");

/** A fresh 24-hex id for sub-documents the API expects the client to name (label values). */
export const newHexId = () => randomBytes(12).toString("hex");

// ---------------------------------------------------------------- links (notes and tasks)

/** Output shape of one link from a note or task to a record or another target. */
export const linkOut = z.object({
  id: z.string(),
  object_type: z.string().describe("company, person, deal, custom, or a non-record target such as task or interaction."),
  schema_id: z.string().optional(),
  name: z.string().optional(),
});
/** The TypeScript type of a link in tool output, inferred from linkOut. */
export type LinkOut = z.infer<typeof linkOut>;

const LINK_NAME_KEYS = ["company_name", "people_name", "deal_name", "name", "title", "subject"];
const NON_RECORD_TARGETS = new Set(["task", "interaction", "meeting", "note"]);

/** Links as notes and tasks store them: [{objectId, schemaId?, objectType?, data?}]. */
export function linksOf(raw: unknown): LinkOut[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((rel) => {
    const id = idOf(rel.objectId);
    if (!id) return [];
    const stored = stringOf(rel.objectType);
    const type = stored === undefined ? "record" : NON_RECORD_TARGETS.has(stored) ? stored : categoryOf(stored);
    const schema = idOf(rel.schemaId);
    const data = isRecord(rel.data) ? rel.data : {};
    const name = LINK_NAME_KEYS.map((k) => stringOf(data[k])).find(Boolean);
    return [{ id, object_type: type, ...(schema ? { schema_id: schema } : {}), ...(name ? { name } : {}) }];
  });
}

/** Renders links as one line of text for a tool result. Takes the links and returns the line, or an empty string for none. */
export const linksLine = (links: readonly LinkOut[]) =>
  links.length ? `Linked to: ${links.map((l) => `${l.object_type} ${label(l)}`).join("; ")}` : "";
