/**
 * Watchlist: the companies the workers monitor. The platform stores "watched"
 * as `isAgentAssigned` on the company record, so the list is listRecords on the
 * company schema filtered by it; watching starts enrichment and the company's
 * Scouts, unwatching cancels those Scouts.
 */
import * as z from "zod/v4";
import { callOperation, expectArray } from "../client/operations.js";
import { fitTable, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  cursorInput,
  DESTROYS,
  expectObject,
  hexId,
  label,
  nextCursorOf,
  numberOf,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  responseFormat,
  UPDATES,
  type ToolContext,
  keysetListQuery,
  LIST_TRUNCATION_HINT,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";
import { listLayouts, normalizeRecord, recordOut, toOut } from "./records.js";

const statisticsOut = z.object({
  tasks_total: z.number().int(),
  tasks_completed: z.number().int(),
  actions: z.number().int(),
  meetings: z.number().int(),
  deals: z.number().int(),
  account_status: z.record(z.string(), z.unknown()),
  engagement_status: z.record(z.string(), z.unknown()),
});
type StatisticsOut = z.infer<typeof statisticsOut>;

function statisticsOf(data: unknown): StatisticsOut {
  const raw = expectObject(data, "watchlist statistics");
  const tasks = isRecord(raw.tasks) ? raw.tasks : {};
  return {
    tasks_total: numberOf(tasks.total) ?? 0,
    tasks_completed: numberOf(tasks.completed) ?? 0,
    actions: numberOf(raw.totalActions) ?? 0,
    meetings: numberOf(raw.totalMeetings) ?? 0,
    deals: numberOf(raw.totalDeals) ?? 0,
    account_status: isRecord(raw.accountStatus) ? raw.accountStatus : {},
    engagement_status: isRecord(raw.engagementStatus) ? raw.engagementStatus : {},
  };
}

/** `"Name" (id …)` of a watch/unwatch response, or just the id when the body has no record. */
function companyLabel(data: unknown, id: string): string {
  if (!isRecord(data)) return `id ${id}`;
  try {
    return label(toOut(normalizeRecord(data, "company"), undefined, false));
  } catch {
    return `id ${id}`;
  }
}

const companyId = hexId("record_id").describe("The company record's id (from heliyos_records_list or _lookup).");
const watchOut = z.object({ record_id: z.string(), watched: z.boolean() });

/** Builds the tools that show the company watchlist and add or remove companies, from the shared tool context. */
export function watchlistTools({ client, schemas }: ToolContext): ToolSpec[] {
  const get = tool({
    name: "heliyos_watchlist_get",
    title: "Get the watchlist",
    description:
      "Lists the companies on the watchlist (the accounts the workers monitor with Scouts and keep enriched), most " +
      "recently created records first (not by watch date), with their ids, names and key fields. \"detailed\" also returns watchlist statistics on the first page: " +
      "tasks done, deals, meetings and actions across watched companies. Use heliyos_companies_watch / _unwatch to " +
      "change it. Returns structuredContent {companies:[{id, name, fields}], statistics?, next_cursor}.",
    input: z.strictObject({
      limit: pageLimit("Companies"),
      cursor: cursorInput,
      response_format: responseFormat("companies with key fields", "every field plus watchlist statistics"),
    }),
    output: z.object({
      companies: z.array(recordOut),
      statistics: statisticsOut.optional(),
      next_cursor: z.string().optional(),
    }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const schema = await schemas.resolve("company");
      const detailed = args.response_format === "detailed";
      const [page, stats] = await Promise.all([
        callOperation(client, "listRecords", {
          params: { id: schema.id },
          query: keysetListQuery(args, { isAgentAssigned: true }),
        }),
        detailed && !args.cursor ? callOperation(client, "getWatchlistStatistics") : undefined,
      ]);
      const companies = expectArray(page.data, "watchlist").map((raw) =>
        toOut(normalizeRecord(raw, "company"), schema, detailed)
      );
      const statistics = stats ? statisticsOf(stats.data) : undefined;
      const next = nextCursorOf(page.meta);

      const lines: string[] = [];
      if (statistics) {
        lines.push(
          renderRecord({
            tasks: `${statistics.tasks_completed} of ${statistics.tasks_total} done`,
            deals: statistics.deals,
            meetings: statistics.meetings,
            actions: statistics.actions,
          }),
          ""
        );
      }
      if (companies.length === 0) {
        lines.push(args.cursor ? "No more watched companies." : "No companies are on the watchlist.");
      } else if (detailed) {
        lines.push(
          `${plural(companies.length, "watched company", "watched companies")}:`,
          ...companies.map((c) => `- ${label(c)}\n${renderRecord(c.fields).replace(/^/gm, "  ")}`)
        );
      } else {
        const rows = companies.map((c) => ({ id: c.id, name: c.name, ...c.fields }));
        lines.push(
          `${plural(companies.length, "watched company", "watched companies")}:`,
          fitTable(rows, listLayouts(companies, schema), MAX_TEXT_CHARS - 1000)
        );
      }
      lines.push("", pagingFooter("heliyos_watchlist_get", next));
      return {
        text: lines.join("\n"),
        structuredContent: { companies, ...(statistics ? { statistics } : {}), ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const watch = tool({
    name: "heliyos_companies_watch",
    title: "Watch a company",
    description:
      "Adds a company record to the watchlist: the workers enrich it, pull in its emails and meetings, and start its " +
      "Scouts. Counts against the plan's watched-company limit (heliyos_organization_get) and uses credits for " +
      "enrichment. Watching an already watched company changes nothing. Returns structuredContent {record_id, watched}.",
    input: z.strictObject({ record_id: companyId }),
    output: watchOut,
    annotations: UPDATES,
    async handler(args) {
      const { data } = await callOperation(client, "watchCompany", { params: { id: args.record_id } });
      return {
        text: `Watching company ${companyLabel(data, args.record_id)}. Enrichment and Scouts start in the background.`,
        structuredContent: { record_id: args.record_id, watched: true },
      };
    },
  });

  const unwatch = tool({
    name: "heliyos_companies_unwatch",
    title: "Unwatch a company",
    description:
      "Removes a company record from the watchlist. Its Scouts are deleted and the workers stop monitoring it; its " +
      "history (emails, meetings, notes, signals) is kept, so watching it again resumes where it left off. Confirm with " +
      "the user first. Returns structuredContent {record_id, watched}.",
    input: z.strictObject({ record_id: companyId }),
    output: watchOut,
    // Destructive: unwatching deletes the company's Scouts.
    annotations: DESTROYS,
    async handler(args) {
      const { data } = await callOperation(client, "unwatchCompany", { params: { id: args.record_id } });
      return {
        text: `Stopped watching company ${companyLabel(data, args.record_id)}; its Scouts were removed.`,
        structuredContent: { record_id: args.record_id, watched: false },
      };
    },
  });

  return [get, watch, unwatch];
}
