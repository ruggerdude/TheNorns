// FRONT DOOR P4 (D3): the attachments domain service. Owns validation, the
// content-addressed store (dedupe by sha256 within a project), the aggregate
// quotas that can't live in a CHECK constraint, soft-deletion, and the
// provider-neutral image parts handed to the planning loop. HTTP concerns
// (auth, status codes) stay in server.ts; this module is pure domain logic
// over a V2 transaction runner so it is unit-testable against PGlite.
import { createHash } from "node:crypto";
import type { ImagePart } from "@norns/adapters";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { type AttachmentImageMime, isAllowedImageMime, sniffImage } from "./imageMeta.js";

/** Caps from the freeze (D3). Aggregate caps are enforced transactionally; the
 *  per-image byte cap is also mirrored as a CHECK in the migration. */
export const ATTACHMENT_CAPS = {
  /** <= 3 MB per image. */
  maxBytesPerImage: 3 * 1024 * 1024,
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
  | "objective_limit"
  | "project_quota";

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
  mime: AttachmentImageMime;
  bytes: number;
  width: number | null;
  height: number | null;
  purpose: string;
  created_by: string | null;
  created_at: string;
}

/** The raw bytes for the GET-serves-image route. */
export interface AttachmentContent {
  mime: AttachmentImageMime;
  bytes: Buffer;
}

export interface CreateAttachmentInput {
  mime: string;
  base64: string;
  purpose?: string;
  createdBy?: string | null;
}

interface AttachmentRow {
  id: string;
  project_id: string;
  sha256: string;
  mime: AttachmentImageMime;
  bytes: number | string;
  width: number | null;
  height: number | null;
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
    purpose: row.purpose,
    created_by: row.created_by,
    created_at: iso(row.created_at),
  };
}

export interface AttachmentServiceOptions {
  now?: () => Date;
}

