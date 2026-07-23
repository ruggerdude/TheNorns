// PHASE TAB P4: approve in the Phase tab auto-starts execution.
//
// The real `ApprovedPlanExecutionKickoff` (planning/executionKickoff.ts) is
// exercised here end to end over HTTP with NO doubles anywhere in the chain:
// a real planning run converges (FakeAdapter-scripted, like the P1 suite),
// the approve decision drives the REAL StrategyBridgeService -> REAL strategy
// approval -> REAL PhaseLaunchService -> REAL Phase4Coordinator gate against
// PGlite, and the assertions read the same repositories/status the existing
// phase-execution tests read (phases.status, dispatch_jobs, commands,
// approvals). The final describe boots buildServer with the production option
// shape main.ts now supplies — including the real kickoff, not a double —
// because an unwired option has shipped dead three times in this repo.
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase4RecoveryMonitor } from "../src/coordinator/phase4RecoveryMonitor.js";
import { PhaseLaunchService } from "../src/coordinator/phaseLaunchService.js";
import { RelationalTaskContextAssembler, TaskContextStore } from "../src/execution/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ExecutionKickoffService } from "../src/planning/executionKickoff.js";
import { AttentionService } from "../src/projects/attentionService.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

const RUNNER = "runner-p4";
const BINDING = "binding-p4";

function plan(moduleIds: string[]) {
  return {
    objective: "build the demo service",
    modules: moduleIds.map((id) => ({
      id,
      title: `Module ${id}`,
      description: `Implements ${id}`,
      deliverables: [`src/${id}.ts`],
      acceptance: [
        {
          id: "AC-1",
          statement: "tests pass",
          verification_type: "command",
          verification: "pnpm test",
        },
      ],
      dependencies: [],
      estimated_complexity: "M",
      risk: "low",
    })),
  };
}

/** A staffing recommendation the worker persists into result.staffing_proposal
 *  — this is the fallback staffing for nodes without human overrides, and the
 *  source of the real (non-zero) task budget. */
function allocation() {
  return {
    summary: "Staff the api node.",
    recommendations: [
      {
        node_id: "api",
        provider: "anthropic",
        model: "claude-sonnet-5",
        worker_count: 1,
        reviewer_model: "gpt-5.6-terra",
        budget_usd: 25,
        rationale: "Single accountable worker.",
      },
    ],
  };
}

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
}

