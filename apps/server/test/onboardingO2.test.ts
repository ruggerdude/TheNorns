// ONBOARDING O2: project setup, both GitHub-backed scenarios.
//
// Every project is GitHub-backed and executes in a GitHub Actions job, so
// each command produces two attachments -- a WORKSPACE (where execution
// happens) and a REMOTE (where it pushes) -- naming the same repository.
//
// The GitHub side is exercised through a fake RemoteRepositoryPort rather
// than a stubbed HTTP layer: the port IS the seam, and a fake makes "how many
// times did we create a repository?" directly observable, which is the whole
// point of the idempotency test.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  type OnboardingResult,
  ProjectOnboardingService,
} from "../src/projects/projectOnboardingService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { RelationalProjectReadRepository } from "../src/projects/relationalReadRepository.js";
import type {
  RemoteRepositoryDescriptor,
  RemoteRepositoryPort,
} from "../src/projects/remoteRepositoryPort.js";
import { RemoteRepositoryVerificationError } from "../src/projects/remoteRepositoryPort.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

interface FakeRepo {
  repository_id: string;
  owner: string;
  name: string;
  default_branch: string;
  installation_ready: boolean;
}

/**
 * Stands in for GitHubIntegrationService through the port. Counts calls so a
 * double submit can be proven not to have created a second repository.
 */
class FakeRemoteRepositoryPort implements RemoteRepositoryPort {
  readonly created: string[] = [];
  readonly resolved: string[] = [];
  /** Repositories the installation can already see, keyed by name. */
  readonly existing = new Map<string, FakeRepo>();
  /** installation_ready applied to repositories this port creates. */
  createInstallationReady = true;
  resolveFailure: RemoteRepositoryVerificationError | null = null;

  private descriptor(repo: FakeRepo): RemoteRepositoryDescriptor {
    return {
      connection_id: "connection-1",
      repository_id: repo.repository_id,
      owner: repo.owner,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      default_branch: repo.default_branch,
      clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      installation_ready: repo.installation_ready,
    };
  }

  resolveById(input: { repository_id: string }): Promise<RemoteRepositoryDescriptor> {
    if (this.resolveFailure) return Promise.reject(this.resolveFailure);
    this.resolved.push(input.repository_id);
    const repo = [...this.existing.values()].find(
      (candidate) => candidate.repository_id === input.repository_id,
    );
    if (!repo) {
      return Promise.reject(
        new RemoteRepositoryVerificationError("github_api_error", "Not Found.", 409),
      );
    }
    return Promise.resolve(this.descriptor(repo));
  }

  findByName(input: { name: string }): Promise<RemoteRepositoryDescriptor | null> {
    const repo = this.existing.get(input.name);
    return Promise.resolve(repo ? this.descriptor(repo) : null);
  }

  create(input: { name: string }): Promise<RemoteRepositoryDescriptor> {
    this.created.push(input.name);
    const repo: FakeRepo = {
      repository_id: `repo-${this.created.length}`,
      owner: "acme",
      name: input.name,
      default_branch: "main",
      installation_ready: this.createInstallationReady,
    };
    this.existing.set(input.name, repo);
    return Promise.resolve(this.descriptor(repo));
  }
}

const ACTOR = { actor_type: "human" as const, actor_id: "admin-1" };

