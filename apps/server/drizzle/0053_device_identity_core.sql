-- DEVICE IDENTITY PHASE 1: additive identity, enrollment, repository
-- authorization, and nullable binding compatibility. No production path is
-- enabled and no legacy row is claimed or rewritten by this migration.

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL DEFAULT 'New device',
  location_label TEXT,
  os_family TEXT NOT NULL DEFAULT 'other',
  architecture TEXT NOT NULL DEFAULT 'unknown',
  lifecycle TEXT NOT NULL DEFAULT 'active',
  current_generation BIGINT NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT devices_owner_identity_unique UNIQUE (id, owner_user_id),
  CONSTRAINT devices_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT devices_location_label_check
    CHECK (location_label IS NULL OR btrim(location_label) <> ''),
  CONSTRAINT devices_os_family_check
    CHECK (os_family IN ('macos', 'windows', 'linux', 'other')),
  CONSTRAINT devices_architecture_check
    CHECK (btrim(architecture) <> '' AND char_length(architecture) <= 100),
  CONSTRAINT devices_lifecycle_check
    CHECK (lifecycle IN ('active', 'revoked')),
  CONSTRAINT devices_generation_check CHECK (current_generation >= 0),
  CONSTRAINT devices_active_owner_check
    CHECK (lifecycle <> 'active' OR owner_user_id IS NOT NULL),
  CONSTRAINT devices_lifecycle_shape_check CHECK (
    (lifecycle = 'active' AND revoked_at IS NULL)
    OR (lifecycle = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS devices_owner_lifecycle_idx
  ON devices (owner_user_id, lifecycle);

CREATE OR REPLACE FUNCTION norns_guard_device_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION 'device ownership is immutable; revoke and re-enroll';
  END IF;
  IF OLD.lifecycle = 'revoked' AND NEW.lifecycle <> 'revoked' THEN
    RAISE EXCEPTION 'device revocation is terminal';
  END IF;
  IF NEW.current_generation < OLD.current_generation THEN
    RAISE EXCEPTION 'device generation cannot decrease';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER devices_monotonicity_guard
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_monotonicity();

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL
    REFERENCES devices (id) ON DELETE RESTRICT,
  generation BIGINT NOT NULL,
  public_key_spki_der BYTEA NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_credentials_fingerprint_unique
    UNIQUE (public_key_fingerprint),
  CONSTRAINT device_credentials_device_generation_unique
    UNIQUE (device_id, generation),
  CONSTRAINT device_credentials_exact_identity_unique
    UNIQUE (device_id, id, generation, public_key_fingerprint),
  CONSTRAINT device_credentials_generation_check CHECK (generation > 0),
  CONSTRAINT device_credentials_public_key_check
    CHECK (octet_length(public_key_spki_der) > 0),
  CONSTRAINT device_credentials_fingerprint_check
    CHECK (public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT device_credentials_state_check
    CHECK (state IN ('active', 'revoked')),
  CONSTRAINT device_credentials_state_shape_check CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS device_credentials_one_active_per_device
  ON device_credentials (device_id)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS device_credentials_device_state_idx
  ON device_credentials (device_id, state);

CREATE OR REPLACE FUNCTION norns_guard_device_credential_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  fenced_generation BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.device_id IS DISTINCT FROM NEW.device_id
      OR OLD.generation IS DISTINCT FROM NEW.generation
      OR OLD.public_key_spki_der IS DISTINCT FROM NEW.public_key_spki_der
      OR OLD.public_key_fingerprint IS DISTINCT FROM NEW.public_key_fingerprint
    THEN
      RAISE EXCEPTION 'device credential identity and key material are immutable';
    END IF;
    IF OLD.state = 'revoked' AND NEW.state <> 'revoked' THEN
      RAISE EXCEPTION 'device credential revocation is terminal';
    END IF;
    RETURN NEW;
  END IF;

  SELECT current_generation
    INTO fenced_generation
    FROM devices
   WHERE id = NEW.device_id
   FOR UPDATE;

  IF NOT FOUND OR NEW.generation <= fenced_generation THEN
    RAISE EXCEPTION 'device credential generation must advance the device fence';
  END IF;

  UPDATE devices
     SET current_generation = NEW.generation,
         updated_at = now()
   WHERE id = NEW.device_id;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER device_credentials_generation_guard
  BEFORE INSERT OR UPDATE ON device_credentials
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_credential_generation();

CREATE TABLE IF NOT EXISTS device_authorization_requests (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'pending',
  public_key_spki_der BYTEA NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  proposed_name TEXT NOT NULL DEFAULT 'New device',
  os_family TEXT NOT NULL DEFAULT 'other',
  architecture TEXT NOT NULL DEFAULT 'unknown',
  requested_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  device_code_hash_version SMALLINT NOT NULL,
  device_code_hash_key_id TEXT NOT NULL,
  device_code_keyed_hash BYTEA NOT NULL,
  user_code_hash_version SMALLINT NOT NULL,
  user_code_hash_key_id TEXT NOT NULL,
  user_code_keyed_hash BYTEA NOT NULL,
  poll_interval_seconds INTEGER NOT NULL,
  effective_poll_interval_seconds INTEGER NOT NULL,
  slow_down_count INTEGER NOT NULL DEFAULT 0,
  poll_attempt_count BIGINT NOT NULL DEFAULT 0,
  last_polled_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  denied_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  denied_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  redeemed_device_id TEXT,
  redeemed_credential_id TEXT,
  redeemed_generation BIGINT,
  redemption_result_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_authorization_requests_device_code_unique
    UNIQUE (
      device_code_hash_version,
      device_code_hash_key_id,
      device_code_keyed_hash
    ),
  CONSTRAINT device_authorization_requests_public_key_check
    CHECK (octet_length(public_key_spki_der) > 0),
  CONSTRAINT device_authorization_requests_fingerprint_check
    CHECK (public_key_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT device_authorization_requests_summary_check CHECK (
    btrim(proposed_name) <> ''
    AND char_length(proposed_name) <= 200
    AND os_family IN ('macos', 'windows', 'linux', 'other')
    AND btrim(architecture) <> ''
    AND char_length(architecture) <= 100
    AND jsonb_typeof(requested_capabilities) = 'array'
    AND jsonb_array_length(requested_capabilities) <= 32
    AND pg_column_size(requested_capabilities) <= 4096
  ),
  CONSTRAINT device_authorization_requests_hash_version_check
    CHECK (device_code_hash_version > 0 AND user_code_hash_version > 0),
  CONSTRAINT device_authorization_requests_hash_key_check CHECK (
    btrim(device_code_hash_key_id) <> ''
    AND btrim(user_code_hash_key_id) <> ''
  ),
  CONSTRAINT device_authorization_requests_hash_length_check CHECK (
    octet_length(device_code_keyed_hash) = 32
    AND octet_length(user_code_keyed_hash) = 32
  ),
  CONSTRAINT device_authorization_requests_state_check CHECK (
    state IN (
      'pending',
      'approved_pending_redemption',
      'active',
      'denied',
      'expired'
    )
  ),
  CONSTRAINT device_authorization_requests_polling_check CHECK (
    poll_interval_seconds > 0
    AND slow_down_count >= 0
    AND poll_attempt_count >= 0
    AND effective_poll_interval_seconds
      >= poll_interval_seconds + (slow_down_count * 5)
  ),
  CONSTRAINT device_authorization_requests_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT device_authorization_requests_approval_pair_check CHECK (
    (approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT device_authorization_requests_state_shape_check CHECK (
    (
      state = 'pending'
      AND approved_by_user_id IS NULL
      AND denied_by_user_id IS NULL
      AND denied_at IS NULL
      AND expired_at IS NULL
      AND redeemed_at IS NULL
      AND redeemed_device_id IS NULL
      AND redeemed_credential_id IS NULL
      AND redeemed_generation IS NULL
      AND redemption_result_expires_at IS NULL
    )
    OR (
      state = 'approved_pending_redemption'
      AND approved_by_user_id IS NOT NULL
      AND denied_by_user_id IS NULL
      AND denied_at IS NULL
      AND expired_at IS NULL
      AND redeemed_at IS NULL
      AND redeemed_device_id IS NULL
      AND redeemed_credential_id IS NULL
      AND redeemed_generation IS NULL
      AND redemption_result_expires_at IS NULL
    )
    OR (
      state = 'active'
      AND approved_by_user_id IS NOT NULL
      AND denied_by_user_id IS NULL
      AND denied_at IS NULL
      AND expired_at IS NULL
      AND redeemed_at IS NOT NULL
      AND redeemed_device_id IS NOT NULL
      AND redeemed_credential_id IS NOT NULL
      AND redeemed_generation IS NOT NULL
      AND redemption_result_expires_at > redeemed_at
    )
    OR (
      state = 'denied'
      AND denied_by_user_id IS NOT NULL
      AND denied_at IS NOT NULL
      AND expired_at IS NULL
      AND redeemed_at IS NULL
      AND redeemed_device_id IS NULL
      AND redeemed_credential_id IS NULL
      AND redeemed_generation IS NULL
      AND redemption_result_expires_at IS NULL
    )
    OR (
      state = 'expired'
      AND denied_by_user_id IS NULL
      AND denied_at IS NULL
      AND expired_at IS NOT NULL
      AND redeemed_at IS NULL
      AND redeemed_device_id IS NULL
      AND redeemed_credential_id IS NULL
      AND redeemed_generation IS NULL
      AND redemption_result_expires_at IS NULL
    )
  ),
  CONSTRAINT device_authorization_requests_redeemed_owner_fk
    FOREIGN KEY (redeemed_device_id, approved_by_user_id)
    REFERENCES devices (id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT device_authorization_requests_redeemed_credential_fk
    FOREIGN KEY (
      redeemed_device_id,
      redeemed_credential_id,
      redeemed_generation,
      public_key_fingerprint
    )
    REFERENCES device_credentials (
      device_id,
      id,
      generation,
      public_key_fingerprint
    ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS device_authorization_requests_live_user_code_unique
  ON device_authorization_requests (
    user_code_hash_version,
    user_code_hash_key_id,
    user_code_keyed_hash
  )
  WHERE state IN ('pending', 'approved_pending_redemption');

CREATE UNIQUE INDEX IF NOT EXISTS device_authorization_requests_live_key_unique
  ON device_authorization_requests (public_key_fingerprint)
  WHERE state IN ('pending', 'approved_pending_redemption');

CREATE INDEX IF NOT EXISTS device_authorization_requests_poll_idx
  ON device_authorization_requests (state, next_poll_at);

CREATE INDEX IF NOT EXISTS device_authorization_requests_expiry_idx
  ON device_authorization_requests (state, expires_at);

CREATE OR REPLACE FUNCTION norns_guard_device_authorization_request()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.public_key_spki_der IS DISTINCT FROM NEW.public_key_spki_der
    OR OLD.public_key_fingerprint IS DISTINCT FROM NEW.public_key_fingerprint
    OR OLD.device_code_hash_version IS DISTINCT FROM NEW.device_code_hash_version
    OR OLD.device_code_hash_key_id IS DISTINCT FROM NEW.device_code_hash_key_id
    OR OLD.device_code_keyed_hash IS DISTINCT FROM NEW.device_code_keyed_hash
    OR OLD.user_code_hash_version IS DISTINCT FROM NEW.user_code_hash_version
    OR OLD.user_code_hash_key_id IS DISTINCT FROM NEW.user_code_hash_key_id
    OR OLD.user_code_keyed_hash IS DISTINCT FROM NEW.user_code_keyed_hash
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'authorization request key material is immutable';
  END IF;

  IF OLD.state IN ('active', 'denied', 'expired') THEN
    RAISE EXCEPTION 'terminal authorization requests are immutable';
  END IF;

  IF OLD.state <> NEW.state AND NOT (
    (
      OLD.state = 'pending'
      AND NEW.state IN ('approved_pending_redemption', 'denied', 'expired')
    )
    OR (
      OLD.state = 'approved_pending_redemption'
      AND NEW.state IN ('active', 'denied', 'expired')
    )
  ) THEN
    RAISE EXCEPTION 'invalid authorization request state transition';
  END IF;

  IF OLD.state = 'approved_pending_redemption' AND (
    OLD.approved_by_user_id IS DISTINCT FROM NEW.approved_by_user_id
    OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
  ) THEN
    RAISE EXCEPTION 'authorization approval is immutable';
  END IF;

  RETURN NEW;
END
$guard$;

CREATE TRIGGER device_authorization_requests_guard
  BEFORE UPDATE ON device_authorization_requests
  FOR EACH ROW EXECUTE FUNCTION norns_guard_device_authorization_request();

CREATE TABLE IF NOT EXISTS device_repository_registrations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL
    REFERENCES devices (id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  approved_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_repository_registrations_identity_unique
    UNIQUE (device_id, workspace_id, repository_id),
  CONSTRAINT device_repository_registrations_device_id_id_unique
    UNIQUE (device_id, id),
  CONSTRAINT device_repository_registrations_text_check CHECK (
    btrim(workspace_id) <> ''
    AND btrim(repository_id) <> ''
    AND btrim(repository_display_name) <> ''
  ),
  CONSTRAINT device_repository_registrations_state_check
    CHECK (state IN ('pending', 'active', 'revoked')),
  CONSTRAINT device_repository_registrations_state_shape_check CHECK (
    (
      state = 'pending'
      AND approved_by_user_id IS NULL
      AND approved_at IS NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'active'
      AND approved_by_user_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'revoked'
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS device_repository_registrations_device_state_idx
  ON device_repository_registrations (device_id, state);

CREATE TABLE IF NOT EXISTS project_device_repository_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL
    REFERENCES projects (id) ON DELETE CASCADE,
  repository_registration_id TEXT NOT NULL
    REFERENCES device_repository_registrations (id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'active',
  granted_by_user_id TEXT NOT NULL
    REFERENCES users (id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by_user_id TEXT
    REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_device_repository_grants_project_registration_unique
    UNIQUE (project_id, repository_registration_id),
  CONSTRAINT project_device_repository_grants_project_id_id_unique
    UNIQUE (project_id, id),
  CONSTRAINT project_device_repository_grants_state_check
    CHECK (state IN ('active', 'revoked')),
  CONSTRAINT project_device_repository_grants_state_shape_check CHECK (
    (
      state = 'active'
      AND revoked_by_user_id IS NULL
      AND revoked_at IS NULL
    )
    OR (
      state = 'revoked'
      AND revoked_by_user_id IS NOT NULL
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS project_device_repository_grants_registration_state_idx
  ON project_device_repository_grants (repository_registration_id, state);

CREATE INDEX IF NOT EXISTS project_device_repository_grants_project_state_idx
  ON project_device_repository_grants (project_id, state);

ALTER TABLE repository_bindings
  ADD COLUMN IF NOT EXISTS project_device_repository_grant_id TEXT;

ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_project_device_repository_grant_fk
  FOREIGN KEY (project_id, project_device_repository_grant_id)
  REFERENCES project_device_repository_grants (project_id, id)
  ON DELETE RESTRICT;

ALTER TABLE repository_bindings
  ADD CONSTRAINT repository_bindings_device_grant_shape_check
  CHECK (
    project_device_repository_grant_id IS NULL
    OR binding_type = 'local_runner'
  );

CREATE INDEX IF NOT EXISTS repository_bindings_device_grant_idx
  ON repository_bindings (project_id, project_device_repository_grant_id)
  WHERE project_device_repository_grant_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON
  devices,
  device_credentials,
  device_authorization_requests,
  device_repository_registrations,
  project_device_repository_grants
TO norns_app;

GRANT EXECUTE ON FUNCTION
  norns_guard_device_monotonicity(),
  norns_guard_device_credential_generation(),
  norns_guard_device_authorization_request()
TO norns_app;
