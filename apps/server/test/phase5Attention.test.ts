import { PGlite } from "@electric-sql/pglite";
import { V2AuditEvent, V2DomainEvent, V2ProjectMemoryEntry } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  AttentionService,
  QC_GATE_NUDGE_TTL_MS,
  requiresHumanIntervention,
} from "../src/projects/attentionService.js";

/**
 * QCP-2A fixture: the full FK/trigger chain a `conversation_plan_reviews` row
 * demands (work_items -> work_conversations -> work_messages ->
 * conversation_actions -> work_plan_versions -> planning_runs), inserted
 * directly at `status='awaiting_human'` so the review row is created in one
 * shot rather than replayed through queued -> running -> awaiting_human
 * (the lifecycle-guard trigger only fires on UPDATE, so a same-shape INSERT
 * is the simplest valid path to a parked row).
 */
async function seedPausedReview(
  pg: PGlite,
  opts: {
    suffix: string;
    pausedCheckpoint: "after_review" | "after_revision" | "adjudication";
    pausedAtRound: number;
    updatedAt: string;
    chatMessages?: unknown[];
    phaseId?: string | null;
  },
): Promise<string> {
  const s = opts.suffix;
  const planHash = "1".repeat(64);
  const contextHash = "2".repeat(64);
  const payloadHash = "3".repeat(64);
  const fingerprint = "4".repeat(64);
  const planJson = JSON.stringify({ objective: `Paused review ${s}`, tasks: [] });
  const contextManifest = JSON.stringify({ entries: [], context_hash: contextHash });
  const payload = JSON.stringify({
    parameters: { plan_version_id: `plan-version-${s}`, content_hash: planHash },
  });

  await pg.query(
    `INSERT INTO work_items (id, project_id, created_by_user_id, title, objective, phase_id)
     VALUES ($1,'project-1','user-1',$2,$2,$3)`,
    [`work-item-${s}`, `Paused review ${s}`, opts.phaseId ?? null],
  );
  await pg.query(
    `INSERT INTO work_conversations (id, project_id, work_item_id, created_by_user_id, kind, provider, model)
     VALUES ($1,'project-1',$2,'user-1','planning','anthropic','claude')`,
    [`conversation-${s}`, `work-item-${s}`],
  );
  await pg.query(
    `INSERT INTO work_messages (
       id, project_id, work_item_id, conversation_id, initiated_by_user_id,
       actor_type, actor_id, role, sequence, parts, client_message_id, request_fingerprint
     ) VALUES ($1,'project-1',$2,$3,'user-1','human','user-1','user',1,$4::jsonb,$5,$6)`,
    [
      `message-${s}`,
      `work-item-${s}`,
      `conversation-${s}`,
      JSON.stringify([{ type: "text", text: "Send this plan to QC." }]),
      `client-${s}`,
      fingerprint,
    ],
  );
  await pg.query(
    `INSERT INTO conversation_actions (
       id, project_id, work_item_id, conversation_id, initiated_by_user_id,
       actor_type, actor_id, source_message_id, action_type, payload, payload_hash,
       status, confirmed_by_user_id, confirmation_idempotency_key,
       confirmation_request_fingerprint, confirmed_at
     ) VALUES ($1,'project-1',$2,$3,'user-1','human','user-1',$4,'send_plan_to_qc',$5::jsonb,$6,
               'confirmed','user-1',$7,$8,now())`,
    [
      `action-${s}`,
      `work-item-${s}`,
      `conversation-${s}`,
      `message-${s}`,
      payload,
      payloadHash,
      `idempotency-${s}`,
      fingerprint,
    ],
  );
  await pg.query(
    `INSERT INTO work_plan_versions (
       id, project_id, work_item_id, conversation_id, created_by_user_id,
       version, status, plan, content_hash
     ) VALUES ($1,'project-1',$2,$3,'user-1',1,'in_qc',$4::jsonb,$5)`,
    [`plan-version-${s}`, `work-item-${s}`, `conversation-${s}`, planJson, planHash],
  );
  await pg.query(
    `INSERT INTO planning_runs (
       id, project_id, status, round, max_rounds, objective, transcript,
       result, total_cost_usd, error, attachment_ids, worker_providers, mode,
       requested_by, initiated_by_user_id, pm_provider, pm_model, agent_provider, agent_model
     ) VALUES ($1,'project-1','queued',0,3,$2,'[]'::jsonb,NULL,0,NULL,'[]'::jsonb,
               'both','review_only','user-1','user-1','anthropic','claude','openai','gpt-4')`,
    [`planning-run-${s}`, `Paused review ${s}`],
  );
  await pg.query(
    `INSERT INTO conversation_plan_reviews (
       id, project_id, work_item_id, conversation_id, action_id, plan_version_id,
       planning_run_id, initiated_by_user_id, attempt_number, pm_provider, pm_model,
       reviewer_provider, reviewer_model, usage_request_group_id, seed_plan, status,
       plan_content_hash, result_plan_content_hash, context_receipt, context_manifest,
       context_hash, paused_checkpoint, paused_at_round, chat_messages, started_at, updated_at
     ) VALUES ($1,'project-1',$2,$3,$4,$5,$6,'user-1',1,'anthropic','claude','openai','gpt-4',$1,
               $7::jsonb,'awaiting_human',$8,$8,'{}'::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$14)`,
    [
      `review-${s}`,
      `work-item-${s}`,
      `conversation-${s}`,
      `action-${s}`,
      `plan-version-${s}`,
      `planning-run-${s}`,
      planJson,
      planHash,
      contextManifest,
      contextHash,
      opts.pausedCheckpoint,
      opts.pausedAtRound,
      JSON.stringify(opts.chatMessages ?? []),
      opts.updatedAt,
    ],
  );
  return `review-${s}`;
}

