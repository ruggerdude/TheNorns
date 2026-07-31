// FRONT DOOR P4 (D3): the attachments domain service. Owns validation, the
// content-addressed store (dedupe by sha256 within a project), the aggregate
// quotas that can't live in a CHECK constraint, soft-deletion, and the
// provider-neutral image parts and bounded file text handed to conversations.
// HTTP concerns
// (auth, status codes) stay in server.ts; this module is pure domain logic
// over a V2 transaction runner so it is unit-testable against PGlite.
import { createHash } from "node:crypto";
import type { ImagePart } from "@norns/adapters";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  ALLOWED_FILE_MIMES,
  AttachmentFileError,
  type AttachmentMime,
  isAllowedAttachmentMime,
  isImageAttachmentMime,
  maxBytesForMime,
  prepareAttachment,
} from "./fileMeta.js";
import { ALLOWED_IMAGE_MIMES, type AttachmentImageMime } from "./imageMeta.js";

/** Aggregate caps are enforced transactionally; per-MIME byte caps are also
 * mirrored as CHECK constraints by the attachment migrations. */
export const ATTACHMENT_CAPS = {
  /** <= 3 MB per image. */
  maxBytesPerImage: 3 * 1024 * 1024,
  /** <= 10 MB for the largest supported file type (PDF). */
  maxBytesPerAttachment: 10 * 1024 * 1024,
  /** <= 8 live attachments per (project, purpose). */
  maxPerObjective: 8,
  /** <= 40 MB of live attachment bytes per project. */
  maxBytesPerProject: 40 * 1024 * 1024,
  /** Per-request image cap injected into a planning round (mirrors the adapter cap). */
  maxImagesPerPlanningRound: 8,
} as const;

export const DEFAULT_ATTACHMENT_PURPOSE = "objective";

export type AttachmentValidationCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_image"
  | "invalid_file"
  | "objective_limit"
  | "project_quota"
  | "attachment_in_use";

