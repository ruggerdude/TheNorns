-- Conversation-first work Phase 1: durable, project-scoped conversation
-- contracts. This migration creates only the persistence foundation; provider
-- streaming and HTTP/UI integration arrive in later phases.

DO $conversation_domain_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM norns_schema_migrations
    WHERE name = '0034_shadow_evidence_order'
  ) THEN
    RAISE EXCEPTION
      '0035_conversation_domain requires 0034_shadow_evidence_order'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_domain_dependency$;

CREATE UNIQUE INDEX planning_runs_project_identity_unique
  ON planning_runs(project_id, id);
CREATE UNIQUE INDEX attachments_project_identity_unique
  ON attachments(project_id, id);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL
    REFERENCES projects(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  objective TEXT NOT NULL CHECK (length(trim(objective)) > 0),
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN (
      'planning',
      'in_qc',
      'awaiting_approval',
      'executing',
      'blocked',
      'completed',
      'cancelled'
    )),
  planning_run_id TEXT,
  phase_id TEXT,
  approved_plan_version_id TEXT,
  aggregate_version INTEGER NOT NULL DEFAULT 1
    CHECK (aggregate_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  execution_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT work_items_planning_run_scope_fk
    FOREIGN KEY (project_id, planning_run_id)
    REFERENCES planning_runs(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_phase_scope_fk
    FOREIGN KEY (project_id, phase_id)
    REFERENCES phases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_items_project_identity_unique
    UNIQUE (project_id, id),
  CONSTRAINT work_items_completion_shape_check CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT work_items_execution_shape_check CHECK (
    (
      status NOT IN ('executing', 'blocked', 'completed')
      OR (phase_id IS NOT NULL AND execution_started_at IS NOT NULL)
    )
    AND (execution_started_at IS NULL OR phase_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX work_items_planning_run_unique
  ON work_items(project_id, planning_run_id)
  WHERE planning_run_id IS NOT NULL;
CREATE INDEX work_items_project_status_time_idx
  ON work_items(project_id, status, created_at DESC, id);
CREATE INDEX work_items_user_time_idx
  ON work_items(created_by_user_id, created_at DESC, id);
CREATE INDEX work_items_phase_idx
  ON work_items(project_id, phase_id)
  WHERE phase_id IS NOT NULL;

CREATE TABLE work_conversations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL
    CHECK (kind IN ('planning', 'execution_pm', 'task')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'closed')),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  next_message_sequence BIGINT NOT NULL DEFAULT 1
    CHECK (next_message_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT work_conversations_work_item_scope_fk
    FOREIGN KEY (project_id, work_item_id)
    REFERENCES work_items(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_conversations_project_work_identity_unique
    UNIQUE (project_id, work_item_id, id),
  CONSTRAINT work_conversations_archive_shape_check
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE INDEX work_conversations_project_time_idx
  ON work_conversations(project_id, created_at DESC, id);
CREATE INDEX work_conversations_work_item_status_idx
  ON work_conversations(work_item_id, status, kind, created_at DESC, id);
CREATE INDEX work_conversations_user_time_idx
  ON work_conversations(created_by_user_id, created_at DESC, id);
CREATE UNIQUE INDEX work_conversations_one_active_primary_kind
  ON work_conversations(work_item_id, kind)
  WHERE status = 'active' AND kind IN ('planning', 'execution_pm');

CREATE FUNCTION norns_guard_conversation_identity()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.kind <> OLD.kind
     OR NEW.provider <> OLD.provider
     OR NEW.model <> OLD.model
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation identity and provider/model pin are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER work_conversations_identity_guard
  BEFORE UPDATE ON work_conversations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_identity();

CREATE TABLE work_messages (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('human', 'coordinator', 'agent', 'runner', 'system', 'legacy')),
  actor_id TEXT,
  role TEXT NOT NULL
    CHECK (role IN ('user', 'assistant', 'system')),
  visibility_status TEXT NOT NULL DEFAULT 'complete'
    CHECK (visibility_status IN ('streaming', 'complete', 'interrupted')),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  parts JSONB NOT NULL,
  client_message_id TEXT,
  request_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_messages_conversation_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT work_messages_project_work_conversation_identity_unique
    UNIQUE (project_id, work_item_id, conversation_id, id),
  CONSTRAINT work_messages_sequence_unique
    UNIQUE (conversation_id, sequence),
  CONSTRAINT work_messages_submission_shape_check
    CHECK (
      (
        role = 'user'
        AND visibility_status = 'complete'
        AND actor_type = 'human'
        AND actor_id = initiated_by_user_id
        AND client_message_id IS NOT NULL
        AND request_fingerprint IS NOT NULL
        AND request_fingerprint ~ '^[a-f0-9]{64}$'
      )
      OR
      (
        role <> 'user'
        AND client_message_id IS NULL
        AND request_fingerprint IS NULL
      )
    ),
  CONSTRAINT work_messages_visibility_shape_check
    CHECK (visibility_status <> 'streaming' OR role = 'assistant'),
  CONSTRAINT work_messages_human_actor_check
    CHECK (actor_type <> 'human' OR actor_id IS NOT NULL),
  CONSTRAINT work_messages_parts_shape_check
    CHECK (
      jsonb_typeof(parts) = 'array'
      AND jsonb_array_length(parts) > 0
    )
);
CREATE UNIQUE INDEX work_messages_user_submission_unique
  ON work_messages(conversation_id, initiated_by_user_id, client_message_id)
  WHERE role = 'user';
CREATE INDEX work_messages_conversation_order_idx
  ON work_messages(conversation_id, sequence);
CREATE INDEX work_messages_project_time_idx
  ON work_messages(project_id, created_at DESC, id);
CREATE INDEX work_messages_user_time_idx
  ON work_messages(initiated_by_user_id, created_at DESC, id);

CREATE FUNCTION norns_guard_visible_message_parts()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  part JSONB;
  part_type TEXT;
BEGIN
  FOR part IN SELECT value FROM jsonb_array_elements(NEW.parts)
  LOOP
    IF jsonb_typeof(part) <> 'object' THEN
      RAISE EXCEPTION 'message parts must be objects'
        USING ERRCODE = '23514';
    END IF;
    part_type := part->>'type';
    IF part_type IS NULL OR part_type NOT IN (
      'text', 'code', 'attachment', 'artifact', 'action', 'plan'
    ) THEN
      RAISE EXCEPTION 'message part type % is not user-visible', part_type
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER work_messages_visible_parts_guard
  BEFORE INSERT OR UPDATE OF parts ON work_messages
  FOR EACH ROW EXECUTE FUNCTION norns_guard_visible_message_parts();

CREATE FUNCTION norns_guard_work_message_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.role = 'user' THEN
    RAISE EXCEPTION 'user messages are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.role <> OLD.role THEN
      RAISE EXCEPTION 'message role is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.role = 'user' THEN
      RAISE EXCEPTION 'user messages are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.visibility_status <> 'streaming' THEN
      RAISE EXCEPTION 'finalized visible messages are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.project_id <> OLD.project_id
       OR NEW.work_item_id <> OLD.work_item_id
       OR NEW.conversation_id <> OLD.conversation_id
       OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
       OR NEW.actor_type <> OLD.actor_type
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.sequence <> OLD.sequence
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'message identity and ordering are immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$guard$;
CREATE TRIGGER work_messages_mutation_guard
  BEFORE UPDATE OR DELETE ON work_messages
  FOR EACH ROW EXECUTE FUNCTION norns_guard_work_message_mutation();
CREATE TRIGGER work_messages_immutable_truncate_guard
  BEFORE TRUNCATE ON work_messages
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

CREATE TABLE work_message_attachment_refs (
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, attachment_id),
  CONSTRAINT work_message_attachment_refs_message_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id, message_id)
    REFERENCES work_messages(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT work_message_attachment_refs_attachment_scope_fk
    FOREIGN KEY (project_id, attachment_id)
    REFERENCES attachments(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX work_message_attachment_refs_attachment_idx
  ON work_message_attachment_refs(project_id, attachment_id, message_id);
CREATE INDEX work_message_attachment_refs_user_time_idx
  ON work_message_attachment_refs(created_by_user_id, created_at DESC, message_id);

-- Reference creation and attachment tombstoning must contend on the same row.
-- Without this immediate lock, PostgreSQL snapshot isolation permits a ref
-- insert and a concurrent tombstone to each miss the other's uncommitted write.
CREATE FUNCTION norns_lock_live_attachment_for_message_ref()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  PERFORM 1
    FROM attachments attachment
   WHERE attachment.project_id = NEW.project_id
     AND attachment.id = NEW.attachment_id
     AND attachment.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message attachment parts require durable live references'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER work_message_attachment_refs_live_attachment_lock
  BEFORE INSERT ON work_message_attachment_refs
  FOR EACH ROW EXECUTE FUNCTION norns_lock_live_attachment_for_message_ref();

CREATE FUNCTION norns_validate_message_attachment_refs()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  target_project_id TEXT;
  target_work_item_id TEXT;
  target_conversation_id TEXT;
  target_message_id TEXT;
  message_parts JSONB;
BEGIN
  IF TG_TABLE_NAME = 'work_messages' THEN
    target_project_id := NEW.project_id;
    target_work_item_id := NEW.work_item_id;
    target_conversation_id := NEW.conversation_id;
    target_message_id := NEW.id;
    message_parts := NEW.parts;
  ELSE
    target_project_id := NEW.project_id;
    target_work_item_id := NEW.work_item_id;
    target_conversation_id := NEW.conversation_id;
    target_message_id := NEW.message_id;
    SELECT parts INTO message_parts
      FROM work_messages
     WHERE project_id = target_project_id
       AND work_item_id = target_work_item_id
       AND conversation_id = target_conversation_id
       AND id = target_message_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(message_parts) part
     WHERE part->>'type' = 'attachment'
       AND (
         NOT EXISTS (
           SELECT 1
             FROM work_message_attachment_refs ref
            WHERE ref.project_id = target_project_id
              AND ref.work_item_id = target_work_item_id
              AND ref.conversation_id = target_conversation_id
              AND ref.message_id = target_message_id
              AND ref.attachment_id = part->>'attachment_id'
         )
         OR NOT EXISTS (
           SELECT 1
             FROM attachments attachment
            WHERE attachment.project_id = target_project_id
              AND attachment.id = part->>'attachment_id'
              AND attachment.deleted_at IS NULL
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM work_message_attachment_refs ref
     WHERE ref.project_id = target_project_id
       AND ref.work_item_id = target_work_item_id
       AND ref.conversation_id = target_conversation_id
       AND ref.message_id = target_message_id
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(message_parts) part
          WHERE part->>'type' = 'attachment'
            AND part->>'attachment_id' = ref.attachment_id
       )
  ) THEN
    RAISE EXCEPTION 'message attachment parts and durable live references must match'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE CONSTRAINT TRIGGER work_messages_attachment_refs_guard
  AFTER INSERT OR UPDATE OF parts ON work_messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_validate_message_attachment_refs();
CREATE CONSTRAINT TRIGGER work_message_attachment_refs_guard
  AFTER INSERT ON work_message_attachment_refs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_validate_message_attachment_refs();

CREATE FUNCTION norns_retain_conversation_attachment()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF (
    TG_OP = 'DELETE'
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  ) AND EXISTS (
    SELECT 1
      FROM work_message_attachment_refs ref
     WHERE ref.project_id = OLD.project_id
       AND ref.attachment_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'conversation-referenced attachments cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$guard$;
CREATE TRIGGER attachments_conversation_retention_guard
  BEFORE UPDATE OF deleted_at OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION norns_retain_conversation_attachment();

CREATE TRIGGER work_message_attachment_refs_immutable_guard
  BEFORE UPDATE OR DELETE ON work_message_attachment_refs
  FOR EACH ROW EXECUTE FUNCTION norns_reject_append_only_mutation();
CREATE TRIGGER work_message_attachment_refs_immutable_truncate_guard
  BEFORE TRUNCATE ON work_message_attachment_refs
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_append_only_mutation();

CREATE TABLE conversation_turn_attempts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('human', 'coordinator', 'agent', 'runner', 'system', 'legacy')),
  actor_id TEXT,
  triggering_message_id TEXT NOT NULL,
  output_message_id TEXT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  provider_request_id TEXT
    CHECK (provider_request_id IS NULL OR length(trim(provider_request_id)) > 0),
  usage_request_id TEXT NOT NULL CHECK (length(trim(usage_request_id)) > 0),
  provider_finish_reason TEXT
    CHECK (provider_finish_reason IS NULL OR length(trim(provider_finish_reason)) > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'streaming', 'succeeded', 'failed', 'cancelled')),
  context_manifest JSONB NOT NULL,
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  usage_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (usage_status IN ('pending', 'exact', 'unavailable')),
  input_tokens BIGINT CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens BIGINT CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens BIGINT CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_usd NUMERIC(24,9) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  failure_code TEXT CHECK (failure_code IS NULL OR length(trim(failure_code)) > 0),
  failure_message_redacted TEXT
    CHECK (
      failure_message_redacted IS NULL
      OR length(trim(failure_message_redacted)) > 0
    ),
  sanitized_failure JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_turn_attempts_conversation_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_turn_attempts_trigger_message_scope_fk
    FOREIGN KEY (
      project_id, work_item_id, conversation_id, triggering_message_id
    )
    REFERENCES work_messages(
      project_id, work_item_id, conversation_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT conversation_turn_attempts_output_message_scope_fk
    FOREIGN KEY (
      project_id, work_item_id, conversation_id, output_message_id
    )
    REFERENCES work_messages(
      project_id, work_item_id, conversation_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT conversation_turn_attempts_retry_unique
    UNIQUE (conversation_id, triggering_message_id, attempt_number),
  CONSTRAINT conversation_turn_attempts_human_actor_check
    CHECK (actor_type <> 'human' OR actor_id IS NOT NULL),
  CONSTRAINT conversation_turn_attempts_context_shape_check
    CHECK (
      jsonb_typeof(context_manifest) = 'object'
      AND jsonb_typeof(context_manifest->'entries') = 'array'
      AND jsonb_typeof(context_manifest->'estimated_tokens') = 'number'
    ),
  CONSTRAINT conversation_turn_attempts_terminal_shape_check
    CHECK (
      (status IN ('succeeded', 'failed', 'cancelled')) = (settled_at IS NOT NULL)
    ),
  CONSTRAINT conversation_turn_attempts_usage_shape_check
    CHECK (
      (
        usage_status = 'exact'
        AND input_tokens IS NOT NULL
        AND output_tokens IS NOT NULL
        AND cache_read_tokens IS NOT NULL
        AND cache_write_tokens IS NOT NULL
      )
      OR
      (
        usage_status <> 'exact'
        AND input_tokens IS NULL
        AND output_tokens IS NULL
        AND cache_read_tokens IS NULL
        AND cache_write_tokens IS NULL
        AND cost_usd IS NULL
      )
    ),
  CONSTRAINT conversation_turn_attempts_terminal_usage_check
    CHECK (
      status NOT IN ('succeeded', 'failed', 'cancelled')
      OR usage_status <> 'pending'
    ),
  CONSTRAINT conversation_turn_attempts_failure_shape_check
    CHECK (
      (
        status = 'failed'
        AND failure_code IS NOT NULL
      )
      OR
      (
        status <> 'failed'
        AND failure_code IS NULL
        AND failure_message_redacted IS NULL
        AND sanitized_failure IS NULL
      )
    ),
  CONSTRAINT conversation_turn_attempts_success_output_check
    CHECK (status <> 'succeeded' OR output_message_id IS NOT NULL),
  CONSTRAINT conversation_turn_attempts_success_finish_reason_check
    CHECK (status <> 'succeeded' OR provider_finish_reason IS NOT NULL),
  CONSTRAINT conversation_turn_attempts_sanitized_failure_check
    CHECK (
      sanitized_failure IS NULL
      OR jsonb_typeof(sanitized_failure) = 'object'
    )
);
CREATE UNIQUE INDEX conversation_turn_attempts_provider_request_unique
  ON conversation_turn_attempts(provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;
CREATE INDEX conversation_turn_attempts_conversation_time_idx
  ON conversation_turn_attempts(conversation_id, created_at DESC, id);
CREATE INDEX conversation_turn_attempts_project_time_idx
  ON conversation_turn_attempts(project_id, created_at DESC, id);
CREATE INDEX conversation_turn_attempts_user_time_idx
  ON conversation_turn_attempts(initiated_by_user_id, created_at DESC, id);
CREATE UNIQUE INDEX conversation_turn_attempts_usage_request_unique
  ON conversation_turn_attempts(usage_request_id);

CREATE FUNCTION norns_guard_turn_attempt_conversation_pin()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  pinned_provider TEXT;
  pinned_model TEXT;
BEGIN
  SELECT provider, model INTO pinned_provider, pinned_model
    FROM work_conversations
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.conversation_id;
  IF pinned_provider IS NULL
     OR NEW.provider <> pinned_provider
     OR NEW.model <> pinned_model THEN
    RAISE EXCEPTION 'turn attempt must use the conversation-pinned provider and model'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_turn_attempts_provider_model_guard
  BEFORE INSERT OR UPDATE OF provider, model, conversation_id
  ON conversation_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_turn_attempt_conversation_pin();

CREATE FUNCTION norns_guard_turn_attempt_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
     OR NEW.actor_type <> OLD.actor_type
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.triggering_message_id <> OLD.triggering_message_id
     OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.provider <> OLD.provider
     OR NEW.model <> OLD.model
     OR NEW.usage_request_id <> OLD.usage_request_id
     OR NEW.context_manifest <> OLD.context_manifest
     OR NEW.context_hash <> OLD.context_hash
     OR NEW.started_at <> OLD.started_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'turn attempt identity, context, provider, and request scope are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.provider_request_id IS DISTINCT FROM NEW.provider_request_id
     AND NOT (
       OLD.status = 'pending'
       AND NEW.status = 'streaming'
       AND OLD.provider_request_id IS NULL
       AND NEW.provider_request_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'turn attempt provider request identity is immutable once dispatched'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'terminal turn attempts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('streaming', 'failed', 'cancelled'))
    OR
    (OLD.status = 'streaming' AND NEW.status IN ('succeeded', 'failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid turn attempt status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status AND (
    NEW.output_message_id IS DISTINCT FROM OLD.output_message_id
    OR NEW.provider_finish_reason IS DISTINCT FROM OLD.provider_finish_reason
    OR NEW.usage_status <> OLD.usage_status
    OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens
    OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens
    OR NEW.cache_read_tokens IS DISTINCT FROM OLD.cache_read_tokens
    OR NEW.cache_write_tokens IS DISTINCT FROM OLD.cache_write_tokens
    OR NEW.cost_usd IS DISTINCT FROM OLD.cost_usd
    OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
    OR NEW.failure_message_redacted IS DISTINCT FROM OLD.failure_message_redacted
    OR NEW.sanitized_failure IS DISTINCT FROM OLD.sanitized_failure
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
  ) THEN
    RAISE EXCEPTION 'turn attempt audit fields change only at a lifecycle transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_turn_attempts_lifecycle_guard
  BEFORE UPDATE ON conversation_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_turn_attempt_lifecycle();

CREATE FUNCTION norns_validate_turn_attempt_usage_request()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  started_event ai_usage_events%ROWTYPE;
BEGIN
  SELECT * INTO started_event
    FROM ai_usage_events usage_event
   WHERE usage_event.request_id = NEW.usage_request_id
     AND usage_event.event_type = 'request_started'
   LIMIT 1;
  IF started_event.id IS NULL THEN
    RAISE EXCEPTION 'turn attempt usage request % has no canonical telemetry start event',
      NEW.usage_request_id
      USING ERRCODE = '23503';
  END IF;
  IF started_event.project_id IS DISTINCT FROM NEW.project_id
     OR started_event.initiated_by_user_id IS DISTINCT FROM NEW.initiated_by_user_id
     OR started_event.provider <> NEW.provider
     OR started_event.model <> NEW.model
     OR started_event.request_type <> 'conversation_turn' THEN
    RAISE EXCEPTION 'turn attempt usage request % attribution does not match conversation scope',
      NEW.usage_request_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE CONSTRAINT TRIGGER conversation_turn_attempts_usage_request_guard
  AFTER INSERT OR UPDATE OF usage_request_id ON conversation_turn_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_validate_turn_attempt_usage_request();

CREATE TABLE conversation_actions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  initiated_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('human', 'coordinator', 'agent', 'runner', 'system', 'legacy')),
  actor_id TEXT,
  source_message_id TEXT NOT NULL,
  action_type TEXT NOT NULL
    CHECK (action_type IN (
      'save_plan_candidate',
      'send_plan_to_qc',
      'request_plan_changes',
      'approve_plan',
      'reject_plan',
      'pause_work',
      'resume_work',
      'redirect_agent',
      'create_mockup',
      'approve_mockup',
      'revise_mockup',
      'reject_mockup'
    )),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN (
      'proposed',
      'confirmed',
      'recorded',
      'sent',
      'agent_acknowledged',
      'applied',
      'rejected',
      'failed'
    )),
  confirmed_by_user_id TEXT
    REFERENCES users(id) ON DELETE RESTRICT,
  confirmation_idempotency_key TEXT,
  confirmation_request_fingerprint TEXT,
  confirmed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  failure_code TEXT CHECK (failure_code IS NULL OR length(trim(failure_code)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_actions_source_message_scope_fk
    FOREIGN KEY (
      project_id, work_item_id, conversation_id, source_message_id
    )
    REFERENCES work_messages(
      project_id, work_item_id, conversation_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT conversation_actions_payload_shape_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT conversation_actions_human_actor_check
    CHECK (actor_type <> 'human' OR actor_id IS NOT NULL),
  CONSTRAINT conversation_actions_confirmation_shape_check
    CHECK (
      (
        status IN (
          'confirmed', 'recorded', 'sent', 'agent_acknowledged', 'applied', 'failed'
        )
        AND confirmed_by_user_id IS NOT NULL
        AND confirmation_idempotency_key IS NOT NULL
        AND confirmation_request_fingerprint ~ '^[a-f0-9]{64}$'
        AND confirmed_at IS NOT NULL
      )
      OR
      (
        status IN ('proposed', 'rejected')
        AND confirmed_by_user_id IS NULL
        AND confirmation_idempotency_key IS NULL
        AND confirmation_request_fingerprint IS NULL
        AND confirmed_at IS NULL
      )
    ),
  CONSTRAINT conversation_actions_delivery_shape_check
    CHECK (
      (
        status IN ('proposed', 'confirmed', 'rejected')
        AND recorded_at IS NULL
        AND sent_at IS NULL
        AND acknowledged_at IS NULL
        AND applied_at IS NULL
      )
      OR (
        status = 'recorded'
        AND recorded_at IS NOT NULL
        AND sent_at IS NULL
        AND acknowledged_at IS NULL
        AND applied_at IS NULL
      )
      OR (
        status = 'sent'
        AND recorded_at IS NOT NULL
        AND sent_at IS NOT NULL
        AND acknowledged_at IS NULL
        AND applied_at IS NULL
      )
      OR (
        status = 'agent_acknowledged'
        AND recorded_at IS NOT NULL
        AND sent_at IS NOT NULL
        AND acknowledged_at IS NOT NULL
        AND applied_at IS NULL
      )
      OR (
        status = 'applied'
        AND recorded_at IS NOT NULL
        AND sent_at IS NOT NULL
        AND acknowledged_at IS NOT NULL
        AND applied_at IS NOT NULL
      )
      OR (
        status = 'failed'
        AND applied_at IS NULL
        AND (sent_at IS NULL OR recorded_at IS NOT NULL)
        AND (acknowledged_at IS NULL OR sent_at IS NOT NULL)
      )
    ),
  CONSTRAINT conversation_actions_failure_shape_check CHECK (
      ((status = 'failed') = (failure_code IS NOT NULL))
  )
);
CREATE UNIQUE INDEX conversation_actions_confirmation_idempotency_unique
  ON conversation_actions(
    conversation_id, confirmed_by_user_id, confirmation_idempotency_key
  )
  WHERE confirmation_idempotency_key IS NOT NULL;
CREATE INDEX conversation_actions_conversation_status_idx
  ON conversation_actions(conversation_id, status, created_at, id);
CREATE INDEX conversation_actions_project_status_idx
  ON conversation_actions(project_id, status, created_at, id);
CREATE INDEX conversation_actions_user_time_idx
  ON conversation_actions(initiated_by_user_id, created_at DESC, id);

CREATE FUNCTION norns_guard_conversation_action_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.initiated_by_user_id <> OLD.initiated_by_user_id
     OR NEW.actor_type <> OLD.actor_type
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.source_message_id <> OLD.source_message_id
     OR NEW.action_type <> OLD.action_type
     OR NEW.payload <> OLD.payload
     OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation action proposal identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'proposed' AND NEW.status IN ('confirmed', 'rejected'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('recorded', 'failed'))
    OR (OLD.status = 'recorded' AND NEW.status IN ('sent', 'failed'))
    OR (OLD.status = 'sent' AND NEW.status IN ('agent_acknowledged', 'failed'))
    OR (OLD.status = 'agent_acknowledged' AND NEW.status IN ('applied', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid conversation action status transition % -> %',
      OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = OLD.status AND (
    NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
    OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
    OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
  ) THEN
    RAISE EXCEPTION 'conversation action delivery evidence changes only with status'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'proposed' AND (
    NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
    OR NEW.confirmation_idempotency_key IS DISTINCT FROM OLD.confirmation_idempotency_key
    OR NEW.confirmation_request_fingerprint IS DISTINCT FROM OLD.confirmation_request_fingerprint
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
  ) THEN
    RAISE EXCEPTION 'conversation action confirmation attribution is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.recorded_at IS NOT NULL AND NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at
     OR OLD.acknowledged_at IS NOT NULL
        AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
     OR OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at
     OR OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
    RAISE EXCEPTION 'conversation action delivery evidence is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('applied', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'terminal conversation actions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_actions_lifecycle_guard
  BEFORE UPDATE ON conversation_actions
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_action_lifecycle();

CREATE TABLE work_plan_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL
    CHECK (status IN (
      'candidate',
      'in_qc',
      'changes_requested',
      'approved',
      'rejected',
      'superseded'
    )),
  plan JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  supersedes_plan_version_id TEXT,
  diff_from_previous JSONB,
  approved_by_user_id TEXT
    REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_plan_versions_conversation_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT work_plan_versions_version_unique
    UNIQUE (work_item_id, version),
  CONSTRAINT work_plan_versions_identity_unique
    UNIQUE (project_id, work_item_id, id),
  CONSTRAINT work_plan_versions_supersedes_scope_fk
    FOREIGN KEY (project_id, work_item_id, supersedes_plan_version_id)
    REFERENCES work_plan_versions(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT work_plan_versions_plan_shape_check
    CHECK (jsonb_typeof(plan) = 'object'),
  CONSTRAINT work_plan_versions_diff_shape_check
    CHECK (
      (version = 1 AND supersedes_plan_version_id IS NULL AND diff_from_previous IS NULL)
      OR
      (
        version > 1
        AND supersedes_plan_version_id IS NOT NULL
        AND jsonb_typeof(diff_from_previous) = 'object'
      )
    ),
  CONSTRAINT work_plan_versions_approval_shape_check
    CHECK (
      (
        status = 'approved'
        AND approved_by_user_id IS NOT NULL
        AND approved_at IS NOT NULL
      )
      OR
      (
        status <> 'approved'
        AND approved_by_user_id IS NULL
        AND approved_at IS NULL
      )
    )
);
CREATE INDEX work_plan_versions_work_item_time_idx
  ON work_plan_versions(work_item_id, version DESC);
CREATE INDEX work_plan_versions_project_status_idx
  ON work_plan_versions(project_id, status, created_at DESC, id);
CREATE INDEX work_plan_versions_user_time_idx
  ON work_plan_versions(created_by_user_id, created_at DESC, id);
CREATE UNIQUE INDEX work_plan_versions_one_approved_per_work_item
  ON work_plan_versions(work_item_id)
  WHERE status = 'approved';

CREATE FUNCTION norns_guard_work_plan_version_update()
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
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'plan version content, hash, lineage, and identity are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'candidate' AND NEW.status IN ('in_qc', 'rejected', 'superseded'))
    OR
    (OLD.status = 'in_qc' AND NEW.status IN ('changes_requested', 'approved', 'rejected'))
    OR
    (OLD.status = 'changes_requested' AND NEW.status = 'superseded')
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

CREATE TABLE conversation_handoffs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  target_conversation_id TEXT NOT NULL,
  approved_plan_version_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL
    CHECK (kind = 'planning_to_execution'),
  package JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_handoffs_source_scope_fk
    FOREIGN KEY (project_id, work_item_id, source_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_handoffs_target_scope_fk
    FOREIGN KEY (project_id, work_item_id, target_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_handoffs_approved_plan_scope_fk
    FOREIGN KEY (project_id, work_item_id, approved_plan_version_id)
    REFERENCES work_plan_versions(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_handoffs_transition_unique
    UNIQUE (source_conversation_id, target_conversation_id, kind),
  CONSTRAINT conversation_handoffs_approved_plan_unique
    UNIQUE (approved_plan_version_id),
  CONSTRAINT conversation_handoffs_distinct_conversations_check
    CHECK (source_conversation_id <> target_conversation_id),
  CONSTRAINT conversation_handoffs_package_shape_check
    CHECK (jsonb_typeof(package) = 'object')
);
CREATE INDEX conversation_handoffs_work_item_time_idx
  ON conversation_handoffs(work_item_id, created_at DESC, id);
CREATE INDEX conversation_handoffs_project_time_idx
  ON conversation_handoffs(project_id, created_at DESC, id);
CREATE INDEX conversation_handoffs_user_time_idx
  ON conversation_handoffs(created_by_user_id, created_at DESC, id);

CREATE FUNCTION norns_validate_conversation_handoff_plan()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  approved_plan work_plan_versions%ROWTYPE;
  approved_task_sequence JSONB;
BEGIN
  SELECT * INTO approved_plan
    FROM work_plan_versions
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.approved_plan_version_id;
  IF approved_plan.id IS NULL
     OR approved_plan.status <> 'approved'
     OR NEW.package->>'approved_plan_version_id' <> approved_plan.id
     OR NEW.package->>'approved_plan_content_hash' <> approved_plan.content_hash
     OR NEW.package->'approved_plan' IS DISTINCT FROM approved_plan.plan THEN
    RAISE EXCEPTION 'handoff must freeze the exact approved plan version and content'
      USING ERRCODE = '23514';
  END IF;
  SELECT jsonb_agg(module->'id' ORDER BY ordinal)
    INTO approved_task_sequence
    FROM jsonb_array_elements(approved_plan.plan->'plan'->'modules')
      WITH ORDINALITY AS planned_module(module, ordinal);
  IF NEW.package->>'objective' IS DISTINCT FROM approved_plan.plan->'plan'->>'objective'
     OR NEW.package->'staffing' IS DISTINCT FROM approved_plan.plan->'staffing'
     OR NEW.package->'budget' IS DISTINCT FROM approved_plan.plan->'estimated_budget'
     OR NEW.package->'task_sequence' IS DISTINCT FROM approved_task_sequence THEN
    RAISE EXCEPTION 'handoff objective, staffing, budget, and task sequence must project the approved plan'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_handoffs_approved_plan_guard
  BEFORE INSERT ON conversation_handoffs
  FOR EACH ROW EXECUTE FUNCTION norns_validate_conversation_handoff_plan();

CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  from_message_sequence BIGINT NOT NULL CHECK (from_message_sequence > 0),
  through_message_sequence BIGINT NOT NULL CHECK (through_message_sequence > 0),
  summary JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_summaries_conversation_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT conversation_summaries_version_unique
    UNIQUE (conversation_id, version),
  CONSTRAINT conversation_summaries_range_check
    CHECK (through_message_sequence >= from_message_sequence),
  CONSTRAINT conversation_summaries_summary_shape_check
    CHECK (jsonb_typeof(summary) = 'object')
);
CREATE INDEX conversation_summaries_conversation_version_idx
  ON conversation_summaries(conversation_id, version DESC);
CREATE INDEX conversation_summaries_project_time_idx
  ON conversation_summaries(project_id, created_at DESC, id);
CREATE INDEX conversation_summaries_user_time_idx
  ON conversation_summaries(created_by_user_id, created_at DESC, id);

CREATE FUNCTION norns_reject_conversation_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$guard$;

CREATE TRIGGER work_plan_versions_content_guard
  BEFORE UPDATE ON work_plan_versions
  FOR EACH ROW EXECUTE FUNCTION norns_guard_work_plan_version_update();

ALTER TABLE work_items
  ADD CONSTRAINT work_items_approved_plan_scope_fk
  FOREIGN KEY (project_id, id, approved_plan_version_id)
  REFERENCES work_plan_versions(project_id, work_item_id, id)
  ON DELETE RESTRICT;

CREATE FUNCTION norns_validate_work_item_approved_plan()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.approved_plan_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM work_plan_versions plan_version
     WHERE plan_version.project_id = NEW.project_id
       AND plan_version.work_item_id = NEW.id
       AND plan_version.id = NEW.approved_plan_version_id
       AND plan_version.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'work item approved plan pointer must reference its approved plan'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER work_items_approved_plan_guard
  BEFORE INSERT OR UPDATE OF approved_plan_version_id ON work_items
  FOR EACH ROW EXECUTE FUNCTION norns_validate_work_item_approved_plan();
CREATE TRIGGER work_plan_versions_delete_guard
  BEFORE DELETE ON work_plan_versions
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER work_plan_versions_immutable_truncate_guard
  BEFORE TRUNCATE ON work_plan_versions
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_handoffs_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_handoffs
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_handoffs_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_handoffs
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_summaries_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_summaries
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_summaries_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

REVOKE ALL PRIVILEGES ON
  work_items,
  work_conversations,
  work_messages,
  work_message_attachment_refs,
  conversation_turn_attempts,
  conversation_actions,
  work_plan_versions,
  conversation_handoffs,
  conversation_summaries
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  work_items,
  work_conversations,
  work_messages,
  work_message_attachment_refs,
  conversation_turn_attempts,
  conversation_actions,
  work_plan_versions,
  conversation_handoffs,
  conversation_summaries
FROM norns_app;

GRANT SELECT, INSERT, UPDATE ON
  work_items,
  work_conversations,
  work_messages,
  conversation_turn_attempts,
  conversation_actions,
  work_plan_versions
TO norns_app;
GRANT SELECT, INSERT ON
  work_message_attachment_refs,
  conversation_handoffs,
  conversation_summaries
TO norns_app;
