// ONBOARDING O6: the promotion path, proved end to end.
//
// The assertion that matters is the last one in the first block: a project
// created through the onboarding command reaches a state where the Phase 4
// dispatch gate ACCEPTS it. Before this phase the gate refused every GitHub
// project, because nothing ever promoted a candidate to a connected binding.
//
// Everything else here exists to prove the promotion is honest rather than
// convenient: it refuses without evidence, it never weakens the gate, and it
// leaves the laptop-runner path exactly as it was.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  type ActivationReadiness,
  type ProjectActivationPort,
  ProjectActivationService,
  type RepositoryEvidence,
} from "../src/projects/projectActivationService.js";
import { ProjectOnboardingService } from "../src/projects/projectOnboardingService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import type {
  RemoteRepositoryDescriptor,
  RemoteRepositoryPort,
} from "../src/projects/remoteRepositoryPort.js";
import { SourceBindingService } from "../src/projects/sourceBindingService.js";

const HEAD = "9f2b7c1a4d6e8f0a2b4c6d8e0f2a4b6c8d0e2f4a";

/** The onboarding side: a repository the installation can see. */
class FakeRemotePort implements RemoteRepositoryPort {
  created: string[] = [];
  installationReady = true;

  private descriptor(): RemoteRepositoryDescriptor {
    return {
      connection_id: "connection-1",
      repository_id: "42",
      owner: "acme",
      name: "app",
      full_name: "acme/app",
      default_branch: "main",
      clone_url: "https://github.com/acme/app.git",
      html_url: "https://github.com/acme/app",
      installation_ready: this.installationReady,
    };
  }

  resolveById(): Promise<RemoteRepositoryDescriptor> {
    return Promise.resolve(this.descriptor());
  }

  findByName(): Promise<RemoteRepositoryDescriptor | null> {
    return Promise.resolve(null);
  }

  create(input: { name: string }): Promise<RemoteRepositoryDescriptor> {
    this.created.push(input.name);
    return Promise.resolve(this.descriptor());
  }
}

/**
 * The activation side. Every field it returns stands in for something read
 * back from GitHub, so a test that flips `ready` to false is modelling a real
 * 404 from the installation probe.
 */
class FakeActivationPort implements ProjectActivationPort {
  ready = true;
  headRevision = HEAD;
  readinessCalls = 0;
  evidenceCalls = 0;
  evidenceFailure: Error | null = null;

  readiness(): Promise<ActivationReadiness> {
    this.readinessCalls += 1;
    return Promise.resolve(
      this.ready
        ? {
            ready: true,
            reason: "ready",
            action_required: null,
            manage_installation_url: "https://github.com/settings/installations/1",
            installation_id: "installation-1",
          }
        : {
            ready: false,
            reason: "repository_not_in_installation",
            action_required: "Add acme/app under Repository access, and save.",
            manage_installation_url: "https://github.com/settings/installations/1",
            installation_id: "installation-1",
          },
    );
  }

  evidence(): Promise<RepositoryEvidence> {
    this.evidenceCalls += 1;
    if (this.evidenceFailure) return Promise.reject(this.evidenceFailure);
    return Promise.resolve({
      installation_id: "installation-1",
      repository_github_id: 42,
      owner: "acme",
      name: "app",
      default_branch: "main",
      head_revision: this.headRevision,
    });
  }
}

const ACTOR = { actor_type: "human" as const, actor_id: "admin-1" };

