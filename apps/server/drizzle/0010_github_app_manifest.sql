-- GitHub App credentials created through GitHub's manifest flow. Public App
-- identifiers remain queryable; client secrets, private keys, and webhook
-- secrets are stored together as one authenticated ciphertext. The key itself
-- is derived from the existing credential HMAC key and never enters Postgres.

CREATE TABLE IF NOT EXISTS github_app_configurations (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  credentials_ciphertext TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT github_app_configurations_singleton_check
    CHECK (id = 'primary')
);

REVOKE ALL PRIVILEGES ON github_app_configurations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON github_app_configurations FROM norns_app;
GRANT SELECT, INSERT ON github_app_configurations TO norns_app;
