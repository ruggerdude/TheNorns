-- Conversation-first work Phase 5: durable human waits, explicit steering
-- delivery receipts, exact-once continuation outbox, and deterministic PM
-- update policy. A runner never remains allocated while a human is deciding.

DO $conversation_human_steering_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM norns_schema_migrations
     WHERE name = '0038_conversation_execution_handoff'
  ) THEN
    RAISE EXCEPTION
      '0039_conversation_human_steering requires 0038_conversation_execution_handoff'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_human_steering_dependency$;

CREATE VIEW conversation_human_steering_v1 AS SELECT 1::INTEGER AS version;
REVOKE ALL ON conversation_human_steering_v1 FROM PUBLIC;
GRANT SELECT ON conversation_human_steering_v1 TO norns_app;

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_state_check_v0039 CHECK (state IN (
  'created','dispatched','running','waiting_for_human','verifying',
  'succeeded','failed','cancelled','expired'
)) NOT VALID;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_state_check_v0039;
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_state_check;
ALTER TABLE agent_runs RENAME CONSTRAINT agent_runs_state_check_v0039 TO agent_runs_state_check;

-- Actions-backed continuations are durable before their ephemeral runner
-- enrolls. They must not enter the ordinary dispatcher retry/dead-letter loop
-- until that runner has authenticated and reconciled.
ALTER TABLE dispatch_jobs ADD CONSTRAINT dispatch_jobs_status_check_v0039 CHECK (
  status IN (
    'awaiting_enrollment','queued','leased','delivered',
    'completed','dead_letter','cancelled'
  )
) NOT VALID;
ALTER TABLE dispatch_jobs VALIDATE CONSTRAINT dispatch_jobs_status_check_v0039;
ALTER TABLE dispatch_jobs DROP CONSTRAINT dispatch_jobs_status_check;
ALTER TABLE dispatch_jobs
  RENAME CONSTRAINT dispatch_jobs_status_check_v0039 TO dispatch_jobs_status_check;

