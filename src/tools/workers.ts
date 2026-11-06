/**
 * Workers: the AI agents of the workspace. Default workers (Platform Admin,
 * Conversation Analyst, Meeting Analyst, Memory Agent) are seeded for every
 * workspace and only their instructions, description, active flag, memory and
 * triggers can change; custom workers are fully editable and deletable.
 * Runs are read with heliyos_runs_list / heliyos_runs_get.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitBlocks, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  DESTROYS,
  expectObject,
  hexId,
  idOf,
  label,
  optional,
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
import { assertKnownEvents, splitToolNames } from "./catalogs.js";

const CONCISE_INSTRUCTIONS_CHARS = 1500;

/** Trigger kinds a tool can set. The platform also stores webhook (same as event) and playground. */
const TRIGGER_TYPES = ["task_created", "mention", "event", "scheduled"] as const;
const CRON = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

// ---------------------------------------------------------------- shapes

const triggerOut = z.object({
  type: z.string().describe("task_created, mention, event (webhook), scheduled or playground."),
  events: z.array(z.string()).optional().describe("event only: the subscribed event names."),
  cron: z.string().optional().describe("scheduled only: 5-field cron."),
  at: z.string().optional().describe("scheduled only: a one-time local wall time."),
  timezone: z.string().optional(),
});

const workerOut = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["default", "custom"]).describe("default workers are built in; only custom ones can be deleted."),
  is_active: z.boolean(),
  description: z.string().optional(),
  tool_name: z.string().optional().describe("Stable snake_case name the orchestrator calls it by."),
  triggers: z.array(triggerOut).optional(),
  instructions: z.string().optional().describe("Markdown; concise cuts it, detailed returns all of it."),
  tool_names: z.array(z.string()).optional().describe("Detailed only: Heliyos tools the worker may call (names from heliyos_workers_tools_list)."),
  action_ids: z.array(z.string()).optional().describe("Detailed only: ids of the integration actions it may call (action_id in heliyos_workers_tools_list)."),
  read_only: z.boolean().optional().describe("Detailed only: the worker may not change data."),
  memory_enabled: z.boolean().optional().describe("Detailed only."),
  resources_scope: z.string().optional().describe("Detailed only: which files it reads (everything, org_knowledge, account_files, selected_files)."),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
type WorkerOut = z.infer<typeof workerOut>;

function triggerOf(raw: Record<string, unknown>): z.infer<typeof triggerOut> {
  const match = isRecord(raw.match) ? raw.match : {};
  const webhook = match.webhookEvent;
  const events = [
    ...(Array.isArray(raw.events) ? raw.events : []),
    ...(Array.isArray(webhook) ? webhook : typeof webhook === "string" ? [webhook] : []),
  ].filter((e): e is string => typeof e === "string");
  const type = stringOf(raw.type) ?? "unknown";
  return {
    type: type === "webhook" ? "event" : type === "schedule" ? "scheduled" : type,
    ...(events.length ? { events } : {}),
    ...optional("cron", stringOf(match.schedule)),
    ...optional("at", stringOf(match.at)),
    ...optional("timezone", stringOf(match.timezone)),
  };
}

