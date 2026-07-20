import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import {
  StrategyBridgeError,
  StrategyBridgeService,
} from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { hashCurrentPassword } from "../src/users/passwords.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

async function seedRelationalUser(pg: PGlite, id: string): Promise<void> {
  await pg.query(
    `INSERT INTO users (
       id, username, display_name, email, name, password_hash,
       password_hash_scheme, role, status
     ) VALUES ($1,$2,$2,$2,$2,$3,'scrypt-v1','admin','active')
     ON CONFLICT (id) DO NOTHING`,
    [id, `${id}@example.com`, await hashCurrentPassword("test-password")],
  );
}

const NOW = "2026-07-20T12:00:00.000Z";
const ACTOR = { actor_id: "admin-1" };

function planModule(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Module ${id}`,
    description: `Do the work of module ${id}.`,
    deliverables: [`Deliverable for ${id}`],
    acceptance: [
      {
        id: `${id}-ac-1`,
        statement: `Module ${id} passes its verification`,
        verification_type: "test",
        verification: `pnpm test ${id}`,
      },
    ],
    estimated_complexity: "M",
    risk: "medium",
    ...extra,
  };
}

function plan() {
  return {
    objective: "Ship the front door end to end",
    assumptions: ["The relational runtime is available"],
    modules: [planModule("mod-a"), planModule("mod-b", { dependencies: ["mod-a"] })],
    risks: [{ description: "Scope creep", mitigation: "Freeze the plan" }],
    out_of_scope: ["Full reskin"],
  };
}

function staffingProposal() {
  return {
    summary: "Cross-provider staffing for two modules.",
    recommendations: [
      {
        node_id: "mod-a",
        provider: "anthropic",
        model: "claude-sonnet-x",
        worker_count: 1,
        reviewer_model: "gpt-review-x",
        budget_usd: 12,
        rationale: "Module A is medium complexity; Claude implements, GPT reviews.",
      },
      {
        node_id: "mod-b",
        provider: "openai",
        model: "gpt-impl-x",
        worker_count: 1,
        reviewer_model: "claude-review-x",
        budget_usd: 8,
        rationale: "Module B is medium complexity; GPT implements, Claude reviews.",
      },
    ],
  };
}

function transcript(finalReview: { must_fix: number; should_fix: number; suggestion: number }) {
  return [
    {
      round: 1,
      role: "pm",
      provider: "anthropic",
      model: "claude-sonnet-x",
      summary: "Drafted the plan.",
      finding_counts: null,
    },
    {
      round: 1,
      role: "reviewer",
      provider: "openai",
      model: "gpt-review-x",
      summary: "Reviewed the plan.",
      finding_counts: finalReview,
    },
  ];
}

async function seedPlanningRun(
  pg: PGlite,
  options: {
    id: string;
    status: "converged" | "cap_reached" | "queued";
    result: unknown | null;
    transcript: unknown[];
    round?: number;
  },
): Promise<void> {
  await pg.query(
    `INSERT INTO planning_runs (
       id, project_id, status, round, max_rounds, objective, transcript, result, total_cost_usd
     ) VALUES ($1,'project-1',$2,$3,3,'Ship the front door',$4::jsonb,$5,0.5)`,
    [
      options.id,
      options.status,
      options.round ?? 1,
      JSON.stringify(options.transcript),
      options.result === null ? null : JSON.stringify(options.result),
    ],
  );
}

async function seedProjectAndUser(pg: PGlite): Promise<void> {
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
     ) VALUES ('project-1','Project One','','active','assignment','verification','budget')`,
  );
}

function convergedResult() {
  return {
    plan: plan(),
    content_hash: "a".repeat(64),
    total_cost_usd: 0.5,
    staffing_proposal: staffingProposal(),
  };
}

