-- Phase 6 acceptance corrections: planning-module mockups flow through the
-- exact execution task package, delivered evidence is visible in the execution
-- conversation, and every accepted implementation is bound through a frozen
-- approved-mockup supplement.

DO $phase6_acceptance_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM norns_schema_migrations
     WHERE name = '0041_phase6_runtime_delivery'
  ) THEN
    RAISE EXCEPTION
      '0042_phase6_acceptance_corrections requires 0041_phase6_runtime_delivery'
      USING ERRCODE = '55000';
  END IF;
END
$phase6_acceptance_dependency$;

CREATE TABLE phase6_idempotency_claims (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (
    operation IN ('artifact_put','deployment_create','deployment_observation')
  ),
  actor_type TEXT NOT NULL CHECK (length(trim(actor_type))>0),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id))>0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key))>0),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  resource_id TEXT NOT NULL CHECK (length(trim(resource_id))>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,operation,actor_type,actor_id,idempotency_key)
);
CREATE TRIGGER phase6_idempotency_claims_immutable_guard
  BEFORE UPDATE OR DELETE ON phase6_idempotency_claims
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER phase6_idempotency_claims_immutable_truncate_guard
  BEFORE TRUNCATE ON phase6_idempotency_claims
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
REVOKE ALL PRIVILEGES ON phase6_idempotency_claims FROM PUBLIC;
REVOKE ALL PRIVILEGES ON phase6_idempotency_claims FROM norns_app;
GRANT SELECT,INSERT ON phase6_idempotency_claims TO norns_app;

CREATE OR REPLACE FUNCTION norns_guard_mockup_version()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  request RECORD;
  prior RECORD;
  manifest RECORD;
  root_action_payload JSONB;
  manifest_json JSONB;
  renderer_fixed_clock TIMESTAMPTZ;
