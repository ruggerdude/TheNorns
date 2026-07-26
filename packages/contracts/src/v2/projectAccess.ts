import { z } from "zod";
import { V2EntityId, V2IsoDateTime } from "./common.js";
import { V2IdentityRole, V2IdentityStatus } from "./identity.js";

const schemaVersion = z.literal(2);

export const V2ProjectMembershipStatus = z.enum(["active", "removed"]);
export type V2ProjectMembershipStatusT = z.infer<typeof V2ProjectMembershipStatus>;

export const V2ProjectAccessSource = z.enum([
  "admin",
  "owner",
  "membership",
  "legacy_unowned",
  "none",
]);
export type V2ProjectAccessSourceT = z.infer<typeof V2ProjectAccessSource>;

export const V2ProjectAccessDecision = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    user_id: V2EntityId,
    owner_user_id: V2EntityId.nullable(),
    can_access: z.boolean(),
    can_manage_members: z.boolean(),
    source: V2ProjectAccessSource,
  })
  .strict();
export type V2ProjectAccessDecisionT = z.infer<typeof V2ProjectAccessDecision>;

export const V2ProjectMember = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    user_id: V2EntityId,
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(1).nullable(),
    workspace_role: V2IdentityRole,
    identity_status: V2IdentityStatus,
    project_role: z.enum(["owner", "member"]),
    membership_status: V2ProjectMembershipStatus,
    added_by_user_id: V2EntityId.nullable(),
    added_at: V2IsoDateTime.nullable(),
    removed_by_user_id: V2EntityId.nullable(),
    removed_at: V2IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((member, ctx) => {
    if (member.membership_status === "active" && member.removed_at !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["removed_at"],
        message: "an active membership cannot have a removal time",
      });
    }
    if (member.membership_status === "removed" && member.removed_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["removed_at"],
        message: "a removed membership requires a removal time",
      });
    }
  });
export type V2ProjectMemberT = z.infer<typeof V2ProjectMember>;

export const V2ProjectMembersResponse = z
  .object({
    schema_version: schemaVersion,
    project_id: V2EntityId,
    owner_user_id: V2EntityId.nullable(),
    members: z.array(V2ProjectMember),
  })
  .strict();
export type V2ProjectMembersResponseT = z.infer<typeof V2ProjectMembersResponse>;

export const V2AddProjectMemberRequest = z
  .object({
    user_id: V2EntityId,
  })
  .strict();
export type V2AddProjectMemberRequestT = z.infer<typeof V2AddProjectMemberRequest>;

export const V2TransferProjectOwnershipRequest = z
  .object({
    owner_user_id: V2EntityId,
  })
  .strict();
export type V2TransferProjectOwnershipRequestT = z.infer<typeof V2TransferProjectOwnershipRequest>;

/**
 * Authenticated attribution propagated from a planning request to the phase,
 * task, and agent-run records materialized from it. Null is reserved for
 * historical rows whose initiating user cannot be proven.
 */
export const V2InitiatorAttribution = z
  .object({
    schema_version: schemaVersion,
    initiated_by_user_id: V2EntityId.nullable(),
  })
  .strict();
export type V2InitiatorAttributionT = z.infer<typeof V2InitiatorAttribution>;
