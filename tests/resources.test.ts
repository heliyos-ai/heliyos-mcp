/**
 * The heliyos://records/{id} resource template: listing, reading one record as JSON and error handling.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../src/client/http.js";
import { closeAll, connect } from "./helpers/mcp.js";
import { acme, apiError, BASE, baseSchemasHandler, KEY, ok, P, RECORD_IDS } from "./helpers/platform.js";

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  api.resetHandlers();
  await closeAll();
});
afterAll(() => api.close());

const client = () => connect(createClient({ baseUrl: BASE, apiKey: KEY, sleep: async () => {} }));

describe("heliyos://records/{id}", () => {
  it("is listed as a resource template", async () => {
    const mcp = await client();
    const { resourceTemplates } = await mcp.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["heliyos://records/{id}"]);
    expect(resourceTemplates[0]!.mimeType).toBe("application/json");
  });

  it("returns the record as JSON, normalized like heliyos_records_get detailed", async () => {
    api.use(baseSchemasHandler(), http.get(`${P}/records/${RECORD_IDS.acme}`, () => ok(acme)));
    const mcp = await client();
    const result = await mcp.readResource({ uri: `heliyos://records/${RECORD_IDS.acme}` });
    const content = result.contents[0] as { uri: string; mimeType?: string; text: string };
    expect(content.uri).toBe(`heliyos://records/${RECORD_IDS.acme}`);
    expect(content.mimeType).toBe("application/json");
    const record = JSON.parse(content.text);
    expect(record).toMatchObject({ id: RECORD_IDS.acme, object_type: "company", name: "Acme Corp" });
    expect(record.fields.domain).toBe("acme.com");
    expect(record.relationships[0].id).toBe("65b0000000000000000000a1");
  });

  it("fails a malformed id before any request", async () => {
    const mcp = await client();
    await expect(mcp.readResource({ uri: "heliyos://records/not-an-id" })).rejects.toThrow(/24-character hex id/);
  });

  it("fails with a key-free message for a missing record", async () => {
    api.use(http.get(`${P}/records/${RECORD_IDS.globex}`, () => apiError(404, "NOT_FOUND", "Record not found")));
    const mcp = await client();
    const err = await mcp.readResource({ uri: `heliyos://records/${RECORD_IDS.globex}` }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/NOT_FOUND/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe("prompts", () => {
  it("lists prepare_account_review (company_id) and daily_pipeline_summary (no args)", async () => {
    const mcp = await client();
    const { prompts } = await mcp.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["prepare_account_review", "daily_pipeline_summary"]);
    expect(prompts[0]!.arguments?.map((a) => [a.name, a.required])).toEqual([["company_id", true]]);
    expect(prompts[1]!.arguments ?? []).toEqual([]);
  });

  it("prepare_account_review names the company and the tools to call", async () => {
    const mcp = await client();
    const result = await mcp.getPrompt({ name: "prepare_account_review", arguments: { company_id: RECORD_IDS.acme } });
    const text = (result.messages[0]!.content as { text: string }).text;
    expect(text).toContain(RECORD_IDS.acme);
    for (const tool of ["heliyos_records_get", "heliyos_records_timeline", "heliyos_tasks_list", "heliyos_signals_list"]) {
      expect(text).toContain(tool);
    }
  });

  it("prepare_account_review rejects a malformed company_id", async () => {
    const mcp = await client();
    await expect(mcp.getPrompt({ name: "prepare_account_review", arguments: { company_id: "acme" } })).rejects.toThrow();
  });

  it("daily_pipeline_summary names the tools to call", async () => {
    const mcp = await client();
    const result = await mcp.getPrompt({ name: "daily_pipeline_summary" });
    const text = (result.messages[0]!.content as { text: string }).text;
    for (const tool of ["heliyos_records_list", "heliyos_tasks_list", "heliyos_signals_list"]) {
      expect(text).toContain(tool);
    }
  });
});
