/**
 * The tool definition wrapper: name and annotation rules, the text plus structuredContent result shape, and error results.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { HeliyosApiError } from "../../src/client/http.js";
import { registerSecret } from "../../src/secrets.js";
import { defineTool, toolErrorResult, type ToolSpec } from "../../src/tools/define.js";

// 32 characters from the key alphabet (no 0, O, I, l).
const KEY = "heliyos_ABCDEFGHJKLMNPQRSTUVWXYZabcdefgh";

const valid = (): ToolSpec => ({
  name: "heliyos_things_list",
  title: "List things",
  description: "Lists things.",
  input: z.strictObject({}),
  output: z.object({}),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async () => ({ text: "ok" }),
});

const server = () => new McpServer({ name: "t", version: "0.0.0" }, { capabilities: { tools: {} } });

describe("defineTool", () => {
  it("accepts a valid spec", () => {
    expect(() => defineTool(server(), valid())).not.toThrow();
  });

  it("rejects a name longer than 64 characters", () => {
    const spec = { ...valid(), name: `heliyos_${"a".repeat(57)}` };
    expect(spec.name.length).toBe(65);
    expect(() => defineTool(server(), spec)).toThrow(/64/);
  });

  it("rejects a name without the heliyos_ prefix or with bad characters", () => {
    expect(() => defineTool(server(), { ...valid(), name: "things_list" })).toThrow(/heliyos_/);
    expect(() => defineTool(server(), { ...valid(), name: "heliyos_Things-list" })).toThrow(/a-z0-9_/);
  });

  it("rejects a missing annotation", () => {
    const { idempotentHint: _omit, ...rest } = valid().annotations;
    const spec = { ...valid(), annotations: rest } as unknown as ToolSpec;
    expect(() => defineTool(server(), spec)).toThrow(/idempotentHint/);
  });

  it("rejects openWorldHint: true", () => {
    const spec = { ...valid(), annotations: { ...valid().annotations, openWorldHint: true } } as unknown as ToolSpec;
    expect(() => defineTool(server(), spec)).toThrow(/openWorldHint/);
  });

  it("rejects a missing output schema", () => {
    const { output: _omit, ...rest } = valid();
    expect(() => defineTool(server(), rest as unknown as ToolSpec)).toThrow(/output/);
  });

  it("rejects a missing title", () => {
    expect(() => defineTool(server(), { ...valid(), title: "" })).toThrow(/title/);
  });
});

describe("toolErrorResult", () => {
  const text = (err: unknown) => {
    const result = toolErrorResult(err);
    expect(result.isError).toBe(true);
    return (result.content[0] as { text: string }).text;
  };

  it.each([
    ["NOT_FOUND", "Check the id, or list the resource to find it."],
    ["FORBIDDEN_ACTION", "This API key cannot perform that action."],
    ["RATE_LIMITED", "Wait and retry; the server already told the client when."],
    ["UNAUTHENTICATED", "Check HELIYOS_API_KEY."],
    ["NETWORK", "The Heliyos API could not be reached; retry."],
  ])("%s gets its hint", (code, hint) => {
    expect(text(new HeliyosApiError(code, "boom", 400))).toBe(`${code}: boom. ${hint}`);
  });

  it("VALIDATION_FAILED includes compact details", () => {
    const t = text(
      new HeliyosApiError("VALIDATION_FAILED", "Invalid body", 400, [
        { path: ["fields", "domain"], message: "Required" },
        { field: "email", message: "must be an email" },
      ])
    );
    expect(t).toContain("VALIDATION_FAILED: Invalid body.");
    expect(t).toContain("fields.domain: Required");
    expect(t).toContain("email: must be an email");
    expect(t).toContain("Fix the input and retry.");
  });

  it("unknown codes get a generic hint", () => {
    expect(text(new HeliyosApiError("TEAPOT", "short and stout", 418))).toMatch(/^TEAPOT: short and stout\. \S/);
  });

  it("does not double the trailing period", () => {
    expect(text(new HeliyosApiError("NOT_FOUND", "Object not found.", 404))).toMatch(/^NOT_FOUND: Object not found\. Check/);
  });

  it("never leaks the API key or a stack trace", () => {
    expect(KEY).toHaveLength(40);
    const err = new Error(`failed with Bearer ${KEY}`);
    const t = text(err);
    expect(t).not.toContain(KEY);
    expect(t).toContain("heliyos_[redacted]");
    expect(t).not.toMatch(/\bat .*\.ts:\d+/);
  });

  it("redacts a registered key even when it does not have the standard shape", () => {
    const legacy = "legacy-key-0123456789-abcdefgh";
    registerSecret(legacy);
    expect(text(new HeliyosApiError("INTERNAL", `bad ${legacy} here`, 500))).not.toContain(legacy);
  });

  it("leaves tool names and other heliyos_ words alone", () => {
    const t = text(new HeliyosApiError("NOT_FOUND", "Use heliyos_notification_settings_get or heliyos_organization_get", 404));
    expect(t).toContain("heliyos_notification_settings_get");
    expect(t).toContain("heliyos_organization_get");
  });
});
