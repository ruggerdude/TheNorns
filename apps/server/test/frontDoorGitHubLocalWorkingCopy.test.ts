import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { RunnerDaemon, WorkspaceRegistry } from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubIntegrationService,
  GitHubRepositorySummary,
} from "../src/integrations/github.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RelationalProjectReadRepository } from "../src/projects/relationalReadRepository.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

const HEAD = "9f2b7c1a4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a";

function repository(): GitHubRepositorySummary {
  return {
    id: "9002",
    connection_id: "github:42",
    owner: "acme",
    name: "fresh-app",
    full_name: "acme/fresh-app",
    private: true,
    default_branch: "main",
    html_url: "https://github.com/acme/fresh-app",
    clone_url: "https://github.com/acme/fresh-app.git",
    description: "Fresh application",
    language: null,
    archived: false,
    updated_at: "2026-07-27T12:00:00.000Z",
  };
}

describe.sequential("Front Door GitHub + this computer creation", () => {
  let pg: PGlite;
  let server: NornsServer;
  let daemon: RunnerDaemon;
  let deviceDaemon: RunnerDaemon;
  let url: string;
  let token: string;
  let parent: string;
  let cloneTokenSeen: string | null;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(
      "CREATE ROLE norns_app NOLOGIN; CREATE TABLE norns_state (key TEXT PRIMARY KEY, snapshot JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());",
    );
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO service_connections (
        id, provider, display_name, owner_type, owner_login,
        external_account_id, installation_id, repository_selection,
        connected_by_user_id
      ) VALUES (
        'github:42','github','acme','organization','acme',
        'account-42','42','all','admin-1'
      );
    `);
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    let created = false;
    const repo = repository();
    const github = {
      listRepositories: vi.fn(async () => (created ? [repo] : [])),
      createRepository: vi.fn(async () => {
        created = true;
        return {
          ...repo,
          binding_ready: true,
          installation: {
            ready: true,
            reason: "ready",
            repository_selection: "all",
            installation_id: "42",
            action_required: null,
            manage_installation_url: "https://github.com/settings/installations/42",
          },
        };
      }),
      installationReadiness: vi.fn(async () => ({
        ready: true,
        reason: "ready",
        repository_selection: "all",
        installation_id: "42",
        action_required: null,
        manage_installation_url: "https://github.com/settings/installations/42",
      })),
      resolveRepository: vi.fn(async () => repo),
      repositoryHead: vi.fn(async () => HEAD),
      localCloneCredential: vi.fn(async () => ({
        repository: repo,
        token: "one-use-clone-token",
      })),
    } as unknown as GitHubIntegrationService;
    const sourceBindings = new SourceBindingService(transactions);
    const ingestion = new RepositoryIngestionService(transactions);
    const phases = new PhaseWorkflowService(transactions);
    const strategies = new StrategyWorkflowService(transactions);
    const deviceProjection = {
      device_id: "device-local",
      owner_user_id: "admin-1",
      name: "Test Mac",
      location_label: "Test desk",
      os_family: "macos" as const,
      os_version: "15.5",
      lifecycle: "active" as const,
      status: {
        availability: "online" as const,
        compatibility: "ready" as const,
        workload: "idle" as const,
        access: "owned" as const,
      },
      last_seen_at: "2026-07-30T12:00:00.000Z",
      active_credential: {
        device_id: "device-local",
        credential_id: "credential-local",
        generation: 1,
        public_key_fingerprint: "a".repeat(64),
        state: "active" as const,
        activated_at: "2026-07-30T12:00:00.000Z",
      },
      agent: {
        version: "0.4.0",
        protocol_version: "1",
        capabilities: [
          "device_control",
          "repository_access",
          "workspace_picker",
          "workspace_repository_inventory",
          "workspace_clone",
          "workspace_delete",
        ],
      },
      repository_grants: [],
      activity: { active_run_count: 0, queued_command_count: 0 },
    };
    const deviceRepositoryService = {
      grantRepository: vi.fn(async ({ project_id }: { project_id: string }) => ({
        grant_id: "grant-local",
        project_id,
        repository_registration_id: "registration-local",
        state: "active" as const,
      })),
      selectProjectExecutionTarget: vi.fn(async ({ project_id }: { project_id: string }) => {
        await sourceBindings.createLocal(
          {
            project_id,
            runner_id: "device-local",
            workspace_id: "workspace-device",
            repository_id: "repository-device",
            repository_display_name: "fresh-app",
            default_branch: "main",
            observed_head: HEAD,
            verification_policy_ref: "verification",
            created_by: { actor_type: "human", actor_id: "admin-1" },
          },
          { makePrimary: true },
        );
        return {
          schema_version: 1 as const,
          project_id,
          viewer_role: "owner" as const,
          selected_execution_target_id: "grant-local",
          work_active: false,
          legacy_claim_required: false,
          execution_targets: [
            {
              project_id,
              execution_target_id: "grant-local",
              name: "Test Mac",
              location_label: "Test desk",
              os_family: "macos" as const,
              status: {
                availability: "online" as const,
                compatibility: "ready" as const,
                workload: "idle" as const,
                access: "shared" as const,
              },
              last_seen_at: "2026-07-30T12:00:00.000Z",
            },
          ],
        };
      }),
    };
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new RelationalProjectReadRepository(transactions, "github-local-test"),
      integrations: { github },
      onboarding: { transactions },
      legacyPairingRoutes: { enabled: true },
      legacyHelperRoutes: { enabled: true },
      legacyLocalRunnerAuth: { enabled: true },
      deviceManagement: {
        service: {
          listOwnedDevices: async () => [deviceProjection],
          getOwnedDevice: async () => deviceProjection,
          renameOwnedDevice: async () => deviceProjection,
          revokeOwnedDevice: async () => deviceProjection,
        },
      },
      deviceWssAuthentication: {
        supportedProtocolVersions: ["1"],
        authenticate: async (request) => ({
          device_id: request.device_id,
          owner_user_id: "admin-1",
          credential_id: request.credential_id,
          generation: request.generation,
          protocol_version: request.protocol_version,
        }),
        verifyCancellationEvidence: async () => false,
      },
      deviceRepositoryAccess: {
        service: deviceRepositoryService as never,
        publicationPermits: {} as never,
        runnerAuthentication: {} as never,
      },
      phase3: {
        sourceBindings,
        ingestion,
        phases,
        strategies,
        bridge: new StrategyBridgeService({ transactions, phases, strategies }),
        resume: new ProjectResumeService(transactions),
      },
    });
    url = await listen(server);

    const sourceRoot = mkdtempSync(join(tmpdir(), "norns-github-local-source-"));
    const source = join(sourceRoot, "source");
    mkdirSync(source);
    execFileSync("git", ["-C", source, "init", "-b", "main"]);
    execFileSync("git", ["-C", source, "config", "user.email", "test@norns.invalid"]);
    execFileSync("git", ["-C", source, "config", "user.name", "Norns Test"]);
    writeFileSync(join(source, "README.md"), "fresh application\n");
    execFileSync("git", ["-C", source, "add", "README.md"]);
    execFileSync("git", ["-C", source, "commit", "-m", "initial"]);
    parent = mkdtempSync(join(tmpdir(), "norns-github-local-parent-"));
    cloneTokenSeen = null;

    const dataDir = mkdtempSync(join(tmpdir(), "norns-github-local-helper-"));
    const pairing = (await (
      await fetch(`${url}/api/pairing/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { code: string };
    daemon = new RunnerDaemon({
      serverUrl: url,
      runnerId: "runner-local",
      dataDir,
      workspaces: new WorkspaceRegistry(
        dataDir,
        async () => parent,
        async ({ cloneUrl, target, token: cloneToken }) => {
          cloneTokenSeen = cloneToken;
          execFileSync("git", ["clone", "--", source, target]);
          execFileSync("git", ["-C", target, "remote", "set-url", "origin", cloneUrl]);
        },
      ),
      heartbeatMs: 250,
      reconnectDelayMs: 50,
    });
    await daemon.pair(pairing.code);
    daemon.connect();
    await waitFor(() => server.connectedRunners().includes("runner-local"), "local helper");

    const deviceDataDir = mkdtempSync(join(tmpdir(), "norns-github-device-helper-"));
    deviceDaemon = new RunnerDaemon({
      serverUrl: url,
      runnerId: "unused-device-runner",
      dataDir: deviceDataDir,
      workspaces: new WorkspaceRegistry(
        deviceDataDir,
        async () => parent,
        async ({ cloneUrl, target, token: cloneToken }) => {
          cloneTokenSeen = cloneToken;
          execFileSync("git", ["clone", "--", source, target]);
          execFileSync("git", ["-C", target, "remote", "set-url", "origin", cloneUrl]);
        },
      ),
      registerWorkspace: async () => ({ registration_id: "registration-local" }),
      heartbeatMs: 250,
      reconnectDelayMs: 50,
      deviceControl: {
        identity: {
          device_id: "device-local",
          credential_id: "credential-local",
          generation: 1,
        },
        sign: () => "test-signature",
        capabilities: deviceProjection.agent.capabilities,
      },
    });
    deviceDaemon.start();
    await waitFor(() => server.connectedRunners().includes("device-local"), "enrolled computer");
  }, 30_000);

  afterEach(async () => {
    daemon?.stop();
    deviceDaemon?.stop();
    await server?.app.close();
    if (pg && !pg.closed) await pg.close();
  });

  it("creates the remote, clones locally, and routes execution to the local binding", async () => {
    const response = await fetch(`${url}/api/v2/projects/onboarding`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scenario: "new_repo",
        name: "Fresh app",
        description: "Build a fresh application",
        pm_provider: "anthropic",
        pm_model: "claude-sonnet-5",
        connection_id: "github:42",
        idempotency_key: "github-local-working-copy",
        repository_name: "fresh-app",
        private: true,
        local_working_copy: true,
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      project_id: string;
      execution_location: string;
      workspace: { kind: string; display_name: string };
      remote: { kind: string; display_name: string };
      local_working_copy: { status: string };
    };
    expect(body).toMatchObject({
      execution_location: "local",
      workspace: { kind: "local_runner", display_name: "fresh-app" },
      remote: { kind: "github", display_name: "acme/fresh-app" },
      local_working_copy: { status: "ready" },
    });
    expect(existsSync(join(parent, "fresh-app", ".git"))).toBe(true);
    expect(cloneTokenSeen).toBe("one-use-clone-token");
    expect(JSON.stringify(body)).not.toContain(parent);
    expect(JSON.stringify(body)).not.toContain("one-use-clone-token");

    const binding = await pg.query<{ binding_type: string; role: string }>(
      `SELECT binding.binding_type, binding.role
       FROM projects project
       JOIN repository_bindings binding
         ON binding.id = project.primary_repository_binding_id
       WHERE project.id = $1`,
      [body.project_id],
    );
    expect(binding.rows).toEqual([{ binding_type: "local_runner", role: "workspace" }]);
    const remote = await pg.query<{ binding_type: string; role: string }>(
      `SELECT binding_type, role
       FROM repository_bindings
       WHERE project_id = $1 AND role = 'remote' AND status = 'connected'`,
      [body.project_id],
    );
    expect(remote.rows).toEqual([{ binding_type: "github", role: "remote" }]);
  });

  it("targets the exact enrolled computer without using a global helper lookup", async () => {
    const response = await fetch(`${url}/api/v2/projects/onboarding`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scenario: "new_repo",
        name: "Fresh app",
        description: "",
        pm_provider: "anthropic",
        pm_model: "claude-sonnet-5",
        connection_id: "github:42",
        idempotency_key: "github-device-working-copy",
        repository_name: "fresh-app",
        private: true,
        local_working_copy: true,
        computer_id: "device-local",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      execution_location: "local",
      workspace: { kind: "local_runner", display_name: "fresh-app" },
      local_working_copy: { status: "ready" },
    });
    expect(existsSync(join(parent, "fresh-app", ".git"))).toBe(true);
    expect(cloneTokenSeen).toBe("one-use-clone-token");
  });
});
