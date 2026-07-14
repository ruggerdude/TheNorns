// Live planning (Tier 3 unlock): POST /api/plan runs the real cross-provider
// planning loop against Anthropic + OpenAI; POST /api/plan/load commits a
// reviewed plan into the graph editor. The guard/load paths run in CI always;
// the actual live-model round trip auto-enables when real keys are present
// in the environment (same pattern as packages/adapters/test/live.test.ts).
import type { UsageEventT } from "@norns/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { GraphSession } from "../src/graph/session.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";

const TOKEN = "plan-test-token";
let server: NornsServer | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

async function start(recordUsage?: (events: UsageEventT[]) => void): Promise<NornsServer> {
  server = await buildServer({
    stores: new RelayStores(),
    sessionToken: TOKEN,
    graphSession: GraphSession.demo(),
    ...(recordUsage ? { recordUsage } : {}),
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

describe("live planning — guard + load (no keys required)", () => {
  it("POST /api/plan refuses with 501 when provider keys are absent", async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NORNS_OPENAI_MODEL: process.env.NORNS_OPENAI_MODEL,
    };
    for (const key of Object.keys(saved)) Reflect.deleteProperty(process.env, key);
    try {
      const s = await start();
      const res = await inject(s, "POST", "/api/plan", { objective: "Build a thing" });
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

  it("POST /api/plan/load commits a reviewed plan into the graph, replacing the demo", async () => {
    const s = await start();
    const before = await inject(s, "GET", "/api/graph");
    expect((before.json() as { nodes: unknown[] }).nodes).toHaveLength(10); // demo plan

    const res = await inject(s, "POST", "/api/plan/load", { plan: TWO_NODE_PLAN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: { id: string; dependencies: string[] }[]; version: number };
    expect(body.nodes.map((n) => n.id).sort()).toEqual(["feature", "foundation"]);
    expect(body.nodes.find((n) => n.id === "feature")?.dependencies).toEqual(["foundation"]);
    expect(body.version).toBe(1); // fresh graph from the new plan

    const audit = await inject(s, "GET", "/api/audit");
    const actions = (audit.json() as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("graph.plan_loaded");
  });

  it("POST /api/plan/load rejects an invalid plan with 422", async () => {
    const s = await start();
    const badPlan = { ...TWO_NODE_PLAN, modules: [{ ...TWO_NODE_PLAN.modules[1] }] }; // dangling dependency
    const res = await inject(s, "POST", "/api/plan/load", { plan: badPlan });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("plan_invalid");

    // the graph is untouched by the rejected load
    const after = await inject(s, "GET", "/api/graph");
    expect((after.json() as { nodes: unknown[] }).nodes).toHaveLength(10);
  });
});

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.NORNS_OPENAI_MODEL;

describe("live planning — real provider round trip", () => {
  it.skipIf(!anthropicKey || !openaiKey || !openaiModel)(
    "POST /api/plan runs a real cross-provider planning loop and records usage",
    async () => {
      const recorded: UsageEventT[] = [];
      const s = await start((events) => recorded.push(...events));
      const res = await inject(s, "POST", "/api/plan", {
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
