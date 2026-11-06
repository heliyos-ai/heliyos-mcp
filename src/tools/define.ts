/**
 * The one way to register a Heliyos tool. `defineTool` enforces the tool rules
 * at registration time (so a bad tool fails at startup and in tests, not in a
 * client) and wraps the handler so every result has a capped text block plus
 * structuredContent, and every failure is an actionable `isError` result.
 *
 * Rules: name `heliyos_<resource>_<verb>`, ≤ 64 chars, `[a-z0-9_]`; a title and
 * description; all four annotations set explicitly; `openWorldHint: false`
 * (every Heliyos tool acts only on the caller's own workspace).
 */
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MAX_TEXT_CHARS, truncate } from "../format/text.js";
import { toolErrorResult } from "./errors.js";
import { redactToolOutput } from "../secrets.js";

export { toolErrorResult } from "./errors.js";

/** The longest tool name allowed, in characters. */
export const MAX_TOOL_NAME_LENGTH = 64;
const NAME_PATTERN = /^[a-z0-9_]+$/;
const ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** MCP tool annotations with every hint required, so no tool leaves a safety hint unset. */
export interface ToolAnnotationsStrict {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Always false: Heliyos tools only touch the caller's own workspace. */
  openWorldHint: false;
}

/** What a handler returns; the wrapper turns it into a CallToolResult. */
export interface ToolOutput {
  text: string;
  structuredContent?: Record<string, unknown>;
}

/**
 * Everything one tool is made of: name, text for the model, input and output schemas, annotations and the handler
 * that does the work.
 */
export interface ToolSpec<I extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: I;
  /** Required: structuredContent is validated against it and clients see its JSON Schema. */
  output: z.ZodObject;
  annotations: ToolAnnotationsStrict;
  /**
   * Appended when the text block is cut at MAX_TEXT_CHARS. Defaults to a generic
   * "ask for less" hint; list/lookup tools pass paging-specific advice.
   */
  truncationHint?: string;
  // Method syntax keeps specs with narrower inputs assignable to ToolSpec.
  handler(args: z.output<I>, ctx: ServerContext): Promise<ToolOutput>;
}

/** Identity helper so a spec's handler args are inferred from its input schema. */
export function tool<I extends z.ZodObject>(spec: ToolSpec<I>): ToolSpec<I> {
  return spec;
}

/** The parts of a tool that form its public contract (used by the snapshot test). */
export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotationsStrict;
  inputKeys: string[];
  outputKeys: string[];
}

/** The advice appended to a tool result when its text is cut and the tool gave no hint of its own. */
export const DEFAULT_TRUNCATION_HINT = 'Ask for less output, for example response_format "concise" where the tool has it.';

/** Reduces a ToolSpec to its public contract: texts, annotations and sorted input and output keys. Returns a ToolSummary. */
export function summarizeTool(spec: ToolSpec): ToolSummary {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    annotations: {
      readOnlyHint: spec.annotations.readOnlyHint,
      destructiveHint: spec.annotations.destructiveHint,
      idempotentHint: spec.annotations.idempotentHint,
      openWorldHint: spec.annotations.openWorldHint,
    },
    inputKeys: Object.keys(spec.input.shape).sort(),
    outputKeys: Object.keys(spec.output.shape).sort(),
  };
}

/** Throws a descriptive Error when the spec breaks a tool rule. */
export function assertToolSpec(spec: ToolSpec): void {
  const name = spec.name;
  const fail = (reason: string): never => {
    throw new Error(`Tool "${name}" is invalid: ${reason}`);
  };
  if (typeof name !== "string" || !name.startsWith("heliyos_")) fail('name must start with "heliyos_".');
  if (name.length > MAX_TOOL_NAME_LENGTH) fail(`name is ${name.length} characters; the limit is ${MAX_TOOL_NAME_LENGTH}.`);
  if (!NAME_PATTERN.test(name)) fail("name may only contain [a-z0-9_].");
  if (typeof spec.title !== "string" || spec.title.trim() === "") fail("title is required.");
  if (typeof spec.description !== "string" || spec.description.trim() === "") fail("description is required.");
  if (!(spec.input instanceof z.ZodObject)) fail("input must be a zod object schema.");
  if (!(spec.output instanceof z.ZodObject)) fail("output is required and must be a zod object schema.");
  const annotations = (spec.annotations ?? {}) as unknown as Record<string, unknown>;
  for (const key of ANNOTATION_KEYS) {
    if (typeof annotations[key] !== "boolean") fail(`annotation ${key} must be set explicitly to true or false.`);
  }
  if (annotations.openWorldHint !== false) fail("openWorldHint must be false for Heliyos tools.");
  if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
    fail("a read-only tool cannot be destructive.");
  }
  if (typeof spec.handler !== "function") fail("handler is required.");
}

/**
 * Validates `spec` and registers it on `server`. The registered handler redacts credentials from the result,
 * truncates long text and turns thrown errors into tool error results. Throws when the spec is invalid.
 */
export function defineTool(server: McpServer, spec: ToolSpec): void {
  assertToolSpec(spec);
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: { ...spec.annotations },
    },
    // The SDK validates args against `input` before this runs.
    async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
      try {
        const raw = await spec.handler(args as z.output<typeof spec.input>, ctx);
        // Single exit for every tool: no credential (token, grant id, API key,
        // key hash) reaches the client, whatever the backend returned.
        const out = redactToolOutput(raw.text, raw.structuredContent);
        const result: CallToolResult = { content: [{ type: "text", text: truncate(out.text, MAX_TEXT_CHARS, spec.truncationHint ?? DEFAULT_TRUNCATION_HINT) }] };
        if (out.structuredContent !== undefined) result.structuredContent = out.structuredContent as CallToolResult["structuredContent"];
        return result;
      } catch (err) {
        return toolErrorResult(err);
      }
    }
  );
}
