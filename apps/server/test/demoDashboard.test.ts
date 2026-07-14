// UI-6 containment (backend): the demo dashboard is a self-contained,
// illustrative surface at GET /api/demo/dashboard. These tests prove the
// separation from real project data is STRUCTURAL, not merely a naming
// convention: there is no route, no parameter, and no code path by which a
// real project_id can reach or influence the demo dashboard's output.
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_PLAN } from "../src/graph/session.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";

const TOKEN = "demo-dash-token";
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
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  auth = true,
): Promise<InjectedResponse> {
  const response = await s.app.inject({
    method,
    url,
    ...(auth ? { headers: { authorization: `Bearer ${TOKEN}` } } : {}),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

/**
 * A demo provider that records every call and any argument passed to it. The
 * route wiring must invoke it with NO arguments — that is what makes it
 * impossible for a caller (or a real project_id) to influence its output.
 */
function trackingProvider() {
  const calls: unknown[][] = [];
  const provider = (...args: unknown[]) => {
    calls.push(args);
    return { marker: "demo-only", pm_summary: "scripted demo walkthrough" };
  };
  return { provider, calls };
}

describe("UI-6 containment — demo dashboard is structurally isolated from real projects", () => {
  it("serves demo data at /api/demo/dashboard and invokes the provider with no arguments", async () => {
    const { provider, calls } = trackingProvider();
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      projects: new ProjectStore(),
      dashboard: provider,
    });

    const res = await inject(server, "GET", "/api/demo/dashboard");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ marker: "demo-only" });

    // Structural proof: the route passes nothing to the provider, so no caller
    // input (project_id, query, body) can reach the demo data.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([]);
  });

  it("requires session auth like every other /api route", async () => {
    const { provider } = trackingProvider();
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      dashboard: provider,
    });

    const res = await inject(server, "GET", "/api/demo/dashboard", undefined, false);
    expect(res.statusCode).toBe(401);
  });

  it("no longer exposes the old unscoped /api/dashboard route", async () => {
    const { provider } = trackingProvider();
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      dashboard: provider,
    });

    const res = await inject(server, "GET", "/api/dashboard");
    expect(res.statusCode).toBe(404);
  });

  it("exposes no project-scoped dashboard route — a real project_id has nowhere to route", async () => {
    const { provider } = trackingProvider();
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      projects: new ProjectStore(),
      dashboard: provider,
    });

    // Create a real project so the id is genuinely valid elsewhere in the API...
    const created = await inject(server, "POST", "/api/projects", {
      name: "Alpha",
      description: "real project",
      pm_provider: "anthropic",
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    await inject(server, "POST", `/api/projects/${id}/plan/load`, { plan: DEMO_PLAN });

    // ...yet there is no dashboard route that accepts it, on either surface.
    expect((await inject(server, "GET", `/api/projects/${id}/dashboard`)).statusCode).toBe(404);
    expect((await inject(server, "GET", `/api/demo/dashboard/${id}`)).statusCode).toBe(404);
  });

  it("returns byte-identical output regardless of query params a caller might append", async () => {
    const { provider } = trackingProvider();
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      projects: new ProjectStore(),
      dashboard: provider,
    });

    const plain = await inject(server, "GET", "/api/demo/dashboard");
    const withProjectId = await inject(server, "GET", "/api/demo/dashboard?project_id=proj-alpha");
    expect(withProjectId.statusCode).toBe(200);
    // The query string is inert: same demo payload either way.
    expect(JSON.stringify(withProjectId.json())).toEqual(JSON.stringify(plain.json()));
  });

  it("omits the demo dashboard route entirely when no demo provider is configured", async () => {
    server = await buildServer({
      stores: new RelayStores(),
      sessionToken: TOKEN,
      projects: new ProjectStore(),
      // no `dashboard` provider
    });

    expect((await inject(server, "GET", "/api/demo/dashboard")).statusCode).toBe(404);
  });
});
