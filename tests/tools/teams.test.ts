/**
 * The heliyos_team_members_change_role, heliyos_team_members_invite, heliyos_team_members_list, heliyos_team_members_remove tools: inputs are mapped to the Heliyos API's requests, responses to the documented output shape, and errors to actionable tool errors.
 * Runs against a mocked Heliyos API (msw); any request without a handler fails the test.
 */
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { expectOk, expectToolError, useMockApi, type Structured } from "../helpers/harness.js";
import { apiError, AUTH, ok } from "../helpers/platform.js";

const { api, call } = useMockApi();
const ROLE_IDS = { OWNER: "6b0000000000000000000001", ADMIN: "6b0000000000000000000002", MEMBER: "6b0000000000000000000003" };
const roles = Object.entries(ROLE_IDS).map(([name, _id]) => ({ _id, name }));
const rolesHandler = () => http.get(`${AUTH}/roles`, () => ok(roles));
const M1 = "6c0000000000000000000001";
const M2 = "6c0000000000000000000002";
const members = [
  { _id: M1, id: M1, email: "owner@acme.com", firstName: "Jordan", lastName: "S", roleName: "OWNER", roleId: ROLE_IDS.OWNER, status: "ACCEPTED", userId: "6d0000000000000000000001" },
  { _id: M2, id: M2, email: "new@acme.com", roleName: "MEMBER", roleId: ROLE_IDS.MEMBER, status: "SENT" },
];

describe("heliyos_team_members_list", () => {
  it("lists members and pending invitations with membership ids, paging by page", async () => {
    const urls: URL[] = [];
    api.use(
      http.get(`${AUTH}/team-memberships`, ({ request }) => {
        urls.push(new URL(request.url));
        return ok(members, { pagination: { count: 5, page: 1, pageSize: 2 } });
      })
    );
    const result = await call("heliyos_team_members_list", { limit: 2, role: "MEMBER" });
    const text = expectOk(result);
    expect(urls[0]!.searchParams.get("pageSize")).toBe("2");
    expect(urls[0]!.searchParams.get("page")).toBe("1");
    expect(urls[0]!.searchParams.get("roleName")).toBe("MEMBER");
    expect(text).toContain(M1);
    expect(text).toContain("new@acme.com");
    expect(text).toMatch(/invited/i);
    const sc = result.structuredContent as Structured;
    expect(sc.members[0]).toMatchObject({ membership_id: M1, email: "owner@acme.com", name: "Jordan S", role: "OWNER", status: "active" });
    expect(sc.members[1]).toMatchObject({ membership_id: M2, role: "MEMBER", status: "invited" });
    expect(sc.next_cursor).toBe("page:2:2");

    // The last page (count 5, page 3 of size 2) has no next_cursor.
    const last = await call("heliyos_team_members_list", { limit: 2, role: "MEMBER", cursor: "page:3:2" });
    expect(urls[1]!.searchParams.get("page")).toBe("3");
    expect(last.structuredContent).not.toHaveProperty("next_cursor");
  });

  it("refuses a cursor issued for another limit", async () => {
    expectToolError(await call("heliyos_team_members_list", { limit: 10, cursor: "page:2:20" }), "VALIDATION_FAILED");
  });

  it("surfaces an API error", async () => {
    api.use(http.get(`${AUTH}/team-memberships`, () => apiError(403, "FORBIDDEN_ACTION", "Not allowed")));
    expectToolError(await call("heliyos_team_members_list"), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_team_members_invite", () => {
  it("resolves the role name to its id and sends the invitation", async () => {
    let body: any;
    api.use(
      rolesHandler(),
      http.post(`${AUTH}/team-memberships`, async ({ request }) => {
        body = await request.json();
        return ok({ _id: M2, email: "new@acme.com", roleId: ROLE_IDS.ADMIN, status: "SENT" });
      })
    );
    const result = await call("heliyos_team_members_invite", { email: "new@acme.com", role: "ADMIN" });
    const text = expectOk(result);
    expect(body).toEqual({ email: "new@acme.com", roleId: ROLE_IDS.ADMIN });
    expect(text).toContain(M2);
    expect((result.structuredContent as Structured).member).toMatchObject({ membership_id: M2, role: "ADMIN", status: "invited" });
  });

  it("refuses to grant OWNER without calling the API", async () => {
    const text = expectToolError(await call("heliyos_team_members_invite", { email: "x@acme.com", role: "OWNER" }), "FORBIDDEN_ACTION");
    expect(text).toMatch(/owner/i);
  });
});

describe("heliyos_team_members_remove", () => {
  it("removes the membership", async () => {
    api.use(http.delete(`${AUTH}/team-memberships/${M2}`, () => ok({ deleted: true })));
    const result = await call("heliyos_team_members_remove", { membership_id: M2 });
    expect(expectOk(result)).toContain(M2);
  });

  it("surfaces the API refusing to remove the last owner", async () => {
    api.use(http.delete(`${AUTH}/team-memberships/${M1}`, () => apiError(403, "FORBIDDEN_ACTION", "Only an owner can grant or remove the owner role")));
    expectToolError(await call("heliyos_team_members_remove", { membership_id: M1 }), "FORBIDDEN_ACTION");
  });
});

describe("heliyos_team_members_change_role", () => {
  it("changes the role by role id", async () => {
    let body: any;
    api.use(
      rolesHandler(),
      http.patch(`${AUTH}/team-memberships/${M2}/role`, async ({ request }) => {
        body = await request.json();
        return ok({});
      })
    );
    const result = await call("heliyos_team_members_change_role", { membership_id: M2, role: "ADMIN" });
    expect(expectOk(result)).toContain("ADMIN");
    expect(body).toEqual({ roleId: ROLE_IDS.ADMIN });
  });

  it("refuses OWNER at the boundary", async () => {
    expectToolError(await call("heliyos_team_members_change_role", { membership_id: M2, role: "OWNER" }), "FORBIDDEN_ACTION");
  });

  it("surfaces a missing membership", async () => {
    api.use(rolesHandler(), http.patch(`${AUTH}/team-memberships/${M2}/role`, () => apiError(404, "NOT_FOUND", "Membership not found")));
    expectToolError(await call("heliyos_team_members_change_role", { membership_id: M2, role: "MEMBER" }), "NOT_FOUND");
  });
});
