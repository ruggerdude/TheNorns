-- FRONT DOOR P4 (D3): image attachments — content-addressed, capped, and
-- storage-pluggable. Metadata (attachments) is deliberately decoupled from the
-- bytes (attachment_blobs, keyed by the content sha256) so the blobs can move
-- to object storage later without changing the metadata contract or any route.
-- The planning round-1 image injection reads a run's attachment ids off the
-- planning_runs row (column added at the end, additive to P2's table).

-- Bytes, content-addressed. One row per distinct sha256 across the whole
-- deployment; many attachments (even across projects) may reference it.
CREATE TABLE attachment_blobs (
  sha256 TEXT PRIMARY KEY,
  content BYTEA NOT NULL,
  CONSTRAINT attachment_blobs_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attachment_blobs_content_check CHECK (octet_length(content) > 0)
);

-- Metadata. Caps (per the freeze): image/png|jpeg|webp|gif only and <= 3 MB
-- each are enforced here as CHECKs; the per-objective (<= 8) and per-project
-- (<= 40 MB) quotas are enforced transactionally in the attachments service,
-- since they are aggregate limits.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL REFERENCES attachment_blobs (sha256),
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  purpose TEXT NOT NULL DEFAULT 'objective',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT attachments_mime_check CHECK (
    mime IN ('image/png','image/jpeg','image/webp','image/gif')
  ),
  CONSTRAINT attachments_bytes_check CHECK (bytes > 0 AND bytes <= 3145728),
  CONSTRAINT attachments_dimensions_check CHECK (
    (width IS NULL OR width > 0) AND (height IS NULL OR height > 0)
  ),
  CONSTRAINT attachments_purpose_check CHECK (length(trim(purpose)) > 0)
);
-- Dedupe within a project: at most one live attachment per (project, content).
-- The service returns the existing row on a repeat upload; this partial unique
-- index makes a concurrent race lose loudly rather than duplicate.
CREATE UNIQUE INDEX attachments_project_sha_live_idx
  ON attachments (project_id, sha256) WHERE deleted_at IS NULL;
-- Quota / listing lookups scan live rows for a (project, purpose).
CREATE INDEX attachments_project_purpose_live_idx
  ON attachments (project_id, purpose) WHERE deleted_at IS NULL;

-- Round-1 planning injection: the ordered attachment ids a planning run should
-- attach to the PM's and reviewer's first-round messages (later rounds carry
-- text only, for cost control). Additive to P2's planning_runs table.
ALTER TABLE planning_runs ADD COLUMN attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

REVOKE ALL PRIVILEGES ON attachments, attachment_blobs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON attachments, attachment_blobs FROM norns_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO norns_app;
GRANT SELECT, INSERT, DELETE ON attachment_blobs TO norns_app;
