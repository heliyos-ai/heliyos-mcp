/**
 * msw fixtures shaped like the platform OpenAPI responses
 * (`{meta:{message, pagination?}, data}` and `{error:{code, message, details?}}`).
 * Base schemas serialise their id as `id`; records keep Mongo's `_id`.
 */
import { http, HttpResponse } from "msw";

export const BASE = "https://api.test.heliyos.ai";
export const KEY = "heliyos_ABCDEFGHJKLMNPQRSTUVWXYZabcdef";
export const P = `${BASE}/v1/platform`;

export const SCHEMA_IDS = {
  company: "64a000000000000000000001",
  person: "64a000000000000000000002",
  deal: "64a000000000000000000003",
  partner: "64a000000000000000000004",
} as const;

const field = (name: string, sequence: number, displayName: string) => ({
  id: `f${sequence}${name}`,
  name,
  displayName,
  sequence,
  type: { type: "text" },
});

export const schemas = [
  {
    id: SCHEMA_IDS.company,
    name: "Companies",
    slug: "company",
    objectType: "company",
    type: "base",
    fields: [
      field("company_name", 1, "Company name"),
      field("domain", 2, "Domain"),
      field("industry", 3, "Industry"),
      field("employee_count", 4, "Employees"),
      field("description", 5, "Description"),
    ],
  },
  {
    id: SCHEMA_IDS.person,
    name: "People",
    slug: "people",
    objectType: "people",
    type: "base",
    fields: [field("people_name", 1, "Name"), field("email", 2, "Email"), field("job_title", 3, "Job title")],
  },
  {
    id: SCHEMA_IDS.deal,
    name: "Deals",
    slug: "deals",
    objectType: "deals",
    type: "base",
    fields: [field("deal_name", 1, "Deal name"), field("stage", 2, "Stage"), field("amount", 3, "Amount")],
  },
  {
    id: SCHEMA_IDS.partner,
    name: "Partners",
    slug: "partners",
    objectType: "partners",
    type: "custom",
    fields: [field("name", 1, "Name"), field("tier", 2, "Tier")],
  },
];

export const RECORD_IDS = {
  acme: "65b000000000000000000001",
  globex: "65b000000000000000000002",
};

export const acme = {
  _id: RECORD_IDS.acme,
  baseSchemaId: SCHEMA_IDS.company,
  organizationId: "64f000000000000000000001",
  objectType: "company",
  data: {
    company_name: "Acme Corp",
    domain: "acme.com",
    industry: "Manufacturing",
    employee_count: 120,
    description: "Makes anvils and rockets.",
    linkedin_url: "https://www.linkedin.com/company/acme",
  },
  relationships: [
    {
      _id: "65c000000000000000000001",
      objectId: "65b0000000000000000000a1",
      schemaId: "64a000000000000000000002",
      objectType: "people",
      data: { people_name: "Jane Doe", email: "jane@acme.com" },
    },
  ],
  metadata: {
    created: { at: "2026-01-02T03:04:05.000Z", by: "user_1" },
    updated: { at: "2026-02-03T04:05:06.000Z", by: "user_1" },
  },
};

export const globex = {
  _id: RECORD_IDS.globex,
  baseSchemaId: SCHEMA_IDS.company,
  organizationId: "64f000000000000000000001",
  objectType: "company",
  data: { company_name: "Globex", domain: "globex.example", industry: "Energy" },
  metadata: {
    created: { at: "2026-01-05T00:00:00.000Z", by: "user_1" },
    updated: { at: "2026-01-06T00:00:00.000Z", by: "user_1" },
  },
};

export const ok = (data: unknown, meta: Record<string, unknown> = {}) =>
  HttpResponse.json({ meta: { message: "ok", ...meta }, data });

export const apiError = (status: number, code: string, message: string, details?: unknown) =>
  HttpResponse.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });

/** Counts calls to GET /base-schemas so tests can assert caching. */
export function baseSchemasHandler(counter: { calls: number } = { calls: 0 }) {
  return http.get(`${P}/base-schemas`, () => {
    counter.calls += 1;
    return ok(schemas);
  });
}

/** The auth service's base path (team members and roles). */
export const AUTH = `${BASE}/v1/auth`;

/** A person record (for enrichment and links). */
export const jane = {
  _id: "65b0000000000000000000a1",
  baseSchemaId: SCHEMA_IDS.person,
  organizationId: "64f000000000000000000001",
  objectType: "people",
  data: { people_name: "Jane Doe", email: "jane@acme.com", job_title: "CTO" },
  metadata: {
    created: { at: "2026-01-03T00:00:00.000Z", by: "user_1" },
    updated: { at: "2026-01-04T00:00:00.000Z", by: "user_1" },
  },
};

// ---------------------------------------------------------------- worker catalogs

/** GET /workers/triggers: the trigger catalog as the platform serves it. */
export const triggerCatalog = [
  { name: "task.created", kind: "event", source: "platform", objectType: "task", label: "Task created", description: "A task was created." },
  { name: "deal.updated", kind: "event", source: "platform", objectType: "deals", label: "Deal updated", description: "A deal's stage, amount or fields changed." },
  { name: "email.received", kind: "event", source: "nylas", objectType: "interaction", label: "Email received", integration: { provider: "gmail" } },
  { name: "company.attribute_updated", kind: "event", source: "platform", objectType: "company", label: "Company attribute changed", selectsAttributes: true },
  { name: "mention", kind: "mention", label: "Mentioned in chat" },
  { name: "schedule", kind: "schedule", label: "On a schedule" },
];

export const ACTION_IDS = { sendEmail: "6dd000000000000000000001" } as const;

/** GET /workers/tools: the registry as agent-mvc's catalog() serves it. */
export const workerToolCatalog = [
  { name: "search_records", description: "Find records.", risk: "read", source: "builtin", action_id: null, common: true, is_internal: true, is_hidden: false, input: { type: "object" } },
  { name: "update_record", description: "Change a record.", risk: "write_crm", source: "builtin", action_id: null, is_internal: true, is_hidden: false },
  { name: "generate_final_response", description: "Plumbing.", risk: "read", source: "builtin", is_internal: true, is_hidden: true },
  { name: "send_email", description: "Send an email from the connected mailbox.", risk: "communicate", source: "action", action_id: ACTION_IDS.sendEmail, provider: "gmail", display_name: "Send email", is_internal: false, is_hidden: false },
];

export const catalogHandlers = () => [
  http.get(`${P}/workers/triggers`, () => ok({ triggers: triggerCatalog })),
  http.get(`${P}/workers/tools`, () => ok({ tools: workerToolCatalog })),
];
