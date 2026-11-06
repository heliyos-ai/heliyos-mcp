/**
 * Builds the Heliyos MCP server. Tools are registered in a fixed order so
 * tools/list is deterministic: records first, then one block per resource;
 * experimental tools sit right after their resource's stable tools.
 */
import { McpServer } from "@modelcontextprotocol/server";
import type { HeliyosClient } from "./client/http.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { askTools } from "./tools/ask.js";
import { createSchemaResolver } from "./tools/baseSchemas.js";
import { catalogTools } from "./tools/catalogs.js";
import { defineTool, summarizeTool, type ToolSpec, type ToolSummary } from "./tools/define.js";
import { fieldTools } from "./tools/fields.js";
import { fileTools } from "./tools/files.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { labelTools } from "./tools/labels.js";
import { noteTools } from "./tools/notes.js";
import { notificationTools } from "./tools/notifications.js";
import { objectTools } from "./tools/objects.js";
import { organizationTools } from "./tools/organization.js";
import { recordEnrichTool, recordTools } from "./tools/records.js";
import { reviewTools } from "./tools/reviews.js";
import { scoutTools } from "./tools/scouts.js";
import { taskTools } from "./tools/tasks.js";
import { teamTools } from "./tools/teams.js";
import { timelineTools } from "./tools/timeline.js";
import { usageTools } from "./tools/usage.js";
import { watchlistTools } from "./tools/watchlist.js";
import { workerTools } from "./tools/workers.js";
import { PACKAGE_VERSION } from "./version.js";

/** Settings for createServer. */
export interface ServerOptions {
  /** Enables tools gated behind HELIYOS_MCP_EXPERIMENTAL (record enrichment, object create/update/delete). */
  experimental: boolean;
}

const contextFor = (client: HeliyosClient) => ({ client, schemas: createSchemaResolver(client) });

/** Every tool spec, in registration order. Per call, so caches are per server instance. */
function buildToolSpecs(ctx: ReturnType<typeof contextFor>, options: ServerOptions): ToolSpec[] {
  return [
    ...recordTools(ctx),
    ...(options.experimental ? [recordEnrichTool(ctx)] : []),
    ...organizationTools(ctx),
    ...objectTools(ctx, options),
    ...fieldTools(ctx),
    ...timelineTools(ctx),
    ...noteTools(ctx),
    ...taskTools(ctx),
    ...labelTools(ctx),
    ...notificationTools(ctx),
    ...teamTools(ctx),
    ...watchlistTools(ctx),
    ...usageTools(ctx),
    ...scoutTools(ctx),
    ...askTools(ctx),
    ...reviewTools(ctx),
    ...workerTools(ctx),
    ...catalogTools(ctx),
    ...knowledgeTools(ctx),
    ...fileTools(ctx),
  ];
}

/**
 * Builds the MCP server: registers every tool, the record resource and the prompts, all talking to the Heliyos API through `client`.
 * `options.experimental` turns on the gated tools. Returns the server, not yet connected to a transport.
 */
export function createServer(client: HeliyosClient, options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "heliyos", title: "Heliyos", version: PACKAGE_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
  const ctx = contextFor(client);
  for (const spec of buildToolSpecs(ctx, options)) defineTool(server, spec);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

/** A client for building specs without a network; any call is a bug. */
const offlineClient: HeliyosClient = (() => {
  const refuse = async (): Promise<never> => {
    throw new Error("listToolSpecs builds specs only; it never calls the API.");
  };
  return { get: refuse, post: refuse, put: refuse, patch: refuse, delete: refuse, putPresigned: refuse };
})();

/** The public tool contract (name, title, annotations, sorted input keys), in tools/list order. */
export function listToolSpecs(options: ServerOptions = { experimental: false }): ToolSummary[] {
  return buildToolSpecs(contextFor(offlineClient), options).map(summarizeTool);
}

/** Re-exported so library users can create a client and recognize its errors. */
export { createClient, HeliyosApiError } from "./client/http.js";
/** Re-exported client types for library users. */
export type { ClientOptions, Envelope, HeliyosClient, RequestOptions } from "./client/http.js";
/** Re-exported so library users can read configuration from the environment and catch its errors. */
export { ConfigError, loadConfig } from "./config.js";
/** Re-exported configuration type. */
export type { Config } from "./config.js";
/** Re-exported type of the public tool contract returned by listToolSpecs. */
export type { ToolSummary } from "./tools/define.js";
