import { createHash } from "node:crypto";
import {
  type V2EvidenceRefT,
  V2MockupArtifactUploadInput,
  type V2MockupArtifactUploadInputT,
  V2ProjectArtifactQuotaReceipt,
  type V2ProjectArtifactQuotaReceiptT,
} from "@norns/contracts";
import { sniffImage } from "../attachments/imageMeta.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export const DEFAULT_PROJECT_ARTIFACT_QUOTA_BYTES = 100 * 1024 * 1024;

export type Phase6ArtifactPurpose = V2MockupArtifactUploadInputT["purpose"];

export type Phase6ArtifactErrorCode =
  | "artifact_not_found"
  | "content_hash_mismatch"
  | "invalid_content"
  | "invalid_dimensions"
  | "project_quota"
  | "size_mismatch"
  | "unsupported_media_type";

export class Phase6ArtifactError extends Error {
  constructor(
    readonly code: Phase6ArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Phase6ArtifactError";
  }
}

export interface PutPhase6ArtifactInput {
  metadata: V2MockupArtifactUploadInputT;
  content: Buffer | Uint8Array;
  label: string;
  provenance: {
    actor_type: "human" | "coordinator" | "agent" | "runner" | "system";
    actor_id: string | null;
  };
  expected_dimensions?: { width: number; height: number };
  phase_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
}

export interface StoredPhase6Artifact {
  id: string;
  project_id: string;
  kind: "mockup" | "visual_evidence" | "visual_comparison" | "deployment_evidence";
  label: string;
  media_type: "image/png" | "application/json";
  content_hash: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  created_at: string;
  evidence: V2EvidenceRefT;
  quota: V2ProjectArtifactQuotaReceiptT;
}

export interface Phase6ArtifactContent {
  media_type: "image/png" | "application/json";
  content_hash: string;
  byte_size: number;
  bytes: Buffer;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  kind: StoredPhase6Artifact["kind"];
  label: string;
  media_type: StoredPhase6Artifact["media_type"];
  content_hash: string;
  byte_size: number | string;
  created_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function artifactId(
  projectId: string,
  purpose: Phase6ArtifactPurpose,
  contentHash: string,
): string {
  const scope = createHash("sha256")
    .update(JSON.stringify(["phase6-artifact", projectId, purpose, contentHash]))
    .digest("hex")
    .slice(0, 32);
  return `artifact_${scope}`;
}

function kindForPurpose(purpose: Phase6ArtifactPurpose): StoredPhase6Artifact["kind"] {
  if (purpose.startsWith("mockup_")) return "mockup";
  if (purpose.startsWith("implementation_")) return "visual_evidence";
  if (purpose === "visual_comparison") return "visual_comparison";
  return "deployment_evidence";
}

function dimensions(
  mediaType: StoredPhase6Artifact["media_type"],
  bytes: Buffer,
  expected: PutPhase6ArtifactInput["expected_dimensions"],
): { width: number | null; height: number | null } {
  if (mediaType === "application/json") {
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (parsed === null || typeof parsed !== "object") throw new Error("not structured JSON");
    } catch {
      throw new Phase6ArtifactError(
        "invalid_content",
        "application/json artifacts must contain one valid structured JSON value",
      );
    }
    if (expected) {
      throw new Phase6ArtifactError(
        "invalid_dimensions",
        "JSON artifacts cannot declare image dimensions",
      );
    }
    return { width: null, height: null };
  }
  const detected = sniffImage(bytes);
  if (!detected || detected.mime !== "image/png") {
    throw new Phase6ArtifactError("invalid_content", "artifact bytes are not a valid PNG image");
  }
  if (expected && (detected.width !== expected.width || detected.height !== expected.height)) {
    throw new Phase6ArtifactError(
      "invalid_dimensions",
      `PNG is ${detected.width}x${detected.height}; expected ${expected.width}x${expected.height}`,
    );
  }
  return { width: detected.width, height: detected.height };
}

function stored(row: ArtifactRow, quota: V2ProjectArtifactQuotaReceiptT): StoredPhase6Artifact {
  const byteSize = Number(row.byte_size);
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    label: row.label,
    media_type: row.media_type,
    content_hash: row.content_hash,
    byte_size: byteSize,
    width: null,
    height: null,
    created_at: iso(row.created_at),
    evidence: {
      artifact_id: row.id,
      content_hash: row.content_hash,
      media_type: row.media_type,
      label: row.label,
    },
    quota,
  };
}

/**
 * Project-scoped, content-addressed bytes for Phase 6 evidence.
 *
 * The project row is the quota mutex. This makes dedupe and aggregate quota
 * decisions serializable without relying on process memory, and therefore
 * safe across multiple server instances and restarts.
 */
