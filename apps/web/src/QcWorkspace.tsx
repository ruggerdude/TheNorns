import type {
  V2ConversationActionT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useEffect, useMemo, useState } from "react";
import { aiProviderLabel } from "./aiProviders";
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
  onStopAll: (review: V2ConversationPlanReviewT) => Promise<void>;
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

function activeQcAgent(review: V2ConversationPlanReviewT): {
  state: string;
  role: string;
  provider: string;
  model: string;
} {
  const live = review.live_progress;
  const liveIsPm =
    live?.provider === review.pm_provider && live.model !== null && live.model === review.pm_model;
  const waitingOnHuman = review.status === "awaiting_human";
  const pmOwnsStep =
    liveIsPm ||
    (waitingOnHuman && review.paused_checkpoint === "after_revision") ||
    (!waitingOnHuman && !live && (review.finding_decisions?.length ?? 0) > 0);
  return {
    state: waitingOnHuman
      ? "Waiting on you"
      : TERMINAL.has(review.status)
        ? "Review completed"
        : review.status === "queued"
          ? "Queued next"
          : "Working now",
    role: pmOwnsStep ? "Planning manager" : "Independent reviewer",
    provider: aiProviderLabel(pmOwnsStep ? review.pm_provider : review.reviewer_provider),
    model: pmOwnsStep ? review.pm_model : review.reviewer_model,
  };
}

