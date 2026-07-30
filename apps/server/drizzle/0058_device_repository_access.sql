-- DEVICE IDENTITY PHASE 4: repository registrations, project grants,
-- immutable device-backed bindings, and one-use publication permits.
--
-- Local paths are deliberately absent. The server stores only opaque
-- installation-scoped workspace/repository identifiers and cloud-safe
-- display metadata.

ALTER TABLE device_repository_registrations
  ADD COLUMN IF NOT EXISTS default_branch TEXT;
ALTER TABLE device_repository_registrations
  ADD COLUMN IF NOT EXISTS observed_head TEXT;
ALTER TABLE device_repository_registrations
  ADD COLUMN IF NOT EXISTS approved_credential_id TEXT;
ALTER TABLE device_repository_registrations
  ADD COLUMN IF NOT EXISTS approved_generation BIGINT;

ALTER TABLE device_credentials
  ADD CONSTRAINT device_credentials_device_id_id_generation_unique
  UNIQUE (device_id, id, generation);

ALTER TABLE device_repository_registrations
  ADD CONSTRAINT device_repository_registrations_approval_credential_fk
  FOREIGN KEY (device_id, approved_credential_id, approved_generation)
  REFERENCES device_credentials (device_id, id, generation)
  ON DELETE RESTRICT;

ALTER TABLE device_repository_registrations
  ADD CONSTRAINT device_repository_registrations_repository_metadata_check CHECK (
    (default_branch IS NULL OR btrim(default_branch) <> '')
    AND (observed_head IS NULL OR btrim(observed_head) <> '')
    AND (
      (approved_credential_id IS NULL AND approved_generation IS NULL)
      OR (
        approved_credential_id IS NOT NULL
        AND approved_generation IS NOT NULL
        AND approved_generation > 0
      )
    )
  );

UPDATE device_repository_registrations registration
   SET approved_credential_id=credential.id,
       approved_generation=credential.generation
  FROM devices device
  JOIN device_credentials credential
    ON credential.device_id=device.id
   AND credential.state='active'
   AND credential.generation=device.current_generation
 WHERE registration.device_id=device.id
   AND registration.state IN ('active','revoked')
   AND registration.approved_credential_id IS NULL
   AND registration.approved_generation IS NULL;

ALTER TABLE device_repository_registrations
  ADD CONSTRAINT device_repository_registrations_credential_proof_state_check CHECK (
    (
      state='pending'
      AND approved_credential_id IS NULL
      AND approved_generation IS NULL
    )
    OR (
      state='active'
      AND approved_credential_id IS NOT NULL
      AND approved_generation IS NOT NULL
    )
    OR (
      state='revoked'
      AND (
        (approved_credential_id IS NULL AND approved_generation IS NULL)
        OR (approved_credential_id IS NOT NULL AND approved_generation IS NOT NULL)
      )
    )
  ) NOT VALID;
ALTER TABLE device_repository_registrations
  VALIDATE CONSTRAINT device_repository_registrations_credential_proof_state_check;

CREATE OR REPLACE FUNCTION norns_guard_device_repository_registration()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.device_id IS DISTINCT FROM NEW.device_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'repository registration identity and approval are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.approved_by_user_id IS DISTINCT FROM NEW.approved_by_user_id
    OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
    OR OLD.approved_credential_id IS DISTINCT FROM NEW.approved_credential_id
    OR OLD.approved_generation IS DISTINCT FROM NEW.approved_generation
  ) AND NOT (
    OLD.state='pending'
    AND NEW.state='active'
    AND OLD.approved_by_user_id IS NULL
    AND OLD.approved_at IS NULL
    AND OLD.approved_credential_id IS NULL
    AND OLD.approved_generation IS NULL
    AND NEW.approved_by_user_id IS NOT NULL
    AND NEW.approved_at IS NOT NULL
    AND NEW.approved_credential_id IS NOT NULL
    AND NEW.approved_generation IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'repository registration approval is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NOT (
       OLD.state=NEW.state
       OR (OLD.state='pending' AND NEW.state IN ('active','revoked'))
       OR (OLD.state='active' AND NEW.state='revoked')
     ) THEN
    RAISE EXCEPTION 'invalid repository registration state transition'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state = 'revoked' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked repository registration is terminal'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS device_repository_registrations_guard
  ON device_repository_registrations;
CREATE TRIGGER device_repository_registrations_guard
  BEFORE INSERT OR UPDATE ON device_repository_registrations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_repository_registration();

