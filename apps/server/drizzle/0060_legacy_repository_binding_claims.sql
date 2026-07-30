-- DEVICE IDENTITY PHASE 6A: additive legacy-binding claim machinery.
--
-- This migration deliberately performs no data cutover. In particular, it
-- neither groups rows by legacy runner_id nor associates any legacy binding
-- with a device. A project owner must begin and finalize each exact project
-- binding through the gated application service.

ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_status_check_v0060 CHECK (
    status IN (
      'unverified_candidate',
      'validating',
      'connected',
      'degraded',
      'disconnected',
      'legacy_claim_required',
      'revoked'
    )
  ) NOT VALID;
ALTER TABLE repository_bindings
  VALIDATE CONSTRAINT repository_bindings_status_check_v0060;
ALTER TABLE repository_bindings
  DROP CONSTRAINT repository_bindings_status_check;
ALTER TABLE repository_bindings
  RENAME CONSTRAINT repository_bindings_status_check_v0060
  TO repository_bindings_status_check;

CREATE TABLE legacy_repository_binding_claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    REFERENCES projects (id) ON DELETE RESTRICT,
  legacy_binding_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'claim_required',
  preclaim_status TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT,
  begin_idempotency_key TEXT NOT NULL,
  project_device_repository_grant_id TEXT,
  replacement_binding_id TEXT UNIQUE,
  finalized_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  finalization_idempotency_key TEXT,
  finalized_at TIMESTAMPTZ,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT legacy_repository_binding_claims_project_legacy_fk
    FOREIGN KEY (project_id, legacy_binding_id)
    REFERENCES repository_bindings (project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT legacy_repository_binding_claims_project_grant_fk
    FOREIGN KEY (project_id, project_device_repository_grant_id)
    REFERENCES project_device_repository_grants (project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT legacy_repository_binding_claims_project_replacement_fk
    FOREIGN KEY (project_id, replacement_binding_id)
    REFERENCES repository_bindings (project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT legacy_repository_binding_claims_legacy_unique
    UNIQUE (legacy_binding_id),
  CONSTRAINT legacy_repository_binding_claims_begin_idempotency_unique
    UNIQUE (created_by_user_id, begin_idempotency_key),
  CONSTRAINT legacy_repository_binding_claims_state_check
    CHECK (state IN ('claim_required', 'finalized')),
  CONSTRAINT legacy_repository_binding_claims_preclaim_status_check CHECK (
    preclaim_status IN (
      'unverified_candidate',
      'validating',
      'connected',
      'degraded',
      'disconnected'
    )
  ),
  CONSTRAINT legacy_repository_binding_claims_idempotency_check CHECK (
    btrim(begin_idempotency_key) <> ''
    AND char_length(begin_idempotency_key) <= 200
    AND (
      finalization_idempotency_key IS NULL
      OR (
        btrim(finalization_idempotency_key) <> ''
        AND char_length(finalization_idempotency_key) <= 200
      )
    )
  ),
  CONSTRAINT legacy_repository_binding_claims_version_check
    CHECK (aggregate_version > 0),
  CONSTRAINT legacy_repository_binding_claims_replacement_check CHECK (
    replacement_binding_id IS NULL
    OR replacement_binding_id <> legacy_binding_id
  ),
  CONSTRAINT legacy_repository_binding_claims_state_shape_check CHECK (
    (
      state='claim_required'
      AND project_device_repository_grant_id IS NULL
      AND replacement_binding_id IS NULL
      AND finalized_by_user_id IS NULL
      AND finalization_idempotency_key IS NULL
      AND finalized_at IS NULL
    )
    OR (
      state='finalized'
      AND project_device_repository_grant_id IS NOT NULL
      AND replacement_binding_id IS NOT NULL
      AND finalized_by_user_id IS NOT NULL
      AND finalization_idempotency_key IS NOT NULL
      AND finalized_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX legacy_repository_binding_claims_finalize_idempotency_unique
  ON legacy_repository_binding_claims (
    finalized_by_user_id,
    finalization_idempotency_key
  )
  WHERE finalization_idempotency_key IS NOT NULL;

CREATE INDEX legacy_repository_binding_claims_project_state_idx
  ON legacy_repository_binding_claims (project_id, state);

CREATE OR REPLACE FUNCTION norns_guard_legacy_repository_binding_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP='UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.legacy_binding_id IS DISTINCT FROM NEW.legacy_binding_id
    OR OLD.preclaim_status IS DISTINCT FROM NEW.preclaim_status
    OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
    OR OLD.begin_idempotency_key IS DISTINCT FROM NEW.begin_idempotency_key
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'legacy repository claim identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP='UPDATE'
     AND NOT (
       OLD.state=NEW.state
       OR (OLD.state='claim_required' AND NEW.state='finalized')
     ) THEN
    RAISE EXCEPTION 'invalid legacy repository claim state transition'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP='UPDATE'
     AND OLD.state='finalized'
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'finalized legacy repository claim is terminal'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$guard$;

CREATE TRIGGER legacy_repository_binding_claims_guard
  BEFORE UPDATE ON legacy_repository_binding_claims
  FOR EACH ROW EXECUTE FUNCTION norns_guard_legacy_repository_binding_claim();

CREATE OR REPLACE FUNCTION norns_require_legacy_repository_binding_claim_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $scope$
BEGIN
  IF NEW.state='claim_required' THEN
    IF EXISTS (
      SELECT 1
        FROM agent_runs run
       WHERE run.project_id=NEW.project_id
         AND run.state IN (
           'created',
           'dispatched',
           'running',
           'verifying',
           'waiting_for_human'
         )
    ) THEN
      RAISE EXCEPTION 'open legacy repository claim is forbidden while project work is active'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM projects project
        JOIN repository_bindings legacy
          ON legacy.id=NEW.legacy_binding_id
         AND legacy.project_id=project.id
         AND legacy.binding_type='local_runner'
         AND legacy.runner_id IS NOT NULL
         AND legacy.project_device_repository_grant_id IS NULL
         AND legacy.status='legacy_claim_required'
       WHERE project.id=NEW.project_id
         AND project.primary_repository_binding_id=legacy.id
    ) THEN
      RAISE EXCEPTION 'open legacy repository claim must name the exact primary legacy binding'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM projects project
      JOIN repository_bindings legacy
        ON legacy.id=NEW.legacy_binding_id
       AND legacy.project_id=project.id
       AND legacy.binding_type='local_runner'
       AND legacy.runner_id IS NOT NULL
       AND legacy.project_device_repository_grant_id IS NULL
       AND legacy.status='revoked'
      JOIN repository_bindings replacement
        ON replacement.id=NEW.replacement_binding_id
       AND replacement.project_id=project.id
       AND replacement.binding_type='local_runner'
       AND replacement.runner_id IS NULL
       AND replacement.project_device_repository_grant_id=
           NEW.project_device_repository_grant_id
     WHERE project.id=NEW.project_id
       AND project.primary_repository_binding_id=replacement.id
  ) THEN
    RAISE EXCEPTION 'finalized legacy repository claim is not atomically switched'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$scope$;

CREATE CONSTRAINT TRIGGER legacy_repository_binding_claims_scope
  AFTER INSERT OR UPDATE ON legacy_repository_binding_claims
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_require_legacy_repository_binding_claim_scope();

REVOKE ALL PRIVILEGES ON legacy_repository_binding_claims FROM PUBLIC;
REVOKE ALL PRIVILEGES ON legacy_repository_binding_claims FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON legacy_repository_binding_claims TO norns_app;

GRANT EXECUTE ON FUNCTION
  norns_guard_legacy_repository_binding_claim(),
  norns_require_legacy_repository_binding_claim_scope()
TO norns_app;
