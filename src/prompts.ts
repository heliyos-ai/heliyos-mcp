/**
 * Prompts: two ready-made workflows that tell the agent which heliyos_ tools to
 * call and in what order. Convenience only: every capability is also a tool.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { hexId } from "./tools/common.js";

const userText = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** Registers the MCP prompts on `server`: ready-made requests that guide the model through common CRM jobs. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "prepare_account_review",
    {
      title: "Prepare an account review",
      description: "Brief on one company before a meeting or review: record, recent activity, open work, deals and signals.",
      argsSchema: z.object({ company_id: hexId("company_id").describe("The company record id (heliyos_records_lookup finds it).") }),
    },
    ({ company_id }) =>
      userText(
        [
          `Prepare an account review for the company with record id ${company_id} in Heliyos.`,
          "",
          `1. Call heliyos_records_get with record_id ${company_id} and response_format "detailed" for its fields and linked people and deals.`,
          "2. For each linked deal, call heliyos_records_get with the deal's id for stage and amount.",
          `3. Call heliyos_records_timeline with record_id ${company_id} for recent activity, and heliyos_interactions_list with record_id ${company_id} for recent emails and meetings.`,
          `4. Call heliyos_tasks_list with record_id ${company_id} for open work, and heliyos_notes_list with record_id ${company_id} for notes.`,
          `5. Call heliyos_signals_list with company_id ${company_id} for what scouts found recently.`,
          "",
          "Then write a short review: where the account stands, what changed recently, open risks, and the next three actions with owners.",
          "Cite record, task and signal ids next to the facts they support. Do not create, update or delete anything unless I ask.",
        ].join("\n")
      )
  );

  server.registerPrompt(
    "daily_pipeline_summary",
    {
      title: "Daily pipeline summary",
      description: "Summarise today's pipeline: deals, open tasks, runs waiting on a person and new signals.",
    },
    () =>
      userText(
        [
          "Give me today's pipeline summary from Heliyos.",
          "",
          '1. Call heliyos_records_list with object_type "deal" for the current deals (page with next_cursor if there are more).',
          '2. Call heliyos_tasks_list with status "in_progress", then with status "backlog", for open work.',
          '3. Call heliyos_runs_list with status "awaiting_approval" for worker runs waiting on a person.',
          '4. Call heliyos_signals_list with status "new" for unread signals from scouts.',
          "",
          "Then summarise in under 200 words: deals by stage with any that look stuck, the most urgent tasks, approvals waiting, and signals worth acting on.",
          "Cite ids next to the facts they support. Do not change anything unless I ask.",
        ].join("\n")
      )
  );
}
