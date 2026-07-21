/*
 * ONBOARDING O4 — Actions-hosted execution, as a strict EXTENSION of the
 * Phase 4 coordinator. See the design and blast-radius notes below the imports.
 */
import { timingSafeEqual } from "node:crypto";
import { NORNS_WORKFLOW_VERSION } from "../integrations/actionsWorkflowTemplate.js";
import {
  type ActionsRepositoryRef,
  type GitHubActionsService,
  type WorkflowInstallResult,
  enrollmentTokenHash,
  generateEnrollmentToken,
} from "../integrations/githubActions.js";
import { nonce } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
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
//   1. DISPATCH-SCOPED IDENTITY (EXECUTION E5). The token enrolls a runner id
//      that belongs to exactly one DISPATCH — `actionsDispatchRunnerId()`
//      mints a fresh id (`actions:${projectId}:${nonce}`) inside `schedule()`
//      for every launch, never reused across launches, and unique per
//      dispatch at the database level (`github_actions_runs_runner_id_idx`).
//      It is not the user's laptop runner and shares no identity with it.
//      Commands for other projects are never routed to it, and the Phase 4
//      coordinator independently rejects a run whose repository binding does
//      not match. Compromising this repository yields this repository, and
//      compromising one dispatch's identity yields at most that one dispatch.
//
//      BEFORE E5, the id was project-scoped (`actions:${projectId}`, one per
//      project for the project's whole lifetime). That made every dispatch in
//      a project share one generation counter and one relay socket slot, so
//      scheduling job B while job A was still running reserved a new
//      generation FOR JOB A'S OWN IDENTITY and fenced job A off its own run,
//      unconditionally, regardless of whether job B's own dispatch was itself
//      accepted or refused by the concurrency cap below. Per-dispatch identity
//      removes the shared state entirely: two dispatches in the same project
//      now hold disjoint `RelayStores` records, so nothing about scheduling
//      one can ever fence the other.
//
//   2. SINGLE USE, AGAINST AN ALREADY-DISPATCHED JOB. Enrollment must name a
//      `github_actions_runs` row that Norns itself created, that is in status
//      `dispatched`, and whose `enrolled_at` is NULL. Redemption flips
//      `enrolled_at` in the same atomic UPDATE, so the second attempt loses.
//      A stolen token cannot be used to sit on the relay waiting for work: it
//      can only race the legitimate job for a job Norns already decided to run.
//
//   3. SHORT GENERATION LIFETIME, NOW SCOPED TO ONE DISPATCH. Each launch
//      reserves a fresh generation for that launch's OWN fresh runner id,
//      which fences only a previous connection for that SAME dispatch
//      identity (a re-run GitHub Actions attempt for the same job, or a
//      resurrected zombie). A token redeemed against a superseded generation
//      is refused, and any connection holding the old generation is fenced
//      off by the existing generation machinery — this protection is
//      unchanged, only its blast radius shrank from "the whole project" to
//      "this one dispatch".
//
//   4. NO STANDING AUTHORITY. The enrollment token is not a relay session
//      credential and not a GitHub credential. It cannot read Norns data, it
//      cannot enumerate projects, and it grants nothing on GitHub — pushes
//      inside the job use GitHub's own GITHUB_TOKEN, which GitHub already
//      scopes to this repository and expires with the job (ONBOARDING O4
//      item 4: no Norns token broker for pushing).
//
//   5. ROTATION ON EVERY LAUNCH. `prepare()` calls `rotateEnrollmentSecret()`
//      on every launch, not merely the first: a new token is minted, sealed to
//      the repository public key, and written over the secret, and the old
//      value dies the moment the new hash is stored (only one hash is kept).
//      This is what stops a single successful read from being permanent — a
//      token observed during run N is already dead by run N+1, so an attacker
//      must re-read the secret for every run they want to intercept rather
//      than reading once and winning every future dispatch. Revocation without
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
// The residual risk, stated without flattery:
//
//   * An attacker with repository write access can already run arbitrary code
//     in that repository's CI and can already push to it. What Norns adds is
//     the ability to intercept Norns runs for that one project.
//   * Rotation bounds that to runs whose secret they actually read. It does
//     NOT reduce it to a single run: someone holding persistent write access
//     can re-read the rotated secret before each dispatch. Rotation removes
//     the "read once, own every future run" property; it does not remove
//     "retain access, keep reading". Only revoking their repository access,
//     or disabling the binding, does that.
//   * Interception is also not silent. Enrollment is single-use, so a stolen
//     redemption makes the legitimate job's own enrollment fail, and both
//     outcomes are audited (`actions.enrollment.completed` / `.rejected`).
//   * It does not add access to other projects, to other repositories, to the
//     relay at large, or to the GitHub App's private key, which never leaves
//     the server (ADR-006).

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