describe.sequential("phase tab P4: approve auto-starts execution (HTTP, real chain)", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let server: NornsServer;
  let token: string;
  let adminId: string;
  let projectId: string;
  let pmAdapter: FakeAdapter;
  let reviewerAdapter: FakeAdapter;

  async function inject(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<InjectedResponse> {
    const response = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return response as unknown as InjectedResponse;
  }

  async function pollUntil(
    runId: string,
    predicate: (run: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const res = await inject("GET", `/api/v2/projects/${projectId}/planning-runs/${runId}`);
      const run = res.json() as Record<string, unknown>;
      if (predicate(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("planning run never reached the expected state");
  }

  /** Everything execution needs that planning does not create: the connected
   *  local-runner binding, the architecture revision, and the repository
   *  facts (verification commands) EXECUTION E1's assembler requires. Same
   *  seed the PhaseLaunchService suite uses. */
  async function seedExecutionEnvironment(): Promise<void> {
    await pg.query(
      `INSERT INTO repository_bindings (
         id, project_id, binding_type, status, runner_id, workspace_id,
         repository_id, repository_display_name, granted_permissions,
         default_branch, observed_head, verification_policy_ref,
         repository_health, created_by_actor_type, created_by_actor_id
       ) VALUES ($1,$2,'local_runner','connected',$3,'workspace-p4','repository-p4','P4 Demo',
         '{}'::jsonb,'main','commit-p4','verification/strict','healthy','human',$4)`,
      [BINDING, projectId, RUNNER, adminId],
    );
    await pg.query("UPDATE projects SET primary_repository_binding_id = $1 WHERE id = $2", [
      BINDING,
      projectId,
    ]);
    await pg.query(
      `INSERT INTO artifacts (
         id, project_id, kind, label, media_type, storage_ref, content_hash, byte_size,
         provenance_actor_type, provenance_actor_id, redaction_status
       ) VALUES ('artifact-p4',$1,'architecture','Repository architecture','text/markdown',
                 'https://example.com/arch',$2,10,'human',$3,'reviewed')`,
      [projectId, "c".repeat(64), adminId],
    );
    await pg.query(
      `INSERT INTO architecture_revisions (
         id, project_id, revision, title, summary, architecture_artifact_id,
         repository_revision, provenance_actor_type, provenance_actor_id
       ) VALUES ('architecture-p4',$1,1,'Monorepo','pnpm workspace.','artifact-p4','abc123','human',$2)`,
      [projectId, adminId],
    );
    await pg.query("UPDATE projects SET current_architecture_revision_id = $1 WHERE id = $2", [
      "architecture-p4",
      projectId,
    ]);
    const facts: Array<[string, string, number]> = [
      ["package_manager", "pnpm", 0.8],
      ["build_command", "pnpm run build", 0.99],
      ["test_command", "pnpm test", 0.99],
      ["lint_command", "pnpm biome check .", 0.9],
    ];
    for (const [key, value, confidence] of facts) {
      await pg.query(
        `INSERT INTO project_memory_entries (
           id, project_id, category, content, provenance, confidence, version, status, created_at
         ) VALUES ($1,$2,'repository_fact',$3,'repository_ingestion',$4,1,'active','2026-01-01T00:00:00Z')`,
        [`memory-fact-${key}-p4`, projectId, `${key}: ${value}`, confidence],
      );
    }
  }

  async function createConvergedRun(): Promise<string> {
    pmAdapter.enqueue(plan(["api"]));
    reviewerAdapter.enqueue({ findings: [] });
    // Third PM turn: the worker's buildStaffingProposal (allocation
    // recommendation) — persisted as result.staffing_proposal.
    pmAdapter.enqueue(allocation());
    const created = await inject("POST", `/api/v2/projects/${projectId}/planning-runs`, {
      objective: "do the thing",
    });
    expect(created.statusCode).toBe(202);
    const { planning_run_id: runId } = created.json() as { planning_run_id: string };
    await pollUntil(runId, (run) => run.status === "converged");
    return runId;
  }

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    transactions = new PGliteTransactionRunner(pg);

    const projects = new ProjectStore();
    projectId = projects.create({
      name: "P4 project",
      description: "phase tab P4",
      pmProvider: "anthropic",
    }).id;

    const users = new UserStore();
    const admin = users.createActive({
      email: "p4-admin@example.com",
      password: "test-password-1",
      role: "admin",
    });
    adminId = admin.id;
    token = users.login("p4-admin@example.com", "test-password-1").token;

    // The deciding user must exist relationally: the kickoff's strategy
    // approval writes approvals.actor_id, which carries an FK to users.
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status
       ) VALUES ($1,'p4-admin@example.com','P4 Admin','p4-admin@example.com','P4 Admin','x',
                 'scrypt-v1','admin','active')`,
      [adminId],
    );
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref
       ) VALUES ($1,'P4 project','phase tab P4','active','assignment/default',
                 'verification/default','budget/default')`,
      [projectId],
    );

    const stores = new RelayStores();
    stores.registerRunner(RUNNER, "test-public-key-pem");

    // The kickoff chain, constructed the way main.ts constructs it — real
    // bridge, real workflow services, real launcher over the real gate.
    const phaseWorkflow = new PhaseWorkflowService(transactions);
    const strategyWorkflow = new StrategyWorkflowService(transactions);
    const bridge = new StrategyBridgeService({
      transactions,
      phases: phaseWorkflow,
      strategies: strategyWorkflow,
    });
    const phaseLaunch = new PhaseLaunchService(
      transactions,
      new Phase4Coordinator(transactions),
      new RelationalTaskContextAssembler(transactions, new TaskContextStore(transactions), {
        baseUrl: "https://norns.example.com",
      }),
      new DispatchContextScopeRepository(transactions),
      (runnerId) => {
        const runner = stores.runner(runnerId);
        return runner
          ? { runner_id: runner.runner_id, runner_generation: runner.generation }
          : null;
      },
      undefined,
    );
    const executionKickoff = new ExecutionKickoffService({
      transactions,
      bridge,
      phaseLaunch,
    });

    pmAdapter = new FakeAdapter("anthropic");
    reviewerAdapter = new FakeAdapter("openai");
    server = await buildServer({
      stores,
      users,
      projects,
      planningRuns: { transactions, executionKickoff },
      phase5: { attention: new AttentionService(transactions) },
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "test-anthropic",
        OPENAI_API_KEY: "test-openai",
        // The allocation-recommendation catalog only marks models available
        // when they are allow-listed for the deployment; without this the
        // worker's buildStaffingProposal fails and staffing_proposal is null.
        NORNS_DEBATE_ALLOWED_MODELS:
          "anthropic/claude-sonnet-5,anthropic/claude-opus-4-8,openai/gpt-5.6-terra",
      },
      createPlanningAdapter: (provider: ProviderName): LlmAdapter =>
        provider === "anthropic" ? pmAdapter : reviewerAdapter,
    });
  }, 30_000);

  afterEach(async () => {
    await server.app.close();
    if (!pg.closed) await pg.close();
  });

  it("approve over HTTP materializes, approves, and actually launches the phase", async () => {
    await seedExecutionEnvironment();
    const runId = await createConvergedRun();

    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "approve" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "approved" });
    const execution = body.execution as { started: boolean; detail: string };
    expect(execution.started).toBe(true);
    expect(execution.detail).toMatch(/Started phase/);
    expect(execution.detail).toMatch(/1 task\(s\) dispatched/);

    // The phase bound to this run is genuinely executing — same status and
    // repositories the existing phase-execution tests assert against.
    const phase = await pg.query<{
      id: string;
      status: string;
      planning_run_id: string;
      approved_strategy_version_id: string | null;
      approved_budget_usd: string | number;
    }>(
      "SELECT id, status, planning_run_id, approved_strategy_version_id, approved_budget_usd FROM phases WHERE project_id = $1",
      [projectId],
    );
    expect(phase.rows).toHaveLength(1);
    expect(phase.rows[0]).toMatchObject({ status: "active", planning_run_id: runId });
    expect(phase.rows[0]?.approved_strategy_version_id).toBeTruthy();
    expect(Number(phase.rows[0]?.approved_budget_usd)).toBe(25);

    const dispatch = await pg.query<{ status: string; runner_id: string }>(
      "SELECT status, runner_id FROM dispatch_jobs",
    );
    expect(dispatch.rows).toEqual([{ status: "queued", runner_id: RUNNER }]);

    // Real assembled context reached the dispatch command.
    const command = await pg.query<{ envelope: { context_refs: unknown[] } }>(
      "SELECT envelope FROM commands WHERE dispatch_job_id IS NOT NULL",
    );
    expect(command.rows).toHaveLength(1);
    expect((command.rows[0]?.envelope.context_refs ?? []).length).toBeGreaterThan(0);

    // The strategy approval originates from the planning-run decision: its
    // actor is the deciding human and its approved_at is the decision's
    // decided_at.
    const decidedAt = (body.decision as { decided_at: string }).decided_at;
    const approval = await pg.query<{ actor_id: string; approved_at: Date | string }>(
      "SELECT actor_id, approved_at FROM approvals WHERE project_id = $1",
      [projectId],
    );
    expect(approval.rows).toHaveLength(1);
    expect(approval.rows[0]?.actor_id).toBe(adminId);
    expect(new Date(approval.rows[0]?.approved_at ?? 0).toISOString()).toBe(decidedAt);
  });

  it("applies the decision's staffing overrides to the created assignments", async () => {
    await seedExecutionEnvironment();
    const runId = await createConvergedRun();

    // The recommendation staffed claude-sonnet-5; the human overrides to
    // claude-opus-4-8 at approval time.
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      {
        decision: "approve",
        staffing: [{ node_id: "api", provider: "anthropic", model: "claude-opus-4-8" }],
      },
    );
    expect(res.statusCode).toBe(200);
    const execution = (res.json() as Record<string, unknown>).execution as {
      started: boolean;
      detail: string;
    };
    expect(execution.started).toBe(true);

    // The created assignment is staffed with the override's model — and the
    // recommendation's budget survives the override (a provider/model edit
    // does not zero the budget).
    const assignment = await pg.query<{ model: string; budget_limit_usd: string | number }>(
      `SELECT profile.model, a.budget_limit_usd
         FROM agent_assignments a
         JOIN agent_profiles profile ON profile.id = a.agent_profile_id
        WHERE a.project_id = $1`,
      [projectId],
    );
    expect(assignment.rows).toHaveLength(1);
    expect(assignment.rows[0]?.model).toBe("claude-opus-4-8");
    expect(Number(assignment.rows[0]?.budget_limit_usd)).toBe(25);

    // The override was applied as a superseding strategy version (v2), and
    // v2 is what got approved.
    const versions = await pg.query<{ version: number; status: string }>(
      "SELECT version, status FROM strategy_versions WHERE project_id = $1 ORDER BY version",
      [projectId],
    );
    expect(versions.rows).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "approved" },
    ]);
  });

  it("refuses when a phase is already executing — approval recorded, nothing mutated", async () => {
    await seedExecutionEnvironment();
    // Another phase in this project is already active (the repo default is
    // one executing phase per project).
    await pg.query(
      `INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
       VALUES ('phase-busy',$1,'Already running',0,'approved',50)`,
      [projectId],
    );
    await pg.query(
      `INSERT INTO strategy_versions (
         id, project_id, phase_id, version, status, objective, content, convergence, content_hash
       ) VALUES ('strategy-busy',$1,'phase-busy',1,'approved','Busy','{}'::jsonb,'converged',$2)`,
      [projectId, "d".repeat(64)],
    );
    await pg.query(
      "UPDATE phases SET status = 'active', approved_strategy_version_id = 'strategy-busy' WHERE id = 'phase-busy'",
    );

    const runId = await createConvergedRun();
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "approve" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // The approval itself is recorded and never thrown away.
    expect(body).toMatchObject({ status: "approved" });
    expect(body.decision).toMatchObject({ decision: "approve" });
    const execution = body.execution as { started: boolean; detail: string };
    expect(execution.started).toBe(false);
    expect(execution.detail).toMatch(/already executing/);
    expect(execution.detail).toMatch(/one phase at a time/);

    // Refused BEFORE any mutation: no second phase was materialized, nothing
    // was dispatched, no strategy approval was recorded.
    const phases = await pg.query<{ id: string }>("SELECT id FROM phases WHERE project_id = $1", [
      projectId,
    ]);
    expect(phases.rows).toEqual([{ id: "phase-busy" }]);
    const dispatch = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM dispatch_jobs",
    );
    expect(Number(dispatch.rows[0]?.count)).toBe(0);
    const approvals = await pg.query<{ count: string }>("SELECT count(*) AS count FROM approvals");
    expect(Number(approvals.rows[0]?.count)).toBe(0);
  });

  it("refuses a staffing override for a node the plan does not contain — approval still recorded", async () => {
    await seedExecutionEnvironment();
    const runId = await createConvergedRun();
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      {
        decision: "approve",
        staffing: [{ node_id: "ghost", provider: "anthropic", model: "claude-sonnet-5" }],
      },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "approved" });
    const execution = body.execution as { started: boolean; detail: string };
    expect(execution.started).toBe(false);
    expect(execution.detail).toMatch(/unknown plan node "ghost"/);

    // Nothing launched: the strategy is still awaiting approval and no
    // dispatch happened.
    const strategy = await pg.query<{ status: string }>(
      "SELECT status FROM strategy_versions WHERE project_id = $1",
      [projectId],
    );
    expect(strategy.rows).toEqual([{ status: "awaiting_approval" }]);
    const dispatch = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM dispatch_jobs",
    );
    expect(Number(dispatch.rows[0]?.count)).toBe(0);
  });
});

