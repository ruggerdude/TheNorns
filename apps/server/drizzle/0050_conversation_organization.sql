-- Per-user conversation organization. A user-visible chat is a work-item
-- family; its planning, execution-PM, and task conversations remain durable
-- children. Folder membership and pinning are private presentation
-- preferences and do not mutate shared conversation history.

DO $conversation_organization_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0049_qc_control_and_transcript'
  ) THEN
    RAISE EXCEPTION
      '0050_conversation_organization requires 0049_qc_control_and_transcript'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_organization_dependency$;

CREATE TABLE conversation_folders (
  schema_version SMALLINT NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_folders_scope_identity_unique
    UNIQUE (project_id, user_id, id)
);

CREATE UNIQUE INDEX conversation_folders_scope_name_unique
  ON conversation_folders (project_id, user_id, lower(name));
CREATE INDEX conversation_folders_scope_order_idx
  ON conversation_folders (project_id, user_id, sort_order, id);

CREATE TABLE work_item_organization_preferences (
  schema_version SMALLINT NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  folder_id TEXT,
  pinned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id, work_item_id),
  CONSTRAINT work_item_organization_work_scope_fk
    FOREIGN KEY (project_id, work_item_id)
    REFERENCES work_items(project_id, id) ON DELETE CASCADE,
  CONSTRAINT work_item_organization_folder_scope_fk
    FOREIGN KEY (project_id, user_id, folder_id)
    REFERENCES conversation_folders(project_id, user_id, id) ON DELETE RESTRICT
);

CREATE INDEX work_item_organization_folder_idx
  ON work_item_organization_preferences (project_id, user_id, folder_id, work_item_id);
CREATE INDEX work_item_organization_pinned_idx
  ON work_item_organization_preferences (project_id, user_id, pinned_at DESC, work_item_id)
  WHERE pinned_at IS NOT NULL;

CREATE OR REPLACE FUNCTION norns_guard_conversation_folder_identity()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'conversation folder identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER conversation_folders_identity_guard
  BEFORE UPDATE ON conversation_folders
  FOR EACH ROW EXECUTE FUNCTION norns_guard_conversation_folder_identity();

CREATE OR REPLACE FUNCTION norns_guard_work_item_organization_identity()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.project_id <> OLD.project_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'work-item organization identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER work_item_organization_identity_guard
  BEFORE UPDATE ON work_item_organization_preferences
  FOR EACH ROW EXECUTE FUNCTION norns_guard_work_item_organization_identity();

CREATE VIEW conversation_organization_v1 AS
SELECT 1::SMALLINT AS schema_version;

REVOKE ALL PRIVILEGES ON
  conversation_folders,
  work_item_organization_preferences,
  conversation_organization_v1
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  conversation_folders,
  work_item_organization_preferences,
  conversation_organization_v1
FROM norns_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_folders TO norns_app;
GRANT SELECT, INSERT, UPDATE ON work_item_organization_preferences TO norns_app;
GRANT SELECT ON conversation_organization_v1 TO norns_app;