/**
 * The project-scoped placeholder identity written onto
 * `github_actions_execution_bindings.runner_id` at provisioning time (see
 * `ensureBindingForProject`/`upsertBinding` below). This is now PROVENANCE
 * ONLY — a stable tag identifying which project's binding a row belongs to —
 * and is never itself reserved a generation, never itself dispatched, and
 * never itself presented by a runner for enrollment. `repository_bindings`'s
 * own mirror of this same value (`ProjectActivationService.actionsRunnerIdFor`,
 * for `binding_type='github'` rows) is exactly as documented there: it is not
 * gate-checked by `Phase4Coordinator.schedule()` either.
 *
 * The identity a runner actually enrolls and authenticates as is
 * `actionsDispatchRunnerId()`, below — one fresh value per dispatch, never
 * this one.
 */
export function actionsRunnerId(projectId: string): string {
  return `actions:${projectId}`;
}

/**
 * EXECUTION E5 — the identity an Actions-hosted ephemeral runner actually
 * enrolls, authenticates, and is fenced or revoked as: one fresh value per
 * DISPATCH, never reused, and never shared across two dispatches even in the
 * same project. `dispatchNonce` must be unpredictable and never reused by the
 * caller (see `ActionsExecutionCoordinator.schedule()`, which draws it from
 * `nonce()` exactly once per launch).
 *
 * This is the fix for the cross-dispatch fencing bug: when every dispatch in
 * a project shared `actionsRunnerId(projectId)`, scheduling a second job
 * reserved a new generation for the FIRST job's identity too (they were the
 * same string), fencing a still-running job off its own connection. Per-
 * dispatch identity means `RelayStores` holds a disjoint record — disjoint
 * generation counter, disjoint relay socket slot — for every dispatch, so
 * nothing about scheduling one can ever affect another's connection.
 */
