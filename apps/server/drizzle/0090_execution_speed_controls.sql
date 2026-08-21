-- Execution speed controls: automatic safe fan-out is the project default,
-- while humans can still pin a project to an explicit 1..6 agent ceiling.

ALTER TABLE projects
  ADD COLUMN development_concurrency_mode TEXT NOT NULL DEFAULT 'automatic';

ALTER TABLE projects
  ADD CONSTRAINT projects_development_concurrency_mode_check
  CHECK (development_concurrency_mode IN ('automatic','manual'));

-- A pre-existing value above one was an explicit operator choice. Preserve it
-- as manual; lift only the shipped one-agent default into automatic mode.
UPDATE projects
   SET development_concurrency_mode = CASE
         WHEN max_concurrent_tasks = 1 THEN 'automatic'
         ELSE 'manual'
       END;

UPDATE projects
   SET max_concurrent_tasks = 6
 WHERE development_concurrency_mode = 'automatic';

ALTER TABLE projects
  ALTER COLUMN max_concurrent_tasks SET DEFAULT 6;

ALTER TABLE projects
  DROP CONSTRAINT projects_max_concurrent_tasks_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_max_concurrent_tasks_check
  CHECK (max_concurrent_tasks BETWEEN 1 AND 6);

-- Agent profiles are reusable execution configurations, not singleton
-- workers. Let one profile back several isolated task sessions; the project,
-- dependency, repository-scope, and budget gates still decide actual fan-out.
ALTER TABLE agent_profiles
  ALTER COLUMN max_concurrent_runs SET DEFAULT 6;

UPDATE agent_profiles
   SET max_concurrent_runs = 6
 WHERE max_concurrent_runs = 1;
