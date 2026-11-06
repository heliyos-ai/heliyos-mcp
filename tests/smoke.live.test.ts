/**
 * Opt-in live smoke test against a real Heliyos API: `npm run smoke`.
 * Needs HELIYOS_API_KEY and, for anything but production, HELIYOS_BASE_URL.
 * Read-only: it lists tools and calls read tools, it never writes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../src/client/http.js";
import { loadConfig } from "../src/config.js";
import { closeAll, connect, textOf } from "./helpers/mcp.js";

const enabled = process.env.HELIYOS_MCP_SMOKE === "1" && Boolean(process.env.HELIYOS_API_KEY);

afterEach(closeAll);

describe.skipIf(!enabled)("live smoke", () => {
  const live = () => {
    const config = loadConfig();
    return connect(createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey }));
  };

  it("reaches the workspace bound to the API key", async () => {
    const client = await live();
    const result = await client.callTool({ name: "heliyos_organization_get", arguments: {} });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ organization: { id: expect.any(String), name: expect.any(String) } });
  });

  it("lists company records", async () => {
    const client = await live();
    const result = await client.callTool({
      name: "heliyos_records_list",
      arguments: { object_type: "company", limit: 5 },
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    const { records } = result.structuredContent as { records: Array<{ id: string; object_type: string }> };
    expect(Array.isArray(records)).toBe(true);
    for (const record of records) expect(record).toMatchObject({ id: expect.any(String), object_type: "company" });
  });
});
