import {
  LegacyRepositoryBindingClaimProjection,
  type LegacyRepositoryBindingClaimProjectionT,
} from "@norns/contracts";

import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { PostgresDeviceAuthorizationPolicy } from "./policy.js";

const LIVE_RUN_STATES = [
  "created",
  "dispatched",
  "running",
  "waiting_for_human",
  "verifying",
] as const;

interface ClaimRow {
  id: string;
  project_id: string;
  legacy_binding_id: string;
  state: "claim_required" | "finalized";
  repository_display_name: string;
  created_by_user_id: string;
  begin_idempotency_key: string;
  project_device_repository_grant_id: string | null;
  replacement_binding_id: string | null;
  finalized_by_user_id: string | null;
  finalization_idempotency_key: string | null;
  finalized_at: string | Date | null;
  aggregate_version: number | string;
  created_at: string | Date;
  project_version: number | string;
  work_active: boolean;
}

interface TargetRow {
  execution_target_id: string;
  name: string;
  location_label: string | null;
  repository_display_name: string;
}

interface BeginScopeRow {
  project_id: string;
  project_version: number | string;
  legacy_binding_id: string;
  binding_version: number | string;
  binding_status: string;
  repository_display_name: string;
}

interface FinalizeScopeRow extends ClaimRow {
  legacy_binding_status: string;
  legacy_binding_version: number | string;
  legacy_role: string;
  verification_policy_ref: string;
  current_primary_binding_id: string | null;
}

interface FinalizeTargetRow extends TargetRow {
  workspace_id: string;
  repository_id: string;
  default_branch: string;
  observed_head: string | null;
}

export type LegacyRepositoryClaimErrorCode =
  | "not_found"
  | "project_version_changed"
  | "claim_version_changed"
  | "project_work_active"
  | "claim_already_started"
  | "claim_already_finalized"
  | "idempotency_conflict"
  | "execution_target_changed";

export class LegacyRepositoryClaimError extends Error {
  constructor(readonly code: LegacyRepositoryClaimErrorCode) {
    super(code);
    this.name = "LegacyRepositoryClaimError";
  }
}

function timestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function claimRow(
  sql: V2SqlExecutor,
  projectId: string,
  claimId: string,
): Promise<ClaimRow | null> {
  const selected = await sql.query<ClaimRow>(
    `SELECT
       claim.id,
       claim.project_id,
       claim.legacy_binding_id,
       claim.state,
       legacy.repository_display_name,
       claim.created_by_user_id,
       claim.begin_idempotency_key,
       claim.project_device_repository_grant_id,
       claim.replacement_binding_id,
       claim.finalized_by_user_id,
       claim.finalization_idempotency_key,
       claim.finalized_at,
       claim.aggregate_version,
       claim.created_at,
       project.aggregate_version AS project_version,
       EXISTS (
         SELECT 1
           FROM agent_runs run
          WHERE run.project_id=project.id
            AND run.state=ANY($3::text[])
       ) AS work_active
     FROM legacy_repository_binding_claims claim
     JOIN projects project
       ON project.id=claim.project_id
      AND project.status='active'
     JOIN repository_bindings legacy
       ON legacy.id=claim.legacy_binding_id
      AND legacy.project_id=claim.project_id
    WHERE claim.project_id=$1
      AND claim.id=$2`,
    [projectId, claimId, [...LIVE_RUN_STATES]],
  );
  return selected.rows[0] ?? null;
}