ALTER TABLE github_actions_runs
  ADD COLUMN enrollment_secret_hash TEXT CHECK (
    enrollment_secret_hash IS NULL OR enrollment_secret_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN enrolled_public_key_hash TEXT CHECK (
    enrolled_public_key_hash IS NULL OR enrolled_public_key_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN enrolled_public_key_pem TEXT,
  ADD COLUMN launch_lease_owner TEXT,
  ADD COLUMN launch_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN launch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (launch_attempts>=0),
  ADD COLUMN launch_available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_dispatch_attempt_at TIMESTAMPTZ,
  ADD COLUMN reconcile_lease_owner TEXT,
  ADD COLUMN reconcile_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts>=0),
  ADD COLUMN reconcile_available_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- An in-flight pre-0039 job only has the repository binding's then-current
-- hash. It is safe to pin that hash when there is exactly one unenrolled
-- nonterminal row for the binding. Multiple rows are ambiguous because older
-- workflow jobs may have captured an earlier rotated secret; quarantine those
-- rows rather than assigning the newest credential to the wrong dispatch.
WITH ambiguous_bindings AS (
  SELECT repository_binding_id
    FROM github_actions_runs
   WHERE status IN ('requested','dispatched') AND enrolled_at IS NULL
   GROUP BY repository_binding_id
  HAVING count(*)>1
)
UPDATE github_actions_runs run
   SET status='abandoned',
       last_error='migration_0039_ambiguous_legacy_enrollment_credential',
       completed_at=now(),
       updated_at=now()
  FROM ambiguous_bindings ambiguous
 WHERE run.repository_binding_id=ambiguous.repository_binding_id
   AND run.status IN ('requested','dispatched')
   AND run.enrolled_at IS NULL;
UPDATE github_actions_runs run
   SET enrollment_secret_hash=binding.enrollment_secret_hash,
       updated_at=now()
  FROM github_actions_execution_bindings binding
 WHERE run.repository_binding_id=binding.repository_binding_id
   AND run.status IN ('requested','dispatched')
   AND run.enrolled_at IS NULL
   AND run.enrollment_secret_hash IS NULL
   AND binding.enrollment_secret_hash IS NOT NULL;
UPDATE github_actions_runs
   SET status='abandoned',
       last_error=COALESCE(
         last_error,
         'migration_0039_missing_legacy_enrollment_credential'
       ),
       completed_at=COALESCE(completed_at,now()),
       updated_at=now()
 WHERE status IN ('requested','dispatched')
   AND enrolled_at IS NULL
   AND enrollment_secret_hash IS NULL;
UPDATE github_actions_runs
   SET status='abandoned',
       last_error=COALESCE(
         last_error,
         'migration_0039_legacy_enrollment_identity_not_persisted'
       ),
       completed_at=COALESCE(completed_at,now()),
       updated_at=now()
 WHERE status='enrolled'
   AND (
     enrollment_secret_hash IS NULL
     OR enrolled_public_key_hash IS NULL
     OR enrolled_public_key_pem IS NULL
     OR runner_generation IS NULL
   );

-- Move every pre-0039 Actions outbox that has not reached a terminal dispatch
-- state out of the ordinary runner queue. Safe rows can now enroll against
-- their pinned hash; quarantined rows become visible to the terminal Actions
-- dispatcher and are dead-lettered with truthful cleanup instead of being
-- delivered or retried as a laptop-runner job.
UPDATE dispatch_jobs job
   SET status='awaiting_enrollment',
       lease_owner=NULL,
       lease_expires_at=NULL,
       available_at=now(),
       updated_at=now()
  FROM github_actions_runs actions
 WHERE actions.dispatch_job_id=job.id
   AND actions.status IN ('requested','dispatched','enrolled','failed','abandoned')
   AND job.status IN ('queued','leased');
ALTER TABLE github_actions_runs
  ADD CONSTRAINT github_actions_runs_status_check_v0039 CHECK (
    status IN (
      'requested','dispatching','dispatched','enrolled',
      'completed','failed','abandoned'
    )
  ) NOT VALID;
ALTER TABLE github_actions_runs
  VALIDATE CONSTRAINT github_actions_runs_status_check_v0039;
ALTER TABLE github_actions_runs DROP CONSTRAINT github_actions_runs_status_check;
ALTER TABLE github_actions_runs
  RENAME CONSTRAINT github_actions_runs_status_check_v0039
  TO github_actions_runs_status_check;
ALTER TABLE github_actions_runs
  ADD CONSTRAINT github_actions_runs_launch_lease_shape_check CHECK (
    (
      status='dispatching'
      AND launch_lease_owner IS NOT NULL
      AND launch_lease_expires_at IS NOT NULL
    )
    OR (
      status<>'dispatching'
      AND launch_lease_owner IS NULL
      AND launch_lease_expires_at IS NULL
    )
  ) NOT VALID;
ALTER TABLE github_actions_runs
  VALIDATE CONSTRAINT github_actions_runs_launch_lease_shape_check;
ALTER TABLE github_actions_runs
  ADD CONSTRAINT github_actions_runs_reconcile_lease_shape_check CHECK (
    (reconcile_lease_owner IS NULL AND reconcile_lease_expires_at IS NULL)
    OR (reconcile_lease_owner IS NOT NULL AND reconcile_lease_expires_at IS NOT NULL)
  ) NOT VALID;
ALTER TABLE github_actions_runs
  VALIDATE CONSTRAINT github_actions_runs_reconcile_lease_shape_check;
ALTER TABLE github_actions_runs
  ADD CONSTRAINT github_actions_runs_enrollment_identity_shape_check CHECK (
    (
      status NOT IN ('dispatched','enrolled')
      OR enrollment_secret_hash IS NOT NULL
    )
    AND (
      status<>'enrolled'
      OR (
        enrolled_at IS NOT NULL
        AND enrolled_public_key_hash IS NOT NULL
        AND enrolled_public_key_pem IS NOT NULL
        AND runner_generation IS NOT NULL
      )
    )
  ) NOT VALID;
ALTER TABLE github_actions_runs
  VALIDATE CONSTRAINT github_actions_runs_enrollment_identity_shape_check;
CREATE INDEX github_actions_runs_unenrolled_reconcile_idx
  ON github_actions_runs(reconcile_available_at,requested_at,dispatch_job_id)
  WHERE status IN ('dispatched','enrolled');

ALTER TABLE runner_events
  ADD COLUMN correlation_id TEXT,
  ADD COLUMN causation_id TEXT,
  ADD COLUMN occurred_at TIMESTAMPTZ;
UPDATE runner_events
   SET correlation_id='legacy:' || id,
       occurred_at=received_at
 WHERE correlation_id IS NULL OR occurred_at IS NULL;
ALTER TABLE runner_events ADD CONSTRAINT runner_events_correlation_not_null_v0039
  CHECK (correlation_id IS NOT NULL) NOT VALID;
ALTER TABLE runner_events VALIDATE CONSTRAINT runner_events_correlation_not_null_v0039;
ALTER TABLE runner_events ADD CONSTRAINT runner_events_occurred_not_null_v0039
  CHECK (occurred_at IS NOT NULL) NOT VALID;
ALTER TABLE runner_events VALIDATE CONSTRAINT runner_events_occurred_not_null_v0039;
ALTER TABLE runner_events
  ALTER COLUMN correlation_id SET NOT NULL,
  ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE runner_events DROP CONSTRAINT runner_events_correlation_not_null_v0039;
ALTER TABLE runner_events DROP CONSTRAINT runner_events_occurred_not_null_v0039;
ALTER TABLE runner_events ADD CONSTRAINT runner_events_correlation_check
  CHECK (length(trim(correlation_id)) > 0);

ALTER TABLE conversation_actions DROP CONSTRAINT conversation_actions_action_type_check;
ALTER TABLE conversation_actions ADD CONSTRAINT conversation_actions_action_type_check CHECK (
  action_type IN (
    'save_plan_candidate','send_plan_to_qc','request_plan_changes','approve_plan','reject_plan',
    'pause_work','resume_work','redirect_agent','record_human_decision',
    'propose_plan_change','approve_plan_change','answer_human_wait',
    'create_mockup','approve_mockup','revise_mockup','reject_mockup'
  )
);
ALTER TABLE conversation_actions
  ADD COLUMN proposal_idempotency_key TEXT,
  ADD COLUMN proposal_request_fingerprint TEXT,
  ADD COLUMN interaction_class TEXT;
UPDATE conversation_actions SET interaction_class = CASE
  WHEN action_type IN ('save_plan_candidate','request_plan_changes','propose_plan_change')
    THEN 'plan_change_proposal'
  WHEN action_type IN (
    'send_plan_to_qc','approve_plan','reject_plan','approve_plan_change',
    'approve_mockup','reject_mockup'
  ) THEN 'approval'
  WHEN action_type IN ('record_human_decision','answer_human_wait') THEN 'human_decision'
  WHEN action_type='redirect_agent' THEN 'task_direction'
  WHEN action_type='pause_work' THEN 'pause'
  WHEN action_type='resume_work' THEN 'resume'
  WHEN action_type IN ('create_mockup','revise_mockup') THEN 'mockup_request'
END;
ALTER TABLE conversation_actions ALTER COLUMN interaction_class SET NOT NULL;
ALTER TABLE conversation_actions ADD CONSTRAINT conversation_actions_interaction_class_check CHECK (
  interaction_class = CASE
    WHEN action_type IN ('save_plan_candidate','request_plan_changes','propose_plan_change')
      THEN 'plan_change_proposal'
    WHEN action_type IN (
      'send_plan_to_qc','approve_plan','reject_plan','approve_plan_change',
      'approve_mockup','reject_mockup'
    ) THEN 'approval'
    WHEN action_type IN ('record_human_decision','answer_human_wait') THEN 'human_decision'
    WHEN action_type='redirect_agent' THEN 'task_direction'
    WHEN action_type='pause_work' THEN 'pause'
    WHEN action_type='resume_work' THEN 'resume'
    WHEN action_type IN ('create_mockup','revise_mockup') THEN 'mockup_request'
  END
);
ALTER TABLE conversation_actions ADD CONSTRAINT conversation_actions_proposal_identity_check CHECK (
  (proposal_idempotency_key IS NULL AND proposal_request_fingerprint IS NULL)
  OR (
    proposal_idempotency_key IS NOT NULL
    AND proposal_request_fingerprint IS NOT NULL
    AND proposal_request_fingerprint ~ '^[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX conversation_actions_proposal_idempotency_unique
  ON conversation_actions(conversation_id, initiated_by_user_id, proposal_idempotency_key)
  WHERE proposal_idempotency_key IS NOT NULL;

CREATE TABLE conversation_action_delivery_intents (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('live','checkpoint','continuation')),
  target_run_id TEXT,
  target_command_id TEXT,
  target_runner_generation INTEGER CHECK (
    target_runner_generation IS NULL OR target_runner_generation >= 0
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued','leased','sent','acknowledged','applied','failed','fallback_queued')
  ),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id,action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  CHECK (target_run_id IS NULL OR length(trim(target_run_id)) > 0),
  CHECK ((target_command_id IS NULL)=(target_runner_generation IS NULL)),
  CONSTRAINT conversation_action_delivery_intents_lease_shape_check CHECK (
    (status='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX conversation_action_delivery_intents_claim_idx
  ON conversation_action_delivery_intents(status,available_at,lease_expires_at);

CREATE TABLE conversation_action_delivery_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN (
    'confirmed','recorded','sent','agent_acknowledged','applied','failed','fallback_queued'
  )),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('live','checkpoint','continuation')),
  target_run_id TEXT,
  target_command_id TEXT,
  receipt JSONB NOT NULL CHECK (
    jsonb_typeof(receipt)='object'
    AND receipt ? 'kind'
    AND receipt->>'kind' IN (
      'confirmation','recorded','sent','agent_ack','applied','failed','fallback_queued'
    )
    AND receipt->>'kind' = CASE status
      WHEN 'confirmed' THEN 'confirmation'
      WHEN 'recorded' THEN 'recorded'
      WHEN 'sent' THEN 'sent'
      WHEN 'agent_acknowledged' THEN 'agent_ack'
      WHEN 'applied' THEN 'applied'
      WHEN 'failed' THEN 'failed'
      WHEN 'fallback_queued' THEN 'fallback_queued'
    END
    AND CASE receipt->>'kind'
      WHEN 'confirmation' THEN receipt->>'fingerprint' ~ '^[a-f0-9]{64}$'
      WHEN 'recorded' THEN length(trim(receipt->>'record_id')) > 0
      WHEN 'sent' THEN length(trim(receipt->>'outbox_id')) > 0
      WHEN 'agent_ack' THEN length(trim(receipt->>'ack_event_id')) > 0
      WHEN 'applied' THEN receipt->>'context_receipt_hash' ~ '^[a-f0-9]{64}$'
      WHEN 'failed' THEN length(trim(receipt->>'failure_code')) > 0
      WHEN 'fallback_queued' THEN length(trim(receipt->>'reason')) > 0
      ELSE false
    END
  ),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id,action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  UNIQUE(action_id,sequence)
);
CREATE INDEX conversation_action_delivery_events_scope_idx
  ON conversation_action_delivery_events(project_id,conversation_id,occurred_at,id);

CREATE TABLE run_command_usage_receipts (
  command_id TEXT PRIMARY KEY REFERENCES commands(command_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd NUMERIC(24,9) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  active_ms BIGINT NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  usage_source TEXT NOT NULL DEFAULT 'runner_report'
    CHECK (usage_source IN ('runner_report','gateway_exact','unavailable')),
  status TEXT NOT NULL DEFAULT 'observing' CHECK (status IN ('observing','final')),
  last_usage_event_id TEXT REFERENCES runner_events(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ,
  terminal_event_id TEXT UNIQUE REFERENCES runner_events(id) ON DELETE RESTRICT,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,phase_id,task_id,run_id)
    REFERENCES agent_runs(project_id,phase_id,task_id,id) ON DELETE RESTRICT,
  CHECK (
    (status='observing' AND terminal_event_id IS NULL AND terminal_at IS NULL)
    OR (status='final' AND terminal_event_id IS NOT NULL AND terminal_at IS NOT NULL)
  )
);
CREATE INDEX run_command_usage_receipts_run_idx
  ON run_command_usage_receipts(run_id,status,command_id);

CREATE TABLE conversation_execution_plan_change_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  plan_version_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  direction TEXT NOT NULL CHECK (length(trim(direction)) > 0),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  approved_by_action_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  FOREIGN KEY (project_id,work_item_id,conversation_id,action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (plan_version_id) REFERENCES work_plan_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_action_id) REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  CHECK (
    (status='proposed' AND approved_by_action_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved','rejected') AND approved_by_action_id IS NOT NULL
        AND decided_at IS NOT NULL)
  )
);

CREATE TABLE conversation_mockup_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  brief TEXT NOT NULL CHECK (length(trim(brief)) > 0),
  target TEXT NOT NULL CHECK (target IN ('desktop','mobile','responsive')),
  artifact_refs JSONB NOT NULL CHECK (jsonb_typeof(artifact_refs)='array'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','rendered','failed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id,action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
);

CREATE TABLE conversation_action_checkpoint_contexts (
  action_id TEXT PRIMARY KEY REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  context_document_id TEXT NOT NULL REFERENCES task_context_documents(id) ON DELETE RESTRICT,
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sent','applied','failed')),
  command_id TEXT REFERENCES commands(command_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  FOREIGN KEY (project_id,work_item_id,conversation_id,action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  CHECK (
    (status='prepared' AND command_id IS NULL AND sent_at IS NULL AND applied_at IS NULL)
    OR (status='sent' AND command_id IS NOT NULL AND sent_at IS NOT NULL AND applied_at IS NULL)
    OR (status='applied' AND command_id IS NOT NULL AND sent_at IS NOT NULL AND applied_at IS NOT NULL)
    OR status='failed'
  )
);
CREATE INDEX conversation_action_checkpoint_contexts_document_idx
  ON conversation_action_checkpoint_contexts(context_document_id,status,task_id);

CREATE TABLE conversation_pause_checkpoints (
  pause_action_id TEXT PRIMARY KEY REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  resume_action_id TEXT UNIQUE REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE RESTRICT,
  budget_reservation_id TEXT NOT NULL REFERENCES budget_reservations(id) ON DELETE RESTRICT,
  published_branch TEXT NOT NULL CHECK (length(trim(published_branch)) > 0),
  published_commit_sha TEXT NOT NULL CHECK (
    published_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  published_remote TEXT NOT NULL CHECK (length(trim(published_remote)) > 0),
  root_context_refs JSONB NOT NULL CHECK (
    jsonb_typeof(root_context_refs)='array' AND jsonb_array_length(root_context_refs)>0
  ),
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  resume_context_ref JSONB CHECK (
    resume_context_ref IS NULL OR jsonb_typeof(resume_context_ref)='object'
  ),
  resume_command_id TEXT UNIQUE,
  resume_job_id TEXT UNIQUE,
  runner_id TEXT,
  runner_generation INTEGER CHECK (runner_generation IS NULL OR runner_generation>=0),
  enrollment_secret_hash TEXT CHECK (
    enrollment_secret_hash IS NULL OR enrollment_secret_hash ~ '^[a-f0-9]{64}$'
  ),
  status TEXT NOT NULL DEFAULT 'paused' CHECK (
    status IN ('paused','resume_queued','leased','provisioned','dispatched','resumed','failed')
  ),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  paused_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  resumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id,pause_action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id,task_id,run_id)
    REFERENCES agent_runs(project_id,phase_id,task_id,id) ON DELETE RESTRICT,
  CHECK (
    (status IN ('paused','failed') AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (status='resume_queued' AND resume_action_id IS NOT NULL
        AND resume_command_id IS NOT NULL AND resume_job_id IS NOT NULL
        AND resume_context_ref IS NOT NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (status='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status IN ('provisioned','dispatched','resumed')
        AND runner_id IS NOT NULL AND runner_generation IS NOT NULL
        AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status='resumed')=(resumed_at IS NOT NULL))
);
CREATE INDEX conversation_pause_checkpoints_claim_idx
  ON conversation_pause_checkpoints(status,available_at,lease_expires_at);

CREATE TABLE human_waits (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES runner_events(id) ON DELETE RESTRICT,
  source_command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL UNIQUE,
  decision_point_id TEXT NOT NULL UNIQUE REFERENCES decision_points(id) ON DELETE RESTRICT,
  decision_point TEXT NOT NULL CHECK (length(trim(decision_point)) > 0),
  question TEXT NOT NULL CHECK (length(trim(question)) > 0),
  question_hash TEXT NOT NULL CHECK (question_hash ~ '^[a-f0-9]{64}$'),
  published_branch TEXT NOT NULL CHECK (length(trim(published_branch)) > 0),
  published_commit_sha TEXT NOT NULL CHECK (
    published_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  published_remote TEXT NOT NULL CHECK (length(trim(published_remote)) > 0),
  runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0),
  runtime_session_id TEXT,
  session_portability TEXT NOT NULL DEFAULT 'transcript_only' CHECK (
    session_portability IN ('transcript_only','same_runner','cross_runner_verified')
  ),
  session_portability_evidence TEXT,
  ask_channel_version INTEGER NOT NULL CHECK (ask_channel_version=1),
  ask_instruction_hash TEXT NOT NULL CHECK (ask_instruction_hash ~ '^[a-f0-9]{64}$'),
  context_manifest JSONB NOT NULL CHECK (jsonb_typeof(context_manifest)='object'),
  canonical_context_manifest TEXT NOT NULL,
  root_context_refs JSONB NOT NULL CHECK (
    jsonb_typeof(root_context_refs)='array' AND jsonb_array_length(root_context_refs) > 0
  ),
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  task_package_hash TEXT CHECK (task_package_hash IS NULL OR task_package_hash ~ '^[a-f0-9]{64}$'),
  compact_summary TEXT NOT NULL CHECK (length(trim(compact_summary)) > 0),
  compact_summary_hash TEXT NOT NULL CHECK (compact_summary_hash ~ '^[a-f0-9]{64}$'),
  budget_reservation_id TEXT NOT NULL REFERENCES budget_reservations(id) ON DELETE RESTRICT,
  root_run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_human' CHECK (
    status IN ('awaiting_human','answered','continuation_queued','resumed','expired','cancelled','failed')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  answered_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id)
    REFERENCES work_conversations(project_id,work_item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,work_item_id,conversation_id,message_id)
    REFERENCES work_messages(project_id,work_item_id,conversation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id,task_id,source_run_id)
    REFERENCES agent_runs(project_id,phase_id,task_id,id) ON DELETE RESTRICT,
  CHECK (root_run_id=source_run_id),
  CONSTRAINT human_waits_portability_shape_check CHECK (
    (session_portability='transcript_only' AND session_portability_evidence IS NULL)
    OR (session_portability<>'transcript_only' AND session_portability_evidence IS NOT NULL)
  ),
  CONSTRAINT human_waits_timing_shape_check CHECK (
    (status IN ('awaiting_human','expired') AND answered_at IS NULL)
    OR (status IN ('answered','continuation_queued','resumed') AND answered_at IS NOT NULL)
    OR status IN ('cancelled','failed')
  ),
  CONSTRAINT human_waits_resume_shape_check CHECK (
    (status='resumed') = (resumed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX human_waits_one_open_per_run
  ON human_waits(source_run_id)
  WHERE status IN ('awaiting_human','answered','continuation_queued');
CREATE INDEX human_waits_scope_status_idx
  ON human_waits(project_id,conversation_id,status,expires_at);

CREATE TABLE human_wait_answers (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  wait_id TEXT NOT NULL UNIQUE REFERENCES human_waits(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  answered_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL UNIQUE REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  decision_record_id TEXT NOT NULL UNIQUE REFERENCES decision_records(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  answer TEXT NOT NULL CHECK (length(trim(answer)) > 0),
  rationale TEXT,
  answer_receipt_hash TEXT NOT NULL CHECK (answer_receipt_hash ~ '^[a-f0-9]{64}$'),
  canonical_answer_receipt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id,answered_by_user_id,idempotency_key)
);

CREATE TABLE human_wait_continuations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  wait_id TEXT NOT NULL UNIQUE REFERENCES human_waits(id) ON DELETE RESTRICT,
  answer_id TEXT NOT NULL UNIQUE REFERENCES human_wait_answers(id) ON DELETE RESTRICT,
  root_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  root_command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE RESTRICT,
  resume_command_id TEXT NOT NULL UNIQUE,
  resume_job_id TEXT NOT NULL UNIQUE,
  budget_reservation_id TEXT NOT NULL REFERENCES budget_reservations(id) ON DELETE RESTRICT,
  saved_commit_sha TEXT NOT NULL CHECK (
    saved_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  answer_receipt_hash TEXT NOT NULL CHECK (answer_receipt_hash ~ '^[a-f0-9]{64}$'),
  replay_context_ref JSONB NOT NULL CHECK (jsonb_typeof(replay_context_ref)='object'),
  canonical_replay_context_ref TEXT NOT NULL,
  runner_id TEXT,
  runner_generation INTEGER CHECK (runner_generation IS NULL OR runner_generation >= 0),
  enrollment_secret_hash TEXT CHECK (
    enrollment_secret_hash IS NULL OR enrollment_secret_hash ~ '^[a-f0-9]{64}$'
  ),
  delivery_receipt_hash TEXT CHECK (
    delivery_receipt_hash IS NULL OR delivery_receipt_hash ~ '^[a-f0-9]{64}$'
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued','leased','provisioned','dispatched','acknowledged','applied','failed')
  ),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  ,CONSTRAINT human_wait_continuations_lease_shape_check CHECK (
    (status='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX human_wait_continuations_claim_idx
  ON human_wait_continuations(status,available_at,lease_expires_at);

CREATE TABLE conversation_pm_update_global_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  update_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (
    update_interval_seconds BETWEEN 60 AND 86400
  ),
  content_level TEXT NOT NULL DEFAULT 'standard' CHECK (
    content_level IN ('concise','standard','detailed')
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO conversation_pm_update_global_settings(singleton) VALUES (true);

CREATE TABLE conversation_pm_update_project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  update_interval_seconds INTEGER CHECK (
    update_interval_seconds IS NULL OR update_interval_seconds BETWEEN 60 AND 86400
  ),
  content_level TEXT CHECK (
    content_level IS NULL OR content_level IN ('concise','standard','detailed')
  ),
  updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_pm_updates (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  transition_sequence BIGINT NOT NULL CHECK (transition_sequence > 0),
  state_hash TEXT NOT NULL CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('working','waiting_for_human','blocked','completed')),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id)
    REFERENCES work_conversations(project_id,work_item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,work_item_id,conversation_id,message_id)
    REFERENCES work_messages(project_id,work_item_id,conversation_id,id) ON DELETE RESTRICT,
  UNIQUE(conversation_id,transition_sequence)
);

CREATE TABLE conversation_pm_update_cursors (
  conversation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  last_evaluated_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ NOT NULL,
  last_state_hash TEXT CHECK (
    last_state_hash IS NULL OR last_state_hash ~ '^[a-f0-9]{64}$'
  ),
  evaluation_count BIGINT NOT NULL DEFAULT 0 CHECK (evaluation_count >= 0),
  transition_count BIGINT NOT NULL DEFAULT 0 CHECK (transition_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id)
    REFERENCES work_conversations(project_id,work_item_id,id) ON DELETE RESTRICT
);
CREATE INDEX conversation_pm_update_cursors_due_idx
  ON conversation_pm_update_cursors(next_due_at,conversation_id);

CREATE OR REPLACE FUNCTION norns_guard_visible_message_parts()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  part JSONB;
  part_type TEXT;
  visible_content TEXT;
BEGIN
  FOR part IN SELECT value FROM jsonb_array_elements(NEW.parts)
  LOOP
    IF jsonb_typeof(part) <> 'object' THEN
      RAISE EXCEPTION 'message parts must be objects' USING ERRCODE='23514';
    END IF;
    part_type := part->>'type';
    IF part_type IS NULL OR part_type NOT IN (
      'text','code','attachment','artifact','action','plan','handoff',
      'planning_excerpt','human_wait','human_wait_update'
    ) THEN
      RAISE EXCEPTION 'message part type % is not user-visible', part_type
        USING ERRCODE='23514';
    END IF;
    IF part_type IN ('text','code') THEN
      visible_content := translate(
        regexp_replace(
          coalesce(part->>CASE WHEN part_type='text' THEN 'text' ELSE 'code' END,''),
          '\s','','g'
        ),
        U&'\200B\200C\200D\2060\FEFF',''
      );
      IF visible_content='' THEN
        RAISE EXCEPTION 'visible text and code parts cannot be blank or zero-width-only'
          USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_set_conversation_action_interaction_class()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  expected_class TEXT;
BEGIN
  expected_class := CASE
    WHEN NEW.action_type IN ('save_plan_candidate','request_plan_changes','propose_plan_change')
      THEN 'plan_change_proposal'
    WHEN NEW.action_type IN (
      'send_plan_to_qc','approve_plan','reject_plan','approve_plan_change',
      'approve_mockup','reject_mockup'
    ) THEN 'approval'
    WHEN NEW.action_type IN ('record_human_decision','answer_human_wait') THEN 'human_decision'
    WHEN NEW.action_type='redirect_agent' THEN 'task_direction'
    WHEN NEW.action_type='pause_work' THEN 'pause'
    WHEN NEW.action_type='resume_work' THEN 'resume'
    WHEN NEW.action_type IN ('create_mockup','revise_mockup') THEN 'mockup_request'
  END;
  IF expected_class IS NULL THEN
    RAISE EXCEPTION 'unsupported conversation action type %', NEW.action_type
      USING ERRCODE='23514';
  END IF;
  IF NEW.interaction_class IS NOT NULL AND NEW.interaction_class<>expected_class THEN
    RAISE EXCEPTION 'interaction class does not match action type'
      USING ERRCODE='23514';
  END IF;
  NEW.interaction_class := expected_class;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_actions_interaction_class_guard
  BEFORE INSERT OR UPDATE OF action_type,interaction_class ON conversation_actions
  FOR EACH ROW EXECUTE FUNCTION norns_set_conversation_action_interaction_class();

CREATE OR REPLACE FUNCTION norns_guard_human_wait_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM commands command
     WHERE command.command_id=NEW.source_command_id
       AND command.project_id=NEW.project_id
       AND command.phase_id=NEW.phase_id
       AND command.task_id=NEW.task_id
       AND command.run_id=NEW.source_run_id
  ) THEN
    RAISE EXCEPTION 'human wait source command scope mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM runner_events event
     WHERE event.id=NEW.source_event_id
       AND event.event_type='human_wait_requested'
       AND event.causation_id=NEW.source_command_id
       AND event.payload->>'run_id'=NEW.source_run_id
  ) THEN
    RAISE EXCEPTION 'human wait source event scope mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM budget_reservations reservation
     WHERE reservation.id=NEW.budget_reservation_id
       AND reservation.project_id=NEW.project_id
       AND reservation.phase_id=NEW.phase_id
       AND reservation.task_id=NEW.task_id
       AND reservation.run_id=NEW.source_run_id
       AND reservation.status='active'
  ) THEN
    RAISE EXCEPTION 'human wait reservation scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER human_waits_scope_guard
  BEFORE INSERT ON human_waits
  FOR EACH ROW EXECUTE FUNCTION norns_guard_human_wait_scope();

CREATE OR REPLACE FUNCTION norns_guard_human_wait_update()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF (
    to_jsonb(NEW) - ARRAY['status','version','answered_at','resumed_at','updated_at']::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY['status','version','answered_at','resumed_at','updated_at']::text[]
  ) THEN
    RAISE EXCEPTION 'human wait immutable identity or evidence changed'
      USING ERRCODE='23514';
  END IF;
  IF NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'human wait version must advance exactly once' USING ERRCODE='23514';
  END IF;
  IF OLD.answered_at IS NOT NULL AND NEW.answered_at IS NULL THEN
    RAISE EXCEPTION 'human wait answered_at cannot be cleared' USING ERRCODE='23514';
  END IF;
  IF NOT (
    (OLD.status='awaiting_human' AND NEW.status IN (
      'answered','continuation_queued','expired','cancelled','failed'
    ))
    OR (OLD.status='answered' AND NEW.status IN ('continuation_queued','cancelled','failed'))
    OR (OLD.status='continuation_queued' AND NEW.status IN ('resumed','cancelled','failed'))
  ) THEN
    RAISE EXCEPTION 'illegal human wait lifecycle transition % -> %',OLD.status,NEW.status
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER human_waits_update_guard
  BEFORE UPDATE ON human_waits
  FOR EACH ROW EXECUTE FUNCTION norns_guard_human_wait_update();

CREATE OR REPLACE FUNCTION norns_guard_human_wait_answer_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM human_waits wait
      JOIN conversation_actions action ON action.id=NEW.action_id
      JOIN decision_records decision ON decision.id=NEW.decision_record_id
     WHERE wait.id=NEW.wait_id
       AND wait.project_id=NEW.project_id
       AND wait.status='awaiting_human'
       AND action.project_id=NEW.project_id
       AND action.work_item_id=wait.work_item_id
       AND action.conversation_id=wait.conversation_id
       AND action.action_type='answer_human_wait'
       AND action.confirmed_by_user_id=NEW.answered_by_user_id
       AND decision.project_id=NEW.project_id
       AND decision.decision_point_id=wait.decision_point_id
  ) THEN
    RAISE EXCEPTION 'human wait answer scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER human_wait_answers_scope_guard
  BEFORE INSERT ON human_wait_answers
  FOR EACH ROW EXECUTE FUNCTION norns_guard_human_wait_answer_scope();

CREATE OR REPLACE FUNCTION norns_guard_human_wait_continuation_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM human_waits wait
      JOIN human_wait_answers answer ON answer.id=NEW.answer_id
      JOIN agent_runs run ON run.id=NEW.root_run_id
      JOIN commands command ON command.command_id=NEW.root_command_id
      JOIN budget_reservations reservation ON reservation.id=NEW.budget_reservation_id
     WHERE wait.id=NEW.wait_id
       AND answer.wait_id=wait.id
       AND run.id=wait.source_run_id
       AND command.command_id=wait.source_command_id
       AND command.run_id=run.id
       AND reservation.id=wait.budget_reservation_id
       AND reservation.run_id=run.id
       AND NEW.saved_commit_sha=wait.published_commit_sha
       AND NEW.context_hash=wait.context_hash
       AND NEW.answer_receipt_hash=answer.answer_receipt_hash
  ) THEN
    RAISE EXCEPTION 'human wait continuation scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER human_wait_continuations_scope_guard
  BEFORE INSERT ON human_wait_continuations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_human_wait_continuation_scope();

CREATE OR REPLACE FUNCTION norns_guard_human_wait_continuation_update()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF (
    to_jsonb(NEW) - ARRAY[
      'status','runner_id','runner_generation','enrollment_secret_hash','delivery_receipt_hash',
      'lease_owner','lease_expires_at','attempts','available_at','last_error','updated_at'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'status','runner_id','runner_generation','enrollment_secret_hash','delivery_receipt_hash',
      'lease_owner','lease_expires_at','attempts','available_at','last_error','updated_at'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'human wait continuation immutable receipt changed'
      USING ERRCODE='23514';
  END IF;
  IF NOT (
    (OLD.status='queued' AND NEW.status='leased')
    OR (OLD.status='leased' AND NEW.status IN ('queued','provisioned','failed'))
    OR (OLD.status='provisioned' AND NEW.status IN ('dispatched','failed'))
    OR (OLD.status='dispatched' AND NEW.status IN ('acknowledged','applied','failed'))
    OR (OLD.status='acknowledged' AND NEW.status IN ('applied','failed'))
  ) THEN
    RAISE EXCEPTION 'illegal continuation lifecycle transition % -> %',OLD.status,NEW.status
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER human_wait_continuations_update_guard
  BEFORE UPDATE ON human_wait_continuations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_human_wait_continuation_update();

CREATE OR REPLACE FUNCTION norns_guard_action_delivery_intent_update()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF (
    to_jsonb(NEW) - ARRAY[
      'status','target_command_id','target_runner_generation','lease_owner','lease_expires_at',
      'attempts','available_at','last_error','updated_at'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'status','target_command_id','target_runner_generation','lease_owner','lease_expires_at',
      'attempts','available_at','last_error','updated_at'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'action delivery intent immutable scope changed'
      USING ERRCODE='23514';
  END IF;
  IF NOT (
    (OLD.status='queued' AND NEW.status='leased')
    OR (OLD.status='leased' AND NEW.status='leased')
    OR (OLD.status='leased' AND NEW.status IN ('queued','sent','failed','fallback_queued'))
    OR (OLD.status='fallback_queued' AND NEW.status IN ('leased','failed'))
    OR (OLD.status='sent' AND NEW.status IN ('acknowledged','failed','fallback_queued'))
    OR (OLD.status='acknowledged' AND NEW.status IN ('applied','failed','fallback_queued'))
  ) THEN
    RAISE EXCEPTION 'illegal action delivery lifecycle transition % -> %',OLD.status,NEW.status
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_action_delivery_intents_update_guard
  BEFORE UPDATE ON conversation_action_delivery_intents
  FOR EACH ROW EXECUTE FUNCTION norns_guard_action_delivery_intent_update();

CREATE OR REPLACE FUNCTION norns_guard_run_command_usage_receipt()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM commands command
     WHERE command.command_id=NEW.command_id AND command.run_id=NEW.run_id
       AND command.project_id=NEW.project_id AND command.phase_id=NEW.phase_id
       AND command.task_id=NEW.task_id
  ) THEN
    RAISE EXCEPTION 'command usage receipt scope does not match command'
      USING ERRCODE='23514';
  END IF;
  IF NEW.last_usage_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runner_events event
     WHERE event.id=NEW.last_usage_event_id AND event.run_id=NEW.run_id
       AND event.causation_id=NEW.command_id AND event.event_type='usage_report'
  ) THEN
    RAISE EXCEPTION 'command usage receipt report event is not exact'
      USING ERRCODE='23514';
  END IF;
  IF NEW.terminal_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runner_events event
     WHERE event.id=NEW.terminal_event_id AND event.run_id=NEW.run_id
       AND event.causation_id=NEW.command_id AND event.event_type='runtime_result'
  ) THEN
    RAISE EXCEPTION 'command usage receipt terminal event is not exact'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='final' THEN
    RAISE EXCEPTION 'final command usage receipts are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND (
     NEW.command_id<>OLD.command_id OR NEW.run_id<>OLD.run_id
     OR NEW.project_id<>OLD.project_id OR NEW.phase_id<>OLD.phase_id
     OR NEW.task_id<>OLD.task_id OR NEW.created_at<>OLD.created_at
  ) THEN
    RAISE EXCEPTION 'command usage receipt scope is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
     NEW.input_tokens<OLD.input_tokens OR NEW.output_tokens<OLD.output_tokens
     OR NEW.cost_usd<OLD.cost_usd OR NEW.active_ms<OLD.active_ms
  ) THEN
    RAISE EXCEPTION 'command usage receipt totals are monotonic' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT (
    NEW.status=OLD.status OR (OLD.status='observing' AND NEW.status='final')
  ) THEN
    RAISE EXCEPTION 'invalid command usage receipt transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER run_command_usage_receipts_update_guard
  BEFORE INSERT OR UPDATE ON run_command_usage_receipts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_run_command_usage_receipt();
CREATE TRIGGER run_command_usage_receipts_delete_guard
  BEFORE DELETE OR TRUNCATE ON run_command_usage_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

CREATE OR REPLACE FUNCTION norns_guard_execution_plan_change_request()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM conversation_actions action
     WHERE action.id=NEW.action_id AND action.project_id=NEW.project_id
       AND action.work_item_id=NEW.work_item_id
       AND action.conversation_id=NEW.conversation_id
       AND action.action_type='propose_plan_change'
       AND action.payload->'parameters'->>'plan_version_id'=NEW.plan_version_id
       AND action.payload->'parameters'->>'plan_hash'=NEW.plan_hash
       AND action.payload->'parameters'->>'direction'=NEW.direction
       AND action.payload->'parameters'->>'rationale'=NEW.rationale
  ) THEN
    RAISE EXCEPTION 'plan-change request is not bound to its exact action payload'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM conversation_actions approval
     WHERE approval.id=NEW.approved_by_action_id
       AND approval.project_id=NEW.project_id
       AND approval.work_item_id=NEW.work_item_id
       AND approval.conversation_id=NEW.conversation_id
       AND approval.action_type='approve_plan_change'
       AND approval.payload->'parameters'->>'proposal_action_id'=NEW.action_id
       AND approval.payload->'parameters'->>'plan_version_id'=NEW.plan_version_id
       AND approval.payload->'parameters'->>'plan_hash'=NEW.plan_hash
  ) THEN
    RAISE EXCEPTION 'plan-change approval is not bound to its exact proposal'
      USING ERRCODE='23514';
  END IF;
  IF OLD.status<>'proposed' OR NEW.status NOT IN ('approved','rejected')
     OR (to_jsonb(NEW)-ARRAY['status','approved_by_action_id','decided_at']::text[])
        IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['status','approved_by_action_id','decided_at']::text[]) THEN
    RAISE EXCEPTION 'invalid execution plan-change request mutation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_execution_plan_change_requests_guard
  BEFORE INSERT OR UPDATE ON conversation_execution_plan_change_requests
  FOR EACH ROW EXECUTE FUNCTION norns_guard_execution_plan_change_request();

CREATE OR REPLACE FUNCTION norns_guard_mockup_request_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conversation_actions action
     WHERE action.id=NEW.action_id AND action.project_id=NEW.project_id
       AND action.work_item_id=NEW.work_item_id
       AND action.conversation_id=NEW.conversation_id
       AND action.action_type='create_mockup'
       AND action.payload->'parameters'->>'brief'=NEW.brief
       AND action.payload->'parameters'->>'target'=NEW.target
       AND COALESCE(action.payload->'parameters'->>'task_id','')
           =COALESCE(NEW.task_id,'')
       AND action.payload->'parameters'->'artifact_refs'=NEW.artifact_refs
  ) THEN
    RAISE EXCEPTION 'mockup request is not bound to its exact action payload'
      USING ERRCODE='23514';
  END IF;
  IF NEW.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_task_package_bindings binding
     WHERE binding.project_id=NEW.project_id AND binding.work_item_id=NEW.work_item_id
       AND binding.conversation_id=NEW.conversation_id AND binding.task_id=NEW.task_id
  ) THEN
    RAISE EXCEPTION 'mockup request task is outside its execution conversation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_mockup_requests_scope_guard
  BEFORE INSERT ON conversation_mockup_requests
  FOR EACH ROW EXECUTE FUNCTION norns_guard_mockup_request_scope();

