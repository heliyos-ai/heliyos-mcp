/**
 * Fields: the columns of an object (company, person, deal or custom object).
 * heliyos_objects_get reads them; these three tools create, change and delete
 * one. Relationship fields link two objects and are created in the web app.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation } from "../client/operations.js";
import { renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  DESTROYS,
  expectObject,
  hexId,
  idOf,
  numberOf,
  REPLACES,
  stringOf,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";
import { objectType, schemaId } from "./records.js";

/** Field types a tool can create, and the platform's type object for each (as the web app sends it). */
export const FIELD_TYPES = [
  "text",
  "richText",
  "number",
  "currency",
  "rating",
  "checkbox",
  "date",
  "timestamp",
  "select",
  "multiSelect",
  "url",
  "email",
  "phone",
  "user",
  "image",
  "file",
] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const TYPE_OBJECT: Record<FieldType, { type: string; enum: string[] }> = {
  text: { type: "text", enum: ["text", "richText"] },
  richText: { type: "richText", enum: ["richText", "text"] },
  number: { type: "number", enum: ["number"] },
  currency: { type: "currency", enum: ["number"] },
  rating: { type: "rating", enum: ["number"] },
  checkbox: { type: "checkbox", enum: ["boolean"] },
  date: { type: "date", enum: ["date", "timestamp"] },
  timestamp: { type: "timestamp", enum: ["timestamp", "date"] },
  select: { type: "select", enum: ["select"] },
  multiSelect: { type: "multiSelect", enum: ["multiSelect"] },
  url: { type: "url", enum: ["text"] },
  email: { type: "email", enum: ["text"] },
  phone: { type: "phone", enum: ["text"] },
  user: { type: "user", enum: ["user"] },
  image: { type: "image", enum: ["text"] },
  file: { type: "file", enum: ["file"] },
};

const OPTION_TYPES: readonly FieldType[] = ["select", "multiSelect"];
/** Types the platform can fill from an AI prompt (the web app's aiEnabledTypes). */
const AI_TYPES: readonly FieldType[] = ["text", "richText", "number", "date", "multiSelect", "select", "checkbox"];

/** Every role may read and edit a new field; the web app's default. */
const DEFAULT_PERMISSIONS = (visibility: "organization" | "private") => {
  const roles = ["SUPER_ADMIN", "STAFF", "SUPPORT", "ADMIN", "OWNER", "MEMBER", "AGENCY"];
  return { visibility, viewableBy: { roles, users: [] }, editableBy: { roles, users: [] } };
};

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

/** The key the web app would derive from a label: lowercase, words joined by underscores. */
export const keyOf = (labelText: string) =>
  labelText
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");

// ---------------------------------------------------------------- shapes

const fieldShortOut = z.object({
  field_id: z.string(),
  key: z.string().describe("The key to use in record `fields` and list filters."),
  label: z.string().optional(),
  type: z.string(),
  options: z.array(z.string()).optional().describe("select and multiSelect only."),
});
type FieldShort = z.infer<typeof fieldShortOut>;

const optionNames = (settings: unknown): string[] =>
  isRecord(settings) && Array.isArray(settings.selectOptions)
    ? settings.selectOptions.map((o) => (isRecord(o) ? stringOf(o.value) : stringOf(o)) ?? "").filter(Boolean)
    : [];

function fieldShortOf(raw: Record<string, unknown>): FieldShort {
  const id = idOf(raw.id) ?? idOf(raw._id);
  const key = stringOf(raw.name);
  if (!id || !key) throw new HeliyosApiError("INTERNAL", "The API returned a field without an id or key", 0);
  const labelText = stringOf(raw.displayName);
  const options = optionNames(raw.settings);
  return {
    field_id: id,
    key,
    ...(labelText ? { label: labelText } : {}),
    type: (isRecord(raw.type) ? stringOf(raw.type.type) : stringOf(raw.type)) ?? "unknown",
    ...(options.length ? { options } : {}),
  };
}

const fieldLine = (f: FieldShort) =>
  `${f.key} (field_id ${f.field_id}, ${f.type}${f.label ? `, label "${f.label}"` : ""}${f.options ? `, options ${f.options.join(" / ")}` : ""})`;

// ---------------------------------------------------------------- inputs

const labelInput = z.string().trim().min(1).max(100).describe('Display name, for example "Contract value".');
const descriptionInput = z.string().trim().max(1000).describe("What the field holds; shown in the web app and read by the workers.");
const optionsInput = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(200)
  .describe("Allowed values of a select or multiSelect field, unique.");
const aiPromptInput = z
  .string()
  .trim()
  .min(1)
  .max(5000)
  .describe(
    "Makes this an AI column: the workers fill it from this prompt (text, richText, number, date, select, multiSelect or " +
      "checkbox only). Filling existing records is started from the Heliyos web app and uses credits."
  );

function assertUniqueOptions(options: readonly string[]): void {
  const seen = new Set<string>();
  for (const o of options) {
    const k = o.toLowerCase();
    if (seen.has(k)) throw new HeliyosApiError("VALIDATION_FAILED", `options must be unique; "${o}" repeats`, 0);
    seen.add(k);
  }
}