async function targets(sql: V2SqlExecutor, projectId: string): Promise<TargetRow[]> {
  const selected = await sql.query<TargetRow>(
    `SELECT
       grant_record.id AS execution_target_id,
       device.display_name AS name,
       device.location_label,
       registration.repository_display_name
     FROM project_device_repository_grants grant_record
     JOIN device_repository_registrations registration
       ON registration.id=grant_record.repository_registration_id
      AND registration.state='active'
      AND registration.default_branch IS NOT NULL
     JOIN devices device
       ON device.id=registration.device_id
      AND device.lifecycle='active'
     JOIN users device_owner
       ON device_owner.id=device.owner_user_id
      AND device_owner.status='active'
     JOIN device_credentials credential
       ON credential.device_id=device.id
      AND credential.id=registration.approved_credential_id
      AND credential.generation=registration.approved_generation
      AND credential.generation=device.current_generation
      AND credential.state='active'
    WHERE grant_record.project_id=$1
      AND grant_record.state='active'
    ORDER BY
      lower(device.display_name),
      lower(registration.repository_display_name),
      grant_record.id`,
    [projectId],
  );
  return selected.rows;
}

async function projection(
  sql: V2SqlExecutor,
  row: ClaimRow,
): Promise<LegacyRepositoryBindingClaimProjectionT> {
  const candidateTargets = await targets(sql, row.project_id);
  return LegacyRepositoryBindingClaimProjection.parse({
    project_id: row.project_id,
    claim_id: row.id,
    state: row.state,
    repository_display_name: row.repository_display_name,
    claim_version: Number(row.aggregate_version),
    project_version: Number(row.project_version),
    can_finalize: row.state === "claim_required" && !row.work_active && candidateTargets.length > 0,
    candidate_targets: candidateTargets,
    finalized_execution_target_id: row.project_device_repository_grant_id,
    created_at: timestamp(row.created_at),
    finalized_at: timestamp(row.finalized_at),
  });
}

/**
 * Phase 6A's exact-project legacy-binding claim service. It never selects by,
 * groups by, or copies a legacy runner ID. The only device choice is the
 * project owner's explicit active grant ID.
 */
