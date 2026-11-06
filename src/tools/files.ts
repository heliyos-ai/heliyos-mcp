/**
 * Files: attachments on records and knowledge-base files the workers read.
 * Four tools: list, get (detailed adds a short-lived download link), upload
 * (presigned PUT straight to storage, then the attachment record) and delete.
 *
 * Shapes follow the Heliyos API's attachment endpoints (/v1/platform/attachments:
 * list `kind`, create, presigned upload URL, download URL)
 * (AttachmentFilters.objectId) and src/core/models/objectAttachment.ts. The
 * upload mirrors the web app (components/settings/knowledgebase/kb-files-tab.tsx).
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { fitTable, MAX_TEXT_CHARS, renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  day,
  DESTROYS,
  expectObject,
  hexId,
  keysetListQuery,
  label,
  linkOut,
  linksLine,
  linksOf,
  LIST_TRUNCATION_HINT,
  nextCursorOf,
  numberOf,
  pageLimit,
  cursorInput,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  searchInput,
  stringOf,
  timestampsOf,
  type ToolContext,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";
import { readRecordRefs } from "./records.js";

const KINDS = ["knowledge_base", "attachment"] as const;
/** The largest file, in bytes, that the upload tool accepts. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Longest base64 text that can decode to MAX_UPLOAD_BYTES, plus room for line breaks. */
const MAX_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4096;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const DOWNLOAD_LINK_SECONDS = 60;

/** Content types for common extensions; anything else is application/octet-stream (or text/plain for `text`). */
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  rtf: "application/rtf",
  // Refused by the platform; kept so the refusal names the type instead of storing it as text.
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  zip: "application/zip",
};

/**
 * The content types the Heliyos API signs uploads for, matched exactly so a refused type is
 * reported before any request is made. HTML, SVG, XML,
 * scripts and executables are refused there, so they are refused here before any request.
 */
const UPLOAD_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
  "text/calendar",
  "message/rfc822",
  "image/bmp",
  "image/tiff",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);
const ALLOWED_FAMILIES =
  "images, PDF, Office and OpenDocument files, RTF, text, CSV, TSV, Markdown, JSON, audio, video, ZIP or " +
  "application/octet-stream";

/** Refuses a type the platform would refuse (the media type only; a guessed charset is fine on text). */
function assertUploadType(mimeType: string): void {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (UPLOAD_CONTENT_TYPES.has(type)) return;
  throw new HeliyosApiError(
    "VALIDATION_FAILED",
    `${type} is not an upload type Heliyos accepts (HTML, SVG, XML, scripts and executables are refused). ` +
      `Allowed: ${ALLOWED_FAMILIES}. To keep the content as text, pass content_type "text/plain"`,
    0
  );
}

/** The guessed type; `text` content is UTF-8, so a guessed text/* type says so. */
const contentTypeFor = (name: string, isText: boolean) => {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  const type = (ext && TYPES[ext]) || (isText ? "text/plain" : "application/octet-stream");
  return isText && type.startsWith("text/") ? `${type}; charset=utf-8` : type;
};

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const sizeText = (bytes: number | undefined) =>
  bytes === undefined ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : megabytes(bytes);

const tooLarge = (bytes: number) =>
  new HeliyosApiError(
    "VALIDATION_FAILED",
    `The file is ${megabytes(bytes)}; heliyos_files_upload accepts up to 10 MB. Upload larger files in Heliyos ` +
      "(the record's Files tab, or Settings, Knowledge base)",
    0
  );

/** The bytes to upload, checked against the 10 MB cap before any request is sent. */
function bytesOf(args: { text?: string | undefined; content_base64?: string | undefined }): Uint8Array {
  let bytes: Uint8Array;
  if (args.text !== undefined) {
    bytes = new TextEncoder().encode(args.text);
  } else {
    const compact = (args.content_base64 ?? "").replace(/\s+/g, "");
    if (!compact || compact.length % 4 !== 0 || !BASE64.test(compact)) {
      throw new HeliyosApiError("VALIDATION_FAILED", "content_base64 is not valid base64 (A-Z, a-z, 0-9, + and /, with = padding)", 0);
    }
    const decodedLength = (compact.length / 4) * 3 - (compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0);
    if (decodedLength > MAX_UPLOAD_BYTES) throw tooLarge(decodedLength);
    bytes = Buffer.from(compact, "base64");
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw tooLarge(bytes.byteLength);
  if (bytes.byteLength === 0) throw new HeliyosApiError("VALIDATION_FAILED", "The file is empty", 0);
  return bytes;
}

/** createAttachment after a successful PUT: a failure must say the bytes are already in storage. */
async function recordUpload<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (err) {
    if (!(err instanceof HeliyosApiError)) throw err;
    throw new HeliyosApiError(
      err.code,
      `The file reached storage, but Heliyos could not record it, so it is not listed: ${err.message}. ` +
        "Retrying uploads it again",
      err.status,
      err.details
    );
  }
}

// ---------------------------------------------------------------- shape

