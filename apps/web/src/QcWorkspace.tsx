import type {
  V2ConversationActionT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useEffect, useMemo, useState } from "react";
import type { QcModeT } from "./conversationApi";
import { Button } from "./ui";
import "./QcWorkspace.css";

export type QcRuling = "reviewer" | "pm" | "supplied_fact";

type QcWorkspaceActions = {
  approve?: V2ConversationActionT | null;
  repeat?: V2ConversationActionT | null;
  reject?: V2ConversationActionT | null;
};

export interface QcWorkspaceProps {
  review: V2ConversationPlanReviewT;
  planVersion: V2WorkPlanVersionT | null;
  history: V2ConversationPlanReviewT[];
  actions: QcWorkspaceActions;
  busy: boolean;
  error?: string | null;
  onTriage: (
    review: V2ConversationPlanReviewT,
    decisions: Record<string, "accept" | "reject">,
  ) => Promise<void>;
  onResume: (review: V2ConversationPlanReviewT, exit: "continue") => Promise<void>;
  onAdjudicate: (
    review: V2ConversationPlanReviewT,
    rulings: Record<string, { ruling: QcRuling; rationale: string }>,
  ) => Promise<void>;
  onContinueWithoutQc: (review: V2ConversationPlanReviewT) => Promise<void>;
  onCancel: (review: V2ConversationPlanReviewT, reason: string) => Promise<void>;
  onConfirmAction: (action: V2ConversationActionT, qcMode?: QcModeT) => Promise<void>;
}

const TERMINAL = new Set(["converged", "cap_reached", "failed", "cancelled"]);

function visibleFindings(review: V2ConversationPlanReviewT): V2ConversationPlanReviewFindingT[] {
  if (review.findings.length > 0) return review.findings;
  let index = 0;
  return review.round_exchanges.flatMap((exchange) =>
    exchange.reviewer.findings.map((finding) => ({
      ...finding,
      id: `${review.id}:historical:${exchange.round}:${index}`,
      index: index++,
      recurs_of_finding_ids: [],
    })),
  );
}

function pausedRoundFindings(
  review: V2ConversationPlanReviewT,
  findings: V2ConversationPlanReviewFindingT[],
): V2ConversationPlanReviewFindingT[] {
  const pausedRound = review.paused_at_round;
  if (review.paused_checkpoint !== "after_review" || pausedRound === null) {
    return findings;
  }
  const currentExchange = review.round_exchanges.find((exchange) => exchange.round === pausedRound);
  if (!currentExchange) return findings;
  const priorCount = review.round_exchanges
    .filter((exchange) => exchange.round < pausedRound)
    .reduce((total, exchange) => total + exchange.reviewer.findings.length, 0);
  return findings.slice(priorCount, priorCount + currentExchange.reviewer.findings.length);
}

function currentRound(review: V2ConversationPlanReviewT): number {
  if (review.paused_at_round !== null) return review.paused_at_round;
  const live = review.live_progress;
  if (live?.round) return live.round;
  return Math.max(1, Math.min(review.rounds_completed + 1, review.max_rounds));
}

function ownerLabel(review: V2ConversationPlanReviewT): string {
  if (review.status === "awaiting_human") return "Waiting for your decision";
  if (review.live_progress?.stage === "revising") return "Planning manager is revising the plan";
  if (review.live_progress?.stage === "reviewing")
    return "Independent reviewer is checking the plan";
  if (review.status === "queued") return "Review is queued";
  return "Quality review is working";
}

/** Live elapsed time for the current QC operation. Counts from the durable
 *  live_progress.started_at (per stage/round/attempt/model), so a refresh or a
 *  new tab shows the true age of the step rather than restarting at zero. */
