import { z } from "zod";
import { V2EntityId, V2IsoDateTime, V2NonEmptyString, V2Sha256Hex } from "./common.js";

const schemaVersion = z.literal(2);
const nullableDate = V2IsoDateTime.nullable();

export const V2IdentityRole = z.enum(["admin", "member"]);
export type V2IdentityRoleT = z.infer<typeof V2IdentityRole>;

export const V2IdentityStatus = z.enum(["active", "invited", "disabled"]);
export type V2IdentityStatusT = z.infer<typeof V2IdentityStatus>;

export const V2PasswordHashScheme = z.enum(["legacy-scrypt-v0", "scrypt-v1"]);
export const V2TokenHashScheme = z.enum(["sha256", "hmac-sha256"]);
export const V2IdentityRecordSource = z.enum(["native", "legacy_snapshot"]);

/**
 * Relational identity shape used during preservation migration.
 *
 * `name` and `password_hash` remain nullable so the legacy invited-user state
 * can be represented without inventing a display name or password.
 */
export const V2IdentityUser = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(1).nullable(),
    role: V2IdentityRole,
    status: V2IdentityStatus,
    password_hash: V2NonEmptyString.nullable(),
    password_hash_scheme: V2PasswordHashScheme.nullable(),
    password_rehashed_at: nullableDate,
    source: V2IdentityRecordSource,
    source_record_id: V2NonEmptyString.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((user, ctx) => {
    if (user.status === "active" && user.password_hash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password_hash"],
        message: "an active identity requires a password hash",
      });
    }
    if ((user.password_hash === null) !== (user.password_hash_scheme === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password_hash_scheme"],
        message: "password hash and password hash scheme must be present or absent together",
      });
    }
    if (user.status === "invited" && user.password_hash !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password_hash"],
        message: "an invited identity cannot already have a password hash",
      });
    }
  });
export type V2IdentityUserT = z.infer<typeof V2IdentityUser>;

export const V2SessionStatus = z.enum(["active", "revoked", "expired"]);
export type V2SessionStatusT = z.infer<typeof V2SessionStatus>;

export const V2SessionInventoryRecord = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    user_id: V2EntityId,
    token_hash: V2Sha256Hex,
    token_hash_scheme: V2TokenHashScheme,
    token_key_id: V2NonEmptyString.nullable(),
    status: V2SessionStatus,
    created_at: V2IsoDateTime,
    expires_at: V2IsoDateTime,
    revoked_at: nullableDate,
    last_seen_at: nullableDate,
    revocation_reason: z.string().trim().min(1).nullable(),
    source: V2IdentityRecordSource,
    source_record_id: V2NonEmptyString.nullable(),
  })
  .strict()
  .superRefine((session, ctx) => {
    if (session.status === "active" && session.revoked_at !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revoked_at"],
        message: "an active session cannot have a revocation time",
      });
    }
    if (session.status === "revoked" && session.revoked_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revoked_at"],
        message: "a revoked session requires a revocation time",
      });
    }
    if (session.token_hash_scheme === "hmac-sha256" && session.token_key_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["token_key_id"],
        message: "an HMAC token hash requires a key ID",
      });
    }
    if (session.source === "legacy_snapshot" && session.status !== "revoked") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "legacy session credentials must be imported as revoked inventory",
      });
    }
  });
export type V2SessionInventoryRecordT = z.infer<typeof V2SessionInventoryRecord>;

export const V2InvitationStatus = z.enum(["pending", "accepted", "revoked", "expired"]);
export type V2InvitationStatusT = z.infer<typeof V2InvitationStatus>;

export const V2Invitation = z
  .object({
    schema_version: schemaVersion,
    id: V2EntityId,
    user_id: V2EntityId,
    token_hash: V2Sha256Hex,
    token_hash_scheme: V2TokenHashScheme,
    token_key_id: V2NonEmptyString.nullable(),
    status: V2InvitationStatus,
    created_at: V2IsoDateTime,
    expires_at: V2IsoDateTime,
    accepted_at: nullableDate,
    revoked_at: nullableDate,
    revocation_reason: z.string().trim().min(1).nullable(),
    source: V2IdentityRecordSource,
    source_record_id: V2NonEmptyString.nullable(),
  })
  .strict()
  .superRefine((invitation, ctx) => {
    if (invitation.status === "accepted" && invitation.accepted_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accepted_at"],
        message: "an accepted invitation requires an acceptance time",
      });
    }
    if (invitation.status === "revoked" && invitation.revoked_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revoked_at"],
        message: "a revoked invitation requires a revocation time",
      });
    }
    if (invitation.token_hash_scheme === "hmac-sha256" && invitation.token_key_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["token_key_id"],
        message: "an HMAC token hash requires a key ID",
      });
    }
    if (invitation.source === "legacy_snapshot" && invitation.status !== "revoked") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "legacy invitation credentials must be imported as revoked inventory",
      });
    }
  });
export type V2InvitationT = z.infer<typeof V2Invitation>;
