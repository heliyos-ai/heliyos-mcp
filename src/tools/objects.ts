/**
 * Objects: the workspace's record types (companies, people, deals and custom
 * objects) and their fields, so an agent can plan record calls. Two read tools;
 * create, update and delete of custom objects are experimental.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { fitTable, formatValue, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import { categoryOf, OBJECT_TYPES } from "./baseSchemas.js";
import {
  CREATES,
  DESTROYS,
  expectObject,
  hexId,
  idOf,
  numberOf,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  stringOf,
  UPDATES,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";
import { objectType, schemaId } from "./records.js";

/** The icon the web app gives a new custom object. */
const DEFAULT_ICON = "PiFile02AiStroke";

/** URL-safe slug: lowercase letters and digits joined by single dashes. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---------------------------------------------------------------- shapes

const fieldOut = z.object({
  key: z.string().describe("The field key to use in record `fields` and filters."),
  field_id: z.string().optional().describe("The field's id, for heliyos_fields_update and heliyos_fields_delete."),
  label: z.string().optional(),
  type: z.string().describe("text, number, currency, date, timestamp, select, multiSelect, url, email, phone, user, relationship, ..."),
  required: z.boolean().optional(),
  hidden: z.boolean().optional().describe("Detailed only: hidden in the web app's tables."),
  options: z.array(z.string()).optional().describe("Detailed only: allowed values of a select or multiSelect field."),
  ai_enabled: z.boolean().optional().describe("Detailed only: the field is filled by an AI prompt."),
  relationship_schema_id: z.string().optional().describe("Detailed only: the object a relationship field links to."),
});
type FieldOut = z.infer<typeof fieldOut>;

const objectSummaryOut = z.object({
  schema_id: z.string(),
  name: z.string(),
  object_type: z.enum(OBJECT_TYPES),
  stored_type: z.string().describe("The platform's own objectType value (for example people, deals)."),
  kind: z.string().optional().describe("base (built in), custom, or computed."),
  record_count: z.number().int().optional(),
  field_count: z.number().int(),
  description: z.string().optional(),
  fields: z.array(z.string()).optional().describe("Detailed only: the object's field keys in order."),
});
type ObjectSummary = z.infer<typeof objectSummaryOut>;

const objectOut = objectSummaryOut.omit({ fields: true, record_count: true }).extend({ fields: z.array(fieldOut) });

interface RawField {
  raw: Record<string, unknown>;
  sequence: number;
}

/** A schema's fields in sequence order (fields without a name are skipped). */
function rawFields(schema: Record<string, unknown>): RawField[] {
  const list = Array.isArray(schema.fields) ? schema.fields : [];
  return list
    .filter(isRecord)
    .filter((f) => stringOf(f.name) !== undefined)
    .map((raw, index) => ({ raw, sequence: numberOf(raw.sequence) ?? 1e9 + index }))
    .sort((a, b) => a.sequence - b.sequence);
}

function summaryOf(schema: Record<string, unknown>, detailed: boolean): ObjectSummary {
  const stored = stringOf(schema.objectType) ?? "";
  const fields = rawFields(schema).map((f) => String(f.raw.name));
  const kind = stringOf(schema.type);
  const description = stringOf(schema.description);
  const count = numberOf(schema.recordCount);
  return {
    schema_id: requireId(schema, "object schema"),
    name: stringOf(schema.name) ?? stringOf(schema.slug) ?? stored,
    object_type: categoryOf(stored),
    stored_type: stored,
    ...(kind ? { kind } : {}),
    ...(count !== undefined ? { record_count: count } : {}),
    field_count: fields.length,
    ...(description ? { description } : {}),
    ...(detailed ? { fields } : {}),
  };
}

function fieldOf(raw: Record<string, unknown>, detailed: boolean): FieldOut {
  const type = isRecord(raw.type) ? stringOf(raw.type.type) : stringOf(raw.type);
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const options = Array.isArray(settings.selectOptions)
    ? settings.selectOptions.map((o) => formatValue(o)).filter(Boolean)
    : [];
  const relationship = isRecord(raw.type) ? stringOf(raw.type.relationshipSchemaId) : undefined;
  const labelText = stringOf(raw.displayName);
  const fieldId = idOf(raw.id) ?? idOf(raw._id);
  return {
    key: String(raw.name),
    ...(fieldId ? { field_id: fieldId } : {}),
    ...(labelText ? { label: labelText } : {}),
    type: type ?? "unknown",
    ...(raw.isRequired === true ? { required: true } : {}),
    ...(detailed && raw.isHiddenField === true ? { hidden: true } : {}),
    ...(detailed && options.length ? { options } : {}),
    ...(detailed && raw.isAIEnabled === true ? { ai_enabled: true } : {}),
    ...(detailed && relationship ? { relationship_schema_id: relationship } : {}),
  };
}

