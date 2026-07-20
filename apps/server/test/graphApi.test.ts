import { FakeAdapter } from "@norns/adapters";
// Graph/allocation HTTP surface: what the React Flow editor drives, now
// scoped under a project (multi-project management) rather than a single
// global graph.
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PLAN } from "../src/graph/session.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

let TOKEN = "";
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
  const users = new UserStore();
  TOKEN = testAdminToken(users);
  server = await buildServer({
    stores: new RelayStores(),
    users,
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
    const users = new UserStore();
    TOKEN = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
    });
    const created = await inject(server, "POST", "/api/projects", {
      name: "OAuth Login",
      description: "Add OAuth login with Google and GitHub",
      pm_provider: "openai",
      pm_model: "gpt-5.6-sol",
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as {
      id: string;
      status: string;
      pm_provider: string;
      pm_model: string;
      reviewer_provider: string;
    };
    expect(project.status).toBe("draft");
    expect(project.pm_provider).toBe("openai");
    expect(project.pm_model).toBe("gpt-5.6-sol");
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

  it("rejects unknown and provider-mismatched PM models", async () => {
    const users = new UserStore();
    TOKEN = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
    });

    const mismatch = await inject(server, "POST", "/api/projects", {
      name: "Mismatch",
      description: "d",
      pm_provider: "anthropic",
      pm_model: "gpt-5.6-sol",
    });
    const unknown = await inject(server, "POST", "/api/projects", {
      name: "Unknown",
      description: "d",
      pm_provider: "openai",
      pm_model: "not-a-real-model",
    });

    expect(mismatch.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
  });

  it("404s on an unknown project id", async () => {
    const users = new UserStore();
    TOKEN = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
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

  it("asks the selected project manager for a guarded mix of workers and models", async () => {
    const users = new UserStore();
    TOKEN = testAdminToken(users);
    const pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    pm.enqueue({
      summary: "Use a mixed-provider team, adding workers only to divisible modules.",
      recommendations: DEMO_PLAN.modules.map((module, index) => {
        const provider = index % 2 === 0 ? "anthropic" : "openai";
        return {
          node_id: module.id,
          provider,
          model: provider === "anthropic" ? "claude-sonnet-5" : "gpt-5.6-terra",
          worker_count: module.parallelization.safe && module.estimated_complexity === "L" ? 2 : 1,
          reviewer_model: provider === "anthropic" ? "gpt-5.6-terra" : "claude-sonnet-5",
          budget_usd: 25 + index,
          rationale: `Best-fit staffing for ${module.title}.`,
        };
      }),
    });
    const usage: unknown[] = [];
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "test-anthropic",
        OPENAI_API_KEY: "test-openai",
        NORNS_DEBATE_ALLOWED_MODELS: "anthropic/claude-sonnet-5,openai/gpt-5.6-terra",
      },
      createPlanningAdapter: () => pm,
      recordUsage: (events) => usage.push(...events),
    });
    const created = await inject(server, "POST", "/api/projects", {
      name: "PM staffed",
      description: "Choose the right team",
      pm_provider: "anthropic",
      pm_model: "claude-sonnet-5",
    });
    const { id } = created.json() as { id: string };
    await inject(server, "POST", `/api/projects/${id}/plan/load`, { plan: DEMO_PLAN });

    const recommended = await inject(
      server,
      "POST",
      `/api/projects/${id}/graph/recommend-allocation`,
      {},
    );

    expect(recommended.statusCode).toBe(200);
    const body = recommended.json() as {
      nodes: Array<{ assignment: { provider: string; source: string; rationale: string } }>;
      allocation_advice: { summary: string; pm_model: string };
    };
    expect(new Set(body.nodes.map((node) => node.assignment.provider))).toEqual(
      new Set(["anthropic", "openai"]),
    );
    expect(body.nodes.every((node) => node.assignment.source === "pm")).toBe(true);
    expect(body.allocation_advice.pm_model).toBe("claude-sonnet-5");
    expect(body.allocation_advice.summary).toMatch(/mixed-provider/i);
    expect(usage).toHaveLength(1);
    expect(pm.requests[0]?.schemaName).toBe("project_allocation_recommendation");

    const audit = await inject(server, "GET", "/api/audit");
    expect((audit.json() as { action: string }[]).map((entry) => entry.action)).toContain(
      "allocation.pm_recommended",
    );
  });

  it("refuses approval while nodes are unallocated", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const res = await inject(s, "POST", `/api/projects/${projectId}/graph/approve-allocation`);
    expect(res.statusCode).toBe(409);
  });

  it("reports approval status server-side: null before approval, current after, stale after a change (ADR-1)", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const graphUrl = `/api/projects/${projectId}/graph`;
    type GraphWithApproval = {
      version: number;
      approval: { content_hash: string; current: boolean; actor: string } | null;
    };

    // Never approved -> null.
    expect((await inject(s, "GET", graphUrl)).json()).toMatchObject({ approval: null });

    await inject(s, "POST", `/api/projects/${projectId}/graph/allocate`, { strategy: "balanced" });
    const approved = await inject(s, "POST", `/api/projects/${projectId}/graph/approve-allocation`);
    expect(approved.statusCode).toBe(200);

    // Immediately after approval it is current.
    const afterApprove = (await inject(s, "GET", graphUrl)).json() as GraphWithApproval;
    expect(afterApprove.approval).toMatchObject({ current: true, actor: "operator" });
    expect(afterApprove.approval?.content_hash).toMatch(/^[a-f0-9]{64}$/);

    // A post-approval override changes an assignment: the approval is not lost,
    // it goes stale (allocation_fingerprint no longer matches).
    await inject(s, "POST", `/api/projects/${projectId}/graph/nodes/auth/assignment`, {
      budget_usd: 999,
    });
    const afterOverride = (await inject(s, "GET", graphUrl)).json() as GraphWithApproval;
    expect(afterOverride.approval).toMatchObject({ current: false });
    // The evidence hash of what was approved is still surfaced.
    expect(afterOverride.approval?.content_hash).toBe(afterApprove.approval?.content_hash);
  });

  it("marks approval stale after a structural edit bumps graph.version (ADR-1)", async () => {
    const { server: s, projectId } = await startWithDemoProject();
    const graphUrl = `/api/projects/${projectId}/graph`;
    await inject(s, "POST", `/api/projects/${projectId}/graph/allocate`, { strategy: "balanced" });
    await inject(s, "POST", `/api/projects/${projectId}/graph/approve-allocation`);
    expect((await inject(s, "GET", graphUrl)).json()).toMatchObject({
      approval: { current: true },
    });

    // A structural edit (new edge) bumps graph.version even though no
    // assignment changed — the approval binds to version too, so it goes stale.
    const edge = await inject(s, "POST", `/api/projects/${projectId}/graph/edges`, {
      from: "db-schema",
      to: "auth",
    });
    expect(edge.statusCode).toBe(200);
    expect((await inject(s, "GET", graphUrl)).json()).toMatchObject({
      approval: { current: false },
    });
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
