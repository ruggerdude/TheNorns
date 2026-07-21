-- EXECUTION E9 — per-run credentials for the provider-native model gateway.
--
-- NUMBER UNASSIGNED (repo convention): the integrating PM assigns NNNN.
-- Additive and forward-only. Nothing here is destructive.
--
-- WHAT THIS TABLE IS FOR. Claude Code and Codex present a bearer/api-key
-- string on every model call; they cannot perform the runner's Ed25519
-- challenge-response. This table is where the short-lived, per-run, revocable
-- string that stands in for it lives.
--
-- ONLY A HASH IS STORED. `token_hash` is sha-256 hex of the plaintext token.
-- The plaintext exists exactly once, in the mint response, and is never
-- written anywhere on the server. A database dump therefore yields nothing an
-- attacker can present.
--
-- NO FOREIGN KEY TO agent_runs, ON PURPOSE. Authorization never trusts this
-- table's contents: every gateway request re-resolves `run_id` through the
-- same lookup the E3 completion proxy uses (agent_runs.runner_id + the
-- dispatched commands.runner_generation + runner_revocations) and re-runs the
-- same ownership check. This row only names a run; it never grants access to
-- one. Keeping it FK-free means credential minting can never be blocked by,
-- nor block, the coordinator's writes to the run tables.

CREATE TABLE IF NOT EXISTS gateway_credentials (
  id TEXT PRIMARY KEY,
  -- sha-256 hex of the plaintext token. Unique so a (astronomically
  -- unlikely) collision is a loud constraint violation, not a silent
  -- cross-run credential.
  token_hash TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  -- The dispatch generation this token was minted at. A run re-dispatched at
  -- a higher generation makes every older token fail the ownership check.
  runner_generation INTEGER NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- Resolution is by hash on every single model call; this index is the hot path.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_credentials_token_hash_idx
  ON gateway_credentials (token_hash);

-- Revoking a run's credentials, and purging expired rows, both scan by these.
CREATE INDEX IF NOT EXISTS gateway_credentials_run_id_idx
  ON gateway_credentials (run_id);
CREATE INDEX IF NOT EXISTS gateway_credentials_expires_at_idx
  ON gateway_credentials (expires_at);

-- Production runs under a restricted role and pglite tests do not model that,
-- so a missing grant is invisible in CI and fails only in production.
-- (Repo convention: every new table needs this. Same shape as 0020.)
-- DELETE is granted, unlike 0020's table: expired credential rows are purged
-- rather than accumulating a permanent list of every model call's credential.
REVOKE ALL PRIVILEGES ON gateway_credentials FROM PUBLIC;
REVOKE ALL PRIVILEGES ON gateway_credentials FROM norns_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_credentials TO norns_app;
