import { afterEach, describe, expect, it } from "vitest";
import type { V2TransactionRunner } from "../src/persistence/v2/database.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

describe("deployment readiness", () => {
  let server: NornsServer | null = null;

  afterEach(async () => {
    await server?.app.close();
    server = null;
  });

  it("reports optional dependencies explicitly when running in legacy mode", async () => {
    server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      integrationEnvironment: {},
      clock: () => new Date("2026-07-25T17:00:00.000Z"),
    });

    const response = await server.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      contracts: "1.2.0",
      checked_at: "2026-07-25T17:00:00.000Z",
      dependencies: {
        database: { required: false, status: "not_configured" },
        identity: { status: "ready", mode: "legacy" },
        persistence_composition: {
          status: "not_configured",
          compatibility_bridge: false,
        },
        runners: {
          required: false,
          status: "not_registered",
          registered: 0,
          connected: 0,
          last_seen_at: null,
        },
        providers: {
          required: false,
          anthropic: false,
          openai: false,
          deepseek: false,
          cross_provider_ready: false,
        },
        execution_models: {
          required: false,
          status: "unavailable",
          available: 0,
          configured: [],
          required_environment: ["NORNS_RUNNER_ALLOWED_MODELS"],
        },
      },
    });
  });

  it("returns 503 with a bounded dependency description when the database probe fails", async () => {
    const unavailableTransactions: V2TransactionRunner = {
      transaction: async () => {
        throw new Error("secret database detail");
      },
    };
    server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      runnerInference: { transactions: unavailableTransactions },
      integrationEnvironment: {},
    });

    const response = await server.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      dependencies: {
        database: { required: true, status: "unavailable" },
      },
    });
    expect(response.body).not.toContain("secret database detail");
  });
});
