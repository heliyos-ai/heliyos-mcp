/**
 * Reviews: worker actions waiting for a person. A review is what a run raised
 * when it wanted to send an email, change a deal, schedule a meeting, create a
 * task or asked the person a question. Three tools: list (pending by default),
 * get (the full proposal) and decide (approve or reject, with an optional
 * comment, feedback or edited values). One decision endpoint covers every
 * type: the platform applies deal and label changes itself and hands the rest
 * to the orchestrator, which resumes the paused run.
 */
import * as z from "zod/v4";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitBlocks, formatValue, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  cursorInput,
  dateOf,
  day,
  DECIDES,
  expectObject,
  hexId,
  idOf,
  LIST_TRUNCATION_HINT,
  nextCursorOf,
  numberOf,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  stringOf,
  timestampsOf,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

const STATUSES = ["pending", "approved", "rejected"] as const;
const DECISIONS = ["approved", "rejected"] as const;
const CONCISE_TEXT_CHARS = 400;
const DETAILED_TEXT_CHARS = 6000;
const LIST_BUDGET = MAX_TEXT_CHARS - 600;

// ---------------------------------------------------------------- shapes

const reviewRecordOut = z.object({
  id: z.string(),
  object_type: z.string().optional(),
  name: z.string().optional(),
});

const draftEmailOut = z.object({
  subject: z.string().optional(),
  body: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
});