describe.sequential("ONBOARDING O2: GitHub-backed project setup", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let remotes: FakeRemoteRepositoryPort;
  let onboarding: ProjectOnboardingService;
  let resume: ProjectResumeService;

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
    // A candidate's service_connection_id is a real FK, so onboarding is only
    // reachable through an actual GitHub connection.
    await pg.exec(`
      INSERT INTO service_connections (
        id, provider, display_name, owner_type, owner_login,
        external_account_id, installation_id, repository_selection,
        connected_by_user_id
      ) VALUES ('connection-1','github','acme','organization','acme',
        'account-1','installation-1','all','admin-1');
    `);
    transactions = new PGliteTransactionRunner(pg);
    remotes = new FakeRemoteRepositoryPort();
    onboarding = new ProjectOnboardingService({ transactions, remotes });
    resume = new ProjectResumeService(transactions);
  });

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  function newRepoCommand(overrides: Partial<{ idempotency_key: string; name: string }> = {}) {
    return {
      name: overrides.name ?? "Fresh project",
      description: "A project Norns creates the repository for",
      pm_provider: "anthropic" as const,
      pm_model: null,
      actor: ACTOR,
      idempotency_key: overrides.idempotency_key ?? "key-new-1",
      connection_id: "connection-1",
      repository_name: "fresh-project",
      private: true,
    };
  }

  function existingRepoCommand(overrides: Partial<{ idempotency_key: string }> = {}) {
    return {
      name: "Adopted project",
      description: "A project on a repository that already exists",
      pm_provider: "anthropic" as const,
      pm_model: null,
      actor: ACTOR,
      idempotency_key: overrides.idempotency_key ?? "key-existing-1",
      connection_id: "connection-1",
      repository_id: "repo-existing",
    };
  }

  // -----------------------------------------------------------------------
  // Scenario 1: new_repo
  // -----------------------------------------------------------------------

  it("new_repo creates the repository and attaches it as both workspace and remote", async () => {
    const result = await onboarding.createNewRepo(newRepoCommand());

    expect(remotes.created).toEqual(["fresh-project"]);
    expect(result.scenario).toBe("new_repo");
    expect(result.replayed).toBe(false);

    // Two attachments, distinct roles, ONE repository.
    expect(result.workspace).toMatchObject({
      role: "workspace",
      kind: "github",
      tier: "candidate",
      verified: false,
      default_branch: "main",
      installation_ready: true,
      workflow_installed: false,
      github: { owner: "acme", name: "fresh-project", url: "github.com/acme/fresh-project" },
    });
    expect(result.remote).toMatchObject({
      role: "remote",
      kind: "github",
      github: { url: "github.com/acme/fresh-project" },
    });
    expect(result.workspace?.id).not.toBe(result.remote?.id);
    expect(result.workspace?.github?.url).toBe(result.remote?.github?.url);

    // Pushes need no brokered credential.
    expect(result.push).toEqual({
      strategy: "actions_github_token",
      norns_issues_credential: false,
      rationale: expect.stringContaining("GITHUB_TOKEN"),
    });

    const stored = await pg.query<{
      role: string;
      source_type: string;
      push_credential_strategy: string;
      remote_provisioning: string;
      installation_ready: boolean;
      workflow_installed: boolean;
      default_branch: string;
    }>(
      `SELECT role, source_type, push_credential_strategy, remote_provisioning,
              installation_ready, workflow_installed, default_branch
       FROM repository_binding_candidates
       WHERE project_id = $1 ORDER BY role`,
      [result.project_id],
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((row) => row.role)).toEqual(["remote", "workspace"]);
    for (const row of stored.rows) {
      expect(row.source_type).toBe("github");
      expect(row.push_credential_strategy).toBe("actions_github_token");
      expect(row.remote_provisioning).toBe("created");
      expect(row.installation_ready).toBe(true);
      expect(row.workflow_installed).toBe(false);
      expect(row.default_branch).toBe("main");
    }

    const project = await pg.query<{ onboarding_scenario: string }>(
      "SELECT onboarding_scenario FROM projects WHERE id = $1",
      [result.project_id],
    );
    expect(project.rows[0]?.onboarding_scenario).toBe("new_repo");
  });

  // -----------------------------------------------------------------------
  // Scenario 2: existing_repo
  // -----------------------------------------------------------------------

  it("existing_repo attaches a repository the installation can see, creating nothing", async () => {
    remotes.existing.set("adopted", {
      repository_id: "repo-existing",
      owner: "acme",
      name: "adopted",
      default_branch: "trunk",
      installation_ready: true,
    });

    const result = await onboarding.createFromExistingRepo(existingRepoCommand());

    expect(remotes.created).toEqual([]);
    expect(remotes.resolved).toEqual(["repo-existing"]);
    expect(result.scenario).toBe("existing_repo");
    expect(result.workspace).toMatchObject({
      role: "workspace",
      default_branch: "trunk",
      github: { url: "github.com/acme/adopted" },
    });
    expect(result.remote?.github?.url).toBe("github.com/acme/adopted");
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(["workflow_not_installed"]);

    const provisioning = await pg.query<{ remote_provisioning: string }>(
      "SELECT DISTINCT remote_provisioning FROM repository_binding_candidates WHERE project_id = $1",
      [result.project_id],
    );
    expect(provisioning.rows).toEqual([{ remote_provisioning: "selected_existing" }]);
  });

  it("surfaces the GitHub failure honestly when the installation cannot see the repository", async () => {
    await expect(onboarding.createFromExistingRepo(existingRepoCommand())).rejects.toBeInstanceOf(
      RemoteRepositoryVerificationError,
    );
    const projects = await pg.query("SELECT id FROM projects");
    expect(projects.rows).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  it("double-submits the same key without creating a second repository", async () => {
    const first = await onboarding.createNewRepo(newRepoCommand());
    const second = await onboarding.createNewRepo(newRepoCommand());

    expect(remotes.created).toEqual(["fresh-project"]);
    expect(second.replayed).toBe(true);
    expect(second.project_id).toBe(first.project_id);
    expect(second.workspace?.id).toBe(first.workspace?.id);
    expect(second.remote?.id).toBe(first.remote?.id);

    const counts = await pg.query<{ projects: number; attachments: number; submissions: number }>(
      `SELECT (SELECT count(*)::int FROM projects) AS projects,
              (SELECT count(*)::int FROM repository_binding_candidates) AS attachments,
              (SELECT count(*)::int FROM project_onboarding_submissions) AS submissions`,
    );
    expect(counts.rows[0]).toEqual({ projects: 1, attachments: 2, submissions: 1 });
  });

  it("rejects an idempotency key reused for the other scenario", async () => {
    await onboarding.createNewRepo(newRepoCommand({ idempotency_key: "shared-key" }));
    await expect(
      onboarding.createFromExistingRepo(existingRepoCommand({ idempotency_key: "shared-key" })),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });

  it("does not re-create a repository that GitHub already has under that name", async () => {
    // Models a crash between GitHub creating the repository and Norns
    // committing the row: a retry with a NEW key must still not double-create.
    remotes.existing.set("fresh-project", {
      repository_id: "repo-preexisting",
      owner: "acme",
      name: "fresh-project",
      default_branch: "main",
      installation_ready: true,
    });
    const result = await onboarding.createNewRepo(newRepoCommand({ idempotency_key: "retry-key" }));
    expect(remotes.created).toEqual([]);
    expect(result.workspace?.github?.url).toBe("github.com/acme/fresh-project");
  });

  // -----------------------------------------------------------------------
  // installation_ready is first-class blocking state
  // -----------------------------------------------------------------------

  it("blocks, durably and visibly, when the installation does not contain the repository", async () => {
    remotes.createInstallationReady = false;
    const result = await onboarding.createNewRepo(newRepoCommand());

    // Both attachments are blocked; only the workspace needs a workflow file.
    expect(result.blockers.map((blocker) => `${blocker.role}:${blocker.code}`).sort()).toEqual([
      "remote:installation_not_ready",
      "workspace:installation_not_ready",
      "workspace:workflow_not_installed",
    ]);
    for (const blocker of result.blockers) {
      expect(blocker.message).toContain("github.com/acme/fresh-project");
    }

    const stored = await pg.query<{ installation_ready: boolean }>(
      "SELECT DISTINCT installation_ready FROM repository_binding_candidates WHERE project_id = $1",
      [result.project_id],
    );
    expect(stored.rows).toEqual([{ installation_ready: false }]);

    // It survives into the read model and drives the recommended action --
    // it is not a creation-time warning that evaporates.
    const view = await resume.open(result.project_id);
    expect(view.onboarding.blockers.map((blocker) => blocker.code)).toContain(
      "installation_not_ready",
    );
    expect(view.next_recommended_action).toContain("Resolve a setup blocker");
  });

  // -----------------------------------------------------------------------
  // Read model
  // -----------------------------------------------------------------------

  it("exposes both attachments and a ready-to-render summary line", async () => {
    const created = await onboarding.createNewRepo(newRepoCommand());
    const view = await resume.open(created.project_id);

    expect(view.onboarding.scenario).toBe("new_repo");
    expect(view.onboarding.summary_line).toBe(
      "Runs in github.com/acme/fresh-project · Pushes to github.com/acme/fresh-project",
    );
    expect(view.onboarding.workspace).toMatchObject({
      role: "workspace",
      kind: "github",
      installation_ready: true,
      workflow_installed: false,
    });
    expect(view.onboarding.remote).toMatchObject({ role: "remote", kind: "github" });
    expect(view.onboarding.push.strategy).toBe("actions_github_token");
    expect(view.onboarding.push.norns_issues_credential).toBe(false);
    // FRONT DOOR P5 tracking fields are untouched by the additions.
    expect(view.progress.overall_percent_complete).toBe(0);
    expect(view.update_interval_seconds).toBe(300);
  });

  it("summarizes a project with a workspace and no remote without inventing one", async () => {
    const projects = new RelationalProjectReadRepository(transactions, "onboarding-test");
    const project = await projects.create({
      name: "GitHub-only legacy project",
      description: "Created through the pre-existing route",
      pmProvider: "anthropic",
      // CreateProjectInput.pmModel is optional, not nullable: "no model
      // supplied" is the field's absence, and the store resolves the
      // provider's default. Omitted rather than nulled.
      sourceType: "github",
      sourceLocation: "https://github.com/acme/legacy.git",
    });
    const view = await resume.open(project.id);
    expect(view.onboarding.scenario).toBeNull();
    expect(view.onboarding.remote).toBeNull();
    expect(view.onboarding.workspace).toMatchObject({ role: "workspace", kind: "github" });
    expect(view.onboarding.summary_line).toBe("Runs in github.com/acme/legacy");
  });

  it("keeps the project summary's pre-existing fields and adds the remote additively", async () => {
    const created = await onboarding.createNewRepo(newRepoCommand());
    const projects = new RelationalProjectReadRepository(transactions, "onboarding-test");
    const summary = await projects.summary(created.project_id);

    expect(summary).toMatchObject({
      id: created.project_id,
      name: "Fresh project",
      source_type: "github",
      status: "draft",
      workspace_location: "https://github.com/acme/fresh-project.git",
      remote_location: "github.com/acme/fresh-project",
      onboarding_scenario: "new_repo",
    });
  });

  // -----------------------------------------------------------------------
  // The dispatch gate is untouched
  // -----------------------------------------------------------------------

  it("still refuses dispatch for a project whose workspace is not a connected binding", async () => {
    const created = await onboarding.createNewRepo(newRepoCommand());
    // An onboarded project has candidate-tier attachments only: nothing has
    // confirmed the repository yet, so primary_repository_binding_id is null
    // and execution must not start. Planning and staffing still work.
    const primary = await pg.query<{ primary_repository_binding_id: string | null }>(
      "SELECT primary_repository_binding_id FROM projects WHERE id = $1",
      [created.project_id],
    );
    expect(primary.rows[0]?.primary_repository_binding_id).toBeNull();

    const coordinator = new Phase4Coordinator(transactions);
    await expect(
      coordinator.schedule({
        project_id: created.project_id,
        phase_id: "phase-missing",
        task_id: "task-missing",
        assignment_id: "assignment-missing",
        runner_id: "runner-1",
        runner_generation: 1,
        authorized_by: { actor_type: "human", actor_id: "admin-1" },
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
      }),
    ).rejects.toThrow();
  });

  it("leaves an existing connected local_runner binding dispatchable", async () => {
    // Regression guard for the re-keyed unique indexes and the `role` default:
    // a pre-O2 project with a connected local_runner workspace must still
    // resolve and still clear the gate.
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('legacy-1','Legacy','','active','assignment','verification','budget');
      INSERT INTO repository_bindings (
        id, project_id, binding_type, status, runner_id, workspace_id,
        repository_id, repository_display_name, granted_permissions,
        default_branch, observed_head, verification_policy_ref,
        repository_health, created_by_actor_type, created_by_actor_id
      ) VALUES ('legacy-binding-1','legacy-1','local_runner','connected','runner-1',
        'workspace-1','repository-1','Legacy','{}'::jsonb,'main','commit-1',
        'verification','healthy','human','admin-1');
      UPDATE projects SET primary_repository_binding_id='legacy-binding-1' WHERE id='legacy-1';
    `);
    const binding = await pg.query<{ role: string; status: string; workflow_installed: boolean }>(
      "SELECT role, status, workflow_installed FROM repository_bindings WHERE id = 'legacy-binding-1'",
    );
    expect(binding.rows[0]).toEqual({
      role: "workspace",
      status: "connected",
      workflow_installed: false,
    });

    const view = await resume.open("legacy-1");
    expect(view.onboarding.workspace).toMatchObject({
      role: "workspace",
      kind: "local_runner",
      tier: "binding",
      verified: true,
    });
    expect(view.onboarding.remote).toBeNull();
    // A local_runner workspace needs no Actions workflow, so it must not be
    // reported as blocked by one.
    expect(view.onboarding.blockers).toEqual([]);
  });
});

/**
 * The route mounts under the exact option shape `main.ts` passes, so a
 * production-wiring mismatch fails here.
 *
 * There is no existing pattern in this repo for asserting `main.ts` boot
 * wiring directly, and one was not invented for this: what is asserted is
 * that `buildServer({ onboarding: { transactions } })` -- character for
 * character what main.ts now supplies -- produces a live route.
 */
describe.sequential("ONBOARDING O2: route wiring", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      // `projects` is what main.ts supplies unconditionally, and the O2
      // section lives inside the project-routes block, so it is part of the
      // shape being asserted.
      projects: new ProjectStore(),
      onboarding: { transactions: new PGliteTransactionRunner(pg) },
    });
  }, 30_000);

  afterEach(async () => {
    await server?.app.close();
    if (!pg.closed) await pg.close();
  });

  const post = (payload: unknown, authenticated = true) =>
    server.app.inject({
      method: "POST",
      url: "/api/v2/projects/onboarding",
      headers: authenticated ? { authorization: `Bearer ${token}` } : {},
      payload: payload as Record<string, unknown>,
    });

  it("mounts the route and requires a session", async () => {
    const response = await post({}, false);
    // 401, not 404: the route exists and the auth gate is what refuses.
    expect(response.statusCode).toBe(401);
  });

  it("validates the body before touching GitHub", async () => {
    const response = await post({ scenario: "new_repo", name: "x" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "bad_request" });
  });

  it("refuses honestly when no GitHub App is configured", async () => {
    // No `integrations.github`, so the service holds an
    // UnconfiguredRemoteRepositoryPort. It must say so rather than mount a
    // route that silently does nothing.
    const response = await post({
      scenario: "new_repo",
      name: "Wired project",
      description: "Proves the route is reachable end to end",
      pm_provider: "anthropic",
      connection_id: "connection-1",
      idempotency_key: "wiring-1",
      repository_name: "wired-project",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "github_not_configured" });
  });
});

/** Narrow helper so the assertions above read as intent, not as plumbing. */
export type { OnboardingResult };
