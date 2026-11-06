/**
 * Timeline: what happened on a record. Three reads: the AI-written timeline
 * (listRecordTimeline), the audit trail of changes (listRecordEvents), and the
 * emails and meetings (listInteractions).
 */
import * as z from "zod/v4";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitBlocks, formatValue, MAX_TEXT_CHARS } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  cursorInput,
  dateOf,
  day,
  expectObject,
  hexId,
  idOf,
  isoDate,
  nextCursorOf,
  numberOf,
  pageCursor,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  searchInput,
  stringOf,
  type ToolContext,
  paginationOf,
  endOfDay,
  LIST_TRUNCATION_HINT,
  pagedQuery,
  sortInput,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

/** The Heliyos API's event enums (operation type and event type), matched exactly. */
export const EVENT_OPERATION_TYPES = ["CREATE", "UPDATE", "DELETE"] as const;
/** The event types a timeline filter accepts. */
export const EVENT_TYPES = ["AUDIT", "INTERACTION", "ENRICHMENT"] as const;

const CONCISE_TEXT_CHARS = 300;
const DETAILED_TEXT_CHARS = 3000;
const MAX_CHANGED_FIELDS = 30;
const LIST_BUDGET = MAX_TEXT_CHARS - 600;

const clipFor = (detailed: boolean) => (text: string) => clip(text, detailed ? DETAILED_TEXT_CHARS : CONCISE_TEXT_CHARS);

// ---------------------------------------------------------------- record timeline

const timelineEntryOut = z.object({
  id: z.string(),
  at: z.string().optional(),
  summary: z.string(),
  object_type: z.string().optional(),
});

// ---------------------------------------------------------------- record events

/** Output shape of one change event on a record: when, who, what kind and which fields changed. */
export const eventOut = z.object({
  id: z.string(),
  at: z.string().optional(),
  event_type: z.string().optional(),
  operation_type: z.string().optional().describe("CREATE, UPDATE, DELETE, ..."),
  actor: z.string().optional().describe("Who made the change (a person's or worker's name)."),
  actor_type: z.string().optional(),
  change_summary: z.string().optional(),
  changed_fields: z.array(z.string()).optional().describe("Detailed only: paths whose value changed."),
});
type EventOut = z.infer<typeof eventOut>;

/** Paths (a.b.c) whose JSON differs between two versions; nested objects are walked, arrays compared whole. */
function changedPaths(before: unknown, after: unknown, prefix = "", out: string[] = []): string[] {
  if (out.length >= MAX_CHANGED_FIELDS) return out;
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (key === "metadata" || key === "updatedAt" || key === "__v") continue;
      changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after) && prefix) out.push(prefix);
  return out;
}

/** Converts a raw timeline event from the Heliyos API into the tool output shape. `detailed` also lists the changed field paths. */
export function eventOf(raw: Record<string, unknown>, detailed: boolean): EventOut {
  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const actor = isRecord(meta.actor) ? meta.actor : {};
  const at = dateOf(raw.timestamp);
  const eventType = stringOf(meta.eventType);
  const operation = stringOf(meta.operationType);
  const actorName = stringOf(actor.name);
  const actorType = stringOf(actor.type);
  const summary = stringOf(raw.changeSummary);
  const changed = detailed ? changedPaths(raw.originalVersion, raw.updatedVersion) : [];
  return {
    id: requireId(raw, "event"),
    ...(at ? { at } : {}),
    ...(eventType ? { event_type: eventType } : {}),
    ...(operation ? { operation_type: operation } : {}),
    ...(actorName ? { actor: actorName } : {}),
    ...(actorType ? { actor_type: actorType } : {}),
    ...(summary ? { change_summary: summary } : {}),
    ...(detailed ? { changed_fields: changed } : {}),
  };
}

/**
 * The text and structuredContent of a change-event list (a record's or a
 * task's): one line per event, who and what, newest first, with the paging
 * footer naming `toolName`.
 */
