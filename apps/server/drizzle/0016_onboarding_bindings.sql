-- ONBOARDING O2: binding roles, for a world where every project is
-- GitHub-backed and execution happens in a GitHub Actions job.
--
-- Nothing is installed on the operator's machine. The runner runs ephemerally
-- INSIDE an Actions job in the project's own repository and connects back to
-- the relay over the existing protocol. So a project has:
--
--   * a WORKSPACE attachment -- where execution happens: an Actions job in a
--     GitHub repository. `projects.primary_repository_binding_id` points at
--     this one, and Phase4Coordinator.schedule() gates dispatch on it.
--     Untouched by this migration.
--   * a REMOTE attachment    -- where the work is pushed: a GitHub repository.
--
-- Today both point at the SAME repository. The roles stay distinct in the
-- model anyway, because they are genuinely different questions and are
-- expected to diverge (fork-and-PR: execute in a fork, push to upstream).
--
-- Modelling decision: the role is a `role` column on BOTH tiers of the binding
-- model -- `repository_bindings` (verified) and `repository_binding_candidates`
-- (the unverified tier from FRONT DOOR D2) -- rather than a second FK column
-- on `projects`. One concept, expressed identically in both tiers, so a
-- candidate's role survives promotion; and the column the dispatch gate reads
-- is left completely alone.
--
-- Additive and forward-only: every existing row defaults to 'workspace',
-- which is exactly what it already meant.
--
-- MIGRATION NUMBER IS DELIBERATELY UNASSIGNED (`NNNN_`). The integrating PM
-- assigns the number; parallel agents collided on numbers in the previous
-- program.

-- ---------------------------------------------------------------------------
-- 1. The role itself
-- ---------------------------------------------------------------------------

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_role_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_role_check
  CHECK (role IN ('workspace', 'remote'));

-- A remote is a push target, so it is always a GitHub repository. Workspaces
-- are unconstrained: pre-existing rows include local_runner workspaces from
-- before this decision, and they must keep working.
ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_remote_shape_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_remote_shape_check
  CHECK (role <> 'remote' OR binding_type = 'github');

-- At most one live remote per project. Workspaces are intentionally NOT
-- constrained this way: the schema has always permitted several bindings per
-- project and existing rows rely on that.
CREATE UNIQUE INDEX IF NOT EXISTS repository_bindings_project_remote_unique
  ON repository_bindings (project_id)
  WHERE role = 'remote' AND status <> 'revoked';

CREATE INDEX IF NOT EXISTS repository_bindings_project_role_idx
  ON repository_bindings (project_id, role);

ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_role_check;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_role_check
  CHECK (role IN ('workspace', 'remote'));

ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_remote_shape_check;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_remote_shape_check
  CHECK (role <> 'remote' OR source_type = 'github');

CREATE UNIQUE INDEX IF NOT EXISTS repository_binding_candidates_project_remote_unique
  ON repository_binding_candidates (project_id)
  WHERE role = 'remote' AND status <> 'dismissed';

CREATE INDEX IF NOT EXISTS repository_binding_candidates_project_role_idx
  ON repository_binding_candidates (project_id, role);

-- ---------------------------------------------------------------------------
-- 2. Re-key the identity uniqueness indexes by role
-- ---------------------------------------------------------------------------
-- Both attachments now name the SAME repository, so four pre-existing unique
-- indexes -- each of which assumed one attachment per repository per project --
-- would reject the second one. Each is recreated with `role` added to the key.
--
-- This strictly WEAKENS each constraint (a wider key can only permit more), so
-- no existing row can be in violation and the change is safe to replay. The
-- semantic each index now enforces is "one attachment per role per repository
-- per project", which is what was actually meant all along.

DROP INDEX IF EXISTS repository_bindings_github_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS repository_bindings_github_identity_unique
  ON repository_bindings (project_id, role, github_installation_id, repository_id)
  WHERE binding_type = 'github';

DROP INDEX IF EXISTS repository_bindings_local_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS repository_bindings_local_identity_unique
  ON repository_bindings (project_id, role, runner_id, workspace_id, repository_id)
  WHERE binding_type = 'local_runner';

DROP INDEX IF EXISTS repository_binding_candidates_project_source_unique;
CREATE UNIQUE INDEX IF NOT EXISTS repository_binding_candidates_project_source_unique
  ON repository_binding_candidates (project_id, role, source_type, source_fingerprint);

