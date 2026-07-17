// Live planning (Tier 3 unlock), scoped to a project: POST
// /api/projects/:id/plan runs the real cross-provider planning loop against
// whichever provider the project's PM is set to; POST /api/projects/:id/plan/load
// commits a reviewed plan into that project's graph. The guard/load paths run
// in CI always; the actual live-model round trip auto-enables when real keys
// are present in the environment (same pattern as
// packages/adapters/test/live.test.ts).
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import type { PmModelT, UsageEventT } from "@norns/contracts";
import { afterEach, describe, expect, it } from "vitest";
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

async function start(
  recordUsage?: (events: UsageEventT[]) => void,
  createPlanningAdapter?: (provider: ProviderName, model: string, apiKey: string) => LlmAdapter,
): Promise<NornsServer> {
  const users = new UserStore();
  TOKEN = testAdminToken(users);
  server = await buildServer({
    stores: new RelayStores(),
    users,
    projects: new ProjectStore(),
    ...(recordUsage ? { recordUsage } : {}),
    ...(createPlanningAdapter ? { createPlanningAdapter } : {}),
  });
  return server;
}

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

async function createProject(
  s: NornsServer,
  pmProvider: "anthropic" | "openai" = "anthropic",
  pmModel?: PmModelT,
): Promise<string> {
  const res = await inject(s, "POST", "/api/projects", {
    name: "Test project",
    description: "d",
    pm_provider: pmProvider,
    ...(pmModel ? { pm_model: pmModel } : {}),
  });
  return (res.json() as { id: string }).id;
}

const TWO_NODE_PLAN = {
  objective: "Live-loaded test objective",
  modules: [
    {
      id: "foundation",
      title: "Foundation",
      description: "Foundation module",
      deliverables: ["foundation deliverable"],
      acceptance: [
        {
          id: "AC-1",
          statement: "foundation passes",
          verification_type: "command",
          verification: "pnpm test",
        },
      ],
      dependencies: [],
      estimated_complexity: "M",
      risk: "low",
      parallelization: { safe: false },
    },
    {
      id: "feature",
      title: "Feature",
      description: "Feature module",
      deliverables: ["feature deliverable"],
      acceptance: [
        {
          id: "AC-1",
          statement: "feature passes",
          verification_type: "command",
          verification: "pnpm test",
        },
      ],
      dependencies: ["foundation"],
      estimated_complexity: "S",
      risk: "low",
      parallelization: { safe: false },
    },
  ],
};