// ---------------------------------------------------------------- tools

/** Builds the tools that create, update and delete the fields of an object, from the shared tool context. */
export function fieldTools({ client, schemas }: ToolContext): ToolSpec[] {
  /** The object's current fields from the API (not the cache), keyed by id. */
  const loadFields = async (schemaIdValue: string) => {
    const { data } = await callOperation(client, "getBaseSchema", { params: { id: schemaIdValue } });
    const raw = expectObject(data, "object schema");
    const list = (Array.isArray(raw.fields) ? raw.fields : []).filter(isRecord);
    return { name: stringOf(raw.name) ?? "", fields: list };
  };

  const findField = (fields: Record<string, unknown>[], fieldId: string, objectName: string) => {
    const field = fields.find((f) => (idOf(f.id) ?? idOf(f._id)) === fieldId);
    if (!field) {
      const known = fields.map((f) => `${stringOf(f.name)} (${idOf(f.id) ?? idOf(f._id)})`).join(", ");
      throw new HeliyosApiError(
        "NOT_FOUND",
        `No field with field_id ${fieldId} on ${objectName}. Its fields: ${known || "none"}. heliyos_objects_get lists them.`,
        0
      );
    }
    return field;
  };

  const create = tool({
    name: "heliyos_fields_create",
    title: "Add a field to an object",
    description:
      "Adds one field (column) to an object: companies, people, deals or a custom object (object_type, plus schema_id for " +
      "custom). Give it a label and a type; select and multiSelect need `options`; `ai_prompt` makes it an AI column. The " +
      "field key (what record `fields` and filters use) is derived from the label unless `key` is given, and must be new " +
      "on the object. Relationship fields are created in the Heliyos web app. Calling this twice with the same key fails. " +
      "Returns structuredContent {field:{field_id, key, label, type}}.",
    input: z
      .strictObject({
        object_type: objectType,
        schema_id: schemaId,
        label: labelInput,
        key: z
          .string()
          .regex(KEY_PATTERN, "key must be lowercase letters, digits and underscores, starting with a letter, up to 60 characters")
          .optional()
          .describe("Field key, for example contract_value. Derived from the label when omitted."),
        type: z.enum(FIELD_TYPES).describe(`One of ${FIELD_TYPES.join(", ")}.`),
        description: descriptionInput.optional(),
        options: optionsInput.optional(),
        required: z.boolean().optional().describe("Records must have a value. Default false."),
        hidden: z.boolean().optional().describe("Hidden from the web app's tables by default. Default false."),
        visibility: z
          .enum(["organization", "private"])
          .default("organization")
          .describe('"organization" (default): every member sees it; "private": only owners and admins.'),
        ai_prompt: aiPromptInput.optional(),
      })
      .refine((v) => !OPTION_TYPES.includes(v.type) || (v.options?.length ?? 0) > 0, {
        message: "select and multiSelect fields need options",
      })
      .refine((v) => OPTION_TYPES.includes(v.type) || v.options === undefined, {
        message: "options only apply to select and multiSelect fields",
      })
      .refine((v) => v.ai_prompt === undefined || AI_TYPES.includes(v.type), {
        message: `ai_prompt only applies to ${AI_TYPES.join(", ")} fields`,
      }),
    output: z.object({ field: fieldShortOut }),
    annotations: CREATES,
    async handler(args) {
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      const key = args.key ?? keyOf(args.label);
      if (!KEY_PATTERN.test(key)) {
        throw new HeliyosApiError("VALIDATION_FAILED", `Could not derive a field key from label "${args.label}"; pass key explicitly`, 0);
      }
      if (args.options) assertUniqueOptions(args.options);
      const { name, fields } = await loadFields(schema.id);
      if (fields.some((f) => stringOf(f.name) === key)) {
        throw new HeliyosApiError("CONFLICT", `${name} already has a field with key ${key}; pick another key or label`, 0);
      }
      const lastSequence = Math.max(0, ...fields.map((f) => numberOf(f.sequence) ?? 0));
      const { data } = await callOperation(client, "createBaseSchemaField", {
        params: { id: schema.id },
        body: {
          sequence: lastSequence + 1,
          name: key,
          displayName: args.label,
          ...(args.description ? { description: args.description } : {}),
          type: TYPE_OBJECT[args.type],
          ...(args.options ? { settings: { selectOptions: args.options } } : {}),
          isAIEnabled: args.ai_prompt !== undefined,
          ...(args.ai_prompt !== undefined ? { aiPrompt: { prompt: args.ai_prompt, variables: [] } } : {}),
          isHiddenField: args.hidden === true,
          required: args.required === true,
          permissions: DEFAULT_PERMISSIONS(args.visibility),
          runImmediately: false,
        },
      });
      schemas.invalidate();
      const raw = expectObject(data, "field");
      // The platform returns the new field; tolerate a whole schema too.
      const created = Array.isArray(raw.fields)
        ? (raw.fields.filter(isRecord).find((f) => stringOf(f.name) === key) ?? raw)
        : raw;
      const field = fieldShortOf(created);
      return {
        text: `Added field ${fieldLine(field)} to ${name}. Use key ${field.key} in heliyos_records_create / _update fields.`,
        structuredContent: { field },
      };
    },
  });

  const update = tool({
    name: "heliyos_fields_update",
    title: "Change a field",
    description:
      "Changes one field of an object by field_id (from heliyos_objects_get): its label, description, options, required " +
      "or hidden flag, AI prompt, or type. What you leave out is kept. `options` REPLACES the allowed values, and records " +
      "holding a removed value keep it as stale text. A type change is refused by the platform when existing values do " +
      "not fit the new type. The field key never changes. Returns structuredContent {field}.",
    input: z
      .strictObject({
        object_type: objectType,
        schema_id: schemaId,
        field_id: hexId("field_id"),
        label: labelInput.optional(),
        description: descriptionInput.optional(),
        type: z.enum(FIELD_TYPES).optional().describe("New type; values must fit it."),
        options: optionsInput.optional(),
        required: z.boolean().optional().describe("true: records must have a value."),
        hidden: z.boolean().optional().describe("true: hidden from the web app's tables by default."),
        ai_prompt: aiPromptInput.optional(),
      })
      .refine(
        (v) =>
          [v.label, v.description, v.type, v.options, v.required, v.hidden, v.ai_prompt].some((x) => x !== undefined),
        { message: "Give at least one of label, description, type, options, required, hidden or ai_prompt" }
      ),
    output: z.object({ field: fieldShortOut }),
    annotations: REPLACES,
    async handler(args) {
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      const { name, fields } = await loadFields(schema.id);
      const current = fieldShortOf(findField(fields, args.field_id, name));
      const type = args.type ?? (current.type as FieldType);
      if (args.options) {
        if (!OPTION_TYPES.includes(type)) {
          throw new HeliyosApiError("VALIDATION_FAILED", `options only apply to select and multiSelect fields; ${current.key} is ${type}`, 0);
        }
        assertUniqueOptions(args.options);
      }
      if (args.ai_prompt !== undefined && !AI_TYPES.includes(type)) {
        throw new HeliyosApiError("VALIDATION_FAILED", `ai_prompt only applies to ${AI_TYPES.join(", ")} fields; ${current.key} is ${type}`, 0);
      }
      const { data } = await callOperation(client, "updateBaseSchemaField", {
        params: { id: schema.id, fieldId: args.field_id },
        body: {
          ...(args.label !== undefined ? { displayName: args.label } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.type !== undefined ? { type: TYPE_OBJECT[args.type] } : {}),
          ...(args.options ? { settings: { selectOptions: args.options } } : {}),
          ...(args.required !== undefined ? { required: args.required } : {}),
          ...(args.hidden !== undefined ? { isHiddenField: args.hidden } : {}),
          ...(args.ai_prompt !== undefined ? { isAIEnabled: true, aiPrompt: { prompt: args.ai_prompt, variables: [] } } : {}),
        },
      });
      schemas.invalidate();
      const raw = expectObject(data, "field");
      const updated = Array.isArray(raw.fields)
        ? (raw.fields.filter(isRecord).find((f) => (idOf(f.id) ?? idOf(f._id)) === args.field_id) ?? raw)
        : raw;
      const field = stringOf(updated.name) ? fieldShortOf(updated) : { ...current, ...(args.label ? { label: args.label } : {}), ...(args.options ? { options: args.options } : {}), ...(args.type ? { type: args.type } : {}) };
      const changes = Object.fromEntries(
        Object.entries({ label: args.label, description: args.description, type: args.type, options: args.options, required: args.required, hidden: args.hidden, ai_prompt: args.ai_prompt }).filter(([, v]) => v !== undefined)
      );
      return {
        text: [`Updated field ${fieldLine(field)} on ${name}.`, renderRecord(changes)].join("\n"),
        structuredContent: { field },
      };
    },
  });

  const remove = tool({
    name: "heliyos_fields_delete",
    title: "Delete a field",
    description:
      "Permanently deletes one field of an object by field_id (from heliyos_objects_get) AND its value on every record. " +
      "This cannot be undone: confirm with the user first, naming the field and the object. Built-in required fields " +
      "(for example a company's name) are refused by the platform. Returns structuredContent {field_id, key, deleted}.",
    input: z.strictObject({ object_type: objectType, schema_id: schemaId, field_id: hexId("field_id") }),
    output: z.object({ field_id: z.string(), key: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      const schema = await schemas.resolve(args.object_type, args.schema_id);
      const { name, fields } = await loadFields(schema.id);
      const field = fieldShortOf(findField(fields, args.field_id, name));
      await callOperation(client, "deleteBaseSchemaField", { params: { id: schema.id, fieldId: args.field_id } });
      schemas.invalidate();
      return {
        text: `Deleted field ${field.key} (field_id ${field.field_id}) from ${name}, and its value on every record.`,
        structuredContent: { field_id: field.field_id, key: field.key, deleted: true },
      };
    },
  });

  return [create, update, remove];
}
