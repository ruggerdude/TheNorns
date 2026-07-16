-- Phase 2 preservation migration.
--
-- Forward-only additions for encrypted recovery checkpoints, lossless legacy
-- identity/project import, reconciliation, shadow reads, and durable cutover
-- routing. The frozen 0001 migration and legacy norns_state rows are untouched.

DO $phase2_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM norns_schema_migrations
    WHERE name = '0001_refoundation_v2'
  ) THEN
    RAISE EXCEPTION '0002_preservation_migration requires 0001_refoundation_v2'
      USING ERRCODE = '55000';
  END IF;
END
$phase2_dependency$;

DO $phase2_runtime_role_posture$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'norns_app'
      AND (
        rolcanlogin
        OR rolsuper
        OR rolcreatedb
        OR rolcreaterole
        OR rolreplication
        OR rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION
      'norns_app must be NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
      USING ERRCODE = '42501';
  END IF;
END
$phase2_runtime_role_posture$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS password_hash_scheme TEXT,
  ADD COLUMN IF NOT EXISTS password_rehashed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS source_record_id TEXT;

DO $phase2_password_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    WHERE password_hash IS NOT NULL
      AND password_hash !~ '^[0-9A-Fa-f]{32}:[0-9A-Fa-f]{128}$'
      AND password_hash !~ '^scrypt\$v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
  ) THEN
    RAISE EXCEPTION '0002 cannot classify one or more existing password hashes'
      USING ERRCODE = '22000';
  END IF;
END
$phase2_password_preflight$;

UPDATE users
SET email = lower(btrim(username)),
    name = display_name,
    password_hash_scheme = CASE
      WHEN password_hash IS NULL THEN NULL
      WHEN password_hash ~ '^scrypt\$v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'
        THEN 'scrypt-v1'
      ELSE 'legacy-scrypt-v0'
    END
WHERE email IS NULL
   OR email IS DISTINCT FROM lower(btrim(email))
   OR password_hash IS NOT NULL;

ALTER TABLE users
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_status_check
    CHECK (status IN ('active', 'invited', 'disabled')),
  ADD CONSTRAINT users_password_hash_shape_check
    CHECK ((password_hash IS NULL) = (password_hash_scheme IS NULL)),
  ADD CONSTRAINT users_active_password_check
    CHECK (status <> 'active' OR password_hash IS NOT NULL),
  ADD CONSTRAINT users_invited_password_check
    CHECK (status <> 'invited' OR password_hash IS NULL),
  ADD CONSTRAINT users_password_hash_scheme_check
    CHECK (
      password_hash_scheme IS NULL
      OR password_hash_scheme IN ('legacy-scrypt-v0', 'scrypt-v1')
    ),
  ADD CONSTRAINT users_email_normalized_check
    CHECK (email = lower(btrim(email))),
  ADD CONSTRAINT users_source_check
    CHECK (source IN ('native', 'legacy_snapshot'));

CREATE UNIQUE INDEX users_email_normalized_unique ON users (lower(email));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS token_hash_scheme TEXT NOT NULL DEFAULT 'sha256',
  ADD COLUMN IF NOT EXISTS token_key_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS source_record_id TEXT,
  ALTER COLUMN last_seen_at DROP NOT NULL;

-- No normalized credential issued before this migration used the Phase 2
-- keyed verifier. Revoke any pre-existing SHA-256 row before making the
-- database reject reusable unkeyed credentials.
UPDATE sessions
SET status = 'revoked',
    revoked_at = COALESCE(revoked_at, now()),
    revocation_reason = COALESCE(revocation_reason, 'phase2_unkeyed_credential_revoked')
WHERE token_hash_scheme = 'sha256'
  AND status = 'active';

ALTER TABLE sessions
  DROP CONSTRAINT sessions_user_id_users_id_fk,
  ADD CONSTRAINT sessions_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check
    CHECK (status IN ('active', 'revoked', 'expired')),
  ADD CONSTRAINT sessions_token_hash_scheme_check
    CHECK (token_hash_scheme IN ('sha256', 'hmac-sha256')),
  ADD CONSTRAINT sessions_token_key_check
    CHECK (
      (token_hash_scheme = 'hmac-sha256' AND token_key_id IS NOT NULL)
      OR (token_hash_scheme = 'sha256' AND token_key_id IS NULL)
    ),
  ADD CONSTRAINT sessions_revocation_shape_check
    CHECK (
      (status = 'active' AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
      OR status = 'expired'
    ),
  ADD CONSTRAINT sessions_native_active_verifier_check
    CHECK (
      source <> 'native'
      OR status <> 'active'
      OR (token_hash_scheme = 'hmac-sha256' AND token_key_id IS NOT NULL)
    ),
  ADD CONSTRAINT sessions_source_check
    CHECK (source IN ('native', 'legacy_snapshot')),
  ADD CONSTRAINT sessions_legacy_revoked_check
    CHECK (source <> 'legacy_snapshot' OR status = 'revoked');

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
    CONSTRAINT invitations_user_id_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  token_hash_scheme TEXT NOT NULL DEFAULT 'sha256',
  token_key_id TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  source TEXT NOT NULL DEFAULT 'native',
  source_record_id TEXT,
  CONSTRAINT invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT invitations_token_hash_scheme_check
    CHECK (token_hash_scheme IN ('sha256', 'hmac-sha256')),
  CONSTRAINT invitations_token_key_check
    CHECK (
      (token_hash_scheme = 'hmac-sha256' AND token_key_id IS NOT NULL)
      OR (token_hash_scheme = 'sha256' AND token_key_id IS NULL)
    ),
  CONSTRAINT invitations_accepted_shape_check
    CHECK (status <> 'accepted' OR accepted_at IS NOT NULL),
  CONSTRAINT invitations_revoked_shape_check
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),
  CONSTRAINT invitations_native_pending_verifier_check
    CHECK (
      source <> 'native'
      OR status <> 'pending'
      OR (token_hash_scheme = 'hmac-sha256' AND token_key_id IS NOT NULL)
    ),
  CONSTRAINT invitations_source_check
    CHECK (source IN ('native', 'legacy_snapshot')),
  CONSTRAINT invitations_legacy_revoked_check
    CHECK (source <> 'legacy_snapshot' OR status = 'revoked')
);
CREATE UNIQUE INDEX invitations_token_hash_unique ON invitations (token_hash);
CREATE INDEX invitations_user_status_idx
  ON invitations (user_id, status, expires_at);

