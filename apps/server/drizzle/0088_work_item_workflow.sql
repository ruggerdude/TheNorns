-- Quick and phased are one planning→implement flow; quick just waives QC.
-- Persist the chosen workflow on the work item so the plan-approval seam can
-- waive QC for quick work without a separate, dead-end execution path. Existing
-- rows default to 'phased' (their historical behavior).

DO $work_item_workflow_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0087_build_failure_email_notifications'
  ) THEN
    RAISE EXCEPTION
      '0088_work_item_workflow requires 0087_build_failure_email_notifications'
      USING ERRCODE = '55000';
  END IF;
END
$work_item_workflow_dependency$;

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS workflow TEXT NOT NULL DEFAULT 'phased';

ALTER TABLE work_items
  DROP CONSTRAINT IF EXISTS work_items_workflow_check;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_workflow_check CHECK (workflow IN ('phased', 'quick'));
