-- Permanent project deletion is an explicit exception to the normal durable,
-- append-only evidence rules. Keep ordinary row deletion blocked, but allow a
-- security-definer entry point to erase one complete project graph.

CREATE OR REPLACE FUNCTION norns_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $append_only$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$append_only$;

CREATE OR REPLACE FUNCTION norns_reject_phase6_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$guard$;

CREATE OR REPLACE FUNCTION norns_reject_human_direction_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'human_directions is append-only' USING ERRCODE = '55000';
END;
$guard$;

CREATE OR REPLACE FUNCTION norns_reject_debate_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$guard$;

CREATE OR REPLACE FUNCTION norns_reject_conversation_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_work_message_mutation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
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

CREATE OR REPLACE FUNCTION norns_retain_conversation_attachment()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
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

CREATE OR REPLACE FUNCTION norns_reject_project_delivery_delete()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('norns.project_destroy', true) = 'on'
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'deployment observations are durable audit records'
    USING ERRCODE='23514';
END
$guard$;

-- Existing direct project references that were intentionally restrictive now
-- participate in the one-statement project cascade.
DO $project_foreign_keys$
DECLARE
  project_fk RECORD;
BEGIN
  FOR project_fk IN
    SELECT fk.conrelid::regclass AS table_name,
           fk.conname,
           pg_get_constraintdef(fk.oid) AS definition
      FROM pg_constraint fk
     WHERE fk.contype = 'f'
       AND fk.confrelid = 'projects'::regclass
       AND fk.confdeltype = 'r'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      project_fk.table_name,
      project_fk.conname
    );
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I %s',
      project_fk.table_name,
      project_fk.conname,
      replace(project_fk.definition, ' ON DELETE RESTRICT', ' ON DELETE CASCADE')
    );
  END LOOP;
END
$project_foreign_keys$;

-- Several newer project-owned tables are scoped through composite parent
-- keys. Add a direct cascade edge as well so every project row is scheduled
-- for deletion together, allowing their existing inter-table RESTRICT edges
-- to continue protecting ordinary child deletion.
DO $project_scoped_tables$
DECLARE
  scoped_table RECORD;
  constraint_name TEXT;
BEGIN
  FOR scoped_table IN
    SELECT c.oid::regclass AS table_name,
           c.relname,
           a.attname AS column_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
       AND a.attname IN ('project_id', 'scope_project_id')
       AND NOT a.attisdropped
     WHERE n.nspname = current_schema()
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND c.relname <> 'projects'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_constraint fk
          WHERE fk.contype = 'f'
            AND fk.conrelid = c.oid
            AND fk.confrelid = 'projects'::regclass
            AND a.attnum = ANY(fk.conkey)
       )
  LOOP
    constraint_name := format(
      'norns_project_destroy_%s_fk',
      substring(md5(scoped_table.relname || '.' || scoped_table.column_name), 1, 16)
    );
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES projects(id) ON DELETE CASCADE NOT VALID',
      scoped_table.table_name,
      constraint_name,
      scoped_table.column_name
    );
  END LOOP;
END
$project_scoped_tables$;

CREATE OR REPLACE FUNCTION norns_destroy_project(target_project_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $destroy$
DECLARE
  deleted_count INTEGER;
BEGIN
  PERFORM set_config('norns.project_destroy', 'on', true);

  DELETE FROM device_run_cancellations cancellation
   WHERE cancellation.run_id IN (
     SELECT run.id FROM agent_runs run WHERE run.project_id = target_project_id
   );
  DELETE FROM human_wait_continuations continuation
   WHERE continuation.wait_id IN (
     SELECT wait.id FROM human_waits wait WHERE wait.project_id = target_project_id
   );
  DELETE FROM usage_budget_threshold_notifications notification
   WHERE notification.policy_id IN (
     SELECT policy.id
       FROM usage_budget_policies policy
      WHERE policy.scope_project_id = target_project_id
   );

  DELETE FROM projects WHERE id = target_project_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count = 1;
END
$destroy$;

REVOKE ALL ON FUNCTION norns_destroy_project(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION norns_destroy_project(TEXT) TO norns_app;
