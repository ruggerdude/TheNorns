// EXECUTION E5 — per-dispatch runner identity for GitHub Actions-hosted
// execution, exercised end to end through the REAL relay (real WebSocket,
// real Ed25519 challenge/response via the real `@norns/runner` daemon, real
// Postgres via pglite), not mocks. This is the regression suite for the bug
// this phase fixes: `actionsRunnerId(projectId)` used to be shared by every
// dispatch in a project, so scheduling a second concurrent Actions job
// reserved a new relay generation for the FIRST job's identity too, fencing
// it off its own connection mid-run.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { EventPayloadT, V2DispatchCommandT } from "@norns/contracts";
import { RunnerDaemon, RunnerStateFile } from "@norns/runner";
import sodium from "libsodium-wrappers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActionsEnrollmentService,
  ActionsExecutionCoordinator,
  ActionsExecutionRepository,
} from "../src/coordinator/actionsExecution.js";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase4RecoveryMonitor } from "../src/coordinator/phase4RecoveryMonitor.js";
import {
  NORNS_ENROLLMENT_SECRET_NAME,
  NORNS_WORKFLOW_PATH,
  nornsRunName,
} from "../src/integrations/actionsWorkflowTemplate.js";
import {
  GitHubIntegrationService,
  githubIntegrationConfigFromEnvironment,
} from "../src/integrations/github.js";
import { GitHubActionsService } from "../src/integrations/githubActions.js";
import { Phase7OperationsService } from "../src/operations/phase7Operations.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { SqlProxiedRunLookup, authorizeProxiedRunAccess } from "../src/runners/inferenceProxy.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const noContent = (status = 204): Response => new Response(null, { status });

const REPO_OWNER = "octo";
const REPO_NAME = "widgets";
const contentsUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${NORNS_WORKFLOW_PATH}`;
const secretsBase = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/secrets`;
const dispatchUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/norns-agent.yml/dispatches`;
const runsUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/norns-agent.yml/runs`;

/** A trivial, real `executeV2` — enough to walk an agent_run through the real
 *  lifecycle transitions in `Phase4EventProcessor` to `succeeded`, without a
 *  real coding runtime, worktree, or verifier (those belong to `apps/runner`,
 *  off limits to this phase; this proves the SERVER side of a full run.) */
async function executeToGreenVerification(
  command: V2DispatchCommandT,
  emit: (event: EventPayloadT) => void,
): Promise<"succeeded"> {
  emit({ kind: "run_status", run_id: command.run_id, status: "started" });
  emit({
    kind: "verification_result",
    node_id: command.task_id,
    commit_sha: command.expected_revision,
    passed: true,
    output_digest: "digest",
    command_results: [],
  });
  emit({ kind: "run_status", run_id: command.run_id, status: "completed" });
  return "succeeded";
}

interface Stack {
  pg: PGlite;
  server: NornsServer;
  url: string;
  stores: RelayStores;
  transactions: PGliteTransactionRunner;
  actionsCoordinator: ActionsExecutionCoordinator;
  actionsRepository: ActionsExecutionRepository;
  phase4Coordinator: Phase4Coordinator;
  adminToken: string;
  dispatched: { inputs: Record<string, string> }[];
  /** The most recently PUT enrollment secret, unsealed with the test's own
   *  keypair — i.e. the plaintext token a real ephemeral runner would read
   *  from `NORNS_RUNNER_ENROLLMENT_TOKEN`. */
  latestEnrollmentToken: () => Promise<string>;
  stop: () => Promise<void>;
}

/** Seeds a project with an approved phase, a connected GitHub execution
 *  binding, and `taskCount` independently schedulable tasks sharing one
 *  agent profile — raising both concurrency caps to `cap` so the identity
 *  fix can be exercised independently of the (separately tested) default. */
