/**
 * Ask Heliyos and follow worker runs. Three tools: heliyos_ask (a chat turn with
 * the orchestrator that long-polls up to 90 s), heliyos_runs_get (a run's status
 * and steps, optionally long-polling 30 s more) and heliyos_runs_list.
 *
 * Shapes and statuses follow the Heliyos API's orchestrator chat and worker run
 * contracts (see the API reference for /v1/platform/orchestrator/chat and
 * /v1/platform/workers/runs); the run status list is the API's run contract.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitBlocks, fitTable, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  cursorInput,
  endOfDay,
  expectObject,
  hexId,
  isoDate,
  LIST_TRUNCATION_HINT,
  pagedQuery,
  sortInput,
  namesOf,
  nextCursorOf,
  numberOf,
  optional,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  STARTS_RUN,
  responseFormat,
  stringOf,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

/** Every orchestrator run status. */
const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "paused",
  "waiting",
  "scheduled",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "stopped",
] as const;
/** Sort fields the platform accepts for worker runs. */
const RUN_SORT_FIELDS = ["createdAt", "updatedAt", "status", "title", "surface"] as const;

/** A run in one of these never changes again (platform TERMINAL_RUN_STATUSES). */
const TERMINAL = new Set(["completed", "failed", "skipped", "cancelled", "stopped"]);
/** Settled but not finished: the run waits on a person or a schedule. */
const HUMAN_WAIT = new Set(["awaiting_approval", "paused", "waiting", "scheduled"]);

/** The platform's caps: POST /orchestrator/chats `wait` ≤ 90, GET /workers/runs/{id} `wait` ≤ 30. */
const ASK_WAIT_SECONDS = 90;
const RUN_WAIT_SECONDS = 30;
const stillRunning = (runId: string) => `Still running. Call heliyos_runs_get with run_id ${runId} and wait: true.`;
const ANSWER_CHARS = 12_000;
const PAYLOAD_CHARS = 2_000;

const OPAQUE_ID = /^[A-Za-z0-9_.:@=+-]+$/;
const runIdInput = z
  .string()
  .min(1)
  .max(128)
  .regex(OPAQUE_ID, "run_id is a run id such as the one heliyos_ask or heliyos_tasks_run returned")
  .refine((v) => !/^\.+$/.test(v), "run_id cannot be only dots")
  .describe("The run id (run_id) from heliyos_ask, heliyos_tasks_run, heliyos_tasks_get or heliyos_runs_list.");
const threadIdInput = z
  .string()
  .min(1)
  .max(100)
  .regex(OPAQUE_ID, "thread_id is the thread_id an earlier heliyos_ask returned")
  .describe("thread_id from an earlier heliyos_ask, to ask a follow-up in the same conversation.");