export class AttachmentValidationError extends Error {
  constructor(
    readonly code: AttachmentValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export type AttachmentLookupCode = "project_not_found" | "attachment_not_found";

export class AttachmentLookupError extends Error {
  constructor(
    readonly code: AttachmentLookupCode,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentLookupError";
  }
}

export interface AttachmentDto {
  id: string;
  project_id: string;
  sha256: string;
  mime: AttachmentMime;
  bytes: number;
  width: number | null;
  height: number | null;
  original_filename: string;
  extracted_text_sha256: string | null;
  extraction_truncated: boolean;
  purpose: string;
  created_by: string | null;
  created_at: string;
}

/** The raw bytes and safe metadata for the authenticated download route. */
export interface AttachmentContent {
  mime: AttachmentMime;
  filename: string;
  bytes: Buffer;
}

export interface CreateAttachmentInput {
  mime: string;
  /** Preferred transport: raw request bytes, bounded by Fastify before parsing. */
  content?: Buffer | Uint8Array;
  /** Backward-compatible JSON transport for older clients. */
  base64?: string;
  purpose?: string;
  filename?: string;
  createdBy?: string | null;
}

/**
 * Private blob-store seam. The default implementation keeps content in the
 * capped Postgres store; an object-store adapter can replace it without
 * changing attachment metadata, authorization, quotas, or planning image parts.
 */
export interface AttachmentBlobStore {
  put(tx: V2SqlExecutor, sha256: string, content: Buffer): Promise<void>;
  get(tx: V2SqlExecutor, sha256: string): Promise<Buffer | null>;
  deleteIfUnreferenced(tx: V2SqlExecutor, sha256: string): Promise<void>;
}

export class PostgresAttachmentBlobStore implements AttachmentBlobStore {
  async put(tx: V2SqlExecutor, sha256: string, content: Buffer): Promise<void> {
    await tx.query(
      `INSERT INTO attachment_blobs (sha256, content) VALUES ($1, $2)
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256, content],
    );
  }

  async get(tx: V2SqlExecutor, sha256: string): Promise<Buffer | null> {
    const result = await tx.query<{ content: Buffer | Uint8Array }>(
      "SELECT content FROM attachment_blobs WHERE sha256 = $1",
      [sha256],
    );
    const content = result.rows[0]?.content;
    return content ? Buffer.from(content) : null;
  }

  async deleteIfUnreferenced(tx: V2SqlExecutor, sha256: string): Promise<void> {
    // Remove tombstoned metadata first so the FK no longer pins orphan bytes.
    // Live references are retained and continue to protect the shared blob.
    await tx.query("DELETE FROM attachments WHERE sha256 = $1 AND deleted_at IS NOT NULL", [
      sha256,
    ]);
    await tx.query(
      `DELETE FROM attachment_blobs
        WHERE sha256 = $1
          AND NOT EXISTS (
            SELECT 1 FROM attachments a
             WHERE a.sha256 = attachment_blobs.sha256 AND a.deleted_at IS NULL
          )`,
      [sha256],
    );
  }
}

interface AttachmentRow {
  id: string;
  project_id: string;
  sha256: string;
  mime: AttachmentMime;
  bytes: number | string;
  width: number | null;
  height: number | null;
  original_filename: string;
  extracted_text: string | null;
  extracted_text_sha256: string | null;
  extraction_truncated: boolean;
  purpose: string;
  created_by: string | null;
  created_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    project_id: row.project_id,
    sha256: row.sha256,
    mime: row.mime,
    bytes: typeof row.bytes === "number" ? row.bytes : Number(row.bytes),
    width: row.width,
    height: row.height,
    original_filename: row.original_filename,
    extracted_text_sha256: row.extracted_text_sha256,
    extraction_truncated: row.extraction_truncated,
    purpose: row.purpose,
    created_by: row.created_by,
    created_at: iso(row.created_at),
  };
}

export interface AttachmentServiceOptions {
  now?: () => Date;
  blobStore?: AttachmentBlobStore;
}

export class AttachmentService {
  private readonly now: () => Date;
  private readonly blobStore: AttachmentBlobStore;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: AttachmentServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.blobStore = options.blobStore ?? new PostgresAttachmentBlobStore();
  }

  /**
   * Validate, dedupe, and store one image or model-readable file. Returns
   * metadata only. A repeat upload of identical content to the same project
   * returns the existing immutable live row and is not re-charged.
   */
  async create(projectId: string, input: CreateAttachmentInput): Promise<AttachmentDto> {
    const rawMime = normalizeMime(input.mime);
    const mime: AttachmentMime = isAllowedAttachmentMime(rawMime)
      ? rawMime
      : "application/octet-stream";
    const bytes = input.content
      ? Buffer.from(input.content)
      : input.base64
        ? decodeBase64(input.base64)
        : Buffer.alloc(0);
    if (bytes.length === 0) {
      throw new AttachmentValidationError(
        isImageAttachmentMime(mime) ? "invalid_image" : "invalid_file",
        "empty attachment payload",
      );
    }
    const maxBytes = maxBytesForMime(mime, ATTACHMENT_CAPS.maxBytesPerImage);
    if (bytes.length > maxBytes) {
      throw new AttachmentValidationError(
        "payload_too_large",
        `attachment is ${bytes.length} bytes; the ${mime} cap is ${maxBytes}`,
      );
    }
    let prepared: Awaited<ReturnType<typeof prepareAttachment>>;
    try {
      prepared = await prepareAttachment(mime, bytes);
    } catch (error) {
      if (!(error instanceof AttachmentFileError)) throw error;
      throw new AttachmentValidationError(
        isImageAttachmentMime(mime) ? "invalid_image" : "invalid_file",
        error.message,
      );
    }
    const filename = normalizeFilename(input.filename, mime);
    const purpose = normalizePurpose(input.purpose);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    return this.transactions.transaction(async (tx) => {
      await this.assertProjectExists(tx, projectId);

      // Dedupe within the project: identical content already stored → return it.
      const existing = await tx.query<AttachmentRow>(
        `SELECT id, project_id, sha256, mime, bytes, width, height,
                original_filename, extracted_text, extracted_text_sha256,
                extraction_truncated, purpose, created_by, created_at
           FROM attachments
          WHERE project_id = $1 AND sha256 = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [projectId, sha256],
      );
      const dedupe = existing.rows[0];
      if (dedupe) return rowToDto(dedupe);

      // Aggregate caps that a CHECK constraint can't express.
      const perObjective = await tx.query<{ count: string | number }>(
        `SELECT count(*) AS count FROM attachments
          WHERE project_id = $1 AND purpose = $2 AND deleted_at IS NULL`,
        [projectId, purpose],
      );
      if (Number(perObjective.rows[0]?.count ?? 0) >= ATTACHMENT_CAPS.maxPerObjective) {
        throw new AttachmentValidationError(
          "objective_limit",
          `at most ${ATTACHMENT_CAPS.maxPerObjective} attachments are allowed per objective`,
        );
      }
      const totalBytes = await tx.query<{ total: string | number | null }>(
        `SELECT coalesce(sum(bytes), 0) AS total FROM attachments
          WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (
        Number(totalBytes.rows[0]?.total ?? 0) + bytes.length >
        ATTACHMENT_CAPS.maxBytesPerProject
      ) {
        throw new AttachmentValidationError(
          "project_quota",
          `project attachment storage would exceed the ${ATTACHMENT_CAPS.maxBytesPerProject}-byte cap`,
        );
      }

      await this.blobStore.put(tx, sha256, bytes);

      const id = newId("attachment");
      const createdAt = this.now().toISOString();
      const inserted = await tx.query<AttachmentRow>(
        `INSERT INTO attachments
           (id, project_id, sha256, mime, bytes, width, height, original_filename,
            extracted_text, extracted_text_sha256, extraction_truncated,
            purpose, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, project_id, sha256, mime, bytes, width, height,
                   original_filename, extracted_text, extracted_text_sha256,
                   extraction_truncated, purpose, created_by, created_at`,
        [
          id,
          projectId,
          sha256,
          prepared.mime,
          bytes.length,
          prepared.width,
          prepared.height,
          filename,
          prepared.extractedText,
          prepared.extractedTextSha256,
          prepared.extractionTruncated,
          purpose,
          input.createdBy ?? null,
          createdAt,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("attachment insert returned no row");
      return rowToDto(row);
    });
  }

  /** Metadata for every live attachment on a project (newest first). */
  async list(projectId: string, purpose?: string): Promise<AttachmentDto[]> {
    return this.transactions.transaction(async (tx) => {
      await this.assertProjectExists(tx, projectId);
      const result = await tx.query<AttachmentRow>(
        `SELECT id, project_id, sha256, mime, bytes, width, height,
                original_filename, extracted_text, extracted_text_sha256,
                extraction_truncated, purpose, created_by, created_at
           FROM attachments
          WHERE project_id = $1 AND deleted_at IS NULL
            AND ($2::text IS NULL OR purpose = $2)
          ORDER BY created_at DESC`,
        [projectId, purpose ?? null],
      );
      return result.rows.map(rowToDto);
    });
  }

  /** The raw bytes + content metadata for the authenticated download route. */
  async content(projectId: string, attachmentId: string): Promise<AttachmentContent> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{
        mime: AttachmentMime;
        sha256: string;
        original_filename: string;
      }>(
        `SELECT mime, sha256, original_filename
           FROM attachments
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [attachmentId, projectId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AttachmentLookupError(
          "attachment_not_found",
          `unknown attachment "${attachmentId}" for project "${projectId}"`,
        );
      }
      const bytes = await this.blobStore.get(tx, row.sha256);
      if (!bytes) {
        throw new AttachmentLookupError(
          "attachment_not_found",
          `content unavailable for attachment "${attachmentId}"`,
        );
      }
      return { mime: row.mime, filename: row.original_filename, bytes };
    });
  }

  /** Tombstone one attachment, then remove metadata/blob content only when no
   *  live attachment still references the content-addressed bytes. */
  async delete(projectId: string, attachmentId: string): Promise<void> {
    try {
      await this.transactions.transaction(async (tx) => {
        // RETURNING (rather than affectedRows) keeps the count identical across
        // the PGlite test runtime and production node-postgres.
        const result = await tx.query<{ id: string; sha256: string }>(
          `UPDATE attachments SET deleted_at = $3
            WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
            RETURNING id, sha256`,
          [attachmentId, projectId, this.now().toISOString()],
        );
        if (result.rows.length === 0) {
          throw new AttachmentLookupError(
            "attachment_not_found",
            `unknown attachment "${attachmentId}" for project "${projectId}"`,
          );
        }
        const sha256 = result.rows[0]?.sha256;
        if (sha256) await this.blobStore.deleteIfUnreferenced(tx, sha256);
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "55000" &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.includes("conversation-referenced attachments cannot be deleted")
      ) {
        throw new AttachmentValidationError(
          "attachment_in_use",
          `attachment "${attachmentId}" is retained as conversation evidence`,
        );
      }
      throw error;
    }
  }

  /** Cleanup hook for project archival: soft-delete every live attachment on
   *  the project. Returns the number tombstoned. */
  async deleteForProject(projectId: string): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ id: string; sha256: string }>(
        `UPDATE attachments SET deleted_at = $2
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM work_message_attachment_refs evidence
               WHERE evidence.project_id = attachments.project_id
                 AND evidence.attachment_id = attachments.id
            )
          RETURNING id, sha256`,
        [projectId, this.now().toISOString()],
      );
      for (const sha256 of new Set(result.rows.map((row) => row.sha256))) {
        await this.blobStore.deleteIfUnreferenced(tx, sha256);
      }
      return result.rows.length;
    });
  }

  /** Quota telemetry for UI and operational checks. */
  async usage(projectId: string): Promise<{
    live_count: number;
    bytes_used: number;
    max_count_per_objective: number;
    max_bytes_per_project: number;
  }> {
    return this.transactions.transaction(async (tx) => {
      await this.assertProjectExists(tx, projectId);
      const result = await tx.query<{ live_count: number | string; bytes_used: number | string }>(
        `SELECT count(*) AS live_count, coalesce(sum(bytes), 0) AS bytes_used
           FROM attachments WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      return {
        live_count: Number(result.rows[0]?.live_count ?? 0),
        bytes_used: Number(result.rows[0]?.bytes_used ?? 0),
        max_count_per_objective: ATTACHMENT_CAPS.maxPerObjective,
        max_bytes_per_project: ATTACHMENT_CAPS.maxBytesPerProject,
      };
    });
  }

  /**
   * Provider-neutral image parts for the planning loop's round-1 injection.
   * Resolves the given ids (scoped to the project, live only), preserving the
   * caller's order, dropping unknown/deleted ids, and hard-capping at the
   * per-round image limit for cost control.
   */
  async imagePartsFor(projectId: string, attachmentIds: readonly string[]): Promise<ImagePart[]> {
    return (await this.resolveForConversationTurn(projectId, attachmentIds)).images;
  }

  /**
   * Resolve every attachment on a triggering message. Images become provider
   * image parts; model-readable files are already present once in the
   * assembler's immutable derived-text context and therefore add no binary
   * provider part here.
   */
  async resolveForConversationTurn(
    projectId: string,
    attachmentIds: readonly string[],
  ): Promise<{ images: ImagePart[]; unavailableAttachmentIds: string[] }> {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length === 0) return { images: [], unavailableAttachmentIds: [] };
    return this.transactions.transaction(async (tx) => {
      // Positional placeholders ($2, $3, …) for portability across the PGlite
      // test runtime and production node-postgres.
      const placeholders = uniqueIds.map((_, i) => `$${i + 2}`).join(", ");
      const result = await tx.query<{
        id: string;
        mime: AttachmentMime;
        sha256: string;
        extracted_text: string | null;
        extracted_text_sha256: string | null;
      }>(
        `SELECT a.id AS id, a.mime AS mime, a.sha256 AS sha256,
                a.extracted_text, a.extracted_text_sha256
           FROM attachments a
          WHERE a.project_id = $1 AND a.deleted_at IS NULL AND a.id IN (${placeholders})`,
        [projectId, ...uniqueIds],
      );
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      const parts: ImagePart[] = [];
      const unavailableAttachmentIds: string[] = [];
      for (const id of uniqueIds) {
        const row = byId.get(id);
        if (!row) {
          unavailableAttachmentIds.push(id);
          continue;
        }
        if (!isImageAttachmentMime(row.mime)) {
          continue;
        }
        if (parts.length >= ATTACHMENT_CAPS.maxImagesPerPlanningRound) {
          unavailableAttachmentIds.push(id);
          continue;
        }
        const bytes = await this.blobStore.get(tx, row.sha256);
        if (!bytes) {
          unavailableAttachmentIds.push(id);
          continue;
        }
        parts.push({
          type: "image",
          mime: row.mime,
          base64: bytes.toString("base64"),
        });
      }
      return { images: parts, unavailableAttachmentIds };
    });
  }

  private async assertProjectExists(tx: V2SqlExecutor, projectId: string): Promise<void> {
    const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
      projectId,
    ]);
    if (!project.rows[0]) {
      throw new AttachmentLookupError("project_not_found", `unknown project "${projectId}"`);
    }
  }
}

function decodeBase64(base64: string): Buffer {
  // Tolerate a data-URI prefix or surrounding whitespace, then decode strictly.
  const cleaned = base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  return Buffer.from(cleaned, "base64");
}

function normalizePurpose(purpose: string | undefined): string {
  const trimmed = (purpose ?? DEFAULT_ATTACHMENT_PURPOSE).trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_ATTACHMENT_PURPOSE;
}

function normalizeMime(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizeFilename(filename: string | undefined, mime: AttachmentMime): string {
  const extension: Record<AttachmentMime, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "text/plain": "txt",
    "text/markdown": "md",
    "application/json": "json",
    "text/csv": "csv",
    "application/pdf": "pdf",
    "application/octet-stream": "bin",
  };
  const normalized = Array.from((filename ?? "").normalize("NFC"), (character) =>
    isUnsafeFilenameCharacter(character) ? "_" : character,
  )
    .join("")
    .trim();
  const fallback = `attachment.${extension[mime]}`;
  return Array.from(normalized || fallback)
    .slice(0, 255)
    .join("");
}

function isUnsafeFilenameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    character === "/" ||
    character === "\\"
  );
}
