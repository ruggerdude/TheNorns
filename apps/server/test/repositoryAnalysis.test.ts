// POLISH P3 — the analyze-repository step, exercised end-to-end through
// buildServer with the SAME option shape production's main.ts supplies
// (`phase3` + `repositoryAnalysis`). An unwired service has shipped dead
// while CI stayed green repeatedly in this codebase; this suite boots the
// real route over the real RepositoryIngestionService and a real
// GitHubIntegrationService, faking only the two network edges:
//   * GitHub's HTTP API, at the `GitHubFetch = typeof fetch` seam
//     github.ts already exposes (installation-token mint included, so the
//     token-scoping request body is asserted for real);
//   * the model, at the adapter-factory seam (`FakeAdapter`), which still
//     runs the real structured-output schema validation.
import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter } from "@norns/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitHubIntegrationService,
  githubIntegrationConfigFromEnvironment,
} from "../src/integrations/github.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import {
  MAX_KEY_FILES,
  RepositoryAnalysisService,
  keyFileScore,
  selectKeyFiles,
} from "../src/projects/repositoryAnalysisService.js";
import { RepositoryIngestionService } from "../src/projects/repositoryIngestionService.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";
import { ProjectStore } from "../src/projects/store.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

const HEAD_SHA = "c0ffee".padEnd(40, "0");
const INSTALLATION_ID = "42";
const REPO_GITHUB_ID = 9001;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

const FILE_CONTENT: Record<string, string> = {
  "README.md": "# Acme App\nA small demo web service.",
  "package.json": '{ "name": "acme-app", "scripts": { "test": "vitest run" } }',
  "src/index.ts": "export const main = () => 42;",
};

const MODEL_OUTPUT = {
  title: "Acme App architecture",
  summary: "A small TypeScript web service with a vitest test suite.",
  architecture_document: "# Architecture\n\nOne service, one entry point.",
  repository_facts: [
    { key: "language", value: "TypeScript", confidence: 0.95 },
    { key: "test_command", value: "vitest run", confidence: 0.9 },
  ],
  constraints: ["Keep the entry point at src/index.ts"],
};

