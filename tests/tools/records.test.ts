/**
 * The heliyos_records_create, heliyos_records_delete, heliyos_records_enrich, heliyos_records_get, heliyos_records_list, heliyos_records_lookup, heliyos_records_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../../src/client/http.js";
import { listToolSpecs } from "../../src/index.js";
import { closeAll, connect, textOf } from "../helpers/mcp.js";
import {
  acme,
  apiError,
  BASE,
  baseSchemasHandler,
  globex,
  jane,
  KEY,
  ok,
  P,
  RECORD_IDS,
  SCHEMA_IDS,
  schemas,
} from "../helpers/platform.js";

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  api.resetHandlers();
  await closeAll();
});
afterAll(() => api.close());

const heliyos = () => createClient({ baseUrl: BASE, apiKey: KEY, sleep: async () => {} });
const call = async (name: string, args: Record<string, unknown>) => {
  const client = await connect(heliyos());
  return client.callTool({ name, arguments: args });
};
type Structured = Record<string, any>;

describe("heliyos_records_list", () => {
  it("rejects limit 1000 with an isError result that names the limit field", async () => {
    // No handlers: any HTTP call would fail the test (onUnhandledRequest: error).
    const result = await call("heliyos_records_list", { object_type: "company", limit: 1000 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/limit/);
  });

  it("returns a text table and structuredContent records with ids and next_cursor", async () => {
    let url: URL | undefined;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, ({ request }) => {
        url = new URL(request.url);
        return ok([acme, globex], { pagination: { limit: 20, next_cursor: "cur_next" } });
      })
    );

    const result = await call("heliyos_records_list", { object_type: "company" });

    expect(result.isError).toBeFalsy();
    expect(url?.searchParams.get("limit")).toBe("20");
    expect(url?.searchParams.has("filters")).toBe(false);
    const text = textOf(result);
    expect(text).toContain("Acme Corp");
    expect(text).toContain(RECORD_IDS.acme);
    expect(text).toContain("Globex");
    expect(text).toContain("cur_next");
    const sc = result.structuredContent as Structured;
    expect(sc.records[0].id).toBe(RECORD_IDS.acme);
    expect(sc.records[0].object_type).toBe("company");
    expect(sc.records[0].name).toBe("Acme Corp");
    expect(sc.next_cursor).toBe("cur_next");
    // Concise keeps the schema's key fields only.
    expect(sc.records[0].fields.domain).toBe("acme.com");
    expect(sc.records[0].fields).not.toHaveProperty("linkedin_url");
  });

  it("response_format detailed includes every field", async () => {
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () => ok([acme], { pagination: { limit: 20 } }))
    );

    const result = await call("heliyos_records_list", { object_type: "company", response_format: "detailed" });

    const sc = result.structuredContent as Structured;
    expect(sc.records[0].fields).toEqual(acme.data);
    expect(sc).not.toHaveProperty("next_cursor");
    expect(textOf(result)).toContain("linkedin_url");
    expect(textOf(result)).toContain("Makes anvils and rockets.");
  });

  it("passes search, filters, limit and cursor through to the API", async () => {
    let url: URL | undefined;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.deal}/records`, ({ request }) => {
        url = new URL(request.url);
        return ok([], { pagination: { limit: 5 } });
      })
    );

    const result = await call("heliyos_records_list", {
      object_type: "deal",
      search: "renewal",
      filters: [{ field: "stage", operator: "equals", value: "Won" }],
      limit: 5,
      cursor: "cur_1",
    });

    expect(result.isError).toBeFalsy();
    expect(url?.searchParams.get("limit")).toBe("5");
    expect(url?.searchParams.get("cursor")).toBe("cur_1");
    expect(JSON.parse(url?.searchParams.get("filters") ?? "{}")).toEqual({
      search: "renewal",
      filters: [{ field: "stage", operator: "equals", value: "Won", conjunction: "and" }],
    });
    expect(textOf(result)).toMatch(/No deal records/);
  });

  it("maps person to the people schema and caches base schemas per server", async () => {
    const counter = { calls: 0 };
    let hits = 0;
    api.use(
      baseSchemasHandler(counter),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.person}/records`, () => {
        hits += 1;
        return ok([], { pagination: { limit: 20 } });
      })
    );
    const client = await connect(heliyos());

    await client.callTool({ name: "heliyos_records_list", arguments: { object_type: "person" } });
    await client.callTool({ name: "heliyos_records_list", arguments: { object_type: "person" } });

    expect(hits).toBe(2);
    expect(counter.calls).toBe(1);
  });

  it("requires schema_id for custom objects and lists the available ones", async () => {
    api.use(baseSchemasHandler());

    const result = await call("heliyos_records_list", { object_type: "custom" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("VALIDATION_FAILED");
    expect(text).toContain("schema_id");
    expect(text).toContain("Partners");
    expect(text).toContain(SCHEMA_IDS.partner);
  });

  it("lists a custom object by schema_id", async () => {
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.partner}/records`, () =>
        ok([{ _id: "65b0000000000000000000aa", objectType: "partners", data: { name: "Initech", tier: "Gold" } }], {
          pagination: { limit: 20 },
        })
      )
    );

    const result = await call("heliyos_records_list", { object_type: "custom", schema_id: SCHEMA_IDS.partner });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Structured;
    expect(sc.records[0]).toMatchObject({ id: "65b0000000000000000000aa", object_type: "custom", name: "Initech" });
  });

  it("keeps detailed text under 20k, says which records it omits, and keeps next_cursor", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...acme,
      _id: `65b0000000000000000${String(i).padStart(5, "0")}`,
      data: { ...acme.data, description: "x".repeat(2_000) },
    }));
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () =>
        ok(many, { pagination: { limit: 100, next_cursor: "cur_more" } })
      )
    );

    const result = await call("heliyos_records_list", { object_type: "company", limit: 100, response_format: "detailed" });

    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(20_000);
    const shown = Number(/Text shows (\d+) of the 100 records on this page/.exec(text)?.[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(text).toContain("all 100 are in structuredContent.records");
    expect(text).toContain(many[99]!._id); // omitted ids are named
    expect(text).toContain('cursor "cur_more"');
    expect((result.structuredContent as Structured).records).toHaveLength(100);
    expect((result.structuredContent as Structured).next_cursor).toBe("cur_more");
  });

  it("fits a concise page of 100 long rows in the text without dropping any row", async () => {
    const long = (i: number) => ({
      ...acme,
      _id: `65b0000000000000000${String(i).padStart(5, "0")}`,
      data: {
        company_name: `Company ${i} ${"n".repeat(80)}`,
        domain: "d".repeat(80),
        industry: "i".repeat(80),
        employee_count: "e".repeat(80),
      },
    });
    const many = Array.from({ length: 100 }, (_, i) => long(i));
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () =>
        ok(many, { pagination: { limit: 100, next_cursor: "cur_more" } })
      )
    );

    const result = await call("heliyos_records_list", { object_type: "company", limit: 100 });

    const text = textOf(result);
    expect(text.length).toBeLessThanOrEqual(20_000);
    for (const record of many) expect(text).toContain(record._id);
    expect(text).not.toContain("truncated");
    expect(text).toContain('cursor "cur_more"');
  });

  it("maps match \"any\" onto every condition's conjunction", async () => {
    let url: URL | undefined;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.deal}/records`, ({ request }) => {
        url = new URL(request.url);
        return ok([], { pagination: { limit: 20 } });
      })
    );

    await call("heliyos_records_list", {
      object_type: "deal",
      match: "any",
      filters: [
        { field: "stage", operator: "equals", value: "Won" },
        { field: "amount", operator: "greaterThan", value: 1000 },
      ],
    });

    const sent = JSON.parse(url?.searchParams.get("filters") ?? "{}");
    expect(sent.filters.map((f: { conjunction: string }) => f.conjunction)).toEqual(["or", "or"]);
  });

  it("rejects per-condition conjunctions (use match instead)", async () => {
    const result = await call("heliyos_records_list", {
      object_type: "deal",
      filters: [{ field: "stage", operator: "equals", value: "Won", conjunction: "or" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/conjunction/);
  });

  it.each([
    [{ field: "employee_count", operator: "contains", value: 50 }, "needs a non-empty text value"],
    [{ field: "domain", operator: "startsWith" }, "needs a non-empty text value"],
    [{ field: "stage", operator: "empty", value: "x" }, "takes no value"],
    [{ field: "stage", operator: "equals" }, "needs a value"],
  ])("rejects filter %o before calling the API", async (filter, message) => {
    // No handlers: an HTTP call would fail the test.
    const result = await call("heliyos_records_list", { object_type: "company", filters: [filter] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^VALIDATION_FAILED: Invalid filters: filters\[0\]/);
    expect(textOf(result)).toContain(message);
    expect(textOf(result)).toContain("Fix the input and retry.");
  });

  it("rejects a schema_id that belongs to another object type", async () => {
    api.use(baseSchemasHandler());
    const result = await call("heliyos_records_list", { object_type: "company", schema_id: SCHEMA_IDS.deal });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is the Deals object (object_type deal), not company");
  });

  it("re-reads the schema list once for an unknown schema_id, and not again for the same miss", async () => {
    const counter = { calls: 0 };
    api.use(
      baseSchemasHandler(counter),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.partner}/records`, () => ok([], { pagination: { limit: 20 } }))
    );
    const client = await connect(heliyos());
    const unknown = "64a0000000000000000000ff";

    await client.callTool({ name: "heliyos_records_list", arguments: { object_type: "custom", schema_id: SCHEMA_IDS.partner } });
    const first = await client.callTool({ name: "heliyos_records_list", arguments: { object_type: "custom", schema_id: unknown } });
    const second = await client.callTool({ name: "heliyos_records_list", arguments: { object_type: "custom", schema_id: unknown } });

    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain(`No object schema has schema_id ${unknown}`);
    expect(second.isError).toBe(true);
    // 1 initial load + 1 refresh on the first miss; the repeated miss is served from the negative cache.
    expect(counter.calls).toBe(2);
  });
});

describe("heliyos_records_get", () => {
  it("returns NOT_FOUND with a hint when the record does not exist", async () => {
    api.use(http.get(`${P}/records/${RECORD_IDS.acme}`, () => apiError(404, "NOT_FOUND", "Object not found")));

    const result = await call("heliyos_records_get", { record_id: RECORD_IDS.acme });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("NOT_FOUND");
    expect(text).toContain("Object not found");
    expect(text).toContain("Check the id, or list the resource to find it.");
    expect(text).not.toContain(KEY);
  });

  it("rejects a malformed record_id before calling the API", async () => {
    const result = await call("heliyos_records_get", { record_id: "not-an-id" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/record_id/);
  });

  it("returns key fields in concise and every field in detailed", async () => {
    api.use(baseSchemasHandler(), http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)));
    const client = await connect(heliyos());

    const concise = await client.callTool({ name: "heliyos_records_get", arguments: { record_id: RECORD_IDS.acme } });
    const detailed = await client.callTool({
      name: "heliyos_records_get",
      arguments: { record_id: RECORD_IDS.acme, response_format: "detailed" },
    });

    const c = (concise.structuredContent as Structured).record;
    expect(c).toMatchObject({ id: RECORD_IDS.acme, object_type: "company", name: "Acme Corp", schema_id: SCHEMA_IDS.company });
    expect(c.fields).not.toHaveProperty("linkedin_url");
    expect(textOf(concise)).toContain("Acme Corp");

    const d = (detailed.structuredContent as Structured).record;
    expect(d.fields).toEqual(acme.data);
    expect(d.created_at).toBe("2026-01-02T03:04:05.000Z");
    expect(textOf(detailed)).toContain("linkedin_url: https://www.linkedin.com/company/acme");
    expect(c.relationship_count).toBe(1);
    expect(c).not.toHaveProperty("relationships");
    expect(textOf(concise)).toContain("Linked records: 1");
    expect(d.relationships).toEqual([
      { id: "65b0000000000000000000a1", object_type: "person", schema_id: SCHEMA_IDS.person, name: "Jane Doe" },
    ]);
    expect(textOf(detailed)).toContain('- person "Jane Doe" (id 65b0000000000000000000a1)');
    // Concise follows the schema's field order: name first, then sequence.
    expect(Object.keys(c.fields)).toEqual(["company_name", "domain", "industry", "employee_count", "description"]);
  });

  it("still returns the record when the base schema list fails", async () => {
    api.use(
      http.get(`${P}/base-schemas`, () => apiError(500, "INTERNAL", "boom")),
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme))
    );

    const result = await call("heliyos_records_get", { record_id: RECORD_IDS.acme });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Structured).record).toMatchObject({ id: RECORD_IDS.acme, name: "Acme Corp" });
  });
});

describe("heliyos_records_create", () => {
  it("posts the fields to the schema and returns the new id", async () => {
    let body: unknown;
    api.use(
      baseSchemasHandler(),
      http.post(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ meta: { message: "Object created successfully" }, data: acme }, { status: 201 });
      })
    );

    const result = await call("heliyos_records_create", {
      object_type: "company",
      fields: { company_name: "Acme Corp", domain: "acme.com" },
    });

    expect(result.isError).toBeFalsy();
    expect(body).toEqual({ company_name: "Acme Corp", domain: "acme.com" });
    expect(textOf(result)).toContain(RECORD_IDS.acme);
    expect((result.structuredContent as Structured).record.id).toBe(RECORD_IDS.acme);
  });

  it("rejects unknown field keys after re-reading the schema once", async () => {
    const counter = { calls: 0 };
    let created = false;
    api.use(
      baseSchemasHandler(counter),
      http.post(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () => {
        created = true;
        return ok(acme);
      })
    );

    const result = await call("heliyos_records_create", {
      object_type: "company",
      fields: { company_name: "Acme", websit: "acme.com" },
    });

    expect(result.isError).toBe(true);
    expect(created).toBe(false);
    expect(textOf(result)).toContain("Unknown field key for the Companies object: websit");
    expect(textOf(result)).toContain("Valid field keys: company_name, domain");
    expect(counter.calls).toBe(2);
  });

  it("accepts a field added after the schema list was cached", async () => {
    let calls = 0;
    api.use(
      http.get(`${P}/base-schemas`, () => {
        calls += 1;
        const extra = calls > 1 ? [{ id: "fnew", name: "website", sequence: 9, type: { type: "text" } }] : [];
        return ok(schemas.map((s) => (s.id === SCHEMA_IDS.company ? { ...s, fields: [...s.fields, ...extra] } : s)));
      }),
      http.post(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () => ok(acme))
    );

    const result = await call("heliyos_records_create", { object_type: "company", fields: { website: "acme.com" } });

    expect(result.isError).toBeFalsy();
    expect(calls).toBe(2);
  });

  it("surfaces server validation details and how to fix them", async () => {
    api.use(
      baseSchemasHandler(),
      http.post(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, () =>
        apiError(400, "VALIDATION_FAILED", "Validation error", [{ path: "domain", message: "must be a valid domain" }])
      )
    );

    const result = await call("heliyos_records_create", { object_type: "company", fields: { domain: "nope" } });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("VALIDATION_FAILED");
    expect(text).toContain("domain: must be a valid domain");
    expect(text).toContain("Fix the input and retry.");
  });
});

describe("heliyos_records_update", () => {
  it("patches {data: fields} and returns the updated summary", async () => {
    let body: unknown;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)),
      http.patch(`${P}/records/${RECORD_IDS.acme}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...acme, data: { ...acme.data, industry: "Aerospace" } });
      })
    );

    const result = await call("heliyos_records_update", { record_id: RECORD_IDS.acme, fields: { industry: "Aerospace" } });

    expect(result.isError).toBeFalsy();
    expect(body).toEqual({ data: { industry: "Aerospace" } });
    expect(textOf(result)).toContain("industry");
    expect((result.structuredContent as Structured).record.fields.industry).toBe("Aerospace");
  });

  it("rejects unknown field keys before writing, listing the valid ones", async () => {
    let patched = false;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)),
      http.patch(`${P}/records/${RECORD_IDS.acme}`, () => {
        patched = true;
        return ok(acme);
      })
    );

    const result = await call("heliyos_records_update", { record_id: RECORD_IDS.acme, fields: { industy: "Aerospace" } });

    expect(result.isError).toBe(true);
    expect(patched).toBe(false);
    const text = textOf(result);
    expect(text).toContain("VALIDATION_FAILED: Unknown field key for the Companies object: industy");
    expect(text).toContain("Valid field keys: company_name, domain, industry, employee_count, description");
  });

  it("does not echo a sent value the API did not return", async () => {
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)),
      http.patch(`${P}/records/${RECORD_IDS.acme}`, () => ok({ ...acme, data: { company_name: "Acme Corp" } }))
    );

    const result = await call("heliyos_records_update", { record_id: RECORD_IDS.acme, fields: { industry: "Aerospace" } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("industry: (not returned by the API");
    expect((result.structuredContent as Structured).record.fields).not.toHaveProperty("industry");
  });
});

describe("heliyos_records_delete", () => {
  it("is annotated destructive and idempotent", async () => {
    const client = await connect(heliyos());
    const { tools } = await client.listTools();
    const del = tools.find((t) => t.name === "heliyos_records_delete");
    expect(del?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("bulk-deletes the ids on the object's schema and returns the count", async () => {
    let body: unknown;
    api.use(
      baseSchemasHandler(),
      http.post(`${P}/base-schemas/${SCHEMA_IDS.company}/records/bulk-delete`, async ({ request }) => {
        body = await request.json();
        return ok(null);
      })
    );

    const result = await call("heliyos_records_delete", {
      object_type: "company",
      record_ids: [RECORD_IDS.acme, RECORD_IDS.globex, RECORD_IDS.acme],
    });

    expect(result.isError).toBeFalsy();
    expect(body).toEqual({ objectIds: [RECORD_IDS.acme, RECORD_IDS.globex] });
    expect((result.structuredContent as Structured).deleted_count).toBe(2);
    expect(textOf(result)).toContain("Sent 2 ids for deletion from company records; the API does not confirm the count.");
  });

  it("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `65b0000000000000000${String(i).padStart(5, "0")}`);
    const result = await call("heliyos_records_delete", { object_type: "company", record_ids: ids });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/record_ids/);
  });
});

describe("heliyos_records_lookup", () => {
  it("matches names case-insensitively and returns ids", async () => {
    let url: URL | undefined;
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records/lookup`, ({ request }) => {
        url = new URL(request.url);
        return ok([
          { id: RECORD_IDS.globex, name: "Globex", secondary: "globex.example", updatedAt: "2026-01-06T00:00:00.000Z" },
          { id: RECORD_IDS.acme, name: "Acme Corp", secondary: "acme.com", updatedAt: "2026-02-03T04:05:06.000Z" },
          { id: "65b000000000000000000003", name: "Not Acme Holdings", secondary: "nah.example" },
        ]);
      })
    );

    const result = await call("heliyos_records_lookup", { object_type: "company", query: "acme" });

    expect(result.isError).toBeFalsy();
    expect(url?.searchParams.get("limit")).toBe("2000");
    const sc = result.structuredContent as Structured;
    expect(sc.matches.map((m: { id: string }) => m.id)).toEqual([RECORD_IDS.acme, "65b000000000000000000003"]);
    expect(textOf(result)).toContain(RECORD_IDS.acme);
  });
});

describe("heliyos_records_update on a missing record", () => {
  it("returns NOT_FOUND and never sends the PATCH", async () => {
    // Only the GET is mocked: a PATCH would be an unhandled request and fail the test.
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/records/${RECORD_IDS.acme}`, () => apiError(404, "NOT_FOUND", "Record not found"))
    );
    const result = await call("heliyos_records_update", { record_id: RECORD_IDS.acme, fields: { domain: "x.com" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^NOT_FOUND: /);
  });
});

describe("heliyos_records_enrich (experimental)", () => {
  const callExperimental = async (args: Record<string, unknown>) => {
    const client = await connect(heliyos(), { experimental: true });
    return client.callTool({ name: "heliyos_records_enrich", arguments: args });
  };

  it("is only registered with experimental on, right after the records tools", async () => {
    expect(listToolSpecs().map((s) => s.name)).not.toContain("heliyos_records_enrich");
    expect(listToolSpecs({ experimental: true }).map((s) => s.name)[6]).toBe("heliyos_records_enrich");
  });

  it("enriches a person and returns the updated record", async () => {
    let posted = false;
    api.use(
      baseSchemasHandler(),
      http.post(`${P}/records/${jane._id}/enrichments`, () => {
        posted = true;
        return ok({ ...jane, data: { ...jane.data, linkedin: "https://linkedin.com/in/jane" } });
      })
    );
    const result = await callExperimental({ record_id: jane._id });
    expect(result.isError).toBeFalsy();
    expect(posted).toBe(true);
    expect(textOf(result)).toContain("Jane Doe");
    expect((result.structuredContent as Structured).record.id).toBe(jane._id);
  });

  it("explains a credits refusal", async () => {
    api.use(
      http.post(`${P}/records/${jane._id}/enrichments`, () =>
        apiError(403, "FORBIDDEN_ACTION", "Insufficient credits for person enrichment")
      )
    );
    const result = await callExperimental({ record_id: jane._id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Insufficient credits");
  });
});

describe("heliyos_records_list sort", () => {
  it("sends the sort in the filters object and pages by page number with a page cursor", async () => {
    const urls: URL[] = [];
    api.use(
      baseSchemasHandler(),
      http.get(`${P}/base-schemas/${SCHEMA_IDS.company}/records`, ({ request }) => {
        urls.push(new URL(request.url));
        return ok([acme, globex], { pagination: { page: 1, limit: 2, count: 5, hasMore: true } });
      })
    );
    const first = await call("heliyos_records_list", { object_type: "company", sort: { field: "domain", direction: "asc" }, limit: 2 });
    expect(first.isError).toBeFalsy();
    expect(urls[0]!.searchParams.get("page")).toBe("1");
    expect(urls[0]!.searchParams.has("cursor")).toBe(false);
    expect(JSON.parse(urls[0]!.searchParams.get("filters")!)).toEqual({ sort: [{ field: "domain", direction: "asc" }] });
    const next = (first.structuredContent as Structured).next_cursor;
    expect(next).toBe("page:2:2");

    const second = await call("heliyos_records_list", { object_type: "company", sort: { field: "updatedAt" }, limit: 2, cursor: next });
    expect(second.isError).toBeFalsy();
    expect(urls[1]!.searchParams.get("page")).toBe("2");
    expect(JSON.parse(urls[1]!.searchParams.get("filters")!)).toEqual({ sort: [{ field: "updatedAt", direction: "desc" }] });
  });

  it("rejects a sort field the object does not have, and a keyset cursor with a sort", async () => {
    api.use(baseSchemasHandler());
    const unknown = await call("heliyos_records_list", { object_type: "company", sort: { field: "revenue" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("revenue");
    const badCursor = await call("heliyos_records_list", { object_type: "company", sort: { field: "domain" }, cursor: "cur_next" });
    expect(badCursor.isError).toBe(true);
    expect(textOf(badCursor)).toMatch(/not issued by this tool/);
  });
});
