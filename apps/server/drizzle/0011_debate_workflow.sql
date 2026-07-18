-- Durable project-scoped debate workflow. Debate definitions are immutable
-- configuration snapshots; every execution is a separately recoverable run.

CREATE TABLE debates (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  phase_id TEXT,
  source_debate_id TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  stopping_policy JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_actor_type TEXT NOT NULL,
  created_by_actor_id TEXT,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT debates_phase_scope_fk FOREIGN KEY (project_id, phase_id)
    REFERENCES phases (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT debates_source_scope_fk FOREIGN KEY (project_id, source_debate_id)
    REFERENCES debates (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT debates_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT debates_state_check CHECK (state IN ('draft','ready','archived')),
  CONSTRAINT debates_content_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT debates_actor_type_check CHECK (created_by_actor_type IN ('human','coordinator','agent','runner','system','legacy')),
  CONSTRAINT debates_actor_shape_check CHECK (created_by_actor_type <> 'human' OR created_by_actor_id IS NOT NULL),
  CONSTRAINT debates_archived_shape_check CHECK ((state = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT debates_aggregate_version_check CHECK (aggregate_version > 0)
);
CREATE INDEX debates_project_state_idx ON debates (project_id, state, created_at DESC);

CREATE TABLE debate_actors (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  role_label TEXT NOT NULL,
  display_name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  position INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  max_input_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  budget_limit_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_actors_debate_scope_fk FOREIGN KEY (project_id, debate_id)
    REFERENCES debates (project_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_actors_debate_id_id_unique UNIQUE (debate_id, id),
  CONSTRAINT debate_actors_position_unique UNIQUE (debate_id, position),
  CONSTRAINT debate_actors_kind_check CHECK (actor_kind IN ('participant','judge','synthesizer')),
  CONSTRAINT debate_actors_limits_check CHECK (max_turns > 0 AND max_input_tokens > 0 AND max_output_tokens > 0 AND budget_limit_usd >= 0),
  CONSTRAINT debate_actors_text_check CHECK (
    length(trim(role_label)) > 0 AND length(trim(display_name)) > 0 AND length(trim(instructions)) > 0
    AND length(trim(provider)) > 0 AND length(trim(model)) > 0 AND length(trim(runtime)) > 0
  )
);
CREATE UNIQUE INDEX debate_actors_one_judge_unique ON debate_actors (debate_id) WHERE actor_kind = 'judge';
CREATE UNIQUE INDEX debate_actors_one_synthesizer_unique ON debate_actors (debate_id) WHERE actor_kind = 'synthesizer';

CREATE TABLE debate_contexts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  label TEXT NOT NULL,
  artifact_id TEXT,
  inline_content TEXT,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_contexts_debate_scope_fk FOREIGN KEY (project_id, debate_id)
    REFERENCES debates (project_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_contexts_artifact_scope_fk FOREIGN KEY (project_id, artifact_id)
    REFERENCES artifacts (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_contexts_debate_ordinal_unique UNIQUE (debate_id, ordinal),
  CONSTRAINT debate_contexts_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT debate_contexts_source_check CHECK ((artifact_id IS NULL) <> (inline_content IS NULL)),
  CONSTRAINT debate_contexts_ordinal_check CHECK (ordinal >= 0)
);

CREATE TABLE debate_runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  lifecycle_version INTEGER NOT NULL DEFAULT 0,
  event_version INTEGER NOT NULL DEFAULT 0,
  cursor_round_number INTEGER NOT NULL DEFAULT 0,
  cursor_turn_number INTEGER NOT NULL DEFAULT 0,
  stop_after TEXT NOT NULL DEFAULT 'none',
  stop_reason TEXT,
  -- Captured at start, never re-read from the mutable provider registry. This
  -- makes later price/model catalog edits unable to change a run in flight.
  actor_execution_snapshots JSONB NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_runs_debate_scope_fk FOREIGN KEY (project_id, debate_id)
    REFERENCES debates (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_runs_project_debate_id_unique UNIQUE (project_id, debate_id, id),
  CONSTRAINT debate_runs_attempt_unique UNIQUE (debate_id, attempt),
  CONSTRAINT debate_runs_state_check CHECK (state IN ('created','queued','running','pausing','paused','finalizing','cancelling','completed','cancelled','failed')),
  CONSTRAINT debate_runs_lifecycle_origin_check CHECK (lifecycle_version > 0 OR state = 'created'),
  CONSTRAINT debate_runs_nonnegative_check CHECK (event_version >= 0 AND cursor_round_number >= 0 AND cursor_turn_number >= 0),
  CONSTRAINT debate_runs_stop_after_check CHECK (stop_after IN ('none','turn','round')),
  CONSTRAINT debate_runs_actor_execution_snapshots_shape_check CHECK (
    jsonb_typeof(actor_execution_snapshots) = 'array' AND jsonb_array_length(actor_execution_snapshots) > 0
  ),
  CONSTRAINT debate_runs_terminal_time_check CHECK ((state IN ('completed','cancelled','failed')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX debate_runs_one_nonterminal_unique ON debate_runs (debate_id)
  WHERE state NOT IN ('completed','cancelled','failed');
CREATE INDEX debate_runs_project_state_idx ON debate_runs (project_id, state, updated_at);

CREATE TABLE debate_rounds (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  consensus_reported BOOLEAN NOT NULL DEFAULT false,
  material_change BOOLEAN,
  unresolved_disagreement_fingerprint TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_rounds_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_rounds_run_round_unique UNIQUE (debate_run_id, round_number),
  CONSTRAINT debate_rounds_run_id_id_unique UNIQUE (debate_run_id, id),
  CONSTRAINT debate_rounds_state_check CHECK (state IN ('pending','active','completed','cancelled','failed')),
  CONSTRAINT debate_rounds_number_check CHECK (round_number > 0),
  CONSTRAINT debate_rounds_fingerprint_check CHECK (unresolved_disagreement_fingerprint IS NULL OR unresolved_disagreement_fingerprint ~ '^[a-f0-9]{64}$')
);

CREATE TABLE debate_turns (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  designated_attempt_id TEXT,
  prompt_hash TEXT NOT NULL,
  output_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT debate_turns_round_scope_fk FOREIGN KEY (debate_run_id, round_id)
    REFERENCES debate_rounds (debate_run_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_turns_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_turns_actor_scope_fk FOREIGN KEY (debate_id, actor_id)
    REFERENCES debate_actors (debate_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_turns_run_turn_unique UNIQUE (debate_run_id, turn_number),
  CONSTRAINT debate_turns_run_id_id_unique UNIQUE (debate_run_id, id),
  CONSTRAINT debate_turns_state_check CHECK (state IN ('pending','queued','leased','running','completed','failed','cancelled','expired')),
  CONSTRAINT debate_turns_number_check CHECK (turn_number > 0),
  CONSTRAINT debate_turns_hash_check CHECK (prompt_hash ~ '^[a-f0-9]{64}$')
);

CREATE TABLE debate_turn_attempts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  is_designated BOOLEAN NOT NULL DEFAULT true,
  provider_execution_id TEXT,
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_turn_attempts_turn_scope_fk FOREIGN KEY (debate_run_id, turn_id)
    REFERENCES debate_turns (debate_run_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_turn_attempts_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_turn_attempts_turn_attempt_unique UNIQUE (turn_id, attempt_number),
  CONSTRAINT debate_turn_attempts_turn_id_id_unique UNIQUE (turn_id, id),
  CONSTRAINT debate_turn_attempts_project_run_id_unique UNIQUE (project_id, debate_id, debate_run_id, id),
  CONSTRAINT debate_turn_attempts_state_check CHECK (state IN ('pending','queued','leased','running','completed','failed','cancelled','expired')),
  CONSTRAINT debate_turn_attempts_number_check CHECK (attempt_number > 0),
  CONSTRAINT debate_turn_attempts_lease_shape_check CHECK ((lease_token IS NULL) = (leased_until IS NULL) OR state IN ('completed','failed','cancelled','expired'))
);
CREATE UNIQUE INDEX debate_turn_attempts_designated_unique ON debate_turn_attempts (turn_id)
  WHERE is_designated = true;
ALTER TABLE debate_turns ADD CONSTRAINT debate_turns_designated_attempt_scope_fk
  FOREIGN KEY (id, designated_attempt_id) REFERENCES debate_turn_attempts (turn_id, id) ON DELETE RESTRICT;

CREATE TABLE debate_messages (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  message_kind TEXT NOT NULL,
  actor_snapshot JSONB,
  turn_id TEXT,
  turn_attempt_id TEXT,
  intervention_kind TEXT,
  intervention_target_actor_id TEXT,
  intervention_apply_at TEXT,
  intervention_applies_after_round INTEGER,
  intervention_applies_after_turn INTEGER,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_messages_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_messages_turn_scope_fk FOREIGN KEY (debate_run_id, turn_id)
    REFERENCES debate_turns (debate_run_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_messages_attempt_scope_fk FOREIGN KEY (turn_id, turn_attempt_id)
    REFERENCES debate_turn_attempts (turn_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_messages_run_sequence_unique UNIQUE (debate_run_id, sequence),
  CONSTRAINT debate_messages_run_id_id_unique UNIQUE (debate_run_id, id),
  CONSTRAINT debate_messages_kind_check CHECK (message_kind IN ('system','participant','judge','synthesizer','human')),
  CONSTRAINT debate_messages_sequence_check CHECK (sequence > 0),
  CONSTRAINT debate_messages_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT debate_messages_intervention_kind_check CHECK (
    intervention_kind IS NULL OR intervention_kind IN ('direction','statement')
  ),
  CONSTRAINT debate_messages_intervention_apply_at_check CHECK (
    intervention_apply_at IS NULL OR intervention_apply_at IN ('next_turn','next_round')
  ),
  CONSTRAINT debate_messages_intervention_boundary_check CHECK (
    intervention_applies_after_round IS NULL OR intervention_applies_after_round >= 0
  ),
  CONSTRAINT debate_messages_intervention_turn_boundary_check CHECK (
    intervention_applies_after_turn IS NULL OR intervention_applies_after_turn >= 0
  ),
  CONSTRAINT debate_messages_intervention_shape_check CHECK (
    (message_kind = 'human') = (intervention_kind IS NOT NULL)
    AND (intervention_kind IS NULL) = (intervention_target_actor_id IS NULL AND intervention_apply_at IS NULL
      AND intervention_applies_after_round IS NULL AND intervention_applies_after_turn IS NULL)
    AND (intervention_kind IS NULL OR (intervention_apply_at IS NOT NULL
      AND intervention_applies_after_round IS NOT NULL AND intervention_applies_after_turn IS NOT NULL))
  )
);
ALTER TABLE debate_turns ADD CONSTRAINT debate_turns_output_message_scope_fk
  FOREIGN KEY (debate_run_id, output_message_id) REFERENCES debate_messages (debate_run_id, id) ON DELETE RESTRICT;

CREATE TABLE debate_findings (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  finding_key TEXT NOT NULL,
  severity TEXT NOT NULL,
  finding TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_findings_message_scope_fk FOREIGN KEY (debate_run_id, message_id)
    REFERENCES debate_messages (debate_run_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_findings_message_key_unique UNIQUE (message_id, finding_key),
  CONSTRAINT debate_findings_severity_check CHECK (severity IN ('must_fix','should_fix','suggestion')),
  CONSTRAINT debate_findings_disposition_check CHECK (disposition IN ('open','accepted','rejected','deferred','resolved'))
);

CREATE TABLE debate_revisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  revision_kind TEXT NOT NULL,
  supersedes_revision_id TEXT,
  rationale TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_type TEXT NOT NULL,
  created_by_actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_revisions_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_revisions_supersedes_fk FOREIGN KEY (supersedes_revision_id)
    REFERENCES debate_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT debate_revisions_run_number_unique UNIQUE (debate_run_id, revision_number),
  CONSTRAINT debate_revisions_kind_check CHECK (revision_kind IN ('finding_disposition','judgment','final_output','correction')),
  CONSTRAINT debate_revisions_number_check CHECK (revision_number > 0)
);

CREATE TABLE debate_judgments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  revision_id TEXT,
  judge_actor_id TEXT,
  conclusion TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_judgments_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_judgments_revision_fk FOREIGN KEY (revision_id) REFERENCES debate_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT debate_judgments_actor_fk FOREIGN KEY (debate_id, judge_actor_id) REFERENCES debate_actors (debate_id, id) ON DELETE RESTRICT,
  CONSTRAINT debate_judgments_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$')
);

CREATE TABLE debate_final_outputs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  revision_id TEXT,
  judgment_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_final_outputs_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_final_outputs_revision_fk FOREIGN KEY (revision_id) REFERENCES debate_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT debate_final_outputs_judgment_fk FOREIGN KEY (judgment_id) REFERENCES debate_judgments (id) ON DELETE RESTRICT,
  CONSTRAINT debate_final_outputs_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX debate_final_outputs_one_current_run_unique ON debate_final_outputs (debate_run_id) WHERE revision_id IS NULL;

CREATE TABLE debate_jobs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  turn_attempt_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  is_designated BOOLEAN NOT NULL DEFAULT true,
  delivery_attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  lease_token TEXT,
  leased_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_jobs_attempt_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id, turn_attempt_id)
    REFERENCES debate_turn_attempts (project_id, debate_id, debate_run_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_jobs_attempt_kind_unique UNIQUE (turn_attempt_id, job_kind),
  CONSTRAINT debate_jobs_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT debate_jobs_kind_check CHECK (job_kind = 'execute_turn'),
  CONSTRAINT debate_jobs_state_check CHECK (state IN ('queued','leased','succeeded','failed','cancelled','dead_letter')),
  CONSTRAINT debate_jobs_delivery_attempt_check CHECK (delivery_attempt > 0),
  CONSTRAINT debate_jobs_lease_shape_check CHECK ((lease_token IS NULL) = (leased_until IS NULL) OR state IN ('succeeded','failed','cancelled','dead_letter'))
);
CREATE UNIQUE INDEX debate_jobs_designated_attempt_unique ON debate_jobs (turn_attempt_id) WHERE is_designated = true;
CREATE INDEX debate_jobs_claim_idx ON debate_jobs (state, leased_until, created_at);

CREATE TABLE debate_reservations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  turn_attempt_id TEXT NOT NULL,
  amount_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  settled_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  released_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  retained_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  resolution_outcome TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT debate_reservations_attempt_fk FOREIGN KEY (project_id, debate_id, debate_run_id, turn_attempt_id)
    REFERENCES debate_turn_attempts (project_id, debate_id, debate_run_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_reservations_attempt_unique UNIQUE (turn_attempt_id),
  CONSTRAINT debate_reservations_status_check CHECK (status IN ('active','retained_ambiguous','settled','released')),
  CONSTRAINT debate_reservations_amount_check CHECK (amount_usd >= 0 AND settled_usd >= 0 AND released_usd >= 0 AND retained_usd >= 0),
  CONSTRAINT debate_reservations_balance_check CHECK (
    (status = 'active' AND settled_usd = 0 AND released_usd = 0 AND retained_usd = 0)
    OR (status <> 'active' AND settled_usd + released_usd + retained_usd = amount_usd)
  )
);
CREATE INDEX debate_reservations_status_expiry_idx ON debate_reservations (status, expires_at);

CREATE TABLE debate_usage_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  turn_attempt_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT debate_usage_events_attempt_fk FOREIGN KEY (project_id, debate_id, debate_run_id, turn_attempt_id)
    REFERENCES debate_turn_attempts (project_id, debate_id, debate_run_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_usage_events_nonnegative_check CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cost_usd >= 0 AND latency_ms >= 0)
);
CREATE INDEX debate_usage_events_run_time_idx ON debate_usage_events (debate_run_id, occurred_at);

CREATE TABLE debate_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2,
  project_id TEXT NOT NULL,
  debate_id TEXT NOT NULL,
  debate_run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  lifecycle_version INTEGER,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT debate_events_run_scope_fk FOREIGN KEY (project_id, debate_id, debate_run_id)
    REFERENCES debate_runs (project_id, debate_id, id) ON DELETE CASCADE,
  CONSTRAINT debate_events_run_sequence_unique UNIQUE (debate_run_id, sequence),
  CONSTRAINT debate_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT debate_events_actor_check CHECK (actor_type IN ('human','coordinator','agent','runner','system','legacy'))
);
CREATE INDEX debate_events_project_time_idx ON debate_events (project_id, occurred_at);

CREATE FUNCTION norns_reject_debate_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$guard$;

CREATE FUNCTION norns_guard_debate_definition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF to_jsonb(NEW) - ARRAY['state','aggregate_version','archived_at']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['state','aggregate_version','archived_at'] THEN
    RAISE EXCEPTION 'debates substantive definition fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
CREATE TRIGGER debates_substantive_update_guard BEFORE UPDATE ON debates
  FOR EACH ROW EXECUTE FUNCTION norns_guard_debate_definition_mutation();

CREATE TRIGGER debate_actors_append_only_guard BEFORE UPDATE OR DELETE ON debate_actors
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_contexts_append_only_guard BEFORE UPDATE OR DELETE ON debate_contexts
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_messages_append_only_guard BEFORE UPDATE OR DELETE ON debate_messages
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_findings_append_only_guard BEFORE UPDATE OR DELETE ON debate_findings
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_revisions_append_only_guard BEFORE UPDATE OR DELETE ON debate_revisions
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_judgments_append_only_guard BEFORE UPDATE OR DELETE ON debate_judgments
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_final_outputs_append_only_guard BEFORE UPDATE OR DELETE ON debate_final_outputs
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_usage_events_append_only_guard BEFORE UPDATE OR DELETE ON debate_usage_events
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_events_append_only_guard BEFORE UPDATE OR DELETE ON debate_events
  FOR EACH ROW EXECUTE FUNCTION norns_reject_debate_append_only_mutation();

CREATE TRIGGER debate_actors_append_only_truncate_guard BEFORE TRUNCATE ON debate_actors
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_contexts_append_only_truncate_guard BEFORE TRUNCATE ON debate_contexts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_messages_append_only_truncate_guard BEFORE TRUNCATE ON debate_messages
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_findings_append_only_truncate_guard BEFORE TRUNCATE ON debate_findings
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_revisions_append_only_truncate_guard BEFORE TRUNCATE ON debate_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_judgments_append_only_truncate_guard BEFORE TRUNCATE ON debate_judgments
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_final_outputs_append_only_truncate_guard BEFORE TRUNCATE ON debate_final_outputs
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_usage_events_append_only_truncate_guard BEFORE TRUNCATE ON debate_usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();
CREATE TRIGGER debate_events_append_only_truncate_guard BEFORE TRUNCATE ON debate_events
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_debate_append_only_mutation();

REVOKE ALL PRIVILEGES ON debates, debate_actors, debate_contexts, debate_runs, debate_rounds,
  debate_turns, debate_turn_attempts, debate_jobs, debate_reservations FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON debates, debate_runs, debate_rounds, debate_turns,
  debate_turn_attempts, debate_jobs, debate_reservations TO norns_app;
GRANT SELECT, INSERT ON debate_actors, debate_contexts, debate_messages, debate_findings,
  debate_revisions, debate_judgments, debate_final_outputs, debate_usage_events, debate_events TO norns_app;
