-- Durable, user-selectable execution boundaries. Pause settings live beside
-- immutable task-package bindings so changing a setting never mutates the
-- signed package-to-task relationship.

DO $development_pause_points_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0085_qc_salvaged_plan'
  ) THEN
    RAISE EXCEPTION
      '0086_development_pause_points requires 0085_qc_salvaged_plan'
      USING ERRCODE = '55000';
  END IF;
END
$development_pause_points_dependency$;

CREATE TABLE conversation_development_pause_points (
  task_id TEXT PRIMARY KEY
    REFERENCES conversation_task_package_bindings(task_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  phase_position INTEGER NOT NULL CHECK (phase_position > 0),
  pause_after_completion BOOLEAN NOT NULL DEFAULT false,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_development_pause_points_phase_position_unique
    UNIQUE (phase_id, phase_position)
);

-- The signed handoff preserves the approved module sequence. Use it to
-- backfill existing bindings instead of guessing from task ids or timestamps.
INSERT INTO conversation_development_pause_points (
  task_id,project_id,work_item_id,conversation_id,handoff_id,phase_id,phase_position
)
SELECT binding.task_id,binding.project_id,binding.work_item_id,binding.conversation_id,
       binding.handoff_id,binding.phase_id,sequence.ordinality::integer
  FROM conversation_task_package_bindings binding
  JOIN conversation_task_packages package ON package.id=binding.package_id
  JOIN conversation_handoffs handoff ON handoff.id=binding.handoff_id
  JOIN LATERAL jsonb_array_elements_text(handoff.package->'task_sequence')
    WITH ORDINALITY AS sequence(module_id, ordinality)
    ON sequence.module_id=package.module_id;

-- Defensive fallback for legacy/imported handoffs whose old package lacks the
-- sequence field. New conversation handoffs always take the signed path above.
INSERT INTO conversation_development_pause_points (
  task_id,project_id,work_item_id,conversation_id,handoff_id,phase_id,phase_position
)
WITH phase_max AS (
  SELECT phase_id,COALESCE(max(phase_position),0) AS max_position
    FROM conversation_development_pause_points
   GROUP BY phase_id
), missing AS (
  SELECT binding.*,
         row_number() OVER (
           PARTITION BY binding.phase_id ORDER BY binding.created_at,binding.task_id
         )::integer AS fallback_position
    FROM conversation_task_package_bindings binding
   WHERE NOT EXISTS (
     SELECT 1 FROM conversation_development_pause_points point
      WHERE point.task_id=binding.task_id
   )
)
SELECT missing.task_id,missing.project_id,missing.work_item_id,missing.conversation_id,
       missing.handoff_id,missing.phase_id,
       COALESCE(phase_max.max_position,0)+missing.fallback_position
  FROM missing
  LEFT JOIN phase_max ON phase_max.phase_id=missing.phase_id;

CREATE INDEX conversation_development_pause_points_enabled_idx
  ON conversation_development_pause_points (phase_id, phase_position)
  WHERE pause_after_completion;

REVOKE ALL PRIVILEGES ON conversation_development_pause_points FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON conversation_development_pause_points TO norns_app;
