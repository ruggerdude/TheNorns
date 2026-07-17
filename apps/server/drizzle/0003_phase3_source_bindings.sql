-- Phase 3 begins with durable, opaque repository identities. Raw local paths,
-- GitHub tokens, and GitHub App private keys are intentionally absent.

CREATE UNIQUE INDEX IF NOT EXISTS repository_bindings_local_identity_unique
  ON repository_bindings (project_id, runner_id, workspace_id, repository_id)
  WHERE binding_type = 'local_runner';

CREATE UNIQUE INDEX IF NOT EXISTS repository_bindings_github_identity_unique
  ON repository_bindings (project_id, github_installation_id, repository_id)
  WHERE binding_type = 'github';

CREATE OR REPLACE FUNCTION norns_guard_repository_binding_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.binding_type IS DISTINCT FROM OLD.binding_type
     OR NEW.runner_id IS DISTINCT FROM OLD.runner_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.github_installation_id IS DISTINCT FROM OLD.github_installation_id
     OR NEW.github_owner IS DISTINCT FROM OLD.github_owner
     OR NEW.github_name IS DISTINCT FROM OLD.github_name
     OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'repository binding identity and provenance are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS repository_bindings_identity_guard ON repository_bindings;
CREATE TRIGGER repository_bindings_identity_guard
BEFORE UPDATE ON repository_bindings
FOR EACH ROW EXECUTE FUNCTION norns_guard_repository_binding_identity();
