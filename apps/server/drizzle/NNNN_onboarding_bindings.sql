-- ONBOARDING O2: binding roles.
--
-- A project may now hold TWO repository attachments at once:
--
--   * the WORKSPACE  -- where execution happens (a local folder owned by a
--                       runner, or -- for a GitHub-only project -- the GitHub
--                       repository itself). This is the binding that
--                       `projects.primary_repository_binding_id` points at and
--                       that Phase4Coordinator.schedule() gates dispatch on.
--                       Nothing about that resolution path changes here.
--   * the REMOTE     -- the push / PR target. Always a GitHub repository.
--
-- Modelling decision: the role lives as a `role` column on BOTH tiers of the
-- binding model (`repository_bindings` for verified attachments,
-- `repository_binding_candidates` for the unverified, runner-offline tier
-- introduced by FRONT DOOR D2) rather than as a second FK column on
-- `projects`. One concept, expressed identically in both tiers, so a
-- candidate's role survives promotion to a real binding; and
-- `projects.primary_repository_binding_id` -- the column the dispatch gate
-- reads -- is left completely untouched.
--
-- Additive and forward-only: every existing row defaults to 'workspace',
-- which is exactly what it already meant.
--
-- MIGRATION NUMBER IS DELIBERATELY UNASSIGNED (`NNNN_`). The integrating PM
-- assigns the number; parallel agents collided on numbers in the previous
-- program.

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_role_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_role_check
  CHECK (role IN ('workspace', 'remote'));

-- A remote is a push target, so it is always a GitHub repository. A workspace
-- may be either a local runner folder or (GitHub-only projects) a GitHub
-- repository, so no constraint is placed on that side.
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

-- Which push-credential seam a project's remote intends to use. See
-- apps/server/src/projects/pushCredentialProvider.ts:
--   'norns_github_app_token' -- PRIMARY. The ADR-006 JIT single-repo
--       installation-token broker. Declared here and selected by default;
--       the issuing implementation is deliberately absent until phase O4.
--   'local_git_remote'       -- FALLBACK. The local folder's own git remote
--       plus whatever credentials the operator's machine already holds. No
--       server-held secret; used when the remote has no usable Norns GitHub
--       connection.
ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS push_credential_strategy TEXT;
ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_push_strategy_check;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_push_strategy_check
  CHECK (
    push_credential_strategy IS NULL
    OR push_credential_strategy IN ('local_git_remote', 'norns_github_app_token')
  );

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS push_credential_strategy TEXT;
ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_push_strategy_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_push_strategy_check
  CHECK (
    push_credential_strategy IS NULL
    OR push_credential_strategy IN ('local_git_remote', 'norns_github_app_token')
  );

-- How the remote repository came to exist: chosen from the installation's
-- existing repositories (GitHubIntegrationService.resolveRepository) or newly
-- created for this project (GitHubIntegrationService.createRepository).
-- Recorded so an idempotent retry can prove creation already happened and
-- must not be attempted a second time, and so O4 knows whether a freshly
-- created repository still needs to be added to a 'selected repositories'
-- installation before a brokered token can push to it.
ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS remote_provisioning TEXT;
ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_remote_provisioning_check;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_remote_provisioning_check
  CHECK (
    remote_provisioning IS NULL
    OR remote_provisioning IN ('selected_existing', 'created')
  );

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS remote_provisioning TEXT;
ALTER TABLE repository_bindings
  DROP CONSTRAINT IF EXISTS repository_bindings_remote_provisioning_check;
ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_remote_provisioning_check
  CHECK (
    remote_provisioning IS NULL
    OR remote_provisioning IN ('selected_existing', 'created')
  );

-- Which of the four onboarding scenarios produced this project. Recorded so
-- the resume read model can explain the project's shape honestly instead of
-- inferring it from which rows happen to exist.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS onboarding_scenario TEXT;
ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_onboarding_scenario_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_onboarding_scenario_check
  CHECK (
    onboarding_scenario IS NULL
    OR onboarding_scenario IN (
      'new_local', 'new_local_github', 'existing_github', 'existing_local'
    )
  );

-- Actor-scoped idempotency for the onboarding creation commands. The project
-- id itself is derived from (actor, idempotency_key), so this table exists to
-- make a double submit observable and to keep the mapping auditable; the
-- primary key is what makes the replay atomic.
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
    CHECK (scenario IN ('new_local', 'new_local_github', 'existing_github', 'existing_local'))
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
