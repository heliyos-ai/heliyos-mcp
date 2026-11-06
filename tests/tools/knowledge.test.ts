/**
 * The heliyos_knowledge_entries_delete, heliyos_knowledge_entries_set, heliyos_knowledge_get, heliyos_knowledge_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, AUTH, ok } from "../helpers/platform.js";

const { api, call } = useMockApi();

const org = {
  _id: "64f000000000000000000001",
  name: "Acme",
  businessContext: "We sell CRM software to B2B teams.",
  knowledgeBase: {
    productsInformation: "Heliyos CRM. ".repeat(200),
    painPoints: "Reps lose context between tools.",
    valueProposition: "",
    qualificationCriteria: "B2B, 20+ reps.",
    legacyKey: "kept as is",
    entries: [
      { label: "Pricing", content: "<p>Starts at $49 per seat.</p>" },
      { label: "Competitors", content: "HubSpot, Attio." },
    ],
  },
};

/** GET returns `current`; PATCH records its body and updates `current` the way the auth service does (whole object). */
function useOrganization(initial = org) {
  const state = { current: JSON.parse(JSON.stringify(initial)) as typeof org, patches: [] as any[] };
  api.use(
    http.get(`${AUTH}/organizations/current`, () => ok(state.current)),
    http.patch(`${AUTH}/organizations/current`, async ({ request }) => {
      const body = (await request.json()) as any;
      state.patches.push(body);
      state.current = { ...state.current, ...body };
      return ok({});
    })
  );
  return state;
}

describe("heliyos_knowledge_get", () => {
  it("returns the fixed texts, business context and entries, clipped in concise", async () => {
    useOrganization();
    const result = await call("heliyos_knowledge_get", {});
    const text = expectOk(result);
    expect(text).toContain("Business context:\nWe sell CRM software");
    expect(text).toContain("pain points:\nReps lose context");
    expect(text).toContain("value proposition:\n(empty)");
    expect(text).toContain("2 custom entries");
    expect(text).toContain("- Pricing: <p>Starts at $49 per seat.</p>");
    expect(text).toContain('heliyos_files_list with kind "knowledge_base"');
    const k = (result.structuredContent as Structured).knowledge;
    expect(k.products_information.length).toBeLessThan(org.knowledgeBase.productsInformation.length);
    expect(k).not.toHaveProperty("value_proposition");
    expect(k.entries).toEqual(org.knowledgeBase.entries);

    const detailed = (await call("heliyos_knowledge_get", { response_format: "detailed" })).structuredContent as Structured;
    expect(detailed.knowledge.products_information).toBe(org.knowledgeBase.productsInformation);
  });

  it("surfaces FORBIDDEN_ACTION", async () => {
    api.use(http.get(`${AUTH}/organizations/current`, () => apiError(403, "FORBIDDEN_ACTION", "Not allowed")));
    expectToolError(await call("heliyos_knowledge_get", {}), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_knowledge_update", () => {
  it("changes only the given texts and sends the whole knowledge base back, entries and unknown keys included", async () => {
    const state = useOrganization();
    const result = await call("heliyos_knowledge_update", { value_proposition: "One place for accounts and workers.", business_context: "" });
    const text = expectOk(result);
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0]).toEqual({
      businessContext: "",
      knowledgeBase: {
        ...org.knowledgeBase,
        valueProposition: "One place for accounts and workers.",
        entries: org.knowledgeBase.entries,
      },
    });
    expect(text).toContain("value_proposition (35 chars)");
    expect(text).toContain("business_context (cleared)");
    const k = (result.structuredContent as Structured).knowledge;
    expect(k.value_proposition).toBe("One place for accounts and workers.");
    expect(k).not.toHaveProperty("business_context");
    expect(k.entries).toHaveLength(2);
  });

  it("requires at least one text and writes nothing", async () => {
    const state = useOrganization();
    expect((await call("heliyos_knowledge_update", {})).isError).toBe(true);
    expect(state.patches).toHaveLength(0);
  });
});

describe("heliyos_knowledge_entries_set", () => {
  it("adds a new entry, keeping the others and the fixed texts", async () => {
    const state = useOrganization();
    const result = await call("heliyos_knowledge_entries_set", { label: "Onboarding", content: "Two-week guided setup." });
    const text = expectOk(result);
    expect(state.patches[0].knowledgeBase.entries).toEqual([...org.knowledgeBase.entries, { label: "Onboarding", content: "Two-week guided setup." }]);
    expect(state.patches[0].knowledgeBase.painPoints).toBe(org.knowledgeBase.painPoints);
    expect(state.patches[0]).not.toHaveProperty("businessContext");
    expect(text).toContain('Added entry "Onboarding"');
    expect((result.structuredContent as Structured).created).toBe(true);
  });

  it("replaces the content of an existing entry, matching the label case-insensitively", async () => {
    const state = useOrganization();
    const result = await call("heliyos_knowledge_entries_set", { label: "pricing", content: "Starts at $59 per seat." });
    expectOk(result);
    expect(state.patches[0].knowledgeBase.entries).toEqual([
      { label: "Pricing", content: "Starts at $59 per seat." },
      { label: "Competitors", content: "HubSpot, Attio." },
    ]);
    expect((result.structuredContent as Structured).created).toBe(false);
    expect((result.structuredContent as Structured).entry.label).toBe("Pricing");
  });
});

describe("heliyos_knowledge_entries_delete", () => {
  it("removes one entry by label", async () => {
    const state = useOrganization();
    const result = await call("heliyos_knowledge_entries_delete", { label: "Competitors" });
    expect(expectOk(result)).toContain("Remaining: Pricing");
    expect(state.patches[0].knowledgeBase.entries).toEqual([org.knowledgeBase.entries[0]]);
    expect(result.structuredContent).toMatchObject({ label: "Competitors", deleted: true });
  });

  it("refuses an unknown label, naming the known ones, without writing", async () => {
    const state = useOrganization();
    const text = expectToolError(await call("heliyos_knowledge_entries_delete", { label: "Roadmap" }), "NOT_FOUND");
    expect(text).toContain('"Pricing"');
    expect(state.patches).toHaveLength(0);
  });
});
