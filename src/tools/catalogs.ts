/**
 * The two catalogs a worker is built from: the triggers it can subscribe to
 * (listWorkerTriggers) and the tools it may call (listWorkerTools: Heliyos's
 * own tools plus the organization's integration actions). Both are read-only
 * and small enough to return in one page. `heliyos_workers_create` and
 * `heliyos_workers_update` validate their `events` and `tool_names` against
 * these catalogs through the loaders exported here.
 */
import * as z from "zod/v4";
import { HeliyosApiError, type HeliyosClient } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { fitBlocks, MAX_TEXT_CHARS } from "../format/text.js";
import { isRecord } from "../util.js";
import { expectObject, idOf, plural, READ_ONLY, responseFormat, stringOf, type ToolContext } from "./common.js";
import { tool, type ToolSpec } from "./define.js";

// ---------------------------------------------------------------- triggers

const TRIGGER_KINDS = ["event", "mention", "schedule"] as const;

const triggerCatalogOut = z.object({
  name: z.string().describe("The event name a worker subscribes to, for example task.created."),
  kind: z.string().describe("event, mention or schedule."),
  label: z.string().optional(),
  description: z.string().optional(),
  object_type: z.string().optional().describe("What the event is about: company, people, deals, task, note, interaction, ..."),
  source: z.string().optional().describe("Who raises it: platform, internal, nylas, recall, typeform, composio, ..."),
  integration: z.string().optional().describe("The connected app that delivers it, when one does (for example gmail)."),
  selects_attributes: z.boolean().optional().describe("true: the trigger watches chosen fields (configured in the web app)."),
});
/** The TypeScript type of one worker trigger in tool output, inferred from triggerCatalogOut. */
export type TriggerCatalogOut = z.infer<typeof triggerCatalogOut>;

function triggerCatalogOf(raw: Record<string, unknown>): TriggerCatalogOut | undefined {
  const name = stringOf(raw.name);
  if (!name) return undefined;
  const integration = isRecord(raw.integration) ? (stringOf(raw.integration.provider) ?? stringOf(raw.integration.name)) : stringOf(raw.integration);
  return {
    name,
    kind: stringOf(raw.kind) ?? "event",
    ...(stringOf(raw.label) ? { label: stringOf(raw.label) } : {}),
    ...(stringOf(raw.description) ? { description: stringOf(raw.description) } : {}),
    ...(stringOf(raw.objectType) ? { object_type: stringOf(raw.objectType) } : {}),
    ...(stringOf(raw.source) ? { source: stringOf(raw.source) } : {}),
    ...(integration ? { integration } : {}),
    ...(raw.selectsAttributes === true ? { selects_attributes: true } : {}),
  };
}

/** Every trigger of the catalog, as the platform serves it (`{triggers:[...]}`). */
export async function loadTriggerCatalog(client: HeliyosClient): Promise<TriggerCatalogOut[]> {
  const { data } = await callOperation(client, "listWorkerTriggers");
  const body = expectObject(data, "trigger catalog");
  return expectArray(body.triggers, "trigger catalog")
    .filter(isRecord)
    .map(triggerCatalogOf)
    .filter((t): t is TriggerCatalogOut => t !== undefined);
}

/** Refuses event names the catalog does not know, naming the closest known ones. */
export async function assertKnownEvents(client: HeliyosClient, events: readonly string[]): Promise<void> {
  const catalog = await loadTriggerCatalog(client);
  const known = new Set(catalog.filter((t) => t.kind === "event").map((t) => t.name));
  const unknown = [...new Set(events)].filter((e) => !known.has(e));
  if (unknown.length === 0) return;
  const sample = [...known].sort().slice(0, 12).join(", ");
  throw new HeliyosApiError(
    "VALIDATION_FAILED",
    `Unknown event${unknown.length > 1 ? "s" : ""} ${unknown.map((e) => `"${e}"`).join(", ")}. ` +
      `Pick names from heliyos_triggers_list, for example ${sample}`,
    0
  );
}

// ---------------------------------------------------------------- worker tools

const TOOL_SOURCES = ["builtin", "action"] as const;

