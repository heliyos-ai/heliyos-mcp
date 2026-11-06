/**
 * The heliyos_interactions_get, heliyos_interactions_list, heliyos_records_events, heliyos_records_timeline tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P, RECORD_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const ID = RECORD_IDS.acme;

const entry = (n: number) => ({
  _id: `66c00000000000000000000${n}`,
  timestamp: `2026-03-0${n}T10:00:00.000Z`,
  metadata: { objectId: ID, objectType: "company", summary: `Summary number ${n}: renewal talks moved forward.` },
});

describe("heliyos_records_timeline", () => {
  it("returns the record summary and dated entries, paging with an opaque cursor", async () => {
    const urls: URL[] = [];
    api.use(
      http.get(`${P}/records/${ID}/timeline`, ({ request }) => {
        urls.push(new URL(request.url));
        return ok(
          { summary: "Acme is mid-renewal.", events: [entry(1), entry(2)] },
          { pagination: { total: 30, page: 1, limit: 2, hasMore: true } }
        );
      })
    );

    const result = await call("heliyos_records_timeline", { record_id: ID, limit: 2 });

    const text = expectOk(result);
    expect(urls[0]!.searchParams.get("limit")).toBe("2");
    expect(urls[0]!.searchParams.has("page")).toBe(false);
    expect(text).toContain("Acme is mid-renewal.");
    expect(text).toContain("Summary number 1");
    expect(text).toContain("2026-03-01");
    const sc = result.structuredContent as Structured;
    expect(sc.record_id).toBe(ID);
    expect(sc.entries[0]).toMatchObject({ id: entry(1)._id, at: entry(1).timestamp });
    expect(sc.next_cursor).toBe("page:2:2");
    expect(text).toContain('"page:2:2"');

    await call("heliyos_records_timeline", { record_id: ID, limit: 2, cursor: sc.next_cursor });
    expect(urls[1]!.searchParams.get("page")).toBe("2");
  });

  it("refuses a page cursor with a different limit, and accepts it with the same one", async () => {
    const text = expectToolError(
      await call("heliyos_records_timeline", { record_id: ID, limit: 50, cursor: "page:2:20" }),
      "VALIDATION_FAILED"
    );
    expect(text).toContain("limit 20");
    expect(text).toMatch(/drop cursor/);
  });

  it("omits next_cursor on the last page", async () => {
    api.use(
      http.get(`${P}/records/${ID}/timeline`, () =>
        ok({ summary: "", events: [entry(1)] }, { pagination: { total: 21, page: 2, limit: 20, hasMore: false } })
      )
    );
    const result = await call("heliyos_records_timeline", { record_id: ID, cursor: "page:2:20" });
    expect(expectOk(result)).toContain("No more pages.");
    expect(result.structuredContent).not.toHaveProperty("next_cursor");
  });

  it("rejects a cursor this tool did not issue, without calling the API", async () => {
    const text = expectToolError(await call("heliyos_records_timeline", { record_id: ID, cursor: "abc" }), "VALIDATION_FAILED");
    expect(text).toContain("cursor");
  });

  it("returns NOT_FOUND for a missing record", async () => {
    api.use(http.get(`${P}/records/${ID}/timeline`, () => apiError(404, "NOT_FOUND", "Object not found")));
    expectToolError(await call("heliyos_records_timeline", { record_id: ID }), "NOT_FOUND");
  });
});

describe("heliyos_records_events", () => {
  const event = {
    _id: "66d000000000000000000001",
    timestamp: "2026-03-05T09:00:00.000Z",
    metadata: {
      actor: { name: "Jordan", type: "USER", uuid: "u1" },
      eventType: "AUDIT",
      objectType: "company",
      objectUUID: ID,
      operationType: "UPDATE",
      organizationUUID: "org",
    },
    originalVersion: { data: { stage: "Lead", domain: "acme.com" } },
    updatedVersion: { data: { stage: "Customer", domain: "acme.com" } },
    changeSummary: "Stage changed from Lead to Customer",
  };

  it("lists the record's change events with actor and summary, passing filters through", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/records/${ID}/events`, ({ request }) => {
        url = new URL(request.url);
        return ok([event], { pagination: { limit: 20, next_cursor: "cur_2" } });
      })
    );

    const result = await call("heliyos_records_events", {
      record_id: ID,
      operation_types: ["UPDATE"],
      since: "2026-03-01",
      search: "stage",
    });

    const text = expectOk(result);
    expect(url?.searchParams.get("operationType")).toBe("UPDATE");
    expect(url?.searchParams.get("startDate")).toBe("2026-03-01");
    expect(url?.searchParams.get("search")).toBe("stage");
    expect(text).toContain("Jordan");
    expect(text).toContain("Stage changed from Lead to Customer");
    expect(text).toContain("cur_2");
    const sc = result.structuredContent as Structured;
    expect(sc.events[0]).toMatchObject({ id: event._id, operation_type: "UPDATE", actor: "Jordan" });
    expect(sc.next_cursor).toBe("cur_2");
  });

  it("names the changed fields in detailed", async () => {
    api.use(http.get(`${P}/records/${ID}/events`, () => ok([event], { pagination: { limit: 20 } })));
    const result = await call("heliyos_records_events", { record_id: ID, response_format: "detailed" });
    expect((result.structuredContent as Structured).events[0].changed_fields).toEqual(["data.stage"]);
  });

  it("rejects an invalid since date before calling the API", async () => {
    expect((await call("heliyos_records_events", { record_id: ID, since: "yesterday" })).isError).toBe(true);
    expect((await call("heliyos_records_events", { record_id: ID, since: "March 1, 2026" })).isError).toBe(true);
  });

  it("accepts only the platform's operation and event types", async () => {
    expect((await call("heliyos_records_events", { record_id: ID, operation_types: ["update"] })).isError).toBe(true);
    expect((await call("heliyos_records_events", { record_id: ID, event_types: ["CHANGE"] })).isError).toBe(true);
  });

  it("sends a date-only until as the end of that day", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/records/${ID}/events`, ({ request }) => {
        url = new URL(request.url);
        return ok([], { pagination: {} });
      })
    );
    expectOk(await call("heliyos_records_events", { record_id: ID, event_types: ["AUDIT", "ENRICHMENT"], until: "2026-03-01" }));
    expect(url?.searchParams.get("endDate")).toBe("2026-03-01T23:59:59.999Z");
    expect(url?.searchParams.get("eventType")).toBe("AUDIT,ENRICHMENT");
  });

  it("returns NOT_FOUND for a missing record", async () => {
    api.use(http.get(`${P}/records/${ID}/events`, () => apiError(404, "NOT_FOUND", "Object not found")));
    expectToolError(await call("heliyos_records_events", { record_id: ID }), "NOT_FOUND");
  });
});

describe("heliyos_interactions_list", () => {
  const email = {
    _id: "66e000000000000000000001",
    channel: { type: "email", email: "rep@heliyos.ai" },
    subject: "Renewal pricing",
    summary: "Customer asked for a 10% discount on renewal.",
    sentiment: "neutral",
    createdAt: "2026-03-02T00:00:00.000Z",
    relationships: [{ objectType: "company", objectId: ID, schemaId: "s" }],
    threads: [
      { date: 1772500000, from: [{ email: "cfo@acme.com" }], to: [{ email: "rep@heliyos.ai" }], snippet: "Hi" },
    ],
  };
  const meeting = {
    _id: "66e000000000000000000002",
    channel: { type: "meeting", email: "rep@heliyos.ai" },
    title: "QBR",
    summary: "Reviewed adoption.",
    createdAt: "2026-03-03T00:00:00.000Z",
    relationships: [],
    participants: [{ email: "cfo@acme.com", status: "yes" }],
    when: { start_time: 1772600000, end_time: 1772603600, object: "timespan" },
  };

  it("lists emails and meetings for a record via the objectId filter", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/interactions`, ({ request }) => {
        url = new URL(request.url);
        return ok([email, meeting], { pagination: { limit: 20 } });
      })
    );

    const result = await call("heliyos_interactions_list", { record_id: ID, channel: "email" });

    const text = expectOk(result);
    expect(JSON.parse(url!.searchParams.get("filters")!)).toEqual({ objectId: ID, channelType: "email" });
    expect(text).toContain("Renewal pricing");
    expect(text).toContain("QBR");
    expect(text).toContain(email._id);
    const sc = result.structuredContent as Structured;
    expect(sc.interactions[0]).toMatchObject({ id: email._id, channel: "email", title: "Renewal pricing" });
    expect(sc.interactions[1]).toMatchObject({ id: meeting._id, channel: "meeting", title: "QBR" });
    expect(sc.interactions[1].at).toBe(new Date(1772600000 * 1000).toISOString());
    expect(sc).not.toHaveProperty("next_cursor");
  });

  it("surfaces a server validation error", async () => {
    api.use(http.get(`${P}/interactions`, () => apiError(400, "VALIDATION_FAILED", "filters must be valid JSON")));
    expectToolError(await call("heliyos_interactions_list", {}), "VALIDATION_FAILED");
  });
});

describe("long pages", () => {
  it("keeps a detailed page of 100 long entries under 20k characters and names the entries it leaves out", async () => {
    const long = "x".repeat(5000);
    const events = Array.from({ length: 100 }, (_, i) => ({
      _id: `66c${String(i).padStart(21, "0")}`,
      timestamp: "2026-03-01T00:00:00.000Z",
      metadata: { summary: long },
    }));
    api.use(
      http.get(`${P}/records/${ID}/timeline`, () =>
        ok({ summary: "s", events }, { pagination: { total: 100, page: 1, limit: 100, hasMore: false } })
      )
    );
    const result = await call("heliyos_records_timeline", { record_id: ID, limit: 100, response_format: "detailed" });
    const text = expectOk(result);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toMatch(/Text shows \d+ of the 100 entries on this page/);
    expect(text).toContain(events[99]!._id);
    expect((result.structuredContent as Structured).entries).toHaveLength(100);
  });
});

describe("heliyos_interactions_list sort", () => {
  it("maps the sort field to the platform's name and pages by page number", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/interactions`, ({ request }) => {
        url = new URL(request.url);
        return ok([], { pagination: { page: 1, limit: 20, hasMore: false } });
      })
    );
    const result = await call("heliyos_interactions_list", { channel: "email", sort: { field: "last_message", direction: "asc" } });
    expectOk(result);
    expect(url!.searchParams.get("page")).toBe("1");
    expect(JSON.parse(url!.searchParams.get("filters")!)).toEqual({
      channelType: "email",
      sort: [{ field: "thread_date", direction: "asc" }],
    });
    expect((result.structuredContent as Structured).next_cursor).toBeUndefined();
  });
});

describe("heliyos_interactions_get", () => {
  const meeting = {
    _id: "66e000000000000000000002",
    channel: { type: "meeting", email: "rep@heliyos.ai" },
    title: "QBR",
    summary: "Reviewed adoption. ".repeat(40),
    sentiment: "positive",
    nextSteps: "Send the renewal quote.",
    createdAt: "2026-03-03T00:00:00.000Z",
    relationships: [{ objectType: "company", objectId: ID, schemaId: "s" }],
    participants: [{ email: "cfo@acme.com", status: "yes" }],
    when: { start_time: 1772600000, end_time: 1772603600, object: "timespan" },
  };

  it("returns one interaction with participants and next steps, cut in concise", async () => {
    api.use(http.get(`${P}/interactions/${meeting._id}`, () => ok(meeting)));
    const concise = await call("heliyos_interactions_get", { interaction_id: meeting._id });
    const text = expectOk(concise);
    const i = (concise.structuredContent as Structured).interaction;
    expect(i).toMatchObject({ id: meeting._id, channel: "meeting", title: "QBR", sentiment: "positive", record_ids: [ID], participants: ["cfo@acme.com"], next_steps: "Send the renewal quote." });
    expect(i.summary.length).toBeLessThan(meeting.summary.length);
    expect(text).toContain("participants: cfo@acme.com");

    const detailed = await call("heliyos_interactions_get", { interaction_id: meeting._id, response_format: "detailed" });
    expect((detailed.structuredContent as Structured).interaction.summary).toBe(meeting.summary);
  });

  it("surfaces NOT_FOUND", async () => {
    api.use(http.get(`${P}/interactions/${meeting._id}`, () => apiError(404, "NOT_FOUND", "Interaction not found")));
    expectToolError(await call("heliyos_interactions_get", { interaction_id: meeting._id }), "NOT_FOUND");
  });
});
