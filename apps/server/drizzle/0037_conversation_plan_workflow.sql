-- CONVERSATION-FIRST PHASE 3: immutable plan versions, isolated QC receipts,
-- and durable explicit-action effects.

DO $conversation_plan_workflow_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0036_conversation_stream_lifecycle'
  ) THEN
    RAISE EXCEPTION
      '0037_conversation_plan_workflow requires 0036_conversation_stream_lifecycle'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_plan_workflow_dependency$;

CREATE VIEW conversation_plan_workflow_v1 AS
SELECT 1::INTEGER AS version;
REVOKE ALL ON conversation_plan_workflow_v1 FROM PUBLIC;
GRANT SELECT ON conversation_plan_workflow_v1 TO norns_app;

ALTER TABLE planning_runs
  DROP CONSTRAINT planning_runs_mode_check;
ALTER TABLE planning_runs
  ADD CONSTRAINT planning_runs_mode_check
  CHECK (mode IN ('planned', 'quick', 'review_only'));

ALTER TABLE work_plan_versions
  ADD COLUMN created_by_action_id TEXT;

ALTER TABLE conversation_actions
  ADD CONSTRAINT conversation_actions_scope_identity_unique
  UNIQUE (project_id, work_item_id, conversation_id, id);
CREATE UNIQUE INDEX conversation_actions_one_open_plan_choice
  ON conversation_actions(
    conversation_id, initiated_by_user_id, action_type, payload_hash
  )
  WHERE status = 'proposed'
    AND action_type IN (
      'save_plan_candidate',
      'send_plan_to_qc',
      'request_plan_changes',
      'approve_plan',
      'reject_plan'
    );

ALTER TABLE work_plan_versions
  ADD CONSTRAINT work_plan_versions_conversation_identity_unique
  UNIQUE (project_id, work_item_id, conversation_id, id);

ALTER TABLE work_plan_versions
  ADD CONSTRAINT work_plan_versions_created_by_action_scope_fk
  FOREIGN KEY (
    project_id, work_item_id, conversation_id, created_by_action_id
  )
  REFERENCES conversation_actions (
    project_id, work_item_id, conversation_id, id
  )
  ON DELETE RESTRICT;