CREATE TRIGGER conversation_action_delivery_events_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_action_delivery_events
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_action_delivery_events_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_action_delivery_events
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER human_wait_answers_immutable_guard
  BEFORE UPDATE OR DELETE ON human_wait_answers
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER human_wait_answers_immutable_truncate_guard
  BEFORE TRUNCATE ON human_wait_answers
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_pm_updates_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_pm_updates
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_pm_updates_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_pm_updates
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

CREATE OR REPLACE FUNCTION norns_guard_pm_update_cursor_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.conversation_id<>OLD.conversation_id
     OR NEW.project_id<>OLD.project_id
     OR NEW.work_item_id<>OLD.work_item_id
     OR NEW.evaluation_count<OLD.evaluation_count THEN
    RAISE EXCEPTION 'PM update cursor scope and monotonic count are immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_pm_update_cursors_scope_guard
  BEFORE UPDATE ON conversation_pm_update_cursors
  FOR EACH ROW EXECUTE FUNCTION norns_guard_pm_update_cursor_scope();

CREATE OR REPLACE FUNCTION norns_guard_action_checkpoint_context()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  action conversation_actions%ROWTYPE;
  intent conversation_action_delivery_intents%ROWTYPE;
  document task_context_documents%ROWTYPE;
BEGIN
  SELECT * INTO action FROM conversation_actions WHERE id=NEW.action_id;
  SELECT * INTO intent FROM conversation_action_delivery_intents WHERE action_id=NEW.action_id;
  SELECT * INTO document FROM task_context_documents WHERE id=NEW.context_document_id;
  IF action.id IS NULL OR action.action_type<>'redirect_agent'
     OR action.project_id<>NEW.project_id OR action.work_item_id<>NEW.work_item_id
     OR action.conversation_id<>NEW.conversation_id
     OR action.payload->'parameters'->>'task_id'<>NEW.task_id
     OR intent.id IS NULL
     OR document.id IS NULL OR document.project_id<>NEW.project_id
     OR document.sha256<>NEW.context_hash THEN
    RAISE EXCEPTION 'checkpoint context scope is not exact' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND (NEW.status<>'prepared' OR intent.status<>'fallback_queued') THEN
    RAISE EXCEPTION 'checkpoint context must bind a fallback direction'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.action_id<>OLD.action_id OR NEW.project_id<>OLD.project_id
       OR NEW.work_item_id<>OLD.work_item_id OR NEW.conversation_id<>OLD.conversation_id
       OR NEW.task_id<>OLD.task_id OR NEW.created_at<>OLD.created_at THEN
      RAISE EXCEPTION 'checkpoint context immutable scope changed' USING ERRCODE='23514';
    END IF;
    IF OLD.status='prepared' AND NEW.status='prepared' THEN
      IF NEW.command_id IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.applied_at IS NOT NULL THEN
        RAISE EXCEPTION 'prepared checkpoint rebind forged delivery evidence'
          USING ERRCODE='23514';
      END IF;
    ELSIF OLD.status='prepared' AND NEW.status='sent' THEN
      IF NOT EXISTS (
        SELECT 1 FROM commands command,
             jsonb_array_elements(command.envelope->'context_refs') reference
         WHERE command.command_id=NEW.command_id AND command.task_id=NEW.task_id
           AND command.project_id=NEW.project_id
           AND reference->>'artifact_id'=NEW.context_document_id
           AND reference->>'content_hash'=NEW.context_hash
           AND (reference->>'byte_size')::bigint=document.byte_size
      ) THEN
        RAISE EXCEPTION 'checkpoint sent command does not contain exact context'
          USING ERRCODE='23514';
      END IF;
    ELSIF OLD.status='sent' AND NEW.status IN ('applied','failed') THEN
      IF NEW.context_document_id<>OLD.context_document_id
         OR NEW.context_hash<>OLD.context_hash
         OR NEW.command_id<>OLD.command_id OR NEW.sent_at<>OLD.sent_at THEN
        RAISE EXCEPTION 'delivered checkpoint receipt is immutable'
          USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'illegal checkpoint context lifecycle % -> %',OLD.status,NEW.status
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_action_checkpoint_contexts_guard
  BEFORE INSERT OR UPDATE ON conversation_action_checkpoint_contexts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_action_checkpoint_context();

