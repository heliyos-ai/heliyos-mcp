/**
 * The base schema resolver: object type lookup, field validation, caching and invalidation.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { describe, expect, it, vi } from "vitest";
import type { HeliyosClient } from "../../src/client/http.js";
import { createSchemaResolver, SCHEMA_CACHE_TTL_MS } from "../../src/tools/baseSchemas.js";
import { schemas, SCHEMA_IDS } from "../helpers/platform.js";

function clientWithSchemas() {
  const get = vi.fn(async () => ({ meta: {}, data: schemas }));
  const refuse = vi.fn(async () => {
    throw new Error("unexpected call");
  });
  const client: HeliyosClient = { get, post: refuse, put: refuse, patch: refuse, delete: refuse, putPresigned: refuse };
  return { client, get };
}

describe("createSchemaResolver", () => {
  it("defaults to a 5 minute cache TTL", () => {
    expect(SCHEMA_CACHE_TTL_MS).toBe(300_000);
  });

  it("serves the cached list within the TTL and re-reads it after", async () => {
    let t = 0;
    const { client, get } = clientWithSchemas();
    const resolver = createSchemaResolver(client, { ttlMs: 1_000, now: () => t });

    expect((await resolver.resolve("company")).id).toBe(SCHEMA_IDS.company);
    t = 999;
    await resolver.resolve("person");
    expect(get).toHaveBeenCalledTimes(1);

    t = 1_000;
    await resolver.resolve("deal");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const { client, get } = clientWithSchemas();
    const resolver = createSchemaResolver(client);
    await Promise.all([resolver.resolve("company"), resolver.resolve("deal"), resolver.find(SCHEMA_IDS.person)]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("find() re-reads once for an unknown id and then remembers the miss until the TTL expires", async () => {
    let t = 0;
    const { client, get } = clientWithSchemas();
    const resolver = createSchemaResolver(client, { ttlMs: 1_000, now: () => t });
    await resolver.resolve("company");

    expect(await resolver.find("64a0000000000000000000ff")).toBeUndefined();
    expect(await resolver.find("64a0000000000000000000ff")).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);

    t = 5_000;
    await resolver.find("64a0000000000000000000ff");
    expect(get).toHaveBeenCalledTimes(3);
  });
});
