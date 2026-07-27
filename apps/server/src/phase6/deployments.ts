import { createHash } from "node:crypto";
import {
  V2EvidenceRef,
  V2ProjectDeployment,
  V2ProjectDeploymentObservation,
  type V2ProjectDeploymentObservationT,
  V2ProjectDeploymentStatus,
  type V2ProjectDeploymentT,
  V2PublicHttpsUrl,
  V2RecordProjectDeploymentObservationInput,
  type V2RecordProjectDeploymentObservationInputT,
} from "@norns/contracts";
import { z } from "zod";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export const CreateDeploymentInput = z
  .object({
    project_id: z.string().trim().min(1),
    phase_id: z.string().trim().min(1).nullable(),
    task_id: z.string().trim().min(1).nullable(),
    run_id: z.string().trim().min(1).nullable(),
    repository_binding_id: z.string().trim().min(1),
    environment: z.string().trim().min(1).max(200),
    service: z.string().trim().min(1).max(200),
    commit_sha: z.string().regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/),
    provider_id: z.string().trim().min(1),
    provider_deployment_id: z.string().trim().min(1),
    started_at: z.string().datetime(),
    source_id: z.string().trim().min(1),
  })
  .strict();
export type CreateDeploymentInputT = z.infer<typeof CreateDeploymentInput>;

export const RecordHumanDeploymentObservationInput = z
  .object({
    project_id: z.string().trim().min(1),
    delivery_record_id: z.string().trim().min(1),
    expected_sequence: z.number().int().positive(),
    status: V2ProjectDeploymentStatus,
    public_url: V2PublicHttpsUrl.nullable(),
    health_url: V2PublicHttpsUrl.nullable(),
    health_status_code: z.number().int().min(100).max(599).nullable(),
    evidence: V2EvidenceRef.nullable(),
    observed_at: z.string().datetime(),
    idempotency_key: z.string().trim().min(1),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.evidence !== null && input.evidence.media_type !== "application/json") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "media_type"],
        message: "deployment evidence must be an immutable JSON receipt",
      });
    }
    if (
      input.status === "succeeded" &&
      (input.public_url === null ||
        input.health_url === null ||
        input.health_status_code === null ||
        input.health_status_code < 200 ||
        input.health_status_code >= 400 ||
        input.evidence === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "successful manual observations require public health and evidence",
      });
    }
  });
export type RecordHumanDeploymentObservationInputT = z.infer<
  typeof RecordHumanDeploymentObservationInput
>;

export type Phase6DeploymentErrorCode =
  | "deployment_conflict"
  | "deployment_not_found"
  | "observation_conflict";

export class Phase6DeploymentError extends Error {
  constructor(
    readonly code: Phase6DeploymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Phase6DeploymentError";
  }
}

