/**
 * The heliyos_labels_create, heliyos_labels_delete, heliyos_labels_list, heliyos_labels_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P } from "../helpers/platform.js";

const { api, call } = useMockApi();
const LABEL_ID = "69a000000000000000000001";
const label = {
  _id: LABEL_ID,
  name: "Intent",
  description: "What the sender wants",
  isActive: true,
  labels: [
    { _id: "69b000000000000000000001", name: "Pricing" },
    { _id: "69b000000000000000000002", name: "Support" },
  ],
};

describe("heliyos_labels_list", () => {
  it("lists label groups with their values and ids", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/classification-labels`, ({ request }) => {
        url = new URL(request.url);
        return ok([label], { pagination: { limit: 20 } });
      })
    );
    const result = await call("heliyos_labels_list", { is_active: true, search: "int" });
    const text = expectOk(result);
    expect(url!.searchParams.get("isActive")).toBe("true");
    expect(url!.searchParams.get("search")).toBe("int");
    expect(text).toContain(LABEL_ID);
    expect(text).toContain("Pricing (id 69b000000000000000000001)");
    expect(text).toContain("Support (id 69b000000000000000000002)");
    const sc = result.structuredContent as Structured;
    expect(sc.labels[0]).toMatchObject({ id: LABEL_ID, name: "Intent", is_active: true });
    expect(sc.labels[0].values).toEqual([
      { id: "69b000000000000000000001", name: "Pricing" },
      { id: "69b000000000000000000002", name: "Support" },
    ]);
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/classification-labels`, () => apiError(403, "FORBIDDEN_ACTION", "Not allowed")));
    expectToolError(await call("heliyos_labels_list"), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_labels_create", () => {
  it("creates a label group, giving each value a fresh id", async () => {
    let body: any;
    api.use(
      http.post(`${P}/classification-labels`, async ({ request }) => {
        body = await request.json();
        return ok({ ...body, _id: LABEL_ID });
      })
    );
    const result = await call("heliyos_labels_create", { name: "Intent", description: "What the sender wants", values: ["Pricing", "Support"] });
    const text = expectOk(result);
    expect(text).toContain(LABEL_ID);
    expect(body.name).toBe("Intent");
    expect(body.labels.map((l: Structured) => l.name)).toEqual(["Pricing", "Support"]);
    for (const l of body.labels) expect(l._id).toMatch(/^[0-9a-f]{24}$/);
    expect(body.labels[0]._id).not.toBe(body.labels[1]._id);
    expect(text).toContain(`Pricing (id ${body.labels[0]._id})`);
  });

  it("rejects duplicate value names before calling the API", async () => {
    const text = expectToolError(
      await call("heliyos_labels_create", { name: "Intent", description: "d", values: ["Pricing", "pricing"] }),
      "VALIDATION_FAILED"
    );
    expect(text).toContain("Pricing");
  });
});

describe("heliyos_labels_update", () => {
  it("keeps existing value ids and adds new ones", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/classification-labels/${LABEL_ID}`, async ({ request }) => {
        body = await request.json();
        return ok({ ...label, labels: body.labels });
      })
    );
    const result = await call("heliyos_labels_update", {
      label_id: LABEL_ID,
      values: [{ id: "69b000000000000000000001", name: "Pricing" }, { name: "Legal" }],
    });
    expect(expectOk(result)).toContain("Pricing (id 69b000000000000000000001)");
    expect(body.labels[0]).toEqual({ _id: "69b000000000000000000001", name: "Pricing" });
    expect(body.labels[1].name).toBe("Legal");
    expect(body.labels[1]._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("surfaces a missing label", async () => {
    // The platform throws a plain Error here, which reaches the client as a 500 (report: platform gap 4).
    api.use(http.patch(`${P}/classification-labels/${LABEL_ID}`, () => apiError(500, "INTERNAL", "Classification labels not found")));
    const text = expectToolError(await call("heliyos_labels_update", { label_id: LABEL_ID, name: "x" }), "INTERNAL");
    expect(text).toContain("Classification labels not found");
  });
});

describe("heliyos_labels_delete", () => {
  it("deletes the label group", async () => {
    api.use(http.delete(`${P}/classification-labels/${LABEL_ID}`, () => ok(null)));
    expect(expectOk(await call("heliyos_labels_delete", { label_id: LABEL_ID }))).toContain(LABEL_ID);
  });

  it("surfaces a missing label", async () => {
    api.use(http.delete(`${P}/classification-labels/${LABEL_ID}`, () => apiError(500, "INTERNAL", "Classification labels not found")));
    expectToolError(await call("heliyos_labels_delete", { label_id: LABEL_ID }), "INTERNAL");
  });
});