export function eventListOutput(
  data: unknown,
  meta: Record<string, unknown>,
  detailed: boolean,
  subject: string,
  toolName: string
): { text: string; structuredContent: { events: EventOut[]; next_cursor?: string } } {
  const events = expectArray(data, "event list")
    .filter(isRecord)
    .map((raw) => eventOf(raw, detailed));
  const next = nextCursorOf(meta);
  const lines = events.map((e) => {
    const who = e.actor ? `${e.actor}${e.actor_type ? ` (${e.actor_type.toLowerCase()})` : ""}` : "unknown actor";
    const what = e.change_summary ?? e.operation_type ?? "change";
    const fields = e.changed_fields?.length ? `\n  changed: ${e.changed_fields.join(", ")}` : "";
    const when = [e.at, e.operation_type].filter(Boolean).join(" · ");
    return `${when ? `${when} ` : ""}by ${who}: ${what} (id ${e.id})${fields}`;
  });
  const list =
    events.length === 0
      ? "No change events matched."
      : fitBlocks(lines, events.map((e) => e.id), LIST_BUDGET, {
          items: "events",
          key: "events",
          readHint: 'Repeat with a lower limit, or response_format "concise".',
        });
  return {
    text: `${plural(events.length, "change event")} on ${subject}:\n${list}\n\n${pagingFooter(toolName, next)}`,
    structuredContent: { events, ...(next ? { next_cursor: next } : {}) },
  };
}

// ---------------------------------------------------------------- interactions

const interactionOut = z.object({
  id: z.string(),
  channel: z.string().describe("email or meeting."),
  title: z.string().describe("Email subject or meeting title."),
  at: z.string().optional().describe("Last message time (email) or start time (meeting)."),
  summary: z.string().optional(),
  sentiment: z.string().optional(),
  record_ids: z.array(z.string()).describe("Records this interaction is linked to."),
  participants: z.array(z.string()).optional().describe("Detailed only: email addresses involved."),
  next_steps: z.string().optional().describe("Detailed only."),
});
type InteractionOut = z.infer<typeof interactionOut>;

const unixToIso = (seconds: number | undefined) =>
  seconds !== undefined ? new Date(seconds * (seconds < 1e12 ? 1000 : 1)).toISOString() : undefined;

const emailsOf = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter(isRecord).map((p) => stringOf(p.email) ?? "").filter(Boolean) : [];

function interactionOf(raw: Record<string, unknown>, detailed: boolean): InteractionOut {
  const channel = isRecord(raw.channel) ? (stringOf(raw.channel.type) ?? "unknown") : "unknown";
  const threads = Array.isArray(raw.threads) ? raw.threads.filter(isRecord) : [];
  const when = isRecord(raw.when) ? raw.when : {};
  const lastThread = threads.map((t) => numberOf(t.date)).filter((d): d is number => d !== undefined).sort((a, b) => b - a)[0];
  const at = channel === "meeting" ? unixToIso(numberOf(when.start_time)) : unixToIso(lastThread);
  const recordIds = (Array.isArray(raw.relationships) ? raw.relationships : [])
    .filter(isRecord)
    .map((r) => idOf(r.objectId))
    .filter((id): id is string => id !== undefined);
  const participants = [
    ...new Set([
      ...emailsOf(raw.participants),
      ...threads.flatMap((t) => [...emailsOf(t.from), ...emailsOf(t.to), ...emailsOf(t.cc)]),
    ]),
  ];
  const summary = stringOf(raw.summary);
  const sentiment = stringOf(raw.sentiment);
  const nextSteps = stringOf(raw.nextSteps) ?? stringOf(raw.keyTakeaways);
  const short = clipFor(detailed);
  return {
    id: requireId(raw, "interaction"),
    channel,
    title: stringOf(raw.subject) ?? stringOf(raw.title) ?? "(no subject)",
    ...((at ?? dateOf(raw.createdAt)) ? { at: at ?? dateOf(raw.createdAt) } : {}),
    ...(summary ? { summary: short(summary) } : {}),
    ...(sentiment ? { sentiment } : {}),
    record_ids: recordIds,
    ...(detailed ? { participants } : {}),
    ...(detailed && nextSteps ? { next_steps: short(nextSteps) } : {}),
  };
}

/** Sort fields of heliyos_interactions_list and what the platform calls them. */
const INTERACTION_SORT_FIELDS = ["last_message", "start_time", "created_at"] as const;
const INTERACTION_SORT_FIELD: Record<(typeof INTERACTION_SORT_FIELDS)[number], string> = {
  last_message: "thread_date",
  start_time: "start_time",
  created_at: "createdAt",
};

