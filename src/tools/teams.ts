/**
 * Team members (auth API). The list reads team memberships, which hold both
 * joined members and pending invitations with the membership id that remove
 * and change_role take; listOrganizationMembers has joined users only and no
 * membership id, so it is not used.
 *
 * An API key acts as an ADMIN of its workspace, so it can never grant the
 * OWNER role or change an owner; OWNER is refused here before any request.
 */
import * as z from "zod/v4";
import { HeliyosApiError } from "../client/http.js";
import { callOperation, expectArray } from "../client/operations.js";
import { fitTable, MAX_TEXT_CHARS } from "../format/text.js";
import { isRecord } from "../util.js";
import {
  CREATES,
  cursorInput,
  DESTROYS,
  expectObject,
  hexId,
  idOf,
  numberOf,
  pageCursor,
  pageLimit,
  pagingFooter,
  plural,
  READ_ONLY,
  requireId,
  responseFormat,
  searchInput,
  stringOf,
  UPDATES,
  type ToolContext,
  paginationOf,
} from "./common.js";
import { tool, type ToolSpec } from "./define.js";

const ROLE_NAMES = ["OWNER", "ADMIN", "MEMBER"] as const;
type RoleName = (typeof ROLE_NAMES)[number];

const STATUS: Record<string, string> = {
  ACCEPTED: "active",
  REGISTERED: "active",
  SENT: "invited",
  REJECTED: "declined",
  REVOKED: "revoked",
};

const memberOut = z.object({
  membership_id: z.string().describe("Pass to heliyos_team_members_remove and _change_role."),
  user_id: z.string().optional().describe("Absent until an invited person signs up."),
  email: z.string(),
  name: z.string().optional(),
  role: z.string().optional(),
  status: z.string().describe("active, invited, declined or revoked."),
  invited_at: z.string().optional().describe("Detailed only."),
});
type MemberOut = z.infer<typeof memberOut>;

function memberOf(data: unknown, detailed: boolean): MemberOut {
  const raw = expectObject(data, "team membership");
  const name = [stringOf(raw.firstName), stringOf(raw.lastName)].filter(Boolean).join(" ");
  const userId = idOf(raw.userId);
  const role = stringOf(raw.roleName);
  const status = stringOf(raw.status) ?? "";
  const invited = stringOf(raw.createdAt);
  return {
    membership_id: requireId(raw, "team membership"),
    ...(userId ? { user_id: userId } : {}),
    email: stringOf(raw.email) ?? "",
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
    status: STATUS[status] ?? (status.toLowerCase() || "unknown"),
    ...(detailed && invited ? { invited_at: invited } : {}),
  };
}

const roleInput = z
  .enum(ROLE_NAMES)
  .describe("ADMIN or MEMBER. OWNER cannot be granted with an API key; an owner does that in Heliyos Settings, Team.");

/** OWNER is refused before any request: an API key acts as ADMIN, which the API forbids from granting it. */
function assertNotOwner(role: RoleName): asserts role is Exclude<RoleName, "OWNER"> {
  if (role === "OWNER") {
    throw new HeliyosApiError(
      "FORBIDDEN_ACTION",
      "An API key acts as an admin and cannot grant the owner role; an owner must do this in Heliyos Settings, Team",
      0
    );
  }
}

/** The role id for a role name, read from listRoles. */
async function roleIdFor(client: ToolContext["client"], role: string): Promise<string> {
  const { data } = await callOperation(client, "listRoles");
  const match = expectArray(data, "role list")
    .filter(isRecord)
    .find((r) => stringOf(r.name)?.toUpperCase() === role);
  const id = match ? idOf(match._id) ?? idOf(match.id) : undefined;
  if (!id) throw new HeliyosApiError("VALIDATION_FAILED", `This workspace has no ${role} role`, 0);
  return id;
}

