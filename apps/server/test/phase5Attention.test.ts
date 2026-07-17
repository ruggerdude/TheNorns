import { PGlite } from "@electric-sql/pglite";
import { V2AuditEvent, V2DomainEvent, V2ProjectMemoryEntry } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AttentionService } from "../src/projects/attentionService.js";

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
});
