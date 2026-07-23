// EXECUTION E3 — proxied model inference.
//
// Three layers, on purpose:
//   A. the decision logic, with in-memory ports, so every refusal is asserted
//      cheaply and exhaustively;
//   B. the SQL that runs in production, against real migrations and a real
//      scheduled run — because a mocked lookup proves nothing about a query;
//   C. one end-to-end pass over a REAL relay socket with a REAL runtime
//      (ProxiedCompletionRuntime), because mocks in this codebase have
//      previously hidden paths that were dead in production.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter } from "@norns/adapters";
import { AdapterError, type LlmAdapter } from "@norns/adapters";
import type { UsageEventT } from "@norns/contracts";
import { ProxiedCompletionRuntime, RunnerDaemon, RunnerStateFile } from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { BudgetLedger } from "../src/engine/budget.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  BudgetLedgerInferenceBudget,
  type InferenceMeter,
  InferenceProxy,
  type ProxiedRunFacts,
  type ProxiedRunLookup,
  SqlInferenceMeter,
  SqlProxiedRunLookup,
  SqlRunReservationBudget,
  estimateInferenceInputTokens,
  parseRunnerAllowedModels,
} from "../src/runners/inferenceProxy.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

const MODEL = "mock-anthropic";
const ALLOWED = [`anthropic/${MODEL}`];

// POLISH P1: the pairing HTTP front door is gone. Mint a runner identity the
// way the server now does at its core — register the public key against the
// store — and seed the daemon's on-disk state with the private half.
function seedRunner(stores: RelayStores, runnerId: string, dataDir: string): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const record = stores.registerRunner(
    runnerId,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  new RunnerStateFile(dataDir, {
    runner_id: runnerId,
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    generation: record.generation,
  });
}

function facts(overrides: Partial<ProxiedRunFacts> = {}): ProxiedRunFacts {
  return {
    run_id: "run-1",
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    runner_id: "runner-1",
    runner_generation: 3,
    active: true,
    ...overrides,
  };
}

class StubLookup implements ProxiedRunLookup {
  readonly seen: string[] = [];
  constructor(private readonly rows: Map<string, ProxiedRunFacts>) {}
  async lookup(runId: string): Promise<ProxiedRunFacts | null> {
    this.seen.push(runId);
    return this.rows.get(runId) ?? null;
  }
}