CREATE OR REPLACE FUNCTION norns_guard_pause_checkpoint()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  pause_action conversation_actions%ROWTYPE;
  resume_action conversation_actions%ROWTYPE;
BEGIN
  SELECT * INTO pause_action FROM conversation_actions WHERE id=NEW.pause_action_id;
  IF pause_action.id IS NULL OR pause_action.action_type<>'pause_work'
     OR pause_action.status<>'applied'
     OR pause_action.project_id<>NEW.project_id
     OR pause_action.work_item_id<>NEW.work_item_id
     OR pause_action.conversation_id<>NEW.conversation_id
     OR NOT EXISTS (
       SELECT 1 FROM agent_runs run
        WHERE run.id=NEW.run_id AND run.project_id=NEW.project_id
          AND run.phase_id=NEW.phase_id AND run.task_id=NEW.task_id
          AND (
            (NEW.status IN ('paused','resume_queued','leased')
             AND run.state='waiting_for_human')
            OR (NEW.status IN ('provisioned','dispatched')
                AND run.state IN ('dispatched','running'))
            OR (NEW.status='resumed' AND run.state='running')
            OR NEW.status='failed'
          )
          AND run.published_branch=NEW.published_branch
          AND run.published_commit_sha=NEW.published_commit_sha
          AND run.published_remote=NEW.published_remote
     )
     OR NOT EXISTS (
       SELECT 1 FROM budget_reservations reservation
        WHERE reservation.id=NEW.budget_reservation_id
          AND reservation.run_id=NEW.run_id
          AND reservation.project_id=NEW.project_id
          AND reservation.phase_id=NEW.phase_id
          AND reservation.task_id=NEW.task_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM commands command
        WHERE command.command_id=NEW.source_command_id AND command.run_id=NEW.run_id
          AND command.project_id=NEW.project_id AND command.phase_id=NEW.phase_id
          AND command.task_id=NEW.task_id
          AND command.envelope->'context_refs'=NEW.root_context_refs
     )
     OR NOT EXISTS (
       SELECT 1 FROM budget_reservations reservation
        WHERE reservation.id=NEW.budget_reservation_id
          AND reservation.status='active'
     ) THEN
    RAISE EXCEPTION 'pause checkpoint scope or publication is not exact'
      USING ERRCODE='23514';
  END IF;
  IF NEW.resume_action_id IS NOT NULL THEN
    SELECT * INTO resume_action FROM conversation_actions WHERE id=NEW.resume_action_id;
    IF resume_action.id IS NULL OR resume_action.action_type<>'resume_work'
       OR resume_action.project_id<>NEW.project_id
       OR resume_action.work_item_id<>NEW.work_item_id
       OR resume_action.conversation_id<>NEW.conversation_id THEN
      RAISE EXCEPTION 'pause resume action scope is not exact' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.status<>'paused' THEN
    RAISE EXCEPTION 'pause checkpoint must start paused' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (
      to_jsonb(NEW) - ARRAY[
        'resume_action_id','resume_context_ref','resume_command_id','resume_job_id',
        'runner_id','runner_generation','enrollment_secret_hash',
        'status','lease_owner','lease_expires_at',
        'attempts','available_at','last_error','resumed_at','updated_at'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'resume_action_id','resume_context_ref','resume_command_id','resume_job_id',
        'runner_id','runner_generation','enrollment_secret_hash',
        'status','lease_owner','lease_expires_at',
        'attempts','available_at','last_error','resumed_at','updated_at'
      ]::text[]
    ) THEN
      RAISE EXCEPTION 'pause checkpoint immutable receipt changed' USING ERRCODE='23514';
    END IF;
    IF NOT (
      (OLD.status='paused' AND NEW.status='resume_queued')
      OR (OLD.status='resume_queued' AND NEW.status='leased')
      OR (OLD.status='leased' AND NEW.status IN ('resume_queued','provisioned','failed'))
      OR (OLD.status='provisioned' AND NEW.status IN ('dispatched','failed'))
      OR (OLD.status='dispatched' AND NEW.status IN ('resumed','failed'))
    ) THEN
      RAISE EXCEPTION 'illegal pause checkpoint lifecycle % -> %',OLD.status,NEW.status
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_pause_checkpoints_guard
  BEFORE INSERT OR UPDATE ON conversation_pause_checkpoints
  FOR EACH ROW EXECUTE FUNCTION norns_guard_pause_checkpoint();

