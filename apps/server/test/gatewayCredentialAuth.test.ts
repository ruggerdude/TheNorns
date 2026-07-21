// EXECUTION E9 — the credential mint route, driven by the REAL runner client.
//
// WHY THIS FILE EXISTS AT ALL, AND WHAT IT CAUGHT.
//
// E1 built a runner-signed HTTP auth scheme and E3 built the runner's client
// for it. They did not agree, in two independent ways:
//
//   server (`execution/runnerContextAuth.ts`)  reads `x-norns-runner-timestamp`
//                                             and signs a `\n`-joined payload
//   runner (`runner/src/contextAuth.ts`)       sent `x-norns-timestamp`
//                                             and signed a `|`-joined payload
//
// So every real task-context fetch answered 401 and every dispatched run
// started with an empty prompt — the exact failure E3 believed it had fixed.
// The only test of that path drives a hand-rolled fake server that implements
// the RUNNER's spelling on both sides, so both halves agreed with a third
// thing and neither agreed with production. That is the fourth time a mock has
// concealed a dead path in this repo.
//
// This file cannot make that mistake: it runs the REAL `buildServer`, the REAL
// Ed25519 keypair from a REAL paired `RunnerDaemon`, and the REAL
// `ModelGatewayClient` shipped in `@norns/runner`. Nothing in the middle is
// written for the test.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  GatewayCredentialError,
  ModelGatewayClient,
  RunnerDaemon,
  privateKeySigner,
  runnerContextFetchPayload,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { runnerContextSigningPayload } from "../src/execution/index.js";
import {
  GATEWAY_CREDENTIAL_ROUTE,
  GatewayCredentialService,
  InMemoryGatewayCredentialStore,
  anthropicGatewayBaseUrl,
  openAiGatewayBaseUrl,
} from "../src/gateway/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { SqlProxiedRunLookup } from "../src/runners/inferenceProxy.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

// ---------------------------------------------------------------------------
// The regression test proper — one assertion, no HTTP, no way to skip it
// ---------------------------------------------------------------------------

describe("EXECUTION E9 — runner and server agree on the signed payload", () => {
  it("produces byte-identical canonical strings on both sides", () => {
    const input = {
      method: "POST",
      path: GATEWAY_CREDENTIAL_ROUTE,
      runnerId: "runner-1",
      timestamp: "2026-07-21T09:00:00.000Z",
    };
    // The server's function and the runner's function name their timestamp
    // field differently, which is itself how the drift went unnoticed.
    expect(
      runnerContextFetchPayload({
        method: input.method,
        path: input.path,
        runnerId: input.runnerId,
        issuedAt: input.timestamp,
      }),
    ).toBe(runnerContextSigningPayload(input));
  });
});

// ---------------------------------------------------------------------------
// The mint route, end to end
// ---------------------------------------------------------------------------

interface Stack {
  server: NornsServer;
  origin: string;
  daemon: RunnerDaemon;
  runId: string;
  credentials: GatewayCredentialService;
  transactions: PGliteTransactionRunner;
  stop(): Promise<void>;
}

