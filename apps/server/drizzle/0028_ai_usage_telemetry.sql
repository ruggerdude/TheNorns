-- Canonical, provider-agnostic AI request telemetry.
--
-- This is additive to the legacy usage_events and debate_usage_events tables.
-- Invocation paths can move independently while new analytics read one
-- lifecycle ledger. Pricing profiles and lifecycle events are immutable;
-- corrections are explicit signed adjustment events.

CREATE TABLE ai_pricing_profiles (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  pricing_version TEXT NOT NULL CHECK (length(trim(pricing_version)) > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  input_per_million NUMERIC(24,9) NOT NULL CHECK (input_per_million >= 0),
  output_per_million NUMERIC(24,9) NOT NULL CHECK (output_per_million >= 0),
  cache_read_per_million NUMERIC(24,9)
    CHECK (cache_read_per_million IS NULL OR cache_read_per_million >= 0),
  cache_write_per_million NUMERIC(24,9)
    CHECK (cache_write_per_million IS NULL OR cache_write_per_million >= 0),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_pricing_profiles_effective_range_check
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ai_pricing_profiles_version_unique
    UNIQUE (provider, model, pricing_version),
  CONSTRAINT ai_pricing_profiles_effective_from_unique
    UNIQUE (provider, model, effective_from)
);
CREATE INDEX ai_pricing_profiles_effective_lookup_idx
  ON ai_pricing_profiles (provider, model, effective_from DESC);

CREATE FUNCTION norns_guard_ai_pricing_profile_insert()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ai_pricing_profiles existing
    WHERE existing.provider = NEW.provider
      AND existing.model = NEW.model
      AND existing.effective_from < COALESCE(NEW.effective_to, 'infinity'::timestamptz)
      AND NEW.effective_from < COALESCE(existing.effective_to, 'infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'pricing profile effective range overlaps provider % model %',
      NEW.provider, NEW.model
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$guard$;

CREATE TRIGGER ai_pricing_profiles_range_guard
  BEFORE INSERT ON ai_pricing_profiles
  FOR EACH ROW EXECUTE FUNCTION norns_guard_ai_pricing_profile_insert();
CREATE TRIGGER ai_pricing_profiles_append_only_guard
  BEFORE UPDATE OR DELETE ON ai_pricing_profiles
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER ai_pricing_profiles_append_only_truncate_guard
  BEFORE TRUNCATE ON ai_pricing_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

CREATE TABLE ai_usage_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'request_started',
      'usage_observed',
      'request_completed',
      'request_failed',
      'adjustment'
    )),
  status TEXT NOT NULL
    CHECK (status IN ('started','in_progress','succeeded','failed','adjusted')),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  provider_request_id TEXT CHECK (
    provider_request_id IS NULL OR length(trim(provider_request_id)) > 0
  ),
  endpoint TEXT NOT NULL CHECK (length(trim(endpoint)) > 0),
  request_type TEXT NOT NULL CHECK (length(trim(request_type)) > 0),
  retry_group_id TEXT CHECK (retry_group_id IS NULL OR length(trim(retry_group_id)) > 0),
  retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),
  initiated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  phase_id TEXT REFERENCES phases(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT,
  usage_source TEXT NOT NULL
    CHECK (usage_source IN (
      'provider_api',
      'runtime_report',
      'subscription_credit',
      'estimate',
      'backfill',
      'manual_adjustment',
      'unavailable'
    )),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  pricing_profile_id TEXT REFERENCES ai_pricing_profiles(id) ON DELETE RESTRICT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  cost_usd NUMERIC(24,9),
  cost_classification TEXT NOT NULL
    CHECK (cost_classification IN (
      'actual',
      'estimated',
      'subscription_consumption',
      'unavailable'
    )),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) > 0),
  error_category TEXT CHECK (error_category IS NULL OR length(trim(error_category)) > 0),
  error_message_redacted TEXT
    CHECK (error_message_redacted IS NULL OR length(trim(error_message_redacted)) > 0),
  sanitized_error JSONB,
  adjusts_event_id TEXT REFERENCES ai_usage_events(id) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_events_request_sequence_unique UNIQUE (request_id, sequence),
  CONSTRAINT ai_usage_events_status_shape_check CHECK (
    (event_type = 'request_started' AND status = 'started')
    OR (event_type = 'usage_observed' AND status = 'in_progress')
    OR (event_type = 'request_completed' AND status = 'succeeded')
    OR (event_type = 'request_failed' AND status = 'failed')
    OR (event_type = 'adjustment' AND status = 'adjusted')
  ),
  CONSTRAINT ai_usage_events_scope_shape_check CHECK (
    (phase_id IS NULL OR project_id IS NOT NULL)
    AND (task_id IS NULL OR phase_id IS NOT NULL)
    AND (run_id IS NULL OR task_id IS NOT NULL)
  ),
  CONSTRAINT ai_usage_events_retry_shape_check CHECK (
    retry_attempt = 0 OR retry_group_id IS NOT NULL
  ),
  CONSTRAINT ai_usage_events_token_shape_check CHECK (
    (
      event_type = 'usage_observed'
      AND input_tokens IS NOT NULL AND input_tokens >= 0
      AND output_tokens IS NOT NULL AND output_tokens >= 0
      AND cache_read_tokens IS NOT NULL AND cache_read_tokens >= 0
      AND cache_write_tokens IS NOT NULL AND cache_write_tokens >= 0
      AND cache_read_tokens + cache_write_tokens <= input_tokens
      AND adjusts_event_id IS NULL
    )
    OR (
      event_type = 'adjustment'
      AND adjusts_event_id IS NOT NULL
      AND (
        COALESCE(input_tokens, 0) <> 0
        OR COALESCE(output_tokens, 0) <> 0
        OR COALESCE(cache_read_tokens, 0) <> 0
        OR COALESCE(cache_write_tokens, 0) <> 0
        OR COALESCE(cost_usd, 0) <> 0
      )
    )
    OR (
      event_type IN ('request_started','request_completed','request_failed')
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND cache_read_tokens IS NULL
      AND cache_write_tokens IS NULL
      AND cost_usd IS NULL
      AND adjusts_event_id IS NULL
    )
  ),
  CONSTRAINT ai_usage_events_cost_shape_check CHECK (
    (
      event_type IN ('request_started','request_completed','request_failed')
      AND cost_classification = 'unavailable'
      AND cost_usd IS NULL
    )
    OR (
      event_type IN ('usage_observed','adjustment')
      AND (
        (
          cost_classification IN ('subscription_consumption','unavailable')
          AND cost_usd IS NULL
        )
        OR (
          cost_classification IN ('actual','estimated')
          AND (
            (event_type = 'usage_observed' AND cost_usd IS NOT NULL AND cost_usd >= 0)
            OR event_type = 'adjustment'
          )
        )
      )
    )
  ),
  CONSTRAINT ai_usage_events_error_shape_check CHECK (
    (
      event_type = 'request_failed'
      AND (
        error_code IS NOT NULL
        OR error_category IS NOT NULL
        OR error_message_redacted IS NOT NULL
        OR sanitized_error IS NOT NULL
      )
    )
    OR (
      event_type <> 'request_failed'
      AND error_code IS NULL
      AND error_category IS NULL
      AND error_message_redacted IS NULL
      AND sanitized_error IS NULL
    )
  ),
  CONSTRAINT ai_usage_events_sanitized_error_check CHECK (
    sanitized_error IS NULL OR jsonb_typeof(sanitized_error) = 'object'
  ),
  CONSTRAINT ai_usage_events_phase_scope_fk
    FOREIGN KEY (project_id, phase_id)
    REFERENCES phases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_events_task_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE RESTRICT,
  CONSTRAINT ai_usage_events_run_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id, run_id)
    REFERENCES agent_runs(project_id, phase_id, task_id, id) ON DELETE RESTRICT
);
CREATE INDEX ai_usage_events_request_time_idx
  ON ai_usage_events (request_id, sequence);