class RecordingMeter implements InferenceMeter {
  readonly events: Array<{ run: ProxiedRunFacts; usage: UsageEventT }> = [];
  record(run: ProxiedRunFacts, usage: UsageEventT): void {
    this.events.push({ run, usage });
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "inf:1",
    run_id: "run-1",
    task_id: "task-1",
    provider: "anthropic" as const,
    model: MODEL,
    prompt: "summarise the diff",
    max_tokens: 512,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Decision logic
// ---------------------------------------------------------------------------

describe("EXECUTION E3 inference proxy authorization", () => {
  let adapter: FakeAdapter;
  let ledger: BudgetLedger;
  let meter: RecordingMeter;
  let lookup: StubLookup;
  let proxy: InferenceProxy;

  beforeEach(() => {
    adapter = new FakeAdapter("anthropic", MODEL);
    ledger = new BudgetLedger(100);
    ledger.approve("task-1", 10);
    meter = new RecordingMeter();
    lookup = new StubLookup(
      new Map([
        ["run-1", facts()],
        // A different project's run, dispatched to a different runner.
        [
          "run-other",
          facts({
            run_id: "run-other",
            project_id: "project-2",
            phase_id: "phase-2",
            task_id: "task-2",
            runner_id: "runner-2",
          }),
        ],
        ["run-finished", facts({ run_id: "run-finished", active: false })],
        // Dispatched at a generation this server no longer recognises.
        ["run-stale", facts({ run_id: "run-stale", runner_generation: 2 })],
      ]),
    );
    proxy = new InferenceProxy({
      runs: lookup,
      createAdapter: () => adapter,
      budget: new BudgetLedgerInferenceBudget(ledger),
      meter,
      allowedModels: ALLOWED,
    });
  });

  it("completes an authorized call, meters it once, and settles the hold", async () => {
    adapter.enqueue("the diff renames a module");
    const before = ledger.available("task-1");

    const response = await proxy.handle(request(), "runner-1", 3, 3);

    expect(response.status).toBe("ok");
    if (response.status !== "ok") throw new Error("unreachable");
    expect(response.text).toBe("the diff renames a module");
    expect(response.request_id).toBe("inf:1");
    expect(response.usage).toEqual({ input_tokens: 100, output_tokens: 50 });

    // Metered exactly once, scoped to the SERVER's resolved run.
    expect(meter.events).toHaveLength(1);
    expect(meter.events[0]?.run.project_id).toBe("project-1");
    expect(meter.events[0]?.usage.input_tokens).toBe(100);

    // The hold is resolved: no reservation is left dangling, and the settled
    // amount is the real cost rather than the conservative estimate.
    expect(ledger.activeReservationsUsd("task-1")).toBe(0);
    expect(ledger.settledUsd("task-1")).toBeCloseTo(
      meter.events[0]?.usage.estimated_cost_usd ?? -1,
    );
    expect(ledger.available("task-1")).toBeLessThan(before);
  });

  it("refuses a run dispatched to a different runner, and never calls the provider", async () => {
    const response = await proxy.handle(
      request({ run_id: "run-other", task_id: "task-2" }),
      "runner-1",
      3,
      3,
    );
    expect(response).toMatchObject({ status: "error", code: "unauthorized" });
    expect(adapter.requests).toHaveLength(0);
    expect(meter.events).toHaveLength(0);
  });

  it("refuses another project's run identically to an unknown run — no probing", async () => {
    const otherProject = await proxy.handle(
      request({ run_id: "run-other", task_id: "task-2" }),
      "runner-1",
      3,
      3,
    );
    const missing = await proxy.handle(request({ run_id: "run-nope" }), "runner-1", 3, 3);
    // Byte-identical refusals: a compromised job cannot tell an existing run
    // it does not own from one that never existed.
    expect(missing).toEqual({ ...otherProject, request_id: missing.request_id });
  });

  it("refuses a superseded generation, both on the frame and on the dispatch", async () => {
    const staleFrame = await proxy.handle(request(), "runner-1", 2, 3);
    expect(staleFrame).toMatchObject({ status: "error", code: "unauthorized" });
    // The frame is fenced before the lookup even happens.
    expect(lookup.seen).toHaveLength(0);

    const staleDispatch = await proxy.handle(request({ run_id: "run-stale" }), "runner-1", 3, 3);
    expect(staleDispatch).toMatchObject({ status: "error", code: "unauthorized" });
    expect(adapter.requests).toHaveLength(0);
  });

  it("refuses a task that does not belong to the run", async () => {
    const response = await proxy.handle(request({ task_id: "task-9" }), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "invalid_request" });
    expect(adapter.requests).toHaveLength(0);
  });

  it("refuses a run that is no longer active", async () => {
    const response = await proxy.handle(request({ run_id: "run-finished" }), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "run_not_active" });
  });