function StageElapsed({ startedAt }: { startedAt: string }): React.ReactElement | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1_000));
  const label = `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <time className="qc-new-elapsed" dateTime={startedAt}>
      {label} on this step
    </time>
  );
}

function severityLabel(severity: V2ConversationPlanReviewFindingT["severity"]): string {
  if (severity === "must_fix") return "Required";
  if (severity === "should_fix") return "Recommended";
  return "Optional";
}

function FindingRow({
  finding,
  selectable,
  selected,
  onSelected,
  response,
}: {
  finding: V2ConversationPlanReviewFindingT;
  selectable: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  response?: { disposition: "accept" | "rebut"; rationale: string } | null;
}): React.ReactElement {
  return (
    <li className="qc-new-finding" data-severity={finding.severity}>
      <div className="qc-new-finding-main">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Accept finding: ${finding.finding}`}
            onChange={(event) => onSelected(event.target.checked)}
          />
        ) : null}
        <span className="qc-new-severity">{severityLabel(finding.severity)}</span>
        <div>
          <strong>{finding.finding}</strong>
          <small>{finding.module_id ? `Plan area · ${finding.module_id}` : "Plan-wide"}</small>
        </div>
      </div>
      <details>
        <summary>Recommendation</summary>
        <p>{finding.recommendation}</p>
      </details>
      {response ? (
        <details>
          <summary>PM response</summary>
          <p>
            <strong>{response.disposition === "accept" ? "Accepted: " : "Rebutted: "}</strong>
            {response.rationale}
          </p>
        </details>
      ) : null}
    </li>
  );
}

