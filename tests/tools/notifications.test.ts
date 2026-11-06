/**
 * The heliyos_notification_settings_get, heliyos_notification_settings_update tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, ok, P } from "../helpers/platform.js";

const { api, call } = useMockApi();
const settings = {
  _id: "6aa000000000000000000001",
  isActive: true,
  notifyEmails: ["ops@acme.com"],
  eventTypes: [
    { type: "task.created", frequency: "immediate" },
    { type: "organization.daily_summary", frequency: "daily" },
  ],
};

describe("heliyos_notification_settings_get", () => {
  it("returns recipients and event types", async () => {
    api.use(http.get(`${P}/notification-settings`, () => ok(settings)));
    const result = await call("heliyos_notification_settings_get");
    const text = expectOk(result);
    expect(text).toContain("ops@acme.com");
    expect(text).toContain("task.created");
    expect(result.structuredContent).toEqual({
      settings: {
        configured: true,
        is_active: true,
        notify_emails: ["ops@acme.com"],
        event_types: [
          { type: "task.created", frequency: "immediate" },
          { type: "organization.daily_summary", frequency: "daily" },
        ],
      },
    });
  });

  it("reports unconfigured settings when the API returns null", async () => {
    api.use(http.get(`${P}/notification-settings`, () => ok(null)));
    const result = await call("heliyos_notification_settings_get");
    expect(expectOk(result)).toMatch(/not been set up/);
    expect((result.structuredContent as Structured).settings.configured).toBe(false);
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${P}/notification-settings`, () => apiError(403, "FORBIDDEN_ACTION", "Not allowed")));
    expectToolError(await call("heliyos_notification_settings_get"), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_notification_settings_update", () => {
  it("sends only the given keys in the API's shape", async () => {
    let body: any;
    api.use(
      http.patch(`${P}/notification-settings`, async ({ request }) => {
        body = await request.json();
        return ok({ ...settings, isActive: false, notifyEmails: ["a@b.co"] });
      })
    );
    const result = await call("heliyos_notification_settings_update", { is_active: false, notify_emails: ["a@b.co"] });
    expectOk(result);
    expect(body).toEqual({ isActive: false, notifyEmails: ["a@b.co"] });
    expect((result.structuredContent as Structured).settings.is_active).toBe(false);
  });

  it("rejects an unknown event type and an empty update before calling the API", async () => {
    expect((await call("heliyos_notification_settings_update", {})).isError).toBe(true);
    expect(
      (await call("heliyos_notification_settings_update", { event_types: [{ type: "nope", frequency: "daily" }] })).isError
    ).toBe(true);
  });

  it("surfaces a server error", async () => {
    api.use(http.patch(`${P}/notification-settings`, () => apiError(400, "VALIDATION_FAILED", "notifyEmails[0] must be a valid email")));
    expectToolError(await call("heliyos_notification_settings_update", { is_active: true }), "VALIDATION_FAILED");
  });
});
