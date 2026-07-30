-- DEVICE IDENTITY PHASE 2: durable, evidence-based cancellation tracking.
--
-- A cancellation request is a server fact. Runner acknowledgement, process
-- exit, and an offline/unconfirmed outcome are separate facts and must never be
-- inferred from a socket closing. Device revocation also creates a publication
-- fence which can only be released by an explicit, attributable action.

CREATE TABLE IF NOT EXISTS device_run_cancellations (
  run_id TEXT PRIMARY KEY
    REFERENCES agent_runs (id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  device_generation BIGINT NOT NULL,
  cause TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'cancellation_requested',
  requested_by_user_id TEXT NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  runner_acknowledged_at TIMESTAMPTZ,
  process_exited_at TIMESTAMPTZ,
  unconfirmed_offline_at TIMESTAMPTZ,
  publication_fenced_at TIMESTAMPTZ,
  publication_reauthorized_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  publication_reauthorized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_run_cancellations_device_credential_fk
    FOREIGN KEY (device_id, credential_id, device_generation)
    REFERENCES device_credentials (device_id, id, generation)
    ON DELETE RESTRICT,
  CONSTRAINT device_run_cancellations_generation_check
    CHECK (device_generation > 0),
  CONSTRAINT device_run_cancellations_cause_check
    CHECK (cause IN ('project_stop', 'device_revocation', 'emergency_stop')),
  CONSTRAINT device_run_cancellations_state_check CHECK (
    state IN (
      'cancellation_requested',
      'runner_acknowledged',
      'process_exited',
      'unconfirmed_offline'
    )
  ),
  CONSTRAINT device_run_cancellations_reason_check CHECK (
    btrim(reason) <> '' AND char_length(reason) <= 4000
  ),
  CONSTRAINT device_run_cancellations_evidence_time_check CHECK (
    (runner_acknowledged_at IS NULL OR runner_acknowledged_at >= requested_at)
    AND (process_exited_at IS NULL OR process_exited_at >= requested_at)
    AND (
      process_exited_at IS NULL
      OR runner_acknowledged_at IS NULL
      OR process_exited_at >= runner_acknowledged_at
    )
    AND (unconfirmed_offline_at IS NULL OR unconfirmed_offline_at >= requested_at)
  ),
  CONSTRAINT device_run_cancellations_state_shape_check CHECK (
    (
      state = 'cancellation_requested'
      AND runner_acknowledged_at IS NULL
      AND process_exited_at IS NULL
      AND unconfirmed_offline_at IS NULL
    )
    OR (
      state = 'runner_acknowledged'
      AND runner_acknowledged_at IS NOT NULL
      AND process_exited_at IS NULL
    )
    OR (
      state = 'process_exited'
      AND runner_acknowledged_at IS NOT NULL
      AND process_exited_at IS NOT NULL
    )
    OR (
      state = 'unconfirmed_offline'
      AND runner_acknowledged_at IS NULL
      AND process_exited_at IS NULL
      AND unconfirmed_offline_at IS NOT NULL
    )
  ),
  CONSTRAINT device_run_cancellations_publication_fence_check CHECK (
    (cause <> 'device_revocation' OR publication_fenced_at IS NOT NULL)
    AND (
      publication_fenced_at IS NULL
      OR publication_fenced_at >= requested_at
    )
  ),
  CONSTRAINT device_run_cancellations_reauthorization_pair_check CHECK (
    (
      publication_reauthorized_by_user_id IS NULL
      AND publication_reauthorized_at IS NULL
    )
    OR (
      publication_fenced_at IS NOT NULL
      AND publication_reauthorized_by_user_id IS NOT NULL
      AND publication_reauthorized_at IS NOT NULL
      AND publication_reauthorized_at >= publication_fenced_at
    )
  )
);

CREATE INDEX IF NOT EXISTS device_run_cancellations_device_state_idx
  ON device_run_cancellations (device_id, state);

CREATE INDEX IF NOT EXISTS device_run_cancellations_unconfirmed_idx
  ON device_run_cancellations (requested_at)
  WHERE state IN ('cancellation_requested', 'unconfirmed_offline');

CREATE OR REPLACE FUNCTION norns_require_device_run_cancellation_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $scope$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM agent_runs run
      JOIN commands command
        ON command.command_id=(
          SELECT latest.command_id
            FROM commands latest
           WHERE latest.run_id=run.id
           ORDER BY latest.created_at DESC,latest.command_id DESC
           LIMIT 1
        )
       AND command.runner_id=NEW.device_id
       AND command.runner_generation=NEW.device_generation
     WHERE run.id=NEW.run_id
  ) THEN
    RAISE EXCEPTION
      'device run cancellation evidence must match the run command identity';
  END IF;
  RETURN NEW;
