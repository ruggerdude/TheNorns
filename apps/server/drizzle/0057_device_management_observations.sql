-- DEVICE MANAGEMENT PHASE 3: nullable observations used by the owned-device
-- detail and privacy-reduced project-target projections.
--
-- These columns are reported facts about an agent installation. Availability,
-- workload, compatibility, access, and connection state remain derived
-- projections and are deliberately not device lifecycle values.

CREATE OR REPLACE FUNCTION norns_valid_agent_capabilities(candidate JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $validation$
BEGIN
  IF jsonb_typeof(candidate) <> 'array' THEN
    RETURN FALSE;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
     FROM jsonb_array_elements(candidate) AS capability(value)
     WHERE jsonb_typeof(capability.value) IS DISTINCT FROM 'string'
        OR (capability.value #>> '{}') !~ '[^[:space:]]'
  );
END
$validation$;

ALTER TABLE devices
  ADD COLUMN os_version TEXT,
  ADD COLUMN agent_version TEXT,
  ADD COLUMN agent_protocol_version TEXT,
  ADD COLUMN agent_capabilities JSONB,
  ADD COLUMN last_seen_at TIMESTAMPTZ;

ALTER TABLE devices
  ADD CONSTRAINT devices_os_version_check CHECK (
    os_version IS NULL
    OR (
      btrim(os_version) <> ''
      AND char_length(os_version) <= 200
    )
  ),
  ADD CONSTRAINT devices_agent_observation_shape_check CHECK (
    (
      agent_version IS NULL
      AND agent_protocol_version IS NULL
      AND agent_capabilities IS NULL
    )
    OR (
      agent_version IS NOT NULL
      AND btrim(agent_version) <> ''
      AND char_length(agent_version) <= 100
      AND agent_protocol_version IS NOT NULL
      AND btrim(agent_protocol_version) <> ''
      AND char_length(agent_protocol_version) <= 100
      AND agent_capabilities IS NOT NULL
      AND norns_valid_agent_capabilities(agent_capabilities)
      AND jsonb_array_length(agent_capabilities) <= 64
      AND pg_column_size(agent_capabilities) <= 8192
    )
  ),
  ADD CONSTRAINT devices_last_seen_check CHECK (
    last_seen_at IS NULL
    OR last_seen_at >= created_at
  );

CREATE INDEX devices_owner_last_seen_idx
  ON devices (owner_user_id, last_seen_at DESC, id);

CREATE OR REPLACE FUNCTION norns_guard_device_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.last_seen_at IS NOT NULL AND (
    NEW.last_seen_at IS NULL
    OR NEW.last_seen_at < OLD.last_seen_at
  ) THEN
    RAISE EXCEPTION 'device last-seen observation cannot regress';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER devices_observation_guard
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_observation();

REVOKE ALL ON FUNCTION norns_valid_agent_capabilities(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION norns_valid_agent_capabilities(JSONB) TO norns_app;
GRANT EXECUTE ON FUNCTION norns_guard_device_observation() TO norns_app;
