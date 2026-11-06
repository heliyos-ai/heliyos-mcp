/**
 * Connects an SDK Client to a fresh Heliyos MCP server over the in-memory
 * transport. Call `closeAll()` in afterEach.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { HeliyosClient } from "../../src/client/http.js";
import { createServer } from "../../src/index.js";

const closers: Array<() => Promise<void>> = [];

export async function connect(heliyos: HeliyosClient, options = { experimental: false }): Promise<Client> {
  const server = createServer(heliyos, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "heliyos-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  closers.push(
    () => client.close(),
    () => server.close()
  );
  return client;
}

export async function closeAll(): Promise<void> {
  while (closers.length) await closers.pop()!();
}

/** The first text block of a tool result. */
export function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}
