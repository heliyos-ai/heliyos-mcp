/**
 * Usage: the workspace's credit usage log (listUsage). Read-only: the API has
 * no way to change usage or credits.
 */
import * as z from "zod/v4";
import { callOperation, expectArray } from "../client/operations.js";
import { fitTable, MAX_TEXT_CHARS } from "../format/text.js";
import {
  cursorInput,
  dateOf,
  expectObject,
  idOf,
  isoDate,
  hexId,
  numberOf,
  pageCursor,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  responseFormat,
  searchInput,
  stringOf,
  type ToolContext,
  paginationOf,
  endOfDay,
  LIST_TRUNCATION_HINT,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

/**
 * The feature names Heliyos writes to the usage log (worker runs default to "agent_operation";
 * the rest come from scouts, searches, meeting processing and AI columns).
 */
export const USAGE_FEATURES = [
  "company_enrichment",
  "people_enrichment",
  "leadset_enrichment",
  "leadset_match",
  "worker_run",
  "scout",
  "meeting_analysis",
  "ai_column",
  "agent_operation",
] as const;

const entryOut = z.object({
  id: z.string().optional(),
  at: z.string().optional(),
  feature: z.string().describe("What used the credits, for example enrichment."),
  credits: z.number(),
  record_id: z.string().optional().describe("The record (or other object) the credits were used on."),
  object_type: z.string().optional(),
  description: z.string().optional().describe("Detailed only."),
  source: z.string().optional().describe("Detailed only: platform, agent or other."),
});
type EntryOut = z.infer<typeof entryOut>;

function entryOf(data: unknown, detailed: boolean): EntryOut {
  const raw = expectObject(data, "usage entry");
  const id = idOf(raw._id) ?? idOf(raw.id);
  const at = dateOf(raw.createdAt);
  const recordId = stringOf(raw.objectId);
  const objectType = stringOf(raw.objectType);
  const description = stringOf(raw.description);
  const source = stringOf(raw.sourceService);
  return {
    ...(id ? { id } : {}),
    ...(at ? { at } : {}),
    feature: stringOf(raw.feature) ?? "unknown",
    credits: numberOf(raw.creditsUtilized) ?? 0,
    ...(recordId ? { record_id: recordId } : {}),
    ...(objectType ? { object_type: objectType } : {}),
    ...(detailed && description ? { description } : {}),
    ...(detailed && source ? { source } : {}),
  };
}

/** Builds the credit usage tool. Takes the shared tool context and returns its specs for registration. */
export function usageTools({ client }: ToolContext): ToolSpec[] {
  const get = tool({
    name: "heliyos_usage_get",
    title: "Get credit usage",
    description:
      "Lists the workspace's credit usage, newest first: when credits were used, by which feature (company_enrichment, " +
      "worker_run, scout, ...), how many, and on which record. Filter by date range, feature, record or text. Read-only: usage and " +
      "credits cannot be changed via the API. Returns structuredContent {entries:[{at, feature, credits, record_id}], " +
      "page_credits, total_entries, next_cursor}.",
    input: z.strictObject({
      from: isoDate("from").optional().describe("Only usage at or after this date (ISO 8601)."),
      to: isoDate("to").optional().describe("Only usage at or before this date (ISO 8601); a date alone includes that whole day (UTC)."),
      feature: z
        .enum(USAGE_FEATURES)
        .optional()
        .describe(
          "Only this feature (exact match): company_enrichment, people_enrichment, leadset_enrichment, leadset_match, " +
            "worker_run, scout, meeting_analysis, ai_column, agent_operation. Older entries may use other names; find them with search."
        ),
      record_id: hexId("record_id").optional().describe("Only usage on this record."),
      search: searchInput("features, descriptions and object types"),
      limit: pageLimit("Entries"),
      cursor: cursorInput,
      response_format: responseFormat("date, feature, credits and record", "descriptions and sources too"),
    }),
    output: z.object({
      entries: z.array(entryOut),
      page_credits: z.number().describe("Credits used by the entries on this page."),
      total_entries: z.number().int().optional().describe("Entries matching the filters, across all pages."),
      next_cursor: z.string().optional(),
    }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const page = pageCursor.decode(args.cursor, args.limit);
      const { data, meta } = await callOperation(client, "listUsage", {
        query: {
          limit: args.limit,
          ...(page > 1 ? { page } : {}),
          ...(args.from ? { from: args.from } : {}),
          ...(args.to ? { to: endOfDay(args.to) } : {}),
          ...(args.feature ? { feature: args.feature } : {}),
          ...(args.record_id ? { objectId: args.record_id } : {}),
          ...(args.search ? { search: args.search } : {}),
        },
      });
      const detailed = args.response_format === "detailed";
      const entries = expectArray(data, "usage list").map((raw) => entryOf(raw, detailed));
      const pagination = paginationOf(meta);
      const total = numberOf(pagination.count);
      const next = pageCursor.next(page, args.limit, pagination);
      const pageCredits = entries.reduce((sum, e) => sum + e.credits, 0);

      const columns = detailed
        ? ["at", "feature", "credits", "record_id", "object_type", "description", "source"]
        : ["at", "feature", "credits", "record_id"];
      const table =
        entries.length === 0
          ? "No usage matched."
          : fitTable(
              entries,
              [
                { columns, maxCell: 60 },
                { columns: ["at", "feature", "credits"], maxCell: 30 },
              ],
              MAX_TEXT_CHARS - 500
            );
      const header =
        `${plural(entries.length, "usage entry", "usage entries")}${total !== undefined ? ` of ${total}` : ""}, ` +
        `${plural(pageCredits, "credit")} on this page:`;
      return {
        text: `${header}\n${table}\n\n${pagingFooter("heliyos_usage_get", next)}`,
        structuredContent: {
          entries,
          page_credits: pageCredits,
          ...(total !== undefined ? { total_entries: total } : {}),
          ...(next ? { next_cursor: next } : {}),
        },
      };
    },
  });

  return [get];
}