CREATE INDEX ai_usage_events_project_time_idx
  ON ai_usage_events (project_id, occurred_at DESC);
CREATE INDEX ai_usage_events_user_time_idx
  ON ai_usage_events (initiated_by_user_id, occurred_at DESC);
CREATE INDEX ai_usage_events_phase_time_idx
  ON ai_usage_events (phase_id, occurred_at DESC);
CREATE INDEX ai_usage_events_provider_model_time_idx
  ON ai_usage_events (provider, model, occurred_at DESC);
CREATE INDEX ai_usage_events_status_time_idx
  ON ai_usage_events (status, occurred_at DESC);
CREATE INDEX ai_usage_events_run_source_idx
  ON ai_usage_events (run_id, request_type)
  WHERE run_id IS NOT NULL;

CREATE FUNCTION norns_guard_ai_usage_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  last_event ai_usage_events%ROWTYPE;
  started_event ai_usage_events%ROWTYPE;
  adjusted_event ai_usage_events%ROWTYPE;
  selected_pricing ai_pricing_profiles%ROWTYPE;
BEGIN
  SELECT *
    INTO last_event
    FROM ai_usage_events
   WHERE request_id = NEW.request_id
   ORDER BY sequence DESC
   LIMIT 1;

  IF last_event.id IS NULL THEN
    IF NEW.event_type <> 'request_started' OR NEW.sequence <> 1 THEN
      RAISE EXCEPTION 'request % must begin with request_started sequence 1', NEW.request_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.sequence <> last_event.sequence + 1 THEN
      RAISE EXCEPTION 'request % expected sequence %, received %',
        NEW.request_id, last_event.sequence + 1, NEW.sequence
        USING ERRCODE = '23514';
    END IF;
    IF NEW.occurred_at < last_event.occurred_at THEN
      RAISE EXCEPTION 'request % event time must not move backwards', NEW.request_id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'request_started' THEN
      RAISE EXCEPTION 'request % already has a start event', NEW.request_id
        USING ERRCODE = '23514';
    END IF;
    IF last_event.event_type IN ('request_completed','request_failed')
       AND NEW.event_type <> 'adjustment' THEN
      RAISE EXCEPTION 'request % is terminal; only adjustments may follow', NEW.request_id
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM ai_usage_events
      WHERE request_id = NEW.request_id
        AND event_type IN ('request_completed','request_failed')
    ) AND NEW.event_type <> 'adjustment' THEN
      RAISE EXCEPTION 'request % already has a terminal event', NEW.request_id
        USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO started_event
      FROM ai_usage_events
     WHERE request_id = NEW.request_id
       AND event_type = 'request_started'
     LIMIT 1;
    IF NEW.provider IS DISTINCT FROM started_event.provider
       OR NEW.model IS DISTINCT FROM started_event.model
       OR NEW.endpoint IS DISTINCT FROM started_event.endpoint
       OR NEW.request_type IS DISTINCT FROM started_event.request_type
       OR NEW.retry_group_id IS DISTINCT FROM started_event.retry_group_id
       OR NEW.retry_attempt IS DISTINCT FROM started_event.retry_attempt
       OR NEW.initiated_by_user_id IS DISTINCT FROM started_event.initiated_by_user_id
       OR NEW.project_id IS DISTINCT FROM started_event.project_id
       OR NEW.phase_id IS DISTINCT FROM started_event.phase_id
       OR NEW.task_id IS DISTINCT FROM started_event.task_id
       OR NEW.run_id IS DISTINCT FROM started_event.run_id
    THEN
      RAISE EXCEPTION 'request % immutable identity or attribution changed', NEW.request_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.event_type = 'adjustment' THEN
    SELECT *
      INTO adjusted_event
      FROM ai_usage_events
     WHERE id = NEW.adjusts_event_id;
    IF adjusted_event.id IS NULL
       OR adjusted_event.request_id <> NEW.request_id
       OR adjusted_event.event_type <> 'usage_observed'
    THEN
      RAISE EXCEPTION 'adjustment must target a usage observation from request %', NEW.request_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.pricing_profile_id IS NOT NULL THEN
    SELECT *
      INTO selected_pricing
      FROM ai_pricing_profiles
     WHERE id = NEW.pricing_profile_id;
    IF selected_pricing.id IS NULL
       OR selected_pricing.provider <> NEW.provider
       OR selected_pricing.model <> NEW.model
       OR selected_pricing.effective_from > NEW.occurred_at
       OR (
         selected_pricing.effective_to IS NOT NULL
         AND selected_pricing.effective_to <= NEW.occurred_at
       )
    THEN
      RAISE EXCEPTION 'pricing profile does not match request provider, model, or event time'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.cost_usd IS NOT NULL AND selected_pricing.currency <> 'USD' THEN
      RAISE EXCEPTION 'cost_usd requires a USD pricing profile'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$guard$;

CREATE TRIGGER ai_usage_events_lifecycle_guard
  BEFORE INSERT ON ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION norns_guard_ai_usage_event_insert();
CREATE TRIGGER ai_usage_events_append_only_guard
  BEFORE UPDATE OR DELETE ON ai_usage_events
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER ai_usage_events_append_only_truncate_guard
  BEFORE TRUNCATE ON ai_usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

REVOKE ALL PRIVILEGES ON ai_pricing_profiles, ai_usage_events FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ai_pricing_profiles, ai_usage_events FROM norns_app;
GRANT SELECT, INSERT ON ai_pricing_profiles, ai_usage_events TO norns_app;
