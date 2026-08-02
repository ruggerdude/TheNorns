import type {
  V2ConversationActionT,
  V2ConversationPlanReviewDispositionT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2ConversationUsageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useEffect, useState } from "react";
import { artifactContentPath } from "./ArtifactImage";
import { PlanVersionDiff } from "./ConversationPlanCard";
import { QC_MODE_OPTIONS } from "./Projects";
import type { QcModeT } from "./conversationApi";
import { Badge, Button, Select, TextArea } from "./ui";

const SEVERITIES = [
  { value: "must_fix", label: "Must fix", tone: "danger" },
  { value: "should_fix", label: "Should fix", tone: "warn" },
  { value: "suggestion", label: "Suggestions", tone: "info" },
] as const;

const CHECKPOINT_LABELS: Record<
  NonNullable<V2ConversationPlanReviewT["paused_checkpoint"]>,
  string
> = {
  after_review: "Gate A · after the reviewer pass",
  after_revision: "Gate B · after the PM's revision",
  adjudication: "Gate C · adjudication",
};

/** The interim plan version materialized at Gate B (origin "qc_interim"),
 *  so the gate card can diff v(n) -> v(n+1). Prefers the review's own
 *  pointer; falls back to matching the paused round's PM revision hash in
 *  case the server sets `revised_plan_version_id` only at terminal. */
export function findGateInterimVersion(
  review: V2ConversationPlanReviewT,
  planVersions: V2WorkPlanVersionT[],
): V2WorkPlanVersionT | null {
  if (review.paused_checkpoint !== "after_revision") return null;
  const pointer = review.revised_plan_version_id;
  const byPointer = pointer
    ? (planVersions.find((version) => version.id === pointer && version.origin === "qc_interim") ??
      null)
    : null;
  if (byPointer) return byPointer;
  const hash =
    review.round_exchanges.find((exchange) => exchange.round === review.paused_at_round)?.pm
      ?.revised_plan_content_hash ?? null;
  if (!hash) return null;
  return (
    planVersions.find(
      (version) => version.origin === "qc_interim" && version.content_hash === hash,
    ) ?? null
  );
}

/** Cumulative spend already computed for this conversation (QC's own usage
 *  events included — see the server's per-review usage aggregation) — reused
 *  here rather than recomputed. Only "exact" usage ever carries a cost (see
 *  V2ConversationUsage's invariant), so pending/unavailable usage shows
 *  nothing rather than a misleading number. */
function formatGateSpend(usage: V2ConversationUsageT): string | null {
  if (usage.usage_status !== "exact" || usage.cost_usd === null) return null;
  return `$${usage.cost_usd.toFixed(2)} spent on this conversation so far`;
}

function failureLabel(code: string | null): string {
  switch (code) {
    case "invalid_response":
      return "an agent could not produce a complete applicable QC result after the reminder";
    case "auth":
      return "the provider rejected its credentials";
    case "rate_limit":
      return "the provider rate limit was reached";
    case "overloaded":
      return "the provider was overloaded";
    case "network":
      return "the provider connection failed";
    case "server":
      return "the provider returned a server error";
    case "cancelled":
      return "the provider request was cancelled";
    case "adaptererror":
      return "a provider response failed before detailed error categories were recorded";
    default:
      return code ? code.replaceAll("_", " ") : "the review could not complete";
  }
}

