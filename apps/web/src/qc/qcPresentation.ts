import type { V2ConversationPlanReviewFindingT, V2ConversationPlanReviewT } from "@norns/contracts";

export type ReviewLiveProgress = {
  stage:
    | "preparing"
    | "generating"
    | "reviewing"
    | "revising"
    | "repairing"
    | "validating"
    | "saving";
  round: number | null;
  attempt: number;
  provider: "anthropic" | "openai" | null;
  model: string | null;
  started_at: string;
  checkpoint_at: string;
};

const LIVE_STAGE_LABELS: Record<ReviewLiveProgress["stage"], string> = {
  preparing: "Preparing",
  generating: "Generating",
  reviewing: "Reviewing",
  revising: "Revising",
  repairing: "Repairing",
  validating: "Validating",
  saving: "Saving",
};

export function reviewLiveProgress(review: V2ConversationPlanReviewT): ReviewLiveProgress | null {
  return (
    (review as V2ConversationPlanReviewT & { live_progress?: ReviewLiveProgress | null })
      .live_progress ?? null
  );
}

function fallbackLivePhase(review: V2ConversationPlanReviewT): string {
  const round = Math.min(review.rounds_completed + 1, review.max_rounds);
  const position = `Round ${round} of ${review.max_rounds}`;
  const last = review.chat_messages.at(-1) ?? null;
  if (review.status === "queued" || !last) return `${position} · waiting to start`;
  const who = last.channel === "reviewer" ? "QC reviewer" : "planning manager";
  if (last.kind === "error") return `${position} · the ${who} request failed`;
  if (last.kind === "repair_reminder") {
    return `${position} · asked the ${who} to correct its format`;
  }
  if (last.kind === "instruction") return `${position} · waiting for the ${who}`;
  return `${position} · ${who} responded`;
}

export function liveProgressLabel(
  review: V2ConversationPlanReviewT,
  progress: ReviewLiveProgress | null,
): string {
  if (!progress) return fallbackLivePhase(review);
  const position =
    progress.round === null ? "QC" : `Round ${progress.round} of ${review.max_rounds}`;
  return `${position} · ${LIVE_STAGE_LABELS[progress.stage]} · Attempt ${progress.attempt}`;
}

export function elapsedLabel(startedAt: string | null, nowMs: number): string | null {
  if (!startedAt) return null;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - startedMs) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function qcStatusTitle(review: V2ConversationPlanReviewT): string {
  if (review.review_mode === "waived") return "QC skipped";
  if (review.status === "queued") return "Quality review is queued";
  if (review.status === "running") return "Quality review is in progress";
  if (review.status === "awaiting_human") return "QC is paused. Your decision is needed.";
  if (review.status === "converged") return "QC passed. The plan is ready for approval.";
  if (review.status === "cap_reached") return "QC finished at the review limit";
  if (review.status === "failed") return "QC could not finish";
  return "Quality review was stopped";
}

export function qcStatusDescription(review: V2ConversationPlanReviewT): string {
  if (review.review_mode === "waived") return "The current plan can move forward by human choice.";
  if (review.status === "queued") {
    return "The plan is waiting for the independent reviewer to begin.";
  }
  if (review.status === "running") {
    return "No action is needed. QC will pause here only if your decision is required.";
  }
  if (review.status === "awaiting_human") {
    if (review.paused_checkpoint === "after_revision") {
      return "The planning manager revised the plan. Review the changes and continue when they look right.";
    }
    if (review.paused_checkpoint === "adjudication") {
      return "The reviewer and planning manager disagree on a blocking issue. Your ruling determines what happens next.";
    }
    return "The reviewer finished this pass. Continue for a revision, add guidance, or choose another path.";
  }
  if (review.status === "converged") {
    return `The review completed successfully after ${review.rounds_completed} round${review.rounds_completed === 1 ? "" : "s"}.`;
  }
  if (review.status === "cap_reached") {
    return `The review used all ${review.max_rounds} rounds. Check the remaining findings before deciding.`;
  }
  if (review.status === "failed") {
    return "The current plan is unchanged. Saved feedback is still available and can be carried into a retry.";
  }
  return "The current plan is unchanged. The reason and retained evidence are available below.";
}

export function qcRemainingEstimate(
  review: V2ConversationPlanReviewT,
  nowMs: number,
): { value: string; detail: string } {
  if (review.review_mode === "waived") {
    return { value: "QC skipped", detail: "No independent review was run" };
  }
  if (["converged", "cap_reached", "failed", "cancelled"].includes(review.status)) {
    const total = elapsedLabel(review.started_at, Date.parse(review.completed_at ?? "") || nowMs);
    return { value: "Finished", detail: total ? `${total} total` : "No work remains" };
  }
  if (review.status === "awaiting_human") {
    return { value: "Paused", detail: "Continues after your decision" };
  }
  const remainingRounds = Math.max(0, review.max_rounds - review.rounds_completed);
  return {
    value: `Up to ${remainingRounds} round${remainingRounds === 1 ? "" : "s"} left`,
    detail: review.status === "queued" ? "Full review budget" : "Includes the round in progress",
  };
}