describe.sequential("FRONT DOOR P3 strategy bridge (service)", () => {
  let pg: PGlite;
  let bridge: StrategyBridgeService;

  beforeEach(async () => {
    pg = new PGlite();
    await seedProjectAndUser(pg);
    await seedRelationalUser(pg, ACTOR.actor_id);
    const transactions = new PGliteTransactionRunner(pg);
    bridge = new StrategyBridgeService({
      transactions,
      phases: new PhaseWorkflowService(transactions),
      strategies: new StrategyWorkflowService(transactions),
      now: () => new Date(NOW),
    });
  });

  afterEach(async () => {
    await pg.close();
  });

  it("materializes a converged run into an editable, staffed, approvable phase", async () => {
    await seedPlanningRun(pg, {
      id: "run-1",
      status: "converged",
      result: convergedResult(),
      transcript: transcript({ must_fix: 0, should_fix: 1, suggestion: 0 }),
    });

    const review = await bridge.createPhaseFromPlanningRun({
      projectId: "project-1",
      planningRunId: "run-1",
      actor: ACTOR,
    });

    // Phase + proposed strategy exist; rounds outcome is carried through.
    expect(review.phase.status).toBe("awaiting_approval");
    expect(review.rounds).toMatchObject({ planning_run_id: "run-1", status: "converged" });
    expect(review.strategy?.status).toBe("awaiting_approval");
    expect(review.strategy?.convergence).toBe("converged");
    expect(review.strategy?.tasks).toHaveLength(2);
    expect(review.strategy?.objectives).toHaveLength(1);

    // Staffing table maps recommendations -> provider/model/reviewer/budget.
    const staffingByTask = new Map(
      (review.strategy?.staffing ?? []).map((entry) => [entry.task_local_id, entry]),
    );
    expect(staffingByTask.get("task-mod-a")).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-x",
      reviewer_provider: "openai",
      reviewer_model: "gpt-review-x",
      budget_limit_usd: 12,
    });
    expect(staffingByTask.get("task-mod-b")).toMatchObject({
      provider: "openai",
      model: "gpt-impl-x",
      reviewer_provider: "anthropic",
      reviewer_model: "claude-review-x",
      budget_limit_usd: 8,
    });

    // Task dependency mod-b -> mod-a is preserved.
    const taskB = review.strategy?.tasks.find((task) => task.local_id === "task-mod-b");
    expect(taskB?.dependency_local_ids).toEqual(["task-mod-a"]);

    // AgentProfiles were resolved/created for every provider/model pair.
    const profiles = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM agent_profiles",
    );
    expect(profiles.rows[0]?.count).toBe(4);

    // Edit staffing: change provider/model/budget of mod-a.
    const edited = await bridge.editStaffing({
      projectId: "project-1",
      phaseId: review.phase.id,
      edits: [
        {
          assignment_id: "assignment-mod-a",
          provider: "openai",
          model: "gpt-impl-x",
          budget_limit_usd: 25,
        },
      ],
      actor: ACTOR,
    });
    const editedA = edited.strategy?.staffing.find((e) => e.task_local_id === "task-mod-a");
    expect(editedA).toMatchObject({
      provider: "openai",
      model: "gpt-impl-x",
      budget_limit_usd: 25,
    });
    expect(edited.strategy?.version).toBe(2);

    // Approve the edited strategy -> materialization.
    const approved = await bridge.approve({
      projectId: "project-1",
      phaseId: review.phase.id,
      actor: ACTOR,
    });
    expect(approved).toMatchObject({ objectives: 1, tasks: 2 });

    // Coordinator-visible state: phase approved, tasks pending, assignments live.
    const state = await pg.query<{
      phase_status: string;
      tasks: number;
      pending_tasks: number;
      assignments: number;
      deps: number;
    }>(
      `SELECT p.status AS phase_status,
              (SELECT count(*)::int FROM tasks WHERE phase_id = p.id) AS tasks,
              (SELECT count(*)::int FROM tasks WHERE phase_id = p.id AND state = 'pending') AS pending_tasks,
              (SELECT count(*)::int FROM agent_assignments WHERE phase_id = p.id) AS assignments,
              (SELECT count(*)::int FROM task_dependencies WHERE phase_id = p.id) AS deps
       FROM phases p WHERE p.id = $1`,
      [review.phase.id],
    );
    expect(state.rows[0]).toEqual({
      phase_status: "approved",
      tasks: 2,
      pending_tasks: 2,
      assignments: 2,
      deps: 1,
    });
  });

  it("is idempotent per planning run (same run twice => one phase)", async () => {
    await seedPlanningRun(pg, {
      id: "run-1",
      status: "converged",
      result: convergedResult(),
      transcript: transcript({ must_fix: 0, should_fix: 0, suggestion: 0 }),
    });
    const first = await bridge.createPhaseFromPlanningRun({
      projectId: "project-1",
      planningRunId: "run-1",
      actor: ACTOR,
    });
    const second = await bridge.createPhaseFromPlanningRun({
      projectId: "project-1",
      planningRunId: "run-1",
      actor: ACTOR,
    });
    expect(second.phase.id).toBe(first.phase.id);
    const counts = await pg.query<{ phases: number; strategies: number }>(
      `SELECT (SELECT count(*)::int FROM phases WHERE planning_run_id = 'run-1') AS phases,
              (SELECT count(*)::int FROM strategy_versions) AS strategies`,
    );
    expect(counts.rows[0]).toEqual({ phases: 1, strategies: 1 });
  });

  it("carries outstanding findings for a cap_reached run and blocks approval", async () => {
    await seedPlanningRun(pg, {
      id: "run-cap",
      status: "cap_reached",
      result: convergedResult(),
      transcript: transcript({ must_fix: 2, should_fix: 1, suggestion: 0 }),
      round: 3,
    });
    const review = await bridge.createPhaseFromPlanningRun({
      projectId: "project-1",
      planningRunId: "run-cap",
      actor: ACTOR,
    });
    expect(review.strategy?.convergence).toBe("cap_reached");
    expect(review.outstanding_findings).toHaveLength(1);
    expect(review.outstanding_findings[0]).toMatchObject({ severity: "must_fix", status: "open" });

    // The existing approval invariant refuses a non-converged strategy.
    await expect(
      bridge.approve({ projectId: "project-1", phaseId: review.phase.id, actor: ACTOR }),
    ).rejects.toThrow();
  });

  it("follows staleness semantics on a post-approval edit (no silent mutation)", async () => {
    await seedPlanningRun(pg, {
      id: "run-1",
      status: "converged",
      result: convergedResult(),
      transcript: transcript({ must_fix: 0, should_fix: 0, suggestion: 0 }),
    });
    const review = await bridge.createPhaseFromPlanningRun({
      projectId: "project-1",
      planningRunId: "run-1",
      actor: ACTOR,
    });
    await bridge.approve({ projectId: "project-1", phaseId: review.phase.id, actor: ACTOR });

    // Editing after approval mints a superseding awaiting_approval version and
    // leaves the approved version untouched.
    const edited = await bridge.editStaffing({
      projectId: "project-1",
      phaseId: review.phase.id,
      edits: [{ assignment_id: "assignment-mod-a", budget_limit_usd: 99 }],
      actor: ACTOR,
    });
    expect(edited.strategy?.version).toBe(2);
    expect(edited.strategy?.status).toBe("awaiting_approval");
    expect(edited.phase.status).toBe("awaiting_approval");

    const versions = await pg.query<{ version: number; status: string }>(
      "SELECT version, status FROM strategy_versions ORDER BY version",
    );
    expect(versions.rows).toEqual([
      { version: 1, status: "approved" },
      { version: 2, status: "awaiting_approval" },
    ]);
  });

  it("rejects a planning run that is not converged/cap_reached", async () => {
    await seedPlanningRun(pg, {
      id: "run-q",
      status: "queued",
      result: null,
      transcript: [],
      round: 0,
    });
    await expect(
      bridge.createPhaseFromPlanningRun({
        projectId: "project-1",
        planningRunId: "run-q",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(StrategyBridgeError);
  });
});

describe.sequential("FRONT DOOR P3 strategy bridge (HTTP)", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;

  beforeEach(async () => {
    pg = new PGlite();
    await seedProjectAndUser(pg);
    await seedPlanningRun(pg, {
      id: "run-1",
      status: "converged",
      result: convergedResult(),
      transcript: transcript({ must_fix: 0, should_fix: 0, suggestion: 0 }),
    });
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    // The approving actor is the authenticated session user; its id must exist
    // in the relational users table for the approval foreign key.
    await seedRelationalUser(pg, users.userForToken(token)?.id ?? "");
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase3: {
        sourceBindings: new SourceBindingService(transactions),
        ingestion: new RepositoryIngestionService(transactions),
        phases: new PhaseWorkflowService(transactions),
        strategies: new StrategyWorkflowService(transactions),
        bridge: new StrategyBridgeService({
          transactions,
          phases: new PhaseWorkflowService(transactions),
          strategies: new StrategyWorkflowService(transactions),
        }),
        resume: new ProjectResumeService(transactions),
      },
    });
  });

  afterEach(async () => {
    await server.app.close();
    await pg.close();
  });

  it("requires a session on every bridge route", async () => {
    const routes: [string, string][] = [
      ["POST", "/api/v2/projects/project-1/phases"],
      ["GET", "/api/v2/projects/project-1/phases/phase-x/strategy"],
      ["PATCH", "/api/v2/projects/project-1/phases/phase-x/strategy/staffing"],
      ["POST", "/api/v2/projects/project-1/phases/phase-x/strategy/approve"],
    ];
    for (const [method, url] of routes) {
      const res = await server.app.inject({ method: method as "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("creates a phase from a planning run and is idempotent over HTTP", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const first = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/phases",
      headers,
      payload: { planning_run_id: "run-1", name: "Front door phase" },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody.phase.status).toBe("awaiting_approval");
    expect(firstBody.phase.objective_summary).toBe("Front door phase");

    const second = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/phases",
      headers,
      payload: { planning_run_id: "run-1" },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().phase.id).toBe(firstBody.phase.id);

    // GET review DTO, then approve via the bridge route.
    const phaseId = firstBody.phase.id;
    const review = await server.app.inject({
      method: "GET",
      url: `/api/v2/projects/project-1/phases/${phaseId}/strategy`,
      headers,
    });
    expect(review.statusCode).toBe(200);
    const contentHash = review.json().strategy.content_hash;

    const approve = await server.app.inject({
      method: "POST",
      url: `/api/v2/projects/project-1/phases/${phaseId}/strategy/approve`,
      headers,
      payload: { expected_content_hash: contentHash },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ tasks: 2, objectives: 1 });
  });

  it("keeps the pre-existing raw create-phase route working", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/phases",
      headers,
      payload: {
        objective_summary: "Raw phase",
        priority: 1,
        predecessor_phase_ids: [],
        expected_project_version: 1,
        idempotency_key: "raw-phase-1",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ objective_summary: "Raw phase", status: "proposed" });
  });

  it("returns 400 for a staffing edit against a missing body", async () => {
    const headers = { authorization: `Bearer ${token}` };
    const res = await server.app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/phases/phase-x/strategy/staffing",
      headers,
      payload: { assignments: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