  it("refuses a model that is not on the deployment allowlist", async () => {
    const closed = new InferenceProxy({
      runs: lookup,
      createAdapter: () => adapter,
      budget: new BudgetLedgerInferenceBudget(ledger),
      meter,
      allowedModels: [],
    });
    const response = await closed.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "model_unavailable" });
    expect(adapter.requests).toHaveLength(0);
  });

  it("refuses when the provider has no configured credential", async () => {
    const unconfigured = new InferenceProxy({
      runs: lookup,
      createAdapter: () => null,
      budget: new BudgetLedgerInferenceBudget(ledger),
      meter,
      allowedModels: ALLOWED,
    });
    const response = await unconfigured.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "model_unavailable" });
  });

  it("refuses rather than spending when no budget machinery is configured", async () => {
    const unbudgeted = new InferenceProxy({
      runs: lookup,
      createAdapter: () => adapter,
      meter,
      allowedModels: ALLOWED,
    });
    const response = await unbudgeted.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "budget_exhausted" });
    expect(adapter.requests).toHaveLength(0);
  });

  it("refuses BEFORE calling the provider once the budget cannot cover the call", async () => {
    const poor = new BudgetLedger(100);
    poor.approve("task-1", 0.000_001);
    const constrained = new InferenceProxy({
      runs: lookup,
      createAdapter: () => adapter,
      budget: new BudgetLedgerInferenceBudget(poor),
      meter,
      allowedModels: ALLOWED,
    });
    const response = await constrained.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "budget_exhausted" });
    expect(adapter.requests).toHaveLength(0);
    expect(meter.events).toHaveLength(0);
    expect(poor.activeReservationsUsd("task-1")).toBe(0);
  });

  it("refuses a task with no approved budget at all, rather than throwing", async () => {
    const empty = new InferenceProxy({
      runs: lookup,
      createAdapter: () => adapter,
      budget: new BudgetLedgerInferenceBudget(new BudgetLedger(100)),
      meter,
      allowedModels: ALLOWED,
    });
    const response = await empty.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "budget_exhausted" });
  });

  it("releases the hold when the provider fails, so the budget does not leak", async () => {
    const failing: LlmAdapter = {
      provider: "anthropic",
      model: MODEL,
      complete: async () => {
        throw new AdapterError("rate_limit", "slow down");
      },
      completeStructured: async () => {
        throw new AdapterError("rate_limit", "slow down");
      },
    };
    const flaky = new InferenceProxy({
      runs: lookup,
      createAdapter: () => failing,
      budget: new BudgetLedgerInferenceBudget(ledger),
      meter,
      allowedModels: ALLOWED,
    });
    const before = ledger.available("task-1");
    const response = await flaky.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "rate_limited" });
    expect(ledger.available("task-1")).toBe(before);
    expect(ledger.activeReservationsUsd("task-1")).toBe(0);
    expect(meter.events).toHaveLength(0);
  });

  it("meters a provider call that cost us even though it failed", async () => {
    const usage: UsageEventT = {
      id: "use_1",
      provider: "anthropic",
      model: MODEL,
      project_id: "project-1",
      node_id: "task-1",
      run_id: "run-1",
      input_tokens: 400,
      output_tokens: 10,
      estimated_cost_usd: 0.0009,
      actual_cost_usd: null,
      usage_source: "provider_api",
      pricing_version: "mock-1",
      occurred_at: new Date().toISOString(),
    };
    const halfFailed: LlmAdapter = {
      provider: "anthropic",
      model: MODEL,
      complete: async () => {
        throw new AdapterError("invalid_response", "unparseable", {
          metadata: { usage, request_dispatched: true },
        });
      },
      completeStructured: async () => {
        throw new AdapterError("invalid_response", "unparseable");
      },
    };
    const proxied = new InferenceProxy({
      runs: lookup,
      createAdapter: () => halfFailed,
      budget: new BudgetLedgerInferenceBudget(ledger),
      meter,
      allowedModels: ALLOWED,
    });
    const response = await proxied.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "provider_error" });
    // The money was spent, so it is on the ledger.
    expect(meter.events).toHaveLength(1);
    expect(ledger.settledUsd("task-1")).toBeCloseTo(0.0009);
  });

  it("never leaks provider or credential detail in a refusal message", async () => {
    const authFailure: LlmAdapter = {
      provider: "anthropic",
      model: MODEL,
      complete: async () => {
        throw new AdapterError("auth", "invalid x-api-key sk-ant-secret");
      },
      completeStructured: async () => {
        throw new AdapterError("auth", "invalid x-api-key sk-ant-secret");
      },
    };
    const proxied = new InferenceProxy({
      runs: lookup,
      createAdapter: () => authFailure,
      budget: new BudgetLedgerInferenceBudget(ledger),
      meter,
      allowedModels: ALLOWED,
    });
    const response = await proxied.handle(request(), "runner-1", 3, 3);
    expect(response).toMatchObject({ status: "error", code: "provider_error" });
    if (response.status !== "error") throw new Error("unreachable");
    expect(response.message).not.toContain("sk-ant");
  });
});

