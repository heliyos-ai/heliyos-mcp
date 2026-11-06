/**
 * Turns failures into MCP tool results. Business errors are returned as
 * `isError: true` text of the form "<CODE>: <message>. <hint>" so the model
 * (and the user) know how to fix them; only unknown tools are protocol errors,
 * which the SDK handles itself. Messages never carry the API key or a stack.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { HeliyosApiError } from "../client/http.js";
import { clip } from "../format/text.js";
import { redactSecrets } from "../secrets.js";

export { redactSecrets } from "../secrets.js";

const HINTS: Record<string, string> = {
  NOT_FOUND: "Check the id, or list the resource to find it.",
  FORBIDDEN_ACTION: "This API key cannot perform that action.",
  VALIDATION_FAILED: "Fix the input and retry.",
  RATE_LIMITED: "Wait and retry; the server already told the client when.",
  UNAUTHENTICATED: "Check HELIYOS_API_KEY.",
  NETWORK: "The Heliyos API could not be reached; retry.",
  CONFLICT: "The record changed or already exists. Fetch the latest version and retry.",
  INTERNAL: "Heliyos hit an internal error. Retry shortly; if it keeps failing, report it.",
};
const GENERIC_HINT = "Retry; if it keeps failing, check the input and report the error.";

const MAX_MESSAGE_CHARS = 500;
const MAX_DETAILS_CHARS = 600;
const MAX_DETAIL_ITEMS = 10;

/** Server or zod issue details as one short line: "a.b: message; c: message". */
export function compactDetails(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  const items = Array.isArray(details) ? details : [details];
  const parts = items.slice(0, MAX_DETAIL_ITEMS).map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const d = item as Record<string, unknown>;
      const rawPath = d.path ?? d.field ?? d.key;
      const path = Array.isArray(rawPath) ? rawPath.join(".") : typeof rawPath === "string" ? rawPath : "";
      const message = typeof d.message === "string" ? d.message : typeof d.msg === "string" ? d.msg : undefined;
      if (message) return path ? `${path}: ${message}` : message;
    }
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  });
  if (items.length > MAX_DETAIL_ITEMS) parts.push(`and ${items.length - MAX_DETAIL_ITEMS} more`);
  const text = parts.filter(Boolean).join("; ");
  return text ? clip(text, MAX_DETAILS_CHARS) : undefined;
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/**
 * Converts any thrown value into an MCP tool result with `isError: true`. Takes the error and returns text of the form
 * "<CODE>: <message>. <hint>" with credentials redacted and long messages clipped.
 */
export function toolErrorResult(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof HeliyosApiError) {
    const message = sentence(clip(redactSecrets(err.message), MAX_MESSAGE_CHARS));
    const details = err.code === "VALIDATION_FAILED" ? compactDetails(err.details) : undefined;
    const detailText = details && !message.includes(details) ? ` Details: ${sentence(redactSecrets(details))}.` : "";
    text = `${err.code}: ${message}.${detailText} ${HINTS[err.code] ?? GENERIC_HINT}`;
  } else {
    // Unexpected bug or response shape: report the message only, never the stack.
    const raw = err instanceof Error ? err.message : String(err);
    const message = sentence(clip(redactSecrets(raw), MAX_MESSAGE_CHARS)) || "Unexpected error";
    text = `INTERNAL: ${message}. ${HINTS.INTERNAL}`;
  }
  return { isError: true, content: [{ type: "text", text }] };
}
