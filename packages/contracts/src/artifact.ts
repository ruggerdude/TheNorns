// Artifact metadata (PRD R4 §Artifact & Log Storage): Postgres keeps metadata
// + content hashes; blobs live in object storage. Deletion is a tombstone.
import { z } from "zod";
import { sha256Hex } from "./approval.js";

const nonEmpty = z.string().min(1);

export const RetentionClass = z.enum(["audit_indefinite", "standard", "ephemeral"]);
export const RedactionStatus = z.enum(["unredacted", "redacted", "not_applicable"]);
export const Compression = z.enum(["none", "gzip", "zstd"]);

export const ArtifactMeta = z.object({
  id: nonEmpty,
  content_hash: sha256Hex,
  size_bytes: z.number().int().nonnegative(),
  mime_type: nonEmpty,
  compression: Compression.default("none"),
  retention_class: RetentionClass,
  redaction_status: RedactionStatus.default("unredacted"),
  storage_uri: nonEmpty,
  version: z.number().int().positive(), // immutable versions
  deleted_at: z.string().datetime().nullable().default(null), // tombstone
});
export type ArtifactMetaT = z.infer<typeof ArtifactMeta>;
