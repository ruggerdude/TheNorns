import { createHash } from "node:crypto";
import {
  V2ImplementationCaptureProfile,
  V2ImplementationVisualEvidence,
  type V2ImplementationVisualEvidenceT,
  V2VisualComparisonReceipt,
} from "@norns/contracts";
import { z } from "zod";
import { canonicalJson } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { Phase6ArtifactService } from "./artifacts.js";

const VisualEvidenceMetadata = z
  .object({
    project_id: z.string().trim().min(1),
    work_item_id: z.string().trim().min(1),
    conversation_id: z.string().trim().min(1),
    phase_id: z.string().trim().min(1),
    task_id: z.string().trim().min(1),
    run_id: z.string().trim().min(1),
    approved_mockup_version_id: z.string().trim().min(1),
    repository_binding_id: z.string().trim().min(1),
    verification_result_id: z.string().trim().min(1),
    deployment_record_id: z.string().trim().min(1),
    deployment_observation_id: z.string().trim().min(1),
    commit_sha: z.string().regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/),
    capture_profile: V2ImplementationCaptureProfile,
    verified_at: z.string().datetime(),
    runner_id: z.string().trim().min(1),
  })
  .strict();

export interface RecordImplementationVisualEvidenceInput
  extends z.infer<typeof VisualEvidenceMetadata> {
  desktop_png: Buffer | Uint8Array;
  mobile_png: Buffer | Uint8Array;
}

export type Phase6VisualEvidenceErrorCode =
  | "evidence_conflict"
  | "evidence_not_found"
  | "mockup_not_approved";

export class Phase6VisualEvidenceError extends Error {
  constructor(
    readonly code: Phase6VisualEvidenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Phase6VisualEvidenceError";
  }
}

interface MockupArtifactRow {
  task_id: string | null;
  viewport: "desktop" | "mobile";
  artifact_id: string;
  artifact_hash: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function scopedId(prefix: string, values: unknown[]): string {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(values))
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Persists runner-captured evidence only after the database can bind it to the
 * approved mockup and the exact verified, pushed, successfully deployed commit.
 * The migration's deferred completeness trigger rechecks the complete tuple at
 * commit time.
 */
export class Phase6VisualEvidenceService {
  private readonly artifacts: Phase6ArtifactService;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: { artifactQuotaBytes?: number } = {},
  ) {
    this.artifacts = new Phase6ArtifactService(transactions, options.artifactQuotaBytes);
  }

  record(
    inputValue: RecordImplementationVisualEvidenceInput,
  ): Promise<V2ImplementationVisualEvidenceT> {
    return this.recordWithReplay(inputValue).then((result) => result.evidence);
  }