function ownerLabel(review: V2ConversationPlanReviewT): string {
  const agent = activeQcAgent(review);
  return `${agent.role} · ${agent.provider} · ${agent.model}`;
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

const STAGE_ESTIMATE_SECONDS: Record<
  NonNullable<V2ConversationPlanReviewT["live_progress"]>["stage"],
  number
> = {
  preparing: 10,
  generating: 75,
  reviewing: 75,
  revising: 90,
  repairing: 60,
  validating: 15,
  saving: 10,
};

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

type QcProgressTab = "progress" | "dialogue";

function QcProgressTabs({
  active,
  onChange,
}: {
  active: QcProgressTab;
  onChange: (tab: QcProgressTab) => void;
}): React.ReactElement {
  return (
    <div className="qc-progress-tabs" role="tablist" aria-label="Quality control details">
      <button
        id="qc-progress-tab"
        type="button"
        role="tab"
        aria-selected={active === "progress"}
        aria-controls="qc-progress-panel"
        onClick={() => onChange("progress")}
      >
        Progress
      </button>
      <button
        id="qc-dialogue-tab"
        type="button"
        role="tab"
        aria-selected={active === "dialogue"}
        aria-controls="qc-dialogue-panel"
        onClick={() => onChange("dialogue")}
      >
        Live dialogue
      </button>
    </div>
  );
}

function speakerLabel(
  speaker: V2ConversationPlanReviewT["chat_messages"][number]["speaker"],
): string {
  if (speaker === "reviewer") return "Independent reviewer";
  if (speaker === "pm") return "Planning manager";
  if (speaker === "human") return "You";
  return "QC workflow";
}

function QcLiveDialogue({ review }: { review: V2ConversationPlanReviewT }): React.ReactElement {
  const messages = review.chat_messages.slice(-20);
  const liveOutput = review.live_progress?.output_preview?.trim() ?? "";
  return (
    <section
      id="qc-dialogue-panel"
      className="qc-live-dialogue"
      role="tabpanel"
      aria-labelledby="qc-dialogue-tab"
    >
      <header>
        <div>
          <strong>Visible agent dialogue</strong>
          <span>Updates automatically while QC is working</span>
        </div>
        {liveOutput ? <b>LIVE</b> : null}
      </header>
      {messages.length > 0 || liveOutput ? (
        <ol>
          {messages.map((message) => (
            <li key={message.id} data-speaker={message.speaker}>
              <header>
                <strong>{speakerLabel(message.speaker)}</strong>
                <span>
                  Round {message.round} · {message.kind.replaceAll("_", " ")}
                </span>
              </header>
              {message.speaker === "workflow" && message.kind !== "error" ? (
                <details>
                  <summary>View instructions sent to {message.channel}</summary>
                  <pre>{message.content}</pre>
                </details>
              ) : (
                <pre>{message.content}</pre>
              )}
            </li>
          ))}
          {liveOutput ? (
            <li
              className="is-live"
              data-speaker={review.live_progress?.stage === "revising" ? "pm" : "reviewer"}
            >
              <header>
                <strong>
                  {review.live_progress?.stage === "revising"
                    ? "Planning manager"
                    : "Independent reviewer"}
                </strong>
                <span>Response streaming now</span>
              </header>
              <pre>{liveOutput}</pre>
            </li>
          ) : null}
        </ol>
      ) : (
        <div className="qc-live-dialogue-empty">
          <span className="qc-new-pulse" aria-hidden="true" />
          <p>The request has been sent. Waiting for the first visible response.</p>
        </div>
      )}
      <small>
        This shows emitted responses and workflow messages, not private internal reasoning.
      </small>
    </section>
  );
}

function QcProgressPopout({
  review,
  accepted,
}: {
  review: V2ConversationPlanReviewT;
  accepted: number;
}): React.ReactElement | null {
  const live = review.live_progress;
  const [activeTab, setActiveTab] = useState<QcProgressTab>("progress");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!live) {
    const queuedAt = Date.parse(review.created_at);
    const queuedSeconds = Number.isNaN(queuedAt)
      ? 0
      : Math.max(0, Math.floor((now - queuedAt) / 1_000));
    return (
      <aside
        className="qc-progress-popout"
        aria-label="Quality control progress"
        aria-live="polite"
      >
        <QcProgressTabs active={activeTab} onChange={setActiveTab} />
        {activeTab === "progress" ? (
          <section
            id="qc-progress-panel"
            className="qc-progress-panel"
            role="tabpanel"
            aria-labelledby="qc-progress-tab"
          >
            <header>
              <span className="qc-new-pulse" aria-hidden="true" />
              <div>
                <strong>{ownerLabel(review)}</strong>
                <span>
                  Round {currentRound(review)} of {review.max_rounds}
                </span>
              </div>
              <b>Waiting</b>
            </header>
            <progress
              max="100"
              aria-label="Current QC step progress"
              aria-valuetext="Waiting for the reviewer to start"
            />
            <p className="qc-progress-activity">Waiting for the independent reviewer to start.</p>
            <dl>
              <div>
                <dt>Elapsed</dt>
                <dd>{durationLabel(queuedSeconds)}</dd>
              </div>
              <div>
                <dt>Estimated</dt>
                <dd>Calculating after the reviewer starts</dd>
              </div>
            </dl>
          </section>
        ) : (
          <QcLiveDialogue review={review} />
        )}
      </aside>
    );
  }

  const stepStarted = Date.parse(live.started_at);
  const reviewStarted = Date.parse(review.started_at ?? live.started_at);
  const stepElapsed = Number.isNaN(stepStarted)
    ? 0
    : Math.max(0, Math.floor((now - stepStarted) / 1_000));
  const totalElapsed = Number.isNaN(reviewStarted)
    ? stepElapsed
    : Math.max(0, Math.floor((now - reviewStarted) / 1_000));
  const estimate = STAGE_ESTIMATE_SECONDS[live.stage];
  const takingLongerThanUsual = stepElapsed > estimate * 2;
  const round = live.round ?? currentRound(review);
  const outputCharacters = live.output_characters;
  const hasMeasuredProgress = live.total_items > 0 && live.completed_items > 0;
  const itemLabel = hasMeasuredProgress
    ? `${Math.min(live.completed_items, live.total_items)} completed of ${live.total_items} item${live.total_items === 1 ? "" : "s"}`
    : live.total_items > 0
      ? `${live.total_items} item${live.total_items === 1 ? "" : "s"} in this review step`
      : live.stage === "revising" && accepted > 0
        ? `${accepted} accepted finding${accepted === 1 ? "" : "s"} in this revision step`
        : null;

  return (
    <aside className="qc-progress-popout" aria-label="Quality control progress" aria-live="polite">
      <QcProgressTabs active={activeTab} onChange={setActiveTab} />
      {activeTab === "progress" ? (
        <section
          id="qc-progress-panel"
          className="qc-progress-panel"
          role="tabpanel"
          aria-labelledby="qc-progress-tab"
        >
          <header>
            <span className="qc-new-pulse" aria-hidden="true" />
            <div>
              <strong>{ownerLabel(review)}</strong>
              <span>
                Round {round} of {review.max_rounds}
              </span>
            </div>
            <b>
              {hasMeasuredProgress
                ? `${Math.min(live.completed_items, live.total_items)} of ${live.total_items}`
                : "In progress"}
            </b>
          </header>
          <progress
            max={hasMeasuredProgress ? live.total_items : 100}
            {...(hasMeasuredProgress
              ? { value: Math.min(live.completed_items, live.total_items) }
              : {})}
            aria-label="Current QC step progress"
            aria-valuetext={
              hasMeasuredProgress
                ? `${live.completed_items} of ${live.total_items} items complete`
                : "Reviewer is active; no completed checkpoint yet"
            }
          />
          <p className="qc-progress-activity">{live.activity}</p>
          {takingLongerThanUsual ? (
            <p className="qc-progress-delay">
              {hasMeasuredProgress
                ? "This step is over its typical time, but QC is still active. Open Live dialogue for emitted output, or use the stop controls below."
                : "No review checkpoint has completed yet. The reviewer request is still active; open Live dialogue for emitted output, or use the stop controls below."}
            </p>
          ) : null}
          <dl>
            <div>
              <dt>Elapsed</dt>
              <dd>{durationLabel(totalElapsed)}</dd>
            </div>
            <div>
              <dt>Typical</dt>
              <dd>About {durationLabel(estimate)} for this step</dd>
            </div>
            {itemLabel ? (
              <div>
                <dt>{hasMeasuredProgress ? "Items" : "Scope"}</dt>
                <dd>{itemLabel}</dd>
              </div>
            ) : null}
            <div>
              <dt>Live output</dt>
              <dd>
                {outputCharacters > 0
                  ? `${outputCharacters.toLocaleString()} characters received`
                  : "Waiting for response data"}
              </dd>
            </div>
          </dl>
          <p className="qc-new-working-meta">
            <StageElapsed startedAt={live.started_at} />
            {live.model ? <span>{live.model}</span> : null}
            {live.attempt > 1 ? <span>retry {live.attempt}</span> : null}
          </p>
          <small>Progress advances only when QC reports a completed checkpoint.</small>
        </section>
      ) : (
        <QcLiveDialogue review={review} />
      )}
    </aside>
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
  showRecommendation = false,
}: {
  finding: V2ConversationPlanReviewFindingT;
  selectable: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  response?: { disposition: "accept" | "rebut"; rationale: string } | null;
  showRecommendation?: boolean;
}): React.ReactElement {
  return (
    <li
      className={`qc-new-finding${selectable ? " is-selectable" : ""}`}
      data-severity={finding.severity}
    >
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
      {showRecommendation ? (
        <div className="qc-new-finding-recommendation">
          <strong>Recommendation</strong>
          <p>{finding.recommendation}</p>
        </div>
      ) : (
        <details>
          <summary>Recommendation</summary>
          <p>{finding.recommendation}</p>
        </details>
      )}
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

function QcStopActions({
  review,
  busy,
  onCancel,
  onStopAll,
}: {
  review: V2ConversationPlanReviewT;
  busy: boolean;
  onCancel: QcWorkspaceProps["onCancel"];
  onStopAll: QcWorkspaceProps["onStopAll"];
}): React.ReactElement {
  return (
    <>
      <Button variant="danger" disabled={busy} onClick={() => void onStopAll(review)}>
        Stop QC and Agents
      </Button>
      <Button disabled={busy} onClick={() => void onCancel(review, "Stopped by the user.")}>
        Stop QC
      </Button>
    </>
  );
}

function FindingTriage({
  review,
  findings,
  busy,
  onTriage,
  onRejectAll,
  onCancel,
  onStopAll,
}: {
  review: V2ConversationPlanReviewT;
  findings: V2ConversationPlanReviewFindingT[];
  busy: boolean;
  onTriage: QcWorkspaceProps["onTriage"];
  onRejectAll: () => Promise<void>;
  onCancel: QcWorkspaceProps["onCancel"];
  onStopAll: QcWorkspaceProps["onStopAll"];
}): React.ReactElement {
  const [mode, setMode] = useState<"all" | "individual" | "none">("all");
  const [selected, setSelected] = useState(() => new Set(findings.map((finding) => finding.id)));
  const selectedCount = selected.size;
  const decisions = (accepted: Set<string>) =>
    Object.fromEntries(
      findings.map((finding) => [finding.id, accepted.has(finding.id) ? "accept" : "reject"]),
    ) as Record<string, "accept" | "reject">;

  return (
    <section className="qc-new-decision" aria-labelledby="qc-triage-title">
      <div className="qc-new-decision-copy">
        <h2 id="qc-triage-title">Which findings should the PM act on?</h2>
      </div>

      <div className="qc-new-choice-grid">
        <button
          type="button"
          className={`qc-new-choice${mode === "all" ? " is-primary" : ""}`}
          aria-pressed={mode === "all"}
          disabled={busy}
          onClick={() => {
            setMode("all");
            setSelected(new Set(findings.map((finding) => finding.id)));
          }}
        >
          <strong>Accept all {findings.length}</strong>
        </button>
        <button
          type="button"
          className={`qc-new-choice${mode === "individual" ? " is-primary" : ""}`}
          aria-pressed={mode === "individual"}
          disabled={busy}
          onClick={() => setMode("individual")}
        >
          <strong>Choose individually</strong>
        </button>
        <button
          type="button"
          className={`qc-new-choice is-danger${mode === "none" ? " is-selected" : ""}`}
          aria-pressed={mode === "none"}
          disabled={busy}
          onClick={() => setMode("none")}
        >
          <strong>Accept none</strong>
        </button>
      </div>

      <fieldset className="qc-new-triage-actions" aria-label="Quality control actions">
        <QcStopActions review={review} busy={busy} onCancel={onCancel} onStopAll={onStopAll} />
        {mode === "none" ? (
          <Button variant="danger" disabled={busy} onClick={() => void onRejectAll()}>
            {busy ? "Recording…" : "Keep current plan"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || (mode === "individual" && selectedCount === 0)}
            onClick={() =>
              void onTriage(
                review,
                decisions(
                  mode === "all" ? new Set(findings.map((finding) => finding.id)) : selected,
                ),
              )
            }
          >
            {busy ? "Sending…" : "Send to PM"}
          </Button>
        )}
      </fieldset>

      {mode === "individual" && selectedCount === 0 ? (
        <p className="qc-new-selection-note">Select at least one finding, or choose Accept none.</p>
      ) : null}

      <ul className="qc-new-findings">
        {findings.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            selectable={mode === "individual"}
            selected={mode === "all" || selected.has(finding.id)}
            onSelected={(checked) =>
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(finding.id);
                else next.delete(finding.id);
                return next;
              })
            }
            showRecommendation
          />
        ))}
      </ul>

      {mode === "none" ? (
        <div className="qc-new-confirm" role="alert">
          <strong>The PM will not receive any findings.</strong>
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
  onStopAll,
  onConfirmAction,
}: QcWorkspaceProps): React.ReactElement {
  const findings = useMemo(() => visibleFindings(review), [review]);
  const currentFindings = useMemo(() => pausedRoundFindings(review, findings), [review, findings]);
  const round = currentRound(review);
  const terminal = TERMINAL.has(review.status);
  const awaitingFindingDecision =
    review.status === "awaiting_human" && review.paused_checkpoint === "after_review";
  const visibleError = error && !/not awaiting human input/i.test(error) ? error : null;
  const accepted = (review.finding_decisions ?? []).filter(
    (item) => item.decision === "accept",
  ).length;
  const stageTitle = `Round ${terminal ? review.rounds_completed : round} of ${review.max_rounds}`;
  const stageDetail =
    review.status === "awaiting_human" && review.paused_checkpoint === "after_review"
      ? `Reviewer pass complete. ${currentFindings.length} finding${currentFindings.length === 1 ? " is" : "s are"} waiting for your decision before the PM can revise anything.`
      : review.status === "awaiting_human" && review.paused_checkpoint === "after_revision"
        ? "Plan revision complete. Review the PM response before continuing."
        : review.status === "awaiting_human"
          ? "This round needs your ruling before QC can continue."
          : review.status === "converged"
            ? "Quality review passed. Approve this plan to begin development."
            : review.status === "cap_reached"
              ? "QC used the available rounds. Review the record and decide whether to proceed."
              : review.status === "failed"
                ? "The plan is unchanged. Choose a recovery path without leaving QC."
                : review.status === "cancelled"
                  ? "The review was stopped. The plan remains unchanged."
                  : null;
  const activeAgent = activeQcAgent(review);

  return (
    <main className="qc-new-workspace" data-testid="qc-new-workspace">
      <header className="qc-new-header">
        <div>
          <h1>Quality control</h1>
          <p className="qc-new-stage-title">{stageTitle}</p>
          {stageDetail ? <p className="qc-new-header-detail">{stageDetail}</p> : null}
          <p className="qc-new-agent-identity">
            <span>{activeAgent.state}</span>
            <strong>{activeAgent.role}</strong>
            <span>
              {activeAgent.provider} · {activeAgent.model}
            </span>
          </p>
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
        <QcProgressPopout review={review} accepted={accepted} />
      ) : null}

      {review.status === "awaiting_human" && review.paused_checkpoint === "after_review" ? (
        <FindingTriage
          review={review}
          findings={currentFindings}
          busy={busy}
          onTriage={onTriage}
          onRejectAll={() => onContinueWithoutQc(review)}
          onCancel={onCancel}
          onStopAll={onStopAll}
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

      {!terminal && !awaitingFindingDecision ? (
        <QcStopActions review={review} busy={busy} onCancel={onCancel} onStopAll={onStopAll} />
      ) : null}

      {visibleError ? (
        <output className="qc-new-error" role="alert">
          {visibleError}
        </output>
      ) : null}

      {!awaitingFindingDecision ? (
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
      ) : null}
    </main>
  );
}