const fileOut = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(KINDS).describe("knowledge_base (read by the workers) or attachment."),
  content_type: z.string().optional(),
  size_bytes: z.number().optional(),
  description: z.string().optional(),
  links: z.array(linkOut).optional().describe("Records (or other objects) the file is attached to."),
  download_url: z
    .string()
    .optional()
    .describe(`get detailed only: a signed download link that expires about ${DOWNLOAD_LINK_SECONDS} s after the call.`),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
type FileOut = z.infer<typeof fileOut>;

function fileOf(data: unknown): FileOut {
  const raw = expectObject(data, "file");
  const type = stringOf(raw.mimeType);
  const size = numberOf(raw.fileSize);
  const description = stringOf(raw.description);
  const links = linksOf(raw.relationships);
  return {
    id: requireId(raw, "file"),
    name: stringOf(raw.fileName) ?? "",
    kind: raw.isKbFile === true ? "knowledge_base" : "attachment",
    ...(type ? { content_type: type } : {}),
    ...(size !== undefined ? { size_bytes: size } : {}),
    ...(description ? { description } : {}),
    ...(links.length ? { links } : {}),
    ...timestampsOf(raw),
  };
}

const fileFacts = (f: FileOut) =>
  renderRecord({ kind: f.kind, type: f.content_type, size: sizeText(f.size_bytes), description: f.description, created: day(f.created_at) });

const fileIdInput = hexId("file_id").describe("File id from heliyos_files_list.");
const kindInput = z.enum(KINDS);

