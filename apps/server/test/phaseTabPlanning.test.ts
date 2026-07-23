// PHASE TAB P1: per-run review rounds, worker-provider constraints, the human
// decision workflow (approve / modify / reject), and the project-level
// execution-status view. Service/worker behavior is driven against PGlite with
// the real runPlanning() loop (FakeAdapter-scripted); the HTTP surface is
// exercised through buildServer with the same production option shape main.ts
// supplies (planningRuns: { transactions }).
import { PGlite } from "@electric-sql/pglite";
import {
  FakeAdapter,
  type LlmAdapter,
  type ProviderName,
  buildSelectableModelCatalog,
} from "@norns/adapters";
import { PlanContract } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowGraph } from "../src/graph/graph.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { recommendProjectAllocation } from "../src/planning/allocationRecommendation.js";
import {
  PlanningRunDecisionError,
  PlanningRunService,
  type PlanningStaffingProposalDto,
} from "../src/planning/runService.js";
import {
  PlanningRunWorker,
  type PlanningRunWorkerOptions,
  type PlanningStaffingInput,
  type ResolvedPlanningModels,
} from "../src/planning/runWorker.js";
import { AttentionService } from "../src/projects/attentionService.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

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

describe.sequential("phase tab: planning run decisions (service + worker)", () => {
  let pg: PGlite;
  let service: PlanningRunService;
  let pm: FakeAdapter;
  let reviewer: FakeAdapter;
  let models: ResolvedPlanningModels;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1', 'Planning project', 'active', 'assignment/default', 'verification/default', 'budget/default');
    `);
    service = new PlanningRunService(new PGliteTransactionRunner(pg));
    pm = new FakeAdapter("anthropic");
    reviewer = new FakeAdapter("openai");
    models = {
      pm: { provider: pm.provider, model: pm.model },
      reviewer: { provider: reviewer.provider, model: reviewer.model },
    };
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  function makeWorker(overrides: Partial<PlanningRunWorkerOptions> = {}) {
    const createAdapter = (provider: ProviderName): LlmAdapter =>
      provider === "anthropic" ? pm : reviewer;
    return new PlanningRunWorker(new PGliteTransactionRunner(pg), createAdapter, {
      resolveModels: async () => models,
      ...overrides,
    });
  }

  async function convergeRun(options: { maxRounds?: number } = {}): Promise<string> {
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });
    const created = await service.create("project-1", {
      objective: "objective",
      ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
    });
    await makeWorker().runNow(created.id);
    const run = await service.get("project-1", created.id);
    expect(run.status).toBe("converged");
    return created.id;
  }

  it("persists review rounds and worker providers and exposes them in the DTO", async () => {
    const created = await service.create("project-1", {
      objective: "objective",
      maxRounds: 4,
      workerProviders: "anthropic",
    });
    expect(created.max_rounds).toBe(4);
    expect(created.review_rounds_total).toBe(4);
    expect(created.rounds_completed).toBe(0);
    expect(created.worker_providers).toBe("anthropic");
    expect(created.decision).toBeNull();
  });

  it("worker passes the run's worker_providers to the staffing proposal", async () => {
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });
    const created = await service.create("project-1", {
      objective: "objective",
      workerProviders: "openai",
    });
    const staffingInputs: PlanningStaffingInput[] = [];
    const worker = makeWorker({
      buildStaffingProposal: async (input): Promise<PlanningStaffingProposalDto | null> => {
        staffingInputs.push(input);
        return null;
      },
    });
    await worker.runNow(created.id);
    expect(staffingInputs).toHaveLength(1);
    expect(staffingInputs[0]?.workerProviders).toBe("openai");
  });

  it("refuses a decision while the run is not in a terminal-review state", async () => {
    const created = await service.create("project-1", { objective: "objective" });
    await expect(
      service.decide("project-1", created.id, { decision: "reject" }),
    ).rejects.toBeInstanceOf(PlanningRunDecisionError);
  });

  it("reject closes the run and retains the rejected plan", async () => {
    const runId = await convergeRun();
    const decided = await service.decide("project-1", runId, { decision: "reject" });
    expect(decided.status).toBe("rejected");
    expect(decided.decision).toMatchObject({ decision: "reject", direction: null, staffing: null });
    expect(decided.result).not.toBeNull();
    // A rejected run takes no further decisions.
    await expect(service.decide("project-1", runId, { decision: "approve" })).rejects.toMatchObject(
      { code: "invalid_status" },
    );
  });

  it("approve records staffing overrides and marks the run approved", async () => {
    const runId = await convergeRun();
    const staffing = [{ node_id: "api", provider: "anthropic" as const, model: "claude-sonnet-5" }];
    const decided = await service.decide("project-1", runId, { decision: "approve", staffing });
    expect(decided.status).toBe("approved");
    expect(decided.decision?.decision).toBe("approve");
    expect(decided.decision?.staffing).toEqual(staffing);
    expect(decided.result).not.toBeNull();
  });

  it("modify re-queues through review cycles with the direction injected and history preserved", async () => {
    const runId = await convergeRun({ maxRounds: 2 });
    const afterFirstLoop = await service.get("project-1", runId);
    const firstLoopCost = afterFirstLoop.total_cost_usd;
    expect(afterFirstLoop.transcript).toHaveLength(2);

    const direction = "Add an authentication module before anything else.";
    const decided = await service.decide("project-1", runId, { decision: "modify", direction });
    expect(decided.status).toBe("queued");
    expect(decided.rounds_completed).toBe(0);
    expect(decided.review_rounds_total).toBe(2);
    expect(decided.result).toBeNull();
    expect(decided.decision).toMatchObject({ decision: "modify", direction });

    // Second loop: the PM revises under the human direction, reviewer converges.
    pm.enqueue(plan(["api", "auth"]));
    reviewer.enqueue({ findings: [] });
    expect(await makeWorker().runNow(runId)).toBe("processed");

    const run = await service.get("project-1", runId);
    expect(run.status).toBe("converged");
    expect(run.rounds_completed).toBe(1);
    // History preserved: 2 prior entries + revision + review.
    expect(run.transcript).toHaveLength(4);
    expect(run.transcript[2]?.summary).toContain("human direction");
    // The direction reached the PM's prompt.
    const revisionRequest = pm.requests[pm.requests.length - 1];
    expect(revisionRequest?.prompt).toContain("HUMAN DIRECTION");
    expect(revisionRequest?.prompt).toContain(direction);
    // Cost accumulates across loops rather than forgetting the first loop.
    expect(run.total_cost_usd).toBeGreaterThan(firstLoopCost);
    expect(run.result?.total_cost_usd).toBeLessThan(run.total_cost_usd);
  });
});

describe("phase tab: allocation implementation-provider constraint", () => {
  const constraintPlan = PlanContract.parse(plan(["api"]));
  const models = buildSelectableModelCatalog([
    { provider: "anthropic", model: "claude-sonnet-5", available: true },
    { provider: "openai", model: "gpt-5.6-terra", available: true },
  ]);

  function recommendation(provider: "anthropic" | "openai") {
    const model = provider === "anthropic" ? "claude-sonnet-5" : "gpt-5.6-terra";
    const reviewerModel = provider === "anthropic" ? "gpt-5.6-terra" : "claude-sonnet-5";
    return {
      summary: "Staff the api node.",
      recommendations: [
        {
          node_id: "api",
          provider,
          model,
          worker_count: 1,
          reviewer_model: reviewerModel,
          budget_usd: 25,
          rationale: "Single accountable worker.",
        },
      ],
    };
  }

  it("tells the PM about the constraint and accepts a compliant recommendation", async () => {
    const pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    pm.enqueue(recommendation("anthropic"));
    const result = await recommendProjectAllocation({
      pm,
      projectId: "project-1",
      projectName: "Constrained",
      objective: constraintPlan.objective,
      graph: WorkflowGraph.fromPlan(constraintPlan).snapshot(),
      models,
      allowedWorkerProviders: ["anthropic"],
    });
    expect(result.recommendations[0]?.provider).toBe("anthropic");
    expect(pm.requests[0]?.prompt).toContain("Implementation-provider constraint");
  });

  it("refuses a recommendation that staffs a disallowed implementation provider", async () => {
    const pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    pm.enqueue(recommendation("openai"));
    await expect(
      recommendProjectAllocation({
        pm,
        projectId: "project-1",
        projectName: "Constrained",
        objective: constraintPlan.objective,
        graph: WorkflowGraph.fromPlan(constraintPlan).snapshot(),
        models,
        allowedWorkerProviders: ["anthropic"],
      }),
    ).rejects.toMatchObject({ code: "provider_constraint" });
  });
});

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
}

describe.sequential("phase tab: HTTP surface (production option shape)", () => {
  let pg: PGlite;
  let server: NornsServer;
  let stores: RelayStores;
  let token: string;
  /** The seeded admin's user id — the expected audit actor for decisions. */
  let adminId: string;
  let projectId: string;
  let pmAdapter: FakeAdapter;
  let reviewerAdapter: FakeAdapter;
  let kickoffCalls: unknown[];

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

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    // The run worker resolves PM models through the projects store, so the
    // project must exist BOTH there (pmSelectionOf) and in PGlite (the
    // planning_runs FK).
    const projects = new ProjectStore();
    projectId = projects.create({
      name: "HTTP project",
      description: "phase tab",
      pmProvider: "anthropic",
    }).id;
    await pg.query(
      `INSERT INTO projects (
         id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
       ) VALUES ($1, 'HTTP project', 'active', 'assignment/default', 'verification/default', 'budget/default')`,
      [projectId],
    );
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    const admin = users.userForToken(token);
    if (!admin) throw new Error("seeded admin session did not resolve");
    adminId = admin.id;
    pmAdapter = new FakeAdapter("anthropic");
    reviewerAdapter = new FakeAdapter("openai");
    kickoffCalls = [];
    stores = new RelayStores();
    server = await buildServer({
      stores,
      users,
      projects,
      // The production option shape from main.ts is planningRuns:
      // { transactions } — executionKickoff is additive/optional and is
      // exercised through the seam here.
      planningRuns: {
        transactions,
        executionKickoff: {
          kickoff: async (input) => {
            kickoffCalls.push(input);
            return { started: false, detail: "kickoff seam invoked (test double)" };
          },
        },
      },
      phase5: { attention: new AttentionService(transactions) },
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "test-anthropic",
        OPENAI_API_KEY: "test-openai",
        NORNS_OPENAI_MODEL: "gpt-5.6-luna",
      },
      createPlanningAdapter: (provider: ProviderName): LlmAdapter =>
        provider === "anthropic" ? pmAdapter : reviewerAdapter,
    });
  }, 30_000);

  afterEach(async () => {
    await server.app.close();
    if (!pg.closed) await pg.close();
  });

  async function createConvergedRun(body: Record<string, unknown> = {}): Promise<string> {
    pmAdapter.enqueue(plan(["api"]));
    reviewerAdapter.enqueue({ findings: [] });
    const created = await inject("POST", `/api/v2/projects/${projectId}/planning-runs`, {
      objective: "do the thing",
      ...body,
    });
    expect(created.statusCode).toBe(202);
    const { planning_run_id: runId } = created.json() as { planning_run_id: string };
    await pollUntil(runId, (run) => run.status === "converged");
    return runId;
  }

  it("accepts review_rounds and worker_providers and reflects them in the DTO", async () => {
    const runId = await createConvergedRun({ review_rounds: 4, worker_providers: "anthropic" });
    const res = await inject("GET", `/api/v2/projects/${projectId}/planning-runs/${runId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      max_rounds: 4,
      review_rounds_total: 4,
      rounds_completed: 1,
      worker_providers: "anthropic",
      decision: null,
    });
  });

  it("409s a decision before the run reaches a terminal-review state", async () => {
    const created = await inject("POST", `/api/v2/projects/${projectId}/planning-runs`, {
      objective: "do the thing",
    });
    const { planning_run_id: runId } = created.json() as { planning_run_id: string };
    // The immediate dispatch fails (empty adapter queues) leaving the run
    // failed — decisions stay refused in every non-terminal-review state.
    await pollUntil(runId, (run) => run.status !== "queued" && run.status !== "drafting");
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "approve" },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "invalid_status" });
  });

  it("400s modify without a direction and 422s approve with unregistered staffing", async () => {
    const runId = await createConvergedRun();
    const noDirection = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "modify" },
    );
    expect(noDirection.statusCode).toBe(400);

    const badModel = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      {
        decision: "approve",
        staffing: [{ node_id: "api", provider: "anthropic", model: "not-a-model" }],
      },
    );
    expect(badModel.statusCode).toBe(422);
    expect(badModel.json()).toMatchObject({ error: "invalid_staffing" });

    const wrongProvider = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      {
        decision: "approve",
        staffing: [{ node_id: "api", provider: "openai", model: "claude-sonnet-5" }],
      },
    );
    expect(wrongProvider.statusCode).toBe(422);
  });

  it("approve records staffing, reports the kickoff seam result, and closes the loop", async () => {
    const runId = await createConvergedRun();
    const staffing = [{ node_id: "api", provider: "anthropic", model: "claude-sonnet-5" }];
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "approve", staffing },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "approved",
      execution: { started: false, detail: "kickoff seam invoked (test double)" },
    });
    expect((body.decision as Record<string, unknown>).staffing).toEqual(staffing);
    expect(kickoffCalls).toHaveLength(1);
    expect(kickoffCalls[0]).toMatchObject({ projectId, planningRunId: runId, staffing });
    // P5b: the kickoff input carries no plan payload — the implementation
    // re-loads the run itself, so the field would be dead weight.
    expect(kickoffCalls[0]).not.toHaveProperty("plan");
    // P5b: the decision and kickoff audit entries are attributed to the
    // resolved session user, not the legacy "operator" literal.
    const audited = stores
      .auditEntries()
      .filter((entry) => entry.action.startsWith("planning_run."))
      .map((entry) => ({ actor: entry.actor, action: entry.action }));
    expect(audited).toContainEqual({ actor: adminId, action: "planning_run.decision.approve" });
    expect(audited).toContainEqual({ actor: adminId, action: "planning_run.execution_kickoff" });
    expect(
      audited.filter(
        (entry) => entry.actor === "operator" && entry.action !== "planning_run.created",
      ),
    ).toEqual([]);
  });

  it("rejects approve staffing outside the run's worker_providers constraint, leaving the run decidable", async () => {
    const runId = await createConvergedRun({ worker_providers: "anthropic" });
    // A registry-valid openai entry: it passes the model-registry check and
    // must be refused by the run's own provider constraint instead.
    const outsideConstraint = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      {
        decision: "approve",
        staffing: [{ node_id: "api", provider: "openai", model: "gpt-5.6-terra" }],
      },
    );
    expect(outsideConstraint.statusCode).toBe(422);
    const refusal = outsideConstraint.json() as { error: string; message: string };
    expect(refusal.error).toBe("invalid_staffing");
    expect(refusal.message).toContain('Node "api" uses implementation provider openai');
    expect(refusal.message).toContain("only allows anthropic");

    // The refusal recorded nothing: the run is still converged and decidable.
    const after = await inject("GET", `/api/v2/projects/${projectId}/planning-runs/${runId}`);
    expect(after.json()).toMatchObject({ status: "converged", decision: null });

    const valid = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      {
        decision: "approve",
        staffing: [{ node_id: "api", provider: "anthropic", model: "claude-sonnet-5" }],
      },
    );
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ status: "approved" });
  });

  it("modify re-enters the loop over HTTP and reconverges with the direction", async () => {
    const runId = await createConvergedRun();
    pmAdapter.enqueue(plan(["api", "auth"]));
    reviewerAdapter.enqueue({ findings: [] });
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "modify", direction: "Add an auth module." },
    );
    expect(res.statusCode).toBe(202);
    const run = await pollUntil(runId, (candidate) => candidate.status === "converged");
    expect((run.transcript as unknown[]).length).toBe(4);
    expect(run.decision).toMatchObject({ decision: "modify" });
  });

  it("reject closes the run over HTTP", async () => {
    const runId = await createConvergedRun();
    const res = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "reject" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "rejected" });
  });

  it("serves per-phase execution progress for the project", async () => {
    await pg.exec(`
      INSERT INTO phases (id,project_id,objective_summary,priority,status,approved_budget_usd)
      VALUES ('phase-1','${projectId}','Build the API',1,'approved',100),
             ('phase-2','${projectId}','Release',2,'proposed',50);
      INSERT INTO strategy_versions (
        id,project_id,phase_id,version,status,objective,content,convergence,review_rounds,content_hash
      ) VALUES ('strategy-1','${projectId}','phase-1',1,'approved','Build the API','{}'::jsonb,
                'converged',1,repeat('a',64));
      UPDATE phases SET approved_strategy_version_id='strategy-1', status='active'
      WHERE id='phase-1';
      INSERT INTO objectives (id,project_id,phase_id,outcome,success_measures,status,"order")
      VALUES ('objective-1','${projectId}','phase-1','API works','["visible"]'::jsonb,'active',0);
      INSERT INTO tasks (
        id,project_id,phase_id,objective_id,strategy_version_id,title,description,
        deliverables,acceptance_criteria,complexity,risk,required_roles,
        required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
        verification_policy_ref,state,lifecycle_version,aggregate_version,completed_at,
        review_evidence,completion_evidence
      ) VALUES
        ('task-1','${projectId}','phase-1','objective-1','strategy-1','One','d',
         '["x"]'::jsonb,'["y"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
         '["commit"]'::jsonb,'environment','verification','completed',1,1,'2026-07-22T10:00:00Z',
         '["review"]'::jsonb,'["done"]'::jsonb),
        ('task-2','${projectId}','phase-1','objective-1','strategy-1','Two','d',
         '["x"]'::jsonb,'["y"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
         '["commit"]'::jsonb,'environment','verification','completed',1,1,'2026-07-22T10:10:00Z',
         '["review"]'::jsonb,'["done"]'::jsonb),
        ('task-3','${projectId}','phase-1','objective-1','strategy-1','Three','d',
         '["x"]'::jsonb,'["y"]'::jsonb,'M','low','["backend"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
         '["commit"]'::jsonb,'environment','verification','failed',1,1,NULL,
         '[]'::jsonb,'[]'::jsonb);
    `);
    const res = await inject("GET", `/api/v2/projects/${projectId}/execution-status`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      project_id: string;
      phases: Array<Record<string, unknown>>;
    };
    expect(body.project_id).toBe(projectId);
    expect(body.phases).toHaveLength(2);
    const [active, proposed] = body.phases;
    expect(active).toMatchObject({
      phase_id: "phase-1",
      name: "Build the API",
      state: "active",
      percent_complete: 67,
    });
    // Two timestamped completions in the window => a real linear-projection ETA.
    expect(typeof active?.est_completion).toBe("string");
    expect(active?.notes).toContain("2/3 tasks complete");
    expect(active?.notes).toContain("1 task(s) failed");
    expect(proposed).toMatchObject({
      phase_id: "phase-2",
      name: "Release",
      state: "proposed",
      percent_complete: 0,
      est_completion: null,
      notes: "no tasks yet",
    });

    const missing = await inject("GET", "/api/v2/projects/no-such-project/execution-status");
    expect(missing.statusCode).toBe(404);
  });
});
