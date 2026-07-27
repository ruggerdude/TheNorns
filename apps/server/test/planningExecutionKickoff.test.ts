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
        reasoning_effort: null,
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
  let phase4: {
    coordinator: Phase4Coordinator;
    completion: Phase4CompletionService;
    dispatch: Phase4DispatchRepository;
    events: Phase4EventProcessor;
    recovery: Phase4RecoveryMonitor;
  };

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
    phase4 = {
      coordinator: new Phase4Coordinator(transactions),
      completion: new Phase4CompletionService(transactions),
      dispatch: new Phase4DispatchRepository(transactions),
      events: new Phase4EventProcessor(transactions),
      recovery: new Phase4RecoveryMonitor(transactions),
    };
    const phaseLaunch = new PhaseLaunchService(
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
      phase4,
      planningRuns: { transactions, executionKickoff },
      phase5: { attention: new AttentionService(transactions) },
      execution: { transactions, baseUrl: "https://norns.example.com" },
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "test-anthropic",
        OPENAI_API_KEY: "test-openai",
        // The allocation-recommendation catalog only marks models available
        // when they are allow-listed for the deployment; without this the
        // worker's buildStaffingProposal fails and staffing_proposal is null.
        NORNS_DEBATE_ALLOWED_MODELS:
          "anthropic/claude-sonnet-5,anthropic/claude-opus-4-8,openai/gpt-5.6-terra",
        NORNS_RUNNER_ALLOWED_MODELS:
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

  it("turns a generated failed-run retry decision into immutable attempt N+1", async () => {
    await seedExecutionEnvironment();
    const planningRunId = await createConvergedRun();
    const approved = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${planningRunId}/decision`,
      { decision: "approve" },
    );
    expect(approved.statusCode).toBe(200);

    const claimed = await phase4.dispatch.claim("decision-recovery-test", 30_000);
    expect(claimed).not.toBeNull();
    if (!claimed) throw new Error("expected the first attempt to be dispatched");
    await phase4.dispatch.markDelivered(
      claimed.job_id,
      "decision-recovery-test",
      "2026-07-25T19:00:00.000Z",
    );
    const event = (eventSeq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: RUNNER,
      generation: claimed.command.runner_generation,
      correlation_id: "failed-run-decision-test",
      causation_id: claimed.command.command_id,
      occurred_at: `2026-07-25T19:0${eventSeq}:00.000Z`,
      payload,
    });
    await phase4.events.apply(
      event(1, { kind: "run_status", run_id: claimed.run_id, status: "started" }) as never,
    );
    await phase4.events.apply(
      event(2, {
        kind: "run_status",
        run_id: claimed.run_id,
        status: "failed",
        failure: {
          stage: "runtime",
          code: "runner_runtime_failed",
          detail: "agent process exited before completing",
        },
      }) as never,
    );
    await phase4.recovery.scan(new Date("2026-07-25T19:10:00.000Z"));

    const decision = await pg.query<{
      id: string;
      condition_fingerprint: string;
      status: string;
    }>(
      `SELECT id, condition_fingerprint, status
         FROM decision_points
        WHERE scope_entity_id=$1 AND reason_class='failed_run'`,
      [claimed.run_id],
    );
    const point = decision.rows[0];
    expect(point).toMatchObject({ status: "open" });
    if (!point) throw new Error("recovery monitor did not create a decision");
    // A human may resolve the decision long after it was created. This
    // timestamp remains historical evidence and must never become the next
    // runner command's issued_at.
    const historicalDecisionTime = "2026-07-25T19:10:00.000Z";

    const decisionUrl = `/api/v2/projects/${projectId}/decision-points/${encodeURIComponent(point.id)}/resolve`;
    const decisionBody = {
      expected_condition_fingerprint: point.condition_fingerprint,
      selected_option_id: "retry",
      rationale: "The failed attempt made no external changes and is safe to retry.",
      direction_target: "implementation_agent",
      direction_text: "Retry from the verified repository head.",
      idempotency_key: `resolve-${point.id}`,
    };

    // A recovery prerequisite failure must not consume the human decision.
    // Replaying the same form key after the prerequisite is restored finishes
    // the already-prepared retry instead of creating a duplicate attempt.
    await pg.query("UPDATE repository_bindings SET status='disconnected' WHERE id=$1", [BINDING]);
    const refused = await inject("POST", decisionUrl, decisionBody);
    expect(refused.statusCode, JSON.stringify(refused.json())).toBe(409);
    expect(refused.json()).toMatchObject({
      error: "recovery_not_started",
      retriable: true,
      detail: expect.stringContaining("decision remains open"),
    });
    expect(
      (
        await pg.query<{ status: string }>("SELECT status FROM decision_points WHERE id=$1", [
          point.id,
        ])
      ).rows[0],
    ).toEqual({ status: "open" });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM decision_records WHERE decision_point_id=$1",
          [point.id],
        )
      ).rows[0]?.count,
    ).toBe(0);

    await pg.query("UPDATE repository_bindings SET status='connected' WHERE id=$1", [BINDING]);
    const resolved = await inject("POST", decisionUrl, decisionBody);
    expect(resolved.statusCode, JSON.stringify(resolved.json())).toBe(200);
    expect(resolved.json()).toMatchObject({
      decision_point_id: point.id,
      recovery: {
        action: "retry",
        started: true,
        prior_run_id: claimed.run_id,
        attempt: 2,
      },
    });

    const runs = await pg.query<{
      id: string;
      attempt: number;
      is_designated: boolean;
      superseded_by_run_id: string | null;
    }>(
      `SELECT id, attempt, is_designated, superseded_by_run_id
         FROM agent_runs WHERE task_id=$1 ORDER BY attempt`,
      [claimed.command.task_id],
    );
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows[0]).toMatchObject({
      id: claimed.run_id,
      attempt: 1,
      is_designated: false,
      superseded_by_run_id: runs.rows[1]?.id,
    });
    expect(runs.rows[1]).toMatchObject({ attempt: 2, is_designated: true });
    const retryCommand = await pg.query<{
      envelope: { issued_at: string; expires_at: string };
    }>(
      `SELECT command.envelope
         FROM commands command
         JOIN agent_runs run ON run.id = command.run_id
        WHERE run.task_id = $1 AND run.attempt = 2`,
      [claimed.command.task_id],
    );
    const retryEnvelope = retryCommand.rows[0]?.envelope;
    expect(retryEnvelope).toBeDefined();
    expect(Date.parse(retryEnvelope?.issued_at ?? "")).toBeGreaterThan(
      Date.parse(historicalDecisionTime),
    );
    expect(
      Date.parse(retryEnvelope?.expires_at ?? "") - Date.parse(retryEnvelope?.issued_at ?? ""),
    ).toBe(5 * 60_000);
    // This is the runner's expiry gate, asserted before it receives the
    // command: a newly recovered attempt must still be live now.
    expect(Date.parse(retryEnvelope?.expires_at ?? "")).toBeGreaterThan(Date.now());
    expect(
      (
        await pg.query<{ status: string }>("SELECT status FROM decision_points WHERE id=$1", [
          point.id,
        ])
      ).rows[0],
    ).toEqual({ status: "resolved" });
    expect(
      (
        await pg.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM decision_records WHERE decision_point_id=$1",
          [point.id],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const attention = await inject("GET", "/api/v2/attention");
    expect(attention.statusCode).toBe(200);
    expect(
      (attention.json() as { items: Array<{ source_id: string }> }).items.some(
        (item) => item.source_id === claimed.run_id,
      ),
    ).toBe(false);
  });

  it("quick change auto-approves and launches exactly one relational execution lineage", async () => {
    await seedExecutionEnvironment();
    pmAdapter.enqueue(plan(["api"]));
    const created = await inject("POST", `/api/v2/projects/${projectId}/planning-runs`, {
      objective: "Correct one small copy issue",
      mode: "quick",
      review_rounds: 0,
      pm: { provider: "anthropic", model: "claude-sonnet-5" },
      agent: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    expect(created.statusCode).toBe(202);
    const { planning_run_id: runId } = created.json() as { planning_run_id: string };

    // No decision POST follows creation. Closing the tab at this point cannot
    // strand the run: the worker owns approval and the durable kickoff.
    const run = await pollUntil(runId, (candidate) => candidate.status === "approved");
    expect(run).toMatchObject({
      mode: "quick",
      status: "approved",
      pm: { provider: "anthropic", model: "claude-sonnet-5" },
      agent: { provider: "anthropic", model: "claude-sonnet-5" },
      decision: { decision: "approve", staffing: null },
      execution: { started: true },
    });
    expect(reviewerAdapter.requests).toHaveLength(0);

    // A stale browser approval is rejected and an explicit execution retry
    // re-enters the idempotent saga. Neither can create a second lineage.
    const staleApproval = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/decision`,
      { decision: "approve" },
    );
    expect(staleApproval.statusCode).toBe(409);
    const retry = await inject(
      "POST",
      `/api/v2/projects/${projectId}/planning-runs/${runId}/execution`,
      {},
    );
    expect(retry.statusCode).toBe(200);

    const counts = await pg.query<{
      planning_runs: number;
      phases: number;
      strategies: number;
      tasks: number;
      assignments: number;
      approvals: number;
      dispatches: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM planning_runs WHERE id = $1) AS planning_runs,
         (SELECT count(*)::int FROM phases WHERE planning_run_id = $1) AS phases,
         (SELECT count(*)::int FROM strategy_versions WHERE project_id = $2) AS strategies,
         (SELECT count(*)::int FROM tasks WHERE project_id = $2) AS tasks,
         (SELECT count(*)::int FROM agent_assignments WHERE project_id = $2) AS assignments,
         (SELECT count(*)::int FROM approvals WHERE project_id = $2) AS approvals,
         (SELECT count(*)::int FROM dispatch_jobs WHERE project_id = $2) AS dispatches`,
      [runId, projectId],
    );
    expect(counts.rows[0]).toEqual({
      planning_runs: 1,
      phases: 1,
      strategies: 1,
      tasks: 1,
      assignments: 1,
      approvals: 1,
      dispatches: 1,
    });
    const quickCommand = await pg.query<{
      command_id: string;
      correlation_id: string;
      run_id: string;
      runner_id: string;
      runner_generation: number;
      phase_id: string;
      task_id: string;
      reviewer_agent_profile_id: string | null;
      envelope: {
        execution_mode?: string;
        max_charge_usd: number;
        provider: string;
        model: string;
        target_branch: string;
      };
      amount_usd: number | string;
    }>(
      `SELECT command.command_id, command.correlation_id, command.run_id, command.runner_id,
              command.runner_generation, command.phase_id, command.task_id,
              assignment.reviewer_agent_profile_id,
              command.envelope, reservation.amount_usd
         FROM commands command
         JOIN phases phase ON phase.id = command.phase_id
         JOIN agent_runs agent_run ON agent_run.id=command.run_id
         JOIN agent_assignments assignment ON assignment.id=agent_run.assignment_id
         JOIN budget_reservations reservation ON reservation.run_id = command.run_id
        WHERE phase.planning_run_id = $1`,
      [runId],
    );
    expect(quickCommand.rows[0]?.envelope.execution_mode).toBe("quick");
    expect(quickCommand.rows[0]?.envelope.max_charge_usd).toBe(2);
    expect(Number(quickCommand.rows[0]?.amount_usd)).toBe(2);
    expect(quickCommand.rows[0]?.reviewer_agent_profile_id).toBeNull();

    const command = quickCommand.rows[0];
    if (!command) throw new Error("Quick Change did not create a command");
    const claimed = await phase4.dispatch.claim("quick-terminal-dispatcher", 30_000);
    expect(claimed?.command.command_id).toBe(command.command_id);
    await phase4.dispatch.markDelivered(
      claimed?.job_id ?? "",
      "quick-terminal-dispatcher",
      "2026-07-25T16:00:00.000Z",
    );
    const commit = "d".repeat(40);
    const apply = (
      eventSeq: number,
      payload: Record<string, unknown>,
      occurredAt = new Date(Date.UTC(2026, 6, 25, 16, eventSeq)).toISOString(),
    ) =>
      phase4.events.apply({
        protocol: 1,
        event_seq: eventSeq,
        runner_id: command.runner_id,
        generation: command.runner_generation,
        correlation_id: command.correlation_id,
        causation_id: command.command_id,
        occurred_at: occurredAt,
        payload,
      } as never);
    await apply(1, {
      kind: "knowledge_registration",
      run_id: command.run_id,
      provider: command.envelope.provider,
      model: command.envelope.model,
      branch_or_workspace: command.envelope.target_branch,
      token_budget: 14_000,
    });
    await apply(2, { kind: "run_status", run_id: command.run_id, status: "started" });
    await apply(3, {
      kind: "verification_result",
      node_id: command.task_id,
      commit_sha: commit,
      passed: true,
      output_digest: "quick-verification-output",
      command_results: [
        {
          name: "test",
          command: ["pnpm", "test"],
          exit_code: 0,
          passed: true,
          output: "passed",
        },
      ],
    });
    await apply(4, {
      kind: "run_published",
      run_id: command.run_id,
      outcome: "pushed",
      branch: command.envelope.target_branch,
      commit_sha: commit,
      remote: "origin",
      pull_request_url: null,
      pull_request_note: "Quick Change was pushed directly.",
    });
    await apply(5, {
      kind: "knowledge_delta",
      run_id: command.run_id,
      changes: [
        {
          kind: "confirmed_assumption",
          summary: "Quick Change completed",
          detail: "The requested small change was implemented and verified.",
          affected_package_ids: [],
        },
      ],
      recommended_package_updates: [],
    });
    const terminalOccurredAt = "2026-07-25T16:07:18.686Z";
    await apply(
      6,
      {
        kind: "knowledge_handoff",
        run_id: command.run_id,
        status: "completed",
        summary: `Verified implementation published at commit ${commit}.`,
        deliverables: [`Verified commit ${commit}`],
        files_changed: ["README.md"],
        interfaces_used: [],
        interfaces_changed: [],
        tests_added: [],
        test_results: ["pnpm test passed"],
        acceptance_criteria: [],
        known_limitations: [],
        open_issues: [],
        dependencies_created: [],
        recommended_package_updates: [],
        recommended_follow_up_tasks: [],
        branch: command.envelope.target_branch,
        commit,
        artifacts: [],
      },
      terminalOccurredAt,
    );
    const durableBeforeCompletion = await pg.query<{
      task_packages: number;
      manifests: number;
      registrations: number;
      deltas: number;
      handoffs: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM task_knowledge_packages
           WHERE task_id=$1 AND status='approved') AS task_packages,
         (SELECT count(*)::int FROM task_context_manifests
           WHERE task_id=$1) AS manifests,
         (SELECT count(*)::int FROM agent_execution_registrations
           WHERE run_id=$2) AS registrations,
         (SELECT count(*)::int FROM knowledge_deltas
           WHERE run_id=$2) AS deltas,
         (SELECT count(*)::int FROM agent_handoffs
           WHERE run_id=$2) AS handoffs`,
      [command.task_id, command.run_id],
    );
    expect(durableBeforeCompletion.rows[0]).toEqual({
      task_packages: 1,
      manifests: 1,
      registrations: 1,
      deltas: 1,
      handoffs: 1,
    });
    await pg.query("UPDATE agent_runs SET updated_at='2026-07-25T15:00:00.000Z' WHERE id=$1", [
      command.run_id,
    ]);
    await expect(
      phase4.recovery.scan(new Date("2026-07-25T16:20:00.000Z"), 60_000),
    ).resolves.toEqual({
      decision_points: 1,
      repaired_reservations: [],
    });
    expect(
      (
        await pg.query<{ status: string }>(
          `SELECT status FROM decision_points
            WHERE scope_entity_id=$1 AND reason_class='stuck_run'`,
          [command.run_id],
        )
      ).rows[0],
    ).toEqual({ status: "open" });
    // Reproduce the live restart/reorder: the later command acknowledgement
    // reached durable storage while the lower terminal status was still
    // buffered. Handoff and completion also share the runner timestamp, so
    // both evaluate the same deterministic completion-gate id.
    await apply(8, {
      kind: "command_ack",
      command_id: command.command_id,
      state: "succeeded",
      detail: "",
    });
    await expect(
      apply(
        7,
        { kind: "run_status", run_id: command.run_id, status: "completed" },
        terminalOccurredAt,
      ),
    ).resolves.toEqual({ duplicate: false });
    await expect(
      apply(
        7,
        { kind: "run_status", run_id: command.run_id, status: "completed" },
        terminalOccurredAt,
      ),
    ).resolves.toEqual({ duplicate: true });
    await expect(
      apply(8, {
        kind: "command_ack",
        command_id: command.command_id,
        state: "succeeded",
        detail: "",
      }),
    ).resolves.toEqual({ duplicate: true });

    const completed = await pg.query<{
      task_state: string;
      phase_status: string;
      objective_status: string;
      assignment_status: string;
      run_state: string;
      task_packages: number;
      manifests: number;
      registrations: number;
      deltas: number;
      handoffs: number;
      reviews: number;
      gates: number;
      phase_gate_passed: boolean;
      completion_events: number;
      command_status: string;
      decision_status: string;
      delta_status: string;
      delta_note: string;
      delta_audits: number;
      delta_evidence: number;
      gate_passed: boolean;
    }>(
      `SELECT task.state AS task_state, phase.status AS phase_status,
              objective.status AS objective_status,
              assignment.status AS assignment_status, agent_run.state AS run_state,
              (SELECT count(*)::int FROM task_knowledge_packages
                WHERE task_id=task.id AND status='approved') AS task_packages,
              (SELECT count(*)::int FROM task_context_manifests
                WHERE task_id=task.id) AS manifests,
              (SELECT count(*)::int FROM agent_execution_registrations
                WHERE run_id=agent_run.id AND status='completed') AS registrations,
              (SELECT count(*)::int FROM knowledge_deltas
                WHERE run_id=agent_run.id) AS deltas,
              (SELECT count(*)::int FROM agent_handoffs
                WHERE run_id=agent_run.id AND status='completed') AS handoffs,
              (SELECT count(*)::int FROM agent_reviews
                WHERE run_id=agent_run.id) AS reviews,
              (SELECT count(*)::int FROM knowledge_gate_evaluations
                WHERE task_id=task.id) AS gates,
              (SELECT passed FROM knowledge_gate_evaluations
                WHERE phase_id=phase.id AND scope_type='phase'
                ORDER BY evaluated_at DESC LIMIT 1) AS phase_gate_passed,
              (SELECT count(*)::int FROM domain_events
                WHERE stream_type='task' AND stream_id=task.id
                  AND event_type='task_state_transitioned'
                  AND payload->>'to'='completed') AS completion_events,
              (SELECT status FROM commands
                WHERE run_id=agent_run.id) AS command_status,
              (SELECT status FROM decision_points
                WHERE scope_entity_id=agent_run.id AND reason_class='stuck_run'
                ORDER BY created_at DESC LIMIT 1) AS decision_status,
              (SELECT status FROM knowledge_deltas
                WHERE run_id=agent_run.id) AS delta_status,
              (SELECT disposition_note FROM knowledge_deltas
                WHERE run_id=agent_run.id) AS delta_note,
              (SELECT count(*)::int FROM knowledge_audit_log
                WHERE subject_type='knowledge_delta'
                  AND subject_id=(SELECT id FROM knowledge_deltas
                    WHERE run_id=agent_run.id)
                  AND action='knowledge.delta.accepted') AS delta_audits,
              (SELECT count(*)::int
                 FROM jsonb_array_elements(task.completion_evidence) item
                WHERE item->>'artifact_id'=(SELECT id FROM knowledge_deltas
                  WHERE run_id=agent_run.id)) AS delta_evidence,
              (SELECT passed FROM knowledge_gate_evaluations
                WHERE task_id=task.id ORDER BY evaluated_at DESC LIMIT 1) AS gate_passed
         FROM tasks task
         JOIN phases phase ON phase.id=task.phase_id
         JOIN objectives objective ON objective.id=task.objective_id
         JOIN agent_assignments assignment ON assignment.id=task.designated_assignment_id
         JOIN agent_runs agent_run ON agent_run.id=task.designated_run_id
        WHERE task.id=$1`,
      [command.task_id],
    );
    expect(completed.rows[0]).toEqual({
      task_state: "completed",
      phase_status: "completed",
      objective_status: "completed",
      assignment_status: "completed",
      run_state: "succeeded",
      task_packages: 1,
      manifests: 1,
      registrations: 1,
      deltas: 1,
      handoffs: 1,
      reviews: 0,
      gates: 1,
      phase_gate_passed: true,
      completion_events: 1,
      command_status: "succeeded",
      decision_status: "dismissed",
      delta_status: "accepted",
      delta_note:
        "Automatically accepted from successful no-review Quick Change after exact-commit verification, publication, and completed handoff.",
      delta_audits: 1,
      delta_evidence: 1,
      gate_passed: true,
    });
    const lifecycle = await pg.query<{ to_state: string }>(
      `SELECT payload->>'to' AS to_state
         FROM domain_events
        WHERE stream_type='task' AND stream_id=$1
          AND event_type='task_state_transitioned'
        ORDER BY stream_version`,
      [command.task_id],
    );
    expect(lifecycle.rows.map((row) => row.to_state)).toEqual(
      expect.arrayContaining(["verifying", "in_review", "completed"]),
    );

    // Simulate the truthful-state residue left by an older process: execution
    // is already complete, but its Quick delta is proposed and absent from
    // closure evidence. The recovery monitor must converge this without a
    // human decision and without duplicating the evidence it appends.
    const delta = await pg.query<{ id: string }>(
      "SELECT id FROM knowledge_deltas WHERE run_id=$1",
      [command.run_id],
    );
    const deltaId = delta.rows[0]?.id;
    if (!deltaId) throw new Error("Quick Change did not persist a knowledge delta");
    await pg.query(
      `UPDATE knowledge_deltas
          SET status='proposed', disposition_note=NULL,
              dispositioned_by_actor_type=NULL, dispositioned_by_actor_id=NULL,
              dispositioned_at=NULL
        WHERE id=$1`,
      [deltaId],
    );
    for (const target of [
      { table: "tasks", idColumn: "id", id: command.task_id, field: "completion_evidence" },
      {
        table: "objectives",
        idColumn: "phase_id",
        id: command.phase_id,
        field: "completion_evidence",
      },
      { table: "phases", idColumn: "id", id: command.phase_id, field: "closure_evidence" },
    ] as const) {
      await pg.query(
        `UPDATE ${target.table}
            SET ${target.field}=(
              SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                FROM jsonb_array_elements(${target.field}) item
               WHERE item->>'artifact_id' <> $2
            )
          WHERE ${target.idColumn}=$1`,
        [target.id, deltaId],
      );
    }
    await phase4.recovery.scan(new Date("2026-07-25T16:30:00.000Z"));
    await phase4.recovery.scan(new Date("2026-07-25T16:31:00.000Z"));
    const repaired = await pg.query<{
      delta_status: string;
      task_evidence: number;
      objective_evidence: number;
      phase_evidence: number;
      phase_gate_passed: boolean;
    }>(
      `SELECT
         (SELECT status FROM knowledge_deltas WHERE id=$1) AS delta_status,
         (SELECT count(*)::int FROM tasks task,
            jsonb_array_elements(task.completion_evidence) item
           WHERE task.id=$2 AND item->>'artifact_id'=$1) AS task_evidence,
         (SELECT count(*)::int FROM objectives objective,
            jsonb_array_elements(objective.completion_evidence) item
           WHERE objective.phase_id=$3 AND item->>'artifact_id'=$1) AS objective_evidence,
         (SELECT count(*)::int FROM phases phase,
            jsonb_array_elements(phase.closure_evidence) item
           WHERE phase.id=$3 AND item->>'artifact_id'=$1) AS phase_evidence,
         (SELECT passed FROM knowledge_gate_evaluations
           WHERE phase_id=$3 AND scope_type='phase'
           ORDER BY evaluated_at DESC LIMIT 1) AS phase_gate_passed`,
      [deltaId, command.task_id, command.phase_id],
    );
    expect(repaired.rows[0]).toEqual({
      delta_status: "accepted",
      task_evidence: 1,
      objective_evidence: 1,
      phase_evidence: 1,
      phase_gate_passed: true,
    });
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
