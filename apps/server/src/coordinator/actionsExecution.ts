/*
 * ONBOARDING O4 — Actions-hosted execution, as a strict EXTENSION of the
 * Phase 4 coordinator. See the design and blast-radius notes below the imports.
 */
import { NORNS_WORKFLOW_VERSION } from "../integrations/actionsWorkflowTemplate.js";
import {
  type ActionsRepositoryRef,
  type GitHubActionsService,
  type WorkflowInstallResult,
  enrollmentTokenHash,
  generateEnrollmentToken,
} from "../integrations/githubActions.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type Phase4Coordinator,
  Phase4CoordinatorConflictError,
  type Phase4ScheduleInput,
  type Phase4ScheduledRun,
} from "./phase4Coordinator.js";

// ONBOARDING O4 — Actions-hosted execution, as a strict EXTENSION of the
// Phase 4 coordinator.
//
// The existing dispatch gate in Phase4Coordinator.schedule() is not weakened,
// bypassed, or duplicated here. `ActionsExecutionCoordinator.schedule()` calls
// straight through to it and only proceeds once it has returned; the extra
// checks in this file run BEFORE that call and can only *refuse* work the base
// coordinator would have accepted. An Actions-hosted run therefore satisfies
// every condition a laptop-hosted run satisfies, plus three more.
//
// ============================================================================
// RUNNER CREDENTIAL — BLAST-RADIUS ANALYSIS
// ============================================================================
//
// The ephemeral runner authenticates to the relay with an Ed25519 keypair it
// generates inside the job. It obtains the right to register that keypair by
// presenting an *enrollment token*, delivered as the repository Actions secret
// NORNS_RUNNER_ENROLLMENT_TOKEN. That secret is the only Norns credential that
// exists on the GitHub side, so the question that matters is:
//
//   What can an attacker with write access to this repository do with it?
//
// They can read it. Repository write access implies the ability to add a
// workflow (or edit ours) that echoes any repository secret to a log they can
// see. There is no configuration that prevents this — GitHub secrets are
// confidential from the public, not from repository collaborators with write.
// The design therefore assumes the token WILL leak to anyone with repo write
// and bounds what that is worth:
//
//   1. PROJECT-SCOPED IDENTITY. The token enrolls a runner id that belongs to
//      exactly one repository binding (`github_actions_bindings_runner_idx` is
//      unique). It is not the user's laptop runner and shares no identity with
//      it. Commands for other projects are never routed to it, and the Phase 4
//      coordinator independently rejects a run whose repository binding does
//      not match. Compromising this repository yields this repository.
//
//   2. SINGLE USE, AGAINST AN ALREADY-DISPATCHED JOB. Enrollment must name a
//      `github_actions_runs` row that Norns itself created, that is in status
//      `dispatched`, and whose `enrolled_at` is NULL. Redemption flips
//      `enrolled_at` in the same atomic UPDATE, so the second attempt loses.
//      A stolen token cannot be used to sit on the relay waiting for work: it
//      can only race the legitimate job for a job Norns already decided to run.
//
//   3. SHORT GENERATION LIFETIME. Each launch reserves a fresh runner
//      generation, which fences the previous one instantly. A token redeemed
//      against a superseded generation is refused, and any connection holding
//      the old generation is fenced off by the existing generation machinery.
//      The credential is therefore worth, at most, one generation.
//
//   4. NO STANDING AUTHORITY. The enrollment token is not a relay session
//      credential and not a GitHub credential. It cannot read Norns data, it
//      cannot enumerate projects, and it grants nothing on GitHub — pushes
//      inside the job use GitHub's own GITHUB_TOKEN, which GitHub already
//      scopes to this repository and expires with the job (ONBOARDING O4
//      item 4: no Norns token broker for pushing).
//
//   5. ROTATION AND REVOCATION. `rotateEnrollmentSecret()` mints a new token,
//      seals it to the repository public key, and overwrites the secret; the
//      old value stops working the moment the new hash is stored, because only
//      the hash is compared and only one hash is kept. Revocation without
//      rotation is `enabled = false` on the binding, which refuses every
//      enrollment. The existing `runner_revocations` table remains the
//      coordinator-level kill switch for the runner identity itself.
//
//   6. NEVER WRITTEN OUT. The plaintext exists in exactly two places: the
//      response GitHub's secrets API is given (sealed, so not plaintext on the
//      wire), and the job's process environment. It is never stored (only its
//      SHA-256 hash is), never logged, never placed in a command envelope,
//      event, artifact, or pull request, and never echoed by the workflow —
//      the run step passes it through `env:`, not through a command line.
//
// The residual risk is honest and worth stating plainly: an attacker with
// repository write access can already run arbitrary code in that repository's
// CI and can already push to it. Norns' presence adds the ability to intercept
// one already-scheduled Norns run for that one project. It does not add access
// to other projects, to other repositories, to the relay at large, or to the
// GitHub App's private key, which never leaves the server (ADR-006).

