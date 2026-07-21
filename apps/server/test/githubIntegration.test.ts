import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GitHubIntegrationService,
  githubIntegrationConfigFromEnvironment,
} from "../src/integrations/github.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe.sequential("workspace GitHub integration", () => {
  let pg: PGlite;
  let service: GitHubIntegrationService;
  let http: ReturnType<typeof vi.fn>;
  let manifestPrivateKey: string;
  let transientAccessTokenFailures = 0;

  beforeAll(async () => {
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
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    manifestPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const config = githubIntegrationConfigFromEnvironment(
      {
        NORNS_GITHUB_APP_ID: "1234",
        NORNS_GITHUB_CLIENT_ID: "Iv1.test",
        NORNS_GITHUB_CLIENT_SECRET: "client-secret",
        NORNS_GITHUB_APP_SLUG: "the-norns-test",
        NORNS_GITHUB_PRIVATE_KEY: manifestPrivateKey,
        NORNS_GITHUB_STATE_SECRET: "state-secret-that-is-at-least-thirty-two-bytes",
        NORNS_GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
      "https://norns.example",
    );
    if (!config) throw new Error("expected GitHub test configuration");

    http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return json({
          access_token: "github-user-token",
          refresh_token: "github-refresh-token",
          expires_in: 28_800,
          refresh_token_expires_in: 15_552_000,
        });
      }
      if (url === "https://api.github.com/app-manifests/manifest-code/conversions") {
        return json(
          {
            id: 5678,
            slug: "the-norns-guided",
            client_id: "Iv1.guided",
            client_secret: "guided-client-secret",
            pem: manifestPrivateKey,
            webhook_secret: null,
          },
          201,
        );
      }
      if (url === "https://api.github.com/user") {
        return json({ id: 101, login: "octocat" });
      }
      if (url === "https://api.github.com/user/installations?per_page=100") {
        return json({
          installations: [
            {
              id: 42,
              account: { id: 101, login: "octocat", type: "User" },
              repository_selection: "all",
            },
          ],
        });
      }
      if (url === "https://api.github.com/app/installations/42/access_tokens") {
        if (transientAccessTokenFailures > 0) {
          transientAccessTokenFailures -= 1;
          return json({ message: "No server is currently available to service your request" }, 503);
        }
        expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /) });
        return json({ token: "installation-token", expires_at: "2026-07-17T04:00:00Z" });
      }
      if (url.startsWith("https://api.github.com/installation/repositories")) {
        return json({ repositories: [repository()] });
      }
      if (url === "https://api.github.com/repositories/9001") {
        return json(repository());
      }
      if (url === "https://api.github.com/user/repos") {
        return json(
          { ...repository(), id: 9002, name: "created", full_name: "octocat/created" },
          201,
        );
      }
      // ONBOARDING O4: createRepository now asks GitHub whether the new
      // repository is actually reachable through the installation, instead of
      // inferring it from repository_selection and then ignoring the answer.
      if (url === "https://api.github.com/repos/octocat/created") {
        return json({ ...repository(), id: 9002, name: "created", full_name: "octocat/created" });
      }
      return json({ message: `unhandled ${url}` }, 500);
    });
    service = new GitHubIntegrationService(
      new PGliteTransactionRunner(pg as never),
      config,
      http as typeof fetch,
    );
  }, 30_000);

  afterAll(async () => {
    if (!pg.closed) await pg.close();
  });

  it("stores an encrypted user authorization and discovers workspace installations", async () => {
    const authorizationUrl = new URL(service.authorizationUrl("norns-user-1"));
    expect(authorizationUrl.origin).toBe("https://github.com");
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("authorization state missing");

    await service.completeAuthorization("norns-user-1", "oauth-code", state);

    const stored = await pg.query<{
      access_token_ciphertext: string;
      refresh_token_ciphertext: string;
    }>("SELECT access_token_ciphertext, refresh_token_ciphertext FROM github_user_authorizations");
    expect(stored.rows[0]?.access_token_ciphertext).not.toContain("github-user-token");
    expect(stored.rows[0]?.refresh_token_ciphertext).not.toContain("github-refresh-token");
    await expect(service.status("norns-user-1", false)).resolves.toMatchObject({
      configured: true,
      user_authorization: { connected: true, login: "octocat" },
      connections: [
        {
          id: "github:42",
          owner_login: "octocat",
          owner_type: "user",
          repository_selection: "all",
        },
      ],
    });
  });

  it("lists and resolves repositories through an installation token", async () => {
    await expect(
      service.listRepositories("another-workspace-user", "github:42"),
    ).resolves.toMatchObject([
      {
        id: "9001",
        connection_id: "github:42",
        full_name: "octocat/hello-world",
        default_branch: "main",
      },
    ]);
    await expect(
      service.resolveRepository("another-workspace-user", "github:42", "9001"),
    ).resolves.toMatchObject({ full_name: "octocat/hello-world" });
  });

  it("retries a transient GitHub outage while loading repositories", async () => {
    const tokenRequestsBefore = http.mock.calls.filter(([input]) =>
      String(input).endsWith("/app/installations/42/access_tokens"),
    ).length;
    transientAccessTokenFailures = 1;

    await expect(service.listRepositories("norns-user-1", "github:42")).resolves.toMatchObject([
      { id: "9001", full_name: "octocat/hello-world" },
    ]);

    const tokenRequestsAfter = http.mock.calls.filter(([input]) =>
      String(input).endsWith("/app/installations/42/access_tokens"),
    ).length;
    expect(tokenRequestsAfter - tokenRequestsBefore).toBe(2);
  });

  it("creates a repository for the authorized personal account", async () => {
    await expect(
      service.createRepository("norns-user-1", {
        connection_id: "github:42",
        name: "created",
        description: "Created by The Norns",
        private: true,
        auto_init: true,
      }),
    ).resolves.toMatchObject({
      id: "9002",
      full_name: "octocat/created",
      binding_ready: true,
      // ONBOARDING O4: the readiness state that replaced the inert flag.
      installation: {
        ready: true,
        reason: "ready",
        installation_id: "42",
        action_required: null,
      },
    });
  });

  it("treats an entirely absent GitHub configuration as disabled", () => {
    expect(githubIntegrationConfigFromEnvironment({}, "https://norns.example")).toBeNull();
  });

  it("creates, encrypts, and reloads a GitHub App through the manifest flow", async () => {
    const rootKey = { keyId: "credential-v1", key: Buffer.alloc(32, 19) };
    const bootstrap = {
      publicOrigin: "https://norns.example",
      currentKey: rootKey,
      keys: new Map([[rootKey.keyId, rootKey]]),
    };
    const guided = new GitHubIntegrationService(
      new PGliteTransactionRunner(pg as never),
      null,
      http as typeof fetch,
      bootstrap,
    );
    await guided.loadStoredConfiguration();
    await expect(guided.status("manifest-admin", false)).resolves.toMatchObject({
      configured: false,
      setup_available: true,
      configuration_source: null,
    });

    const registration = guided.manifestRegistration("manifest-admin", "norns-org");
    expect(registration.action).toBe(
      "https://github.com/organizations/norns-org/settings/apps/new",
    );
    expect(JSON.parse(registration.manifest)).toMatchObject({
      url: "https://norns.example",
      redirect_url: "https://norns.example/api/integrations/github/manifest/callback",
      callback_urls: ["https://norns.example/api/integrations/github/callback"],
      setup_url: "https://norns.example/api/integrations/github/setup",
      default_permissions: {
        contents: "write",
        pull_requests: "write",
      },
    });

    await guided.completeManifest("manifest-admin", "manifest-code", registration.state);
    const stored = await pg.query<{
      key_id: string;
      app_id: string;
      client_id: string;
      app_slug: string;
      credentials_ciphertext: string;
    }>(
      `SELECT key_id, app_id, client_id, app_slug, credentials_ciphertext
       FROM github_app_configurations`,
    );
    expect(stored.rows[0]).toMatchObject({
      key_id: "credential-v1",
      app_id: "5678",
      client_id: "Iv1.guided",
      app_slug: "the-norns-guided",
    });
    expect(stored.rows[0]?.credentials_ciphertext).not.toContain("guided-client-secret");
    expect(stored.rows[0]?.credentials_ciphertext).not.toContain("PRIVATE KEY");
    expect(stored.rows[0]?.credentials_ciphertext).not.toContain("webhook_secret");

    const reloaded = new GitHubIntegrationService(
      new PGliteTransactionRunner(pg as never),
      null,
      http as typeof fetch,
      bootstrap,
    );
    await reloaded.loadStoredConfiguration();
    await expect(reloaded.status("manifest-admin", false)).resolves.toMatchObject({
      configured: true,
      setup_available: false,
      configuration_source: "manifest",
    });
    expect(new URL(reloaded.authorizationUrl("manifest-admin")).searchParams.get("client_id")).toBe(
      "Iv1.guided",
    );
  });
});

function repository() {
  return {
    id: 9001,
    name: "hello-world",
    full_name: "octocat/hello-world",
    private: true,
    default_branch: "main",
    html_url: "https://github.com/octocat/hello-world",
    clone_url: "https://github.com/octocat/hello-world.git",
    description: "A connected repository",
    language: "TypeScript",
    archived: false,
    updated_at: "2026-07-16T20:00:00Z",
    owner: { login: "octocat" },
  };
}
