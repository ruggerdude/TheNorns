-- Per-user, per-project development failure email preferences and a durable
-- delivery ledger. A run/user primary key makes the polling delivery worker
-- safe to repeat without sending a second notification for the same failure.

DO $build_failure_email_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0086_development_pause_points'
  ) THEN
    RAISE EXCEPTION
      '0087_build_failure_email_notifications requires 0086_development_pause_points'
      USING ERRCODE = '55000';
  END IF;
END
$build_failure_email_dependency$;

CREATE TABLE build_failure_email_subscriptions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT build_failure_email_subscriptions_enabled_shape_check
    CHECK (enabled = (enabled_at IS NOT NULL))
);

CREATE INDEX build_failure_email_subscriptions_enabled_idx
  ON build_failure_email_subscriptions (project_id, user_id)
  WHERE enabled;

CREATE TABLE build_failure_email_deliveries (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, user_id),
  CONSTRAINT build_failure_email_deliveries_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  CONSTRAINT build_failure_email_deliveries_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT build_failure_email_deliveries_sent_shape_check
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE INDEX build_failure_email_deliveries_ready_idx
  ON build_failure_email_deliveries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'failed');

REVOKE ALL PRIVILEGES ON
  build_failure_email_subscriptions,
  build_failure_email_deliveries
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON build_failure_email_subscriptions TO norns_app;
GRANT SELECT, INSERT, UPDATE ON build_failure_email_deliveries TO norns_app;
