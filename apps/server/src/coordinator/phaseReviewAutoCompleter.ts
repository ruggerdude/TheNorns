// EXEC-REVIEW-1 — advance a phase on green, with no independent reviewer.
//
// A development run that verifies green parks its task at `in_review`, waiting
// for an independent reviewer to move it to `completed`. That reviewer stage
// was never built (no worker writes `agent_reviews`), so every succeeded task
// hung there forever and its dependents never dispatched — the phase looked
// "done" in the UI but never advanced. Foundation had to be completed by hand
// through the operator complete route on every phase.
//
// The product decision (David, 2026-08-19): there is no reviewer between
// phases. Green verification IS the bar. This sweep is the operator's manual
// completion, automated: for every task sitting at `in_review` whose
// designated run succeeded with passed verification and no unresolved
// integration conflict, it synthesises the same evidence the operator supplied
// (a review waiver bound to the exact verification result + commit, and the
// run's verified/published commit) and drives the EXISTING `Phase4CompletionService`
// — the one proven path to `completed`. Nothing here reimplements completion,
// weakens the conflict gate, or merges anything.
//
// Why a poll, not a hook (identical reasoning to PhaseQueueDrainer): a task
// reaches a completable state on several paths, not all of which emit an event
// (a recovery monitor settles a stale run, the server restarts holding the
// state). A poll cannot miss a transition it never saw. Once a predecessor is
// `completed`, the phase-queue drainer's next tick dispatches its dependents,
// so phases advance without any further wiring.
import { type V2ActorT, V2EvidenceRef, type V2EvidenceRefT } from "@norns/contracts";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { Phase4CompletionConflictError, type Phase4CompletionService } from "./phase4Completion.js";

export const PHASE_REVIEW_AUTO_COMPLETER_ACTOR: V2ActorT = {
  actor_type: "coordinator",
  actor_id: "system:phase-review-auto-completer",
};

export interface PhaseReviewAutoCompleteOutcome {
  project_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  phase_closed: boolean;
}

export interface PhaseReviewAutoCompleterOptions {
  now?: () => Date;
  /** Surfaced so an operator sees a completion that keeps failing rather than a
   *  task that silently sticks at in_review. One task's failure never stops the
   *  next task from being swept. */
  onError?: (taskId: string, error: unknown) => void;
}

interface CandidateRow {
  project_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  verification_id: string;
  verification_commit: string;
  published_commit: string;
}

export class PhaseReviewAutoCompleter {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly completion: Phase4CompletionService,
    private readonly options: PhaseReviewAutoCompleterOptions = {},
  ) {}

  /**
   * Every task at `in_review` whose DESIGNATED run succeeded with passed
   * verification, published its work, and carries no `awaiting_human`
   * integration conflict. Keying integration evidence off the run's published
   * commit (not a handoff row) matches what the operator supplied by hand — a
   * planned phase run is not guaranteed to leave a completed handoff, so a
   * handoff join would silently skip every phase task. The conflict clause
   * matters: a task with an open conflict must wait for a human to reconcile
   * the branches, and `Phase4CompletionService` would refuse it anyway —
   * filtering it here keeps the sweep from churning on a task it can never
   * complete.
   */
  private async candidates(): Promise<CandidateRow[]> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<CandidateRow>(
        `SELECT DISTINCT ON (task.id)
                task.project_id, task.phase_id, task.id AS task_id,
                run.id AS run_id,
                verification.id AS verification_id,
                verification.commit_sha AS verification_commit,
                run.published_commit_sha AS published_commit
           FROM tasks task
           JOIN agent_runs run ON run.id = task.designated_run_id
           JOIN verification_results verification
             ON verification.run_id = run.id AND verification.passed = true
          WHERE task.state = 'in_review'
            AND run.state = 'succeeded'
            AND run.verification_status = 'passed'
            AND run.published_commit_sha IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM run_integration_conflicts conflict
               WHERE conflict.status = 'awaiting_human'
                 AND (conflict.task_id = task.id OR conflict.counterpart_task_id = task.id)
            )
          ORDER BY task.id, verification.created_at DESC`,
      );
      return result.rows;
    });
  }

  /** One pass. Each task is completed independently; one failure is reported
   *  and the next task is still attempted. */
  async sweep(): Promise<PhaseReviewAutoCompleteOutcome[]> {
    const now = this.options.now ?? (() => new Date());
    const outcomes: PhaseReviewAutoCompleteOutcome[] = [];
    for (const candidate of await this.candidates()) {
      const completedAt = now().toISOString();
      const reviewEvidence: V2EvidenceRefT[] = [
        V2EvidenceRef.parse({
          artifact_id: `review-waived:${candidate.run_id}`,
          content_hash: canonicalSha256({
            policy: "no-review-between-phases",
            reviewer_agent_profile_id: null,
            verification_result_id: candidate.verification_id,
            commit: candidate.verification_commit,
          }),
          media_type: "application/vnd.norns.review-waiver+json",
          label: "Phase completed on green verification; independent review is disabled",
        }),
      ];
      const integrationEvidence: V2EvidenceRefT[] = [
        V2EvidenceRef.parse({
          artifact_id: `published-commit:${candidate.run_id}`,
          content_hash: canonicalSha256({
            run_id: candidate.run_id,
            published_commit: candidate.published_commit,
            verification_result_id: candidate.verification_id,
          }),
          media_type: "application/vnd.norns.published-commit+json",
          label: `Verified and published commit ${candidate.published_commit}`,
        }),
      ];
      try {
        const result = await this.completion.complete({
          project_id: candidate.project_id,
          phase_id: candidate.phase_id,
          task_id: candidate.task_id,
          run_id: candidate.run_id,
          actor: PHASE_REVIEW_AUTO_COMPLETER_ACTOR,
          correlation_id: `auto-review:${candidate.run_id}`,
          review_evidence: reviewEvidence,
          integration_evidence: integrationEvidence,
          review_summary: `Auto-completed after green verification at ${candidate.verification_commit}; independent review is disabled for this project.`,
          completed_at: completedAt,
        });
        outcomes.push({
          project_id: candidate.project_id,
          phase_id: candidate.phase_id,
          task_id: candidate.task_id,
          run_id: candidate.run_id,
          phase_closed: result.phase_closed,
        });
      } catch (error) {
        // A conflict here means the task stopped being completable between the
        // candidate query and the completion (a race with the operator route,
        // or a conflict opened in the gap). Ordinary; the next sweep re-derives
        // the candidate set. Anything else is reported.
        if (!(error instanceof Phase4CompletionConflictError)) {
          this.options.onError?.(candidate.task_id, error);
        }
      }
    }
    return outcomes;
  }
}
