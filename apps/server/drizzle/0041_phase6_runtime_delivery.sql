-- PHASE 6 runtime delivery hardening.
-- Multiple immutable artifact references may bind the same project-scoped
-- bytes for different semantic purposes/viewports. Quota accounting remains
-- content-addressed and counts each project hash once.

DO $phase6_runtime_delivery_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM norns_schema_migrations
     WHERE name = '0040_conversation_mockups_dashboard'
  ) THEN
    RAISE EXCEPTION
      '0041_phase6_runtime_delivery requires 0040_conversation_mockups_dashboard'
      USING ERRCODE = '55000';
  END IF;
END
$phase6_runtime_delivery_dependency$;

DROP INDEX IF EXISTS artifact_blobs_project_hash_unique;
CREATE INDEX artifact_blobs_project_hash_idx
  ON artifact_blobs(project_id,content_hash);

CREATE TABLE implementation_visual_evidence_collections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  approved_mockup_version_id TEXT NOT NULL,
  repository_binding_id TEXT NOT NULL,
  verification_result_id TEXT NOT NULL,
  deployment_record_id TEXT NOT NULL,
  deployment_observation_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued','leased','awaiting_runner','delivered','completed','failed')
  ),
  command_id TEXT UNIQUE REFERENCES commands(command_id) ON DELETE RESTRICT,
  dispatch_job_id TEXT UNIQUE REFERENCES dispatch_jobs(id) ON DELETE RESTRICT,
  runner_id TEXT,
  runner_generation INTEGER CHECK (runner_generation IS NULL OR runner_generation>=0),
  evidence_id TEXT UNIQUE REFERENCES implementation_visual_evidence(id) ON DELETE RESTRICT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT implementation_visual_evidence_collections_run_mockup_unique
    UNIQUE (run_id,approved_mockup_version_id),
  FOREIGN KEY (project_id,work_item_id,conversation_id,approved_mockup_version_id)
    REFERENCES conversation_mockup_versions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id,task_id,run_id)
    REFERENCES agent_runs(project_id,phase_id,task_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (
    project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,
    verification_result_id
  ) REFERENCES verification_results(
    project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,
    deployment_record_id
  ) REFERENCES project_delivery_records(
    project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,deployment_record_id,deployment_observation_id)
    REFERENCES project_delivery_observations(project_id,delivery_record_id,id)
    ON DELETE RESTRICT,
  CHECK (
    (status IN ('queued','leased') AND command_id IS NULL AND dispatch_job_id IS NULL
      AND runner_id IS NULL AND runner_generation IS NULL)
    OR
    (status IN ('awaiting_runner','delivered') AND command_id IS NOT NULL
      AND dispatch_job_id IS NOT NULL AND runner_id IS NOT NULL
      AND runner_generation IS NOT NULL)
    OR
    (status='completed' AND command_id IS NOT NULL AND dispatch_job_id IS NOT NULL
      AND runner_id IS NOT NULL AND runner_generation IS NOT NULL
      AND evidence_id IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status='failed' AND last_error IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (
    (status='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);
CREATE INDEX implementation_visual_evidence_collections_worker_idx
  ON implementation_visual_evidence_collections(
    status,available_at,lease_expires_at,created_at,id
  );

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
     OR version.conversation_id<>NEW.conversation_id
     OR version.task_id IS DISTINCT FROM NEW.task_id
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
    RAISE EXCEPTION 'visual evidence collection requires an approved mockup and exact delivered commit'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER implementation_visual_evidence_collections_scope_guard
  BEFORE INSERT OR UPDATE ON implementation_visual_evidence_collections
  FOR EACH ROW EXECUTE FUNCTION norns_guard_visual_evidence_collection();

CREATE OR REPLACE FUNCTION norns_require_dispatch_task_package_supplements()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  command_kind TEXT;
BEGIN
  SELECT kind INTO command_kind FROM commands WHERE command_id=NEW.command_id;
  IF command_kind IS DISTINCT FROM 'launch_run' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM tasks WHERE id=NEW.task_id FOR UPDATE;
  IF NEW.status NOT IN ('queued','awaiting_enrollment','leased','delivered') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM conversation_task_package_supplements supplement
     WHERE supplement.task_id=NEW.task_id
       AND NOT EXISTS (
         SELECT 1 FROM conversation_task_package_supplement_dispatch_receipts receipt
          WHERE receipt.command_id=NEW.command_id
            AND receipt.run_id=NEW.run_id
            AND receipt.supplement_id=supplement.id
            AND receipt.base_package_id=supplement.base_package_id
            AND receipt.ordinal=supplement.ordinal
            AND receipt.content_hash=supplement.content_hash
            AND receipt.context_document_id=supplement.context_document_id
       )
  ) THEN
    RAISE EXCEPTION 'dispatch is missing an immutable approved mockup supplement receipt'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;

-- 0040's renderer profile guard accidentally counted nine keys even though
-- the canonical v2 profile has ten (including the deterministic seed). Keep
-- the immutable request/manifest checks and correct that catalog-level gate.
CREATE OR REPLACE FUNCTION norns_guard_mockup_version()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  request RECORD;
  prior RECORD;
  manifest RECORD;
  renderer_fixed_clock TIMESTAMPTZ;
BEGIN
  SELECT * INTO request FROM conversation_mockup_requests WHERE id=NEW.request_id FOR SHARE;
  SELECT * INTO manifest FROM artifacts WHERE id=NEW.manifest_artifact_id FOR SHARE;
  IF request.id IS NULL
     OR request.root_request_id<>NEW.root_request_id
     OR request.project_id<>NEW.project_id
     OR request.work_item_id<>NEW.work_item_id
     OR request.conversation_id<>NEW.conversation_id
     OR request.task_id IS DISTINCT FROM NEW.task_id
     OR request.action_id<>NEW.created_by_action_id
     OR request.brief<>NEW.brief OR request.target<>NEW.target
     OR request.status<>'leased' THEN
    RAISE EXCEPTION 'mockup version does not match its immutable request'
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
     OR NEW.canonical_manifest::jsonb->'renderer_profile'<>NEW.renderer_profile
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

REVOKE ALL ON implementation_visual_evidence_collections FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON implementation_visual_evidence_collections TO norns_app;
