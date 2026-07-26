-- AI usage-intelligence Phase 2: project ownership, explicit membership, and
-- authenticated initiator attribution.
--
-- This migration is additive. Existing project creation remains valid because
-- owner_user_id is nullable. A null owner is the explicit compatibility marker
-- for a legacy/unintegrated project with no identity available at migration
-- time. Those projects are closed to standard users; an administrator must
-- establish ownership before collaboration can begin.

DO $project_access_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM norns_schema_migrations
    WHERE name = '0027_knowledge_packages'
  ) THEN
    RAISE EXCEPTION
      '0031_project_access_attribution requires 0027_knowledge_packages'
      USING ERRCODE = '55000';
  END IF;
END
$project_access_dependency$;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS projects_owner_status_idx
  ON projects (owner_user_id, status);

CREATE TABLE project_members (
  project_id TEXT NOT NULL
    REFERENCES projects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  added_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_status_check
    CHECK (status IN ('active', 'removed')),
  CONSTRAINT project_members_removal_shape_check
    CHECK (
      (status = 'active' AND removed_at IS NULL AND removed_by_user_id IS NULL)
      OR
      (status = 'removed' AND removed_at IS NOT NULL)
    )
);

CREATE INDEX project_members_user_status_idx
  ON project_members (user_id, status, project_id);
CREATE INDEX project_members_project_status_idx
  ON project_members (project_id, status, user_id);

-- Give every historical project one deterministic owner. Prefer the earliest
-- active administrator; when no administrator exists, fall back to the
-- earliest active identity. Deliberately grant only that owner membership:
-- cross-joining every project to every user would turn a migration into an
-- authorization expansion.
WITH default_owner AS (
  SELECT id
  FROM users
  WHERE status = 'active'
  ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at, id
  LIMIT 1
)
UPDATE projects
SET owner_user_id = default_owner.id
FROM default_owner
WHERE projects.owner_user_id IS NULL;

INSERT INTO project_members (
  project_id,
  user_id,
  status,
  added_by_user_id,
  added_at
)
SELECT
  project.id,
  project.owner_user_id,
  'active',
  project.owner_user_id,
  now()
FROM projects project
WHERE project.owner_user_id IS NOT NULL
ON CONFLICT (project_id, user_id) DO NOTHING;

-- The planning run is the attribution root. Descendants inherit this value
-- through InitiatorAttributionService; historical rows stay null rather than
-- receiving an invented owner.
ALTER TABLE planning_runs
  ADD COLUMN IF NOT EXISTS initiated_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE phases
  ADD COLUMN IF NOT EXISTS initiated_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS initiated_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS initiated_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT;

-- Quick-change planning runs already carry a proven authenticated requester.
-- This is the only safe historical backfill available in the current schema.
UPDATE planning_runs
SET initiated_by_user_id = requested_by
WHERE initiated_by_user_id IS NULL
  AND requested_by IS NOT NULL;

UPDATE phases phase
SET initiated_by_user_id = planning.initiated_by_user_id
FROM planning_runs planning
WHERE phase.planning_run_id = planning.id
  AND phase.initiated_by_user_id IS NULL
  AND planning.initiated_by_user_id IS NOT NULL;

UPDATE tasks task
SET initiated_by_user_id = phase.initiated_by_user_id
FROM phases phase
WHERE task.phase_id = phase.id
  AND task.project_id = phase.project_id
  AND task.initiated_by_user_id IS NULL
  AND phase.initiated_by_user_id IS NOT NULL;

UPDATE agent_runs run
SET initiated_by_user_id = task.initiated_by_user_id
FROM tasks task
WHERE run.task_id = task.id
  AND run.phase_id = task.phase_id
  AND run.project_id = task.project_id
  AND run.initiated_by_user_id IS NULL
  AND task.initiated_by_user_id IS NOT NULL;

-- New lineage rows inherit attribution at write time. This closes the gap
-- between a planning request and later asynchronous phase/task/run creation;
-- mismatched explicit attribution is rejected rather than silently replaced.
CREATE OR REPLACE FUNCTION norns_bind_planning_run_initiator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $planning_run_initiator$
BEGIN
  IF NEW.initiated_by_user_id IS NULL THEN
    NEW.initiated_by_user_id := NEW.requested_by;
  ELSIF NEW.requested_by IS NOT NULL
    AND NEW.initiated_by_user_id <> NEW.requested_by THEN
    RAISE EXCEPTION 'planning run initiator conflicts with requester'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$planning_run_initiator$;

