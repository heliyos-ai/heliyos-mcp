/**
 * Thin fetch client for the Heliyos REST API.
 *
 * - Sends `Authorization: Bearer <apiKey>`; the key is never logged or put in errors.
 * - Success bodies are the `{ meta, data }` envelope.
 * - Error bodies `{ error: { code, message, details? } }` become HeliyosApiError.
 * - Network failures, timeouts and non-JSON bodies become HeliyosApiError("NETWORK").
 * - A 429 is retried exactly once after Retry-After (capped at 30 s, 2 s if absent).
 * - `putPresigned` is the one request to another host (a presigned storage URL):
 *   it never carries the API key, and its URL never appears in errors.
 */
import { registerSecret } from "../secrets.js";
import { isRecord } from "../util.js";
import { PACKAGE_VERSION } from "../version.js";

/** The error codes the client raises. Known codes are listed; any other string is allowed for codes the API adds later. */
export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN_ACTION"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "INTERNAL"
  | "NETWORK"
  | (string & {});

/** An error from the Heliyos API or from reaching it. Carries a machine-readable code, the HTTP status (0 when there was no response) and optional details. */
export class HeliyosApiError extends Error {
  override readonly name = "HeliyosApiError";

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    /** HTTP status, or 0 when no response was received. */
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message);
  }
}

/** The standard response wrapper of the Heliyos API: a `meta` object and the `data` payload. */
export interface Envelope<T = unknown> {
  meta: Record<string, unknown>;
  data: T;
}

/** A value allowed in a query string: a scalar or a list of scalars. Null and undefined are left out. */
export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number | boolean>;

/** Optional parts of a request: query parameters and a JSON body. */
export interface RequestOptions {
  query?: Record<string, QueryValue | Record<string, unknown>>;
  body?: unknown;
}

/** A function that sends one request to a path of the Heliyos API and resolves to its Envelope. */
export type RequestFn = (path: string, options?: RequestOptions) => Promise<Envelope>;

/** The HTTP client the tools use: one method per HTTP verb, plus an upload to a presigned URL. */
export interface HeliyosClient {
  get: RequestFn;
  post: RequestFn;
  put: RequestFn;
  patch: RequestFn;
  delete: RequestFn;
  /**
   * PUTs bytes to a presigned upload URL from the API (an absolute https URL on
   * the storage host). Sends only Content-Type: never the API key.
   */
  putPresigned(url: string, body: Uint8Array, contentType: string): Promise<void>;
}

/** Settings for createClient: base URL, API key and optional hooks for tests. */
export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout in milliseconds. Defaults to 120 s (the MCP tool timeout we document). */
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 2_000;

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN_ACTION",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION_FAILED",
  429: "RATE_LIMITED",
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Creates a HeliyosClient for `options.baseUrl` that signs requests with the API key, retries transient failures
 * and turns error responses into HeliyosApiError. The key is registered for redaction.
 */
export function createClient(options: ClientOptions): HeliyosClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  registerSecret(options.apiKey);
  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    Accept: "application/json",
    "User-Agent": `heliyos-mcp/${PACKAGE_VERSION}`,
  };

  const request = async (method: string, path: string, opts: RequestOptions = {}): Promise<Envelope> => {
    const url = buildUrl(baseUrl, path, opts.query);
    const init: RequestInit = { method, headers: { ...headers } };
    if (opts.body !== undefined) {
      init.headers = { ...headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }

    let response = await send(fetchImpl, url, init, timeoutMs, method, path);
    if (response.status === 429) {
      const waitMs = retryAfterMs(response.headers.get("retry-after"));
      // Release the unread 429 body so the connection is not held open while we wait.
      discardBody(response);
      await sleep(waitMs);
      response = await send(fetchImpl, url, init, timeoutMs, method, path);
    }
    return parseResponse(response, method, path);
  };

  const putPresigned = async (url: string, body: Uint8Array, contentType: string): Promise<void> => {
    const host = presignedHost(url);
    // A fresh header set: the bearer key must never reach the storage host.
    // redirect "error": a redirect (for example to http) must never resend the file elsewhere.
    const init: RequestInit = { method: "PUT", headers: { "Content-Type": contentType }, body, redirect: "error" };
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const reason = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : describeCause(err);
      throw new HeliyosApiError("NETWORK", `Uploading the file to ${host} failed: ${reason}`, 0);
    }
    discardBody(response);
    if (!response.ok) {
      throw new HeliyosApiError(
        "INTERNAL",
        `File storage (${host}) rejected the upload with HTTP ${response.status}; nothing was saved in Heliyos`,
        response.status
      );
    }
  };

  return {
    get: (path, opts) => request("GET", path, opts),
    post: (path, opts) => request("POST", path, opts),
    put: (path, opts) => request("PUT", path, opts),
    patch: (path, opts) => request("PATCH", path, opts),
    delete: (path, opts) => request("DELETE", path, opts),
    putPresigned,
  };
}

