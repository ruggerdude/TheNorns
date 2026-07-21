import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { RunnerDaemon, WorkspaceRegistry } from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
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

describe.sequential("runner-owned local folder API", () => {
  let pg: PGlite;
  let server: NornsServer;
  let daemon: RunnerDaemon;
  let token: string;
  let url: string;
  let root: string;
  let repository: string;

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
      projects: new RelationalProjectReadRepository(transactions, "local-folder-api"),
      phase3: {
        sourceBindings: new SourceBindingService(transactions),
        ingestion: new RepositoryIngestionService(transactions),
        phases: new PhaseWorkflowService(transactions),
        strategies: new StrategyWorkflowService(transactions),
        bridge: new StrategyBridgeService({
          transactions,
          phases: new PhaseWorkflowService(transactions),
          strategies: new StrategyWorkflowService(transactions),
        }),
        resume: new ProjectResumeService(transactions),
      },
      localProjectOnboardingReady: true,
    });
    url = await listen(server);
    root = mkdtempSync(join(tmpdir(), "norns-local-root-"));
    repository = join(root, "project-a");
    mkdirSync(repository);
    execFileSync("git", ["-C", repository, "init", "-b", "main"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "test@norns.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
    writeFileSync(join(repository, "README.md"), "test\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
    const dataDir = mkdtempSync(join(tmpdir(), "norns-local-runner-"));
    const registry = new WorkspaceRegistry(dataDir, async () => repository);
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

  it("opens the runner-native chooser and returns an opaque repository selection", async () => {
    const selected = await api("/api/runners/runner-local/workspaces/choose", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(selected.status).toBe(200);
    const selection = (await selected.json()) as {
      selection_token: string;
      repository: Record<string, string>;
    };
    expect(selection).toMatchObject({
      selection_token: expect.stringMatching(/^selection:/),
      repository: {
        runner_id: "runner-local",
        repository_display_name: "project-a",
        default_branch: "main",
      },
    });
    expect(JSON.stringify(selection)).not.toContain(root);
    expect(JSON.stringify(selection)).not.toContain(repository);
  });

  it("selects, creates, binds, and reopens a local project without exposing its path", async () => {
    // FRONT DOOR P2b (D2): a raw local path is now accepted at creation time
    // with no runner online (it was previously a hard 400 here) — it creates
    // an unverified repository-binding candidate. See
    // frontDoorLocalProjectCreation.test.ts for full coverage of that path;
    // this file keeps only the "never leaks the raw path" assertion, since
    // that guarantee matters regardless of which creation path is used, and
    // continues on to exercise the real runner-verified flow below.
    const rawPathAttempt = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Unverified local project",
        description: "No runner required at creation",
        pm_provider: "anthropic",
        source_type: "local",
        source_location: root,
      }),
    });
    expect(rawPathAttempt.status).toBe(201);
    expect(JSON.stringify(await rawPathAttempt.json())).not.toContain(root);

    const workspaces = await api("/api/runners/runner-local/workspaces");
    expect(workspaces.status).toBe(200);
    const runners = (await (await api("/api/runners")).json()) as Record<string, unknown>[];
    expect(runners).toContainEqual(
      expect.objectContaining({
        runner_id: "runner-local",
        workspace_picker_ready: true,
        local_project_onboarding_ready: true,
      }),
    );
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
    const created = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Local app",
        description: "Continue the selected local repository",
        pm_provider: "anthropic",
      }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };
    const bound = await api(`/api/v2/projects/${project.id}/source-bindings/local`, {
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
    const summary = await api(`/api/projects/${project.id}`);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      id: project.id,
      source_type: "local",
      source_location: "project-a",
    });
    const graph = await api(`/api/projects/${project.id}/graph`);
    expect(graph.status).toBe(409);
    expect(await graph.json()).toMatchObject({ error: "not_planned" });
    const resume = await api(`/api/v2/projects/${project.id}/resume`);
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({
      project: { id: project.id },
      repositories: [
        {
          binding_type: "local_runner",
          display_name: "project-a",
          status: "connected",
          health: "healthy",
        },
      ],
      next_recommended_action: "Analyze the repository and record its architecture",
    });
    const reused = await api(`/api/v2/projects/${project.id}/source-bindings/local`, {
      method: "POST",
      body: JSON.stringify({
        selection_token: selection.selection_token,
        verification_policy_ref: "verification",
      }),
    });
    expect(reused.status).toBe(409);
  });

  it("refuses a stale workspace generation until the replacement runner reconciles", async () => {
    const pairing = (await (await api("/api/pairing/start", { method: "POST" })).json()) as {
      code: string;
    };
    const replacementData = mkdtempSync(join(tmpdir(), "norns-local-runner-replacement-"));
    const replacementRegistry = new WorkspaceRegistry(replacementData);
    replacementRegistry.addWorkspace(root, "Projects");
    const replacement = new RunnerDaemon({
      serverUrl: url,
      runnerId: "runner-local",
      dataDir: replacementData,
      workspaces: replacementRegistry,
      heartbeatMs: 500,
      reconnectDelayMs: 50,
    });
    await replacement.pair(pairing.code);
    expect(replacement.generation).toBe(2);

    const stale = await api("/api/runners/runner-local/workspaces");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "runner_unavailable" });

    try {
      replacement.connect();
      await waitFor(async () => {
        const response = await api("/api/runners/runner-local/workspaces");
        return response.status === 200;
      }, "replacement runner reconciliation");
      await waitFor(() => daemon.isFenced, "prior runner generation fenced");
    } finally {
      replacement.stop();
    }
  });

  it("marks a reconciled legacy runner as requiring an upgrade", async () => {
    const pairing = (await (await api("/api/pairing/start", { method: "POST" })).json()) as {
      code: string;
    };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const paired = await fetch(`${url}/api/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: pairing.code,
        runner_id: "runner-legacy",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
    });
    const { generation } = (await paired.json()) as { generation: number };
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);
    let competingSocket: WebSocket | undefined;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as {
        type: string;
        nonce?: string;
      };
      if (frame.type === "challenge" && frame.nonce) {
        socket.send(
          JSON.stringify({
            type: "auth",
            runner_id: "runner-legacy",
            nonce_signature: sign(null, Buffer.from(frame.nonce), privateKey).toString("base64"),
          }),
        );
      } else if (frame.type === "auth_ok") {
        // Deliberately omit capabilities to model a pre-folder-picker runner.
        socket.send(
          JSON.stringify({
            type: "reconcile_request",
            body: {
              protocol: 1,
              runner_id: "runner-legacy",
              generation,
              last_event_seq_sent: 0,
              recently_executed_command_ids: [],
            },
          }),
        );
      }
    });
    try {
      await waitFor(async () => {
        const audit = (await (await api("/api/audit")).json()) as {
          actor: string;
          action: string;
        }[];
        return audit.some(
          (entry) => entry.actor === "runner:runner-legacy" && entry.action === "runner.reconciled",
        );
      }, "legacy runner reconciliation");
      const runners = (await (await api("/api/runners")).json()) as {
        runner_id: string;
        workspace_picker_ready: boolean;
      }[];
      expect(runners).toContainEqual(
        expect.objectContaining({ runner_id: "runner-legacy", workspace_picker_ready: false }),
      );
      const unavailable = await api("/api/runners/runner-legacy/workspaces");
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toEqual({
        error: "runner_upgrade_required",
        message: "Update this local runner to use folder selection.",
      });

      // Authentication without reconciliation must not displace the current,
      // generation-accepted socket or change its negotiated capability state.
      let competingAuthenticated = false;
      competingSocket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);
      competingSocket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { type: string; nonce?: string };
        if (frame.type === "challenge" && frame.nonce) {
          competingSocket?.send(
            JSON.stringify({
              type: "auth",
              runner_id: "runner-legacy",
              nonce_signature: sign(null, Buffer.from(frame.nonce), privateKey).toString("base64"),
            }),
          );
        } else if (frame.type === "auth_ok") {
          competingAuthenticated = true;
        }
      });
      await waitFor(() => competingAuthenticated, "competing runner authentication");
      const stillCurrent = await api("/api/runners/runner-legacy/workspaces");
      expect(stillCurrent.status).toBe(409);
      expect(await stillCurrent.json()).toMatchObject({ error: "runner_upgrade_required" });
    } finally {
      competingSocket?.terminate();
      socket.terminate();
    }
  });
});
