// EXECUTION E1/E2: an unwired service shipped dead in each of the last two
// programs (attachments, then the O2 onboarding route) — both times
// `buildServer` accepted the option and did the right thing, but nothing in
// `main.ts` ever passed it, so production ran as if the feature didn't
// exist. This suite is the check that prevents a third: it boots
// `buildServer` with the EXACT option shape `main.ts` supplies for the
// EXECUTION program (`phase4` + `execution`), asserts the routes it should
// produce actually exist, and asserts the constructor-level misconfiguration
// guard (`execution.baseUrl` must be HTTPS, or http on localhost) fails
// closed at boot rather than silently at the first runner fetch.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase4RecoveryMonitor } from "../src/coordinator/phase4RecoveryMonitor.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

describe.sequential("EXECUTION E1/E2: main.ts boot wiring", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    transactions = new PGliteTransactionRunner(pg);
  }, 60_000);

  afterEach(async () => {
    // A server built with `phase4` starts an unref'd 500ms Phase4Dispatcher
    // tick timer; its own `onClose` hook clears the timer, but a tick already
    // in flight at the moment a test's own `afterEach` closed the server can
    // still be awaiting a query against this pg instance. server.ts now
    // catches that rejection (fixed alongside this test — it was previously
    // unhandled and could have crashed a production server on a transient DB
    // error), so this is just a small courtesy delay, not a correctness fix.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!pg.closed) await pg.close();
  });

  /** Exactly the `phase4` shape `main.ts` builds (`phase4Services` there). */
  function phase4() {
    return {
      coordinator: new Phase4Coordinator(transactions),
      completion: new Phase4CompletionService(transactions),
      dispatch: new Phase4DispatchRepository(transactions),
      events: new Phase4EventProcessor(transactions),
      recovery: new Phase4RecoveryMonitor(transactions),
    };
  }

  describe("real option shape (phase4 + execution, as main.ts supplies both)", () => {
    let server: NornsServer;
    let token: string;

    beforeEach(async () => {
      const users = new UserStore();
      token = testAdminToken(users);
      server = await buildServer({
        stores: new RelayStores(),
        users,
        projects: new ProjectStore(),
        phase4: phase4(),
        execution: { transactions, baseUrl: "https://norns.example.com" },
      });
    }, 30_000);

    afterEach(async () => {
      await server?.app.close();
    });

    it("exposes the assembler on NornsServer (the object E2's trigger and E1's fetch route both need live)", () => {
      expect(server.taskContext).toBeDefined();
    });

    it("mounts the start-readiness route and requires a session", async () => {
      const response = await server.app.inject({
        method: "GET",
        url: "/api/v2/projects/proj-1/phases/phase-1/start-readiness",
      });
      // 401, not 404: the route exists and the session gate is what refuses.
      expect(response.statusCode).toBe(401);
    });

    it("mounts the start-phase route and requires a session", async () => {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/v2/projects/proj-1/phases/phase-1/start",
      });
      expect(response.statusCode).toBe(401);
    });

    it("an authenticated start-readiness call reaches PhaseLaunchService, not a 404", async () => {
      const response = await server.app.inject({
        method: "GET",
        url: "/api/v2/projects/proj-1/phases/phase-1/start-readiness",
        headers: { authorization: `Bearer ${token}` },
      });
      // The project/phase don't exist, so PhaseLaunchService's readiness()
      // reports it honestly (200, ready:false, phase_not_ready) rather than
      // throwing — proof the route is live and dispatching into real
      // PhaseLaunchService code, not 401 (session works) or 404 (route
      // missing).
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ready: false,
        blocking_code: "phase_not_ready",
      });
    });

    it("the runner-facing task-context fetch route is live (401s an unsigned request, not 404)", async () => {
      const response = await server.app.inject({
        method: "GET",
        url: "/api/v2/execution/task-context/whatever",
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("partial wiring — execution without phase4", () => {
    it("mounts E1's fetch route but never the start-phase trigger, so a half-wired boot fails safe, not silently", async () => {
      const users = new UserStore();
      const server = await buildServer({
        stores: new RelayStores(),
        users,
        projects: new ProjectStore(),
        execution: { transactions, baseUrl: "https://norns.example.com" },
      });
      try {
        expect(server.taskContext).toBeDefined();
        const start = await server.app.inject({
          method: "POST",
          url: "/api/v2/projects/proj-1/phases/phase-1/start",
        });
        expect(start.statusCode).toBe(404);
      } finally {
        await server.app.close();
      }
    });
  });

  describe("misconfigured baseUrl fails at boot, not at the first runner fetch", () => {
    it("rejects a non-HTTPS, non-localhost baseUrl", async () => {
      await expect(
        buildServer({
          stores: new RelayStores(),
          users: new UserStore(),
          projects: new ProjectStore(),
          phase4: phase4(),
          execution: { transactions, baseUrl: "http://example.com" },
        }),
      ).rejects.toThrow(/HTTPS/);
    });

    it("accepts http on localhost (the runner's own fetcher exception, for local dev)", async () => {
      const server = await buildServer({
        stores: new RelayStores(),
        users: new UserStore(),
        projects: new ProjectStore(),
        phase4: phase4(),
        execution: { transactions, baseUrl: "http://127.0.0.1" },
      });
      try {
        expect(server.taskContext).toBeDefined();
      } finally {
        await server.app.close();
      }
    });
  });
});
