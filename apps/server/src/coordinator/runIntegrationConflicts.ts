// EXECUTION E12 — conflict safety for two agents editing one repository.
//
// ADAPT OR SUPERSEDE: the honest answer, up front.
// ================================================
//
// The refoundation's `engine/coordination.ts` and `engine/integration.ts`
// contain a complete, thought-through answer to this problem: workers in
// separate worktrees on `-w<k>` branches, a lead that assembles them, CLEAN
// MERGES ONLY, a conflict spawning a human-visible conflict node that REPLACES
// the original (dependents rewired, original archived `superseded`), and an
// explicit `HumanConfirmationRequiredError` before a both-sides conflict node
// may integrate. An audit established that every file under `engine/**` is
// imported only by its own tests and the barrel export -- none of it runs.
//
// Its MECHANISM is superseded here; its RULE is adopted whole. The mechanism
// cannot be switched on, for a reason that is architectural rather than a
// matter of effort: `engine/integration.ts` does `git worktree add` and `git
// merge` in a `LocalGitRepo` on the machine running the server. In V2 the
// server has no repository. The code lives on the user's laptop behind a
// `local_runner` binding, or inside an ephemeral GitHub Actions job, and the
// relay's entire relationship with it is a signed WebSocket and a `commit_sha`
// string. Adapting `integrateBranch()` would mean giving the relay a checkout
// of every user's repository -- a far larger change to the trust boundary than
// this phase is entitled to make, and one that ADR-006 (the GitHub App private
// key never leaves the server; the server never holds user code) argues
// against on its own terms.
//
// So: no merge is attempted, anywhere, by anything. That is not a gap to be
// filled later -- it is the strongest possible form of "never silently resolve
// a conflict", because there is no resolution code path to accidentally reach.
// What this module adds is the part the relay CAN honestly do: notice that two
// sibling runs have produced work that a human must reconcile, say so in a
// durable, auditable row, and refuse to let the phase quietly close over it.
//
// TWO LAYERS
// ==========
//
// 1. PREVENTIVE (cheap, precise, opt-in) -- `Phase4Coordinator.schedule()`
//    already refuses to dispatch a task whose `task_coordination_constraints.
//    conflict_keys` intersect an active sibling's, deferring it until the
//    sibling finishes. Two tasks that declare overlapping file scope therefore
//    never run concurrently and never produce a conflict at all.
//
//    E12's audit found that gate has never fired: THE TABLE HAS TWO READERS
//    AND ZERO WRITERS. Nothing in this codebase has ever inserted a row. The
//    mutual exclusion was real code over permanently empty data --
//    structurally the same class of dead path the mocks in this repo have
//    concealed five times. `TaskConflictScopeRepository` below is the missing
//    writer.
//
// 2. DETECTIVE (fail-closed, always on) -- because layer 1 only protects tasks
//    whose scope somebody actually declared, and today nobody does. When a
//    second run in a phase publishes a branch off the same base revision as an
//    unintegrated sibling, this module records a conflict CANDIDATE unless
//    both tasks declared scopes that provably do not intersect.
//
//    Undeclared scope means unproven disjointness, and unproven disjointness
//    is treated as conflict. That is deliberately pessimistic and will produce
//    false positives on genuinely independent work. The asymmetry justifies
//    it: a false positive costs a human one glance and one click to dismiss; a
//    false negative costs them a repository merged wrong by a machine that was
//    guessing. Declaring scope (layer 1) is what buys the precision back, and
//    it buys it in the right direction -- by preventing the conflict rather
//    than by lowering the alarm.
//
// WHAT NORNS NEVER CLAIMS
// =======================
//
// A row here does NOT mean git would conflict. The relay cannot know that; it
// has no trees to merge. It means "these two branches came off the same commit
// and Norns cannot prove they are disjoint" -- which is exactly the fact a
// human needs in order to decide, and no more than the relay actually knows.
// The wording carried to the UI says that in those terms rather than asserting
// a merge conflict that may not exist.
import type { V2ActorT } from "@norns/contracts";
import { z } from "zod";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

