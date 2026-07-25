import { describe, expect, it } from "vitest";
import {
  V2AddProjectMemberRequest,
  V2ProjectAccessDecision,
  V2ProjectMember,
  V2TransferProjectOwnershipRequest,
} from "../src/index.js";

describe("V2 project collaboration contracts", () => {
  it("accepts a precise owner access decision", () => {
    expect(
      V2ProjectAccessDecision.parse({
        schema_version: 2,
        project_id: "project-1",
        user_id: "owner-1",
        owner_user_id: "owner-1",
        can_access: true,
        can_manage_members: true,
        source: "owner",
      }),
    ).toMatchObject({ source: "owner", can_manage_members: true });
  });

  it("requires removed membership records to carry removal time", () => {
    const candidate = {
      schema_version: 2,
      project_id: "project-1",
      user_id: "member-1",
      email: "member@example.com",
      name: "Member",
      workspace_role: "member",
      identity_status: "active",
      project_role: "member",
      membership_status: "removed",
      added_by_user_id: "owner-1",
      added_at: "2026-07-25T12:00:00.000Z",
      removed_by_user_id: "owner-1",
      removed_at: null,
    };
    expect(V2ProjectMember.safeParse(candidate).success).toBe(false);
    expect(
      V2ProjectMember.parse({
        ...candidate,
        removed_at: "2026-07-25T13:00:00.000Z",
      }).membership_status,
    ).toBe("removed");
  });

  it("keeps membership and ownership request bodies strict", () => {
    expect(V2AddProjectMemberRequest.parse({ user_id: "member-1" })).toEqual({
      user_id: "member-1",
    });
    expect(V2TransferProjectOwnershipRequest.parse({ owner_user_id: "owner-2" })).toEqual({
      owner_user_id: "owner-2",
    });
    expect(
      V2AddProjectMemberRequest.safeParse({ user_id: "member-1", role: "owner" }).success,
    ).toBe(false);
  });
});
