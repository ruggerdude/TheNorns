-- Durable Codex effort selections for planning participants and execution
-- profiles. Nullable preserves every existing project/run/profile and means
-- "use the runtime default".

ALTER TABLE planning_runs
  ADD COLUMN pm_reasoning_effort TEXT;
ALTER TABLE planning_runs
  ADD COLUMN agent_reasoning_effort TEXT;

ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_pm_reasoning_effort_check
  CHECK (
    pm_reasoning_effort IS NULL
    OR (
      pm_provider = 'openai'
      AND pm_reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')
    )
  );

ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_agent_reasoning_effort_check
  CHECK (
    agent_reasoning_effort IS NULL
    OR (
      agent_provider = 'openai'
      AND agent_reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')
    )
  );

ALTER TABLE agent_profiles
  ADD COLUMN reasoning_effort TEXT;

ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_reasoning_effort_check
  CHECK (
    reasoning_effort IS NULL
    OR (
      provider = 'openai'
      AND reasoning_effort IN ('minimal', 'low', 'medium', 'high', 'xhigh')
    )
  );