export function actionsDispatchRunnerId(projectId: string, dispatchNonce: string): string {
  return `${actionsRunnerId(projectId)}:${dispatchNonce}`;
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

// EXECUTION E5 — the same columns, qualified for a query that joins
// `github_actions_execution_bindings` against `github_actions_runs`, which has
// its own (different-meaning) `project_id`, `repository_binding_id`, and
// `runner_id` columns. Unqualified `BINDING_COLUMNS` would be ambiguous there.
const QUALIFIED_BINDING_COLUMNS = `bindings.repository_binding_id, bindings.project_id,
          bindings.connection_id, bindings.installation_id, bindings.repository_github_id,
          bindings.owner, bindings.name, bindings.default_branch, bindings.workflow_version,
          bindings.workflow_installed_at, bindings.workflow_blocked_reason, bindings.runner_id,
          bindings.enrollment_secret_hash, bindings.enabled`;

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

  /**
   * EXECUTION E5 — resolve the binding an ENROLLING RUNNER should be checked
   * against, now that `runner_id` is minted fresh per dispatch and no longer
   * lives on `github_actions_execution_bindings` (that table's own `runner_id`
   * is the per-project provisioning placeholder documented on
   * `actionsRunnerId()`, not a per-dispatch value — it will never match).
   *
   * Resolved through `github_actions_runs`, which already records exactly
   * which dispatch a runner id belongs to (`createRun()` stores it there at
   * schedule time). Matching on BOTH `dispatch_job_id` (globally unique) AND
   * `runner_id` is redundant with `redeemEnrollment`'s own predicate by
   * design — two independent checks of "this runner id belongs to this
   * dispatch" is exactly the kind of duplication that is safe to keep, unlike
   * duplicating an authorization DECISION.
   */
  bindingForDispatch(
    dispatchJobId: string,
    runnerId: string,
  ): Promise<ActionsExecutionBindingRow | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<ActionsExecutionBindingRow>(
        `SELECT ${QUALIFIED_BINDING_COLUMNS}
         FROM github_actions_execution_bindings bindings
         JOIN github_actions_runs runs ON runs.repository_binding_id = bindings.repository_binding_id
         WHERE runs.dispatch_job_id = $1 AND runs.runner_id = $2`,
        [dispatchJobId, runnerId],
      );
      return result.rows[0] ?? null;
    });
  }

  /**
   * Derive (and keep fresh) the Actions execution binding from the project's
   * own primary GitHub repository binding.
   *
   * This is what makes the Actions path self-provisioning. Previously the only
   * caller of `upsertBinding` was the test suite, so in production every
   * schedule request returned `actions_execution_not_configured` forever.
   * Rather than requiring the projects module to call into this seam — a
   * cross-module coupling that would have to be negotiated between two agents
   * working in parallel — the binding is projected here, read-only, from the
   * row the projects module already writes.
   *
   * Returns null when the project has no primary GitHub binding, or when its
   * `repository_id` is not the numeric GitHub id that installation-token
   * scoping requires. Both are "not configured", never a silent half-state.
   */
  ensureBindingForProject(projectId: string): Promise<ActionsExecutionBindingRow | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<ActionsExecutionBindingRow>(
        `INSERT INTO github_actions_execution_bindings (
           repository_binding_id, project_id, connection_id, installation_id,
           repository_github_id, owner, name, default_branch, runner_id
         )
         SELECT binding.id,
                binding.project_id,
                'github:' || binding.github_installation_id,
                binding.github_installation_id,
                binding.repository_id::BIGINT,
                binding.github_owner,
                binding.github_name,
                binding.default_branch,
                $2
         FROM repository_bindings binding
         JOIN projects project
           ON project.id = binding.project_id
          AND project.primary_repository_binding_id = binding.id
         WHERE binding.project_id = $1
           AND binding.binding_type = 'github'
           AND binding.github_installation_id IS NOT NULL
           AND binding.github_owner IS NOT NULL
           AND binding.github_name IS NOT NULL
           -- repository_id is TEXT; only the numeric GitHub id can scope a token.
           AND binding.repository_id ~ '^[0-9]+$'
         ON CONFLICT (repository_binding_id) DO UPDATE SET
           connection_id = EXCLUDED.connection_id,
           installation_id = EXCLUDED.installation_id,
           repository_github_id = EXCLUDED.repository_github_id,
           owner = EXCLUDED.owner,
           name = EXCLUDED.name,
           default_branch = EXCLUDED.default_branch,
           updated_at = now()
         RETURNING ${BINDING_COLUMNS}`,
        [projectId, actionsRunnerId(projectId)],
      );
      // No row inserted/updated means no eligible GitHub binding exists. An
      // existing row may still be present from an earlier projection, so fall
      // back to reading it rather than reporting "not configured" wrongly.
      return result.rows[0] ?? (await this.readBinding(sql, "project_id", projectId));
    });
  }

  private async readBinding(
    sql: V2SqlExecutor,
    column: "project_id" | "runner_id",
    value: string,
  ): Promise<ActionsExecutionBindingRow | null> {
    const result = await sql.query<ActionsExecutionBindingRow>(
      `SELECT ${BINDING_COLUMNS} FROM github_actions_execution_bindings WHERE ${column} = $1`,
      [value],
    );
    return result.rows[0] ?? null;
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

  /**
   * Attach GitHub run correlation after the fact.
   *
   * Deliberately does NOT touch `status`: by the time correlation resolves the
   * job may already have enrolled, and moving it backwards would invalidate a
   * live runner.
   */
  attachGitHubRun(dispatchJobId: string, run: { id: number; url: string }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
         SET github_run_id = $2, github_run_url = $3, updated_at = now()
         WHERE dispatch_job_id = $1 AND github_run_id IS NULL`,
        [dispatchJobId, run.id, run.url],
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
    // Rotate on EVERY launch, not only when no secret exists yet. A secret read
    // once would otherwise stay valid for every future dispatch, so an attacker
    // who read it would not have to race a scheduled run — they would win every
    // subsequent one. Rotating here means a value observed during run N is
    // already dead by run N+1.
    if (workflow.blocked_reason === null) {
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
    // Self-provisioning: project the Actions binding from the project's own
    // primary GitHub repository binding, creating or refreshing it as needed.
    const binding = await this.repository.ensureBindingForProject(input.project_id);
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

    // EXECUTION E5 — a fresh identity for THIS dispatch alone, never reused
    // across launches and never shared with any other dispatch in this (or
    // any other) project. See `actionsDispatchRunnerId()` for why: reusing
    // `prepared.runner_id` (the project-scoped placeholder) here used to mean
    // every dispatch in a project reserved a generation for the SAME identity,
    // so scheduling job B fenced job A off its own still-running connection.
    const dispatchRunnerId = actionsDispatchRunnerId(input.project_id, nonce());

    // Reserve the generation the job will enroll at BEFORE building the
    // command, so the command carries the generation the runner will prove it
    // owns. Reserving also fences any previous connection for THIS dispatch
    // identity (a re-run GitHub Actions attempt for the same job) — never any
    // other dispatch's identity, since no two dispatches ever share one.
    const runnerGeneration = this.options.reserveGeneration(dispatchRunnerId);

    // --- The existing Phase 4 gate, called unchanged. ---
    const scheduled = await this.coordinator.schedule({
      ...input,
      runner_id: dispatchRunnerId,
      runner_generation: runnerGeneration,
    });

    await this.repository.createRun({
      project_id: input.project_id,
      repository_binding_id: prepared.repository_binding_id,
      dispatch_job_id: scheduled.dispatch_job_id,
      run_id: scheduled.run_id,
      runner_id: dispatchRunnerId,
      runner_generation: runnerGeneration,
    });

    const reference = repositoryRef(prepared);
    try {
      await this.actions.dispatchWorkflow(reference, {
        norns_job_id: scheduled.dispatch_job_id,
        norns_runner_id: dispatchRunnerId,
        norns_run_id: scheduled.run_id,
      });
      // Commit `dispatched` IMMEDIATELY after the 204, before any further
      // network call. `redeemEnrollment` requires status='dispatched', and a
      // fast job can enroll while a run-correlation round-trip is still in
      // flight — which used to produce an opaque 403 and a dead job holding a
      // queued dispatch. Run correlation is attached afterwards as an update.
      await this.repository.markDispatched(scheduled.dispatch_job_id, null);
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
    // through the run name the template sets. A miss is not fatal and must not
    // affect enrollment: the job may simply not be queued yet, and the runner's
    // own enrollment is what proves it started.
    let located: { id: number; url: string } | null = null;
    try {
      const run = await this.actions.findRunForJob(reference, scheduled.dispatch_job_id);
      if (run) located = { id: run.github_run_id, url: run.html_url };
    } catch {
      located = null;
    }
    if (located) await this.repository.attachGitHubRun(scheduled.dispatch_job_id, located);

    return {
      ...scheduled,
      actions: {
        runner_id: dispatchRunnerId,
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
    const binding = await this.repository.bindingForDispatch(
      input.dispatch_job_id,
      input.runner_id,
    );
    if (!binding || !binding.enabled || !binding.enrollment_secret_hash) throw rejected;
    // Compare hashes, never the token, and compare them in constant time.
    // Both operands are fixed-length hex, so a length mismatch means a
    // corrupt stored hash rather than an attacker-chosen length.
    const supplied = Buffer.from(enrollmentTokenHash(input.enrollment_token), "utf8");
    const expected = Buffer.from(binding.enrollment_secret_hash, "utf8");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
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