async function seedProject(pg: PGlite, taskCount: number, cap: number): Promise<void> {
  await pg.exec(`
    INSERT INTO projects (
      id, name, description, status, assignment_policy_ref,
      verification_policy_ref, budget_policy_ref, max_concurrent_tasks
    ) VALUES ('project-1','Project One','','active','assignment','verification','budget',${cap});
    INSERT INTO repository_bindings (
      id, project_id, binding_type, status, runner_id, repository_id,
      repository_display_name, github_installation_id, github_owner, github_name,
      granted_permissions, default_branch, observed_head, verification_policy_ref,
      repository_health, created_by_actor_type, created_by_actor_id
    ) VALUES ('binding-1','project-1','github','connected','actions:project-1',
      '90210','octo/widgets','5001','${REPO_OWNER}','${REPO_NAME}','{}'::jsonb,'main','commit-1',
      'verification','healthy','human','admin-1');
    UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
    INSERT INTO phases (
      id, project_id, objective_summary, priority, status, approved_budget_usd
    ) VALUES ('phase-1','project-1','Implement vertical slice',1,'awaiting_approval',200);
    INSERT INTO objectives (
      id, project_id, phase_id, outcome, success_measures, status, "order"
    ) VALUES ('objective-1','project-1','phase-1','Completed tasks',
      '["tasks complete"]'::jsonb,'active',0);
    INSERT INTO strategy_versions (
      id, project_id, phase_id, version, status, objective, content,
      convergence, review_rounds, content_hash
    ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
      '{}'::jsonb,'converged',1,repeat('a',64));
    UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
      WHERE id='phase-1';
    INSERT INTO agent_profiles (
      id, provider, runtime, model, roles, capabilities, context_limit_tokens,
      security_restrictions, status, active_workload, cost_metadata, max_concurrent_runs
    ) VALUES ('agent-1','openai','codex','gpt-5-codex','["implementation"]'::jsonb,
      '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
      '{"billing_mode":"subscription"}'::jsonb,${cap});
  `);
  for (let i = 1; i <= taskCount; i += 1) {
    await pg.exec(`
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title,
        description, deliverables, acceptance_criteria, complexity, risk,
        required_roles, required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES ('task-${i}','project-1','phase-1','objective-1','strategy-1','Do work ${i}',
        'Independent unit of work ${i}','["change"]'::jsonb,'["verified"]'::jsonb,
        'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
        '["commit"]'::jsonb,'environment','verification','pending',0);
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, allocation_policy_ref
      ) VALUES ('assignment-${i}','project-1','phase-1','task-${i}','agent-1','proposed',
        'Best implementation agent','["capability"]'::jsonb,10,'allocation');
    `);
  }
}