describe("live planning — persisted PM model routing", () => {
  it("uses each project's exact PM model and an opposite-provider reviewer model", async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NORNS_OPENAI_MODEL: process.env.NORNS_OPENAI_MODEL,
      NORNS_REVIEWER_ANTHROPIC_MODEL: process.env.NORNS_REVIEWER_ANTHROPIC_MODEL,
    };
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.NORNS_OPENAI_MODEL = "gpt-5.6-luna";
    process.env.NORNS_REVIEWER_ANTHROPIC_MODEL = "claude-opus-4-8";

    const constructed: { provider: ProviderName; model: string }[] = [];
    const factory = (provider: ProviderName, model: string): LlmAdapter => {
      const adapter = new FakeAdapter(provider, model);
      adapter.enqueue(constructed.length % 2 === 0 ? TWO_NODE_PLAN : { findings: [] });
      constructed.push({ provider, model });
      return adapter;
    };

    try {
      const s = await start(undefined, factory);
      const fableId = await createProject(s, "anthropic", "claude-fable-5");
      const fable = await inject(s, "POST", `/api/projects/${fableId}/plan`, {
        objective: "Build with Fable",
        maxRounds: 1,
      });
      expect(fable.statusCode).toBe(200);
      expect((fable.json() as { policy: unknown }).policy).toMatchObject({
        pm_provider: "anthropic",
        pm_model: "claude-fable-5",
        reviewer_provider: "openai",
        reviewer_model: "gpt-5.6-luna",
      });
      expect((fable.json() as { versions: unknown[] }).versions).toEqual([
        expect.objectContaining({ version: 1, findings: [], responses: null }),
      ]);

      const solId = await createProject(s, "openai", "gpt-5.6-sol");
      const sol = await inject(s, "POST", `/api/projects/${solId}/plan`, {
        objective: "Build with Sol",
        maxRounds: 1,
      });
      expect(sol.statusCode).toBe(200);
      expect((sol.json() as { policy: unknown }).policy).toMatchObject({
        pm_provider: "openai",
        pm_model: "gpt-5.6-sol",
        reviewer_provider: "anthropic",
        reviewer_model: "claude-opus-4-8",
      });

      expect(constructed).toEqual([
        { provider: "anthropic", model: "claude-fable-5" },
        { provider: "openai", model: "gpt-5.6-luna" },
        { provider: "openai", model: "gpt-5.6-sol" },
        { provider: "anthropic", model: "claude-opus-4-8" },
      ]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});

describe("live planning — guard + load (no keys required)", () => {
  it("POST /api/projects/:id/plan refuses with 501 when provider keys are absent", async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NORNS_OPENAI_MODEL: process.env.NORNS_OPENAI_MODEL,
    };
    for (const key of Object.keys(saved)) Reflect.deleteProperty(process.env, key);
    try {
      const s = await start();
      const id = await createProject(s);
      const res = await inject(s, "POST", `/api/projects/${id}/plan`, {
        objective: "Build a thing",
      });
      expect(res.statusCode).toBe(501);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe("live_planning_unavailable");
      expect(body.message).toContain("ANTHROPIC_API_KEY");
      expect(body.message).toContain("OPENAI_API_KEY");
      expect(body.message).toContain("NORNS_OPENAI_MODEL");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });

  it("POST /api/projects/:id/plan 404s on an unknown project before even checking keys", async () => {
    const s = await start();
    const res = await inject(s, "POST", "/api/projects/proj-ghost/plan", { objective: "x" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/projects/:id/plan/load commits a reviewed plan, turning a draft into planned", async () => {
    const s = await start();
    const id = await createProject(s);
    expect((await inject(s, "GET", `/api/projects/${id}/graph`)).statusCode).toBe(409); // not planned yet

    const res = await inject(s, "POST", `/api/projects/${id}/plan/load`, { plan: TWO_NODE_PLAN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: { id: string; dependencies: string[] }[]; version: number };
    expect(body.nodes.map((n) => n.id).sort()).toEqual(["feature", "foundation"]);
    expect(body.nodes.find((n) => n.id === "feature")?.dependencies).toEqual(["foundation"]);
    expect(body.version).toBe(1);

    const audit = await inject(s, "GET", "/api/audit");
    const actions = (audit.json() as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("graph.plan_loaded");
  });

  it("POST /api/projects/:id/plan/load rejects an invalid plan with 422, leaving the project a draft", async () => {
    const s = await start();
    const id = await createProject(s);
    const badPlan = { ...TWO_NODE_PLAN, modules: [{ ...TWO_NODE_PLAN.modules[1] }] }; // dangling dependency
    const res = await inject(s, "POST", `/api/projects/${id}/plan/load`, { plan: badPlan });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("plan_invalid");
    expect((await inject(s, "GET", `/api/projects/${id}`)).json()).toMatchObject({
      status: "draft",
    });
  });
});

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.NORNS_OPENAI_MODEL;

describe("live planning — real provider round trip", () => {
  it.skipIf(!anthropicKey || !openaiKey || !openaiModel)(
    "POST /api/projects/:id/plan runs a real cross-provider planning loop and records usage",
    async () => {
      const recorded: UsageEventT[] = [];
      const s = await start((events) => recorded.push(...events));
      const id = await createProject(s, "anthropic");
      const res = await inject(s, "POST", `/api/projects/${id}/plan`, {
        objective: "A single health-check HTTP endpoint that returns { ok: true }",
        maxRounds: 1,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        status: string;
        plan: { modules: unknown[] };
        content_hash: string;
        total_cost_usd: number;
        usage: unknown[];
      };
      expect(["converged", "cap_reached"]).toContain(body.status);
      expect(body.plan.modules.length).toBeGreaterThan(0);
      expect(body.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(body.total_cost_usd).toBeGreaterThan(0);
      expect(recorded.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