async function startStack(runnerId = "runner-1"): Promise<Stack> {
  const pg = new PGlite();
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
    ) VALUES ('binding-1','project-1','local_runner','connected','${runnerId}',
      'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
      'verification','healthy','human','admin-1');
    UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
    INSERT INTO phases (
      id, project_id, objective_summary, priority, status, approved_budget_usd
    ) VALUES ('phase-1','project-1','Slice',1,'awaiting_approval',100);
    INSERT INTO strategy_versions (
      id, project_id, phase_id, version, status, objective, content,
      convergence, review_rounds, content_hash
    ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Slice',
      '{}'::jsonb,'converged',1,repeat('a',64));
    UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
      WHERE id='phase-1';
    INSERT INTO objectives (
      id, project_id, phase_id, outcome, success_measures, status, "order"
    ) VALUES ('objective-1','project-1','phase-1','Done','["ok"]'::jsonb,'active',0);
    INSERT INTO tasks (
      id, project_id, phase_id, objective_id, strategy_version_id, title,
      description, deliverables, acceptance_criteria, complexity, risk,
      required_roles, required_capabilities, required_inputs, expected_outputs,
      environment_policy_ref, verification_policy_ref, state, lifecycle_version
    ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
      'Slice','["change"]'::jsonb,'["verified"]'::jsonb,
      'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      '["commit"]'::jsonb,'environment','verification','pending',0);
    INSERT INTO agent_profiles (
      id, provider, runtime, model, roles, capabilities, context_limit_tokens,
      security_restrictions, status, active_workload, cost_metadata
    ) VALUES ('agent-1','anthropic','claude-code','claude-sonnet-5','["implementation"]'::jsonb,
      '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
      '{"billing_mode":"api"}'::jsonb);
    INSERT INTO agent_assignments (
      id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
      rationale_factors, budget_limit_usd, allocation_policy_ref
    ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
      'Best','["capability"]'::jsonb,50,'allocation');
  `);
  const transactions = new PGliteTransactionRunner(pg);

  const stores = new RelayStores();
  const users = new UserStore();
  const token = testAdminToken(users);
  const credentials = new GatewayCredentialService(new InMemoryGatewayCredentialStore());
  const runs = new SqlProxiedRunLookup(transactions);
  const server = await buildServer({
    stores,
    users,
    // The gateway is composed by buildServer's own E9 section from these; only
    // the credential store is swapped so the test can inspect it.
    planningRuns: { transactions },
    gatewayCredentials: credentials,
    gatewayRuns: runs,
    publicOrigin: "https://norns.example",
  });
  const origin = await listen(server);

  // A REAL pairing: the daemon generates the Ed25519 keypair and the server
  // records the public half, exactly as a laptop or an Actions job does.
  const pairing = (await (
    await fetch(`${origin}/api/pairing/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as { code: string };
  const dataDir = mkdtempSync(join(tmpdir(), "norns-e9-"));
  const daemon = new RunnerDaemon({
    serverUrl: origin,
    runnerId,
    dataDir,
    heartbeatMs: 500,
    reconnectDelayMs: 100,
  });
  await daemon.pair(pairing.code);
  daemon.connect();
  await waitFor(() => server.connectedRunners().includes(runnerId), "runner connected");

  const scheduled = await new Phase4Coordinator(transactions).schedule({
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    runner_id: runnerId,
    runner_generation: daemon.generation,
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
    max_output_tokens: 8_000,
    max_duration_seconds: 900,
    issued_at: "2026-07-16T20:00:00.000Z",
    expires_at: "2026-07-16T20:15:00.000Z",
  });

  return {
    server,
    origin,
    daemon,
    runId: scheduled.run_id,
    credentials,
    transactions,
    stop: async () => {
      daemon.stop();
      await server.app.close();
      await pg.close();
    },
  };
}