describe.sequential("phase tab P4: buildServer boots with the production option shape", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let server: NornsServer;
  let token: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    transactions = new PGliteTransactionRunner(pg);

    const users = new UserStore();
    users.createActive({
      email: "boot-admin@example.com",
      password: "test-password-1",
      role: "admin",
    });
    token = users.login("boot-admin@example.com", "test-password-1").token;
    const stores = new RelayStores();

    // EXACTLY main.ts's assembly for the kickoff (see the planningRuns block
    // there): bridge from phase3Services, PhaseLaunchService over the phase4
    // coordinator + a fresh assembler/scope repository over the same
    // transactions, runner resolution against the live RelayStores. GitHub is
    // not configured on this deployment, so actionsExecution is absent —
    // exactly like a production boot without GitHub credentials.
    const phaseWorkflow = new PhaseWorkflowService(transactions);
    const strategyWorkflow = new StrategyWorkflowService(transactions);
    const bridge = new StrategyBridgeService({
      transactions,
      phases: phaseWorkflow,
      strategies: strategyWorkflow,
    });
    const phase4 = {
      coordinator: new Phase4Coordinator(transactions),
      completion: new Phase4CompletionService(transactions),
      dispatch: new Phase4DispatchRepository(transactions),
      events: new Phase4EventProcessor(transactions),
      recovery: new Phase4RecoveryMonitor(transactions),
    };
    const kickoffPhaseLaunch = new PhaseLaunchService(
      transactions,
      phase4.coordinator,
      new RelationalTaskContextAssembler(transactions, new TaskContextStore(transactions), {
        baseUrl: "https://norns.example.com",
      }),
      new DispatchContextScopeRepository(transactions),
      (runnerId) => {
        const runner = stores.runner(runnerId);
        return runner
          ? { runner_id: runner.runner_id, runner_generation: runner.generation }
          : null;
      },
      undefined,
    );

    server = await buildServer({
      stores,
      users,
      projects: new ProjectStore(),
      phase3: {
        sourceBindings: new SourceBindingService(transactions),
        ingestion: new RepositoryIngestionService(transactions),
        phases: phaseWorkflow,
        strategies: strategyWorkflow,
        bridge,
        resume: new ProjectResumeService(transactions),
      },
      phase4,
      phase5: { attention: new AttentionService(transactions) },
      planningRuns: {
        transactions,
        executionKickoff: new ExecutionKickoffService({
          transactions,
          bridge,
          phaseLaunch: kickoffPhaseLaunch,
        }),
      },
      attachments: { transactions },
      onboarding: { transactions },
      execution: { transactions, baseUrl: "https://norns.example.com" },
      runnerInference: { transactions },
      integrations: { github: null },
    });
  }, 30_000);

  afterEach(async () => {
    // Same courtesy delay executionBootWiring uses: a phase4 dispatcher tick
    // in flight at close time may still be awaiting a query on this pg.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server?.app.close();
    if (!pg.closed) await pg.close();
  });

  it("mounts the decision route (the seam's caller) — 401 unauthenticated, not 404", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/proj-1/planning-runs/run-1/decision",
    });
    expect(response.statusCode).toBe(401);
  });

  it("an authenticated decision reaches the real planning-run service (404 for an unknown run)", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/proj-1/planning-runs/run-1/decision",
      headers: { authorization: `Bearer ${token}` },
      payload: { decision: "approve" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("mounts the start-phase trigger the kickoff's launcher parallels (phase4 + execution wired)", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v2/projects/proj-1/phases/phase-1/start",
    });
    expect(response.statusCode).toBe(401);
  });
});
