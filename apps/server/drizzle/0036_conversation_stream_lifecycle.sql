-- Conversation-first work Phase 2: truthful provider dispatch before the first
-- visible token. A provider can accept a request (and assign its immutable
-- request ID) before it emits user-visible text. Phase 1 correctly prohibited
-- arbitrary in-place attempt mutation, but also prohibited attaching the
-- first visible output row after pending -> streaming. This narrow replacement
-- permits exactly that NULL -> non-NULL link while the attempt remains
-- streaming; every other identity/context/audit rule is unchanged.

DO $conversation_stream_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0035_conversation_domain'
  ) THEN
    RAISE EXCEPTION
      '0036_conversation_stream_lifecycle requires 0035_conversation_domain'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_stream_dependency$;

-- Runtime startup cannot read the privileged migration ledger. This stable,
-- read-only marker lets the ordinary application distinguish the Phase 2
-- streaming lifecycle from the otherwise table-identical Phase 1 domain.
CREATE VIEW conversation_stream_lifecycle_v1 AS
SELECT 1::INTEGER AS version;

REVOKE ALL ON conversation_stream_lifecycle_v1 FROM PUBLIC;
GRANT SELECT ON conversation_stream_lifecycle_v1 TO norns_app;

CREATE OR REPLACE FUNCTION norns_guard_visible_message_parts()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  part JSONB;
  part_type TEXT;
  visible_content TEXT;
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
    IF part_type IN ('text', 'code') THEN
      visible_content :=
        translate(
          regexp_replace(
            coalesce(part->>CASE WHEN part_type = 'text' THEN 'text' ELSE 'code' END, ''),
            '\s',
            '',
            'g'
          ),
          U&'\200B\200C\200D\2060\FEFF',
          ''
        );
      IF visible_content = '' THEN
        RAISE EXCEPTION 'visible text and code parts cannot be blank or zero-width-only'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_turn_attempt_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  attaches_first_visible_output BOOLEAN;
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

  attaches_first_visible_output :=
    OLD.status = 'streaming'
    AND NEW.status = 'streaming'
    AND OLD.output_message_id IS NULL
    AND NEW.output_message_id IS NOT NULL
    AND NEW.provider_finish_reason IS NOT DISTINCT FROM OLD.provider_finish_reason
    AND NEW.usage_status = OLD.usage_status
    AND NEW.input_tokens IS NOT DISTINCT FROM OLD.input_tokens
    AND NEW.output_tokens IS NOT DISTINCT FROM OLD.output_tokens
    AND NEW.cache_read_tokens IS NOT DISTINCT FROM OLD.cache_read_tokens
    AND NEW.cache_write_tokens IS NOT DISTINCT FROM OLD.cache_write_tokens
    AND NEW.cost_usd IS NOT DISTINCT FROM OLD.cost_usd
    AND NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code
    AND NEW.failure_message_redacted IS NOT DISTINCT FROM OLD.failure_message_redacted
    AND NEW.sanitized_failure IS NOT DISTINCT FROM OLD.sanitized_failure
    AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at;

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
  ) AND NOT attaches_first_visible_output THEN
    RAISE EXCEPTION 'turn attempt audit fields change only at a lifecycle transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
