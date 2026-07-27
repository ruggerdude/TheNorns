-- Canonical usage-policy reservations for trusted conversation PM inference.
--
-- This table is not a second spend ledger. ai_usage_events remains the
-- canonical settled usage source; these rows serialize conservative
-- pre-dispatch holds, temporarily preserve exact settlement while canonical
-- telemetry is queued, and retain the ceiling when dispatched usage is
-- unavailable.

ALTER TABLE conversation_turn_attempts
  ADD CONSTRAINT conversation_turn_attempts_id_usage_request_unique
  UNIQUE (id,usage_request_id);

CREATE TABLE conversation_inference_reservations (
  reservation_key TEXT PRIMARY KEY
    REFERENCES conversation_turn_attempts(id) ON DELETE RESTRICT,
  usage_request_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  max_input_tokens BIGINT NOT NULL CHECK (max_input_tokens >= 0),
  max_output_tokens BIGINT NOT NULL CHECK (max_output_tokens > 0),
  max_charge_usd NUMERIC(24,9) NOT NULL CHECK (max_charge_usd >= 0),
  actual_tokens BIGINT NOT NULL DEFAULT 0 CHECK (actual_tokens >= 0),
  actual_charge_usd NUMERIC(24,9) NOT NULL DEFAULT 0 CHECK (actual_charge_usd >= 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','settled','released','retained_ambiguous')),
  dispatch_started_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_inference_reservations_conversation_scope_fk
    FOREIGN KEY (project_id,work_item_id,conversation_id)
    REFERENCES work_conversations(project_id,work_item_id,id) ON DELETE RESTRICT,
  CONSTRAINT conversation_inference_reservations_attempt_identity_fk
    FOREIGN KEY (reservation_key,usage_request_id)
    REFERENCES conversation_turn_attempts(id,usage_request_id) ON DELETE RESTRICT,
  CONSTRAINT conversation_inference_reservations_shape_check CHECK (
    (status='active' AND resolved_at IS NULL
      AND actual_tokens=0 AND actual_charge_usd=0)
    OR
    (status='released' AND resolved_at IS NOT NULL
      AND actual_tokens=0 AND actual_charge_usd=0)
    OR
    (status='settled' AND resolved_at IS NOT NULL)
    OR
    (status='retained_ambiguous' AND resolved_at IS NOT NULL
      AND actual_tokens=max_input_tokens+max_output_tokens
      AND actual_charge_usd=max_charge_usd)
  )
);

CREATE INDEX conversation_inference_reservations_policy_hold_idx
  ON conversation_inference_reservations (
    status,created_at,project_id,initiated_by_user_id,provider,model
  );

GRANT SELECT, INSERT, UPDATE ON conversation_inference_reservations TO norns_app;
