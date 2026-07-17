CREATE TABLE IF NOT EXISTS attention_item_states (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  condition_class TEXT NOT NULL,
  condition_fingerprint TEXT NOT NULL,
  disposition TEXT NOT NULL,
  snoozed_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_key),
  CONSTRAINT attention_item_states_fingerprint_check
    CHECK (condition_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT attention_item_states_disposition_check
    CHECK (disposition IN ('acknowledged','snoozed')),
  CONSTRAINT attention_item_states_snooze_check
    CHECK ((disposition = 'snoozed') = (snoozed_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS attention_item_states_project_user_idx
  ON attention_item_states (project_id, user_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON attention_item_states TO norns_app;

