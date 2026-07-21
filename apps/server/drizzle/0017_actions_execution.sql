-- ONBOARDING O4 — GitHub Actions execution path.
--
-- Two tables:
--   github_actions_execution_bindings — per repository-binding configuration
--     for hosting ephemeral runners in that repository's Actions.
--   github_actions_runs — one row per workflow_dispatch Norns issued. This is
--     also the enrollment ledger: it is what makes the repository secret
--     single-use per dispatched job rather than a standing relay credential.

CREATE TABLE IF NOT EXISTS github_actions_execution_bindings (
  repository_binding_id TEXT PRIMARY KEY
    CONSTRAINT github_actions_bindings_binding_fk
    REFERENCES repository_bindings (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL
    CONSTRAINT github_actions_bindings_project_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  -- Numeric GitHub repository id: the unit installation-token `repository_ids`
  -- scoping uses, so it must be stored, not re-derived from owner/name.
  repository_github_id BIGINT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  workflow_path TEXT NOT NULL DEFAULT '.github/workflows/norns-agent.yml',
  -- NULL until the workflow file has been committed at least once.
  workflow_version INTEGER,
  workflow_installed_at TIMESTAMPTZ,
  workflow_blocked_reason TEXT,
  -- The project-scoped identity ephemeral runners enroll as. Deliberately NOT
  -- shared with any laptop runner: see the blast-radius analysis in
  -- apps/server/src/coordinator/actionsExecution.ts.
  runner_id TEXT NOT NULL,
  -- SHA-256 of the current enrollment token. The token itself is never stored.
  enrollment_secret_hash TEXT,
  enrollment_secret_rotated_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT github_actions_bindings_repository_id_check
    CHECK (repository_github_id > 0)
);

CREATE INDEX IF NOT EXISTS github_actions_bindings_project_idx
  ON github_actions_execution_bindings (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS github_actions_bindings_runner_idx
  ON github_actions_execution_bindings (runner_id);

CREATE TABLE IF NOT EXISTS github_actions_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    CONSTRAINT github_actions_runs_project_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  repository_binding_id TEXT NOT NULL
    CONSTRAINT github_actions_runs_binding_fk
    REFERENCES repository_bindings (id) ON DELETE RESTRICT,
  -- One Actions run per Norns dispatch job, enforced by the database rather
  -- than by the coordinator remembering to check.
  dispatch_job_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  runner_generation INTEGER,
  status TEXT NOT NULL DEFAULT 'requested',
  github_run_id BIGINT,
  github_run_url TEXT,
  conclusion TEXT,
  -- Single-use enrollment: non-NULL once a job has redeemed the enrollment
  -- secret against this row. A replay is rejected on this column alone.
  enrolled_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT github_actions_runs_status_check
    CHECK (status IN ('requested', 'dispatched', 'enrolled', 'completed', 'failed', 'abandoned'))
);

CREATE INDEX IF NOT EXISTS github_actions_runs_binding_idx
  ON github_actions_runs (repository_binding_id, status);
CREATE INDEX IF NOT EXISTS github_actions_runs_runner_idx
  ON github_actions_runs (runner_id, status);

-- ---------------------------------------------------------------------------
-- Runtime role privileges.
--
-- Production runs under the restricted `norns_app` role — that is why
-- applyMigrations needs privileged credentials, since the app role
-- deliberately cannot alter schema. A new table therefore reaches the runtime
-- with NO privileges unless they are granted here. Omitting this is invisible
-- in tests (pglite has no meaningful role separation) and then fails in
-- production with `permission denied for table` on the first Actions query.
--
-- Least privilege: SELECT, INSERT, UPDATE only. Nothing in the Actions
-- execution path deletes a row — the binding is removed by the ON DELETE
-- CASCADE from repository_bindings, which runs with the referencing table's
-- owner privileges rather than the caller's, and the run ledger is append-only
-- history that must survive for audit.
--
-- Guarded so the migration still applies on a database without the role
-- (developer machines, pglite), matching the idiom in 0016.
DO $actions_execution$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'norns_app') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON github_actions_execution_bindings, github_actions_runs FROM PUBLIC';
    EXECUTE 'REVOKE ALL PRIVILEGES ON github_actions_execution_bindings, github_actions_runs FROM norns_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON github_actions_execution_bindings TO norns_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON github_actions_runs TO norns_app';
  END IF;
END;
$actions_execution$;
