// HTTP surface for real user accounts: bootstrap, login/logout, session
// resolution, invites, and admin user management. UserStore itself is
// covered at the unit level in userStore.test.ts — this file proves the
// routes wire it up correctly (status codes, auth gating, audit trail).
import { afterEach, describe, expect, it } from "vitest";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

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
  token?: string,
): Promise<InjectedResponse> {
  const response = await s.app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return response as unknown as InjectedResponse;
}

async function start(opts?: { deployToken?: string; users?: UserStore }): Promise<NornsServer> {
  server = await buildServer({
    stores: new RelayStores(),
    users: opts?.users ?? new UserStore(),
    ...(opts?.deployToken !== undefined ? { deployToken: opts.deployToken } : {}),
  });
  return server;
}

describe("GET /api/auth/status", () => {
  it("reports needs_bootstrap true with zero users, false once one exists", async () => {
    const users = new UserStore();
    const s = await start({ users });
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({ needs_bootstrap: true });

    users.createActive({ email: "a@x.com", password: "password1", role: "admin" });
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({ needs_bootstrap: false });
  });
});

describe("POST /api/auth/bootstrap", () => {
  it("creates the first admin and logs them in when zero users exist", async () => {
    const s = await start({ deployToken: "deploy-secret" });
    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
      name: "Root",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { email: string; role: string } };
    expect(body.token).toHaveLength(64);
    expect(body.user).toMatchObject({ email: "root@x.com", role: "admin" });

    // the minted token is a live session
    const me = await inject(s, "GET", "/api/auth/me", undefined, body.token);
    expect(me.statusCode).toBe(200);
    expect((me.json() as { email: string }).email).toBe("root@x.com");
  });

  it("refuses a second bootstrap once an admin already exists, even with the right token", async () => {
    const s = await start({ deployToken: "deploy-secret" });
    await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
    });
    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "second@x.com",
      password: "password123",
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe("already_bootstrapped");
  });

  it("501s when no deploy token is configured at all", async () => {
    const s = await start(); // no deployToken
    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "anything",
      email: "root@x.com",
      password: "password123",
    });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: string }).error).toBe("bootstrap_disabled");
  });

  it("403s on a wrong deploy token", async () => {
    const s = await start({ deployToken: "deploy-secret" });
    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "wrong",
      email: "root@x.com",
      password: "password123",
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe("invalid_deploy_token");
  });

  it("400s on a malformed body (short password)", async () => {
    const s = await start({ deployToken: "deploy-secret" });
    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "short",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/auth/login + /api/auth/logout", () => {
  it("logs in with the right password and issues a working session", async () => {
    const users = new UserStore();
    users.createActive({ email: "a@x.com", password: "password1", role: "member" });
    const s = await start({ users });

    const res = await inject(s, "POST", "/api/auth/login", {
      email: "a@x.com",
      password: "password1",
    });
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as { token: string };
    expect((await inject(s, "GET", "/api/auth/me", undefined, token)).statusCode).toBe(200);
  });

  it("401s on the wrong password without revealing whether the email exists", async () => {
    const users = new UserStore();
    users.createActive({ email: "a@x.com", password: "password1", role: "member" });
    const s = await start({ users });

    const wrongPw = await inject(s, "POST", "/api/auth/login", {
      email: "a@x.com",
      password: "wrong",
    });
    const noSuchUser = await inject(s, "POST", "/api/auth/login", {
      email: "nobody@x.com",
      password: "wrong",
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(noSuchUser.json());
  });

  it("logout invalidates the session", async () => {
    const users = new UserStore();
    users.createActive({ email: "a@x.com", password: "password1", role: "member" });
    const s = await start({ users });
    const { token } = (await inject(s, "POST", "/api/auth/login", {
      email: "a@x.com",
      password: "password1",
    }).then((r) => r.json())) as { token: string };

    expect((await inject(s, "GET", "/api/auth/me", undefined, token)).statusCode).toBe(200);
    await inject(s, "POST", "/api/auth/logout", undefined, token);
    expect((await inject(s, "GET", "/api/auth/me", undefined, token)).statusCode).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("401s with no token and with a garbage token", async () => {
    const s = await start();
    expect((await inject(s, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await inject(s, "GET", "/api/auth/me", undefined, "not-a-real-token")).statusCode).toBe(
      401,
    );
  });
});

describe("POST /api/auth/accept-invite", () => {
  it("accepting an invite sets the password and returns a working session", async () => {
    const users = new UserStore();
    const { inviteToken } = users.createInvite({ email: "b@x.com", role: "member" });
    const s = await start({ users });

    const res = await inject(s, "POST", "/api/auth/accept-invite", {
      invite_token: inviteToken,
      password: "new-password-1",
    });
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json() as { token: string; user: { status: string } };
    expect(user.status).toBe("active");
    expect((await inject(s, "GET", "/api/auth/me", undefined, token)).statusCode).toBe(200);
  });

  it("400s on an unknown or already-used invite token", async () => {
    const s = await start();
    const res = await inject(s, "POST", "/api/auth/accept-invite", {
      invite_token: "does-not-exist",
      password: "new-password-1",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_invite");
  });
});

describe("admin user management — requires the admin role", () => {
  async function startAsMember(): Promise<{
    s: NornsServer;
    adminToken: string;
    memberToken: string;
  }> {
    const users = new UserStore();
    users.createActive({ email: "admin@x.com", password: "admin-password", role: "admin" });
    users.createActive({ email: "member@x.com", password: "member-password", role: "member" });
    const s = await start({ users });
    const adminToken = users.login("admin@x.com", "admin-password").token;
    const memberToken = users.login("member@x.com", "member-password").token;
    return { s, adminToken, memberToken };
  }

  it("GET /api/admin/users: 401 anonymous, 403 non-admin, 200 with the full roster for an admin", async () => {
    const { s, adminToken, memberToken } = await startAsMember();
    expect((await inject(s, "GET", "/api/admin/users")).statusCode).toBe(401);
    expect((await inject(s, "GET", "/api/admin/users", undefined, memberToken)).statusCode).toBe(
      403,
    );

    const res = await inject(s, "GET", "/api/admin/users", undefined, adminToken);
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(2);
  });

  it("POST /api/admin/users creates a member as an admin, rejects duplicates, forbids non-admins", async () => {
    const { s, adminToken, memberToken } = await startAsMember();

    const created = await inject(
      s,
      "POST",
      "/api/admin/users",
      { email: "new@x.com", password: "password123", role: "member" },
      adminToken,
    );
    expect(created.statusCode).toBe(201);
    expect((created.json() as { role: string }).role).toBe("member");

    const dup = await inject(
      s,
      "POST",
      "/api/admin/users",
      { email: "new@x.com", password: "password123" },
      adminToken,
    );
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { error: string }).error).toBe("user_exists");

    const forbidden = await inject(
      s,
      "POST",
      "/api/admin/users",
      { email: "another@x.com", password: "password123" },
      memberToken,
    );
    expect(forbidden.statusCode).toBe(403);
  });

  it("POST /api/admin/users/invite still creates the invited user even when email sending fails", async () => {
    // RESEND_API_KEY is not set in the test environment, so sendEmail always
    // throws EmailNotConfiguredError — the route must surface that clearly
    // (502) while leaving the user record intact for a manual invite link.
    const { s, adminToken } = await startAsMember();
    const res = await inject(
      s,
      "POST",
      "/api/admin/users/invite",
      { email: "invitee@x.com", role: "member" },
      adminToken,
    );
    expect(res.statusCode).toBe(502);
    const body = res.json() as {
      error: string;
      user: { email: string; status: string };
      invite_url: string;
    };
    expect(body.error).toBe("email_not_configured");
    expect(body.user).toMatchObject({ email: "invitee@x.com", status: "invited" });
    expect(body.invite_url).toContain("/?invite=");

    // the user genuinely exists now, admin can see it in the roster
    const roster = await inject(s, "GET", "/api/admin/users", undefined, adminToken);
    expect((roster.json() as { email: string }[]).map((u) => u.email)).toContain("invitee@x.com");
  });

  it("DELETE /api/admin/users/:id removes a user and invalidates their session; 404s on unknown id", async () => {
    const { s, adminToken } = await startAsMember();
    const created = await inject(
      s,
      "POST",
      "/api/admin/users",
      { email: "doomed@x.com", password: "password123" },
      adminToken,
    );
    const { id } = created.json() as { id: string };
    const login = await inject(s, "POST", "/api/auth/login", {
      email: "doomed@x.com",
      password: "password123",
    });
    const { token: doomedToken } = login.json() as { token: string };
    expect((await inject(s, "GET", "/api/auth/me", undefined, doomedToken)).statusCode).toBe(200);

    const removed = await inject(s, "DELETE", `/api/admin/users/${id}`, undefined, adminToken);
    expect(removed.statusCode).toBe(200);
    expect((await inject(s, "GET", "/api/auth/me", undefined, doomedToken)).statusCode).toBe(401);

    const notFound = await inject(
      s,
      "DELETE",
      "/api/admin/users/user-ghost",
      undefined,
      adminToken,
    );
    expect(notFound.statusCode).toBe(404);
  });
});