const interactionLines = (i: InteractionOut, detailed: boolean) =>
  [
    `${[`${i.channel} "${i.title}"`, day(i.at)].filter(Boolean).join(" · ")} (id ${i.id})`,
    i.summary ? `  ${i.summary}` : "",
    i.record_ids.length ? `  records: ${i.record_ids.join(", ")}` : "",
    detailed && i.participants?.length ? `  participants: ${i.participants.join(", ")}` : "",
    i.next_steps ? `  next steps: ${formatValue(i.next_steps)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

// ---------------------------------------------------------------- tools

/** Builds the tools for a record's timeline and events and for interactions, from the shared tool context. */
export function timelineTools({ client }: ToolContext): ToolSpec[] {
  const recordTimeline = tool({
    name: "heliyos_records_timeline",
    title: "Read a record's timeline",
    description:
      "Returns the AI-written timeline of one record (company, person or deal): the record's current relationship summary " +
      "and dated entries describing what happened (emails, meetings, deal moves), newest first. Use it to brief yourself " +
      "on an account before acting. For the raw audit trail of field changes use heliyos_records_events; for the emails " +
      "and meetings themselves use heliyos_interactions_list. Returns structuredContent {record_id, summary, entries, next_cursor}.",
    input: z.strictObject({
      record_id: hexId("record_id"),
      limit: pageLimit("Entries"),
      cursor: cursorInput,
      response_format: responseFormat(
        `each entry cut at ${CONCISE_TEXT_CHARS} characters`,
        "full entry text"
      ),
    }),
    output: z.object({
      record_id: z.string(),
      summary: z.string().optional(),
      entries: z.array(timelineEntryOut),
      total: z.number().int().optional(),
      next_cursor: z.string().optional(),
    }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const page = pageCursor.decode(args.cursor, args.limit);
      const { data, meta } = await callOperation(client, "listRecordTimeline", {
        params: { id: args.record_id },
        query: { limit: args.limit, ...(page > 1 ? { page } : {}) },
      });
      const body = expectObject(data, "timeline");
      const detailed = args.response_format === "detailed";
      const short = clipFor(detailed);
      const entries = expectArray(body.events ?? [], "timeline entries")
        .filter(isRecord)
        .map((raw) => {
          const m = isRecord(raw.metadata) ? raw.metadata : {};
          const at = dateOf(raw.timestamp);
          const type = stringOf(m.objectType);
          return {
            id: requireId(raw, "timeline entry"),
            ...(at ? { at } : {}),
            summary: short(stringOf(m.summary) ?? ""),
            ...(type ? { object_type: type } : {}),
          };
        });
      const pagination = paginationOf(meta);
      const total = numberOf(pagination.total);
      const next = pageCursor.next(page, args.limit, pagination);
      const summary = stringOf(body.summary);

      const header = [
        `Timeline of record ${args.record_id}${total !== undefined ? ` (${plural(total, "entry", "entries")} in all)` : ""}.`,
        summary ? `Summary: ${short(summary)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const footer = pagingFooter("heliyos_records_timeline", next);
      const list =
        entries.length === 0
          ? "No timeline entries on this page."
          : fitBlocks(
              entries.map((e) => `${[day(e.at), e.summary].filter(Boolean).join(" · ")} (id ${e.id})`),
              entries.map((e) => e.id),
              LIST_BUDGET - header.length,
              { items: "entries", key: "entries", readHint: 'Repeat with a lower limit, or response_format "concise".' }
            );
      return {
        text: `${header}\n\n${list}\n\n${footer}`,
        structuredContent: {
          record_id: args.record_id,
          ...(summary ? { summary } : {}),
          entries,
          ...(total !== undefined ? { total } : {}),
          ...(next ? { next_cursor: next } : {}),
        },
      };
    },
  });

  const recordEvents = tool({
    name: "heliyos_records_events",
    title: "Read a record's change history",
    description:
      "Returns the audit trail of one record: who changed what and when (people and workers), newest first, each with a " +
      "one-line change summary. Filter by operation type, event type, date range or text. \"detailed\" adds the paths of " +
      "the changed fields. Use heliyos_records_timeline instead for a narrative of the relationship. " +
      "Returns structuredContent {events:[{id, at, operation_type, actor, change_summary}], next_cursor}.",
    input: z.strictObject({
      record_id: hexId("record_id"),
      operation_types: z
        .array(z.enum(EVENT_OPERATION_TYPES))
        .min(1)
        .max(EVENT_OPERATION_TYPES.length)
        .optional()
        .describe("Only these operations: CREATE, UPDATE, DELETE."),
      event_types: z
        .array(z.enum(EVENT_TYPES))
        .min(1)
        .max(EVENT_TYPES.length)
        .optional()
        .describe("Only these event types: AUDIT (field changes), INTERACTION (emails, meetings), ENRICHMENT."),
      since: isoDate("since").optional(),
      until: isoDate("until").optional().describe("Only events at or before this date; a date alone includes that whole day (UTC)."),
      search: searchInput("the change summaries"),
      limit: pageLimit("Events"),
      cursor: cursorInput,
      response_format: responseFormat("one line per change", "the changed field paths too"),
    }),
    output: z.object({ events: z.array(eventOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const { data, meta } = await callOperation(client, "listRecordEvents", {
        params: { id: args.record_id },
        query: {
          limit: args.limit,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.operation_types ? { operationType: args.operation_types.join(",") } : {}),
          ...(args.event_types ? { eventType: args.event_types.join(",") } : {}),
          ...(args.since ? { startDate: args.since } : {}),
          ...(args.until ? { endDate: endOfDay(args.until) } : {}),
          ...(args.search ? { search: args.search } : {}),
        },
      });
      return eventListOutput(data, meta, args.response_format === "detailed", `record ${args.record_id}`, "heliyos_records_events");
    },
  });

  const interactions = tool({
    name: "heliyos_interactions_list",
    title: "List emails and meetings",
    description:
      "Lists synced emails and meetings, newest first, optionally only those linked to one record (record_id) or of one " +
      "channel. Each has its subject or title, time, AI summary and the records it is linked to. \"detailed\" adds " +
      "participants and next steps; heliyos_interactions_get returns one with its full summary. Order with `sort`. " +
      "Returns structuredContent {interactions:[{id, channel, title, at, summary, record_ids}], next_cursor}.",
    input: z.strictObject({
      record_id: hexId("record_id").optional().describe("Only interactions linked to this record (company, person or deal)."),
      channel: z.enum(["email", "meeting"]).optional().describe("Only emails or only meetings."),
      search: searchInput("subjects, titles and summaries"),
      sort: sortInput(
        INTERACTION_SORT_FIELDS,
        "last_message (newest email thread message), start_time (meeting start) or created_at (when it was synced)."
      ),
      limit: pageLimit("Interactions"),
      cursor: cursorInput,
      response_format: responseFormat(
        `subject, time and a summary cut at ${CONCISE_TEXT_CHARS} characters`,
        "the full summary, participants and next steps"
      ),
    }),
    output: z.object({ interactions: z.array(interactionOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const paging = pagedQuery(args, args.sort !== undefined);
      const filters = {
        ...(args.record_id ? { objectId: args.record_id } : {}),
        ...(args.channel ? { channelType: args.channel } : {}),
        ...(args.search ? { search: args.search } : {}),
        ...(args.sort ? { sort: [{ field: INTERACTION_SORT_FIELD[args.sort.field], direction: args.sort.direction }] } : {}),
      };
      const { data, meta } = await callOperation(client, "listInteractions", {
        query: { ...paging.query, ...(Object.keys(filters).length ? { filters: JSON.stringify(filters) } : {}) },
      });
      const detailed = args.response_format === "detailed";
      const items = expectArray(data, "interaction list")
        .filter(isRecord)
        .map((raw) => interactionOf(raw, detailed));
      const next = paging.next(meta);
      const blocks = items.map((i) => interactionLines(i, detailed));
      const list =
        items.length === 0
          ? "No emails or meetings matched."
          : fitBlocks(blocks, items.map((i) => i.id), LIST_BUDGET, {
              items: "interactions",
              key: "interactions",
              readHint: 'Repeat with a lower limit, or response_format "concise".',
            });
      return {
        text: `${plural(items.length, "interaction")}:\n${list}\n\n${pagingFooter("heliyos_interactions_list", next)}`,
        structuredContent: { interactions: items, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const interactionGet = tool({
    name: "heliyos_interactions_get",
    title: "Get an email or meeting",
    description:
      "Fetches one synced email thread or meeting by id (from heliyos_interactions_list or heliyos_records_timeline): " +
      "subject or title, time, the AI summary, sentiment, the records it is linked to, participants and next steps. " +
      "\"concise\" cuts the summary; \"detailed\" returns all of it. Returns structuredContent {interaction}.",
    input: z.strictObject({
      interaction_id: hexId("interaction_id"),
      response_format: responseFormat(
        `the summary cut at ${CONCISE_TEXT_CHARS} characters`,
        "the full summary, participants and next steps"
      ),
    }),
    output: z.object({ interaction: interactionOut }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "getInteraction", { params: { id: args.interaction_id } });
      const interaction = interactionOf(expectObject(data, "interaction"), true);
      const short = clipFor(args.response_format === "detailed");
      const out: InteractionOut = {
        ...interaction,
        ...(interaction.summary ? { summary: short(interaction.summary) } : {}),
        ...(interaction.next_steps ? { next_steps: short(interaction.next_steps) } : {}),
      };
      return { text: interactionLines(out, true), structuredContent: { interaction: out } };
    },
  });

  return [recordTimeline, recordEvents, interactions, interactionGet];
}
