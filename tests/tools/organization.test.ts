/**
 * The heliyos_organization_get tool: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P } from "../helpers/platform.js";

const { api, call } = useMockApi();

const summary = {
  id: "64f000000000000000000001",
  name: "Acme Workspace",
  billingStatus: "active",
  plan: { name: "Growth" },
  memberCount: 4,
  recordCounts: { companies: 120, people: 300, deals: 15 },
  watchersInUse: 12,
  watchersLimit: 50,
};

describe("heliyos_organization_get", () => {
  it("returns the workspace summary with its id, plan, counts and watcher usage", async () => {
    api.use(http.get(`${P}/organization`, () => ok(summary)));

    const result = await call("heliyos_organization_get");

    const text = expectOk(result);
    expect(text).toContain("Acme Workspace");
    expect(text).toContain(summary.id);
    expect(text).toContain("Growth");
    expect(text).toMatch(/12 of 50/);
    const sc = result.structuredContent as Structured;
    expect(sc.organization).toMatchObject({
      id: summary.id,
      name: "Acme Workspace",
      plan: "Growth",
      member_count: 4,
      record_counts: { companies: 120, people: 300, deals: 15 },
      watchers_in_use: 12,
      watchers_limit: 50,
    });
  });

  it("says there is no active plan when plan and limit are null", async () => {
    api.use(http.get(`${P}/organization`, () => ok({ ...summary, plan: null, watchersLimit: null })));
    const text = expectOk(await call("heliyos_organization_get"));
    expect(text).toMatch(/no active plan/i);
  });

  it("shows an active plan without a product name as an unnamed plan", async () => {
    api.use(http.get(`${P}/organization`, () => ok({ ...summary, plan: { name: "" } })));
    const result = await call("heliyos_organization_get");
    expect(expectOk(result)).toContain("unnamed plan");
    expect((result.structuredContent as Structured).organization.watchers_limit).toBe(50);
  });

  it("returns FORBIDDEN_ACTION with a hint when the key may not read the organization", async () => {
    api.use(http.get(`${P}/organization`, () => apiError(403, "FORBIDDEN_ACTION", "Not allowed")));
    const text = expectToolError(await call("heliyos_organization_get"), "FORBIDDEN_ACTION");
    expect(text).toContain("cannot perform");
  });
});