export class AttachmentService {
  private readonly now: () => Date;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: AttachmentServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Validate, dedupe, and store one image. Returns the metadata (never the
   * bytes). A repeat upload of identical content to the same project returns
   * the existing live row and is not re-charged against the quotas.
   */
  async create(projectId: string, input: CreateAttachmentInput): Promise<AttachmentDto> {
    if (!isAllowedImageMime(input.mime)) {
      throw new AttachmentValidationError(
        "unsupported_media_type",
        `unsupported media type "${input.mime}"; allowed: image/png, image/jpeg, image/webp, image/gif`,
      );
    }
    const bytes = decodeBase64(input.base64);
    if (bytes.length === 0) {
      throw new AttachmentValidationError("invalid_image", "empty attachment payload");
    }
    if (bytes.length > ATTACHMENT_CAPS.maxBytesPerImage) {
      throw new AttachmentValidationError(
        "payload_too_large",
        `attachment is ${bytes.length} bytes; the per-image cap is ${ATTACHMENT_CAPS.maxBytesPerImage}`,
      );
    }
    const detected = sniffImage(bytes);
    if (!detected || detected.mime !== input.mime) {
      throw new AttachmentValidationError(
        "invalid_image",
        `payload is not a valid ${input.mime} image`,
      );
    }
    const purpose = normalizePurpose(input.purpose);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    return this.transactions.transaction(async (tx) => {
      await this.assertProjectExists(tx, projectId);

      // Dedupe within the project: identical content already stored → return it.
      const existing = await tx.query<AttachmentRow>(
        `SELECT id, project_id, sha256, mime, bytes, width, height, purpose, created_by, created_at
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

      // Content-addressed blob: shared across attachments, written once.
      await tx.query(
        `INSERT INTO attachment_blobs (sha256, content) VALUES ($1, $2)
           ON CONFLICT (sha256) DO NOTHING`,
        [sha256, bytes],
      );

      const id = newId("attachment");
      const createdAt = this.now().toISOString();
      const inserted = await tx.query<AttachmentRow>(
        `INSERT INTO attachments
           (id, project_id, sha256, mime, bytes, width, height, purpose, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, project_id, sha256, mime, bytes, width, height, purpose, created_by, created_at`,
        [
          id,
          projectId,
          sha256,
          detected.mime,
          bytes.length,
          detected.width,
          detected.height,
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
        `SELECT id, project_id, sha256, mime, bytes, width, height, purpose, created_by, created_at
           FROM attachments
          WHERE project_id = $1 AND deleted_at IS NULL
            AND ($2::text IS NULL OR purpose = $2)
          ORDER BY created_at DESC`,
        [projectId, purpose ?? null],
      );
      return result.rows.map(rowToDto);
    });
  }

  /** The raw bytes + content-type for the image-serving GET route. */
  async content(projectId: string, attachmentId: string): Promise<AttachmentContent> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ mime: AttachmentImageMime; content: Buffer | Uint8Array }>(
        `SELECT a.mime AS mime, b.content AS content
           FROM attachments a
           JOIN attachment_blobs b ON b.sha256 = a.sha256
          WHERE a.id = $1 AND a.project_id = $2 AND a.deleted_at IS NULL`,
        [attachmentId, projectId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AttachmentLookupError(
          "attachment_not_found",
          `unknown attachment "${attachmentId}" for project "${projectId}"`,
        );
      }
      return { mime: row.mime, bytes: Buffer.from(row.content) };
    });
  }

  /** Soft-delete one attachment. The blob is content-addressed and may be
   *  shared, so it is retained; only the metadata row is tombstoned. */
  async delete(projectId: string, attachmentId: string): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      // RETURNING (rather than affectedRows) keeps the count identical across
      // the PGlite test runtime and production node-postgres.
      const result = await tx.query<{ id: string }>(
        `UPDATE attachments SET deleted_at = $3
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
          RETURNING id`,
        [attachmentId, projectId, this.now().toISOString()],
      );
      if (result.rows.length === 0) {
        throw new AttachmentLookupError(
          "attachment_not_found",
          `unknown attachment "${attachmentId}" for project "${projectId}"`,
        );
      }
    });
  }

  /** Cleanup hook for project archival: soft-delete every live attachment on
   *  the project. Returns the number tombstoned. */
  async deleteForProject(projectId: string): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE attachments SET deleted_at = $2
          WHERE project_id = $1 AND deleted_at IS NULL
          RETURNING id`,
        [projectId, this.now().toISOString()],
      );
      return result.rows.length;
    });
  }

  /**
   * Provider-neutral image parts for the planning loop's round-1 injection.
   * Resolves the given ids (scoped to the project, live only), preserving the
   * caller's order, dropping unknown/deleted ids, and hard-capping at the
   * per-round image limit for cost control.
   */
  async imagePartsFor(projectId: string, attachmentIds: readonly string[]): Promise<ImagePart[]> {
    if (attachmentIds.length === 0) return [];
    return this.transactions.transaction(async (tx) => {
      // Positional placeholders ($2, $3, …) for portability across the PGlite
      // test runtime and production node-postgres.
      const placeholders = attachmentIds.map((_, i) => `$${i + 2}`).join(", ");
      const result = await tx.query<{
        id: string;
        mime: AttachmentImageMime;
        content: Buffer | Uint8Array;
      }>(
        `SELECT a.id AS id, a.mime AS mime, b.content AS content
           FROM attachments a
           JOIN attachment_blobs b ON b.sha256 = a.sha256
          WHERE a.project_id = $1 AND a.deleted_at IS NULL AND a.id IN (${placeholders})`,
        [projectId, ...attachmentIds],
      );
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      const parts: ImagePart[] = [];
      for (const id of attachmentIds) {
        if (parts.length >= ATTACHMENT_CAPS.maxImagesPerPlanningRound) break;
        const row = byId.get(id);
        if (!row) continue;
        parts.push({
          type: "image",
          mime: row.mime,
          base64: Buffer.from(row.content).toString("base64"),
        });
      }
      return parts;
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