const reviewOut = z.object({
  id: z.string(),
  status: z.enum(STATUSES),
  type: z.string().describe("deal_update, email_draft, meeting_scheduled, task, document, decision, classification_label, or a tool name."),
  kind: z.string().optional().describe("plan, action or question."),
  title: z.string().optional(),
  summary: z.string().optional().describe("What the worker proposes, in a sentence or two."),
  worker: z.string().optional().describe("The worker that raised it."),
  tool: z.string().optional().describe("The paused tool call, when the review is one."),
  run_id: z.string().optional().describe("The run waiting on it; read it with heliyos_runs_get."),
  task_id: z.string().optional(),
  records: z.array(reviewRecordOut).optional().describe("The records it is about."),
  confidence: z.number().optional().describe("0 to 100, as the worker stated it."),
  reasoning: z.string().optional().describe("Why the worker proposes it."),
  approval_reason: z.string().optional().describe("Why it waits: the toggle is off, confidence is below the threshold, ..."),
  proposal: z.record(z.string(), z.unknown()).optional().describe("Detailed only: the proposed arguments (what the worker wants to do)."),
  draft_email: draftEmailOut.optional().describe("email_draft only."),
  deal_before: z.record(z.string(), z.unknown()).optional().describe("deal_update only: the deal's fields before the change."),
  deal_after: z.record(z.string(), z.unknown()).optional().describe("deal_update only: the fields as proposed."),
  decided_at: z.string().optional(),
  comment: z.string().optional().describe("The reviewer's comment, once decided."),
  feedback: z.string().optional().describe("The reviewer's feedback to the worker, once decided."),
  outcome: z.record(z.string(), z.unknown()).optional().describe("Detailed only: what happened once decided."),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
type ReviewOut = z.infer<typeof reviewOut>;

const statusOf = (raw: Record<string, unknown>): ReviewOut["status"] => {
  const approval = isRecord(raw.approval) ? raw.approval : {};
  const s = String(stringOf(approval.status) ?? stringOf(raw.status) ?? "PENDING").toUpperCase();
  return s === "APPROVED" ? "approved" : s === "REJECTED" ? "rejected" : "pending";
};

const emailsOf = (list: unknown): string[] | undefined => {
  if (!Array.isArray(list)) return undefined;
  const out = list.map((p) => (typeof p === "string" ? p : isRecord(p) ? (stringOf(p.email) ?? stringOf(p.name)) : undefined)).filter((s): s is string => !!s);
  return out.length ? out : undefined;
};

function recordsOf(raw: Record<string, unknown>): ReviewOut["records"] {
  const refs = Array.isArray(raw.objectRefs) && raw.objectRefs.length ? raw.objectRefs : isRecord(raw.objectRef) ? [raw.objectRef] : [];
  const out = refs.filter(isRecord).flatMap((r) => {
    const id = idOf(r.objectId);
    return id ? [{ id, ...(stringOf(r.objectType) ? { object_type: stringOf(r.objectType) } : {}), ...(stringOf(r.name) ? { name: stringOf(r.name) } : {}) }] : [];
  });
  return out.length ? out : undefined;
}

function reviewOf(data: unknown, mode: "list" | "concise" | "detailed"): ReviewOut {
  const raw = expectObject(data, "review");
  const detailed = mode === "detailed";
  const short = (text: string | undefined) => (text === undefined ? undefined : clip(text, detailed ? DETAILED_TEXT_CHARS : CONCISE_TEXT_CHARS));
  const proposal = isRecord(raw.proposal) ? raw.proposal : {};
  const approval = isRecord(raw.approval) ? raw.approval : {};
  const draft = isRecord(raw.draftEmail) ? raw.draftEmail : undefined;
  const taskMeta = isRecord(raw.taskMeta) ? raw.taskMeta : {};
  const before = isRecord(raw.previousVersion) && isRecord(raw.previousVersion.data) ? raw.previousVersion.data : undefined;
  const after = isRecord(raw.newVersion) && isRecord(raw.newVersion.data) ? raw.newVersion.data : undefined;
  const args = isRecord(raw.proposedOutput) ? raw.proposedOutput : isRecord(proposal.args) ? proposal.args : undefined;
  const agent = stringOf(raw.agent) ?? (isRecord(raw.agentRef) ? stringOf(raw.agentRef.name) : undefined);
  const toolName = isRecord(raw.tool) ? stringOf(raw.tool.name) : undefined;
  const type = stringOf(raw.type) ?? "deal_update";
  const title = stringOf(proposal.title) ?? (draft ? stringOf(draft.subject) : undefined) ?? stringOf(taskMeta.title);
  const status = statusOf(raw);
  const decided = status !== "pending";
  return {
    id: requireId(raw, "review"),
    status,
    type,
    ...(stringOf(raw.kind) ? { kind: stringOf(raw.kind) } : {}),
    ...(title ? { title: short(title) } : {}),
    ...(stringOf(proposal.summary) ? { summary: short(stringOf(proposal.summary)) } : {}),
    ...(agent ? { worker: agent } : {}),
    ...(toolName ? { tool: toolName } : {}),
    ...(stringOf(raw.runId) ?? stringOf(raw.agentRunId) ? { run_id: stringOf(raw.runId) ?? stringOf(raw.agentRunId) } : {}),
    ...(stringOf(raw.taskId) ? { task_id: stringOf(raw.taskId) } : {}),
    ...(recordsOf(raw) ? { records: recordsOf(raw) } : {}),
    ...(numberOf(raw.confidence) !== undefined ? { confidence: numberOf(raw.confidence) } : {}),
    ...(mode !== "list" && stringOf(raw.reasoning) ? { reasoning: short(stringOf(raw.reasoning)) } : {}),
    ...(mode !== "list" && stringOf(raw.approvalReason) ? { approval_reason: stringOf(raw.approvalReason) } : {}),
    ...(detailed && args ? { proposal: args } : {}),
    ...(mode !== "list" && draft
      ? {
          draft_email: {
            ...(stringOf(draft.subject) ? { subject: stringOf(draft.subject) } : {}),
            ...(stringOf(draft.body) ? { body: short(stringOf(draft.body)) } : {}),
            ...(emailsOf(draft.to) ? { to: emailsOf(draft.to) } : {}),
            ...(emailsOf(draft.cc) ? { cc: emailsOf(draft.cc) } : {}),
            ...(emailsOf(draft.bcc) ? { bcc: emailsOf(draft.bcc) } : {}),
          },
        }
      : {}),
    ...(mode !== "list" && type === "deal_update" && before ? { deal_before: before } : {}),
    ...(mode !== "list" && type === "deal_update" && after ? { deal_after: after } : {}),
    ...(decided && dateOf(approval.at) ? { decided_at: dateOf(approval.at) } : {}),
    ...(decided && stringOf(approval.comment) ? { comment: stringOf(approval.comment) } : {}),
    ...(decided && stringOf(approval.feedback) ? { feedback: stringOf(approval.feedback) } : {}),
    ...(detailed && isRecord(raw.outcome) ? { outcome: raw.outcome } : {}),
    ...timestampsOf(raw),
  };
}

const recordsText = (r: ReviewOut) => r.records?.map((x) => `${x.object_type ?? "record"} ${x.name ? `"${x.name}" (${x.id})` : x.id}`).join(", ");

const reviewLine = (r: ReviewOut) =>
  [
    `${r.id} [${r.status}] ${r.type}${r.kind && r.kind !== "action" ? ` (${r.kind})` : ""}${r.title ? `: ${r.title}` : ""}`,
    `  ${[r.worker ? `by ${r.worker}` : "", r.created_at ? day(r.created_at) : "", r.confidence !== undefined ? `confidence ${r.confidence}` : ""]
      .filter(Boolean)
      .join(" · ")}`,
    r.summary ? `  ${r.summary}` : "",
    r.records?.length ? `  about: ${recordsText(r)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/** The fields of a deal proposal that differ from the deal before it. */
function dealChanges(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!after) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(value)) out[key] = `${before && key in before ? `${formatValue(before[key])} → ` : ""}${formatValue(value)}`;
  }
  return out;
}

function reviewText(r: ReviewOut): string {
  const facts = renderRecord({
    worker: r.worker,
    tool: r.tool,
    run_id: r.run_id,
    task_id: r.task_id,
    about: recordsText(r),
    confidence: r.confidence,
    waiting_because: r.approval_reason,
    created: day(r.created_at),
    decided: r.decided_at ? `${day(r.decided_at)}${r.comment ? `, comment: ${r.comment}` : ""}${r.feedback ? `, feedback: ${r.feedback}` : ""}` : undefined,
  });
  const changes = dealChanges(r.deal_before, r.deal_after);
  const sections = [
    `Review ${r.id} [${r.status}] ${r.type}${r.kind ? ` (${r.kind})` : ""}${r.title ? `: ${r.title}` : ""}`,
    facts,
    r.summary ? `\nProposal: ${r.summary}` : "",
    r.reasoning ? `Reasoning: ${r.reasoning}` : "",
    r.draft_email
      ? `\nDraft email${r.draft_email.to ? ` to ${r.draft_email.to.join(", ")}` : ""}${r.draft_email.cc ? ` (cc ${r.draft_email.cc.join(", ")})` : ""}:\n` +
        `Subject: ${r.draft_email.subject ?? "(none)"}\n${r.draft_email.body ?? "(no body)"}`
      : "",
    Object.keys(changes).length ? `\nDeal changes:\n${renderRecord(changes)}` : "",
    r.proposal && !r.draft_email && !Object.keys(changes).length ? `\nProposed arguments:\n${renderRecord(r.proposal)}` : "",
    r.outcome ? `\nOutcome:\n${renderRecord(r.outcome)}` : "",
  ];
  return sections.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- tools

/** Builds the tools that list and read reviews and record a decision on one, from the shared tool context. */
export function reviewTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_reviews_list",
    title: "List reviews",
    description:
      "Lists reviews: worker actions waiting for a person's decision (an email draft, a deal change, a meeting, a task, " +
      "a document, or a question the worker asked), pending ones by default, newest first. Filter by status, type, or " +
      "the record or task they are about. Each shows its id, type, title, summary, the worker and the records. Read one " +
      "with heliyos_reviews_get, decide it with heliyos_reviews_decide. Returns structuredContent " +
      "{reviews:[{id, status, type, title, summary, worker, run_id, records}], next_cursor}.",
    input: z.strictObject({
      status: z.enum(STATUSES).default("pending").describe("pending (default), approved or rejected."),
      type: z
        .string()
        .trim()
        .regex(/^[a-z][a-z0-9_]*$/, "type must be a lowercase identifier such as email_draft")
        .max(64)
        .optional()
        .describe("Only one type: deal_update, email_draft, meeting_scheduled, task, document, decision (questions and ad-hoc approvals), classification_label, or a tool name."),
      object_id: hexId("object_id").optional().describe("Only reviews about this record (company, person, deal) or task."),
      limit: pageLimit("Reviews"),
      cursor: cursorInput,
      response_format: responseFormat("id, type, title, summary, worker and records per review", "the reasoning and draft or deal details too"),
    }),
    output: z.object({ reviews: z.array(reviewOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const { data, meta } = await callOperation(client, "listReviews", {
        query: {
          limit: args.limit,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          status: args.status.toUpperCase() as "PENDING" | "APPROVED" | "REJECTED",
          ...(args.type ? { type: args.type } : {}),
          ...(args.object_id ? { objectId: args.object_id } : {}),
        },
      });
      const detailed = args.response_format === "detailed";
      const reviews = expectArray(data, "review list").map((raw) => reviewOf(raw, detailed ? "concise" : "list"));
      const next = nextCursorOf(meta);
      const body =
        reviews.length === 0
          ? `No ${args.status} reviews matched.`
          : fitBlocks(reviews.map(reviewLine), reviews.map((r) => r.id), LIST_BUDGET, {
              items: "reviews",
              key: "reviews",
              readHint: "Read them with heliyos_reviews_get.",
            });
      return {
        text: `${plural(reviews.length, `${args.status} review`)}:\n${body}\n\n${pagingFooter("heliyos_reviews_list", next)}`,
        structuredContent: { reviews, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const get = tool({
    name: "heliyos_reviews_get",
    title: "Get a review",
    description:
      "Fetches one review by id with everything a person needs to decide it: the worker's proposal and reasoning, the " +
      "draft email (subject, recipients, body) or the deal's fields before and after, the records and run it belongs " +
      `to, and, once decided, the comment and outcome. Long texts are cut at ${CONCISE_TEXT_CHARS} characters in concise. ` +
      "Returns structuredContent {review}.",
    input: z.strictObject({
      review_id: hexId("review_id"),
      response_format: responseFormat("the proposal with shortened texts", "full texts, the raw proposed arguments and the outcome"),
    }),
    output: z.object({ review: reviewOut }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "getReview", { params: { id: args.review_id } });
      const review = reviewOf(data, args.response_format === "detailed" ? "detailed" : "concise");
      return { text: reviewText(review), structuredContent: { review } };
    },
  });

  const decide = tool({
    name: "heliyos_reviews_decide",
    title: "Approve or reject a review",
    description:
      "Decides one pending review. Approving does the thing the worker proposed: the email is sent, the deal or label " +
      "is changed, the meeting is booked, or the paused run continues with its action; rejecting discards it and tells " +
      "the worker why (feedback). A review is decided once; a second call fails. Approving acts on the user's behalf and " +
      "cannot be undone: read it with heliyos_reviews_get and confirm with the user first. For a deal_update you may " +
      "pass the fields as the user edited them in `data`; for a paused tool call, edited arguments in `args`. Returns " +
      "structuredContent {review_id, decision, status, run_notified}.",
    input: z
      .strictObject({
        review_id: hexId("review_id"),
        decision: z.enum(DECISIONS).describe("approved or rejected."),
        comment: z.string().trim().max(5000).optional().describe("A note kept on the review."),
        feedback: z.string().trim().max(5000).optional().describe("What to tell the worker, for example why it was rejected or what to change."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("deal_update and approved only: the deal's fields as the user confirmed or edited them (field key to value)."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("A paused tool call and approved only: the tool's arguments as the user edited them (see proposal in heliyos_reviews_get)."),
      })
      .refine((v) => v.decision === "approved" || (v.data === undefined && v.args === undefined), {
        message: "data and args only apply when approving",
      }),
    output: z.object({
      review_id: z.string(),
      decision: z.enum(DECISIONS),
      status: z.string(),
      run_notified: z.boolean().describe("false: the change was applied but the paused run could not be told; it will be picked up later."),
      review: reviewOut.optional(),
    }),
    annotations: DECIDES,
    async handler(args) {
      const { data } = await callOperation(client, "createReviewDecision", {
        params: { id: args.review_id },
        body: {
          decision: args.decision,
          ...(args.comment !== undefined ? { comment: args.comment } : {}),
          ...(args.feedback !== undefined ? { feedback: args.feedback } : {}),
          ...(args.data !== undefined ? { data: args.data } : {}),
          ...(args.args !== undefined ? { args: args.args } : {}),
        },
      });
      const raw = expectObject(data, "review decision");
      const status = (stringOf(raw.status) ?? args.decision).toLowerCase();
      const notified = !stringOf(raw.orchestratorError);
      const review = isRecord(raw.review) ? reviewOf({ ...raw.review, status: status.toUpperCase() }, "concise") : undefined;
      const applied = isRecord(raw.applied) ? raw.applied : undefined;
      const text = [
        `Review ${args.review_id} ${status}${review?.title ? `: ${review.title}` : ""}.`,
        applied ? `Applied: ${renderRecord(Object.fromEntries(Object.entries(applied).filter(([k]) => k !== "object")))}` : "",
        notified ? "" : "The change is applied, but the worker's run could not be told yet; it will pick the decision up on its own.",
        review?.run_id ? `Follow the run with heliyos_runs_get run_id ${review.run_id}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        structuredContent: {
          review_id: args.review_id,
          decision: args.decision,
          status,
          run_notified: notified,
          ...(review ? { review } : {}),
        },
      };
    },
  });

  return [list, get, decide];
}
