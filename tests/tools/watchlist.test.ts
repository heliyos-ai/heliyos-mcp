/**
 * The heliyos_companies_unwatch, heliyos_companies_watch, heliyos_watchlist_get tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { textOf } from "../helpers/mcp.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { acme, apiError, baseSchemasHandler, ok, P, RECORD_IDS, SCHEMA_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const stats = {
  tasks: { total: 9, completed: 4 },
  totalActions: 3,
  totalMeetings: 2,
  totalDeals: 5,
  accountStatus: { healthy: 1 },
  engagementStatus: { active: 1 },
};

describe("heliyos_watchlist_get", () => {
  it("lists watched companies via the isAgentAssigned filter", async () => {
    let url: URL | undefined;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, ({ request }) => {
        url = new URL(request.url);
        return ok([{ ...acme, isAgentAssigned: true }], { pagination: { limit: 20, next_cursor: "w2" } });
      })
    );
    const result = await call("heliyos_watchlist_get");
    const text = expectOk(result);
    expect(JSON.parse(url!.searchParams.get("filters")!)).toEqual({ isAgentAssigned: true });
    expect(text).toContain(RECORD_IDS.acme);
    expect(text).toContain("Acme Corp");
    const sc = result.structuredContent as Structured;
    expect(sc.companies[0]).toMatchObject({ id: RECORD_IDS.acme, name: "Acme Corp" });
    expect(sc.next_cursor).toBe("w2");
    expect(sc).not.toHaveProperty("statistics");
  });

  it("adds watchlist statistics in detailed on the first page", async () => {
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () => ok([acme], { pagination: { limit: 20 } })),
      http.get(`${P}/watchlist/statistics`, () => ok(stats))
    );
    const result = await call("heliyos_watchlist_get", { response_format: "detailed" });
    expect(textOf(result)).toMatch(/4 of 9/);
    expect((result.structuredContent as Structured).statistics).toMatchObject({ tasks_total: 9, tasks_completed: 4, deals: 5, meetings: 2, actions: 3 });
  });

  it("surfaces an API error", async () => {
    api.use(baseSchemasHandler(), http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () => apiError(500, "INTERNAL", "boom")));
    expectToolError(await call("heliyos_watchlist_get"), "INTERNAL");
  });
});

describe("heliyos_companies_watch / unwatch", () => {
  it("watches a company", async () => {
    api.use(http.post(`${P}/companies/${RECORD_IDS.acme}/watch`, () => ok({ ...acme, isAgentAssigned: true })));
    const result = await call("heliyos_companies_watch", { record_id: RECORD_IDS.acme });
    expect(expectOk(result)).toContain("Acme Corp");
    expect(result.structuredContent).toEqual({ record_id: RECORD_IDS.acme, watched: true });
  });

  it("reports a record that is not a company", async () => {
    api.use(http.post(`${P}/companies/${RECORD_IDS.acme}/watch`, () => apiError(404, "NOT_FOUND", "Company not found")));
    expectToolError(await call("heliyos_companies_watch", { record_id: RECORD_IDS.acme }), "NOT_FOUND");
  });

  it("unwatches a company", async () => {
    api.use(http.delete(`${P}/companies/${RECORD_IDS.acme}/watch`, () => ok({ ...acme, isAgentAssigned: false })));
    const result = await call("heliyos_companies_unwatch", { record_id: RECORD_IDS.acme });
    expectOk(result);
    expect(result.structuredContent).toEqual({ record_id: RECORD_IDS.acme, watched: false });
  });

  it("surfaces an unwatch error", async () => {
    api.use(http.delete(`${P}/companies/${RECORD_IDS.acme}/watch`, () => apiError(404, "NOT_FOUND", "Company not found")));
    expectToolError(await call("heliyos_companies_unwatch", { record_id: RECORD_IDS.acme }), "NOT_FOUND");
  });
});
