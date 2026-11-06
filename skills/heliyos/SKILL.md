---
name: heliyos
description: Use when working in a Heliyos CRM workspace through the heliyos MCP tools, to find accounts and people, log notes and tasks, follow scouts and signals, or hand a job to Heliyos workers with heliyos_ask.
---

# Working in Heliyos

Heliyos is a CRM where AI workers work alongside the team. The `heliyos_*` tools act on one workspace, the one the API key belongs to, with admin rights. Start with `heliyos_organization_get` if you need the workspace name, plan or limits.

## Pick the tool family in this order

1. **Records first.** Find the account, person or deal before anything else.
   - Know a name: `heliyos_records_lookup` (fast, ranked by name).
   - Need to filter or browse: `heliyos_records_list` with `search` or `filters`.
   - Need every field or the linked records: `heliyos_records_get` with `response_format: "detailed"`.
   - What happened lately: `heliyos_records_timeline` (the AI-written story), `heliyos_records_events` (the activity feed of a company, person or deal: every change, by whom), `heliyos_interactions_list` (emails and meetings). A task's activity is `heliyos_tasks_events`.
   - Custom objects need a `schema_id`: get it from `heliyos_objects_list`. Field keys and `field_id`s come from `heliyos_objects_get`; add or change a column with `heliyos_fields_create` / `heliyos_fields_update`.
   - Lists are newest first. Pass `sort` (`heliyos_records_list`, `heliyos_interactions_list`, `heliyos_runs_list`) for another order.
2. **Then notes and tasks** to record what you learned or what must happen next.
   - `heliyos_notes_create` and `heliyos_tasks_create` take `record_ids` so the note or task shows on those records.
   - `heliyos_tasks_run` starts the workers on a task. It uses credits, so ask first.
3. **Then scouts and signals** for what changed outside the CRM.
   - `heliyos_signals_list` (filter by `company_id`, `status: "new"` for unread) shows funding rounds, hires and other events.
   - `heliyos_companies_scouts_list` shows which scouts watch a company; `heliyos_scouts_list` lists them all.
   - `heliyos_companies_watch` puts a company on the watchlist, which starts enrichment and its scouts and uses credits.
4. **Reviews** are worker actions waiting for a person: an email draft, a deal change, a meeting, a task, or a question the worker asked. `heliyos_reviews_list` shows the pending ones (filter by `object_id` for one record or task), `heliyos_reviews_get` the full proposal, `heliyos_reviews_decide` approves or rejects it. Approving sends the email or applies the change, so show the user what `heliyos_reviews_get` returned and get a clear yes before approving. Rejecting with `feedback` tells the worker what to change.
5. **Workers** are the AI agents. `heliyos_workers_list` shows them, `heliyos_workers_get` their instructions, `heliyos_runs_list` with `worker_id` what they did. Create or change one only when the user asks for a new automation; its runs use credits. To build one:
   1. `heliyos_triggers_list` for the event names it can react to (`task.created`, `deal.updated`, `email.received`, ...), then put them in an `event` trigger's `events`; `scheduled` takes a cron, `mention` and `task_created` take nothing.
   2. `heliyos_workers_tools_list` for the tools it may call, Heliyos's own and the connected integrations' actions, then put their names in `tool_names`. Give it only what the job needs; `communicate`, `write_crm` and `external` tools act on the outside world.
   3. `heliyos_workers_create` with `name`, `instructions`, `triggers` and `tool_names`. Unknown event or tool names are refused with the valid ones.
6. **Knowledge base** is what every worker knows about the business. `heliyos_knowledge_get` returns the business context, products, pain points, value proposition, qualification criteria and the team's custom entries; `heliyos_knowledge_update` changes the fixed texts, `heliyos_knowledge_entries_set` adds or rewrites a custom entry by label, `heliyos_knowledge_entries_delete` removes one. Documents the workers read are files: `heliyos_files_list` / `heliyos_files_upload` with `kind: "knowledge_base"`. Each text replaces the current one whole, so read before you rewrite.
7. **Ask Heliyos last**, for work that spans many records or needs the workers' judgement: `heliyos_ask` with a plain-language question or job.
   - It waits up to 90 seconds. If it returns "Still running", call `heliyos_runs_get` with the `run_id` and `wait: true` until `done` is true.
   - Pass the same `thread_id` to continue that conversation.
   - It can change records, update tasks or send email, so confirm jobs that change things with the user before you ask.

