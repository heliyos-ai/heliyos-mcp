/**
 * Resources: `heliyos://records/{id}` returns one record as JSON, normalized
 * exactly like heliyos_records_get with response_format "detailed" (every
 * field, linked records, timestamps). Convenience only: every capability is
 * also a tool.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";
import { HeliyosApiError } from "./client/http.js";
import { callOperation } from "./client/operations.js";
import { OBJECT_ID, type ToolContext } from "./tools/common.js";
import { toolErrorResult } from "./tools/errors.js";
import { normalizeRecord, toOut } from "./tools/records.js";
import { redactCredentials } from "./secrets.js";

/** The URI template of the record resource; `{id}` is a record id. */
export const RECORD_URI_TEMPLATE = "heliyos://records/{id}";

/** The same key-free "<CODE>: <message>. <hint>" text a tool error carries. */
const errorText = (err: unknown) => {
  const block = toolErrorResult(err).content[0];
  return block && block.type === "text" ? block.text : "INTERNAL: Unexpected error.";
};

/** Registers the MCP resources on `server`: currently one record per URI, read through `client` and described with `schemas`. */
export function registerResources(server: McpServer, { client, schemas }: ToolContext): void {
  server.registerResource(
    "record",
    new ResourceTemplate(RECORD_URI_TEMPLATE, { list: undefined }),
    {
      title: "Heliyos record",
      description:
        "One record (company, person, deal or custom object row) as JSON: id, object_type, schema_id, name, every " +
        "field, linked records and timestamps. The same data as heliyos_records_get with response_format detailed.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(Array.isArray(variables.id) ? variables.id[0] : variables.id ?? "");
      if (!OBJECT_ID.test(id)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `VALIDATION_FAILED: ${uri.href} needs a 24-character hex id, for example heliyos://records/65b000000000000000000001.`
        );
      }
      try {
        const { data } = await callOperation(client, "getRecord", { params: { id } });
        const record = normalizeRecord(data);
        const out = redactCredentials(toOut(record, await schemas.find(record.schemaId), true));
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        if (err instanceof HeliyosApiError && err.code === "NOT_FOUND") throw new ResourceNotFoundError(uri.href, errorText(err));
        throw new Error(errorText(err));
      }
    }
  );
}