function FindingTriage({
  review,
  findings,
  busy,
  onTriage,
  onRejectAll,
}: {
  review: V2ConversationPlanReviewT;
  findings: V2ConversationPlanReviewFindingT[];
  busy: boolean;
  onTriage: QcWorkspaceProps["onTriage"];
  onRejectAll: () => Promise<void>;
}): React.ReactElement {
  const [mode, setMode] = useState<"choice" | "individual" | "reject">("choice");
  const [selected, setSelected] = useState(() => new Set(findings.map((finding) => finding.id)));
  const selectedCount = selected.size;
  const decisions = (accepted: Set<string>) =>
    Object.fromEntries(
      findings.map((finding) => [finding.id, accepted.has(finding.id) ? "accept" : "reject"]),
    ) as Record<string, "accept" | "reject">;

  return (
    <section className="qc-new-decision" aria-labelledby="qc-triage-title">
      <div className="qc-new-decision-copy">
        <span>YOUR DECISION</span>
        <h2 id="qc-triage-title">Which findings should the PM act on?</h2>
        <p>
          Nothing goes back to the planning manager until you choose. Rejected findings remain in
          the review record but will not be used as revision instructions.
        </p>
      </div>

      {mode === "choice" ? (
        <div className="qc-new-choice-grid">
          <button
            type="button"
            className="qc-new-choice is-primary"
            disabled={busy}
            onClick={() =>
              void onTriage(review, decisions(new Set(findings.map((item) => item.id))))
            }
          >
            <strong>Accept all {findings.length}</strong>
            <span>Send every finding to the PM for revision</span>
          </button>
          <button
            type="button"
            className="qc-new-choice"
            disabled={busy}
            onClick={() => setMode("individual")}
          >
            <strong>Choose individually</strong>
            <span>Accept only the findings you agree with</span>
          </button>
          <button
            type="button"
            className="qc-new-choice is-danger"
            disabled={busy}
            onClick={() => setMode("reject")}
          >
            <strong>Accept none</strong>
            <span>Keep the current plan and override this review</span>
          </button>
        </div>
      ) : null}

      {mode === "individual" ? (
        <div className="qc-new-individual">
          <header>
            <div>
              <strong>{selectedCount} accepted</strong>
              <span>{findings.length - selectedCount} rejected</span>
            </div>
            <button type="button" onClick={() => setMode("choice")}>
              Back
            </button>
          </header>
          <ul className="qc-new-findings">
            {findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                selectable
                selected={selected.has(finding.id)}
                onSelected={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(finding.id);
                    else next.delete(finding.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
          <div className="qc-new-decision-bar">
            <span>
              {selectedCount > 0
                ? `${selectedCount} finding${selectedCount === 1 ? "" : "s"} will be sent to the PM`
                : "Choose at least one finding, or accept none"}
            </span>
            {selectedCount > 0 ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void onTriage(review, decisions(selected))}
              >
                {busy ? "Sending…" : `Send ${selectedCount} to PM`}
              </Button>
            ) : (
              <Button variant="danger" disabled={busy} onClick={() => setMode("reject")}>
                Accept none
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {mode === "reject" ? (
        <div className="qc-new-confirm" role="alert">
          <strong>Keep the original plan?</strong>
          <p>
            This rejects all {findings.length} findings and records QC as overridden. The planning
            manager will not revise the plan.
          </p>
          <div>
            <Button disabled={busy} onClick={() => setMode("choice")}>
              Go back
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void onRejectAll()}>
              {busy ? "Recording…" : "Reject all and keep plan"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AdjudicationDecision({
  review,
  findings,
  busy,
  onAdjudicate,
}: {
  review: V2ConversationPlanReviewT;
  findings: V2ConversationPlanReviewFindingT[];
  busy: boolean;
  onAdjudicate: QcWorkspaceProps["onAdjudicate"];
}): React.ReactElement {
  const eligible = findings.filter(
    (finding) =>
      finding.severity !== "suggestion" &&
      review.dispositions.some(
        (disposition) => disposition.finding_id === finding.id && disposition.adjudication === null,
      ),
  );
  const [choices, setChoices] = useState<Record<string, "reviewer" | "pm">>({});
  const complete = eligible.length > 0 && eligible.every((finding) => choices[finding.id]);
  return (
    <section className="qc-new-decision" aria-labelledby="qc-conflict-title">
      <div className="qc-new-decision-copy">
        <span>CONFLICT TO RESOLVE</span>
        <h2 id="qc-conflict-title">The reviewer and PM disagree</h2>
        <p>Choose the position the next round must follow. Your ruling is saved in the audit.</p>
      </div>
      <ul className="qc-new-conflicts">
        {eligible.map((finding) => {
          const disposition = review.dispositions.find((item) => item.finding_id === finding.id);
          return (
            <li key={finding.id}>
              <strong>{finding.finding}</strong>
              <p>{disposition?.rationale}</p>
              <div>
                <button
                  type="button"
                  className={choices[finding.id] === "reviewer" ? "is-selected" : ""}
                  onClick={() =>
                    setChoices((current) => ({ ...current, [finding.id]: "reviewer" }))
                  }
                >
                  Follow reviewer
                </button>
                <button
                  type="button"
                  className={choices[finding.id] === "pm" ? "is-selected" : ""}
                  onClick={() => setChoices((current) => ({ ...current, [finding.id]: "pm" }))}
                >
                  Keep PM approach
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="qc-new-decision-bar">
        <span>
          {complete ? "All conflicts have a ruling" : "Choose an outcome for every conflict"}
        </span>
        <Button
          variant="primary"
          disabled={busy || !complete}
          onClick={() =>
            void onAdjudicate(
              review,
              Object.fromEntries(
                Object.entries(choices).map(([findingId, ruling]) => [
                  findingId,
                  {
                    ruling,
                    rationale:
                      ruling === "reviewer"
                        ? "Human decision: follow the independent reviewer."
                        : "Human decision: keep the planning manager's approach.",
                  },
                ]),
              ),
            )
          }
        >
          Continue with rulings
        </Button>
      </div>
    </section>
  );
}

export function QcWorkspace({
  review,
  planVersion,
  history,
  actions,
  busy,
  error,
  onTriage,
  onResume,
  onAdjudicate,
  onContinueWithoutQc,
  onCancel,
  onConfirmAction,
}: QcWorkspaceProps): React.ReactElement {
  const findings = useMemo(() => visibleFindings(review), [review]);
  const currentFindings = useMemo(() => pausedRoundFindings(review, findings), [review, findings]);
  const round = currentRound(review);
  const terminal = TERMINAL.has(review.status);
  const accepted = (review.finding_decisions ?? []).filter(
    (item) => item.decision === "accept",
  ).length;
  const stageTitle =
    review.status === "awaiting_human"
      ? review.paused_checkpoint === "after_review"
        ? `Round ${round} reviewer pass complete`
        : review.paused_checkpoint === "after_revision"
          ? `Round ${round} revision complete`
          : `Round ${round} needs your ruling`
      : terminal
        ? review.status === "converged"
          ? "Quality review passed"
          : review.status === "cap_reached"
            ? "Review limit reached"
            : review.status === "failed"
              ? "Quality review stopped"
              : "Quality review cancelled"
        : `Round ${round} of ${review.max_rounds}`;

  return (
    <main className="qc-new-workspace" data-testid="qc-new-workspace">
      <header className="qc-new-header">
        <div>
          <span>QUALITY CONTROL</span>
          <h1>{stageTitle}</h1>
          <p>
            {review.status === "awaiting_human" && review.paused_checkpoint === "after_review"
              ? `${currentFindings.length} finding${currentFindings.length === 1 ? " is" : "s are"} waiting for your decision before the PM can revise anything.`
              : review.status === "converged"
                ? "The review is complete. Approve this plan to begin development."
                : review.status === "cap_reached"
                  ? "QC used the available rounds. Review the record and decide whether to proceed."
                  : review.status === "failed"
                    ? "The plan is unchanged. Choose a recovery path without leaving QC."
                    : review.status === "cancelled"
                      ? "The review was stopped. The plan remains unchanged."
                      : ownerLabel(review)}
          </p>
        </div>
        <div className="qc-new-round" aria-label="Review position">
          <strong>{terminal ? review.rounds_completed : round}</strong>
          <span>of {review.max_rounds} rounds</span>
        </div>
      </header>

      <ol className="qc-new-stage-rail" aria-label="Work stages">
        <li className="is-complete">
          <span>1</span>
          <strong>Plan locked</strong>
        </li>
        <li className="is-current">
          <span>2</span>
          <strong>Quality control</strong>
        </li>
        <li>
          <span>3</span>
          <strong>Development after approval</strong>
        </li>
      </ol>

      {!terminal && review.status !== "awaiting_human" ? (
        <section className="qc-new-working" aria-live="polite">
          <span className="qc-new-pulse" aria-hidden="true" />
          <div>
            <strong>{ownerLabel(review)}</strong>
            <p>
              {review.live_progress?.stage === "revising" && accepted > 0
                ? `Applying the ${accepted} finding${accepted === 1 ? "" : "s"} you accepted. You can leave this page and return later.`
                : "No action is needed right now. This page will stop when your decision is required."}
            </p>
            {review.live_progress ? (
              <p className="qc-new-working-meta">
                <StageElapsed startedAt={review.live_progress.started_at} />
                {review.live_progress.model ? <span>{review.live_progress.model}</span> : null}
                {review.live_progress.attempt > 1 ? (
                  <span>retry {review.live_progress.attempt}</span>
                ) : null}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {review.status === "awaiting_human" && review.paused_checkpoint === "after_review" ? (
        <FindingTriage
          review={review}
          findings={currentFindings}
          busy={busy}
          onTriage={onTriage}
          onRejectAll={() => onContinueWithoutQc(review)}
        />
      ) : null}

      {review.status === "awaiting_human" && review.paused_checkpoint === "after_revision" ? (
        <section className="qc-new-decision">
          <div className="qc-new-decision-copy">
            <span>REVISION SAVED</span>
            <h2>The PM finished the selected changes</h2>
            <p>The plan remains inside QC. Send this revision directly to the reviewer.</p>
          </div>
          <div className="qc-new-decision-bar">
            <span>Plan version {planVersion?.version ?? "updated"}</span>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void onResume(review, "continue")}
            >
              Send revision to reviewer
            </Button>
          </div>
        </section>
      ) : null}

      {review.status === "awaiting_human" && review.paused_checkpoint === "adjudication" ? (
        <AdjudicationDecision
          review={review}
          findings={findings}
          busy={busy}
          onAdjudicate={onAdjudicate}
        />
      ) : null}

      {terminal ? (
        <section className="qc-new-outcome">
          <div>
            <span>{review.status === "converged" ? "REVIEW COMPLETE" : "DECISION REQUIRED"}</span>
            <h2>
              {review.status === "converged"
                ? "The plan is ready for approval"
                : review.status === "cap_reached"
                  ? "Choose whether this plan is ready"
                  : "Choose a recovery path"}
            </h2>
            <p>
              {review.status === "failed"
                ? "The plan is unchanged. A fresh QC attempt will use the new finding-triage flow before the PM revises it."
                : `${findings.length} finding${findings.length === 1 ? " remains" : "s remain"} in the review record.`}
            </p>
          </div>
          <div className="qc-new-outcome-actions">
            {actions.approve && ["converged", "cap_reached"].includes(review.status) ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  if (actions.approve) void onConfirmAction(actions.approve);
                }}
              >
                Approve plan and start development
              </Button>
            ) : null}
            {actions.repeat && ["failed", "cancelled", "cap_reached"].includes(review.status) ? (
              <Button
                variant={review.status === "failed" ? "primary" : undefined}
                disabled={busy}
                onClick={() => {
                  if (actions.repeat) {
                    void onConfirmAction(actions.repeat, "gated_when_contested");
                  }
                }}
              >
                Run QC again
              </Button>
            ) : null}
            {review.status === "failed" ? (
              <Button disabled={busy} onClick={() => void onContinueWithoutQc(review)}>
                Keep plan without QC
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
        </section>
      ) : null}

      {error ? (
        <output className="qc-new-error" role="alert">
          {error}
        </output>
      ) : null}

      <details className="qc-new-record">
        <summary>Review record</summary>
        <div>
          <dl>
            <div>
              <dt>Plan</dt>
              <dd>Version {planVersion?.version ?? review.plan_version_id}</dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>{review.attempt_number}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{accepted}</dd>
            </div>
            <div>
              <dt>Prior attempts</dt>
              <dd>{history.length}</dd>
            </div>
          </dl>
          {findings.length > 0 ? (
            <ul className="qc-new-findings is-readonly">
              {findings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  selectable={false}
                  selected={false}
                  onSelected={() => undefined}
                  response={
                    review.dispositions.find((item) => item.finding_id === finding.id) ?? null
                  }
                />
              ))}
            </ul>
          ) : (
            <p>No retained findings.</p>
          )}
          {review.chat_messages.length > 0 ? (
            <details className="qc-new-transcript">
              <summary>
                Full reviewer ↔ PM transcript · {review.chat_messages.length}{" "}
                {review.chat_messages.length === 1 ? "message" : "messages"}
              </summary>
              <ol>
                {review.chat_messages.map((message) => (
                  <li key={message.id}>
                    <strong>
                      {message.speaker === "pm"
                        ? "Planning manager"
                        : message.speaker === "reviewer"
                          ? "Reviewer"
                          : message.speaker === "human"
                            ? "You"
                            : "QC workflow"}
                    </strong>
                    <span>Round {message.round}</span>
                    <p>{message.content}</p>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {history.length > 0 ? (
            <details className="qc-new-history">
              <summary>Previous attempts · {history.length}</summary>
              <ol>
                {history.map((pastReview) => {
                  const pastFindings = visibleFindings(pastReview);
                  return (
                    <li key={pastReview.id}>
                      <header>
                        <strong>Attempt {pastReview.attempt_number}</strong>
                        <span>{pastReview.status.replaceAll("_", " ")}</span>
                      </header>
                      <p>
                        {pastReview.rounds_completed} of {pastReview.max_rounds} rounds completed
                      </p>
                      {pastFindings.length > 0 ? (
                        <ul>
                          {pastFindings.map((finding) => (
                            <li key={finding.id}>{finding.finding}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No retained findings.</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </details>
          ) : null}
        </div>
      </details>

      {!terminal ? (
        <details className="qc-new-stop">
          <summary>Stop this QC run</summary>
          <p>Stopping preserves the review record and leaves the plan unchanged.</p>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void onCancel(review, "Stopped by the user.")}
          >
            Stop QC
          </Button>
        </details>
      ) : null}
    </main>
  );
}