CREATE TABLE credential_hmac_key_registry (
  key_id TEXT PRIMARY KEY,
  key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT credential_hmac_key_registry_fingerprint_check
    CHECK (key_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT credential_hmac_key_registry_status_check
    CHECK (status IN ('active', 'retired')),
  CONSTRAINT credential_hmac_key_registry_retirement_shape_check CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE FUNCTION norns_guard_credential_hmac_key_update()
RETURNS trigger
LANGUAGE plpgsql
AS $credential_hmac_key_guard$
BEGIN
  IF (
    NEW.key_id,
    NEW.key_fingerprint,
    NEW.registered_at
  ) IS DISTINCT FROM (
    OLD.key_id,
    OLD.key_fingerprint,
    OLD.registered_at
  ) THEN
    RAISE EXCEPTION 'credential HMAC key identity and fingerprint are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'active'
     AND NEW.status = 'retired'
     AND NEW.retired_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'credential HMAC key retirement is one-way'
    USING ERRCODE = '55000';
END
$credential_hmac_key_guard$;

CREATE TRIGGER credential_hmac_key_registry_update_guard
  BEFORE UPDATE ON credential_hmac_key_registry
  FOR EACH ROW EXECUTE FUNCTION norns_guard_credential_hmac_key_update();

CREATE TABLE archive_encryption_key_registry (
  key_id TEXT PRIMARY KEY,
  key_fingerprint TEXT NOT NULL UNIQUE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT archive_encryption_key_registry_identity_unique
    UNIQUE (key_id, key_fingerprint),
  CONSTRAINT archive_encryption_key_registry_fingerprint_check
    CHECK (key_fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE TRIGGER archive_encryption_key_registry_update_guard
  BEFORE UPDATE ON archive_encryption_key_registry
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();

-- Credential identity, verifier selection, and expiry are immutable. Live
-- credentials may move only to a terminal state; terminal rows can never be
-- made reusable again.
CREATE FUNCTION norns_guard_session_credential_update()
RETURNS trigger
LANGUAGE plpgsql
AS $session_credential_guard$
BEGIN
  IF (
    NEW.id,
    NEW.user_id,
    NEW.token_hash,
    NEW.token_hash_scheme,
    NEW.token_key_id,
    NEW.created_at,
    NEW.expires_at,
    NEW.source,
    NEW.source_record_id
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.user_id,
    OLD.token_hash,
    OLD.token_hash_scheme,
    OLD.token_key_id,
    OLD.created_at,
    OLD.expires_at,
    OLD.source,
    OLD.source_record_id
  ) THEN
    RAISE EXCEPTION 'session credential identity and verifier are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'active' AND NEW.status IN ('active', 'revoked', 'expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('revoked', 'expired') AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'session terminal state cannot be resurrected or changed'
    USING ERRCODE = '55000';
END
$session_credential_guard$;

CREATE TRIGGER sessions_credential_update_guard
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION norns_guard_session_credential_update();

CREATE FUNCTION norns_guard_invitation_credential_update()
RETURNS trigger
LANGUAGE plpgsql
AS $invitation_credential_guard$
BEGIN
  IF (
    NEW.id,
    NEW.user_id,
    NEW.token_hash,
    NEW.token_hash_scheme,
    NEW.token_key_id,
    NEW.created_at,
    NEW.expires_at,
    NEW.source,
    NEW.source_record_id
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.user_id,
    OLD.token_hash,
    OLD.token_hash_scheme,
    OLD.token_key_id,
    OLD.created_at,
    OLD.expires_at,
    OLD.source,
    OLD.source_record_id
  ) THEN
    RAISE EXCEPTION 'invitation credential identity and verifier are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending'
     AND NEW.status IN ('pending', 'accepted', 'revoked', 'expired') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('accepted', 'revoked', 'expired') AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invitation terminal state cannot be resurrected or changed'
    USING ERRCODE = '55000';
END
$invitation_credential_guard$;

CREATE TRIGGER invitations_credential_update_guard
  BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_invitation_credential_update();

CREATE TABLE project_planning_preferences (
  project_id TEXT PRIMARY KEY
    CONSTRAINT project_planning_preferences_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  pm_provider TEXT NOT NULL,
  pm_model TEXT,
  reviewer_provider TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'native',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_planning_preferences_pm_provider_check
    CHECK (pm_provider IN ('anthropic', 'openai')),
  CONSTRAINT project_planning_preferences_reviewer_provider_check
    CHECK (
      reviewer_provider IN ('anthropic', 'openai')
      AND reviewer_provider <> pm_provider
    ),
  CONSTRAINT project_planning_preferences_source_check
    CHECK (source IN ('native', 'legacy_snapshot'))
);

CREATE TABLE repository_binding_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    CONSTRAINT repository_binding_candidates_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  display_name TEXT NOT NULL,
  github_owner TEXT,
  github_name TEXT,
  status TEXT NOT NULL DEFAULT 'unverified',
  archive_id TEXT,
  source_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT repository_binding_candidates_source_type_check
    CHECK (source_type IN ('local', 'github')),
  CONSTRAINT repository_binding_candidates_status_check
    CHECK (status IN ('unverified', 'promoted', 'dismissed')),
  CONSTRAINT repository_binding_candidates_hash_check
    CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT repository_binding_candidates_source_shape_check
    CHECK (
      source_type = 'local'
      OR source_type = 'github'
    )
);
CREATE UNIQUE INDEX repository_binding_candidates_project_source_unique
  ON repository_binding_candidates (project_id, source_type, source_fingerprint);
CREATE INDEX repository_binding_candidates_project_status_idx
  ON repository_binding_candidates (project_id, status);

ALTER TABLE migration_runs
  ADD COLUMN IF NOT EXISTS source_manifest_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_application_version TEXT,
  ADD COLUMN IF NOT EXISTS source_application_commit TEXT,
  ADD COLUMN IF NOT EXISTS recovery_marker JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_source_records JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollback_window_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS v2_writes_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_summary TEXT;

CREATE UNIQUE INDEX migration_runs_phase2_preservation_singleton
  ON migration_runs (migration_name)
  WHERE migration_name = 'phase2_legacy_preservation';

ALTER TABLE migration_runs
  ADD CONSTRAINT migration_runs_status_check
    CHECK (status IN (
      'capturing', 'archived', 'importing', 'reconciling', 'shadowing',
      'ready', 'cutover', 'rolled_back', 'failed'
    )),
  ADD CONSTRAINT migration_runs_manifest_hash_check
    CHECK (
      source_manifest_hash IS NULL
      OR source_manifest_hash ~ '^[a-f0-9]{64}$'
    );

CREATE UNIQUE INDEX migration_runs_name_manifest_unique
  ON migration_runs (migration_name, source_manifest_hash)
  WHERE source_manifest_hash IS NOT NULL;

CREATE TABLE recovery_checkpoints (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL
    CONSTRAINT recovery_checkpoints_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  backup_reference TEXT NOT NULL,
  database_time TIMESTAMPTZ NOT NULL,
  wal_lsn TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  application_version TEXT NOT NULL,
  application_commit TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  source_frozen_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recovery_checkpoints_manifest_hash_check
    CHECK (source_manifest_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX recovery_checkpoints_migration_run_unique
  ON recovery_checkpoints (migration_run_id);

CREATE TABLE legacy_snapshot_archives (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL
    CONSTRAINT legacy_snapshot_archives_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  storage_ref TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  cipher TEXT NOT NULL,
  exact_hash TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  ciphertext_hash TEXT NOT NULL,
  aad_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  exact_byte_size BIGINT NOT NULL,
  canonical_byte_size BIGINT NOT NULL,
  object_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_record JSONB,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  status TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  CONSTRAINT legacy_snapshot_archives_key_registry_fk
    FOREIGN KEY (key_id, key_fingerprint)
    REFERENCES archive_encryption_key_registry (key_id, key_fingerprint)
    ON DELETE RESTRICT,
  CONSTRAINT legacy_snapshot_archives_hashes_check CHECK (
    exact_hash ~ '^[a-f0-9]{64}$'
    AND canonical_hash ~ '^[a-f0-9]{64}$'
    AND ciphertext_hash ~ '^[a-f0-9]{64}$'
    AND aad_hash ~ '^[a-f0-9]{64}$'
    AND manifest_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT legacy_snapshot_archives_cipher_check
    CHECK (cipher = 'aes-256-gcm'),
  CONSTRAINT legacy_snapshot_archives_status_check
    CHECK (status IN ('sealed', 'verified', 'expired')),
  CONSTRAINT legacy_snapshot_archives_verification_shape_check CHECK (
    (status = 'sealed' AND verified_at IS NULL)
    OR status = 'expired'
    OR (status = 'verified' AND verified_at IS NOT NULL)
  ),
  CONSTRAINT legacy_snapshot_archives_size_check
    CHECK (exact_byte_size >= 0 AND canonical_byte_size >= 0),
  CONSTRAINT legacy_snapshot_archives_retention_check
    CHECK (retention_until > captured_at)
);
CREATE UNIQUE INDEX legacy_snapshot_archives_storage_unique
  ON legacy_snapshot_archives (storage_ref);
CREATE UNIQUE INDEX legacy_snapshot_archives_run_source_unique
  ON legacy_snapshot_archives (migration_run_id, source_key);
-- AES-GCM catastrophically fails when a nonce is reused under the same key.
-- Make that state unrepresentable even if a faulty nonce generator reaches
-- the persistence boundary.
CREATE UNIQUE INDEX legacy_snapshot_archives_key_nonce_unique
  ON legacy_snapshot_archives (key_fingerprint, nonce);

ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_archive_id_legacy_snapshot_archives_id_fk
  FOREIGN KEY (archive_id)
  REFERENCES legacy_snapshot_archives (id) ON DELETE RESTRICT;

CREATE TABLE legacy_archive_access_events (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL
    CONSTRAINT legacy_archive_access_events_archive_id_legacy_snapshot_archives_id_fk
    REFERENCES legacy_snapshot_archives (id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_applied BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT legacy_archive_access_operation_check
    CHECK (operation IN ('write', 'head', 'read', 'verify')),
  CONSTRAINT legacy_archive_access_outcome_check
    CHECK (outcome IN ('allowed', 'denied', 'failed')),
  CONSTRAINT legacy_archive_access_human_actor_check
    CHECK (actor_type <> 'human' OR actor_id IS NOT NULL)
);
CREATE INDEX legacy_archive_access_archive_time_idx
  ON legacy_archive_access_events (archive_id, occurred_at);

CREATE TABLE migration_steps (
  migration_run_id TEXT NOT NULL
    CONSTRAINT migration_steps_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  step_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  output_hash TEXT,
  output_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_summary TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migration_steps_pk PRIMARY KEY (migration_run_id, step_key),
  CONSTRAINT migration_steps_hash_check
    CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT migration_steps_output_hash_check
    CHECK (output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT migration_steps_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT migration_steps_attempt_check CHECK (attempt > 0)
);

CREATE TABLE legacy_project_imports (
  migration_run_id TEXT NOT NULL
    CONSTRAINT legacy_project_imports_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    CONSTRAINT legacy_project_imports_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  source_hash TEXT NOT NULL,
  plan_hash TEXT,
  graph_hash TEXT,
  approval_hash TEXT,
  graph_version INTEGER,
  source_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  import_hash TEXT NOT NULL,
  archive_id TEXT
    CONSTRAINT legacy_project_imports_archive_id_legacy_snapshot_archives_id_fk
    REFERENCES legacy_snapshot_archives (id) ON DELETE RESTRICT,
  imported_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT legacy_project_imports_pk
    PRIMARY KEY (migration_run_id, project_id),
  CONSTRAINT legacy_project_imports_hash_check CHECK (
    source_hash ~ '^[a-f0-9]{64}$'
    AND (plan_hash IS NULL OR plan_hash ~ '^[a-f0-9]{64}$')
    AND (graph_hash IS NULL OR graph_hash ~ '^[a-f0-9]{64}$')
    AND (approval_hash IS NULL OR approval_hash ~ '^[a-f0-9]{64}$')
    AND import_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT legacy_project_imports_graph_version_check
    CHECK (graph_version IS NULL OR graph_version > 0)
);

ALTER TABLE legacy_id_mappings
  ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS import_event_id TEXT;

ALTER TABLE legacy_id_mappings
  ADD CONSTRAINT legacy_id_mappings_source_hash_check
    CHECK (source_hash ~ '^[a-f0-9]{64}$');

CREATE TABLE migration_reconciliation_findings (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL
    CONSTRAINT migration_reconciliation_findings_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  project_id TEXT
    CONSTRAINT migration_reconciliation_findings_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT,
  source_fingerprint TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by_actor_id TEXT
    CONSTRAINT migration_reconciliation_findings_resolved_by_actor_id_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  disposition_note TEXT,
  CONSTRAINT migration_reconciliation_findings_code_check CHECK (code IN (
    'invalid_plan_payload',
    'invalid_graph_payload',
    'plan_without_graph',
    'graph_without_plan',
    'graph_node_without_plan_module',
    'plan_module_without_graph_node',
    'shared_task_field_mismatch',
    'acceptance_criteria_unavailable',
    'acceptance_criteria_projection_mismatch',
    'dependency_edge_added_in_graph',
    'dependency_edge_removed_from_graph',
    'orphan_dependency_reference',
    'assignment_missing',
    'assignment_projection_mismatch',
    'assignment_worker_count_requires_reconciliation',
    'assignment_changed_since_approval',
    'approval_graph_version_mismatch',
    'approval_content_hash_mismatch',
    'invalid_approval_payload',
    'approval_actor_unattributable',
    'source_changed_after_freeze',
    'imported_count_mismatch',
    'imported_checksum_mismatch',
    'unknown_snapshot_key',
    'nonterminal_legacy_command'
  )),
  CONSTRAINT migration_reconciliation_findings_severity_check
    CHECK (severity IN ('blocking', 'warning', 'informational')),
  CONSTRAINT migration_reconciliation_findings_status_check
    CHECK (status IN ('open', 'resolved', 'accepted')),
  CONSTRAINT migration_reconciliation_findings_disposition_shape_check CHECK (
    (
      status = 'open'
      AND resolved_at IS NULL
      AND resolved_by_actor_id IS NULL
      AND disposition_note IS NULL
    )
    OR (
      status IN ('resolved', 'accepted')
      AND resolved_at IS NOT NULL
      AND resolved_by_actor_id IS NOT NULL
      AND disposition_note IS NOT NULL
      AND btrim(disposition_note) <> ''
    )
  ),
  CONSTRAINT migration_reconciliation_findings_hash_check
    CHECK (source_fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX migration_reconciliation_findings_identity_unique
  ON migration_reconciliation_findings (
    migration_run_id,
    project_id,
    code,
    source_entity_type,
    source_entity_id,
    source_fingerprint
  );
CREATE INDEX migration_reconciliation_findings_open_idx
  ON migration_reconciliation_findings (
    migration_run_id,
    project_id,
    status,
    severity
  );

CREATE TABLE shadow_read_comparisons (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL
    CONSTRAINT shadow_read_comparisons_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  legacy_hash TEXT NOT NULL,
  relational_hash TEXT NOT NULL,
  matched BOOLEAN NOT NULL,
  differences JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_key TEXT NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  source_exact_hash TEXT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT shadow_read_comparisons_scope_check
    CHECK (scope_type IN ('identity', 'project', 'new_projects', 'relay')),
  CONSTRAINT shadow_read_comparisons_hash_check CHECK (
    legacy_hash ~ '^[a-f0-9]{64}$'
    AND relational_hash ~ '^[a-f0-9]{64}$'
    AND source_manifest_hash ~ '^[a-f0-9]{64}$'
    AND source_exact_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT shadow_read_comparisons_difference_check CHECK (
    (matched AND jsonb_array_length(differences) = 0)
    OR (NOT matched AND jsonb_array_length(differences) > 0)
  )
);
CREATE INDEX shadow_read_comparisons_scope_time_idx
  ON shadow_read_comparisons (scope_type, scope_key, observed_at);
CREATE INDEX shadow_read_comparisons_mismatch_idx
  ON shadow_read_comparisons (migration_run_id, matched);
CREATE INDEX shadow_read_comparisons_provenance_idx
  ON shadow_read_comparisons (
    migration_run_id, scope_type, scope_key, source_manifest_hash,
    source_key, source_exact_hash, source_updated_at, observed_at
  );

-- Shadow evidence is evidence about a specific frozen source revision, not a
-- caller-selected timestamp. Bind that provenance inside PostgreSQL so a
-- future-dated observation, stale source hash, or foreign manifest cannot be
-- manufactured through the application insert surface.
CREATE FUNCTION norns_bind_shadow_read_comparison()
RETURNS trigger
LANGUAGE plpgsql
AS $shadow_read_comparison_binding$
DECLARE
  bound_manifest_hash TEXT;
  bound_source_key TEXT;
  bound_source_text TEXT;
  bound_source_updated_at TIMESTAMPTZ;
  bound_observed_at TIMESTAMPTZ;
BEGIN
  SELECT source_manifest_hash
    INTO bound_manifest_hash
    FROM migration_runs
   WHERE id = NEW.migration_run_id;

  IF bound_manifest_hash IS NULL THEN
    RAISE EXCEPTION 'shadow evidence requires a migration manifest'
      USING ERRCODE = '23514';
  END IF;

  bound_source_key := CASE NEW.scope_type
    WHEN 'identity' THEN 'users'
    WHEN 'project' THEN 'projects'
    WHEN 'new_projects' THEN 'projects'
    WHEN 'relay' THEN 'relay'
    ELSE NULL
  END;
  IF bound_source_key IS NULL THEN
    RAISE EXCEPTION 'shadow evidence has an unsupported persistence scope'
      USING ERRCODE = '23514';
  END IF;

  SELECT snapshot::text, updated_at
    INTO bound_source_text, bound_source_updated_at
    FROM norns_state
   WHERE key = bound_source_key;
  IF bound_source_text IS NULL OR bound_source_updated_at IS NULL THEN
    RAISE EXCEPTION 'shadow evidence source % is missing', bound_source_key
      USING ERRCODE = '23514';
  END IF;

  bound_observed_at := transaction_timestamp();
  NEW.source_key := bound_source_key;
  NEW.source_manifest_hash := bound_manifest_hash;
  NEW.source_exact_hash := encode(sha256(convert_to(bound_source_text, 'UTF8')), 'hex');
  NEW.source_updated_at := bound_source_updated_at;
  NEW.observed_at := bound_observed_at;
  NEW.id := 'shadow:' || encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'caller_id', NEW.id,
          'migration_run_id', NEW.migration_run_id,
          'scope_type', NEW.scope_type,
          'scope_key', NEW.scope_key,
          'operation', NEW.operation,
          'legacy_hash', NEW.legacy_hash,
          'relational_hash', NEW.relational_hash,
          'source_manifest_hash', NEW.source_manifest_hash,
          'source_key', NEW.source_key,
          'source_exact_hash', NEW.source_exact_hash,
          'source_updated_at', NEW.source_updated_at,
          'observed_at', NEW.observed_at,
          'transaction_id', txid_current()
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
  RETURN NEW;
END
$shadow_read_comparison_binding$;

CREATE TRIGGER shadow_read_comparisons_bind_provenance
  BEFORE INSERT ON shadow_read_comparisons
  FOR EACH ROW EXECUTE FUNCTION norns_bind_shadow_read_comparison();

CREATE TABLE persistence_routes (
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  read_mode TEXT NOT NULL,
  write_mode TEXT NOT NULL,
  migration_run_id TEXT
    CONSTRAINT persistence_routes_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  changed_by_actor_type TEXT NOT NULL,
  changed_by_actor_id TEXT
    CONSTRAINT persistence_routes_changed_by_actor_id_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  changed_at TIMESTAMPTZ NOT NULL,
  v2_writes_started_at TIMESTAMPTZ,
  rollback_window_until TIMESTAMPTZ,
  CONSTRAINT persistence_routes_pk PRIMARY KEY (scope_type, scope_key),
  CONSTRAINT persistence_routes_scope_check
    CHECK (scope_type IN ('identity', 'project', 'new_projects', 'relay')),
  CONSTRAINT persistence_routes_scope_key_check CHECK (
    (scope_type = 'project' AND scope_key <> '*')
    OR (scope_type <> 'project' AND scope_key = '*')
  ),
  CONSTRAINT persistence_routes_read_mode_check
    CHECK (read_mode IN ('legacy', 'shadow', 'relational')),
  CONSTRAINT persistence_routes_write_mode_check
    CHECK (write_mode IN ('legacy', 'frozen', 'relational')),
  CONSTRAINT persistence_routes_v2_write_time_check
    CHECK (write_mode <> 'relational' OR v2_writes_started_at IS NOT NULL),
  CONSTRAINT persistence_routes_human_actor_check
    CHECK (changed_by_actor_type <> 'human' OR changed_by_actor_id IS NOT NULL),
  CONSTRAINT persistence_routes_version_check CHECK (aggregate_version > 0)
);

CREATE TABLE legacy_approval_evidence (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL
    CONSTRAINT legacy_approval_evidence_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    CONSTRAINT legacy_approval_evidence_project_id_projects_id_fk
    REFERENCES projects (id) ON DELETE RESTRICT,
  phase_id TEXT
    CONSTRAINT legacy_approval_evidence_phase_id_phases_id_fk
    REFERENCES phases (id) ON DELETE RESTRICT,
  subject_entity_type TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  graph_version INTEGER NOT NULL,
  allocation_fingerprint TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT
    CONSTRAINT legacy_approval_evidence_actor_id_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  source_actor_text TEXT,
  approved_at TIMESTAMPTZ NOT NULL,
  current_at_import BOOLEAN NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT legacy_approval_evidence_hash_check CHECK (
    content_hash ~ '^[a-f0-9]{64}$'
    AND allocation_fingerprint ~ '^[a-f0-9]{64}$'
    AND source_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT legacy_approval_evidence_graph_version_check CHECK (graph_version > 0),
  CONSTRAINT legacy_approval_evidence_actor_check CHECK (
    (
      actor_type = 'legacy'
      AND actor_id IS NULL
      AND source_actor_text IS NOT NULL
    )
    OR (
      actor_type = 'human'
      AND actor_id IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX legacy_approval_evidence_source_unique
  ON legacy_approval_evidence (migration_run_id, project_id, source_hash);

-- Recovery/access/provenance records are immutable even for the table owner.
DO $phase2_append_only$
DECLARE
  protected_table TEXT;
  protected_tables TEXT[] := ARRAY[
    'legacy_archive_access_events',
    'legacy_approval_evidence',
    'legacy_project_imports',
    'shadow_read_comparisons',
    'legacy_id_mappings'
  ];
BEGIN
  FOREACH protected_table IN ARRAY protected_tables LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation()',
      protected_table || '_append_only',
      protected_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I
       FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation()',
      protected_table || '_append_only_truncate',
      protected_table
    );
  END LOOP;
END
$phase2_append_only$;

-- Checkpoint identity is immutable, but a privileged verifier may stamp the
-- checkpoint exactly once. The guard rejects every other rewrite, including
-- attempts to combine verification with a history edit.
CREATE FUNCTION norns_guard_recovery_checkpoint_update()
RETURNS trigger
LANGUAGE plpgsql
AS $recovery_checkpoint_guard$
BEGIN
  IF (to_jsonb(NEW) - 'verified_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'verified_at') THEN
    RAISE EXCEPTION 'recovery_checkpoints is append-only; checkpoint identity cannot change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.verified_at IS NULL
     AND NEW.verified_at IS NOT NULL
     AND NEW.verified_at >= OLD.created_at
     AND NEW.verified_at <= CURRENT_TIMESTAMP THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recovery_checkpoints is append-only; verified_at may be set exactly once'
    USING ERRCODE = '55000';
END
$recovery_checkpoint_guard$;

CREATE TRIGGER recovery_checkpoints_update_guard
  BEFORE UPDATE ON recovery_checkpoints
  FOR EACH ROW EXECUTE FUNCTION norns_guard_recovery_checkpoint_update();
CREATE TRIGGER recovery_checkpoints_delete_guard
  BEFORE DELETE ON recovery_checkpoints
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER recovery_checkpoints_truncate_guard
  BEFORE TRUNCATE ON recovery_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

-- Archive identity and encrypted payload are immutable. The only ordinary
-- lifecycle mutation is a one-way verification stamp. Expiry is also one-way
-- and may occur only after retention; it deliberately leaves every payload
-- and verification field untouched.
CREATE FUNCTION norns_guard_legacy_snapshot_archive_update()
RETURNS trigger
LANGUAGE plpgsql
AS $legacy_archive_guard$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'verified_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'verified_at') THEN
    RAISE EXCEPTION 'legacy_snapshot_archives payload and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'sealed'
     AND OLD.verified_at IS NULL
     AND NEW.status = 'verified'
     AND NEW.verified_at IS NOT NULL
     AND NEW.verified_at >= OLD.captured_at
     AND NEW.verified_at <= CURRENT_TIMESTAMP THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('sealed', 'verified')
     AND NEW.status = 'expired'
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
     AND CURRENT_TIMESTAMP >= OLD.retention_until THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'legacy_snapshot_archives allows only sealed-to-verified or retention expiry transitions'
    USING ERRCODE = '55000';
END
$legacy_archive_guard$;

CREATE TRIGGER legacy_snapshot_archives_update_guard
  BEFORE UPDATE ON legacy_snapshot_archives
  FOR EACH ROW EXECUTE FUNCTION norns_guard_legacy_snapshot_archive_update();

CREATE TRIGGER migration_reconciliation_findings_delete_guard
  BEFORE DELETE ON migration_reconciliation_findings
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER migration_reconciliation_findings_truncate_guard
  BEFORE TRUNCATE ON migration_reconciliation_findings
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

CREATE FUNCTION norns_guard_migration_finding_update()
RETURNS trigger
LANGUAGE plpgsql
AS $migration_finding_guard$
BEGIN
  IF (
    to_jsonb(NEW)
      - 'status'
      - 'resolved_at'
      - 'resolved_by_actor_id'
      - 'disposition_note'
  ) IS DISTINCT FROM (
    to_jsonb(OLD)
      - 'status'
      - 'resolved_at'
      - 'resolved_by_actor_id'
      - 'disposition_note'
  ) THEN
    RAISE EXCEPTION 'migration finding identity and evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'open'
     AND NEW.status IN ('resolved', 'accepted')
     AND NEW.resolved_at IS NOT NULL
     AND NEW.resolved_by_actor_id IS NOT NULL
     AND NEW.disposition_note IS NOT NULL
     AND btrim(NEW.disposition_note) <> '' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'migration findings allow only an attributed one-way disposition'
    USING ERRCODE = '55000';
END
$migration_finding_guard$;

CREATE TRIGGER migration_reconciliation_findings_update_guard
  BEFORE UPDATE ON migration_reconciliation_findings
  FOR EACH ROW EXECUTE FUNCTION norns_guard_migration_finding_update();

DO $phase2_delete_guards$
DECLARE
  protected_table TEXT;
  protected_tables TEXT[] := ARRAY[
    'users',
    'sessions',
    'projects',
    'invitations',
    'credential_hmac_key_registry',
    'archive_encryption_key_registry',
    'project_planning_preferences',
    'repository_binding_candidates',
    'migration_runs',
    'migration_steps',
    'legacy_snapshot_archives'
  ];
BEGIN
  FOREACH protected_table IN ARRAY protected_tables LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I
       FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation()',
      protected_table || '_delete_guard',
      protected_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I
       FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation()',
      protected_table || '_truncate_guard',
      protected_table
    );
  END LOOP;
END
$phase2_delete_guards$;

-- Extend runtime privileges deliberately. Migration/archive control remains
-- privileged, archive access history is append-only, and projects are
-- archive-only for the MVP.
DO $phase2_runtime_grants$
DECLARE
  runtime_schema TEXT := current_schema();
  runtime_table TEXT;
  operational_tables TEXT[] := ARRAY[
    'invitations',
    'project_planning_preferences',
    'repository_binding_candidates'
  ];
  read_only_tables TEXT[] := ARRAY[
    'credential_hmac_key_registry',
    'archive_encryption_key_registry',
    'recovery_checkpoints',
    'migration_steps',
    'legacy_approval_evidence',
    'legacy_project_imports',
    'migration_runs',
    'legacy_id_mappings'
  ];
BEGIN
  FOREACH runtime_table IN ARRAY operational_tables LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM norns_app',
      runtime_schema,
      runtime_table
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO norns_app',
      runtime_schema,
      runtime_table
    );
  END LOOP;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.persistence_routes FROM norns_app',
    runtime_schema
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.persistence_routes TO norns_app',
    runtime_schema
  );

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.legacy_archive_access_events FROM norns_app',
    runtime_schema
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.legacy_archive_access_events TO norns_app',
    runtime_schema
  );

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.migration_reconciliation_findings FROM norns_app',
    runtime_schema
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.migration_reconciliation_findings TO norns_app',
    runtime_schema
  );

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.shadow_read_comparisons FROM norns_app',
    runtime_schema
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE %I.shadow_read_comparisons TO norns_app',
    runtime_schema
  );

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.legacy_snapshot_archives FROM norns_app',
    runtime_schema
  );
  EXECUTE format(
    'GRANT SELECT (
       id, migration_run_id, source_key, source_updated_at, storage_ref, key_id,
       key_fingerprint, cipher, exact_hash, canonical_hash, ciphertext_hash, aad_hash,
       manifest_hash, exact_byte_size, canonical_byte_size, object_counts,
       last_record, status, captured_at, retention_until, verified_at
     ) ON TABLE %I.legacy_snapshot_archives TO norns_app',
    runtime_schema
  );

  FOREACH runtime_table IN ARRAY read_only_tables LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM norns_app',
      runtime_schema,
      runtime_table
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.%I TO norns_app',
      runtime_schema,
      runtime_table
    );
  END LOOP;

  IF to_regclass(format('%I.norns_state', runtime_schema)) IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.norns_state FROM norns_app',
      runtime_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.norns_state TO norns_app',
      runtime_schema
    );
  END IF;

  EXECUTE format(
    'REVOKE DELETE ON TABLE %I.users, %I.sessions, %I.projects FROM norns_app',
    runtime_schema,
    runtime_schema,
    runtime_schema
  );
END
$phase2_runtime_grants$;

-- Rollback evidence is a database-derived, short-lived statement of exactly
-- which project read canaries are active and which normalized records would
-- become invisible. The human approves this immutable record by fingerprint;
-- callers never supply counts, timestamps, or target scopes.
CREATE TABLE migration_rollback_evidence (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL
    CONSTRAINT migration_rollback_evidence_migration_run_id_migration_runs_id_fk
    REFERENCES migration_runs (id) ON DELETE RESTRICT,
  state_fingerprint TEXT NOT NULL,
  report_fingerprint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migration_rollback_evidence_identity_unique
    UNIQUE (id, migration_run_id),
  CONSTRAINT migration_rollback_evidence_report_unique
    UNIQUE (report_fingerprint),
  CONSTRAINT migration_rollback_evidence_hash_check CHECK (
    state_fingerprint ~ '^[a-f0-9]{64}$'
    AND report_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT migration_rollback_evidence_freshness_check
    CHECK (valid_until > observed_at),
  CONSTRAINT migration_rollback_evidence_report_shape_check
    CHECK (jsonb_typeof(report) = 'object')
);
CREATE INDEX migration_rollback_evidence_run_time_idx
  ON migration_rollback_evidence (migration_run_id, observed_at DESC);

CREATE TABLE migration_rollback_approvals (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  migration_run_id TEXT NOT NULL,
  human_actor_id TEXT NOT NULL
    CONSTRAINT migration_rollback_approvals_human_actor_id_users_id_fk
    REFERENCES users (id) ON DELETE RESTRICT,
  confirmed_report_fingerprint TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  routes_reversed JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT migration_rollback_approvals_evidence_unique UNIQUE (evidence_id),
  CONSTRAINT migration_rollback_approvals_evidence_run_fk
    FOREIGN KEY (evidence_id, migration_run_id)
    REFERENCES migration_rollback_evidence (id, migration_run_id) ON DELETE RESTRICT,
  CONSTRAINT migration_rollback_approvals_hash_check
    CHECK (confirmed_report_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT migration_rollback_approvals_routes_check
    CHECK (jsonb_typeof(routes_reversed) = 'array' AND jsonb_array_length(routes_reversed) > 0)
);
CREATE INDEX migration_rollback_approvals_run_time_idx
  ON migration_rollback_approvals (migration_run_id, approved_at DESC);

CREATE TRIGGER migration_rollback_evidence_update_delete_guard
  BEFORE UPDATE OR DELETE ON migration_rollback_evidence
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER migration_rollback_evidence_truncate_guard
  BEFORE TRUNCATE ON migration_rollback_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER migration_rollback_approvals_update_delete_guard
  BEFORE UPDATE OR DELETE ON migration_rollback_approvals
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER migration_rollback_approvals_truncate_guard
  BEFORE TRUNCATE ON migration_rollback_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

-- Once relational credential writes have ever started, even a temporary
-- write freeze cannot erase that fact or route identity reads/writes back to
-- the legacy snapshot. Recovery is an offline restore followed by a fresh
-- migration run, never credential resurrection through a route update.
CREATE FUNCTION norns_guard_identity_route_forward_only()
RETURNS trigger
LANGUAGE plpgsql
AS $identity_route_forward_only$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.scope_type = 'identity' AND OLD.v2_writes_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'identity credential cutover is forward-only; the durable route cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.scope_type = 'identity'
     AND (NEW.scope_type, NEW.scope_key) IS DISTINCT FROM (OLD.scope_type, OLD.scope_key) THEN
    RAISE EXCEPTION 'identity credential route scope is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.scope_type = 'identity'
     AND OLD.v2_writes_started_at IS NOT NULL
     AND (
       NEW.v2_writes_started_at IS DISTINCT FROM OLD.v2_writes_started_at
       OR NEW.read_mode <> 'relational'
       OR NEW.write_mode = 'legacy'
     ) THEN
    RAISE EXCEPTION 'identity credential cutover is forward-only; legacy credentials cannot be reactivated'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$identity_route_forward_only$;

CREATE TRIGGER persistence_routes_identity_forward_only_guard
  BEFORE UPDATE OR DELETE ON persistence_routes
  FOR EACH ROW EXECUTE FUNCTION norns_guard_identity_route_forward_only();
CREATE TRIGGER persistence_routes_truncate_guard
  BEFORE TRUNCATE ON persistence_routes
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

DO $phase2_rollback_runtime_grants$
DECLARE
  runtime_schema TEXT := current_schema();
  rollback_table TEXT;
  rollback_tables TEXT[] := ARRAY[
    'migration_rollback_evidence',
    'migration_rollback_approvals'
  ];
BEGIN
  FOREACH rollback_table IN ARRAY rollback_tables LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM norns_app',
      runtime_schema,
      rollback_table
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.%I TO norns_app',
      runtime_schema,
      rollback_table
    );
  END LOOP;
END
$phase2_rollback_runtime_grants$;
