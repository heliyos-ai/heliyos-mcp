/**
 * Labels: the classification label groups the workers use to tag emails and
 * meetings (for example Intent: Pricing, Support). Four tools over the
 * classification-labels operations.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { fitBlocks, MAX_TEXT_CHARS } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  cursorInput,
  DESTROYS,
  expectObject,
  hexId,
  idOf,
  label,
  newHexId,
  nextCursorOf,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  searchInput,
  stringOf,
  REPLACES,
  type ToolContext,
  LIST_TRUNCATION_HINT,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

const labelOut = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  is_active: z.boolean().describe("Inactive groups are not applied by the workers."),
  values: z.array(z.object({ id: z.string(), name: z.string() })).describe("The labels in this group."),
});
type LabelOut = z.infer<typeof labelOut>;

function labelOf(data: unknown, withDescription: boolean): LabelOut {
  const raw = expectObject(data, "label group");
  const description = stringOf(raw.description);
  const values = (Array.isArray(raw.labels) ? raw.labels : []).filter(isRecord).flatMap((v) => {
    const id = idOf(v._id) ?? idOf(v.id);
    const name = stringOf(v.name);
    return id && name ? [{ id, name }] : [];
  });
  return {
    id: requireId(raw, "label group"),
    name: stringOf(raw.name) ?? "",
    ...(withDescription && description ? { description } : {}),
    is_active: raw.isActive !== false,
    values,
  };
}

const labelLine = (l: LabelOut) =>
  [
    `${label(l)}${l.is_active ? "" : " (inactive)"}: ${
      l.values.map((v) => `${v.name} (id ${v.id})`).join(", ") || "no values"
    }`,
    l.description ? `  ${l.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/** Value names must be unique within a group (case-insensitive), as the platform requires. */
function assertUniqueNames(names: readonly string[]): void {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) dupes.push(`${seen.get(key)} / ${name}`);
    else seen.set(key, name);
  }
  if (dupes.length) {
    throw new HeliyosApiError("VALIDATION_FAILED", `Value names must be unique within a group: ${dupes.join(", ")}`, 0);
  }
}

const nameInput = z.string().trim().min(1).max(200).describe("Group name, for example Intent.");
const descriptionInput = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe("What the group classifies; the workers read it to decide which value applies.");
const valueName = z.string().trim().min(1).max(100);

/** Builds the tools that list, create, update and delete labels, from the shared tool context. */
export function labelTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_labels_list",
    title: "List label groups",
    description:
      "Lists the workspace's classification label groups (for example Intent with values Pricing and Support) that the " +
      "workers apply to emails and meetings, with each group's id, active flag and values (each with its id). " +
      "Returns structuredContent {labels:[{id, name, is_active, values:[{id, name}]}], next_cursor}.",
    input: z.strictObject({
      is_active: z.boolean().optional().describe("Only active (true) or only inactive (false) groups."),
      search: searchInput("group names"),
      limit: pageLimit("Groups"),
      cursor: cursorInput,
      response_format: responseFormat("names and values", "each group's description too"),
    }),
    output: z.object({ labels: z.array(labelOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const { data, meta } = await callOperation(client, "listClassificationLabels", {
        query: {
          limit: args.limit,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.search ? { search: args.search } : {}),
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
        },
      });
      const detailed = args.response_format === "detailed";
      const labels = expectArray(data, "label group list").map((raw) => labelOf(raw, detailed));
      const next = nextCursorOf(meta);
      const body =
        labels.length === 0
          ? "No label groups matched."
          : fitBlocks(labels.map(labelLine), labels.map((l) => l.id), MAX_TEXT_CHARS - 600, {
              items: "label groups",
              key: "labels",
              readHint: "Repeat with a lower limit.",
            });
      return {
        text: `${plural(labels.length, "label group")}:\n${body}\n\n${pagingFooter("heliyos_labels_list", next)}`,
        structuredContent: { labels, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const create = tool({
    name: "heliyos_labels_create",
    title: "Create a label group",
    description:
      "Creates a classification label group with its values, for example name Intent, values [Pricing, Support]. The " +
      "workers start applying it to new emails and meetings when it is active. Calling it twice creates two groups; check " +
      "heliyos_labels_list first. Returns structuredContent {label}.",
    input: z.strictObject({
      name: nameInput,
      description: descriptionInput,
      values: z.array(valueName).max(100).optional().describe("Value names, unique within the group."),
      is_active: z.boolean().optional().describe("Default true."),
    }),
    output: z.object({ label: labelOut }),
    annotations: CREATES,
    async handler(args) {
      if (args.values) assertUniqueNames(args.values);
      const { data } = await callOperation(client, "createClassificationLabels", {
        body: {
          name: args.name,
          description: args.description,
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
          ...(args.values ? { labels: args.values.map((name) => ({ _id: newHexId(), name })) } : {}),
        },
      });
      const created = labelOf(data, true);
      return { text: `Created label group ${labelLine(created)}`, structuredContent: { label: created } };
    },
  });

  const update = tool({
    name: "heliyos_labels_update",
    title: "Update a label group",
    description:
      "Changes a label group's name, description, active flag or values by label_id. `values` REPLACES the group's " +
      "values: to keep a value, pass it with its existing id (shown as \"Name (id …)\" by heliyos_labels_list); a value " +
      "without an id is created as a NEW value, even if its name matches an existing one. Values left out are removed, " +
      "and emails and meetings already classified with them lose that label. Returns structuredContent {label}.",
    input: z
      .strictObject({
        label_id: hexId("label_id"),
        name: nameInput.optional(),
        description: descriptionInput.optional(),
        is_active: z.boolean().optional().describe("true to let the workers apply the group, false to pause it without deleting it."),
        values: z
          .array(
            z.strictObject({
              id: z
                .string()
                .trim()
                .min(1)
                .max(100)
                .optional()
                .describe("The existing value's id, to keep it. Omitting it creates a new value with a new id."),
              name: valueName.describe("The value's name, unique within the group."),
            })
          )
          .max(100)
          .optional()
          .describe("The complete list of values the group should have afterwards; it replaces the current values."),
      })
      .refine(
        (v) => v.name !== undefined || v.description !== undefined || v.is_active !== undefined || v.values !== undefined,
        { message: "Give at least one of name, description, is_active or values" }
      ),
    output: z.object({ label: labelOut }),
    // values replaces the set and strips a removed value from classified emails and meetings.
    annotations: REPLACES,
    async handler(args) {
      if (args.values) assertUniqueNames(args.values.map((v) => v.name));
      const { data } = await callOperation(client, "updateClassificationLabels", {
        params: { id: args.label_id },
        body: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
          ...(args.values ? { labels: args.values.map((v) => ({ _id: v.id ?? newHexId(), name: v.name })) } : {}),
        },
      });
      const updated = labelOf(data, true);
      return { text: `Updated label group ${labelLine(updated)}`, structuredContent: { label: updated } };
    },
  });

  const remove = tool({
    name: "heliyos_labels_delete",
    title: "Delete a label group",
    description:
      "Permanently deletes a label group and its values by id. This cannot be undone: confirm with the user first. To stop " +
      "the workers applying it but keep it, use heliyos_labels_update with is_active false. " +
      "Returns structuredContent {label_id, deleted}.",
    input: z.strictObject({ label_id: hexId("label_id") }),
    output: z.object({ label_id: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      await callOperation(client, "deleteClassificationLabels", { params: { id: args.label_id } });
      return {
        text: `Deleted label group ${args.label_id}.`,
        structuredContent: { label_id: args.label_id, deleted: true },
      };
    },
  });

  return [list, create, update, remove];
}