BEGIN
  SELECT * INTO request FROM conversation_mockup_requests WHERE id=NEW.request_id FOR SHARE;
  SELECT * INTO manifest FROM artifacts WHERE id=NEW.manifest_artifact_id FOR SHARE;
  SELECT action.payload INTO root_action_payload
    FROM conversation_mockup_requests root_request
    JOIN conversation_actions action ON action.id=root_request.action_id
   WHERE root_request.id=NEW.root_request_id;
  manifest_json := NEW.canonical_manifest::jsonb;
  IF request.id IS NULL
     OR request.root_request_id<>NEW.root_request_id
     OR request.project_id<>NEW.project_id
     OR request.work_item_id<>NEW.work_item_id
     OR request.conversation_id<>NEW.conversation_id
     OR request.task_id IS DISTINCT FROM NEW.task_id
     OR request.action_id<>NEW.created_by_action_id
     OR request.brief<>NEW.brief OR request.target<>NEW.target
     OR request.status<>'leased'
     OR root_action_payload IS NULL
     OR manifest_json->>'mockup_version_id'<>NEW.id
     OR manifest_json->>'root_request_id'<>NEW.root_request_id
     OR manifest_json->>'request_id'<>NEW.request_id
     OR manifest_json->>'task_id' IS DISTINCT FROM NEW.task_id
     OR manifest_json->>'version'<>NEW.version::text
     OR manifest_json->>'brief'<>NEW.brief
     OR manifest_json->>'target'<>NEW.target
     OR manifest_json->'interaction_notes'<>NEW.interaction_notes
     OR manifest_json->>'plan_version_id'
          IS DISTINCT FROM root_action_payload->'parameters'->>'plan_version_id'
     OR manifest_json->>'module_id'
          IS DISTINCT FROM root_action_payload->'parameters'->>'module_id'
     OR (
       (manifest_json->>'plan_version_id' IS NULL)
       <> (manifest_json->>'module_id' IS NULL)
     )
     OR (
       NEW.task_id IS NOT NULL
       AND (
         manifest_json->>'plan_version_id' IS NOT NULL
         OR manifest_json->>'module_id' IS NOT NULL
       )
     ) THEN
    RAISE EXCEPTION 'mockup version does not match its immutable request and target'
      USING ERRCODE='23514';
  END IF;
  IF NEW.version=1 THEN
    IF NEW.root_request_id<>NEW.request_id OR NEW.supersedes_mockup_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'first mockup version must be its root request'
        USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO prior FROM conversation_mockup_versions
     WHERE id=NEW.supersedes_mockup_version_id FOR SHARE;
    IF prior.id IS NULL OR prior.root_request_id<>NEW.root_request_id
       OR NEW.version<>prior.version+1
       OR request.source_mockup_version_id<>prior.id
       OR NOT EXISTS (
         SELECT 1 FROM conversation_mockup_decisions decision
          WHERE decision.mockup_version_id=prior.id
            AND decision.decision='revision_requested'
            AND decision.action_id=request.action_id
            AND decision.direction=request.revision_direction
       ) THEN
      RAISE EXCEPTION 'revised mockup version lacks its exact prior revision decision'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF manifest.id IS NULL OR manifest.project_id<>NEW.project_id
     OR manifest.kind<>'mockup' OR manifest.media_type<>'application/json'
     OR manifest.content_hash<>NEW.manifest_artifact_hash
     OR NOT EXISTS (
       SELECT 1 FROM artifact_blobs blob
        WHERE blob.artifact_id=manifest.id
          AND blob.content_hash=NEW.manifest_artifact_hash
     ) THEN
    RAISE EXCEPTION 'mockup manifest requires an exact project-scoped JSON artifact blob'
      USING ERRCODE='23514';
  END IF;
  BEGIN
    renderer_fixed_clock := (NEW.renderer_profile->>'fixed_clock')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'mockup renderer fixed clock is not a valid instant'
      USING ERRCODE='23514';
  END;
  IF jsonb_array_length(NEW.interaction_notes)>32
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(NEW.interaction_notes) note
        WHERE jsonb_typeof(note)<>'string'
           OR length(trim(note#>>'{}'))=0
     )
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.renderer_profile))<>10
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(NEW.renderer_profile) entry
        WHERE entry.key<>'pixel_ratio' AND jsonb_typeof(entry.value)<>'string'
     )
     OR jsonb_typeof(NEW.renderer_profile->'pixel_ratio')<>'number'
     OR NEW.renderer_profile->>'renderer'<>'norns-deterministic-v1'
     OR COALESCE(NEW.renderer_profile->>'renderer_revision','')
          !~ '^[a-f0-9]{64}$'
     OR COALESCE(NEW.renderer_profile->>'font_revision','')
          !~ '^[a-f0-9]{64}$'
     OR NEW.renderer_profile->>'pixel_ratio'<>'1'
     OR NEW.renderer_profile->>'network'<>'disabled'
     OR NEW.renderer_profile->>'scripts'<>'disabled'
     OR NEW.renderer_profile->>'locale'<>'en-US'
     OR NEW.renderer_profile->>'timezone'<>'UTC'
     OR COALESCE(NEW.renderer_profile->>'fixed_clock','')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
     OR COALESCE(NEW.renderer_profile->>'seed','') !~ '^[a-f0-9]{64}$'
     OR manifest_json->'renderer_profile'<>NEW.renderer_profile
     OR NOT EXISTS (
       SELECT 1 FROM artifact_blobs blob
        WHERE blob.artifact_id=manifest.id
          AND blob.content=convert_to(NEW.canonical_manifest,'UTF8')
     ) THEN
    RAISE EXCEPTION 'mockup renderer profile or canonical manifest bytes are not exact'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_assert_mockup_version_complete(version_id TEXT)
RETURNS void LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  desktop RECORD;
  mobile RECORD;
  manifest JSONB;
  expected_manifest JSONB;
  root_action_payload JSONB;
  target_keys_required BOOLEAN;
