-- FRONT DOOR P2 (D1): user-configurable, observable cross-provider planning
-- runs. Wraps the existing runPlanning loop (apps/server/src/planning/session.ts)
-- with a durable, pollable record: per-round transcript progress, terminal
-- result/failure, and a persisted per-project reviewer selection so the
-- provider/model pairing and default round cap survive a restart.

CREATE TABLE planning_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL,
  objective TEXT NOT NULL,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  result JSONB,
  total_cost_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  error TEXT,
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT planning_runs_status_check CHECK (
    status IN ('queued','drafting','reviewing','revising','converged','cap_reached','failed')
  ),
  CONSTRAINT planning_runs_max_rounds_check CHECK (max_rounds BETWEEN 1 AND 5),
  CONSTRAINT planning_runs_round_check CHECK (round >= 0),
  CONSTRAINT planning_runs_objective_check CHECK (length(trim(objective)) > 0),
  CONSTRAINT planning_runs_cost_check CHECK (total_cost_usd >= 0),
  -- error is set if and only if the run is failed; result is set if and only
  -- if the run reached a terminal success state.
  CONSTRAINT planning_runs_error_shape_check CHECK ((status = 'failed') = (error IS NOT NULL)),
  CONSTRAINT planning_runs_result_shape_check CHECK (
    (status IN ('converged','cap_reached')) = (result IS NOT NULL)
  )
);
CREATE INDEX planning_runs_project_created_idx ON planning_runs (project_id, created_at DESC);
CREATE INDEX planning_runs_claim_idx ON planning_runs (status, created_at) WHERE status = 'queued';

-- Project-level planning defaults: an explicit reviewer provider/model
-- override (fallback is the existing env-configured behavior when NULL) and
-- the default round cap offered to new planning runs.
CREATE TABLE planning_reviewer_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  reviewer_provider TEXT,
  reviewer_model TEXT,
  default_max_rounds INTEGER NOT NULL DEFAULT 3,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT planning_reviewer_settings_provider_check CHECK (
    reviewer_provider IS NULL OR reviewer_provider IN ('anthropic','openai')
  ),
  CONSTRAINT planning_reviewer_settings_pair_check CHECK (
    (reviewer_provider IS NULL) = (reviewer_model IS NULL)
  ),
  CONSTRAINT planning_reviewer_settings_default_max_rounds_check CHECK (
    default_max_rounds BETWEEN 1 AND 5
  )
);

REVOKE ALL PRIVILEGES ON planning_runs, planning_reviewer_settings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON planning_runs, planning_reviewer_settings FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON planning_runs, planning_reviewer_settings TO norns_app;
