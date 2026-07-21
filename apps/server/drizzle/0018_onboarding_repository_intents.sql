-- ONBOARDING O6: repository-creation intents.
--
-- MIGRATION NUMBER IS DELIBERATELY UNASSIGNED (`NNNN_`). 0016 and 0017 are
-- taken; the PM assigns this one and updates the two constants in
-- apps/server/src/persistence/v2/migrate.ts at the same time.
--
-- WHY THIS TABLE EXISTS
-- --------------------
-- The `new_repo` onboarding scenario must satisfy two rules that pull against
-- each other:
--
--   * a genuine retry of the SAME submission must not create a second GitHub
--     repository (repository creation is not idempotent — GitHub answers 422),
--     and
--   * a first-time submission must NEVER quietly take over a repository that
--     already existed.
--
-- The original look-before-create satisfied only the first. It matched any
-- repository in the installation with the requested name, with nothing to say
-- whether Norns had put it there — so a user typing "website" into the *create
-- a new repository* form could have their existing production `website` repo
-- silently adopted, recorded as `remote_provisioning = 'created'`, and later
-- committed into. Data safety, not cosmetics.
--
-- Recording the intent BEFORE calling GitHub is what makes the two cases
-- distinguishable after the fact. If a row here already names this exact
-- (actor, idempotency key, connection, repository name), then Norns genuinely
-- reached the creation step for this submission before and a same-named
-- repository is its own earlier attempt — safe to adopt. With no such row, a
-- name collision is someone else's repository and is surfaced as a conflict
-- for the human to resolve.
--
-- Deliberately NOT foreign-keyed to `projects`: the intent is recorded before
-- the project row exists, which is the entire point.

CREATE TABLE IF NOT EXISTS project_onboarding_repository_intents (
  idempotency_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  connection_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_onboarding_repository_intents_connection_idx
  ON project_onboarding_repository_intents (connection_id, repository_name);

DO $intents$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'norns_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON project_onboarding_repository_intents TO norns_app';
  END IF;
END;
$intents$;
