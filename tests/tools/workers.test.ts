/**
 * The heliyos_triggers_list, heliyos_workers_create, heliyos_workers_delete, heliyos_workers_get, heliyos_workers_list, heliyos_workers_tools_list, heliyos_workers_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { ACTION_IDS, apiError, catalogHandlers, ok, P } from "../helpers/platform.js";

const { api, call } = useMockApi();

const DEFAULT_ID = "6aa000000000000000000001";
const CUSTOM_ID = "6aa000000000000000000002";

const analyst = {
  _id: DEFAULT_ID,
  name: "Conversation Analyst",
  type: "default",
  isActive: true,
  description: "Reads every email thread.",
  toolName: "conversation_analyst",
  instructions: "Summarise each thread. ".repeat(100),
  triggers: [{ type: "event", source: "default", events: ["interaction.created"] }],
  toolNames: ["records.read", "notes.create"],
  toolPolicy: { readOnly: false },
  memory: { enabled: true },
  resources: { scope: "org_knowledge" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};
const renewals = {
  _id: CUSTOM_ID,
  name: "Renewal scout",
  type: "custom",
  isActive: false,
  instructions: "Find renewals due in 30 days.",
  triggers: [{ type: "scheduled", source: "user", match: { schedule: "0 8 * * 1-5", timezone: "Europe/Berlin" } }, { type: "mention" }],
};

describe("heliyos_workers_list", () => {
  it("lists every worker with type, active flag and triggers, filtered client side", async () => {
    api.use(http.get(`${P}/agents`, () => ok([analyst, renewals])));
    const result = await call("heliyos_workers_list", { type: "custom", response_format: "detailed" });
    const text = expectOk(result);
    expect(text).toContain("Renewal scout");
    expect(text).not.toContain("Conversation Analyst");
    expect(text).toContain("scheduled (0 8 * * 1-5 Europe/Berlin)");
    const sc = result.structuredContent as Structured;
    expect(sc.workers).toHaveLength(1);
    expect(sc.workers[0]).toMatchObject({ id: CUSTOM_ID, type: "custom", is_active: false });
    expect(sc.workers[0].triggers).toEqual([
      { type: "scheduled", cron: "0 8 * * 1-5", timezone: "Europe/Berlin" },
      { type: "mention" },
    ]);
    // The list never carries instructions.
    expect(sc.workers[0]).not.toHaveProperty("instructions");
  });

  it("filters by is_active and keeps concise rows trigger-free", async () => {
    api.use(http.get(`${P}/agents`, () => ok([analyst, renewals])));
    const sc = (await call("heliyos_workers_list", { is_active: true })).structuredContent as Structured;
    expect(sc.workers.map((w: any) => w.id)).toEqual([DEFAULT_ID]);
    expect(sc.workers[0]).not.toHaveProperty("triggers");
  });
});

describe("heliyos_workers_get", () => {
  it("returns shortened instructions in concise and everything in detailed", async () => {
    api.use(http.get(`${P}/agents/${DEFAULT_ID}`, () => ok(analyst)));
    const concise = (await call("heliyos_workers_get", { worker_id: DEFAULT_ID })).structuredContent as Structured;
    expect(concise.worker.instructions.length).toBeLessThan(analyst.instructions.length);
    expect(concise.worker).not.toHaveProperty("tool_names");

    const result = await call("heliyos_workers_get", { worker_id: DEFAULT_ID, response_format: "detailed" });
    const text = expectOk(result);
    const w = (result.structuredContent as Structured).worker;
    expect(w).toMatchObject({
      id: DEFAULT_ID,
      type: "default",
      tool_name: "conversation_analyst",
      tool_names: ["records.read", "notes.create"],
      read_only: false,
      memory_enabled: true,
      resources_scope: "org_knowledge",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(w.instructions).toBe(analyst.instructions);
    expect(w.triggers).toEqual([{ type: "event", events: ["interaction.created"] }]);
    expect(text).toContain("event (interaction.created)");
  });

  it("surfaces NOT_FOUND", async () => {
    api.use(http.get(`${P}/agents/${CUSTOM_ID}`, () => apiError(404, "NOT_FOUND", "Agent not found")));
    expectToolError(await call("heliyos_workers_get", { worker_id: CUSTOM_ID }), "NOT_FOUND");
  });
});

describe("heliyos_workers_create", () => {
  it("maps the inputs to the platform's agent body and trigger shapes, splitting tool_names into tools and actions", async () => {
    let body: any;
    api.use(
      ...catalogHandlers(),
      http.post(`${P}/agents`, async ({ request }) => {
        body = await request.json();
        return ok({ ...renewals, ...body, _id: CUSTOM_ID, type: "custom" }, {}, );
      })
    );
    const result = await call("heliyos_workers_create", {
      name: "Renewal scout",
      instructions: "Find renewals due in 30 days.",
      description: "Weekly renewal check",
      read_only: true,
      memory_enabled: false,
      triggers: [
        { type: "scheduled", cron: "0 8 * * 1-5", timezone: "Europe/Berlin" },
        { type: "event", events: ["deal.updated"] },
        { type: "mention" },
      ],
      tool_names: ["search_records", "send_email"],
    });
    const text = expectOk(result);
    expect(body).toEqual({
      name: "Renewal scout",
      instructions: "Find renewals due in 30 days.",
      description: "Weekly renewal check",
      toolPolicy: { readOnly: true },
      memory: { enabled: false },
      triggers: [
        { type: "scheduled", match: { schedule: "0 8 * * 1-5", timezone: "Europe/Berlin" } },
        { type: "event", events: ["deal.updated"] },
        { type: "mention" },
      ],
      toolNames: ["search_records"],
      actionIds: [ACTION_IDS.sendEmail],
    });
    expect(text).toContain("tools: search_records");
    const w = (result.structuredContent as Structured).worker;
    expect(w.id).toBe(CUSTOM_ID);
    expect(w.tool_names).toEqual(["search_records"]);
    expect(w.action_ids).toEqual([ACTION_IDS.sendEmail]);
  });

  it("refuses an event name or tool name the catalogs do not know, before creating anything", async () => {
    api.use(...catalogHandlers(), http.post(`${P}/agents`, () => apiError(500, "INTERNAL", "should not be called")));
    const badEvent = await call("heliyos_workers_create", { name: "W", instructions: "Do it.", triggers: [{ type: "event", events: ["deal.updated", "deal.closed"] }] });
    const eventText = expectToolError(badEvent, "VALIDATION_FAILED");
    expect(eventText).toContain('"deal.closed"');
    expect(eventText).toContain("heliyos_triggers_list");
    expect(eventText).not.toContain('"deal.updated"');

    const badTool = await call("heliyos_workers_create", { name: "W", instructions: "Do it.", tool_names: ["search_records", "generate_final_response"] });
    const toolText = expectToolError(badTool, "VALIDATION_FAILED");
    expect(toolText).toContain('"generate_final_response"');
    expect(toolText).toContain("heliyos_workers_tools_list");
  });

  it("creates without touching the catalogs when no events or tool_names are given", async () => {
    api.use(http.post(`${P}/agents`, async ({ request }) => ok({ ...renewals, ...((await request.json()) as object), _id: CUSTOM_ID, type: "custom" })));
    expectOk(await call("heliyos_workers_create", { name: "W", instructions: "Do it.", triggers: [{ type: "mention" }] }));
  });

  it.each([
    [{ type: "event" }, /events/],
    [{ type: "scheduled" }, /cron/],
    [{ type: "scheduled", cron: "every day" }, /5 fields/],
    [{ type: "mention", events: ["x"] }, /events only apply/],
  ])("rejects a malformed trigger %j before calling the API", async (trigger, message) => {
    const result = await call("heliyos_workers_create", { name: "W", instructions: "Do it.", triggers: [trigger] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
  });

  it("surfaces CONFLICT for a duplicate name", async () => {
    api.use(http.post(`${P}/agents`, () => apiError(409, "CONFLICT", "A worker with this name already exists.")));
    expectToolError(await call("heliyos_workers_create", { name: "Renewal scout", instructions: "x" }), "CONFLICT");
  });
});

describe("heliyos_workers_update", () => {
  it("sends only the given fields and notes what a default worker ignores", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/agents/${DEFAULT_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...analyst, instructions: body.instructions });
      })
    );
    const result = await call("heliyos_workers_update", { worker_id: DEFAULT_ID, instructions: "Be brief.", name: "Nope", is_active: false });
    const text = expectOk(result);
    expect(body).toEqual({ instructions: "Be brief.", name: "Nope", isActive: false });
    expect(text).toContain("name cannot change on a default worker");
    expect((result.structuredContent as Structured).worker.instructions).toBe("Be brief.");
  });

  it("replaces tool_names on a custom worker, keeping hidden plumbing it already had", async () => {
    let body: any;
    api.use(
      ...catalogHandlers(),
      http.get(`${P}/agents/${CUSTOM_ID}`, () => ok({ ...renewals, toolNames: ["update_record", "generate_final_response"], actionIds: [] })),
      http.patch(`${P}/agents/${CUSTOM_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...renewals, ...body });
      })
    );
    const result = await call("heliyos_workers_update", { worker_id: CUSTOM_ID, tool_names: ["search_records", "send_email"] });
    const text = expectOk(result);
    expect(body).toEqual({ toolNames: ["search_records", "generate_final_response"], actionIds: [ACTION_IDS.sendEmail] });
    expect(text).toContain("tool_names: search_records, send_email");
    expect((result.structuredContent as Structured).worker.action_ids).toEqual([ACTION_IDS.sendEmail]);
  });

  it("requires at least one change", async () => {
    expect((await call("heliyos_workers_update", { worker_id: CUSTOM_ID })).isError).toBe(true);
  });
});

describe("heliyos_workers_delete", () => {
  it("deletes a custom worker", async () => {
    api.use(http.delete(`${P}/agents/${CUSTOM_ID}`, () => ok({ deleted: true })));
    const result = await call("heliyos_workers_delete", { worker_id: CUSTOM_ID });
    expectOk(result);
    expect(result.structuredContent).toEqual({ worker_id: CUSTOM_ID, deleted: true });
  });

  it("surfaces the platform's refusal for a default worker", async () => {
    api.use(http.delete(`${P}/agents/${DEFAULT_ID}`, () => apiError(400, "VALIDATION_FAILED", "Default agents cannot be deleted.")));
    expectToolError(await call("heliyos_workers_delete", { worker_id: DEFAULT_ID }), "VALIDATION_FAILED");
  });
});