describe.sequential("Phase 5 attention projections", () => {
  let pg: PGlite;
  let attention: AttentionService;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES ('user-1','owner@example.com','Owner','owner@example.com','Owner',
                'hash','scrypt-v1','admin','active');
      INSERT INTO projects (
        id,name,description,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref
      ) VALUES ('project-1','Project One','Persistent project','active','assignment','verification','budget');
      INSERT INTO phases (id,project_id,objective_summary,priority,status,approved_budget_usd)
      VALUES ('phase-1','project-1','Ship attention mode',1,'approved',10);
      INSERT INTO strategy_versions (
        id,project_id,phase_id,version,status,objective,content,convergence,review_rounds,content_hash
      ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Ship attention mode','{}'::jsonb,
                'converged',1,repeat('a',64));
      UPDATE phases SET approved_strategy_version_id='strategy-1' WHERE id='phase-1';
      INSERT INTO objectives (id,project_id,phase_id,outcome,success_measures,status,"order")
      VALUES ('objective-1','project-1','phase-1','Attention works','["visible"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id,project_id,phase_id,objective_id,strategy_version_id,title,description,
        deliverables,acceptance_criteria,complexity,risk,required_roles,
        required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
        verification_policy_ref,state,lifecycle_version,aggregate_version
      ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1',
        'Resolve production blocker','Blocked work','["fix"]'::jsonb,'["green"]'::jsonb,
        'M','high','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,'["commit"]'::jsonb,
        'environment','verification','blocked',1,1);
    `);
    attention = new AttentionService(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  it("surfaces a completed quick kickoff refusal as restart-needed portfolio attention", async () => {
    await pg.exec(`
      UPDATE tasks SET state='pending', aggregate_version=2 WHERE id='task-1';
      INSERT INTO planning_runs (
        id,project_id,status,round,max_rounds,objective,result,mode,requested_by,
        quick_kickoff_status,quick_kickoff_attempts,quick_kickoff_result,updated_at
      ) VALUES (
        'planning-run-quick-failure','project-1','approved',0,1,
        'Correct the empty-state grammar','{}'::jsonb,'quick','user-1',
        'completed',1,
        '{"started":false,"detail":"No runner is available for the approved workspace."}'::jsonb,
        '2026-07-25T18:00:00.000Z'
      );
      UPDATE phases
         SET planning_run_id='planning-run-quick-failure'
       WHERE id='phase-1';
    `);

    const portfolio = await attention.portfolio("user-1", {
      now: new Date("2026-07-25T18:01:00.000Z"),
    });

    expect(portfolio.counts).toMatchObject({
      blockers: 1,
      active_runs: 0,
    });
    expect(portfolio.items).toEqual([
      expect.objectContaining({
        source_type: "planning_run",
        source_id: "planning-run-quick-failure",
        phase_id: "phase-1",
        task_id: null,
        condition_class: "quick_kickoff_failed",
        kind: "blocker",
        severity: "high",
        title: "Coding needs a restart",
        summary: "No runner is available for the approved workspace.",
        recommendation: "Open the Phase tab, resolve the reported blocker, and retry coding",
      }),
    ]);
    expect(portfolio.projects).toEqual([
      expect.objectContaining({
        id: "project-1",
        health: "attention",
        active_runs: 0,
        attention_count: 1,
        next_action: "Open the Phase tab, resolve the reported blocker, and retry coding",
      }),
    ]);

    await pg.exec("UPDATE phases SET status='active' WHERE id='phase-1'");
    const started = await attention.portfolio("user-1", {
      now: new Date("2026-07-25T18:02:00.000Z"),
    });
    expect(started.items).toHaveLength(0);
    expect(started.projects[0]).toMatchObject({
      health: "healthy",
      active_runs: 0,
      attention_count: 0,
    });
  });

  it("keeps a completion milestone in activity without classifying it as intervention", async () => {
    expect(requiresHumanIntervention({ kind: "milestone" })).toBe(false);
    expect(requiresHumanIntervention({ kind: "blocker" })).toBe(true);

    await pg.exec(`
      UPDATE tasks
         SET state='completed',
             review_evidence='[{"artifact_id":"review"}]'::jsonb,
             completion_evidence='[{"artifact_id":"completion"}]'::jsonb,
             completed_at='2026-07-25T18:00:00.000Z'
       WHERE id='task-1';
      UPDATE objectives SET status='completed' WHERE id='objective-1';
      UPDATE phases
         SET status='completed', closed_at='2026-07-25T18:00:00.000Z',
             closure_summary='Completed successfully',
             closure_evidence='[{"artifact_id":"completion"}]'::jsonb
       WHERE id='phase-1';
    `);

    const portfolio = await attention.portfolio("user-1", {
      now: new Date("2026-07-25T18:01:00.000Z"),
    });
    expect(portfolio.items).toEqual([
      expect.objectContaining({
        source_type: "phase",
        source_id: "phase-1",
        kind: "milestone",
        severity: "low",
        title: "Phase completed",
      }),
    ]);
    expect(portfolio.counts).toMatchObject({
      critical: 0,
      high: 0,
      decisions: 0,
      approvals: 0,
      blockers: 0,
      active_runs: 0,
    });
    expect(portfolio.projects).toEqual([
      expect.objectContaining({
        id: "project-1",
        health: "healthy",
        attention_count: 0,
        next_action: "Create the next phase",
      }),
    ]);
  });

  it("preserves acknowledgement across rebuild and re-raises one changed condition", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    const initial = await attention.portfolio("user-1", { now });
    const item = initial.items.find((candidate) => candidate.source_id === "task-1");
    expect(item).toMatchObject({ kind: "blocker", acknowledged: false, severity: "high" });
    if (!item) throw new Error("missing task attention item");

    await attention.disposition({
      user_id: "user-1",
      item_key: item.key,
      condition_fingerprint: item.condition_fingerprint,
      disposition: "acknowledged",
      snoozed_until: null,
      now,
    });
    expect((await attention.portfolio("user-1", { now })).items).toHaveLength(0);
    const rebuilt = await attention.portfolio("user-1", { includeAcknowledged: true, now });
    expect(rebuilt.items[0]).toMatchObject({ key: item.key, acknowledged: true });

    await pg.query("UPDATE tasks SET aggregate_version=2, updated_at=$2 WHERE id=$1", [
      "task-1",
      "2026-07-16T21:01:00.000Z",
    ]);
    const changed = await attention.portfolio("user-1", {
      now: new Date("2026-07-16T21:02:00.000Z"),
    });
    expect(changed.items).toHaveLength(1);
    expect(changed.items[0]).toMatchObject({ key: item.key, acknowledged: false });
    expect(changed.items[0]?.condition_fingerprint).not.toBe(item.condition_fingerprint);
  });

  it("projects phase execution from canonical tasks rather than the legacy graph", async () => {
    const execution = await attention.phase("project-1", "phase-1");
    expect(execution.phase).toMatchObject({ total_tasks: 1, completed_tasks: 0 });
    expect(execution.tasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        state: "blocked",
        dependencies: [],
        assignment: null,
        run: null,
      }),
    ]);
  });

  it("hides recovery attention once its phase is cancelled or its failed run is superseded", async () => {
    await pg.exec(`
      UPDATE phases SET status='active' WHERE id='phase-1';
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions,
        default_branch, verification_policy_ref, repository_health,
        created_by_actor_type
      ) VALUES (
        'binding-attention','project-1','local_runner','connected','runner-attention',
        'workspace-attention','repo-attention','Attention repository','{}'::jsonb,
        'main','verification','healthy','human'
      );
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, context_limit_tokens, status, cost_metadata
      ) VALUES (
        'agent-attention','openai','codex','codex','["backend"]'::jsonb,
        128000,'available','{}'::jsonb
      );
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status,
        rationale, rationale_factors, allocation_policy_ref
      ) VALUES (
        'assignment-attention','project-1','phase-1','task-1','agent-attention','active',
        'Attention projection fixture','["capability"]'::jsonb,'allocation'
      );
      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision, failure_code,
        failure_detail, lifecycle_version
      ) VALUES (
        'run-attention','project-1','phase-1','task-1','assignment-attention',1,'failed',
        true,'binding-attention','base-attention','runner_failed','Runner failed',1
      );
      UPDATE tasks
         SET designated_assignment_id='assignment-attention',
             designated_run_id='run-attention'
       WHERE id='task-1';
      INSERT INTO decision_points (
        id, project_id, phase_id, task_id, scope_entity_type, scope_entity_id,
        reason_class, source_instance_id, condition_key, condition_fingerprint,
        question, context, options, recommendation_option_id, urgency,
        blocking_scope, status
      ) VALUES (
        'decision-attention','project-1','phase-1','task-1','agent_run','run-attention',
        'failed_run','run-attention','decision:failed:run-attention',repeat('e',64),
        'Recover the failed run?','The designated run failed.',
        '[{"id":"retry","label":"Retry"},{"id":"cancel","label":"Cancel"}]'::jsonb,
        'retry','high','{"entity_type":"task","entity_id":"task-1"}'::jsonb,'open'
      );
    `);

    const active = await attention.portfolio("user-1");
    expect(active.items.map((item) => item.source_id)).toEqual(
      expect.arrayContaining(["run-attention", "decision-attention"]),
    );

    await pg.exec(`
      INSERT INTO agent_runs (
        id, project_id, phase_id, task_id, assignment_id, attempt, state,
        is_designated, repository_binding_id, expected_revision
      ) VALUES (
        'run-attention-retry','project-1','phase-1','task-1','assignment-attention',2,
        'created',false,'binding-attention','base-attention'
      );
      UPDATE agent_runs
         SET is_designated=false, superseded_at='2026-07-25T18:00:00.000Z',
             superseded_by_run_id='run-attention-retry'
       WHERE id='run-attention';
      UPDATE agent_runs SET is_designated=true WHERE id='run-attention-retry';
      UPDATE tasks SET designated_run_id='run-attention-retry' WHERE id='task-1';
    `);
    const superseded = await attention.portfolio("user-1");
    expect(superseded.items.map((item) => item.source_id)).not.toContain("run-attention");
    expect(superseded.items.map((item) => item.source_id)).not.toContain("decision-attention");

    await pg.exec(`
      UPDATE agent_runs SET is_designated=false WHERE id='run-attention-retry';
      UPDATE agent_runs
         SET is_designated=true, superseded_at=NULL, superseded_by_run_id=NULL
       WHERE id='run-attention';
      UPDATE tasks SET designated_run_id='run-attention' WHERE id='task-1';
      UPDATE phases
         SET status='cancelled', closed_at='2026-07-25T18:01:00.000Z'
       WHERE id='phase-1';
    `);
    const cancelled = await attention.portfolio("user-1");
    expect(cancelled.items.map((item) => item.source_id)).not.toContain("run-attention");
    expect(cancelled.items.map((item) => item.source_id)).not.toContain("decision-attention");
  });

  it("snoozes unchanged material but immediately re-raises a changed condition", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    const item = (await attention.portfolio("user-1", { now })).items[0];
    if (!item) throw new Error("missing attention item");
    await attention.disposition({
      user_id: "user-1",
      item_key: item.key,
      condition_fingerprint: item.condition_fingerprint,
      disposition: "snoozed",
      snoozed_until: "2026-07-16T22:00:00.000Z",
      now,
    });
    expect((await attention.portfolio("user-1", { now })).items).toHaveLength(0);

    await pg.query("UPDATE tasks SET aggregate_version=2 WHERE id='task-1'");
    const changed = await attention.portfolio("user-1", {
      now: new Date("2026-07-16T21:01:00.000Z"),
    });
    expect(changed.items).toHaveLength(1);
    expect(changed.items[0]).toMatchObject({ key: item.key, snoozed_until: null });
  });

  it("normalizes legacy decision options and atomically persists an idempotent human resolution", async () => {
    await pg.exec(`
      INSERT INTO decision_points (
        id,project_id,phase_id,task_id,scope_entity_type,scope_entity_id,reason_class,
        source_instance_id,condition_key,condition_fingerprint,question,context,options,
        recommendation_option_id,urgency,blocking_scope,status
      ) VALUES (
        'decision-1','project-1','phase-1','task-1','task','task-1','qc_question',
        'review-1','decision:legacy',repeat('b',64),'Which path should we take?',
        'Reviewer needs human judgment.',
        '[{"id":"accept","label":"Accept"},{"id":"rework","label":"Request rework"}]'::jsonb,
        'accept','high','{"entity_type":"task","entity_id":"task-1"}'::jsonb,'open'
      );
    `);
    const item = (await attention.portfolio("user-1")).items.find(
      (candidate) => candidate.source_id === "decision-1",
    );
    expect(item?.decision).toEqual({
      decision_point_id: "decision-1",
      condition_fingerprint: "b".repeat(64),
      recommendation_option_id: "accept",
      options: [
        expect.objectContaining({
          id: "accept",
          label: "Accept",
          impact: expect.any(String),
          risk: expect.any(String),
        }),
        expect.objectContaining({
          id: "rework",
          label: "Request rework",
          impact: expect.any(String),
          risk: expect.any(String),
        }),
      ],
    });

    const request = {
      user_id: "user-1",
      project_id: "project-1",
      decision_point_id: "decision-1",
      idempotency_key: "resolve-qc-1",
      expected_condition_fingerprint: "b".repeat(64),
      selected_option_id: "accept",
      rationale: "The verified evidence supports acceptance.",
      direction_target: "all_agents" as const,
      direction_text: "",
      now: new Date("2026-07-17T12:00:00.000Z"),
    };
    const result = await attention.resolveDecision(request);
    expect(await attention.resolveDecision(request)).toEqual(result);
    const persisted = await pg.query<{
      status: string;
      approvals: number;
      records: number;
      memories: number;
      events: number;
      audits: number;
      idempotency: number;
      direction_target: string;
      direction_text: string;
      source_ref: unknown;
    }>(`SELECT
      (SELECT status FROM decision_points WHERE id='decision-1') AS status,
      (SELECT count(*)::int FROM approvals WHERE subject_entity_id='decision-1') AS approvals,
      (SELECT count(*)::int FROM decision_records WHERE decision_point_id='decision-1') AS records,
      (SELECT count(*)::int FROM project_memory_entries WHERE provenance='human_decision_resolution') AS memories,
      (SELECT count(*)::int FROM domain_events WHERE stream_id='decision-1') AS events,
      (SELECT count(*)::int FROM audit_events WHERE audit_type='decision_point_resolved') AS audits,
      (SELECT count(*)::int FROM idempotency_records WHERE command_family='decision_resolution') AS idempotency,
      (SELECT direction_target FROM decision_records WHERE decision_point_id='decision-1') AS direction_target,
      (SELECT direction_text FROM decision_records WHERE decision_point_id='decision-1') AS direction_text,
      (SELECT source_ref FROM project_memory_entries WHERE provenance='human_decision_resolution') AS source_ref`);
    expect(persisted.rows[0]).toMatchObject({
      status: "resolved",
      approvals: 1,
      records: 1,
      memories: 1,
      events: 1,
      audits: 1,
      idempotency: 1,
      direction_target: "all_agents",
      direction_text: "Accept — The verified evidence supports acceptance.",
      source_ref: expect.objectContaining({
        entity_type: "decision_record",
      }),
    });
    const domain = await pg.query("SELECT * FROM domain_events WHERE stream_id='decision-1'");
    const audit = await pg.query(
      "SELECT * FROM audit_events WHERE audit_type='decision_point_resolved'",
    );
    const persistedDomain = domain.rows[0] as Record<string, unknown> & {
      occurred_at: string | Date;
    };
    const parsedDomain = V2DomainEvent.safeParse({
      ...persistedDomain,
      occurred_at: new Date(persistedDomain.occurred_at).toISOString(),
    });
    expect(parsedDomain.success, parsedDomain.success ? "" : parsedDomain.error.message).toBe(true);
    const persistedAudit = audit.rows[0] as Record<string, unknown> & {
      occurred_at: string | Date;
    };
    const parsedAudit = V2AuditEvent.safeParse({
      ...persistedAudit,
      occurred_at: new Date(persistedAudit.occurred_at).toISOString(),
    });
    expect(parsedAudit.success, parsedAudit.success ? "" : parsedAudit.error.message).toBe(true);
    await expect(
      pg.query("UPDATE decision_records SET direction_text='tampered' WHERE id=$1", [
        result.decision_record_id,
      ]),
    ).rejects.toThrow(/substantive fields are immutable/);
    await expect(
      pg.query("UPDATE decision_records SET status='obsolete' WHERE id=$1", [
        result.decision_record_id,
      ]),
    ).resolves.toBeDefined();
  });

  it("rejects stale, invalid, closed, and cross-project decision resolution", async () => {
    await pg.exec(`
      INSERT INTO projects (id,name,description,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref)
      VALUES ('project-2','Other','','active','assignment','verification','budget');
      INSERT INTO decision_points (
        id,project_id,scope_entity_type,scope_entity_id,reason_class,source_instance_id,
        condition_key,condition_fingerprint,question,context,options,recommendation_option_id,
        urgency,status
      ) VALUES ('decision-2','project-2','project','project-2','scope','source-2','decision:2',
        repeat('c',64),'Choose','Context','[{"id":"one","label":"One"}]'::jsonb,
        'one','normal','open');
    `);
    const base = {
      user_id: "user-1",
      project_id: "project-2",
      decision_point_id: "decision-2",
      idempotency_key: "decision-2-key",
      expected_condition_fingerprint: "c".repeat(64),
      selected_option_id: "one",
      rationale: "Reason",
      direction_target: "project_manager" as const,
      direction_text: "Apply option one.",
    };
    await expect(
      attention.resolveDecision({ ...base, project_id: "project-1" }),
    ).rejects.toMatchObject({ code: "decision_not_found" });
    await expect(
      attention.resolveDecision({
        ...base,
        expected_condition_fingerprint: "d".repeat(64),
        selected_option_id: "missing",
      }),
    ).rejects.toMatchObject({ code: "stale_decision" });
    await expect(
      attention.resolveDecision({ ...base, selected_option_id: "missing" }),
    ).rejects.toMatchObject({ code: "invalid_option" });
    await expect(
      pg.query("UPDATE decision_points SET context='tampered' WHERE id='decision-2'"),
    ).rejects.toThrow(/substantive fields are immutable/);
    await pg.query("UPDATE decision_points SET status='dismissed' WHERE id='decision-2'");
    await expect(attention.resolveDecision(base)).rejects.toMatchObject({
      code: "decision_closed",
    });
  });

  it("records proactive direction once per actor-scoped idempotency key", async () => {
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES ('user-2','other@example.com','Other','other@example.com','Other',
                'hash','scrypt-v1','member','active');
    `);
    const request = {
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      direction_target: "implementation_agent" as const,
      direction_text: "Preserve the public API while addressing the QC finding.",
      idempotency_key: "direction-1",
      now: new Date("2026-07-17T13:00:00.000Z"),
    };
    const first = await attention.recordDirection({ user_id: "user-1", ...request });
    const replay = await attention.recordDirection({ user_id: "user-1", ...request });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ memory_entry_id: first.memory_entry_id, replayed: true });
    await expect(
      attention.recordDirection({
        user_id: "user-1",
        ...request,
        direction_text: "Different content",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const otherActor = await attention.recordDirection({ user_id: "user-2", ...request });
    expect(otherActor.memory_entry_id).not.toBe(first.memory_entry_id);
    await pg.exec(`
      INSERT INTO projects (id,name,description,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref)
      VALUES ('project-2','Other','','active','assignment','verification','budget');
    `);
    await expect(
      attention.recordDirection({
        user_id: "user-1",
        ...request,
        project_id: "project-2",
        idempotency_key: "wrong-scope",
      }),
    ).rejects.toMatchObject({ code: "scope_not_found" });
    const counts = await pg.query<{ memories: number; audits: number; events: number }>(`SELECT
      (SELECT count(*)::int FROM project_memory_entries WHERE provenance='human_proactive_direction') AS memories,
      (SELECT count(*)::int FROM audit_events WHERE audit_type='human_direction_recorded') AS audits,
      (SELECT count(*)::int FROM domain_events WHERE event_type='human_direction_recorded') AS events`);
    expect(counts.rows[0]).toEqual({ memories: 2, audits: 2, events: 0 });
    await expect(
      pg.query("UPDATE human_directions SET direction_text='tampered' WHERE id=$1", [
        first.memory_entry_id.replace("memory:", ""),
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(pg.query("DELETE FROM human_directions")).rejects.toThrow(/append-only/);
    await expect(pg.exec("TRUNCATE human_directions")).rejects.toThrow(/append-only/);
    const memory = await pg.query<Record<string, unknown>>(
      `SELECT schema_version, id, project_id, phase_id, task_id, category, content,
              provenance, source_ref, confidence::float8 AS confidence, version, status,
              approved_by_human, approved_by, approved_at, supersedes_memory_entry_id,
              superseded_by_memory_entry_id, created_at
       FROM project_memory_entries WHERE id=$1`,
      [first.memory_entry_id],
    );
    const persistedMemory = memory.rows[0] as Record<string, unknown> & {
      approved_at: string | Date;
      created_at: string | Date;
    };
    const parsedMemory = V2ProjectMemoryEntry.safeParse({
      ...persistedMemory,
      approved_at: new Date(persistedMemory.approved_at).toISOString(),
      created_at: new Date(persistedMemory.created_at).toISOString(),
    });
    expect(parsedMemory.success, parsedMemory.success ? "" : parsedMemory.error.message).toBe(true);
  });

  it("rolls back the entire resolution when durable audit evidence cannot commit", async () => {
    await pg.exec(`
      INSERT INTO decision_points (
        id,project_id,scope_entity_type,scope_entity_id,reason_class,source_instance_id,
        condition_key,condition_fingerprint,question,context,options,recommendation_option_id,
        urgency,status
      ) VALUES ('decision-rollback','project-1','project','project-1','rollback','source-rb',
        'decision:rollback',repeat('f',64),'Proceed?','Context',
        '[{"id":"yes","label":"Yes"}]'::jsonb,'yes','normal','open');
      CREATE FUNCTION reject_resolution_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.audit_type = 'decision_point_resolved' THEN
          RAISE EXCEPTION 'injected audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_resolution_audit_trigger
        BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_resolution_audit();
    `);
    await expect(
      attention.resolveDecision({
        user_id: "user-1",
        project_id: "project-1",
        decision_point_id: "decision-rollback",
        idempotency_key: "rollback-key",
        expected_condition_fingerprint: "f".repeat(64),
        selected_option_id: "yes",
        rationale: "Test rollback",
        direction_target: "project_manager",
        direction_text: "Proceed",
      }),
    ).rejects.toThrow(/injected audit failure/);
    const state = await pg.query<{
      status: string;
      approvals: number;
      records: number;
      memories: number;
      events: number;
      keys: number;
    }>(`SELECT
      (SELECT status FROM decision_points WHERE id='decision-rollback') AS status,
      (SELECT count(*)::int FROM approvals WHERE subject_entity_id='decision-rollback') AS approvals,
      (SELECT count(*)::int FROM decision_records WHERE decision_point_id='decision-rollback') AS records,
      (SELECT count(*)::int FROM project_memory_entries WHERE source_ref->>'entity_id' LIKE 'decision-record:decision-rollback:%') AS memories,
      (SELECT count(*)::int FROM domain_events WHERE stream_id='decision-rollback') AS events,
      (SELECT count(*)::int FROM idempotency_records WHERE idempotency_key='rollback-key') AS keys`);
    expect(state.rows[0]).toEqual({
      status: "open",
      approvals: 0,
      records: 0,
      memories: 0,
      events: 0,
      keys: 0,
    });
  });

  it("surfaces a paused adjudication gate as a decision that outranks a same-project cadence gate", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    await seedPausedReview(pg, {
      suffix: "adjudication",
      pausedCheckpoint: "adjudication",
      pausedAtRound: 2,
      updatedAt: now.toISOString(),
      phaseId: "phase-1",
    });
    await seedPausedReview(pg, {
      suffix: "cadence",
      pausedCheckpoint: "after_revision",
      pausedAtRound: 1,
      updatedAt: now.toISOString(),
    });

    const portfolio = await attention.portfolio("user-1", { now });
    const adjudication = portfolio.items.find((item) => item.source_id === "review-adjudication");
    const cadence = portfolio.items.find((item) => item.source_id === "review-cadence");
    expect(adjudication).toMatchObject({
      source_type: "conversation_plan_review",
      kind: "decision",
      severity: "high",
      phase_id: "phase-1",
      task_id: null,
    });
    expect(cadence).toMatchObject({
      source_type: "conversation_plan_review",
      kind: "approval",
      severity: "normal",
      phase_id: null,
    });
    // Gate C (adjudication) must outrank Gate A/B (cadence) in the sorted feed.
    const adjudicationRank = portfolio.items.findIndex(
      (item) => item.source_id === "review-adjudication",
    );
    const cadenceRank = portfolio.items.findIndex((item) => item.source_id === "review-cadence");
    expect(adjudicationRank).toBeLessThan(cadenceRank);
  });

  it("escalates severity once a paused gate has sat unread past the TTL", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const stalePark = new Date(now.getTime() - QC_GATE_NUDGE_TTL_MS - 60 * 60 * 1000).toISOString();
    await seedPausedReview(pg, {
      suffix: "stale",
      pausedCheckpoint: "after_review",
      pausedAtRound: 1,
      updatedAt: stalePark,
    });

    const portfolio = await attention.portfolio("user-1", { now });
    const item = portfolio.items.find((candidate) => candidate.source_id === "review-stale");
    expect(item).toMatchObject({ kind: "approval", severity: "high" });
    expect(item?.summary).toMatch(/waiting/i);
  });

  it("does not escalate a stale-parked gate that received a recent human chat message", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const stalePark = new Date(now.getTime() - QC_GATE_NUDGE_TTL_MS - 60 * 60 * 1000).toISOString();
    const recentHumanMessage = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    await seedPausedReview(pg, {
      suffix: "answered",
      pausedCheckpoint: "after_review",
      pausedAtRound: 1,
      updatedAt: stalePark,
      chatMessages: [
        {
          id: "chat-1",
          request_id: "request-1",
          channel: "reviewer",
          round: 1,
          attempt: 1,
          speaker: "human",
          kind: "instruction",
          content: "Why is this a must-fix?",
          error_code: null,
          created_at: recentHumanMessage,
        },
      ],
    });

    const portfolio = await attention.portfolio("user-1", { now });
    const item = portfolio.items.find((candidate) => candidate.source_id === "review-answered");
    expect(item).toMatchObject({ kind: "approval", severity: "normal" });
    expect(item?.summary).not.toMatch(/waiting/i);
  });
});
