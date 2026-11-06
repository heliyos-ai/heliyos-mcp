/**
 * The OpenAPI code generator: which operations it emits, colliding operationIds, and the generated zod schemas.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { callOperation } from "../src/client/operations.js";
import { operations } from "../src/client/generated.js";
import type { HeliyosClient } from "../src/client/http.js";
import { generate, usedOperationIds } from "../scripts/codegen.mjs";

const OBJECT_ID = "0123456789abcdef01234567";

describe("generated operations", () => {
  it.each([
    ["listRecords", "GET", "/v1/platform/base-schemas/{id}/records", "platform"],
    ["getOrganization", "GET", "/v1/platform/organization", "platform"],
    ["createTask", "POST", "/v1/platform/tasks", "platform"],
    ["listTeamMemberships", "GET", "/v1/auth/team-memberships", "auth"],
  ] as const)("%s is %s %s", (operationId, method, path, service) => {
    const op = operations[operationId];
    expect(op).toBeDefined();
    expect(op.method).toBe(method);
    expect(op.path).toBe(path);
    expect(op.service).toBe(service);
  });

  it("validates path params and query bounds for listRecords", () => {
    const op = operations.listRecords;
    expect(op.params.safeParse({ id: OBJECT_ID }).success).toBe(true);
    expect(op.params.safeParse({ id: "not-an-id" }).success).toBe(false);
    expect(op.query.safeParse({ limit: 20 }).success).toBe(true);
    expect(op.query.safeParse({ limit: 101 }).success).toBe(false);
    expect(op.query.safeParse({ unknownKey: 1 }).success).toBe(false);
  });

  it("rejects a bad createTask body and accepts a good one", () => {
    const body = operations.createTask.body;
    expect(body.safeParse({}).success).toBe(false); // title is required
    expect(body.safeParse({ title: 42 }).success).toBe(false);
    expect(body.safeParse({ title: "Call Acme", surprise: true }).success).toBe(false); // additionalProperties: false
    expect(
      body.safeParse({ title: "Call Acme", assignedAgents: [{ agentId: "a1", role: "nope" }] }).success
    ).toBe(false); // enum
    expect(
      body.safeParse({ title: "Call Acme", assignedAgents: [{ agentId: "a1", role: "reviewer" }] }).success
    ).toBe(true);
  });

  it("emits exactly the operations the tools and resources call, nothing else from the OpenAPI documents", () => {
    const emitted = Object.keys(operations).sort();
    const used = usedOperationIds();
    expect(emitted).toEqual(used);
    expect(used.length).toBeGreaterThan(50);
    // Operations the MCP never calls must not ship in the package.
    for (const id of ["createSession", "createSignup", "createApiKey", "createCheckout", "listAgencyInvitations"]) {
      expect(emitted).not.toContain(id);
    }
  });

  it("is idempotent: regenerating from the committed OpenAPI files reproduces generated.ts", () => {
    const committed = readFileSync(fileURLToPath(new URL("../src/client/generated.ts", import.meta.url)), "utf8");
    expect(generate()).toBe(committed);
  });
});

describe("callOperation", () => {
  const fakeClient = () => {
    const call = vi.fn(async () => ({ meta: {}, data: { ok: true } }));
    const client: HeliyosClient = { get: call, post: call, put: call, patch: call, delete: call, putPresigned: async () => {} };
    return { client, call };
  };

  it("fills the path template with encoded params and passes query through", async () => {
    const { client, call } = fakeClient();
    await callOperation(client, "listRecords", { params: { id: OBJECT_ID }, query: { limit: 5 } });
    expect(call).toHaveBeenCalledWith(`/v1/platform/base-schemas/${OBJECT_ID}/records`, {
      query: { limit: 5 },
      body: undefined,
    });
  });

  it("rejects invalid input before any HTTP call", async () => {
    const { client, call } = fakeClient();
    await expect(callOperation(client, "createTask", { body: { nope: 1 } as never })).rejects.toThrow(/createTask/);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([".", ".."])("refuses the dot-segment path param %j, which would resolve to another route", async (id) => {
    const { client, call } = fakeClient();
    await expect(callOperation(client, "getWorkerRun", { params: { id } })).rejects.toThrow(/cannot be/);
    expect(call).not.toHaveBeenCalled();
  });
});