/**
 * The body of `POST /api/v2/run-conflicts/:conflictId/resolve`.
 *
 * Deliberately server-local rather than added to `@norns/contracts`: it is a
 * request shape for one HTTP route, not a protocol message crossing the
 * relay/runner boundary, and E12's contract budget is better spent on nothing
 * at all. Add it to contracts if and when a non-web client needs it.
 *
 * There is no `resolution: "auto"`. Every accepted value describes something a
 * HUMAN did, which is the point.
 */
export const RunConflictResolutionRequest = z
  .object({
    resolution: z.enum(["merged_manually", "superseded", "not_a_conflict"]),
    note: z.string().max(4_000).nullable().optional(),
  })
  .strict();
export type RunConflictResolutionRequestT = z.infer<typeof RunConflictResolutionRequest>;

export class RunIntegrationConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunIntegrationConflictError";
  }
}

export type ConflictDetectionBasis = "declared_scope_overlap" | "undeclared_scope";
export type ConflictResolution = "merged_manually" | "superseded" | "not_a_conflict";

export interface RunIntegrationConflict {
  id: string;
  project_id: string;
  phase_id: string;
  run_id: string;
  task_id: string;
  task_title: string;
  branch: string;
  commit_sha: string;
  counterpart_run_id: string;
  counterpart_task_id: string;
  counterpart_task_title: string;
  counterpart_branch: string;
  counterpart_commit_sha: string;
  base_revision: string;
  detection_basis: ConflictDetectionBasis;
  overlap_keys: string[];
  status: "awaiting_human" | "resolved" | "dismissed";
  resolution: ConflictResolution | null;
  resolution_note: string | null;
  detected_at: string;
  resolved_at: string | null;
  /** Plain-language statement of what Norns actually observed, and of what it
   *  is NOT claiming. Rendered verbatim; never summarised into "conflict". */
  summary: string;
}

/** Task states in which a run's published work is still unintegrated. Once a
 *  task is `completed`, `Phase4CompletionService` has been handed integration
 *  evidence, so the branch is somebody's problem no longer. */
const UNINTEGRATED_TASK_STATES = [
  "pending",
  "ready",
  "assigned",
  "in_progress",
  "verifying",
  "in_review",
  "blocked",
  "failed",
];

