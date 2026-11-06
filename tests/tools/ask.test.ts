/**
 * The heliyos_ask, heliyos_runs_get, heliyos_runs_list, heliyos_signals_mark_read tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../../src/index.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P } from "../helpers/platform.js";

const { api, call } = useMockApi();
const RUN_ID = "run_9f2c";
const TASK_ID = "68a000000000000000000001";

const slimRun = {
  id: RUN_ID,
  status: "completed",
  trigger: { type: "chat" },
  startedAt: "2026-10-22T09:00:00.000Z",
  endedAt: "2026-10-22T09:00:40.000Z",
  threadId: "th_1",
  taskId: null,
  steps: [
    {
      seq: 1,
      type: "worker",
      title: "Account researcher",
      status: "completed",
      startedAt: "2026-10-22T09:00:01.000Z",
      endedAt: "2026-10-22T09:00:30.000Z",
      summary: "Found three open deals for Acme.",
    },
    {
      seq: 2,
      type: "final",
      title: null,
      status: "completed",
      startedAt: "2026-10-22T09:00:31.000Z",
      endedAt: "2026-10-22T09:00:40.000Z",
      summary: "Acme has three open deals.",
    },
  ],
  reviews: [],
  usage: { credits: 2 },
  output: { response: "Acme has three open deals worth $120k.", final_response_by: "orchestrator" },
};

describe("registration", () => {
  it("registers ask, runs_get and runs_list after the signal tools", () => {
    const names = listToolSpecs().map((s) => s.name);
    const start = names.indexOf("heliyos_ask");
    expect(names[start - 1]).toBe("heliyos_signals_mark_read");
    expect(names.slice(start, start + 3)).toEqual(["heliyos_ask", "heliyos_runs_get", "heliyos_runs_list"]);
  });
});

describe("heliyos_ask", () => {
  it("waits 90 s and returns the answer of a finished run", async () => {
    let body: any;
    api.use(
      http.post(`${P}/orchestrator/chats`, async ({ request }) => {
        body = await request.json();
        return ok({ runId: RUN_ID, status: "completed", threadId: "th_1", output: slimRun.output });
      })
    );
    const result = await call("heliyos_ask", { message: "What is open with Acme?" });
    const text = expectOk(result);
    expect(body).toEqual({ message: "What is open with Acme?", wait: 90 });
    expect(text).toContain("Acme has three open deals worth $120k.");
    expect(text).toContain(RUN_ID);
    expect(result.structuredContent).toMatchObject({
      run_id: RUN_ID,
      status: "completed",
      thread_id: "th_1",
      done: true,
      answer: "Acme has three open deals worth $120k.",
    });
  });

  it("returns the run id and how to follow it when the run is still going", async () => {
    let body: any;
    api.use(
      http.post(`${P}/orchestrator/chats`, async ({ request }) => {
        body = await request.json();
        return ok({ runId: RUN_ID, status: "running", threadId: "th_1" });
      })
    );
    const result = await call("heliyos_ask", { message: "Research Globex", thread_id: "th_1" });
    const text = expectOk(result);
    expect(body).toEqual({ message: "Research Globex", threadId: "th_1", wait: 90 });
    expect(text).toContain(`Still running. Call heliyos_runs_get with run_id ${RUN_ID} and wait: true.`);
    expect(text).not.toContain("runId");
    expect(text).toContain(RUN_ID);
    expect(result.structuredContent).toEqual({ run_id: RUN_ID, status: "running", thread_id: "th_1", done: false });
  });

  it("says when the run waits on a person", async () => {
    api.use(http.post(`${P}/orchestrator/chats`, () => ok({ runId: RUN_ID, status: "awaiting_approval", threadId: "th_1" })));
    const text = expectOk(await call("heliyos_ask", { message: "Email Acme" }));
    expect(text).toContain("awaiting_approval");
    expect(text).toContain("will not move");
    // A run waiting on a person is not "still running": no advice to poll it.
    expect(text).not.toContain("Still running");
    expect(text).not.toContain("wait: true");
  });

  it("reports a failed run as finished, with no answer", async () => {
    api.use(http.post(`${P}/orchestrator/chats`, () => ok({ runId: RUN_ID, status: "failed", threadId: "th_1" })));
    const result = await call("heliyos_ask", { message: "x" });
    const text = expectOk(result);
    expect(text).toContain("failed");
    expect(text).toContain("heliyos_runs_get");
    expect((result.structuredContent as Structured).done).toBe(true);
  });

  it("is marked destructive and not idempotent (it can change the workspace)", () => {
    const spec = listToolSpecs().find((s) => s.name === "heliyos_ask")!;
    expect(spec.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  });

  it("reports an unknown thread_id instead of pointing to the run list", async () => {
    api.use(http.post(`${P}/orchestrator/chats`, () => ok({ runId: null, status: "not_found", threadId: "th_gone" })));
    const result = await call("heliyos_ask", { message: "x", thread_id: "th_gone" });
    const text = expectOk(result);
    expect(text).toContain("thread_id th_gone was not found");
    expect(text).not.toContain("heliyos_runs_list");
    expect((result.structuredContent as Structured).done).toBe(true);
  });

  it("surfaces an out-of-credits error", async () => {
    api.use(http.post(`${P}/orchestrator/chats`, () => apiError(403, "FORBIDDEN_ACTION", "Not enough credits")));
    expectToolError(await call("heliyos_ask", { message: "x" }), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_runs_get", () => {
  it("returns status, steps and the answer, without waiting by default", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/workers/runs/${RUN_ID}`, ({ request }) => {
        url = new URL(request.url);
        return ok(slimRun);
      })
    );
    const result = await call("heliyos_runs_get", { run_id: RUN_ID });
    const text = expectOk(result);
    expect(url!.searchParams.has("wait")).toBe(false);
    expect(url!.searchParams.get("include")).toBe("detail");
    expect(text).toContain(RUN_ID);
    expect(text).toContain("completed");
    expect(text).toContain("Account researcher");
    expect(text).toContain("2026-10-22T09:00:01");
    expect(text).toContain("Acme has three open deals worth $120k.");
    const sc = result.structuredContent as Structured;
    expect(sc.run).toMatchObject({ id: RUN_ID, status: "completed", done: true, thread_id: "th_1" });
    expect(sc.run.steps).toHaveLength(2);
    expect(sc.run.steps[0]).toMatchObject({ seq: 1, type: "worker", started_at: "2026-10-22T09:00:01.000Z" });
  });

  it("long-polls 30 s with wait and adds payloads in detailed", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/workers/runs/${RUN_ID}`, ({ request }) => {
        url = new URL(request.url);
        return ok({
          ...slimRun,
          status: "running",
          endedAt: null,
          output: undefined,
          title: "Acme deals",
          steps: [{ ...slimRun.steps[0], input: { company: "Acme" }, output: { deals: 3 }, error: null }],
          graph: { nodes: [] },
        });
      })
    );
    const result = await call("heliyos_runs_get", { run_id: RUN_ID, wait: true, response_format: "detailed" });
    const text = expectOk(result);
    expect(url!.searchParams.get("wait")).toBe("30");
    expect(url!.searchParams.get("include")).toBe("detail,step_payloads");
    expect(text).toContain('"deals":3');
    expect(text).toContain("wait: true");
    const sc = result.structuredContent as Structured;
    expect(sc.run).toMatchObject({ done: false, title: "Acme deals" });
    expect(sc.run.steps[0].output).toContain("deals");
  });

  it("always asks for detail, so a failed run's error shows in concise", async () => {
    api.use(
      http.get(`${P}/workers/runs/${RUN_ID}`, () =>
        ok({ ...slimRun, status: "failed", output: undefined, error: "Not enough credits to continue" })
      )
    );
    const result = await call("heliyos_runs_get", { run_id: RUN_ID });
    expect(expectOk(result)).toContain("error: Not enough credits to continue");
    expect((result.structuredContent as Structured).run).toMatchObject({ status: "failed", done: true, error: "Not enough credits to continue" });
  });

  it("does not tell the agent to poll a run that waits on a person", async () => {
    api.use(
      http.get(`${P}/workers/runs/${RUN_ID}`, () =>
        ok({ ...slimRun, status: "awaiting_approval", endedAt: null, output: undefined, reviews: [{ id: "rv_1", type: "action", status: "pending" }] })
      )
    );
    const text = expectOk(await call("heliyos_runs_get", { run_id: RUN_ID, wait: true }));
    expect(text).toContain("needs a person to act in Heliyos");
    expect(text).toContain("rv_1");
    expect(text).toContain("Polling will not change it");
    expect(text).not.toContain("Call heliyos_runs_get again");
    expect(text).not.toContain("to wait for it");
  });

  it("rejects dot-only run ids before any request", async () => {
    expect((await call("heliyos_runs_get", { run_id: ".." })).isError).toBe(true);
    expect((await call("heliyos_runs_get", { run_id: "." })).isError).toBe(true);
  });

  it("rejects a run id with a slash before any request", async () => {
    const result = await call("heliyos_runs_get", { run_id: "../x" });
    expect(result.isError).toBe(true);
  });

  it("returns NOT_FOUND for another workspace's run", async () => {
    api.use(http.get(`${P}/workers/runs/${RUN_ID}`, () => apiError(404, "NOT_FOUND", "Run not found")));
    expectToolError(await call("heliyos_runs_get", { run_id: RUN_ID }), "NOT_FOUND");
  });
});

describe("heliyos_runs_list", () => {
  const listed = {
    _id: "6a0000000000000000000001",
    orchestratorRunId: RUN_ID,
    status: "completed",
    title: "Acme deals",
    surface: "chat",
    taskId: TASK_ID,
    threadId: "th_1",
    createdAt: "2026-10-22T09:00:00.000Z",
    updatedAt: "2026-10-22T09:00:40.000Z",
    workers: [{ agentName: "Account researcher" }],
    toolCalls: 3,
  };

  it("lists runs newest first, filtered by status and task", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/workers/runs`, ({ request }) => {
        url = new URL(request.url);
        return ok([listed], { pagination: { limit: 10, next_cursor: "r2" } });
      })
    );
    const result = await call("heliyos_runs_list", { status: "completed", task_id: TASK_ID, limit: 10 });
    const text = expectOk(result);
    expect(url!.searchParams.get("status")).toBe("completed");
    expect(url!.searchParams.get("taskId")).toBe(TASK_ID);
    expect(url!.searchParams.get("limit")).toBe("10");
    expect(text).toContain(RUN_ID);
    expect(text).toContain("Acme deals");
    const sc = result.structuredContent as Structured;
    expect(sc.runs[0]).toMatchObject({ id: RUN_ID, status: "completed", task_id: TASK_ID });
    expect(sc.next_cursor).toBe("r2");
  });

  it("rejects an unknown status before any request", async () => {
    expect((await call("heliyos_runs_list", { status: "done" })).isError).toBe(true);
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/workers/runs`, () => apiError(500, "INTERNAL", "boom")));
    expectToolError(await call("heliyos_runs_list"), "INTERNAL");
  });
});

describe("heliyos_runs_list sort and filters", () => {
  const run = { orchestratorRunId: RUN_ID, status: "completed", title: "Acme deals", createdAt: "2026-03-01T10:00:00.000Z" };

  it("passes worker, company and date filters through", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/workers/runs`, ({ request }) => {
        url = new URL(request.url);
        return ok([run], { pagination: { limit: 20 } });
      })
    );
    expectOk(
      await call("heliyos_runs_list", {
        worker_id: "6aa000000000000000000002",
        company_id: "65b000000000000000000001",
        since: "2026-03-01",
        until: "2026-03-02",
      })
    );
    expect(url!.searchParams.get("agentId")).toBe("6aa000000000000000000002");
    expect(url!.searchParams.get("companyId")).toBe("65b000000000000000000001");
    expect(url!.searchParams.get("from")).toBe("2026-03-01");
    expect(url!.searchParams.get("to")).toBe("2026-03-02T23:59:59.999Z");
    expect(url!.searchParams.has("sortBy")).toBe(false);
  });

  it("sorts with sortBy/sortOrder and pages by page number", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/workers/runs`, ({ request }) => {
        url = new URL(request.url);
        return ok([run], { pagination: { limit: 1, offset: 0, total: 3, hasMore: true } });
      })
    );
    const result = await call("heliyos_runs_list", { sort: { field: "status", direction: "asc" }, limit: 1 });
    expectOk(result);
    expect(url!.searchParams.get("sortBy")).toBe("status");
    expect(url!.searchParams.get("sortOrder")).toBe("asc");
    expect(url!.searchParams.get("page")).toBe("1");
    expect((result.structuredContent as Structured).next_cursor).toBe("page:2:1");
  });

  it("rejects an unknown sort field", async () => {
    expect((await call("heliyos_runs_list", { sort: { field: "credits" } })).isError).toBe(true);
  });
});
