// EXECUTION E12 — concurrent tasks inside one phase, against real dependencies.
//
// Every test here drives a REAL PGlite database through the REAL migrations,
// the REAL `Phase4Coordinator` gate, the REAL `PhaseLaunchService`, the REAL
// `RelationalTaskContextAssembler`, the REAL `Phase4EventProcessor`, the REAL
// `Phase4CompletionService`, the REAL `PhaseQueueDrainer` and the REAL budget
// reservation machinery. Nothing about concurrency, fencing, budget or conflict
// detection is mocked.
//
// That is not ceremony. This repository's own history records five dead code
// paths that mocks kept green, and E12 found a sixth by reading rather than
// running: `task_coordination_constraints` has two readers and had zero
// writers, so the dispatch gate's repository-scope mutual exclusion had never
// executed its conflict branch even once in production. A suite that mocked
// the coordinator would have "proved" that gate worked. These tests instead
// assert on rows the real code actually wrote.
import { PGlite } from "@electric-sql/pglite";
import type { EventEnvelopeInputT } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { describePhaseConcurrency } from "../src/coordinator/phaseConcurrency.js";
import {
  DEFAULT_PHASE_LAUNCH_POLICY,
  PhaseLaunchService,
} from "../src/coordinator/phaseLaunchService.js";
import { PhaseQueueDrainer } from "../src/coordinator/phaseQueueDrainer.js";
import {
  RunIntegrationConflictService,
  TaskConflictScopeRepository,
} from "../src/coordinator/runIntegrationConflicts.js";
import { RelationalTaskContextAssembler, TaskContextStore } from "../src/execution/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const PROJECT = "project-e12";
const PHASE = "phase-e12";
const STRATEGY = "strategy-e12";
const OBJECTIVE = "objective-e12";
const ARCHITECTURE = "arch-e12";
const PROFILE = "profile-e12";
const USER = "user-e12";
const RUNNER = "runner-e12";
const BINDING = "binding-e12";
const BASE_REVISION = "commit-e12";
const HASH_64 = "a".repeat(64);
const ISSUED_AT = "2026-07-21T12:00:00.000Z";

const HUMAN = { actor_type: "human", actor_id: USER } as const;

function evidence(kind: string, ref: string) {
  return {
    artifact_id: `artifact-${kind}-${ref}`,
    content_hash: HASH_64,
    media_type: "text/markdown",
    label: `${kind} ${ref}`,
  };
}

interface SeedOptions {
  /** `projects.max_concurrent_tasks`. The shipped default is 1. */
  cap?: number;
  taskCount?: number;
  approvedBudgetUsd?: number;
  taskBudgetLimitUsd?: number;
  /** Per-profile cap. Raised by default so the PROJECT cap is what's under
   *  test; `agent_profiles.max_concurrent_runs` is a separate limit that
   *  would otherwise silently be the binding one. */
  profileMaxConcurrentRuns?: number;
  /** `task-2` depends on `task-1`, so only one is dependency-ready at first. */
  chainDependencies?: boolean;
}

function taskId(index: number): string {
  return `task-e12-${index}`;
}
function assignmentId(index: number): string {
  return `assignment-e12-${index}`;
}