CREATE OR REPLACE FUNCTION norns_guard_project_device_repository_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.repository_registration_id IS DISTINCT FROM NEW.repository_registration_id
    OR OLD.granted_by_user_id IS DISTINCT FROM NEW.granted_by_user_id
    OR OLD.granted_at IS DISTINCT FROM NEW.granted_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'project repository grant identity and provenance are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NOT (
       OLD.state=NEW.state
       OR (OLD.state='active' AND NEW.state='revoked')
     ) THEN
    RAISE EXCEPTION 'invalid project repository grant state transition'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state = 'revoked' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked project repository grant is terminal'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS project_device_repository_grants_guard
  ON project_device_repository_grants;
CREATE TRIGGER project_device_repository_grants_guard
  BEFORE UPDATE ON project_device_repository_grants
  FOR EACH ROW EXECUTE FUNCTION norns_guard_project_device_repository_grant();

-- Legacy local bindings retain runner_id. Device-backed bindings carry their
-- identity only through the grant -> registration -> device chain.
ALTER TABLE repository_bindings ALTER COLUMN runner_id DROP NOT NULL;
ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_device_identity_shape_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_device_identity_shape_check CHECK (
    project_device_repository_grant_id IS NULL OR runner_id IS NULL
  );

CREATE OR REPLACE FUNCTION norns_require_device_repository_binding_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $scope$
BEGIN
  IF NEW.project_device_repository_grant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM project_device_repository_grants grant_record
      JOIN device_repository_registrations registration
        ON registration.id=grant_record.repository_registration_id
      JOIN devices device
        ON device.id=registration.device_id
       AND device.lifecycle='active'
      JOIN device_credentials credential
        ON credential.device_id=device.id
       AND credential.id=registration.approved_credential_id
       AND credential.generation=registration.approved_generation
       AND credential.generation=device.current_generation
       AND credential.state='active'
     WHERE grant_record.id=NEW.project_device_repository_grant_id
       AND grant_record.project_id=NEW.project_id
       AND grant_record.state='active'
       AND registration.state='active'
       AND registration.workspace_id=NEW.workspace_id
       AND registration.repository_id=NEW.repository_id
  ) THEN
    RAISE EXCEPTION 'device-backed binding must match its grant and registration'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$scope$;

DROP TRIGGER IF EXISTS repository_bindings_device_scope
  ON repository_bindings;
CREATE CONSTRAINT TRIGGER repository_bindings_device_scope
  AFTER INSERT OR UPDATE OF
    project_id,
    project_device_repository_grant_id,
    workspace_id,
    repository_id
  ON repository_bindings
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION norns_require_device_repository_binding_scope();

