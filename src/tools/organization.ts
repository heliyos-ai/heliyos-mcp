/**
 * Organization: the caller's workspace at a glance (getOrganization). One tool,
 * usually the first call an agent makes to orient itself.
 */
import * as z from "zod/v4";
import { callOperation } from "../client/operations.js";
import { renderRecord } from "../format/text.js";
import { isRecord } from "../util.js";
import { expectObject, numberOf, READ_ONLY, requireId, stringOf, type ToolContext } from "./common.js";
import { tool, type ToolSpec } from "./define.js";

const organizationOut = z.object({
  id: z.string(),
  name: z.string(),
  billing_status: z.string().optional(),
  plan: z.string().optional().describe("Active plan name; absent when the workspace has no active plan."),
  member_count: z.number().int(),
  record_counts: z.object({ companies: z.number().int(), people: z.number().int(), deals: z.number().int() }),
  watchers_in_use: z.number().int().describe("Companies on the watchlist."),
  watchers_limit: z.number().int().optional().describe("Watched-company limit of the active plan."),
});

/** Builds the tool that reads the workspace's details, from the shared tool context. */
export function organizationTools({ client }: ToolContext): ToolSpec[] {
  const get = tool({
    name: "heliyos_organization_get",
    title: "Get the workspace",
    description:
      "Returns the Heliyos workspace this API key belongs to: its id and name, billing status, active plan, member count, " +
      "how many companies, people and deals it holds, and how many companies are watched out of the plan's limit. " +
      "Call it first to orient yourself. Use heliyos_objects_list for the objects and their schema ids, " +
      "heliyos_usage_get for credit usage. Returns structuredContent {organization}.",
    // No response_format: the summary is small and has no detail tier.
    input: z.strictObject({}),
    output: z.object({ organization: organizationOut }),
    annotations: READ_ONLY,
    async handler() {
      const { data } = await callOperation(client, "getOrganization");
      const raw = expectObject(data, "organization");
      const counts = isRecord(raw.recordCounts) ? raw.recordCounts : {};
      // An active plan whose product has no name is still an active plan.
      const plan = isRecord(raw.plan) ? (stringOf(raw.plan.name) ?? "unnamed plan") : undefined;
      const billing = stringOf(raw.billingStatus);
      const limit = numberOf(raw.watchersLimit);
      const org = {
        id: requireId(raw, "organization"),
        name: stringOf(raw.name) ?? "",
        ...(billing ? { billing_status: billing } : {}),
        ...(plan ? { plan } : {}),
        member_count: numberOf(raw.memberCount) ?? 0,
        record_counts: {
          companies: numberOf(counts.companies) ?? 0,
          people: numberOf(counts.people) ?? 0,
          deals: numberOf(counts.deals) ?? 0,
        },
        watchers_in_use: numberOf(raw.watchersInUse) ?? 0,
        ...(limit !== undefined ? { watchers_limit: limit } : {}),
      };
      const watchers =
        limit !== undefined ? `${org.watchers_in_use} of ${limit} watched companies` : `${org.watchers_in_use} watched companies`;
      const text = [
        `Workspace "${org.name}" (organization id ${org.id})`,
        renderRecord({
          plan: plan ?? "no active plan",
          billing_status: billing,
          members: org.member_count,
          records: `${org.record_counts.companies} companies, ${org.record_counts.people} people, ${org.record_counts.deals} deals`,
          watchlist: watchers,
        }),
      ].join("\n");
      return { text, structuredContent: { organization: org } };
    },
  });

  return [get];
}
