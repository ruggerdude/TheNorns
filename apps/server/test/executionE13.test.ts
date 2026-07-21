// EXECUTION E13 — the human wants to see what an agent is doing and what it
// is costing WHILE it runs, not after. Three things exist for the first time
// as of E9/E10/E11 and none of them was surfaced: real per-call spend in
// `usage_events` (E9's gateway, E3's proxy), real per-command verification
// output (E10), and streamed `run_log` events (E11). This phase reads all
// three back through `AttentionService`.
//
// Every test here runs against a real PGlite database with the real forward
// migrations, the real `Phase4Coordinator` / `Phase4DispatchRepository` /
// `Phase4EventProcessor` / `AttentionService`, and real INSERTs into
// `usage_events` / `budget_reservations` (the tables E9/E3/the coordinator
// actually write) rather than a mocked repository. This repo's own
// conventions record that mocks have concealed dead paths here; the honesty
// requirement this phase is built around ("never a confident zero that
// looks like free") is exactly the kind of thing a mock would paper over by
// construction.
import { PGlite } from "@electric-sql/pglite";
import { V2_DEFAULT_VERIFICATION_POLICY_REF } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AttentionService, RUN_LOG_PAGE_LIMIT } from "../src/projects/attentionService.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

async function seedExecutableProject(pg: PGlite): Promise<void> {
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
    `INSERT INTO users (
       id, username, display_name, email, name, password_hash,
       password_hash_scheme, role, status
     ) VALUES ('admin-1','admin@example.com','admin@example.com','admin@example.com',
       'admin@example.com','x','scrypt-v1','admin','active')`,
  );
  await pg.exec(`
    INSERT INTO projects (
      id, name, description, status, assignment_policy_ref,
      verification_policy_ref, budget_policy_ref
    ) VALUES ('project-1','Project One','','active','assignment',
      '${V2_DEFAULT_VERIFICATION_POLICY_REF}','budget');
    INSERT INTO repository_bindings (
      id, project_id, binding_type, status, runner_id, workspace_id,
      repository_id, repository_display_name, granted_permissions,
      default_branch, observed_head, verification_policy_ref,
      repository_health, created_by_actor_type, created_by_actor_id
    ) VALUES ('binding-1','project-1','local_runner','connected','runner-1',
      'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
      '${V2_DEFAULT_VERIFICATION_POLICY_REF}','healthy','human','admin-1');
    UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
    INSERT INTO phases (
      id, project_id, objective_summary, priority, status, approved_budget_usd
    ) VALUES ('phase-1','project-1','Implement vertical slice',1,'approved',20);
    INSERT INTO strategy_versions (
      id, project_id, phase_id, version, status, objective, content,
      convergence, review_rounds, content_hash
    ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
      '{}'::jsonb,'converged',1,repeat('a',64));
    UPDATE phases SET approved_strategy_version_id='strategy-1' WHERE id='phase-1';
    INSERT INTO objectives (
      id, project_id, phase_id, outcome, success_measures, status, "order"
    ) VALUES ('objective-1','project-1','phase-1','One completed task',
      '["task completes"]'::jsonb,'active',0);
    INSERT INTO tasks (
      id, project_id, phase_id, objective_id, strategy_version_id, title,
      description, deliverables, acceptance_criteria, complexity, risk,
      required_roles, required_capabilities, required_inputs, expected_outputs,
      environment_policy_ref, verification_policy_ref, state, lifecycle_version
    ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
      'Complete the vertical slice','["change"]'::jsonb,'["verified"]'::jsonb,
      'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      '["commit"]'::jsonb,'environment','${V2_DEFAULT_VERIFICATION_POLICY_REF}','pending',0);
    INSERT INTO agent_profiles (
      id, provider, runtime, model, roles, capabilities, context_limit_tokens,
      security_restrictions, status, active_workload, cost_metadata
    ) VALUES ('agent-1','openai','codex','gpt-5-codex','["implementation"]'::jsonb,
      '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
      '{"billing_mode":"subscription"}'::jsonb);
    INSERT INTO agent_assignments (
      id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
      rationale_factors, budget_limit_usd, allocation_policy_ref
    ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
      'Best implementation agent','["capability"]'::jsonb,10,'allocation');
  `);
}

