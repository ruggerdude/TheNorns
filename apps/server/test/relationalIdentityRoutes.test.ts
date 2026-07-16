import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PGliteDatabaseLike,
  PGliteTransactionRunner,
} from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { RelationalIdentityService } from "../src/users/relationalIdentityService.js";
import { UserStore } from "../src/users/store.js";

const CREDENTIAL_KEY = {
  keyId: "identity-route-key",
  key: Buffer.alloc(32, 21),
};

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
}

async function inject(
  server: NornsServer,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  token?: string,
): Promise<InjectedResponse> {
  const response = await server.app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

function inviteToken(response: InjectedResponse): string {
  const body = response.json() as { invite_url?: string };
  if (!body.invite_url) throw new Error("expected a manual invitation URL");
  const token = new URL(body.invite_url).searchParams.get("invite");
  if (!token) throw new Error("expected an invitation token");
  return token;
}

describe.sequential("relational identity HTTP routes", () => {
  const databases: PGlite[] = [];
  const servers: NornsServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.app.close()));
    await Promise.all(
      databases.splice(0).map(async (database) => {
        if (!database.closed) await database.close();
      }),
    );
  });

  it("survives restart and drives auth, admin, invite, logout, and soft-disable routes", async () => {
    const previousResendKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = undefined;
    try {
      const pg = new PGlite();
      databases.push(pg);
      await pg.exec(`
        CREATE ROLE norns_app NOLOGIN;
        CREATE TABLE norns_state (
          key TEXT PRIMARY KEY,
          snapshot JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO norns_state (key, snapshot) VALUES
          ('users', '{"users":[],"sessions":[]}'::jsonb),
          ('projects', '{"projects":[]}'::jsonb),
          ('relay', '{"audit":[]}'::jsonb);
      `);
      await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);

      const transactions = new PGliteTransactionRunner(pg as unknown as PGliteDatabaseLike);
      let randomCounter = 1;
      let idCounter = 1;
      const makeIdentity = (): RelationalIdentityService =>
        new RelationalIdentityService({
          transactions,
          credentialKey: CREDENTIAL_KEY,
          clock: () => new Date("2026-07-16T21:00:00.000Z"),
          newId: () => `route-user-${idCounter++}`,
          randomBytes: (size) => Buffer.alloc(size, randomCounter++),
        });

      const firstIdentity = makeIdentity();
      await firstIdentity.createActive({
        email: "admin@example.com",
        name: "Admin",
        password: "admin-password",
        role: "admin",
      });
      const firstServer = await buildServer({
        stores: new RelayStores(),
        users: new UserStore(),
        identity: firstIdentity,
      });
      servers.push(firstServer);

      expect((await inject(firstServer, "GET", "/api/auth/status")).json()).toEqual({
        needs_bootstrap: false,
      });
      const login = await inject(firstServer, "POST", "/api/auth/login", {
        email: "admin@example.com",
        password: "admin-password",
      });
      expect(login.statusCode).toBe(200);
      const adminToken = (login.json() as { token: string }).token;
      expect(
        (await inject(firstServer, "GET", "/api/auth/me", undefined, adminToken)).statusCode,
      ).toBe(200);

      // Rebuild both the HTTP server and identity service. The original token
      // must remain authorized because only its HMAC verifier is persisted.
      await firstServer.app.close();
      servers.splice(servers.indexOf(firstServer), 1);
      const restartedIdentity = makeIdentity();
      const restartedServer = await buildServer({
        stores: new RelayStores(),
        users: new UserStore(),
        identity: restartedIdentity,
      });
      servers.push(restartedServer);
      expect(
        (await inject(restartedServer, "GET", "/api/auth/me", undefined, adminToken)).statusCode,
      ).toBe(200);
      const roster = await inject(
        restartedServer,
        "GET",
        "/api/admin/users",
        undefined,
        adminToken,
      );
      expect(roster.statusCode).toBe(200);
      expect(roster.json()).toEqual([
        expect.objectContaining({ email: "admin@example.com", role: "admin" }),
      ]);

      // Email is deliberately unavailable in this test, so the route returns
      // the manual URL while retaining the durable invited identity.
      const firstInvite = await inject(
        restartedServer,
        "POST",
        "/api/admin/users/invite",
        { email: "invitee@example.com", name: "Invitee", role: "member" },
        adminToken,
      );
      expect(firstInvite.statusCode).toBe(502);
      const firstInviteToken = inviteToken(firstInvite);
      const firstInvitedId = (firstInvite.json() as { user: { id: string } }).user.id;

      const reissuedInvite = await inject(
        restartedServer,
        "POST",
        "/api/admin/users/invite",
        { email: "INVITEE@EXAMPLE.COM", name: "Ignored Update", role: "admin" },
        adminToken,
      );
      expect(reissuedInvite.statusCode).toBe(502);
      expect((reissuedInvite.json() as { user: { id: string; role: string } }).user).toMatchObject({
        id: firstInvitedId,
        role: "member",
      });
      const reissuedToken = inviteToken(reissuedInvite);

      expect(
        (
          await inject(restartedServer, "POST", "/api/auth/accept-invite", {
            invite_token: firstInviteToken,
            password: "invitee-password",
          })
        ).statusCode,
      ).toBe(400);
      const accepted = await inject(restartedServer, "POST", "/api/auth/accept-invite", {
        invite_token: reissuedToken,
        password: "invitee-password",
      });
      expect(accepted.statusCode).toBe(200);
      const inviteeToken = (accepted.json() as { token: string }).token;
      expect(
        (await inject(restartedServer, "GET", "/api/auth/me", undefined, inviteeToken)).statusCode,
      ).toBe(200);
      expect(
        (await inject(restartedServer, "GET", "/api/admin/users", undefined, inviteeToken))
          .statusCode,
      ).toBe(403);

      const createdMember = await inject(
        restartedServer,
        "POST",
        "/api/admin/users",
        { email: "member@example.com", password: "member-password", role: "member" },
        adminToken,
      );
      expect(createdMember.statusCode).toBe(201);
      const memberId = (createdMember.json() as { id: string }).id;
      const memberLogin = await inject(restartedServer, "POST", "/api/auth/login", {
        email: "member@example.com",
        password: "member-password",
      });
      const memberToken = (memberLogin.json() as { token: string }).token;
      const removed = await inject(
        restartedServer,
        "DELETE",
        `/api/admin/users/${memberId}`,
        undefined,
        adminToken,
      );
      expect(removed.statusCode).toBe(200);
      expect(
        (await inject(restartedServer, "GET", "/api/auth/me", undefined, memberToken)).statusCode,
      ).toBe(401);
      const preserved = await pg.query<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count
         FROM users WHERE id = $1
         GROUP BY status`,
        [memberId],
      );
      expect(preserved.rows[0]).toEqual({ status: "disabled", count: 1 });

      const logout = await inject(
        restartedServer,
        "POST",
        "/api/auth/logout",
        undefined,
        adminToken,
      );
      expect(logout.statusCode).toBe(200);
      expect(
        (await inject(restartedServer, "GET", "/api/auth/me", undefined, adminToken)).statusCode,
      ).toBe(401);
    } finally {
      if (previousResendKey === undefined) process.env.RESEND_API_KEY = undefined;
      else process.env.RESEND_API_KEY = previousResendKey;
    }
  });
});