describe.sequential("ONBOARDING O6: GitHub-evidenced binding promotion", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let remotes: FakeRemotePort;
  let port: FakeActivationPort;
  let onboarding: ProjectOnboardingService;
  let activation: ProjectActivationService;
  let coordinator: Phase4Coordinator;
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
    await pg.exec(`
      INSERT INTO service_connections (
        id, provider, display_name, owner_type, owner_login,
        external_account_id, installation_id, repository_selection,
        connected_by_user_id
      ) VALUES ('connection-1','github','acme','organization','acme',
        'account-1','installation-1','selected','admin-1');
    `);
    transactions = new PGliteTransactionRunner(pg);
    remotes = new FakeRemotePort();
    port = new FakeActivationPort();
    onboarding = new ProjectOnboardingService({ transactions, remotes });
    activation = new ProjectActivationService(transactions, port);
    coordinator = new Phase4Coordinator(transactions);
    resume = new ProjectResumeService(transactions);
  });

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  async function onboardProject(key = "o6-key-1"): Promise<string> {
    const result = await onboarding.createNewRepo({
      name: "Runnable project",
      description: "Created through the onboarding command",
      pm_provider: "anthropic",
      pm_model: null,
      actor: ACTOR,
      idempotency_key: key,
      connection_id: "connection-1",
      repository_name: "app",
      private: true,
    });
    return result.project_id;
  }

  /**
   * The rest of the scheduling scope the Phase 4 gate needs. Nothing here is
   * repository-related — it exists so the only thing under test is whether the
   * binding clears the gate.
   */
  async function seedSchedulableWork(projectId: string): Promise<void> {
    await pg.query(
      `INSERT INTO phases (id, project_id, objective_summary, priority, status, approved_budget_usd)
       VALUES ('phase-1',$1,'Ship it',1,'approved',20)`,
      [projectId],
    );
    await pg.query(
      `INSERT INTO strategy_versions (
         id, project_id, phase_id, version, status, objective, content,
         convergence, review_rounds, content_hash
       ) VALUES ('strategy-1',$1,'phase-1',1,'approved','Ship it','{}'::jsonb,
         'converged',1,repeat('a',64))`,
      [projectId],
    );
    await pg.query(
      "UPDATE phases SET approved_strategy_version_id='strategy-1' WHERE id='phase-1'",
    );
    await pg.query(
      `INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
       VALUES ('objective-1',$1,'phase-1','Done','["it works"]'::jsonb,'active',0)`,
      [projectId],
    );
    await pg.query(
      `INSERT INTO tasks (
         id, project_id, phase_id, objective_id, strategy_version_id, title,
         description, deliverables, acceptance_criteria, complexity, risk,
         required_roles, required_capabilities, required_inputs, expected_outputs,
         environment_policy_ref, verification_policy_ref, state, lifecycle_version
       ) VALUES ('task-1',$1,'phase-1','objective-1','strategy-1','Do work','Do it',
         '["change"]'::jsonb,'["verified"]'::jsonb,'M','medium','["implementation"]'::jsonb,
         '[]'::jsonb,'[]'::jsonb,'["commit"]'::jsonb,'environment','verification','pending',0)`,
      [projectId],
    );
    await pg.exec(`
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens,
        security_restrictions, status, active_workload, cost_metadata
      ) VALUES ('agent-1','openai','codex','gpt-5-codex','["implementation"]'::jsonb,
        '["typescript"]'::jsonb,200000,'[]'::jsonb,'available',0,
        '{"billing_mode":"subscription"}'::jsonb);
    `);
    await pg.query(
      `INSERT INTO agent_assignments (
         id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
         rationale_factors, budget_limit_usd, allocation_policy_ref
       ) VALUES ('assignment-1',$1,'phase-1','task-1','agent-1','proposed','Best fit',
         '["capability"]'::jsonb,10,'allocation')`,
      [projectId],
    );
  }

  function schedule(projectId: string) {
    return coordinator.schedule({
      project_id: projectId,
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
      runner_id: `actions:${projectId}`,
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
    });
  }

  // -----------------------------------------------------------------------
  // THE ASSERTION THAT MATTERS
  // -----------------------------------------------------------------------

  it("takes an onboarded project all the way to a dispatch the gate accepts", async () => {
    const projectId = await onboardProject();
    await seedSchedulableWork(projectId);

    // Before activation the gate refuses — this is the pre-O6 state, and it
    // must remain the state for an unactivated project.
    await expect(schedule(projectId)).rejects.toThrow(/verified repository binding/);

    const result = await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    expect(result.activated).toBe(true);
    expect(result.observed_head).toBe(HEAD);
    expect(result.blockers).toEqual([]);

    // The gate now ACCEPTS. This is what was impossible before O6.
    const scheduled = await schedule(projectId);
    expect(scheduled.command.repository_binding_id).toBe(result.workspace_binding_id);
    // The revision the runner is told to work from is the one activation
    // actually read out of GitHub, carried through unchanged.
    expect(scheduled.command.expected_revision).toBe(HEAD);
    // `runner_repository_id` is a local_runner-only field: a GitHub binding
    // hands the runner no opaque local repository handle.
    expect(scheduled.command.runner_repository_id).toBeUndefined();

    const binding = await pg.query<{
      status: string;
      role: string;
      binding_type: string;
      observed_head: string;
      repository_health: string;
    }>(
      `SELECT b.status, b.role, b.binding_type, b.observed_head, b.repository_health
       FROM repository_bindings b
       JOIN projects p ON p.primary_repository_binding_id = b.id
       WHERE p.id = $1`,
      [projectId],
    );
    expect(binding.rows[0]).toEqual({
      status: "connected",
      // The dispatch gate resolves the WORKSPACE binding, never the remote.
      role: "workspace",
      binding_type: "github",
      observed_head: HEAD,
      repository_health: "healthy",
    });
  });

  it("promotes both roles onto one repository and retires the candidates", async () => {
    const projectId = await onboardProject();
    await activation.activate({ project_id: projectId, actor_id: "admin-1" });

    const bindings = await pg.query<{ role: string; status: string; repository_id: string }>(
      "SELECT role, status, repository_id FROM repository_bindings WHERE project_id = $1 ORDER BY role",
      [projectId],
    );
    expect(bindings.rows).toEqual([
      { role: "remote", status: "connected", repository_id: "42" },
      { role: "workspace", status: "connected", repository_id: "42" },
    ]);
    const candidates = await pg.query<{ status: string }>(
      "SELECT DISTINCT status FROM repository_binding_candidates WHERE project_id = $1",
      [projectId],
    );
    expect(candidates.rows).toEqual([{ status: "promoted" }]);
  });

  // -----------------------------------------------------------------------
  // Evidence, or no promotion
  // -----------------------------------------------------------------------

  it("refuses to connect anything when the installation cannot see the repository", async () => {
    port.ready = false;
    const projectId = await onboardProject();
    await seedSchedulableWork(projectId);

    const result = await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    expect(result.activated).toBe(false);
    expect(result.blockers[0]).toMatchObject({
      code: "installation_not_ready",
      action_required: expect.stringContaining("Repository access"),
      manage_installation_url: expect.stringContaining("installations/"),
    });

    // No binding at all — not a binding in a hopeful state.
    const bindings = await pg.query("SELECT id FROM repository_bindings WHERE project_id = $1", [
      projectId,
    ]);
    expect(bindings.rows).toHaveLength(0);
    // It never even asked for the head: the probe is a hard gate, not advisory.
    expect(port.evidenceCalls).toBe(0);
    await expect(schedule(projectId)).rejects.toThrow(/verified repository binding/);

    // ...and it is recorded durably, so the read model tells the same story.
    const view = await resume.open(projectId);
    expect(view.onboarding.blockers).toEqual(["installation_not_ready"]);
  });

  it("connects nothing when the head revision cannot be read", async () => {
    port.evidenceFailure = new Error("contents read denied");
    const projectId = await onboardProject();

    await expect(
      activation.activate({ project_id: projectId, actor_id: "admin-1" }),
    ).rejects.toThrow("contents read denied");

    const bindings = await pg.query("SELECT id FROM repository_bindings WHERE project_id = $1", [
      projectId,
    ]);
    expect(bindings.rows).toHaveLength(0);
  });

  it("never records a connected binding without a real observed revision", async () => {
    const projectId = await onboardProject();
    await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    // The gate's second requirement. A connected binding with a null head
    // would pass the status check and then fail at dispatch — so the invariant
    // is asserted directly over the table, for every row.
    const rows = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM repository_bindings
       WHERE status = 'connected' AND (observed_head IS NULL OR observed_head = '')`,
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("records the evidence it relied on in the audit trail", async () => {
    const projectId = await onboardProject();
    await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    const audit = await pg.query<{ details: { evidence: string[]; observed_head: string } }>(
      `SELECT details FROM audit_events
       WHERE project_id = $1 AND audit_type = 'repository_binding.connected'`,
      [projectId],
    );
    expect(audit.rows[0]?.details.evidence).toEqual([
      "installation_probe",
      "repository_resolved",
      "head_revision_read",
    ]);
    expect(audit.rows[0]?.details.observed_head).toBe(HEAD);
  });

  // -----------------------------------------------------------------------
  // Recovery and idempotency
  // -----------------------------------------------------------------------

  it("recovers after the human grants installation access, without re-creating anything", async () => {
    port.ready = false;
    const projectId = await onboardProject();
    const blocked = await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    expect(blocked.activated).toBe(false);

    // The human adds the repository to the installation and retries. The
    // repository is never re-created and the project is never re-made — this
    // is what stops a blocked project stranding an orphaned repository.
    port.ready = true;
    const recovered = await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    expect(recovered.activated).toBe(true);
    expect(remotes.created).toEqual(["app"]);

    const projects = await pg.query("SELECT id FROM projects");
    expect(projects.rows).toHaveLength(1);
  });

  it("is idempotent: re-activating updates in place rather than duplicating", async () => {
    const projectId = await onboardProject();
    const first = await activation.activate({ project_id: projectId, actor_id: "admin-1" });
    port.headRevision = "1111111111111111111111111111111111111111";
    const second = await activation.activate({ project_id: projectId, actor_id: "admin-1" });

    expect(second.workspace_binding_id).toBe(first.workspace_binding_id);
    const bindings = await pg.query<{ count: number; head: string }>(
      `SELECT count(*)::int AS count, max(observed_head) AS head
       FROM repository_bindings WHERE project_id = $1 AND role = 'workspace'`,
      [projectId],
    );
    expect(bindings.rows[0]?.count).toBe(1);
    // Re-activation refreshes the observed revision rather than pinning a
    // stale one: the binding tracks the repository.
    expect(bindings.rows[0]?.head).toBe("1111111111111111111111111111111111111111");
  });

  // -----------------------------------------------------------------------
  // The laptop-runner path is untouched
  // -----------------------------------------------------------------------

  it("leaves the runner-reported local promotion path exactly as it was", async () => {
    await pg.exec(`
      INSERT INTO projects (
        id, name, description, status, assignment_policy_ref,
        verification_policy_ref, budget_policy_ref
      ) VALUES ('local-1','Laptop project','','active','assignment','verification','budget');
    `);
    const bindings = new SourceBindingService(transactions);
    const binding = await bindings.createLocal({
      project_id: "local-1",
      runner_id: "runner-1",
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "Laptop project",
      default_branch: "main",
      observed_head: "cafebabe",
      verification_policy_ref: "verification-default",
      created_by: { actor_type: "human", actor_id: "admin-1" },
    });

    expect(binding).toMatchObject({
      binding_type: "local_runner",
      status: "connected",
      repository_health: "healthy",
    });
    const stored = await pg.query<{ role: string; primary_id: string }>(
      `SELECT b.role, p.primary_repository_binding_id AS primary_id
       FROM repository_bindings b JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [binding.id],
    );
    // Still defaults to the workspace role, still becomes the project's
    // primary binding, still driven entirely by the runner's own report.
    expect(stored.rows[0]).toEqual({ role: "workspace", primary_id: binding.id });

    await seedSchedulableWork("local-1");
    const scheduled = await coordinator.schedule({
      project_id: "local-1",
      phase_id: "phase-1",
      task_id: "task-1",
      assignment_id: "assignment-1",
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
    });
    expect(scheduled.command.runner_repository_id).toBe("repository-1");
  });
});
