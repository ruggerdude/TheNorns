-- CONVERSATION-FIRST PHASE 6: deterministic visual mockups, immutable
-- decisions/task supplements, delivered visual evidence, and explicit
-- deployment observations. Publication and deployment remain separate facts.

DO $conversation_mockups_dashboard_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM norns_schema_migrations
     WHERE name = '0039_conversation_human_steering'
  ) THEN
    RAISE EXCEPTION
      '0040_conversation_mockups_dashboard requires 0039_conversation_human_steering'
      USING ERRCODE = '55000';
  END IF;
END
$conversation_mockups_dashboard_dependency$;

CREATE OR REPLACE FUNCTION norns_is_public_https_url(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $url$
DECLARE
  authority_match TEXT[];
  authority TEXT;
  host TEXT;
  ipv6_literal BOOLEAN := false;
  parsed_ip INET;
  octets TEXT[];
  first_octet INTEGER;
  second_octet INTEGER;
BEGIN
  authority_match := regexp_match(value,'^https://([^/?#]+)([/?#]|$)','i');
  IF authority_match IS NULL THEN
    RETURN false;
  END IF;
  authority := authority_match[1];
  IF authority='' OR position('@' IN authority)>0 THEN
    RETURN false;
  END IF;
  IF left(authority,1)='[' THEN
    IF right(authority,1)<>']' OR position(']' IN authority)<>length(authority) THEN
      RETURN false;
    END IF;
    host := substring(authority FROM 2 FOR length(authority)-2);
    ipv6_literal := true;
  ELSE
    IF position(':' IN authority)>0 THEN
      RETURN false;
    END IF;
    host := authority;
  END IF;
  host := lower(rtrim(host,'.'));
  IF host='' OR host='localhost' OR host LIKE '%.localhost' OR host LIKE '%.local' THEN
    RETURN false;
  END IF;
  IF ipv6_literal THEN
    BEGIN
      parsed_ip := host::inet;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    RETURN family(parsed_ip)=6
      AND parsed_ip << inet '2000::/3'
      AND NOT parsed_ip << inet '2001:db8::/32';
  END IF;
  IF host ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' THEN
    octets := string_to_array(host,'.');
    IF EXISTS (
      SELECT 1 FROM unnest(octets) octet WHERE octet::integer>255
    ) THEN
      RETURN false;
    END IF;
    first_octet := octets[1]::integer;
    second_octet := octets[2]::integer;
    IF first_octet=0 OR first_octet=10 OR first_octet=127
       OR (first_octet=169 AND second_octet=254)
       OR (first_octet=172 AND second_octet BETWEEN 16 AND 31)
       OR (first_octet=192 AND second_octet=168)
       OR (first_octet=100 AND second_octet BETWEEN 64 AND 127)
       OR first_octet>=224 THEN
      RETURN false;
    END IF;
  ELSIF host ~ '^[0-9.]+$'
     OR host ~* '(^|\.)(0x[0-9a-f]+|0[0-9]+)(\.|$)' THEN
    RETURN false;
  END IF;
  RETURN true;
END
$url$;
REVOKE ALL ON FUNCTION norns_is_public_https_url(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION norns_is_public_https_url(TEXT) TO norns_app;

CREATE VIEW conversation_mockups_dashboard_v1 AS SELECT 1::INTEGER AS version;
REVOKE ALL ON conversation_mockups_dashboard_v1 FROM PUBLIC;
GRANT SELECT ON conversation_mockups_dashboard_v1 TO norns_app;

ALTER TABLE conversation_mockup_requests
  DROP CONSTRAINT IF EXISTS conversation_mockup_requests_status_check;
ALTER TABLE conversation_mockup_requests
  ADD COLUMN root_request_id TEXT,
  ADD COLUMN source_mockup_version_id TEXT,
  ADD COLUMN payload_hash TEXT,
  ADD COLUMN revision_direction TEXT,
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN available_at TIMESTAMPTZ,
  ADD COLUMN last_error TEXT,
  ADD COLUMN rendered_version_id TEXT;

UPDATE conversation_mockup_requests request
   SET root_request_id=request.id,
       payload_hash=action.payload_hash,
       available_at=request.created_at
  FROM conversation_actions action
 WHERE action.id=request.action_id
   AND request.root_request_id IS NULL;

-- Phase 5 exposed the status vocabulary before a renderer existed. Preserve
-- every schema-valid legacy row without pretending that an unverifiable
-- rendered/leased state has Phase 6 evidence.
UPDATE conversation_mockup_requests
   SET status=CASE
         WHEN status='leased' THEN 'queued'
         WHEN status='rendered' THEN 'failed'
         ELSE status
       END,
       attempts=CASE WHEN status='leased' THEN 1 ELSE attempts END,
       last_error=CASE
         WHEN status='leased'
           THEN '0040 recovered a legacy lease that had no durable lease metadata'
         WHEN status='rendered'
           THEN '0040 rejected a legacy rendered claim that had no immutable version evidence'
         WHEN status='failed'
           THEN '0040 preserved a legacy failure whose original detail was unavailable'
         ELSE last_error
       END
 WHERE status IN ('leased','rendered','failed');

ALTER TABLE conversation_mockup_requests
  ALTER COLUMN root_request_id SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL,
  ALTER COLUMN available_at SET NOT NULL,
  ADD CONSTRAINT conversation_mockup_requests_status_check
    CHECK (status IN ('queued','leased','rendered','failed','cancelled')),
  ADD CONSTRAINT conversation_mockup_requests_hash_check
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT conversation_mockup_requests_attempts_check CHECK (attempts >= 0),
  ADD CONSTRAINT conversation_mockup_requests_revision_shape_check CHECK (
    (source_mockup_version_id IS NULL AND root_request_id=id AND revision_direction IS NULL)
    OR (source_mockup_version_id IS NOT NULL AND revision_direction IS NOT NULL)
  ),
  ADD CONSTRAINT conversation_mockup_requests_lease_shape_check CHECK (
    (status='leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT conversation_mockup_requests_result_shape_check CHECK (
    (status='rendered' AND rendered_version_id IS NOT NULL AND last_error IS NULL)
    OR (status='failed' AND rendered_version_id IS NULL AND last_error IS NOT NULL)
    OR (status IN ('queued','leased','cancelled') AND rendered_version_id IS NULL)
  );
CREATE UNIQUE INDEX conversation_mockup_requests_scope_unique
  ON conversation_mockup_requests(project_id,work_item_id,conversation_id,id);
CREATE INDEX conversation_mockup_requests_worker_idx
  ON conversation_mockup_requests(status,available_at,lease_expires_at,created_at,id);

CREATE TABLE artifact_blobs (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  content BYTEA NOT NULL CHECK (octet_length(content)>0),
  content_hash TEXT NOT NULL CHECK (
    content_hash ~ '^[a-f0-9]{64}$'
    AND content_hash=encode(sha256(content),'hex')
  ),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size=octet_length(content)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX artifact_blobs_project_hash_unique
  ON artifact_blobs(project_id,content_hash);

CREATE TABLE conversation_mockup_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  root_request_id TEXT NOT NULL REFERENCES conversation_mockup_requests(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE REFERENCES conversation_mockup_requests(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  created_by_action_id TEXT NOT NULL UNIQUE REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  brief TEXT NOT NULL CHECK (length(trim(brief)) > 0),
  target TEXT NOT NULL CHECK (target IN ('desktop','mobile','responsive')),
  interaction_notes JSONB NOT NULL CHECK (
    jsonb_typeof(interaction_notes)='array' AND jsonb_array_length(interaction_notes)>0
  ),
  manifest_artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
  manifest_artifact_hash TEXT NOT NULL CHECK (manifest_artifact_hash ~ '^[a-f0-9]{64}$'),
  canonical_manifest TEXT NOT NULL CHECK (length(canonical_manifest)>0),
  renderer_profile JSONB NOT NULL CHECK (jsonb_typeof(renderer_profile)='object'),
  supersedes_mockup_version_id TEXT REFERENCES conversation_mockup_versions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id,request_id)
    REFERENCES conversation_mockup_requests(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id,work_item_id,conversation_id,created_by_action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id,manifest_artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT,
  CHECK (
    canonical_manifest::jsonb IS NOT NULL
    AND encode(sha256(convert_to(canonical_manifest,'UTF8')),'hex')=manifest_artifact_hash
  ),
  CHECK (
    (version=1 AND supersedes_mockup_version_id IS NULL)
    OR (version>1 AND supersedes_mockup_version_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX conversation_mockup_versions_root_version_unique
  ON conversation_mockup_versions(root_request_id,version);
CREATE UNIQUE INDEX conversation_mockup_versions_scope_unique
  ON conversation_mockup_versions(project_id,work_item_id,conversation_id,id);
CREATE UNIQUE INDEX conversation_mockup_versions_project_id_unique
  ON conversation_mockup_versions(project_id,id);
CREATE INDEX conversation_mockup_versions_conversation_created_idx
  ON conversation_mockup_versions(conversation_id,created_at,id);

CREATE TABLE conversation_mockup_version_artifacts (
  mockup_version_id TEXT NOT NULL REFERENCES conversation_mockup_versions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  viewport TEXT NOT NULL CHECK (viewport IN ('desktop','mobile')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 4096),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 4096),
  capture_profile JSONB NOT NULL CHECK (jsonb_typeof(capture_profile)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mockup_version_id,viewport),
  CONSTRAINT conversation_mockup_version_artifacts_parent_artifact_unique
    UNIQUE (mockup_version_id,artifact_id),
  FOREIGN KEY (project_id,artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,mockup_version_id)
    REFERENCES conversation_mockup_versions(project_id,id) ON DELETE RESTRICT
);

CREATE TABLE conversation_mockup_decisions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  mockup_version_id TEXT NOT NULL UNIQUE REFERENCES conversation_mockup_versions(id)
    ON DELETE RESTRICT,
  action_id TEXT NOT NULL UNIQUE REFERENCES conversation_actions(id) ON DELETE RESTRICT,
  decided_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved','revision_requested','rejected')),
  manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  manifest_artifact_hash TEXT NOT NULL CHECK (manifest_artifact_hash ~ '^[a-f0-9]{64}$'),
  rationale TEXT,
  direction TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,work_item_id,conversation_id,mockup_version_id)
    REFERENCES conversation_mockup_versions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id,work_item_id,conversation_id,action_id)
    REFERENCES conversation_actions(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  CHECK (
    (decision='approved' AND direction IS NULL AND rationale IS NULL)
    OR (decision='revision_requested' AND direction IS NOT NULL AND rationale IS NULL)
    OR (decision='rejected' AND direction IS NULL AND rationale IS NOT NULL)
  )
);
CREATE INDEX conversation_mockup_decisions_conversation_created_idx
  ON conversation_mockup_decisions(conversation_id,created_at,id);

CREATE UNIQUE INDEX conversation_task_packages_scope_unique
  ON conversation_task_packages(project_id,work_item_id,conversation_id,id);

CREATE TABLE conversation_task_package_supplements (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  base_package_id TEXT NOT NULL REFERENCES conversation_task_packages(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  source_mockup_version_id TEXT NOT NULL REFERENCES conversation_mockup_versions(id)
    ON DELETE RESTRICT,
  approval_decision_id TEXT NOT NULL UNIQUE REFERENCES conversation_mockup_decisions(id)
    ON DELETE RESTRICT,
  manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  manifest_artifact_hash TEXT NOT NULL CHECK (manifest_artifact_hash ~ '^[a-f0-9]{64}$'),
  supplement JSONB NOT NULL CHECK (jsonb_typeof(supplement)='object'),
  canonical_supplement TEXT NOT NULL CHECK (
    canonical_supplement::jsonb=supplement
  ),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  context_document_id TEXT NOT NULL REFERENCES task_context_documents(id) ON DELETE RESTRICT,
  context_byte_size INTEGER NOT NULL CHECK (context_byte_size>0),
  context_media_type TEXT NOT NULL CHECK (context_media_type='application/json'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_task_package_supplements_package_order_unique
    UNIQUE (base_package_id,ordinal),
  CONSTRAINT conversation_task_package_supplements_task_mockup_unique
    UNIQUE (task_id,source_mockup_version_id),
  FOREIGN KEY (project_id,work_item_id,conversation_id,base_package_id)
    REFERENCES conversation_task_packages(project_id,work_item_id,conversation_id,id)
    ON DELETE RESTRICT,
  CHECK (
    encode(sha256(convert_to(canonical_supplement,'UTF8')),'hex')=content_hash
  )
);
CREATE INDEX conversation_task_package_supplements_task_order_idx
  ON conversation_task_package_supplements(task_id,ordinal,id);

CREATE TABLE conversation_task_package_supplement_dispatch_receipts (
  command_id TEXT NOT NULL REFERENCES commands(command_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  supplement_id TEXT NOT NULL REFERENCES conversation_task_package_supplements(id)
    ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_package_id TEXT NOT NULL REFERENCES conversation_task_packages(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal>0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  context_document_id TEXT NOT NULL REFERENCES task_context_documents(id) ON DELETE RESTRICT,
  context_ref JSONB NOT NULL CHECK (jsonb_typeof(context_ref)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (command_id,supplement_id),
  CONSTRAINT task_package_supplement_receipts_order_unique
    UNIQUE (command_id,ordinal),
  FOREIGN KEY (project_id,phase_id,task_id,run_id)
    REFERENCES agent_runs(project_id,phase_id,task_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id,task_id,run_id,command_id)
    REFERENCES commands(project_id,phase_id,task_id,run_id,command_id) ON DELETE RESTRICT
);

CREATE TABLE project_delivery_records (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  phase_id TEXT REFERENCES phases(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT,
  repository_binding_id TEXT NOT NULL REFERENCES repository_bindings(id) ON DELETE RESTRICT,
  environment TEXT NOT NULL CHECK (length(trim(environment))>0),
  service TEXT NOT NULL CHECK (length(trim(service))>0),
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  provider_id TEXT NOT NULL CHECK (length(trim(provider_id))>0),
  provider_deployment_id TEXT NOT NULL CHECK (length(trim(provider_deployment_id))>0),
  status TEXT NOT NULL CHECK (status IN ('pending','deploying','succeeded','failed')),
  current_observation_sequence INTEGER NOT NULL DEFAULT 1
    CHECK (current_observation_sequence>0),
  public_url TEXT CHECK (public_url IS NULL OR norns_is_public_https_url(public_url)),
  health_url TEXT CHECK (health_url IS NULL OR norns_is_public_https_url(health_url)),
  health_status_code INTEGER CHECK (
    health_status_code IS NULL OR health_status_code BETWEEN 100 AND 599
  ),
  evidence_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  evidence_artifact_hash TEXT CHECK (
    evidence_artifact_hash IS NULL OR evidence_artifact_hash ~ '^[a-f0-9]{64}$'
  ),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_delivery_records_provider_unique
    UNIQUE (project_id,provider_id,provider_deployment_id),
  CONSTRAINT project_delivery_records_project_id_unique UNIQUE (project_id,id),
  FOREIGN KEY (project_id,repository_binding_id)
    REFERENCES repository_bindings(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id)
    REFERENCES phases(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id,task_id)
    REFERENCES tasks(project_id,phase_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,phase_id,task_id,run_id)
    REFERENCES agent_runs(project_id,phase_id,task_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,evidence_artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT,
  CHECK (
    (status IN ('pending','deploying') AND completed_at IS NULL)
    OR (status IN ('succeeded','failed') AND completed_at IS NOT NULL)
  ),
  CHECK ((evidence_artifact_id IS NULL)=(evidence_artifact_hash IS NULL)),
  CHECK (
    status<>'succeeded'
    OR (
      public_url IS NOT NULL AND health_url IS NOT NULL
      AND health_status_code BETWEEN 200 AND 399
      AND evidence_artifact_id IS NOT NULL AND evidence_artifact_hash IS NOT NULL
    )
  ),
  CHECK (
    (phase_id IS NULL AND task_id IS NULL AND run_id IS NULL)
    OR (phase_id IS NOT NULL AND task_id IS NULL AND run_id IS NULL)
    OR (phase_id IS NOT NULL AND task_id IS NOT NULL)
  )
);
CREATE INDEX project_delivery_records_project_recent_idx
  ON project_delivery_records(project_id,created_at DESC,id);
CREATE INDEX project_delivery_records_commit_idx
  ON project_delivery_records(project_id,commit_sha,status);
CREATE UNIQUE INDEX project_delivery_records_visual_scope_unique
  ON project_delivery_records(
    project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,id
  );

CREATE TABLE project_delivery_observations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  delivery_record_id TEXT NOT NULL REFERENCES project_delivery_records(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence>0),
  status TEXT NOT NULL CHECK (status IN ('pending','deploying','succeeded','failed')),
  source_type TEXT NOT NULL CHECK (source_type IN ('provider','runner','system','human')),
  source_id TEXT NOT NULL CHECK (length(trim(source_id))>0),
  provider_event_id TEXT,
  public_url TEXT CHECK (public_url IS NULL OR norns_is_public_https_url(public_url)),
  health_url TEXT CHECK (health_url IS NULL OR norns_is_public_https_url(health_url)),
  health_status_code INTEGER CHECK (
    health_status_code IS NULL OR health_status_code BETWEEN 100 AND 599
  ),
  evidence_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  evidence_artifact_hash TEXT CHECK (
    evidence_artifact_hash IS NULL OR evidence_artifact_hash ~ '^[a-f0-9]{64}$'
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_delivery_observations_record_sequence_unique
    UNIQUE (delivery_record_id,sequence),
  CONSTRAINT project_delivery_observations_provider_event_unique
    UNIQUE (project_id,source_id,provider_event_id),
  CONSTRAINT project_delivery_observations_scope_unique
    UNIQUE (project_id,delivery_record_id,id),
  FOREIGN KEY (project_id,delivery_record_id)
    REFERENCES project_delivery_records(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id,evidence_artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT,
  CHECK ((source_type='provider')=(provider_event_id IS NOT NULL)),
  CHECK ((evidence_artifact_id IS NULL)=(evidence_artifact_hash IS NULL)),
  CHECK (
    status<>'succeeded'
    OR (
      public_url IS NOT NULL AND health_url IS NOT NULL
      AND health_status_code BETWEEN 200 AND 399
      AND evidence_artifact_id IS NOT NULL AND evidence_artifact_hash IS NOT NULL
    )
  )
);
CREATE INDEX project_delivery_observations_record_created_idx
  ON project_delivery_observations(delivery_record_id,sequence,created_at,id);

CREATE UNIQUE INDEX verification_results_visual_scope_unique
  ON verification_results(
    project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,id
  );

CREATE TABLE implementation_visual_evidence (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version=2),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  approved_mockup_version_id TEXT NOT NULL REFERENCES conversation_mockup_versions(id)
    ON DELETE RESTRICT,
  repository_binding_id TEXT NOT NULL REFERENCES repository_bindings(id) ON DELETE RESTRICT,
  verification_result_id TEXT NOT NULL REFERENCES verification_results(id) ON DELETE RESTRICT,
  deployment_record_id TEXT NOT NULL REFERENCES project_delivery_records(id) ON DELETE RESTRICT,
  deployment_observation_id TEXT NOT NULL REFERENCES project_delivery_observations(id)
    ON DELETE RESTRICT,
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  capture_profile JSONB NOT NULL CHECK (jsonb_typeof(capture_profile)='object'),
  comparison_artifact_id TEXT UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
  comparison_artifact_hash TEXT CHECK (
    comparison_artifact_hash IS NULL OR comparison_artifact_hash ~ '^[a-f0-9]{64}$'
  ),
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT implementation_visual_evidence_run_mockup_unique
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
  FOREIGN KEY (project_id,comparison_artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT,
  CHECK ((comparison_artifact_id IS NULL)=(comparison_artifact_hash IS NULL))
);
CREATE INDEX implementation_visual_evidence_conversation_created_idx
  ON implementation_visual_evidence(conversation_id,created_at,id);

CREATE TABLE implementation_visual_evidence_artifacts (
  visual_evidence_id TEXT NOT NULL REFERENCES implementation_visual_evidence(id)
    ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  viewport TEXT NOT NULL CHECK (viewport IN ('desktop','mobile')),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  artifact_hash TEXT NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 4096),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 4096),
  capture_profile JSONB NOT NULL CHECK (jsonb_typeof(capture_profile)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (visual_evidence_id,viewport),
  CONSTRAINT implementation_visual_evidence_artifacts_parent_artifact_unique
    UNIQUE (visual_evidence_id,artifact_id),
  FOREIGN KEY (project_id,artifact_id)
    REFERENCES artifacts(project_id,id) ON DELETE RESTRICT
);

ALTER TABLE conversation_mockup_requests
  ADD CONSTRAINT conversation_mockup_requests_source_version_fk
    FOREIGN KEY (source_mockup_version_id) REFERENCES conversation_mockup_versions(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT conversation_mockup_requests_rendered_version_fk
    FOREIGN KEY (rendered_version_id) REFERENCES conversation_mockup_versions(id)
    ON DELETE RESTRICT;

DROP TRIGGER IF EXISTS conversation_mockup_requests_scope_guard
  ON conversation_mockup_requests;
CREATE OR REPLACE FUNCTION norns_guard_phase6_mockup_request()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  action RECORD;
  source_version RECORD;
  source_request RECORD;
  rendered_version RECORD;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO action FROM conversation_actions WHERE id=NEW.action_id FOR SHARE;
    -- 0039's deployed writer does not know the Phase 6 worker columns. Derive
    -- them from the immutable action so 0040 can safely land before the new
    -- application SHA without breaking create_mockup during the rollout.
    NEW.root_request_id := COALESCE(NEW.root_request_id,NEW.id);
    NEW.payload_hash := COALESCE(NEW.payload_hash,action.payload_hash);
    NEW.available_at := COALESCE(NEW.available_at,NEW.created_at,now());
    IF action.id IS NULL
       OR action.project_id<>NEW.project_id
       OR action.work_item_id<>NEW.work_item_id
       OR action.conversation_id<>NEW.conversation_id
       OR action.payload_hash<>NEW.payload_hash
       OR action.status NOT IN (
         'recorded','sent','agent_acknowledged','applied'
       ) THEN
      RAISE EXCEPTION 'mockup request scope or payload hash mismatch'
        USING ERRCODE='23514';
    END IF;
    IF NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.rendered_version_id IS NOT NULL THEN
      RAISE EXCEPTION 'mockup request must begin queued and unrendered'
        USING ERRCODE='23514';
    END IF;

    IF action.action_type='create_mockup' THEN
      IF NEW.root_request_id<>NEW.id
         OR NEW.source_mockup_version_id IS NOT NULL
         OR action.payload->'parameters'->>'brief'<>NEW.brief
         OR action.payload->'parameters'->>'target'<>NEW.target
         OR COALESCE(action.payload->'parameters'->>'task_id','')<>COALESCE(NEW.task_id,'')
         OR action.payload->'parameters'->'artifact_refs'<>NEW.artifact_refs
         OR jsonb_array_length(NEW.artifact_refs)>32
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(NEW.artifact_refs) reference
            WHERE jsonb_typeof(reference)<>'string'
               OR length(trim(reference#>>'{}'))=0
         )
         OR (
           SELECT count(DISTINCT reference#>>'{}')
             FROM jsonb_array_elements(NEW.artifact_refs) reference
         )<>jsonb_array_length(NEW.artifact_refs)
         OR (
           SELECT count(*)
             FROM artifacts artifact
            WHERE artifact.project_id=NEW.project_id
              AND artifact.id IN (
                SELECT reference#>>'{}'
                  FROM jsonb_array_elements(NEW.artifact_refs) reference
              )
         )<>jsonb_array_length(NEW.artifact_refs) THEN
        RAISE EXCEPTION 'initial mockup request is not bound to its exact action payload'
          USING ERRCODE='23514';
      END IF;
    ELSIF action.action_type='revise_mockup' THEN
      SELECT * INTO source_version
        FROM conversation_mockup_versions
       WHERE id=NEW.source_mockup_version_id
       FOR SHARE;
      SELECT * INTO source_request
        FROM conversation_mockup_requests
       WHERE id=source_version.request_id
       FOR SHARE;
      IF source_version.id IS NULL
         OR source_version.project_id<>NEW.project_id
         OR source_version.work_item_id<>NEW.work_item_id
         OR source_version.conversation_id<>NEW.conversation_id
         OR source_version.root_request_id<>NEW.root_request_id
         OR source_version.task_id IS DISTINCT FROM NEW.task_id
         OR source_version.brief<>NEW.brief
         OR source_version.target<>NEW.target
         OR action.payload->'parameters'->>'mockup_version_id'<>source_version.id
         OR action.payload->'parameters'->>'manifest_artifact_id'<>source_version.manifest_artifact_id
         OR action.payload->'parameters'->>'manifest_artifact_hash'<>source_version.manifest_artifact_hash
         OR action.payload->'parameters'->>'direction'<>NEW.revision_direction
         OR source_request.id IS NULL
         OR NEW.artifact_refs<>source_request.artifact_refs THEN
        RAISE EXCEPTION 'revision request is not bound to its exact version and manifest hash'
          USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'mockup requests require create_mockup or revise_mockup actions'
        USING ERRCODE='23514';
    END IF;

    IF NEW.task_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM conversation_task_package_bindings binding
       WHERE binding.project_id=NEW.project_id
         AND binding.work_item_id=NEW.work_item_id
         AND binding.conversation_id=NEW.conversation_id
         AND binding.task_id=NEW.task_id
    ) THEN
      RAISE EXCEPTION 'mockup request task is outside its execution conversation'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF OLD.status IN ('rendered','failed','cancelled')
       AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'terminal mockup request outcomes are immutable'
        USING ERRCODE='23514';
    END IF;
    IF (
      to_jsonb(NEW) - ARRAY[
        'status','lease_owner','lease_expires_at','attempts','available_at',
        'last_error','rendered_version_id','updated_at'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'status','lease_owner','lease_expires_at','attempts','available_at',
        'last_error','rendered_version_id','updated_at'
      ]::text[]
    ) THEN
      RAISE EXCEPTION 'mockup request immutable input changed' USING ERRCODE='23514';
    END IF;
    IF NEW.attempts<OLD.attempts OR NOT (
      (OLD.status='queued' AND NEW.status IN ('queued','leased','cancelled'))
      OR (OLD.status='leased' AND NEW.status IN ('queued','leased','rendered','failed','cancelled'))
      OR (OLD.status=NEW.status AND OLD.status IN ('rendered','failed','cancelled'))
    ) THEN
      RAISE EXCEPTION 'illegal mockup request lifecycle % -> %',OLD.status,NEW.status
        USING ERRCODE='23514';
    END IF;
    IF NEW.status='rendered' THEN
      SELECT * INTO rendered_version
        FROM conversation_mockup_versions
       WHERE id=NEW.rendered_version_id
       FOR SHARE;
      IF rendered_version.request_id<>NEW.id THEN
        RAISE EXCEPTION 'rendered request requires its complete desktop/mobile version'
          USING ERRCODE='23514';
      END IF;
      PERFORM norns_assert_mockup_version_complete(rendered_version.id);
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_mockup_requests_phase6_guard
  BEFORE INSERT OR UPDATE ON conversation_mockup_requests
  FOR EACH ROW EXECUTE FUNCTION norns_guard_phase6_mockup_request();
CREATE TRIGGER conversation_mockup_requests_delete_guard
  BEFORE DELETE ON conversation_mockup_requests
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_requests_truncate_guard
  BEFORE TRUNCATE ON conversation_mockup_requests
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

CREATE OR REPLACE FUNCTION norns_guard_artifact_blob()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  artifact RECORD;
BEGIN
  SELECT * INTO artifact FROM artifacts WHERE id=NEW.artifact_id FOR SHARE;
  IF artifact.id IS NULL OR artifact.project_id<>NEW.project_id
     OR artifact.content_hash<>NEW.content_hash
     OR artifact.byte_size<>NEW.byte_size
     OR artifact.storage_ref<>('db://artifact/' || NEW.artifact_id)
     OR artifact.media_type NOT IN ('image/png','application/json')
     OR (
       artifact.media_type='image/png'
       AND NEW.byte_size>10*1024*1024
     )
     OR (
       artifact.media_type='application/json'
       AND NEW.byte_size>1024*1024
     ) THEN
    RAISE EXCEPTION 'artifact blob does not match its immutable metadata'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER artifact_blobs_scope_guard
  BEFORE INSERT ON artifact_blobs
  FOR EACH ROW EXECUTE FUNCTION norns_guard_artifact_blob();

CREATE OR REPLACE FUNCTION norns_guard_blob_backed_artifact_metadata()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM artifact_blobs blob WHERE blob.artifact_id=OLD.id)
     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'blob-backed artifact metadata is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER artifacts_blob_backed_immutable_guard
  BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_blob_backed_artifact_metadata();

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
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.renderer_profile))<>9
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
CREATE TRIGGER conversation_mockup_versions_scope_guard
  BEFORE INSERT ON conversation_mockup_versions
  FOR EACH ROW EXECUTE FUNCTION norns_guard_mockup_version();

CREATE OR REPLACE FUNCTION norns_guard_mockup_version_artifact()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  artifact RECORD;
BEGIN
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.mockup_version_id FOR SHARE;
  SELECT * INTO artifact FROM artifacts WHERE id=NEW.artifact_id FOR SHARE;
  IF version.id IS NULL OR version.project_id<>NEW.project_id
     OR artifact.id IS NULL OR artifact.project_id<>NEW.project_id
     OR artifact.kind<>'mockup' OR artifact.media_type<>'image/png'
     OR artifact.content_hash<>NEW.artifact_hash
     OR NOT EXISTS (
       SELECT 1 FROM artifact_blobs blob
        WHERE blob.artifact_id=artifact.id AND blob.content_hash=NEW.artifact_hash
     ) THEN
    RAISE EXCEPTION 'mockup screenshot requires its exact project-scoped PNG artifact blob'
      USING ERRCODE='23514';
  END IF;
  IF (NEW.viewport='desktop' AND (NEW.width<>1440 OR NEW.height<>1024))
     OR (NEW.viewport='mobile' AND (NEW.width<>390 OR NEW.height<>844)) THEN
    RAISE EXCEPTION 'mockup screenshot dimensions are not the fixed Phase 6 viewports'
      USING ERRCODE='23514';
  END IF;
  IF NEW.capture_profile<>version.renderer_profile THEN
    RAISE EXCEPTION 'mockup screenshot does not use its version renderer profile'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER conversation_mockup_version_artifacts_scope_guard
  BEFORE INSERT ON conversation_mockup_version_artifacts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_mockup_version_artifact();

CREATE OR REPLACE FUNCTION norns_assert_mockup_version_complete(version_id TEXT)
RETURNS void LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  desktop RECORD;
  mobile RECORD;
  manifest JSONB;
  expected_manifest JSONB;
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
  manifest := version.canonical_manifest::jsonb;
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
  IF version.id IS NULL OR desktop.artifact_id IS NULL OR mobile.artifact_id IS NULL
     OR (SELECT count(*) FROM conversation_mockup_version_artifacts artifact
          WHERE artifact.mockup_version_id=version_id)<>2
     OR manifest<>expected_manifest THEN
    RAISE EXCEPTION 'mockup manifest is not bound to its reviewed fields and exact screenshots'
      USING ERRCODE='23514';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION norns_guard_mockup_decision()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  action RECORD;
  expected_action_type TEXT;
BEGIN
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.mockup_version_id FOR UPDATE;
  PERFORM norns_assert_mockup_version_complete(NEW.mockup_version_id);
  SELECT * INTO action FROM conversation_actions WHERE id=NEW.action_id FOR SHARE;
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
       AND (
         version.task_id IS NULL
         OR action.payload->'parameters'->>'task_id'<>version.task_id
       )
     ) THEN
    RAISE EXCEPTION 'mockup decision is not bound to the complete exact version and manifest'
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
CREATE TRIGGER conversation_mockup_decisions_scope_guard
  BEFORE INSERT ON conversation_mockup_decisions
  FOR EACH ROW EXECUTE FUNCTION norns_guard_mockup_decision();

CREATE OR REPLACE FUNCTION norns_guard_task_package_supplement()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  binding RECORD;
  version RECORD;
  decision RECORD;
  document RECORD;
BEGIN
  PERFORM 1 FROM tasks WHERE id=NEW.task_id FOR UPDATE;
  IF EXISTS (
    SELECT 1
      FROM dispatch_jobs job
     WHERE job.task_id=NEW.task_id
       AND job.status IN ('queued','awaiting_enrollment','leased','delivered')
  ) THEN
    RAISE EXCEPTION
      'approved mockup supplement must be frozen before a task command is dispatched'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO binding FROM conversation_task_package_bindings
   WHERE package_id=NEW.base_package_id FOR SHARE;
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.source_mockup_version_id FOR SHARE;
  SELECT * INTO decision FROM conversation_mockup_decisions
   WHERE id=NEW.approval_decision_id FOR SHARE;
  SELECT * INTO document FROM task_context_documents
   WHERE id=NEW.context_document_id FOR SHARE;
  IF binding.package_id IS NULL OR version.id IS NULL OR decision.id IS NULL
     OR binding.project_id<>NEW.project_id
     OR binding.work_item_id<>NEW.work_item_id
     OR binding.conversation_id<>NEW.conversation_id
     OR binding.task_id<>NEW.task_id
     OR version.project_id<>NEW.project_id
     OR version.work_item_id<>NEW.work_item_id
     OR version.conversation_id<>NEW.conversation_id
     OR version.task_id IS DISTINCT FROM NEW.task_id
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
     OR jsonb_typeof(NEW.supplement)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.supplement))<>11
     OR COALESCE(jsonb_typeof(NEW.supplement->'schema_version'),'missing')<>'number'
     OR NEW.supplement->>'schema_version'<>'2'
     OR NEW.supplement->>'kind'<>'approved_mockup'
     OR NEW.supplement->>'mockup_version_id'<>version.id
     OR NEW.supplement->>'manifest_artifact_id'<>version.manifest_artifact_id
     OR NEW.supplement->>'manifest_artifact_hash'<>version.manifest_artifact_hash
     OR NEW.supplement->>'brief'<>version.brief
     OR NEW.supplement->>'target'<>version.target
     OR NEW.supplement->'interaction_notes'<>version.interaction_notes
     OR NEW.supplement->'renderer_profile'<>version.renderer_profile
     OR NEW.supplement->'screenshots'<>version.canonical_manifest::jsonb->'screenshots'
     OR jsonb_typeof(NEW.supplement->'approval')<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(NEW.supplement->'approval'))<>4
     OR NEW.supplement#>>'{approval,decision_id}'<>decision.id
     OR NEW.supplement#>>'{approval,action_id}'<>decision.action_id
     OR NEW.supplement#>>'{approval,decided_by_user_id}'<>decision.decided_by_user_id
     OR (NEW.supplement#>>'{approval,decided_at}')::timestamptz<>decision.created_at
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
CREATE TRIGGER conversation_task_package_supplements_scope_guard
  BEFORE INSERT ON conversation_task_package_supplements
  FOR EACH ROW EXECUTE FUNCTION norns_guard_task_package_supplement();

CREATE OR REPLACE FUNCTION norns_require_task_mockup_supplement()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
BEGIN
  IF NEW.decision<>'approved' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.mockup_version_id;
  IF version.task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversation_task_package_supplements supplement
     WHERE supplement.approval_decision_id=NEW.id
       AND supplement.source_mockup_version_id=NEW.mockup_version_id
       AND supplement.task_id=version.task_id
  ) THEN
    RAISE EXCEPTION 'task-targeted mockup approval requires its immutable package supplement'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE CONSTRAINT TRIGGER conversation_mockup_approval_supplement_guard
  AFTER INSERT ON conversation_mockup_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_require_task_mockup_supplement();

CREATE OR REPLACE FUNCTION norns_guard_task_package_supplement_dispatch_receipt()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  supplement RECORD;
  document RECORD;
  command_row RECORD;
  dispatched_binding JSONB;
BEGIN
  SELECT * INTO supplement FROM conversation_task_package_supplements
   WHERE id=NEW.supplement_id FOR SHARE;
  SELECT * INTO document FROM task_context_documents
   WHERE id=NEW.context_document_id FOR SHARE;
  SELECT * INTO command_row FROM commands
   WHERE command_id=NEW.command_id FOR SHARE;
  SELECT value INTO dispatched_binding
    FROM jsonb_array_elements(
      COALESCE(command_row.envelope->'task_package_supplements','[]'::jsonb)
    )
   WHERE value->>'supplement_id'=NEW.supplement_id;
  IF supplement.id IS NULL
     OR supplement.project_id<>NEW.project_id
     OR supplement.task_id<>NEW.task_id
     OR supplement.base_package_id<>NEW.base_package_id
     OR supplement.ordinal<>NEW.ordinal
     OR supplement.content_hash<>NEW.content_hash
     OR supplement.context_document_id<>NEW.context_document_id
     OR document.id IS NULL OR document.project_id<>NEW.project_id
     OR document.sha256<>NEW.content_hash
     OR command_row.command_id IS NULL
     OR command_row.project_id<>NEW.project_id
     OR command_row.phase_id<>NEW.phase_id
     OR command_row.task_id<>NEW.task_id
     OR command_row.run_id<>NEW.run_id
     OR command_row.envelope->>'task_package_id'<>NEW.base_package_id
     OR dispatched_binding IS NULL
     OR dispatched_binding->>'task_id'<>NEW.task_id
     OR dispatched_binding->>'base_package_id'<>NEW.base_package_id
     OR (dispatched_binding->>'ordinal')::integer<>NEW.ordinal
     OR dispatched_binding->>'content_hash'<>NEW.content_hash
     OR dispatched_binding->'context_ref'<>NEW.context_ref
     OR NEW.context_ref<>jsonb_build_object(
       'artifact_id',NEW.context_document_id,
       'content_hash',document.sha256,
       'byte_size',document.byte_size,
       'storage_ref',NEW.context_ref->>'storage_ref'
     ) THEN
    RAISE EXCEPTION 'dispatch supplement receipt does not match its command and immutable context'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER task_package_supplement_receipts_scope_guard
  BEFORE INSERT ON conversation_task_package_supplement_dispatch_receipts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_task_package_supplement_dispatch_receipt();

CREATE OR REPLACE FUNCTION norns_require_dispatch_task_package_supplements()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  -- This row lock is the supplement cutoff. It serializes dispatch becoming
  -- executable against a concurrent mockup approval/supplement insertion.
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
CREATE CONSTRAINT TRIGGER dispatch_jobs_mockup_supplements_guard
  AFTER INSERT OR UPDATE OF status ON dispatch_jobs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_require_dispatch_task_package_supplements();

CREATE OR REPLACE FUNCTION norns_guard_project_delivery_record()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  evidence RECORD;
  run RECORD;
  observation RECORD;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.current_observation_sequence<>1
       OR NEW.completed_at IS NOT NULL OR NEW.evidence_artifact_id IS NOT NULL THEN
      RAISE EXCEPTION 'deployment record must begin pending before its first observation'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF (
      to_jsonb(NEW) - ARRAY[
        'status','public_url','health_url','health_status_code',
        'evidence_artifact_id','evidence_artifact_hash',
        'current_observation_sequence','completed_at','updated_at'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'status','public_url','health_url','health_status_code',
        'evidence_artifact_id','evidence_artifact_hash',
        'current_observation_sequence','completed_at','updated_at'
      ]::text[]
    ) THEN
      RAISE EXCEPTION 'deployment identity and exact commit are immutable'
        USING ERRCODE='23514';
    END IF;
    IF NOT (
      (OLD.status='pending' AND NEW.status IN ('pending','deploying','succeeded','failed'))
      OR (OLD.status='deploying' AND NEW.status IN ('deploying','succeeded','failed'))
    ) THEN
      RAISE EXCEPTION 'illegal deployment observation lifecycle % -> %',OLD.status,NEW.status
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO observation FROM project_delivery_observations
     WHERE delivery_record_id=NEW.id AND sequence=NEW.current_observation_sequence
     FOR SHARE;
    IF NEW.current_observation_sequence<>OLD.current_observation_sequence+1
       OR observation.id IS NULL OR observation.project_id<>NEW.project_id
       OR observation.status<>NEW.status
       OR observation.public_url IS DISTINCT FROM NEW.public_url
       OR observation.health_url IS DISTINCT FROM NEW.health_url
       OR observation.health_status_code IS DISTINCT FROM NEW.health_status_code
       OR observation.evidence_artifact_id IS DISTINCT FROM NEW.evidence_artifact_id
       OR observation.evidence_artifact_hash IS DISTINCT FROM NEW.evidence_artifact_hash
       OR (
         NEW.completed_at IS NOT NULL
         AND NEW.completed_at IS DISTINCT FROM observation.observed_at
       ) THEN
      RAISE EXCEPTION 'deployment summary must advance by one exact attributed observation'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.task_id IS NOT NULL AND NEW.phase_id IS NULL
     OR NEW.run_id IS NOT NULL AND NEW.task_id IS NULL THEN
    RAISE EXCEPTION 'deployment task/run scope is incomplete' USING ERRCODE='23514';
  END IF;
  IF NEW.run_id IS NOT NULL THEN
    SELECT * INTO run FROM agent_runs WHERE id=NEW.run_id FOR SHARE;
    IF run.id IS NULL OR run.project_id<>NEW.project_id
       OR run.phase_id<>NEW.phase_id OR run.task_id<>NEW.task_id
       OR run.repository_binding_id<>NEW.repository_binding_id
       OR run.published_commit_sha<>NEW.commit_sha
       OR run.publication_outcome<>'pushed' THEN
      RAISE EXCEPTION 'deployment observation must match the run exact pushed commit'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status='succeeded' THEN
    SELECT * INTO evidence FROM artifacts WHERE id=NEW.evidence_artifact_id FOR SHARE;
    IF evidence.id IS NULL OR evidence.project_id<>NEW.project_id
       OR evidence.kind<>'deployment_evidence'
       OR evidence.media_type<>'application/json'
       OR evidence.content_hash<>NEW.evidence_artifact_hash
       OR NOT EXISTS (
         SELECT 1 FROM artifact_blobs blob
          WHERE blob.artifact_id=evidence.id
            AND blob.content_hash=NEW.evidence_artifact_hash
       ) THEN
      RAISE EXCEPTION 'successful deployment requires an exact durable observation artifact'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER project_delivery_records_scope_guard
  BEFORE INSERT OR UPDATE ON project_delivery_records
  FOR EACH ROW EXECUTE FUNCTION norns_guard_project_delivery_record();

CREATE OR REPLACE FUNCTION norns_guard_project_delivery_observation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  delivery RECORD;
  evidence RECORD;
  evidence_payload JSONB;
  prior_observed_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO delivery FROM project_delivery_records
   WHERE id=NEW.delivery_record_id FOR UPDATE;
  IF delivery.id IS NULL OR delivery.project_id<>NEW.project_id
     OR NEW.sequence<>(CASE
       WHEN delivery.current_observation_sequence=1
        AND NOT EXISTS (
          SELECT 1 FROM project_delivery_observations existing
           WHERE existing.delivery_record_id=delivery.id
        )
       THEN 1
       ELSE delivery.current_observation_sequence+1
     END)
     OR NOT (
       (delivery.status='pending' AND NEW.status IN ('pending','deploying','succeeded','failed'))
       OR (delivery.status='deploying' AND NEW.status IN ('deploying','succeeded','failed'))
     )
     OR (
       NEW.source_type='provider'
       AND (
         NEW.provider_event_id IS NULL
         OR NEW.source_id<>delivery.provider_id
       )
     ) THEN
    RAISE EXCEPTION 'deployment observation is out of scope, order, or lifecycle'
      USING ERRCODE='23514';
  END IF;
  SELECT max(observed_at) INTO prior_observed_at
    FROM project_delivery_observations
   WHERE delivery_record_id=NEW.delivery_record_id;
  IF NEW.observed_at<delivery.started_at
     OR (prior_observed_at IS NOT NULL AND NEW.observed_at<=prior_observed_at) THEN
    RAISE EXCEPTION 'deployment observation timestamps must be strictly monotonic'
      USING ERRCODE='23514';
  END IF;
  IF NEW.evidence_artifact_id IS NOT NULL THEN
    SELECT * INTO evidence FROM artifacts WHERE id=NEW.evidence_artifact_id FOR SHARE;
    SELECT convert_from(blob.content,'UTF8')::jsonb INTO evidence_payload
      FROM artifact_blobs blob
     WHERE blob.artifact_id=NEW.evidence_artifact_id
       AND blob.content_hash=NEW.evidence_artifact_hash;
    IF evidence.id IS NULL OR evidence.project_id<>NEW.project_id
       OR evidence.kind<>'deployment_evidence'
       OR evidence.media_type<>'application/json'
       OR evidence.content_hash<>NEW.evidence_artifact_hash
       OR evidence_payload IS NULL
       OR (SELECT count(*) FROM jsonb_object_keys(evidence_payload))<>18
       OR COALESCE(jsonb_typeof(evidence_payload->'schema_version'),'missing')<>'number'
       OR COALESCE(jsonb_typeof(evidence_payload->'sequence'),'missing')<>'number'
       OR COALESCE(jsonb_typeof(evidence_payload->'health_status_code'),'missing')
            NOT IN ('number','null')
       OR COALESCE(jsonb_typeof(evidence_payload->'kind'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'delivery_record_id'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'project_id'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'provider_id'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'provider_deployment_id'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'commit_sha'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'environment'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'service'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'status'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'source_type'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'source_id'),'missing')<>'string'
       OR COALESCE(jsonb_typeof(evidence_payload->'provider_event_id'),'missing')
            NOT IN ('string','null')
       OR COALESCE(jsonb_typeof(evidence_payload->'public_url'),'missing')
            NOT IN ('string','null')
       OR COALESCE(jsonb_typeof(evidence_payload->'health_url'),'missing')
            NOT IN ('string','null')
       OR COALESCE(jsonb_typeof(evidence_payload->'observed_at'),'missing')<>'string'
       OR evidence_payload->>'schema_version'<>'2'
       OR evidence_payload->>'kind'<>'deployment_observation'
       OR evidence_payload->>'delivery_record_id'<>delivery.id
       OR evidence_payload->>'project_id'<>delivery.project_id
       OR evidence_payload->>'provider_id'<>delivery.provider_id
       OR evidence_payload->>'provider_deployment_id'<>delivery.provider_deployment_id
       OR evidence_payload->>'commit_sha'<>delivery.commit_sha
       OR evidence_payload->>'environment'<>delivery.environment
       OR evidence_payload->>'service'<>delivery.service
       OR (evidence_payload->>'sequence')::integer<>NEW.sequence
       OR evidence_payload->>'status'<>NEW.status
       OR evidence_payload->>'source_type'<>NEW.source_type
       OR evidence_payload->>'source_id'<>NEW.source_id
       OR evidence_payload->>'provider_event_id' IS DISTINCT FROM NEW.provider_event_id
       OR evidence_payload->>'public_url' IS DISTINCT FROM NEW.public_url
       OR evidence_payload->>'health_url' IS DISTINCT FROM NEW.health_url
       OR (evidence_payload->>'health_status_code')::integer
            IS DISTINCT FROM NEW.health_status_code
       OR (evidence_payload->>'observed_at')::timestamptz<>NEW.observed_at THEN
      RAISE EXCEPTION 'deployment observation lacks its exact attributed evidence payload'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER project_delivery_observations_scope_guard
  BEFORE INSERT ON project_delivery_observations
  FOR EACH ROW EXECUTE FUNCTION norns_guard_project_delivery_observation();

CREATE OR REPLACE FUNCTION norns_require_project_delivery_observation()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  current_delivery RECORD;
BEGIN
  SELECT * INTO current_delivery FROM project_delivery_records WHERE id=NEW.id;
  IF NOT EXISTS (
    SELECT 1 FROM project_delivery_observations observation
     WHERE observation.delivery_record_id=current_delivery.id
       AND observation.sequence=current_delivery.current_observation_sequence
       AND observation.status=current_delivery.status
       AND observation.public_url IS NOT DISTINCT FROM current_delivery.public_url
       AND observation.health_url IS NOT DISTINCT FROM current_delivery.health_url
       AND observation.health_status_code IS NOT DISTINCT FROM current_delivery.health_status_code
       AND observation.evidence_artifact_id
             IS NOT DISTINCT FROM current_delivery.evidence_artifact_id
       AND observation.evidence_artifact_hash
             IS NOT DISTINCT FROM current_delivery.evidence_artifact_hash
       AND (
         current_delivery.completed_at IS NULL
         OR current_delivery.completed_at=observation.observed_at
       )
  ) THEN
    RAISE EXCEPTION 'deployment record cannot commit without its current observation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE CONSTRAINT TRIGGER project_delivery_records_observation_guard
  AFTER INSERT OR UPDATE ON project_delivery_records
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_require_project_delivery_observation();

CREATE OR REPLACE FUNCTION norns_guard_implementation_visual_evidence()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  version RECORD;
  comparison artifacts%ROWTYPE;
  run RECORD;
  verification RECORD;
  deployment RECORD;
  deployment_observation RECORD;
  capture_fixed_clock TIMESTAMPTZ;
BEGIN
  SELECT * INTO version FROM conversation_mockup_versions
   WHERE id=NEW.approved_mockup_version_id FOR SHARE;
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
     OR run.published_commit_sha<>NEW.commit_sha
     OR run.publication_outcome<>'pushed'
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
    RAISE EXCEPTION 'visual evidence requires the approved mockup and exact verified deployed commit'
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
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(NEW.capture_profile) entry
        WHERE entry.key<>'pixel_ratio' AND jsonb_typeof(entry.value)<>'string'
     )
     OR jsonb_typeof(NEW.capture_profile->'pixel_ratio')<>'number'
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
CREATE TRIGGER implementation_visual_evidence_scope_guard
  BEFORE INSERT ON implementation_visual_evidence
  FOR EACH ROW EXECUTE FUNCTION norns_guard_implementation_visual_evidence();

CREATE OR REPLACE FUNCTION norns_guard_implementation_visual_artifact()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  visual RECORD;
  artifact RECORD;
BEGIN
  SELECT * INTO visual FROM implementation_visual_evidence
   WHERE id=NEW.visual_evidence_id FOR SHARE;
  SELECT * INTO artifact FROM artifacts WHERE id=NEW.artifact_id FOR SHARE;
  IF visual.id IS NULL OR visual.project_id<>NEW.project_id
     OR artifact.id IS NULL OR artifact.project_id<>NEW.project_id
     OR artifact.kind<>'visual_evidence' OR artifact.media_type<>'image/png'
     OR artifact.content_hash<>NEW.artifact_hash
     OR NOT EXISTS (
       SELECT 1 FROM artifact_blobs blob
        WHERE blob.artifact_id=artifact.id AND blob.content_hash=NEW.artifact_hash
     ) THEN
    RAISE EXCEPTION 'delivered screenshot requires its exact project-scoped PNG artifact blob'
      USING ERRCODE='23514';
  END IF;
  IF (NEW.viewport='desktop' AND (NEW.width<>1440 OR NEW.height<>1024))
     OR (NEW.viewport='mobile' AND (NEW.width<>390 OR NEW.height<>844))
     OR NEW.capture_profile<>visual.capture_profile THEN
    RAISE EXCEPTION 'delivered screenshot does not match its fixed capture profile'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER implementation_visual_evidence_artifacts_scope_guard
  BEFORE INSERT ON implementation_visual_evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION norns_guard_implementation_visual_artifact();

CREATE OR REPLACE FUNCTION norns_require_implementation_visual_evidence_complete()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  mockup_desktop RECORD;
  mockup_mobile RECORD;
  implementation_desktop RECORD;
  implementation_mobile RECORD;
  comparison_payload JSONB;
  expected_comparison JSONB;
BEGIN
  IF (SELECT count(*) FROM implementation_visual_evidence_artifacts artifact
       WHERE artifact.visual_evidence_id=NEW.id)<>2
     OR NOT EXISTS (
       SELECT 1 FROM implementation_visual_evidence_artifacts artifact
        WHERE artifact.visual_evidence_id=NEW.id AND artifact.viewport='desktop'
     )
     OR NOT EXISTS (
       SELECT 1 FROM implementation_visual_evidence_artifacts artifact
        WHERE artifact.visual_evidence_id=NEW.id AND artifact.viewport='mobile'
     ) THEN
    RAISE EXCEPTION 'visual evidence requires exactly one desktop and one mobile screenshot'
      USING ERRCODE='23514';
  END IF;
  IF NEW.comparison_artifact_id IS NOT NULL THEN
    SELECT * INTO mockup_desktop
      FROM conversation_mockup_version_artifacts
     WHERE mockup_version_id=NEW.approved_mockup_version_id AND viewport='desktop';
    SELECT * INTO mockup_mobile
      FROM conversation_mockup_version_artifacts
     WHERE mockup_version_id=NEW.approved_mockup_version_id AND viewport='mobile';
    SELECT * INTO implementation_desktop
      FROM implementation_visual_evidence_artifacts
     WHERE visual_evidence_id=NEW.id AND viewport='desktop';
    SELECT * INTO implementation_mobile
      FROM implementation_visual_evidence_artifacts
     WHERE visual_evidence_id=NEW.id AND viewport='mobile';
    SELECT convert_from(blob.content,'UTF8')::jsonb INTO comparison_payload
      FROM artifact_blobs blob
     WHERE blob.artifact_id=NEW.comparison_artifact_id
       AND blob.content_hash=NEW.comparison_artifact_hash;
    expected_comparison := jsonb_build_object(
      'schema_version',2,
      'kind','visual_comparison',
      'implementation_visual_evidence_id',NEW.id,
      'approved_mockup_version_id',NEW.approved_mockup_version_id,
      'commit_sha',NEW.commit_sha,
      'comparisons',jsonb_build_array(
        jsonb_build_object(
          'viewport','desktop',
          'mockup_artifact_id',mockup_desktop.artifact_id,
          'mockup_artifact_hash',mockup_desktop.artifact_hash,
          'implementation_artifact_id',implementation_desktop.artifact_id,
          'implementation_artifact_hash',implementation_desktop.artifact_hash
        ),
        jsonb_build_object(
          'viewport','mobile',
          'mockup_artifact_id',mockup_mobile.artifact_id,
          'mockup_artifact_hash',mockup_mobile.artifact_hash,
          'implementation_artifact_id',implementation_mobile.artifact_id,
          'implementation_artifact_hash',implementation_mobile.artifact_hash
        )
      )
    );
    IF comparison_payload IS NULL OR comparison_payload<>expected_comparison THEN
      RAISE EXCEPTION 'visual comparison does not bind the exact before and after artifacts'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;
CREATE CONSTRAINT TRIGGER implementation_visual_evidence_complete_guard
  AFTER INSERT ON implementation_visual_evidence
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION norns_require_implementation_visual_evidence_complete();

CREATE OR REPLACE FUNCTION norns_guard_visible_message_parts()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE
  part JSONB;
  part_type TEXT;
  visible_content TEXT;
  mockup_version conversation_mockup_versions%ROWTYPE;
BEGIN
  FOR part IN SELECT value FROM jsonb_array_elements(NEW.parts)
  LOOP
    IF jsonb_typeof(part) <> 'object' THEN
      RAISE EXCEPTION 'message parts must be objects' USING ERRCODE='23514';
    END IF;
    part_type := part->>'type';
    IF part_type IS NULL OR part_type NOT IN (
      'text','code','attachment','artifact','action','plan','handoff',
      'planning_excerpt','human_wait','human_wait_update','mockup'
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
      SELECT * INTO mockup_version
        FROM conversation_mockup_versions
       WHERE id=part->>'mockup_version_id'
       FOR SHARE;
      IF mockup_version.id IS NULL
         OR mockup_version.project_id<>NEW.project_id
         OR mockup_version.work_item_id<>NEW.work_item_id
         OR mockup_version.conversation_id<>NEW.conversation_id THEN
        RAISE EXCEPTION 'mockup message part is outside its exact conversation scope'
          USING ERRCODE='23514';
      END IF;
      PERFORM norns_assert_mockup_version_complete(mockup_version.id);
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER artifact_blobs_immutable_guard
  BEFORE UPDATE OR DELETE ON artifact_blobs
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER artifact_blobs_immutable_truncate_guard
  BEFORE TRUNCATE ON artifact_blobs
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_versions_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_mockup_versions
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_versions_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_mockup_versions
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_version_artifacts_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_mockup_version_artifacts
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_version_artifacts_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_mockup_version_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_decisions_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_mockup_decisions
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_mockup_decisions_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_mockup_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_package_supplements_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_task_package_supplements
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER conversation_task_package_supplements_immutable_truncate_guard
  BEFORE TRUNCATE ON conversation_task_package_supplements
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER task_package_supplement_receipts_immutable_guard
  BEFORE UPDATE OR DELETE ON conversation_task_package_supplement_dispatch_receipts
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER task_package_supplement_receipts_truncate_guard
  BEFORE TRUNCATE ON conversation_task_package_supplement_dispatch_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER implementation_visual_evidence_immutable_guard
  BEFORE UPDATE OR DELETE ON implementation_visual_evidence
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER implementation_visual_evidence_immutable_truncate_guard
  BEFORE TRUNCATE ON implementation_visual_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER implementation_visual_evidence_artifacts_immutable_guard
  BEFORE UPDATE OR DELETE ON implementation_visual_evidence_artifacts
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER implementation_visual_artifacts_immutable_truncate_guard
  BEFORE TRUNCATE ON implementation_visual_evidence_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

CREATE OR REPLACE FUNCTION norns_reject_project_delivery_delete()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  RAISE EXCEPTION 'deployment observations are durable audit records'
    USING ERRCODE='23514';
END
$guard$;
CREATE TRIGGER project_delivery_records_delete_guard
  BEFORE DELETE ON project_delivery_records
  FOR EACH ROW EXECUTE FUNCTION norns_reject_project_delivery_delete();
CREATE TRIGGER project_delivery_records_truncate_guard
  BEFORE TRUNCATE ON project_delivery_records
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_project_delivery_delete();
CREATE TRIGGER project_delivery_observations_immutable_guard
  BEFORE UPDATE OR DELETE ON project_delivery_observations
  FOR EACH ROW EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();
CREATE TRIGGER project_delivery_observations_immutable_truncate_guard
  BEFORE TRUNCATE ON project_delivery_observations
  FOR EACH STATEMENT EXECUTE FUNCTION norns_reject_conversation_immutable_mutation();

REVOKE ALL PRIVILEGES ON
  artifact_blobs,
  conversation_mockup_versions,
  conversation_mockup_version_artifacts,
  conversation_mockup_decisions,
  conversation_task_package_supplements,
  conversation_task_package_supplement_dispatch_receipts,
  project_delivery_records,
  project_delivery_observations,
  implementation_visual_evidence,
  implementation_visual_evidence_artifacts
FROM PUBLIC;
REVOKE ALL PRIVILEGES ON
  artifact_blobs,
  conversation_mockup_versions,
  conversation_mockup_version_artifacts,
  conversation_mockup_decisions,
  conversation_task_package_supplements,
  conversation_task_package_supplement_dispatch_receipts,
  project_delivery_records,
  project_delivery_observations,
  implementation_visual_evidence,
  implementation_visual_evidence_artifacts
FROM norns_app;
GRANT SELECT,INSERT ON
  artifact_blobs,
  conversation_mockup_versions,
  conversation_mockup_version_artifacts,
  conversation_mockup_decisions,
  conversation_task_package_supplements,
  conversation_task_package_supplement_dispatch_receipts,
  project_delivery_observations,
  implementation_visual_evidence,
  implementation_visual_evidence_artifacts
TO norns_app;
GRANT SELECT,INSERT,UPDATE ON project_delivery_records TO norns_app;