const workerToolOut = z.object({
  name: z.string().describe("The name to put in tool_names on heliyos_workers_create / heliyos_workers_update."),
  label: z.string().optional().describe("Human-readable name."),
  description: z.string().optional(),
  source: z.string().describe("builtin (a Heliyos tool) or action (a connected integration's action)."),
  risk: z.string().optional().describe("read, write_crm, communicate, schedule_meeting, external or schedule."),
  provider: z.string().optional().describe("action only: the integration, for example gmail, hubspot, google_drive."),
  action_id: z.string().optional().describe("action only: the action's id."),
  common: z.boolean().optional().describe("true: a tool most workers should have."),
  input: z.record(z.string(), z.unknown()).optional().describe("Detailed only: the tool's input JSON schema."),
});
/** The TypeScript type of one tool a worker can use, inferred from workerToolOut. */
export type WorkerToolOut = z.infer<typeof workerToolOut>;

function workerToolOf(raw: Record<string, unknown>, detailed: boolean): WorkerToolOut | undefined {
  const name = stringOf(raw.name);
  if (!name) return undefined;
  const source = stringOf(raw.source) ?? (raw.is_internal === false ? "action" : "builtin");
  const actionId = idOf(raw.action_id);
  return {
    name,
    ...(stringOf(raw.label) ?? stringOf(raw.display_name) ? { label: stringOf(raw.label) ?? stringOf(raw.display_name) } : {}),
    ...(stringOf(raw.description) ? { description: stringOf(raw.description) } : {}),
    source,
    ...(stringOf(raw.risk) ? { risk: stringOf(raw.risk) } : {}),
    ...(stringOf(raw.provider) ? { provider: stringOf(raw.provider) } : {}),
    ...(actionId ? { action_id: actionId } : {}),
    ...(raw.common === true ? { common: true } : {}),
    ...(detailed && isRecord(raw.input) ? { input: raw.input } : {}),
  };
}

/**
 * The tool registry a worker chooses from, hidden orchestrator plumbing left
 * out (the web app hides it too; the platform wires it in at run time).
 */
export async function loadWorkerToolCatalog(client: HeliyosClient, detailed = false): Promise<WorkerToolOut[]> {
  const { data } = await callOperation(client, "listWorkerTools");
  const body = expectObject(data, "worker tool catalog");
  return expectArray(body.tools, "worker tool catalog")
    .filter(isRecord)
    .filter((raw) => raw.is_hidden !== true)
    .map((raw) => workerToolOf(raw, detailed))
    .filter((t): t is WorkerToolOut => t !== undefined);
}

/**
 * Splits chosen tool names into what the worker stores: built-in names in
 * `toolNames`, integration actions by id in `actionIds` (as the web app does).
 * Unknown names are refused with the closest known ones. Names in `existing`
 * that the catalog does not show (hidden orchestrator plumbing a worker was
 * wired with) are kept in `toolNames`, as the web app keeps them on save.
 */
export async function splitToolNames(
  client: HeliyosClient,
  names: readonly string[],
  existing: readonly string[] = []
): Promise<{ toolNames: string[]; actionIds: string[] }> {
  const catalog = await loadWorkerToolCatalog(client);
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const unknown = [...new Set(names)].filter((n) => !byName.has(n));
  if (unknown.length) {
    const sample = catalog
      .map((t) => t.name)
      .sort()
      .slice(0, 12)
      .join(", ");
    throw new HeliyosApiError(
      "VALIDATION_FAILED",
      `Unknown tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}. ` +
        `Pick names from heliyos_workers_tools_list, for example ${sample}`,
      0
    );
  }
  const toolNames: string[] = [];
  const actionIds: string[] = [];
  for (const name of new Set(names)) {
    const entry = byName.get(name);
    if (entry?.source === "action" && entry.action_id) actionIds.push(entry.action_id);
    else toolNames.push(name);
  }
  for (const name of existing) if (!byName.has(name) && !toolNames.includes(name)) toolNames.push(name);
  return { toolNames, actionIds };
}

// ---------------------------------------------------------------- tools