REVOKE ALL PRIVILEGES ON
  conversation_action_delivery_intents,
  conversation_action_delivery_events,
  run_command_usage_receipts,
  conversation_execution_plan_change_requests,
  conversation_mockup_requests,
  conversation_action_checkpoint_contexts,
  conversation_pause_checkpoints,
  human_waits,
  human_wait_answers,
  human_wait_continuations,
  conversation_pm_update_global_settings,
  conversation_pm_update_project_settings,
  conversation_pm_updates,
  conversation_pm_update_cursors
FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON
  conversation_action_delivery_intents,
  run_command_usage_receipts,
  conversation_execution_plan_change_requests,
  conversation_mockup_requests,
  conversation_action_checkpoint_contexts,
  conversation_pause_checkpoints,
  human_waits,
  human_wait_continuations,
  conversation_pm_update_project_settings,
  conversation_pm_update_cursors
TO norns_app;
GRANT DELETE ON conversation_pm_update_project_settings TO norns_app;
GRANT SELECT,INSERT ON
  conversation_action_delivery_events,
  human_wait_answers,
  conversation_pm_updates
TO norns_app;
GRANT SELECT ON conversation_pm_update_global_settings TO norns_app;
GRANT INSERT (proposal_idempotency_key,proposal_request_fingerprint,interaction_class)
  ON conversation_actions TO norns_app;