/** Builds the tools that list team members and invite, remove or change the role of a member, from the shared tool context. */
export function teamTools({ client }: ToolContext): ToolSpec[] {
  const list = tool({
    name: "heliyos_team_members_list",
    title: "List team members",
    description:
      "Lists the workspace's people: joined members and pending invitations, each with its membership_id, email, name, " +
      "role (OWNER, ADMIN, MEMBER) and status (active, invited, declined or revoked). Filter by role or by text in the name or email. " +
      "Returns structuredContent {members:[{membership_id, email, name, role, status}], total, next_cursor}.",
    input: z.strictObject({
      role: z.enum(ROLE_NAMES).optional().describe("Only members with this role."),
      search: searchInput("names and email addresses"),
      limit: pageLimit("Members"),
      cursor: cursorInput,
      response_format: responseFormat("one row per person", "user ids and invitation dates too"),
    }),
    output: z.object({ members: z.array(memberOut), total: z.number().int().optional(), next_cursor: z.string().optional() }),
    annotations: READ_ONLY,
    truncationHint: "Lower limit (and drop cursor to start again); next_cursor continues after the whole page.",
    async handler(args) {
      const page = pageCursor.decode(args.cursor, args.limit);
      const { data, meta } = await callOperation(client, "listTeamMemberships", {
        query: {
          page,
          pageSize: args.limit,
          ...(args.search ? { search: args.search } : {}),
          ...(args.role ? { roleName: args.role } : {}),
        },
      });
      const detailed = args.response_format === "detailed";
      const members = expectArray(data, "team membership list").map((raw) => memberOf(raw, detailed));
      const pagination = paginationOf(meta);
      const total = numberOf(pagination.count);
      const next = pageCursor.next(page, args.limit, pagination);
      const columns = detailed
        ? ["membership_id", "email", "name", "role", "status", "user_id", "invited_at"]
        : ["membership_id", "email", "name", "role", "status"];
      const table =
        members.length === 0
          ? "No team members matched."
          : fitTable(
              members,
              [
                { columns, maxCell: 60 },
                { columns: ["membership_id", "email", "role", "status"], maxCell: 40 },
              ],
              MAX_TEXT_CHARS - 500
            );
      const header = `${plural(members.length, "team member")}${total !== undefined ? ` of ${total}` : ""}:`;
      return {
        text: `${header}\n${table}\n\n${pagingFooter("heliyos_team_members_list", next)}`,
        structuredContent: { members, ...(total !== undefined ? { total } : {}), ...(next ? { next_cursor: next } : {}) },
      };
    },
  });

  const invite = tool({
    name: "heliyos_team_members_invite",
    title: "Invite a team member",
    description:
      "Emails an invitation to join the workspace with the given role (ADMIN or MEMBER). A second invite to an email " +
      "with a pending invitation fails with CONFLICT (resend it from Heliyos), so check heliyos_team_members_list " +
      "first. Returns structuredContent {member} with the new " +
      "membership_id and status invited.",
    input: z.strictObject({ email: z.email().max(320).describe("The person's email address."), role: roleInput }),
    output: z.object({ member: memberOut }),
    annotations: CREATES,
    async handler(args) {
      assertNotOwner(args.role);
      const roleId = await roleIdFor(client, args.role);
      const { data } = await callOperation(client, "createTeamMembership", { body: { email: args.email, roleId } });
      const member = { ...memberOf(data, false), role: args.role };
      return {
        text: `Invited ${member.email} as ${args.role} (membership_id ${member.membership_id}). They join when they accept the email.`,
        structuredContent: { member },
      };
    },
  });

  const remove = tool({
    name: "heliyos_team_members_remove",
    title: "Remove a team member",
    description:
      "Removes a person from the workspace, or cancels a pending invitation, by membership_id (from " +
      "heliyos_team_members_list). They lose access immediately. This cannot be undone (they would need a new " +
      "invitation): confirm with the user first. The last owner cannot be removed. " +
      "Returns structuredContent {membership_id, removed}.",
    input: z.strictObject({ membership_id: hexId("membership_id") }),
    output: z.object({ membership_id: z.string(), removed: z.boolean() }),
    annotations: DESTROYS,
    async handler(args) {
      await callOperation(client, "deleteTeamMembership", { params: { id: args.membership_id } });
      return {
        text: `Removed team membership ${args.membership_id}; that person no longer has access.`,
        structuredContent: { membership_id: args.membership_id, removed: true },
      };
    },
  });

  const changeRole = tool({
    name: "heliyos_team_members_change_role",
    title: "Change a team member's role",
    description:
      "Sets a team member's role to ADMIN or MEMBER by membership_id (from heliyos_team_members_list). Owners' roles " +
      "and the OWNER role cannot be changed with an API key. Returns structuredContent {membership_id, role}.",
    input: z.strictObject({ membership_id: hexId("membership_id"), role: roleInput }),
    output: z.object({ membership_id: z.string(), role: z.string() }),
    annotations: UPDATES,
    async handler(args) {
      assertNotOwner(args.role);
      const roleId = await roleIdFor(client, args.role);
      await callOperation(client, "updateTeamMembershipRole", { params: { id: args.membership_id }, body: { roleId } });
      return {
        text: `Changed the role of membership ${args.membership_id} to ${args.role}.`,
        structuredContent: { membership_id: args.membership_id, role: args.role },
      };
    },
  });

  return [list, invite, remove, changeRole];
}