function workerOf(data: unknown, mode: "list" | "concise" | "detailed"): WorkerOut {
  const raw = expectObject(data, "worker");
  const triggers = (Array.isArray(raw.triggers) ? raw.triggers : []).filter(isRecord).map(triggerOf);
  const instructions = stringOf(raw.instructions);
  const policy = isRecord(raw.toolPolicy) ? raw.toolPolicy : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  const resources = isRecord(raw.resources) ? raw.resources : {};
  const detailed = mode === "detailed";
  return {
    id: requireId(raw, "worker"),
    name: stringOf(raw.name) ?? "",
    type: raw.type === "default" ? "default" : "custom",
    is_active: raw.isActive !== false,
    ...optional("description", stringOf(raw.description)),
    ...optional("tool_name", stringOf(raw.toolName)),
    ...(mode === "list" ? {} : { triggers }),
    ...(mode !== "list" && instructions ? { instructions: detailed ? instructions : clip(instructions, CONCISE_INSTRUCTIONS_CHARS) } : {}),
    ...(detailed && Array.isArray(raw.toolNames) ? { tool_names: raw.toolNames.filter((t): t is string => typeof t === "string") } : {}),
    ...(detailed && Array.isArray(raw.actionIds)
      ? { action_ids: raw.actionIds.map(idOf).filter((id): id is string => id !== undefined) }
      : {}),
    ...(detailed && typeof policy.readOnly === "boolean" ? { read_only: policy.readOnly } : {}),
    ...(detailed && typeof memory.enabled === "boolean" ? { memory_enabled: memory.enabled } : {}),
    ...(detailed ? optional("resources_scope", stringOf(resources.scope)) : {}),
    ...(detailed ? timestampsOf(raw) : {}),
  };
}

const triggerText = (t: z.infer<typeof triggerOut>) =>
  t.type === "event"
    ? `event (${t.events?.join(", ") || "any"})`
    : t.type === "scheduled"
      ? `scheduled (${[t.cron, t.at, t.timezone].filter(Boolean).join(" ")})`
      : t.type;