export class Phase6ArtifactService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly quotaBytes = DEFAULT_PROJECT_ARTIFACT_QUOTA_BYTES,
  ) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) {
      throw new Error("Phase 6 project artifact quota must be a positive safe integer");
    }
  }

  put(input: PutPhase6ArtifactInput): Promise<StoredPhase6Artifact> {
    return this.transactions.transaction((tx) => this.putInTransaction(tx, input));
  }

  async putInTransaction(
    tx: V2SqlExecutor,
    input: PutPhase6ArtifactInput,
  ): Promise<StoredPhase6Artifact> {
    const metadata = V2MockupArtifactUploadInput.parse(input.metadata);
    const bytes = Buffer.from(input.content);
    if (metadata.project_id !== input.metadata.project_id) {
      throw new Phase6ArtifactError("invalid_content", "artifact project scope changed");
    }
    if (bytes.byteLength !== metadata.byte_size) {
      throw new Phase6ArtifactError(
        "size_mismatch",
        `artifact declares ${metadata.byte_size} bytes but received ${bytes.byteLength}`,
      );
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== metadata.content_hash) {
      throw new Phase6ArtifactError(
        "content_hash_mismatch",
        "artifact bytes do not match the declared SHA-256",
      );
    }
    const imageDimensions = dimensions(metadata.media_type, bytes, input.expected_dimensions);
    const kind = kindForPurpose(metadata.purpose);

    const project = await tx.query<{ id: string }>(
      "SELECT id FROM projects WHERE id=$1 FOR UPDATE",
      [metadata.project_id],
    );
    if (!project.rows[0]) {
      throw new Phase6ArtifactError(
        "artifact_not_found",
        `unknown project "${metadata.project_id}"`,
      );
    }
    const conversation = await tx.query<{ id: string }>(
      `SELECT id
         FROM work_conversations
        WHERE project_id=$1 AND work_item_id=$2 AND id=$3`,
      [metadata.project_id, metadata.work_item_id, metadata.conversation_id],
    );
    if (!conversation.rows[0]) {
      throw new Phase6ArtifactError(
        "artifact_not_found",
        "artifact conversation scope does not exist in the requested project",
      );
    }

    const id = artifactId(metadata.project_id, metadata.purpose, hash);
    const existing = (
      await tx.query<ArtifactRow>(
        `SELECT artifact.id,artifact.project_id,artifact.kind,artifact.label,
                artifact.media_type,artifact.content_hash,artifact.byte_size,
                artifact.created_at
           FROM artifact_blobs blob
           JOIN artifacts artifact ON artifact.id=blob.artifact_id
          WHERE blob.project_id=$1 AND blob.artifact_id=$2
          LIMIT 1`,
        [metadata.project_id, id],
      )
    ).rows[0];
    const usage = (
      await tx.query<{ used: number | string }>(
        `SELECT coalesce(sum(blob.byte_size),0) AS used
           FROM (
             SELECT content_hash,max(byte_size) AS byte_size
               FROM artifact_blobs
              WHERE project_id=$1
              GROUP BY content_hash
           ) blob`,
        [metadata.project_id],
      )
    ).rows[0];
    const usedBytes = Number(usage?.used ?? 0);
    const contentAlreadyStored =
      (
        await tx.query<{ present: boolean }>(
          `SELECT EXISTS (
           SELECT 1 FROM artifact_blobs WHERE project_id=$1 AND content_hash=$2
         ) AS present`,
          [metadata.project_id, hash],
        )
      ).rows[0]?.present === true;
    const requestedBytes = existing || contentAlreadyStored ? 0 : bytes.byteLength;
    const quota = V2ProjectArtifactQuotaReceipt.parse({
      project_id: metadata.project_id,
      limit_bytes: this.quotaBytes,
      used_bytes_before: usedBytes,
      requested_bytes: requestedBytes,
      allowed: usedBytes + requestedBytes <= this.quotaBytes,
    });
    if (existing) {
      if (existing.kind !== kind || existing.media_type !== metadata.media_type) {
        throw new Phase6ArtifactError(
          "invalid_content",
          "project content hash is already bound to a different immutable artifact purpose",
        );
      }
      const result = stored(existing, quota);
      result.width = imageDimensions.width;
      result.height = imageDimensions.height;
      return result;
    }
    if (!quota.allowed) {
      throw new Phase6ArtifactError(
        "project_quota",
        `artifact would exceed the ${this.quotaBytes}-byte project evidence quota`,
      );
    }

    const inserted = await tx.query<ArtifactRow>(
      `INSERT INTO artifacts (
         id,project_id,phase_id,task_id,run_id,kind,label,media_type,storage_ref,
         content_hash,byte_size,provenance_actor_type,provenance_actor_id,
         redaction_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'not_required')
       RETURNING id,project_id,kind,label,media_type,content_hash,byte_size,created_at`,
      [
        id,
        metadata.project_id,
        input.phase_id ?? null,
        input.task_id ?? null,
        input.run_id ?? null,
        kind,
        input.label.trim(),
        metadata.media_type,
        `db://artifact/${id}`,
        hash,
        bytes.byteLength,
        input.provenance.actor_type,
        input.provenance.actor_id,
      ],
    );
    await tx.query(
      `INSERT INTO artifact_blobs (
         artifact_id,project_id,content,content_hash,byte_size
       ) VALUES ($1,$2,$3,$4,$5)`,
      [id, metadata.project_id, bytes, hash, bytes.byteLength],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("artifact insert returned no row");
    const result = stored(row, quota);
    result.width = imageDimensions.width;
    result.height = imageDimensions.height;
    return result;
  }

  async content(projectId: string, artifactIdValue: string): Promise<Phase6ArtifactContent> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{
        media_type: StoredPhase6Artifact["media_type"];
        content_hash: string;
        byte_size: number | string;
        content: Buffer | Uint8Array;
      }>(
        `SELECT artifact.media_type,artifact.content_hash,artifact.byte_size,blob.content
           FROM artifacts artifact
           JOIN artifact_blobs blob
             ON blob.artifact_id=artifact.id AND blob.project_id=artifact.project_id
          WHERE artifact.project_id=$1 AND artifact.id=$2`,
        [projectId, artifactIdValue],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Phase6ArtifactError(
          "artifact_not_found",
          `unknown artifact "${artifactIdValue}" for project "${projectId}"`,
        );
      }
      const bytes = Buffer.from(row.content);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== row.content_hash || bytes.byteLength !== Number(row.byte_size)) {
        throw new Phase6ArtifactError(
          "invalid_content",
          `artifact "${artifactIdValue}" failed its stored integrity check`,
        );
      }
      dimensions(row.media_type, bytes, undefined);
      return {
        media_type: row.media_type,
        content_hash: hash,
        byte_size: bytes.byteLength,
        bytes,
      };
    });
  }
}
