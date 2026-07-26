-- Usage-intelligence Phase 4B: immutable provider-plan snapshots and
-- cycle-to-date calibration observations. Analytics remain derived from the
-- canonical ai_usage_events ledger; these tables record only external quota
-- context and the evidence needed to calibrate estimates.

DO $usage_calibration_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM norns_schema_migrations
    WHERE name = '0030_ai_usage_telemetry'
  ) THEN
    RAISE EXCEPTION
      '0033_usage_calibration_analytics requires 0030_ai_usage_telemetry'
      USING ERRCODE = '55000';
  END IF;
END
$usage_calibration_dependency$;

CREATE TABLE ai_provider_usage_plans (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  plan_name TEXT NOT NULL CHECK (length(trim(plan_name)) > 0),
  allowance_unit TEXT NOT NULL
    CHECK (allowance_unit IN ('tokens','requests','credits','usd_equivalent')),
  allowance_amount NUMERIC(30,9) NOT NULL CHECK (allowance_amount > 0),
  allowance_usd_equivalent NUMERIC(24,9)
    CHECK (allowance_usd_equivalent IS NULL OR allowance_usd_equivalent > 0),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_provider_usage_plans_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ai_provider_usage_plans_provider_id_unique UNIQUE (id, provider)
);

CREATE INDEX ai_provider_usage_plans_provider_effective_idx
  ON ai_provider_usage_plans (provider, effective_from DESC, created_at DESC);

CREATE TABLE ai_usage_calibration_observations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  plan_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  subscription_tier TEXT NOT NULL CHECK (length(trim(subscription_tier)) > 0),
  cycle_period TEXT NOT NULL CHECK (cycle_period IN ('weekly','monthly')),
  reset_at TIMESTAMPTZ NOT NULL,
  cycle_start TIMESTAMPTZ NOT NULL,
  cycle_end TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  provider_reading_kind TEXT NOT NULL
    CHECK (provider_reading_kind IN ('used','remaining','utilization_percent')),
  provider_reading_unit TEXT NOT NULL
    CHECK (provider_reading_unit IN ('tokens','requests','credits','usd_equivalent','percent')),
  provider_reading_value NUMERIC(30,9) NOT NULL CHECK (provider_reading_value >= 0),
  displayed_percentage NUMERIC(7,4) NOT NULL
    CHECK (displayed_percentage > 0 AND displayed_percentage <= 100),
  tokens_used_since_reset BIGINT NOT NULL CHECK (tokens_used_since_reset >= 0),
  implied_max_tokens NUMERIC(30,9) NOT NULL CHECK (implied_max_tokens >= 0),
  provider_reading_usd_equivalent NUMERIC(24,9)
    CHECK (
      provider_reading_usd_equivalent IS NULL
      OR provider_reading_usd_equivalent >= 0
    ),
  canonical_requests INTEGER NOT NULL CHECK (canonical_requests >= 0),
  canonical_input_tokens BIGINT NOT NULL CHECK (canonical_input_tokens >= 0),
  canonical_output_tokens BIGINT NOT NULL CHECK (canonical_output_tokens >= 0),
  canonical_cache_read_tokens BIGINT NOT NULL CHECK (canonical_cache_read_tokens >= 0),
  canonical_cache_write_tokens BIGINT NOT NULL CHECK (canonical_cache_write_tokens >= 0),
  canonical_known_cost_usd NUMERIC(24,9)
    CHECK (canonical_known_cost_usd IS NULL OR canonical_known_cost_usd >= 0),
  canonical_unpriced_requests INTEGER NOT NULL DEFAULT 0
    CHECK (canonical_unpriced_requests >= 0),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL
    CHECK (source IN ('provider_api','runtime_report','manual','import')),
  evidence_note TEXT CHECK (evidence_note IS NULL OR length(trim(evidence_note)) > 0),
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_calibration_observations_plan_fk
    FOREIGN KEY (plan_id, provider)
    REFERENCES ai_provider_usage_plans(id, provider) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_calibration_observations_cycle_check
    CHECK (
      cycle_end > cycle_start
      AND reset_at = cycle_start
      AND observed_at >= cycle_start
      AND observed_at < cycle_end
    ),
  CONSTRAINT ai_usage_calibration_observations_reading_shape_check CHECK (
    (provider_reading_kind = 'utilization_percent'
      AND provider_reading_unit = 'percent'
      AND provider_reading_value <= 100)
    OR
    (provider_reading_kind IN ('used','remaining')
      AND provider_reading_unit <> 'percent')
  )
);

CREATE INDEX ai_usage_calibration_provider_cycle_idx
  ON ai_usage_calibration_observations
    (provider, model, subscription_tier, reset_at DESC, observed_at DESC);
CREATE INDEX ai_usage_calibration_plan_time_idx
  ON ai_usage_calibration_observations (plan_id, observed_at DESC);

CREATE TRIGGER ai_provider_usage_plans_append_only_guard
  BEFORE UPDATE OR DELETE ON ai_provider_usage_plans
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER ai_provider_usage_plans_append_only_truncate_guard
  BEFORE TRUNCATE ON ai_provider_usage_plans
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER ai_usage_calibration_append_only_guard
  BEFORE UPDATE OR DELETE ON ai_usage_calibration_observations
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER ai_usage_calibration_append_only_truncate_guard
  BEFORE TRUNCATE ON ai_usage_calibration_observations
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

REVOKE ALL PRIVILEGES
  ON ai_provider_usage_plans, ai_usage_calibration_observations
  FROM PUBLIC;
REVOKE ALL PRIVILEGES
  ON ai_provider_usage_plans, ai_usage_calibration_observations
  FROM norns_app;
GRANT SELECT, INSERT
  ON ai_provider_usage_plans, ai_usage_calibration_observations
  TO norns_app;
