/*
 * ONBOARDING O4 — Actions-hosted execution, as a strict EXTENSION of the
 * Phase 4 coordinator. See the design and blast-radius notes below the imports.
 */
import { createHash } from "node:crypto";
import { nonce } from "../ids.js";
import { NORNS_WORKFLOW_VERSION } from "../integrations/actionsWorkflowTemplate.js";
import {
  type ActionsRepositoryRef,
  type GitHubActionsService,
  type WorkflowInstallResult,
  enrollmentTokenHash,
  generateEnrollmentToken,
} from "../integrations/githubActions.js";
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
//   2. RUN-PINNED, AGAINST AN ALREADY-DISPATCHED JOB. Enrollment must name
//      the exact Actions row, dispatch job, command, runner id, and generation
//      Norns created, with a live command envelope and its per-run token hash.
//      The first success binds an exact public-key hash and PEM atomically.
//      A response-loss retry with the same token and key is idempotent; a
//      changed token/key or a terminal/expired command loses.
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
//   5. SERIALIZED ROTATION AND PER-RUN HASHES. The repository secret is
//      rotated only after a launch owns the head of that repository's durable
//      FIFO. Its hash is pinned on the run before workflow_dispatch. No
//      successor may rotate the repository secret until the predecessor
//      enrolls or terminalizes, and ambiguous 204/restart retries preserve the
//      pinned hash. Later rotation does not invalidate an older token for its
//      own still-live exact command, but that token has no authority over any
//      successor row. `enabled = false` refuses every enrollment; runner
//      revocation remains the coordinator-level kill switch.
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
//   * Interception is also not silent. The first redemption binds the exact
//     public key, so a stolen redemption makes the legitimate job's changed
//     key fail; exact response-loss replay is the only accepted repeat.
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
    enrollment_secret_hash?: string;
  }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO github_actions_runs (
           id, project_id, repository_binding_id, dispatch_job_id, run_id,
           runner_id, runner_generation, enrollment_secret_hash, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested')
         ON CONFLICT(dispatch_job_id) DO NOTHING`,
        [
          `actions-run:${input.dispatch_job_id}`,
          input.project_id,
          input.repository_binding_id,
          input.dispatch_job_id,
          input.run_id,
          input.runner_id,
          input.runner_generation,
          input.enrollment_secret_hash ?? null,
        ],
      );
      const stored = (
        await sql.query<{
          project_id: string;
          repository_binding_id: string;
          run_id: string;
          runner_id: string;
          runner_generation: number | null;
          enrollment_secret_hash: string | null;
          status: string;
        }>(
          `SELECT project_id,repository_binding_id,run_id,runner_id,runner_generation,
                  enrollment_secret_hash,status
             FROM github_actions_runs WHERE dispatch_job_id=$1`,
          [input.dispatch_job_id],
        )
      ).rows[0];
      if (
        !stored ||
        stored.project_id !== input.project_id ||
        stored.repository_binding_id !== input.repository_binding_id ||
        stored.run_id !== input.run_id ||
        stored.runner_id !== input.runner_id ||
        stored.runner_generation !== input.runner_generation ||
        (input.enrollment_secret_hash !== undefined &&
          stored.enrollment_secret_hash !== input.enrollment_secret_hash)
      ) {
        throw new ActionsExecutionError(
          "actions_run_replay_mismatch",
          "the existing Actions launch does not match this continuation",
        );
      }
    });
  }

  runForDispatch(dispatchJobId: string): Promise<{
    status: string;
    github_run_id: number | null;
    github_run_url: string | null;
    enrollment_secret_hash: string | null;
  } | null> {
    return this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{
          status: string;
          github_run_id: number | null;
          github_run_url: string | null;
          enrollment_secret_hash: string | null;
        }>(
          `SELECT status,github_run_id,github_run_url,enrollment_secret_hash
             FROM github_actions_runs WHERE dispatch_job_id=$1`,
          [dispatchJobId],
        )
      ).rows[0];
      return row ?? null;
    });
  }

  launchDeadline(dispatchJobId: string): Promise<Date | string | null> {
    return this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{ expires_at: Date | string }>(
          `SELECT (command.envelope->>'expires_at')::timestamptz AS expires_at
             FROM github_actions_runs actions
             JOIN dispatch_jobs job ON job.id=actions.dispatch_job_id
             JOIN commands command ON command.command_id=job.command_id
            WHERE actions.dispatch_job_id=$1`,
          [dispatchJobId],
        )
      ).rows[0];
      return row?.expires_at ?? null;
    });
  }

  recoverableLaunch(): Promise<{
    project_id: string;
    repository_binding_id: string;
    dispatch_job_id: string;
    run_id: string;
    runner_id: string;
    runner_generation: number;
  } | null> {
    return this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{
          project_id: string;
          repository_binding_id: string;
          dispatch_job_id: string;
          run_id: string;
          runner_id: string;
          runner_generation: number;
        }>(
          `SELECT candidate.project_id,candidate.repository_binding_id,
                  candidate.dispatch_job_id,candidate.run_id,
                  candidate.runner_id,candidate.runner_generation
             FROM github_actions_runs candidate
             JOIN github_actions_execution_bindings candidate_binding
               ON candidate_binding.repository_binding_id=candidate.repository_binding_id
              AND candidate_binding.enabled
             JOIN dispatch_jobs candidate_job
               ON candidate_job.id=candidate.dispatch_job_id
              AND candidate_job.status='awaiting_enrollment'
              AND candidate_job.run_id=candidate.run_id
              AND candidate_job.runner_id=candidate.runner_id
             JOIN commands candidate_command
               ON candidate_command.command_id=candidate_job.command_id
              AND candidate_command.dispatch_job_id=candidate_job.id
              AND candidate_command.run_id=candidate.run_id
              AND candidate_command.runner_id=candidate.runner_id
              AND candidate_command.runner_generation=candidate.runner_generation
              AND candidate_command.status='queued'
              AND (candidate_command.envelope->>'expires_at')::timestamptz>now()
             WHERE candidate.launch_available_at<=now()
              AND (
                candidate.status='requested'
                OR (
                  candidate.status='dispatching'
                  AND candidate.launch_lease_expires_at<=now()
                )
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM github_actions_runs predecessor
                  JOIN github_actions_execution_bindings predecessor_binding
                    ON predecessor_binding.repository_binding_id=
                       predecessor.repository_binding_id
                   AND predecessor_binding.enabled
                  JOIN dispatch_jobs predecessor_job
                    ON predecessor_job.id=predecessor.dispatch_job_id
                   AND predecessor_job.status='awaiting_enrollment'
                   AND predecessor_job.run_id=predecessor.run_id
                   AND predecessor_job.runner_id=predecessor.runner_id
                  JOIN commands predecessor_command
                    ON predecessor_command.command_id=predecessor_job.command_id
                   AND predecessor_command.dispatch_job_id=predecessor_job.id
                   AND predecessor_command.run_id=predecessor.run_id
                   AND predecessor_command.runner_id=predecessor.runner_id
                   AND predecessor_command.runner_generation=
                       predecessor.runner_generation
                   AND predecessor_command.status='queued'
                   AND (predecessor_command.envelope->>'expires_at')::timestamptz>now()
                 WHERE predecessor.repository_binding_id=candidate.repository_binding_id
                   AND predecessor.dispatch_job_id<>candidate.dispatch_job_id
                   AND (
                     predecessor.status IN ('dispatching','dispatched')
                     OR (
                       predecessor.status='requested'
                       AND (
                         predecessor.requested_at<candidate.requested_at
                         OR (
                           predecessor.requested_at=candidate.requested_at
                           AND predecessor.dispatch_job_id<candidate.dispatch_job_id
                         )
                       )
                     )
                   )
              )
            ORDER BY candidate.launch_available_at,candidate.requested_at,
                     candidate.dispatch_job_id
            LIMIT 1`,
        )
      ).rows[0];
      return row ?? null;
    });
  }

  claimLaunch(
    dispatchJobId: string,
    owner: string,
    leaseMs: number,
  ): Promise<{ attempts: number } | null> {
    return this.transactions.transaction(async (sql) => {
      const scope = (
        await sql.query<{ repository_binding_id: string }>(
          `SELECT run.repository_binding_id
             FROM github_actions_runs run
             JOIN github_actions_execution_bindings binding
               ON binding.repository_binding_id=run.repository_binding_id
              AND binding.enabled
             JOIN dispatch_jobs job
               ON job.id=run.dispatch_job_id
              AND job.status='awaiting_enrollment'
              AND job.run_id=run.run_id
              AND job.runner_id=run.runner_id
             JOIN commands command
               ON command.command_id=job.command_id
              AND command.dispatch_job_id=job.id
              AND command.run_id=run.run_id
              AND command.runner_id=run.runner_id
              AND command.runner_generation=run.runner_generation
              AND command.status='queued'
              AND (command.envelope->>'expires_at')::timestamptz>now()
            WHERE run.dispatch_job_id=$1
            FOR UPDATE OF binding,run,job,command`,
          [dispatchJobId],
        )
      ).rows[0];
      if (!scope) return null;
      const result = await sql.query<{ attempts: number }>(
        `UPDATE github_actions_runs
            SET status='dispatching',launch_lease_owner=$3,
                launch_lease_expires_at=now()+($4::text || ' milliseconds')::interval,
                launch_attempts=launch_attempts+1,last_dispatch_attempt_at=now(),
                launch_available_at=now()+($4::text || ' milliseconds')::interval,
                last_error=NULL,updated_at=now()
          WHERE dispatch_job_id=$1
            AND (
              status='requested'
              OR (
                status='dispatching'
                AND launch_lease_expires_at<=now()
              )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM github_actions_runs active
                JOIN github_actions_execution_bindings active_binding
                  ON active_binding.repository_binding_id=
                     active.repository_binding_id
                 AND active_binding.enabled
                JOIN dispatch_jobs active_job
                  ON active_job.id=active.dispatch_job_id
                 AND active_job.status='awaiting_enrollment'
                 AND active_job.run_id=active.run_id
                 AND active_job.runner_id=active.runner_id
                JOIN commands active_command
                  ON active_command.command_id=active_job.command_id
                 AND active_command.dispatch_job_id=active_job.id
                 AND active_command.run_id=active.run_id
                 AND active_command.runner_id=active.runner_id
                 AND active_command.runner_generation=active.runner_generation
                 AND active_command.status='queued'
                 AND (active_command.envelope->>'expires_at')::timestamptz>now()
               WHERE active.repository_binding_id=$2
                 AND active.dispatch_job_id<>$1
                 AND (
                   active.status IN ('dispatching','dispatched')
                   OR (
                     active.status='requested'
                     AND (
                       active.requested_at < (
                         SELECT requested_at FROM github_actions_runs
                          WHERE dispatch_job_id=$1
                       )
                       OR (
                         active.requested_at = (
                           SELECT requested_at FROM github_actions_runs
                            WHERE dispatch_job_id=$1
                         )
                         AND active.dispatch_job_id<$1
                       )
                     )
                   )
                 )
            )
          RETURNING launch_attempts AS attempts`,
        [dispatchJobId, scope.repository_binding_id, owner, leaseMs],
      );
      return result.rows[0] ?? null;
    });
  }

  storeRunEnrollmentSecretHash(dispatchJobId: string, owner: string, hash: string): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ dispatch_job_id: string }>(
        `UPDATE github_actions_runs
            SET enrollment_secret_hash=$3,updated_at=now()
          WHERE dispatch_job_id=$1 AND status='dispatching'
            AND launch_lease_owner=$2
            AND launch_lease_expires_at>now()
          RETURNING dispatch_job_id`,
        [dispatchJobId, owner, hash],
      );
      if (!result.rows[0]) {
        throw new ActionsExecutionError(
          "actions_enrollment_credential_scope_changed",
          "The per-dispatch enrollment credential lost its fenced launch.",
        );
      }
    });
  }

  renewLaunchLease(dispatchJobId: string, owner: string, leaseMs: number): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ dispatch_job_id: string }>(
        `UPDATE github_actions_runs actions
            SET launch_lease_expires_at=now()+($3::text || ' milliseconds')::interval,
                launch_available_at=now()+($3::text || ' milliseconds')::interval,
                updated_at=now()
           FROM github_actions_execution_bindings binding,
                dispatch_jobs job,commands command
          WHERE actions.dispatch_job_id=$1 AND actions.status='dispatching'
            AND actions.launch_lease_owner=$2
            AND actions.launch_lease_expires_at>now()
            AND binding.repository_binding_id=actions.repository_binding_id
            AND binding.enabled
            AND job.id=actions.dispatch_job_id
            AND job.status='awaiting_enrollment'
            AND job.run_id=actions.run_id
            AND job.runner_id=actions.runner_id
            AND command.command_id=job.command_id
            AND command.dispatch_job_id=job.id
            AND command.run_id=actions.run_id
            AND command.runner_id=actions.runner_id
            AND command.runner_generation=actions.runner_generation
            AND command.status='queued'
            AND (command.envelope->>'expires_at')::timestamptz>now()
          RETURNING actions.dispatch_job_id`,
        [dispatchJobId, owner, leaseMs],
      );
      if (!result.rows[0]) {
        throw new ActionsExecutionError(
          "actions_launch_lease_lost",
          "The GitHub Actions launch lease expired or was reclaimed.",
        );
      }
    });
  }

  markDispatched(
    dispatchJobId: string,
    run: { id: number; url: string } | null,
    owner?: string,
  ): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ dispatch_job_id: string }>(
        `UPDATE github_actions_runs
         SET status='dispatched',github_run_id=COALESCE($2,github_run_id),
             github_run_url=COALESCE($3,github_run_url),
             launch_lease_owner=NULL,launch_lease_expires_at=NULL,updated_at=now()
         WHERE dispatch_job_id=$1
           AND (
             (
               status IN ('requested','dispatching','dispatched')
               AND $4::text IS NULL
             )
             OR (
               status='dispatching'
               AND ($4::text IS NULL OR (
                 launch_lease_owner=$4
                 AND launch_lease_expires_at>now()
               ))
             )
           )
         RETURNING dispatch_job_id`,
        [dispatchJobId, run?.id ?? null, run?.url ?? null, owner ?? null],
      );
      if (!result.rows[0]) {
        throw new ActionsExecutionError(
          "actions_launch_lease_lost",
          "The GitHub Actions launch could not be recorded because its lease was lost.",
        );
      }
    });
  }

  releaseLaunch(
    dispatchJobId: string,
    owner: string,
    error: string,
    retry: boolean,
    retryDelayMs = 5_000,
  ): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
            SET status=CASE WHEN $4 THEN 'requested' ELSE 'failed' END,
                launch_lease_owner=NULL,launch_lease_expires_at=NULL,
                launch_available_at=CASE
                  WHEN $4 THEN now()+($5::text || ' milliseconds')::interval
                  ELSE launch_available_at
                END,
                last_error=$3,
                completed_at=CASE WHEN $4 THEN NULL ELSE now() END,
                updated_at=now()
          WHERE dispatch_job_id=$1 AND status='dispatching'
            AND launch_lease_owner=$2`,
        [dispatchJobId, owner, error.slice(0, 2_000), retry, retryDelayMs],
      );
    });
  }

  claimUnenrolledReconciliation(
    owner: string,
    leaseMs: number,
  ): Promise<{
    project_id: string;
    repository_binding_id: string;
    dispatch_job_id: string;
    github_run_id: number | null;
    reconcile_attempts: number;
    command_expires_at: Date | string;
  } | null> {
    return this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{
          project_id: string;
          repository_binding_id: string;
          dispatch_job_id: string;
          github_run_id: number | null;
          reconcile_attempts: number;
          command_expires_at: Date | string;
        }>(
          `WITH candidate AS (
             SELECT actions.dispatch_job_id,
                    (command.envelope->>'expires_at')::timestamptz AS command_expires_at
               FROM github_actions_runs actions
               JOIN dispatch_jobs job ON job.id=actions.dispatch_job_id
               JOIN commands command ON command.command_id=job.command_id
              WHERE actions.status IN ('dispatched','enrolled')
                AND job.status='awaiting_enrollment'
                AND actions.reconcile_available_at<=now()
                AND (
                  actions.reconcile_lease_owner IS NULL
                  OR actions.reconcile_lease_expires_at<=now()
                )
              ORDER BY actions.reconcile_available_at,actions.requested_at,
                       actions.dispatch_job_id
              FOR UPDATE OF actions,job SKIP LOCKED
              LIMIT 1
           )
           UPDATE github_actions_runs actions
              SET reconcile_lease_owner=$1,
                  reconcile_lease_expires_at=
                    now()+($2::text || ' milliseconds')::interval,
                  reconcile_attempts=reconcile_attempts+1,
                  reconcile_available_at=
                    now()+($2::text || ' milliseconds')::interval,
                  updated_at=now()
             FROM candidate
            WHERE actions.dispatch_job_id=candidate.dispatch_job_id
          RETURNING actions.project_id,actions.repository_binding_id,
                    actions.dispatch_job_id,actions.github_run_id,
                    actions.reconcile_attempts,candidate.command_expires_at`,
          [owner, leaseMs],
        )
      ).rows[0];
      return row ?? null;
    });
  }

  releaseUnenrolledReconciliation(
    dispatchJobId: string,
    owner: string,
    retryDelayMs: number,
    error: string | null,
  ): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
            SET reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,
                reconcile_available_at=
                  now()+($3::text || ' milliseconds')::interval,
                last_error=CASE WHEN $4::text IS NULL THEN last_error ELSE $4 END,
                updated_at=now()
          WHERE dispatch_job_id=$1 AND status IN ('dispatched','enrolled')
            AND reconcile_lease_owner=$2`,
        [dispatchJobId, owner, retryDelayMs, error?.slice(0, 2_000) ?? null],
      );
    });
  }

  markUnenrolledTerminal(
    dispatchJobId: string,
    owner: string,
    conclusion: string,
  ): Promise<boolean> {
    return this.transactions.transaction(async (sql) => {
      const scope = (
        await sql.query<{
          actions_status: string;
          job_status: string;
          reconcile_lease_owner: string | null;
          reconcile_lease_expires_at: Date | string | null;
        }>(
          `SELECT actions.status AS actions_status,job.status AS job_status,
                  actions.reconcile_lease_owner,
                  actions.reconcile_lease_expires_at
             FROM github_actions_runs actions
             JOIN dispatch_jobs job ON job.id=actions.dispatch_job_id
            WHERE actions.dispatch_job_id=$1
            FOR UPDATE OF actions,job`,
          [dispatchJobId],
        )
      ).rows[0];
      if (
        !scope ||
        scope.job_status !== "awaiting_enrollment" ||
        !["dispatched", "enrolled"].includes(scope.actions_status) ||
        scope.reconcile_lease_owner !== owner ||
        scope.reconcile_lease_expires_at === null ||
        new Date(scope.reconcile_lease_expires_at).getTime() <= Date.now()
      ) {
        return false;
      }
      const result = await sql.query<{ dispatch_job_id: string }>(
        `UPDATE github_actions_runs
            SET status='failed',conclusion=$3,
                last_error='github_actions_ended_before_runner_enrollment',
                completed_at=now(),
                reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,
                updated_at=now()
          WHERE dispatch_job_id=$1 AND status IN ('dispatched','enrolled')
            AND reconcile_lease_owner=$2 AND reconcile_lease_expires_at>now()
          RETURNING dispatch_job_id`,
        [dispatchJobId, owner, conclusion.slice(0, 500)],
      );
      return Boolean(result.rows[0]);
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
         SET status = 'failed', last_error = $2, completed_at = now(),
             launch_lease_owner=NULL,launch_lease_expires_at=NULL,
             reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,
             updated_at = now()
         WHERE dispatch_job_id = $1 AND status NOT IN ('completed','failed')`,
        [dispatchJobId, error.slice(0, 2_000)],
      );
    });
  }

  markCompleted(dispatchJobId: string, conclusion: string | null): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE github_actions_runs
         SET status = 'completed', conclusion = $2, completed_at = now(),
             launch_lease_owner=NULL,launch_lease_expires_at=NULL,
             reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,
             updated_at = now()
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
    enrollment_secret_hash: string;
    public_key_hash: string;
    public_key_pem: string;
  }): Promise<{ run_id: string; runner_generation: number | null } | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ run_id: string; runner_generation: number | null }>(
        `UPDATE github_actions_runs actions
            SET status='enrolled',
                enrolled_at=COALESCE(actions.enrolled_at,now()),
                enrolled_public_key_hash=COALESCE(actions.enrolled_public_key_hash,$4),
                enrolled_public_key_pem=COALESCE(actions.enrolled_public_key_pem,$5),
                reconcile_lease_owner=NULL,reconcile_lease_expires_at=NULL,
                updated_at=now()
           FROM dispatch_jobs job,
                commands command,
                github_actions_execution_bindings binding
          WHERE actions.dispatch_job_id=$1
            AND actions.runner_id=$2
            AND actions.enrollment_secret_hash=$3
            AND actions.enrolled_public_key_hash IS NOT DISTINCT FROM
                CASE WHEN actions.status='enrolled'
                  THEN $4::text ELSE actions.enrolled_public_key_hash END
            AND actions.enrolled_public_key_pem IS NOT DISTINCT FROM
                CASE WHEN actions.status='enrolled'
                  THEN $5::text ELSE actions.enrolled_public_key_pem END
            AND binding.repository_binding_id=actions.repository_binding_id
            AND binding.project_id=actions.project_id
            AND binding.enabled
            AND job.id=actions.dispatch_job_id
            AND job.run_id=actions.run_id
            AND job.runner_id=actions.runner_id
            AND command.command_id=job.command_id
            AND command.dispatch_job_id=job.id
            AND command.run_id=job.run_id
            AND command.runner_id=actions.runner_id
            AND command.runner_generation=actions.runner_generation
            AND (command.envelope->>'expires_at')::timestamptz>now()
            AND NOT EXISTS (
              SELECT 1 FROM runner_revocations revocation
               WHERE revocation.runner_id=actions.runner_id
                 AND revocation.revoked_through_generation>=actions.runner_generation
            )
            AND (
              (
                actions.status='dispatched'
                AND actions.enrolled_at IS NULL
                AND actions.enrolled_public_key_hash IS NULL
                AND job.status='awaiting_enrollment'
                AND command.status='queued'
              )
              OR (
                actions.status='enrolled'
                AND actions.enrolled_public_key_hash=$4
                AND job.status IN ('awaiting_enrollment','delivered')
                AND command.status IN ('queued','dispatched')
              )
            )
         RETURNING actions.run_id,actions.runner_generation`,
        [
          input.dispatch_job_id,
          input.runner_id,
          input.enrollment_secret_hash,
          input.public_key_hash,
          input.public_key_pem,
        ],
      );
      return result.rows[0] ?? null;
    });
  }

  enrolledRunnerIdentity(runnerId: string): Promise<{
    public_key_pem: string;
    runner_generation: number;
  } | null> {
    return this.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{ public_key_pem: string; runner_generation: number }>(
          `SELECT actions.enrolled_public_key_pem AS public_key_pem,
                  actions.runner_generation
             FROM github_actions_runs actions
             JOIN dispatch_jobs job ON job.id=actions.dispatch_job_id
             JOIN commands command
               ON command.command_id=job.command_id
              AND command.dispatch_job_id=job.id
            WHERE actions.runner_id=$1
              AND actions.status='enrolled'
              AND actions.enrolled_public_key_pem IS NOT NULL
              AND actions.runner_generation IS NOT NULL
              AND job.runner_id=actions.runner_id
              AND job.run_id=actions.run_id
              AND job.status IN ('awaiting_enrollment','delivered')
              AND command.runner_id=actions.runner_id
              AND command.runner_generation=actions.runner_generation
              AND command.status IN ('queued','dispatched')
              AND NOT EXISTS (
                SELECT 1 FROM runner_revocations revocation
                 WHERE revocation.runner_id=actions.runner_id
                   AND revocation.revoked_through_generation>=actions.runner_generation
              )
            LIMIT 1`,
          [runnerId],
        )
      ).rows[0];
      return row ?? null;
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
  private readonly launchOwner = `actions-launch:${process.pid}:${nonce()}`;
  private readonly launchLeaseMs = 120_000;

  constructor(
    private readonly coordinator: Phase4Coordinator,
    private readonly repository: ActionsExecutionRepository,
    private readonly actions: GitHubActionsService,
    private readonly options: ActionsExecutionOptions,
  ) {}

  /**
   * Ensure the repository can host ephemeral runners by committing/upgrading
   * the managed workflow. Credential rotation is deliberately owned by the
   * fenced FIFO launch lease, not this preparatory step.
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
    return workflow;
  }

  /**
   * Mint a token for the FIFO launch owner and seal it to the repository's
   * public key. The binding stores the latest hash for provisioning while the
   * launch row stores the durable per-run hash used for redemption.
   */
  async rotateEnrollmentSecret(binding: ActionsExecutionBindingRow): Promise<string> {
    const token = generateEnrollmentToken();
    await this.actions.putEnrollmentSecret(repositoryRef(binding), token);
    const hash = enrollmentTokenHash(token);
    await this.repository.storeEnrollmentSecretHash(binding.repository_binding_id, hash);
    // `token` goes out of scope here and is never returned, stored, or logged.
    return hash;
  }

  async prepareContinuation(projectId: string): Promise<{
    repository_binding_id: string;
  }> {
    const binding = await this.repository.ensureBindingForProject(projectId);
    if (!binding || !binding.enabled) {
      throw new ActionsExecutionError(
        "actions_execution_not_configured",
        "This project has no enabled GitHub Actions execution binding.",
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
    return { repository_binding_id: binding.repository_binding_id };
  }

  async launchContinuation(input: {
    project_id: string;
    repository_binding_id: string;
    dispatch_job_id: string;
    run_id: string;
    runner_id: string;
    runner_generation: number;
    enrollment_secret_hash?: string;
  }): Promise<void> {
    const binding = await this.repository.bindingForProject(input.project_id);
    if (
      !binding ||
      !binding.enabled ||
      binding.repository_binding_id !== input.repository_binding_id
    ) {
      throw new ActionsExecutionError(
        "actions_execution_not_configured",
        "The continuation Actions binding no longer matches the repository.",
      );
    }
    const existing = await this.repository.runForDispatch(input.dispatch_job_id);
    if (existing && ["dispatched", "enrolled", "completed"].includes(existing.status)) return;
    await this.repository.createRun(input);
    const launch = await this.repository.claimLaunch(
      input.dispatch_job_id,
      this.launchOwner,
      this.launchLeaseMs,
    );
    if (!launch) return;
    try {
      await this.repository.renewLaunchLease(
        input.dispatch_job_id,
        this.launchOwner,
        this.launchLeaseMs,
      );
      // A stale dispatching lease may mean GitHub accepted the previous
      // workflow_dispatch but Norns crashed before recording the response.
      // Preserve that launch's pinned credential: the workflow may already
      // have captured it. A hash is minted only for the first launch attempt;
      // every recovery and at-least-once redispatch reuses the same repository
      // secret and per-run hash.
      const claimedRun = await this.repository.runForDispatch(input.dispatch_job_id);
      if (!claimedRun?.enrollment_secret_hash) {
        const enrollmentSecretHash = await this.rotateEnrollmentSecret(binding);
        await this.repository.storeRunEnrollmentSecretHash(
          input.dispatch_job_id,
          this.launchOwner,
          enrollmentSecretHash,
        );
      }
      await this.repository.renewLaunchLease(
        input.dispatch_job_id,
        this.launchOwner,
        this.launchLeaseMs,
      );
      const located = await this.actions
        .findRunForJob(repositoryRef(binding), input.dispatch_job_id)
        .catch(() => null);
      if (located) {
        await this.repository.markDispatched(
          input.dispatch_job_id,
          {
            id: located.github_run_id,
            url: located.html_url,
          },
          this.launchOwner,
        );
        return;
      }
      await this.repository.renewLaunchLease(
        input.dispatch_job_id,
        this.launchOwner,
        this.launchLeaseMs,
      );
      await this.actions.dispatchWorkflow(repositoryRef(binding), {
        norns_job_id: input.dispatch_job_id,
        norns_runner_id: input.runner_id,
        norns_run_id: input.run_id,
      });
      await this.repository.markDispatched(input.dispatch_job_id, null, this.launchOwner);
      const correlated = await this.actions
        .findRunForJob(repositoryRef(binding), input.dispatch_job_id)
        .catch(() => null);
      if (correlated) {
        await this.repository.attachGitHubRun(input.dispatch_job_id, {
          id: correlated.github_run_id,
          url: correlated.html_url,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const deadline = await this.repository.launchDeadline(input.dispatch_job_id);
      const retry = deadline !== null && new Date(deadline).getTime() > Date.now();
      const retryDelayMs = Math.min(
        60_000,
        1_000 * 2 ** Math.min(Math.max(0, launch.attempts - 1), 6),
      );
      await this.repository.releaseLaunch(
        input.dispatch_job_id,
        this.launchOwner,
        detail,
        retry,
        retryDelayMs,
      );
      throw new ActionsExecutionError(
        "actions_dispatch_failed",
        `Norns provisioned the continuation but could not launch GitHub Actions: ${detail}`,
      );
    }
  }

  async recoverNextLaunch(): Promise<boolean> {
    const candidate = await this.repository.recoverableLaunch();
    if (!candidate) return false;
    await this.launchContinuation(candidate);
    return true;
  }

  async reconcileNextUnenrolledRun(): Promise<boolean> {
    const candidate = await this.repository.claimUnenrolledReconciliation(
      this.launchOwner,
      this.launchLeaseMs,
    );
    if (!candidate) return false;
    try {
      const binding = await this.repository.bindingForProject(candidate.project_id);
      if (
        !binding ||
        !binding.enabled ||
        binding.repository_binding_id !== candidate.repository_binding_id
      ) {
        await this.repository.markUnenrolledTerminal(
          candidate.dispatch_job_id,
          this.launchOwner,
          "actions_binding_unavailable_before_enrollment",
        );
        return true;
      }
      let githubRunId = candidate.github_run_id;
      if (githubRunId === null) {
        const located = await this.actions.findRunForJob(
          repositoryRef(binding),
          candidate.dispatch_job_id,
        );
        if (!located) {
          if (new Date(candidate.command_expires_at).getTime() <= Date.now()) {
            await this.repository.markUnenrolledTerminal(
              candidate.dispatch_job_id,
              this.launchOwner,
              "github_run_not_correlated_before_command_expiry",
            );
            return true;
          }
          await this.repository.releaseUnenrolledReconciliation(
            candidate.dispatch_job_id,
            this.launchOwner,
            15_000,
            null,
          );
          return true;
        }
        githubRunId = located.github_run_id;
        await this.repository.attachGitHubRun(candidate.dispatch_job_id, {
          id: located.github_run_id,
          url: located.html_url,
        });
      }
      const status = await this.actions.runStatus(repositoryRef(binding), githubRunId);
      if (status.status === "completed") {
        await this.repository.markUnenrolledTerminal(
          candidate.dispatch_job_id,
          this.launchOwner,
          `github:${status.conclusion ?? "completed_without_conclusion"}`,
        );
      } else {
        await this.repository.releaseUnenrolledReconciliation(
          candidate.dispatch_job_id,
          this.launchOwner,
          5_000,
          null,
        );
      }
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.repository.releaseUnenrolledReconciliation(
        candidate.dispatch_job_id,
        this.launchOwner,
        5_000,
        detail,
      );
      throw error;
    }
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
    if (!prepared) {
      throw new ActionsExecutionError(
        "actions_execution_not_configured",
        "The Actions repository binding disappeared before launch.",
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
      awaiting_runner_enrollment: true,
    });

    await this.repository.createRun({
      project_id: input.project_id,
      repository_binding_id: prepared.repository_binding_id,
      dispatch_job_id: scheduled.dispatch_job_id,
      run_id: scheduled.run_id,
      runner_id: dispatchRunnerId,
      runner_generation: runnerGeneration,
    });
    await this.launchContinuation({
      project_id: input.project_id,
      repository_binding_id: prepared.repository_binding_id,
      dispatch_job_id: scheduled.dispatch_job_id,
      run_id: scheduled.run_id,
      runner_id: dispatchRunnerId,
      runner_generation: runnerGeneration,
    });
    const launched = await this.repository.runForDispatch(scheduled.dispatch_job_id);

    return {
      ...scheduled,
      actions: {
        runner_id: dispatchRunnerId,
        runner_generation: runnerGeneration,
        workflow,
        github_run_id: launched?.github_run_id ?? null,
        github_run_url: launched?.github_run_url ?? null,
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
    const publicKeyHash = createHash("sha256").update(input.public_key_pem, "utf8").digest("hex");
    // Exact-scope and exact-key idempotent. A changed token, key, generation,
    // run, job, or binding loses inside the same transaction.
    const durableIdentity = {
      dispatch_job_id: input.dispatch_job_id,
      runner_id: input.runner_id,
      enrollment_secret_hash: enrollmentTokenHash(input.enrollment_token),
      public_key_hash: publicKeyHash,
      public_key_pem: input.public_key_pem,
    };
    const claimed = await this.repository.redeemEnrollment(durableIdentity);
    if (!claimed || claimed.runner_generation === null) throw rejected;
    const registered = this.enroll(
      input.runner_id,
      input.public_key_pem,
      claimed.runner_generation,
    );
    if (!registered) throw rejected;
    return {
      runner_id: input.runner_id,
      generation: claimed.runner_generation,
      run_id: claimed.run_id,
    };
  }
}

/** Re-exported so callers can assert the version they installed. */
export { NORNS_WORKFLOW_VERSION, Phase4CoordinatorConflictError };