interface DeploymentRow {
  id: string;
  project_id: string;
  phase_id: string | null;
  task_id: string | null;
  run_id: string | null;
  repository_binding_id: string;
  environment: string;
  service: string;
  commit_sha: string;
  provider_id: string;
  provider_deployment_id: string;
  status: "pending" | "deploying" | "succeeded" | "failed";
  current_observation_sequence: number | string;
  public_url: string | null;
  health_url: string | null;
  health_status_code: number | null;
  evidence_artifact_id: string | null;
  evidence_artifact_hash: string | null;
  evidence_label: string | null;
  initial_source_id: string;
  started_at: string | Date;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ObservationRow {
  id: string;
  delivery_record_id: string;
  project_id: string;
  sequence: number | string;
  status: "pending" | "deploying" | "succeeded" | "failed";
  source_type: "provider" | "runner" | "system" | "human";
  source_id: string;
  provider_event_id: string | null;
  public_url: string | null;
  health_url: string | null;
  health_status_code: number | null;
  evidence_artifact_id: string | null;
  evidence_artifact_hash: string | null;
  evidence_label: string | null;
  evidence_media_type: string | null;
  observed_at: string | Date;
  created_at: string | Date;
}

interface EvidenceArtifactRow {
  id: string;
  content_hash: string;
  media_type: string;
  label: string;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableIso(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function evidence(row: {
  evidence_artifact_id: string | null;
  evidence_artifact_hash: string | null;
  evidence_label: string | null;
  evidence_media_type?: string | null;
}) {
  return row.evidence_artifact_id && row.evidence_artifact_hash
    ? {
        artifact_id: row.evidence_artifact_id,
        content_hash: row.evidence_artifact_hash,
        media_type: row.evidence_media_type ?? "application/json",
        label: row.evidence_label ?? "Deployment observation receipt",
      }
    : null;
}

function deployment(row: DeploymentRow): V2ProjectDeploymentT {
  return V2ProjectDeployment.parse({
    schema_version: 2,
    id: row.id,
    project_id: row.project_id,
    phase_id: row.phase_id,
    task_id: row.task_id,
    run_id: row.run_id,
    repository_binding_id: row.repository_binding_id,
    environment: row.environment,
    service: row.service,
    commit_sha: row.commit_sha,
    provider_id: row.provider_id,
    provider_deployment_id: row.provider_deployment_id,
    status: row.status,
    current_observation_sequence: Number(row.current_observation_sequence),
    public_url: row.public_url,
    health_url: row.health_url,
    health_status_code: row.health_status_code,
    evidence: evidence(row),
    started_at: iso(row.started_at),
    completed_at: nullableIso(row.completed_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function observation(row: ObservationRow): V2ProjectDeploymentObservationT {
  return V2ProjectDeploymentObservation.parse({
    schema_version: 2,
    id: row.id,
    deployment_record_id: row.delivery_record_id,
    project_id: row.project_id,
    sequence: Number(row.sequence),
    status: row.status,
    source_type: row.source_type,
    source_id: row.source_id,
    provider_event_id: row.provider_event_id,
    public_url: row.public_url,
    health_url: row.health_url,
    health_status_code: row.health_status_code,
    evidence: evidence(row),
    observed_at: iso(row.observed_at),
    created_at: iso(row.created_at),
  });
}

function scopedId(prefix: string, values: unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 32)}`;
}

const deploymentSelect = `SELECT delivery.id,delivery.project_id,delivery.phase_id,
  delivery.task_id,delivery.run_id,delivery.repository_binding_id,
  delivery.environment,delivery.service,delivery.commit_sha,delivery.provider_id,
  delivery.provider_deployment_id,delivery.status,delivery.current_observation_sequence,
  delivery.public_url,delivery.health_url,delivery.health_status_code,
  delivery.evidence_artifact_id,delivery.evidence_artifact_hash,
  artifact.label AS evidence_label,delivery.started_at,delivery.completed_at,
  delivery.created_at,delivery.updated_at,
  (SELECT initial.source_id FROM project_delivery_observations initial
    WHERE initial.delivery_record_id=delivery.id AND initial.sequence=1) AS initial_source_id
 FROM project_delivery_records delivery
 LEFT JOIN artifacts artifact ON artifact.id=delivery.evidence_artifact_id`;

const observationSelect = `SELECT observation.id,observation.delivery_record_id,
  observation.project_id,observation.sequence,observation.status,
  observation.source_type,observation.source_id,observation.provider_event_id,
  observation.public_url,observation.health_url,observation.health_status_code,
  observation.evidence_artifact_id,observation.evidence_artifact_hash,
  artifact.label AS evidence_label,artifact.media_type AS evidence_media_type,
  observation.observed_at,observation.created_at
 FROM project_delivery_observations observation
 LEFT JOIN artifacts artifact ON artifact.id=observation.evidence_artifact_id`;

export class Phase6DeploymentService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  create(inputValue: CreateDeploymentInputT): Promise<V2ProjectDeploymentT> {
    return this.createWithReplay(inputValue).then((result) => result.deployment);
  }

  createWithReplay(inputValue: CreateDeploymentInputT): Promise<{
    deployment: V2ProjectDeploymentT;
    replayed: boolean;
  }> {
    const input = CreateDeploymentInput.parse(inputValue);
    return this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ id: string }>(
        "SELECT id FROM projects WHERE id=$1 FOR UPDATE",
        [input.project_id],
      );
      if (!project.rows[0]) {
        throw new Phase6DeploymentError(
          "deployment_not_found",
          "deployment project does not exist",
        );
      }
      const normalizedStartedAt = new Date(input.started_at).toISOString();
      const requestFingerprint = canonicalSha256({
        ...input,
        started_at: normalizedStartedAt,
      });
      const claimKey = `${input.provider_id}:${input.provider_deployment_id}`;
      const claim = (
        await tx.query<{ request_fingerprint: string; resource_id: string }>(
          `SELECT request_fingerprint,resource_id
            FROM phase6_idempotency_claims
            WHERE project_id=$1 AND operation='deployment_create'
              AND actor_type='source' AND actor_id=$2 AND idempotency_key=$3
            FOR SHARE`,
          [input.project_id, input.source_id, claimKey],
        )
      ).rows[0];
      if (claim && claim.request_fingerprint !== requestFingerprint) {
        throw new Phase6DeploymentError(
          "deployment_conflict",
          "provider deployment identity was already claimed by different immutable facts",
        );
      }
      const existing = (
        await tx.query<DeploymentRow>(
          `${deploymentSelect}
            WHERE delivery.project_id=$1 AND delivery.provider_id=$2
              AND delivery.provider_deployment_id=$3
            FOR UPDATE OF delivery`,
          [input.project_id, input.provider_id, input.provider_deployment_id],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.repository_binding_id !== input.repository_binding_id ||
          existing.phase_id !== input.phase_id ||
          existing.task_id !== input.task_id ||
          existing.run_id !== input.run_id ||
          existing.commit_sha !== input.commit_sha ||
          existing.environment !== input.environment ||
          existing.service !== input.service ||
          iso(existing.started_at) !== normalizedStartedAt ||
          existing.initial_source_id !== input.source_id ||
          (claim !== undefined && claim.resource_id !== existing.id)
        ) {
          throw new Phase6DeploymentError(
            "deployment_conflict",
            "provider deployment identity is already bound to different immutable scope",
          );
        }
        if (!claim) {
          await tx.query(
            `INSERT INTO phase6_idempotency_claims (
               project_id,operation,actor_type,actor_id,idempotency_key,
               request_fingerprint,resource_id
             ) VALUES ($1,'deployment_create','source',$2,$3,$4,$5)`,
            [input.project_id, input.source_id, claimKey, requestFingerprint, existing.id],
          );
        }
        return { deployment: deployment(existing), replayed: true };
      }
      if (claim) {
        throw new Phase6DeploymentError(
          "deployment_conflict",
          "provider deployment idempotency claim has no durable deployment record",
        );
      }
      const id = scopedId("deployment", [
        input.project_id,
        input.provider_id,
        input.provider_deployment_id,
      ]);
      await tx.query(
        `INSERT INTO project_delivery_records (
           id,project_id,phase_id,task_id,run_id,repository_binding_id,
           environment,service,commit_sha,provider_id,provider_deployment_id,
           status,current_observation_sequence,started_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',1,$12)`,
        [
          id,
          input.project_id,
          input.phase_id,
          input.task_id,
          input.run_id,
          input.repository_binding_id,
          input.environment,
          input.service,
          input.commit_sha,
          input.provider_id,
          input.provider_deployment_id,
          input.started_at,
        ],
      );
      await tx.query(
        `INSERT INTO phase6_idempotency_claims (
           project_id,operation,actor_type,actor_id,idempotency_key,
           request_fingerprint,resource_id
         ) VALUES ($1,'deployment_create','source',$2,$3,$4,$5)`,
        [input.project_id, input.source_id, claimKey, requestFingerprint, id],
      );
      await tx.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           provider_event_id,public_url,health_url,health_status_code,
           evidence_artifact_id,evidence_artifact_hash,observed_at
         ) VALUES ($1,$2,$3,1,'pending','system',$4,NULL,NULL,NULL,NULL,NULL,NULL,$5)`,
        [
          scopedId("deployment_observation", [id, 1]),
          id,
          input.project_id,
          input.source_id,
          input.started_at,
        ],
      );
      const inserted = (
        await tx.query<DeploymentRow>(`${deploymentSelect} WHERE delivery.id=$1`, [id])
      ).rows[0];
      if (!inserted) throw new Error("deployment insert returned no row");
      return { deployment: deployment(inserted), replayed: false };
    });
  }

  recordProviderObservation(inputValue: V2RecordProjectDeploymentObservationInputT): Promise<{
    deployment: V2ProjectDeploymentT;
    observation: V2ProjectDeploymentObservationT;
    replayed: boolean;
  }> {
    const input = V2RecordProjectDeploymentObservationInput.parse(inputValue);
    return this.recordObservation(
      {
        ...input,
        source_type: "provider",
        source_id: input.provider_id,
        provider_event_id: input.provider_event_id,
      },
      false,
    ).then((result) => {
      if (!result) throw new Error("provider observation unexpectedly skipped");
      return result;
    });
  }

  replayProviderObservation(inputValue: V2RecordProjectDeploymentObservationInputT): Promise<{
    deployment: V2ProjectDeploymentT;
    observation: V2ProjectDeploymentObservationT;
    replayed: true;
  } | null> {
    const input = V2RecordProjectDeploymentObservationInput.parse(inputValue);
    return this.recordObservation(
      {
        ...input,
        source_type: "provider",
        source_id: input.provider_id,
        provider_event_id: input.provider_event_id,
      },
      true,
    ) as Promise<{
      deployment: V2ProjectDeploymentT;
      observation: V2ProjectDeploymentObservationT;
      replayed: true;
    } | null>;
  }

  recordHumanObservation(
    inputValue: RecordHumanDeploymentObservationInputT,
    userId: string,
  ): Promise<{
    deployment: V2ProjectDeploymentT;
    observation: V2ProjectDeploymentObservationT;
    replayed: boolean;
  }> {
    const input = RecordHumanDeploymentObservationInput.parse(inputValue);
    return this.recordObservation(
      {
        ...input,
        source_type: "human",
        source_id: userId,
        provider_event_id: null,
        provider_id: null,
      },
      false,
    ).then((result) => {
      if (!result) throw new Error("human observation unexpectedly skipped");
      return result;
    });
  }

  replayHumanObservation(
    inputValue: RecordHumanDeploymentObservationInputT,
    userId: string,
  ): Promise<{
    deployment: V2ProjectDeploymentT;
    observation: V2ProjectDeploymentObservationT;
    replayed: true;
  } | null> {
    const input = RecordHumanDeploymentObservationInput.parse(inputValue);
    return this.recordObservation(
      {
        ...input,
        source_type: "human",
        source_id: userId,
        provider_event_id: null,
        provider_id: null,
      },
      true,
    ) as Promise<{
      deployment: V2ProjectDeploymentT;
      observation: V2ProjectDeploymentObservationT;
      replayed: true;
    } | null>;
  }

  private recordObservation(
    input: {
      project_id: string;
      delivery_record_id: string;
      expected_sequence: number;
      status: "pending" | "deploying" | "succeeded" | "failed";
      source_type: "provider" | "human";
      source_id: string;
      provider_id: string | null;
      provider_event_id: string | null;
      public_url: string | null;
      health_url: string | null;
      health_status_code: number | null;
      evidence: {
        artifact_id: string;
        content_hash: string;
        media_type: string;
        label: string;
      } | null;
      observed_at: string;
      idempotency_key: string;
    },
    replayOnly: boolean,
  ): Promise<{
    deployment: V2ProjectDeploymentT;
    observation: V2ProjectDeploymentObservationT;
    replayed: boolean;
  } | null> {
    return this.transactions.transaction(async (tx) => {
      const current = (
        await tx.query<DeploymentRow>(
          `${deploymentSelect}
            WHERE delivery.project_id=$1 AND delivery.id=$2
            FOR UPDATE OF delivery`,
          [input.project_id, input.delivery_record_id],
        )
      ).rows[0];
      if (!current) {
        throw new Phase6DeploymentError("deployment_not_found", "deployment record does not exist");
      }
      if (input.source_type === "provider" && current.provider_id !== input.provider_id) {
        throw new Phase6DeploymentError(
          "observation_conflict",
          "observation provider does not own this deployment record",
        );
      }
      if (input.evidence) {
        const artifact = (
          await tx.query<EvidenceArtifactRow>(
            `SELECT id,content_hash,media_type,label
               FROM artifacts
              WHERE project_id=$1 AND id=$2
              FOR SHARE`,
            [input.project_id, input.evidence.artifact_id],
          )
        ).rows[0];
        if (
          !artifact ||
          artifact.content_hash !== input.evidence.content_hash ||
          artifact.media_type !== input.evidence.media_type ||
          artifact.label !== input.evidence.label
        ) {
          throw new Phase6DeploymentError(
            "observation_conflict",
            "observation evidence does not match its immutable artifact metadata",
          );
        }
      }
      const observationId = scopedId("deployment_observation", [
        input.project_id,
        input.source_type,
        input.source_id,
        input.source_type === "provider" ? input.provider_event_id : input.idempotency_key,
      ]);
      const claimKey = `${input.source_type}:${input.source_id}:${
        input.source_type === "provider" ? input.provider_event_id : input.idempotency_key
      }`;
      const requestFingerprint = canonicalSha256({
        ...input,
        observed_at: new Date(input.observed_at).toISOString(),
      });
      const claim = (
        await tx.query<{ request_fingerprint: string; resource_id: string }>(
          `SELECT request_fingerprint,resource_id
            FROM phase6_idempotency_claims
            WHERE project_id=$1 AND operation='deployment_observation'
              AND actor_type=$2 AND actor_id=$3 AND idempotency_key=$4
            FOR SHARE`,
          [input.project_id, input.source_type, input.source_id, claimKey],
        )
      ).rows[0];
      if (
        claim &&
        (claim.request_fingerprint !== requestFingerprint || claim.resource_id !== observationId)
      ) {
        throw new Phase6DeploymentError(
          "observation_conflict",
          "observation idempotency key was already claimed by different immutable facts",
        );
      }
      const replay = (
        await tx.query<ObservationRow>(
          `${observationSelect}
            WHERE observation.project_id=$1 AND observation.id=$2`,
          [input.project_id, observationId],
        )
      ).rows[0];
      if (replay) {
        if (
          replay.delivery_record_id !== input.delivery_record_id ||
          Number(replay.sequence) !== input.expected_sequence ||
          replay.status !== input.status ||
          replay.source_type !== input.source_type ||
          replay.source_id !== input.source_id ||
          replay.provider_event_id !== input.provider_event_id ||
          replay.public_url !== input.public_url ||
          replay.health_url !== input.health_url ||
          replay.health_status_code !== input.health_status_code ||
          replay.evidence_artifact_id !== (input.evidence?.artifact_id ?? null) ||
          replay.evidence_artifact_hash !== (input.evidence?.content_hash ?? null) ||
          replay.evidence_label !== (input.evidence?.label ?? null) ||
          replay.evidence_media_type !== (input.evidence?.media_type ?? null) ||
          iso(replay.observed_at) !== new Date(input.observed_at).toISOString()
        ) {
          throw new Phase6DeploymentError(
            "observation_conflict",
            "observation idempotency key was already recorded with different immutable facts",
          );
        }
        if (!claim) {
          await tx.query(
            `INSERT INTO phase6_idempotency_claims (
               project_id,operation,actor_type,actor_id,idempotency_key,
               request_fingerprint,resource_id
             ) VALUES ($1,'deployment_observation',$2,$3,$4,$5,$6)`,
            [
              input.project_id,
              input.source_type,
              input.source_id,
              claimKey,
              requestFingerprint,
              replay.id,
            ],
          );
        }
        return {
          deployment: deployment(current),
          observation: observation(replay),
          replayed: true,
        };
      }
      if (claim) {
        throw new Phase6DeploymentError(
          "observation_conflict",
          "observation idempotency claim has no durable observation record",
        );
      }
      if (replayOnly) return null;
      const nextSequence = Number(current.current_observation_sequence) + 1;
      if (input.expected_sequence !== nextSequence) {
        throw new Phase6DeploymentError(
          "observation_conflict",
          `deployment observation expected sequence ${nextSequence}`,
        );
      }
      await tx.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           provider_event_id,public_url,health_url,health_status_code,
           evidence_artifact_id,evidence_artifact_hash,observed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          observationId,
          input.delivery_record_id,
          input.project_id,
          input.expected_sequence,
          input.status,
          input.source_type,
          input.source_id,
          input.provider_event_id,
          input.public_url,
          input.health_url,
          input.health_status_code,
          input.evidence?.artifact_id ?? null,
          input.evidence?.content_hash ?? null,
          input.observed_at,
        ],
      );
      await tx.query(
        `INSERT INTO phase6_idempotency_claims (
           project_id,operation,actor_type,actor_id,idempotency_key,
           request_fingerprint,resource_id
         ) VALUES ($1,'deployment_observation',$2,$3,$4,$5,$6)`,
        [
          input.project_id,
          input.source_type,
          input.source_id,
          claimKey,
          requestFingerprint,
          observationId,
        ],
      );
      await tx.query(
        `UPDATE project_delivery_records
            SET status=$2,current_observation_sequence=$3,public_url=$4,health_url=$5,
                health_status_code=$6,evidence_artifact_id=$7,evidence_artifact_hash=$8,
                completed_at=CASE
                  WHEN $2 IN ('succeeded','failed') THEN $9::timestamptz
                  ELSE NULL
                END,
                updated_at=$9::timestamptz
          WHERE id=$1`,
        [
          input.delivery_record_id,
          input.status,
          input.expected_sequence,
          input.public_url,
          input.health_url,
          input.health_status_code,
          input.evidence?.artifact_id ?? null,
          input.evidence?.content_hash ?? null,
          input.observed_at,
        ],
      );
      const updated = (
        await tx.query<DeploymentRow>(`${deploymentSelect} WHERE delivery.id=$1`, [
          input.delivery_record_id,
        ])
      ).rows[0];
      const insertedObservation = (
        await tx.query<ObservationRow>(`${observationSelect} WHERE observation.id=$1`, [
          observationId,
        ])
      ).rows[0];
      if (!updated || !insertedObservation) throw new Error("deployment observation disappeared");
      return {
        deployment: deployment(updated),
        observation: observation(insertedObservation),
        replayed: false,
      };
    });
  }

  list(projectId: string, limit = 20): Promise<V2ProjectDeploymentT[]> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<DeploymentRow>(
        `${deploymentSelect}
          WHERE delivery.project_id=$1
          ORDER BY delivery.created_at DESC,delivery.id DESC
          LIMIT $2`,
        [projectId, Math.max(1, Math.min(100, limit))],
      );
      return result.rows.map(deployment);
    });
  }

  observations(
    projectId: string,
    deploymentId: string,
  ): Promise<V2ProjectDeploymentObservationT[]> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<ObservationRow>(
        `${observationSelect}
          WHERE observation.project_id=$1 AND observation.delivery_record_id=$2
          ORDER BY observation.sequence,observation.id`,
        [projectId, deploymentId],
      );
      if (result.rows.length === 0) {
        const exists = await tx.query<{ id: string }>(
          "SELECT id FROM project_delivery_records WHERE project_id=$1 AND id=$2",
          [projectId, deploymentId],
        );
        if (!exists.rows[0]) {
          throw new Phase6DeploymentError(
            "deployment_not_found",
            "deployment record does not exist",
          );
        }
      }
      return result.rows.map(observation);
    });
  }
}
