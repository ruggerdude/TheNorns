import { z } from "zod";
import {
  V2Actor,
  V2EntityId,
  V2EntityRef,
  V2EvidenceRef,
  V2IsoDateTime,
  V2NonEmptyString,
  V2Sha256Hex,
} from "./common.js";

export const V2ApprovalKind = z.enum([
  "strategy_version",
  "budget_extension",
  "integration",
  "decision",
  "architecture",
  "review_exception",
]);
export type V2ApprovalKindT = z.infer<typeof V2ApprovalKind>;

export const V2ApprovalStatus = z.enum(["active", "superseded", "revoked"]);

export const V2Approval = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    kind: V2ApprovalKind,
    subject: V2EntityRef,
    actor: z
      .object({
        actor_type: z.literal("human"),
        actor_id: V2EntityId,
      })
      .strict(),
    content_hash: V2Sha256Hex,
    status: V2ApprovalStatus,
    approved_at: V2IsoDateTime,
    superseded_by_approval_id: V2EntityId.nullable(),
    revoked_at: V2IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((approval, ctx) => {
    if (approval.status === "superseded" && approval.superseded_by_approval_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["superseded_by_approval_id"],
        message: "a superseded approval requires its successor",
      });
    }
    if (approval.status === "revoked" && approval.revoked_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revoked_at"],
        message: "a revoked approval requires revoked_at",
      });
    }
  });
export type V2ApprovalT = z.infer<typeof V2Approval>;

export const V2ArtifactKind = z.enum([
  "context",
  "log",
  "transcript",
  "patch",
  "deliverable",
  "verification_output",
  "architecture",
  "provider_response",
]);
export const V2ArtifactRedactionStatus = z.enum(["pending", "applied", "not_required", "failed"]);

export const V2ArtifactMetadata = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    run_id: V2EntityId.nullable(),
    kind: V2ArtifactKind,
    label: V2NonEmptyString,
    media_type: V2NonEmptyString,
    storage_ref: V2NonEmptyString,
    content_hash: V2Sha256Hex,
    byte_size: z.number().int().nonnegative(),
    provenance: V2Actor,
    redaction_status: V2ArtifactRedactionStatus,
    retention_until: V2IsoDateTime.nullable(),
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2ArtifactMetadataT = z.infer<typeof V2ArtifactMetadata>;

export const V2VerificationCommandResult = z
  .object({
    command_label: V2NonEmptyString,
    command_digest: V2Sha256Hex,
    exit_code: z.number().int(),
    passed: z.boolean(),
    output_artifact: V2EvidenceRef,
  })
  .strict();

export const V2VerificationResult = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId,
    task_id: V2EntityId,
    run_id: V2EntityId,
    repository_binding_id: V2EntityId,
    commit_sha: V2NonEmptyString,
    verification_policy_ref: V2EntityId,
    passed: z.boolean(),
    command_results: z.array(V2VerificationCommandResult).min(1),
    evidence: z.array(V2EvidenceRef).min(1),
    produced_by_runner_id: V2EntityId,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((result, ctx) => {
    const allCommandsPassed = result.command_results.every((command) => command.passed);
    if (result.passed !== allCommandsPassed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passed"],
        message: "verification result must agree with all required command results",
      });
    }
  });
export type V2VerificationResultT = z.infer<typeof V2VerificationResult>;
