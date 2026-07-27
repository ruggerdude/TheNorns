-- Conversation-first work Phase 4: an atomic planning-to-execution
-- transition, immutable compact handoffs, scoped excerpt receipts, semantic
-- compaction receipts, and a durable post-commit kickoff outbox.

DO $conversation_execution_handoff_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0037_conversation_plan_workflow'
  ) THEN
    RAISE EXCEPTION
      '0038_conversation_execution_handoff requires 0037_conversation_plan_workflow'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_execution_handoff_dependency$;

CREATE VIEW conversation_execution_handoff_v1 AS
SELECT 1::INTEGER AS version;
REVOKE ALL ON conversation_execution_handoff_v1 FROM PUBLIC;
GRANT SELECT ON conversation_execution_handoff_v1 TO norns_app;

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
      RAISE EXCEPTION 'message parts must be objects'
        USING ERRCODE = '23514';
    END IF;
    part_type := part->>'type';
    IF part_type IS NULL OR part_type NOT IN (
      'text', 'code', 'attachment', 'artifact', 'action', 'plan',
      'handoff', 'planning_excerpt'
    ) THEN
      RAISE EXCEPTION 'message part type % is not user-visible', part_type
        USING ERRCODE = '23514';
    END IF;
    IF part_type IN ('text', 'code') THEN
      visible_content :=
        translate(
          regexp_replace(
            coalesce(part->>CASE WHEN part_type = 'text' THEN 'text' ELSE 'code' END, ''),
            '\s',
            '',
            'g'
          ),
          U&'\200B\200C\200D\2060\FEFF',
          ''
        );
      IF visible_content = '' THEN
        RAISE EXCEPTION 'visible text and code parts cannot be blank or zero-width-only'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;

-- Store the exact canonical bytes that were hashed. JSONB preserves semantic
-- equality but not the application's canonical serialization; this receipt
-- lets PostgreSQL independently reject a mismatched package/hash.
ALTER TABLE conversation_handoffs
  ADD COLUMN canonical_package TEXT;

CREATE OR REPLACE FUNCTION norns_validate_conversation_handoff_plan()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  approved_plan work_plan_versions%ROWTYPE;
  approved_task_sequence JSONB;
  source_conversation work_conversations%ROWTYPE;
  target_conversation work_conversations%ROWTYPE;
  manifest_count INTEGER;
  manifest_distinct_count INTEGER;
  approved_manifest_count INTEGER;
  approved_manifest_kind_count INTEGER;
  malformed_manifest_count INTEGER;