export class ActionsExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Human-facing next step, when one exists. */
    readonly action_required: string | null = null,
  ) {
    super(message);
    this.name = "ActionsExecutionError";
  }
}

export interface ActionsExecutionBindingRow {
  repository_binding_id: string;
  project_id: string;
  connection_id: string;
  installation_id: string;
  repository_github_id: string | number;
  owner: string;
  name: string;
  default_branch: string;
  workflow_version: number | null;
  workflow_installed_at: Date | string | null;
  workflow_blocked_reason: string | null;
  runner_id: string;
  enrollment_secret_hash: string | null;
  enabled: boolean;
}

export interface ActionsExecutionBindingInput {
  repository_binding_id: string;
  project_id: string;
  connection_id: string;
  installation_id: string;
  repository_github_id: number;
  owner: string;
  name: string;
  default_branch: string;
  /** Defaults to a deterministic, project-scoped ephemeral identity. */
  runner_id?: string;
}

/** The project-scoped ephemeral runner identity. Never a laptop runner id. */
export function actionsRunnerId(projectId: string): string {
  return `actions:${projectId}`;
}

function repositoryRef(binding: ActionsExecutionBindingRow): ActionsRepositoryRef {
  return {
    installation_id: binding.installation_id,
    repository_github_id: Number(binding.repository_github_id),
    owner: binding.owner,
    name: binding.name,
    default_branch: binding.default_branch,
  };
}

const BINDING_COLUMNS = `repository_binding_id, project_id, connection_id, installation_id,
          repository_github_id, owner, name, default_branch, workflow_version,
          workflow_installed_at, workflow_blocked_reason, runner_id,
          enrollment_secret_hash, enabled`;