/** A run's final output as text: a string, or its response / final_response / text / message / summary. */
function answerOf(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output.trim() || undefined;
  if (isRecord(output)) {
    for (const key of ["response", "final_response", "text", "message", "summary"]) {
      const text = stringOf(output[key]);
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
}

/** A raw step payload as a short JSON string (structuredContent and detailed text). */
function payloadOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return clip(value, PAYLOAD_CHARS);
  try {
    return clip(JSON.stringify(value), PAYLOAD_CHARS);
  } catch {
    return undefined;
  }
}

const waitNote = (status: string) =>
  HUMAN_WAIT.has(status)
    ? `The run is ${status}: it waits on a person or a schedule, so it will not move until that happens (approvals are in Heliyos, Review).`
    : "";

// ---------------------------------------------------------------- run shapes

const stepOut = z.object({
  seq: z.number().int().describe("The step's position in the run (its id)."),
  type: z.string().describe("tool, worker, approval, wait, final, ..."),
  title: z.string().optional(),
  status: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  summary: z.string().optional(),
  input: z.string().optional().describe("detailed only: the raw input as JSON, cut at 2,000 characters."),
  output: z.string().optional().describe("detailed only: the raw output as JSON, cut at 2,000 characters."),
  error: z.string().optional().describe("detailed only."),
});
type StepOut = z.infer<typeof stepOut>;

const runOut = z.object({
  id: z.string(),
  status: z.string(),
  done: z.boolean().describe("true once the run can no longer change (completed, failed, skipped, cancelled, stopped)."),
  title: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  thread_id: z.string().optional(),
  task_id: z.string().optional(),
  trigger: z.string().optional().describe("What started the run, for example chat or event company 65b…."),
  answer: z.string().optional().describe("The run's final answer, once it has one."),
  error: z.string().optional(),
  credits: z.number().optional(),
  workers: z.array(z.string()).optional().describe("detailed only: names of the workers that took part."),
  steps: z.array(stepOut),
  reviews: z.array(z.object({ id: z.string(), type: z.string().optional(), status: z.string().optional() })),
});
type RunOut = z.infer<typeof runOut>;

function stepOf(raw: Record<string, unknown>, index: number, detailed: boolean): StepOut {
  return {
    seq: numberOf(raw.seq) ?? index + 1,
    type: stringOf(raw.type) ?? "step",
    ...optional("title", stringOf(raw.title)),
    ...optional("status", stringOf(raw.status)),
    ...optional("started_at", stringOf(raw.startedAt)),
    ...optional("ended_at", stringOf(raw.endedAt)),
    ...optional("summary", stringOf(raw.summary)),
    ...(detailed
      ? { ...optional("input", payloadOf(raw.input)), ...optional("output", payloadOf(raw.output)), ...optional("error", payloadOf(raw.error)) }
      : {}),
  };
}

function triggerText(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const parts = [stringOf(raw.type), stringOf(raw.event), stringOf(raw.objectType), stringOf(raw.objectId)].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function runOf(data: unknown, detailed: boolean): RunOut {
  const raw = expectObject(data, "run");
  const id = stringOf(raw.id);
  if (!id) throw new HeliyosApiError("INTERNAL", "The API returned a run without an id", 0);
  const status = stringOf(raw.status) ?? "unknown";
  const usage = isRecord(raw.usage) ? raw.usage : {};
  const answer = answerOf(raw.output);
  const workers = namesOf(raw.workers, "agentName");
  return {
    id,
    status,
    done: TERMINAL.has(status),
    ...optional("title", stringOf(raw.title)),
    ...optional("started_at", stringOf(raw.startedAt)),
    ...optional("ended_at", stringOf(raw.endedAt)),
    ...optional("thread_id", stringOf(raw.threadId)),
    ...optional("task_id", stringOf(raw.taskId)),
    ...optional("trigger", triggerText(raw.trigger)),
    ...optional("answer", answer && clip(answer, ANSWER_CHARS)),
    ...optional("error", stringOf(raw.error)),
    ...optional("credits", numberOf(usage.credits)),
    ...(detailed && workers.length ? { workers } : {}),
    steps: (Array.isArray(raw.steps) ? raw.steps.filter(isRecord) : []).map((s, i) => stepOf(s, i, detailed)),
    reviews: (Array.isArray(raw.reviews) ? raw.reviews.filter(isRecord) : []).flatMap((r) => {
      const reviewId = stringOf(r.id);
      if (!reviewId) return [];
      const type = stringOf(r.type);
      const reviewStatus = stringOf(r.status);
      return [{ id: reviewId, ...(type ? { type } : {}), ...(reviewStatus ? { status: reviewStatus } : {}) }];
    }),
  };
}

/** Second precision is enough to read a step log. */
const time = (iso: string | undefined) => (iso ? iso.slice(0, 19) : "");

function stepsText(run: RunOut, detailed: boolean, budget: number): string {
  if (!run.steps.length) return "No steps yet.";
  if (!detailed) {
    const rows = run.steps.map((s) => ({ ...s, started: time(s.started_at), ended: time(s.ended_at) }));
    return `Steps:\n${fitTable(
      rows,
      [
        { columns: ["seq", "type", "title", "status", "started", "ended", "summary"], maxCell: 80 },
        { columns: ["seq", "type", "title", "status", "started", "summary"], maxCell: 40 },
        { columns: ["seq", "type", "status", "started"], maxCell: 30 },
      ],
      budget
    )}`;
  }
  const blocks = run.steps.map((s) =>
    [
      `#${s.seq} ${s.type}${s.title ? ` ${s.title}` : ""} · ${s.status ?? "?"} · ${time(s.started_at)} → ${time(s.ended_at)}`,
      s.summary ? `summary: ${s.summary}` : "",
      s.input ? `input: ${s.input}` : "",
      s.output ? `output: ${s.output}` : "",
      s.error ? `error: ${s.error}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
  return `Steps:\n${fitBlocks(
    blocks,
    run.steps.map((s) => `#${s.seq}`),
    budget,
    { items: "steps", key: "run.steps", readHint: 'Repeat with response_format "concise" for one line per step.' }
  )}`;
}

/** Builds the tool that asks the workspace assistant a question and the tools that read its runs, from the shared tool context. */
export function askTools({ client }: ToolContext): ToolSpec[] {
  const ask = tool({
    name: "heliyos_ask",
    title: "Ask Heliyos",
    description:
      "Asks Heliyos (the orchestrator and its workers) a question or gives it a job, in plain language, for example " +
      '"summarise what changed with Acme this week" or "draft a follow-up to the Globex thread". It can read and act on ' +
      "the whole workspace: it may change records and tasks or send email, and consequential actions wait for approval " +
      `in Heliyos, so confirm jobs that change things with the user first. Waits up to ${ASK_WAIT_SECONDS} s: a finished run returns its answer and run_id. Otherwise ` +
      'it returns {run_id, status, thread_id} and the text "Still running"; then call heliyos_runs_get with that ' +
      "run_id and wait: true. Pass thread_id to continue the same conversation. Runs use credits; calling it twice " +
      "starts two runs. Needs a client tool timeout of at least 120 s. Returns structuredContent " +
      "{run_id, status, thread_id, done, answer?}.",
    input: z.strictObject({
      message: z.string().trim().min(1).max(20_000).describe("The question or instruction."),
      thread_id: threadIdInput.optional(),
    }),
    output: z.object({
      run_id: z.string().optional(),
      status: z.string(),
      thread_id: z.string().optional(),
      done: z.boolean().describe("false: the run is still going; follow it with heliyos_runs_get."),
      answer: z.string().optional(),
    }),
    annotations: STARTS_RUN,
    async handler(args) {
      const { data } = await callOperation(client, "createOrchestratorChat", {
        body: { message: args.message, ...(args.thread_id ? { threadId: args.thread_id } : {}), wait: ASK_WAIT_SECONDS },
      });
      const raw = expectObject(data, "chat");
      const runId = stringOf(raw.runId);
      const status = stringOf(raw.status) ?? "queued";
      const threadId = stringOf(raw.threadId);
      // not_found: an unknown thread_id; nothing ran and nothing will.
      const done = TERMINAL.has(status) || status === "not_found";
      const answer = done ? answerOf(raw.output) : undefined;
      const ids = [runId ? `run_id ${runId}` : "", threadId ? `thread_id ${threadId}` : ""].filter(Boolean).join(", ");
      const followUp = threadId ? `For a follow-up, call heliyos_ask with thread_id ${threadId}.` : "";
      let text: string;
      if (status === "not_found") {
        text = args.thread_id
          ? `thread_id ${args.thread_id} was not found. Omit thread_id to start a new conversation.`
          : "Heliyos could not find the conversation for this message. Try again without thread_id.";
      } else if (!runId) {
        text = done
          ? `Heliyos did not start a run (status ${status}).${ids ? ` ${ids}.` : ""}`
          : `Heliyos accepted the message (status ${status}) but returned no run id. Find the run with heliyos_runs_list.`;
      } else if (!done) {
        // A run waiting on a person will not move by polling, so only a running one gets the poll advice.
        const next = HUMAN_WAIT.has(status) ? waitNote(status) : stillRunning(runId);
        text = [`Run ${runId} is ${status}.`, next, ids ? `(${ids})` : ""].filter(Boolean).join("\n");
      } else if (status === "completed") {
        text = [answer ? clip(answer, ANSWER_CHARS) : "The run completed without a text answer.", "", `(${ids}) ${followUp}`.trim()].join("\n");
      } else {
        text = `Run ${runId} ended with status ${status} and no answer. Call heliyos_runs_get with run_id ${runId} for its steps and error.`;
      }
      return {
        text,
        structuredContent: {
          ...(runId ? { run_id: runId } : {}),
          status,
          ...(threadId ? { thread_id: threadId } : {}),
          done,
          ...(answer ? { answer: clip(answer, ANSWER_CHARS) } : {}),
        },
      };
    },
  });

  const get = tool({
    name: "heliyos_runs_get",
    title: "Get a run",
    description:
      "Reads one worker run: its status, whether it is done, its steps (seq, type, title, status, start and end " +
      "times, a one-line summary each), reviews waiting on a person, credits used, and the final answer once there is " +
      `one. wait: true waits up to ${RUN_WAIT_SECONDS} s for the run to finish or stop on a person; call again with ` +
      "wait: true while done is false, unless the run waits on a person (awaiting_approval, paused, waiting, scheduled): " +
      'then it only moves when someone acts in Heliyos, and wait: true returns at once. "detailed" adds each step\'s raw input, output and error. Returns ' +
      "structuredContent {run:{id, status, done, steps, reviews, answer?}}.",
    input: z.strictObject({
      run_id: runIdInput,
      wait: z.boolean().default(false).describe(`true: wait up to ${RUN_WAIT_SECONDS} s for the run to finish before answering.`),
      response_format: responseFormat("status and one line per step", "each step's raw input, output and error, plus run title and workers"),
    }),
    output: z.object({ run: runOut }),
    annotations: READ_ONLY,
    truncationHint: 'Use response_format "concise"; every step is in structuredContent.run.steps.',
    async handler(args) {
      const detailed = args.response_format === "detailed";
      const { data } = await callOperation(client, "getWorkerRun", {
        params: { id: args.run_id },
        query: {
          ...(args.wait ? { wait: RUN_WAIT_SECONDS } : {}),
          // detail carries the run-level error (and title); step_payloads the raw step input and output.
          include: detailed ? "detail,step_payloads" : "detail",
        },
      });
      const run = runOf(data, detailed);
      const head = [
        `Run ${run.id}: ${run.status}${run.done ? "" : " (not done)"}`,
        renderRecord({
          title: run.title,
          started: run.started_at,
          ended: run.ended_at,
          thread_id: run.thread_id,
          task_id: run.task_id,
          trigger: run.trigger,
          credits: run.credits,
          workers: run.workers,
          error: run.error,
        }),
        run.reviews.length
          ? `Reviews: ${run.reviews.map((r) => `${r.id} (${[r.type, r.status].filter(Boolean).join(", ")})`).join("; ")}`
          : "",
        run.answer ? `Answer:\n${run.answer}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const pending = run.reviews.filter((r) => r.status === undefined || r.status === "pending").map((r) => r.id);
      const footer = run.done
        ? ""
        : HUMAN_WAIT.has(run.status)
          ? `The run is ${run.status}: it needs a person to act in Heliyos` +
            `${pending.length ? ` (Review, review ${pending.join(", ")})` : " (Review)"}. ` +
            "Polling will not change it, and wait: true returns at once; read it again after someone has acted."
          : args.wait
            ? `Still not done after waiting up to ${RUN_WAIT_SECONDS} s. Call heliyos_runs_get again with wait: true.`
            : "Call heliyos_runs_get with wait: true to wait for it.";
      const steps = stepsText(run, detailed, MAX_TEXT_CHARS - head.length - footer.length - 200);
      return {
        text: [head, steps, footer].filter(Boolean).join("\n\n"),
        structuredContent: { run },
      };
    },
  });

  const runListOut = z.object({
    id: z.string().describe("Run id for heliyos_runs_get."),
    status: z.string(),
    title: z.string().optional(),
    surface: z.string().optional().describe("Where it started: chat, task, event, ..."),
    task_id: z.string().optional(),
    thread_id: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    workers: z.array(z.string()).optional().describe("detailed only."),
    tool_calls: z.number().optional().describe("detailed only."),
  });

  const list = tool({
    name: "heliyos_runs_list",
    title: "List runs",
    description:
      "Lists worker runs (chats with Heliyos, task runs and automatic runs), newest first, optionally in one status, " +
      "for one task, one worker or one company, or in a date range. Shows each run's id, status, title and start time; " +
      "read one with heliyos_runs_get. Order with `sort`. Returns structuredContent {runs:[{id, status, title, ...}], next_cursor}.",
    input: z.strictObject({
      status: z
        .enum(RUN_STATUSES)
        .optional()
        .describe("Only runs in this status, for example running, awaiting_approval, completed or failed."),
      task_id: hexId("task_id").optional().describe("Only runs on this task (its own runs and chats that mention it)."),
      worker_id: hexId("worker_id").optional().describe("Only runs of this worker (id from heliyos_workers_list)."),
      company_id: hexId("company_id").optional().describe("Only runs about this company record."),
      since: isoDate("since").optional().describe("Only runs started at or after this date (ISO 8601)."),
      until: isoDate("until").optional().describe("Only runs started at or before this date; a date alone includes that whole day (UTC)."),
      sort: sortInput(RUN_SORT_FIELDS, "createdAt, updatedAt, status, title or surface."),
      limit: pageLimit("Runs"),
      cursor: cursorInput,
      response_format: responseFormat("one row per run", "task, workers and tool calls too"),
    }),
    output: z.object({ runs: z.array(runListOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const paging = pagedQuery(args, args.sort !== undefined);
      const { data, meta } = await callOperation(client, "listWorkerRuns", {
        query: {
          ...paging.query,
          ...(args.status ? { status: args.status } : {}),
          ...(args.task_id ? { taskId: args.task_id } : {}),
          ...(args.worker_id ? { agentId: args.worker_id } : {}),
          ...(args.company_id ? { companyId: args.company_id } : {}),
          ...(args.since ? { from: args.since } : {}),
          ...(args.until ? { to: endOfDay(args.until) } : {}),
          ...(args.sort ? { sortBy: args.sort.field, sortOrder: args.sort.direction } : {}),
        },
      });
      const detailed = args.response_format === "detailed";
      const runs = expectArray(data, "run list").map((item) => {
        const raw = expectObject(item, "run");
        const id = stringOf(raw.orchestratorRunId);
        if (!id) throw new HeliyosApiError("INTERNAL", "The API returned a run without a run id", 0);
        const workers = namesOf(raw.workers, "agentName");
        return {
          id,
          status: stringOf(raw.status) ?? "unknown",
          ...optional("title", stringOf(raw.title)),
          ...optional("surface", stringOf(raw.surface)),
          ...optional("task_id", stringOf(raw.taskId)),
          ...optional("thread_id", stringOf(raw.threadId)),
          ...optional("created_at", stringOf(raw.createdAt)),
          ...optional("updated_at", stringOf(raw.updatedAt)),
          ...(detailed && workers.length ? { workers } : {}),
          ...(detailed ? optional("tool_calls", numberOf(raw.toolCalls)) : {}),
        } as z.infer<typeof runListOut>;
      });
      const next = paging.next(meta);
      const rows = runs.map((r) => ({ ...r, created: time(r.created_at), workers: r.workers?.join(", ") }));
      const wide = detailed
        ? ["id", "status", "title", "surface", "created", "task_id", "workers", "tool_calls"]
        : ["id", "status", "title", "surface", "created"];
      const table = runs.length
        ? fitTable(
            rows,
            [
              { columns: wide, maxCell: 50 },
              { columns: ["id", "status", "title", "created"], maxCell: 40 },
              { columns: ["id", "status"], maxCell: 40 },
            ],
            MAX_TEXT_CHARS - 600
          )
        : "No runs matched.";
      return {
        text: `${plural(runs.length, "run")}:\n${table}\n\n${pagingFooter("heliyos_runs_list", next)}`,
        structuredContent: { runs, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  return [ask, get, list];
}

