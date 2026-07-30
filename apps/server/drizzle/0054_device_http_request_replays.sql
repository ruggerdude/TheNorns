-- PHASE 2A: one-time request identifiers for strict device-authenticated HTTP.
--
-- A request signature is accepted only after this row is inserted. The global
-- primary key makes request_id one-use across purposes and endpoints, while
-- the exact credential foreign key prevents replay records from drifting away
-- from the device generation that authenticated them.

ALTER TABLE device_credentials
  ADD CONSTRAINT device_credentials_exact_generation_unique
  UNIQUE (device_id, id, generation);

ALTER TABLE dispatch_context_documents
  ADD COLUMN runner_generation INTEGER;

ALTER TABLE dispatch_context_documents
  ADD CONSTRAINT dispatch_context_documents_runner_generation_check
  CHECK (runner_generation IS NULL OR runner_generation >= 0);

CREATE TABLE device_http_request_replays (
  request_id TEXT PRIMARY KEY,
  identity_kind TEXT NOT NULL,
  device_id TEXT,
  legacy_runner_id TEXT,
  credential_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  purpose TEXT NOT NULL,
  request_timestamp TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT device_http_request_replays_credential_fk
    FOREIGN KEY (device_id, credential_id, generation)
    REFERENCES device_credentials (device_id, id, generation)
    ON DELETE RESTRICT,
  CONSTRAINT device_http_request_replays_identity_kind_check
    CHECK (identity_kind IN ('device', 'legacy_runner')),
  CONSTRAINT device_http_request_replays_identity_shape_check CHECK (
    (
      identity_kind='device'
      AND device_id IS NOT NULL
      AND legacy_runner_id IS NULL
    )
    OR (
      identity_kind='legacy_runner'
      AND device_id IS NULL
      AND legacy_runner_id IS NOT NULL
    )
  ),
  CONSTRAINT device_http_request_replays_generation_check
    CHECK (generation > 0),
  CONSTRAINT device_http_request_replays_purpose_check CHECK (
    purpose IN (
      'norns.runner-http.context-retrieval.v1',
      'norns.runner-http.gateway-credential-mint.v1',
      'norns.runner-http.visual-evidence-upload.v1'
    )
  )
);

CREATE INDEX device_http_request_replays_credential_consumed_idx
  ON device_http_request_replays (
    identity_kind,
    COALESCE(device_id, legacy_runner_id),
    credential_id,
    consumed_at DESC
  );

GRANT SELECT, INSERT ON device_http_request_replays TO norns_app;