BEGIN
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=version_id FOR SHARE;
  SELECT screenshot.*,artifact.label INTO desktop
    FROM conversation_mockup_version_artifacts screenshot
    JOIN artifacts artifact ON artifact.id=screenshot.artifact_id
   WHERE screenshot.mockup_version_id=version_id AND screenshot.viewport='desktop'
   FOR SHARE OF screenshot,artifact;
  SELECT screenshot.*,artifact.label INTO mobile
    FROM conversation_mockup_version_artifacts screenshot
    JOIN artifacts artifact ON artifact.id=screenshot.artifact_id
   WHERE screenshot.mockup_version_id=version_id AND screenshot.viewport='mobile'
   FOR SHARE OF screenshot,artifact;
  SELECT action.payload INTO root_action_payload
    FROM conversation_mockup_requests root_request
    JOIN conversation_actions action ON action.id=root_request.action_id
   WHERE root_request.id=version.root_request_id;
  manifest := version.canonical_manifest::jsonb;
  target_keys_required :=
    root_action_payload->'parameters'->>'plan_version_id' IS NOT NULL
    OR root_action_payload->'parameters'->>'module_id' IS NOT NULL
    OR manifest ? 'plan_version_id'
    OR manifest ? 'module_id';
  expected_manifest := jsonb_build_object(
    'schema_version',2,
    'kind','mockup',
    'mockup_version_id',version.id,
    'root_request_id',version.root_request_id,
    'request_id',version.request_id,
    'task_id',to_jsonb(version.task_id),
    'version',version.version,
    'brief',version.brief,
    'target',version.target,
    'interaction_notes',version.interaction_notes,
    'renderer_profile',version.renderer_profile,
    'screenshots',jsonb_build_array(
      jsonb_build_object(
        'viewport','desktop',
        'artifact',jsonb_build_object(
          'artifact_id',desktop.artifact_id,
          'content_hash',desktop.artifact_hash,
          'media_type','image/png',
          'label',desktop.label
        ),
        'width',desktop.width,
        'height',desktop.height,
        'capture_profile',desktop.capture_profile
      ),
      jsonb_build_object(
        'viewport','mobile',
        'artifact',jsonb_build_object(
          'artifact_id',mobile.artifact_id,
          'content_hash',mobile.artifact_hash,
          'media_type','image/png',
          'label',mobile.label
        ),
        'width',mobile.width,
        'height',mobile.height,
        'capture_profile',mobile.capture_profile
      )
    )
  );
  IF target_keys_required THEN
    expected_manifest := expected_manifest || jsonb_build_object(
      'plan_version_id',
        to_jsonb(root_action_payload->'parameters'->>'plan_version_id'),
      'module_id',
        to_jsonb(root_action_payload->'parameters'->>'module_id')
    );
  END IF;
  IF version.id IS NULL OR desktop.artifact_id IS NULL OR mobile.artifact_id IS NULL
     OR (SELECT count(*) FROM conversation_mockup_version_artifacts artifact
          WHERE artifact.mockup_version_id=version_id)<>2
     OR manifest<>expected_manifest THEN
    RAISE EXCEPTION 'mockup manifest is not bound to its reviewed fields, target, and exact screenshots'
      USING ERRCODE='23514';
  END IF;
END
$guard$;

DO $replace_mockup_scope_fks$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT constraint_entry.conname INTO constraint_name
    FROM pg_constraint constraint_entry
   WHERE constraint_entry.conrelid='implementation_visual_evidence_collections'::regclass
     AND constraint_entry.contype='f'
     AND pg_get_constraintdef(constraint_entry.oid)
           LIKE 'FOREIGN KEY (project_id, work_item_id, conversation_id, approved_mockup_version_id)%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE implementation_visual_evidence_collections DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
  SELECT constraint_entry.conname INTO constraint_name
    FROM pg_constraint constraint_entry
   WHERE constraint_entry.conrelid='implementation_visual_evidence'::regclass
     AND constraint_entry.contype='f'
     AND pg_get_constraintdef(constraint_entry.oid)
           LIKE 'FOREIGN KEY (project_id, work_item_id, conversation_id, approved_mockup_version_id)%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE implementation_visual_evidence DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END
$replace_mockup_scope_fks$;

ALTER TABLE implementation_visual_evidence_collections
  ADD CONSTRAINT implementation_visual_evidence_collections_mockup_project_fk
  FOREIGN KEY (project_id,approved_mockup_version_id)
  REFERENCES conversation_mockup_versions(project_id,id) ON DELETE RESTRICT;

