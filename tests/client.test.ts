/**
 * The HTTP client: bearer auth, the response envelope, error mapping, retries on 429 and the redaction of the key in errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient, HeliyosApiError, retryAfterMs } from "../src/client/http.js";

const BASE = "https://api.test.heliyos.ai";
const KEY = "heliyos_ABCDEFGHJKLMNPQRSTUVWXYZabcdef";
const ORG_URL = `${BASE}/v1/platform/organization`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ok = (data: unknown) => HttpResponse.json({ meta: { message: "ok" }, data });

/** Captures the error a promise rejects with, failing the test if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<HeliyosApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HeliyosApiError);
    return err as HeliyosApiError;
  }
  throw new Error("expected the request to fail");
}

describe("createClient", () => {
  it("sends the bearer key, Accept and User-Agent headers and returns the envelope", async () => {
    let seen: Headers | undefined;
    server.use(
      http.get(ORG_URL, ({ request }) => {
        seen = request.headers;
        return ok({ id: "org_1", name: "Acme" });
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const result = await client.get("/v1/platform/organization");

    expect(result).toEqual({ meta: { message: "ok" }, data: { id: "org_1", name: "Acme" } });
    expect(seen?.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen?.get("accept")).toBe("application/json");
    expect(seen?.get("user-agent")).toMatch(/^heliyos-mcp\/\d+\.\d+\.\d+/);
  });

  it("serialises query values and skips undefined ones", async () => {
    let url: URL | undefined;
    server.use(
      http.get(`${BASE}/v1/platform/tasks`, ({ request }) => {
        url = new URL(request.url);
        return ok([]);
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    await client.get("/v1/platform/tasks", {
      query: { limit: 20, cursor: undefined, ids: ["a", "b"], done: false },
    });
    expect(url?.searchParams.get("limit")).toBe("20");
    expect(url?.searchParams.has("cursor")).toBe(false);
    expect(url?.searchParams.getAll("ids")).toEqual(["a", "b"]);
    expect(url?.searchParams.get("done")).toBe("false");
  });

  it("sends a JSON body on POST", async () => {
    let body: unknown;
    let contentType: string | null = null;
    server.use(
      http.post(`${BASE}/v1/platform/tasks`, async ({ request }) => {
        contentType = request.headers.get("content-type");
        body = await request.json();
        return ok({ id: "t1" });
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const result = await client.post("/v1/platform/tasks", { body: { title: "Call Acme" } });
    expect(result.data).toEqual({ id: "t1" });
    expect(contentType).toContain("application/json");
    expect(body).toEqual({ title: "Call Acme" });
  });

  it("returns null data for an empty 204 response", async () => {
    server.use(http.delete(`${BASE}/v1/platform/tasks/1`, () => new HttpResponse(null, { status: 204 })));
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    expect(await client.delete("/v1/platform/tasks/1")).toEqual({ meta: {}, data: null });
  });

  it("retries once on 429 after Retry-After seconds, then returns the result", async () => {
    let calls = 0;
    server.use(
      http.get(ORG_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { error: { code: "RATE_LIMITED", message: "Slow down" } },
            { status: 429, headers: { "Retry-After": "1" } }
          );
        }
        return ok({ id: "org_1", name: "Acme" });
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const started = Date.now();
    const result = await client.get("/v1/platform/organization");
    expect(result.data).toEqual({ id: "org_1", name: "Acme" });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("caps Retry-After at 30 s and defaults to 2 s when it is absent", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let calls = 0;
    server.use(
      http.get(ORG_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: { code: "RATE_LIMITED", message: "x" } }, { status: 429, headers: { "Retry-After": "120" } });
        }
        if (calls === 3) {
          return HttpResponse.json({ error: { code: "RATE_LIMITED", message: "x" } }, { status: 429 });
        }
        return ok({});
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY, sleep });
    await client.get("/v1/platform/organization");
    await client.get("/v1/platform/organization");
    expect(waits).toEqual([30_000, 2_000]);
  });

  it("gives up after one retry and surfaces RATE_LIMITED", async () => {
    let calls = 0;
    server.use(
      http.get(ORG_URL, () => {
        calls += 1;
        return HttpResponse.json({ error: { code: "RATE_LIMITED", message: "Slow down" } }, { status: 429, headers: { "Retry-After": "0" } });
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY, sleep: async () => {} });
    const err = await rejectionOf(client.get("/v1/platform/organization"));
    expect(calls).toBe(2);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.status).toBe(429);
  });

  it("maps an error envelope to HeliyosApiError with code, message, status and details", async () => {
    server.use(
      http.get(`${BASE}/v1/platform/tasks/abc`, () =>
        HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Task not found", details: { id: "abc" } } },
          { status: 404 }
        )
      )
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.get("/v1/platform/tasks/abc"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Task not found");
    expect(err.details).toEqual({ id: "abc" });
  });

  it("derives the code from the status when the error body has none", async () => {
    server.use(http.get(ORG_URL, () => HttpResponse.json({ meta: { message: "Forbidden" } }, { status: 403 })));
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.get("/v1/platform/organization"));
    expect(err.code).toBe("FORBIDDEN_ACTION");
    expect(err.status).toBe(403);
  });

  it("maps a network failure to NETWORK without leaking the key", async () => {
    server.use(http.get(ORG_URL, () => HttpResponse.error()));
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.get("/v1/platform/organization"));
    expect(err.code).toBe("NETWORK");
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(KEY);
  });

  it("maps a non-JSON response to NETWORK and keeps the status", async () => {
    server.use(
      http.get(ORG_URL, () => new HttpResponse("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }))
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.get("/v1/platform/organization"));
    expect(err.code).toBe("NETWORK");
    expect(err.status).toBe(502);
  });

  it("refuses paths that would send the key to another host", async () => {
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.get("https://evil.example.com/steal")).rejects.toThrow(/path/i);
    await expect(client.get("//evil.example.com/steal")).rejects.toThrow(/path/i);
  });
});

describe("retryAfterMs", () => {
  // HTTP dates have one-second resolution, so pin "now" to a whole second.
  const now = Date.parse("2026-10-22T10:00:00.000Z");

  it("reads an HTTP-date Retry-After as the delay until that date", () => {
    expect(retryAfterMs(new Date(now + 5_000).toUTCString(), now)).toBe(5_000);
  });

  it("treats an HTTP date in the past as no wait", () => {
    expect(retryAfterMs(new Date(now - 10_000).toUTCString(), now)).toBe(0);
  });

  it("caps an HTTP date far in the future at 30 s", () => {
    expect(retryAfterMs(new Date(now + 600_000).toUTCString(), now)).toBe(30_000);
  });

  it("falls back to 2 s for an unparseable value", () => {
    expect(retryAfterMs("soon", now)).toBe(2_000);
  });
});

describe("429 retry", () => {
  it("cancels the 429 response body before waiting and retrying", async () => {
    let cancelled = false;
    const events: string[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        const body = new ReadableStream({
          cancel() {
            cancelled = true;
            events.push("cancel");
          },
        });
        return new Response(body, { status: 429, headers: { "Retry-After": "0" } });
      }
      return new Response(JSON.stringify({ meta: {}, data: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    const client = createClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetchImpl,
      sleep: async () => {
        events.push("sleep");
      },
    });

    const result = await client.get("/v1/platform/organization");

    expect(result.data).toEqual({ ok: true });
    expect(cancelled).toBe(true);
    expect(events).toEqual(["cancel", "sleep"]);
  });
});

describe("putPresigned", () => {
  const S3 = "https://heliyos-assets.s3.amazonaws.com/64f000000000000000000001/1-a.txt";
  const SIGNED = `${S3}?X-Amz-Signature=secretsig&X-Amz-Credential=AKIA`;

  it("PUTs the bytes with the signed content type and never sends the API key", async () => {
    let seen: Headers | undefined;
    let body: string | undefined;
    server.use(
      http.put(S3, async ({ request }) => {
        seen = request.headers;
        body = await request.text();
        return new HttpResponse(null, { status: 200 });
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    await client.putPresigned(SIGNED, new TextEncoder().encode("hello"), "text/plain");

    expect(body).toBe("hello");
    expect(seen?.get("content-type")).toBe("text/plain");
    expect(seen?.has("authorization")).toBe(false);
    expect([...seen!.values()].join(" ")).not.toContain(KEY);
  });

  it("refuses a non-https URL before sending anything", async () => {
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.putPresigned("http://example.com/x", new Uint8Array(1), "text/plain"));
    expect(err.code).toBe("INTERNAL");
  });

  it("reports a network failure without the signed URL", async () => {
    server.use(http.put(S3, () => HttpResponse.error()));
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.putPresigned(SIGNED, new Uint8Array(1), "text/plain"));
    expect(err.code).toBe("NETWORK");
    expect(err.message).toContain("heliyos-assets.s3.amazonaws.com");
    expect(err.message).not.toContain("secretsig");
    expect(err.message).not.toContain("X-Amz");
  });

  it("does not follow a redirect", async () => {
    let followed = false;
    server.use(
      http.put(S3, () => new HttpResponse(null, { status: 307, headers: { Location: "http://plain.example.com/x" } })),
      http.put("http://plain.example.com/x", () => {
        followed = true;
        return new HttpResponse(null, { status: 200 });
      })
    );
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    await rejectionOf(client.putPresigned(SIGNED, new Uint8Array(1), "text/plain"));
    expect(followed).toBe(false);
  });

  it("reports a storage rejection without the signed URL", async () => {
    server.use(http.put(S3, () => new HttpResponse("<Error>SignatureDoesNotMatch</Error>", { status: 403 })));
    const client = createClient({ baseUrl: BASE, apiKey: KEY });
    const err = await rejectionOf(client.putPresigned(SIGNED, new Uint8Array(1), "text/plain"));
    expect(err.code).toBe("INTERNAL");
    expect(err.message).toContain("403");
    expect(err.message).not.toContain("secretsig");
    expect(err.message).not.toContain(KEY);
  });
});