Prefer the specific tool when one exists. It is cheaper, faster and easier for the user to check than `heliyos_ask`.

## Ids to carry between calls

| From | Id | Use it in |
| --- | --- | --- |
| `heliyos_records_lookup`, `heliyos_records_list` | record `id` | `heliyos_records_get`, `heliyos_records_update`, `record_ids` on notes and tasks, `record_id` on timeline, files and watch tools, `company_id` on scout and signal tools |
| `heliyos_objects_list` | `schema_id` | `heliyos_records_list` and `heliyos_records_create` for custom objects |
| `heliyos_objects_get` | `field_id` | `heliyos_fields_update`, `heliyos_fields_delete` |
| `heliyos_interactions_list`, `heliyos_records_timeline` | interaction `id` | `heliyos_interactions_get` |
| `heliyos_workers_list` | worker `id` | `heliyos_workers_get`, `heliyos_workers_update`, `heliyos_runs_list` (`worker_id`) |
| `heliyos_tasks_create`, `heliyos_tasks_list` | task `id` | `heliyos_tasks_update`, `heliyos_tasks_run`, `heliyos_tasks_events`, `object_id` on `heliyos_reviews_list` |
| `heliyos_tasks_run`, `heliyos_ask` | `run_id` | `heliyos_runs_get` |
| `heliyos_reviews_list`, `heliyos_runs_get` | review `id` | `heliyos_reviews_get`, `heliyos_reviews_decide` |
| `heliyos_triggers_list` | trigger `name` | `events` of an event trigger on `heliyos_workers_create` / `heliyos_workers_update` |
| `heliyos_workers_tools_list` | tool `name` | `tool_names` on `heliyos_workers_create` / `heliyos_workers_update` |
| `heliyos_ask` | `thread_id` | the next `heliyos_ask` in the same conversation |
| `heliyos_scouts_list` | scout `id` | `heliyos_scouts_get`, `heliyos_signals_list` (`scout_id`), `heliyos_companies_scouts_add` |
| `heliyos_signals_list` | signal `id` | `heliyos_signals_mark_read` |
| `heliyos_files_list` | file `id` | `heliyos_files_get`, `heliyos_files_delete` |
| `heliyos_knowledge_get` | entry `label` | `heliyos_knowledge_entries_set`, `heliyos_knowledge_entries_delete` |

Lists return `next_cursor` when there is more. Pass it back as `cursor` to read the next page. Do not guess ids.

## Review and approval

Important worker actions wait for a person. A run in `awaiting_approval`, `paused`, `waiting` or `scheduled` only moves when someone decides its review, so polling will not change it. `heliyos_runs_get` names the pending review ids; read each with `heliyos_reviews_get`, show the user what the worker proposes, and only on their clear yes call `heliyos_reviews_decide` with `approved`. Otherwise `rejected` with `feedback`, or leave it for the user to decide in Heliyos. A run is finished when its status is `completed`, `failed`, `skipped`, `cancelled` or `stopped`.

Tasks move through `backlog`, `in_progress`, `scheduled_for_later` (a worker set a wake-up for it), `on_hold` (waiting on a person or an event), `completed` and `cancelled`.

## Care

- Tools marked destructive (`heliyos_records_delete`, `heliyos_notes_delete`, `heliyos_tasks_delete`, `heliyos_labels_delete`, `heliyos_files_delete`, `heliyos_scouts_delete`, `heliyos_companies_scouts_remove`, `heliyos_companies_unwatch`, `heliyos_team_members_remove`, `heliyos_fields_delete` (drops the value on every record), `heliyos_workers_delete`, `heliyos_knowledge_entries_delete`, and the experimental `heliyos_objects_delete`) remove data or stop work and cannot be undone. Confirm with the user first.
- `heliyos_labels_update` with `values`, `heliyos_fields_update` with `options` and `heliyos_workers_update` with `tool_names` replace the whole set, and `heliyos_tasks_run` starts workers that can change records and send email (consequential actions wait for approval in Heliyos). Confirm these with the user first.
- `heliyos_reviews_decide` with `approved` sends the email, changes the deal or lets the worker act, on the user's behalf and for good. Never approve a review the user has not seen.
- Runs, scouts, enrichment and watching a company use credits. `heliyos_usage_get` shows what was spent.
- The API allows 60 requests per minute per key. Prefer one list call over many get calls.
- When a tool returns an error, its text says how to fix the input. Read it before you retry.