ALTER TABLE implementation_visual_evidence
  ADD CONSTRAINT implementation_visual_evidence_mockup_project_fk
  FOREIGN KEY (project_id,approved_mockup_version_id)
  REFERENCES conversation_mockup_versions(project_id,id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION norns_guard_mockup_decision()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  action RECORD;
  root_action RECORD;
  expected_action_type TEXT;
BEGIN
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.mockup_version_id FOR UPDATE;
  PERFORM norns_assert_mockup_version_complete(NEW.mockup_version_id);
  SELECT * INTO action FROM conversation_actions WHERE id=NEW.action_id FOR SHARE;
  SELECT root.payload INTO root_action
    FROM conversation_mockup_requests request
    JOIN conversation_actions root ON root.id=request.action_id
   WHERE request.id=version.root_request_id;
  expected_action_type := CASE NEW.decision
    WHEN 'approved' THEN 'approve_mockup'
    WHEN 'revision_requested' THEN 'revise_mockup'
    WHEN 'rejected' THEN 'reject_mockup'
  END;
  IF version.id IS NULL OR action.id IS NULL
     OR version.project_id<>NEW.project_id
     OR version.work_item_id<>NEW.work_item_id
     OR version.conversation_id<>NEW.conversation_id
     OR action.project_id<>NEW.project_id
     OR action.work_item_id<>NEW.work_item_id
     OR action.conversation_id<>NEW.conversation_id
     OR action.action_type<>expected_action_type
     OR action.status NOT IN ('confirmed','recorded','sent','agent_acknowledged','applied')
     OR action.confirmed_by_user_id<>NEW.decided_by_user_id
     OR action.payload->'parameters'->>'mockup_version_id'<>version.id
     OR action.payload->'parameters'->>'manifest_artifact_id'<>version.manifest_artifact_id
     OR action.payload->'parameters'->>'manifest_artifact_hash'<>version.manifest_artifact_hash
     OR NEW.manifest_artifact_id<>version.manifest_artifact_id
     OR NEW.manifest_artifact_hash<>version.manifest_artifact_hash
     OR (
       NEW.decision='approved'
       AND NOT (
         (
           version.task_id IS NOT NULL
           AND action.payload->'parameters'->>'task_id'=version.task_id
           AND COALESCE(action.payload->'parameters'->>'plan_version_id','')=''
           AND COALESCE(action.payload->'parameters'->>'module_id','')=''
         )
         OR
         (
           version.task_id IS NULL
           AND action.payload->'parameters'->>'plan_version_id'
                 =root_action.payload->'parameters'->>'plan_version_id'
           AND action.payload->'parameters'->>'module_id'
                 =root_action.payload->'parameters'->>'module_id'
           AND COALESCE(action.payload->'parameters'->>'task_id','')=''
           AND EXISTS (
             SELECT 1 FROM work_plan_versions plan
              WHERE plan.id=action.payload->'parameters'->>'plan_version_id'
                AND plan.project_id=NEW.project_id
                AND plan.work_item_id=NEW.work_item_id
                AND plan.conversation_id=NEW.conversation_id
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(plan.plan->'plan'->'modules') module
                   WHERE module->>'id'=action.payload->'parameters'->>'module_id'
                )
           )
         )
       )
     ) THEN
    RAISE EXCEPTION 'mockup decision is not bound to the complete exact version and target'
      USING ERRCODE='23514';
  END IF;
  IF NEW.decision='revision_requested'
     AND action.payload->'parameters'->>'direction'<>NEW.direction THEN
    RAISE EXCEPTION 'mockup revision direction does not match its action'
      USING ERRCODE='23514';
  END IF;
  IF NEW.decision='rejected'
     AND action.payload->'parameters'->>'reason'<>NEW.rationale THEN
    RAISE EXCEPTION 'mockup rejection reason does not match its action'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_task_package_supplement()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  binding RECORD;
  package RECORD;
  handoff RECORD;
  version RECORD;
  decision RECORD;
  document RECORD;
  root_action RECORD;
  expected_supplement JSONB;
