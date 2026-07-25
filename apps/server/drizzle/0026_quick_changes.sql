-- QUICK CHANGES: a durable, reviewer-free path through the Phase tab.
--
-- `mode` distinguishes the existing reviewed planning journey from a quick
-- change. Optional PM/agent selections are pinned to the run so retries,
-- refreshes, and background worker claims use the identities the human chose.
-- Null selections mean "use the project/default resolution".

ALTER TABLE planning_runs
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE planning_runs
  ADD COLUMN pm_provider TEXT;
ALTER TABLE planning_runs
  ADD COLUMN pm_model TEXT;
ALTER TABLE planning_runs
  ADD COLUMN agent_provider TEXT;
ALTER TABLE planning_runs
  ADD COLUMN agent_model TEXT;

ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_mode_check CHECK (mode IN ('planned', 'quick'));
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_pm_selection_check CHECK (
    (pm_provider IS NULL AND pm_model IS NULL)
    OR (
      pm_provider IS NOT NULL
      AND pm_model IS NOT NULL
      AND pm_provider IN ('anthropic', 'openai')
      AND length(trim(pm_model)) > 0
    )
  );
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_agent_selection_check CHECK (
    (agent_provider IS NULL AND agent_model IS NULL)
    OR (
      agent_provider IS NOT NULL
      AND agent_model IS NOT NULL
      AND agent_provider IN ('anthropic', 'openai')
      AND length(trim(agent_model)) > 0
    )
  );