const objectHeading = (o: { name: string; schema_id: string; object_type: string; kind?: string }) =>
  `${o.name} (schema_id ${o.schema_id}, object_type ${o.object_type}${o.kind ? `, ${o.kind}` : ""})`;

// ---------------------------------------------------------------- tools

/** Builds the tools that list and read objects. With `options.experimental` set it also builds the create, update and delete tools. */
export function objectTools({ client, schemas }: ToolContext, options: { experimental: boolean }): ToolSpec[] {
  const list = tool({
    name: "heliyos_objects_list",
    title: "List objects",
    description:
      "Lists the workspace's objects (record types): companies, people, deals and any custom objects, with each one's " +
      "schema_id, object_type, record count and number of fields. Use it to learn which object_type and schema_id to pass " +
      "to the heliyos_records_* tools (custom objects need schema_id), then heliyos_objects_get for an object's field keys. " +
      "Returns every object in one page (a workspace has a handful), as structuredContent {objects}.",
    input: z.strictObject({
      response_format: responseFormat("one line per object", "each object's field keys too"),
    }),
    output: z.object({ objects: z.array(objectSummaryOut) }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "listBaseSchemas", { query: { isRecordCount: true } });
      const detailed = args.response_format === "detailed";
      const objects = expectArray(data, "object list")
        .filter(isRecord)
        .map((s) => summaryOf(s, detailed));
      let body: string;
      if (objects.length === 0) {
        body = "This workspace has no objects.";
      } else if (detailed) {
        body = objects
          .map((o) =>
            [objectHeading(o), `records: ${o.record_count ?? "unknown"}`, `field keys: ${(o.fields ?? []).join(", ")}`].join("\n")
          )
          .join("\n\n");
      } else {
        const rows = objects.map((o) => ({ ...o, records: o.record_count, fields: o.field_count }));
        body = fitTable(
          rows,
          [
            { columns: ["schema_id", "name", "object_type", "kind", "records", "fields"], maxCell: 60 },
            { columns: ["schema_id", "name", "object_type"], maxCell: 30 },
          ],
          MAX_TEXT_CHARS - 300
        );
      }
      return {
        text: `${plural(objects.length, "object")}:\n${body}\n\nUse heliyos_objects_get with object_type (and schema_id for custom objects) for field keys and types.`,
        structuredContent: { objects },
      };
    },
  });

  const get = tool({
    name: "heliyos_objects_get",
    title: "Get an object's fields",
    description:
      "Returns one object's fields: each field key (what heliyos_records_create, _update and _list filters take), its label " +
      "and type, and which are required. \"detailed\" adds the allowed values of select fields, hidden and AI-filled flags, " +
      "and the target object of relationship fields. Pick the object with object_type (company, person, deal, or custom with " +
      "schema_id from heliyos_objects_list). Each field's field_id feeds heliyos_fields_update and heliyos_fields_delete; " +
      "heliyos_fields_create adds one. Returns structuredContent {object:{schema_id, name, fields:[{key, field_id, type, ...}]}}.",
    input: z.strictObject({
      object_type: objectType,
      schema_id: schemaId,
      response_format: responseFormat("each field's key, label and type", "select options and field flags too"),
    }),
    output: z.object({ object: objectOut }),
    annotations: READ_ONLY,
    truncationHint: 'Use response_format "concise" for field keys and types only.',
    async handler(args) {
      const resolved = await schemas.resolve(args.object_type, args.schema_id);
      const { data } = await callOperation(client, "getBaseSchema", { params: { id: resolved.id } });
      const raw = expectObject(data, "object schema");
      const detailed = args.response_format === "detailed";
      const { fields: _names, record_count: _count, ...summary } = summaryOf(raw, false);
      const fields = rawFields(raw).map((f) => fieldOf(f.raw, detailed));
      const object = { ...summary, fields };

      const rows = fields.map((f) => ({
        ...f,
        required: f.required ? "yes" : "",
        flags: [f.hidden ? "hidden" : "", f.ai_enabled ? "AI" : "", f.relationship_schema_id ? `links ${f.relationship_schema_id}` : ""]
          .filter(Boolean)
          .join(" "),
        options: f.options?.join(", "),
      }));
      const columns = detailed ? ["key", "type", "label", "required", "flags", "options"] : ["key", "type", "label", "required"];
      const table = fitTable(
        rows,
        [
          { columns, maxCell: 60 },
          { columns: ["key", "type", "label"], maxCell: 30 },
          { columns: ["key", "type"], maxCell: 30 },
        ],
        MAX_TEXT_CHARS - 600
      );
      const text = [
        objectHeading(object),
        summary.description ? `description: ${summary.description}` : "",
        `${plural(fields.length, "field")}:`,
        table,
        "Use these keys in heliyos_records_create / _update `fields` and in heliyos_records_list `filters`.",
      ]
        .filter(Boolean)
        .join("\n");
      return { text, structuredContent: { object } };
    },
  });

  if (!options.experimental) return [list, get];

  const objectShort = z.object({ schema_id: z.string(), name: z.string(), stored_type: z.string().optional() });
  const shortOf = (data: unknown) => {
    const raw = expectObject(data, "object schema");
    const stored = stringOf(raw.objectType);
    return { schema_id: requireId(raw, "object schema"), name: stringOf(raw.name) ?? "", ...(stored ? { stored_type: stored } : {}) };
  };

  const create = tool({
    name: "heliyos_objects_create",
    title: "Create a custom object",
    description:
      "Experimental. Creates a custom object (a new record type, for example Partners or Investors). The platform gives it " +
      "one text field named after the object and one empty record. Calling it twice creates two objects, so check " +
      "heliyos_objects_list first. Returns structuredContent {object:{schema_id, name}}; pass that schema_id with " +
      'object_type "custom" to the records tools, and add fields with heliyos_fields_create.',
    input: z.strictObject({
      name: z.string().trim().min(1).max(100).describe("Display name, for example Partners."),
      description: z.string().trim().max(1000).optional().describe("What the object holds, shown in the web app."),
      icon: z.string().trim().min(1).max(100).optional().describe(`Web app icon name. Default ${DEFAULT_ICON}.`),
    }),
    output: z.object({ object: objectShort }),
    annotations: CREATES,
    async handler(args) {
      const slug = slugOf(args.name);
      if (!slug) throw new HeliyosApiError("VALIDATION_FAILED", "name must contain at least one letter or digit", 0);
      const { data } = await callOperation(client, "createBaseSchema", {
        body: {
          name: args.name,
          slug,
          icon: args.icon ?? DEFAULT_ICON,
          type: "custom",
          ...(args.description ? { description: args.description } : {}),
        },
      });
      schemas.invalidate();
      const object = shortOf(data);
      return {
        text: `Created custom object "${object.name}" (schema_id ${object.schema_id}). Use object_type "custom" with this schema_id in the records tools.`,
        structuredContent: { object },
      };
    },
  });

  const update = tool({
    name: "heliyos_objects_update",
    title: "Rename or describe an object",
    description:
      "Experimental. Changes an object's name, description or icon by schema_id. Fields are not changed here. " +
      "Returns structuredContent {object:{schema_id, name}}.",
    input: z
      .strictObject({
        schema_id: hexId("schema_id"),
        name: z.string().trim().min(1).max(100).optional().describe("New display name."),
        description: z.string().trim().max(1000).optional().describe("New description; an empty string clears it."),
        icon: z.string().trim().min(1).max(100).optional().describe("Web app icon name."),
      })
      .refine((v) => v.name !== undefined || v.description !== undefined || v.icon !== undefined, {
        message: "Give at least one of name, description or icon",
      }),
    output: z.object({ object: objectShort }),
    annotations: UPDATES,
    async handler(args) {
      const { schema_id, ...changes } = args;
      const { data } = await callOperation(client, "updateBaseSchema", { params: { id: schema_id }, body: changes });
      schemas.invalidate();
      const object = shortOf(data);
      return {
        text: [`Updated object ${object.name ? `"${object.name}" ` : ""}(schema_id ${object.schema_id}).`, renderRecord(changes)].join("\n"),
        structuredContent: { object },
      };
    },
  });

  const remove = tool({
    name: "heliyos_objects_delete",
    title: "Delete a custom object",
    description:
      "Experimental. Permanently deletes a custom object AND every record in it. This cannot be undone: confirm with the " +
      "user first, naming the object and its record count (heliyos_objects_list). Only custom objects can be deleted; " +
      "built-in objects (companies, people, deals) are refused, and so is any object whose type cannot be read. Returns structuredContent {schema_id, deleted}.",
    input: z.strictObject({ schema_id: hexId("schema_id") }),
    output: z.object({ schema_id: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      // Fail closed: read the target itself (never the cache, never best-effort). If it cannot be
      // read, the error is returned and no DELETE is sent.
      const { data } = await callOperation(client, "getBaseSchema", { params: { id: args.schema_id } });
      const target = summaryOf(expectObject(data, "object schema"), false);
      if (target.kind !== "custom" || target.object_type !== "custom") {
        throw new HeliyosApiError(
          "FORBIDDEN_ACTION",
          `${target.name} (schema_id ${target.schema_id}) is ${
            target.object_type === "custom" ? `a ${target.kind ?? "non-custom"} object` : "a built-in object"
          }; only custom objects can be deleted with the API`,
          0
        );
      }
      await callOperation(client, "deleteBaseSchema", { params: { id: args.schema_id } });
      schemas.invalidate();
      const name = target.name ? `"${target.name}" ` : "";
      return {
        text: `Deleted object ${name}(schema_id ${args.schema_id}) and all of its records.`,
        structuredContent: { schema_id: args.schema_id, deleted: true },
      };
    },
  });

  return [list, get, create, update, remove];
}