BEGIN
  PERFORM 1 FROM tasks WHERE id=NEW.task_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM dispatch_jobs job
     WHERE job.task_id=NEW.task_id
       AND job.status IN ('queued','awaiting_enrollment','leased','delivered')
  ) THEN
    RAISE EXCEPTION
      'approved mockup supplement must be frozen before a task command is dispatched'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO binding FROM conversation_task_package_bindings
   WHERE package_id=NEW.base_package_id FOR SHARE;
  SELECT * INTO package FROM conversation_task_packages
   WHERE id=NEW.base_package_id FOR SHARE;
  SELECT * INTO handoff FROM conversation_handoffs
   WHERE id=package.handoff_id FOR SHARE;
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.source_mockup_version_id FOR SHARE;
  SELECT * INTO decision FROM conversation_mockup_decisions
   WHERE id=NEW.approval_decision_id FOR SHARE;
  SELECT * INTO document FROM task_context_documents
   WHERE id=NEW.context_document_id FOR SHARE;
  SELECT root.payload INTO root_action
    FROM conversation_mockup_requests request
    JOIN conversation_actions root ON root.id=request.action_id
   WHERE request.id=version.root_request_id;
  expected_supplement := jsonb_build_object(
    'schema_version',2,
    'kind','approved_mockup',
    'mockup_version_id',version.id,
    'manifest_artifact_id',version.manifest_artifact_id,
    'manifest_artifact_hash',version.manifest_artifact_hash,
    'approval',jsonb_build_object(
      'decision_id',decision.id,
      'action_id',decision.action_id,
      'decided_by_user_id',decision.decided_by_user_id,
      'decided_at',to_char(decision.created_at AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'brief',version.brief,
    'target',version.target,
    'interaction_notes',version.interaction_notes,
    'renderer_profile',version.renderer_profile,
    'screenshots',version.canonical_manifest::jsonb->'screenshots',
    'implementation_visual_evidence_requirement',jsonb_build_object(
      'manifest_path','.norns/visual-evidence.json',
      'producer','playwright',
      'approved_mockup_version_id',version.id,
      'required_captures',jsonb_build_array(
        jsonb_build_object('viewport','desktop','width',1440,'height',1024,
                           'media_type','image/png'),
        jsonb_build_object('viewport','mobile','width',390,'height',844,
                           'media_type','image/png')
      ),
      'capture_profile',jsonb_build_object(
        'renderer','playwright','pixel_ratio',1,'network','application_only',
        'locale','en-US','timezone','UTC'
      ),
      'manifest_schema',jsonb_build_object(
        'root_keys',jsonb_build_array(
          'schema_version','approved_mockup_version_id','capture_profile','screenshots'
        ),
        'capture_profile_keys',jsonb_build_array(
          'renderer','browser_name','browser_version','font_revision','pixel_ratio',
          'network','locale','timezone','fixed_clock'
        ),
        'screenshot_keys',jsonb_build_array('viewport','path','content_hash'),
        'manifest_template',jsonb_build_object(
          'schema_version',2,
          'approved_mockup_version_id',version.id,
          'capture_profile',jsonb_build_object(
            'renderer','playwright',
            'browser_name','<non-empty Playwright browser name>',
            'browser_version','<non-empty Playwright browser version>',
            'font_revision','<64 lowercase hex SHA-256 of the exact loaded font profile>',
            'pixel_ratio',1,
            'network','application_only',
            'locale','en-US',
            'timezone','UTC',
            'fixed_clock','<one ISO-8601 UTC instant frozen for both captures>'
          ),
          'screenshots',jsonb_build_array(
            jsonb_build_object(
              'viewport','desktop',
              'path','.norns/visual-evidence/desktop-1440x1024.png',
              'content_hash','<64 lowercase hex SHA-256 of this PNG''s bytes>'
            ),
            jsonb_build_object(
              'viewport','mobile',
              'path','.norns/visual-evidence/mobile-390x844.png',
              'content_hash','<64 lowercase hex SHA-256 of this PNG''s bytes>'
            )
          )
        )
      ),
      'production_rules',jsonb_build_array(
        'Use Playwright to capture the implemented application at exactly 1440x1024 and 390x844 with deviceScaleFactor 1.',
        'Replace every angle-bracket placeholder in the template with the observed value; do not add or omit manifest keys.',
        'Compute each content_hash from the exact PNG file bytes using lowercase SHA-256.',
        'Commit the manifest and both ordinary, non-symlink PNG files in the same implementation commit before verification and deployment.'
      ),
      'commit_policy',
        'manifest_and_pngs_must_be_regular_files_in_the_verified_implementation_commit'
    )
  );
  IF binding.package_id IS NULL OR package.id IS NULL
     OR version.id IS NULL OR decision.id IS NULL
     OR binding.project_id<>NEW.project_id
     OR binding.work_item_id<>NEW.work_item_id
     OR binding.conversation_id<>NEW.conversation_id
     OR binding.task_id<>NEW.task_id
     OR package.project_id<>NEW.project_id
     OR package.work_item_id<>NEW.work_item_id
     OR package.conversation_id<>NEW.conversation_id
     OR version.project_id<>NEW.project_id
     OR version.work_item_id<>NEW.work_item_id
     OR NOT (
       (
         version.task_id=NEW.task_id
         AND version.conversation_id=NEW.conversation_id
       )
       OR
       (
         handoff.id IS NOT NULL
         AND
         version.task_id IS NULL
         AND version.conversation_id=handoff.source_conversation_id
         AND NEW.conversation_id=handoff.target_conversation_id
         AND root_action.payload->'parameters'->>'plan_version_id'
               =package.approved_plan_version_id
         AND root_action.payload->'parameters'->>'module_id'=package.module_id
       )
     )
     OR decision.mockup_version_id<>version.id
     OR decision.decision<>'approved'
     OR decision.manifest_artifact_id<>version.manifest_artifact_id
     OR decision.manifest_artifact_hash<>version.manifest_artifact_hash
     OR NEW.manifest_artifact_id<>version.manifest_artifact_id
     OR NEW.manifest_artifact_hash<>version.manifest_artifact_hash
     OR NEW.ordinal<>(
       SELECT COALESCE(max(existing.ordinal),0)+1
         FROM conversation_task_package_supplements existing
        WHERE existing.base_package_id=NEW.base_package_id
     )
     OR NEW.supplement<>expected_supplement
     OR document.id IS NULL OR document.project_id<>NEW.project_id
     OR document.section<>'approved_mockup'
     OR document.sha256<>NEW.content_hash
     OR document.byte_size<>NEW.context_byte_size
     OR document.media_type<>NEW.context_media_type
     OR NOT EXISTS (
       SELECT 1 FROM task_context_blobs blob
        WHERE blob.sha256=NEW.content_hash
          AND blob.content=convert_to(NEW.canonical_supplement,'UTF8')
     ) THEN
    RAISE EXCEPTION 'task package supplement is not bound to its approved exact mockup'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_visual_evidence_collection()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  run RECORD;
  verification RECORD;
  deployment RECORD;
  observation RECORD;
BEGIN
  IF TG_OP='UPDATE' AND (
    to_jsonb(NEW) - ARRAY[
      'status','command_id','dispatch_job_id','runner_id','runner_generation',
      'evidence_id','attempts','available_at','lease_owner','lease_expires_at',
      'last_error','updated_at','completed_at'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'status','command_id','dispatch_job_id','runner_id','runner_generation',
      'evidence_id','attempts','available_at','lease_owner','lease_expires_at',
      'last_error','updated_at','completed_at'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'visual evidence collection scope is immutable'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.approved_mockup_version_id FOR SHARE;
  SELECT * INTO run FROM agent_runs WHERE id=NEW.run_id FOR SHARE;
  SELECT * INTO verification FROM verification_results
   WHERE id=NEW.verification_result_id FOR SHARE;
  SELECT * INTO deployment FROM project_delivery_records
   WHERE id=NEW.deployment_record_id FOR SHARE;
  SELECT * INTO observation FROM project_delivery_observations
   WHERE id=NEW.deployment_observation_id FOR SHARE;
  IF version.id IS NULL OR version.project_id<>NEW.project_id
     OR version.work_item_id<>NEW.work_item_id
     OR NOT EXISTS (
       SELECT 1
         FROM conversation_task_package_supplements supplement
        WHERE supplement.project_id=NEW.project_id
          AND supplement.work_item_id=NEW.work_item_id
         AND supplement.conversation_id=NEW.conversation_id
         AND supplement.task_id=NEW.task_id
         AND supplement.source_mockup_version_id=version.id
          AND supplement.supplement ? 'implementation_visual_evidence_requirement'
          AND supplement.supplement#>>'{implementation_visual_evidence_requirement,approved_mockup_version_id}'
                =version.id
     )
     OR NOT EXISTS (
       SELECT 1 FROM conversation_mockup_decisions decision
        WHERE decision.mockup_version_id=version.id AND decision.decision='approved'
     )
     OR run.id IS NULL OR run.project_id<>NEW.project_id
     OR run.phase_id<>NEW.phase_id OR run.task_id<>NEW.task_id
     OR run.repository_binding_id<>NEW.repository_binding_id
     OR run.published_commit_sha<>NEW.commit_sha OR run.publication_outcome<>'pushed'
     OR verification.id IS NULL OR verification.passed<>true
     OR verification.run_id<>NEW.run_id OR verification.commit_sha<>NEW.commit_sha
     OR deployment.id IS NULL OR deployment.status<>'succeeded'
     OR deployment.run_id<>NEW.run_id OR deployment.commit_sha<>NEW.commit_sha
     OR observation.id IS NULL OR observation.delivery_record_id<>deployment.id
     OR observation.sequence<>deployment.current_observation_sequence
     OR observation.status<>'succeeded'
     OR (
       NEW.status='completed'
       AND NOT EXISTS (
         SELECT 1 FROM implementation_visual_evidence evidence
          WHERE evidence.id=NEW.evidence_id AND evidence.project_id=NEW.project_id
            AND evidence.run_id=NEW.run_id
            AND evidence.approved_mockup_version_id=NEW.approved_mockup_version_id
       )
     ) THEN
    RAISE EXCEPTION 'visual evidence collection requires a dispatched approved mockup and exact delivered commit'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_implementation_visual_evidence()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  comparison artifacts%ROWTYPE;
  run RECORD;
  verification RECORD;
  deployment RECORD;
  deployment_observation RECORD;
  capture_fixed_clock TIMESTAMPTZ;
BEGIN
  SELECT * INTO run FROM agent_runs WHERE id=NEW.run_id FOR SHARE;
  SELECT * INTO verification FROM verification_results
   WHERE id=NEW.verification_result_id FOR SHARE;
  SELECT * INTO deployment FROM project_delivery_records
   WHERE id=NEW.deployment_record_id FOR SHARE;
  SELECT * INTO deployment_observation FROM project_delivery_observations
   WHERE id=NEW.deployment_observation_id FOR SHARE;
  IF NEW.comparison_artifact_id IS NOT NULL THEN
    SELECT * INTO comparison FROM artifacts WHERE id=NEW.comparison_artifact_id FOR SHARE;
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM conversation_task_package_supplements supplement
        WHERE supplement.project_id=NEW.project_id
          AND supplement.work_item_id=NEW.work_item_id
          AND supplement.conversation_id=NEW.conversation_id
          AND supplement.task_id=NEW.task_id
          AND supplement.source_mockup_version_id=NEW.approved_mockup_version_id
     )
     OR run.id IS NULL OR run.project_id<>NEW.project_id
     OR run.phase_id<>NEW.phase_id OR run.task_id<>NEW.task_id
     OR run.repository_binding_id<>NEW.repository_binding_id
     OR run.published_commit_sha<>NEW.commit_sha OR run.publication_outcome<>'pushed'
     OR verification.id IS NULL OR verification.project_id<>NEW.project_id
     OR verification.phase_id<>NEW.phase_id OR verification.task_id<>NEW.task_id
     OR verification.run_id<>NEW.run_id
     OR verification.repository_binding_id<>NEW.repository_binding_id
     OR verification.commit_sha<>NEW.commit_sha OR verification.passed<>true
     OR deployment.id IS NULL OR deployment.project_id<>NEW.project_id
     OR deployment.phase_id<>NEW.phase_id OR deployment.task_id<>NEW.task_id
     OR deployment.run_id<>NEW.run_id
     OR deployment.repository_binding_id<>NEW.repository_binding_id
     OR deployment.commit_sha<>NEW.commit_sha OR deployment.status<>'succeeded'
     OR deployment_observation.id IS NULL
     OR deployment_observation.project_id<>NEW.project_id
     OR deployment_observation.delivery_record_id<>deployment.id
     OR deployment_observation.sequence<>deployment.current_observation_sequence
     OR deployment_observation.status<>'succeeded'
     OR NEW.verified_at<deployment.completed_at THEN
    RAISE EXCEPTION 'visual evidence requires the dispatched mockup and exact verified deployed commit'
      USING ERRCODE='23514';
  END IF;
  IF NEW.comparison_artifact_id IS NOT NULL
     AND (
       comparison.id IS NULL OR comparison.project_id<>NEW.project_id
       OR comparison.kind<>'visual_comparison'
       OR comparison.media_type<>'application/json'
       OR comparison.content_hash<>NEW.comparison_artifact_hash
       OR NOT EXISTS (
         SELECT 1 FROM artifact_blobs blob
          WHERE blob.artifact_id=comparison.id
            AND blob.content_hash=NEW.comparison_artifact_hash
       )
     ) THEN
    RAISE EXCEPTION 'visual comparison is not its exact immutable JSON artifact'
      USING ERRCODE='23514';
  END IF;
  BEGIN
    capture_fixed_clock := (NEW.capture_profile->>'fixed_clock')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'delivered visual evidence fixed clock is not a valid instant'
      USING ERRCODE='23514';
  END;
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.capture_profile))<>9
     OR NEW.capture_profile->>'renderer'<>'playwright'
     OR length(trim(COALESCE(NEW.capture_profile->>'browser_name','')))=0
     OR length(trim(COALESCE(NEW.capture_profile->>'browser_version','')))=0
     OR COALESCE(NEW.capture_profile->>'font_revision','') !~ '^[a-f0-9]{64}$'
     OR NEW.capture_profile->>'pixel_ratio'<>'1'
     OR NEW.capture_profile->>'network'<>'application_only'
     OR NEW.capture_profile->>'locale'<>'en-US'
     OR NEW.capture_profile->>'timezone'<>'UTC'
     OR COALESCE(NEW.capture_profile->>'fixed_clock','')
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
  THEN
    RAISE EXCEPTION 'delivered visual evidence capture profile is incomplete'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_visible_message_parts()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  part JSONB;
  part_type TEXT;
  visible_content TEXT;
  mockup_version conversation_mockup_versions%ROWTYPE;
  visual implementation_visual_evidence%ROWTYPE;
BEGIN
  FOR part IN SELECT value FROM jsonb_array_elements(NEW.parts)
  LOOP
    IF jsonb_typeof(part) <> 'object' THEN
      RAISE EXCEPTION 'message parts must be objects' USING ERRCODE='23514';
    END IF;
    part_type := part->>'type';
    IF part_type IS NULL OR part_type NOT IN (
      'text','code','attachment','artifact','action','plan','handoff',
      'planning_excerpt','human_wait','human_wait_update','mockup',
      'implementation_visual_evidence'
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
    ELSIF part_type='mockup' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(part))<>2
         OR length(trim(COALESCE(part->>'mockup_version_id','')))=0 THEN
        RAISE EXCEPTION 'mockup message parts contain only one immutable version reference'
          USING ERRCODE='23514';
      END IF;
      SELECT * INTO mockup_version FROM conversation_mockup_versions
       WHERE id=part->>'mockup_version_id' FOR SHARE;
      IF mockup_version.id IS NULL
         OR mockup_version.project_id<>NEW.project_id
         OR mockup_version.work_item_id<>NEW.work_item_id
         OR mockup_version.conversation_id<>NEW.conversation_id THEN
        RAISE EXCEPTION 'mockup message part is outside its exact conversation scope'
          USING ERRCODE='23514';
      END IF;
      PERFORM norns_assert_mockup_version_complete(mockup_version.id);
    ELSIF part_type='implementation_visual_evidence' THEN
      IF (SELECT count(*) FROM jsonb_object_keys(part))<>2
         OR length(trim(COALESCE(part->>'visual_evidence_id','')))=0 THEN
        RAISE EXCEPTION 'visual evidence message parts contain one immutable reference'
          USING ERRCODE='23514';
      END IF;
      SELECT * INTO visual FROM implementation_visual_evidence
       WHERE id=part->>'visual_evidence_id' FOR SHARE;
      IF visual.id IS NULL OR visual.project_id<>NEW.project_id
         OR visual.work_item_id<>NEW.work_item_id
         OR visual.conversation_id<>NEW.conversation_id THEN
        RAISE EXCEPTION 'visual evidence message part is outside its execution conversation'
          USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION norns_guard_mockup_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION norns_guard_task_package_supplement() FROM PUBLIC;
REVOKE ALL ON FUNCTION norns_guard_visual_evidence_collection() FROM PUBLIC;
REVOKE ALL ON FUNCTION norns_guard_implementation_visual_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION norns_guard_visible_message_parts() FROM PUBLIC;
