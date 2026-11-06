/**
 * Knowledge base: what the workers know about the business. The text lives on
 * the organization in the auth service (getCurrentOrganization /
 * updateCurrentOrganization): four fixed fields (products, pain points, value
 * proposition, qualification criteria), the business context, and custom
 * entries (label + content), the same endpoints the web app's Knowledge base
 * settings use. Knowledge-base files are attachments: heliyos_files_* with
 * kind knowledge_base.
 *
 * The update endpoint replaces the whole `knowledgeBase` object, so every
 * write here reads the current one first and sends it back merged: a change
 * to one field never drops another, and an entry edit never drops its siblings.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation } from "../client/operations.js";
import { clip } from "../format/text.js";
import { isRecord } from "../util.js";
import { DESTROYS, expectObject, plural, READ_ONLY, responseFormat, stringOf, UPDATES, type ToolContext } from "./common.js";
import { tool, type ToolSpec } from "./define.js";

const CONCISE_TEXT_CHARS = 1500;
const MAX_TEXT = 100_000;
const MAX_ENTRIES = 200;

/** The fixed fields, tool name → API key, in the order the web app shows them. */
const FIELDS = {
  products_information: "productsInformation",
  pain_points: "painPoints",
  value_proposition: "valueProposition",
  qualification_criteria: "qualificationCriteria",
} as const;
type FieldKey = keyof typeof FIELDS;
const FIELD_KEYS = Object.keys(FIELDS) as FieldKey[];

// ---------------------------------------------------------------- shapes

const entryOut = z.object({
  label: z.string(),
  content: z.string().describe("Plain text or HTML, as the web app stores it; cut in concise."),
});
type EntryOut = z.infer<typeof entryOut>;

const knowledgeOut = z.object({
  business_context: z.string().optional().describe("What the business does, in the team's words."),
  products_information: z.string().optional(),
  pain_points: z.string().optional().describe("The customer problems the products solve."),
  value_proposition: z.string().optional(),
  qualification_criteria: z.string().optional().describe("What makes a lead worth pursuing."),
  entries: z.array(entryOut).describe("Custom knowledge entries the team added."),
});
type KnowledgeOut = z.infer<typeof knowledgeOut>;

/** The organization as the auth service stores it: the knowledgeBase object and businessContext. */
interface StoredKnowledge {
  knowledgeBase: Record<string, unknown>;
  entries: EntryOut[];
  businessContext: string | undefined;
}

function entriesOf(raw: unknown): EntryOut[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((e) => {
    const label = stringOf(e.label)?.trim();
    return label ? [{ label, content: typeof e.content === "string" ? e.content : "" }] : [];
  });
}

async function readKnowledge(client: ToolContext["client"]): Promise<StoredKnowledge> {
  const { data } = await callOperation(client, "getCurrentOrganization");
  const org = expectObject(data, "organization");
  const knowledgeBase = isRecord(org.knowledgeBase) ? org.knowledgeBase : {};
  return { knowledgeBase, entries: entriesOf(knowledgeBase.entries), businessContext: stringOf(org.businessContext) };
}