export class ActionsExecutionRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  bindingForProject(projectId: string): Promise<ActionsExecutionBindingRow | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<ActionsExecutionBindingRow>(
        `SELECT ${BINDING_COLUMNS} FROM github_actions_execution_bindings WHERE project_id = $1`,
        [projectId],
      );
      return result.rows[0] ?? null;
    });
  }

  bindingForRunner(runnerId: string): Promise<ActionsExecutionBindingRow | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<ActionsExecutionBindingRow>(
        `SELECT ${BINDING_COLUMNS} FROM github_actions_execution_bindings WHERE runner_id = $1`,
        [runnerId],
      );
      return result.rows[0] ?? null;
    });
  }

  upsertBinding(input: ActionsExecutionBindingInput): Promise<ActionsExecutionBindingRow> {
    const runnerId = input.runner_id ?? actionsRunnerId(input.project_id);
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<ActionsExecutionBindingRow>(
        `INSERT INTO github_actions_execution_bindings (
           repository_binding_id, project_id, connection_id, installation_id,
           repository_github_id, owner, name, default_branch, runner_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (repository_binding_id) DO UPDATE SET
           connection_id = EXCLUDED.connection_id,
           installation_id = EXCLUDED.installation_id,
           repository_github_id = EXCLUDED.repository_github_id,
           owner = EXCLUDED.owner,
           name = EXCLUDED.name,
           default_branch = EXCLUDED.default_branch,
           updated_at = now()
         RETURNING ${BINDING_COLUMNS}`,
        [
          input.repository_binding_id,
          input.project_id,
          input.connection_id,
          input.installation_id,
          input.repository_github_id,
          input.owner,
          input.name,
          input.default_branch,
          runnerId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new ActionsExecutionError("binding_upsert_failed", "binding was not stored");
      return row;
    });
  }

  recordWorkflowInstall(
    bindingId: string,
    result: Pick<WorkflowInstallResult, "action" | "version" | "blocked_reason">,
  ): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_execution_bindings
         SET workflow_version = $2,
             workflow_installed_at = CASE WHEN $3::text IS NULL THEN now() ELSE workflow_installed_at END,
             workflow_blocked_reason = $3,
             updated_at = now()
         WHERE repository_binding_id = $1`,
        [bindingId, result.blocked_reason === null ? result.version : null, result.blocked_reason],
      );
    });
  }

  storeEnrollmentSecretHash(bindingId: string, hash: string): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_execution_bindings
         SET enrollment_secret_hash = $2, enrollment_secret_rotated_at = now(), updated_at = now()
         WHERE repository_binding_id = $1`,
        [bindingId, hash],
      );
    });
  }

  setEnabled(bindingId: string, enabled: boolean): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_execution_bindings SET enabled = $2, updated_at = now()
         WHERE repository_binding_id = $1`,
        [bindingId, enabled],
      );
    });
  }

  createRun(input: {
    project_id: string;
    repository_binding_id: string;
    dispatch_job_id: string;
    run_id: string;
    runner_id: string;
    runner_generation: number;
  }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO github_actions_runs (
           id, project_id, repository_binding_id, dispatch_job_id, run_id,
           runner_id, runner_generation, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'requested')`,
        [
          `actions-run:${input.dispatch_job_id}`,
          input.project_id,
          input.repository_binding_id,
          input.dispatch_job_id,
          input.run_id,
          input.runner_id,
          input.runner_generation,
        ],
      );
    });
  }

  markDispatched(dispatchJobId: string, run: { id: number; url: string } | null): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
         SET status = 'dispatched', github_run_id = $2, github_run_url = $3, updated_at = now()
         WHERE dispatch_job_id = $1 AND status = 'requested'`,
        [dispatchJobId, run?.id ?? null, run?.url ?? null],
      );
    });
  }

  markFailed(dispatchJobId: string, error: string): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
         SET status = 'failed', last_error = $2, completed_at = now(), updated_at = now()
         WHERE dispatch_job_id = $1 AND status NOT IN ('completed','failed')`,
        [dispatchJobId, error.slice(0, 2_000)],
      );
    });
  }

  markCompleted(dispatchJobId: string, conclusion: string | null): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
         SET status = 'completed', conclusion = $2, completed_at = now(), updated_at = now()
         WHERE dispatch_job_id = $1`,
        [dispatchJobId, conclusion],
      );
    });
  }

  /**
   * Atomically redeem an enrollment. Single-use is enforced by the database,
   * not by a read-then-write the coordinator could race with itself: the
   * `enrolled_at IS NULL` predicate lives inside the UPDATE.
   */
  redeemEnrollment(input: {
    dispatch_job_id: string;
    runner_id: string;
  }): Promise<{ run_id: string; runner_generation: number | null } | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ run_id: string; runner_generation: number | null }>(
        `UPDATE github_actions_runs
         SET status = 'enrolled', enrolled_at = now(), updated_at = now()
         WHERE dispatch_job_id = $1 AND runner_id = $2
           AND status = 'dispatched' AND enrolled_at IS NULL
         RETURNING run_id, runner_generation`,
        [input.dispatch_job_id, input.runner_id],
      );
      return result.rows[0] ?? null;
    });
  }
}

/** Everything the caller must show the human when a launch cannot proceed. */
export interface ActionsLaunch {
  runner_id: string;
  runner_generation: number;
  workflow: WorkflowInstallResult;
  github_run_id: number | null;
  github_run_url: string | null;
}

export interface ActionsExecutionOptions {
  /** Baked into the workflow file; see the template's security note. */
  serverOrigin: string;
  /** npm spec for the runner installed inside the job. */
  runnerPackage: string;
  nodeVersion?: string;
  timeoutMinutes?: number;
  /**
   * Reserve the generation the ephemeral runner will enroll at. Backed by
   * `RelayStores.reserveRunnerGeneration`; injected so this module does not
   * depend on relay state directly.
   */
  reserveGeneration: (runnerId: string) => number;
}

export class ActionsExecutionCoordinator {
  constructor(
    private readonly coordinator: Phase4Coordinator,
    private readonly repository: ActionsExecutionRepository,
    private readonly actions: GitHubActionsService,
    private readonly options: ActionsExecutionOptions,
  ) {}

  /**
   * Ensure the repository can host ephemeral runners: commit/upgrade the
   * workflow and provision the enrollment secret. Idempotent — safe to call on
   * every launch, and cheap when nothing has changed.
   */
  async prepare(binding: ActionsExecutionBindingRow): Promise<WorkflowInstallResult> {
    const reference = repositoryRef(binding);
    const workflow = await this.actions.installWorkflow(reference, {
      serverOrigin: this.options.serverOrigin,
      runnerPackage: this.options.runnerPackage,
      nodeVersion: this.options.nodeVersion,
      timeoutMinutes: this.options.timeoutMinutes,
    });
    await this.repository.recordWorkflowInstall(binding.repository_binding_id, workflow);
    if (workflow.blocked_reason === null && binding.enrollment_secret_hash === null) {
      await this.rotateEnrollmentSecret(binding);
    }
    return workflow;
  }

  /**
   * Mint a new enrollment token, seal it to the repository's public key, and
   * store only its hash. The previous token stops working immediately.
   */
  async rotateEnrollmentSecret(binding: ActionsExecutionBindingRow): Promise<void> {
    const token = generateEnrollmentToken();
    await this.actions.putEnrollmentSecret(repositoryRef(binding), token);
    await this.repository.storeEnrollmentSecretHash(
      binding.repository_binding_id,
      enrollmentTokenHash(token),
    );
    // `token` goes out of scope here and is never returned, stored, or logged.
  }

  /**
   * Schedule a task and launch an Actions-hosted runner for it.
   *
   * ORDERING IS DELIBERATE. The base coordinator's gate runs first and in full;
   * only if it produces a run does anything reach GitHub. Dispatching first
   * would leave a job running in the user's repository with no work to do.
   */
  async schedule(
    input: Omit<Phase4ScheduleInput, "runner_id" | "runner_generation">,
  ): Promise<Phase4ScheduledRun & { actions: ActionsLaunch }> {
    const binding = await this.repository.bindingForProject(input.project_id);
    if (!binding) {
      throw new ActionsExecutionError(
        "actions_execution_not_configured",
        "This project has no GitHub Actions execution binding, so Norns has nowhere to run the work.",
        "Connect a GitHub repository for this project and enable Actions-hosted execution.",
      );
    }
    // --- EXTRA preconditions. These only ever REFUSE work; the base gate below
    // --- is untouched and still decides everything it decided before.
    if (!binding.enabled) {
      throw new ActionsExecutionError(
        "actions_execution_disabled",
        `Actions-hosted execution is disabled for ${binding.owner}/${binding.name}.`,
        "Re-enable Actions-hosted execution for this project in settings.",
      );
    }
    const workflow = await this.prepare(binding);
    if (workflow.blocked_reason !== null) {
      throw new ActionsExecutionError(
        "actions_workflow_blocked",
        workflow.blocked_reason,
        workflow.blocked_reason,
      );
    }
    const prepared = await this.repository.bindingForProject(input.project_id);
    if (!prepared?.enrollment_secret_hash) {
      throw new ActionsExecutionError(
        "actions_enrollment_secret_missing",
        "The Norns runner credential is not provisioned in this repository.",
        "Norns could not write the repository Actions secret. Confirm the GitHub App has Secrets: write on this repository.",
      );
    }

    // Reserve the generation the job will enroll at BEFORE building the
    // command, so the command carries the generation the runner will prove it
    // owns. Reserving also fences any previous ephemeral generation at once.
    const runnerGeneration = this.options.reserveGeneration(prepared.runner_id);

    // --- The existing Phase 4 gate, called unchanged. ---
    const scheduled = await this.coordinator.schedule({
      ...input,
      runner_id: prepared.runner_id,
      runner_generation: runnerGeneration,
    });

    await this.repository.createRun({
      project_id: input.project_id,
      repository_binding_id: prepared.repository_binding_id,
      dispatch_job_id: scheduled.dispatch_job_id,
      run_id: scheduled.run_id,
      runner_id: prepared.runner_id,
      runner_generation: runnerGeneration,
    });

    const reference = repositoryRef(prepared);
    try {
      await this.actions.dispatchWorkflow(reference, {
        norns_job_id: scheduled.dispatch_job_id,
        norns_runner_id: prepared.runner_id,
        norns_run_id: scheduled.run_id,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.repository.markFailed(scheduled.dispatch_job_id, detail);
      // The Phase 4 dispatch job stays queued; the existing dispatcher will
      // retry delivery and dead-letter it, which is exactly what should happen
      // when no runner ever arrives.
      throw new ActionsExecutionError(
        "actions_dispatch_failed",
        `Norns scheduled ${scheduled.run_id} but could not start a GitHub Actions job: ${detail}`,
        "Confirm the Norns GitHub App has Actions: write on this repository and that the repository is included in the installation.",
      );
    }

    // workflow_dispatch answers 204 with no body, so correlate afterwards
    // through the run name the template sets. A miss is not fatal: the job may
    // simply not be queued yet, and the runner's own enrollment is what proves
    // it started.
    let located: { id: number; url: string } | null = null;
    try {
      const run = await this.actions.findRunForJob(reference, scheduled.dispatch_job_id);
      if (run) located = { id: run.github_run_id, url: run.html_url };
    } catch {
      located = null;
    }
    await this.repository.markDispatched(scheduled.dispatch_job_id, located);

    return {
      ...scheduled,
      actions: {
        runner_id: prepared.runner_id,
        runner_generation: runnerGeneration,
        workflow,
        github_run_id: located?.id ?? null,
        github_run_url: located?.url ?? null,
      },
    };
  }

  /** Live status of the Actions job backing a dispatch job. */
  async runStatus(
    projectId: string,
    githubRunId: number,
  ): Promise<{ status: string; conclusion: string | null; html_url: string }> {
    const binding = await this.repository.bindingForProject(projectId);
    if (!binding) {
      throw new ActionsExecutionError(
        "actions_execution_not_configured",
        "This project has no GitHub Actions execution binding.",
      );
    }
    const run = await this.actions.runStatus(repositoryRef(binding), githubRunId);
    return { status: run.status, conclusion: run.conclusion, html_url: run.html_url };
  }

  /** Job logs, for diagnosing a job that died before reaching the relay. */
  async runLogs(projectId: string, githubRunId: number): Promise<string> {
    const binding = await this.repository.bindingForProject(projectId);
    if (!binding) {
      throw new ActionsExecutionError(
        "actions_execution_not_configured",
        "This project has no GitHub Actions execution binding.",
      );
    }
    return this.actions.runLogs(repositoryRef(binding), githubRunId);
  }
}

/**
 * Enrollment: the ephemeral runner's one-shot exchange of the repository secret
 * for a live runner identity.
 *
 * Separate from the coordinator because server.ts owns the HTTP surface and
 * relay state; this class owns the decision. Every rejection is a plain
 * `ActionsExecutionError` with a stable code so the route can answer 403
 * without leaking which condition failed.
 */
export class ActionsEnrollmentService {
  constructor(
    private readonly repository: ActionsExecutionRepository,
    private readonly enroll: (
      runnerId: string,
      publicKeyPem: string,
      generation: number,
    ) => { generation: number } | null,
  ) {}

  async redeem(input: {
    enrollment_token: string;
    runner_id: string;
    dispatch_job_id: string;
    public_key_pem: string;
  }): Promise<{ runner_id: string; generation: number; run_id: string }> {
    const rejected = new ActionsExecutionError(
      "invalid_enrollment",
      "This Norns enrollment request was rejected.",
    );
    const binding = await this.repository.bindingForRunner(input.runner_id);
    if (!binding || !binding.enabled || !binding.enrollment_secret_hash) throw rejected;
    // Compare hashes, never the token. Both operands are fixed-length hex.
    if (enrollmentTokenHash(input.enrollment_token) !== binding.enrollment_secret_hash) {
      throw rejected;
    }
    // Single-use, and only against a job Norns itself dispatched.
    const claimed = await this.repository.redeemEnrollment({
      dispatch_job_id: input.dispatch_job_id,
      runner_id: input.runner_id,
    });
    if (!claimed || claimed.runner_generation === null) throw rejected;
    // The reservation must still be the current one: a superseded generation
    // has already lost its claim.
    const registered = this.enroll(
      input.runner_id,
      input.public_key_pem,
      claimed.runner_generation,
    );
    if (!registered) throw rejected;
    return {
      runner_id: input.runner_id,
      generation: registered.generation,
      run_id: claimed.run_id,
    };
  }
}

/** Re-exported so callers can assert the version they installed. */
export { NORNS_WORKFLOW_VERSION, Phase4CoordinatorConflictError };
