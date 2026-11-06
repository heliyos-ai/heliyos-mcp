/**
 * The heliyos_fields_create, heliyos_fields_delete, heliyos_fields_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { keyOf } from "../../src/tools/fields.js";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, baseSchemasHandler, ok, P, SCHEMA_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();
const S = SCHEMA_IDS.company;
const FIELD_ID = "6bb000000000000000000003";

const companySchema = {
  _id: S,
  name: "Companies",
  objectType: "company",
  type: "base",
  fields: [
    { id: "6bb000000000000000000001", name: "company_name", displayName: "Company name", sequence: 1, type: { type: "text" } },
    { id: "6bb000000000000000000002", name: "domain", displayName: "Domain", sequence: 4, type: { type: "url" } },
    {
      id: FIELD_ID,
      name: "stage",
      displayName: "Stage",
      sequence: 2,
      type: { type: "select" },
      settings: { selectOptions: [{ value: "Lead", color: "x" }, "Customer"] },
    },
  ],
};

const useSchemas = () => api.use(baseSchemasHandler(), http.get(`${P}/base-schemas/${S}`, () => ok(companySchema)));

describe("keyOf", () => {
  it("derives the web app's key from a label", () => {
    expect(keyOf("Contract value")).toBe("contract_value");
    expect(keyOf("  ARR (USD) ")).toBe("arr_usd");
    expect(keyOf("2nd owner")).toBe("nd_owner");
    expect(keyOf("Ünïcode")).toBe("unicode");
  });
});

describe("heliyos_fields_create", () => {
  it("creates a select field with the derived key, the next sequence and default permissions", async () => {
    let body: any;
    useSchemas();
    api.use(
      http.post(`${P}/base-schemas/${S}/fields`, async ({ request }) => {
        body = await request.json();
        return ok({ id: "6bb000000000000000000009", ...body });
      })
    );
    const result = await call("heliyos_fields_create", {
      object_type: "company",
      label: "Contract tier",
      type: "select",
      options: ["Gold", "Silver"],
      description: "Commercial tier",
      required: true,
    });
    const text = expectOk(result);
    expect(body).toEqual({
      sequence: 5,
      name: "contract_tier",
      displayName: "Contract tier",
      description: "Commercial tier",
      type: { type: "select", enum: ["select"] },
      settings: { selectOptions: ["Gold", "Silver"] },
      isAIEnabled: false,
      isHiddenField: false,
      required: true,
      permissions: {
        visibility: "organization",
        viewableBy: { roles: ["SUPER_ADMIN", "STAFF", "SUPPORT", "ADMIN", "OWNER", "MEMBER", "AGENCY"], users: [] },
        editableBy: { roles: ["SUPER_ADMIN", "STAFF", "SUPPORT", "ADMIN", "OWNER", "MEMBER", "AGENCY"], users: [] },
      },
      runImmediately: false,
    });
    expect(text).toContain("contract_tier");
    expect((result.structuredContent as Structured).field).toEqual({
      field_id: "6bb000000000000000000009",
      key: "contract_tier",
      label: "Contract tier",
      type: "select",
      options: ["Gold", "Silver"],
    });
  });

  it("makes an AI column with ai_prompt and never runs it", async () => {
    let body: any;
    useSchemas();
    api.use(
      http.post(`${P}/base-schemas/${S}/fields`, async ({ request }) => {
        body = await request.json();
        return ok({ id: "6bb000000000000000000009", ...body });
      })
    );
    expectOk(
      await call("heliyos_fields_create", { object_type: "company", label: "Tech stack", type: "text", ai_prompt: "List the company's main technologies.", key: "tech_stack", visibility: "private" })
    );
    expect(body.isAIEnabled).toBe(true);
    expect(body.aiPrompt).toEqual({ prompt: "List the company's main technologies.", variables: [] });
    expect(body.runImmediately).toBe(false);
    expect(body.permissions.visibility).toBe("private");
  });

  it("refuses a key the object already has, before calling the API", async () => {
    useSchemas();
    api.use(http.post(`${P}/base-schemas/${S}/fields`, () => apiError(500, "INTERNAL", "should not be called")));
    expectToolError(await call("heliyos_fields_create", { object_type: "company", label: "Domain", type: "text" }), "CONFLICT");
  });

  it.each([
    [{ type: "select" }, /need options/],
    [{ type: "text", options: ["a"] }, /only apply to select/],
    [{ type: "url", ai_prompt: "x" }, /ai_prompt only applies/],
    [{ type: "text", key: "Bad Key" }, /lowercase/],
    [{ type: "relationship" }, /type/],
  ])("rejects %j before calling the API", async (extra, message) => {
    const result = await call("heliyos_fields_create", { object_type: "company", label: "X", ...extra });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
  });
});

describe("heliyos_fields_update", () => {
  it("replaces options and relabels by field_id", async () => {
    let body: any;
    useSchemas();
    api.use(
      http.patch(`${P}/base-schemas/${S}/fields/${FIELD_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...companySchema.fields[2], displayName: body.displayName, settings: body.settings });
      })
    );
    const result = await call("heliyos_fields_update", { object_type: "company", field_id: FIELD_ID, label: "Lifecycle stage", options: ["Lead", "Customer", "Churned"] });
    const text = expectOk(result);
    expect(body).toEqual({ displayName: "Lifecycle stage", settings: { selectOptions: ["Lead", "Customer", "Churned"] } });
    expect(text).toContain("Lifecycle stage");
    expect((result.structuredContent as Structured).field).toMatchObject({ field_id: FIELD_ID, key: "stage", options: ["Lead", "Customer", "Churned"] });
  });

  it("refuses options on a non-select field and an unknown field_id with the known ones", async () => {
    useSchemas();
    const bad = await call("heliyos_fields_update", { object_type: "company", field_id: "6bb000000000000000000002", options: ["x"] });
    expectToolError(bad, "VALIDATION_FAILED");
    const missing = await call("heliyos_fields_update", { object_type: "company", field_id: "6bb0000000000000000000ff", label: "x" });
    expect(expectToolError(missing, "NOT_FOUND")).toContain("company_name");
  });

  it("passes a type change through and surfaces the platform's refusal", async () => {
    useSchemas();
    api.use(http.patch(`${P}/base-schemas/${S}/fields/${FIELD_ID}`, () => apiError(400, "VALIDATION_FAILED", "Cannot change field type: 3 records have incompatible data.")));
    const text = expectToolError(await call("heliyos_fields_update", { object_type: "company", field_id: FIELD_ID, type: "number" }), "VALIDATION_FAILED");
    expect(text).toContain("incompatible");
  });
});

describe("heliyos_fields_delete", () => {
  it("deletes by field_id and names the key", async () => {
    useSchemas();
    let called = false;
    api.use(
      http.delete(`${P}/base-schemas/${S}/fields/${FIELD_ID}`, () => {
        called = true;
        return ok({ deleted: true });
      })
    );
    const result = await call("heliyos_fields_delete", { object_type: "company", field_id: FIELD_ID });
    expect(expectOk(result)).toContain("stage");
    expect(called).toBe(true);
    expect(result.structuredContent).toEqual({ field_id: FIELD_ID, key: "stage", deleted: true });
  });

  it("refuses an unknown field_id without calling the API", async () => {
    useSchemas();
    expectToolError(await call("heliyos_fields_delete", { object_type: "company", field_id: "6bb0000000000000000000ff" }), "NOT_FOUND");
  });
});