const workerLine = (w: WorkerOut) =>
  [
    `${label(w)}: ${w.type}${w.is_active ? "" : ", inactive"}${w.triggers?.length ? `; triggers ${w.triggers.map(triggerText).join(", ")}` : ""}`,
    w.description ? `  ${w.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/** "tools: a, b; actions: 2" for a detailed worker, or "" when it has neither. */
const toolsLine = (w: WorkerOut) =>
  [
    w.tool_names?.length ? `tools: ${w.tool_names.join(", ")}` : "",
    w.action_ids?.length ? `integration actions: ${plural(w.action_ids.length, "action")} (${w.action_ids.join(", ")})` : "",
  ]
    .filter(Boolean)
    .join("; ");

// ---------------------------------------------------------------- inputs

const triggerInput = z
  .strictObject({
    type: z.enum(TRIGGER_TYPES).describe("task_created (every new task), mention (@worker in chat), event (named events) or scheduled (cron)."),
    events: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(200)
      .optional()
      .describe('event only: event names such as "task.created" or "deal.updated".'),
    cron: z.string().trim().regex(CRON, "cron must have 5 fields, for example 0 8 * * 1-5").optional().describe('scheduled only: 5-field cron, for example "0 8 * * 1-5".'),
    timezone: z.string().trim().min(1).max(64).optional().describe('scheduled only: IANA zone, for example "Europe/Berlin". Default UTC.'),
  })
  .refine((t) => t.type !== "event" || (t.events?.length ?? 0) > 0, { message: "an event trigger needs events" })
  .refine((t) => t.type !== "scheduled" || t.cron !== undefined, { message: "a scheduled trigger needs cron" })
  .refine((t) => t.type === "event" || t.events === undefined, { message: "events only apply to event triggers" })
  .refine((t) => t.type === "scheduled" || (t.cron === undefined && t.timezone === undefined), {
    message: "cron and timezone only apply to scheduled triggers",
  });
type TriggerInput = z.infer<typeof triggerInput>;

type ApiTrigger =
  | { type: "task_created" | "mention" }
  | { type: "event"; events: string[] }
  | { type: "scheduled"; match: { schedule: string; timezone: string } };

const toApiTrigger = (t: TriggerInput): ApiTrigger =>
  t.type === "event"
    ? { type: "event", events: t.events ?? [] }
    : t.type === "scheduled"
      ? { type: "scheduled", match: { schedule: t.cron ?? "", timezone: t.timezone ?? "UTC" } }
      : { type: t.type };

const nameInput = z.string().trim().min(1).max(200).describe("Worker name, unique in the workspace.");
const instructionsInput = z.string().trim().min(1).max(50_000).describe("What the worker does and how, in Markdown.");
const descriptionInput = z.string().trim().max(2000).describe("One line shown in the worker catalog.");
const triggersInput = z
  .array(triggerInput)
  .max(50)
  .describe(
    "When the worker runs. Replaces the current triggers; on a default worker its built-in triggers stay. Event names " +
      "must come from heliyos_triggers_list."
  );
const toolNamesInput = z
  .array(z.string().trim().min(1).max(200))
  .max(500)
  .describe(
    "The tools the worker may call, by name from heliyos_workers_tools_list (Heliyos tools and integration actions " +
      "alike). Unknown names are refused. Custom workers only."
  );

/** Event names of the given triggers, for catalog validation. */
const eventsOf = (triggers: readonly TriggerInput[] | undefined) => triggers?.flatMap((t) => t.events ?? []) ?? [];

/**
 * The parts of a create/update body that need a catalog read: event names
 * checked against heliyos_triggers_list, tool names split into the worker's
 * `toolNames` and `actionIds` by heliyos_workers_tools_list. `existing` is the
 * worker's current toolNames (update only), so hidden plumbing it was wired
 * with survives a new selection. Both reads run before anything is written.
 */
async function catalogChecked(
  client: ToolContext["client"],
  args: { triggers?: readonly TriggerInput[] | undefined; tool_names?: readonly string[] | undefined },
  existing: readonly string[] = []
): Promise<{ toolNames?: string[]; actionIds?: string[] }> {
  const events = eventsOf(args.triggers);
  const [, split] = await Promise.all([
    events.length ? assertKnownEvents(client, events) : Promise.resolve(),
    args.tool_names ? splitToolNames(client, args.tool_names, existing) : Promise.resolve(undefined),
  ]);
  return split ?? {};
}

/** The current toolNames of a worker, read before an update that replaces them. */
async function currentToolNames(client: ToolContext["client"], workerId: string): Promise<string[]> {
  const { data } = await callOperation(client, "getAgent", { params: { id: workerId } });
  const raw = expectObject(data, "worker");
  return Array.isArray(raw.toolNames) ? raw.toolNames.filter((t): t is string => typeof t === "string") : [];
}

// ---------------------------------------------------------------- tools

/** Builds the tools that list, read, create, update and delete workers, from the shared tool context. */
export function workerTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_workers_list",
    title: "List workers",
    description:
      "Lists the workspace's workers (AI agents): the built-in default ones and custom ones, each with its id, type, " +
      "active flag, description and triggers. Returns every worker in one page (a workspace has a handful). Use " +
      "heliyos_workers_get for a worker's instructions, heliyos_runs_list with worker_id for its runs. Returns " +
      "structuredContent {workers:[{id, name, type, is_active, ...}]}.",
    input: z.strictObject({
      type: z.enum(["default", "custom"]).optional().describe("Only built-in (default) or only custom workers."),
      is_active: z.boolean().optional().describe("Only active (true) or only inactive (false) workers."),
      response_format: responseFormat("one row per worker", "each worker's triggers too"),
    }),
    output: z.object({ workers: z.array(workerOut) }),
    annotations: READ_ONLY,
    truncationHint: 'Use response_format "concise", or filter by type or is_active.',
    async handler(args) {
      const { data } = await callOperation(client, "listAgents");
      const detailed = args.response_format === "detailed";
      const workers = expectArray(data, "worker list")
        .map((raw) => workerOf(raw, detailed ? "concise" : "list"))
        .map(({ instructions: _i, ...w }) => w)
        .filter((w) => (args.type === undefined || w.type === args.type) && (args.is_active === undefined || w.is_active === args.is_active));
      const body =
        workers.length === 0
          ? "No workers matched."
          : fitBlocks(workers.map(workerLine), workers.map((w) => w.id), MAX_TEXT_CHARS - 400, {
              items: "workers",
              key: "workers",
              readHint: "Filter by type or is_active.",
            });
      return { text: `${plural(workers.length, "worker")}:\n${body}`, structuredContent: { workers } };
    },
  });

  const get = tool({
    name: "heliyos_workers_get",
    title: "Get a worker",
    description:
      "Fetches one worker by id: name, type, active flag, description, triggers and instructions (cut at " +
      `${CONCISE_INSTRUCTIONS_CHARS} characters in concise). "detailed" adds the full instructions, the tools it may call, ` +
      "read-only and memory flags, file scope and times. Returns structuredContent {worker}.",
    input: z.strictObject({
      worker_id: hexId("worker_id"),
      response_format: responseFormat("the worker with shortened instructions", "full instructions, tools, flags and times"),
    }),
    output: z.object({ worker: workerOut }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "getAgent", { params: { id: args.worker_id } });
      const worker = workerOf(data, args.response_format === "detailed" ? "detailed" : "concise");
      const { instructions, triggers, id: _id, name: _n, type: _t, is_active: _a, description: _d, ...rest } = worker;
      const details = { ...rest, ...(triggers?.length ? { triggers: triggers.map(triggerText).join("; ") } : {}) };
      const text = [
        workerLine(worker),
        Object.keys(details).length ? renderRecord(details) : "",
        instructions ? `instructions:\n${instructions}` : "instructions: (none)",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structuredContent: { worker } };
    },
  });

  const create = tool({
    name: "heliyos_workers_create",
    title: "Create a worker",
    description:
      "Creates a custom worker (AI agent) with a name, instructions and, optionally, triggers that start it: on every new " +
      "task, when mentioned in chat, on named events, or on a cron schedule. It starts active unless is_active is false, " +
      "and its runs use credits and can change records or send email (consequential actions wait for approval in " +
      "Heliyos), so confirm with the user first. Names are unique; a repeat fails with CONFLICT. Before calling: " +
      "heliyos_triggers_list for valid event names and heliyos_workers_tools_list for the tool_names it may use " +
      "(both are checked; unknown names are refused). Files are configured in the Heliyos web app. Returns " +
      "structuredContent {worker}.",
    input: z.strictObject({
      name: nameInput,
      instructions: instructionsInput,
      description: descriptionInput.optional(),
      is_active: z.boolean().optional().describe("Default true."),
      read_only: z.boolean().optional().describe("true: the worker may read but never change data. Default false."),
      memory_enabled: z.boolean().optional().describe("true: the worker keeps memory across runs. Default from the workspace."),
      triggers: triggersInput.optional(),
      tool_names: toolNamesInput.optional(),
    }),
    output: z.object({ worker: workerOut }),
    annotations: CREATES,
    async handler(args) {
      const tools = await catalogChecked(client, args);
      const { data } = await callOperation(client, "createAgent", {
        body: {
          name: args.name,
          instructions: args.instructions,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
          ...(args.read_only !== undefined ? { toolPolicy: { readOnly: args.read_only } } : {}),
          ...(args.memory_enabled !== undefined ? { memory: { enabled: args.memory_enabled } } : {}),
          ...(args.triggers ? { triggers: args.triggers.map(toApiTrigger) } : {}),
          ...tools,
        },
      });
      const worker = workerOf(data, "detailed");
      return { text: [`Created worker ${workerLine(worker)}`, toolsLine(worker)].filter(Boolean).join("\n"), structuredContent: { worker } };
    },
  });

  const update = tool({
    name: "heliyos_workers_update",
    title: "Update a worker",
    description:
      "Changes a worker by id; what you leave out is kept. Custom workers: name, instructions, description, is_active, " +
      "read_only, memory_enabled, triggers and tool_names. Default (built-in) workers: only instructions, description, " +
      "is_active, memory_enabled and triggers; the rest is ignored. `triggers` REPLACES the worker's own triggers (a " +
      "default worker keeps its built-in ones) and `tool_names` REPLACES its tools: pass every tool it should keep " +
      "(heliyos_workers_get detailed shows the current ones, heliyos_workers_tools_list the valid names). Set is_active " +
      "false to pause a worker. Returns structuredContent {worker}.",
    input: z
      .strictObject({
        worker_id: hexId("worker_id"),
        name: nameInput.optional(),
        instructions: instructionsInput.optional(),
        description: descriptionInput.optional(),
        is_active: z.boolean().optional().describe("false pauses the worker; true resumes it."),
        read_only: z.boolean().optional().describe("true: the worker may read but never change data (custom workers only)."),
        memory_enabled: z.boolean().optional().describe("Whether the worker keeps memory across runs."),
        triggers: triggersInput.optional(),
        tool_names: toolNamesInput.optional(),
      })
      .refine(
        (v) =>
          [v.name, v.instructions, v.description, v.is_active, v.read_only, v.memory_enabled, v.triggers, v.tool_names].some(
            (x) => x !== undefined
          ),
        { message: "Give at least one of name, instructions, description, is_active, read_only, memory_enabled, triggers or tool_names" }
      ),
    output: z.object({ worker: workerOut }),
    annotations: UPDATES,
    async handler(args) {
      const { worker_id, ...changes } = args;
      const existing = changes.tool_names ? await currentToolNames(client, worker_id) : [];
      const tools = await catalogChecked(client, changes, existing);
      const { data } = await callOperation(client, "updateAgent", {
        params: { id: worker_id },
        body: {
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.instructions !== undefined ? { instructions: changes.instructions } : {}),
          ...(changes.description !== undefined ? { description: changes.description } : {}),
          ...(changes.is_active !== undefined ? { isActive: changes.is_active } : {}),
          ...(changes.read_only !== undefined ? { toolPolicy: { readOnly: changes.read_only } } : {}),
          ...(changes.memory_enabled !== undefined ? { memory: { enabled: changes.memory_enabled } } : {}),
          ...(changes.triggers ? { triggers: changes.triggers.map(toApiTrigger) } : {}),
          ...tools,
        },
      });
      const worker = workerOf(data, "detailed");
      const ignored =
        worker.type === "default"
          ? (["name", "read_only", "tool_names"] as const).filter((k) => changes[k] !== undefined)
          : [];
      const summary = Object.fromEntries(
        Object.entries({
          ...changes,
          triggers: changes.triggers?.map(toApiTrigger).map((t) => JSON.stringify(t)).join("; "),
          tool_names: changes.tool_names?.join(", "),
        }).filter(([, v]) => v !== undefined)
      );
      return {
        text: [
          `Updated worker ${workerLine(worker)}`,
          renderRecord(summary),
          toolsLine(worker),
          ignored.length ? `Note: ${ignored.join(", ")} cannot change on a default worker and was ignored.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        structuredContent: { worker },
      };
    },
  });

  const remove = tool({
    name: "heliyos_workers_delete",
    title: "Delete a worker",
    description:
      "Permanently deletes one custom worker by id and its schedules. Default (built-in) workers cannot be deleted; pause " +
      "them with heliyos_workers_update is_active false. Past runs are kept. This cannot be undone: confirm with the " +
      "user first. Returns structuredContent {worker_id, deleted}.",
    input: z.strictObject({ worker_id: hexId("worker_id") }),
    output: z.object({ worker_id: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      const { data } = await callOperation(client, "deleteAgent", { params: { id: args.worker_id } });
      const deleted = !isRecord(data) || data.deleted !== false;
      if (!deleted) throw new HeliyosApiError("INTERNAL", "The API did not confirm the deletion", 0);
      return { text: `Deleted worker ${args.worker_id}.`, structuredContent: { worker_id: args.worker_id, deleted: true } };
    },
  });

  return [list, get, create, update, remove];
}