BEGIN
  SELECT * INTO approved_plan
    FROM work_plan_versions
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.approved_plan_version_id;
  SELECT * INTO source_conversation
    FROM work_conversations
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.source_conversation_id;
  SELECT * INTO target_conversation
    FROM work_conversations
   WHERE project_id = NEW.project_id
     AND work_item_id = NEW.work_item_id
     AND id = NEW.target_conversation_id;
  IF source_conversation.kind <> 'planning'
     OR source_conversation.status <> 'archived'
     OR target_conversation.kind <> 'execution_pm'
     OR target_conversation.status <> 'active' THEN
    RAISE EXCEPTION 'handoff requires archived planning source and active execution PM target'
      USING ERRCODE = '23514';
  END IF;
  IF approved_plan.id IS NULL
     OR approved_plan.status <> 'approved'
     OR approved_plan.conversation_id <> NEW.source_conversation_id
     OR NEW.package->>'approved_plan_version_id' <> approved_plan.id
     OR NEW.package->>'approved_plan_content_hash' <> approved_plan.content_hash
     OR NEW.package->'approved_plan' IS DISTINCT FROM approved_plan.plan THEN
    RAISE EXCEPTION 'handoff must freeze the exact approved plan version and content'
      USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.package)) <> 18
     OR NOT (NEW.package ?& ARRAY[
       'approved_plan_version_id','approved_plan_content_hash','approved_plan',
       'objective','binding_rules','human_decisions',
       'qc_findings_and_dispositions','unresolved_risks_and_questions',
       'task_sequence','staffing','budget','required_mockup_artifact_ids',
       'acceptance_evidence','artifact_ids','phase_ids','task_ids',
       'repository_binding_ids','context_manifest'
     ])
     OR jsonb_typeof(NEW.package->'binding_rules') <> 'array'
     OR jsonb_typeof(NEW.package->'human_decisions') <> 'array'
     OR jsonb_typeof(NEW.package->'qc_findings_and_dispositions') <> 'array'
     OR jsonb_typeof(NEW.package->'unresolved_risks_and_questions') <> 'array'
     OR jsonb_typeof(NEW.package->'required_mockup_artifact_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'acceptance_evidence') <> 'array'
     OR jsonb_typeof(NEW.package->'artifact_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'phase_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'task_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'repository_binding_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'context_manifest') <> 'array' THEN
    RAISE EXCEPTION 'handoff package is missing required structured transition evidence'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*),
         count(DISTINCT (reference->>'kind', reference->>'ref')),
         count(*) FILTER (WHERE reference->>'kind'='approved_plan'),
         count(*) FILTER (
           WHERE reference->>'kind'='approved_plan'
             AND reference->>'ref'=NEW.approved_plan_version_id
             AND reference->>'content_hash'=approved_plan.content_hash
         ),
         count(*) FILTER (
           WHERE jsonb_typeof(reference) <> 'object'
              OR CASE WHEN jsonb_typeof(reference) = 'object'
                      THEN (SELECT count(*) FROM jsonb_object_keys(reference)) <> 3
                      ELSE true END
              OR coalesce(reference->>'kind','') NOT IN (
                'approved_plan','global_rules','project_rules','decision',
                'qc_review','artifact','phase','task','repository'
              )
              OR length(trim(coalesce(reference->>'ref',''))) = 0
              OR coalesce(reference->>'content_hash','') !~ '^[a-f0-9]{64}$'
         )
    INTO manifest_count, manifest_distinct_count,
         approved_manifest_kind_count, approved_manifest_count,
         malformed_manifest_count
    FROM jsonb_array_elements(NEW.package->'context_manifest') reference;
  IF manifest_count <> manifest_distinct_count
     OR approved_manifest_kind_count <> 1
     OR approved_manifest_count <> 1
     OR malformed_manifest_count <> 0 THEN
    RAISE EXCEPTION 'handoff manifest must uniquely bind the exact approved plan'
      USING ERRCODE = '23514';
  END IF;
  SELECT jsonb_agg(module->'id' ORDER BY ordinal)
    INTO approved_task_sequence
    FROM jsonb_array_elements(approved_plan.plan->'plan'->'modules')
      WITH ORDINALITY AS planned_module(module, ordinal);
  IF NEW.package->>'objective' IS DISTINCT FROM approved_plan.plan->'plan'->>'objective'
     OR NEW.package->'staffing' IS DISTINCT FROM approved_plan.plan->'staffing'
     OR NEW.package->'budget' IS DISTINCT FROM approved_plan.plan->'estimated_budget'
     OR NEW.package->'task_sequence' IS DISTINCT FROM approved_task_sequence THEN
    RAISE EXCEPTION 'handoff projections must equal the approved plan'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.canonical_package IS NULL
     OR NEW.canonical_package::jsonb IS DISTINCT FROM NEW.package
     OR encode(sha256(convert_to(NEW.canonical_package, 'UTF8')), 'hex') <> NEW.content_hash THEN
    RAISE EXCEPTION 'handoff content hash must match its exact canonical package'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

ALTER TABLE conversation_plan_action_effects
  ADD COLUMN execution_conversation_id TEXT,
  ADD COLUMN handoff_id TEXT,
  ADD COLUMN kickoff_intent_id TEXT;

