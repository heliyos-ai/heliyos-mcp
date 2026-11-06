/**
 * One msw server per test file plus a `call(tool, args)` that connects a fresh
 * MCP server (real HTTP client, mocked API). Any unmocked request fails the test,
 * so "no request was sent" is asserted by simply not registering a handler.
 */
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { createClient } from "../../src/client/http.js";
import { closeAll, connect, textOf } from "./mcp.js";
import { BASE, KEY } from "./platform.js";

export type Structured = Record<string, any>;

export function useMockApi() {
  const api = setupServer();
  beforeAll(() => api.listen({ onUnhandledRequest: "error" }));
  afterEach(async () => {
    api.resetHandlers();
    await closeAll();
  });
  afterAll(() => api.close());

  const call = async (name: string, args: Record<string, unknown> = {}, options = { experimental: false }) => {
    const client = await connect(createClient({ baseUrl: BASE, apiKey: KEY, sleep: async () => {} }), options);
    return client.callTool({ name, arguments: args });
  };
  return { api, call };
}

/** An isError result whose text starts with `code`, carries a hint, and never the key or a stack. */
export function expectToolError(result: { isError?: unknown; content?: unknown }, code: string): string {
  const text = textOf(result);
  expect(result.isError, text).toBe(true);
  expect(text.startsWith(`${code}:`), text).toBe(true);
  expect(text).not.toContain(KEY);
  expect(text).not.toMatch(/\n\s+at /);
  return text;
}

/** A successful result; returns its text. */
export function expectOk(result: { isError?: unknown; content?: unknown }): string {
  const text = textOf(result);
  expect(result.isError, text).toBeFalsy();
  return text;
}