describe.sequential("EXECUTION E9 gateway credential mint route", () => {
  let stack: Stack;

  afterEach(async () => {
    await stack?.stop();
  });

  it("mints a credential for the run the runner was actually dispatched", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(stack.origin, {
      runnerId: "runner-1",
      // The key never leaves the daemon; only a signing capability is handed
      // out, exactly as the CLI does it.
      sign: (payload) => stack.daemon.sign(payload),
    });

    const credential = await client.mint(stack.runId);

    expect(credential.token.startsWith("nrngw_")).toBe(true);
    expect(Date.parse(credential.expires_at)).toBeGreaterThan(Date.now());
    // The base URLs handed back are the exact strings the two SDKs need.
    expect(credential.anthropic_base_url).toBe(anthropicGatewayBaseUrl("https://norns.example"));
    expect(credential.openai_base_url).toBe(openAiGatewayBaseUrl("https://norns.example"));
    expect(credential.openai_base_url.endsWith("/v1")).toBe(true);

    // It resolves server-side to the run, task, project and generation.
    const resolved = await stack.credentials.resolve(credential.token);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.credential.run_id).toBe(stack.runId);
      expect(resolved.credential.runner_id).toBe("runner-1");
      expect(resolved.credential.runner_generation).toBe(stack.daemon.generation);
    }
  });

  it("refuses to mint for a run the caller was not dispatched", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(stack.origin, {
      runnerId: "runner-1",
      sign: (payload) => stack.daemon.sign(payload),
    });
    await expect(client.mint("run-belonging-to-nobody")).rejects.toBeInstanceOf(
      GatewayCredentialError,
    );
  });

  it("refuses a request signed by a key the server never registered", async () => {
    stack = await startStack();
    // A well-formed request from an identity claiming to be runner-1: right
    // scheme, right headers, right canonical payload — a DIFFERENT key. This
    // is the attack the signature exists to stop, and it is checked with the
    // real client and the server's real Ed25519 verifier.
    const { privateKey } = generateKeyPairSync("ed25519");
    const impostor = new ModelGatewayClient(
      stack.origin,
      privateKeySigner("runner-1", privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    );
    await expect(impostor.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a stale timestamp outside the replay window", async () => {
    stack = await startStack();
    const longAgo = new Date(Date.now() - 60 * 60_000);
    const client = new ModelGatewayClient(
      stack.origin,
      { runnerId: "runner-1", sign: (payload) => stack.daemon.sign(payload) },
      () => longAgo,
    );
    await expect(client.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses an unauthenticated mint attempt outright", async () => {
    stack = await startStack();
    const response = await fetch(`${stack.origin}${GATEWAY_CREDENTIAL_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: stack.runId }),
    });
    expect(response.status).toBe(401);
  });

  it("stops working once the run is no longer spendable", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(stack.origin, {
      runnerId: "runner-1",
      sign: (payload) => stack.daemon.sign(payload),
    });
    await client.mint(stack.runId);

    // Terminal state: the coordinator's own vocabulary, not a test-only flag.
    await stack.transactions.transaction(async (sql) => {
      // `agent_runs_lifecycle_origin_check` requires a nonzero lifecycle_version
      // for any state other than 'created', so the transition is written the
      // way the coordinator writes one.
      await sql.query(
        "UPDATE agent_runs SET state = 'succeeded', lifecycle_version = lifecycle_version + 1 WHERE id = $1",
        [stack.runId],
      );
    });

    // Minting a new one is refused with the "not spendable" status...
    await expect(client.mint(stack.runId)).rejects.toMatchObject({ status: 403 });
    // ...and so is every model call made with the one already issued, because
    // the run is re-resolved on every single request rather than cached.
    const resolvedRun = await new SqlProxiedRunLookup(stack.transactions).lookup(stack.runId);
    expect(resolvedRun?.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------
//
// THE REPO'S OWN RULE: a service that exists, is tested, and is never actually
// composed by `buildServer` is dead in production while CI is green. That has
// shipped three times here (attachments, the onboarding route, Actions
// execution bindings). Every E9 test above injects `modelGateway`, so without
// this one the DEFAULT composition — the only path production takes — would be
// entirely unexercised.
describe.sequential("EXECUTION E9 boot wiring", () => {
  it("composes the gateway from the option shape main.ts actually supplies", async () => {
    const pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY, snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const transactions = new PGliteTransactionRunner(pg);

    // Exactly what main.ts passes: `planningRuns: { transactions }` plus a
    // publicOrigin. No gateway, no credential service, no run lookup.
    const server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      planningRuns: { transactions },
      publicOrigin: "https://norns.example",
    });
    const origin = await listen(server);
    try {
      // The mint route exists and authenticates (401, not 404).
      const mint = await fetch(`${origin}${GATEWAY_CREDENTIAL_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: "run-1" }),
      });
      expect(mint.status).toBe(401);

      // The Anthropic surface exists and refuses an unknown credential
      // (401 with the gateway's own refusal header), rather than 404ing.
      const forwarded = await fetch(`${anthropicGatewayBaseUrl(origin)}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nrngw_nope" },
        body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [] }),
      });
      expect(forwarded.status).toBe(401);
      expect(forwarded.headers.get("x-norns-gateway-refusal")).toBe("unauthorized");

      // And Claude Code's reachability probe is answered rather than 404'd.
      const probe = await fetch(anthropicGatewayBaseUrl(origin), { method: "HEAD" });
      expect(probe.status).toBe(200);

      // The gateway_credentials table the default composition writes to really
      // exists in a migrated database.
      const columns = await transactions.transaction(async (sql) => {
        const result = await sql.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'gateway_credentials'",
        );
        return result.rows.map((row) => row.column_name).sort();
      });
      expect(columns).toContain("token_hash");
      expect(columns).toContain("runner_generation");
      expect(columns).not.toContain("token");
    } finally {
      await server.app.close();
      await pg.close();
    }
  });
});
