/**
 * Typed request helper over the generated operation table: validates input
 * with the operation's zod schemas, fills the path template and dispatches
 * through the HeliyosClient. Invalid input never reaches the network.
 */
import type * as z from "zod/v4";
import { operations, type OperationId, type Operations } from "./generated.js";
import { HeliyosApiError, type Envelope, type HeliyosClient, type RequestOptions } from "./http.js";

/** The path parameters, query and body accepted by operation K, typed from its schemas. */
export interface OperationInput<K extends OperationId> {
  params?: z.input<Operations[K]["params"]>;
  query?: z.input<Operations[K]["query"]>;
  body?: z.input<Operations[K]["body"]>;
}

/**
 * Calls the API operation `operationId` through `client`. `input` is validated against the operation's schemas, path parameters are filled in,
 * and the response Envelope is returned. Throws a VALIDATION_FAILED HeliyosApiError when the input is invalid or a path parameter is missing.
 */
export async function callOperation<K extends OperationId>(
  client: HeliyosClient,
  operationId: K,
  input: OperationInput<K> = {}
): Promise<Envelope> {
  const op = operations[operationId];
  const params = parseOrThrow(op.params, input.params ?? {}, operationId, "path params");
  const query = parseOrThrow(op.query, input.query ?? {}, operationId, "query");
  const body = parseOrThrow(op.body, input.body, operationId, "body");

  const path = op.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = (params as Record<string, unknown>)[name];
    if (value === undefined || value === null || value === "") {
      throw new HeliyosApiError("VALIDATION_FAILED", `${operationId}: missing path param "${name}".`, 0);
    }
    // "." and ".." (even as %2E) are dot segments: the URL would resolve to another route.
    if (/^\.+$/.test(String(value))) {
      throw new HeliyosApiError("VALIDATION_FAILED", `${operationId}: path param "${name}" cannot be "${String(value)}".`, 0);
    }
    return encodeURIComponent(String(value));
  });

  const method = op.method.toLowerCase() as Lowercase<typeof op.method>;
  return client[method](path, { query: query as RequestOptions["query"], body });
}

function parseOrThrow(schema: z.ZodType, value: unknown, operationId: string, part: string): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  throw new HeliyosApiError("VALIDATION_FAILED", `${operationId}: invalid ${part}: ${issues}`, 0, result.error.issues);
}

/** Narrows an API `data` payload to an array, or fails with INTERNAL naming what was expected. */
export function expectArray(data: unknown, what: string): unknown[] {
  if (!Array.isArray(data)) throw new HeliyosApiError("INTERNAL", `The ${what} response was not an array`, 0);
  return data;
}
