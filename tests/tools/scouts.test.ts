/**
 * The heliyos_companies_scouts_add, heliyos_companies_scouts_list, heliyos_companies_scouts_remove, heliyos_scouts_create, heliyos_scouts_delete, heliyos_scouts_get, heliyos_scouts_list, heliyos_scouts_update, heliyos_signals_list, heliyos_signals_mark_read, heliyos_usage_get tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../../src/index.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P, RECORD_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();

const SCOUT_ID = "66a000000000000000000001";
const CUSTOM_ID = "66a000000000000000000002";
const INSTANCE_ID = "66b000000000000000000001";
const SIGNAL_ID = "66c000000000000000000001";
const SIGNAL_2 = "66c000000000000000000002";

const funding = {
  _id: SCOUT_ID,
  organizationId: "64f000000000000000000001",
  name: "Funding rounds",
  type: "default",
  applyTo: "watchlist",
  category: "Funding",
  queryTemplate: "Find new funding rounds for {company_name}",
  cadence: "weekly",
  effort: "medium",
  isActive: true,
  previewStatus: null,
  signal_counts: { total: 12, new: 3 },
  latest_signal: { _id: SIGNAL_ID, summary: "Acme raised a Series B", detected_date: "2026-10-20T00:00:00.000Z" },
  active_company_count: 5,
  metadata: { created: { at: "2026-01-01T00:00:00.000Z" }, updated: { at: "2026-02-01T00:00:00.000Z" } },
};
const custom = {
  ...funding,
  _id: CUSTOM_ID,
  name: "Hiring for RevOps",
  type: "custom",
  category: "Hiring",
  isActive: false,
  previewStatus: "running",
  signal_counts: { total: 0, new: 0 },
  latest_signal: null,
  active_company_count: 0,
};
const signal = {
  _id: SIGNAL_ID,
  scoutSchemaId: INSTANCE_ID,
  baseSchemaObjectId: RECORD_IDS.acme,
  category: "Funding",
  scout_name: "Funding rounds",
  company_name: "Acme Corp",
  website: "https://acme.com",
  summary: "Acme raised a $40M Series B led by Example Ventures.",
  citations: ["https://news.example.com/acme-series-b"],
  detected_date: "2026-10-20T00:00:00.000Z",
  relevance_score: 0.9,
  status: "new",
};
const instance = {
  _id: INSTANCE_ID,
  baseSchemaObjectId: RECORD_IDS.acme,
  defaultScoutId: SCOUT_ID,
  name: "Funding rounds",
  category: "Funding",
  cadence: "weekly",
  status: "active",
  scope: "watchlist",
  lastRunDate: "2026-10-19T00:00:00.000Z",
};

describe("registration", () => {
  it("registers the scout and signal tools in order after the M3a tools", () => {
    const names = listToolSpecs().map((s) => s.name);
    const start = names.indexOf("heliyos_scouts_list");
    expect(start).toBeGreaterThan(names.indexOf("heliyos_usage_get"));
    expect(names.slice(start, start + 10)).toEqual([
      "heliyos_scouts_list",
      "heliyos_scouts_get",
      "heliyos_scouts_create",
      "heliyos_scouts_update",
      "heliyos_scouts_delete",
      "heliyos_companies_scouts_list",
      "heliyos_companies_scouts_add",
      "heliyos_companies_scouts_remove",
      "heliyos_signals_list",
      "heliyos_signals_mark_read",
    ]);
  });
});

describe("heliyos_scouts_list", () => {
  it("lists global scouts with their ids, state and signal counts", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/global-scouts`, ({ request }) => {
        url = new URL(request.url);
        return ok([funding, custom]);
      })
    );
    const result = await call("heliyos_scouts_list", { type: "custom", is_active: false });
    const text = expectOk(result);
    expect(url!.searchParams.get("type")).toBe("custom");
    expect(url!.searchParams.get("isActive")).toBe("false");
    expect(text).toContain(SCOUT_ID);
    expect(text).toContain(CUSTOM_ID);
    expect(text).toContain("Funding rounds");
    const sc = result.structuredContent as Structured;
    expect(sc.scouts[0]).toMatchObject({ id: SCOUT_ID, type: "default", is_active: true, new_signals: 3, total_signals: 12 });
    expect(sc.scouts[1]).toMatchObject({ id: CUSTOM_ID, is_active: false, preview_status: "running" });
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/global-scouts`, () => apiError(500, "INTERNAL", "Error listing global scouts")));
    expectToolError(await call("heliyos_scouts_list"), "INTERNAL");
  });
});

describe("heliyos_scouts_get", () => {
  it("concise returns the scout without reading its signals", async () => {
    api.use(http.get(`${P}/global-scouts/${SCOUT_ID}`, () => ok(funding)));
    const result = await call("heliyos_scouts_get", { scout_id: SCOUT_ID });
    const text = expectOk(result);
    expect(text).toContain(SCOUT_ID);
    expect(text).toContain("Find new funding rounds");
    expect((result.structuredContent as Structured).scout.id).toBe(SCOUT_ID);
  });

  it("detailed adds the latest signals with their ids", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/global-scouts/${SCOUT_ID}`, () => ok(funding)),
      http.get(`${P}/global-scouts/${SCOUT_ID}/signals`, ({ request }) => {
        url = new URL(request.url);
        return ok([{ ...signal, companyName: "Acme Corp" }], { pagination: { limit: 5, next_cursor: "s2" } });
      })
    );
    const result = await call("heliyos_scouts_get", { scout_id: SCOUT_ID, response_format: "detailed" });
    const text = expectOk(result);
    expect(url!.searchParams.get("limit")).toBe("5");
    expect(text).toContain(SIGNAL_ID);
    expect(text).toContain("heliyos_signals_list");
    const sc = result.structuredContent as Structured;
    expect(sc.recent_signals[0]).toMatchObject({ id: SIGNAL_ID, company_name: "Acme Corp" });
  });

  it("returns NOT_FOUND for a missing scout", async () => {
    api.use(http.get(`${P}/global-scouts/${SCOUT_ID}`, () => apiError(404, "NOT_FOUND", "Global scout not found")));
    expectToolError(await call("heliyos_scouts_get", { scout_id: SCOUT_ID }), "NOT_FOUND");
  });
});

describe("heliyos_scouts_create", () => {
  it("creates a custom scout and says how to confirm it", async () => {
    let body: any;
    api.use(
      http.post(`${P}/global-scouts`, async ({ request }) => {
        body = await request.json();
        return ok(custom);
      })
    );
    const result = await call("heliyos_scouts_create", {
      name: "Hiring for RevOps",
      category: "Hiring",
      query: "Is {company_name} hiring RevOps roles?",
      cadence: "daily",
    });
    const text = expectOk(result);
    expect(body).toEqual({
      name: "Hiring for RevOps",
      category: "Hiring",
      queryTemplate: "Is {company_name} hiring RevOps roles?",
      cadence: "daily",
    });
    expect(text).toContain(CUSTOM_ID);
    expect(text).toContain('state "confirmed"');
    expect((result.structuredContent as Structured).scout).toMatchObject({ id: CUSTOM_ID, is_active: false });
  });

  it("requires selected_company_ids for selected_watchlist before any request", async () => {
    const result = await call("heliyos_scouts_create", {
      name: "x",
      category: "y",
      query: "z",
      apply_to: "selected_watchlist",
    });
    expect(result.isError).toBe(true);
  });

  it("surfaces a server validation error", async () => {
    api.use(http.post(`${P}/global-scouts`, () => apiError(400, "VALIDATION_FAILED", "selectedCompanyIds must contain only watched companies from this organization")));
    const text = expectToolError(
      await call("heliyos_scouts_create", {
        name: "x",
        category: "y",
        query: "z",
        apply_to: "selected_watchlist",
        selected_company_ids: [RECORD_IDS.globex],
      }),
      "VALIDATION_FAILED"
    );
    expect(text).toContain("watched companies");
  });
});

describe("heliyos_scouts_update", () => {
  it("patches fields only", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/global-scouts/${CUSTOM_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...custom, cadence: "monthly" });
      })
    );
    const result = await call("heliyos_scouts_update", { scout_id: CUSTOM_ID, cadence: "monthly" });
    expect(expectOk(result)).toContain(CUSTOM_ID);
    expect(body).toEqual({ cadence: "monthly" });
    expect((result.structuredContent as Structured).scout.cadence).toBe("monthly");
  });

  it("pauses through the state endpoint and returns the scout", async () => {
    let body: any;
    api.use(
      http.post(`${P}/global-scouts/${SCOUT_ID}/state`, async ({ request }) => {
        body = await request.json();
        return ok({ success: true, scout: { ...funding, isActive: false }, deactivated_count: 5, monitors_deleted: 5 });
      })
    );
    const result = await call("heliyos_scouts_update", { scout_id: SCOUT_ID, state: "paused" });
    const text = expectOk(result);
    expect(body).toEqual({ state: "paused" });
    expect(text).toContain("paused");
    expect((result.structuredContent as Structured).scout).toMatchObject({ id: SCOUT_ID, is_active: false });
  });

  it("applies fields first, then the state, when both are given", async () => {
    const order: string[] = [];
    api.use(
      http.patch(`${P}/global-scouts/${CUSTOM_ID}`, () => {
        order.push("patch");
        return ok(custom);
      }),
      http.post(`${P}/global-scouts/${CUSTOM_ID}/state`, () => {
        order.push("state");
        return ok({ ...custom, isActive: true, previewStatus: "completed" });
      })
    );
    const result = await call("heliyos_scouts_update", { scout_id: CUSTOM_ID, name: "RevOps hiring", state: "confirmed" });
    expectOk(result);
    expect(order).toEqual(["patch", "state"]);
    expect((result.structuredContent as Structured).scout.is_active).toBe(true);
  });

  it("says the fields were saved when the state change after them fails", async () => {
    api.use(
      http.patch(`${P}/global-scouts/${CUSTOM_ID}`, () => ok(custom)),
      http.post(`${P}/global-scouts/${CUSTOM_ID}/state`, () => apiError(400, "VALIDATION_FAILED", "Scout preview is not completed"))
    );
    const text = expectToolError(
      await call("heliyos_scouts_update", { scout_id: CUSTOM_ID, name: "RevOps hiring", state: "confirmed" }),
      "VALIDATION_FAILED"
    );
    expect(text).toContain("field changes (name) were saved");
    expect(text).toContain("preview is not completed");
  });

  it("rejects a call with nothing to change", async () => {
    const result = await call("heliyos_scouts_update", { scout_id: SCOUT_ID });
    expect(result.isError).toBe(true);
  });

  it("surfaces a confirm on an unfinished preview", async () => {
    api.use(http.post(`${P}/global-scouts/${CUSTOM_ID}/state`, () => apiError(400, "VALIDATION_FAILED", "Scout preview is not completed")));
    const text = expectToolError(await call("heliyos_scouts_update", { scout_id: CUSTOM_ID, state: "confirmed" }), "VALIDATION_FAILED");
    expect(text).toContain("preview is not completed");
  });
});

describe("heliyos_scouts_delete", () => {
  it("deletes a custom scout", async () => {
    api.use(
      http.delete(`${P}/global-scouts/${CUSTOM_ID}`, () => ok({ success: true, deleted_company_scouts: 2, monitors_deleted: 2 }))
    );
    const result = await call("heliyos_scouts_delete", { scout_id: CUSTOM_ID });
    const text = expectOk(result);
    expect(text).toContain(CUSTOM_ID);
    expect(result.structuredContent).toMatchObject({ scout_id: CUSTOM_ID, deleted: true, deleted_company_scouts: 2 });
  });

  it("returns FORBIDDEN_ACTION for a default scout", async () => {
    api.use(
      http.delete(`${P}/global-scouts/${SCOUT_ID}`, () =>
        apiError(403, "FORBIDDEN_ACTION", "Cannot delete default scouts. Only custom scouts can be deleted.")
      )
    );
    expectToolError(await call("heliyos_scouts_delete", { scout_id: SCOUT_ID }), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_companies_scouts_list", () => {
  it("lists a company's scouts with instance and global ids", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/companies/${RECORD_IDS.acme}/scouts`, ({ request }) => {
        url = new URL(request.url);
        return ok([instance]);
      })
    );
    const result = await call("heliyos_companies_scouts_list", { company_id: RECORD_IDS.acme, status: "active" });
    const text = expectOk(result);
    expect(url!.searchParams.get("status")).toBe("active");
    expect(text).toContain(INSTANCE_ID);
    expect(text).toContain(SCOUT_ID);
    expect((result.structuredContent as Structured).scouts[0]).toMatchObject({ id: INSTANCE_ID, scout_id: SCOUT_ID, status: "active" });
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/companies/${RECORD_IDS.acme}/scouts`, () => apiError(500, "INTERNAL", "Error fetching scouts")));
    expectToolError(await call("heliyos_companies_scouts_list", { company_id: RECORD_IDS.acme }), "INTERNAL");
  });
});

describe("heliyos_companies_scouts_add", () => {
  it("starts the given scouts on a company", async () => {
    let body: any;
    api.use(
      http.post(`${P}/companies/${RECORD_IDS.acme}/scouts`, async ({ request }) => {
        body = await request.json();
        return ok({ message: "Scout creation triggered successfully", status: "processing", total_scouts: 1 });
      })
    );
    const result = await call("heliyos_companies_scouts_add", { company_id: RECORD_IDS.acme, scout_ids: [SCOUT_ID, SCOUT_ID] });
    const text = expectOk(result);
    expect(body).toEqual({ defaultScoutIds: [SCOUT_ID] });
    expect(text).toContain(RECORD_IDS.acme);
    expect(result.structuredContent).toMatchObject({ company_id: RECORD_IDS.acme, scout_ids: [SCOUT_ID], status: "processing" });
  });

  it("surfaces an inactive scout", async () => {
    api.use(
      http.post(`${P}/companies/${RECORD_IDS.acme}/scouts`, () =>
        apiError(400, "VALIDATION_FAILED", "Inactive scouts cannot be assigned to a company")
      )
    );
    expectToolError(
      await call("heliyos_companies_scouts_add", { company_id: RECORD_IDS.acme, scout_ids: [CUSTOM_ID] }),
      "VALIDATION_FAILED"
    );
  });
});

describe("heliyos_companies_scouts_remove", () => {
  it("removes every scout from the company and reports failures", async () => {
    api.use(
      http.delete(`${P}/companies/${RECORD_IDS.acme}/scouts`, () =>
        ok({
          success: [INSTANCE_ID],
          failed: [{ scout_id: "66b000000000000000000002", error: "monitor gone" }],
          total: 2,
          success_count: 1,
          failed_count: 1,
        })
      )
    );
    const result = await call("heliyos_companies_scouts_remove", { company_id: RECORD_IDS.acme });
    const text = expectOk(result);
    expect(text).toContain(INSTANCE_ID);
    expect(text).toContain("66b000000000000000000002");
    expect(result.structuredContent).toMatchObject({ company_id: RECORD_IDS.acme, removed: [INSTANCE_ID], failed: ["66b000000000000000000002"] });
  });

  it("surfaces an API error", async () => {
    api.use(http.delete(`${P}/companies/${RECORD_IDS.acme}/scouts`, () => apiError(500, "INTERNAL", "Error deleting scouts")));
    expectToolError(await call("heliyos_companies_scouts_remove", { company_id: RECORD_IDS.acme }), "INTERNAL");
  });
});

describe("heliyos_signals_list", () => {
  it("lists the workspace's signals filtered by company and status", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/signals`, ({ request }) => {
        url = new URL(request.url);
        return ok([signal], { pagination: { limit: 20, next_cursor: "sig2" } });
      })
    );
    const result = await call("heliyos_signals_list", { company_id: RECORD_IDS.acme, status: "new" });
    const text = expectOk(result);
    expect(url!.searchParams.get("companyId")).toBe(RECORD_IDS.acme);
    expect(url!.searchParams.get("status")).toBe("new");
    expect(url!.searchParams.get("limit")).toBe("20");
    expect(text).toContain(SIGNAL_ID);
    expect(text).toContain("Acme Corp");
    const sc = result.structuredContent as Structured;
    expect(sc.signals[0]).toMatchObject({ id: SIGNAL_ID, company_id: RECORD_IDS.acme, status: "new" });
    expect(sc.next_cursor).toBe("sig2");
  });

  it("reads one global scout's signals through its own endpoint", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/global-scouts/${SCOUT_ID}/signals`, ({ request }) => {
        url = new URL(request.url);
        return ok([signal]);
      })
    );
    const result = await call("heliyos_signals_list", { scout_id: SCOUT_ID, cursor: "abc" });
    expectOk(result);
    expect(url!.searchParams.get("cursor")).toBe("abc");
    expect(url!.searchParams.has("scoutId")).toBe(false);
  });

  it("rejects an unknown status before any request", async () => {
    const result = await call("heliyos_signals_list", { status: "unread" });
    expect(result.isError).toBe(true);
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/signals`, () => apiError(400, "VALIDATION_FAILED", "Invalid cursor")));
    expectToolError(await call("heliyos_signals_list", { cursor: "bad" }), "VALIDATION_FAILED");
  });
});

describe("heliyos_signals_mark_read", () => {
  it("marks each given signal read", async () => {
    const seen: string[] = [];
    api.use(
      http.post(`${P}/signals/:id/read`, ({ params }) => {
        seen.push(String(params.id));
        return ok({ success: true, signal: { ...signal, status: "read" } });
      })
    );
    const result = await call("heliyos_signals_mark_read", { signal_ids: [SIGNAL_ID, SIGNAL_2] });
    const text = expectOk(result);
    expect(seen).toEqual([SIGNAL_ID, SIGNAL_2]);
    expect(text).toContain(SIGNAL_2);
    expect(result.structuredContent).toMatchObject({ marked: [SIGNAL_ID, SIGNAL_2], failed: [] });
  });

  it("reports ids that failed next to those that worked", async () => {
    api.use(
      http.post(`${P}/signals/${SIGNAL_ID}/read`, () => ok({ success: true })),
      http.post(`${P}/signals/${SIGNAL_2}/read`, () => apiError(404, "NOT_FOUND", "Signal not found"))
    );
    const result = await call("heliyos_signals_mark_read", { signal_ids: [SIGNAL_ID, SIGNAL_2] });
    const text = expectOk(result);
    expect(text).toContain("NOT_FOUND");
    expect(result.structuredContent).toMatchObject({ marked: [SIGNAL_ID], failed: [{ id: SIGNAL_2, code: "NOT_FOUND" }] });
  });

  it("fails when every id fails", async () => {
    api.use(http.post(`${P}/signals/${SIGNAL_ID}/read`, () => apiError(404, "NOT_FOUND", "Signal not found")));
    expectToolError(await call("heliyos_signals_mark_read", { signal_ids: [SIGNAL_ID] }), "NOT_FOUND");
  });

  it("marks a company's new signals read in one call", async () => {
    let body: any;
    api.use(
      http.post(`${P}/signals/bulk-read`, async ({ request }) => {
        body = await request.json();
        return ok({ success: true, marked_count: 4 });
      })
    );
    const result = await call("heliyos_signals_mark_read", { company_id: RECORD_IDS.acme });
    expect(expectOk(result)).toContain("4");
    expect(body).toEqual({ companyId: RECORD_IDS.acme });
    expect(result.structuredContent).toMatchObject({ company_id: RECORD_IDS.acme, marked_count: 4 });
  });

  it("treats a bulk answer of success false as an error", async () => {
    api.use(http.post(`${P}/signals/bulk-read`, () => ok({ success: false, error: "db down" })));
    expectToolError(await call("heliyos_signals_mark_read", { company_id: RECORD_IDS.acme }), "INTERNAL");
  });

  it("needs exactly one of signal_ids or company_id", async () => {
    expect((await call("heliyos_signals_mark_read", {})).isError).toBe(true);
    expect((await call("heliyos_signals_mark_read", { signal_ids: [SIGNAL_ID], company_id: RECORD_IDS.acme })).isError).toBe(true);
  });
});
