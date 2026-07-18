import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { RunnerDaemon, WorkspaceRegistry } from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

describe.sequential("runner-owned local folder API", () => {
  let pg: PGlite;
  let server: NornsServer;
  let daemon: RunnerDaemon;
  let token: string;
  let url: string;
  let root: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(
      "CREATE ROLE norns_app NOLOGIN; CREATE TABLE norns_state (key TEXT PRIMARY KEY, snapshot JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());",
    );
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.query(
      `INSERT INTO projects (id,name,description,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref) VALUES ('project-1','Project One','Persistent project','active','assignment','verification','budget')`,
    );
    const users = new UserStore();
    token = testAdminToken(users);
    const transactions = new PGliteTransactionRunner(pg);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase3: {
        sourceBindings: new SourceBindingService(transactions),
        ingestion: new RepositoryIngestionService(transactions),
        phases: new PhaseWorkflowService(transactions),
        strategies: new StrategyWorkflowService(transactions),
        resume: new ProjectResumeService(transactions),
      },
    });
    url = await listen(server);
    root = mkdtempSync(join(tmpdir(), "norns-local-root-"));
    const repository = join(root, "project-a");
    mkdirSync(repository);
    execFileSync("git", ["-C", repository, "init", "-b", "main"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@norns.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
    writeFileSync(join(repository, "README.md"), "test\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
    const dataDir = mkdtempSync(join(tmpdir(), "norns-local-runner-"));
    const registry = new WorkspaceRegistry(dataDir);
    registry.addWorkspace(root, "Projects");
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
      workspaces: registry,
      heartbeatMs: 500,
      reconnectDelayMs: 50,
    });
    await daemon.pair(pairing.code);
    daemon.connect();
    await waitFor(() => server.connectedRunners().includes("runner-local"), "runner connected");
  });

  afterEach(async () => {
    daemon?.stop();
    await server?.app.close();
    await pg?.close();
  });

  const api = (path: string, init?: RequestInit) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });

  it("mints a one-time selection from runner-only metadata and binds it", async () => {
    const rawPathAttempt = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Unsafe local project",
        description: "Must use runner selection",
        pm_provider: "anthropic",
        source_type: "local",
        source_location: root,
      }),
    });
    expect(rawPathAttempt.status).toBe(400);
    expect(JSON.stringify(await rawPathAttempt.json())).not.toContain(root);

    const workspaces = await api("/api/runners/runner-local/workspaces");
    expect(workspaces.status).toBe(200);
    const workspace = ((await workspaces.json()) as { workspaces: { workspace_id: string }[] })
      .workspaces[0];
    if (!workspace) throw new Error("runner returned no approved workspace");
    const browse = await api("/api/runners/runner-local/workspaces/browse", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspace.workspace_id }),
    });
    expect(browse.status).toBe(200);
    const browseBody = (await browse.json()) as { entries: { entry_id: string; kind: string }[] };
    const repository = browseBody.entries.find((entry) => entry.kind === "repository");
    if (!repository) throw new Error("runner returned no repository");
    const selected = await api("/api/runners/runner-local/workspaces/validate", {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspace.workspace_id, entry_id: repository.entry_id }),
    });
    const selection = (await selected.json()) as {
      selection_token: string;
      repository: Record<string, string>;
    };
    expect(selected.status).toBe(200);
    expect(JSON.stringify(selection)).not.toContain(root);
    const bound = await api("/api/v2/projects/project-1/source-bindings/local", {
      method: "POST",
      body: JSON.stringify({
        selection_token: selection.selection_token,
        verification_policy_ref: "verification",
      }),
    });
    expect(bound.status).toBe(201);
    expect((await bound.json()) as { repository_id: string }).toMatchObject({
      repository_id: selection.repository.repository_id,
    });
    const reused = await api("/api/v2/projects/project-1/source-bindings/local", {
      method: "POST",
      body: JSON.stringify({
        selection_token: selection.selection_token,
        verification_policy_ref: "verification",
      }),
    });
    expect(reused.status).toBe(409);
  });
});
