-- QUICK CHANGES: a durable, reviewer-free path through the Phase tab.
--
-- `mode` distinguishes the existing reviewed planning journey from a quick
-- change. Optional PM/agent selections are pinned to the run so retries,
-- refreshes, and background worker claims use the identities the human chose.
-- Null selections mean "use the project/default resolution".
--
-- A quick change is also an approval + execution request, not a plan waiting
-- for a browser-side follow-up. `requested_by` keeps the authenticated human
-- who initiated it as the actor of record. The kickoff fields form a tiny
-- durable outbox: the planning worker atomically writes the approved result
-- and `pending`, then exclusively claims that outbox item before calling the
-- idempotent materialize/approve/launch saga. A process death can therefore
-- cause a safe retry, but never a second phase/task lineage for the run.

ALTER TABLE planning_runs
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE planning_runs
  ADD COLUMN requested_by TEXT REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE planning_runs
  ADD COLUMN pm_provider TEXT;
ALTER TABLE planning_runs
  ADD COLUMN pm_model TEXT;
ALTER TABLE planning_runs
  ADD COLUMN agent_provider TEXT;
ALTER TABLE planning_runs
  ADD COLUMN agent_model TEXT;
ALTER TABLE planning_runs
  ADD COLUMN quick_kickoff_status TEXT;
ALTER TABLE planning_runs
  ADD COLUMN quick_kickoff_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE planning_runs
  ADD COLUMN quick_kickoff_result JSONB;

ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_mode_check CHECK (mode IN ('planned', 'quick'));
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_quick_actor_check CHECK (
    mode <> 'quick' OR requested_by IS NOT NULL
  );
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
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_quick_kickoff_status_check CHECK (
    quick_kickoff_status IS NULL
    OR (
      mode = 'quick'
      AND quick_kickoff_status IN ('pending', 'in_progress', 'completed')
    )
  );
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_quick_kickoff_result_check CHECK (
    quick_kickoff_result IS NULL OR mode = 'quick'
  );
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_quick_kickoff_attempts_check CHECK (
    quick_kickoff_attempts >= 0
  );

CREATE INDEX planning_runs_quick_kickoff_claim_idx
  ON planning_runs (quick_kickoff_status, updated_at)
  WHERE mode = 'quick' AND status = 'approved' AND quick_kickoff_status = 'pending';
