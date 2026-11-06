/**
 * The heliyos_triggers_list, heliyos_workers_tools_list tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { describe, expect, it } from "vitest";
import { expectOk, useMockApi, type Structured } from "../helpers/harness.js";
import { ACTION_IDS, catalogHandlers, triggerCatalog } from "../helpers/platform.js";

const { api, call } = useMockApi();

describe("heliyos_triggers_list", () => {
  it("lists every trigger with kind, object and integration, and filters client side", async () => {
    api.use(...catalogHandlers());
    const result = await call("heliyos_triggers_list", {});
    const text = expectOk(result);
    expect(text).toContain("6 triggers");
    expect(text).toContain("email.received (event, interaction, gmail)");
    expect(text).toContain("watches chosen fields");
    const sc = result.structuredContent as Structured;
    expect(sc.triggers.map((t: any) => t.name)).toEqual(triggerCatalog.map((t) => t.name));
    expect(sc.triggers[2]).toMatchObject({ name: "email.received", kind: "event", object_type: "interaction", integration: "gmail" });
    expect(sc.triggers[3].selects_attributes).toBe(true);

    const deals = (await call("heliyos_triggers_list", { object_type: "deals" })).structuredContent as Structured;
    expect(deals.triggers.map((t: any) => t.name)).toEqual(["deal.updated"]);
    const kinds = (await call("heliyos_triggers_list", { kind: "schedule" })).structuredContent as Structured;
    expect(kinds.triggers.map((t: any) => t.name)).toEqual(["schedule"]);
  });
});

describe("heliyos_workers_tools_list", () => {
  it("lists builtin tools and integration actions, hiding orchestrator plumbing", async () => {
    api.use(...catalogHandlers());
    const result = await call("heliyos_workers_tools_list", {});
    const text = expectOk(result);
    expect(text).toContain("3 tools");
    expect(text).toContain("send_email (action, communicate, gmail): Send email");
    expect(text).not.toContain("generate_final_response");
    const sc = result.structuredContent as Structured;
    expect(sc.tools.map((t: any) => t.name)).toEqual(["search_records", "update_record", "send_email"]);
    expect(sc.tools[2]).toMatchObject({ name: "send_email", source: "action", risk: "communicate", provider: "gmail", action_id: ACTION_IDS.sendEmail });
    expect(sc.tools[0]).not.toHaveProperty("input");

    const detailed = (await call("heliyos_workers_tools_list", { source: "builtin", search: "find", response_format: "detailed" })).structuredContent as Structured;
    expect(detailed.tools).toHaveLength(1);
    expect(detailed.tools[0]).toMatchObject({ name: "search_records", input: { type: "object" } });

    const gmail = (await call("heliyos_workers_tools_list", { provider: "gmail" })).structuredContent as Structured;
    expect(gmail.tools.map((t: any) => t.name)).toEqual(["send_email"]);
  });
});
