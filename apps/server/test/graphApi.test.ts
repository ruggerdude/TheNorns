// Graph/allocation HTTP surface: what the React Flow editor drives.
import { afterEach, describe, expect, it } from "vitest";
import { GraphSession } from "../src/graph/session.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";

const TOKEN = "graph-test-token";
let server: NornsServer | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
});

async function start(): Promise<NornsServer> {
  server = await buildServer({
    stores: new RelayStores(),
    sessionToken: TOKEN,
    graphSession: GraphSession.demo(),
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

describe("graph API", () => {
  it("serves the graph with cost preview", async () => {
    const s = await start();
    const res = await inject(s, "GET", "/api/graph");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: unknown[]; version: number; cost: { total_usd: number } };
    expect(body.nodes).toHaveLength(10);
    expect(body.version).toBe(1);
    expect(body.cost.total_usd).toBe(0);
  });

  it("rejects cycle-creating edges with 409 and the offending path", async () => {
    const s = await start();
    const res = await inject(s, "POST", "/api/graph/edges", { from: "release", to: "contracts" });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; cycle_path: string[] };
    expect(body.error).toBe("cycle");
    expect(body.cycle_path.length).toBeGreaterThan(2);
  });

  it("allocate -> override -> approve roundtrip, all audited", async () => {
    const s = await start();
    const allocated = await inject(s, "POST", "/api/graph/allocate", { strategy: "balanced" });
    expect(allocated.statusCode).toBe(200);

    const override = await inject(s, "POST", "/api/graph/nodes/auth/assignment", {
      budget_usd: 77,
    });
    expect(override.statusCode).toBe(200);

    const approved = await inject(s, "POST", "/api/graph/approve-allocation");
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as { content_hash: string }).content_hash).toMatch(/^[a-f0-9]{64}$/);

    const audit = await inject(s, "GET", "/api/audit");
    const actions = (audit.json() as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("graph.auto_allocated");
    expect(actions).toContain("graph.assignment_overridden");
    expect(actions).toContain("allocation.approved");
  });

  it("refuses approval while nodes are unallocated", async () => {
    const s = await start();
    const res = await inject(s, "POST", "/api/graph/approve-allocation");
    expect(res.statusCode).toBe(409);
  });
});