CREATE TABLE conversation_kickoff_intents (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  execution_conversation_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  approved_plan_version_id TEXT NOT NULL,
  plan_review_id TEXT NOT NULL,
  planning_run_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  decided_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','succeeded','refused','failed')),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  execution_started BOOLEAN,
  execution_detail TEXT,
  phase_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT conversation_kickoff_intents_source_scope_fk
    FOREIGN KEY (project_id, work_item_id, source_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_target_scope_fk
    FOREIGN KEY (project_id, work_item_id, execution_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_action_fk
    FOREIGN KEY (action_id)
    REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_plan_fk
    FOREIGN KEY (approved_plan_version_id)
    REFERENCES work_plan_versions(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_review_fk
    FOREIGN KEY (plan_review_id)
    REFERENCES conversation_plan_reviews(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_run_fk
    FOREIGN KEY (planning_run_id)
    REFERENCES planning_runs(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_handoff_fk
    FOREIGN KEY (handoff_id)
    REFERENCES conversation_handoffs(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_phase_fk
    FOREIGN KEY (project_id, phase_id)
    REFERENCES phases(project_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_kickoff_intents_action_unique UNIQUE (action_id),
  CONSTRAINT conversation_kickoff_intents_handoff_unique UNIQUE (handoff_id),
  CONSTRAINT conversation_kickoff_intents_identity_unique
    UNIQUE (project_id, work_item_id, source_conversation_id, id),
  CONSTRAINT conversation_kickoff_intents_lifecycle_check CHECK (
    (
      status = 'pending'
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND execution_started IS NULL AND execution_detail IS NULL
      AND phase_id IS NULL AND settled_at IS NULL
    ) OR (
      status = 'leased'
      AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND execution_started IS NULL AND execution_detail IS NULL
      AND phase_id IS NULL AND settled_at IS NULL
    ) OR (
      status IN ('succeeded','refused','failed')
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND execution_started IS NOT NULL AND execution_detail IS NOT NULL
      AND settled_at IS NOT NULL
      AND ((status = 'succeeded' AND execution_started AND phase_id IS NOT NULL)
        OR (status IN ('refused','failed') AND NOT execution_started AND phase_id IS NULL))
    )
  )
);
CREATE INDEX conversation_kickoff_intents_dispatch_idx
  ON conversation_kickoff_intents(status, lease_expires_at, created_at, id);

ALTER TABLE conversation_plan_action_effects
  ADD CONSTRAINT conversation_plan_action_effects_execution_conversation_fk
    FOREIGN KEY (project_id, work_item_id, execution_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT conversation_plan_action_effects_handoff_fk
    FOREIGN KEY (handoff_id) REFERENCES conversation_handoffs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT conversation_plan_action_effects_kickoff_intent_fk
    FOREIGN KEY (kickoff_intent_id) REFERENCES conversation_kickoff_intents(id) ON DELETE RESTRICT;

ALTER TABLE conversation_plan_action_effects
  ADD CONSTRAINT conversation_plan_action_effects_transition_shape_check CHECK (
    effect_kind <> 'plan_approved'
    OR (
      execution_conversation_id IS NOT NULL
      AND handoff_id IS NOT NULL
      AND kickoff_intent_id IS NOT NULL
    )
  ) NOT VALID;

CREATE TABLE conversation_task_packages (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  approved_plan_version_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  package JSONB NOT NULL CHECK (jsonb_typeof(package) = 'object'),
  canonical_package TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_task_packages_conversation_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_task_packages_handoff_fk
    FOREIGN KEY (handoff_id) REFERENCES conversation_handoffs(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_task_packages_plan_fk
    FOREIGN KEY (approved_plan_version_id) REFERENCES work_plan_versions(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_task_packages_module_unique UNIQUE (handoff_id, module_id),
  CONSTRAINT conversation_task_packages_canonical_hash_check CHECK (
    canonical_package::jsonb = package
    AND encode(sha256(convert_to(canonical_package, 'UTF8')), 'hex') = content_hash
  )
);

-- A package is frozen at approval, before the existing strategy bridge has
-- materialized relational tasks. Kickoff creates this immutable binding after
-- materialization and before dispatch. The content document id is the exact
-- canonical package bytes in the content-addressed task-context store.
CREATE TABLE conversation_task_package_bindings (
  package_id TEXT PRIMARY KEY
    REFERENCES conversation_task_packages(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  context_document_id TEXT NOT NULL
    REFERENCES task_context_documents(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_task_package_bindings_task_unique UNIQUE (task_id),
  CONSTRAINT conversation_task_package_bindings_task_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id)
    REFERENCES tasks(project_id, phase_id, id) ON DELETE RESTRICT
);

-- Written in the coordinator transaction that creates agent_runs. This makes
-- the package identity/hash auditable on the task, run, and emitted dispatch
-- envelope rather than relying only on a coincidentally matching context ref.
CREATE TABLE conversation_task_package_runs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  package_id TEXT NOT NULL
    REFERENCES conversation_task_package_bindings(package_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  context_document_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_task_package_runs_scope_fk
    FOREIGN KEY (project_id, phase_id, task_id, run_id)
    REFERENCES agent_runs(project_id, phase_id, task_id, id) ON DELETE RESTRICT
);

CREATE TABLE conversation_planning_excerpt_receipts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  target_conversation_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  source_message_ids JSONB NOT NULL CHECK (
    jsonb_typeof(source_message_ids) = 'array'
    AND jsonb_array_length(source_message_ids) BETWEEN 1 AND 20
  ),
  source_message_hashes JSONB NOT NULL CHECK (
    jsonb_typeof(source_message_hashes) = 'array'
    AND jsonb_array_length(source_message_hashes) = jsonb_array_length(source_message_ids)
  ),
  canonical_source_messages JSONB NOT NULL CHECK (
    jsonb_typeof(canonical_source_messages) = 'array'
    AND jsonb_array_length(canonical_source_messages) = jsonb_array_length(source_message_ids)
  ),
  result_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_planning_excerpt_source_scope_fk
    FOREIGN KEY (project_id, work_item_id, source_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_planning_excerpt_target_scope_fk
    FOREIGN KEY (project_id, work_item_id, target_conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_planning_excerpt_handoff_fk
    FOREIGN KEY (handoff_id) REFERENCES conversation_handoffs(id) ON DELETE RESTRICT,
  CONSTRAINT conversation_planning_excerpt_message_scope_fk
    FOREIGN KEY (project_id, work_item_id, target_conversation_id, result_message_id)
    REFERENCES work_messages(project_id, work_item_id, conversation_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_planning_excerpt_idempotency_unique
    UNIQUE (target_conversation_id, requested_by_user_id, idempotency_key),
  CONSTRAINT conversation_planning_excerpt_result_unique UNIQUE (result_message_id)
);

CREATE TABLE conversation_compaction_receipts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  summary_id TEXT NOT NULL REFERENCES conversation_summaries(id) ON DELETE RESTRICT,
  milestone TEXT NOT NULL CHECK (
    milestone IN ('plan_approved','semantic_milestone','context_threshold')
  ),
  source_message_ids JSONB NOT NULL CHECK (
    jsonb_typeof(source_message_ids) = 'array'
    AND jsonb_array_length(source_message_ids) > 0
  ),
  source_message_hashes JSONB NOT NULL CHECK (
    jsonb_typeof(source_message_hashes) = 'array'
    AND jsonb_array_length(source_message_hashes) = jsonb_array_length(source_message_ids)
  ),
  canonical_source_messages JSONB NOT NULL CHECK (
    jsonb_typeof(canonical_source_messages) = 'array'
    AND jsonb_array_length(canonical_source_messages) = jsonb_array_length(source_message_ids)
  ),
  canonical_summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_compaction_receipts_conversation_scope_fk
    FOREIGN KEY (project_id, work_item_id, conversation_id)
    REFERENCES work_conversations(project_id, work_item_id, id) ON DELETE RESTRICT,
  CONSTRAINT conversation_compaction_receipts_summary_unique UNIQUE (summary_id)
);

CREATE FUNCTION norns_validate_phase4_execution_transition()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  transition_handoff conversation_handoffs%ROWTYPE;
  transition_intent conversation_kickoff_intents%ROWTYPE;
  execution_conversation work_conversations%ROWTYPE;
BEGIN
  IF NEW.effect_kind <> 'plan_approved' THEN
    IF NEW.execution_conversation_id IS NOT NULL
       OR NEW.handoff_id IS NOT NULL
       OR NEW.kickoff_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'only plan approval effects can own execution transition records'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO transition_handoff FROM conversation_handoffs WHERE id=NEW.handoff_id;
  SELECT * INTO transition_intent FROM conversation_kickoff_intents WHERE id=NEW.kickoff_intent_id;
  SELECT * INTO execution_conversation
    FROM work_conversations WHERE id=NEW.execution_conversation_id;
  IF transition_handoff.source_conversation_id <> NEW.conversation_id
     OR transition_handoff.target_conversation_id <> NEW.execution_conversation_id
     OR transition_handoff.approved_plan_version_id <> NEW.plan_version_id
     OR transition_intent.action_id <> NEW.action_id
     OR transition_intent.handoff_id <> NEW.handoff_id
     OR transition_intent.execution_conversation_id <> NEW.execution_conversation_id
     OR execution_conversation.kind <> 'execution_pm' THEN
    RAISE EXCEPTION 'approval effect transition records must share exact scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE CONSTRAINT TRIGGER conversation_plan_action_effects_transition_guard
  AFTER INSERT OR UPDATE OF execution_conversation_id, handoff_id, kickoff_intent_id
  ON conversation_plan_action_effects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_validate_phase4_execution_transition();

CREATE FUNCTION norns_validate_kickoff_intent_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_action conversation_actions%ROWTYPE;
  source_plan work_plan_versions%ROWTYPE;
  source_review conversation_plan_reviews%ROWTYPE;
  source_handoff conversation_handoffs%ROWTYPE;
  source_conversation work_conversations%ROWTYPE;
  target_conversation work_conversations%ROWTYPE;
BEGIN
  SELECT * INTO source_action FROM conversation_actions WHERE id=NEW.action_id;
  SELECT * INTO source_plan FROM work_plan_versions WHERE id=NEW.approved_plan_version_id;
  SELECT * INTO source_review FROM conversation_plan_reviews WHERE id=NEW.plan_review_id;
  SELECT * INTO source_handoff FROM conversation_handoffs WHERE id=NEW.handoff_id;
  SELECT * INTO source_conversation FROM work_conversations WHERE id=NEW.source_conversation_id;
  SELECT * INTO target_conversation FROM work_conversations WHERE id=NEW.execution_conversation_id;
  IF source_action.project_id <> NEW.project_id
     OR source_action.work_item_id <> NEW.work_item_id
     OR source_action.conversation_id <> NEW.source_conversation_id
     OR source_action.action_type <> 'approve_plan'
     OR source_action.confirmed_by_user_id <> NEW.decided_by_user_id
     OR source_action.payload->'parameters'->>'plan_version_id' <> NEW.approved_plan_version_id
     OR source_action.payload->'parameters'->>'plan_review_id' <> NEW.plan_review_id
     OR source_plan.status <> 'approved'
     OR source_plan.conversation_id <> NEW.source_conversation_id
     OR source_review.status NOT IN ('converged','cap_reached')
     OR source_review.planning_run_id <> NEW.planning_run_id
     OR coalesce(source_review.revised_plan_version_id, source_review.plan_version_id)
          <> NEW.approved_plan_version_id
     OR source_handoff.source_conversation_id <> NEW.source_conversation_id
     OR source_handoff.target_conversation_id <> NEW.execution_conversation_id
     OR source_handoff.approved_plan_version_id <> NEW.approved_plan_version_id
     OR source_conversation.kind <> 'planning'
     OR source_conversation.status <> 'archived'
     OR target_conversation.kind <> 'execution_pm'
     OR target_conversation.status <> 'active' THEN
    RAISE EXCEPTION 'kickoff intent scope must equal its approved action, review, run, and handoff'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_kickoff_intents_scope_guard
  BEFORE INSERT ON conversation_kickoff_intents
  FOR EACH ROW EXECUTE FUNCTION norns_validate_kickoff_intent_scope();

CREATE FUNCTION norns_validate_task_package_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_handoff conversation_handoffs%ROWTYPE;
  planned_module JSONB;
  planned_staffing JSONB;
  malformed_manifest_count INTEGER;
BEGIN
  SELECT * INTO source_handoff FROM conversation_handoffs WHERE id=NEW.handoff_id;
  SELECT module INTO planned_module
    FROM jsonb_array_elements(source_handoff.package->'approved_plan'->'plan'->'modules')
      AS planned(module)
   WHERE module->>'id'=NEW.module_id;
  SELECT staffing INTO planned_staffing
    FROM jsonb_array_elements(source_handoff.package->'staffing') AS staffed(staffing)
   WHERE staffing->>'module_id'=NEW.module_id;
  IF source_handoff.project_id <> NEW.project_id
     OR source_handoff.work_item_id <> NEW.work_item_id
     OR source_handoff.target_conversation_id <> NEW.conversation_id
     OR source_handoff.approved_plan_version_id <> NEW.approved_plan_version_id
     OR planned_module IS NULL OR planned_staffing IS NULL
     OR NEW.package->'module' IS DISTINCT FROM planned_module
     OR NEW.package->'staffing' IS DISTINCT FROM planned_staffing
     OR NEW.package->>'approved_plan_version_id'
          IS DISTINCT FROM source_handoff.approved_plan_version_id
     OR NEW.package->>'approved_plan_content_hash'
          IS DISTINCT FROM source_handoff.package->>'approved_plan_content_hash'
     OR NEW.package->>'objective' IS DISTINCT FROM source_handoff.package->>'objective'
     OR NEW.package->'budget' IS DISTINCT FROM source_handoff.package->'budget'
     OR NEW.package->'binding_rules' IS DISTINCT FROM source_handoff.package->'binding_rules'
     OR NEW.package->'human_decisions' IS DISTINCT FROM source_handoff.package->'human_decisions'
     OR NEW.package->'artifact_ids' IS DISTINCT FROM source_handoff.package->'artifact_ids'
     OR NEW.package->'repository_binding_ids'
          IS DISTINCT FROM source_handoff.package->'repository_binding_ids'
     OR NEW.package->'context_manifest' IS DISTINCT FROM source_handoff.package->'context_manifest'
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.package)) <> 11
     OR NOT (NEW.package ?& ARRAY[
       'approved_plan_version_id','approved_plan_content_hash','objective',
       'module','staffing','budget','binding_rules','human_decisions',
       'artifact_ids','repository_binding_ids','context_manifest'
     ])
     OR jsonb_typeof(NEW.package->'binding_rules') <> 'array'
     OR jsonb_typeof(NEW.package->'human_decisions') <> 'array'
     OR jsonb_typeof(NEW.package->'artifact_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'repository_binding_ids') <> 'array'
     OR jsonb_typeof(NEW.package->'context_manifest') <> 'array' THEN
    RAISE EXCEPTION 'task package must be an exact module-scoped handoff projection'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) FILTER (
           WHERE jsonb_typeof(reference) <> 'object'
              OR CASE WHEN jsonb_typeof(reference) = 'object'
                      THEN (SELECT count(*) FROM jsonb_object_keys(reference)) <> 3
                      ELSE true END
              OR coalesce(reference->>'kind','') NOT IN (
                'approved_plan','global_rules','project_rules','decision',
                'qc_review','artifact','phase','task','repository'
              )
              OR length(trim(coalesce(reference->>'ref',''))) = 0
              OR coalesce(reference->>'content_hash','') !~ '^[a-f0-9]{64}$'
         )
    INTO malformed_manifest_count
    FROM jsonb_array_elements(NEW.package->'context_manifest') reference;
  IF malformed_manifest_count <> 0 THEN
    RAISE EXCEPTION 'task package manifest entries must be exact auditable references'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_task_packages_scope_guard
  BEFORE INSERT ON conversation_task_packages
  FOR EACH ROW EXECUTE FUNCTION norns_validate_task_package_scope();

-- Byte-for-byte equivalent to JavaScript encodeURIComponent for UTF-8 input.
-- Materialized strategy identities use that encoding, so the database can
-- independently prove module -> proposed local id -> canonical task id.
CREATE FUNCTION norns_encode_uri_component(input TEXT)
RETURNS TEXT IMMUTABLE STRICT LANGUAGE plpgsql AS $encode$
DECLARE
  bytes BYTEA := convert_to(input, 'UTF8');
  result TEXT := '';
  value INTEGER;
  position INTEGER;
BEGIN
  IF octet_length(bytes) = 0 THEN
    RETURN result;
  END IF;
  FOR position IN 0..octet_length(bytes)-1 LOOP
    value := get_byte(bytes, position);
    IF (value BETWEEN 65 AND 90)
       OR (value BETWEEN 97 AND 122)
       OR (value BETWEEN 48 AND 57)
       OR value IN (33,39,40,41,42,45,46,95,126) THEN
      result := result || chr(value);
    ELSE
      result := result || '%' || upper(lpad(to_hex(value),2,'0'));
    END IF;
  END LOOP;
  RETURN result;
END
$encode$;

CREATE FUNCTION norns_validate_task_package_binding()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_package conversation_task_packages%ROWTYPE;
  source_task tasks%ROWTYPE;
  source_phase phases%ROWTYPE;
  source_intent conversation_kickoff_intents%ROWTYPE;
  source_document task_context_documents%ROWTYPE;
  source_bytes BYTEA;
  expected_acceptance JSONB;
  expected_task_id TEXT;
BEGIN
  SELECT * INTO source_package
    FROM conversation_task_packages WHERE id=NEW.package_id;
  SELECT * INTO source_task FROM tasks WHERE id=NEW.task_id;
  SELECT * INTO source_phase FROM phases WHERE id=NEW.phase_id;
  SELECT * INTO source_intent
    FROM conversation_kickoff_intents WHERE handoff_id=NEW.handoff_id;
  SELECT * INTO source_document
    FROM task_context_documents WHERE id=NEW.context_document_id;
  SELECT content INTO source_bytes
    FROM task_context_blobs WHERE sha256=source_document.sha256;
  expected_task_id :=
    'task:' || norns_encode_uri_component(NEW.phase_id) || ':' ||
    norns_encode_uri_component('task-' || source_package.module_id);
  SELECT coalesce(jsonb_agg(criterion->'statement' ORDER BY ordinal), '[]'::jsonb)
    INTO expected_acceptance
    FROM jsonb_array_elements(source_package.package->'module'->'acceptance')
      WITH ORDINALITY AS criteria(criterion, ordinal);
  IF source_package.id IS NULL
     OR source_task.id IS NULL
     OR source_phase.id IS NULL
     OR source_intent.id IS NULL
     OR source_document.id IS NULL
     OR source_bytes IS NULL
     OR source_package.project_id <> NEW.project_id
     OR source_package.work_item_id <> NEW.work_item_id
     OR source_package.conversation_id <> NEW.conversation_id
     OR source_package.handoff_id <> NEW.handoff_id
     OR source_package.content_hash <> NEW.content_hash
     OR source_task.project_id <> NEW.project_id
     OR source_task.phase_id <> NEW.phase_id
     OR source_task.id <> expected_task_id
     OR source_phase.project_id <> NEW.project_id
     OR source_phase.planning_run_id <> source_intent.planning_run_id
     OR source_intent.execution_conversation_id <> NEW.conversation_id
     OR source_task.strategy_version_id <> source_phase.approved_strategy_version_id
     OR source_task.title <> source_package.package->'module'->>'title'
     OR source_task.description <> source_package.package->'module'->>'description'
     OR source_task.deliverables IS DISTINCT FROM source_package.package->'module'->'deliverables'
     OR source_task.acceptance_criteria IS DISTINCT FROM expected_acceptance
     OR source_document.project_id <> NEW.project_id
     OR source_document.section <> 'approved_task_package'
     OR source_document.media_type <> 'application/json'
     OR source_document.sha256 <> source_package.content_hash
     OR source_document.byte_size <> octet_length(convert_to(source_package.canonical_package,'UTF8'))
     OR source_bytes IS DISTINCT FROM convert_to(source_package.canonical_package,'UTF8') THEN
    RAISE EXCEPTION 'task package binding must match the exact materialized approved module'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_task_package_bindings_scope_guard
  BEFORE INSERT ON conversation_task_package_bindings
  FOR EACH ROW EXECUTE FUNCTION norns_validate_task_package_binding();

CREATE FUNCTION norns_validate_task_package_run()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_binding conversation_task_package_bindings%ROWTYPE;
  source_run agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO source_binding
    FROM conversation_task_package_bindings WHERE package_id=NEW.package_id;
  SELECT * INTO source_run FROM agent_runs WHERE id=NEW.run_id;
  IF source_binding.project_id <> NEW.project_id
     OR source_binding.phase_id <> NEW.phase_id
     OR source_binding.task_id <> NEW.task_id
     OR source_binding.content_hash <> NEW.content_hash
     OR source_binding.context_document_id <> NEW.context_document_id
     OR source_run.project_id <> NEW.project_id
     OR source_run.phase_id <> NEW.phase_id
     OR source_run.task_id <> NEW.task_id THEN
    RAISE EXCEPTION 'run package binding must equal its immutable task package binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_task_package_runs_scope_guard
  BEFORE INSERT ON conversation_task_package_runs
  FOR EACH ROW EXECUTE FUNCTION norns_validate_task_package_run();

CREATE FUNCTION norns_validate_excerpt_receipt_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_handoff conversation_handoffs%ROWTYPE;
  source_conversation work_conversations%ROWTYPE;
  target_conversation work_conversations%ROWTYPE;
  result_message work_messages%ROWTYPE;
  receipt_count INTEGER;
  distinct_count INTEGER;
  matching_count INTEGER;
  expected_ids JSONB;
BEGIN
  SELECT * INTO source_handoff FROM conversation_handoffs WHERE id=NEW.handoff_id;
  SELECT * INTO source_conversation FROM work_conversations WHERE id=NEW.source_conversation_id;
  SELECT * INTO target_conversation FROM work_conversations WHERE id=NEW.target_conversation_id;
  SELECT * INTO result_message FROM work_messages WHERE id=NEW.result_message_id;
  SELECT count(*) INTO receipt_count
    FROM jsonb_array_elements_text(NEW.source_message_ids);
  SELECT count(DISTINCT value) INTO distinct_count
    FROM jsonb_array_elements_text(NEW.source_message_ids);
  SELECT jsonb_agg(message.id ORDER BY message.sequence, message.id)
    INTO expected_ids
    FROM work_messages message
   WHERE message.project_id=NEW.project_id
     AND message.work_item_id=NEW.work_item_id
     AND message.conversation_id=NEW.source_conversation_id
     AND message.visibility_status='complete'
     AND message.id IN (
       SELECT value FROM jsonb_array_elements_text(NEW.source_message_ids)
     );
  SELECT count(*) INTO matching_count
    FROM jsonb_array_elements_text(NEW.source_message_ids) WITH ORDINALITY ids(id, ordinal)
    JOIN jsonb_array_elements_text(NEW.source_message_hashes)
      WITH ORDINALITY hashes(hash, ordinal) USING (ordinal)
    JOIN jsonb_array_elements_text(NEW.canonical_source_messages)
      WITH ORDINALITY canonical(payload, ordinal) USING (ordinal)
    JOIN work_messages message
      ON message.id=ids.id
     AND message.project_id=NEW.project_id
     AND message.work_item_id=NEW.work_item_id
     AND message.conversation_id=NEW.source_conversation_id
     AND message.visibility_status='complete'
   WHERE canonical.payload::jsonb = jsonb_build_object(
           'parts', message.parts,
           'role', message.role,
           'sequence', message.sequence
         )
     AND encode(sha256(convert_to(canonical.payload, 'UTF8')), 'hex')=hashes.hash;
  IF source_handoff.source_conversation_id <> NEW.source_conversation_id
     OR source_handoff.target_conversation_id <> NEW.target_conversation_id
     OR source_conversation.kind <> 'planning'
     OR source_conversation.status <> 'archived'
     OR target_conversation.kind <> 'execution_pm'
     OR target_conversation.status <> 'active'
     OR distinct_count <> receipt_count
     OR expected_ids IS DISTINCT FROM NEW.source_message_ids
     OR matching_count <> receipt_count
     OR result_message.conversation_id <> NEW.target_conversation_id
     OR result_message.visibility_status <> 'complete'
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(result_message.parts) part
        WHERE part->>'type'='planning_excerpt'
          AND part->>'excerpt_receipt_id'=NEW.id
     ) THEN
    RAISE EXCEPTION 'planning excerpt receipt must bind exact linked complete messages and result card'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE CONSTRAINT TRIGGER conversation_planning_excerpt_receipts_scope_guard
  AFTER INSERT ON conversation_planning_excerpt_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_validate_excerpt_receipt_scope();

CREATE FUNCTION norns_validate_compaction_receipt_scope()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  source_summary conversation_summaries%ROWTYPE;
  receipt_count INTEGER;
  distinct_count INTEGER;
  matching_count INTEGER;
  range_count INTEGER;
  expected_ids JSONB;
  first_sequence BIGINT;
  last_sequence BIGINT;
BEGIN
  SELECT * INTO source_summary FROM conversation_summaries WHERE id=NEW.summary_id;
  SELECT count(*) INTO receipt_count
    FROM jsonb_array_elements_text(NEW.source_message_ids);
  SELECT count(DISTINCT value) INTO distinct_count
    FROM jsonb_array_elements_text(NEW.source_message_ids);
  SELECT count(*), min(message.sequence), max(message.sequence)
    INTO matching_count, first_sequence, last_sequence
    FROM jsonb_array_elements_text(NEW.source_message_ids) WITH ORDINALITY ids(id, ordinal)
    JOIN jsonb_array_elements_text(NEW.source_message_hashes)
      WITH ORDINALITY hashes(hash, ordinal) USING (ordinal)
    JOIN jsonb_array_elements_text(NEW.canonical_source_messages)
      WITH ORDINALITY canonical(payload, ordinal) USING (ordinal)
    JOIN work_messages message
      ON message.id=ids.id
     AND message.project_id=NEW.project_id
     AND message.work_item_id=NEW.work_item_id
     AND message.conversation_id=NEW.conversation_id
     AND message.visibility_status='complete'
   WHERE canonical.payload::jsonb = jsonb_build_object(
           'parts', message.parts,
           'role', message.role,
           'sequence', message.sequence
         )
     AND encode(sha256(convert_to(canonical.payload, 'UTF8')), 'hex')=hashes.hash;
  SELECT count(*), jsonb_agg(message.id ORDER BY message.sequence, message.id)
    INTO range_count, expected_ids
    FROM work_messages message
   WHERE message.project_id=NEW.project_id
     AND message.work_item_id=NEW.work_item_id
     AND message.conversation_id=NEW.conversation_id
     AND message.visibility_status='complete'
     AND message.sequence BETWEEN source_summary.from_message_sequence
                              AND source_summary.through_message_sequence;
  IF source_summary.project_id <> NEW.project_id
     OR source_summary.work_item_id <> NEW.work_item_id
     OR source_summary.conversation_id <> NEW.conversation_id
     OR distinct_count <> receipt_count
     OR matching_count <> receipt_count
     OR range_count <> receipt_count
     OR expected_ids IS DISTINCT FROM NEW.source_message_ids
     OR first_sequence <> source_summary.from_message_sequence
     OR last_sequence <> source_summary.through_message_sequence
     OR NEW.canonical_summary::jsonb IS DISTINCT FROM source_summary.summary
     OR encode(sha256(convert_to(NEW.canonical_summary, 'UTF8')), 'hex')
          <> source_summary.content_hash THEN
    RAISE EXCEPTION 'compaction receipt must bind its exact summary and complete source range'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_compaction_receipts_scope_guard
  BEFORE INSERT ON conversation_compaction_receipts
  FOR EACH ROW EXECUTE FUNCTION norns_validate_compaction_receipt_scope();

CREATE FUNCTION norns_guard_kickoff_intent_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.project_id <> OLD.project_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.source_conversation_id <> OLD.source_conversation_id
     OR NEW.execution_conversation_id <> OLD.execution_conversation_id
     OR NEW.action_id <> OLD.action_id
     OR NEW.approved_plan_version_id <> OLD.approved_plan_version_id
     OR NEW.plan_review_id <> OLD.plan_review_id
     OR NEW.planning_run_id <> OLD.planning_run_id
     OR NEW.handoff_id <> OLD.handoff_id
     OR NEW.decided_by_user_id <> OLD.decided_by_user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kickoff intent identity and approval scope are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('succeeded','refused','failed') THEN
    RAISE EXCEPTION 'settled kickoff intents are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status='leased')
    OR (OLD.status='leased' AND NEW.status IN ('pending','succeeded','refused','failed'))
  ) THEN
    RAISE EXCEPTION 'invalid kickoff intent transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_kickoff_intents_lifecycle_guard
  BEFORE UPDATE ON conversation_kickoff_intents
  FOR EACH ROW EXECUTE FUNCTION norns_guard_kickoff_intent_lifecycle();

CREATE TRIGGER conversation_task_packages_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_task_packages
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_packages_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_task_packages
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_package_bindings_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_task_package_bindings
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_package_bindings_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_task_package_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_package_runs_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_task_package_runs
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_package_runs_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_task_package_runs
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_planning_excerpt_receipts_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_planning_excerpt_receipts
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_planning_excerpt_receipts_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_planning_excerpt_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_compaction_receipts_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_compaction_receipts
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_compaction_receipts_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_compaction_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

REVOKE ALL PRIVILEGES ON
  conversation_kickoff_intents,
  conversation_task_packages,
  conversation_task_package_bindings,
  conversation_task_package_runs,
  conversation_planning_excerpt_receipts,
  conversation_compaction_receipts
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON conversation_kickoff_intents TO norns_app;
GRANT SELECT, INSERT ON
  conversation_task_packages,
  conversation_task_package_bindings,
  conversation_task_package_runs,
  conversation_planning_excerpt_receipts,
  conversation_compaction_receipts
TO norns_app;
GRANT UPDATE (execution_conversation_id, handoff_id, kickoff_intent_id)
  ON conversation_plan_action_effects TO norns_app;
GRANT SELECT, INSERT (canonical_package) ON conversation_handoffs TO norns_app;