export function qcNextStep(review: V2ConversationPlanReviewT): { value: string; detail: string } {
  if (review.review_mode === "waived") {
    return { value: "Approve the plan", detail: "QC will remain marked as skipped" };
  }
  if (review.status === "queued" || review.status === "running") {
    return { value: "No action needed", detail: "We’ll pause here if you are needed" };
  }
  if (review.status === "awaiting_human") {
    return review.paused_checkpoint === "adjudication"
      ? { value: "Rule on the conflict", detail: "Then QC can continue" }
      : { value: "Continue the review", detail: "Recommended" };
  }
  if (review.status === "converged" || review.status === "cap_reached") {
    return { value: "Approve or revise", detail: "Implementation has not started" };
  }
  if (review.status === "failed") {
    return { value: "Retry with context", detail: "Recommended recovery" };
  }
  return { value: "Review the stopped run", detail: "Choose a recovery path" };
}

export function qcCurrentOwner(
  review: V2ConversationPlanReviewT,
  progress: ReviewLiveProgress | null,
): { value: string; detail: string } {
  if (review.review_mode === "waived") return { value: "You", detail: "QC was skipped" };
  if (review.status === "awaiting_human") return { value: "You", detail: "QC is paused" };
  if (["converged", "cap_reached", "failed", "cancelled"].includes(review.status)) {
    return { value: "You", detail: "Run has finished" };
  }
  if (review.status === "queued") return { value: "QC workflow", detail: "Waiting to dispatch" };
  if (progress?.stage === "reviewing") {
    return { value: "Independent reviewer", detail: "Checking the plan" };
  }
  if (progress?.stage === "revising") {
    return { value: "Planning manager", detail: "Revising the plan" };
  }
  if (progress?.stage === "repairing") {
    return { value: progress.provider ?? "Active agent", detail: "Correcting its response" };
  }
  const last = review.chat_messages.at(-1);
  if (last?.channel === "pm") {
    return { value: "Planning manager", detail: "Preparing a response" };
  }
  return { value: "Independent reviewer", detail: "Checking the plan" };
}

export function visibleReviewFindings(
  review: V2ConversationPlanReviewT,
): V2ConversationPlanReviewFindingT[] {
  if (review.findings.length > 0) return review.findings;
  let index = 0;
  return review.round_exchanges.flatMap((exchange) =>
    exchange.reviewer.findings.map((finding) => ({
      ...finding,
      id: `${review.id}:round-${exchange.round}:finding-${index}`,
      index: index++,
      recurs_of_finding_ids: [],
    })),
  );
}

export function qcActiveRound(
  review: V2ConversationPlanReviewT,
  progress: ReviewLiveProgress | null,
): number {
  if (review.status === "awaiting_human" && typeof review.paused_at_round === "number") {
    return Math.max(1, Math.min(review.paused_at_round, review.max_rounds));
  }
  const recordedRound = progress?.round;
  if (recordedRound !== null && recordedRound !== undefined) {
    return Math.max(1, Math.min(recordedRound, review.max_rounds));
  }
  const terminal = ["converged", "cap_reached", "failed", "cancelled"].includes(review.status);
  const inferred = terminal
    ? Math.max(1, review.rounds_completed)
    : Math.max(1, review.rounds_completed + 1);
  return Math.min(inferred, review.max_rounds);
}

export function qcRoundStageTitle(
  review: V2ConversationPlanReviewT,
  progress: ReviewLiveProgress | null,
  owner: { value: string; detail: string },
): string {
  if (review.review_mode === "waived") return "No independent review was run";
  if (["converged", "cap_reached", "failed", "cancelled"].includes(review.status)) {
    return qcStatusTitle(review);
  }
  if (review.status === "awaiting_human") return "Waiting for your decision";
  if (review.status === "queued") return "Waiting to start this round";
  if (!progress) return `${owner.value} is ${owner.detail.toLowerCase()}`;
  if (progress.stage === "reviewing") return "Independent reviewer is checking the plan";
  if (progress.stage === "revising") return "Planning manager is revising the plan";
  if (progress.stage === "repairing") return `${owner.value} is correcting a response`;
  if (progress.stage === "validating") return "QC is validating this round";
  if (progress.stage === "saving") return "QC is saving this round";
  if (progress.stage === "generating") return `${owner.value} is preparing a response`;
  return "QC is preparing this round";
}
