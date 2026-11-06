/**
 * The heliyos_runs_get, heliyos_tasks_create, heliyos_tasks_delete, heliyos_tasks_events, heliyos_tasks_get, heliyos_tasks_list, heliyos_tasks_run, heliyos_tasks_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { acme, apiError, ok, P, RECORD_IDS, SCHEMA_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const TASK_ID = "68a000000000000000000001";
const task = {
  _id: TASK_ID,
  title: "Send renewal quote",
  description: "Include the SSO add-on.",
  status: "backlog",
  priority: "high",
  isFinished: false,
  dueDate: "2026-04-01T00:00:00.000Z",
  relationships: [{ objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company" }],
  assignedUser: [{ id: "u1", name: "Jordan" }],
  currentRun: { status: "completed", planSteps: 3, completedSteps: 3 },
  metadata: { created: { at: "2026-03-01T00:00:00.000Z" }, updated: { at: "2026-03-02T00:00:00.000Z" } },
};

describe("heliyos_tasks_list", () => {
  it("filters by record and status and returns ids", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/tasks`, ({ request }) => {
        url = new URL(request.url);
        return ok([task], { pagination: { limit: 20, next_cursor: "t2" } });
      })
    );
    const result = await call("heliyos_tasks_list", { record_id: RECORD_IDS.acme, status: "backlog" });
    const text = expectOk(result);
    expect(JSON.parse(url!.searchParams.get("filters")!)).toEqual({
      relatedObjectId: RECORD_IDS.acme,
      filters: [{ field: "status", operator: "equals", value: "backlog" }],
    });
    expect(text).toContain(TASK_ID);
    expect(text).toContain("Send renewal quote");
    const sc = result.structuredContent as Structured;
    expect(sc.tasks[0]).toMatchObject({ id: TASK_ID, status: "backlog", priority: "high", due_date: "2026-04-01T00:00:00.000Z" });
    expect(sc.next_cursor).toBe("t2");
  });

  it("detailed shows a links column of linked record names with their ids", async () => {
    const linked = {
      ...task,
      relationships: [
        { objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company", data: { company_name: "Acme Corp" } },
        { objectId: RECORD_IDS.globex, schemaId: SCHEMA_IDS.company, objectType: "company" },
      ],
    };
    api.use(http.get(`${P}/tasks`, () => ok([linked])));
    const text = expectOk(await call("heliyos_tasks_list", { response_format: "detailed" }));
    const [header, , row] = text.split("\n").slice(1);
    expect(header).toMatch(/\blinks$/);
    expect(row).toContain(`Acme Corp (${RECORD_IDS.acme}), 65b`);
    const sc = (await call("heliyos_tasks_list", { response_format: "detailed" })).structuredContent as Structured;
    expect(sc.tasks[0].links.map((l: { id: string }) => l.id)).toEqual([RECORD_IDS.acme, RECORD_IDS.globex]);
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/tasks`, () => apiError(500, "INTERNAL", "boom")));
    expectToolError(await call("heliyos_tasks_list"), "INTERNAL");
  });
});

describe("heliyos_tasks_get", () => {
  it("returns the task with its links and run state", async () => {
    api.use(http.get(`${P}/tasks/${TASK_ID}`, () => ok(task)));
    const result = await call("heliyos_tasks_get", { task_id: TASK_ID, response_format: "detailed" });
    const text = expectOk(result);
    expect(text).toContain("Include the SSO add-on.");
    expect(text).toContain(RECORD_IDS.acme);
    const sc = result.structuredContent as Structured;
    expect(sc.task).toMatchObject({ id: TASK_ID, run_status: "completed", assignees: ["Jordan"] });
    expect(sc.task.links[0].id).toBe(RECORD_IDS.acme);
  });

  it("returns NOT_FOUND for a missing task", async () => {
    api.use(http.get(`${P}/tasks/${TASK_ID}`, () => apiError(404, "NOT_FOUND", "Task not found")));
    expectToolError(await call("heliyos_tasks_get", { task_id: TASK_ID }), "NOT_FOUND");
  });
});

describe("heliyos_tasks_create", () => {
  it("creates a task linked to a record", async () => {
    let body: any;
    api.use(
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)),
      http.post(`${P}/tasks`, async ({ request }) => {
        body = await request.json();
        return ok({ ...task, id: TASK_ID, _id: undefined });
      })
    );
    const result = await call("heliyos_tasks_create", {
      title: "Send renewal quote",
      priority: "high",
      due_date: "2026-04-01",
      record_ids: [RECORD_IDS.acme],
    });
    const text = expectOk(result);
    expect(body).toEqual({
      title: "Send renewal quote",
      priority: "high",
      dueDate: "2026-04-01",
      relationships: [{ objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company" }],
    });
    expect(text).toContain(TASK_ID);
    expect((result.structuredContent as Structured).task.id).toBe(TASK_ID);
  });

  it("surfaces a server validation error", async () => {
    api.use(http.post(`${P}/tasks`, () => apiError(400, "VALIDATION_FAILED", "dueDate must be a valid date", [{ path: ["dueDate"], message: "must be a valid date" }])));
    const text = expectToolError(await call("heliyos_tasks_create", { title: "x" }), "VALIDATION_FAILED");
    expect(text).toContain("Fix the input");
  });
});

describe("heliyos_tasks_update", () => {
  it("marks the task finished when status becomes completed", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/tasks/${TASK_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...task, status: "completed", isFinished: true });
      })
    );
    const result = await call("heliyos_tasks_update", { task_id: TASK_ID, status: "completed" });
    expect(expectOk(result)).toContain("completed");
    expect(body).toEqual({ status: "completed", isFinished: true });
  });

  it("accepts scheduled_for_later and keeps the task open", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/tasks/${TASK_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...task, status: "scheduled_for_later", isFinished: false });
      })
    );
    const result = await call("heliyos_tasks_update", { task_id: TASK_ID, status: "scheduled_for_later" });
    expect(expectOk(result)).toContain("scheduled_for_later");
    expect(body).toEqual({ status: "scheduled_for_later", isFinished: false });
  });

  it("returns NOT_FOUND for a missing task", async () => {
    api.use(http.patch(`${P}/tasks/${TASK_ID}`, () => apiError(404, "NOT_FOUND", "Task not found")));
    expectToolError(await call("heliyos_tasks_update", { task_id: TASK_ID, title: "x" }), "NOT_FOUND");
  });
});

describe("heliyos_tasks_delete", () => {
  it("deletes the task", async () => {
    api.use(http.delete(`${P}/tasks/${TASK_ID}`, () => ok({ message: "Task deleted successfully" })));
    const result = await call("heliyos_tasks_delete", { task_id: TASK_ID });
    expect(expectOk(result)).toContain(TASK_ID);
  });

  it("returns NOT_FOUND for a missing task", async () => {
    api.use(http.delete(`${P}/tasks/${TASK_ID}`, () => apiError(404, "NOT_FOUND", "Task not found")));
    expectToolError(await call("heliyos_tasks_delete", { task_id: TASK_ID }), "NOT_FOUND");
  });
});

describe("heliyos_tasks_run", () => {
  it("starts a worker run and points to heliyos_runs_get", async () => {
    api.use(http.post(`${P}/tasks/${TASK_ID}/runs`, () => ok({ triggered: true, orchestratorRunId: "run_123", status: "running" })));
    const result = await call("heliyos_tasks_run", { task_id: TASK_ID });
    const text = expectOk(result);
    expect(text).toContain("run_123");
    expect(text).toContain("heliyos_runs_get");
    expect(result.structuredContent).toEqual({ task_id: TASK_ID, run_id: "run_123", started: true, status: "running" });
  });

  it("treats a run response without a run id as INTERNAL", async () => {
    api.use(http.post(`${P}/tasks/${TASK_ID}/runs`, () => ok({ triggered: true, status: "running" })));
    expectToolError(await call("heliyos_tasks_run", { task_id: TASK_ID }), "INTERNAL");
  });

  it("explains why workers did not start", async () => {
    api.use(http.post(`${P}/tasks/${TASK_ID}/runs`, () => apiError(409, "CONFLICT", "The workers did not start: the organization is out of credits.")));
    const text = expectToolError(await call("heliyos_tasks_run", { task_id: TASK_ID }), "CONFLICT");
    expect(text).toContain("out of credits");
  });
});

describe("heliyos_tasks_events", () => {
  const event = {
    _id: "66d000000000000000000009",
    timestamp: "2026-03-05T09:00:00.000Z",
    metadata: { actor: { name: "Renewal scout", type: "AGENT" }, eventType: "AUDIT", objectType: "task", operationType: "UPDATE" },
    originalVersion: { status: "backlog", title: "Send renewal quote" },
    updatedVersion: { status: "in_progress", title: "Send renewal quote" },
    changeSummary: "Status changed from backlog to in_progress",
  };

  it("lists the task's activity with actor and summary, and pages with next_cursor", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/tasks/${TASK_ID}/events`, ({ request }) => {
        url = new URL(request.url);
        return ok([event], { pagination: { limit: 5, next_cursor: "e2" } });
      })
    );
    const result = await call("heliyos_tasks_events", { task_id: TASK_ID, limit: 5, response_format: "detailed" });
    const text = expectOk(result);
    expect(url!.searchParams.get("limit")).toBe("5");
    expect(text).toContain(`change event on task ${TASK_ID}`);
    expect(text).toContain("by Renewal scout (agent): Status changed from backlog to in_progress");
    expect(text).toContain("changed: status");
    expect(text).toContain('cursor "e2"');
    const sc = result.structuredContent as Structured;
    expect(sc.events[0]).toMatchObject({ id: event._id, operation_type: "UPDATE", actor: "Renewal scout", actor_type: "AGENT", changed_fields: ["status"] });
    expect(sc.next_cursor).toBe("e2");
  });

  it("surfaces NOT_FOUND for an unknown task", async () => {
    api.use(http.get(`${P}/tasks/${TASK_ID}/events`, () => apiError(404, "NOT_FOUND", "Task not found")));
    expectToolError(await call("heliyos_tasks_events", { task_id: TASK_ID }), "NOT_FOUND");
  });
});
