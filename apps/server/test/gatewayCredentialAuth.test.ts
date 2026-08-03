// EXECUTION E9 — the credential mint route, driven by the REAL runner client.
//
// WHY THIS FILE EXISTS AT ALL, AND WHAT IT CAUGHT.
//
// The end-to-end tests run the real `buildServer`, the real Ed25519 keypair
// from a paired `RunnerDaemon`, and the real `ModelGatewayClient` shipped in
// `@norns/runner`. This prevents a test-only signer or verifier from drifting
// away from the shared nine-field transcript.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
  serializeSignedDeviceHttpTranscript,
} from "@norns/contracts";
import {
  GatewayCredentialError,
  ModelGatewayClient,
  RunnerDaemon,
  RunnerStateFile,
  RunnerVisualEvidenceUploader,
  devicePrivateKeySigner,
  privateKeySigner,
  signRunnerHttpRequest,
} from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { PostgresDeviceActionAuthorization } from "../src/devices/actionAuthorization.js";
import { DeviceRevocationService } from "../src/devices/revocation.js";
import {
  DeviceHttpRequestAuthenticator,
  PostgresDeviceHttpCredentialRepository,
} from "../src/execution/index.js";
import {
  GATEWAY_CREDENTIAL_ROUTE,
  GatewayCredentialService,
  type GatewaySurface,
  ProviderGateway,
  SqlGatewayCredentialStore,
  anthropicGatewayBaseUrl,
  deepSeekGatewayBaseUrl,
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
// The regression test proper — one serializer, shared by every HTTP surface.
// ---------------------------------------------------------------------------

describe("EXECUTION E9 — gateway uses the shared signed transcript", () => {
  it("binds all nine fields through the contracts serializer", () => {
    let captured = "";
    const body = JSON.stringify({ run_id: "run-1" });
    const timestamp = "2026-07-21T09:00:00.000Z";
    const requestId = "11111111-1111-4111-8111-111111111111";
    signRunnerHttpRequest({
      identity: {
        mode: "device",
        deviceId: "device-1",
        credentialId: "credential-1",
        generation: 7,
        sign: (payload) => {
          captured = payload;
          return "signed";
        },
      },
      purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
      method: "POST",
      url: new URL(`https://norns.example${GATEWAY_CREDENTIAL_ROUTE}?mode=task`),
      body,
      timestamp,
      requestId,
    });
    expect(captured).toBe(
      serializeSignedDeviceHttpTranscript({
        purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
        device_id: "device-1",
        credential_id: "credential-1",
        generation: 7,
        http_method: "POST",
        canonical_path_and_query: `${GATEWAY_CREDENTIAL_ROUTE}?mode=task`,
        body_sha256: createHash("sha256").update(body).digest("hex"),
        timestamp,
        request_id: requestId,
      }),
    );
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
  privateKeyPem: string;
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
    INSERT INTO users (
      id,username,display_name,email,name,password_hash,
      password_hash_scheme,role,status,source
    ) VALUES (
      'admin-1','admin@example.com','Admin','admin@example.com','Admin',
      'hash','scrypt-v1','admin','active','native'
    );
    INSERT INTO projects (
      id, name, description, status, assignment_policy_ref,
      verification_policy_ref, budget_policy_ref,owner_user_id
    ) VALUES (
      'project-1','Project One','','active','assignment','verification','budget','admin-1'
    );
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
      environment_policy_ref, verification_policy_ref, state, lifecycle_version,
      initiated_by_user_id
    ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
      'Slice','["change"]'::jsonb,'["verified"]'::jsonb,
      'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      '["commit"]'::jsonb,'environment','verification','pending',0,'admin-1');
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await pg.query(
    `INSERT INTO devices (
       id,owner_user_id,display_name,os_family,architecture,lifecycle,current_generation
     ) VALUES ($1,'admin-1','Gateway device','linux','x86_64','active',0)`,
    [runnerId],
  );
  await pg.query(
    `INSERT INTO device_credentials (
       id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
     ) VALUES (
       'gateway-device-credential',$1,1,$2,$3,'active'
     )`,
    [runnerId, publicKeyDer, createHash("sha256").update(publicKeyDer).digest("hex")],
  );
  await pg.query(
    `INSERT INTO device_repository_registrations (
       id,device_id,workspace_id,repository_id,repository_display_name,
       state,approved_by_user_id,approved_at,approved_credential_id,approved_generation
     ) VALUES (
       'gateway-registration',$1,'workspace-1','repository-1','Project One',
       'active','admin-1',now(),'gateway-device-credential',1
     )`,
    [runnerId],
  );
  await pg.query(
    `INSERT INTO project_device_repository_grants (
       id,project_id,repository_registration_id,state,granted_by_user_id
     ) VALUES (
       'gateway-grant','project-1','gateway-registration','active','admin-1'
     )`,
  );
  await pg.query(
    `INSERT INTO repository_bindings (
       id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
       repository_display_name,granted_permissions,default_branch,observed_head,
       verification_policy_ref,repository_health,created_by_actor_type,
       created_by_actor_id,project_device_repository_grant_id
     ) VALUES (
       'binding-1','project-1','local_runner','connected',NULL,'workspace-1',
       'repository-1','Project One','{}'::jsonb,'main','commit-1','verification',
       'healthy','human','admin-1','gateway-grant'
     )`,
  );
  await pg.query(
    "UPDATE projects SET primary_repository_binding_id='binding-1' WHERE id='project-1'",
  );

  const stores = new RelayStores();
  const users = new UserStore();
  const token = testAdminToken(users);
  const credentials = new GatewayCredentialService(new SqlGatewayCredentialStore(transactions));
  const runs = new SqlProxiedRunLookup(transactions);
  const runnerHttpAuthentication = new DeviceHttpRequestAuthenticator({
    repository: new PostgresDeviceHttpCredentialRepository(transactions),
    legacyCompatibility: {
      enabled: true,
      lookupRunner: (requestedRunnerId) => {
        const runner = stores.runner(requestedRunnerId);
        return runner
          ? {
              public_key_pem: runner.public_key_pem,
              generation: runner.generation,
            }
          : null;
      },
    },
  });
  const deviceActionAuthorization = {
    service: new PostgresDeviceActionAuthorization({ deviceDispatchEnabled: true }),
    transactions,
  };
  const server = await buildServer({
    stores,
    users,
    legacyGlobalRunnerCompatibility: { enabled: true },
    legacyLocalRunnerAuth: { enabled: true },
    // The gateway is composed by buildServer's own E9 section from these; only
    // the credential store is swapped so the test can inspect it.
    planningRuns: { transactions },
    execution: { transactions, baseUrl: "http://127.0.0.1" },
    gatewayCredentials: credentials,
    gatewayRuns: runs,
    runnerHttpAuthentication,
    deviceActionAuthorization,
    publicOrigin: "https://norns.example",
  });
  const origin = await listen(server);

  // A REAL registered identity: an Ed25519 keypair whose public half the
  // server records, exactly what Actions enrollment produces. (POLISH P1
  // removed the pairing HTTP front door, so the key is registered directly.)
  const dataDir = mkdtempSync(join(tmpdir(), "norns-e9-"));
  const registered = stores.registerRunner(
    runnerId,
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  new RunnerStateFile(dataDir, {
    runner_id: runnerId,
    private_key_pem: privateKeyPem,
    generation: registered.generation,
  });
  const daemon = new RunnerDaemon({
    serverUrl: origin,
    runnerId,
    dataDir,
    heartbeatMs: 500,
    reconnectDelayMs: 100,
  });
  daemon.loadState();
  daemon.connect();
  await waitFor(() => server.connectedRunners().includes(runnerId), "runner connected");

  const scheduled = await new Phase4Coordinator(transactions, {
    deviceAuthorization: new PostgresDeviceActionAuthorization({ deviceDispatchEnabled: true }),
  }).schedule({
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
    // Time-relative: a hardcoded window silently expires and the dispatch
    // stops being a live command (see actionsDispatchConcurrency.test.ts).
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  await transactions.transaction(async (sql) => {
    await sql.query(
      `UPDATE agent_runs
          SET initiated_by_user_id='admin-1',
              repository_binding_id='binding-1'
        WHERE id=$1`,
      [scheduled.run_id],
    );
    await sql.query(
      "UPDATE projects SET primary_repository_binding_id='binding-1' WHERE id='project-1'",
    );
  });

  return {
    server,
    origin,
    daemon,
    runId: scheduled.run_id,
    credentials,
    transactions,
    privateKeyPem,
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

  it("rejects a legacy HTTP subject for a grant-backed device run", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(stack.origin, {
      mode: "legacy_runner",
      runnerId: "runner-1",
      generation: stack.daemon.generation,
      // The key never leaves the daemon; only a signing capability is handed
      // out, exactly as the CLI does it.
      sign: (payload) => stack.daemon.sign(payload),
    });

    await expect(client.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a pre-existing legacy gateway token for a grant-backed device run", async () => {
    stack = await startStack();
    const run = await new SqlProxiedRunLookup(stack.transactions).lookup(stack.runId);
    if (!run) throw new Error("scheduled run missing");
    const legacy = await stack.credentials.mint(run, { subject: "legacy_runner" });
    const response = await fetch(`${anthropicGatewayBaseUrl(stack.origin)}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${legacy.token}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("x-norns-gateway-refusal")).toBe("unauthorized");
  });

  it("rejects a legacy visual-evidence upload for a grant-backed device run", async () => {
    stack = await startStack();
    const uploader = new RunnerVisualEvidenceUploader(stack.origin, {
      mode: "legacy_runner",
      runnerId: "runner-1",
      generation: stack.daemon.generation,
      sign: (payload) => stack.daemon.sign(payload),
    });
    const desktop = Buffer.from("desktop");
    const mobile = Buffer.from("mobile");
    await expect(
      uploader.upload(
        {
          schema_version: 2,
          approved_mockup_version_id: "mockup-approved",
          commit_sha: "a".repeat(40),
          capture_profile: {
            renderer: "playwright",
            browser_name: "chromium",
            browser_version: "123.0.0",
            font_revision: "b".repeat(64),
            pixel_ratio: 1,
            network: "application_only",
            locale: "en-US",
            timezone: "UTC",
            fixed_clock: "2026-07-30T12:00:00.000Z",
          },
          screenshots: [
            {
              viewport: "desktop",
              path: ".norns/visual-evidence/desktop-1440x1024.png",
              content_hash: createHash("sha256").update(desktop).digest("hex"),
              width: 1440,
              height: 1024,
              bytes: desktop,
            },
            {
              viewport: "mobile",
              path: ".norns/visual-evidence/mobile-390x844.png",
              content_hash: createHash("sha256").update(mobile).digest("hex"),
              width: 390,
              height: 844,
              bytes: mobile,
            },
          ],
        },
        {
          project_id: "project-1",
          work_item_id: "work-item-1",
          conversation_id: "conversation-1",
          phase_id: "phase-1",
          task_id: "task-1",
          run_id: stack.runId,
          repository_binding_id: "binding-1",
          verification_result_id: "verification-1",
          deployment_record_id: "deployment-1",
          deployment_observation_id: "observation-1",
          verified_at: "2026-07-30T12:00:00.000Z",
        },
      ),
    ).rejects.toThrow(/403/);
  });

  it("mints a device credential only through the current repository grant chain", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(
      stack.origin,
      devicePrivateKeySigner({
        deviceId: "runner-1",
        credentialId: "gateway-device-credential",
        generation: 1,
        privateKeyPem: stack.privateKeyPem,
      }),
    );
    const minted = await client.mint(stack.runId);
    expect(minted.deepseek_base_url).toBe(deepSeekGatewayBaseUrl("https://norns.example"));
    const resolved = await stack.credentials.resolve(minted.token);
    expect(resolved).toMatchObject({
      ok: true,
      credential: {
        authentication_subject: "device",
        device_credential_id: "gateway-device-credential",
      },
    });
  });

  it("rejects mint and provider use immediately after the device grant is revoked", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(
      stack.origin,
      devicePrivateKeySigner({
        deviceId: "runner-1",
        credentialId: "gateway-device-credential",
        generation: 1,
        privateKeyPem: stack.privateKeyPem,
      }),
    );
    const minted = await client.mint(stack.runId);
    await stack.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE project_device_repository_grants
            SET state='revoked',revoked_by_user_id='admin-1',
                revoked_at=now(),updated_at=now()
          WHERE id='gateway-grant'`,
      );
    });

    await expect(client.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
    const use = await fetch(`${anthropicGatewayBaseUrl(stack.origin)}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${minted.token}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(use.status).toBe(401);
    expect(use.headers.get("x-norns-gateway-refusal")).toBe("unauthorized");
  });

  it("commits device revocation while an authorized provider request is waiting for headers", async () => {
    stack = await startStack();
    const runs = new SqlProxiedRunLookup(stack.transactions);
    const run = await runs.lookup(stack.runId);
    if (!run) throw new Error("scheduled run missing");
    const minted = await stack.credentials.mint(run, {
      subject: "device",
      credential_id: "gateway-device-credential",
    });

    let releaseProvider!: (response: Response) => void;
    const providerHeaders = new Promise<Response>((resolve) => {
      releaseProvider = resolve;
    });
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const anthropicSurface: GatewaySurface = {
      provider: "anthropic",
      origin: "https://provider.invalid",
      paths: new Set(["/v1/models"]),
      meteredPaths: new Set(),
      authHeaders: (key) => ({ "x-api-key": key }),
    };
    const openAiSurface: GatewaySurface = {
      provider: "openai",
      origin: "https://provider.invalid",
      paths: new Set(["/v1/models"]),
      meteredPaths: new Set(),
      authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    };
    const deepSeekSurface: GatewaySurface = {
      provider: "deepseek",
      origin: "https://provider.invalid",
      paths: new Set(["/v1/models"]),
      meteredPaths: new Set(),
      authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    };
    const gateway = new ProviderGateway({
      runs,
      credentials: stack.credentials,
      deviceActionAuthorization: {
        service: new PostgresDeviceActionAuthorization({ deviceDispatchEnabled: true }),
        transactions: stack.transactions,
      },
      apiKey: () => "provider-key",
      fetchImpl: (async () => {
        markProviderStarted();
        return providerHeaders;
      }) as typeof fetch,
      surfaces: {
        anthropic: anthropicSurface,
        openai: openAiSurface,
        deepseek: deepSeekSurface,
      },
    });

    const forwarding = gateway.forward({
      provider: "anthropic",
      path: "/v1/models",
      query: "",
      method: "GET",
      headers: { authorization: `Bearer ${minted.token}` },
      body: new Uint8Array(),
    });
    await providerStarted;

    // The response headers are still withheld. This would deadlock (or make
    // PGlite reject a nested transaction) if `forward` kept assertRun's row
    // locks until the external fetch returned.
    const revocation = await new DeviceRevocationService(stack.transactions).revoke({
      device_id: "runner-1",
      revoked_by_user_id: "admin-1",
      reason: "Regression: revoke during withheld provider headers",
      revoked_at: new Date().toISOString(),
    });
    expect(revocation.record.affected_run_ids).toEqual([stack.runId]);

    releaseProvider(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await forwarding;
    expect(result.kind).toBe("forwarded");
    if (result.kind === "forwarded") {
      for await (const _chunk of result.body) {
        // Consume the body so the forwarding request reaches its terminal path.
      }
    }
  });

  it("refuses to mint for a run the caller was not dispatched", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(stack.origin, {
      mode: "legacy_runner",
      runnerId: "runner-1",
      generation: stack.daemon.generation,
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
      privateKeySigner(
        "runner-1",
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        1,
      ),
    );
    await expect(impostor.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a stale timestamp outside the replay window", async () => {
    stack = await startStack();
    const longAgo = new Date(Date.now() - 60 * 60_000);
    const client = new ModelGatewayClient(
      stack.origin,
      {
        mode: "legacy_runner",
        runnerId: "runner-1",
        generation: stack.daemon.generation,
        sign: (payload) => stack.daemon.sign(payload),
      },
      () => longAgo,
    );
    await expect(client.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses the current key when it claims a stale or future generation", async () => {
    stack = await startStack();
    const client = new ModelGatewayClient(stack.origin, {
      mode: "legacy_runner",
      runnerId: "runner-1",
      generation: stack.daemon.generation + 1,
      sign: (payload) => stack.daemon.sign(payload),
    });
    await expect(client.mint(stack.runId)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a valid signature when the transmitted body changes", async () => {
    stack = await startStack();
    const body = JSON.stringify({ run_id: stack.runId });
    const signed = signRunnerHttpRequest({
      identity: {
        mode: "legacy_runner",
        runnerId: "runner-1",
        generation: stack.daemon.generation,
        sign: (payload) => stack.daemon.sign(payload),
      },
      purpose: DEVICE_GATEWAY_CREDENTIAL_MINT_HTTP_SIGNATURE_PURPOSE,
      method: "POST",
      url: new URL(`${stack.origin}${GATEWAY_CREDENTIAL_ROUTE}`),
      body,
      timestamp: new Date().toISOString(),
    });
    const response = await fetch(`${stack.origin}${GATEWAY_CREDENTIAL_ROUTE}`, {
      method: "POST",
      headers: {
        ...signed.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ run_id: "different-run" }),
    });
    expect(response.status).toBe(401);
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
    const client = new ModelGatewayClient(
      stack.origin,
      devicePrivateKeySigner({
        deviceId: "runner-1",
        credentialId: "gateway-device-credential",
        generation: 1,
        privateKeyPem: stack.privateKeyPem,
      }),
    );
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

    const stores = new RelayStores();
    const runnerHttpAuthentication = new DeviceHttpRequestAuthenticator({
      repository: new PostgresDeviceHttpCredentialRepository(transactions),
      legacyCompatibility: { enabled: false },
    });
    // Exactly the production composition inputs: relational transactions,
    // runner HTTP authentication, and the public origin.
    const server = await buildServer({
      stores,
      users: new UserStore(),
      planningRuns: { transactions },
      runnerHttpAuthentication,
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
      expect(columns).toContain("authentication_subject");
      expect(columns).toContain("device_credential_id");
      expect(columns).not.toContain("token");
    } finally {
      await server.app.close();
      await pg.close();
    }
  });
});
