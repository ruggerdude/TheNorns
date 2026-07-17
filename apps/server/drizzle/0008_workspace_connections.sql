-- Workspace-scoped provider connections. Projects reference provider-owned
-- repository identities; reusable credentials remain at the integration
-- boundary and are never copied into project or repository-binding rows.

CREATE TABLE IF NOT EXISTS service_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT 'https://github.com',
  status TEXT NOT NULL DEFAULT 'connected',
  owner_type TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  installation_id TEXT,
  repository_selection TEXT,
  connected_by_user_id TEXT NOT NULL,
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_connections_provider_check
    CHECK (provider IN ('github')),
  CONSTRAINT service_connections_status_check
    CHECK (status IN ('connected', 'action_required', 'disconnected')),
  CONSTRAINT service_connections_owner_type_check
    CHECK (owner_type IN ('user', 'organization')),
  CONSTRAINT service_connections_repository_selection_check
    CHECK (repository_selection IS NULL OR repository_selection IN ('all', 'selected')),
  CONSTRAINT service_connections_github_shape_check
    CHECK (provider <> 'github' OR installation_id IS NOT NULL),
  CONSTRAINT service_connections_provider_installation_unique
    UNIQUE (provider, installation_id)
);

CREATE INDEX IF NOT EXISTS service_connections_provider_status_idx
  ON service_connections (provider, status, owner_login);

CREATE TABLE IF NOT EXISTS github_user_authorizations (
  user_id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE repository_binding_candidates
  ADD COLUMN IF NOT EXISTS service_connection_id TEXT,
  ADD COLUMN IF NOT EXISTS external_repository_id TEXT,
  ADD COLUMN IF NOT EXISTS default_branch TEXT;

ALTER TABLE repository_binding_candidates
  DROP CONSTRAINT IF EXISTS repository_binding_candidates_service_connection_fk;
ALTER TABLE repository_binding_candidates
  ADD CONSTRAINT repository_binding_candidates_service_connection_fk
  FOREIGN KEY (service_connection_id) REFERENCES service_connections(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS repository_binding_candidates_connection_repository_unique
  ON repository_binding_candidates (project_id, service_connection_id, external_repository_id)
  WHERE service_connection_id IS NOT NULL;

REVOKE ALL PRIVILEGES ON service_connections, github_user_authorizations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON service_connections, github_user_authorizations FROM norns_app;
GRANT SELECT, INSERT, UPDATE ON service_connections, github_user_authorizations TO norns_app;
GRANT SELECT, INSERT, UPDATE ON repository_binding_candidates TO norns_app;
