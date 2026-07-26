// FRONT DOOR P2 §D1: HTTP surface for durable planning runs — auth,
// validation, and DTO shape. Lifecycle correctness (convergence, cap_reached,
// reviewer resolution) is covered directly against PlanningRunWorker in
// test/planningRunWorker.test.ts; this file only exercises the route layer.
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
}

async function inject(
  server: NornsServer,
  token: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  const response = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

describe.sequential("durable planning run HTTP API", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;
  let projectId: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    projectId = "project-http-1";
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES ('${projectId}', 'HTTP project', 'active', 'assignment/default', 'verification/default', 'budget/default');
    `);
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    const actor = users.list()[0];
    if (!actor) throw new Error("test admin was not created");
    await pg.query(
      `INSERT INTO users (
         id, username, display_name, email, name, password_hash,
         password_hash_scheme, role, status
       ) VALUES ($1, $2, $3, $2, $3, $4, 'legacy-scrypt-v0', 'admin', 'active')`,
      [actor.id, actor.email, actor.name ?? actor.email, `${"a".repeat(32)}:${"b".repeat(128)}`],
    );
    const pmAdapter = new FakeAdapter("anthropic");
    const reviewerAdapter = new FakeAdapter("openai");
    pmAdapter.enqueue({
      objective: "objective",
      modules: [
        {
          id: "api",
          title: "API",
          description: "d",
          deliverables: ["src/api.ts"],
          acceptance: [
            {
              id: "AC-1",
              statement: "tests pass",
              verification_type: "command",
              verification: "pnpm test",
            },
          ],
          dependencies: [],
          estimated_complexity: "M",
          risk: "low",
        },
      ],
    });
    reviewerAdapter.enqueue({ findings: [] });
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      planningRuns: { transactions },
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "test-anthropic",
        OPENAI_API_KEY: "test-openai",
        NORNS_OPENAI_MODEL: "gpt-5.6-luna",
        NORNS_RUNNER_ALLOWED_MODELS:
          "anthropic/claude-fable-5,anthropic/claude-sonnet-5,openai/gpt-5.6-luna",
      },
      createPlanningAdapter: (provider: ProviderName): LlmAdapter =>
        provider === "anthropic" ? pmAdapter : reviewerAdapter,
    });
  }, 30_000);

  afterEach(async () => {
    await server.app.close();
    if (!pg.closed) await pg.close();
  });

  it("rejects an unauthenticated create", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v2/projects/${projectId}/planning-runs`,
      payload: { objective: "do the thing" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const empty = await inject(
      server,
      token,
      "POST",
      `/api/v2/projects/${projectId}/planning-runs`,
      {
        objective: "",
      },
    );
    expect(empty.statusCode).toBe(400);

    const badRounds = await inject(
      server,
      token,
      "POST",
      `/api/v2/projects/${projectId}/planning-runs`,
      { objective: "do the thing", max_rounds: 9 },
    );
    expect(badRounds.statusCode).toBe(400);

    const unknownField = await inject(
      server,
      token,
      "POST",
      `/api/v2/projects/${projectId}/planning-runs`,
      { objective: "do the thing", nope: true },
    );
    expect(unknownField.statusCode).toBe(400);
  });

  it("404s for an unknown project", async () => {
    const res = await inject(
      server,
      token,
      "POST",
      "/api/v2/projects/no-such-project/planning-runs",
      {
        objective: "do the thing",
      },
    );
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "project_not_found" });
  });

  it("creates a run and accepts attachment_ids as forward-compatible input", async () => {
    const res = await inject(server, token, "POST", `/api/v2/projects/${projectId}/planning-runs`, {
      objective: "do the thing",
      max_rounds: 2,
      attachment_ids: ["att-1"],
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { planning_run_id: string };
    expect(typeof body.planning_run_id).toBe("string");
  });

  it("lists every durable work conversation newest first", async () => {
    const first = await inject(
      server,
      token,
      "POST",
      `/api/v2/projects/${projectId}/planning-runs`,
      { objective: "first objective", max_rounds: 2 },
    );
    const second = await inject(
      server,
      token,
      "POST",
      `/api/v2/projects/${projectId}/planning-runs`,
      { objective: "second objective", max_rounds: 2 },
    );
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const firstId = (first.json() as { planning_run_id: string }).planning_run_id;
    const secondId = (second.json() as { planning_run_id: string }).planning_run_id;
    await pg.query("UPDATE planning_runs SET created_at = $2 WHERE id = $1", [
      firstId,
      "2026-01-01T00:00:00.000Z",
    ]);
    await pg.query("UPDATE planning_runs SET created_at = $2 WHERE id = $1", [
      secondId,
      "2026-01-02T00:00:00.000Z",
    ]);

    const response = await inject(
      server,
      token,
      "GET",
      `/api/v2/projects/${projectId}/planning-runs`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { planning_runs: Array<{ objective: string }> };
    expect(body.planning_runs.map((run) => run.objective)).toEqual([
      "second objective",
      "first objective",
    ]);
  });

  it("creates and versions the project's NORN.md rules directive", async () => {
    const empty = await inject(server, token, "GET", `/api/v2/projects/${projectId}/rules`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ filename: "NORN.md", content: "", version: 0 });

    const first = await inject(server, token, "PUT", `/api/v2/projects/${projectId}/rules`, {
      content: "# Rules\r\n\r\n- Run the full test suite.",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      filename: "NORN.md",
      content: "# Rules\n\n- Run the full test suite.",
      version: 1,
    });

    const second = await inject(server, token, "PUT", `/api/v2/projects/${projectId}/rules`, {
      content: "# Rules\n\n- Preserve API compatibility.",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ version: 2 });

    const directives = await pg.query<{ content: string; status: string; version: number }>(
      `SELECT content, status, version FROM project_memory_entries
       WHERE project_id = $1 AND provenance = 'project_rules_file'
       ORDER BY version`,
      [projectId],
    );
    expect(directives.rows).toEqual([
      {
        content: "# Rules\n\n- Run the full test suite.",
        status: "obsolete",
        version: 1,
      },
      {
        content: "# Rules\n\n- Preserve API compatibility.",
        status: "active",
        version: 2,
      },
    ]);
  });

  it("404s GET for an unknown run and rejects unauthenticated reads", async () => {
    const unauthed = await server.app.inject({
      method: "GET",
      url: `/api/v2/projects/${projectId}/planning-runs/no-such-run`,
    });
    expect(unauthed.statusCode).toBe(401);

    const notFound = await inject(
      server,
      token,
      "GET",
      `/api/v2/projects/${projectId}/planning-runs/no-such-run`,
    );
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: "planning_run_not_found" });
  });

  it("GET returns the queued DTO shape immediately after creation", async () => {
    const created = await inject(
      server,
      token,
      "POST",
      `/api/v2/projects/${projectId}/planning-runs`,
      { objective: "do the thing" },
    );
    const { planning_run_id: runId } = created.json() as { planning_run_id: string };

    const res = await inject(
      server,
      token,
      "GET",
      `/api/v2/projects/${projectId}/planning-runs/${runId}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: runId,
      project_id: projectId,
      objective: "do the thing",
      max_rounds: 3,
    });
    expect(Array.isArray(body.transcript)).toBe(true);
    expect([
      "queued",
      "drafting",
      "reviewing",
      "revising",
      "converged",
      "cap_reached",
      "failed",
    ]).toContain(body.status);
  });
});