interface DeclaredScope {
  keys: Set<string>;
  declared: boolean;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function loadDeclaredScopes(
  sql: V2SqlExecutor,
  taskIds: readonly string[],
): Promise<Map<string, DeclaredScope>> {
  const scopes = new Map<string, DeclaredScope>();
  if (taskIds.length === 0) return scopes;
  const placeholders = taskIds.map((_, index) => `$${index + 1}`).join(",");
  const rows = await sql.query<{
    task_id: string;
    conflict_keys: unknown;
    conflict_scope_declared: boolean;
  }>(
    `SELECT task_id, conflict_keys, conflict_scope_declared
       FROM task_coordination_constraints WHERE task_id IN (${placeholders})`,
    [...taskIds],
  );
  for (const row of rows.rows) {
    scopes.set(row.task_id, {
      keys: new Set(stringArray(row.conflict_keys)),
      declared: row.conflict_scope_declared === true,
    });
  }
  return scopes;
}

/**
 * The writer `task_coordination_constraints` never had.
 *
 * Declaring a task's file scope is what turns E12's pessimistic detective
 * layer back into precise, preventive mutual exclusion -- so this is the seam
 * a planner (or a human, or a later phase) uses to buy real parallelism.
 * `keys` are opaque strings compared for exact equality by the dispatch gate:
 * path prefixes like `apps/server/src/coordinator/` are the intended use, but
 * nothing here interprets them, so any agreed vocabulary works.
 *
 * An EMPTY `keys` array is a meaningful, provable claim -- "this task touches
 * no shared scope" -- and is recorded as declared. That is why the migration
 * adds `conflict_scope_declared` rather than treating `conflict_keys = []` as
 * the absence of a declaration: the old column could not tell "nothing to
 * declare" apart from "nobody declared", and those must fail in opposite
 * directions.
 */
export class TaskConflictScopeRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async declare(input: {
    task_id: string;
    project_id: string;
    phase_id: string;
    conflict_keys: readonly string[];
  }): Promise<void> {
    const keys = [...new Set(input.conflict_keys.filter((key) => key.trim().length > 0))].sort();
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO task_coordination_constraints
           (task_id, project_id, phase_id, conflict_keys, conflict_scope_declared)
         VALUES ($1,$2,$3,$4::jsonb,true)
         ON CONFLICT (task_id) DO UPDATE SET
           conflict_keys = EXCLUDED.conflict_keys,
           conflict_scope_declared = true`,
        [input.task_id, input.project_id, input.phase_id, JSON.stringify(keys)],
      );
    });
  }

  async read(taskId: string): Promise<{ conflict_keys: string[]; declared: boolean } | null> {
    return this.transactions.transaction(async (sql) => {
      const scopes = await loadDeclaredScopes(sql, [taskId]);
      const scope = scopes.get(taskId);
      return scope ? { conflict_keys: [...scope.keys].sort(), declared: scope.declared } : null;
    });
  }
}

function conflictSummary(input: {
  basis: ConflictDetectionBasis;
  overlapKeys: string[];
  branch: string;
  counterpartBranch: string;
  base: string;
}): string {
  const pair = `\`${input.branch}\` and \`${input.counterpartBranch}\` were both produced from base revision ${input.base} and neither has been integrated`;
  if (input.basis === "declared_scope_overlap") {
    return `${pair}. Their tasks declared overlapping file scope (${input.overlapKeys.join(", ")}), so they are expected to touch the same code. Norns has not attempted a merge and never will — review both branches and reconcile them yourself, then record what you did.`;
  }
  return `${pair}. Neither task declared a file scope, so Norns cannot prove they are independent and is assuming they are not. Norns has not attempted a merge and never will — check whether these branches actually overlap. If they do not, dismiss this as "not a conflict"; if they do, reconcile them yourself and record what you did.`;
}

/**
 * Detection, insertion, reading and human resolution of integration conflicts.
 *
 * `detect()` takes a live `V2SqlExecutor` rather than opening its own
 * transaction so it can run INSIDE `Phase4EventProcessor.apply()`, in the same
 * transaction that records the publication. That matters: a conflict must
 * become visible atomically with the fact that created it, or a crash between
 * the two leaves a published branch nobody was warned about.
 */
export class RunIntegrationConflictService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  /**
   * Called when `run_id` has just reported a publication. Records a candidate
   * against every unintegrated sibling in the same phase that published from
   * the same base revision, unless both sides declared provably disjoint
   * scope. Idempotent: re-running it (event replay, restart mid-scan, manual
   * re-scan) never produces a second row for the same pair.
   */
  static async detect(sql: V2SqlExecutor, runId: string): Promise<string[]> {
    const self = await sql.query<{
      project_id: string;
      phase_id: string;
      task_id: string;
      task_state: string;
      branch: string | null;
      commit_sha: string | null;
      base_revision: string | null;
    }>(
      `SELECT run.project_id, run.phase_id, run.task_id, task.state AS task_state,
              run.published_branch AS branch, run.published_commit_sha AS commit_sha,
              run.expected_revision AS base_revision
         FROM agent_runs run JOIN tasks task ON task.id = run.task_id
        WHERE run.id = $1`,
      [runId],
    );
    const run = self.rows[0];
    if (!run?.branch || !run.commit_sha || !run.base_revision) return [];
    // A run whose task is already completed/cancelled has been integrated (or
    // abandoned) and is nobody's merge problem.
    if (!UNINTEGRATED_TASK_STATES.includes(run.task_state)) return [];

    const states = UNINTEGRATED_TASK_STATES.map((_, index) => `$${index + 4}`).join(",");
    const siblings = await sql.query<{
      run_id: string;
      task_id: string;
      branch: string;
      commit_sha: string;
    }>(
      `SELECT run.id AS run_id, run.task_id,
              run.published_branch AS branch, run.published_commit_sha AS commit_sha
         FROM agent_runs run JOIN tasks task ON task.id = run.task_id
        WHERE run.phase_id = $1
          AND run.id <> $2
          AND run.task_id <> $3
          AND run.published_branch IS NOT NULL
          AND run.published_commit_sha IS NOT NULL
          AND run.expected_revision = (SELECT expected_revision FROM agent_runs WHERE id = $2)
          AND task.state IN (${states})
        ORDER BY run.published_at ASC NULLS LAST, run.id ASC`,
      [run.phase_id, runId, run.task_id, ...UNINTEGRATED_TASK_STATES],
    );
    if (siblings.rows.length === 0) return [];

    const scopes = await loadDeclaredScopes(sql, [
      run.task_id,
      ...siblings.rows.map((row) => row.task_id),
    ]);
    const own = scopes.get(run.task_id);
    const created: string[] = [];

    for (const sibling of siblings.rows) {
      const other = scopes.get(sibling.task_id);
      let basis: ConflictDetectionBasis;
      let overlapKeys: string[] = [];
      if (own?.declared && other?.declared) {
        overlapKeys = [...own.keys].filter((key) => other.keys.has(key)).sort();
        // BOTH sides made a checkable claim and the claims do not intersect.
        // This is the ONLY path on which E12 stays silent, and it is silent
        // because somebody proved it safe, not because nothing was checked.
        if (overlapKeys.length === 0) continue;
        basis = "declared_scope_overlap";
      } else {
        basis = "undeclared_scope";
      }

      // A pair, not an ordered pair: if this conflict was already recorded
      // with the sides the other way round (the sibling published second on an
      // earlier pass, then this run re-published), it is the SAME thing for a
      // human to resolve and must not be duplicated.
      const existing = await sql.query<{ id: string }>(
        `SELECT id FROM run_integration_conflicts
          WHERE (run_id = $1 AND counterpart_run_id = $2)
             OR (run_id = $2 AND counterpart_run_id = $1)
          LIMIT 1`,
        [runId, sibling.run_id],
      );
      if (existing.rows.length > 0) continue;

      const id = `run-conflict:${runId}:${sibling.run_id}`;
      await sql.query(
        `INSERT INTO run_integration_conflicts (
           id, project_id, phase_id, run_id, task_id, branch, commit_sha,
           counterpart_run_id, counterpart_task_id, counterpart_branch,
           counterpart_commit_sha, base_revision, detection_basis, overlap_keys,
           status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'awaiting_human')
         ON CONFLICT (run_id, counterpart_run_id) DO NOTHING`,
        [
          id,
          run.project_id,
          run.phase_id,
          runId,
          run.task_id,
          run.branch,
          run.commit_sha,
          sibling.run_id,
          sibling.task_id,
          sibling.branch,
          sibling.commit_sha,
          run.base_revision,
          basis,
          JSON.stringify(overlapKeys),
        ],
      );
      created.push(id);
    }
    return created;
  }