CREATE TABLE conversation_plan_reviews (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  planning_run_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  pm_provider TEXT NOT NULL CHECK (pm_provider IN ('anthropic', 'openai')),
  pm_model TEXT NOT NULL CHECK (length(trim(pm_model)) > 0),
  reviewer_provider TEXT NOT NULL CHECK (reviewer_provider IN ('anthropic', 'openai')),
  reviewer_model TEXT NOT NULL CHECK (length(trim(reviewer_model)) > 0),
  usage_request_group_id TEXT NOT NULL CHECK (
    length(trim(usage_request_group_id)) > 0
  ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'converged', 'cap_reached', 'failed')),
  seed_plan JSONB NOT NULL CHECK (jsonb_typeof(seed_plan) = 'object'),
  plan_content_hash TEXT NOT NULL CHECK (plan_content_hash ~ '^[a-f0-9]{64}$'),
  result_plan_content_hash TEXT NOT NULL
    CHECK (result_plan_content_hash ~ '^[a-f0-9]{64}$'),
  context_receipt JSONB NOT NULL CHECK (jsonb_typeof(context_receipt) = 'object'),
  context_manifest JSONB NOT NULL CHECK (jsonb_typeof(context_manifest) = 'object'),
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  dispositions JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(dispositions) = 'array'),
  revised_plan JSONB CHECK (revised_plan IS NULL OR jsonb_typeof(revised_plan) = 'object'),
  revised_plan_content_hash TEXT
    CHECK (
      revised_plan_content_hash IS NULL
      OR revised_plan_content_hash ~ '^[a-f0-9]{64}$'
    ),
  revised_plan_version_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR length(trim(failure_code)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_plan_reviews_action_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, action_id)
    REFERENCES conversation_actions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_reviews_plan_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, plan_version_id)
    REFERENCES work_plan_versions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_reviews_run_scope_fk
    FOREIGN KEY (project_id, planning_run_id)
    REFERENCES planning_runs(project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_reviews_revision_scope_fk
    FOREIGN KEY (
      project_id, work_item_id, conversation_id, revised_plan_version_id
    )
    REFERENCES work_plan_versions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_reviews_action_unique UNIQUE (action_id),
  CONSTRAINT conversation_plan_reviews_run_unique UNIQUE (planning_run_id),
  CONSTRAINT conversation_plan_reviews_attempt_unique
    UNIQUE (plan_version_id, attempt_number),
  CONSTRAINT conversation_plan_reviews_identity_unique
    UNIQUE (project_id, work_item_id, conversation_id, id),
  CONSTRAINT conversation_plan_reviews_provider_policy_check
    CHECK (pm_provider <> reviewer_provider),
  CONSTRAINT conversation_plan_reviews_manifest_hash_check
    CHECK (
      context_manifest ? 'context_hash'
      AND context_manifest->>'context_hash' = context_hash
    ),
  CONSTRAINT conversation_plan_reviews_nonterminal_evidence_check
    CHECK (
      status IN ('converged', 'cap_reached')
      OR (
        jsonb_array_length(findings) = 0
        AND jsonb_array_length(dispositions) = 0
        AND revised_plan IS NULL
        AND revised_plan_content_hash IS NULL
        AND revised_plan_version_id IS NULL
        AND result_plan_content_hash = plan_content_hash
      )
    ),
  CONSTRAINT conversation_plan_reviews_revision_shape_check
    CHECK (
      (
        revised_plan IS NULL
        AND revised_plan_content_hash IS NULL
        AND revised_plan_version_id IS NULL
        AND result_plan_content_hash = plan_content_hash
      )
      OR (
        revised_plan IS NOT NULL
        AND revised_plan_content_hash IS NOT NULL
        AND revised_plan_version_id IS NOT NULL
        AND revised_plan_version_id <> plan_version_id
        AND result_plan_content_hash = revised_plan_content_hash
      )
    ),
  CONSTRAINT conversation_plan_reviews_timing_check
    CHECK (
      (
        status = 'queued'
        AND started_at IS NULL
        AND completed_at IS NULL
        AND failure_code IS NULL
      )
      OR (
        status = 'running'
        AND started_at IS NOT NULL
        AND completed_at IS NULL
        AND failure_code IS NULL
      )
      OR (
        status IN ('converged', 'cap_reached')
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failure_code IS NULL
      )
      OR (
        status = 'failed'
        AND completed_at IS NOT NULL
        AND failure_code IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX conversation_plan_reviews_one_active_per_version
  ON conversation_plan_reviews(plan_version_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX conversation_plan_reviews_conversation_time_idx
  ON conversation_plan_reviews(conversation_id, created_at, id);
CREATE INDEX conversation_plan_reviews_work_item_status_idx
  ON conversation_plan_reviews(work_item_id, status, created_at, id);

CREATE FUNCTION norns_validate_conversation_plan_review_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_action conversation_actions%ROWTYPE;
  source_plan work_plan_versions%ROWTYPE;
BEGIN
  SELECT * INTO source_action
    FROM conversation_actions
   WHERE id = NEW.action_id;
  IF source_action.action_type <> 'send_plan_to_qc'
     OR source_action.payload->'parameters'->>'plan_version_id' <> NEW.plan_version_id
     OR source_action.payload->'parameters'->>'content_hash' <> NEW.plan_content_hash THEN
    RAISE EXCEPTION 'plan review must match its exact send-to-QC action payload'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO source_plan
    FROM work_plan_versions
   WHERE id = NEW.plan_version_id;
  IF source_plan.conversation_id <> NEW.conversation_id
     OR source_plan.plan <> NEW.seed_plan
     OR source_plan.content_hash <> NEW.plan_content_hash THEN
    RAISE EXCEPTION 'plan review seed must equal its immutable conversation plan version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_plan_reviews_scope_guard
  BEFORE INSERT ON conversation_plan_reviews
  FOR EACH ROW EXECUTE FUNCTION norns_validate_conversation_plan_review_scope();

CREATE FUNCTION norns_guard_conversation_plan_review()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  revision work_plan_versions%ROWTYPE;
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.action_id <> OLD.action_id
     OR NEW.plan_version_id <> OLD.plan_version_id
     OR NEW.planning_run_id <> OLD.planning_run_id
     OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
     OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.pm_provider <> OLD.pm_provider
     OR NEW.pm_model <> OLD.pm_model
     OR NEW.reviewer_provider <> OLD.reviewer_provider
     OR NEW.reviewer_model <> OLD.reviewer_model
     OR NEW.usage_request_group_id <> OLD.usage_request_group_id
     OR NEW.seed_plan <> OLD.seed_plan
     OR NEW.plan_content_hash <> OLD.plan_content_hash
     OR NEW.context_receipt <> OLD.context_receipt
     OR NEW.context_manifest <> OLD.context_manifest
     OR NEW.context_hash <> OLD.context_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation plan review seed, context, and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('converged', 'cap_reached', 'failed') THEN
    RAISE EXCEPTION 'terminal conversation plan reviews are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
    OR
    (OLD.status = 'running' AND NEW.status IN ('converged', 'cap_reached', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid conversation plan review status transition % -> %',
      OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'queued' AND NEW.status IN ('running', 'failed') AND (
    NEW.findings <> OLD.findings
    OR NEW.dispositions <> OLD.dispositions
    OR NEW.result_plan_content_hash <> OLD.result_plan_content_hash
    OR NEW.revised_plan IS DISTINCT FROM OLD.revised_plan
    OR NEW.revised_plan_content_hash IS DISTINCT FROM OLD.revised_plan_content_hash
    OR NEW.revised_plan_version_id IS DISTINCT FROM OLD.revised_plan_version_id
  ) THEN
    RAISE EXCEPTION 'pre-review transitions cannot attach QC findings or revision evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'failed' AND (
    jsonb_array_length(NEW.findings) <> 0
    OR jsonb_array_length(NEW.dispositions) <> 0
    OR NEW.revised_plan IS NOT NULL
    OR NEW.revised_plan_content_hash IS NOT NULL
    OR NEW.revised_plan_version_id IS NOT NULL
    OR NEW.result_plan_content_hash <> NEW.plan_content_hash
  ) THEN
    RAISE EXCEPTION 'failed reviews cannot attach QC result or revision evidence'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IN ('converged', 'cap_reached')
     AND NEW.revised_plan_version_id IS NOT NULL THEN
    SELECT * INTO revision
      FROM work_plan_versions
     WHERE id = NEW.revised_plan_version_id;
    IF revision.conversation_id <> NEW.conversation_id
       OR revision.supersedes_plan_version_id <> NEW.plan_version_id
       OR revision.plan <> NEW.revised_plan
       OR revision.content_hash <> NEW.revised_plan_content_hash THEN
      RAISE EXCEPTION 'review revision evidence must equal its immutable successor version'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = OLD.status AND (
    NEW.findings <> OLD.findings
    OR NEW.dispositions <> OLD.dispositions
    OR NEW.result_plan_content_hash <> OLD.result_plan_content_hash
    OR NEW.revised_plan IS DISTINCT FROM OLD.revised_plan
    OR NEW.revised_plan_content_hash IS DISTINCT FROM OLD.revised_plan_content_hash
    OR NEW.revised_plan_version_id IS DISTINCT FROM OLD.revised_plan_version_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
  ) THEN
    RAISE EXCEPTION 'conversation plan review evidence changes only with lifecycle state'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_plan_reviews_lifecycle_guard
  BEFORE UPDATE ON conversation_plan_reviews
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_plan_review();

CREATE TABLE conversation_plan_action_effects (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL
    CHECK (effect_kind IN (
      'plan_saved', 'qc_started', 'changes_requested', 'plan_approved', 'plan_rejected'
    )),
  plan_version_id TEXT NOT NULL,
  plan_review_id TEXT,
  planning_run_id TEXT,
  execution_status TEXT
    CHECK (execution_status IS NULL OR execution_status IN (
      'pending', 'started', 'refused', 'failed'
    )),
  execution_started BOOLEAN,
  execution_detail TEXT CHECK (
    execution_detail IS NULL OR length(trim(execution_detail)) > 0
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_plan_action_effects_action_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, action_id)
    REFERENCES conversation_actions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_action_effects_plan_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, plan_version_id)
    REFERENCES work_plan_versions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_action_effects_review_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, plan_review_id)
    REFERENCES conversation_plan_reviews(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_action_effects_run_scope_fk
    FOREIGN KEY (project_id, planning_run_id)
    REFERENCES planning_runs(project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_action_effects_action_unique UNIQUE (action_id),
  CONSTRAINT conversation_plan_action_effects_identity_unique
    UNIQUE (project_id, work_item_id, conversation_id, id),
  CONSTRAINT conversation_plan_action_effects_shape_check CHECK (
    (
      effect_kind = 'qc_started'
      AND plan_review_id IS NOT NULL
      AND planning_run_id IS NOT NULL
      AND execution_status IS NULL
    )
    OR (
      effect_kind = 'plan_approved'
      AND plan_review_id IS NOT NULL
      AND planning_run_id IS NOT NULL
      AND execution_status IS NOT NULL
    )
    OR (
      effect_kind IN ('plan_saved', 'changes_requested', 'plan_rejected')
      AND plan_review_id IS NULL
      AND planning_run_id IS NULL
      AND execution_status IS NULL
    )
  ),
  CONSTRAINT conversation_plan_action_effects_execution_shape_check CHECK (
    (
      execution_status = 'pending'
      AND execution_started IS NULL
      AND execution_detail IS NULL
    )
    OR (
      execution_status IN ('started', 'refused', 'failed')
      AND execution_started IS NOT NULL
      AND execution_detail IS NOT NULL
    )
    OR (
      execution_status IS NULL
      AND execution_started IS NULL
      AND execution_detail IS NULL
    )
  ),
  CONSTRAINT conversation_plan_action_effects_execution_truth_check CHECK (
    (execution_status = 'started' AND execution_started = TRUE)
    OR (execution_status IN ('refused', 'failed') AND execution_started = FALSE)
    OR execution_status IN ('pending')
    OR execution_status IS NULL
  )
);
CREATE INDEX conversation_plan_action_effects_conversation_time_idx
  ON conversation_plan_action_effects(conversation_id, created_at, id);

CREATE FUNCTION norns_validate_conversation_plan_action_effect()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_action conversation_actions%ROWTYPE;
  source_plan work_plan_versions%ROWTYPE;
  source_review conversation_plan_reviews%ROWTYPE;
  expected_kind TEXT;
BEGIN
  SELECT * INTO source_action
    FROM conversation_actions
   WHERE id = NEW.action_id;
  expected_kind := CASE source_action.action_type
    WHEN 'save_plan_candidate' THEN 'plan_saved'
    WHEN 'send_plan_to_qc' THEN 'qc_started'
    WHEN 'request_plan_changes' THEN 'changes_requested'
    WHEN 'approve_plan' THEN 'plan_approved'
    WHEN 'reject_plan' THEN 'plan_rejected'
    ELSE NULL
  END;
  IF expected_kind IS NULL OR expected_kind <> NEW.effect_kind THEN
    RAISE EXCEPTION 'plan action effect kind does not match its source action'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO source_plan
    FROM work_plan_versions
   WHERE id = NEW.plan_version_id;
  IF source_plan.conversation_id <> NEW.conversation_id THEN
    RAISE EXCEPTION 'plan action effect cannot cross conversation plan ownership'
      USING ERRCODE = '23514';
  END IF;
  IF source_action.action_type = 'save_plan_candidate' THEN
    IF source_plan.created_by_action_id <> NEW.action_id THEN
      RAISE EXCEPTION 'saved-plan effect must reference the version created by its action'
        USING ERRCODE = '23514';
    END IF;
  ELSIF source_action.payload->'parameters'->>'plan_version_id' <> NEW.plan_version_id
        OR source_action.payload->'parameters'->>'content_hash' <> source_plan.content_hash THEN
    RAISE EXCEPTION 'plan action effect version/hash does not match its source action'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.effect_kind = 'plan_approved' AND (
    source_action.payload->'parameters'->>'plan_review_id' <> NEW.plan_review_id
  ) THEN
    RAISE EXCEPTION 'approval effect review does not match its source action'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.effect_kind = 'plan_approved' THEN
    SELECT * INTO source_review
      FROM conversation_plan_reviews
     WHERE id = NEW.plan_review_id;
    IF source_review.status NOT IN ('converged', 'cap_reached')
       OR source_review.conversation_id <> NEW.conversation_id
       OR coalesce(
            source_review.revised_plan_version_id,
            source_review.plan_version_id
          ) <> NEW.plan_version_id
       OR source_review.result_plan_content_hash <> source_plan.content_hash
       OR source_review.planning_run_id <> NEW.planning_run_id THEN
      RAISE EXCEPTION 'approval effect must bind the exact successful QC review and run'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_plan_action_effects_scope_guard
  BEFORE INSERT ON conversation_plan_action_effects
  FOR EACH ROW EXECUTE FUNCTION norns_validate_conversation_plan_action_effect();

CREATE FUNCTION norns_guard_conversation_plan_action_effect()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.action_id <> OLD.action_id
     OR NEW.effect_kind <> OLD.effect_kind
     OR NEW.plan_version_id <> OLD.plan_version_id
     OR NEW.plan_review_id IS DISTINCT FROM OLD.plan_review_id
     OR NEW.planning_run_id IS DISTINCT FROM OLD.planning_run_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation plan action effect identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_status IS DISTINCT FROM NEW.execution_status AND NOT (
    OLD.execution_status = 'pending'
    AND NEW.execution_status IN ('started', 'refused', 'failed')
  ) THEN
    RAISE EXCEPTION 'invalid plan action execution transition % -> %',
      OLD.execution_status, NEW.execution_status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'settled plan action execution outcome is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_plan_action_effects_lifecycle_guard
  BEFORE UPDATE ON conversation_plan_action_effects
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_plan_action_effect();

CREATE TABLE conversation_plan_proposal_attempts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  source_message_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  usage_request_id TEXT NOT NULL,
  retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),
  provider_request_id TEXT,
  usage_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (usage_status IN ('pending', 'exact', 'unavailable')),
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  cost_usd NUMERIC(18, 6),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  context_manifest JSONB NOT NULL CHECK (jsonb_typeof(context_manifest) = 'object'),
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  output_message_id TEXT,
  action_id TEXT,
  plan_content_hash TEXT
    CHECK (plan_content_hash IS NULL OR plan_content_hash ~ '^[a-f0-9]{64}$'),
  failure_code TEXT CHECK (failure_code IS NULL OR length(trim(failure_code)) > 0),
  failure_message_redacted TEXT
    CHECK (failure_message_redacted IS NULL OR length(trim(failure_message_redacted)) > 0),
  sanitized_failure JSONB
    CHECK (sanitized_failure IS NULL OR jsonb_typeof(sanitized_failure) = 'object'),
  started_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_plan_proposals_source_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, source_message_id)
    REFERENCES work_messages(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_proposals_output_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, output_message_id)
    REFERENCES work_messages(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_proposals_action_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, action_id)
    REFERENCES conversation_actions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_proposals_idempotency_unique
    UNIQUE (conversation_id, initiated_by_user_id, idempotency_key),
  CONSTRAINT conversation_plan_proposals_usage_request_unique UNIQUE (usage_request_id),
  CONSTRAINT conversation_plan_proposals_manifest_hash_check CHECK (
    context_manifest ? 'entries'
    AND context_manifest ? 'estimated_tokens'
  ),
  CONSTRAINT conversation_plan_proposals_usage_shape_check CHECK (
    (
      usage_status = 'exact'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND cache_read_tokens IS NOT NULL
      AND cache_write_tokens IS NOT NULL
      AND cost_usd IS NOT NULL
    )
    OR (
      usage_status IN ('pending', 'unavailable')
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND cache_read_tokens IS NULL
      AND cache_write_tokens IS NULL
      AND cost_usd IS NULL
    )
  ),
  CONSTRAINT conversation_plan_proposals_terminal_shape_check CHECK (
    (
      status = 'pending'
      AND output_message_id IS NULL
      AND action_id IS NULL
      AND plan_content_hash IS NULL
      AND failure_code IS NULL
      AND failure_message_redacted IS NULL
      AND sanitized_failure IS NULL
      AND settled_at IS NULL
    )
    OR (
      status = 'succeeded'
      AND output_message_id IS NOT NULL
      AND action_id IS NOT NULL
      AND plan_content_hash IS NOT NULL
      AND failure_code IS NULL
      AND failure_message_redacted IS NULL
      AND sanitized_failure IS NULL
      AND settled_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND output_message_id IS NULL
      AND action_id IS NULL
      AND plan_content_hash IS NULL
      AND failure_code IS NOT NULL
      AND failure_message_redacted IS NOT NULL
      AND settled_at IS NOT NULL
    )
  )
);
CREATE INDEX conversation_plan_proposals_conversation_time_idx
  ON conversation_plan_proposal_attempts(conversation_id, created_at, id);
CREATE UNIQUE INDEX conversation_plan_proposals_one_pending_per_conversation
  ON conversation_plan_proposal_attempts(conversation_id)
  WHERE status='pending';

CREATE FUNCTION norns_guard_conversation_plan_proposal_attempt()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_fingerprint <> OLD.request_fingerprint
     OR NEW.source_message_id <> OLD.source_message_id
     OR NEW.provider <> OLD.provider
     OR NEW.model <> OLD.model
     OR NEW.usage_request_id <> OLD.usage_request_id
     OR NEW.retry_attempt <> OLD.retry_attempt
     OR NEW.context_manifest <> OLD.context_manifest
     OR NEW.context_hash <> OLD.context_hash
     OR NEW.started_at <> OLD.started_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation plan proposal request identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'invalid conversation plan proposal lifecycle transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_plan_proposals_lifecycle_guard
  BEFORE UPDATE ON conversation_plan_proposal_attempts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_plan_proposal_attempt();

CREATE TABLE conversation_plan_change_proposals (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  plan_version_id TEXT NOT NULL,
  plan_content_hash TEXT NOT NULL CHECK (plan_content_hash ~ '^[a-f0-9]{64}$'),
  direction TEXT NOT NULL CHECK (
    char_length(trim(direction)) BETWEEN 1 AND 2000
  ),
  direction_hash TEXT NOT NULL CHECK (direction_hash ~ '^[a-f0-9]{64}$'),
  message_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_plan_change_proposals_plan_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, plan_version_id)
    REFERENCES work_plan_versions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_change_proposals_message_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, message_id)
    REFERENCES work_messages(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_change_proposals_action_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, action_id)
    REFERENCES conversation_actions(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_plan_change_proposals_idempotency_unique
    UNIQUE (conversation_id, initiated_by_user_id, idempotency_key)
);
CREATE INDEX conversation_plan_change_proposals_conversation_time_idx
  ON conversation_plan_change_proposals(conversation_id, created_at, id);

CREATE FUNCTION norns_validate_conversation_plan_change_proposal()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  proposed_action conversation_actions%ROWTYPE;
  source_message work_messages%ROWTYPE;
BEGIN
  SELECT * INTO proposed_action FROM conversation_actions WHERE id=NEW.action_id;
  SELECT * INTO source_message FROM work_messages WHERE id=NEW.message_id;
  IF proposed_action.action_type <> 'request_plan_changes'
     OR proposed_action.status <> 'proposed'
     OR proposed_action.source_message_id <> NEW.message_id
     OR proposed_action.initiated_by_user_id <> NEW.initiated_by_user_id
     OR proposed_action.actor_type <> 'human'
     OR proposed_action.actor_id <> NEW.initiated_by_user_id
     OR proposed_action.payload->'parameters'->>'plan_version_id' <> NEW.plan_version_id
     OR proposed_action.payload->'parameters'->>'content_hash' <> NEW.plan_content_hash
     OR proposed_action.payload->'parameters'->>'direction' <> NEW.direction
     OR source_message.role <> 'user'
     OR source_message.actor_type <> 'human'
     OR source_message.actor_id <> NEW.initiated_by_user_id THEN
    RAISE EXCEPTION 'plan-change proposal action/message does not match immutable intent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_plan_change_proposals_scope_guard
  BEFORE INSERT ON conversation_plan_change_proposals
  FOR EACH ROW EXECUTE FUNCTION norns_validate_conversation_plan_change_proposal();

-- A provider/runtime failure is not a request for plan changes. Permit the
-- reviewed immutable candidate to return to candidate only when the same
-- transaction has already recorded a failed linked review.
CREATE OR REPLACE FUNCTION norns_guard_work_plan_version_update()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.version <> OLD.version
     OR NEW.plan <> OLD.plan
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.supersedes_plan_version_id IS DISTINCT FROM OLD.supersedes_plan_version_id
     OR NEW.diff_from_previous IS DISTINCT FROM OLD.diff_from_previous
     OR NEW.created_by_action_id IS DISTINCT FROM OLD.created_by_action_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan version content, hash, lineage, and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'in_qc' AND NEW.status = 'candidate' THEN
    IF EXISTS (
      SELECT 1
        FROM conversation_plan_reviews review
       WHERE review.plan_version_id = OLD.id
         AND review.status IN ('queued', 'running')
    ) OR (
      SELECT review.status
        FROM conversation_plan_reviews review
       WHERE review.plan_version_id = OLD.id
       ORDER BY review.attempt_number DESC
       LIMIT 1
    ) IS DISTINCT FROM 'failed' THEN
      RAISE EXCEPTION
        'in-QC plans return to candidate only after the latest linked review failed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'candidate' AND NEW.status = 'approved' AND NOT EXISTS (
    SELECT 1
      FROM conversation_plan_reviews review
     WHERE review.revised_plan_version_id = OLD.id
       AND review.result_plan_content_hash = OLD.content_hash
       AND review.status IN ('converged', 'cap_reached')
  ) THEN
    RAISE EXCEPTION 'candidate approval requires an exact successful QC result revision'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (
      OLD.status = 'candidate'
      AND NEW.status IN (
        'in_qc', 'changes_requested', 'approved', 'rejected', 'superseded'
      )
    )
    OR (
      OLD.status = 'in_qc'
      AND NEW.status IN ('candidate', 'changes_requested', 'approved', 'rejected')
    )
    OR (OLD.status = 'changes_requested' AND NEW.status IN ('rejected', 'superseded'))
    OR (OLD.status = 'rejected' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'invalid plan version status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'approved'
     AND (
       NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     ) THEN
    RAISE EXCEPTION 'approved plan attribution is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;

REVOKE ALL PRIVILEGES ON
  conversation_plan_reviews,
  conversation_plan_action_effects,
  conversation_plan_proposal_attempts,
  conversation_plan_change_proposals
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  conversation_plan_reviews,
  conversation_plan_action_effects,
  conversation_plan_proposal_attempts,
  conversation_plan_change_proposals
FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON
  conversation_plan_reviews,
  conversation_plan_action_effects,
  conversation_plan_proposal_attempts
TO norns_app;
GRANT SELECT, INSERT ON conversation_plan_change_proposals TO norns_app;