describe("EXECUTION E3 proxy helpers", () => {
  it("fails the model allowlist closed when unset or blank", () => {
    expect(parseRunnerAllowedModels(undefined)).toEqual([]);
    expect(parseRunnerAllowedModels("   ")).toEqual([]);
    expect(parseRunnerAllowedModels("anthropic/a, openai/b")).toEqual(["anthropic/a", "openai/b"]);
  });

  it("over-estimates input tokens rather than under-estimating them", () => {
    const prompt = "x".repeat(4_000);
    // 4 chars/token would be 1000; the estimate must exceed that.
    expect(estimateInferenceInputTokens(undefined, prompt)).toBeGreaterThan(1_000);
    expect(estimateInferenceInputTokens("sys", "p")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B. The SQL that actually runs in production
// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E3 inference proxy against real persistence", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let runId: string;

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
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1','Project One','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions,
        default_branch, observed_head, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','local_runner','connected','runner-1',
        'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
        'verification','healthy','human','admin-1');
      UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
      INSERT INTO phases (
        id, project_id, objective_summary, priority, status, approved_budget_usd
      ) VALUES ('phase-1','project-1','Implement vertical slice',1,'awaiting_approval',20);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
        '{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
        WHERE id='phase-1';
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
        '["commit"]'::jsonb,'environment','verification','pending',0);
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
    transactions = new PGliteTransactionRunner(pg);
    // A REAL scheduled run: the coordinator writes agent_runs, commands and the
    // budget reservation the proxy will later enforce against.
    const scheduled = await new Phase4Coordinator(transactions).schedule({
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
      runner_id: "runner-1",
      runner_generation: 3,
      authorized_by: { actor_type: "human", actor_id: "admin-1" },
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
      // Time-relative: a hardcoded window silently expires and the dispatch
      // stops being a live command (see actionsDispatchConcurrency.test.ts).
      issued_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    runId = scheduled.run_id;
  });

  afterEach(async () => {
    await pg.close();
  });

  it("resolves a real scheduled run to its authorization facts", async () => {
    const resolved = await new SqlProxiedRunLookup(transactions).lookup(runId);
    expect(resolved).toMatchObject({
      run_id: runId,
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      runner_id: "runner-1",
      runner_generation: 3,
      active: true,
    });
  });

  it("returns null for an unknown run", async () => {
    expect(await new SqlProxiedRunLookup(transactions).lookup("run-nope")).toBeNull();
  });

  it("marks a terminal run inactive so it can no longer spend", async () => {
    await pg.exec(
      `UPDATE agent_runs SET state='succeeded', lifecycle_version=1 WHERE id='${runId}'`,
    );
    const resolved = await new SqlProxiedRunLookup(transactions).lookup(runId);
    expect(resolved?.active).toBe(false);
  });

  it("marks a revoked runner's run inactive", async () => {
    await pg.exec(`
      INSERT INTO runner_revocations (runner_id, revoked_through_generation, reason, revoked_by)
      VALUES ('runner-1', 5, 'compromised', 'admin-1');
    `);
    const resolved = await new SqlProxiedRunLookup(transactions).lookup(runId);
    expect(resolved?.active).toBe(false);
  });

  it("meters into usage_events and enforces the run's own reservation", async () => {
    const resolved = await new SqlProxiedRunLookup(transactions).lookup(runId);
    if (!resolved) throw new Error("run not resolved");
    const budget = new SqlRunReservationBudget(transactions);
    const meter = new SqlInferenceMeter(transactions);

    // The reservation is the assignment's budget_limit_usd (10).
    const hold = await budget.reserve(resolved, 4);
    expect(hold).not.toBeNull();
    await hold?.settle(4);
    await meter.record(resolved, {
      id: "use_1",
      provider: "anthropic",
      model: MODEL,
      project_id: "project-1",
      node_id: "task-1",
      run_id: runId,
      input_tokens: 1_000,
      output_tokens: 500,
      estimated_cost_usd: 9.5,
      actual_cost_usd: null,
      usage_source: "provider_api",
      pricing_version: "mock-1",
      occurred_at: "2026-07-16T20:01:00.000Z",
    });

    const rows = await pg.query<{
      project_id: string;
      phase_id: string;
      task_id: string;
      run_id: string;
      cost_usd: string;
    }>("SELECT project_id, phase_id, task_id, run_id, cost_usd FROM usage_events");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: runId,
    });

    // 9.5 of 10 is now spent, durably. A further call for 1.00 must be refused,
    // and the refusal survives a fresh budget instance (a restarted server).
    const refused = await new SqlRunReservationBudget(transactions).reserve(resolved, 1);
    expect(refused).toBeNull();
    // But a call within the remaining 0.50 is still allowed.
    expect(await new SqlRunReservationBudget(transactions).reserve(resolved, 0.25)).not.toBeNull();
  });

  it("refuses a run with no live reservation", async () => {
    await pg.exec(`
      UPDATE budget_reservations
      SET status='settled', resolution_outcome='completed',
          settled_usd=amount_usd, released_usd=0, retained_usd=0;
    `);
    const resolved = await new SqlProxiedRunLookup(transactions).lookup(runId);
    if (!resolved) throw new Error("run not resolved");
    expect(await new SqlRunReservationBudget(transactions).reserve(resolved, 0.01)).toBeNull();
  });

  it("does not let concurrent in-flight holds oversubscribe one reservation", async () => {
    const resolved = await new SqlProxiedRunLookup(transactions).lookup(runId);
    if (!resolved) throw new Error("run not resolved");
    const budget = new SqlRunReservationBudget(transactions);
    const first = await budget.reserve(resolved, 6);
    const second = await budget.reserve(resolved, 6);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // 6 + 6 > 10
    await first?.release();
    expect(await budget.reserve(resolved, 6)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. End to end, over a real socket, driving a real runtime
// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E3 proxied inference end to end", () => {
  let server: NornsServer;
  let daemon: RunnerDaemon;
  let adapter: FakeAdapter;
  let meter: RecordingMeter;
  let ledger: BudgetLedger;
  const runnerId = "runner-e3";

  beforeEach(async () => {
    adapter = new FakeAdapter("anthropic", MODEL);
    meter = new RecordingMeter();
    ledger = new BudgetLedger(100);
    ledger.approve("task-1", 5);
    const stores = new RelayStores();
    const users = new UserStore();
    const token = testAdminToken(users);
    server = await buildServer({
      stores,
      users,
      inferenceProxy: new InferenceProxy({
        // The run is dispatched to THIS runner at the generation its key
        // registration assigns (1 for a first registration).
        runs: {
          lookup: async (id) =>
            id === "run-1" ? facts({ runner_id: runnerId, runner_generation: 1 }) : null,
        },
        createAdapter: () => adapter,
        budget: new BudgetLedgerInferenceBudget(ledger),
        meter,
        allowedModels: ALLOWED,
      }),
    });
    const url = await listen(server);
    const dataDir = mkdtempSync(join(tmpdir(), "norns-e3-"));
    seedRunner(stores, runnerId, dataDir);
    daemon = new RunnerDaemon({
      serverUrl: url,
      runnerId,
      dataDir,
      heartbeatMs: 500,
      reconnectDelayMs: 100,
    });
    daemon.loadState();
    daemon.connect();
    await waitFor(() => server.connectedRunners().includes(runnerId), "runner connected");
  });

  afterEach(async () => {
    daemon.stop();
    await server.app.close();
  });

  it("runs a REAL runtime whose only model access is the relay", async () => {
    adapter.enqueue("# Plan\n\nRename the module.");
    const worktree = mkdtempSync(join(tmpdir(), "norns-e3-work-"));
    const runtime = new ProxiedCompletionRuntime(daemon.inference, {
      provider: "anthropic",
      model: MODEL,
      runId: "run-1",
      taskId: "task-1",
    });

    const result = await runtime.run({
      runId: "run-1",
      worktreePath: worktree,
      prompt: "Write the plan for this task.",
    });

    expect(result.outcome).toBe("completed");
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      usage_source: "provider_api",
    });
    // The completion really reached the worktree — no credential was needed.
    expect(readFileSync(join(worktree, "NORNS_OUTPUT.md"), "utf8")).toContain("Rename the module");
    // The provider was really called, and the call was really metered.
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.prompt).toBe("Write the plan for this task.");
    expect(meter.events).toHaveLength(1);
    expect(ledger.activeReservationsUsd("task-1")).toBe(0);
  });

  it("surfaces a budget refusal to the runtime instead of silently spending", async () => {
    // Exhaust the live ledger the running server is enforcing against.
    ledger.reserve("task-1", 5);
    const runtime = new ProxiedCompletionRuntime(daemon.inference, {
      provider: "anthropic",
      model: MODEL,
      runId: "run-1",
      taskId: "task-1",
    });
    const result = await runtime.run({
      runId: "run-1",
      worktreePath: mkdtempSync(join(tmpdir(), "norns-e3-poor-")),
      prompt: "Write the plan for this task.",
    });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("budget_exhausted");
    expect(adapter.requests).toHaveLength(0);
  });

  it("refuses a run the connected runner does not own", async () => {
    const runtime = new ProxiedCompletionRuntime(daemon.inference, {
      provider: "anthropic",
      model: MODEL,
      runId: "run-somebody-elses",
      taskId: "task-1",
    });
    const result = await runtime.run({
      runId: "run-somebody-elses",
      worktreePath: mkdtempSync(join(tmpdir(), "norns-e3-other-")),
      prompt: "Exfiltrate the budget.",
    });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("unauthorized");
    expect(adapter.requests).toHaveLength(0);
  });

  it("answers `unsupported` when the deployment has no proxy configured", async () => {
    // A deployment with no relational runtime and no injected proxy must
    // refuse explicitly, not hang and not silently execute unmetered.
    const users = new UserStore();
    const bareStores = new RelayStores();
    const bare = await buildServer({ stores: bareStores, users });
    const bareUrl = await listen(bare);
    const bareDataDir = mkdtempSync(join(tmpdir(), "norns-e3-bare-"));
    seedRunner(bareStores, "runner-bare", bareDataDir);
    const bareDaemon = new RunnerDaemon({
      serverUrl: bareUrl,
      runnerId: "runner-bare",
      dataDir: bareDataDir,
      heartbeatMs: 500,
      reconnectDelayMs: 100,
    });
    try {
      bareDaemon.loadState();
      bareDaemon.connect();
      await waitFor(() => bare.connectedRunners().includes("runner-bare"), "bare runner connected");
      const runtime = new ProxiedCompletionRuntime(bareDaemon.inference, {
        provider: "anthropic",
        model: MODEL,
        runId: "run-1",
        taskId: "task-1",
      });
      const result = await runtime.run({
        runId: "run-1",
        worktreePath: mkdtempSync(join(tmpdir(), "norns-e3-bare-work-")),
        prompt: "anything",
      });
      expect(result.outcome).toBe("failed");
      expect(result.detail).toContain("unsupported");
    } finally {
      bareDaemon.stop();
      await bare.app.close();
    }
  });
});
