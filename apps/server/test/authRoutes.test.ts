// HTTP surface for real user accounts: bootstrap, login/logout, session
// resolution, invites, and admin user management. UserStore itself is
// covered at the unit level in userStore.test.ts — this file proves the
// routes wire it up correctly (status codes, auth gating, audit trail).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubIntegrationService } from "../src/integrations/github.js";
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
  body: string;
  headers: Record<string, string | string[] | undefined>;
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

async function start(opts?: {
  deployToken?: string;
  users?: UserStore;
  persistUsers?: () => Promise<void>;
  integrationEnvironment?: NodeJS.ProcessEnv;
  github?: GitHubIntegrationService;
}): Promise<NornsServer> {
  server = await buildServer({
    stores: new RelayStores(),
    users: opts?.users ?? new UserStore(),
    ...(opts?.deployToken !== undefined ? { deployToken: opts.deployToken } : {}),
    ...(opts?.persistUsers !== undefined ? { persistUsers: opts.persistUsers } : {}),
    ...(opts?.integrationEnvironment !== undefined
      ? { integrationEnvironment: opts.integrationEnvironment }
      : {}),
    ...(opts?.github !== undefined ? { integrations: { github: opts.github } } : {}),
  });
  return server;
}

describe("GET /api/auth/status", () => {
  it("requires bootstrap until an active administrator exists", async () => {
    const users = new UserStore();
    const s = await start({ users });
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({ needs_bootstrap: true });

    users.createActive({ email: "member@x.com", password: "password1", role: "member" });
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({ needs_bootstrap: true });

    users.createInvite({ email: "invited-admin@x.com", role: "admin" });
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({ needs_bootstrap: true });

    users.createActive({ email: "admin@x.com", password: "password1", role: "admin" });
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({ needs_bootstrap: false });
  });
});

describe("GET /api/integrations/ai/status", () => {
  it("reports provider readiness without returning secret values", async () => {
    const s = await start({
      deployToken: "deploy-secret",
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "anthropic-secret",
        NORNS_PM_MODEL: "claude-sonnet-5",
        NORNS_OPENAI_MODEL: "gpt-5.6-sol",
      },
    });
    const bootstrap = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
      name: "Root",
    });
    const token = (bootstrap.json() as { token: string }).token;

    expect((await inject(s, "GET", "/api/integrations/ai/status")).statusCode).toBe(401);
    const status = await inject(s, "GET", "/api/integrations/ai/status", undefined, token);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      cross_provider_ready: false,
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          configured: true,
          model: "claude-sonnet-5",
          required_environment: ["ANTHROPIC_API_KEY"],
        },
        {
          id: "openai",
          name: "OpenAI",
          configured: false,
          model: "gpt-5.6-sol",
          required_environment: ["OPENAI_API_KEY", "NORNS_OPENAI_MODEL"],
        },
      ],
    });
    expect(JSON.stringify(status.json())).not.toContain("anthropic-secret");
  });
});

describe("GitHub App manifest setup routes", () => {
  it("serves an authenticated auto-submitting GitHub manifest form", async () => {
    const manifestRegistration = vi.fn(() => ({
      action: "https://github.com/organizations/norns-org/settings/apps/new",
      manifest: JSON.stringify({ name: "The Norns", callback_urls: ["https://norns.example/cb"] }),
      state: "signed-state",
    }));
    const github = { manifestRegistration } as unknown as GitHubIntegrationService;
    const s = await start({ deployToken: "deploy-secret", github });
    const bootstrap = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
      name: "Root",
    });
    const token = (bootstrap.json() as { token: string }).token;
    expect((await inject(s, "GET", "/api/integrations/github/manifest/start")).statusCode).toBe(
      401,
    );

    const response = await inject(
      s,
      "GET",
      "/api/integrations/github/manifest/start?owner_type=organization&organization=norns-org",
      undefined,
      token,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("form-action https://github.com");
    expect(response.body).toContain('method="post"');
    expect(response.body).toContain(
      'action="https://github.com/organizations/norns-org/settings/apps/new"',
    );
    expect(response.body).toContain('name="manifest"');
    expect(response.body).toContain("&quot;The Norns&quot;");
    expect(response.body).not.toContain('<input type="hidden" name="manifest" value="{"');
    const manifestCookie = Array.isArray(response.headers["set-cookie"])
      ? response.headers["set-cookie"][0]
      : response.headers["set-cookie"];
    expect(manifestCookie).toContain("norns_github_manifest_state=signed-state");
    expect(manifestCookie).toContain("HttpOnly");
    expect(manifestCookie).toContain("SameSite=Lax");
    expect(manifestRegistration).toHaveBeenCalledWith(expect.any(String), "norns-org");
  });

  it("converts the manifest then continues into authorization and installation", async () => {
    const completeManifest = vi.fn(async () => undefined);
    const github = {
      manifestUserId: vi.fn(() => "admin-1"),
      completeManifest,
      authorizationUrl: vi.fn(
        () => "https://github.com/login/oauth/authorize?client_id=Iv1.guided",
      ),
    } as unknown as GitHubIntegrationService;
    const s = await start({ github });
    const response = (await s.app.inject({
      method: "GET",
      url: "/api/integrations/github/manifest/callback?code=manifest-code",
      headers: { cookie: "norns_github_manifest_state=signed-state" },
    })) as unknown as InjectedResponse;
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "https://github.com/login/oauth/authorize?client_id=Iv1.guided",
    );
    expect(completeManifest).toHaveBeenCalledWith("admin-1", "manifest-code", "signed-state");
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
  });
});