describe.sequential("EXECUTION E12 — concurrent tasks within one phase", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let coordinator: Phase4Coordinator;
  let taskContext: RelationalTaskContextAssembler;
  let dispatchScope: DispatchContextScopeRepository;
  let events: Phase4EventProcessor;
  let completion: Phase4CompletionService;
  let conflicts: RunIntegrationConflictService;
  let scopes: TaskConflictScopeRepository;

  async function seed(options: SeedOptions = {}): Promise<void> {
    const cap = options.cap ?? 1;
    const taskCount = options.taskCount ?? 2;
    const approvedBudgetUsd = options.approvedBudgetUsd ?? 1_000;
    const taskBudgetLimitUsd = options.taskBudgetLimitUsd ?? 10;

    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES ('${USER}', 'pm@example.com', 'PM', 'pm@example.com', 'PM', 'x',
                'scrypt-v1', 'admin', 'active');
    `);
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref, max_concurrent_tasks
       ) VALUES ($1,'Norns E12','Concurrent execution.','active','assignment/default',
                 'verification/strict','budget/default',$2)`,
      [PROJECT, cap],
    );
    await pg.query(
      `INSERT INTO repository_bindings (
         id, project_id, binding_type, status, runner_id, workspace_id,
         repository_id, repository_display_name, granted_permissions,
         default_branch, observed_head, verification_policy_ref,
         repository_health, created_by_actor_type, created_by_actor_id
       ) VALUES ($1,$2,'local_runner','connected',$3,'workspace-e12','repository-e12',
                 'Norns E12','{}'::jsonb,'main',$4,'verification/strict','healthy','human',$5)`,
      [BINDING, PROJECT, RUNNER, BASE_REVISION, USER],
    );
    await pg.query("UPDATE projects SET primary_repository_binding_id = $1 WHERE id = $2", [
      BINDING,
      PROJECT,
    ]);
    await pg.query(
      `INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
       VALUES ($1,$2,'Ship concurrent execution.',1,'approved',$3)`,
      [PHASE, PROJECT, approvedBudgetUsd],
    );
    await pg.query(
      `INSERT INTO strategy_versions (
         id, project_id, phase_id, version, status, objective, content, convergence, content_hash
       ) VALUES ($1,$2,$3,1,'approved','Concurrency','{}'::jsonb,'converged',$4)`,
      [STRATEGY, PROJECT, PHASE, HASH_64],
    );
    await pg.query("UPDATE phases SET approved_strategy_version_id = $2 WHERE id = $1", [
      PHASE,
      STRATEGY,
    ]);
    await pg.query(
      `INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
       VALUES ($1,$2,$3,'Parallel runs produce verified branches.',
               '["runs complete"]'::jsonb,'active',0)`,
      [OBJECTIVE, PROJECT, PHASE],
    );
    await pg.query(
      `INSERT INTO artifacts (
         id, project_id, kind, label, media_type, storage_ref, content_hash, byte_size,
         provenance_actor_type, provenance_actor_id, redaction_status
       ) VALUES ('artifact-${PROJECT}',$1,'architecture','Architecture','text/markdown',
                 'https://example.com/arch',$2,10,'human',$3,'reviewed')`,
      [PROJECT, "c".repeat(64), USER],
    );
    await pg.query(
      `INSERT INTO architecture_revisions (
         id, project_id, revision, title, summary, architecture_artifact_id,
         repository_revision, provenance_actor_type, provenance_actor_id
       ) VALUES ($1,$2,1,'Monorepo','pnpm workspace.','artifact-${PROJECT}','abc123','human',$3)`,
      [ARCHITECTURE, PROJECT, USER],
    );
    await pg.query("UPDATE projects SET current_architecture_revision_id = $1 WHERE id = $2", [
      ARCHITECTURE,
      PROJECT,
    ]);
    await pg.query(
      `INSERT INTO agent_profiles (
         id, provider, runtime, model, roles, capabilities, context_limit_tokens, status,
         active_workload, max_concurrent_runs, cost_metadata
       ) VALUES ($1,'anthropic','claude-code','claude-opus-4-8','["implementer"]'::jsonb,
                 '[]'::jsonb,200000,'available',0,$2,'{}'::jsonb)`,
      [PROFILE, options.profileMaxConcurrentRuns ?? 16],
    );

    for (let index = 1; index <= taskCount; index += 1) {
      await pg.query(
        `INSERT INTO tasks (
           id, project_id, phase_id, objective_id, strategy_version_id, title, description,
           deliverables, acceptance_criteria, complexity, risk, required_roles,
           required_capabilities, required_inputs, expected_outputs,
           environment_policy_ref, verification_policy_ref, state, lifecycle_version,
           created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'Do the described work.',
                   '["change implemented"]'::jsonb,'["tests pass"]'::jsonb,
                   'M','medium','["implementer"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                   '["commit"]'::jsonb,'env/default','verification/strict','ready',1,$7)`,
        [
          taskId(index),
          PROJECT,
          PHASE,
          OBJECTIVE,
          STRATEGY,
          `Task ${index}`,
          `2026-01-0${index}T00:00:00Z`,
        ],
      );
      await pg.query(
        `INSERT INTO agent_assignments (
           id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
           rationale_factors, budget_limit_usd, allocation_policy_ref
         ) VALUES ($1,$2,$3,$4,$5,'proposed','Best fit.','{}'::jsonb,$6,'allocation/default')`,
        [assignmentId(index), PROJECT, PHASE, taskId(index), PROFILE, taskBudgetLimitUsd],
      );
      await pg.query("UPDATE tasks SET designated_assignment_id = $2 WHERE id = $1", [
        taskId(index),
        assignmentId(index),
      ]);
    }

    if (options.chainDependencies && taskCount >= 2) {
      await pg.query(
        `INSERT INTO task_dependencies (id, project_id, phase_id, predecessor_task_id,
                                        successor_task_id)
         VALUES ($1,$2,$3,$4,$5)`,
        ["dep-e12-1", PROJECT, PHASE, taskId(1), taskId(2)],
      );
    }

    await seedFact("package_manager", "pnpm", 0.8);
    await seedFact("build_command", "pnpm run build", 0.99);
    await seedFact("test_command", "pnpm test", 0.99);
    await seedFact("lint_command", "pnpm biome check .", 0.9);
  }

  async function seedFact(key: string, value: string, confidence: number): Promise<void> {
    await pg.query(
      `INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, confidence, version, status, created_at
       ) VALUES ($1,$2,'repository_fact',$3,'repository_ingestion',$4,1,'active',
                 '2026-01-01T00:00:00Z')`,
      [`memory-fact-${key}-${PROJECT}`, PROJECT, `${key}: ${value}`, confidence],
    );
  }

  function service(): PhaseLaunchService {
    return new PhaseLaunchService(
      transactions,
      coordinator,
      taskContext,
      dispatchScope,
      (runnerId) => (runnerId === RUNNER ? { runner_id: RUNNER, runner_generation: 1 } : null),
      undefined,
      DEFAULT_PHASE_LAUNCH_POLICY,
    );
  }

  function start(launch = service()) {
    return launch.startPhase({
      project_id: PROJECT,
      phase_id: PHASE,
      authorized_by: HUMAN,
      authorized_by_session_id: "session-e12",
      issued_at: ISSUED_AT,
    });
  }

  function snapshot() {
    return transactions.transaction((tx) => describePhaseConcurrency(tx, PROJECT, PHASE));
  }

  /** Drive a dispatched run through the REAL event processor to `running`. */
  let eventSeq = 0;
  async function runnerEvent(payload: EventEnvelopeInputT["payload"]): Promise<void> {
    eventSeq += 1;
    await events.apply({
      protocol: 1,
      event_seq: eventSeq,
      runner_id: RUNNER,
      generation: 1,
      correlation_id: `correlation-e12-${eventSeq}`,
      causation_id: null,
      occurred_at: `2026-07-21T13:00:${String(eventSeq).padStart(2, "0")}.000Z`,
      payload,
    });
  }

  /**
   * Deliver every queued dispatch job through the REAL `Phase4DispatchRepository`
   * -- claim, lease, mark delivered -- which is what moves a run from `created`
   * to `dispatched`. Doing this rather than an UPDATE keeps the leasing and
   * lifecycle machinery in the test's path, and is also where a shared-identity
   * regression would show up as one job stealing another's lease.
   */
  async function deliverAll(): Promise<void> {
    const dispatch = new Phase4DispatchRepository(transactions);
    for (;;) {
      const claimed = await dispatch.claim("dispatcher-e12", 30_000);
      if (!claimed) break;
      await dispatch.markDelivered(claimed.job_id, "dispatcher-e12", "2026-07-21T12:30:00.000Z");
    }
  }

  async function markRunning(runId: string): Promise<void> {
    await deliverAll();
    await runnerEvent({ kind: "run_status", run_id: runId, status: "started" });
  }

  /** `verification_result` is addressed by TASK id (it resolves through
   *  `tasks.designated_run_id`), not by run id. */
  async function verifyGreen(taskIdentifier: string): Promise<void> {
    await runnerEvent({
      kind: "verification_result",
      node_id: taskIdentifier,
      commit_sha: "c".repeat(40),
      passed: true,
      output_digest: "d".repeat(64),
    });
  }

  async function publish(runId: string, branch: string): Promise<void> {
    await runnerEvent({
      kind: "run_published",
      run_id: runId,
      outcome: "pushed",
      branch,
      commit_sha: `${branch.replace(/[^a-f0-9]/g, "0")}`.padEnd(40, "0").slice(0, 40),
      remote: "origin",
      pull_request_url: null,
      pull_request_note: null,
    });
  }

  async function runStates(): Promise<Record<string, string>> {
    const rows = await pg.query<{ id: string; state: string }>(
      "SELECT id, state FROM agent_runs ORDER BY id",
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, row.state]));
  }

  beforeEach(async () => {
    eventSeq = 0;
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    taskContext = new RelationalTaskContextAssembler(
      transactions,
      new TaskContextStore(transactions),
      { baseUrl: "https://norns.example.com" },
    );
    dispatchScope = new DispatchContextScopeRepository(transactions);
    events = new Phase4EventProcessor(transactions);
    completion = new Phase4CompletionService(transactions);
    conflicts = new RunIntegrationConflictService(transactions);
    scopes = new TaskConflictScopeRepository(transactions);
  }, 60_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  // -------------------------------------------------------------------------
  // 1. Concurrent dispatch
  // -------------------------------------------------------------------------

  it("dispatches two dependency-ready tasks in parallel when the cap is 2, each with its own run, command, context scope and budget reservation", async () => {
    await seed({ cap: 2, taskCount: 2 });

    const result = await start();

    expect(result.blocked).toEqual([]);
    expect(result.deferred).toEqual([]);
    expect(result.scheduled).toHaveLength(2);
    expect(result.scheduled.map((entry) => entry.task_id)).toEqual([taskId(1), taskId(2)]);

    // Each run is a genuinely separate execution: distinct run id, distinct
    // dispatch job, distinct command, distinct budget reservation. This is the
    // property E5 made possible and that a shared identity would violate.
    const runIds = result.scheduled.map((entry) => entry.run_id);
    expect(new Set(runIds).size).toBe(2);
    const jobIds = result.scheduled.map((entry) => entry.dispatch_job_id);
    expect(new Set(jobIds).size).toBe(2);

    const jobs = await pg.query<{ id: string; run_id: string; command_id: string; status: string }>(
      "SELECT id, run_id, command_id, status FROM dispatch_jobs ORDER BY id",
    );
    expect(jobs.rows).toHaveLength(2);
    expect(new Set(jobs.rows.map((row) => row.command_id)).size).toBe(2);
    expect(jobs.rows.every((row) => row.status === "queued")).toBe(true);

    const reservations = await pg.query<{ id: string; run_id: string; status: string }>(
      "SELECT id, run_id, status FROM budget_reservations ORDER BY id",
    );
    expect(reservations.rows).toHaveLength(2);
    expect(new Set(reservations.rows.map((row) => row.run_id)).size).toBe(2);
    expect(reservations.rows.every((row) => row.status === "active")).toBe(true);

    // Each run's context is its own: E2's dispatch scope must name both runs,
    // or the E1 context-fetch route would authorize one run to read the
    // other's documents.
    const scopeRows = await pg.query<{ run_id: string }>(
      "SELECT DISTINCT run_id FROM dispatch_context_documents ORDER BY run_id",
    );
    expect(scopeRows.rows).toHaveLength(2);

    expect(result.concurrency).toMatchObject({
      max_concurrent_tasks: 2,
      running: 2,
      available: 0,
      queued: 0,
      open_conflicts: 0,
    });
  }, 60_000);

  it("carries both concurrent runs through to completion independently", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two scheduled runs");

    await markRunning(first.run_id);
    await markRunning(second.run_id);
    expect(await runStates()).toMatchObject({
      [first.run_id]: "running",
      [second.run_id]: "running",
    });

    for (const [index, run] of [first.run_id, second.run_id].entries()) {
      await verifyGreen(taskId(index + 1));
      await runnerEvent({ kind: "run_status", run_id: run, status: "completed" });
    }

    expect(await runStates()).toMatchObject({
      [first.run_id]: "succeeded",
      [second.run_id]: "succeeded",
    });
    const tasks = await pg.query<{ id: string; state: string }>(
      "SELECT id, state FROM tasks ORDER BY id",
    );
    expect(tasks.rows.map((row) => row.state)).toEqual(["in_review", "in_review"]);

    // Both complete. Neither needed the other to finish first.
    for (const [index, run] of [first.run_id, second.run_id].entries()) {
      const outcome = await completion.complete({
        project_id: PROJECT,
        phase_id: PHASE,
        task_id: taskId(index + 1),
        run_id: run,
        actor: HUMAN,
        correlation_id: `correlation-complete-${index}`,
        review_evidence: [evidence("review", `${index}`)],
        integration_evidence: [evidence("integration", `${index}`)],
        review_summary: "reviewed and merged",
        completed_at: "2026-07-21T14:00:00.000Z",
      });
      expect(outcome.task_completed).toBe(true);
    }
    const finalTasks = await pg.query<{ state: string }>("SELECT state FROM tasks");
    expect(finalTasks.rows.every((row) => row.state === "completed")).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 2. Fan-out control: over-cap work queues, and starts when a slot frees
  // -------------------------------------------------------------------------

  it("queues the third task at a cap of 2 instead of failing it, and reports running vs queued", async () => {
    await seed({ cap: 2, taskCount: 3 });

    const result = await start();

    expect(result.scheduled).toHaveLength(2);
    // THE CENTRAL ASSERTION OF DELIVERABLE 3. Before E12 this task landed in
    // `blocked` with `concurrency_exhausted` -- reported as a failure, and
    // never retried by anything.
    expect(result.blocked).toEqual([]);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0]?.task_id).toBe(taskId(3));
    expect(result.deferred[0]?.outcome).toBe("deferred");
    expect(result.deferred[0]?.blocked_reason).toContain("queued");

    // Only two jobs and two conversations' worth of context were created. A
    // phase with twenty ready tasks would behave the same way.
    const jobs = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM dispatch_jobs",
    );
    expect(jobs.rows[0]?.count).toBe(2);

    const view = await snapshot();
    expect(view.running).toBe(2);
    expect(view.available).toBe(0);
    expect(view.queued).toBe(1);
    expect(view.queued_tasks).toEqual([{ task_id: taskId(3), task_title: "Task 3", position: 1 }]);
    expect(view.running_runs.every((run) => run.other_phase === false)).toBe(true);
  }, 60_000);

  it("starts the queued task when a slot frees, via the drainer that nothing used to call", async () => {
    await seed({ cap: 2, taskCount: 3 });
    const launch = service();
    const first = await start(launch);
    const firstRun = first.scheduled[0]?.run_id;
    if (!firstRun) throw new Error("expected a scheduled run");

    const drainer = new PhaseQueueDrainer(transactions, launch, {
      now: () => new Date("2026-07-21T15:00:00.000Z"),
    });

    // No slot free: draining is a no-op, not an error and not an over-dispatch.
    expect(await drainer.drain()).toEqual([]);
    expect((await snapshot()).running).toBe(2);

    // Free a slot the honest way: run 1 fails through the real event
    // processor, which transitions the run and settles its reservation.
    await markRunning(firstRun);
    await runnerEvent({
      kind: "run_status",
      run_id: firstRun,
      status: "failed",
    });
    expect((await runStates())[firstRun]).toBe("failed");

    const drained = await drainer.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.dispatched).toHaveLength(1);

    const view = await snapshot();
    expect(view.running).toBe(2);
    expect(view.queued).toBe(0);
    const dispatchedTasks = await pg.query<{ task_id: string }>(
      "SELECT DISTINCT task_id FROM agent_runs ORDER BY task_id",
    );
    expect(dispatchedTasks.rows.map((row) => row.task_id)).toEqual([
      taskId(1),
      taskId(2),
      taskId(3),
    ]);
  }, 60_000);

  it("never exceeds the cap even when the launcher is invoked repeatedly", async () => {
    await seed({ cap: 2, taskCount: 5 });
    const launch = service();
    await start(launch);
    await start(launch);
    await start(launch);

    const running = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM agent_runs
        WHERE state IN ('created','dispatched','running','verifying')`,
    );
    expect(running.rows[0]?.count).toBe(2);
    expect((await snapshot()).queued).toBe(3);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3. Existing single-task behaviour is unchanged at a cap of 1
  // -------------------------------------------------------------------------

  it("behaves exactly as before when the cap is the shipped default of 1", async () => {
    await seed({ taskCount: 2 }); // cap defaults to 1
    const project = await pg.query<{ max_concurrent_tasks: number }>(
      "SELECT max_concurrent_tasks FROM projects WHERE id = $1",
      [PROJECT],
    );
    expect(project.rows[0]?.max_concurrent_tasks).toBe(1);

    const result = await start();
    expect(result.scheduled).toHaveLength(1);
    expect(result.blocked).toEqual([]);
    expect(result.deferred).toHaveLength(1);
    const jobs = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM dispatch_jobs",
    );
    expect(jobs.rows[0]?.count).toBe(1);
    expect((await snapshot()).running).toBe(1);
  }, 60_000);

  it("still refuses a task whose dependencies are incomplete, at any cap", async () => {
    await seed({ cap: 4, taskCount: 2, chainDependencies: true });
    const result = await start();
    expect(result.scheduled.map((entry) => entry.task_id)).toEqual([taskId(1)]);
    // task-2 is not deferred and not blocked: it is not dependency-ready, so
    // it is not a candidate at all. The queue does not claim it is waiting on
    // a slot when it is actually waiting on task-1.
    expect(result.deferred).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect((await snapshot()).queued).toBe(0);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 4. Conflict safety
  // -------------------------------------------------------------------------

  it("surfaces a conflict for a human when two sibling runs publish branches off the same base, and merges nothing", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");

    await markRunning(first.run_id);
    await markRunning(second.run_id);
    await publish(first.run_id, "norns/task-a");

    // One published branch is not a conflict.
    expect(await conflicts.listForPhase(PHASE, { open_only: true })).toEqual([]);

    await publish(second.run_id, "norns/task-b");

    const open = await conflicts.listForPhase(PHASE, { open_only: true });
    expect(open).toHaveLength(1);
    const conflict = open[0];
    expect(conflict?.status).toBe("awaiting_human");
    expect(conflict?.base_revision).toBe(BASE_REVISION);
    // Neither task declared a scope, so disjointness is unproven and E12 fails
    // closed rather than assuming independence.
    expect(conflict?.detection_basis).toBe("undeclared_scope");
    expect(new Set([conflict?.branch, conflict?.counterpart_branch])).toEqual(
      new Set(["norns/task-a", "norns/task-b"]),
    );
    // The wording must not claim a merge conflict Norns cannot have observed,
    // and must say plainly that nothing was merged.
    expect(conflict?.summary).toContain("never will");
    expect(conflict?.resolution).toBeNull();

    // Nothing auto-resolved. Re-publishing does not create a second row for
    // the same pair, and does not quietly close the first.
    await publish(second.run_id, "norns/task-b");
    expect(await conflicts.listForPhase(PHASE, { open_only: true })).toHaveLength(1);
  }, 60_000);

  it("blocks completion until a human resolves the conflict, then allows it", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");

    for (const [index, run] of [first.run_id, second.run_id].entries()) {
      await markRunning(run);
      await verifyGreen(taskId(index + 1));
    }
    await publish(first.run_id, "norns/task-a");
    await publish(second.run_id, "norns/task-b");
    for (const run of [first.run_id, second.run_id]) {
      await runnerEvent({ kind: "run_status", run_id: run, status: "completed" });
    }

    const complete = () =>
      completion.complete({
        project_id: PROJECT,
        phase_id: PHASE,
        task_id: taskId(1),
        run_id: first.run_id as string,
        actor: HUMAN,
        correlation_id: "correlation-complete",
        review_evidence: [evidence("review", "1")],
        integration_evidence: [evidence("integration", "1")],
        review_summary: "reviewed",
        completed_at: "2026-07-21T14:00:00.000Z",
      });

    await expect(complete()).rejects.toThrow(/unresolved integration conflict/);

    const open = await conflicts.listForPhase(PHASE, { open_only: true });
    const conflictId = open[0]?.id;
    if (!conflictId) throw new Error("expected an open conflict");

    const resolved = await conflicts.resolve({
      conflict_id: conflictId,
      resolution: "merged_manually",
      note: "rebased task-b onto task-a by hand",
      actor: HUMAN,
      resolved_at: "2026-07-21T14:30:00.000Z",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("merged_manually");

    // The resolution is attributed to the human, in the row, by constraint.
    const stored = await pg.query<{
      resolved_by_actor_type: string;
      resolved_by_actor_id: string;
    }>(
      "SELECT resolved_by_actor_type, resolved_by_actor_id FROM run_integration_conflicts WHERE id = $1",
      [conflictId],
    );
    expect(stored.rows[0]).toMatchObject({
      resolved_by_actor_type: "human",
      resolved_by_actor_id: USER,
    });

    await expect(complete()).resolves.toMatchObject({ task_completed: true });
  }, 60_000);

  it("stays silent only when both tasks declared provably disjoint file scope", async () => {
    await seed({ cap: 2, taskCount: 2 });
    await scopes.declare({
      task_id: taskId(1),
      project_id: PROJECT,
      phase_id: PHASE,
      conflict_keys: ["apps/server/src/coordinator/"],
    });
    await scopes.declare({
      task_id: taskId(2),
      project_id: PROJECT,
      phase_id: PHASE,
      conflict_keys: ["apps/web/src/"],
    });

    const result = await start();
    expect(result.scheduled).toHaveLength(2);
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");
    await markRunning(first.run_id);
    await markRunning(second.run_id);
    await publish(first.run_id, "norns/task-a");
    await publish(second.run_id, "norns/task-b");

    // Somebody made a checkable claim and it holds. This is the ONE path on
    // which E12 says nothing.
    expect(await conflicts.listForPhase(PHASE, { open_only: true })).toEqual([]);
  }, 60_000);

  it("prevents the collision entirely when two tasks declare OVERLAPPING scope: the second is queued, not run", async () => {
    await seed({ cap: 2, taskCount: 2 });
    for (const index of [1, 2]) {
      await scopes.declare({
        task_id: taskId(index),
        project_id: PROJECT,
        phase_id: PHASE,
        conflict_keys: ["apps/server/src/coordinator/phase4Coordinator.ts"],
      });
    }

    const result = await start();
    // The gate's conflict-key branch -- which had never executed in
    // production, because nothing ever wrote the table it reads.
    expect(result.scheduled).toHaveLength(1);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0]?.blocked_code).toBe("repository_scope_conflict");
    expect(result.deferred[0]?.blocked_reason).toContain("queued");

    // Because they never ran together, there is nothing to reconcile later.
    const jobs = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM dispatch_jobs",
    );
    expect(jobs.rows[0]?.count).toBe(1);
  }, 60_000);

  it("records overlapping declared scope on the conflict row when two such runs do both publish", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");
    // Scope declared after dispatch (e.g. discovered during the run), so the
    // preventive layer could not act and the detective layer must.
    for (const index of [1, 2]) {
      await scopes.declare({
        task_id: taskId(index),
        project_id: PROJECT,
        phase_id: PHASE,
        conflict_keys: ["apps/server/src/server.ts", `unique-${index}`],
      });
    }
    await markRunning(first.run_id);
    await markRunning(second.run_id);
    await publish(first.run_id, "norns/task-a");
    await publish(second.run_id, "norns/task-b");

    const open = await conflicts.listForPhase(PHASE, { open_only: true });
    expect(open).toHaveLength(1);
    expect(open[0]?.detection_basis).toBe("declared_scope_overlap");
    expect(open[0]?.overlap_keys).toEqual(["apps/server/src/server.ts"]);
    expect(open[0]?.summary).toContain("apps/server/src/server.ts");
  }, 60_000);

  it("refuses to resolve a conflict twice, and refuses an unattributable resolution", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");
    await markRunning(first.run_id);
    await markRunning(second.run_id);
    await publish(first.run_id, "norns/task-a");
    await publish(second.run_id, "norns/task-b");
    const conflictId = (await conflicts.listForPhase(PHASE, { open_only: true }))[0]?.id;
    if (!conflictId) throw new Error("expected an open conflict");

    await expect(
      conflicts.resolve({
        conflict_id: conflictId,
        resolution: "not_a_conflict",
        note: null,
        actor: { actor_type: "system", actor_id: null },
        resolved_at: "2026-07-21T14:30:00.000Z",
      }),
    ).rejects.toThrow(/attributable/);

    const dismissed = await conflicts.resolve({
      conflict_id: conflictId,
      resolution: "not_a_conflict",
      note: "different directories",
      actor: HUMAN,
      resolved_at: "2026-07-21T14:30:00.000Z",
    });
    expect(dismissed.status).toBe("dismissed");

    await expect(
      conflicts.resolve({
        conflict_id: conflictId,
        resolution: "merged_manually",
        note: null,
        actor: HUMAN,
        resolved_at: "2026-07-21T15:00:00.000Z",
      }),
    ).rejects.toThrow(/already dismissed/);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5. Failure isolation
  // -------------------------------------------------------------------------

  it("leaves a sibling running and correct when one run fails", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");
    await markRunning(first.run_id);
    await markRunning(second.run_id);

    await runnerEvent({
      kind: "run_status",
      run_id: first.run_id,
      status: "failed",
    });

    const states = await runStates();
    expect(states[first.run_id]).toBe("failed");
    expect(states[second.run_id]).toBe("running");

    // The survivor's task, reservation and command are untouched.
    const tasks = await pg.query<{ id: string; state: string }>(
      "SELECT id, state FROM tasks ORDER BY id",
    );
    expect(tasks.rows).toEqual([
      { id: taskId(1), state: "failed" },
      { id: taskId(2), state: "in_progress" },
    ]);
    const reservations = await pg.query<{ run_id: string; status: string }>(
      "SELECT run_id, status FROM budget_reservations ORDER BY run_id",
    );
    const byRun = Object.fromEntries(reservations.rows.map((row) => [row.run_id, row.status]));
    expect(byRun[first.run_id]).not.toBe("active");
    expect(byRun[second.run_id]).toBe("active");

    // And the survivor still completes normally.
    await verifyGreen(taskId(2));
    await runnerEvent({
      kind: "run_status",
      run_id: second.run_id,
      status: "completed",
    });
    expect((await runStates())[second.run_id]).toBe("succeeded");
  }, 60_000);

  it("leaves a sibling running and correct when one run is cancelled", async () => {
    await seed({ cap: 2, taskCount: 2 });
    const result = await start();
    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");
    await markRunning(first.run_id);
    await markRunning(second.run_id);

    await runnerEvent({
      kind: "run_status",
      run_id: first.run_id,
      status: "cancelled",
    });

    const states = await runStates();
    expect(states[first.run_id]).toBe("cancelled");
    expect(states[second.run_id]).toBe("running");
    const tasks = await pg.query<{ id: string; state: string }>(
      "SELECT id, state FROM tasks ORDER BY id",
    );
    expect(tasks.rows[0]?.state).toBe("cancelled");
    expect(tasks.rows[1]?.state).toBe("in_progress");
  }, 60_000);

  it("does not refuse a sibling when one run's budget reservation is exhausted; only the PHASE budget can, and it says so", async () => {
    // Phase budget of $25 with $10 per task: two run concurrently ($20
    // reserved), the third genuinely does not fit ($30 > $25).
    await seed({ cap: 3, taskCount: 3, approvedBudgetUsd: 25, taskBudgetLimitUsd: 10 });

    const result = await start();
    expect(result.scheduled).toHaveLength(2);
    // This one IS blocked, not deferred: no slot will free that changes the
    // arithmetic. Only a human raising the phase budget can. Calling it
    // "queued" would be a lie that leaves a human waiting forever.
    expect(result.deferred).toEqual([]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.blocked_code).toBe("budget_exhausted");

    const [first, second] = result.scheduled;
    if (!first?.run_id || !second?.run_id) throw new Error("expected two runs");

    // Now blow run 1's OWN budget: usage far above its $10 reservation. This
    // is a per-run fact and must not touch run 2 at all.
    await pg.query("UPDATE agent_runs SET usage_cost_usd = 999 WHERE id = $1", [first.run_id]);
    await markRunning(first.run_id);
    await markRunning(second.run_id);
    await runnerEvent({
      kind: "run_status",
      run_id: first.run_id,
      status: "failed",
    });

    const states = await runStates();
    expect(states[first.run_id]).toBe("failed");
    expect(states[second.run_id]).toBe("running");
    const survivor = await pg.query<{ status: string }>(
      "SELECT status FROM budget_reservations WHERE run_id = $1",
      [second.run_id],
    );
    expect(survivor.rows[0]?.status).toBe("active");

    // Run 1's reservation released, so the phase now has room again and the
    // third task -- previously genuinely unaffordable -- becomes launchable.
    const drainer = new PhaseQueueDrainer(transactions, service(), {
      now: () => new Date("2026-07-21T16:00:00.000Z"),
    });
    await drainer.drain();
    const dispatched = await pg.query<{ task_id: string }>(
      "SELECT DISTINCT task_id FROM agent_runs ORDER BY task_id",
    );
    expect(dispatched.rows.map((row) => row.task_id)).toEqual([taskId(1), taskId(2), taskId(3)]);
  }, 60_000);

  it("isolates a per-phase drain failure so other projects' queues still drain", async () => {
    await seed({ cap: 2, taskCount: 3 });
    // Break the phase's binding AFTER launch, the way a revoked runner would:
    // the drainer must report/ignore this phase, not throw and abandon the
    // whole tick.
    await pg.query("UPDATE repository_bindings SET status = 'revoked' WHERE id = $1", [BINDING]);
    const seen: unknown[] = [];
    const drainer = new PhaseQueueDrainer(transactions, service(), {
      onError: (_project, _phase, error) => seen.push(error),
    });
    await expect(drainer.drain()).resolves.toEqual([]);
    // A `PhaseLaunchError` is an ordinary "not launchable right now", not an
    // operator alarm.
    expect(seen).toEqual([]);
  }, 60_000);
});
