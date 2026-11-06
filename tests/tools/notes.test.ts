/**
 * The heliyos_notes_create, heliyos_notes_delete, heliyos_notes_get, heliyos_notes_list, heliyos_notes_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { acme, apiError, ok, P, RECORD_IDS, SCHEMA_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const NOTE_ID = "67a000000000000000000001";
const note = {
  _id: NOTE_ID,
  title: "Call with Acme",
  content: "They want SSO before renewal. Budget approved for Q3.",
  relationships: [{ objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company", data: { company_name: "Acme Corp" } }],
  metadata: { created: { at: "2026-03-01T00:00:00.000Z" }, updated: { at: "2026-03-02T00:00:00.000Z" } },
};

describe("heliyos_notes_list", () => {
  it("lists notes for a record with search, passing filters and paging", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/notes`, ({ request }) => {
        url = new URL(request.url);
        return ok([note], { pagination: { limit: 5, next_cursor: "n2" } });
      })
    );
    const result = await call("heliyos_notes_list", { record_id: RECORD_IDS.acme, search: "SSO", limit: 5 });
    const text = expectOk(result);
    expect(JSON.parse(url!.searchParams.get("filters")!)).toEqual({ search: "SSO", relatedObjectId: RECORD_IDS.acme });
    expect(url!.searchParams.get("limit")).toBe("5");
    expect(text).toContain(NOTE_ID);
    expect(text).toContain("Call with Acme");
    const sc = result.structuredContent as Structured;
    expect(sc.notes[0]).toMatchObject({ id: NOTE_ID, title: "Call with Acme" });
    expect(sc.next_cursor).toBe("n2");
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/notes`, () => apiError(429, "RATE_LIMITED", "Too many requests")));
    expectToolError(await call("heliyos_notes_list"), "RATE_LIMITED");
  });
});

describe("heliyos_notes_get", () => {
  it("returns the note content and linked records", async () => {
    api.use(http.get(`${P}/notes/${NOTE_ID}`, () => ok(note)));
    const result = await call("heliyos_notes_get", { note_id: NOTE_ID, response_format: "detailed" });
    const text = expectOk(result);
    expect(text).toContain("They want SSO before renewal.");
    expect(text).toContain(RECORD_IDS.acme);
    const sc = result.structuredContent as Structured;
    expect(sc.note.links[0]).toMatchObject({ id: RECORD_IDS.acme, object_type: "company", name: "Acme Corp" });
    expect(sc.note.created_at).toBe("2026-03-01T00:00:00.000Z");
  });

  it("returns NOT_FOUND for a missing note", async () => {
    api.use(http.get(`${P}/notes/${NOTE_ID}`, () => apiError(404, "NOT_FOUND", "Note not found")));
    expectToolError(await call("heliyos_notes_get", { note_id: NOTE_ID }), "NOT_FOUND");
  });
});

describe("heliyos_notes_create", () => {
  it("links the note to records with their object type and schema", async () => {
    let body: any;
    api.use(
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)),
      http.post(`${P}/notes`, async ({ request }) => {
        body = await request.json();
        return ok({ ...note, _id: NOTE_ID });
      })
    );
    const result = await call("heliyos_notes_create", { title: "Call with Acme", content: "SSO", record_ids: [RECORD_IDS.acme] });
    const text = expectOk(result);
    expect(body).toEqual({
      title: "Call with Acme",
      content: "SSO",
      relationships: [{ objectId: RECORD_IDS.acme, schemaId: SCHEMA_IDS.company, objectType: "company" }],
    });
    expect(text).toContain(NOTE_ID);
    expect((result.structuredContent as Structured).note.id).toBe(NOTE_ID);
  });

  it("fails with NOT_FOUND naming the unknown record id and creates nothing", async () => {
    api.use(http.get(`${P}/records/${RECORD_IDS.globex}`, () => apiError(404, "NOT_FOUND", "Record not found")));
    const text = expectToolError(
      await call("heliyos_notes_create", { title: "x", record_ids: [RECORD_IDS.globex] }),
      "NOT_FOUND"
    );
    expect(text).toContain(RECORD_IDS.globex);
  });
});

describe("heliyos_notes_update", () => {
  it("patches only the given fields", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/notes/${NOTE_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...note, title: "Renamed" });
      })
    );
    const result = await call("heliyos_notes_update", { note_id: NOTE_ID, title: "Renamed" });
    expect(expectOk(result)).toContain("Renamed");
    expect(body).toEqual({ title: "Renamed" });
  });

  it("rejects an update with nothing to change", async () => {
    expect((await call("heliyos_notes_update", { note_id: NOTE_ID })).isError).toBe(true);
    expect((await call("heliyos_notes_update", { note_id: NOTE_ID, title: "  " })).isError).toBe(true);
  });
});

describe("heliyos_notes_delete", () => {
  it("deletes the note (204 No Content)", async () => {
    api.use(http.delete(`${P}/notes/${NOTE_ID}`, () => new HttpResponse(null, { status: 204 })));
    const result = await call("heliyos_notes_delete", { note_id: NOTE_ID });
    expect(expectOk(result)).toContain(NOTE_ID);
    expect((result.structuredContent as Structured).deleted).toBe(true);
  });

  it("returns NOT_FOUND for a missing note", async () => {
    api.use(http.delete(`${P}/notes/${NOTE_ID}`, () => apiError(404, "NOT_FOUND", "Note not found")));
    expectToolError(await call("heliyos_notes_delete", { note_id: NOTE_ID }), "NOT_FOUND");
  });
});