/** Builds the tools that list, read, upload and delete files, from the shared tool context. */
export function fileTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_files_list",
    title: "List files",
    description:
      "Lists files, newest first: knowledge-base files (documents the workers read, kind knowledge_base) and " +
      "attachments on records (kind attachment). Filter by kind, by the record a file is attached to (record_id) or " +
      "by name. Shows each file's id, name, kind, type and size; use heliyos_files_get for a download link. Returns " +
      "structuredContent {files:[{id, name, kind, content_type, size_bytes}], next_cursor}.",
    input: z.strictObject({
      kind: kindInput.optional().describe("knowledge_base or attachment. Omit for both."),
      record_id: hexId("record_id").optional().describe("Only files attached to this record."),
      search: searchInput("file names and types"),
      limit: pageLimit("Files"),
      cursor: cursorInput,
      response_format: responseFormat("one row per file", "descriptions and linked records too"),
    }),
    output: z.object({ files: z.array(fileOut), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: LIST_TRUNCATION_HINT,
    async handler(args) {
      const filters = {
        ...(args.record_id ? { objectId: args.record_id } : {}),
        ...(args.search ? { search: args.search } : {}),
      };
      const { data, meta } = await callOperation(client, "listAttachments", {
        query: { ...keysetListQuery(args, filters), ...(args.kind ? { kind: args.kind } : {}) },
      });
      const detailed = args.response_format === "detailed";
      const all = expectArray(data, "file list").map(fileOf);
      const files = detailed ? all : all.map(({ links: _l, description: _d, ...rest }) => rest);
      const next = nextCursorOf(meta);
      const rows = all.map((f) => ({
        ...f,
        type: f.content_type,
        size: sizeText(f.size_bytes),
        created: day(f.created_at),
        links: (f.links ?? []).map((l) => (l.name ? `${l.name} (${l.id})` : l.id)).join(", "),
      }));
      const wide = detailed
        ? ["id", "name", "kind", "type", "size", "created", "links", "description"]
        : ["id", "name", "kind", "type", "size", "created"];
      const table = all.length
        ? fitTable(
            rows,
            [
              { columns: wide, maxCell: 50 },
              { columns: ["id", "name", "kind", "size"], maxCell: 40 },
              { columns: ["id", "name"], maxCell: 30 },
            ],
            MAX_TEXT_CHARS - 600
          )
        : "No files matched.";
      return {
        text: `${plural(all.length, "file")}:\n${table}\n\n${pagingFooter("heliyos_files_list", next)}`,
        structuredContent: { files, ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const get = tool({
    name: "heliyos_files_get",
    title: "Get a file",
    description:
      "Fetches one file's details by id: name, kind, type, size, description and the records it is attached to. " +
      `"detailed" also returns a signed download link that expires about ${DOWNLOAD_LINK_SECONDS} s after the call, ` +
      "so use it at once. Returns structuredContent {file}.",
    input: z.strictObject({
      file_id: fileIdInput,
      response_format: responseFormat("the file's details", `the details plus a download link valid for about ${DOWNLOAD_LINK_SECONDS} s`),
    }),
    output: z.object({ file: fileOut }),
    annotations: READ_ONLY,
    async handler(args) {
      const { data } = await callOperation(client, "getAttachment", { params: { id: args.file_id } });
      let file = fileOf(data);
      const lines = [`File ${label(file)}`, fileFacts(file), linksLine(file.links ?? [])];
      if (args.response_format === "detailed") {
        const link = await callOperation(client, "getAttachmentDownloadUrl", { params: { id: args.file_id } });
        const url = isRecord(link.data) ? stringOf(link.data.url) : undefined;
        if (url) {
          file = { ...file, download_url: url };
          lines.push(`Download (link expires in about ${DOWNLOAD_LINK_SECONDS} s; call again for a new one): ${url}`);
        } else {
          lines.push("No download link is available for this file.");
        }
      } else {
        lines.push('Use response_format "detailed" for a download link.');
      }
      return { text: lines.filter(Boolean).join("\n"), structuredContent: { file } };
    },
  });

  const upload = tool({
    name: "heliyos_files_upload",
    title: "Upload a file",
    description:
      "Uploads one file, up to 10 MB, as a knowledge-base file (kind knowledge_base: documents the workers read, such " +
      "as playbooks or pricing) or as an attachment (kind attachment), optionally attached to one record (record_id). " +
      "Pass the content as text (stored as UTF-8) or as content_base64 for binary files, exactly one of the two. " +
      "content_type is guessed from the name's extension when omitted; HTML, SVG, XML, scripts and executables are " +
      "refused. Calling it twice stores two files. Returns " +
      "structuredContent {file}.",
    input: z
      .strictObject({
        name: z.string().trim().min(1).max(200).describe('File name with extension, for example "pricing-2026.pdf".'),
        text: z
          .string()
          .max(MAX_UPLOAD_BYTES, "text is larger than the 10 MB upload limit")
          .optional()
          .describe("The file's content as text (UTF-8). Use content_base64 for binary files."),
        content_base64: z
          .string()
          .max(MAX_BASE64_CHARS, "content_base64 is larger than the 10 MB upload limit")
          .optional()
          .describe("The file's bytes, base64-encoded."),
        kind: kindInput.describe("knowledge_base (read by the workers) or attachment."),
        record_id: hexId("record_id").optional().describe("Attach the file to this record (company, person, deal)."),
        content_type: z
          .string()
          .regex(CONTENT_TYPE, 'content_type must look like "application/pdf"')
          .optional()
          .describe('MIME type, for example "application/pdf". Guessed from the name when omitted.'),
      })
      .refine((v) => (v.text === undefined) !== (v.content_base64 === undefined), {
        message: "Pass exactly one of text or content_base64",
      }),
    output: z.object({ file: fileOut }),
    annotations: CREATES,
    async handler(args) {
      // Size and encoding are checked before any request.
      const bytes = bytesOf(args);
      const mimeType = args.content_type ?? contentTypeFor(args.name, args.text !== undefined);
      assertUploadType(mimeType);
      const [ref] = args.record_id ? await readRecordRefs(client, [args.record_id], "record_id") : [];

      const presigned = await callOperation(client, "createPresignedUrl", {
        body: {
          fileName: args.name,
          mimeType,
          ...(ref?.objectType ? { objectType: ref.objectType } : {}),
          // Signed as the PUT's Content-Length, so storage refuses any other body.
          fileSize: bytes.byteLength,
        },
      });
      const target = expectObject(presigned.data, "upload URL");
      const uploadUrl = stringOf(target.presignedUrl);
      const fileKey = stringOf(target.fileKey);
      const bucket = stringOf(target.bucketName);
      if (!uploadUrl || !fileKey || !bucket) {
        throw new HeliyosApiError("INTERNAL", "The API returned an incomplete upload URL", 0);
      }
      await client.putPresigned(uploadUrl, bytes, mimeType);

      const { data } = await recordUpload(() => callOperation(client, "createAttachment", {
        body: {
          fileName: args.name,
          fileSize: bytes.byteLength,
          mimeType,
          url: `https://${bucket}.s3.amazonaws.com/${fileKey}`,
          storageProvider: "S3",
          storageKey: fileKey,
          isKbFile: args.kind === "knowledge_base",
          ...(ref
            ? {
                relationships: [
                  { objectId: ref.objectId, ...(ref.schemaId ? { schemaId: ref.schemaId } : {}), objectType: ref.objectType ?? "" },
                ],
              }
            : {}),
        },
      }));
      const file = fileOf(data);
      return {
        text: [`Uploaded file ${label(file)}.`, fileFacts(file), linksLine(file.links ?? [])].filter(Boolean).join("\n"),
        structuredContent: { file },
      };
    },
  });

  const remove = tool({
    name: "heliyos_files_delete",
    title: "Delete a file",
    description:
      "Permanently deletes one file by id. A knowledge-base file also disappears from what the workers can read. This " +
      "cannot be undone: confirm with the user first. Returns structuredContent {file_id, deleted}.",
    input: z.strictObject({ file_id: fileIdInput }),
    output: z.object({ file_id: z.string(), deleted: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      await callOperation(client, "deleteAttachment", { params: { id: args.file_id } });
      return { text: `Deleted file ${args.file_id}.`, structuredContent: { file_id: args.file_id, deleted: true } };
    },
  });

  return [list, get, upload, remove];
}