function knowledgeOf(stored: StoredKnowledge, detailed: boolean): KnowledgeOut {
  const short = (text: string | undefined) => (text === undefined ? undefined : detailed ? text : clip(text, CONCISE_TEXT_CHARS));
  const out: KnowledgeOut = { entries: stored.entries.map((e) => ({ label: e.label, content: short(e.content) ?? "" })) };
  const context = short(stored.businessContext);
  if (context) out.business_context = context;
  for (const key of FIELD_KEYS) {
    const value = short(stringOf(stored.knowledgeBase[FIELDS[key]]));
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Writes the knowledge base back whole (the endpoint replaces the object):
 * the current fields, with `fields` changed, and `entries` as given. Keys the
 * tool does not know are kept, as the web app keeps them.
 */
async function writeKnowledge(
  client: ToolContext["client"],
  stored: StoredKnowledge,
  changes: { fields?: Partial<Record<FieldKey, string>>; businessContext?: string; entries?: EntryOut[] }
): Promise<void> {
  const knowledgeBase: Record<string, unknown> = { ...stored.knowledgeBase };
  for (const key of FIELD_KEYS) {
    const value = changes.fields?.[key];
    if (value !== undefined) knowledgeBase[FIELDS[key]] = value;
  }
  knowledgeBase.entries = (changes.entries ?? stored.entries).map(({ label, content }) => ({ label, content }));
  await callOperation(client, "updateCurrentOrganization", {
    body: { knowledgeBase, ...(changes.businessContext !== undefined ? { businessContext: changes.businessContext } : {}) },
  });
}

function knowledgeText(k: KnowledgeOut): string {
  const sections = [
    k.business_context ? `Business context:\n${k.business_context}` : "Business context: (empty)",
    ...FIELD_KEYS.map((key) => `${key.replace(/_/g, " ")}:\n${k[key] ?? "(empty)"}`),
    k.entries.length
      ? `${plural(k.entries.length, "custom entry", "custom entries")}:\n${k.entries.map((e) => `- ${e.label}: ${e.content || "(empty)"}`).join("\n")}`
      : "No custom entries.",
  ];
  return sections.join("\n\n");
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------------------------------------------------------------- inputs

const textInput = (what: string) => z.string().max(MAX_TEXT).describe(`${what}, plain text or Markdown. An empty string clears it.`);
const labelInput = z.string().trim().min(1).max(200).describe("The entry's label; matched case-insensitively against the existing entries.");

// ---------------------------------------------------------------- tools

/** Builds the tools that read and update the knowledge base and set or delete its entries, from the shared tool context. */
export function knowledgeTools({ client }: ToolContext): ToolSpec[] {
  const get = tool({
    name: "heliyos_knowledge_get",
    title: "Read the knowledge base",
    description:
      "Returns what the workers know about the business: the business context, products information, pain points, value " +
      "proposition and qualification criteria, and the team's custom entries (label and content). Texts are cut at " +
      `${CONCISE_TEXT_CHARS} characters in concise. Knowledge-base files are listed with heliyos_files_list kind ` +
      "knowledge_base. Returns structuredContent {knowledge:{business_context, products_information, ..., entries}}.",
    input: z.strictObject({
      response_format: responseFormat("each text shortened", "every text in full"),
    }),
    output: z.object({ knowledge: knowledgeOut }),
    annotations: READ_ONLY,
    truncationHint: 'Use response_format "concise".',
    async handler(args) {
      const knowledge = knowledgeOf(await readKnowledge(client), args.response_format === "detailed");
      return {
        text: `${knowledgeText(knowledge)}\n\nFiles the workers read: heliyos_files_list with kind "knowledge_base".`,
        structuredContent: { knowledge },
      };
    },
  });

  const update = tool({
    name: "heliyos_knowledge_update",
    title: "Update the knowledge base",
    description:
      "Changes the knowledge base's fixed texts: business_context, products_information, pain_points, value_proposition " +
      "and qualification_criteria. What you leave out is kept, and the custom entries are untouched (use " +
      "heliyos_knowledge_entries_set for those). Each text replaces the current one whole, so read it with " +
      "heliyos_knowledge_get first when you mean to add to it. The workers read these on their next run. Returns " +
      "structuredContent {knowledge}.",
    input: z
      .strictObject({
        business_context: textInput("What the business does").optional(),
        products_information: textInput("The products and services").optional(),
        pain_points: textInput("The customer problems the products solve").optional(),
        value_proposition: textInput("Why customers choose these products").optional(),
        qualification_criteria: textInput("What makes a lead worth pursuing").optional(),
      })
      .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Give at least one text to change" }),
    output: z.object({ knowledge: knowledgeOut }),
    annotations: UPDATES,
    async handler(args) {
      const stored = await readKnowledge(client);
      const { business_context, ...fields } = args;
      await writeKnowledge(client, stored, { fields, businessContext: business_context });
      const knowledge = knowledgeOf(await readKnowledge(client), false);
      const changed = Object.entries(args)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k} (${(v as string).length === 0 ? "cleared" : `${(v as string).length} chars`})`);
      return { text: `Updated knowledge base: ${changed.join(", ")}.\n\n${knowledgeText(knowledge)}`, structuredContent: { knowledge } };
    },
  });

  const entriesSet = tool({
    name: "heliyos_knowledge_entries_set",
    title: "Add or change a knowledge entry",
    description:
      "Adds a custom knowledge entry (a label and its content) or replaces the content of the entry with that label. " +
      "Other entries and the fixed texts are kept. Use it for facts the fixed texts do not cover, for example " +
      "\"Pricing\" or \"Competitors\". Remove one with heliyos_knowledge_entries_delete. Returns structuredContent " +
      "{entry, created, entries}.",
    input: z.strictObject({
      label: labelInput,
      content: z.string().max(MAX_TEXT).describe("The entry's content, plain text or HTML (the web app shows it as rich text). Replaces the current content."),
    }),
    output: z.object({ entry: entryOut, created: z.boolean(), entries: z.array(entryOut) }),
    annotations: UPDATES,
    async handler(args) {
      const stored = await readKnowledge(client);
      const index = stored.entries.findIndex((e) => sameLabel(e.label, args.label));
      const created = index === -1;
      if (created && stored.entries.length >= MAX_ENTRIES) {
        throw new HeliyosApiError("VALIDATION_FAILED", `The knowledge base already has ${MAX_ENTRIES} entries; delete one first`, 0);
      }
      const entry = { label: created ? args.label : stored.entries[index]!.label, content: args.content };
      const entries = created ? [...stored.entries, entry] : stored.entries.map((e, i) => (i === index ? entry : e));
      await writeKnowledge(client, stored, { entries });
      const short = entries.map((e) => ({ label: e.label, content: clip(e.content, CONCISE_TEXT_CHARS) }));
      return {
        text: `${created ? "Added" : "Updated"} entry "${entry.label}" (${entry.content.length} chars). ${plural(entries.length, "entry", "entries")} now: ${entries.map((e) => e.label).join(", ")}.`,
        structuredContent: { entry: { label: entry.label, content: clip(entry.content, CONCISE_TEXT_CHARS) }, created, entries: short },
      };
    },
  });

  const entriesDelete = tool({
    name: "heliyos_knowledge_entries_delete",
    title: "Delete a knowledge entry",
    description:
      "Removes one custom knowledge entry by label. The fixed texts and other entries are kept. This cannot be undone: " +
      "confirm with the user first. Returns structuredContent {label, deleted, entries}.",
    input: z.strictObject({ label: labelInput }),
    output: z.object({ label: z.string(), deleted: z.boolean(), entries: z.array(entryOut) }),
    annotations: DESTROYS,
    async handler(args) {
      const stored = await readKnowledge(client);
      const target = stored.entries.find((e) => sameLabel(e.label, args.label));
      if (!target) {
        const known = stored.entries.map((e) => `"${e.label}"`).join(", ");
        throw new HeliyosApiError("NOT_FOUND", `No knowledge entry labelled "${args.label}". ${known ? `Known entries: ${known}` : "There are no entries."}`, 0);
      }
      const entries = stored.entries.filter((e) => e !== target);
      await writeKnowledge(client, stored, { entries });
      return {
        text: `Deleted entry "${target.label}". ${entries.length ? `Remaining: ${entries.map((e) => e.label).join(", ")}.` : "No entries remain."}`,
        structuredContent: { label: target.label, deleted: true, entries: entries.map((e) => ({ label: e.label, content: clip(e.content, CONCISE_TEXT_CHARS) })) },
      };
    },
  });

  return [get, update, entriesSet, entriesDelete];
}
