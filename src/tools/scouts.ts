/**
 * Scouts and signals. A global scout (`/global-scouts`) is the workspace's
 * scout definition: what to look for, how often, and on which companies. Its
 * company scouts (`/companies/{id}/scouts`) are the instances running on each
 * watched company, and signals are what they find. Ten tools, one operation
 * each (scouts_update adds the state call when `state` is given).
 *
 * Closed value sets (cadences, apply-to, efforts, preview lookback periods, signal and
 * scout statuses, the global scout state) match the Heliyos API's scouts endpoints exactly.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitTable, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { redactSecrets } from "../secrets.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  cursorInput,
  day,
  DESTROYS,
  expectObject,
  hexId,
  idOf,
  label,
  LIST_TRUNCATION_HINT,
  nextCursorOf,
  numberOf,
  optional,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  stringOf,
  timestampsOf,
  UPDATES,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

const CADENCES = ["daily", "weekly", "monthly"] as const;
const APPLY_TO = ["watchlist", "selected_watchlist", "entire_web"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const LOOKBACKS = ["1_month", "3_months", "6_months"] as const;
const SIGNAL_STATUSES = ["new", "read", "archived"] as const;
const COMPANY_SCOUT_STATUSES = ["active", "paused", "failed"] as const;
/** setGlobalScoutState minus "cancelled", which deletes the scout (that is heliyos_scouts_delete's job). */
const SCOUT_STATES = ["active", "paused", "confirmed"] as const;

const CONCISE_QUERY_CHARS = 1500;
const CONCISE_SUMMARY_CHARS = 300;
const RECENT_SIGNALS = 5;
/** markSignalRead is one request per id; 20 stays well inside the 60/min API key limit. */
const MAX_SIGNAL_IDS = 20;

// ---------------------------------------------------------------- shapes

