/**
 * The heliyos_objects_create, heliyos_objects_delete, heliyos_objects_get, heliyos_objects_list, heliyos_objects_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { listToolSpecs } from "../../src/index.js";
import { textOf } from "../helpers/mcp.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, baseSchemasHandler, ok, P, SCHEMA_IDS, schemas } from "../helpers/platform.js";

const { api, call } = useMockApi();
const EXPERIMENTAL = { experimental: true };

const companySchemaFull = {
  _id: SCHEMA_IDS.company,
  name: "Companies",
  slug: "company",
  objectType: "company",
  type: "base",
  description: "Accounts you sell to",
  fields: [
    { id: "f1", name: "company_name", displayName: "Company name", sequence: 1, isRequired: true, type: { type: "text" } },
    { id: "f2", name: "domain", displayName: "Domain", sequence: 2, type: { type: "url" } },
    {
      id: "f3",
      name: "stage",
      displayName: "Stage",
      sequence: 3,
      type: { type: "select" },
      settings: { selectOptions: [{ value: "Lead", color: "x" }, { value: "Customer", color: "y" }] },
    },
    { id: "f4", name: "owner", displayName: "Owner", sequence: 4, isHiddenField: true, type: { type: "user" } },
  ],
};

describe("heliyos_objects_list", () => {
  it("lists every object with its schema_id, type and record count", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/base-schemas`, ({ request }) => {
        url = new URL(request.url);
        return ok(schemas.map((s, i) => ({ ...s, recordCount: 10 + i })));
      })
    );

    const result = await call("heliyos_objects_list");

    const text = expectOk(result);
    expect(url?.searchParams.get("isRecordCount")).toBe("true");
    for (const s of schemas) expect(text).toContain(s.id);
    expect(text).toContain("Partners");
    const sc = result.structuredContent as Structured;
    expect(sc.objects).toHaveLength(4);
    expect(sc.objects[0]).toMatchObject({ schema_id: SCHEMA_IDS.company, name: "Companies", object_type: "company", record_count: 10, field_count: 5 });
    expect(sc.objects[1].object_type).toBe("person");
    expect(sc.objects[3]).toMatchObject({ object_type: "custom", kind: "custom" });
    // Concise does not list field keys.
    expect(sc.objects[0]).not.toHaveProperty("fields");
  });

  it("lists field keys per object in detailed", async () => {
    api.use(http.get(`${P}/base-schemas`, () => ok(schemas)));
    const result = await call("heliyos_objects_list", { response_format: "detailed" });
    expect(textOf(result)).toContain("employee_count");
    expect((result.structuredContent as Structured).objects[0].fields).toContain("domain");
  });

  it("returns UNAUTHENTICATED with the key hint", async () => {
    api.use(http.get(`${P}/base-schemas`, () => apiError(401, "UNAUTHENTICATED", "Invalid API key")));
    expect(expectToolError(await call("heliyos_objects_list"), "UNAUTHENTICATED")).toContain("HELIYOS_API_KEY");
  });
});

describe("heliyos_objects_get", () => {
  it("returns the object's field keys and types for planning record calls", async () => {
    api.use(baseSchemasHandler(), http.get(`${P}/base-schemas/${SCHEMA_IDS.company}`, () => ok(companySchemaFull)));

    const result = await call("heliyos_objects_get", { object_type: "company" });

    const text = expectOk(result);
    expect(text).toContain(SCHEMA_IDS.company);
    expect(text).toMatch(/company_name\s+text/);
    expect(text).toMatch(/stage\s+select/);
    const sc = result.structuredContent as Structured;
    expect(sc.object).toMatchObject({ schema_id: SCHEMA_IDS.company, object_type: "company", name: "Companies" });
    expect(sc.object.fields.map((f: Structured) => f.key)).toEqual(["company_name", "domain", "stage", "owner"]);
    expect(sc.object.fields[0]).toMatchObject({ key: "company_name", type: "text", required: true });
    // Options only in detailed.
    expect(sc.object.fields[2]).not.toHaveProperty("options");
  });

  it("lists select options and hidden flags in detailed", async () => {
    api.use(baseSchemasHandler(), http.get(`${P}/base-schemas/${SCHEMA_IDS.company}`, () => ok(companySchemaFull)));
    const result = await call("heliyos_objects_get", { object_type: "company", response_format: "detailed" });
    const sc = result.structuredContent as Structured;
    expect(sc.object.fields[2].options).toEqual(["Lead", "Customer"]);
    expect(sc.object.fields[3].hidden).toBe(true);
    expect(textOf(result)).toContain("Customer");
  });

  it("asks for schema_id on custom objects, listing them, without fetching a schema", async () => {
    api.use(baseSchemasHandler());
    const text = expectToolError(await call("heliyos_objects_get", { object_type: "custom" }), "VALIDATION_FAILED");
    expect(text).toContain(SCHEMA_IDS.partner);
  });
});

describe("experimental object tools", () => {
  it("are not registered unless experimental is on", async () => {
    const off = listToolSpecs().map((s) => s.name);
    const on = listToolSpecs({ experimental: true }).map((s) => s.name);
    for (const name of ["heliyos_objects_create", "heliyos_objects_update", "heliyos_objects_delete"]) {
      expect(off).not.toContain(name);
      expect(on).toContain(name);
    }
    // Experimental object tools follow objects_get.
    expect(on.slice(on.indexOf("heliyos_objects_get") + 1, on.indexOf("heliyos_objects_get") + 4)).toEqual([
      "heliyos_objects_create",
      "heliyos_objects_update",
      "heliyos_objects_delete",
    ]);
  });

  it("heliyos_objects_create posts a custom object and returns its schema_id", async () => {
    let body: any;
    api.use(
      http.post(`${P}/base-schemas`, async ({ request }) => {
        body = await request.json();
        return ok({ _id: "64a0000000000000000000ff", name: "Investors", objectType: "investors", type: "custom", fields: [{ name: "investors" }] });
      })
    );

    const result = await call("heliyos_objects_create", { name: "Investors", description: "Funds" }, EXPERIMENTAL);

    const text = expectOk(result);
    expect(body).toEqual({ name: "Investors", slug: "investors", icon: "PiFile02AiStroke", type: "custom", description: "Funds" });
    expect(text).toContain("64a0000000000000000000ff");
    expect((result.structuredContent as Structured).object.schema_id).toBe("64a0000000000000000000ff");
  });

  it("heliyos_objects_create surfaces a server validation error", async () => {
    api.use(http.post(`${P}/base-schemas`, () => apiError(400, "VALIDATION_FAILED", "slug is not allowed to be empty")));
    expectToolError(await call("heliyos_objects_create", { name: "X" }, EXPERIMENTAL), "VALIDATION_FAILED");
  });

  it("heliyos_objects_update patches only the given keys", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/base-schemas/${SCHEMA_IDS.partner}`, async ({ request }) => {
        body = await request.json();
        return ok({ _id: SCHEMA_IDS.partner, name: "Resellers", objectType: "partners", type: "custom" });
      })
    );
    const result = await call("heliyos_objects_update", { schema_id: SCHEMA_IDS.partner, name: "Resellers" }, EXPERIMENTAL);
    expect(expectOk(result)).toContain("Resellers");
    expect(body).toEqual({ name: "Resellers" });
  });

  it("heliyos_objects_update rejects an empty change and a missing schema", async () => {
    expect((await call("heliyos_objects_update", { schema_id: SCHEMA_IDS.partner }, EXPERIMENTAL)).isError).toBe(true);
    api.use(http.patch(`${P}/base-schemas/${SCHEMA_IDS.partner}`, () => apiError(404, "NOT_FOUND", "Schema not found")));
    expectToolError(await call("heliyos_objects_update", { schema_id: SCHEMA_IDS.partner, name: "Y" }, EXPERIMENTAL), "NOT_FOUND");
  });

  const partnerSchema = { _id: SCHEMA_IDS.partner, name: "Partners", objectType: "partners", type: "custom", fields: [] };

  it("heliyos_objects_delete deletes a custom object after reading it", async () => {
    let deleted = false;
    api.use(
      http.get(`${P}/base-schemas/${SCHEMA_IDS.partner}`, () => ok(partnerSchema)),
      http.delete(`${P}/base-schemas/${SCHEMA_IDS.partner}`, () => {
        deleted = true;
        return ok(null);
      })
    );
    const result = await call("heliyos_objects_delete", { schema_id: SCHEMA_IDS.partner }, EXPERIMENTAL);
    expect(expectOk(result)).toContain("Partners");
    expect(deleted).toBe(true);
  });

  it("heliyos_objects_delete refuses a built-in object without sending a DELETE", async () => {
    api.use(http.get(`${P}/base-schemas/${SCHEMA_IDS.company}`, () => ok(companySchemaFull)));
    const text = expectToolError(await call("heliyos_objects_delete", { schema_id: SCHEMA_IDS.company }, EXPERIMENTAL), "FORBIDDEN_ACTION");
    expect(text).toContain("built-in");
  });

  it("heliyos_objects_delete fails closed: no DELETE when the object cannot be read", async () => {
    // Only the GET is mocked: a DELETE would be an unhandled request and fail the test.
    api.use(http.get(`${P}/base-schemas/${SCHEMA_IDS.partner}`, () => apiError(500, "INTERNAL", "boom")));
    expectToolError(await call("heliyos_objects_delete", { schema_id: SCHEMA_IDS.partner }, EXPERIMENTAL), "INTERNAL");
    api.use(http.get(`${P}/base-schemas/${SCHEMA_IDS.partner}`, () => ok({ _id: SCHEMA_IDS.partner, name: "Odd", objectType: "odd" })));
    expectToolError(await call("heliyos_objects_delete", { schema_id: SCHEMA_IDS.partner }, EXPERIMENTAL), "FORBIDDEN_ACTION");
  });

  it("heliyos_objects_delete passes NOT_FOUND through without deleting", async () => {
    api.use(http.get(`${P}/base-schemas/${SCHEMA_IDS.partner}`, () => apiError(404, "NOT_FOUND", "Schema not found")));
    expectToolError(await call("heliyos_objects_delete", { schema_id: SCHEMA_IDS.partner }, EXPERIMENTAL), "NOT_FOUND");
  });

  it("heliyos_objects_create sends a clean slug and rejects a name without letters or digits", async () => {
    let body: any;
    api.use(
      http.post(`${P}/base-schemas`, async ({ request }) => {
        body = await request.json();
        return ok({ _id: "64a0000000000000000000fe", name: "R&D Partners!" });
      })
    );
    await call("heliyos_objects_create", { name: "R&D Partners!" }, EXPERIMENTAL);
    expect(body.slug).toBe("r-d-partners");
    expectToolError(await call("heliyos_objects_create", { name: "!!!" }, EXPERIMENTAL), "VALIDATION_FAILED");
  });

  it("heliyos_objects_delete is annotated destructive", async () => {
    const spec = listToolSpecs(EXPERIMENTAL).find((s) => s.name === "heliyos_objects_delete")!;
    expect(spec.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });
});

