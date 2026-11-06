/**
 * Tasks: work items for people and workers, optionally linked to records. Six
 * tools, one operation each: list, get, create, update, delete, and run (start
 * the workers on a task; the run is then read with heliyos_runs_get).
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitTable, formatValue, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  cursorInput,
  day,
  DESTROYS,
  expectObject,
  hexId,
  isoDate,
  label,
  linkOut,
  linksLine,
  linksOf,
  namesOf,
  nextCursorOf,
  numberOf,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  STARTS_RUN,
  requireId,
  responseFormat,
  searchInput,
  stringOf,
  timestampsOf,
  UPDATES,
  type ToolContext,
  keysetListQuery,
  LIST_TRUNCATION_HINT,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";
import { linkedRecordIds, readRecordRefs } from "./records.js";
import { eventListOutput, eventOut } from "./timeline.js";

const STATUSES = ["backlog", "in_progress", "scheduled_for_later", "on_hold", "cancelled", "completed"] as const;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
const CONCISE_DESCRIPTION_CHARS = 1500;

const taskOut = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().optional(),
  priority: z.string().optional(),
  due_date: z.string().optional(),
  is_finished: z.boolean().optional(),
  assignees: z.array(z.string()).optional().describe("Names of the people assigned."),
  workers: z.array(z.string()).optional().describe("Names of the workers (AI agents) assigned."),
  run_status: z.string().optional().describe("Status of the workers' current or last run on this task."),
  run_id: z.string().optional().describe("The current run id; read it with heliyos_runs_get."),
  description: z.string().optional().describe("get only; cut in concise."),
  links: z.array(linkOut).optional().describe("Linked records; in lists only with response_format detailed."),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
type TaskOut = z.infer<typeof taskOut>;

function taskOf(data: unknown, options: { description?: number | "full" }): TaskOut {
  const raw = expectObject(data, "task");
  const run = isRecord(raw.currentRun) ? raw.currentRun : {};
  const assignees = namesOf(raw.assignedUser, "name");
  const workers = namesOf(raw.assignedAgents, "name");
  const description = stringOf(raw.description);
  const status = stringOf(raw.status);
  const priority = stringOf(raw.priority);
  const due = stringOf(raw.dueDate);
  const runStatus = stringOf(run.status);
  const runId = stringOf(raw.currentRunId);
  const desc =
    description && options.description !== undefined
      ? options.description === "full"
        ? description
        : clip(description, options.description)
      : undefined;
  return {
    id: requireId(raw, "task"),
    title: typeof raw.title === "string" ? raw.title : "",
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(due ? { due_date: due } : {}),
    ...(typeof raw.isFinished === "boolean" ? { is_finished: raw.isFinished } : {}),
    ...(assignees.length ? { assignees } : {}),
    ...(workers.length ? { workers } : {}),
    ...(runStatus ? { run_status: runStatus } : {}),
    ...(runId ? { run_id: runId } : {}),
    ...(desc ? { description: desc } : {}),
    links: linksOf(raw.relationships),
    ...timestampsOf(raw),
  };
}

const taskHeading = (t: TaskOut) => `Task ${label({ id: t.id, name: t.title })}`;

function taskFacts(t: TaskOut): string {
  return renderRecord({
    status: t.status,
    priority: t.priority,
    due: day(t.due_date),
    assignees: t.assignees,
    workers: t.workers,
    run: t.run_status ? `${t.run_status}${t.run_id ? ` (run_id ${t.run_id})` : ""}` : undefined,
  });
}

/** The isFinished flag the web app keeps beside status (the server does not derive it). */
const finishedFor = (status: string | undefined) => (status === undefined ? {} : { isFinished: status === "completed" });

const titleInput = z.string().trim().max(500).describe("Task title.");
const descriptionInput = z.string().max(20_000).describe("Task description (plain text).");
const statusInput = z.enum(STATUSES).describe("backlog, in_progress, scheduled_for_later (a worker set a wake-up for it), on_hold (waiting on a person or an event), cancelled or completed.");
const priorityInput = z.enum(PRIORITIES).describe("none, low, medium, high or urgent.");