END
$scope$;

CREATE TRIGGER device_run_cancellations_scope
  BEFORE INSERT ON device_run_cancellations
  FOR EACH ROW EXECUTE FUNCTION norns_require_device_run_cancellation_scope();

CREATE OR REPLACE FUNCTION norns_guard_device_run_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.device_id IS DISTINCT FROM NEW.device_id
    OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
    OR OLD.device_generation IS DISTINCT FROM NEW.device_generation
    OR OLD.cause IS DISTINCT FROM NEW.cause
    OR OLD.requested_by_user_id IS DISTINCT FROM NEW.requested_by_user_id
    OR OLD.reason IS DISTINCT FROM NEW.reason
    OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
  THEN
    RAISE EXCEPTION 'device run cancellation request is immutable';
  END IF;
  IF OLD.publication_fenced_at IS NOT NULL
    AND OLD.publication_fenced_at IS DISTINCT FROM NEW.publication_fenced_at
  THEN
    RAISE EXCEPTION 'device run publication fence is immutable';
  END IF;

  IF OLD.runner_acknowledged_at IS NOT NULL
    AND OLD.runner_acknowledged_at IS DISTINCT FROM NEW.runner_acknowledged_at
  THEN
    RAISE EXCEPTION 'runner acknowledgement evidence is immutable';
  END IF;
  IF OLD.process_exited_at IS NOT NULL
    AND OLD.process_exited_at IS DISTINCT FROM NEW.process_exited_at
  THEN
    RAISE EXCEPTION 'process exit evidence is immutable';
  END IF;
  IF OLD.unconfirmed_offline_at IS NOT NULL
    AND OLD.unconfirmed_offline_at IS DISTINCT FROM NEW.unconfirmed_offline_at
  THEN
    RAISE EXCEPTION 'offline uncertainty evidence is immutable';
  END IF;
  IF OLD.publication_reauthorized_at IS NOT NULL AND (
    OLD.publication_reauthorized_at IS DISTINCT FROM NEW.publication_reauthorized_at
    OR OLD.publication_reauthorized_by_user_id
      IS DISTINCT FROM NEW.publication_reauthorized_by_user_id
  ) THEN
    RAISE EXCEPTION 'publication reauthorization is immutable';
  END IF;

  IF OLD.state <> NEW.state AND NOT (
    (
      OLD.state = 'cancellation_requested'
      AND NEW.state IN ('runner_acknowledged', 'process_exited', 'unconfirmed_offline')
    )
    OR (
      OLD.state = 'unconfirmed_offline'
      AND NEW.state IN ('runner_acknowledged', 'process_exited')
    )
    OR (
      OLD.state = 'runner_acknowledged'
      AND NEW.state = 'process_exited'
    )
  ) THEN
    RAISE EXCEPTION 'invalid device run cancellation transition';
  END IF;

  RETURN NEW;
END
$guard$;

CREATE TRIGGER device_run_cancellations_guard
  BEFORE UPDATE ON device_run_cancellations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_run_cancellation();

CREATE TABLE IF NOT EXISTS device_revocations (
  device_id TEXT PRIMARY KEY
    REFERENCES devices (id) ON DELETE RESTRICT,
  revoked_by_user_id TEXT NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT,
  previous_generation BIGINT NOT NULL,
  fenced_generation BIGINT NOT NULL,
  reason TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT device_revocations_generation_check CHECK (
    previous_generation >= 0
    AND fenced_generation = previous_generation + 1
  ),
  CONSTRAINT device_revocations_reason_check CHECK (
    btrim(reason) <> '' AND char_length(reason) <= 4000
  )
);

CREATE OR REPLACE FUNCTION norns_guard_device_revocation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION 'device revocation records are immutable';
END
$guard$;

CREATE TRIGGER device_revocations_guard
  BEFORE UPDATE OR DELETE ON device_revocations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_revocation();

GRANT SELECT, INSERT, UPDATE ON device_run_cancellations TO norns_app;
GRANT SELECT, INSERT ON device_revocations TO norns_app;
GRANT EXECUTE ON FUNCTION
  norns_require_device_run_cancellation_scope(),
  norns_guard_device_run_cancellation(),
  norns_guard_device_revocation()
TO norns_app;