/** Builds the tools that list worker triggers and the tools a worker can use, from the shared tool context. */
export function catalogTools({ client }: ToolContext): ToolSpec[] {
  const triggers = tool({
    name: "heliyos_triggers_list",
    title: "List worker triggers",
    description:
      "Lists the events a worker can subscribe to (the names to put in an event trigger's `events` on " +
      "heliyos_workers_create / heliyos_workers_update), each with what it means and the object it is about. Also " +
      "lists the mention and schedule kinds. Call it before creating a worker that reacts to events. Returns every " +
      "trigger in one page. Returns structuredContent {triggers:[{name, kind, label, description, object_type, ...}]}.",
    input: z.strictObject({
      kind: z.enum(TRIGGER_KINDS).optional().describe("Only event, mention or schedule triggers."),
      object_type: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .optional()
        .describe("Only triggers about this object: company, people, deals, task, note, interaction, review, signal, ..."),
    }),
    output: z.object({ triggers: z.array(triggerCatalogOut) }),
    annotations: READ_ONLY,
    truncationHint: "Filter by kind or object_type.",
    async handler(args) {
      const all = await loadTriggerCatalog(client);
      const wanted = args.object_type?.toLowerCase();
      const triggers = all.filter(
        (t) => (args.kind === undefined || t.kind === args.kind) && (wanted === undefined || (t.object_type ?? "").toLowerCase() === wanted)
      );
      const lines = triggers.map(
        (t) =>
          `${t.name} (${[t.kind, t.object_type, t.integration ?? t.source].filter(Boolean).join(", ")})` +
          `${t.label ? `: ${t.label}` : ""}${t.description ? ` — ${t.description}` : ""}${t.selects_attributes ? " [watches chosen fields; configure in the web app]" : ""}`
      );
      const body =
        triggers.length === 0
          ? "No triggers matched."
          : fitBlocks(lines, triggers.map((t) => t.name), MAX_TEXT_CHARS - 300, {
              items: "triggers",
              key: "triggers",
              readHint: "Filter by kind or object_type.",
            });
      return { text: `${plural(triggers.length, "trigger")}:\n${body}`, structuredContent: { triggers } };
    },
  });

  const workerTools = tool({
    name: "heliyos_workers_tools_list",
    title: "List tools a worker can use",
    description:
      "Lists the tools a worker may be given (the names to put in `tool_names` on heliyos_workers_create / " +
      "heliyos_workers_update): Heliyos's own tools (source builtin) and the actions of the workspace's connected " +
      "integrations (source action, for example sending email through the connected mailbox). Each has a risk class; " +
      "communicate, write_crm and external tools do things people will want to review. Call it before creating a worker. " +
      "Returns every tool in one page. Returns structuredContent {tools:[{name, label, description, source, risk, provider}]}.",
    input: z.strictObject({
      source: z.enum(TOOL_SOURCES).optional().describe("Only Heliyos's own tools (builtin) or only integration actions (action)."),
      provider: z.string().trim().min(1).max(100).optional().describe("Only one integration's actions, for example gmail or hubspot."),
      search: z.string().trim().min(1).max(200).optional().describe("Plain words matched against names, labels and descriptions."),
      response_format: responseFormat("name, label, description, source and risk", "each tool's input schema too"),
    }),
    output: z.object({ tools: z.array(workerToolOut) }),
    annotations: READ_ONLY,
    truncationHint: 'Filter by source, provider or search, or use response_format "concise".',
    async handler(args) {
      const detailed = args.response_format === "detailed";
      const all = await loadWorkerToolCatalog(client, detailed);
      const needle = args.search?.toLowerCase();
      const provider = args.provider?.toLowerCase();
      const tools = all.filter(
        (t) =>
          (args.source === undefined || t.source === args.source) &&
          (provider === undefined || (t.provider ?? "").toLowerCase() === provider) &&
          (needle === undefined || [t.name, t.label, t.description].some((s) => s?.toLowerCase().includes(needle)))
      );
      const lines = tools.map(
        (t) =>
          `${t.name} (${[t.source, t.risk, t.provider].filter(Boolean).join(", ")})${t.label && t.label !== t.name ? `: ${t.label}` : ""}` +
          `${t.description ? ` — ${t.description}` : ""}${detailed && t.input ? `\n  input: ${JSON.stringify(t.input)}` : ""}`
      );
      const body =
        tools.length === 0
          ? "No tools matched."
          : fitBlocks(lines, tools.map((t) => t.name), MAX_TEXT_CHARS - 300, {
              items: "tools",
              key: "tools",
              readHint: "Filter by source, provider or search.",
            });
      return { text: `${plural(tools.length, "tool")}:\n${body}`, structuredContent: { tools } };
    },
  });

  return [triggers, workerTools];
}