describe.sequential("POLISH P3: repository analysis", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let server: NornsServer | undefined;
  let token: string;
  let users: UserStore;
  let github: GitHubIntegrationService;
  let adapter: FakeAdapter;
  let ingestion: RepositoryIngestionService;
  let tokenMintBodies: Array<Record<string, unknown>>;
  let http: ReturnType<typeof vi.fn>;

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
    await pg.query(
      `INSERT INTO projects (
         id, name, description, status, assignment_policy_ref,
         verification_policy_ref, budget_policy_ref
       ) VALUES ('project-1','Project One','','initializing','assignment-default',
                 'verification-default','budget-default')`,
    );
    transactions = new PGliteTransactionRunner(pg);
    ingestion = new RepositoryIngestionService(transactions);
    tokenMintBodies = [];

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

    http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
        tokenMintBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(
          {
            token: "installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          201,
        );
      }
      if (url === "https://api.github.com/repos/acme/app/branches/main") {
        return json({ commit: { sha: HEAD_SHA } });
      }
      if (url === `https://api.github.com/repos/acme/app/git/trees/${HEAD_SHA}?recursive=1`) {
        return json({
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", size: 40 },
            { path: "package.json", type: "blob", size: 60 },
            { path: "src/index.ts", type: "blob", size: 30 },
            { path: "src/util/helpers.ts", type: "blob", size: 100 },
            { path: "assets/logo.png", type: "blob", size: 900_000 },
            { path: "src", type: "tree" },
          ],
        });
      }
      const contents = url.match(
        /^https:\/\/api\.github\.com\/repos\/acme\/app\/contents\/(.+)\?ref=(.+)$/,
      );
      if (contents) {
        const path = decodeURIComponent(contents[1] as string)
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/");
        const content = FILE_CONTENT[path];
        if (content === undefined) return json({ message: "Not Found" }, 404);
        return json({ type: "file", encoding: "base64", content: b64(content) });
      }
      throw new Error(`unexpected GitHub request: ${url}`);
    });
    github = new GitHubIntegrationService(transactions, config, http as unknown as typeof fetch);
    adapter = new FakeAdapter("anthropic");

    users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      // Exactly the production `phase3` shape main.ts supplies.
      phase3: phase3Options(),
      // Exactly the production `repositoryAnalysis` shape main.ts supplies
      // (transactions + github + phase3's ingestion + adapter factory).
      repositoryAnalysis: new RepositoryAnalysisService({
        transactions,
        github,
        ingestion,
        createAdapter: () => adapter,
        http: http as unknown as typeof fetch,
      }),
    });
  }, 60_000);

  afterEach(async () => {
    await server?.app.close();
    server = undefined;
    await pg.close();
  });

  /** The production `phase3` shape — the v2 project routes (including
   *  analyze-repository) mount inside `if (options.phase3)`, exactly as a
   *  deployment with a relational runtime supplies them. */
  function phase3Options() {
    return {
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
    };
  }

  async function createGitHubBinding(): Promise<string> {
    const binding = await new SourceBindingService(transactions).createGitHub({
      project_id: "project-1",
      runner_id: "runner-1",
      github_installation_id: INSTALLATION_ID,
      // Production stores the numeric GitHub repository id (as text) here —
      // ProjectActivationService promotes `external_repository_id`, which is
      // `String(repository.id)` from the GitHub API.
      github_repository_id: String(REPO_GITHUB_ID),
      owner: "acme",
      name: "app",
      default_branch: "main",
      observed_head: HEAD_SHA,
      verification_policy_ref: "verification-default",
      granted_permissions: {
        metadata: "read",
        contents: "read",
        pull_requests: "none",
        checks: "none",
        actions: "none",
      },
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });
    return binding.id;
  }

  const post = () =>
    (server as NornsServer).app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/analyze-repository",
      headers: { authorization: `Bearer ${token}` },
    });

  it("requires a session", async () => {
    const res = await (server as NornsServer).app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/analyze-repository",
    });
    expect(res.statusCode).toBe(401);
  });

  it("analyzes a bounded repository sample and records it through the real ingestion service", async () => {
    const bindingId = await createGitHubBinding();
    adapter.enqueue(MODEL_OUTPUT);

    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      architecture_revision: 1,
      replayed: false,
      title: "Acme App architecture",
      summary: MODEL_OUTPUT.summary,
      repository_revision: HEAD_SHA,
      model: { provider: "anthropic", model: "mock-anthropic" },
    });

    // The installation token was minted repository-scoped, contents:read —
    // never the installation-wide full grant.
    expect(tokenMintBodies).toEqual([
      { repository_ids: [REPO_GITHUB_ID], permissions: { contents: "read" } },
    ]);

    // The model saw the tree and the key files, and nothing else was fetched
    // (no source file outside the key-file selection, no binary).
    const request = adapter.requests[0];
    expect(request?.prompt).toContain("README.md");
    expect(request?.prompt).toContain("# Acme App");
    expect(request?.prompt).toContain('"name": "acme-app"');
    expect(request?.prompt).toContain("export const main");
    expect(request?.prompt).toContain("assets/logo.png"); // tree listing only
    const contentFetches = http.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("/contents/"));
    expect(contentFetches).toHaveLength(3);

    // Recorded through the REAL ingestion path: architecture revision +
    // artifact + memory entries, and the project promoted to active with the
    // new revision current.
    const state = await pg.query<{
      status: string;
      current: string | null;
      architectures: number;
      artifacts: number;
      memories: number;
      binding: string;
    }>(
      `SELECT p.status, p.current_architecture_revision_id AS current,
              (SELECT count(*)::int FROM architecture_revisions) AS architectures,
              (SELECT count(*)::int FROM artifacts) AS artifacts,
              (SELECT count(*)::int FROM project_memory_entries) AS memories,
              p.primary_repository_binding_id AS binding
       FROM projects p WHERE p.id = 'project-1'`,
    );
    expect(state.rows[0]).toMatchObject({
      status: "active",
      architectures: 1,
      artifacts: 1,
      // 2 facts + 1 constraint + 1 architecture summary; no directives — a
      // model inference must never enter memory auto-approved.
      memories: 4,
      binding: bindingId,
    });
    const approved = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM project_memory_entries WHERE approved_by_human",
    );
    expect(approved.rows[0]?.count).toBe(0);

    // The resume payload now carries the recorded architecture and moves the
    // recommendation past "Analyze the repository".
    const resume = await (server as NornsServer).app.inject({
      method: "GET",
      url: "/api/v2/projects/project-1/resume",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({
      architecture: {
        title: "Acme App architecture",
        summary: MODEL_OUTPUT.summary,
        repository_revision: HEAD_SHA,
      },
      next_recommended_action: "Create the project's next phase",
    });

    // Replay: analyzing the same head again is idempotent, not a duplicate.
    adapter.enqueue(MODEL_OUTPUT);
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ architecture_revision: 1, replayed: true });
  });

  it("refuses honestly when the project has no repository", async () => {
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_repository" });
  });

  it("refuses honestly when the only connected repository is not GitHub-backed", async () => {
    await new SourceBindingService(transactions).createLocal({
      project_id: "project-1",
      runner_id: "runner-1",
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "Project One",
      default_branch: "main",
      observed_head: "commit-1",
      verification_policy_ref: "verification-default",
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_github_repository" });
  });

  it("refuses honestly for an unknown project", async () => {
    const res = await (server as NornsServer).app.inject({
      method: "POST",
      url: "/api/v2/projects/project-unknown/analyze-repository",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "project_not_found" });
  });

  it("refuses honestly when GitHub is not configured on the deployment", async () => {
    const bare = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase3: phase3Options(),
      repositoryAnalysis: new RepositoryAnalysisService({
        transactions,
        github: null,
        ingestion,
        createAdapter: () => adapter,
      }),
    });
    try {
      const res = await bare.app.inject({
        method: "POST",
        url: "/api/v2/projects/project-1/analyze-repository",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "github_not_configured" });
    } finally {
      await bare.app.close();
    }
  });

  it("refuses honestly when no model provider is configured", async () => {
    const bare = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase3: phase3Options(),
      repositoryAnalysis: new RepositoryAnalysisService({
        transactions,
        github,
        ingestion,
        createAdapter: () => {
          // Exactly what main.ts's factory does without ANTHROPIC_API_KEY.
          throw new Error("Anthropic is not configured for repository analysis");
        },
        http: http as unknown as typeof fetch,
      }),
    });
    try {
      const res = await bare.app.inject({
        method: "POST",
        url: "/api/v2/projects/project-1/analyze-repository",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "model_not_configured" });
      expect(res.json().message).toContain("Anthropic is not configured");
    } finally {
      await bare.app.close();
    }
  });

  it("refuses honestly when the deployment never wired the service at all", async () => {
    const bare = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      phase3: phase3Options(),
    });
    try {
      const res = await bare.app.inject({
        method: "POST",
        url: "/api/v2/projects/project-1/analyze-repository",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "analysis_unavailable" });
    } finally {
      await bare.app.close();
    }
  });

  it("surfaces a GitHub API failure as the server's own error, not a generic one", async () => {
    await createGitHubBinding();
    http.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
        return json(
          {
            token: "installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          201,
        );
      }
      return json({ message: "Repository access blocked" }, 451);
    });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "github_api_error" });
    expect(res.json().message).toContain("Repository access blocked");
  });

  it("bounds the key-file selection deterministically", () => {
    expect(keyFileScore("README.md")).toBe(0);
    expect(keyFileScore("package.json")).toBe(1);
    expect(keyFileScore("docs/README.md")).toBe(10);
    expect(keyFileScore("assets/logo.png")).toBeNull();
    expect(keyFileScore("src/util/helpers.ts")).toBeNull();
    const many = Array.from({ length: 40 }, (_, index) => ({
      path: `packages/p${String(index).padStart(2, "0")}/package.json`,
      size: 100,
    }));
    const selected = selectKeyFiles([
      { path: "README.md", size: 10 },
      { path: "huge/package.json", size: 10 * 1024 * 1024 }, // over per-file byte cap
      ...many,
    ]);
    expect(selected).toHaveLength(MAX_KEY_FILES);
    expect(selected[0]?.path).toBe("README.md");
    expect(selected.map((file) => file.path)).not.toContain("huge/package.json");
  });
});