function scheduleInputFor(taskIndex: number) {
  return {
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: `task-${taskIndex}`,
    assignment_id: `assignment-${taskIndex}`,
    authorized_by: { actor_type: "human" as const, actor_id: "admin-1" },
    authorized_by_session_id: "session-1",
    correlation_id: `correlation-${taskIndex}`,
    causation_id: null,
    context_refs: [
      {
        artifact_id: `prompt-${taskIndex}`,
        content_hash: "b".repeat(64),
        byte_size: 12,
        storage_ref: `relay://artifacts/prompt-${taskIndex}`,
      },
    ],
    target_branch: `norns/task-${taskIndex}`,
    worktree_policy_ref: "worktree-default",
    sandbox_policy_ref: "sandbox-default",
    max_input_tokens: 10_000,
    max_output_tokens: 4_000,
    max_duration_seconds: 900,
    // TIME-RELATIVE ON PURPOSE. These were hardcoded wall-clock instants, and
    // when that quarter-hour passed the runner's expiry check
    // (apps/runner/src/daemon.ts) started acking every dispatch `expired`: the
    // E5 "two concurrent dispatches both run to completion" assertion stopped
    // testing anything and CI went permanently red. Anchoring to the real clock
    // keeps the same 15-minute window valid at any wall-clock time.
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

async function buildStack(taskCount: number, cap: number): Promise<Stack> {
  await sodium.ready;
  const keypair = sodium.crypto_box_keypair();
  const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);

  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY, snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
  await seedProject(pg, taskCount, cap);

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = githubIntegrationConfigFromEnvironment(
    {
      NORNS_GITHUB_APP_ID: "1234",
      NORNS_GITHUB_CLIENT_ID: "Iv1.test",
      NORNS_GITHUB_CLIENT_SECRET: "client-secret",
      NORNS_GITHUB_APP_SLUG: "the-norns-test",
      NORNS_GITHUB_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      NORNS_GITHUB_STATE_SECRET: "state-secret-that-is-at-least-thirty-two-bytes",
      NORNS_GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    "https://norns.example",
  );
  if (!config) throw new Error("expected GitHub test configuration");

  const dispatched: { inputs: Record<string, string> }[] = [];
  let latestSealedSecret: string | null = null;
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (url.endsWith("/access_tokens")) {
      return json({
        token: `installation-token-${Math.random()}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.startsWith(contentsUrl) && method === "GET") return json({ message: "Not Found" }, 404);
    if (url.startsWith(contentsUrl) && method === "PUT") {
      return json({ commit: { sha: `commit-${Math.random()}` } }, 201);
    }
    if (url === `${secretsBase}/public-key`) return json({ key_id: "key-1", key: publicKeyBase64 });
    if (url === `${secretsBase}/${NORNS_ENROLLMENT_SECRET_NAME}` && method === "PUT") {
      latestSealedSecret = String(body?.encrypted_value ?? "");
      return noContent();
    }
    if (url === dispatchUrl) {
      dispatched.push({ inputs: (body?.inputs ?? {}) as Record<string, string> });
      return noContent();
    }
    if (url.startsWith(runsUrl)) {
      return json({
        workflow_runs: [
          {
            id: Math.floor(Math.random() * 100_000),
            display_title: nornsRunName(dispatched.at(-1)?.inputs.norns_job_id ?? ""),
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/octo/widgets/actions/runs/1",
            run_number: 1,
            created_at: "2026-07-21T10:00:00Z",
          },
        ],
      });
    }
    return json({ message: `unexpected ${method} ${url}` }, 500);
  }) as unknown as typeof fetch;

  const transactions = new PGliteTransactionRunner(pg);
  const github = new GitHubIntegrationService(transactions, config, http, null);
  const actionsService = new GitHubActionsService(github, http);

  const stores = new RelayStores();
  const phase4Coordinator = new Phase4Coordinator(transactions);
  const phase4 = {
    coordinator: phase4Coordinator,
    completion: new Phase4CompletionService(transactions),
    dispatch: new Phase4DispatchRepository(transactions),
    events: new Phase4EventProcessor(transactions),
    recovery: new Phase4RecoveryMonitor(transactions),
  };
  const actionsRepository = new ActionsExecutionRepository(transactions);
  const actionsCoordinator = new ActionsExecutionCoordinator(
    phase4Coordinator,
    actionsRepository,
    actionsService,
    {
      serverOrigin: "https://norns.example",
      runnerPackage:
        "0.1.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reserveGeneration: (runnerId: string) => stores.reserveRunnerGeneration(runnerId),
    },
  );
  const enrollment = new ActionsEnrollmentService(actionsRepository, (runnerId, pem, generation) =>
    stores.enrollRunnerAtGeneration(runnerId, pem, generation),
  );
  const users = new UserStore();
  const adminToken = testAdminToken(users);

  const server = await buildServer({
    stores,
    users,
    phase4,
    actionsExecution: {
      coordinator: actionsCoordinator,
      enrollment,
      repository: actionsRepository,
    },
    phase7: { operations: new Phase7OperationsService(transactions) },
  });
  const url = await listen(server);

  return {
    pg,
    server,
    url,
    stores,
    transactions,
    actionsCoordinator,
    actionsRepository,
    phase4Coordinator,
    adminToken,
    dispatched,
    latestEnrollmentToken: async () => {
      if (!latestSealedSecret) throw new Error("no enrollment secret has been provisioned yet");
      const opened = sodium.crypto_box_seal_open(
        sodium.from_base64(latestSealedSecret, sodium.base64_variants.ORIGINAL),
        keypair.publicKey,
        keypair.privateKey,
      );
      return sodium.to_string(opened);
    },
    stop: async () => {
      await server.app.close();
      if (!pg.closed) await pg.close();
    },
  };
}

/** Enrolls and connects a real ephemeral-runner daemon for `dispatchJobId`
 *  under `runnerId`, using the REAL enrollment token captured off the wire
 *  (never a stand-in). Returns the connected, real `@norns/runner` daemon. */
async function enrollAndConnect(
  stack: Stack,
  runnerId: string,
  dispatchJobId: string,
): Promise<RunnerDaemon> {
  const token = await stack.latestEnrollmentToken();
  const dataDir = mkdtempSync(join(tmpdir(), "norns-e5-"));
  const daemon = new RunnerDaemon({
    serverUrl: stack.url,
    runnerId,
    dataDir,
    heartbeatMs: 250,
    reconnectDelayMs: 100,
    executeV2: executeToGreenVerification,
  });
  await daemon.enroll({ enrollmentToken: token, dispatchJobId });
  daemon.connect();
  await waitFor(
    () => stack.server.connectedRunners().includes(runnerId),
    `runner ${runnerId} connected`,
  );
  return daemon;
}

async function runState(stack: Stack, runId: string): Promise<string> {
  const result = await stack.pg.query<{ state: string }>(
    "SELECT state FROM agent_runs WHERE id = $1",
    [runId],
  );
  return result.rows[0]?.state ?? "(missing)";
}

describe("EXECUTION E5 — per-dispatch runner identity, end to end", () => {
  let stack: Stack | null = null;
  const daemons: RunnerDaemon[] = [];

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) daemon.stop();
    await stack?.stop();
    stack = null;
  });

  it("two concurrent Actions-hosted dispatches in one project both run to completion, and neither fences the other", async () => {
    stack = await buildStack(2, 2);

    const jobA = await stack.actionsCoordinator.schedule(scheduleInputFor(1));
    const daemonA = await enrollAndConnect(stack, jobA.actions.runner_id, jobA.dispatch_job_id);
    daemons.push(daemonA);

    // Job A is fully live BEFORE job B is even scheduled — the exact
    // ordering that used to fence a running job the instant a second one was
    // scheduled, back when every dispatch in a project shared one identity.
    expect(daemonA.isFenced).toBe(false);

    const jobB = await stack.actionsCoordinator.schedule(scheduleInputFor(2));
    expect(jobB.actions.runner_id).not.toBe(jobA.actions.runner_id);
    const daemonB = await enrollAndConnect(stack, jobB.actions.runner_id, jobB.dispatch_job_id);
    daemons.push(daemonB);

    // The defining assertion: scheduling B did not fence A.
    expect(daemonA.isFenced).toBe(false);
    expect(daemonB.isFenced).toBe(false);
    expect(stack.server.connectedRunners()).toEqual(
      expect.arrayContaining([jobA.actions.runner_id, jobB.actions.runner_id]),
    );

    // Both commands are actually delivered and both runs actually finish —
    // "run to completion", not merely "stay connected".
    await waitFor(
      async () => (await runState(stack as Stack, jobA.run_id)) === "succeeded",
      "run A succeeded",
    );
    await waitFor(
      async () => (await runState(stack as Stack, jobB.run_id)) === "succeeded",
      "run B succeeded",
    );
    expect(daemonA.isFenced).toBe(false);
    expect(daemonB.isFenced).toBe(false);
  }, 20_000);

  it("the concurrency cap refuses the (N+1)th dispatch with a clear, specific reason, and disturbs neither running dispatch", async () => {
    stack = await buildStack(3, 2); // cap = 2, three schedulable tasks

    const jobA = await stack.actionsCoordinator.schedule(scheduleInputFor(1));
    const daemonA = await enrollAndConnect(stack, jobA.actions.runner_id, jobA.dispatch_job_id);
    daemons.push(daemonA);
    const jobB = await stack.actionsCoordinator.schedule(scheduleInputFor(2));
    const daemonB = await enrollAndConnect(stack, jobB.actions.runner_id, jobB.dispatch_job_id);
    daemons.push(daemonB);

    // A third dispatch, over the project's configured cap of 2, must be
    // refused with a specific, human-legible reason — not silently dropped,
    // and not by fencing its way past the cap.
    await expect(stack.actionsCoordinator.schedule(scheduleInputFor(3))).rejects.toThrow(
      /project concurrency capacity is exhausted/,
    );

    // The refusal must not have touched either already-running dispatch.
    expect(daemonA.isFenced).toBe(false);
    expect(daemonB.isFenced).toBe(false);
    expect(stack.server.connectedRunners()).toEqual(
      expect.arrayContaining([jobA.actions.runner_id, jobB.actions.runner_id]),
    );
  }, 20_000);

  it("a superseded (zombie) runner is still refused, and a concurrent dispatch is unaffected", async () => {
    stack = await buildStack(2, 2);

    const jobA = await stack.actionsCoordinator.schedule(scheduleInputFor(1));
    const daemonA = await enrollAndConnect(stack, jobA.actions.runner_id, jobA.dispatch_job_id);
    daemons.push(daemonA);
    const jobB = await stack.actionsCoordinator.schedule(scheduleInputFor(2));
    const daemonB = await enrollAndConnect(stack, jobB.actions.runner_id, jobB.dispatch_job_id);
    daemons.push(daemonB);

    // Simulate a resurrected zombie: something reserves a NEW generation for
    // job A's own identity while daemonA's connection is still live and
    // reconciled at the OLD one — the exact mechanism the pre-fix bug relied
    // on (there, it happened to be triggered by scheduling a second dispatch;
    // here it is triggered directly, to prove the fencing PROTECTION itself
    // still works once it is no longer accidentally triggered by every
    // sibling dispatch). daemonA's own heartbeat (an ordinary "event" frame
    // on its still-open socket) is what surfaces the mismatch: no reconnect
    // is involved, matching how the real bug manifested — a runner fenced
    // mid-run on its next frame, not on its next connection attempt.
    stack.stores.reserveRunnerGeneration(jobA.actions.runner_id);
    await waitFor(() => daemonA.isFenced, "superseded runner A is fenced");

    // Job B, a wholly separate dispatch identity, must be entirely unaffected.
    expect(daemonB.isFenced).toBe(false);
    expect(stack.server.connectedRunners()).toContain(jobB.actions.runner_id);
  }, 20_000);

  it("revocation cuts a runner off immediately, without a restart, and without affecting a concurrent dispatch", async () => {
    stack = await buildStack(2, 2);

    const jobA = await stack.actionsCoordinator.schedule(scheduleInputFor(1));
    const daemonA = await enrollAndConnect(stack, jobA.actions.runner_id, jobA.dispatch_job_id);
    daemons.push(daemonA);
    const jobB = await stack.actionsCoordinator.schedule(scheduleInputFor(2));
    const daemonB = await enrollAndConnect(stack, jobB.actions.runner_id, jobB.dispatch_job_id);
    daemons.push(daemonB);

    const revoke = await fetch(
      `${stack.url}/api/admin/runners/${encodeURIComponent(jobA.actions.runner_id)}/revoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${stack.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          revoked_through_generation: jobA.actions.runner_generation,
          reason: "operator revoked this dispatch",
        }),
      },
    );
    expect(revoke.status).toBe(200);

    await waitFor(
      () => !stack?.server.connectedRunners().includes(jobA.actions.runner_id),
      "runner A disconnected",
    );
    // The concurrent dispatch is untouched.
    expect(daemonB.isFenced).toBe(false);
    expect(stack.server.connectedRunners()).toContain(jobB.actions.runner_id);
  }, 20_000);

  it("a runner cannot act for a run or project it does not own", async () => {
    stack = await buildStack(2, 2);
    const jobA = await stack.actionsCoordinator.schedule(scheduleInputFor(1));
    const jobB = await stack.actionsCoordinator.schedule(scheduleInputFor(2));

    const runs = new SqlProxiedRunLookup(stack.transactions);
    const factsA = await runs.lookup(jobA.run_id);
    const factsB = await runs.lookup(jobB.run_id);
    expect(factsA?.runner_id).toBe(jobA.actions.runner_id);
    expect(factsB?.runner_id).toBe(jobB.actions.runner_id);

    // Runner B's identity presenting for run A: refused.
    expect(
      authorizeProxiedRunAccess(
        factsA,
        jobA.run_id,
        jobB.actions.runner_id,
        jobB.actions.runner_generation,
      ),
    ).toBe("unauthorized");
    // Runner A's identity, but claiming run B: refused.
    expect(
      authorizeProxiedRunAccess(
        factsB,
        jobA.run_id,
        jobA.actions.runner_id,
        jobA.actions.runner_generation,
      ),
    ).toBe("unauthorized");
    // Runner A's own identity for its own run, at its own generation: allowed.
    expect(
      authorizeProxiedRunAccess(
        factsA,
        jobA.run_id,
        jobA.actions.runner_id,
        jobA.actions.runner_generation,
      ),
    ).toBe("ok");
  });

  it("a legacy paired runner's connection and reconnect keep working, unaffected by Actions-hosted dispatch", async () => {
    stack = await buildStack(1, 2);

    // A legacy laptop runner (paired before POLISH P1 removed the pairing
    // front door) still holds a registered key and a state file. Reproduce
    // that state directly, as `test/helpers.ts`'s `startStack` does.
    const dataDir = mkdtempSync(join(tmpdir(), "norns-laptop-"));
    const laptopKeys = generateKeyPairSync("ed25519");
    const laptopRecord = stack.stores.registerRunner(
      "laptop-1",
      laptopKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    new RunnerStateFile(dataDir, {
      runner_id: "laptop-1",
      private_key_pem: laptopKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      generation: laptopRecord.generation,
    });
    const laptop = new RunnerDaemon({
      serverUrl: stack.url,
      runnerId: "laptop-1",
      dataDir,
      heartbeatMs: 250,
      reconnectDelayMs: 100,
    });
    laptop.loadState();
    laptop.connect();
    daemons.push(laptop);
    await waitFor(
      () => stack?.server.connectedRunners().includes("laptop-1") ?? false,
      "laptop paired",
    );

    // Schedule and connect an Actions-hosted dispatch in the SAME server
    // instance while the laptop stays connected.
    const jobA = await stack.actionsCoordinator.schedule(scheduleInputFor(1));
    const daemonA = await enrollAndConnect(stack, jobA.actions.runner_id, jobA.dispatch_job_id);
    daemons.push(daemonA);

    expect(laptop.isFenced).toBe(false);
    expect(stack.server.connectedRunners()).toContain("laptop-1");

    // Reconnect: drop the laptop's socket and confirm it comes back on its
    // own generation, unaffected by anything Actions-related.
    const generationBefore = laptop.generation;
    laptop.disconnectNow();
    await waitFor(
      () => stack?.server.connectedRunners().includes("laptop-1") ?? false,
      "laptop reconnected",
    );
    expect(laptop.isFenced).toBe(false);
    expect(laptop.generation).toBe(generationBefore);
  }, 20_000);
});
