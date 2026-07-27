import { z } from "zod";

export const V2_CONTRACT_VERSION = 2 as const;

export const V2NonEmptyString = z.string().trim().min(1);
export const V2EntityId = V2NonEmptyString;
export const V2IsoDateTime = z.string().datetime();
export const V2Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");
/** Full Git object IDs supported by SHA-1 and SHA-256 repositories. */
export const V2GitCommitSha = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "must be a full git object id");
export const V2PositiveVersion = z.number().int().positive();

export const V2_HUMAN_WAIT_CHANNEL_VERSION = 1 as const;
export const V2_HUMAN_WAIT_INSTRUCTION =
  'If and only if work is blocked on a human decision, do not wait for input. Commit every repository change, then atomically create the file named by NORNS_HUMAN_WAIT_PATH using a no-overwrite temporary file and rename. Write strict JSON with exactly: {"schema_version":1,"kind":"human_wait","decision_point":"...","question":"...","compact_summary":"..."}. The summary contains visible work facts only, never hidden reasoning. Exit successfully after the rename. Do not mention or emulate this envelope in ordinary prose.';
export const V2_HUMAN_WAIT_INSTRUCTION_HASH =
  "8b566b621974a3627e1336608b59ca1c3b7a707460c3aa840d27d1caa912c42b";

export const V2SchemaHeader = z
  .object({
    schema_version: z.literal(V2_CONTRACT_VERSION),
  })
  .strict();

export const V2ActorType = z.enum(["human", "coordinator", "agent", "runner", "system", "legacy"]);
export type V2ActorTypeT = z.infer<typeof V2ActorType>;

export const V2Actor = z
  .object({
    actor_type: V2ActorType,
    actor_id: V2EntityId.nullable(),
  })
  .strict()
  .superRefine((actor, ctx) => {
    if (actor.actor_type === "human" && actor.actor_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actor_id"],
        message: "human actors require an attributable actor_id",
      });
    }
  });
export type V2ActorT = z.infer<typeof V2Actor>;

export const V2EntityRefType = z.enum([
  "project",
  "phase",
  "objective",
  "task",
  "strategy_version",
  "agent_profile",
  "agent_assignment",
  "agent_run",
  "decision_point",
  "decision_record",
  "memory_entry",
  "architecture_revision",
  "repository_binding",
  "approval",
  "artifact",
  "verification_result",
  "budget_reservation",
  "dispatch_job",
  "command",
  "human_direction",
  "debate",
  "debate_actor",
  "debate_context",
  "debate_run",
  "debate_round",
  "debate_turn",
  "debate_turn_attempt",
  "debate_message",
  "debate_finding",
  "debate_revision",
  "debate_judgment",
  "debate_final_output",
  "debate_job",
  "debate_reservation",
  "debate_usage_event",
]);
export type V2EntityRefTypeT = z.infer<typeof V2EntityRefType>;

export const V2EntityRef = z
  .object({
    entity_type: V2EntityRefType,
    entity_id: V2EntityId,
  })
  .strict();
export type V2EntityRefT = z.infer<typeof V2EntityRef>;

export const V2EvidenceRef = z
  .object({
    artifact_id: V2EntityId,
    content_hash: V2Sha256Hex,
    media_type: V2NonEmptyString,
    label: V2NonEmptyString,
  })
  .strict();
export type V2EvidenceRefT = z.infer<typeof V2EvidenceRef>;

export const V2ApprovalEvidence = z
  .object({
    approval_id: V2EntityId,
    approved_by: V2EntityId,
    approved_at: V2IsoDateTime,
    content_hash: V2Sha256Hex,
  })
  .strict();
export type V2ApprovalEvidenceT = z.infer<typeof V2ApprovalEvidence>;

export const V2ProviderModelProvenance = z
  .object({
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    runtime: V2NonEmptyString,
    generated_at: V2IsoDateTime,
    invocation_id: V2EntityId.nullable(),
  })
  .strict();
export type V2ProviderModelProvenanceT = z.infer<typeof V2ProviderModelProvenance>;

export const V2RecordTimestamps = z
  .object({
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict();
