-- QCP-0: schema foundation for human pause gates in the plan QC loop
-- (see QC-PAUSE-POINTS.md). Adds the awaiting_human status, its pinned
-- cadence settings, and the QC-interim/QC-result plan version origin marker.
-- No pausing behavior is wired up here — that lands with the mechanism.

DO $qc_pause_points_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0063_binary_attachments'
  ) THEN
    RAISE EXCEPTION
      '0064_qc_pause_points requires 0063_binary_attachments'
      USING ERRCODE = '55000';
  END IF;
END
$qc_pause_points_dependency$;

ALTER TABLE conversation_plan_reviews
  DROP CONSTRAINT conversation_plan_reviews_status_check;
ALTER TABLE conversation_plan_reviews
  ADD CONSTRAINT conversation_plan_reviews_status_check CHECK (
    status IN (
      'queued', 'running', 'awaiting_human', 'converged', 'cap_reached', 'failed', 'cancelled'
    )
  );

ALTER TABLE conversation_plan_reviews
  ADD COLUMN paused_checkpoint TEXT
    CHECK (paused_checkpoint IS NULL OR paused_checkpoint IN (
      'after_review', 'after_revision', 'adjudication'
    )),
  ADD COLUMN paused_at_round INTEGER CHECK (paused_at_round IS NULL OR paused_at_round > 0),
  ADD COLUMN qc_mode TEXT NOT NULL DEFAULT 'automatic'
    CHECK (qc_mode IN (
      'automatic', 'gated_each_round', 'gated_each_step', 'gated_when_contested'
    )),
  ADD COLUMN qc_mode_source TEXT NOT NULL DEFAULT 'project_default'
    CHECK (qc_mode_source IN ('project_default', 'work_item', 'in_run')),
  ADD COLUMN allow_unadjudicated_rebuttals BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN human_steered_rounds JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(human_steered_rounds) = 'array'),
  ADD CONSTRAINT conversation_plan_reviews_paused_coupling_check CHECK (
    (paused_checkpoint IS NOT NULL) = (status = 'awaiting_human')
    AND (paused_at_round IS NOT NULL) = (status = 'awaiting_human')
  );

ALTER TABLE work_plan_versions
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'
    CHECK (origin IN ('human', 'qc_interim', 'qc_result'));

ALTER TABLE planning_reviewer_settings
  ADD COLUMN qc_mode TEXT NOT NULL DEFAULT 'automatic'
    CHECK (qc_mode IN (
      'automatic', 'gated_each_round', 'gated_each_step', 'gated_when_contested'
    )),
  ADD COLUMN allow_unadjudicated_rebuttals BOOLEAN NOT NULL DEFAULT false;