function scheduleInput() {
  return {
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    runner_id: "runner-1",
    runner_generation: 3,
    authorized_by: { actor_type: "human" as const, actor_id: "admin-1" },
    authorized_by_session_id: "session-1",
    correlation_id: "correlation-1",
    causation_id: null,
    context_refs: [
      {
        artifact_id: "prompt-1",
        content_hash: "b".repeat(64),
        byte_size: 12,
        storage_ref: "relay://artifacts/prompt-1",
      },
    ],
    target_branch: "norns/task-1",
    worktree_policy_ref: "worktree-default",
    sandbox_policy_ref: "sandbox-default",
    max_input_tokens: 10_000,
    max_output_tokens: 4_000,
    max_duration_seconds: 900,
    issued_at: "2026-07-21T20:00:00.000Z",
    expires_at: "2026-07-21T20:15:00.000Z",
  };
}

describe.sequential("EXECUTION E13 — live cost read model", () => {
  let pg: PGlite;
  let coordinator: Phase4Coordinator;
  let events: Phase4EventProcessor;
  let attention: AttentionService;

  beforeEach(async () => {
    pg = new PGlite();
    await seedExecutableProject(pg);
    const transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    events = new Phase4EventProcessor(transactions);
    attention = new AttentionService(transactions);
  });

  afterEach(async () => {
    await pg.close();
  });

  async function dispatchAndStart(): Promise<string> {
    const scheduled = await coordinator.schedule(scheduleInput());
    const dispatch = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    const claimed = await dispatch.claim("dispatcher-e13", 30_000);
    expect(claimed?.command.command_id).toBe(scheduled.command_id);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-e13",
      "2026-07-21T20:00:30.000Z",
    );
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:01:00.000Z",
      payload: { kind: "run_status", run_id: scheduled.run_id, status: "started" },
    });
    return scheduled.run_id;
  }

  it("before any run is scheduled, cost is honestly absent rather than zero", async () => {
    const phase = await attention.phase("project-1", "phase-1");
    const task = phase.tasks.find((entry) => entry.id === "task-1");
    expect(task?.run).toBeNull();
    // No run at all yet: nothing to report. Never a fabricated $0.
    expect(task?.cost).toEqual({
      spend_usd: null,
      input_tokens: null,
      output_tokens: null,
      budget_usd: null,
      last_usage_at: null,
    });
    // The phase itself DOES have a real approved budget (set at strategy
    // approval time) even though nothing has spent against it yet.
    expect(phase.phase.spend_usd).toBeNull();
    expect(phase.phase.budget_usd).toBe(20);
  });

  it("once a run is reserved, the task's real budget shows even with zero spend", async () => {
    const runId = await dispatchAndStart();
    const reservation = await pg.query<{ amount_usd: string }>(
      "SELECT amount_usd FROM budget_reservations WHERE run_id = $1",
      [runId],
    );
    const expectedBudget = Number(reservation.rows[0]?.amount_usd);
    expect(expectedBudget).toBeGreaterThan(0);

    const phase = await attention.phase("project-1", "phase-1");
    const task = phase.tasks.find((entry) => entry.id === "task-1");
    expect(task?.cost).toEqual({
      spend_usd: null,
      input_tokens: null,
      output_tokens: null,
      budget_usd: expectedBudget,
      last_usage_at: null,
    });
  });

  it("real usage_events rows produce real spend at both task and phase scope", async () => {
    const runId = await dispatchAndStart();
    await pg.query(
      `INSERT INTO usage_events (
         id, project_id, phase_id, task_id, run_id, provider, model,
         input_tokens, output_tokens, cost_usd, occurred_at
       ) VALUES
         ('usage-1','project-1','phase-1','task-1',$1,'anthropic','claude-sonnet-5',
           1000,200,0.15,'2026-07-21T20:02:00.000Z'),
         ('usage-2','project-1','phase-1','task-1',$1,'anthropic','claude-sonnet-5',
           800,150,0.12,'2026-07-21T20:03:00.000Z')`,
      [runId],
    );

    const phase = await attention.phase("project-1", "phase-1");
    const task = phase.tasks.find((entry) => entry.id === "task-1");
    expect(task?.cost?.spend_usd).toBeCloseTo(0.27, 6);
    expect(task?.cost?.input_tokens).toBe(1800);
    expect(task?.cost?.output_tokens).toBe(350);
    expect(task?.cost?.last_usage_at).toBe("2026-07-21T20:03:00.000Z");
    expect(task?.cost?.budget_usd).toBeGreaterThan(0);

    // The phase total is the same figure here (one task, one run).
    expect(phase.phase.spend_usd).toBeCloseTo(0.27, 6);
    expect(phase.phase.budget_usd).toBe(20);
  });
});

