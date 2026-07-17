import { PGlite } from "@electric-sql/pglite";
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
});
