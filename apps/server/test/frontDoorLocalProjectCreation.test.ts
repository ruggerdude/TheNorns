import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter } from "@norns/adapters";
import { RunnerDaemon, WorkspaceRegistry } from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RelationalProjectReadRepository } from "../src/projects/relationalReadRepository.js";
import { RepositoryAnalysisService } from "../src/projects/repositoryAnalysisService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

describe.sequential("Front Door secure local-folder creation", () => {
  let pg: PGlite;
  let server: NornsServer;
  let daemon: RunnerDaemon;
  let url: string;
  let token: string;
  let repository: string;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(
      "CREATE ROLE norns_app NOLOGIN; CREATE TABLE norns_state (key TEXT PRIMARY KEY, snapshot JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());",
    );
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    adapter = new FakeAdapter("anthropic");
    const ingestion = new RepositoryIngestionService(transactions);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new RelationalProjectReadRepository(transactions, "secure-local-test"),
      phase3: {
        sourceBindings: new SourceBindingService(transactions),
        ingestion,
        phases: new PhaseWorkflowService(transactions),
        strategies: new StrategyWorkflowService(transactions),
        bridge: new StrategyBridgeService({
          transactions,
          phases: new PhaseWorkflowService(transactions),
          strategies: new StrategyWorkflowService(transactions),
        }),
        resume: new ProjectResumeService(transactions),
      },
      repositoryAnalysis: new RepositoryAnalysisService({
        transactions,
        github: null,
        ingestion,
        createAdapter: () => adapter,
      }),
    });
    url = await listen(server);

    repository = join(mkdtempSync(join(tmpdir(), "norns-local-repo-")), "secret-app");
    mkdirSync(repository);
    execFileSync("git", ["-C", repository, "init", "-b", "main"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@norns.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
    writeFileSync(join(repository, "README.md"), "secure local test\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

    const dataDir = mkdtempSync(join(tmpdir(), "norns-local-helper-"));
    const pairing = (await (
      await fetch(`${url}/api/pairing/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as {
      code: string;
      pairing_uri: string;
      downloads: { windows: string | null; macos: string | null };
    };
    expect(pairing.pairing_uri).toMatch(/^norns-agent:\/\/pair\?/);
    expect(pairing.downloads).toEqual({ windows: null, macos: null });
    daemon = new RunnerDaemon({
      serverUrl: url,
      runnerId: "runner-local",
      dataDir,
      workspaces: new WorkspaceRegistry(dataDir, async () => repository),
      heartbeatMs: 250,
      reconnectDelayMs: 50,
    });
    await daemon.pair(pairing.code);
    daemon.connect();
    await waitFor(() => server.connectedRunners().includes("runner-local"), "local helper");
  });

  afterEach(async () => {
    daemon?.stop();
    await server?.app.close();
    if (pg && !pg.closed) await pg.close();
  });

  const api = (path: string, init?: RequestInit) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

  it("chooses, creates, binds, and reopens a local project without exposing its path", async () => {
    const status = await api("/api/runners/helper/status");
    expect(await status.json()).toMatchObject({
      state: "connected",
      runner_id: "runner-local",
    });

    const chosen = await api("/api/runners/helper/repositories/choose", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(chosen.status).toBe(200);
    const selection = (await chosen.json()) as {
      selection_token: string;
      repository: { repository_display_name: string };
    };
    expect(selection.repository.repository_display_name).toBe("secret-app");
    expect(JSON.stringify(selection)).not.toContain(repository);

    const inventoryResponse = await api("/api/runners/helper/repositories");
    expect(inventoryResponse.status).toBe(200);
    const inventory = (await inventoryResponse.json()) as {
      repositories: Array<{
        selection_token: string;
        repository: { repository_display_name: string };
      }>;
    };
    expect(inventory.repositories).toHaveLength(1);
    expect(inventory.repositories[0]?.repository.repository_display_name).toBe("secret-app");
    expect(JSON.stringify(inventory)).not.toContain(repository);

    const created = await api("/api/v2/projects/local", {
      method: "POST",
      body: JSON.stringify({
        name: "Local app",
        description: "Continue the selected repository",
        pm_provider: "anthropic",
        pm_model: "claude-sonnet-5",
        selection_token: inventory.repositories[0]?.selection_token,
        verification_policy_ref: "verification",
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "Local app",
      source_type: "local",
      source_location: "secret-app",
    });

    const projectId = ((await (await api("/api/projects")).json()) as Array<{ id: string }>)[0]?.id;
    expect(projectId).toBeTruthy();
    const resume = await api(`/api/v2/projects/${projectId}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.body).not.toContain(repository);
    expect(await resume.json()).toMatchObject({
      repositories: [
        {
          binding_type: "local_runner",
          display_name: "secret-app",
          status: "connected",
          health: "healthy",
        },
      ],
    });

    adapter.enqueue({
      title: "Local app architecture",
      summary: "A local repository analyzed from its committed revision.",
      architecture_document: "# Architecture\n\nA small local project.",
      repository_facts: [
        { key: "readme", value: "README.md is present", confidence: 0.99 },
        { key: "verification", value: "Repository has committed source", confidence: 0.9 },
      ],
      constraints: ["Use committed repository content"],
    });
    const analyzed = await api(`/api/v2/projects/${projectId}/analyze-repository`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(analyzed.status).toBe(200);
    expect(await analyzed.json()).toMatchObject({
      title: "Local app architecture",
      repository_revision: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(adapter.requests[0]?.prompt).toContain("secure local test");
    expect(adapter.requests[0]?.prompt).not.toContain(repository);

    const reused = await api("/api/v2/projects/local", {
      method: "POST",
      body: JSON.stringify({
        name: "Replay",
        description: "Must not reuse selection",
        pm_provider: "anthropic",
        pm_model: "claude-sonnet-5",
        selection_token: inventory.repositories[0]?.selection_token,
      }),
    });
    expect(reused.status).toBe(409);
  });

  it("rejects raw browser filesystem paths and never persists them", async () => {
    const attempted = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Unsafe",
        description: "Raw path",
        pm_provider: "anthropic",
        source_type: "local",
        source_location: repository,
      }),
    });
    expect(attempted.status).toBe(400);
    const candidates = await pg.query(
      "SELECT id FROM repository_binding_candidates WHERE display_name = $1",
      ["secret-app"],
    );
    expect(candidates.rows).toEqual([]);
  });
});