describe("legacy control-page authentication", () => {
  it("redirects /control to account login and serves no manual token prompt", async () => {
    const s = await start();

    const control = await s.app.inject({ method: "GET", url: "/control" });
    expect(control.statusCode).toBe(302);
    expect(control.headers.location).toBe("/");

    const root = await s.app.inject({ method: "GET", url: "/" });
    expect(root.body).toContain("email and password");
    expect(root.body).not.toMatch(/session token|access token/i);
  });
});

describe("POST /api/auth/bootstrap", () => {
  it("creates the first admin and logs them in when no active admin exists", async () => {
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

  it("allows bootstrap when only members and unaccepted admin invites exist", async () => {
    const users = new UserStore();
    users.createActive({ email: "member@x.com", password: "password1", role: "member" });
    users.createInvite({ email: "invited-admin@x.com", role: "admin" });
    const s = await start({ users, deployToken: "deploy-secret" });

    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
    });

    expect(res.statusCode).toBe(201);
    expect((res.json() as { user: { role: string } }).user.role).toBe("admin");
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({
      needs_bootstrap: false,
    });
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

  it("waits for durable user persistence before acknowledging bootstrap", async () => {
    const users = new UserStore();
    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const s = await start({
      users,
      deployToken: "deploy-secret",
      persistUsers: async () => {
        expect(users.hasActiveAdmin).toBe(true);
        persistenceStarted();
        await held;
      },
    });

    let settled = false;
    const pending = inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
    }).then((response) => {
      settled = true;
      return response;
    });

    await started;
    await Promise.resolve();
    expect(settled).toBe(false);

    releasePersistence();
    expect((await pending).statusCode).toBe(201);
  });

  it("rolls bootstrap back and returns 503 when user persistence fails", async () => {
    const users = new UserStore();
    users.createActive({ email: "member@x.com", password: "password1", role: "member" });
    const beforeBootstrap = users.snapshot();
    const s = await start({
      users,
      deployToken: "deploy-secret",
      persistUsers: async () => {
        throw new Error("database unavailable");
      },
    });

    const res = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "deploy-secret",
      email: "root@x.com",
      password: "password123",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "auth_persistence_unavailable" });
    expect(users.snapshot()).toEqual(beforeBootstrap);
    expect(users.hasActiveAdmin).toBe(false);
    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({
      needs_bootstrap: true,
    });
    expect(
      (
        await inject(s, "POST", "/api/auth/login", {
          email: "root@x.com",
          password: "password123",
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("POST /api/auth/login + /api/auth/logout", () => {
  it("logs a restored admin in with email/password when no deploy token is configured", async () => {
    const seeded = new UserStore();
    seeded.createActive({ email: "admin@x.com", password: "admin-password", role: "admin" });
    const users = new UserStore();
    users.restoreFrom(seeded.snapshot());
    const s = await start({ users });

    expect((await inject(s, "GET", "/api/auth/status")).json()).toEqual({
      needs_bootstrap: false,
    });
    const loginResponse = await inject(s, "POST", "/api/auth/login", {
      email: "admin@x.com",
      password: "admin-password",
    });
    expect(loginResponse.statusCode).toBe(200);

    const bootstrapResponse = await inject(s, "POST", "/api/auth/bootstrap", {
      deploy_token: "unused",
      email: "second@x.com",
      password: "password123",
    });
    expect(bootstrapResponse.statusCode).toBe(403);
    expect(bootstrapResponse.json()).toEqual({ error: "already_bootstrapped" });
  });

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

  it("throttles repeated failures before another credential check", async () => {
    const users = new UserStore();
    users.createActive({ email: "throttle@x.com", password: "password1", role: "member" });
    const s = await start({ users });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await inject(s, "POST", "/api/auth/login", {
            email: "throttle@x.com",
            password: "wrong",
          })
        ).statusCode,
      ).toBe(401);
    }
    const blocked = await inject(s, "POST", "/api/auth/login", {
      email: "throttle@x.com",
      password: "password1",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: "login_throttled" });
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

  it("refuses to remove the last active administrator", async () => {
    const users = new UserStore();
    const admin = users.createActive({
      email: "admin@x.com",
      password: "admin-password",
      role: "admin",
    });
    const adminToken = users.login("admin@x.com", "admin-password").token;
    const s = await start({ users });

    const response = await inject(
      s,
      "DELETE",
      `/api/admin/users/${admin.id}`,
      undefined,
      adminToken,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "last_active_admin",
      message: "the last active administrator cannot be removed",
    });
    expect(users.hasActiveAdmin).toBe(true);
  });
});
