/**
 * Notes: free-text notes, optionally linked to records. Five tools, one
 * operation each (listNotes, getNote, createNote, updateNote, deleteNote).
 */
import * as z from "zod/v4";
import { callOperation, expectArray } from "../client/operations.js";
import { clip, fitBlocks, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  cursorInput,
  day,
  DESTROYS,
  expectObject,
  hexId,
  label,
  linkOut,
  linksLine,
  linksOf,
  nextCursorOf,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  searchInput,
  stringOf,
  timestampsOf,
  UPDATES,
  type ToolContext,
  keysetListQuery,
  LIST_TRUNCATION_HINT,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";
import { linkedRecordIds, readRecordRefs } from "./records.js";

const LIST_PREVIEW_CHARS = 200;
const CONCISE_CONTENT_CHARS = 1500;
const MAX_CONTENT_CHARS = 100_000;

// ---------------------------------------------------------------- notes

const noteOut = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().optional().describe("Concise: cut (list: 200, get: 1500 characters); detailed: complete."),
  content_truncated: z.boolean().optional(),
  links: z.array(linkOut),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
type NoteOut = z.infer<typeof noteOut>;

function noteOf(data: unknown, contentChars: number | undefined): NoteOut {
  const raw = expectObject(data, "note");
  const content = typeof raw.content === "string" ? raw.content : "";
  const cut = contentChars !== undefined && content.length > contentChars;
  return {
    id: requireId(raw, "note"),
    title: typeof raw.title === "string" ? raw.title : "",
    ...(content ? { content: cut ? clip(content, contentChars!) : content } : {}),
    ...(cut ? { content_truncated: true } : {}),
    links: linksOf(raw.relationships),
    ...timestampsOf(raw),
  };
}

const noteHeading = (n: NoteOut) => `Note ${label({ id: n.id, name: n.title })}`;

const title = z.string().trim().max(500).describe("Note title.");
const content = z.string().max(MAX_CONTENT_CHARS).describe("Note body (plain text or simple HTML).");

/** Builds the tools that list, read, create, update and delete notes, from the shared tool context. */
export function noteTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_notes_list",
    title: "List notes",
    description:
      "Lists notes, newest first, optionally only those linked to one record (record_id) or matching text in the title or " +
      "body. Each note shows its id, title, a short preview and the records it is linked to. Use heliyos_notes_get for the " +
      "full text. Returns structuredContent {notes:[{id, title, content, links}], next_cursor}.",
    input: z.strictObject({
      record_id: hexId("record_id").optional().describe("Only notes linked to this record."),
      search: searchInput("note titles and bodies"),
      limit: pageLimit("Notes"),
      cursor: cursorInput,
      response_format: responseFormat(`a ${LIST_PREVIEW_CHARS}-character preview`, "each note's full text and times"),
    }),
    output: z.object({ notes: z.array(noteOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const filters = {
        ...(args.search ? { search: args.search } : {}),
        ...(args.record_id ? { relatedObjectId: args.record_id } : {}),
      };
      const { data, meta } = await callOperation(client, "listNotes", {
        query: keysetListQuery(args, filters),
      });
      const detailed = args.response_format === "detailed";
      const notes = expectArray(data, "note list").map((raw) => noteOf(raw, detailed ? undefined : LIST_PREVIEW_CHARS));
      const next = nextCursorOf(meta);
      const blocks = notes.map((n) =>
        [
          [noteHeading(n), day(n.updated_at ?? n.created_at)].filter(Boolean).join(" · "),
          n.content ? `  ${detailed ? n.content : n.content.replace(/\s+/g, " ")}` : "",
          n.links.length ? `  ${linksLine(n.links)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
      const body =
        notes.length === 0
          ? "No notes matched."
          : fitBlocks(blocks, notes.map((n) => n.id), MAX_TEXT_CHARS - 600, {
              items: "notes",
              key: "notes",
              readHint: "Read them with heliyos_notes_get.",
            });
      return {
        text: `${plural(notes.length, "note")}:\n${body}\n\n${pagingFooter("heliyos_notes_list", next)}`,
        structuredContent: { notes, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const get = tool({
    name: "heliyos_notes_get",
    title: "Get a note",
    description:
      "Fetches one note by id with its title, text and linked records. \"concise\" cuts the text at " +
      `${CONCISE_CONTENT_CHARS} characters; "detailed" returns all of it plus created and updated times. ` +
      "Returns structuredContent {note}.",
    input: z.strictObject({
      note_id: hexId("note_id"),
      response_format: responseFormat(`the text cut at ${CONCISE_CONTENT_CHARS} characters`, "the full text and times"),
    }),
    output: z.object({ note: noteOut }),
    annotations: READ_ONLY,
    truncationHint: 'The note is longer than this result allows; use response_format "concise" for its start.',
    async handler(args) {
      const { data } = await callOperation(client, "getNote", { params: { id: args.note_id } });
      const detailed = args.response_format === "detailed";
      const note = noteOf(data, detailed ? undefined : CONCISE_CONTENT_CHARS);
      const head = [
        noteHeading(note),
        linksLine(note.links),
        detailed ? renderRecord({ created_at: note.created_at, updated_at: note.updated_at }) : "",
      ]
        .filter(Boolean)
        .join("\n");
      const cutNote = note.content_truncated ? '\n\n(Text cut; response_format "detailed" returns all of it.)' : "";
      const text = `${head}\n\n${note.content ?? "(no text)"}${cutNote}`;
      return { text, structuredContent: { note } };
    },
  });

  const create = tool({
    name: "heliyos_notes_create",
    title: "Create a note",
    description:
      "Creates a note, optionally linked to records (a company, person or deal) so it shows on them and can trigger " +
      "workers. Calling it twice creates two notes. Returns the new note's id as structuredContent {note}.",
    input: z.strictObject({
      title: title.min(1),
      content: content.optional(),
      record_ids: linkedRecordIds("note").optional(),
    }),
    output: z.object({ note: noteOut }),
    annotations: CREATES,
    async handler(args) {
      const relationships = args.record_ids ? await readRecordRefs(client, args.record_ids) : undefined;
      const { data } = await callOperation(client, "createNote", {
        body: {
          title: args.title,
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(relationships ? { relationships } : {}),
        },
      });
      const note = noteOf(data, LIST_PREVIEW_CHARS);
      return {
        text: [`Created ${noteHeading(note)}.`, linksLine(note.links)].filter(Boolean).join("\n"),
        structuredContent: { note },
      };
    },
  });

  const update = tool({
    name: "heliyos_notes_update",
    title: "Update a note",
    description:
      "Changes a note's title, text or linked records by id; what you leave out is kept. record_ids REPLACES the note's " +
      "links (pass every record it should stay linked to). Returns structuredContent {note}.",
    input: z
      .strictObject({
        note_id: hexId("note_id"),
        title: title.min(1).optional(),
        content: content.optional(),
        record_ids: linkedRecordIds("note").optional(),
      })
      .refine((v) => v.title !== undefined || v.content !== undefined || v.record_ids !== undefined, {
        message: "Give at least one of title, content or record_ids",
      }),
    output: z.object({ note: noteOut }),
    annotations: UPDATES,
    async handler(args) {
      const relationships = args.record_ids ? await readRecordRefs(client, args.record_ids) : undefined;
      const { data } = await callOperation(client, "updateNote", {
        params: { id: args.note_id },
        body: {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(relationships ? { relationships } : {}),
        },
      });
      const note = noteOf(data, LIST_PREVIEW_CHARS);
      const changed = ["title", "content", "record_ids"].filter((k) => (args as Record<string, unknown>)[k] !== undefined);
      return {
        text: [`Updated ${noteHeading(note)}: ${changed.join(", ")}.`, linksLine(note.links)].filter(Boolean).join("\n"),
        structuredContent: { note },
      };
    },
  });

  const remove = tool({
    name: "heliyos_notes_delete",
    title: "Delete a note",
    description:
      "Permanently deletes one note by id. This cannot be undone: confirm with the user first. " +
      "Returns structuredContent {note_id, deleted}.",
    input: z.strictObject({ note_id: hexId("note_id") }),
    output: z.object({ note_id: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      await callOperation(client, "deleteNote", { params: { id: args.note_id } });
      return {
        text: `Deleted note ${args.note_id}.`,
        structuredContent: { note_id: args.note_id, deleted: true },
      };
    },
  });

  return [list, get, create, update, remove];
}