  recordWithReplay(inputValue: RecordImplementationVisualEvidenceInput): Promise<{
    evidence: V2ImplementationVisualEvidenceT;
    replayed: boolean;
  }> {
    const { desktop_png: desktopValue, mobile_png: mobileValue, ...metadataValue } = inputValue;
    const input = VisualEvidenceMetadata.parse(metadataValue);
    const desktop = Buffer.from(desktopValue);
    const mobile = Buffer.from(mobileValue);
    return this.transactions.transaction(async (tx) => {
      const evidenceId = scopedId("visual-evidence", [
        input.project_id,
        input.run_id,
        input.approved_mockup_version_id,
      ]);
      const ownedRun = await tx.query<{ id: string }>(
        `SELECT run.id
           FROM agent_runs run
          WHERE run.id=$1 AND run.project_id=$2 AND run.phase_id=$3 AND run.task_id=$4
            AND run.repository_binding_id=$5
            AND (
              run.runner_id=$6
              OR EXISTS (
                SELECT 1 FROM implementation_visual_evidence_collections collection
                 WHERE collection.run_id=run.id
                   AND collection.approved_mockup_version_id=$7
                   AND collection.runner_id=$6
                   AND collection.status IN ('awaiting_runner','delivered','completed')
              )
            )
          FOR SHARE`,
        [
          input.run_id,
          input.project_id,
          input.phase_id,
          input.task_id,
          input.repository_binding_id,
          input.runner_id,
          input.approved_mockup_version_id,
        ],
      );
      if (!ownedRun.rows[0]) {
        throw new Phase6VisualEvidenceError(
          "evidence_conflict",
          "the authenticated runner does not own the exact run and repository binding",
        );
      }
      const collectionFence = await tx.query<{ id: string }>(
        `SELECT id FROM implementation_visual_evidence_collections
          WHERE project_id=$1 AND run_id=$2 AND approved_mockup_version_id=$3
            AND verification_result_id=$4 AND deployment_record_id=$5
            AND deployment_observation_id=$6 AND runner_id=$7
            AND status IN ('awaiting_runner','delivered','completed')
          FOR UPDATE`,
        [
          input.project_id,
          input.run_id,
          input.approved_mockup_version_id,
          input.verification_result_id,
          input.deployment_record_id,
          input.deployment_observation_id,
          input.runner_id,
        ],
      );
      if (!collectionFence.rows[0]) {
        throw new Phase6VisualEvidenceError(
          "evidence_conflict",
          "visual evidence has no exact runner collection fence",
        );
      }
      const existing = await this.read(tx, input.project_id, evidenceId);
      if (existing) {
        if (
          existing.project_id !== input.project_id ||
          existing.work_item_id !== input.work_item_id ||
          existing.conversation_id !== input.conversation_id ||
          existing.phase_id !== input.phase_id ||
          existing.task_id !== input.task_id ||
          existing.run_id !== input.run_id ||
          existing.approved_mockup_version_id !== input.approved_mockup_version_id ||
          existing.repository_binding_id !== input.repository_binding_id ||
          existing.commit_sha !== input.commit_sha ||
          existing.verification_result_id !== input.verification_result_id ||
          existing.deployment_record_id !== input.deployment_record_id ||
          existing.deployment_observation_id !== input.deployment_observation_id ||
          canonicalJson(existing.capture_profile) !== canonicalJson(input.capture_profile) ||
          existing.verified_at !== new Date(input.verified_at).toISOString() ||
          existing.screenshots[0].artifact.content_hash !== sha256(desktop) ||
          existing.screenshots[1].artifact.content_hash !== sha256(mobile)
        ) {
          throw new Phase6VisualEvidenceError(
            "evidence_conflict",
            "visual evidence replay changed immutable scope, provenance, capture, or bytes",
          );
        }
        await this.appendVisibleMessage(tx, existing);
        await this.completeCollection(tx, input, existing.id);
        return { evidence: existing, replayed: true };
      }

      const mockupArtifacts = (
        await tx.query<MockupArtifactRow>(
          `SELECT supplement.task_id,artifact.viewport,artifact.artifact_id,
                  artifact.artifact_hash
             FROM conversation_mockup_versions version
             JOIN conversation_mockup_decisions decision
               ON decision.mockup_version_id=version.id AND decision.decision='approved'
             JOIN conversation_task_package_supplements supplement
               ON supplement.source_mockup_version_id=version.id
              AND supplement.project_id=version.project_id
             JOIN conversation_mockup_version_artifacts artifact
               ON artifact.mockup_version_id=version.id
            WHERE version.id=$1 AND version.project_id=$2
              AND version.work_item_id=$3
              AND supplement.conversation_id=$4
              AND supplement.task_id=$5
            ORDER BY CASE artifact.viewport WHEN 'desktop' THEN 0 ELSE 1 END
            FOR SHARE OF version,decision,artifact`,
          [
            input.approved_mockup_version_id,
            input.project_id,
            input.work_item_id,
            input.conversation_id,
            input.task_id,
          ],
        )
      ).rows;
      if (
        mockupArtifacts.length !== 2 ||
        mockupArtifacts[0]?.viewport !== "desktop" ||
        mockupArtifacts[1]?.viewport !== "mobile" ||
        mockupArtifacts.some((row) => row.task_id !== input.task_id)
      ) {
        throw new Phase6VisualEvidenceError(
          "mockup_not_approved",
          "visual evidence requires the exact task-scoped approved mockup",
        );
      }

      const storedDesktop = await this.artifacts.putInTransaction(tx, {
        metadata: {
          project_id: input.project_id,
          work_item_id: input.work_item_id,
          conversation_id: input.conversation_id,
          media_type: "image/png",
          purpose: "implementation_desktop",
          content_hash: sha256(desktop),
          byte_size: desktop.byteLength,
          idempotency_key: `${evidenceId}:desktop`,
        },
        content: desktop,
        label: `Implementation desktop at ${input.commit_sha.slice(0, 12)}`,
        provenance: { actor_type: "runner", actor_id: input.runner_id },
        expected_dimensions: { width: 1440, height: 1024 },
        phase_id: input.phase_id,
        task_id: input.task_id,
        run_id: input.run_id,
      });
      const storedMobile = await this.artifacts.putInTransaction(tx, {
        metadata: {
          project_id: input.project_id,
          work_item_id: input.work_item_id,
          conversation_id: input.conversation_id,
          media_type: "image/png",
          purpose: "implementation_mobile",
          content_hash: sha256(mobile),
          byte_size: mobile.byteLength,
          idempotency_key: `${evidenceId}:mobile`,
        },
        content: mobile,
        label: `Implementation mobile at ${input.commit_sha.slice(0, 12)}`,
        provenance: { actor_type: "runner", actor_id: input.runner_id },
        expected_dimensions: { width: 390, height: 844 },
        phase_id: input.phase_id,
        task_id: input.task_id,
        run_id: input.run_id,
      });
      if (storedDesktop.id === storedMobile.id) {
        throw new Phase6VisualEvidenceError(
          "evidence_conflict",
          "desktop and mobile evidence must be distinct immutable artifacts",
        );
      }

      const comparison = V2VisualComparisonReceipt.parse({
        schema_version: 2,
        kind: "visual_comparison",
        implementation_visual_evidence_id: evidenceId,
        approved_mockup_version_id: input.approved_mockup_version_id,
        commit_sha: input.commit_sha,
        comparisons: [
          {
            viewport: "desktop",
            mockup_artifact_id: mockupArtifacts[0].artifact_id,
            mockup_artifact_hash: mockupArtifacts[0].artifact_hash,
            implementation_artifact_id: storedDesktop.id,
            implementation_artifact_hash: storedDesktop.content_hash,
          },
          {
            viewport: "mobile",
            mockup_artifact_id: mockupArtifacts[1].artifact_id,
            mockup_artifact_hash: mockupArtifacts[1].artifact_hash,
            implementation_artifact_id: storedMobile.id,
            implementation_artifact_hash: storedMobile.content_hash,
          },
        ],
      });
      const comparisonBytes = Buffer.from(canonicalJson(comparison), "utf8");
      const comparisonArtifact = await this.artifacts.putInTransaction(tx, {
        metadata: {
          project_id: input.project_id,
          work_item_id: input.work_item_id,
          conversation_id: input.conversation_id,
          media_type: "application/json",
          purpose: "visual_comparison",
          content_hash: sha256(comparisonBytes),
          byte_size: comparisonBytes.byteLength,
          idempotency_key: `${evidenceId}:comparison`,
        },
        content: comparisonBytes,
        label: "Approved mockup to delivered implementation comparison",
        provenance: { actor_type: "system", actor_id: null },
        phase_id: input.phase_id,
        task_id: input.task_id,
        run_id: input.run_id,
      });

      const created = await tx.query<{ created_at: string | Date }>(
        `INSERT INTO implementation_visual_evidence (
           id,project_id,work_item_id,conversation_id,phase_id,task_id,run_id,
           approved_mockup_version_id,repository_binding_id,
           verification_result_id,deployment_record_id,deployment_observation_id,
           commit_sha,capture_profile,comparison_artifact_id,
           comparison_artifact_hash,verified_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)
         RETURNING created_at`,
        [
          evidenceId,
          input.project_id,
          input.work_item_id,
          input.conversation_id,
          input.phase_id,
          input.task_id,
          input.run_id,
          input.approved_mockup_version_id,
          input.repository_binding_id,
          input.verification_result_id,
          input.deployment_record_id,
          input.deployment_observation_id,
          input.commit_sha,
          JSON.stringify(input.capture_profile),
          comparisonArtifact.id,
          comparisonArtifact.content_hash,
          input.verified_at,
        ],
      );
      for (const screenshot of [
        { viewport: "desktop" as const, artifact: storedDesktop, width: 1440, height: 1024 },
        { viewport: "mobile" as const, artifact: storedMobile, width: 390, height: 844 },
      ]) {
        await tx.query(
          `INSERT INTO implementation_visual_evidence_artifacts (
             visual_evidence_id,project_id,viewport,artifact_id,artifact_hash,
             width,height,capture_profile
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            evidenceId,
            input.project_id,
            screenshot.viewport,
            screenshot.artifact.id,
            screenshot.artifact.content_hash,
            screenshot.width,
            screenshot.height,
            JSON.stringify(input.capture_profile),
          ],
        );
      }
      const createdAt = created.rows[0]?.created_at;
      if (!createdAt) throw new Error("visual evidence insert returned no creation time");
      const result = V2ImplementationVisualEvidence.parse({
        schema_version: 2,
        id: evidenceId,
        project_id: input.project_id,
        work_item_id: input.work_item_id,
        conversation_id: input.conversation_id,
        phase_id: input.phase_id,
        task_id: input.task_id,
        run_id: input.run_id,
        approved_mockup_version_id: input.approved_mockup_version_id,
        repository_binding_id: input.repository_binding_id,
        verification_result_id: input.verification_result_id,
        deployment_record_id: input.deployment_record_id,
        deployment_observation_id: input.deployment_observation_id,
        commit_sha: input.commit_sha,
        capture_profile: input.capture_profile,
        screenshots: [
          {
            viewport: "desktop",
            artifact: storedDesktop.evidence,
            width: 1440,
            height: 1024,
            capture_profile: input.capture_profile,
          },
          {
            viewport: "mobile",
            artifact: storedMobile.evidence,
            width: 390,
            height: 844,
            capture_profile: input.capture_profile,
          },
        ],
        comparison_artifact: comparisonArtifact.evidence,
        verified_at: input.verified_at,
        created_at: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
      });
      await this.appendVisibleMessage(tx, result);
      await this.completeCollection(tx, input, result.id);
      return { evidence: result, replayed: false };
    });
  }

  get(projectId: string, evidenceId: string): Promise<V2ImplementationVisualEvidenceT> {
    return this.transactions.transaction(async (tx) => {
      const found = await this.read(tx, projectId, evidenceId);
      if (!found) {
        throw new Phase6VisualEvidenceError(
          "evidence_not_found",
          `unknown visual evidence "${evidenceId}"`,
        );
      }
      return found;
    });
  }

  getForConversation(
    projectId: string,
    workItemId: string,
    conversationId: string,
    evidenceId: string,
  ): Promise<V2ImplementationVisualEvidenceT> {
    return this.transactions.transaction(async (tx) => {
      const found = await this.read(tx, projectId, evidenceId);
      if (!found || found.work_item_id !== workItemId || found.conversation_id !== conversationId) {
        throw new Phase6VisualEvidenceError(
          "evidence_not_found",
          `unknown visual evidence "${evidenceId}" in this work conversation`,
        );
      }
      return found;
    });
  }

  private async read(
    tx: V2SqlExecutor,
    projectId: string,
    evidenceId: string,
  ): Promise<V2ImplementationVisualEvidenceT | null> {
    const result = await tx.query<{
      id: string;
      project_id: string;
      work_item_id: string;
      conversation_id: string;
      phase_id: string;
      task_id: string;
      run_id: string;
      approved_mockup_version_id: string;
      repository_binding_id: string;
      verification_result_id: string;
      deployment_record_id: string;
      deployment_observation_id: string;
      commit_sha: string;
      capture_profile: unknown;
      comparison_artifact_id: string | null;
      comparison_artifact_hash: string | null;
      comparison_label: string | null;
      verified_at: string | Date;
      created_at: string | Date;
    }>(
      `SELECT evidence.*,artifact.label AS comparison_label
         FROM implementation_visual_evidence evidence
         LEFT JOIN artifacts artifact ON artifact.id=evidence.comparison_artifact_id
        WHERE evidence.project_id=$1 AND evidence.id=$2`,
      [projectId, evidenceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const screenshots = (
      await tx.query<{
        viewport: "desktop" | "mobile";
        artifact_id: string;
        artifact_hash: string;
        label: string;
        width: number;
        height: number;
        capture_profile: unknown;
      }>(
        `SELECT screenshot.viewport,screenshot.artifact_id,screenshot.artifact_hash,
                artifact.label,screenshot.width,screenshot.height,screenshot.capture_profile
           FROM implementation_visual_evidence_artifacts screenshot
           JOIN artifacts artifact ON artifact.id=screenshot.artifact_id
          WHERE screenshot.visual_evidence_id=$1
          ORDER BY CASE screenshot.viewport WHEN 'desktop' THEN 0 ELSE 1 END`,
        [evidenceId],
      )
    ).rows;
    if (
      screenshots.length !== 2 ||
      screenshots[0]?.viewport !== "desktop" ||
      screenshots[1]?.viewport !== "mobile"
    ) {
      throw new Phase6VisualEvidenceError(
        "evidence_conflict",
        "stored visual evidence is incomplete",
      );
    }
    return V2ImplementationVisualEvidence.parse({
      schema_version: 2,
      id: row.id,
      project_id: row.project_id,
      work_item_id: row.work_item_id,
      conversation_id: row.conversation_id,
      phase_id: row.phase_id,
      task_id: row.task_id,
      run_id: row.run_id,
      approved_mockup_version_id: row.approved_mockup_version_id,
      repository_binding_id: row.repository_binding_id,
      verification_result_id: row.verification_result_id,
      deployment_record_id: row.deployment_record_id,
      deployment_observation_id: row.deployment_observation_id,
      commit_sha: row.commit_sha,
      capture_profile: row.capture_profile,
      screenshots: screenshots.map((screenshot) => ({
        viewport: screenshot.viewport,
        artifact: {
          artifact_id: screenshot.artifact_id,
          content_hash: screenshot.artifact_hash,
          media_type: "image/png",
          label: screenshot.label,
        },
        width: Number(screenshot.width),
        height: Number(screenshot.height),
        capture_profile: screenshot.capture_profile,
      })),
      comparison_artifact:
        row.comparison_artifact_id && row.comparison_artifact_hash
          ? {
              artifact_id: row.comparison_artifact_id,
              content_hash: row.comparison_artifact_hash,
              media_type: "application/json",
              label: row.comparison_label ?? "Visual comparison",
            }
          : null,
      verified_at:
        row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    });
  }

  private async completeCollection(
    tx: V2SqlExecutor,
    input: z.infer<typeof VisualEvidenceMetadata>,
    evidenceId: string,
  ): Promise<void> {
    await tx.query(
      `UPDATE implementation_visual_evidence_collections
          SET status='completed',evidence_id=$8,completed_at=now(),
              lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
        WHERE project_id=$1 AND run_id=$2 AND approved_mockup_version_id=$3
          AND verification_result_id=$4 AND deployment_record_id=$5
          AND deployment_observation_id=$6 AND runner_id=$7
          AND status IN ('awaiting_runner','delivered','completed')`,
      [
        input.project_id,
        input.run_id,
        input.approved_mockup_version_id,
        input.verification_result_id,
        input.deployment_record_id,
        input.deployment_observation_id,
        input.runner_id,
        evidenceId,
      ],
    );
  }

  private async appendVisibleMessage(
    tx: V2SqlExecutor,
    evidence: V2ImplementationVisualEvidenceT,
  ): Promise<void> {
    const messageId = `message:visual-evidence:${evidence.id}`;
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM work_messages
        WHERE id=$1 AND project_id=$2 AND work_item_id=$3 AND conversation_id=$4`,
      [messageId, evidence.project_id, evidence.work_item_id, evidence.conversation_id],
    );
    if (existing.rows[0]) return;
    const conversation = (
      await tx.query<{
        created_by_user_id: string;
        next_message_sequence: number | string;
      }>(
        `SELECT created_by_user_id,next_message_sequence
           FROM work_conversations
          WHERE id=$1 AND project_id=$2 AND work_item_id=$3
            AND kind='execution_pm'
          FOR UPDATE`,
        [evidence.conversation_id, evidence.project_id, evidence.work_item_id],
      )
    ).rows[0];
    if (!conversation) {
      throw new Phase6VisualEvidenceError(
        "evidence_conflict",
        "delivered visual evidence has no linked execution PM conversation",
      );
    }
    await tx.query(
      `INSERT INTO work_messages (
         id,project_id,work_item_id,conversation_id,initiated_by_user_id,
         actor_type,actor_id,role,visibility_status,sequence,parts
       ) VALUES ($1,$2,$3,$4,$5,'coordinator',NULL,'assistant','complete',$6,$7::jsonb)`,
      [
        messageId,
        evidence.project_id,
        evidence.work_item_id,
        evidence.conversation_id,
        conversation.created_by_user_id,
        Number(conversation.next_message_sequence),
        JSON.stringify([
          {
            type: "text",
            format: "markdown",
            text: `Implementation visual evidence is verified for commit \`${evidence.commit_sha}\`.`,
          },
          {
            type: "implementation_visual_evidence",
            visual_evidence_id: evidence.id,
          },
        ]),
      ],
    );
    await tx.query(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1,updated_at=now()
        WHERE id=$1`,
      [evidence.conversation_id],
    );
  }
}
