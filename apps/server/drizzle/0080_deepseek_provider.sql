-- Add DeepSeek anywhere the durable planning/execution model stores a provider.
-- Existing values and wire-compatible `both` worker selection remain valid.

ALTER TABLE project_planning_preferences
  DROP CONSTRAINT project_planning_preferences_pm_provider_check;
ALTER TABLE project_planning_preferences
  ADD CONSTRAINT project_planning_preferences_pm_provider_check
  CHECK (pm_provider IN ('anthropic', 'openai', 'deepseek'));
ALTER TABLE project_planning_preferences
  DROP CONSTRAINT project_planning_preferences_reviewer_provider_check;
ALTER TABLE project_planning_preferences
  ADD CONSTRAINT project_planning_preferences_reviewer_provider_check
  CHECK (
    reviewer_provider IN ('anthropic', 'openai', 'deepseek')
    AND reviewer_provider <> pm_provider
  );

ALTER TABLE planning_reviewer_settings
  DROP CONSTRAINT planning_reviewer_settings_provider_check;
ALTER TABLE planning_reviewer_settings
  ADD CONSTRAINT planning_reviewer_settings_provider_check
  CHECK (reviewer_provider IS NULL OR reviewer_provider IN ('anthropic', 'openai', 'deepseek'));

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_worker_providers_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_worker_providers_check
  CHECK (worker_providers IN ('anthropic', 'openai', 'deepseek', 'both'));
ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_pm_selection_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_pm_selection_check CHECK (
    (pm_provider IS NULL AND pm_model IS NULL)
    OR (
      pm_provider IS NOT NULL
      AND pm_provider IN ('anthropic', 'openai', 'deepseek')
      AND pm_model IS NOT NULL
      AND length(trim(pm_model)) > 0
    )
  );
ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_agent_selection_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_agent_selection_check CHECK (
    (agent_provider IS NULL AND agent_model IS NULL)
    OR (
      agent_provider IS NOT NULL
      AND agent_provider IN ('anthropic', 'openai', 'deepseek')
      AND agent_model IS NOT NULL
      AND length(trim(agent_model)) > 0
    )
  );
ALTER TABLE planning_runs
  ADD COLUMN agent_credential_mode TEXT NOT NULL DEFAULT 'api';
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_agent_credential_mode_check
  CHECK (agent_credential_mode IN ('api', 'subscription'));

ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_pm_provider_check;
ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_reviewer_provider_check;
ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_provider_policy_check;
ALTER TABLE conversation_plan_reviews
  ADD CONSTRAINT conversation_plan_reviews_provider_policy_check CHECK (
    pm_provider IN ('anthropic', 'openai', 'deepseek')
    AND reviewer_provider IN ('anthropic', 'openai', 'deepseek')
    AND pm_provider <> reviewer_provider
    AND length(trim(pm_model)) > 0
    AND length(trim(reviewer_model)) > 0
  );

ALTER TABLE conversation_plan_proposal_attempts
  DROP CONSTRAINT conversation_plan_proposal_attempts_provider_check;
ALTER TABLE conversation_plan_proposal_attempts
  ADD CONSTRAINT conversation_plan_proposal_attempts_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'deepseek'));
