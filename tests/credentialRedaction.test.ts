/**
 * No credential (Nylas/OAuth token, grant id, API key, key hash) reaches an MCP
 * client, whatever a backend response carries. Every tool result goes through
 * redactToolOutput in defineTool.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { isCredentialKey, redactCredentials, redactToolOutput, REDACTED } from "../src/secrets.js";
import { expectOk, useMockApi } from "./helpers/harness.js";
import { ok, P, RECORD_IDS } from "./helpers/platform.js";

const SECRETS = ["nylas_at_1234567", "nylas_key_456789", "grant-7890abcd", "conn-12345678", "hash-abcdef12"];
const creds = {
  accessToken: SECRETS[0],
  apiKey: SECRETS[1],
  grantId: SECRETS[2],
  composioConnectionId: SECRETS[3],
  keyHash: SECRETS[4],
};

const leaks = (s: string) => SECRETS.filter((x) => s.includes(x));

describe("credential redaction helpers", () => {
  it("redacts credential keys at any depth and keeps CRM fields", () => {
    const input = { a: [{ ...creds, email: "rep@acme.com" }], data: { signature: "Best", card: "Visa", pin: "560001", total_tokens: 3 } };
    const out = redactCredentials(input) as any;
    expect(out.a[0].accessToken).toBe(REDACTED);
    expect(out.a[0].grantId).toBe(REDACTED);
    expect(out.a[0].email).toBe("rep@acme.com");
    expect(out.data).toEqual(input.data);
    expect(input.a[0]!.accessToken).toBe(SECRETS[0]); // not mutated
    for (const k of ["signature", "card", "pin", "session", "totalTokens", "accountId", "grantSyncStatus"]) {
      expect(isCredentialKey(k)).toBe(false);
    }
  });

  it("scrubs JSON-shaped pairs and values seen in structured content out of text", () => {
    const text = `raw: {"accessToken": "${SECRETS[0]}", "title": "Gmail"} and later ${SECRETS[1]} again`;
    const out = redactToolOutput(text, { apiKey: SECRETS[1] });
    expect(leaks(out.text)).toEqual([]);
    expect(out.text).toContain('"title": "Gmail"');
    expect((out.structuredContent as any).apiKey).toBe(REDACTED);
  });

  it("leaves ordinary output untouched", () => {
    const text = 'Stage changed from "Lead" to "Customer". {"stage": "Customer", "token_count": "12"}';
    const out = redactToolOutput(text, { stage: "Customer", tokenCount: 12 });
    expect(out.text).toBe(text);
    expect(out.structuredContent).toEqual({ stage: "Customer", tokenCount: 12 });
  });
});

describe("tool output end to end", () => {
  const { api, call } = useMockApi();
  const ID = RECORD_IDS.acme;

  it("heliyos_records_events never returns a credential from an event", async () => {
    const event = {
      _id: "66d000000000000000000001",
      timestamp: "2026-10-26T15:33:22.000Z",
      metadata: {
        actor: { name: "Rep", type: "USER", uuid: "u1" },
        eventType: "AUDIT",
        objectType: "company",
        objectUUID: ID,
        operationType: "UPDATE",
        organizationUUID: "org",
      },
      originalVersion: { ...creds, grantSyncStatus: "FAILED" },
      updatedVersion: { ...creds, accessToken: "nylas_at_NEWVALUE", grantSyncStatus: "SYNCED" },
      changeSummary: `Updated {"accessToken": "${SECRETS[0]}"}`,
    };
    api.use(http.get(`${P}/records/${ID}/events`, () => ok([event], { pagination: { limit: 20 } })));

    for (const response_format of ["concise", "detailed"] as const) {
      const result = await call("heliyos_records_events", { record_id: ID, response_format });
      const text = expectOk(result);
      const everything = text + JSON.stringify(result.structuredContent ?? {});
      expect(leaks(everything)).toEqual([]);
      expect(everything).not.toContain("nylas_at_NEWVALUE");
      expect(text).toContain("Rep");
    }
  });
});
