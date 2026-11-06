#!/usr/bin/env node
/**
 * stdio entry point: `npx -y @heliyos/mcp`. stdout carries MCP protocol
 * messages only; diagnostics go to stderr and never include the API key.
 */
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createClient } from "../client/http.js";
import { ConfigError, loadConfig } from "../config.js";
import { createServer } from "../index.js";

function main(): void {
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

  //  serveStdio picks the protocol era from the client's opening message and
  //  pins one server instance from the factory for the connection.
  serveStdio(() => createServer(client, options), {
    transport: new StdioServerTransport(),
    onerror: (error) => process.stderr.write(`heliyos-mcp: ${error.message}\n`),
  });
}

main();
