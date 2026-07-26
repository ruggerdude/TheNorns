-- Usage-intelligence Phase 4A: configurable UTC period budgets and
-- notification-ready, deduplicated threshold crossings.

DO $usage_policy_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM norns_schema_migrations
    WHERE name = '0030_ai_usage_telemetry'
  ) THEN
    RAISE EXCEPTION
      '0032_usage_intelligence_policies requires 0030_ai_usage_telemetry'
      USING ERRCODE = '55000';
  END IF;
END
$usage_policy_dependency$;

CREATE FUNCTION norns_valid_usage_budget_thresholds(candidate SMALLINT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $validation$
DECLARE
  current_threshold SMALLINT;
  previous_threshold SMALLINT := 0;
BEGIN
  IF cardinality(candidate) = 0 THEN
    RETURN false;
  END IF;
  FOREACH current_threshold IN ARRAY candidate LOOP
    IF current_threshold < 1
       OR current_threshold > 100
       OR current_threshold <= previous_threshold
    THEN
      RETURN false;
    END IF;
    previous_threshold := current_threshold;
  END LOOP;
  RETURN true;
END
$validation$;

CREATE TABLE usage_budget_policies (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global','user','project')),
  scope_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  scope_project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  period TEXT NOT NULL CHECK (period IN ('daily','weekly','monthly')),
  provider TEXT CHECK (provider IS NULL OR length(trim(provider)) > 0),
  model TEXT CHECK (model IS NULL OR length(trim(model)) > 0),
  limit_usd NUMERIC(24,9) CHECK (limit_usd IS NULL OR limit_usd > 0),
  limit_tokens BIGINT CHECK (limit_tokens IS NULL OR limit_tokens > 0),
  threshold_percentages SMALLINT[] NOT NULL DEFAULT ARRAY[50,75,90,100]::SMALLINT[],
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_budget_policies_scope_shape_check CHECK (
    (scope_type = 'global' AND scope_user_id IS NULL AND scope_project_id IS NULL)
    OR
    (scope_type = 'user' AND scope_user_id IS NOT NULL AND scope_project_id IS NULL)
    OR
    (scope_type = 'project' AND scope_user_id IS NULL AND scope_project_id IS NOT NULL)
  ),
  CONSTRAINT usage_budget_policies_model_scope_check
    CHECK (model IS NULL OR provider IS NOT NULL),
  CONSTRAINT usage_budget_policies_limit_check
    CHECK (limit_usd IS NOT NULL OR limit_tokens IS NOT NULL),
  CONSTRAINT usage_budget_policies_thresholds_check
    CHECK (norns_valid_usage_budget_thresholds(threshold_percentages))
);

CREATE UNIQUE INDEX usage_budget_policies_one_active_scope_idx
  ON usage_budget_policies (
    scope_type,
    COALESCE(scope_user_id, ''),
    COALESCE(scope_project_id, ''),
    period,
    COALESCE(provider, ''),
    COALESCE(model, '')
  )
  WHERE status = 'active';
CREATE INDEX usage_budget_policies_user_status_idx
  ON usage_budget_policies (scope_user_id, status, period);
CREATE INDEX usage_budget_policies_project_status_idx
  ON usage_budget_policies (scope_project_id, status, period);

COMMENT ON COLUMN usage_budget_policies.limit_tokens IS
  'Total canonical input_tokens + output_tokens after signed adjustments; cache categories are not added again.';

CREATE TABLE usage_budget_threshold_notifications (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  policy_id TEXT NOT NULL
    REFERENCES usage_budget_policies(id) ON DELETE RESTRICT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  threshold_percentage SMALLINT NOT NULL
    CHECK (threshold_percentage BETWEEN 1 AND 100),
  metric TEXT NOT NULL CHECK (metric IN ('usd','tokens')),
  consumed_usd NUMERIC(24,9) NOT NULL CHECK (consumed_usd >= 0),
  consumed_tokens BIGINT NOT NULL CHECK (consumed_tokens >= 0),
  unpriced_requests INTEGER NOT NULL DEFAULT 0 CHECK (unpriced_requests >= 0),
  limit_usd NUMERIC(24,9),
  limit_tokens BIGINT,
  delivery_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (delivery_status IN ('ready','delivered','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  CONSTRAINT usage_budget_threshold_notifications_period_check
    CHECK (period_end > period_start),
  CONSTRAINT usage_budget_threshold_notifications_limit_check CHECK (
    (metric = 'usd' AND limit_usd IS NOT NULL AND limit_usd > 0)
    OR
    (metric = 'tokens' AND limit_tokens IS NOT NULL AND limit_tokens > 0)
  ),
  CONSTRAINT usage_budget_threshold_notifications_delivery_check CHECK (
    (delivery_status = 'ready' AND delivered_at IS NULL AND dismissed_at IS NULL)
    OR
    (delivery_status = 'delivered' AND delivered_at IS NOT NULL AND dismissed_at IS NULL)
    OR
    (delivery_status = 'dismissed' AND dismissed_at IS NOT NULL)
  ),
  CONSTRAINT usage_budget_threshold_notifications_dedupe
    UNIQUE (policy_id, period_start, threshold_percentage, metric)
);

CREATE INDEX usage_budget_threshold_notifications_ready_idx
  ON usage_budget_threshold_notifications (delivery_status, created_at)
  WHERE delivery_status = 'ready';
CREATE INDEX usage_budget_threshold_notifications_policy_period_idx
  ON usage_budget_threshold_notifications (policy_id, period_start, threshold_percentage);

REVOKE ALL PRIVILEGES
  ON usage_budget_policies, usage_budget_threshold_notifications
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON usage_budget_policies, usage_budget_threshold_notifications
  FROM norns_app;
GRANT SELECT, INSERT, UPDATE
  ON usage_budget_policies, usage_budget_threshold_notifications
  TO norns_app;
