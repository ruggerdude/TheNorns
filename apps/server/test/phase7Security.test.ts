import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";
import { UserStore } from "../src/users/store.js";

describe.sequential("Phase 7 browser and account security", () => {
  let pg: PGlite;
  let server: NornsServer;
  let identity: RelationalIdentityService;
  let currentTime: Date;

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
    currentTime = new Date("2026-07-16T21:00:00.000Z");
    let randomByte = 1;
    let userId = 0;
    identity = new RelationalIdentityService({
      transactions: new PGliteTransactionRunner(pg),
      credentialKey: { keyId: "phase7-key", key: Buffer.alloc(32, 31) },
      clock: () => new Date(currentTime),
      newId: () => `phase7-user-${++userId}`,
      randomBytes: (size) => Buffer.alloc(size, randomByte++),
    });
    await identity.createActive({
      email: "admin@example.com",
      password: "initial-password",
      role: "admin",
    });
    server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      identity,
      secureCookies: true,
      clock: () => new Date(currentTime),
    });
  });

  afterEach(async () => {
    await server.app.close();
    await pg.close();
  });

  it("uses HttpOnly cookies, rejects CSRF, enforces recent auth, inventories sessions, and recovers passwords", async () => {
    const login = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "initial-password" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).not.toHaveProperty("token");
    const loginBody = login.json() as { csrf_token: string };
    const setCookie = login.headers["set-cookie"];
    const cookieLines = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const sessionCookie = cookieLines.find((line) => line.startsWith("norns_session="));
    const csrfCookie = cookieLines.find((line) => line.startsWith("norns_csrf="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(csrfCookie).not.toContain("HttpOnly");
    const cookieHeader = cookieLines.map((line) => line.split(";")[0]).join("; ");

    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);

    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: cookieHeader },
      payload: { email: "member@example.com", password: "member-password", role: "member" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ error: "csrf_rejected" });

    const created = await server.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: cookieHeader, "x-csrf-token": loginBody.csrf_token },
      payload: { email: "member@example.com", password: "member-password", role: "member" },
    });
    expect(created.statusCode).toBe(201);

    const inventory = await server.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: cookieHeader },
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({
      sessions: [{ status: "active", current: true }],
    });

    currentTime = new Date("2026-07-16T21:16:00.000Z");
    const staleAdmin = await server.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: cookieHeader, "x-csrf-token": loginBody.csrf_token },
      payload: { email: "other@example.com", password: "other-password", role: "member" },
    });
    expect(staleAdmin.statusCode).toBe(403);
    expect(staleAdmin.json()).toMatchObject({ error: "recent_auth_required" });

    const recoveryToken = await identity.requestPasswordRecovery("admin@example.com");
    expect(recoveryToken).toMatch(/^norns_recovery_/);
    const stored = await pg.query<{ token_hash: string }>(
      "SELECT token_hash FROM password_recovery_tokens",
    );
    expect(stored.rows[0]?.token_hash).not.toContain(recoveryToken);
    await identity.resetPassword(recoveryToken ?? "", "replacement-password");
    await expect(identity.login("admin@example.com", "initial-password")).rejects.toThrow();
    await expect(
      identity.login("admin@example.com", "replacement-password"),
    ).resolves.toHaveProperty("token");
    const revoked = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader },
    });
    expect(revoked.statusCode).toBe(401);
    const notifications = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM security_notifications WHERE user_id='phase7-user-1'",
    );
    expect(notifications.rows[0]?.count).toBeGreaterThanOrEqual(4);
  });
});
