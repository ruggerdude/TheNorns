-- EXECUTION E1: assembled task context, content-addressed.
--
-- THE NUMBER IS DELIBERATELY UNASSIGNED. 0018 is the highest number currently
-- merged; the PM assigns this migration's real number and renames both this
-- file and the constants in persistence/v2/migrate.ts at integration. Parallel
-- execution-program agents have collided on migration numbers three times.
--
-- Storage deliberately mirrors FRONT DOOR P4's attachments pattern: the bytes
-- live in their own table keyed by the content sha256, so identical context
-- documents (the repository/architecture section is byte-identical for every
-- task in a project) are stored once and the metadata table can later point at
-- object storage without a contract change.
--
-- The sha256 recorded here is the SAME hash the runner's
-- HashVerifiedContextLoader recomputes over the fetched bytes. It is the
-- integrity guarantee for the whole execution path; nothing else authenticates
-- the content.

-- Bytes, content-addressed. One row per distinct sha256 across the deployment.
CREATE TABLE task_context_blobs (
  sha256 TEXT PRIMARY KEY,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_context_blobs_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT task_context_blobs_content_check CHECK (octet_length(content) > 0)
);

-- Metadata. `id` is derived deterministically from (project_id, section,
-- sha256) by the assembler, so re-assembling an unchanged task returns exactly
-- the same artifact ids, the same hashes, and writes nothing new. Documents are
-- project-scoped but NOT task-scoped: the same repository or memory section is
-- shared by every task in the project.
CREATE TABLE task_context_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES task_context_blobs (sha256),
  byte_size INTEGER NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'text/markdown; charset=utf-8',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_context_documents_section_check CHECK (length(trim(section)) > 0),
  CONSTRAINT task_context_documents_byte_size_check CHECK (byte_size > 0)
);
CREATE UNIQUE INDEX task_context_documents_project_section_sha_idx
  ON task_context_documents (project_id, section, sha256);

REVOKE ALL PRIVILEGES ON task_context_documents, task_context_blobs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON task_context_documents, task_context_blobs FROM norns_app;
GRANT SELECT, INSERT ON task_context_documents TO norns_app;
GRANT SELECT, INSERT ON task_context_blobs TO norns_app;
