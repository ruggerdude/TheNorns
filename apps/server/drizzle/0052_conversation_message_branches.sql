-- Append-only edit-and-resend lineage. The parent transcript remains
-- untouched; a branch conversation receives only a safe immutable prefix,
-- and the edited user content is submitted later through the normal message
-- route.

DO $conversation_message_branches_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0051_conversation_file_attachments'
  ) THEN
    RAISE EXCEPTION
      '0052_conversation_message_branches requires 0051_conversation_file_attachments'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_message_branches_dependency$;

ALTER TABLE work_conversations
  ADD COLUMN message_branch BOOLEAN NOT NULL DEFAULT false;

DROP INDEX work_conversations_one_active_primary_kind;
CREATE UNIQUE INDEX work_conversations_one_active_primary_kind
  ON work_conversations(work_item_id, kind)
  WHERE status = 'active' AND kind = 'execution_pm';
CREATE UNIQUE INDEX work_conversations_one_active_root_planning
  ON work_conversations(work_item_id, kind)
  WHERE status = 'active' AND kind = 'planning' AND message_branch = false;

CREATE TABLE conversation_message_branches (
  schema_version SMALLINT NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  child_conversation_id TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_message_branches_child_unique
    UNIQUE (child_conversation_id),
  CONSTRAINT conversation_message_branches_distinct_conversations
    CHECK (child_conversation_id <> parent_conversation_id),
  CONSTRAINT conversation_message_branches_child_scope_fk
    FOREIGN KEY (project_id, work_item_id, child_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_message_branches_parent_scope_fk
    FOREIGN KEY (project_id, work_item_id, parent_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_message_branches_source_scope_fk
    FOREIGN KEY (
      project_id,
      work_item_id,
      parent_conversation_id,
      source_message_id
    )
    REFERENCES work_messages(project_id, work_item_id, conversation_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX conversation_message_branches_parent_idx
  ON conversation_message_branches (
    project_id,
    work_item_id,
    parent_conversation_id,
    created_at DESC,
    id
  );
CREATE INDEX conversation_message_branches_user_idx
  ON conversation_message_branches (created_by_user_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION norns_validate_conversation_message_branch()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  parent work_conversations%ROWTYPE;
  child work_conversations%ROWTYPE;
  source work_messages%ROWTYPE;
BEGIN
  SELECT * INTO parent
    FROM work_conversations
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.parent_conversation_id;
  SELECT * INTO child
    FROM work_conversations
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.child_conversation_id;
  SELECT * INTO source
    FROM work_messages
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND conversation_id = NEW.parent_conversation_id
     AND id = NEW.source_message_id;

  IF parent.id IS NULL OR child.id IS NULL OR source.id IS NULL THEN
    RAISE EXCEPTION 'message branch lineage must remain in one conversation scope'
      USING ERRCODE = '23514';
  END IF;
  IF parent.kind <> 'planning'
     OR child.kind <> 'planning'
     OR parent.status <> 'active'
     OR child.status <> 'active'
     OR child.message_branch = false THEN
    RAISE EXCEPTION 'message branches require active planning conversations'
      USING ERRCODE = '23514';
  END IF;
  IF parent.provider <> child.provider OR parent.model <> child.model THEN
    RAISE EXCEPTION 'message branch must preserve its parent provider and model'
      USING ERRCODE = '23514';
  END IF;
  IF source.role <> 'user'
     OR source.actor_type <> 'human'
     OR source.visibility_status <> 'complete' THEN
    RAISE EXCEPTION 'message branch source must be a complete human user message'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER conversation_message_branches_scope_guard
  BEFORE INSERT ON conversation_message_branches
  FOR EACH ROW EXECUTE FUNCTION norns_validate_conversation_message_branch();

CREATE OR REPLACE FUNCTION norns_require_conversation_message_branch_lineage()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.message_branch AND NOT EXISTS (
    SELECT 1
      FROM conversation_message_branches branch
     WHERE branch.project_id = NEW.project_id
       AND branch.work_item_id = NEW.work_item_id
       AND branch.child_conversation_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'message-branch conversations require durable lineage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE CONSTRAINT TRIGGER work_conversations_message_branch_lineage_guard
  AFTER INSERT OR UPDATE OF message_branch ON work_conversations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_require_conversation_message_branch_lineage();

CREATE OR REPLACE FUNCTION norns_guard_conversation_message_branch_identity()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.message_branch <> OLD.message_branch THEN
    RAISE EXCEPTION 'conversation message-branch identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER work_conversations_message_branch_identity_guard
  BEFORE UPDATE ON work_conversations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_message_branch_identity();

CREATE TRIGGER conversation_message_branches_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_message_branches
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_message_branches_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_message_branches
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

CREATE VIEW conversation_message_branches_v1 AS
SELECT 1::SMALLINT AS schema_version;

REVOKE ALL PRIVILEGES ON
  conversation_message_branches,
  conversation_message_branches_v1
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  conversation_message_branches,
  conversation_message_branches_v1
FROM norns_app;

GRANT SELECT, INSERT ON conversation_message_branches TO norns_app;
GRANT SELECT ON conversation_message_branches_v1 TO norns_app;
