/**
 * Starts the MCP server over stdio. Loaded by bin/stdio.ts only after the Node
 * version check, because the imports below need Node 20 or newer.
 */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createClient } from "../client/http.js";
import { ConfigError, loadConfig } from "../config.js";
import { createServer } from "../index.js";

/** Reads the configuration from the environment and serves until the client disconnects. */
export function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`heliyos-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const options = { experimental: config.experimental };

  // serveStdio picks the protocol era from the client's opening message and
  // pins one server instance from the factory for the connection.
  serveStdio(() => createServer(client, options), {
    transport: new StdioServerTransport(),
    onerror: (error) => process.stderr.write(`heliyos-mcp: ${error.message}\n`),
  });
}