export class LegacyRepositoryClaimService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  getCurrent(
    actorUserId: string,
    projectId: string,
  ): Promise<LegacyRepositoryBindingClaimProjectionT | null> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canClaimLegacyRepository({
        actor_user_id: actorUserId,
        project_id: projectId,
      });
      if (!decision.allowed) return null;
      const selected = await sql.query<{ id: string }>(
        `SELECT claim.id
           FROM legacy_repository_binding_claims claim
           JOIN projects project
             ON project.id=claim.project_id
            AND project.status='active'
          WHERE claim.project_id=$1
          ORDER BY
            CASE
              WHEN claim.state='claim_required'
               AND claim.legacy_binding_id=project.primary_repository_binding_id
              THEN 0
              WHEN claim.state='finalized'
               AND claim.replacement_binding_id=project.primary_repository_binding_id
              THEN 1
              ELSE 2
            END,
            claim.created_at DESC,
            claim.id DESC
          LIMIT 1`,
        [projectId],
      );
      const id = selected.rows[0]?.id;
      if (!id) return null;
      const row = await claimRow(sql, projectId, id);
      return row ? projection(sql, row) : null;
    });
  }

  get(
    actorUserId: string,
    projectId: string,
    claimId: string,
  ): Promise<LegacyRepositoryBindingClaimProjectionT | null> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canClaimLegacyRepository({
        actor_user_id: actorUserId,
        project_id: projectId,
      });
      if (!decision.allowed) return null;
      const row = await claimRow(sql, projectId, claimId);
      return row ? projection(sql, row) : null;
    });
  }

  async begin(input: {
    actor_user_id: string;
    project_id: string;
    expected_project_version: number;
    idempotency_key: string;
    now: string;
  }): Promise<LegacyRepositoryBindingClaimProjectionT> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canClaimLegacyRepository(
        input,
      );
      if (!decision.allowed) throw new LegacyRepositoryClaimError("not_found");

      const replay = await sql.query<{ id: string; project_id: string }>(
        `SELECT id,project_id
           FROM legacy_repository_binding_claims
          WHERE created_by_user_id=$1
            AND begin_idempotency_key=$2
          FOR UPDATE`,
        [input.actor_user_id, input.idempotency_key],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].project_id !== input.project_id) {
          throw new LegacyRepositoryClaimError("idempotency_conflict");
        }
        const row = await claimRow(sql, input.project_id, replay.rows[0].id);
        if (!row) throw new LegacyRepositoryClaimError("not_found");
        return projection(sql, row);
      }

      // A browser reload may legitimately create a fresh request key. Return
      // the exact project's already-open claim instead of creating, selecting,
      // or inferring anything from the legacy runner identifier.
      const open = await sql.query<{ id: string }>(
        `SELECT claim.id
           FROM legacy_repository_binding_claims claim
           JOIN projects project
             ON project.id=claim.project_id
            AND project.status='active'
            AND project.primary_repository_binding_id=claim.legacy_binding_id
          WHERE claim.project_id=$1
            AND claim.state='claim_required'
          FOR UPDATE OF claim,project`,
        [input.project_id],
      );
      if (open.rows[0]) {
        const row = await claimRow(sql, input.project_id, open.rows[0].id);
        if (!row) throw new LegacyRepositoryClaimError("not_found");
        return projection(sql, row);
      }

      const selected = await sql.query<BeginScopeRow>(
        `SELECT
           project.id AS project_id,
           project.aggregate_version AS project_version,
           binding.id AS legacy_binding_id,
           binding.aggregate_version AS binding_version,
           binding.status AS binding_status,
           binding.repository_display_name
         FROM users actor
         JOIN projects project
           ON project.owner_user_id=actor.id
          AND project.id=$2
          AND project.status='active'
         JOIN repository_bindings binding
           ON binding.id=project.primary_repository_binding_id
          AND binding.project_id=project.id
          AND binding.binding_type='local_runner'
          AND binding.runner_id IS NOT NULL
          AND binding.project_device_repository_grant_id IS NULL
          AND binding.status IN (
            'unverified_candidate','validating','connected','degraded','disconnected'
          )
        WHERE actor.id=$1
          AND actor.status='active'
        FOR UPDATE OF actor,project,binding`,
        [input.actor_user_id, input.project_id],
      );
      const scope = selected.rows[0];
      if (!scope) throw new LegacyRepositoryClaimError("not_found");
      if (Number(scope.project_version) !== input.expected_project_version) {
        throw new LegacyRepositoryClaimError("project_version_changed");
      }

      // This must be a fresh statement after the ownership, project, and
      // binding locks above. A scheduler can have inserted an uncommitted run
      // while holding those same scope locks; the selecting statement's MVCC
      // snapshot must not decide whether work is still active after it waits.
      const liveWork = await sql.query<{ work_active: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM agent_runs run
            WHERE run.project_id=$1
              AND run.state=ANY($2::text[])
         ) AS work_active`,
        [input.project_id, [...LIVE_RUN_STATES]],
      );
      if (liveWork.rows[0]?.work_active) {
        throw new LegacyRepositoryClaimError("project_work_active");
      }

      const existing = await sql.query<{ id: string }>(
        `SELECT id
           FROM legacy_repository_binding_claims
          WHERE legacy_binding_id=$1
          FOR UPDATE`,
        [scope.legacy_binding_id],
      );
      if (existing.rows[0]) {
        const row = await claimRow(sql, input.project_id, existing.rows[0].id);
        if (!row) throw new LegacyRepositoryClaimError("claim_already_started");
        return projection(sql, row);
      }

      const claimId = newId("legacy-binding-claim");
      await sql.query(
        `INSERT INTO legacy_repository_binding_claims (
           id,project_id,legacy_binding_id,state,preclaim_status,
           created_by_user_id,begin_idempotency_key,created_at,updated_at
         ) VALUES (
           $1,$2,$3,'claim_required',$4,$5,$6,$7,$7
         )`,
        [
          claimId,
          input.project_id,
          scope.legacy_binding_id,
          scope.binding_status,
          input.actor_user_id,
          input.idempotency_key,
          input.now,
        ],
      );
      const marked = await sql.query<{ id: string }>(
        `UPDATE repository_bindings
            SET status='legacy_claim_required',
                aggregate_version=aggregate_version+1,
                updated_at=$3
          WHERE id=$1
            AND project_id=$2
            AND aggregate_version=$4
            AND status=$5
          RETURNING id`,
        [
          scope.legacy_binding_id,
          input.project_id,
          input.now,
          Number(scope.binding_version),
          scope.binding_status,
        ],
      );
      if (!marked.rows[0]) throw new LegacyRepositoryClaimError("project_version_changed");
      await sql.query(
        `INSERT INTO audit_events (
           audit_id,audit_type,project_id,actor_type,actor_id,outcome,severity,
           correlation_id,causation_id,occurred_at,targets,summary,details,
           redaction_applied
         ) VALUES (
           $1,'device.legacy_repository_claim_started',$2,'human',$3,
           'succeeded','warning',$4,$5,$6,$7::jsonb,
           'Legacy repository claim started',$8::jsonb,true
         )`,
        [
          newId("audit"),
          input.project_id,
          input.actor_user_id,
          `legacy-repository-claim:${claimId}`,
          scope.legacy_binding_id,
          input.now,
          JSON.stringify([{ entity_type: "legacy_repository_binding_claim", entity_id: claimId }]),
          JSON.stringify({ project_id: input.project_id }),
        ],
      );
      const row = await claimRow(sql, input.project_id, claimId);
      if (!row) throw new LegacyRepositoryClaimError("not_found");
      return projection(sql, row);
    });
  }

  async finalize(input: {
    actor_user_id: string;
    project_id: string;
    claim_id: string;
    execution_target_id: string;
    expected_claim_version: number;
    expected_project_version: number;
    idempotency_key: string;
    now: string;
  }): Promise<LegacyRepositoryBindingClaimProjectionT> {
    return this.transactions.transaction(async (sql) => {
      const decision = await new PostgresDeviceAuthorizationPolicy(sql).canClaimLegacyRepository(
        input,
      );
      if (!decision.allowed) throw new LegacyRepositoryClaimError("not_found");

      const idempotent = await sql.query<{
        id: string;
        project_id: string;
        project_device_repository_grant_id: string | null;
      }>(
        `SELECT id,project_id,project_device_repository_grant_id
           FROM legacy_repository_binding_claims
          WHERE finalized_by_user_id=$1
            AND finalization_idempotency_key=$2
          FOR UPDATE`,
        [input.actor_user_id, input.idempotency_key],
      );
      if (idempotent.rows[0]) {
        if (
          idempotent.rows[0].id !== input.claim_id ||
          idempotent.rows[0].project_id !== input.project_id ||
          idempotent.rows[0].project_device_repository_grant_id !== input.execution_target_id
        ) {
          throw new LegacyRepositoryClaimError("idempotency_conflict");
        }
        const row = await claimRow(sql, input.project_id, input.claim_id);
        if (!row) throw new LegacyRepositoryClaimError("not_found");
        return projection(sql, row);
      }

      const selected = await sql.query<FinalizeScopeRow>(
        `SELECT
           claim.id,
           claim.project_id,
           claim.legacy_binding_id,
           claim.state,
           legacy.repository_display_name,
           claim.created_by_user_id,
           claim.begin_idempotency_key,
           claim.project_device_repository_grant_id,
           claim.replacement_binding_id,
           claim.finalized_by_user_id,
           claim.finalization_idempotency_key,
           claim.finalized_at,
           claim.aggregate_version,
           claim.created_at,
           project.aggregate_version AS project_version,
           EXISTS (
             SELECT 1
               FROM agent_runs run
              WHERE run.project_id=project.id
                AND run.state=ANY($4::text[])
           ) AS work_active,
           legacy.status AS legacy_binding_status,
           legacy.aggregate_version AS legacy_binding_version,
           legacy.role AS legacy_role,
           project.verification_policy_ref,
           project.primary_repository_binding_id AS current_primary_binding_id
         FROM users actor
         JOIN projects project
           ON project.owner_user_id=actor.id
          AND project.id=$2
          AND project.status='active'
         JOIN legacy_repository_binding_claims claim
           ON claim.id=$3
          AND claim.project_id=project.id
         JOIN repository_bindings legacy
           ON legacy.id=claim.legacy_binding_id
          AND legacy.project_id=project.id
        WHERE actor.id=$1
          AND actor.status='active'
        FOR UPDATE OF actor,project,claim,legacy`,
        [input.actor_user_id, input.project_id, input.claim_id, [...LIVE_RUN_STATES]],
      );
      const scope = selected.rows[0];
      if (!scope) throw new LegacyRepositoryClaimError("not_found");
      if (scope.state === "finalized") {
        throw new LegacyRepositoryClaimError("claim_already_finalized");
      }
      if (Number(scope.aggregate_version) !== input.expected_claim_version) {
        throw new LegacyRepositoryClaimError("claim_version_changed");
      }
      if (
        Number(scope.project_version) !== input.expected_project_version ||
        scope.current_primary_binding_id !== scope.legacy_binding_id ||
        scope.legacy_binding_status !== "legacy_claim_required"
      ) {
        throw new LegacyRepositoryClaimError("project_version_changed");
      }
      if (scope.work_active) throw new LegacyRepositoryClaimError("project_work_active");

      const target = await sql.query<FinalizeTargetRow>(
        `SELECT
           grant_record.id AS execution_target_id,
           device.display_name AS name,
           device.location_label,
           registration.repository_display_name,
           registration.workspace_id,
           registration.repository_id,
           registration.default_branch,
           registration.observed_head
         FROM project_device_repository_grants grant_record
         JOIN device_repository_registrations registration
           ON registration.id=grant_record.repository_registration_id
          AND registration.state='active'
          AND registration.default_branch IS NOT NULL
         JOIN devices device
           ON device.id=registration.device_id
          AND device.lifecycle='active'
         JOIN users device_owner
           ON device_owner.id=device.owner_user_id
          AND device_owner.status='active'
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.id=registration.approved_credential_id
          AND credential.generation=registration.approved_generation
          AND credential.generation=device.current_generation
          AND credential.state='active'
        WHERE grant_record.id=$1
          AND grant_record.project_id=$2
          AND grant_record.state='active'
        FOR UPDATE OF grant_record,registration,device,device_owner,credential`,
        [input.execution_target_id, input.project_id],
      );
      const selectedTarget = target.rows[0];
      if (!selectedTarget) throw new LegacyRepositoryClaimError("execution_target_changed");

      const replacementBindingId = newId("repository-binding");
      await sql.query(
        `INSERT INTO repository_bindings (
           id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
           repository_display_name,granted_permissions,default_branch,observed_head,
           verification_policy_ref,repository_health,created_by_actor_type,
           created_by_actor_id,project_device_repository_grant_id,role,created_at,updated_at
         ) VALUES (
           $1,$2,'local_runner','disconnected',NULL,$3,$4,$5,'{}'::jsonb,$6,$7,
           $8,'unknown','human',$9,$10,$11,$12,$12
         )`,
        [
          replacementBindingId,
          input.project_id,
          selectedTarget.workspace_id,
          selectedTarget.repository_id,
          selectedTarget.repository_display_name,
          selectedTarget.default_branch,
          selectedTarget.observed_head,
          scope.verification_policy_ref,
          input.actor_user_id,
          input.execution_target_id,
          scope.legacy_role,
          input.now,
        ],
      );
      const switched = await sql.query<{ aggregate_version: number | string }>(
        `UPDATE projects
            SET primary_repository_binding_id=$2,
                aggregate_version=aggregate_version+1,
                updated_at=$3
          WHERE id=$1
            AND aggregate_version=$4
            AND primary_repository_binding_id=$5
            AND NOT EXISTS (
              SELECT 1
                FROM agent_runs run
               WHERE run.project_id=projects.id
                 AND run.state=ANY($6::text[])
            )
          RETURNING aggregate_version`,
        [
          input.project_id,
          replacementBindingId,
          input.now,
          input.expected_project_version,
          scope.legacy_binding_id,
          [...LIVE_RUN_STATES],
        ],
      );
      const project = switched.rows[0];
      if (!project) throw new LegacyRepositoryClaimError("project_version_changed");

      const retired = await sql.query<{ id: string }>(
        `UPDATE repository_bindings
            SET status='revoked',
                aggregate_version=aggregate_version+1,
                updated_at=$3
          WHERE id=$1
            AND project_id=$2
            AND status='legacy_claim_required'
            AND aggregate_version=$4
          RETURNING id`,
        [
          scope.legacy_binding_id,
          input.project_id,
          input.now,
          Number(scope.legacy_binding_version),
        ],
      );
      if (!retired.rows[0]) throw new LegacyRepositoryClaimError("project_version_changed");

      const finalized = await sql.query<{ id: string }>(
        `UPDATE legacy_repository_binding_claims
            SET state='finalized',
                project_device_repository_grant_id=$2,
                replacement_binding_id=$3,
                finalized_by_user_id=$4,
                finalization_idempotency_key=$5,
                finalized_at=$6,
                aggregate_version=aggregate_version+1,
                updated_at=$6
          WHERE id=$1
            AND state='claim_required'
            AND aggregate_version=$7
          RETURNING id`,
        [
          input.claim_id,
          input.execution_target_id,
          replacementBindingId,
          input.actor_user_id,
          input.idempotency_key,
          input.now,
          input.expected_claim_version,
        ],
      );
      if (!finalized.rows[0]) throw new LegacyRepositoryClaimError("claim_version_changed");

      await sql.query(
        `INSERT INTO domain_events (
           event_id,stream_type,stream_id,stream_version,event_type,project_id,
           actor_type,actor_id,correlation_id,causation_id,occurred_at,payload
         ) VALUES (
           $1,'project',$2,$3,'legacy_repository_binding_claim_finalized',$2,
           'human',$4,$5,$6,$7,$8::jsonb
         )`,
        [
          newId("event"),
          input.project_id,
          Number(project.aggregate_version),
          input.actor_user_id,
          `legacy-repository-claim:${input.claim_id}`,
          input.claim_id,
          input.now,
          JSON.stringify({
            kind: "legacy_repository_binding_claim_finalized",
            claim_id: input.claim_id,
            execution_target_id: input.execution_target_id,
          }),
        ],
      );
      await sql.query(
        `INSERT INTO audit_events (
           audit_id,audit_type,project_id,actor_type,actor_id,outcome,severity,
           correlation_id,causation_id,occurred_at,targets,summary,details,
           redaction_applied
         ) VALUES (
           $1,'device.legacy_repository_claim_finalized',$2,'human',$3,
           'succeeded','warning',$4,$5,$6,$7::jsonb,
           'Legacy repository claim finalized',$8::jsonb,true
         )`,
        [
          newId("audit"),
          input.project_id,
          input.actor_user_id,
          `legacy-repository-claim:${input.claim_id}`,
          input.claim_id,
          input.now,
          JSON.stringify([
            { entity_type: "legacy_repository_binding_claim", entity_id: input.claim_id },
          ]),
          JSON.stringify({ execution_target_id: input.execution_target_id }),
        ],
      );
      const row = await claimRow(sql, input.project_id, input.claim_id);
      if (!row) throw new LegacyRepositoryClaimError("not_found");
      return projection(sql, row);
    });
  }
}