/** The host of a presigned upload URL, which must be absolute https; the URL itself (with its signature) is never echoed. */
function presignedHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HeliyosApiError("INTERNAL", "The API returned an upload URL that is not an absolute URL", 0);
  }
  if (parsed.protocol !== "https:") {
    throw new HeliyosApiError("INTERNAL", "The API returned an upload URL that is not https; refusing to send the file", 0);
  }
  return parsed.host;
}

/**
 * Joins a path onto the base URL. Only origin-relative paths are accepted so a
 * caller can never redirect the bearer key to another host.
 */
function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new HeliyosApiError("VALIDATION_FAILED", `Request path must start with a single "/": ${path}`, 0);
  }
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (typeof value === "object") {
      url.searchParams.append(key, JSON.stringify(value));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  method: string,
  path: string
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const reason = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : describeCause(err);
    throw new HeliyosApiError("NETWORK", `${method} ${path} failed: ${reason}`, 0);
  }
}

/**
 * Cancels an unread body so its connection is released. Not awaited to
 * completion: some stream implementations (msw's interceptor among them) never
 * settle the cancel promise, and the retry must not hang on it.
 */
function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // Already locked or consumed: nothing to release.
  }
}

/** A short, key-free description of a fetch failure. */
function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return "network error";
  const cause = (err as Error & { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : undefined;
  return code ? `${err.message} (${code})` : err.message || "network error";
}

/** Retry-After as delta-seconds or an HTTP date; capped at 30 s; 2 s when absent or invalid. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const value = header.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const date = Date.parse(value);
    if (Number.isNaN(date)) return DEFAULT_RETRY_AFTER_MS;
    ms = date - now;
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

async function parseResponse(response: Response, method: string, path: string): Promise<Envelope> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new HeliyosApiError("NETWORK", `${method} ${path} failed while reading the response: ${describeCause(err)}`, response.status);
  }

  if (response.ok && text.trim() === "") return { meta: {}, data: null };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HeliyosApiError(
      "NETWORK",
      `${method} ${path} returned a non-JSON response (HTTP ${response.status}).`,
      response.status
    );
  }

  if (!response.ok) throw toApiError(json, response.status);

  if (isRecord(json) && "data" in json) {
    return { meta: isRecord(json.meta) ? json.meta : {}, data: json.data };
  }
  return { meta: {}, data: json };
}

function toApiError(json: unknown, status: number): HeliyosApiError {
  const fallbackCode = STATUS_CODES[status] ?? "INTERNAL";
  const error = isRecord(json) && isRecord(json.error) ? json.error : undefined;
  const legacyMessage = isRecord(json) && isRecord(json.meta) ? json.meta.message : undefined;

  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : fallbackCode;
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : typeof legacyMessage === "string" && legacyMessage.length > 0
        ? legacyMessage
        : `Request failed with HTTP ${status}.`;
  return new HeliyosApiError(code, message, status, error?.details);
}
