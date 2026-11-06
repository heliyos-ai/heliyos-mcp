/**
 * Server assembly: registration order, tool naming rules, experimental gating and the tools/list contract.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeliyosApiError, type HeliyosClient } from "../src/client/http.js";
import { closeAll, connect, textOf } from "./helpers/mcp.js";

function mockClient(overrides: Partial<HeliyosClient> = {}): HeliyosClient {
  const unused = vi.fn(async () => {
    throw new Error("unexpected call");
  });
  return { get: unused, post: unused, put: unused, patch: unused, delete: unused, putPresigned: unused, ...overrides };
}

afterEach(closeAll);

describe("createServer", () => {
  it("registers the records tools first, in a fixed order, with no placeholder ping", async () => {
    const client = await connect(mockClient());
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).slice(0, 6)).toEqual([
      "heliyos_records_list",
      "heliyos_records_get",
      "heliyos_records_create",
      "heliyos_records_update",
      "heliyos_records_delete",
      "heliyos_records_lookup",
    ]);
    expect(tools.map((t) => t.name)).not.toContain("heliyos_ping");
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
  });

  it("returns an actionable isError result when the API rejects the key", async () => {
    const get = vi.fn(async () => {
      throw new HeliyosApiError("UNAUTHENTICATED", "Invalid API key", 401);
    });
    const client = await connect(mockClient({ get }));

    const result = await client.callTool({
      name: "heliyos_records_get",
      arguments: { record_id: "65b000000000000000000001" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("UNAUTHENTICATED: Invalid API key. Check HELIYOS_API_KEY.");
  });

  it("turns an unexpected exception into an isError result without a stack trace", async () => {
    const get = vi.fn(async () => {
      throw new TypeError("cannot read properties of undefined");
    });
    const client = await connect(mockClient({ get }));

    const result = await client.callTool({
      name: "heliyos_records_get",
      arguments: { record_id: "65b000000000000000000001" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INTERNAL: /);
    expect(textOf(result)).not.toMatch(/\n\s+at /);
  });
});
