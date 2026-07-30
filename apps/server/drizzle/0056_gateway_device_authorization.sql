-- PHASE 2: preserve the authentication subject that minted each provider
-- gateway credential. Historical rows remain explicitly legacy; they never
-- acquire device repository grants merely because runner_id happens to match
-- a device id.

ALTER TABLE gateway_credentials
  ADD COLUMN authentication_subject TEXT NOT NULL DEFAULT 'legacy_runner';

ALTER TABLE gateway_credentials
  ADD COLUMN device_credential_id TEXT;

ALTER TABLE gateway_credentials
  ADD CONSTRAINT gateway_credentials_authentication_subject_check
  CHECK (authentication_subject IN ('device', 'legacy_runner'));

ALTER TABLE gateway_credentials
  ADD CONSTRAINT gateway_credentials_device_identity_shape_check
  CHECK (
    (
      authentication_subject='device'
      AND device_credential_id IS NOT NULL
    )
    OR (
      authentication_subject='legacy_runner'
      AND device_credential_id IS NULL
    )
  );

ALTER TABLE gateway_credentials
  ADD CONSTRAINT gateway_credentials_device_credential_fk
  FOREIGN KEY (runner_id, device_credential_id, runner_generation)
  REFERENCES device_credentials (device_id, id, generation)
  ON DELETE RESTRICT;

CREATE INDEX gateway_credentials_device_identity_idx
  ON gateway_credentials (
    runner_id,
    device_credential_id,
    runner_generation,
    revoked_at
  )
  WHERE authentication_subject='device';