CREATE TRIGGER planning_runs_bind_initiator
  BEFORE INSERT OR UPDATE OF requested_by, initiated_by_user_id
  ON planning_runs
  FOR EACH ROW EXECUTE FUNCTION norns_bind_planning_run_initiator();

CREATE OR REPLACE FUNCTION norns_bind_phase_initiator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $phase_initiator$
DECLARE
  parent_initiator TEXT;
BEGIN
  IF NEW.planning_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT initiated_by_user_id
    INTO parent_initiator
    FROM planning_runs
   WHERE id = NEW.planning_run_id;
  IF NEW.initiated_by_user_id IS NULL THEN
    NEW.initiated_by_user_id := parent_initiator;
  ELSIF parent_initiator IS NOT NULL
    AND NEW.initiated_by_user_id <> parent_initiator THEN
    RAISE EXCEPTION 'phase initiator conflicts with planning run'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$phase_initiator$;

CREATE TRIGGER phases_bind_initiator
  BEFORE INSERT OR UPDATE OF planning_run_id, initiated_by_user_id
  ON phases
  FOR EACH ROW EXECUTE FUNCTION norns_bind_phase_initiator();

CREATE OR REPLACE FUNCTION norns_bind_task_initiator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $task_initiator$
DECLARE
  parent_initiator TEXT;
BEGIN
  SELECT initiated_by_user_id
    INTO parent_initiator
    FROM phases
   WHERE id = NEW.phase_id
     AND project_id = NEW.project_id;
  IF NEW.initiated_by_user_id IS NULL THEN
    NEW.initiated_by_user_id := parent_initiator;
  ELSIF parent_initiator IS NOT NULL
    AND NEW.initiated_by_user_id <> parent_initiator THEN
    RAISE EXCEPTION 'task initiator conflicts with phase'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$task_initiator$;

CREATE TRIGGER tasks_bind_initiator
  BEFORE INSERT OR UPDATE OF phase_id, project_id, initiated_by_user_id
  ON tasks
  FOR EACH ROW EXECUTE FUNCTION norns_bind_task_initiator();

CREATE OR REPLACE FUNCTION norns_bind_agent_run_initiator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $agent_run_initiator$
DECLARE
  parent_initiator TEXT;
BEGIN
  SELECT initiated_by_user_id
    INTO parent_initiator
    FROM tasks
   WHERE id = NEW.task_id
     AND phase_id = NEW.phase_id
     AND project_id = NEW.project_id;
  IF NEW.initiated_by_user_id IS NULL THEN
    NEW.initiated_by_user_id := parent_initiator;
  ELSIF parent_initiator IS NOT NULL
    AND NEW.initiated_by_user_id <> parent_initiator THEN
    RAISE EXCEPTION 'agent run initiator conflicts with task'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$agent_run_initiator$;

CREATE TRIGGER agent_runs_bind_initiator
  BEFORE INSERT OR UPDATE OF task_id, phase_id, project_id, initiated_by_user_id
  ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION norns_bind_agent_run_initiator();

CREATE INDEX planning_runs_initiator_created_idx
  ON planning_runs (initiated_by_user_id, created_at DESC)
  WHERE initiated_by_user_id IS NOT NULL;
CREATE INDEX phases_initiator_created_idx
  ON phases (initiated_by_user_id, created_at DESC)
  WHERE initiated_by_user_id IS NOT NULL;
CREATE INDEX tasks_initiator_created_idx
  ON tasks (initiated_by_user_id, created_at DESC)
  WHERE initiated_by_user_id IS NOT NULL;
CREATE INDEX agent_runs_initiator_created_idx
  ON agent_runs (initiated_by_user_id, created_at DESC)
  WHERE initiated_by_user_id IS NOT NULL;

REVOKE ALL PRIVILEGES ON project_members FROM PUBLIC;
REVOKE ALL PRIVILEGES ON project_members FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON project_members TO norns_app;
