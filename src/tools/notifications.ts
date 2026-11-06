/**
 * Notification settings: which events email whom, and how often. One settings
 * document per workspace (getNotificationSettings / updateNotificationSettings).
 */
import * as z from "zod/v4";
import { callOperation } from "../client/operations.js";
import { renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import { READ_ONLY, stringOf, UPDATES, type ToolContext } from "./common.js";
import { tool, type ToolSpec } from "./define.js";

/** The event types the platform accepts (updateNotificationSettings). */
export const NOTIFICATION_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "deal.created",
  "deal.updated",
  "deal.approval",
  "leadset.created",
  "leadset.records.available",
  "organization.daily_summary",
  "scout.signal_detected",
  "integration.not_synced",
] as const;
const FREQUENCIES = ["immediate", "daily"] as const;

const eventTypeOut = z.object({ type: z.string(), frequency: z.string() });

const settingsOut = z.object({
  configured: z.boolean().describe("false when the workspace has never saved notification settings."),
  is_active: z.boolean().describe("When false, no notification emails are sent."),
  notify_emails: z.array(z.string()),
  event_types: z.array(eventTypeOut),
});
type SettingsOut = z.infer<typeof settingsOut>;

function settingsOf(data: unknown): SettingsOut {
  if (!isRecord(data)) return { configured: false, is_active: false, notify_emails: [], event_types: [] };
  const emails = Array.isArray(data.notifyEmails) ? data.notifyEmails.map(stringOf).filter((e): e is string => !!e) : [];
  const events = (Array.isArray(data.eventTypes) ? data.eventTypes : []).filter(isRecord).flatMap((e) => {
    const type = stringOf(e.type);
    return type ? [{ type, frequency: stringOf(e.frequency) ?? "immediate" }] : [];
  });
  return { configured: true, is_active: data.isActive !== false, notify_emails: emails, event_types: events };
}

function settingsText(s: SettingsOut): string {
  if (!s.configured) {
    return "Notification settings have not been set up for this workspace; no notification emails are sent. Use heliyos_notification_settings_update to set them.";
  }
  return renderRecord({
    notifications: s.is_active ? "on" : "off",
    recipients: s.notify_emails.length ? s.notify_emails : "none",
    events: s.event_types.length ? s.event_types.map((e) => `${e.type} (${e.frequency})`) : "none",
  });
}

/** Builds the tools that read and update the workspace's notification email settings, from the shared tool context. */
export function notificationTools({ client }: ToolContext): ToolSpec[] {
  const get = tool({
    name: "heliyos_notification_settings_get",
    title: "Get notification settings",
    description:
      "Returns the workspace's notification email settings: whether they are on, who receives them, and which events " +
      "notify (each immediate or in a daily digest). Returns structuredContent {settings:{configured, is_active, " +
      "notify_emails, event_types:[{type, frequency}]}}.",
    // No response_format: one small settings document with no detail tier.
    input: z.strictObject({}),
    output: z.object({ settings: settingsOut }),
    annotations: READ_ONLY,
    async handler() {
      const { data } = await callOperation(client, "getNotificationSettings");
      const settings = settingsOf(data);
      return { text: settingsText(settings), structuredContent: { settings } };
    },
  });

  const update = tool({
    name: "heliyos_notification_settings_update",
    title: "Update notification settings",
    description:
      "Changes the workspace's notification email settings. Each key you pass REPLACES that setting: notify_emails is " +
      "the full recipient list and event_types the full list of notifying events (read the current ones with " +
      "heliyos_notification_settings_get and send the complete list). Keys you leave out are kept. " +
      "scout.signal_detected is always immediate. Returns structuredContent {settings}.",
    input: z
      .strictObject({
        is_active: z.boolean().optional().describe("Turns all notification emails on or off."),
        notify_emails: z.array(z.email()).max(50).optional().describe("Every recipient address (replaces the list)."),
        event_types: z
          .array(
            z.strictObject({
              type: z.enum(NOTIFICATION_EVENT_TYPES).describe("The event, for example task.created or deal.approval."),
              frequency: z.enum(FREQUENCIES).describe('"immediate" (one email per event) or "daily" (in the daily digest).'),
            })
          )
          .max(NOTIFICATION_EVENT_TYPES.length)
          .optional()
          .describe("Every event that should notify, each immediate or daily (replaces the list)."),
      })
      .refine((v) => v.is_active !== undefined || v.notify_emails !== undefined || v.event_types !== undefined, {
        message: "Give at least one of is_active, notify_emails or event_types",
      }),
    output: z.object({ settings: settingsOut }),
    annotations: UPDATES,
    async handler(args) {
      const { data } = await callOperation(client, "updateNotificationSettings", {
        body: {
          ...(args.is_active !== undefined ? { isActive: args.is_active } : {}),
          ...(args.notify_emails ? { notifyEmails: args.notify_emails } : {}),
          ...(args.event_types ? { eventTypes: args.event_types } : {}),
        },
      });
      const settings = settingsOf(data);
      return { text: `Saved notification settings.\n${settingsText(settings)}`, structuredContent: { settings } };
    },
  });

  return [get, update];
}
