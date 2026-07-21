-- EXECUTION E10: where a run's work actually went.
--
-- THE NUMBER IS DELIBERATELY UNASSIGNED. 0020 is the highest number merged when
-- E10 was written; the PM assigns the real number and renames this file (and
-- RUN_PUBLICATION_MIGRATION_NAME in persistence/v2/migrate.ts) at integration.
--
-- WHY. EXECUTION E4 made the runner push the run's branch and open its pull
-- request, and then reported both as `run_log` TEXT. A log line is not a field:
-- nothing in the read models could link a finished task to the review a human
-- is supposed to click through to, so the branch and the PR existed but were
-- unreachable from the product. These columns are that missing link.
--
-- Strictly additive and nullable. Every existing row keeps meaning exactly what
-- it meant -- NULL here reads as "this run has not reported a publication",
-- which is the truth for every run that predates E10, not a fabricated absence.
ALTER TABLE agent_runs ADD COLUMN published_branch TEXT;
ALTER TABLE agent_runs ADD COLUMN published_commit_sha TEXT;
ALTER TABLE agent_runs ADD COLUMN published_remote TEXT;
ALTER TABLE agent_runs ADD COLUMN pull_request_url TEXT;
-- Why there is NO pull request, when a run published without one. "no PR" and
-- "the PR could not be opened" are very different facts to a human waiting on a
-- review, and E4's publisher already distinguishes them; this is where that
-- distinction survives the wire.
ALTER TABLE agent_runs ADD COLUMN publication_note TEXT;
ALTER TABLE agent_runs ADD COLUMN publication_outcome TEXT;
ALTER TABLE agent_runs ADD COLUMN published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_runs_pull_request_idx
  ON agent_runs (project_id, pull_request_url)
  WHERE pull_request_url IS NOT NULL;

-- NO NEW GRANT IS REQUIRED. agent_runs already carries norns_app's table-level
-- privileges from 0001_refoundation_v2, and PostgreSQL table privileges extend
-- to columns added later (same reasoning as 0013 and 0015). The repo rule that
-- every NEW TABLE needs an explicit GRANT does not reach a column addition, and
-- issuing a redundant one here would imply otherwise.
