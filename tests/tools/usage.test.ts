/**
 * The heliyos_usage_get tool: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../../src/index.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P, RECORD_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const log = (n: number) => ({
  _id: `6e000000000000000000000${n}`,
  feature: "enrichment",
  creditsUtilized: 20,
  objectId: RECORD_IDS.acme,
  objectType: "company",
  description: "Company enrichment",
  createdAt: `2026-03-0${n}T00:00:00.000Z`,
});

describe("heliyos_usage_get", () => {
  it("is read-only and says usage cannot be changed", () => {
    const spec = listToolSpecs().find((s) => s.name === "heliyos_usage_get")!;
    expect(spec.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(spec.description).toMatch(/cannot be changed/);
  });

  it("lists credit usage with filters and a page cursor", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/usage`, ({ request }) => {
        url = new URL(request.url);
        return ok([log(1), log(2)], { pagination: { page: 1, limit: 2, offset: 0, count: 7, hasMore: true } });
      })
    );
    const result = await call("heliyos_usage_get", {
      feature: "company_enrichment",
      record_id: RECORD_IDS.acme,
      from: "2026-03-01",
      to: "2026-03-31",
      limit: 2,
    });
    const text = expectOk(result);
    expect(url!.searchParams.get("feature")).toBe("company_enrichment");
    expect(url!.searchParams.get("to")).toBe("2026-03-31T23:59:59.999Z");
    expect(url!.searchParams.get("objectId")).toBe(RECORD_IDS.acme);
    expect(url!.searchParams.get("from")).toBe("2026-03-01");
    expect(text).toContain("enrichment");
    expect(text).toMatch(/40 credits/);
    const sc = result.structuredContent as Structured;
    expect(sc.entries[0]).toMatchObject({ feature: "enrichment", credits: 20, record_id: RECORD_IDS.acme });
    expect(sc.total_entries).toBe(7);
    expect(sc.page_credits).toBe(40);
    expect(sc.next_cursor).toBe("page:2:2");
  });

  it("accepts only the features the services log, and the cursor's own limit", async () => {
    expect((await call("heliyos_usage_get", { feature: "enrichment" })).isError).toBe(true);
    expectToolError(await call("heliyos_usage_get", { cursor: "page:2:2" }), "VALIDATION_FAILED");
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/usage`, () => apiError(400, "VALIDATION_FAILED", "from must be a valid ISO 8601 date")));
    expectToolError(await call("heliyos_usage_get", { from: "2026-03-01" }), "VALIDATION_FAILED");
  });
});