DROP INDEX IF EXISTS repository_binding_candidates_connection_repository_unique;
CREATE UNIQUE INDEX IF NOT EXISTS repository_binding_candidates_connection_repository_unique
  ON repository_binding_candidates (project_id, role, service_connection_id, external_repository_id)
  WHERE service_connection_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. What a GitHub Actions execution target needs
-- ---------------------------------------------------------------------------

-- Whether the GitHub App installation actually contains this repository.
--
-- FIRST-CLASS BLOCKING STATE, not a warning. A "selected repositories"
-- installation does NOT automatically include a newly created repository, so
-- Norns cannot commit the workflow file, cannot dispatch a run, and cannot
-- read run status until the operator grants access. Every read model that
-- describes a project's attachments surfaces this, and the project's
-- next-recommended-action names it.
--
-- NULL = not yet determined.
ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS installation_ready BOOLEAN;
ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS installation_ready BOOLEAN;

-- Whether the Norns workflow file has been committed to the repository. Until
-- it is, there is no Actions job to run the ephemeral runner in, so there is
-- nowhere to execute. Committing it is a control-plane action Norns performs
-- with its own App token; that belongs to the Actions phase, so this column
-- starts false and is surfaced, never assumed.
ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS workflow_installed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS workflow_installed BOOLEAN NOT NULL DEFAULT false;

-- The repository's default branch. `repository_bindings.default_branch` is
-- already NOT NULL; the candidate tier gained a nullable `default_branch` in
-- 0008 and it is now populated at creation for every GitHub attachment,
-- because an Actions workflow has to be committed to a named branch.

-- How this project's pushes are authenticated.
--
-- Exactly one answer, and it needs no broker: inside a GitHub Actions job the
-- `GITHUB_TOKEN` secret is provided automatically and is already scoped to
-- the repository the job is running in. Norns mints nothing, stores nothing,
-- and hands the runner no push credential.
--
-- (Norns's own GitHub App token is still required, but for CONTROL-PLANE calls
-- only -- create a repository, list repositories, commit the workflow file,
-- dispatch a run, read run status. It is never a push credential.)
ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS push_credential_strategy TEXT;
ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_push_strategy_check;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_push_strategy_check
  CHECK (push_credential_strategy IS NULL OR push_credential_strategy = 'actions_github_token');

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS push_credential_strategy TEXT;
ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_push_strategy_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_push_strategy_check
  CHECK (push_credential_strategy IS NULL OR push_credential_strategy = 'actions_github_token');

-- How the repository came to exist: selected by the operator from the
-- installation, or created by Norns for this project. Recorded so an
-- idempotent retry can prove creation already happened and must not be
-- attempted again (GitHub repository creation is not idempotent).
ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS remote_provisioning TEXT;
ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_remote_provisioning_check;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_remote_provisioning_check
  CHECK (remote_provisioning IS NULL OR remote_provisioning IN ('selected_existing', 'created'));

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS remote_provisioning TEXT;
ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_remote_provisioning_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_remote_provisioning_check
  CHECK (remote_provisioning IS NULL OR remote_provisioning IN ('selected_existing', 'created'));

-- ---------------------------------------------------------------------------
-- 4. Onboarding provenance and idempotency
-- ---------------------------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS onboarding_scenario TEXT;
ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_onboarding_scenario_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_onboarding_scenario_check
  CHECK (onboarding_scenario IS NULL OR onboarding_scenario IN ('new_repo', 'existing_repo'));

-- Actor-scoped idempotency for the onboarding creation commands. The project
-- id is itself derived from (actor, idempotency_key); this table makes the
-- replay observable BEFORE any side effect runs, which is what guarantees a
-- double submit never creates a second GitHub repository.
CREATE TABLE IF NOT EXISTS project_onboarding_submissions (
  idempotency_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    CONSTRAINT project_onboarding_submissions_project_id_fk
    REFERENCES projects (id) ON DELETE CASCADE,
  scenario TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_onboarding_submissions_scenario_check
    CHECK (scenario IN ('new_repo', 'existing_repo'))
);
CREATE INDEX IF NOT EXISTS project_onboarding_submissions_project_idx
  ON project_onboarding_submissions (project_id);

DO $onboarding$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'norns_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON project_onboarding_submissions TO norns_app';
  END IF;
END;
$onboarding$;