CREATE OR REPLACE FUNCTION norns_guard_repository_binding_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.binding_type IS DISTINCT FROM OLD.binding_type
     OR NEW.runner_id IS DISTINCT FROM OLD.runner_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.github_installation_id IS DISTINCT FROM OLD.github_installation_id
     OR NEW.github_owner IS DISTINCT FROM OLD.github_owner
     OR NEW.github_name IS DISTINCT FROM OLD.github_name
     OR NEW.project_device_repository_grant_id
        IS DISTINCT FROM OLD.project_device_repository_grant_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'repository binding identity and provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TABLE IF NOT EXISTS device_publication_permits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
    REFERENCES agent_runs (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    REFERENCES projects (id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  device_generation BIGINT NOT NULL,
  repository_registration_id TEXT NOT NULL
    REFERENCES device_repository_registrations (id) ON DELETE RESTRICT,
  project_device_repository_grant_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL
    REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  signing_key_id TEXT NOT NULL,
  permit_sha256 TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_publication_permits_device_credential_fk
    FOREIGN KEY (device_id, credential_id, device_generation)
    REFERENCES device_credentials (device_id, id, generation)
    ON DELETE RESTRICT,
  CONSTRAINT device_publication_permits_project_grant_fk
    FOREIGN KEY (project_id, project_device_repository_grant_id)
    REFERENCES project_device_repository_grants (project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT device_publication_permits_generation_check
    CHECK (device_generation > 0),
  CONSTRAINT device_publication_permits_text_check CHECK (
    btrim(repository_id) <> ''
    AND btrim(branch) <> ''
    AND btrim(commit_sha) <> ''
    AND btrim(signing_key_id) <> ''
    AND permit_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT device_publication_permits_expiry_check CHECK (
    expires_at > issued_at
    AND expires_at <= issued_at + interval '30 seconds'
    AND (
      consumed_at IS NULL
      OR (consumed_at >= issued_at AND consumed_at <= expires_at)
    )
  )
);

CREATE INDEX IF NOT EXISTS device_publication_permits_run_idx
  ON device_publication_permits (run_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS device_publication_permits_live_idx
  ON device_publication_permits (device_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION norns_require_device_publication_permit_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $scope$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM agent_runs run
      JOIN projects project
        ON project.id=run.project_id
       AND project.status='active'
       AND project.primary_repository_binding_id=NEW.repository_binding_id
      JOIN repository_bindings binding
        ON binding.id=run.repository_binding_id
       AND binding.id=NEW.repository_binding_id
       AND binding.project_id=project.id
       AND binding.binding_type='local_runner'
       AND binding.status='connected'
       AND binding.project_device_repository_grant_id=
           NEW.project_device_repository_grant_id
       AND binding.repository_id=NEW.repository_id
      JOIN project_device_repository_grants grant_record
        ON grant_record.id=binding.project_device_repository_grant_id
       AND grant_record.project_id=project.id
       AND grant_record.repository_registration_id=
           NEW.repository_registration_id
       AND grant_record.state='active'
      JOIN device_repository_registrations registration
        ON registration.id=grant_record.repository_registration_id
       AND registration.device_id=NEW.device_id
       AND registration.repository_id=NEW.repository_id
       AND registration.workspace_id=binding.workspace_id
       AND registration.state='active'
       AND registration.approved_credential_id=NEW.credential_id
       AND registration.approved_generation=NEW.device_generation
      JOIN devices device
        ON device.id=registration.device_id
       AND device.lifecycle='active'
       AND device.current_generation=NEW.device_generation
      JOIN users owner
        ON owner.id=device.owner_user_id
       AND owner.status='active'
      JOIN device_credentials credential
        ON credential.device_id=device.id
       AND credential.id=NEW.credential_id
       AND credential.generation=NEW.device_generation
       AND credential.state='active'
      JOIN commands command
        ON command.command_id=(
          SELECT latest.command_id
            FROM commands latest
           WHERE latest.run_id=run.id
           ORDER BY latest.created_at DESC,latest.command_id DESC
           LIMIT 1
        )
       AND command.runner_id=device.id
       AND command.runner_generation=NEW.device_generation
       AND command.envelope->>'target_branch'=NEW.branch
     WHERE run.id=NEW.run_id
       AND run.project_id=NEW.project_id
       AND run.state IN (
         'dispatched','running','waiting_for_human','verifying'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM device_run_cancellations cancellation
          WHERE cancellation.run_id=run.id
            AND cancellation.publication_fenced_at IS NOT NULL
            AND cancellation.publication_reauthorized_at IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'publication permit scope is not currently authorized'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$scope$;

CREATE CONSTRAINT TRIGGER device_publication_permits_scope
  AFTER INSERT ON device_publication_permits
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION norns_require_device_publication_permit_scope();

CREATE OR REPLACE FUNCTION norns_guard_device_publication_permit()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.device_id IS DISTINCT FROM NEW.device_id
     OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
     OR OLD.device_generation IS DISTINCT FROM NEW.device_generation
     OR OLD.repository_registration_id IS DISTINCT FROM NEW.repository_registration_id
     OR OLD.project_device_repository_grant_id
        IS DISTINCT FROM NEW.project_device_repository_grant_id
     OR OLD.repository_binding_id IS DISTINCT FROM NEW.repository_binding_id
     OR OLD.repository_id IS DISTINCT FROM NEW.repository_id
     OR OLD.branch IS DISTINCT FROM NEW.branch
     OR OLD.commit_sha IS DISTINCT FROM NEW.commit_sha
     OR OLD.signing_key_id IS DISTINCT FROM NEW.signing_key_id
     OR OLD.permit_sha256 IS DISTINCT FROM NEW.permit_sha256
     OR OLD.issued_at IS DISTINCT FROM NEW.issued_at
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'publication permit is immutable and may be consumed once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER device_publication_permits_guard
  BEFORE UPDATE ON device_publication_permits
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_publication_permit();

GRANT SELECT, INSERT, UPDATE ON
  device_publication_permits
TO norns_app;

GRANT EXECUTE ON FUNCTION
  norns_guard_device_repository_registration(),
  norns_guard_project_device_repository_grant(),
  norns_require_device_repository_binding_scope(),
  norns_require_device_publication_permit_scope(),
  norns_guard_device_publication_permit()
TO norns_app;