  /** Every conflict in a phase, newest first. `open_only` backs the badge. */
  async listForPhase(
    phaseId: string,
    options: { open_only?: boolean } = {},
  ): Promise<RunIntegrationConflict[]> {
    return this.transactions.transaction(async (sql) => {
      const rows = await sql.query<Record<string, unknown>>(
        `SELECT conflict.*, task.title AS task_title,
                counterpart_task.title AS counterpart_task_title
           FROM run_integration_conflicts conflict
           JOIN tasks task ON task.id = conflict.task_id
           JOIN tasks counterpart_task ON counterpart_task.id = conflict.counterpart_task_id
          WHERE conflict.phase_id = $1
            AND ($2::boolean IS NOT TRUE OR conflict.status = 'awaiting_human')
          ORDER BY conflict.detected_at DESC, conflict.id DESC`,
        [phaseId, options.open_only === true],
      );
      return rows.rows.map((row) => hydrate(row));
    });
  }

  async openCountForTask(taskId: string): Promise<number> {
    return this.transactions.transaction(async (sql) => {
      const rows = await sql.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM run_integration_conflicts
          WHERE status = 'awaiting_human' AND (task_id = $1 OR counterpart_task_id = $1)`,
        [taskId],
      );
      return rows.rows[0]?.count ?? 0;
    });
  }

  /**
   * The human's side of the gate. There is no automatic counterpart to this
   * method anywhere in the codebase: a conflict leaves `awaiting_human` only
   * because a named actor said what they did about it.
   *
   * `not_a_conflict` is a `dismissed`, not a `resolved` -- the distinction is
   * kept because "I looked and these are independent" and "I merged them" are
   * different claims and an audit should be able to tell them apart.
   */
  async resolve(input: {
    conflict_id: string;
    resolution: ConflictResolution;
    note: string | null;
    actor: V2ActorT;
    resolved_at: string;
  }): Promise<RunIntegrationConflict> {
    if (!input.actor.actor_id) {
      throw new RunIntegrationConflictError(
        "unattributable_resolution",
        "resolving an integration conflict must be attributable to an actor",
      );
    }
    return this.transactions.transaction(async (sql) => {
      const current = await sql.query<{ status: string }>(
        "SELECT status FROM run_integration_conflicts WHERE id = $1 FOR UPDATE",
        [input.conflict_id],
      );
      const status = current.rows[0]?.status;
      if (!status) {
        throw new RunIntegrationConflictError(
          "conflict_not_found",
          `integration conflict ${input.conflict_id} does not exist`,
        );
      }
      if (status !== "awaiting_human") {
        throw new RunIntegrationConflictError(
          "conflict_already_resolved",
          `integration conflict ${input.conflict_id} is already ${status}`,
        );
      }
      await sql.query(
        `UPDATE run_integration_conflicts
            SET status = $2, resolution = $3, resolution_note = $4,
                resolved_by_actor_type = $5, resolved_by_actor_id = $6,
                resolved_at = $7
          WHERE id = $1`,
        [
          input.conflict_id,
          input.resolution === "not_a_conflict" ? "dismissed" : "resolved",
          input.resolution,
          input.note,
          input.actor.actor_type,
          input.actor.actor_id,
          input.resolved_at,
        ],
      );
      const rows = await sql.query<Record<string, unknown>>(
        `SELECT conflict.*, task.title AS task_title,
                counterpart_task.title AS counterpart_task_title
           FROM run_integration_conflicts conflict
           JOIN tasks task ON task.id = conflict.task_id
           JOIN tasks counterpart_task ON counterpart_task.id = conflict.counterpart_task_id
          WHERE conflict.id = $1`,
        [input.conflict_id],
      );
      const row = rows.rows[0];
      if (!row) {
        throw new RunIntegrationConflictError(
          "conflict_not_found",
          `integration conflict ${input.conflict_id} disappeared during resolution`,
        );
      }
      return hydrate(row);
    });
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function hydrate(row: Record<string, unknown>): RunIntegrationConflict {
  const basis = text(row.detection_basis) as ConflictDetectionBasis;
  const overlapKeys = stringArray(row.overlap_keys);
  const detectedAt = row.detected_at;
  const resolvedAt = row.resolved_at;
  return {
    id: text(row.id),
    project_id: text(row.project_id),
    phase_id: text(row.phase_id),
    run_id: text(row.run_id),
    task_id: text(row.task_id),
    task_title: text(row.task_title),
    branch: text(row.branch),
    commit_sha: text(row.commit_sha),
    counterpart_run_id: text(row.counterpart_run_id),
    counterpart_task_id: text(row.counterpart_task_id),
    counterpart_task_title: text(row.counterpart_task_title),
    counterpart_branch: text(row.counterpart_branch),
    counterpart_commit_sha: text(row.counterpart_commit_sha),
    base_revision: text(row.base_revision),
    detection_basis: basis,
    overlap_keys: overlapKeys,
    status: text(row.status) as RunIntegrationConflict["status"],
    resolution: (row.resolution ?? null) as ConflictResolution | null,
    resolution_note: (row.resolution_note ?? null) as string | null,
    detected_at: detectedAt instanceof Date ? detectedAt.toISOString() : text(detectedAt),
    resolved_at:
      resolvedAt == null
        ? null
        : resolvedAt instanceof Date
          ? resolvedAt.toISOString()
          : text(resolvedAt),
    summary: conflictSummary({
      basis,
      overlapKeys,
      branch: text(row.branch),
      counterpartBranch: text(row.counterpart_branch),
      base: text(row.base_revision),
    }),
  };
}