const scoutOut = z.object({
  id: z.string().describe("Global scout id: the scout_id of the other scout and signal tools."),
  name: z.string(),
  type: z.string().optional().describe("default (built in) or custom."),
  is_active: z.boolean().optional(),
  category: z.string().optional(),
  cadence: z.string().optional(),
  effort: z.string().optional(),
  apply_to: z.string().optional().describe("watchlist, selected_watchlist or entire_web."),
  preview_status: z.string().optional().describe("Custom scouts: pending, running, completed or failed."),
  total_signals: z.number().optional(),
  new_signals: z.number().optional(),
  active_company_count: z.number().optional().describe("Watched companies this scout is running on."),
  query: z.string().optional().describe("What the scout looks for (get; cut in concise)."),
  selected_company_ids: z.array(z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
type ScoutOut = z.infer<typeof scoutOut>;

const signalOut = z.object({
  id: z.string(),
  status: z.string().optional().describe("new (unread), read or archived."),
  detected_at: z.string().optional(),
  company_id: z.string().optional().describe("The company record the signal is about (watchlist scouts)."),
  company_name: z.string().optional(),
  scout_name: z.string().optional(),
  category: z.string().optional(),
  summary: z.string().optional(),
  website: z.string().optional(),
  sources: z.array(z.string()).optional().describe("Source URLs; detailed only."),
  relevance_score: z.number().optional(),
});
type SignalOut = z.infer<typeof signalOut>;

const companyScoutOut = z.object({
  id: z.string().describe("The company scout (instance) id."),
  scout_id: z.string().optional().describe("Its global scout id (heliyos_scouts_get)."),
  name: z.string(),
  status: z.string().optional(),
  category: z.string().optional(),
  cadence: z.string().optional(),
  last_run_at: z.string().optional(),
});
type CompanyScoutOut = z.infer<typeof companyScoutOut>;

const stringList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map((v) => idOf(v) ?? stringOf(v) ?? "").filter(Boolean) : [];

function scoutOf(data: unknown, options: { query?: number | "full"; detailed?: boolean } = {}): ScoutOut {
  const raw = expectObject(data, "scout");
  const counts = isRecord(raw.signal_counts) ? raw.signal_counts : {};
  const query = stringOf(raw.queryTemplate);
  const selected = stringList(raw.selectedCompanyIds);
  return {
    id: requireId(raw, "scout"),
    name: stringOf(raw.name) ?? "",
    ...optional("type", stringOf(raw.type)),
    ...optional("is_active", typeof raw.isActive === "boolean" ? raw.isActive : undefined),
    ...optional("category", stringOf(raw.category)),
    ...optional("cadence", stringOf(raw.cadence)),
    ...optional("effort", stringOf(raw.effort)),
    ...optional("apply_to", stringOf(raw.applyTo)),
    ...optional("preview_status", stringOf(raw.previewStatus)),
    ...optional("total_signals", numberOf(counts.total)),
    ...optional("new_signals", numberOf(counts.new)),
    ...optional("active_company_count", numberOf(raw.active_company_count)),
    ...(query && options.query !== undefined
      ? { query: options.query === "full" ? query : clip(query, options.query) }
      : {}),
    ...(options.detailed && selected.length ? { selected_company_ids: selected } : {}),
    ...(options.detailed ? timestampsOf(raw) : {}),
  };
}

function signalOf(data: unknown, detailed: boolean): SignalOut {
  const raw = expectObject(data, "signal");
  const summary = stringOf(raw.summary);
  const companyId = idOf(raw.baseSchemaObjectId);
  const company = stringOf(raw.companyName) ?? stringOf(raw.company_name);
  const sources = stringList(raw.citations);
  return {
    id: requireId(raw, "signal"),
    ...optional("status", stringOf(raw.status)),
    ...optional("detected_at", stringOf(raw.detected_date)),
    ...optional("company_id", companyId),
    ...optional("company_name", company),
    ...optional("scout_name", stringOf(raw.scout_name)),
    ...optional("category", stringOf(raw.category)),
    ...optional("summary", summary && (detailed ? summary : clip(summary, CONCISE_SUMMARY_CHARS))),
    ...optional("website", stringOf(raw.website)),
    ...(detailed && sources.length ? { sources } : {}),
    ...(detailed ? optional("relevance_score", numberOf(raw.relevance_score)) : {}),
  };
}

function companyScoutOf(data: unknown): CompanyScoutOut {
  const raw = expectObject(data, "company scout");
  const scoutId = idOf(raw.defaultScoutId);
  const status = stringOf(raw.status);
  const category = stringOf(raw.category);
  const cadence = stringOf(raw.cadence);
  const lastRun = stringOf(raw.lastRunDate);
  return {
    id: requireId(raw, "company scout"),
    ...(scoutId ? { scout_id: scoutId } : {}),
    name: stringOf(raw.name) ?? "",
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(cadence ? { cadence } : {}),
    ...(lastRun ? { last_run_at: lastRun } : {}),
  };
}

const yesNo = (value: boolean | undefined) => (value === undefined ? "" : value ? "yes" : "no");
const signalCounts = (s: ScoutOut) =>
  s.total_signals === undefined ? "" : `${s.new_signals ?? 0} new of ${s.total_signals}`;

function scoutFacts(s: ScoutOut): string {
  return renderRecord({
    type: s.type,
    active: yesNo(s.is_active),
    category: s.category,
    cadence: s.cadence,
    effort: s.effort,
    applies_to: s.apply_to,
    preview: s.preview_status,
    signals: signalCounts(s),
    companies_running: s.active_company_count,
    selected_company_ids: s.selected_company_ids,
  });
}

const scoutHeading = (s: ScoutOut) => `Scout ${label(s)}`;

/** One line per signal: date · company · summary (id …). */
const signalLine = (s: SignalOut) =>
  `- ${[day(s.detected_at), s.company_name, s.summary].filter(Boolean).join(" · ")} (id ${s.id}${s.status ? `, ${s.status}` : ""})`;

/** The scout a state change answered: `{scout, ...}` for active/paused, the scout itself for confirmed. */
const scoutFromState = (data: unknown) => (isRecord(data) && isRecord(data.scout) ? data.scout : data);

// ---------------------------------------------------------------- inputs

const scoutIdInput = hexId("scout_id").describe("Global scout id from heliyos_scouts_list.");
const companyIdInput = hexId("company_id").describe("Company record id (heliyos_records_lookup with object_type company).");
const nameInput = z.string().trim().min(1).max(200).describe("Scout name.");
const categoryInput = z.string().trim().min(1).max(200).describe('A short category label, for example "Funding" or "Hiring".');
const queryInput = z
  .string()
  .trim()
  .min(1)
  .max(5000)
  .describe(
    'What to look for, in plain language. For watchlist scopes write it about "the company"; each company\'s name and ' +
      "website are added when it runs. For entire_web, describe the event anywhere on the web."
  );
const cadenceInput = z.enum(CADENCES).describe("How often it runs: daily, weekly (default) or monthly.");
const effortInput = z.enum(EFFORTS).describe("Search depth: low, medium (default) or high. Higher effort costs more credits per run.");
const selectedIdsInput = z
  .array(hexId("each selected_company_ids entry"))
  .min(1)
  .max(1000)
  .describe("Watched company record ids the scout runs on (only with apply_to selected_watchlist).");

/** Builds the tools for scouts (create, update, assign to companies) and their signals, from the shared tool context. */
export function scoutTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_scouts_list",
    title: "List scouts",
    description:
      "Lists the workspace's scouts: the built-in (default) and custom monitors that look for events such as funding, " +
      "hiring or leadership changes on watched companies or across the web. Shows each scout's id, whether it is " +
      "active, its cadence, and how many signals it found (new of total). Returns every scout (there are only a few, " +
      "so there is no paging). Use heliyos_scouts_get for one scout's query and recent signals, heliyos_signals_list " +
      "for what scouts found. Returns structuredContent {scouts:[{id, name, type, is_active, ...}]}.",
    input: z.strictObject({
      type: z.enum(["default", "custom"]).optional().describe("Only built-in (default) or only custom scouts."),
      is_active: z.boolean().optional().describe("Only active (true) or only paused and unconfirmed (false) scouts."),
      apply_to: z.enum(APPLY_TO).optional().describe("Only scouts with this scope."),
      response_format: responseFormat("one row per scout", "category, scope, effort and preview state too"),
    }),
    output: z.object({ scouts: z.array(scoutOut) }),
    annotations: READ_ONLY,
    truncationHint: 'Use response_format "concise" or filter by type, is_active or apply_to.',
    async handler(args) {
      const { data } = await callOperation(client, "listGlobalScouts", {
        query: {
          ...(args.type ? { type: args.type } : {}),
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
          ...(args.apply_to ? { applyTo: args.apply_to } : {}),
        },
      });
      const detailed = args.response_format === "detailed";
      const scouts = expectArray(data, "scout list").map((raw) => scoutOf(raw, { detailed }));
      const rows = scouts.map((s) => ({ ...s, active: yesNo(s.is_active), signals: signalCounts(s), companies: s.active_company_count }));
      const wide = detailed
        ? ["id", "name", "type", "active", "cadence", "signals", "companies", "category", "apply_to", "effort", "preview_status"]
        : ["id", "name", "type", "active", "cadence", "signals"];
      const table =
        scouts.length === 0
          ? "No scouts matched."
          : fitTable(
              rows,
              [
                { columns: wide, maxCell: 40 },
                { columns: ["id", "name", "active", "signals"], maxCell: 40 },
              ],
              MAX_TEXT_CHARS - 400
            );
      return {
        text: `${plural(scouts.length, "scout")}:\n${table}\n\nUse heliyos_scouts_get with an id for its query and recent signals.`,
        structuredContent: { scouts },
      };
    },
  });

  const get = tool({
    name: "heliyos_scouts_get",
    title: "Get a scout",
    description:
      "Fetches one scout by id: what it looks for (its query), cadence, effort, scope, whether it is active, its preview " +
      `state (custom scouts) and its signal counts. "detailed" adds the ${RECENT_SIGNALS} most recent signals with ` +
      "their ids and the full query. Returns structuredContent {scout, recent_signals?}.",
    input: z.strictObject({
      scout_id: scoutIdInput,
      response_format: responseFormat(
        `the scout with its query cut at ${CONCISE_QUERY_CHARS} characters`,
        `the full query and the ${RECENT_SIGNALS} most recent signals`
      ),
    }),
    output: z.object({ scout: scoutOut, recent_signals: z.array(signalOut).optional() }),
    annotations: READ_ONLY,
    async handler(args) {
      const detailed = args.response_format === "detailed";
      const { data } = await callOperation(client, "getGlobalScout", { params: { id: args.scout_id } });
      const scout = scoutOf(data, { query: detailed ? "full" : CONCISE_QUERY_CHARS, detailed });
      const lines = [scoutHeading(scout), scoutFacts(scout), scout.query ? `query: ${scout.query}` : ""];
      let recent: SignalOut[] | undefined;
      if (detailed) {
        const signals = await callOperation(client, "listGlobalScoutSignals", {
          params: { id: args.scout_id },
          query: { limit: RECENT_SIGNALS },
        });
        recent = expectArray(signals.data, "signal list").map((raw) => signalOf(raw, false));
        lines.push(
          recent.length ? `Recent signals:\n${recent.map(signalLine).join("\n")}` : "No signals yet.",
          `More: heliyos_signals_list with scout_id ${scout.id}.`
        );
      } else {
        lines.push('Use response_format "detailed" for its recent signals.');
      }
      return {
        text: lines.filter(Boolean).join("\n"),
        structuredContent: { scout, ...(recent ? { recent_signals: recent } : {}) },
      };
    },
  });

  const create = tool({
    name: "heliyos_scouts_create",
    title: "Create a scout",
    description:
      "Creates a custom scout and starts a preview run of its query. The scout stays inactive until you confirm it: " +
      'when heliyos_scouts_get shows preview completed, call heliyos_scouts_update with state "confirmed" to activate ' +
      "it on its companies. apply_to: watchlist (every watched company, the default), selected_watchlist (only " +
      "selected_company_ids, which must be watched companies) or entire_web. The scope cannot be changed later. Scout " +
      "runs use credits. Calling this twice creates two scouts. Returns structuredContent {scout}.",
    input: z
      .strictObject({
        name: nameInput,
        category: categoryInput,
        query: queryInput,
        cadence: cadenceInput.optional(),
        effort: effortInput.optional(),
        apply_to: z.enum(APPLY_TO).optional().describe("watchlist (default), selected_watchlist or entire_web. Fixed once created."),
        selected_company_ids: selectedIdsInput.optional(),
        preview_company: z
          .strictObject({
            name: z.string().trim().min(1).max(500).describe("Company name."),
            website: z.string().trim().max(2000).optional().describe("Company website."),
          })
          .optional()
          .describe("selected_watchlist only: the company the preview runs on."),
        preview_lookback: z.enum(LOOKBACKS).optional().describe("How far back the preview searches: 1_month (default), 3_months or 6_months."),
      })
      .refine((v) => v.apply_to !== "selected_watchlist" || (v.selected_company_ids?.length ?? 0) > 0, {
        message: "selected_company_ids is required when apply_to is selected_watchlist",
        path: ["selected_company_ids"],
      })
      .refine((v) => v.selected_company_ids === undefined || v.apply_to === "selected_watchlist", {
        message: 'selected_company_ids needs apply_to "selected_watchlist"',
        path: ["apply_to"],
      }),
    output: z.object({ scout: scoutOut }),
    annotations: CREATES,
    async handler(args) {
      const { data } = await callOperation(client, "createGlobalScout", {
        body: {
          name: args.name,
          category: args.category,
          queryTemplate: args.query,
          ...(args.cadence ? { cadence: args.cadence } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.apply_to ? { applyTo: args.apply_to } : {}),
          ...(args.selected_company_ids ? { selectedCompanyIds: [...new Set(args.selected_company_ids)] } : {}),
          ...(args.preview_company
            ? {
                previewCompanyData: {
                  company_name: args.preview_company.name,
                  ...(args.preview_company.website ? { website: args.preview_company.website } : {}),
                },
              }
            : {}),
          ...(args.preview_lookback ? { previewLookbackPeriod: args.preview_lookback } : {}),
        },
      });
      const scout = scoutOf(data, { query: CONCISE_QUERY_CHARS });
      const next =
        scout.preview_status === "failed"
          ? "Its preview run failed to start; check the query, then delete it with heliyos_scouts_delete and create it again."
          : `It is inactive while its preview runs. When heliyos_scouts_get shows preview completed, call heliyos_scouts_update with scout_id ${scout.id} and state "confirmed" to activate it.`;
      return {
        text: [`Created ${scoutHeading(scout)}.`, scoutFacts(scout), next].filter(Boolean).join("\n"),
        structuredContent: { scout },
      };
    },
  });

  const update = tool({
    name: "heliyos_scouts_update",
    title: "Update a scout",
    description:
      "Changes a scout's name, category, query, cadence, effort or selected companies, and/or its state; what you leave " +
      "out is kept. Changes apply to every company the scout runs on. state: \"paused\" stops it on every company, " +
      '"active" resumes it, "confirmed" activates a new custom scout after its preview completed. The scope (apply_to) ' +
      "cannot be changed. To delete a custom scout use heliyos_scouts_delete. Returns structuredContent {scout}.",
    input: z
      .strictObject({
        scout_id: scoutIdInput,
        name: nameInput.optional(),
        category: categoryInput.optional(),
        query: queryInput.optional(),
        cadence: cadenceInput.optional(),
        effort: effortInput.optional(),
        selected_company_ids: selectedIdsInput
          .optional()
          .describe("Replaces the selected companies (selected_watchlist scouts only)."),
        state: z
          .enum(SCOUT_STATES)
          .optional()
          .describe('"active", "paused", or "confirmed" (activate a custom scout once its preview completed). Applied after the field changes.'),
      })
      .refine((v) => Object.keys(v).some((k) => k !== "scout_id" && (v as Record<string, unknown>)[k] !== undefined), {
        message: "Give at least one field or a state to change",
      }),
    output: z.object({ scout: scoutOut }),
    annotations: UPDATES,
    async handler(args) {
      const body = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.query !== undefined ? { queryTemplate: args.query } : {}),
        ...(args.cadence ? { cadence: args.cadence } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
        ...(args.selected_company_ids ? { selectedCompanyIds: [...new Set(args.selected_company_ids)] } : {}),
      };
      let latest: unknown;
      const changed: string[] = [];
      if (Object.keys(body).length) {
        latest = (await callOperation(client, "updateGlobalScout", { params: { id: args.scout_id }, body })).data;
        changed.push(...Object.keys(args).filter((k) => k !== "scout_id" && k !== "state" && (args as Record<string, unknown>)[k] !== undefined));
      }
      if (args.state) {
        try {
          const { data } = await callOperation(client, "setGlobalScoutState", {
            params: { id: args.scout_id },
            body: { state: args.state },
          });
          latest = scoutFromState(data);
        } catch (err) {
          // The PATCH already landed: say so, so a retry only repeats the state change.
          if (changed.length && err instanceof HeliyosApiError) {
            throw new HeliyosApiError(
              err.code,
              `The field changes (${changed.join(", ")}) were saved, but the state change to "${args.state}" failed: ${err.message}`,
              err.status,
              err.details
            );
          }
          throw err;
        }
      }
      const scout = scoutOf(latest, { query: CONCISE_QUERY_CHARS });
      const did = [changed.length ? `changed ${changed.join(", ")}` : "", args.state ? `state ${args.state}` : ""]
        .filter(Boolean)
        .join("; ");
      return {
        text: [`Updated ${scoutHeading(scout)} (${did}).`, scoutFacts(scout)].filter(Boolean).join("\n"),
        structuredContent: { scout },
      };
    },
  });

  const remove = tool({
    name: "heliyos_scouts_delete",
    title: "Delete a scout",
    description:
      "Permanently deletes one custom scout and stops it on every company it runs on. Built-in (default) scouts cannot " +
      'be deleted; pause them with heliyos_scouts_update state "paused". Signals it already found are kept. This cannot ' +
      "be undone: confirm with the user first. Returns structuredContent {scout_id, deleted, deleted_company_scouts}.",
    input: z.strictObject({ scout_id: scoutIdInput }),
    output: z.object({
      scout_id: z.string(),
      deleted: z.boolean(),
      deleted_company_scouts: z.number().optional().describe("Company scouts removed with it."),
    }),
    annotations: DESTROYS,
    async handler(args) {
      const { data } = await callOperation(client, "deleteGlobalScout", { params: { id: args.scout_id } });
      const count = isRecord(data) ? numberOf(data.deleted_company_scouts) : undefined;
      return {
        text: `Deleted scout ${args.scout_id}${count !== undefined ? ` and its ${plural(count, "company scout")}` : ""}.`,
        structuredContent: { scout_id: args.scout_id, deleted: true, ...(count !== undefined ? { deleted_company_scouts: count } : {}) },
      };
    },
  });

  const companyList = tool({
    name: "heliyos_companies_scouts_list",
    title: "List a company's scouts",
    description:
      "Lists the scouts running on one company: each company scout's own id, its global scout id (scout_id, for " +
      "heliyos_scouts_get), status (active, paused or failed), cadence and last run. A company has only a few, so " +
      "there is no paging. Returns structuredContent {company_id, scouts:[{id, scout_id, name, status, ...}]}.",
    input: z.strictObject({
      company_id: companyIdInput,
      status: z.enum(COMPANY_SCOUT_STATUSES).optional().describe("Only scouts in this status: active, paused or failed."),
    }),
    output: z.object({ company_id: z.string(), scouts: z.array(companyScoutOut) }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "listCompanyScouts", {
        params: { id: args.company_id },
        query: args.status ? { status: args.status } : {},
      });
      const scouts = expectArray(data, "company scout list").map(companyScoutOf);
      const rows = scouts.map((s) => ({ ...s, last_run: day(s.last_run_at) }));
      const table = scouts.length
        ? fitTable(rows, [{ columns: ["id", "scout_id", "name", "status", "cadence", "last_run"], maxCell: 40 }], MAX_TEXT_CHARS - 400)
        : "No scouts run on this company. Add some with heliyos_companies_scouts_add.";
      return {
        text: `${plural(scouts.length, "scout")} on company ${args.company_id}:\n${table}`,
        structuredContent: { company_id: args.company_id, scouts },
      };
    },
  });

  const companyAdd = tool({
    name: "heliyos_companies_scouts_add",
    title: "Add scouts to a company",
    description:
      "Starts the given scouts on one company. Each scout_id must be an active global scout with apply_to watchlist " +
      "(see heliyos_scouts_list). Setup runs in the background; check it with heliyos_companies_scouts_list. A scout " +
      "already running on the company is not added twice. Scout runs use credits. Returns structuredContent " +
      "{company_id, scout_ids, status}.",
    input: z.strictObject({
      company_id: companyIdInput,
      scout_ids: z.array(hexId("each scout_ids entry")).min(1).max(50).describe("Global scout ids, 1 to 50."),
    }),
    output: z.object({
      company_id: z.string(),
      scout_ids: z.array(z.string()),
      status: z.string().optional().describe("processing: setup continues in the background."),
    }),
    annotations: CREATES,
    async handler(args) {
      const ids = [...new Set(args.scout_ids)];
      const { data } = await callOperation(client, "createCompanyScouts", {
        params: { id: args.company_id },
        body: { defaultScoutIds: ids },
      });
      const status = isRecord(data) ? stringOf(data.status) : undefined;
      return {
        text:
          `Starting ${plural(ids.length, "scout")} on company ${args.company_id} (${ids.join(", ")})` +
          `${status ? `: ${status}` : ""}. Check with heliyos_companies_scouts_list in a minute.`,
        structuredContent: { company_id: args.company_id, scout_ids: ids, ...(status ? { status } : {}) },
      };
    },
  });

  const companyRemove = tool({
    name: "heliyos_companies_scouts_remove",
    title: "Remove a company's scouts",
    description:
      "Stops and removes EVERY scout running on one company (there is no per-scout removal). Signals already found are " +
      "kept, and the company stays watched. This cannot be undone: confirm with the user first. Returns " +
      "structuredContent {company_id, removed (company scout ids), failed}.",
    input: z.strictObject({ company_id: companyIdInput }),
    output: z.object({
      company_id: z.string(),
      removed: z.array(z.string()),
      failed: z.array(z.string()).describe("Company scout ids that could not be removed; retry the call."),
    }),
    annotations: DESTROYS,
    async handler(args) {
      const { data } = await callOperation(client, "deleteCompanyScouts", { params: { id: args.company_id } });
      const raw = isRecord(data) ? data : {};
      const removed = stringList(raw.success);
      const failed = Array.isArray(raw.failed)
        ? raw.failed.filter(isRecord).map((f) => idOf(f.scout_id) ?? "").filter(Boolean)
        : [];
      const lines = [
        removed.length
          ? `Removed ${plural(removed.length, "scout")} from company ${args.company_id}: ${removed.join(", ")}.`
          : `No scouts were running on company ${args.company_id}.`,
        failed.length ? `Could not remove ${failed.join(", ")}; call again to retry.` : "",
      ];
      return {
        text: lines.filter(Boolean).join("\n"),
        structuredContent: { company_id: args.company_id, removed, failed },
      };
    },
  });

  const signalsList = tool({
    name: "heliyos_signals_list",
    title: "List signals",
    description:
      "Lists signals (events scouts found, such as a funding round or a leadership change), newest first. Filter by " +
      "company_id, by scout_id (a global scout from heliyos_scouts_list) and by status (new = unread). Each signal shows " +
      "its id, date, company and a summary; detailed adds source URLs. Mark them read with heliyos_signals_mark_read. " +
      "Returns structuredContent {signals:[{id, status, detected_at, company_id, company_name, summary}], next_cursor}.",
    input: z.strictObject({
      company_id: companyIdInput.optional().describe("Only signals about this company record."),
      scout_id: scoutIdInput.optional().describe("Only signals found by this global scout."),
      status: z.enum(SIGNAL_STATUSES).optional().describe("new (unread), read or archived."),
      limit: pageLimit("Signals"),
      cursor: cursorInput,
      response_format: responseFormat("one line per signal", "full summaries, source URLs and relevance"),
    }),
    output: z.object({ signals: z.array(signalOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const query = {
        limit: args.limit,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.status ? { status: args.status } : {}),
        ...(args.company_id ? { companyId: args.company_id } : {}),
      };
      // listSignals' scoutId is a company scout (instance) id, so a global scout is read through its own route.
      const { data, meta } = args.scout_id
        ? await callOperation(client, "listGlobalScoutSignals", { params: { id: args.scout_id }, query })
        : await callOperation(client, "listSignals", { query });
      const detailed = args.response_format === "detailed";
      const signals = expectArray(data, "signal list").map((raw) => signalOf(raw, detailed));
      const next = nextCursorOf(meta);
      const body = signals.length
        ? signals
            .map((s) =>
              detailed
                ? [signalLine(s), s.sources?.length ? `  sources: ${s.sources.join(", ")}` : "", s.company_id ? `  company_id: ${s.company_id}` : ""]
                    .filter(Boolean)
                    .join("\n")
                : signalLine(s)
            )
            .join("\n")
        : "No signals matched.";
      return {
        text: `${plural(signals.length, "signal")}:\n${body}\n\n${pagingFooter("heliyos_signals_list", next)}`,
        structuredContent: { signals, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const markRead = tool({
    name: "heliyos_signals_mark_read",
    title: "Mark signals read",
    description:
      `Marks signals read: either the given signal_ids (1 to ${MAX_SIGNAL_IDS}) or every new signal about one ` +
      "company (company_id). Pass exactly one of the two. Marking a read signal again changes nothing. Returns " +
      "structuredContent {marked, failed} for signal_ids, or {company_id, marked_count} for a company.",
    input: z
      .strictObject({
        signal_ids: z
          .array(hexId("each signal_ids entry"))
          .min(1)
          .max(MAX_SIGNAL_IDS)
          .optional()
          .describe(`Signal ids from heliyos_signals_list, 1 to ${MAX_SIGNAL_IDS}.`),
        company_id: companyIdInput.optional().describe("Mark every new signal about this company read."),
      })
      .refine((v) => (v.signal_ids === undefined) !== (v.company_id === undefined), {
        message: "Pass exactly one of signal_ids or company_id",
      }),
    output: z.object({
      marked: z.array(z.string()).optional(),
      failed: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })).optional(),
      company_id: z.string().optional(),
      marked_count: z.number().optional(),
    }),
    annotations: UPDATES,
    async handler(args) {
      if (args.company_id) {
        const { data } = await callOperation(client, "bulkMarkSignalsRead", { body: { companyId: args.company_id } });
        const raw = isRecord(data) ? data : {};
        // The agent service answers a failed bulk update with 200 {success: false, error}.
        if (raw.success === false) throw new HeliyosApiError("INTERNAL", "The API could not mark the signals read", 0);
        const count = numberOf(raw.marked_count) ?? 0;
        return {
          text: `Marked ${plural(count, "new signal")} about company ${args.company_id} read.`,
          structuredContent: { company_id: args.company_id, marked_count: count },
        };
      }
      const ids = [...new Set(args.signal_ids ?? [])];
      const marked: string[] = [];
      const failed: Array<{ id: string; code: string; message: string; error: unknown }> = [];
      // One at a time: a long list must not burst the per-key rate limit.
      for (const id of ids) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await callOperation(client, "markSignalRead", { params: { id } });
          marked.push(id);
        } catch (err) {
          if (!(err instanceof HeliyosApiError)) throw err;
          failed.push({ id, code: String(err.code), message: err.message, error: err });
        }
      }
      if (!marked.length && failed[0]) throw failed[0].error;
      const failedOut = failed.map(({ id, code, message }) => ({ id, code, message: clip(redactSecrets(message), 200) }));
      const lines = [
        `Marked ${plural(marked.length, "signal")} read: ${marked.join(", ")}.`,
        ...failedOut.map((f) => `Not marked ${f.id}: ${f.code} ${f.message}`),
      ];
      return { text: lines.join("\n"), structuredContent: { marked, failed: failedOut } };
    },
  });

  return [list, get, create, update, remove, companyList, companyAdd, companyRemove, signalsList, markRead];
}
