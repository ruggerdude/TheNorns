// Graph/allocation HTTP surface: what the React Flow editor drives, now
// scoped under a project (multi-project management) rather than a single
// global graph.
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PLAN } from "../src/graph/session.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";

const TOKEN = "graph-test-token";
let server: NornsServer | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
}

async function inject(
  s: NornsServer,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
): Promise<InjectedResponse> {
  const response = await s.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

/** A fresh server with one project already carrying the 10-node demo plan. */
async function startWithDemoProject(): Promise<{ server: NornsServer; projectId: string }> {
  server = await buildServer({
    stores: new RelayStores(),
    sessionToken: TOKEN,
    projects: new ProjectStore(),
  });
  const created = await inject(server, "POST", "/api/projects", {
    name: "Demo",
    description: "Phase 4 acceptance graph",
    pm_provider: "anthropic",
  });
  const { id } = created.json() as { id: string };
  const loaded = await inject(server, "POST", `/api/projects/${id}/plan/load`, { plan: DEMO_PLAN });
  if (loaded.statusCode !== 200) throw new Error(`demo plan failed to load: ${loaded.statusCode}`);
  return { server, projectId: id };
}

describe("projects API", () => {
  it("creates a project as a draft, then plan/load turns it into planned", async () => {
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      projects: new ProjectStore(),
    });
    const created = await inject(server, "POST", "/api/projects", {
      name: "OAuth Login",
      description: "Add OAuth login with Google and GitHub",
      pm_provider: "openai",
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as {
      id: string;
      status: string;
      pm_provider: string;
      reviewer_provider: string;
    };
    expect(project.status).toBe("draft");
    expect(project.pm_provider).toBe("openai");
    expect(project.reviewer_provider).toBe("anthropic"); // always the opposite provider

    const list = await inject(server, "GET", "/api/projects");
    expect((list.json() as unknown[]).length).toBe(1);

    const graphBeforePlan = await inject(server, "GET", `/api/projects/${project.id}/graph`);
    expect(graphBeforePlan.statusCode).toBe(409); // not planned yet

    const loaded = await inject(server, "POST", `/api/projects/${project.id}/plan/load`, {
      plan: DEMO_PLAN,
    });
    expect(loaded.statusCode).toBe(200);
    expect((await inject(server, "GET", `/api/projects/${project.id}`)).json()).toMatchObject({
      status: "planned",
      plan_objective: DEMO_PLAN.objective,
    });
  });

  it("404s on an unknown project id", async () => {
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      projects: new ProjectStore(),
    });
    const res = await inject(server, "GET", "/api/projects/proj-does-not-exist");
    expect(res.statusCode).toBe(404);
  });
});

describe("project graph API", () => {
  it("serves the graph with cost preview", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const res = await inject(s, "GET", `/api/projects/${projectId}/graph`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: unknown[]; version: number; cost: { total_usd: number } };
    expect(body.nodes).toHaveLength(10);
    expect(body.version).toBe(1);
    expect(body.cost.total_usd).toBe(0);
  });

  it("rejects cycle-creating edges with 409 and the offending path", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const res = await inject(s, "POST", `/api/projects/${projectId}/graph/edges`, {
      from: "release",
      to: "contracts",
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; cycle_path: string[] };
    expect(body.error).toBe("cycle");
    expect(body.cycle_path.length).toBeGreaterThan(2);
  });

  it("allocate -> override -> approve roundtrip, all audited", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const allocated = await inject(s, "POST", `/api/projects/${projectId}/graph/allocate`, {
      strategy: "balanced",
    });
    expect(allocated.statusCode).toBe(200);

    const override = await inject(
      s,
      "POST",
      `/api/projects/${projectId}/graph/nodes/auth/assignment`,
      { budget_usd: 77 },
    );
    expect(override.statusCode).toBe(200);

    const approved = await inject(s, "POST", `/api/projects/${projectId}/graph/approve-allocation`);
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as { content_hash: string }).content_hash).toMatch(/^[a-f0-9]{64}$/);

    const audit = await inject(s, "GET", "/api/audit");
    const actions = (audit.json() as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("graph.auto_allocated");
    expect(actions).toContain("graph.assignment_overridden");
    expect(actions).toContain("allocation.approved");
  });

  it("refuses approval while nodes are unallocated", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const res = await inject(s, "POST", `/api/projects/${projectId}/graph/approve-allocation`);
    expect(res.statusCode).toBe(409);
  });

  it("keeps two projects' graphs fully independent", async () => {
    const { server: s, projectId: projectA } = await startWithDemoProject();
    const createdB = await inject(s, "POST", "/api/projects", {
      name: "Small",
      description: "d",
      pm_provider: "anthropic",
    });
    const { id: projectB } = createdB.json() as { id: string };
    await inject(s, "POST", `/api/projects/${projectB}/plan/load`, {
      plan: {
        objective: "Small plan",
        modules: [
          {
            id: "only-module",
            title: "Only",
            description: "d",
            deliverables: ["x"],
            acceptance: [
              {
                id: "AC-1",
                statement: "x",
                verification_type: "command",
                verification: "pnpm test",
              },
            ],
            dependencies: [],
            estimated_complexity: "S",
            risk: "low",
            parallelization: { safe: false },
          },
        ],
      },
    });

    const graphA = (await inject(s, "GET", `/api/projects/${projectA}/graph`)).json() as {
      nodes: unknown[];
    };
    const graphB = (await inject(s, "GET", `/api/projects/${projectB}/graph`)).json() as {
      nodes: unknown[];
    };
    expect(graphA.nodes).toHaveLength(10);
    expect(graphB.nodes).toHaveLength(1);
  });
});
