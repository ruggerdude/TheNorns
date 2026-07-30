-- DEVICE IDENTITY PHASE 5: project-run stop idempotency and context fencing.
--
-- The cancellation row remains the durable source of truth introduced by
-- 0055. This migration adds only the data needed for response-loss-safe
-- project-stop requests and explicit revocation of a run's context grants.

ALTER TABLE device_run_cancellations
  ADD COLUMN idempotency_key TEXT;

ALTER TABLE device_run_cancellations
  ADD CONSTRAINT device_run_cancellations_idempotency_key_check CHECK (
    idempotency_key IS NULL
    OR (
      btrim(idempotency_key) <> ''
      AND char_length(idempotency_key) <= 200
    )
  );

CREATE UNIQUE INDEX device_run_cancellations_actor_idempotency_unique
  ON device_run_cancellations (requested_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION norns_guard_device_run_cancellation_idempotency()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'device run cancellation idempotency identity is immutable';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER device_run_cancellations_idempotency_guard
  BEFORE UPDATE ON device_run_cancellations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_run_cancellation_idempotency();

ALTER TABLE dispatch_context_documents
  ADD COLUMN revoked_at TIMESTAMPTZ;

CREATE INDEX dispatch_context_documents_active_run_idx
  ON dispatch_context_documents (run_id, runner_id, runner_generation)
  WHERE revoked_at IS NULL;

GRANT EXECUTE ON FUNCTION
  norns_guard_device_run_cancellation_idempotency()
TO norns_app;