describe.sequential("EXECUTION E13 — live run-log tail", () => {
  let pg: PGlite;
  let coordinator: Phase4Coordinator;
  let events: Phase4EventProcessor;
  let attention: AttentionService;

  beforeEach(async () => {
    pg = new PGlite();
    await seedExecutableProject(pg);
    const transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    events = new Phase4EventProcessor(transactions);
    attention = new AttentionService(transactions);
  });

  afterEach(async () => {
    await pg.close();
  });

  async function dispatchAndStart(): Promise<string> {
    const scheduled = await coordinator.schedule(scheduleInput());
    const dispatch = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    await dispatch.claim("dispatcher-e13", 30_000);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-e13",
      "2026-07-21T20:00:30.000Z",
    );
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:01:00.000Z",
      payload: { kind: "run_status", run_id: scheduled.run_id, status: "started" },
    });
    return scheduled.run_id;
  }

  it("reports honestly (no run, no total) before a run exists to tail", async () => {
    const result = await attention.runLog("project-1", "phase-1", "task-1");
    expect(result).toEqual({ run_id: null, entries: [], truncated: false, total_entries: null });
  });

  it("tails streamed run_log output in order, then advances by cursor", async () => {
    const runId = await dispatchAndStart();
    for (let index = 0; index < 3; index += 1) {
      await events.apply({
        protocol: 1,
        event_seq: index + 2,
        runner_id: "runner-1",
        generation: 3,
        correlation_id: "correlation-1",
        causation_id: null,
        occurred_at: `2026-07-21T20:0${2 + index}:00.000Z`,
        payload: { kind: "run_log", run_id: runId, chunk: `line ${index}\n` },
      });
    }

    const tail = await attention.runLog("project-1", "phase-1", "task-1");
    expect(tail.run_id).toBe(runId);
    expect(tail.truncated).toBe(false);
    expect(tail.total_entries).toBe(3);
    expect(tail.entries.map((entry) => entry.chunk)).toEqual(["line 0\n", "line 1\n", "line 2\n"]);
    // Ascending sequence, oldest first.
    expect(tail.entries[0]?.sequence).toBeLessThan(tail.entries[1]?.sequence ?? Infinity);

    const lastSeen = tail.entries.at(-1)?.sequence;
    expect(lastSeen).toBeDefined();

    // Nothing new yet: the cursor mode returns an empty page, not an error.
    const caughtUp = await attention.runLog("project-1", "phase-1", "task-1", {
      after: lastSeen as number,
    });
    expect(caughtUp.entries).toEqual([]);
    expect(caughtUp.truncated).toBe(false);

    await events.apply({
      protocol: 1,
      event_seq: 5,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:05:00.000Z",
      payload: { kind: "run_log", run_id: runId, chunk: "line 3\n" },
    });
    const advanced = await attention.runLog("project-1", "phase-1", "task-1", {
      after: lastSeen as number,
    });
    expect(advanced.entries.map((entry) => entry.chunk)).toEqual(["line 3\n"]);
  });

  it("bounds the tail at RUN_LOG_PAGE_LIMIT and discloses truncation rather than dropping it silently", async () => {
    const runId = await dispatchAndStart();
    const overflow = RUN_LOG_PAGE_LIMIT + 5;
    for (let index = 0; index < overflow; index += 1) {
      await events.apply({
        protocol: 1,
        event_seq: index + 2,
        runner_id: "runner-1",
        generation: 3,
        correlation_id: "correlation-1",
        causation_id: null,
        occurred_at: "2026-07-21T20:02:00.000Z",
        payload: { kind: "run_log", run_id: runId, chunk: `line ${index}\n` },
      });
    }

    const tail = await attention.runLog("project-1", "phase-1", "task-1");
    expect(tail.entries).toHaveLength(RUN_LOG_PAGE_LIMIT);
    expect(tail.total_entries).toBe(overflow);
    expect(tail.truncated).toBe(true);
    // The TAIL, not the head: the most recent entries, oldest-shown-first.
    expect(tail.entries[0]?.chunk).toBe(`line ${overflow - RUN_LOG_PAGE_LIMIT}\n`);
    expect(tail.entries.at(-1)?.chunk).toBe(`line ${overflow - 1}\n`);
  }, 20_000);
});

describe.sequential("GET .../tasks/:taskId/run-log (server)", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;

  beforeEach(async () => {
    pg = new PGlite();
    await seedExecutableProject(pg);
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase5: { attention: new AttentionService(transactions) },
    });
  });

  afterEach(async () => {
    await server.app.close();
    await pg.close();
  });

  it("requires a session", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v2/projects/project-1/phases/phase-1/tasks/task-1/run-log",
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed cursor", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v2/projects/project-1/phases/phase-1/tasks/task-1/run-log?after=not-a-number",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns an honest empty tail for a task with no run yet", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v2/projects/project-1/phases/phase-1/tasks/task-1/run-log",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      run_id: null,
      entries: [],
      truncated: false,
      total_entries: null,
    });
  });
});
