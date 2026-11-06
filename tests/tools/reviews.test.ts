/**
 * The heliyos_reviews_decide, heliyos_reviews_get, heliyos_reviews_list tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P, RECORD_IDS } from "../helpers/platform.js";

const { api, call } = useMockApi();

const EMAIL_ID = "6cc000000000000000000001";
const DEAL_ID = "6cc000000000000000000002";
const DEAL_RECORD = "65b000000000000000000009";

const emailReview = {
  _id: EMAIL_ID,
  type: "email_draft",
  kind: "action",
  status: "PENDING",
  agent: "Renewal scout",
  tool: { name: "send_email", callId: "call_1" },
  runId: "run_abc",
  taskId: "68a000000000000000000001",
  proposal: { title: "Reply to Jane about the renewal", summary: "Confirms the April renewal and asks for a call.", args: { to: ["jane@acme.com"], subject: "Renewal" } },
  proposedOutput: { to: ["jane@acme.com"], subject: "Renewal", body: "Hi Jane, ..." },
  objectRefs: [{ objectId: RECORD_IDS.acme, objectType: "company", name: "Acme Corp" }],
  confidence: 72,
  reasoning: "The thread asked for a written confirmation.",
  approvalReason: "confidence below threshold",
  draftEmail: { subject: "Renewal", body: "Hi Jane, confirming the April renewal. ".repeat(20), to: [{ email: "jane@acme.com", name: "Jane" }], cc: ["cto@acme.com"] },
  approval: { status: "PENDING", by: null, at: null, comment: null, feedback: null },
  metadata: { created: { at: "2026-03-01T10:00:00.000Z" }, updated: { at: "2026-03-01T10:00:00.000Z" } },
};

const dealReview = {
  _id: DEAL_ID,
  type: "deal_update",
  status: "APPROVED",
  agent: "Platform Admin",
  dealAction: "Update",
  objectRef: { objectId: DEAL_RECORD, objectType: "deals" },
  previousVersion: { data: { stage: "Proposal", amount: 10000 } },
  newVersion: { data: { stage: "Negotiation", amount: 12000 } },
  approval: { status: "APPROVED", by: "u1", at: "2026-03-02T09:00:00.000Z", comment: "Looks right", feedback: null },
  outcome: { ok: true, appliedBy: "platform", action: "Update" },
  createdAt: "2026-03-01T00:00:00.000Z",
};

describe("heliyos_reviews_list", () => {
  it("lists pending reviews by default and passes filters through", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/reviews`, ({ request }) => {
        url = new URL(request.url);
        return ok([emailReview], { pagination: { limit: 20, next_cursor: "r2" } });
      })
    );
    const result = await call("heliyos_reviews_list", { type: "email_draft", object_id: RECORD_IDS.acme });
    const text = expectOk(result);
    expect(url!.searchParams.get("status")).toBe("PENDING");
    expect(url!.searchParams.get("type")).toBe("email_draft");
    expect(url!.searchParams.get("objectId")).toBe(RECORD_IDS.acme);
    expect(text).toContain(EMAIL_ID);
    expect(text).toContain("Reply to Jane about the renewal");
    expect(text).toContain('company "Acme Corp"');
    expect(text).toContain('cursor "r2"');
    const sc = result.structuredContent as Structured;
    expect(sc.next_cursor).toBe("r2");
    expect(sc.reviews[0]).toMatchObject({
      id: EMAIL_ID,
      status: "pending",
      type: "email_draft",
      worker: "Renewal scout",
      tool: "send_email",
      run_id: "run_abc",
      confidence: 72,
      records: [{ id: RECORD_IDS.acme, object_type: "company", name: "Acme Corp" }],
    });
    // A list row never carries the draft or the reasoning.
    expect(sc.reviews[0]).not.toHaveProperty("draft_email");
    expect(sc.reviews[0]).not.toHaveProperty("reasoning");
  });

  it("maps approved and rejected statuses and refuses a bad type before calling", async () => {
    let url: URL | undefined;
    api.use(
      http.get(`${P}/reviews`, ({ request }) => {
        url = new URL(request.url);
        return ok([dealReview], {});
      })
    );
    const sc = (await call("heliyos_reviews_list", { status: "approved" })).structuredContent as Structured;
    expect(url!.searchParams.get("status")).toBe("APPROVED");
    expect(sc.reviews[0]).toMatchObject({ id: DEAL_ID, status: "approved", type: "deal_update", decided_at: "2026-03-02T09:00:00.000Z", comment: "Looks right" });
    expect((await call("heliyos_reviews_list", { type: "Email Draft" })).isError).toBe(true);
  });
});

describe("heliyos_reviews_get", () => {
  it("shows the draft email, reasoning and why it waits, clipped in concise", async () => {
    api.use(http.get(`${P}/reviews/${EMAIL_ID}`, () => ok(emailReview)));
    const result = await call("heliyos_reviews_get", { review_id: EMAIL_ID });
    const text = expectOk(result);
    expect(text).toContain("Draft email to jane@acme.com (cc cto@acme.com)");
    expect(text).toContain("Subject: Renewal");
    expect(text).toContain("Reasoning: The thread asked");
    expect(text).toContain("confidence below threshold");
    const r = (result.structuredContent as Structured).review;
    expect(r.draft_email.to).toEqual(["jane@acme.com"]);
    expect(r.draft_email.body.length).toBeLessThan(emailReview.draftEmail.body.length);
    expect(r).not.toHaveProperty("proposal");

    const detailed = (await call("heliyos_reviews_get", { review_id: EMAIL_ID, response_format: "detailed" })).structuredContent as Structured;
    expect(detailed.review.draft_email.body).toBe(emailReview.draftEmail.body);
    expect(detailed.review.proposal).toEqual(emailReview.proposedOutput);
  });

  it("shows a deal change as before → after and the outcome once decided", async () => {
    api.use(http.get(`${P}/reviews/${DEAL_ID}`, () => ok(dealReview)));
    const result = await call("heliyos_reviews_get", { review_id: DEAL_ID, response_format: "detailed" });
    const text = expectOk(result);
    expect(text).toContain("stage");
    expect(text).toContain("Proposal → Negotiation");
    expect(text).toContain("10000 → 12000");
    expect(text).toContain("appliedBy");
    const r = (result.structuredContent as Structured).review;
    expect(r.deal_before).toEqual({ stage: "Proposal", amount: 10000 });
    expect(r.deal_after).toEqual({ stage: "Negotiation", amount: 12000 });
    expect(r.records).toEqual([{ id: DEAL_RECORD, object_type: "deals" }]);
  });

  it("surfaces NOT_FOUND", async () => {
    api.use(http.get(`${P}/reviews/${EMAIL_ID}`, () => apiError(404, "NOT_FOUND", "Review not found")));
    expectToolError(await call("heliyos_reviews_get", { review_id: EMAIL_ID }), "NOT_FOUND");
  });
});

describe("heliyos_reviews_decide", () => {
  it("approves with a comment and reports the run to follow", async () => {
    let body: any;
    api.use(
      http.post(`${P}/reviews/${EMAIL_ID}/decisions`, async ({ request }) => {
        body = await request.json();
        return ok({ review: { ...emailReview, approval: { ...emailReview.approval, status: "APPROVED" } }, status: "APPROVED", orchestrator: { resumed: true } });
      })
    );
    const result = await call("heliyos_reviews_decide", { review_id: EMAIL_ID, decision: "approved", comment: "Send it" });
    const text = expectOk(result);
    expect(body).toEqual({ decision: "approved", comment: "Send it" });
    expect(text).toContain(`Review ${EMAIL_ID} approved: Reply to Jane`);
    expect(text).toContain("heliyos_runs_get run_id run_abc");
    expect(result.structuredContent).toMatchObject({ review_id: EMAIL_ID, decision: "approved", status: "approved", run_notified: true });
  });

  it("rejects with feedback, and passes edited deal data through on approval", async () => {
    const bodies: any[] = [];
    api.use(
      http.post(`${P}/reviews/${DEAL_ID}/decisions`, async ({ request }) => {
        bodies.push(await request.json());
        return ok({ review: dealReview, status: bodies.at(-1).decision === "approved" ? "APPROVED" : "REJECTED", applied: { action: "Update", dealId: DEAL_RECORD }, orchestratorError: "agent unreachable" });
      })
    );
    const rejected = await call("heliyos_reviews_decide", { review_id: DEAL_ID, decision: "rejected", feedback: "Amount is wrong" });
    expectOk(rejected);
    expect(bodies[0]).toEqual({ decision: "rejected", feedback: "Amount is wrong" });

    const approved = await call("heliyos_reviews_decide", { review_id: DEAL_ID, decision: "approved", data: { stage: "Negotiation", amount: 11500 } });
    const text = expectOk(approved);
    expect(bodies[1]).toEqual({ decision: "approved", data: { stage: "Negotiation", amount: 11500 } });
    expect(text).toContain("Applied:");
    expect(text).toContain("could not be told yet");
    expect((approved.structuredContent as Structured).run_notified).toBe(false);
  });

  it("refuses data or args on a rejection before calling, and surfaces an already-decided review", async () => {
    const bad = await call("heliyos_reviews_decide", { review_id: DEAL_ID, decision: "rejected", data: { stage: "x" } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/only apply when approving/);

    api.use(http.post(`${P}/reviews/${DEAL_ID}/decisions`, () => apiError(400, "VALIDATION_FAILED", "Review is already approved.")));
    const text = expectToolError(await call("heliyos_reviews_decide", { review_id: DEAL_ID, decision: "approved" }), "VALIDATION_FAILED");
    expect(text).toContain("already approved");
  });
});
