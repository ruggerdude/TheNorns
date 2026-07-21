// EXECUTION E1: the content-addressed store behind assembled task context.
//
// Deliberately the same shape as FRONT DOOR P4's attachments store (metadata
// row + sha256-keyed blob table) rather than a second storage invention: the
// bytes are decoupled from the metadata so they can move to object storage
// later without touching the ref contract or the fetch route.
//
// The sha256 written here is the SAME value the runner's
// HashVerifiedContextLoader recomputes over the bytes it fetches. Nothing else
// authenticates the content, so this hash is the integrity guarantee for the
// entire execution path.
import { createHash } from "node:crypto";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export const TASK_CONTEXT_MEDIA_TYPE = "text/markdown; charset=utf-8";

export interface StoredTaskContextDocument {
  id: string;
  project_id: string;
  section: string;
  sha256: string;
  byte_size: number;
  media_type: string;
}

export interface TaskContextDocumentContent {
  media_type: string;
  bytes: Buffer;
}

/**
 * Deterministic document id. Derived from (project, section, content hash) so
 * re-assembling an unchanged task yields byte-identical refs — same
 * `artifact_id`, same `content_hash`, same `storage_ref` — and writes nothing
 * new. The project is part of the preimage so two projects that happen to
 * produce identical bytes do not share a row.
 */
export function taskContextDocumentId(
  projectId: string,
  section: string,
  contentHash: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["task-context", projectId, section, contentHash]))
    .digest("hex")
    .slice(0, 32);
  return `taskctx_${digest}`;
}

export class TaskContextStore {
  constructor(private readonly transactions: V2TransactionRunner) {}

  /**
   * Write one section's bytes content-addressed, inside the caller's
   * transaction, and return its metadata. Idempotent: a repeat write of
   * identical content is a no-op that returns the same row.
   */
  async put(
    tx: V2SqlExecutor,
    input: { projectId: string; section: string; content: Buffer },
  ): Promise<StoredTaskContextDocument> {
    if (input.content.byteLength === 0) {
      throw new Error(`task context section "${input.section}" produced no bytes`);
    }
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const id = taskContextDocumentId(input.projectId, input.section, sha256);
    await tx.query(
      `INSERT INTO task_context_blobs (sha256, content) VALUES ($1, $2)
         ON CONFLICT (sha256) DO NOTHING`,
      [sha256, input.content],
    );
    await tx.query(
      `INSERT INTO task_context_documents
         (id, project_id, section, sha256, byte_size, media_type)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        input.projectId,
        input.section,
        sha256,
        input.content.byteLength,
        TASK_CONTEXT_MEDIA_TYPE,
      ],
    );
    return {
      id,
      project_id: input.projectId,
      section: input.section,
      sha256,
      byte_size: input.content.byteLength,
      media_type: TASK_CONTEXT_MEDIA_TYPE,
    };
  }

  /** The raw bytes for the runner-facing GET route. Null when unknown. */
  async content(documentId: string): Promise<TaskContextDocumentContent | null> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ media_type: string; content: Buffer | Uint8Array }>(
        `SELECT d.media_type AS media_type, b.content AS content
           FROM task_context_documents d
           JOIN task_context_blobs b ON b.sha256 = d.sha256
          WHERE d.id = $1`,
        [documentId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { media_type: row.media_type, bytes: Buffer.from(row.content) };
    });
  }
}