/** Builds the tools that list, read, create, update, delete, run and inspect tasks, from the shared tool context. */
export function taskTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_tasks_list",
    title: "List tasks",
    description:
      "Lists tasks, newest first, optionally only those linked to one record (record_id), in one status, or matching text. " +
      "Each task shows its id, title, status, priority, due date and whether workers are running on it. Use " +
      "heliyos_tasks_get for the description and links. Returns structuredContent {tasks:[{id, title, status, ...}], next_cursor}.",
    input: z.strictObject({
      record_id: hexId("record_id").optional().describe("Only tasks linked to this record."),
      status: statusInput.optional(),
      search: searchInput("task titles and descriptions"),
      limit: pageLimit("Tasks"),
      cursor: cursorInput,
      response_format: responseFormat("one row per task", "assignees, workers and linked records too"),
    }),
    output: z.object({ tasks: z.array(taskOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const filters = {
        ...(args.search ? { search: args.search } : {}),
        ...(args.record_id ? { relatedObjectId: args.record_id } : {}),
        ...(args.status ? { filters: [{ field: "status", operator: "equals", value: args.status }] } : {}),
      };
      const { data, meta } = await callOperation(client, "listTasks", {
        query: keysetListQuery(args, filters),
      });
      const detailed = args.response_format === "detailed";
      const tasks = expectArray(data, "task list").map((raw) => taskOf(raw, {}));
      const out = detailed ? tasks : tasks.map(({ links: _l, assignees: _a, workers: _w, ...rest }) => rest);
      const next = nextCursorOf(meta);
      const rows = tasks.map((t) => ({
        ...t,
        due: day(t.due_date),
        run: t.run_status,
        assignees: formatValue(t.assignees),
        links: (t.links ?? []).map((l) => (l.name ? `${l.name} (${l.id})` : l.id)).join(", "),
      }));
      const wide = detailed
        ? ["id", "title", "status", "priority", "due", "run", "assignees", "links"]
        : ["id", "title", "status", "priority", "due", "run"];
      const table =
        tasks.length === 0
          ? "No tasks matched."
          : fitTable(
              rows,
              [
                { columns: wide, maxCell: 60 },
                { columns: ["id", "title", "status", "due"], maxCell: 40 },
                { columns: ["id", "title"], maxCell: 30 },
              ],
              MAX_TEXT_CHARS - 600
            );
      return {
        text: `${plural(tasks.length, "task")}:\n${table}\n\n${pagingFooter("heliyos_tasks_list", next)}`,
        structuredContent: { tasks: out, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const get = tool({
    name: "heliyos_tasks_get",
    title: "Get a task",
    description:
      "Fetches one task by id: title, status, priority, due date, assignees and workers, the workers' run status and " +
      "run_id, the records it is linked to, and its description (cut at " +
      `${CONCISE_DESCRIPTION_CHARS} characters in concise). Returns structuredContent {task}.`,
    input: z.strictObject({
      task_id: hexId("task_id"),
      response_format: responseFormat("the task with a shortened description", "the full description and times"),
    }),
    output: z.object({ task: taskOut }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "getTask", { params: { id: args.task_id } });
      const detailed = args.response_format === "detailed";
      const task = taskOf(data, { description: detailed ? "full" : CONCISE_DESCRIPTION_CHARS });
      const text = [
        taskHeading(task),
        taskFacts(task),
        linksLine(task.links ?? []),
        detailed ? renderRecord({ created_at: task.created_at, updated_at: task.updated_at }) : "",
        task.description ? `\n${task.description}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structuredContent: { task } };
    },
  });

  const create = tool({
    name: "heliyos_tasks_create",
    title: "Create a task",
    description:
      "Creates a task, optionally linked to records (a company, person or deal). Creating a task can start workers that " +
      "subscribe to new tasks. Calling it twice creates two tasks. To have workers act on it now, call heliyos_tasks_run " +
      "with the returned id. Returns structuredContent {task}.",
    input: z.strictObject({
      title: titleInput.min(1),
      description: descriptionInput.optional(),
      status: statusInput.optional().describe("Default backlog."),
      priority: priorityInput.optional(),
      due_date: isoDate("due_date").optional(),
      record_ids: linkedRecordIds("task").optional(),
    }),
    output: z.object({ task: taskOut }),
    annotations: CREATES,
    async handler(args) {
      const relationships = args.record_ids ? await readRecordRefs(client, args.record_ids) : undefined;
      const { data } = await callOperation(client, "createTask", {
        body: {
          title: args.title,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.status ? { status: args.status, ...finishedFor(args.status) } : {}),
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.due_date ? { dueDate: args.due_date } : {}),
          ...(relationships ? { relationships } : {}),
        },
      });
      const task = taskOf(data, {});
      return {
        text: [`Created ${taskHeading(task)}.`, taskFacts(task), linksLine(task.links ?? [])].filter(Boolean).join("\n"),
        structuredContent: { task },
      };
    },
  });

  const update = tool({
    name: "heliyos_tasks_update",
    title: "Update a task",
    description:
      "Changes a task's title, description, status, priority, due date or linked records by id; what you leave out is " +
      "kept. Setting status completed also marks it finished. record_ids REPLACES the task's links (pass every record it " +
      "should stay linked to). Returns structuredContent {task}.",
    input: z
      .strictObject({
        task_id: hexId("task_id"),
        title: titleInput.min(1).optional(),
        description: descriptionInput.optional(),
        status: statusInput.optional(),
        priority: priorityInput.optional(),
        due_date: isoDate("due_date").optional(),
        record_ids: linkedRecordIds("task").optional(),
      })
      .refine((v) => Object.keys(v).some((k) => k !== "task_id" && (v as Record<string, unknown>)[k] !== undefined), {
        message: "Give at least one field to change",
      }),
    output: z.object({ task: taskOut }),
    annotations: UPDATES,
    async handler(args) {
      const relationships = args.record_ids ? await readRecordRefs(client, args.record_ids) : undefined;
      const { data } = await callOperation(client, "updateTask", {
        params: { id: args.task_id },
        body: {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.status ? { status: args.status, ...finishedFor(args.status) } : {}),
          ...(args.priority ? { priority: args.priority } : {}),
          ...(args.due_date ? { dueDate: args.due_date } : {}),
          ...(relationships ? { relationships } : {}),
        },
      });
      const task = taskOf(data, {});
      return {
        text: [`Updated ${taskHeading(task)}.`, taskFacts(task), linksLine(task.links ?? [])].filter(Boolean).join("\n"),
        structuredContent: { task },
      };
    },
  });

  const remove = tool({
    name: "heliyos_tasks_delete",
    title: "Delete a task",
    description:
      "Permanently deletes one task by id. This cannot be undone: confirm with the user first. " +
      "Returns structuredContent {task_id, deleted}.",
    input: z.strictObject({ task_id: hexId("task_id") }),
    output: z.object({ task_id: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      await callOperation(client, "deleteTask", { params: { id: args.task_id } });
      return { text: `Deleted task ${args.task_id}.`, structuredContent: { task_id: args.task_id, deleted: true } };
    },
  });

  const run = tool({
    name: "heliyos_tasks_run",
    title: "Run workers on a task",
    description:
      "Starts the workers (AI agents) on one task now and marks it in progress. If a run is already open, returns that " +
      "run instead of starting another. Runs use credits; the call fails when the workspace is out of them. Returns " +
      "structuredContent {task_id, run_id, started, status}; follow the run with heliyos_runs_get using run_id.",
    input: z.strictObject({ task_id: hexId("task_id") }),
    output: z.object({
      task_id: z.string(),
      run_id: z.string(),
      started: z.boolean().describe("false when an already open run was returned."),
      status: z.string().optional(),
    }),
    annotations: STARTS_RUN,
    async handler(args) {
      const { data } = await callOperation(client, "createTaskRun", { params: { id: args.task_id } });
      const raw = expectObject(data, "task run");
      const runId = stringOf(raw.orchestratorRunId) ?? (numberOf(raw.orchestratorRunId) !== undefined ? String(raw.orchestratorRunId) : undefined);
      if (!runId) throw new HeliyosApiError("INTERNAL", "The API started a task run but returned no run id", 0);
      const started = raw.triggered !== false;
      const status = stringOf(raw.status);
      const lead = started ? `Started workers on task ${args.task_id}` : `Task ${args.task_id} already has an open run`;
      return {
        text:
          `${lead}: run_id ${runId}${status ? `, status ${status}` : ""}. ` +
          "Call heliyos_runs_get with this run_id (wait: true) to follow it.",
        structuredContent: { task_id: args.task_id, run_id: runId, started, ...(status ? { status } : {}) },
      };
    },
  });

  const events = tool({
    name: "heliyos_tasks_events",
    title: "Read a task's activity",
    description:
      "Returns the activity (change history) of one task: who changed what and when (people and workers), newest first, " +
      "each with a one-line change summary. \"detailed\" adds the paths of the changed fields. For a company, person or " +
      "deal use heliyos_records_events; for what the workers did on the task use heliyos_runs_list with task_id. " +
      "Returns structuredContent {events:[{id, at, operation_type, actor, change_summary}], next_cursor}.",
    input: z.strictObject({
      task_id: hexId("task_id"),
      limit: pageLimit("Events"),
      cursor: cursorInput,
      response_format: responseFormat("one line per change", "the changed field paths too"),
    }),
    output: z.object({ events: z.array(eventOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const { data, meta } = await callOperation(client, "listTaskEvents", {
        params: { id: args.task_id },
        query: { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) },
      });
      return eventListOutput(data, meta, args.response_format === "detailed", `task ${args.task_id}`, "heliyos_tasks_events");
    },
  });

  return [list, get, events, create, update, remove, run];
}