type ReviewLiveProgress = {
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

function reviewLiveProgress(review: V2ConversationPlanReviewT): ReviewLiveProgress | null {
  return (
    (review as V2ConversationPlanReviewT & { live_progress?: ReviewLiveProgress | null })
      .live_progress ?? null
  );
}

// Historical attempts predate durable live progress. Keep the old event-based
// description as a truthful fallback for those records and rolling deploys.
function fallbackLivePhase(review: V2ConversationPlanReviewT): string {
  const round = Math.min(review.rounds_completed + 1, review.max_rounds);
  const position = `Round ${round} of ${review.max_rounds}`;
  const last = review.chat_messages.at(-1) ?? null;
  if (review.status === "queued" || !last) return `${position} · waiting to start`;
  const who = last.channel === "reviewer" ? "QC reviewer" : "planning manager";
  if (last.kind === "error") return `${position} · the ${who} request failed`;
  if (last.kind === "repair_reminder")
    return `${position} · asked the ${who} to correct its format`;
  if (last.kind === "instruction") return `${position} · waiting for the ${who}`;
  return `${position} · ${who} responded`;
}

function liveProgressLabel(
  review: V2ConversationPlanReviewT,
  progress: ReviewLiveProgress | null,
): string {
  if (!progress) return fallbackLivePhase(review);
  const position =
    progress.round === null ? "QC" : `Round ${progress.round} of ${review.max_rounds}`;
  return `${position} · ${LIVE_STAGE_LABELS[progress.stage]} · Attempt ${progress.attempt}`;
}

function elapsedLabel(startedAt: string | null, nowMs: number): string | null {
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

function useProgressClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return nowMs;
}

function qcStatusTitle(review: V2ConversationPlanReviewT): string {
  if (review.review_mode === "waived") return "QC skipped";
  if (review.status === "queued") return "Quality review is queued";
  if (review.status === "running") return "Quality review is in progress";
  if (review.status === "awaiting_human") return "QC is paused. Your decision is needed.";
  if (review.status === "converged") return "QC passed. The plan is ready for approval.";
  if (review.status === "cap_reached") return "QC finished at the review limit";
  if (review.status === "failed") return "QC could not finish";
  return "Quality review was stopped";
}

function qcStatusDescription(review: V2ConversationPlanReviewT): string {
  if (review.review_mode === "waived") {
    return "The current plan can move forward by human choice.";
  }
  if (review.status === "queued")
    return "The plan is waiting for the independent reviewer to begin.";
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

function qcRemainingEstimate(
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
  const roundLabel = `Up to ${remainingRounds} round${remainingRounds === 1 ? "" : "s"} left`;
  return {
    value: roundLabel,
    detail: review.status === "queued" ? "Full review budget" : "Includes the round in progress",
  };
}

function qcNextStep(review: V2ConversationPlanReviewT): { value: string; detail: string } {
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

function qcCurrentOwner(
  review: V2ConversationPlanReviewT,
  progress: ReviewLiveProgress | null,
): { value: string; detail: string } {
  if (review.review_mode === "waived") return { value: "You", detail: "QC was skipped" };
  if (review.status === "awaiting_human") return { value: "You", detail: "QC is paused" };
  if (["converged", "cap_reached", "failed", "cancelled"].includes(review.status)) {
    return { value: "You", detail: "Run has finished" };
  }
  if (review.status === "queued") return { value: "QC workflow", detail: "Waiting to dispatch" };
  if (progress?.stage === "reviewing")
    return { value: "Independent reviewer", detail: "Checking the plan" };
  if (progress?.stage === "revising")
    return { value: "Planning manager", detail: "Revising the plan" };
  if (progress?.stage === "repairing") {
    return { value: progress.provider ?? "Active agent", detail: "Correcting its response" };
  }
  const last = review.chat_messages.at(-1);
  if (last?.channel === "pm") return { value: "Planning manager", detail: "Preparing a response" };
  return { value: "Independent reviewer", detail: "Checking the plan" };
}

function Finding({
  finding,
  review,
  onDiscuss,
}: {
  finding: V2ConversationPlanReviewFindingT;
  review: V2ConversationPlanReviewT;
  onDiscuss?: (finding: V2ConversationPlanReviewFindingT) => void;
}): React.ReactElement {
  const disposition = review.dispositions.find(
    (candidate) => candidate.finding_id === finding.id && candidate.finding_index === finding.index,
  );
  return (
    <li className="conversation-qc-finding">
      <div>
        <strong>{finding.finding}</strong>
        {finding.module_id ? <code>Task · {finding.module_id}</code> : <code>Plan level</code>}
      </div>
      <p>
        <strong>Reviewer recommendation:</strong> {finding.recommendation}
      </p>
      {disposition ? (
        <div className="conversation-qc-disposition">
          <Badge tone={disposition.disposition === "accept" ? "success" : "warn"}>
            PM {disposition.disposition}
          </Badge>
          <p>{disposition.rationale}</p>
        </div>
      ) : (
        <p className="conversation-qc-pending-disposition">Awaiting PM disposition.</p>
      )}
      {onDiscuss ? (
        <Button
          className="btn-small conversation-qc-discuss-button"
          onClick={() => onDiscuss(finding)}
        >
          Discuss in Plan
        </Button>
      ) : null}
    </li>
  );
}

function QcDetailedStatus({ review }: { review: V2ConversationPlanReviewT }): React.ReactElement {
  const events = review.chat_messages;
  return (
    <section className="conversation-qc-detailed-status" aria-label="Detailed QC status">
      <div>
        <h4>Detailed status</h4>
        <Badge tone={review.status === "failed" ? "danger" : "info"}>{events.length} events</Badge>
      </div>
      {events.length > 0 ? (
        <ol aria-live="polite">
          {events.map((event) => (
            <li key={event.id} className={event.error_code ? "is-error" : undefined}>
              <span aria-hidden="true" />
              <div>
                <strong>
                  Round {event.round} ·{" "}
                  {event.channel === "reviewer" ? "Reviewer" : "Planning manager"}
                  {event.attempt > 1 ? ` · Attempt ${event.attempt}` : ""}
                </strong>
                <small>
                  {event.kind === "instruction"
                    ? event.speaker === "human"
                      ? "Human guidance sent"
                      : "Request sent"
                    : event.kind === "repair_reminder"
                      ? "Formatting reminder sent"
                      : event.kind === "error"
                        ? `Request failed${event.error_code ? ` · ${event.error_code}` : ""}`
                        : event.error_code
                          ? `Response preserved but not applicable · ${event.error_code}`
                          : "Response received and Markdown saved"}
                  {" · "}
                  {new Date(event.created_at).toLocaleString()}
                </small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p>
          {review.round_exchanges.length > 0
            ? "This historical attempt retained its round results, but raw event-level status was not recorded yet."
            : "Waiting for the first QC request to be recorded."}
        </p>
      )}
    </section>
  );
}

function QcFindings({
  review,
  onDiscussFinding,
}: {
  review: V2ConversationPlanReviewT;
  onDiscussFinding?: (finding: V2ConversationPlanReviewFindingT) => void;
}): React.ReactElement | null {
  if (review.findings.length === 0) return null;
  return (
    <section className="conversation-qc-findings" aria-label="Suggested revisions">
      <header>
        <div>
          <h4>Suggested revisions</h4>
          <p>Review the QC feedback and recommendation before choosing what happens next.</p>
        </div>
        <Badge tone="warn">{review.findings.length} findings</Badge>
      </header>
      {SEVERITIES.map((severity) => {
        const findings = review.findings.filter((finding) => finding.severity === severity.value);
        if (findings.length === 0) return null;
        return (
          <section
            className={`conversation-qc-group is-${severity.value}`}
            key={severity.value}
            aria-labelledby={`${review.id}-${severity.value}`}
          >
            <div>
              <h4 id={`${review.id}-${severity.value}`}>{severity.label}</h4>
              <Badge tone={severity.tone}>{findings.length}</Badge>
            </div>
            <ol>
              {findings.map((finding) => (
                <Finding
                  key={finding.id}
                  finding={finding}
                  review={review}
                  onDiscuss={onDiscussFinding}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </section>
  );
}

function visibleReviewFindings(
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

function QcIssueBrief({
  review,
  onDiscussFinding,
}: {
  review: V2ConversationPlanReviewT;
  onDiscussFinding?: (finding: V2ConversationPlanReviewFindingT) => void;
}): React.ReactElement {
  const findings = visibleReviewFindings(review);
  const substantive = findings.filter((finding) => finding.severity !== "suggestion");
  const suggestions = findings.length - substantive.length;
  const resolved = review.dispositions.filter(
    (disposition) => disposition.disposition === "accept" || disposition.adjudication !== null,
  ).length;

  return (
    <section className="conversation-qc-brief" aria-label="Decision brief">
      <header>
        <div>
          <span className="eyebrow">Decision brief</span>
          <h4>
            {findings.length === 0
              ? "No changes requested"
              : `${substantive.length} substantive issue${substantive.length === 1 ? "" : "s"}`}
          </h4>
          <p>
            {findings.length === 0
              ? "The independent reviewer did not identify a revision that blocks this plan."
              : "Scan the issues here. Open one only when you need the reviewer’s recommendation and the planning manager’s response."}
          </p>
        </div>
        {findings.length > 0 ? (
          <dl>
            <div>
              <dt>Resolved</dt>
              <dd>{resolved}</dd>
            </div>
            <div>
              <dt>Suggestions</dt>
              <dd>{suggestions}</dd>
            </div>
          </dl>
        ) : (
          <Badge tone="success">Clear</Badge>
        )}
      </header>
      {findings.length > 0 ? (
        <ol>
          {findings.map((finding) => {
            const disposition = review.dispositions.find(
              (candidate) =>
                candidate.finding_id === finding.id && candidate.finding_index === finding.index,
            );
            return (
              <li key={finding.id}>
                <details>
                  <summary>
                    <Badge
                      tone={
                        finding.severity === "must_fix"
                          ? "danger"
                          : finding.severity === "should_fix"
                            ? "warn"
                            : "info"
                      }
                    >
                      {finding.severity.replaceAll("_", " ")}
                    </Badge>
                    <span>
                      <strong>{finding.finding}</strong>
                      <small>
                        {finding.module_id ? `Task · ${finding.module_id}` : "Plan level"}
                      </small>
                    </span>
                    <span className="conversation-qc-brief-disposition">
                      {disposition
                        ? `PM ${disposition.disposition}`
                        : review.status === "running"
                          ? "Awaiting PM"
                          : "No response"}
                    </span>
                  </summary>
                  <div className="conversation-qc-brief-comparison">
                    <section>
                      <span>Reviewer recommends</span>
                      <p>{finding.recommendation}</p>
                    </section>
                    <section>
                      <span>Planning manager response</span>
                      <p>
                        {disposition?.rationale ?? "No planning manager response was recorded."}
                      </p>
                    </section>
                  </div>
                  {onDiscussFinding ? (
                    <Button className="btn-small" onClick={() => onDiscussFinding(finding)}>
                      Discuss in Plan
                    </Button>
                  ) : null}
                </details>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function qcActiveRound(
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

function qcRoundStageTitle(
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

function QcConversationLog({
  review,
  busy,
  onContinue,
}: {
  review: V2ConversationPlanReviewT;
  busy: boolean;
  onContinue?: (
    review: V2ConversationPlanReviewT,
    channel: "reviewer" | "pm",
    message: string,
  ) => Promise<void>;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [channel, setChannel] = useState<"reviewer" | "pm">("pm");
  const messages = [...review.chat_messages].sort(
    (left, right) =>
      left.round - right.round ||
      left.attempt - right.attempt ||
      Date.parse(left.created_at) - Date.parse(right.created_at),
  );
  const artifacts = review.markdown_artifacts.filter(
    (artifact) => artifact.channel === "reviewer" || artifact.channel === "pm",
  );
  const canMessage =
    (review.status === "failed" || review.status === "awaiting_human") && onContinue;
  return (
    <section className="conversation-qc-conversation" aria-label="Reviewer and PM conversation">
      <header>
        <div>
          <h4>Reviewer ↔ planning manager</h4>
          <p>
            One chronological record of the requests, replies, and handoffs between both agents.
          </p>
        </div>
        <Badge tone="info">{messages.length} messages</Badge>
      </header>
      <div className="conversation-qc-conversation-body">
        {messages.length > 0 ? (
          <ol>
            {messages.map((message) => (
              <li
                key={message.id}
                className={`is-${message.speaker} is-${message.channel}-channel`}
              >
                <header>
                  <div>
                    <strong>
                      {message.speaker === "workflow"
                        ? "QC workflow"
                        : message.speaker === "human"
                          ? "You"
                          : message.speaker === "reviewer"
                            ? "QC reviewer"
                            : "Planning manager"}
                    </strong>
                    <Badge tone={message.channel === "reviewer" ? "warn" : "info"}>
                      {message.channel === "reviewer" ? "Reviewer lane" : "PM lane"}
                    </Badge>
                  </div>
                  <small>
                    Round {message.round} · Attempt {message.attempt} ·{" "}
                    {message.kind.replaceAll("_", " ")} ·{" "}
                    {new Date(message.created_at).toLocaleString()}
                  </small>
                </header>
                <pre>{message.content}</pre>
                {message.error_code ? (
                  <Badge tone="danger">{message.error_code.replaceAll("_", " ")}</Badge>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>No raw messages were captured for this historical attempt.</p>
        )}
        {artifacts.length > 0 ? (
          <details className="conversation-qc-artifacts">
            <summary>Saved Markdown files · {artifacts.length}</summary>
            <ul>
              {artifacts.map((artifact) => (
                <li key={artifact.artifact_id}>
                  <a
                    href={artifactContentPath(review.project_id, artifact.artifact_id)}
                    download={artifact.filename}
                  >
                    {artifact.filename}
                  </a>
                  <small>{artifact.channel === "reviewer" ? "Reviewer" : "Planning manager"}</small>
                  <Badge tone={artifact.valid ? "success" : "warn"}>
                    {artifact.valid ? "applicable" : "partial"}
                  </Badge>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {canMessage ? (
          <details className="conversation-qc-takeover">
            <summary>
              {review.status === "awaiting_human" ? "Ask an agent" : "Guide an agent"}
            </summary>
            <p>
              {review.status === "awaiting_human"
                ? "The reply stays in this record. It does not advance the paused review."
                : "The complete reply will be saved and supplied as context when you retry QC."}
            </p>
            <label htmlFor={`qc-chat-${review.id}-channel`}>Send to</label>
            <Select
              id={`qc-chat-${review.id}-channel`}
              value={channel}
              disabled={busy}
              onChange={(event) => setChannel(event.target.value as "reviewer" | "pm")}
            >
              <option value="pm">Planning manager</option>
              <option value="reviewer">QC reviewer</option>
            </Select>
            <label htmlFor={`qc-chat-${review.id}-message`}>
              {review.status === "awaiting_human" ? "Your question" : "Your guidance"}
            </label>
            <TextArea
              id={`qc-chat-${review.id}-message`}
              value={draft}
              maxLength={4_000}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              disabled={busy || !draft.trim()}
              onClick={() => {
                const message = draft.trim();
                if (!message) return;
                void onContinue(review, channel, message).then(() => setDraft(""));
              }}
            >
              {busy
                ? "Waiting for agent…"
                : review.status === "awaiting_human"
                  ? `Ask the ${channel === "reviewer" ? "reviewer" : "planning manager"}`
                  : `Send to ${channel === "reviewer" ? "reviewer" : "planning manager"}`}
            </Button>
          </details>
        ) : null}
      </div>
    </section>
  );
}

export type Ruling = "reviewer" | "pm" | "supplied_fact";

const RULING_OPTIONS: ReadonlyArray<{ value: Ruling; label: string }> = [
  { value: "reviewer", label: "Rule for reviewer — the finding stands, PM must revise" },
  { value: "pm", label: "Rule for PM — the rebuttal stands, closed as human-dismissed" },
  { value: "supplied_fact", label: "Supply the missing fact — add context and return it" },
];

const CONTEXT_ENTRY_LABELS: Record<string, string> = {
  global_rules: "Global rule",
  project_rules: "Project rule",
  project_knowledge: "Project knowledge",
  decision: "Recorded decision",
  artifact: "Artifact",
};

/** The context manifest — what was actually in the frozen receipt both the
 *  reviewer and the PM read (QC-PAUSE-POINTS.md "The adjudication card").
 *  Neither agent has repository access or a transcript, so when one side
 *  "didn't review the code," this list is where that becomes checkable
 *  instead of a bare claim. */
function ContextManifestSummary({
  review,
}: {
  review: V2ConversationPlanReviewT;
}): React.ReactElement {
  const entries = review.context_manifest.entries;
  return (
    <details
      className="conversation-qc-adjudication-manifest"
      data-testid="conversation-qc-adjudication-manifest"
    >
      <summary>
        Context manifest both agents read
        <Badge tone="info">{entries.length} entries</Badge>
      </summary>
      <p>
        Exact receipt hash{" "}
        <code title={review.context_manifest.context_hash}>
          {review.context_manifest.context_hash.slice(0, 10)}
        </code>
        . Neither agent had repository access beyond what is listed here.
      </p>
      {entries.length > 0 ? (
        <ul>
          {entries.map((entry) => (
            <li key={`${entry.kind}:${entry.ref}`}>
              <Badge>{CONTEXT_ENTRY_LABELS[entry.kind] ?? entry.kind}</Badge>
              <code>{entry.ref}</code>
              <code title={entry.content_hash}>{entry.content_hash.slice(0, 10)}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>No context entries were frozen into this receipt.</p>
      )}
    </details>
  );
}

/** Findings still open for a Gate C ruling: a disposition exists (the PM
 *  rebutted or hollow-accepted it) and no adjudication has been recorded yet.
 *  Mirrors the server's own eligibility check in `adjudicateReview`. */
function contestedFindings(review: V2ConversationPlanReviewT): Array<{
  finding: V2ConversationPlanReviewFindingT;
  disposition: V2ConversationPlanReviewDispositionT;
}> {
  return review.dispositions
    .filter((disposition) => disposition.adjudication === null)
    .map((disposition) => {
      const finding = review.findings.find(
        (candidate) =>
          candidate.id === disposition.finding_id && candidate.index === disposition.finding_index,
      );
      return finding ? { finding, disposition } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        finding: V2ConversationPlanReviewFindingT;
        disposition: V2ConversationPlanReviewDispositionT;
      } => entry !== null && entry.finding.severity !== "suggestion",
    );
}

/** The channel + message editor shared by every "send a note" path (Gate C's
 *  supply-the-missing-fact ruling, and the gate card's own "Continue with a
 *  note"). Controlled — the caller owns the draft and decides what happens
 *  with it, which is why the two callers differ only in label text and in
 *  what (if anything) they render as `children` for the submit control. */
function NoteEditor({
  idPrefix,
  prompt,
  ariaLabel,
  placeholder,
  note,
  onNoteChange,
  busy,
  children,
}: {
  idPrefix: string;
  prompt: string;
  ariaLabel: string;
  placeholder: string;
  note: { channel: "reviewer" | "pm"; message: string };
  onNoteChange: (note: { channel: "reviewer" | "pm"; message: string }) => void;
  busy: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="conversation-qc-gate-note">
      <label htmlFor={`${idPrefix}-note-channel`}>{prompt}</label>
      <Select
        id={`${idPrefix}-note-channel`}
        value={note.channel}
        disabled={busy}
        onChange={(event) =>
          onNoteChange({ ...note, channel: event.target.value as "reviewer" | "pm" })
        }
      >
        <option value="pm">Planning manager</option>
        <option value="reviewer">QC reviewer</option>
      </Select>
      <TextArea
        aria-label={ariaLabel}
        value={note.message}
        maxLength={4_000}
        disabled={busy}
        placeholder={placeholder}
        onChange={(event) => onNoteChange({ ...note, message: event.target.value })}
      />
      {children}
    </div>
  );
}

/** The Gate C ruling UI: one ruling + rationale per contested finding,
 *  submitted together. "Supply the missing fact" shares the note editor
 *  below, since it is the continue-with-a-note path with a ruling attached. */
function AdjudicationFindings({
  review,
  busy,
  capBlocked,
  onAdjudicate,
}: {
  review: V2ConversationPlanReviewT;
  busy: boolean;
  capBlocked: boolean;
  onAdjudicate?: (
    review: V2ConversationPlanReviewT,
    rulings: Record<string, { ruling: Ruling; rationale: string }>,
    note: { channel: "reviewer" | "pm"; message: string } | undefined,
    raiseMaxRounds: boolean,
  ) => Promise<void>;
}): React.ReactElement {
  const findings = contestedFindings(review);
  const [rulings, setRulings] = useState<Record<string, { ruling: Ruling; rationale: string }>>({});
  const [noteChannel, setNoteChannel] = useState<"reviewer" | "pm">("pm");
  const [noteMessage, setNoteMessage] = useState("");

  const needsNote = Object.values(rulings).some((entry) => entry.ruling === "supplied_fact");
  const allDecided =
    findings.length > 0 &&
    findings.every((entry) => (rulings[entry.finding.id]?.rationale ?? "").trim().length > 0);
  const canSubmit = allDecided && (!needsNote || noteMessage.trim().length > 0);

  const submit = (raiseMaxRounds: boolean) => {
    if (!onAdjudicate || !canSubmit) return;
    void onAdjudicate(
      review,
      rulings,
      needsNote ? { channel: noteChannel, message: noteMessage.trim() } : undefined,
      raiseMaxRounds,
    );
  };

  if (findings.length === 0) {
    return (
      <p className="conversation-qc-gate-adjudication-empty">
        No contested finding remains unruled for this pause.
      </p>
    );
  }

  return (
    <div className="conversation-qc-gate-adjudication" data-testid="conversation-qc-adjudication">
      <strong>Adjudication needed — the reviewer and the PM disagree.</strong>
      <p>
        Read the finding, the PM&apos;s rebuttal, and the context manifest below, then rule for each
        finding.
      </p>
      <ContextManifestSummary review={review} />
      <ol className="conversation-qc-adjudication-findings">
        {findings.map(({ finding, disposition }) => {
          const current = rulings[finding.id];
          const priorFindings = (finding.recurs_of_finding_ids ?? [])
            .map((id) => review.findings.find((candidate) => candidate.id === id) ?? null)
            .filter(
              (candidate): candidate is V2ConversationPlanReviewFindingT => candidate !== null,
            );
          return (
            <li key={finding.id} data-testid={`conversation-qc-adjudication-finding-${finding.id}`}>
              <div>
                <Badge tone={finding.severity === "must_fix" ? "danger" : "warn"}>
                  {finding.severity.replaceAll("_", " ")}
                </Badge>
                {finding.module_id ? (
                  <code>Task · {finding.module_id}</code>
                ) : (
                  <code>Plan level</code>
                )}
              </div>
              <p>
                <strong>Finding:</strong> {finding.finding}
              </p>
              <p>
                <strong>Reviewer recommendation:</strong> {finding.recommendation}
              </p>
              <blockquote className="conversation-qc-adjudication-rebuttal">
                <strong>PM {disposition.disposition}:</strong> {disposition.rationale}
              </blockquote>
              {priorFindings.length > 0 ? (
                <div
                  className="conversation-qc-adjudication-recurrence"
                  data-testid={`conversation-qc-recurrence-${finding.id}`}
                >
                  <strong>Raised before in this review:</strong>
                  <ul>
                    {priorFindings.map((prior) => {
                      const priorDisposition = review.dispositions.find(
                        (candidate) => candidate.finding_id === prior.id,
                      );
                      return (
                        <li key={prior.id}>
                          <p>{prior.finding}</p>
                          {priorDisposition?.adjudication ? (
                            <p>
                              Ruled by a human:{" "}
                              {priorDisposition.adjudication.ruling === "reviewer"
                                ? "for the reviewer"
                                : priorDisposition.adjudication.ruling === "pm"
                                  ? "for the PM"
                                  : "supplied the missing fact"}
                              {" — "}
                              {priorDisposition.adjudication.rationale}
                            </p>
                          ) : priorDisposition ? (
                            <p>
                              PM {priorDisposition.disposition} — {priorDisposition.rationale}
                            </p>
                          ) : (
                            <p>No disposition was recorded for it.</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              <fieldset>
                <legend>Ruling</legend>
                {RULING_OPTIONS.map((option) => (
                  <label key={option.value} className="conversation-qc-ruling-option">
                    <input
                      type="radio"
                      name={`ruling-${finding.id}`}
                      value={option.value}
                      checked={current?.ruling === option.value}
                      disabled={busy}
                      onChange={() =>
                        setRulings((prev) => ({
                          ...prev,
                          [finding.id]: {
                            ruling: option.value,
                            rationale: prev[finding.id]?.rationale ?? "",
                          },
                        }))
                      }
                    />
                    {option.label}
                  </label>
                ))}
              </fieldset>
              <label htmlFor={`ruling-rationale-${finding.id}`}>Rationale</label>
              <TextArea
                id={`ruling-rationale-${finding.id}`}
                value={current?.rationale ?? ""}
                maxLength={2_000}
                disabled={busy || !current}
                placeholder="Why does this ruling stand?"
                onChange={(event) =>
                  setRulings((prev) => ({
                    ...prev,
                    [finding.id]: {
                      ruling: prev[finding.id]?.ruling ?? "reviewer",
                      rationale: event.target.value,
                    },
                  }))
                }
              />
            </li>
          );
        })}
      </ol>
      {needsNote ? (
        <NoteEditor
          idPrefix={`${review.id}-adjudication`}
          prompt="Send the missing fact to"
          ariaLabel="Missing fact"
          placeholder="What fact was missing from the frozen context?"
          note={{ channel: noteChannel, message: noteMessage }}
          onNoteChange={(next) => {
            setNoteChannel(next.channel);
            setNoteMessage(next.message);
          }}
          busy={busy}
        />
      ) : null}
      {capBlocked ? (
        <div className="conversation-qc-gate-cap-blocked" role="alert">
          <strong>This review is at its round cap.</strong>
          <p>
            Ruling for the reviewer sends the plan back for another revision, which needs a round
            this review doesn&apos;t have left. Raise the cap by one to carry out this ruling
            instead of letting it expire into a reached cap.
          </p>
          <Button variant="primary" disabled={busy || !canSubmit} onClick={() => submit(true)}>
            {busy ? "Raising cap…" : "Raise round cap by one and record ruling"}
          </Button>
        </div>
      ) : (
        <Button
          variant="primary"
          disabled={busy || !canSubmit || !onAdjudicate}
          onClick={() => submit(false)}
        >
          {busy ? "Recording ruling…" : "Record ruling"}
        </Button>
      )}
    </div>
  );
}

function qcModeSourceLabel(review: V2ConversationPlanReviewT): string {
  if (review.qc_mode_source === "project_default") return "project default";
  if (review.qc_mode_source === "work_item") return "set for this work item";
  return `changed mid-review at round ${review.qc_mode_changed_at_round} by ${review.qc_mode_changed_by_user_id}`;
}

/** Mid-flight cadence editing (QC-PAUSE-POINTS.md "Settings: three layers",
 *  layer 3) plus "hold at the next checkpoint" — both are just the one PATCH,
 *  re-read the next time a checkpoint is reached. Rendered for any
 *  non-terminal review, so it works from the QC tab and from the gate card's
 *  own parent alike. */
function QcCadenceControl({
  review,
  busy,
  onPatch,
}: {
  review: V2ConversationPlanReviewT;
  busy: boolean;
  onPatch?: (review: V2ConversationPlanReviewT, patch: { qcMode?: QcModeT }) => Promise<void>;
}): React.ReactElement {
  const modeLabel =
    QC_MODE_OPTIONS.find((option) => option.value === review.qc_mode)?.label ?? review.qc_mode;
  const canHold = review.status === "running" && review.qc_mode !== "gated_each_step";
  return (
    <section className="conversation-qc-cadence" data-testid="conversation-qc-cadence">
      <p>
        Cadence: <strong>{modeLabel}</strong> · {qcModeSourceLabel(review)}. No mode skips Gate C —
        an unresolved must-fix disagreement always pauses for you.
      </p>
      <label htmlFor={`${review.id}-cadence`}>Change cadence</label>
      <Select
        id={`${review.id}-cadence`}
        value={review.qc_mode}
        disabled={busy || !onPatch}
        onChange={(event) => void onPatch?.(review, { qcMode: event.target.value as QcModeT })}
      >
        {QC_MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {canHold ? (
        <Button
          disabled={busy || !onPatch}
          onClick={() => void onPatch?.(review, { qcMode: "gated_each_step" })}
        >
          Hold at the next checkpoint
        </Button>
      ) : null}
    </section>
  );
}

/** The gate card: rendered for a review parked `awaiting_human`. Composes the
 *  existing Finding/Badge/Button/PlanVersionDiff primitives — the findings
 *  themselves (must-fix first, paired with their disposition) already render
 *  via ConversationQcCard's severity groups below this card, so this only
 *  adds what doesn't exist yet: the gate position/spend header, the Gate B
 *  plan diff, the Gate C no-ruling-yet notice, and the four distinct exits. */
function QcGateCard({
  review,
  interimVersion,
  usage,
  busy,
  capBlocked = false,
  onResume,
  onContinueWithoutQc,
  onCancel,
  onAdjudicate,
}: {
  review: V2ConversationPlanReviewT;
  interimVersion: V2WorkPlanVersionT | null;
  usage: V2ConversationUsageT | null;
  busy: boolean;
  /** True when the last adjudicate submit failed with
   *  `round_cap_requires_raise` — offer the raise instead of failing silently. */
  capBlocked?: boolean;
  onResume?: (
    review: V2ConversationPlanReviewT,
    exit: "continue" | "note",
    note?: { channel: "reviewer" | "pm"; message: string },
    stopAsking?: boolean,
  ) => Promise<void>;
  onContinueWithoutQc?: (review: V2ConversationPlanReviewT) => Promise<void>;
  onCancel?: (review: V2ConversationPlanReviewT, reason: string) => Promise<void>;
  onAdjudicate?: (
    review: V2ConversationPlanReviewT,
    rulings: Record<string, { ruling: Ruling; rationale: string }>,
    note: { channel: "reviewer" | "pm"; message: string } | undefined,
    raiseMaxRounds: boolean,
  ) => Promise<void>;
}): React.ReactElement {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteChannel, setNoteChannel] = useState<"reviewer" | "pm">("pm");
  const [noteMessage, setNoteMessage] = useState("");
  const [confirmingAccept, setConfirmingAccept] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("Stopped by human review.");

  const isAdjudication = review.paused_checkpoint === "adjudication";
  const counts = SEVERITIES.map((severity) => ({
    ...severity,
    count: review.findings.filter((finding) => finding.severity === severity.value).length,
  })).filter((severity) => severity.count > 0);
  const spend = usage ? formatGateSpend(usage) : null;

  return (
    <section className="conversation-qc-gate" data-testid="conversation-qc-gate-card">
      <header className="conversation-qc-gate-header">
        <div>
          <span className="eyebrow">Decision checkpoint</span>
          <strong>What needs your attention</strong>
          <span>{review.paused_checkpoint ? CHECKPOINT_LABELS[review.paused_checkpoint] : ""}</span>
        </div>
        <div className="conversation-qc-gate-meta">
          <strong>
            Round {review.paused_at_round} of {review.max_rounds}
          </strong>
          {spend ? <span>{spend}</span> : null}
        </div>
      </header>
      {counts.length > 0 ? (
        <div className="conversation-qc-gate-counts" aria-label="Finding counts">
          {counts.map((severity) => (
            <Badge key={severity.value} tone={severity.tone}>
              {severity.count} {severity.label.toLowerCase()}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="conversation-qc-gate-clear">No open findings in this pass.</p>
      )}

      {isAdjudication ? (
        <AdjudicationFindings
          review={review}
          busy={busy}
          capBlocked={capBlocked}
          onAdjudicate={onAdjudicate}
        />
      ) : null}

      {interimVersion ? (
        <div className="conversation-qc-gate-diff">
          <h4>Plan changes this round</h4>
          <PlanVersionDiff version={interimVersion} />
        </div>
      ) : null}

      <div className="conversation-qc-gate-exits">
        {!isAdjudication ? (
          <Button
            variant="primary"
            className="conversation-qc-gate-continue"
            disabled={busy || !onResume}
            onClick={() => void onResume?.(review, "continue")}
          >
            {busy ? "Continuing…" : "Continue"}
          </Button>
        ) : null}
        {!isAdjudication ? (
          <Button disabled={busy} onClick={() => setNoteOpen((open) => !open)}>
            Add guidance
          </Button>
        ) : null}
      </div>

      {noteOpen ? (
        <NoteEditor
          idPrefix={`${review.id}-gate`}
          prompt="Send a note to"
          ariaLabel="Note"
          placeholder="What should they know before the next round?"
          note={{ channel: noteChannel, message: noteMessage }}
          onNoteChange={(next) => {
            setNoteChannel(next.channel);
            setNoteMessage(next.message);
          }}
          busy={busy}
        >
          <Button
            variant="primary"
            disabled={busy || !noteMessage.trim() || !onResume}
            onClick={() => {
              const message = noteMessage.trim();
              if (!message) return;
              void onResume?.(review, "note", { channel: noteChannel, message }).then(() => {
                setNoteMessage("");
                setNoteOpen(false);
              });
            }}
          >
            {busy ? "Sending…" : "Send note and continue"}
          </Button>
        </NoteEditor>
      ) : null}

      <details className="conversation-qc-gate-more">
        <summary>More options</summary>
        <div>
          {!isAdjudication && review.qc_mode !== "automatic" ? (
            <Button
              className="conversation-qc-gate-stop-asking"
              disabled={busy || !onResume}
              onClick={() => void onResume?.(review, "continue", undefined, true)}
            >
              {busy ? "Continuing…" : "Continue, and stop asking"}
            </Button>
          ) : null}
          {confirmingAccept ? (
            <span className="conversation-qc-gate-confirm">
              Keep the current plan and send it to approval?
              <Button disabled={busy} onClick={() => setConfirmingAccept(false)}>
                Keep reviewing
              </Button>
              <Button
                className="conversation-qc-gate-accept"
                disabled={busy || !onContinueWithoutQc}
                onClick={() => void onContinueWithoutQc?.(review)}
              >
                {busy ? "Accepting…" : "Confirm accept current plan"}
              </Button>
            </span>
          ) : (
            <Button
              className="conversation-qc-gate-accept"
              disabled={busy}
              onClick={() => setConfirmingAccept(true)}
            >
              Accept current plan
            </Button>
          )}
          {confirmingCancel ? (
            <span className="conversation-qc-gate-confirm">
              <label htmlFor={`${review.id}-gate-cancel-reason`}>Why cancel this review?</label>
              <TextArea
                id={`${review.id}-gate-cancel-reason`}
                value={cancelReason}
                maxLength={500}
                disabled={busy}
                onChange={(event) => setCancelReason(event.target.value)}
              />
              <Button disabled={busy} onClick={() => setConfirmingCancel(false)}>
                Keep reviewing
              </Button>
              <Button
                variant="danger"
                disabled={busy || !cancelReason.trim() || !onCancel}
                onClick={() => void onCancel?.(review, cancelReason.trim())}
              >
                {busy ? "Cancelling…" : "Confirm cancel review"}
              </Button>
            </span>
          ) : (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmingCancel(true)}>
              Cancel review
            </Button>
          )}
        </div>
      </details>
    </section>
  );
}

/** Which round a flattened finding index belongs to, mirroring the server's
 *  running-index assignment in `flattenReviewEvidence` (rounds in order,
 *  each contributing `reviewer.findings.length` consecutive indices). */
function roundOfFindingIndex(review: V2ConversationPlanReviewT): Map<number, number> {
  const rounds = new Map<number, number>();
  let index = 0;
  for (const exchange of review.round_exchanges) {
    for (let i = 0; i < exchange.reviewer.findings.length; i++) {
      rounds.set(index, exchange.round);
      index++;
    }
  }
  return rounds;
}

/** Approval-card aggregation (QC-PAUSE-POINTS.md "Outcomes" / "Repeat
 *  disputes across attempts"): rebutted should_fix findings don't trigger
 *  Gate C on their own, so they're rolled up here instead of only appearing
 *  buried in the round transcript. */
function rebuttedShouldFixSummary(review: V2ConversationPlanReviewT): {
  count: number;
  rounds: number[];
  entries: Array<{ finding: V2ConversationPlanReviewFindingT; rationale: string }>;
} | null {
  const findingRounds = roundOfFindingIndex(review);
  const entries = review.dispositions
    .filter((disposition) => disposition.disposition === "rebut")
    .map((disposition) => {
      const finding = review.findings.find(
        (candidate) =>
          candidate.id === disposition.finding_id && candidate.index === disposition.finding_index,
      );
      return finding && finding.severity === "should_fix" ? { finding, disposition } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        finding: V2ConversationPlanReviewFindingT;
        disposition: V2ConversationPlanReviewDispositionT;
      } => entry !== null,
    );
  if (entries.length === 0) return null;
  const rounds = [
    ...new Set(entries.map(({ finding }) => findingRounds.get(finding.index) ?? 0)),
  ].sort((left, right) => left - right);
  return {
    count: entries.length,
    rounds,
    entries: entries.map(({ finding, disposition }) => ({
      finding,
      rationale: disposition.rationale,
    })),
  };
}

/** Contested themes (QC-PAUSE-POINTS.md "Repeat disputes across attempts"):
 *  same dumb same-module match as `recurs_of_finding_ids`, but rolled up
 *  across every review this work item has run rather than one review's
 *  rounds — surfaced once, at the decision point. */
function contestedThemes(reviews: V2ConversationPlanReviewT[]): Array<{
  moduleId: string;
  findings: V2ConversationPlanReviewFindingT[];
}> {
  const byModule = new Map<string, V2ConversationPlanReviewFindingT[]>();
  for (const candidate of reviews) {
    for (const finding of candidate.findings) {
      if (!finding.module_id || finding.severity === "suggestion") continue;
      const list = byModule.get(finding.module_id) ?? [];
      list.push(finding);
      byModule.set(finding.module_id, list);
    }
  }
  return [...byModule.entries()]
    .filter(([, findings]) => findings.length > 1)
    .map(([moduleId, findings]) => ({ moduleId, findings }));
}

/** Human-steering provenance (QC-PAUSE-POINTS.md "Human chat at a gate"): a
 *  review that converged because a human redirected an agent must not read
 *  as having converged on the merits alone. */
function ApprovalEvidence({
  review,
  allReviews,
}: {
  review: V2ConversationPlanReviewT;
  allReviews: V2ConversationPlanReviewT[];
}): React.ReactElement | null {
  const shouldFix = rebuttedShouldFixSummary(review);
  const themes = contestedThemes(allReviews);
  const steeredRounds = review.human_steered_rounds;
  if (!shouldFix && themes.length === 0 && steeredRounds.length === 0) return null;

  return (
    <section className="conversation-qc-approval-evidence" aria-label="Before you decide">
      {steeredRounds.length > 0 ? (
        <details className="conversation-qc-human-steered" open>
          <summary>
            This review was human-steered at round{steeredRounds.length > 1 ? "s" : ""}{" "}
            {steeredRounds.join(", ")}.
          </summary>
          <p>
            A human sent guidance into the live review at{" "}
            {steeredRounds.length > 1 ? "these rounds" : "this round"}. Convergence here reflects
            that steering, not agreement reached on the merits alone.
          </p>
          <ul>
            {review.chat_messages
              .filter((message) => message.speaker === "human")
              .map((message) => (
                <li key={message.id}>
                  Round {message.round} · {message.channel === "reviewer" ? "reviewer" : "PM"} ·{" "}
                  {message.content}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {shouldFix ? (
        <details className="conversation-qc-should-fix-summary">
          <summary>
            {shouldFix.count} should-fix finding{shouldFix.count === 1 ? "" : "s"} rebutted across{" "}
            {shouldFix.rounds.length} round{shouldFix.rounds.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {shouldFix.entries.map(({ finding, rationale }) => (
              <li key={finding.id}>
                <p>{finding.finding}</p>
                <p>PM rebuttal: {rationale}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {themes.length > 0 ? (
        <details className="conversation-qc-contested-themes">
          <summary>
            {themes.length} contested theme{themes.length === 1 ? "" : "s"} raised more than once
          </summary>
          <ul>
            {themes.map((theme) => (
              <li key={theme.moduleId}>
                <code>Task · {theme.moduleId}</code>
                <ul>
                  {theme.findings.map((finding) => (
                    <li key={finding.id}>{finding.finding}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export function ConversationQcCard({
  planVersion,
  review,
  allReviews,
  interimVersion = null,
  usage = null,
  actions = {},
  busy = false,
  capBlocked = false,
  error = null,
  onCancel,
  onContinueChat,
  onContinueWithoutQc,
  onResume,
  onAdjudicate,
  onPatch,
  onConfirmAction,
  onReturnToPlanning,
  onDiscussFinding,
}: {
  planVersion: V2WorkPlanVersionT | null;
  review: V2ConversationPlanReviewT;
  /** Every review this work item has run, for the approval card's contested-
   *  themes rollup (QC-PAUSE-POINTS.md "Repeat disputes across attempts").
   *  Defaults to just this review when the caller doesn't have the full list. */
  allReviews?: V2ConversationPlanReviewT[];
  /** The Gate B interim plan version (origin "qc_interim"), for the v(n) ->
   *  v(n+1) diff. Resolve with `findGateInterimVersion` from the full
   *  plan-versions list; null outside Gate B or before it's materialized. */
  interimVersion?: V2WorkPlanVersionT | null;
  /** Cumulative spend for this conversation, already computed server-side —
   *  shown on the gate header, not recomputed here. */
  usage?: V2ConversationUsageT | null;
  actions?: {
    approve?: V2ConversationActionT | null;
    repeat?: V2ConversationActionT | null;
    skip?: V2ConversationActionT | null;
    reject?: V2ConversationActionT | null;
  };
  busy?: boolean;
  /** True when the last adjudicate submit failed with
   *  `round_cap_requires_raise` — offer the raise instead of failing silently. */
  capBlocked?: boolean;
  error?: string | null;
  onCancel?: (review: V2ConversationPlanReviewT, reason: string) => Promise<void>;
  onContinueChat?: (
    review: V2ConversationPlanReviewT,
    channel: "reviewer" | "pm",
    message: string,
  ) => Promise<void>;
  onContinueWithoutQc?: (review: V2ConversationPlanReviewT) => Promise<void>;
  /** Gate exits "Continue" and "Continue with a note" — POST .../resume. */
  onResume?: (
    review: V2ConversationPlanReviewT,
    exit: "continue" | "note",
    note?: { channel: "reviewer" | "pm"; message: string },
    stopAsking?: boolean,
  ) => Promise<void>;
  /** Gate C ruling — POST .../adjudicate. */
  onAdjudicate?: (
    review: V2ConversationPlanReviewT,
    rulings: Record<string, { ruling: Ruling; rationale: string }>,
    note: { channel: "reviewer" | "pm"; message: string } | undefined,
    raiseMaxRounds: boolean,
  ) => Promise<void>;
  /** Mid-flight cadence edit and "hold at the next checkpoint" — PATCH
   *  .../plan-reviews/:reviewId. */
  onPatch?: (review: V2ConversationPlanReviewT, patch: { qcMode?: QcModeT }) => Promise<void>;
  onConfirmAction?: (action: V2ConversationActionT) => Promise<void>;
  onReturnToPlanning?: () => void;
  onDiscussFinding?: (finding: V2ConversationPlanReviewFindingT) => void;
}): React.ReactElement {
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("Stopped by human review.");
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const titleId = `conversation-qc-${review.id}`;
  const waived = review.review_mode === "waived";
  const terminal =
    waived || ["converged", "cap_reached", "failed", "cancelled"].includes(review.status);
  const percent = Math.min(
    100,
    Math.round((review.rounds_completed / Math.max(1, review.max_rounds)) * 100),
  );
  const liveProgress = reviewLiveProgress(review);
  const nowMs = useProgressClock(!terminal);
  const progressLabel = liveProgressLabel(review, liveProgress);
  const stageElapsed = elapsedLabel(liveProgress?.started_at ?? null, nowMs);
  const totalElapsed = elapsedLabel(review.started_at, nowMs);
  const timingLabel = [
    stageElapsed ? `Stage ${stageElapsed}` : null,
    totalElapsed ? `Total ${totalElapsed}` : null,
  ]
    .filter((label): label is string => label !== null)
    .join(" · ");
  const lastExchange = review.round_exchanges.at(-1) ?? null;
  const failedAfterReviewer =
    review.status === "failed" &&
    lastExchange !== null &&
    lastExchange.reviewer.findings.length > 0 &&
    lastExchange.pm === null;
  const remaining = qcRemainingEstimate(review, nowMs);
  const nextStep = qcNextStep(review);
  const owner = qcCurrentOwner(review, liveProgress);
  const evidenceCount =
    review.chat_messages.length + review.round_exchanges.length + review.markdown_artifacts.length;
  const visibleFindings = visibleReviewFindings(review);
  const activeFindings = visibleFindings.filter(
    (finding) => finding.severity !== "suggestion",
  ).length;
  const activeRound = qcActiveRound(review, liveProgress);
  const roundStageTitle = qcRoundStageTitle(review, liveProgress, owner);
  const roundHeading = waived
    ? "QC skipped"
    : terminal
      ? `${review.rounds_completed} of ${review.max_rounds} rounds used`
      : `Round ${activeRound} of ${review.max_rounds}`;
  const roundEyebrow = waived
    ? "Quality control"
    : terminal
      ? "Review summary"
      : review.status === "awaiting_human"
        ? "Paused in"
        : "Current round";
  const ownerDetail =
    !terminal && liveProgress?.provider && liveProgress.model
      ? `${liveProgress.provider} · ${liveProgress.model}`
      : owner.detail;
  const remainingLabel = waived
    ? "Review status"
    : terminal
      ? "Run duration"
      : review.status === "awaiting_human"
        ? "Time status"
        : "Round budget";
  const primaryDecision =
    actions.approve && ["converged", "cap_reached"].includes(review.status)
      ? actions.approve
      : (actions.repeat ?? null);

  return (
    <article
      className="conversation-qc-card"
      data-testid="conversation-qc-card"
      aria-labelledby={titleId}
    >
      <div className="conversation-qc-pinned">
        <header className="conversation-qc-identity">
          <span>
            Plan {planVersion ? `version ${planVersion.version}` : review.plan_version_id} · QC
            attempt {review.attempt_number}
          </span>
        </header>

        <section className="conversation-qc-round-focus" aria-labelledby={titleId}>
          <header>
            <div>
              <span className="eyebrow">{roundEyebrow}</span>
              <h3 id={titleId}>{roundHeading}</h3>
            </div>
          </header>
          <div className="conversation-qc-round-stage">
            <span
              className={`conversation-qc-truth-marker is-${review.status}`}
              aria-hidden="true"
            />
            <div>
              <strong>{roundStageTitle}</strong>
              <p>{qcStatusDescription(review)}</p>
            </div>
          </div>
          {!waived ? (
            <footer className="conversation-qc-round-summary" aria-live="polite">
              <span>
                <small>
                  {terminal || review.status === "awaiting_human"
                    ? "Decision owner"
                    : "Working now"}
                </small>
                <strong>{owner.value}</strong>
              </span>
              <span>
                <small>{remainingLabel}</small>
                <strong>{remaining.value}</strong>
              </span>
            </footer>
          ) : null}
        </section>

        <details className="conversation-qc-run-details">
          <summary>
            <span>Run details</span>
          </summary>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{qcStatusTitle(review)}</dd>
            </div>
            <div>
              <dt>Current owner</dt>
              <dd>{owner.value}</dd>
              <small>{ownerDetail}</small>
            </div>
            <div>
              <dt>{remainingLabel}</dt>
              <dd>{remaining.value}</dd>
              <small>{remaining.detail}</small>
            </div>
            <div>
              <dt>Timing</dt>
              <dd>{timingLabel || "Timing not recorded"}</dd>
            </div>
            <div>
              <dt>Next</dt>
              <dd>{nextStep.value}</dd>
              <small>{nextStep.detail}</small>
            </div>
            <div>
              <dt>Round activity</dt>
              <dd>{terminal ? review.status.replaceAll("_", " ") : progressLabel}</dd>
            </div>
            <div>
              <dt>Findings</dt>
              <dd>
                {visibleFindings.length} total · {activeFindings} substantive
              </dd>
            </div>
          </dl>
          {!terminal && !waived && review.status !== "awaiting_human" ? (
            <div className="conversation-qc-run-controls">
              <QcCadenceControl review={review} busy={busy} onPatch={onPatch} />
              {onCancel ? (
                <section className="conversation-qc-controls">
                  {stopping ? (
                    <>
                      <label htmlFor={`${titleId}-stop-reason`}>Why are you stopping QC?</label>
                      <TextArea
                        id={`${titleId}-stop-reason`}
                        value={reason}
                        maxLength={500}
                        disabled={busy}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <div>
                        <Button disabled={busy} onClick={() => setStopping(false)}>
                          Keep QC running
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy || !reason.trim()}
                          onClick={() => void onCancel(review, reason.trim())}
                        >
                          {busy ? "Stopping…" : "Confirm stop QC"}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button variant="danger" disabled={busy} onClick={() => setStopping(true)}>
                      Stop QC
                    </Button>
                  )}
                </section>
              ) : null}
            </div>
          ) : null}
        </details>

        {!terminal ? (
          <progress
            className="sr-only"
            aria-label="QC review progress"
            max={100}
            value={review.rounds_completed > 0 ? percent : undefined}
            aria-valuetext={`${progressLabel}${
              liveProgress?.provider && liveProgress.model
                ? ` · ${liveProgress.provider} · ${liveProgress.model}`
                : ""
            }${timingLabel ? ` · ${timingLabel}` : ""}`}
          />
        ) : null}
        {review.status === "failed" ? (
          <output className="conversation-qc-failure" role="alert">
            <strong>QC failed because {failureLabel(review.failure_code)}.</strong>
            {failedAfterReviewer ? (
              <span>
                The reviewer feedback below was saved, but the planning agent did not produce an
                acceptable revision.
              </span>
            ) : null}
            <span>The unchanged plan remains a candidate and can be sent to QC again.</span>
          </output>
        ) : null}
        {review.status === "cancelled" ? (
          <output className="conversation-qc-failure">
            QC stopped by a human · {review.cancellation_reason}
          </output>
        ) : null}

        {!waived && (terminal || review.status === "awaiting_human") ? (
          <QcIssueBrief review={review} onDiscussFinding={onDiscussFinding} />
        ) : null}

        {review.status === "awaiting_human" ? (
          <QcGateCard
            review={review}
            interimVersion={interimVersion}
            usage={usage}
            busy={busy}
            capBlocked={capBlocked}
            onResume={onResume}
            onContinueWithoutQc={onContinueWithoutQc}
            onCancel={onCancel}
            onAdjudicate={onAdjudicate}
          />
        ) : null}

        {terminal && onConfirmAction ? (
          <section className="conversation-qc-decision" aria-label="Human plan decision">
            <div className="conversation-qc-decision-intro">
              <span className="eyebrow">Your decision</span>
              <h4>
                {review.status === "failed" || review.status === "cancelled"
                  ? "Choose how to recover"
                  : activeFindings > 0
                    ? `Review ${activeFindings} substantive finding${activeFindings === 1 ? "" : "s"}`
                    : "Approve the reviewed plan"}
              </h4>
              <p>
                {visibleFindings.length > 0
                  ? "The findings and the planning manager’s response are summarized immediately below."
                  : "QC returned no requested revisions for this plan."}
              </p>
            </div>
            <ApprovalEvidence review={review} allReviews={allReviews ?? [review]} />
            <div className="conversation-qc-decision-primary">
              {primaryDecision ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void onConfirmAction(primaryDecision)}
                >
                  {primaryDecision.action_type === "approve_plan"
                    ? "Approve reviewed plan & start implementation"
                    : review.status === "failed"
                      ? "Retry QC with retained guidance"
                      : "Run QC again"}
                </Button>
              ) : null}
              <small>Recommended next step</small>
            </div>
            <details className="conversation-qc-decision-more">
              <summary>Other options</summary>
              <div>
                {actions.repeat && actions.repeat.id !== primaryDecision?.id ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (actions.repeat) void onConfirmAction(actions.repeat);
                    }}
                  >
                    Run QC again
                  </Button>
                ) : null}
                {review.status === "failed" && onContinueWithoutQc ? (
                  confirmingSkip ? (
                    <div className="conversation-qc-skip-confirmation" role="alert">
                      <p>
                        This records QC as explicitly waived. The retained chats and Markdown files
                        remain visible in the audit history.
                      </p>
                      <Button disabled={busy} onClick={() => setConfirmingSkip(false)}>
                        Keep QC required
                      </Button>
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => void onContinueWithoutQc(review)}
                      >
                        {busy ? "Recording choice…" : "Confirm continue without QC"}
                      </Button>
                    </div>
                  ) : (
                    <Button disabled={busy} onClick={() => setConfirmingSkip(true)}>
                      Continue without QC
                    </Button>
                  )
                ) : null}
                {review.status === "failed" && onReturnToPlanning ? (
                  <Button disabled={busy} onClick={onReturnToPlanning}>
                    Return to planning chat
                  </Button>
                ) : null}
                {actions.reject ? (
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (actions.reject) void onConfirmAction(actions.reject);
                    }}
                  >
                    Reject plan
                  </Button>
                ) : null}
              </div>
            </details>
          </section>
        ) : null}
        {error ? (
          <output className="conversation-action-error" role="alert">
            {error}
          </output>
        ) : null}
      </div>

      <section className="conversation-qc-audit-launch">
        <Button className="btn-small" onClick={() => setAuditOpen(true)}>
          Open audit trail · {evidenceCount}
        </Button>
      </section>

      {auditOpen ? (
        <div className="conversation-qc-audit-layer">
          <button
            type="button"
            className="conversation-qc-audit-backdrop"
            aria-label="Close audit trail"
            onClick={() => setAuditOpen(false)}
          />
          <dialog
            open
            className="conversation-qc-audit-drawer"
            aria-modal="true"
            aria-labelledby={`${titleId}-audit-title`}
          >
            <header>
              <div>
                <span className="eyebrow">Attempt {review.attempt_number}</span>
                <h3 id={`${titleId}-audit-title`}>QC audit trail</h3>
                <p>Every agent handoff, saved response, round result, and technical receipt.</p>
              </div>
              <Button aria-label="Close audit trail" onClick={() => setAuditOpen(false)}>
                Close
              </Button>
            </header>
            <div className="conversation-qc-evidence-body">
              {!waived ? (
                <>
                  {!terminal && review.status !== "awaiting_human" ? (
                    <QcFindings review={review} onDiscussFinding={onDiscussFinding} />
                  ) : null}
                  <QcConversationLog review={review} busy={busy} onContinue={onContinueChat} />
                  <details className="conversation-qc-technical-log">
                    <summary>Technical event log · {review.chat_messages.length} events</summary>
                    <QcDetailedStatus review={review} />
                  </details>
                  {review.markdown_artifacts.some((artifact) => artifact.channel === "workflow") ? (
                    <section className="conversation-qc-final-artifact">
                      <h4>Final QC output</h4>
                      {review.markdown_artifacts
                        .filter((artifact) => artifact.channel === "workflow")
                        .map((artifact) => (
                          <a
                            key={artifact.artifact_id}
                            href={artifactContentPath(review.project_id, artifact.artifact_id)}
                            download={artifact.filename}
                          >
                            Download {artifact.filename}
                          </a>
                        ))}
                    </section>
                  ) : null}
                </>
              ) : null}

              {review.round_exchanges.length > 0 ? (
                <section
                  className="conversation-qc-transcript"
                  aria-labelledby={`${titleId}-transcript`}
                >
                  <div>
                    <h4 id={`${titleId}-transcript`}>Agent review transcript</h4>
                    <Badge tone="info">{review.round_exchanges.length} rounds</Badge>
                  </div>
                  <ol>
                    {review.round_exchanges.map((exchange) => (
                      <li key={exchange.round}>
                        <div className="conversation-qc-round-heading">
                          <strong>Round {exchange.round}</strong>
                          <code title={exchange.reviewed_plan_content_hash}>
                            Plan {exchange.reviewed_plan_content_hash.slice(0, 10)}
                          </code>
                        </div>
                        <article className="conversation-qc-agent-message is-reviewer">
                          <header>
                            <Badge tone="warn">QC reviewer</Badge>
                            <strong>
                              {exchange.reviewer.provider} · {exchange.reviewer.model}
                            </strong>
                          </header>
                          {exchange.reviewer.findings.length === 0 ? (
                            <p>No changes requested.</p>
                          ) : (
                            <ol>
                              {exchange.reviewer.findings.map((finding, index) => (
                                <li key={`${exchange.round}:finding:${index}`}>
                                  <strong>{finding.severity.replaceAll("_", " ")}</strong>
                                  <span>{finding.finding}</span>
                                  <small>{finding.recommendation}</small>
                                </li>
                              ))}
                            </ol>
                          )}
                        </article>
                        {exchange.pm ? (
                          <article className="conversation-qc-agent-message is-pm">
                            <header>
                              <Badge tone="info">Planning agent</Badge>
                              <strong>
                                {exchange.pm.provider} · {exchange.pm.model}
                              </strong>
                            </header>
                            {exchange.pm.dispositions.length > 0 ? (
                              <ol>
                                {exchange.pm.dispositions.map((disposition) => (
                                  <li
                                    key={`${exchange.round}:response:${disposition.finding_index}`}
                                  >
                                    <strong>{disposition.disposition}</strong>
                                    <span>{disposition.rationale}</span>
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p>No dispositions were required.</p>
                            )}
                            <code title={exchange.pm.revised_plan_content_hash}>
                              Revised plan {exchange.pm.revised_plan_content_hash.slice(0, 10)}
                            </code>
                          </article>
                        ) : exchange.reviewer.findings.some(
                            (finding) => finding.severity === "must_fix",
                          ) ? (
                          <p className="conversation-qc-awaiting-agent">
                            Waiting for the planning agent to respond.
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {waived ? (
                <p className="conversation-qc-clear">
                  No reviewer was called. You explicitly chose to proceed with the selected
                  execution agent.
                </p>
              ) : terminal && review.findings.length === 0 && review.status !== "failed" ? (
                <p className="conversation-qc-clear">
                  QC returned no findings for this exact plan version.
                </p>
              ) : null}
              {review.revised_plan_version_id ? (
                <p className="conversation-qc-revision">
                  PM revision saved as plan reference <code>{review.revised_plan_version_id}</code>.
                </p>
              ) : null}

              <details className="conversation-qc-receipt">
                <summary>Review receipt · models, hashes, and context</summary>
                <dl className="conversation-qc-summary">
                  <div>
                    <dt>Progress</dt>
                    <dd>
                      {review.rounds_completed} / {review.max_rounds} rounds
                    </dd>
                  </div>
                  <div>
                    <dt>Exact reviewed hash</dt>
                    <dd>
                      <code title={review.plan_content_hash}>
                        {review.plan_content_hash.slice(0, 10)}
                      </code>
                    </dd>
                  </div>
                  {["converged", "cap_reached"].includes(review.status) ? (
                    <div>
                      <dt>Final result hash</dt>
                      <dd>
                        <code title={review.result_plan_content_hash}>
                          {review.result_plan_content_hash.slice(0, 10)}
                        </code>
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>PM</dt>
                    <dd>
                      {review.pm_provider} · {review.pm_model}
                    </dd>
                  </div>
                  {!waived ? (
                    <div>
                      <dt>Reviewer</dt>
                      <dd>
                        {review.reviewer_provider} · {review.reviewer_model}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Context receipt</dt>
                    <dd>
                      <code title={review.context_manifest.context_hash}>
                        {review.context_manifest.context_hash.slice(0, 10)}
                      </code>
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          </dialog>
        </div>
      ) : null}
    </article>
  );
}
