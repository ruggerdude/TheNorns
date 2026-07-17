import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  PhaseWorkflowConflictError,
  PhaseWorkflowService,
} from "../src/projects/phaseWorkflowService.js";

describe.sequential("Phase 3 persistent phase workflow", () => {
  let pg: PGlite;
  let service: PhaseWorkflowService;

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
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref
       ) VALUES ('project-1','Project One','','active','assignment',
                 'verification','budget')`,
    );
    service = new PhaseWorkflowService(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  it("creates a durable proposed phase and replays without rebuilding project history", async () => {
    const command = {
      schema_version: 2 as const,
      command_id: "command-create-animation-phase",
      kind: "create_phase" as const,
      command_family: "phase" as const,
      actor: { actor_type: "human" as const, actor_id: "admin-1" },
      idempotency_key: "create-animations-1",
      correlation_id: "correlation-1",
      causation_id: null,
      issued_at: "2026-07-16T19:20:00.000Z",
      project_id: "project-1",
      objective_summary: "Add polished interface animations",
      priority: 10,
      predecessor_phase_ids: [],
      expected_project_version: 1,
    };

    const phase = await service.create(command);
    const replay = await service.create(command);
    expect(replay).toEqual(phase);
    expect(phase).toMatchObject({
      project_id: "project-1",
      objective_summary: "Add polished interface animations",
      status: "proposed",
      approved_strategy_version_id: null,
      aggregate_version: 1,
    });
    const counts = await pg.query<{ phases: number; events: number; project_version: number }>(
      `SELECT (SELECT count(*)::int FROM phases) AS phases,
              (SELECT count(*)::int FROM domain_events WHERE event_type = 'phase.created') AS events,
              aggregate_version AS project_version
       FROM projects WHERE id = 'project-1'`,
    );
    expect(counts.rows[0]).toEqual({ phases: 1, events: 1, project_version: 2 });
  });

  it("rejects stale project versions without leaving partial phase state", async () => {
    await expect(
      service.create({
        schema_version: 2,
        command_id: "command-stale",
        kind: "create_phase",
        command_family: "phase",
        actor: { actor_type: "human", actor_id: "admin-1" },
        idempotency_key: "stale",
        correlation_id: "correlation-stale",
        causation_id: null,
        issued_at: "2026-07-16T19:20:00.000Z",
        project_id: "project-1",
        objective_summary: "Stale phase",
        priority: 1,
        predecessor_phase_ids: [],
        expected_project_version: 9,
      }),
    ).rejects.toBeInstanceOf(PhaseWorkflowConflictError);
    expect((await pg.query("SELECT id FROM phases")).rows).toHaveLength(0);
  });
});
