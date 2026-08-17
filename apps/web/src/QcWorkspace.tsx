import type {
  V2ConversationActionT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useEffect, useMemo, useState } from "react";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { aiProviderLabel } from "./aiProviders";
import type { QcModeT } from "./conversationApi";
import { Button, Select } from "./ui";
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
  history?: V2ConversationPlanReviewT[];
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
  onChat: (
    review: V2ConversationPlanReviewT,
    channel: "reviewer" | "pm",
    message: string,
  ) => Promise<void>;
  onConfirmAction: (action: V2ConversationActionT, qcMode?: QcModeT) => Promise<void>;
  view?: "qc" | "plan_review";
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
  if (TERMINAL.has(review.status)) return Math.max(1, review.rounds_completed);
  if (review.paused_at_round !== null) return review.paused_at_round;
  const live = review.live_progress;
  if (live?.round) return live.round;
  return Math.max(1, Math.min(review.rounds_completed + 1, review.max_rounds));
}

export interface QcReviewJourney {
  active: "qc" | "pm" | "complete";
  round: number;
  maxRounds: number;
}

function pmOwnsReviewStep(review: V2ConversationPlanReviewT): boolean {
  const live = review.live_progress;
  const liveIsPm =
    live?.provider === review.pm_provider && live.model !== null && live.model === review.pm_model;
  const waitingOnHuman = review.status === "awaiting_human";
  return (
    liveIsPm ||
    (waitingOnHuman && review.paused_checkpoint === "after_revision") ||
    (!waitingOnHuman && !live && (review.finding_decisions?.length ?? 0) > 0)
  );
}

export function qcReviewJourney(review: V2ConversationPlanReviewT): QcReviewJourney {
  return {
    active: TERMINAL.has(review.status) ? "complete" : pmOwnsReviewStep(review) ? "pm" : "qc",
    round: currentRound(review),
    maxRounds: review.max_rounds,
  };
}

function activeQcAgent(review: V2ConversationPlanReviewT): {
  state: string;
  role: string;
  provider: string;
  model: string;
} {
  const waitingOnHuman = review.status === "awaiting_human";
  const pmOwnsStep = pmOwnsReviewStep(review);
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

function speakerLabel(
  speaker: V2ConversationPlanReviewT["chat_messages"][number]["speaker"],
): string {
  if (speaker === "reviewer") return "Independent reviewer";
  if (speaker === "pm") return "Planning manager";
  if (speaker === "human") return "You";
  return "QC workflow";
}

type StructuredQcFinding = Pick<
  V2ConversationPlanReviewFindingT,
  "severity" | "module_id" | "finding" | "recommendation"
>;

type QcMessageSpeaker = V2ConversationPlanReviewT["chat_messages"][number]["speaker"];

type StructuredPmResponse = {
  finding_index: number;
  disposition: "accept" | "rebut";
  rationale: string;
};

type StructuredPmChange = Record<string, unknown> & {
  op: string;
  finding_indices: number[];
};

type StructuredPmRevision = {
  responses: StructuredPmResponse[];
  changes: StructuredPmChange[];
  plan: Record<string, unknown> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredJson(content: string): Record<string, unknown> | null {
  let source = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  if (fenced?.[1]) source = fenced[1];
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function structuredQcFindings(content: string): StructuredQcFinding[] | null {
  const parsed = structuredJson(content);
  if (!parsed) return null;
  try {
    if (!parsed || !Array.isArray(parsed.findings) || parsed.findings.length === 0) return null;
    const findings = parsed.findings.filter(
      (candidate): candidate is StructuredQcFinding =>
        typeof candidate === "object" &&
        candidate !== null &&
        ["must_fix", "should_fix", "suggestion"].includes(
          String((candidate as { severity?: unknown }).severity),
        ) &&
        (typeof (candidate as { module_id?: unknown }).module_id === "string" ||
          (candidate as { module_id?: unknown }).module_id === null) &&
        typeof (candidate as { finding?: unknown }).finding === "string" &&
        typeof (candidate as { recommendation?: unknown }).recommendation === "string",
    );
    return findings.length === parsed.findings.length ? findings : null;
  } catch {
    return null;
  }
}

function structuredPmRevision(content: string): StructuredPmRevision | null {
  const parsed = structuredJson(content);
  if (!parsed || !Array.isArray(parsed.responses)) return null;
  const responses = parsed.responses.filter(
    (candidate): candidate is StructuredPmResponse =>
      isRecord(candidate) &&
      Number.isInteger(candidate.finding_index) &&
      Number(candidate.finding_index) >= 0 &&
      ["accept", "rebut"].includes(String(candidate.disposition)) &&
      typeof candidate.rationale === "string",
  );
  if (responses.length !== parsed.responses.length) return null;

  const rawChanges = parsed.changes;
  const changes = Array.isArray(rawChanges)
    ? rawChanges.filter(
        (candidate): candidate is StructuredPmChange =>
          isRecord(candidate) &&
          typeof candidate.op === "string" &&
          Array.isArray(candidate.finding_indices) &&
          candidate.finding_indices.every((index) => Number.isInteger(index) && Number(index) >= 0),
      )
    : [];
  if (Array.isArray(rawChanges) && changes.length !== rawChanges.length) return null;

  const plan = isRecord(parsed.plan) ? parsed.plan : null;
  if (!Array.isArray(rawChanges) && !plan) return null;
  return { responses, changes, plan };
}

function phaseScope(moduleId: unknown, phaseNumbers: ReadonlyMap<string, number>): string | null {
  if (typeof moduleId !== "string") return null;
  const phase = phaseNumbers.get(moduleId);
  return `${phase ? `Phase ${phase}` : "Plan phase"} · ${moduleId}`;
}

function readableList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    if (typeof item.description !== "string") return [];
    return [
      typeof item.mitigation === "string" && item.mitigation.trim()
        ? `${item.description} — ${item.mitigation}`
        : item.description,
    ];
  });
}

function readableFieldName(field: string): string {
  return field.replaceAll("_", " ");
}

function pmChangePresentation(
  change: StructuredPmChange,
  phaseNumbers: ReadonlyMap<string, number>,
): { title: string; scope: string; detail?: string; items?: string[] } {
  const scope = phaseScope(change.module_id, phaseNumbers) ?? "Plan-wide";
  const module = isRecord(change.module) ? change.module : null;
  const patch = isRecord(change.patch) ? change.patch : null;
  const staffing = isRecord(change.staffing) ? change.staffing : null;

  switch (change.op) {
    case "set_objective":
      return {
        title: "Updated the plan objective",
        scope,
        ...(typeof change.value === "string" ? { detail: change.value } : {}),
      };
    case "set_assumptions":
      return { title: "Updated assumptions", scope, items: readableList(change.value) };
    case "set_risks":
      return { title: "Updated risks and mitigations", scope, items: readableList(change.value) };
    case "set_out_of_scope":
      return { title: "Updated what is out of scope", scope, items: readableList(change.value) };
    case "set_verification_requirements":
      return { title: "Updated final verification", scope, items: readableList(change.value) };
    case "set_open_decisions":
      return { title: "Updated open decisions", scope, items: readableList(change.value) };
    case "set_estimated_budget": {
      const value = isRecord(change.value) ? change.value : null;
      const amount = typeof value?.amount === "number" ? value.amount.toFixed(2) : null;
      const currency = typeof value?.currency === "string" ? value.currency : "";
      return {
        title: "Updated the estimated budget",
        scope,
        ...(amount ? { detail: `${currency} ${amount}`.trim() } : {}),
      };
    }
    case "add_module":
    case "replace_module":
      return {
        title: `${change.op === "add_module" ? "Added" : "Replaced"} ${typeof module?.title === "string" ? module.title : "a development phase"}`,
        scope: phaseScope(module?.id, phaseNumbers) ?? scope,
        ...(typeof module?.description === "string" ? { detail: module.description } : {}),
      };
    case "patch_module": {
      const changedFields = patch ? Object.keys(patch).map(readableFieldName) : [];
      return {
        title: "Updated a development phase",
        scope,
        ...(typeof patch?.description === "string"
          ? { detail: patch.description }
          : changedFields.length > 0
            ? { detail: `Changed ${changedFields.join(", ")}.` }
            : {}),
      };
    }
    case "remove_module":
      return { title: "Removed a development phase", scope };
    case "add_staffing":
    case "replace_staffing": {
      const identity = [staffing?.agent_role, staffing?.provider, staffing?.model]
        .filter((value): value is string => typeof value === "string")
        .join(" · ");
      return {
        title: `${change.op === "add_staffing" ? "Assigned" : "Changed"} the implementation agent`,
        scope,
        ...(identity ? { detail: identity } : {}),
      };
    }
    case "remove_staffing":
      return { title: "Removed the implementation agent", scope };
    default:
      return { title: readableFieldName(change.op), scope };
  }
}

function planRevisionSummary(plan: Record<string, unknown>): {
  objective: string | null;
  phases: Array<{ id: string | null; title: string }>;
} {
  const contract = isRecord(plan.plan) ? plan.plan : null;
  const modules = Array.isArray(contract?.modules) ? contract.modules : [];
  return {
    objective: typeof contract?.objective === "string" ? contract.objective : null,
    phases: modules.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.title === "string"
        ? [
            {
              id: typeof candidate.id === "string" ? candidate.id : null,
              title: candidate.title,
            },
          ]
        : [],
    ),
  };
}

function PmRevisionContent({
  revision,
  phaseNumbers,
}: {
  revision: StructuredPmRevision;
  phaseNumbers: ReadonlyMap<string, number>;
}): React.ReactElement {
  const plan = revision.plan ? planRevisionSummary(revision.plan) : null;
  return (
    <section
      className="qc-structured-response qc-pm-revision"
      aria-label="Planning manager revision"
    >
      <header>
        <strong>Planning manager revision</strong>
        <span>
          {revision.responses.length} {revision.responses.length === 1 ? "response" : "responses"}
          {revision.changes.length > 0
            ? ` · ${revision.changes.length} ${revision.changes.length === 1 ? "plan change" : "plan changes"}`
            : plan
              ? " · complete revised plan"
              : ""}
        </span>
      </header>
      {revision.responses.length > 0 ? (
        <ul className="qc-pm-responses" aria-label="Responses to QC findings">
          {revision.responses.map((response) => (
            <li
              key={`${response.finding_index}:${response.disposition}`}
              data-disposition={response.disposition}
            >
              <header>
                <strong>Finding {response.finding_index + 1}</strong>
                <span>{response.disposition === "accept" ? "Accepted" : "Rebutted"}</span>
              </header>
              <p>{response.rationale}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {revision.changes.length > 0 ? (
        <section className="qc-pm-changes" aria-label="Applied plan changes">
          <h4>Applied plan changes</h4>
          <ol>
            {revision.changes.map((change, index) => {
              const presentation = pmChangePresentation(change, phaseNumbers);
              return (
                <li key={`${change.op}:${index}`}>
                  <header>
                    <strong>{presentation.title}</strong>
                    <span>{presentation.scope}</span>
                  </header>
                  {presentation.detail ? <p>{presentation.detail}</p> : null}
                  {presentation.items && presentation.items.length > 0 ? (
                    <ul>
                      {presentation.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  <small>
                    Addresses finding{change.finding_indices.length === 1 ? "" : "s"}{" "}
                    {change.finding_indices.map((finding) => finding + 1).join(", ")}
                  </small>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {plan ? (
        <section className="qc-pm-plan-summary" aria-label="Complete revised plan summary">
          <h4>Complete revised plan</h4>
          {plan.objective ? <p>{plan.objective}</p> : null}
          {plan.phases.length > 0 ? (
            <ol>
              {plan.phases.map((phase, index) => (
                <li key={phase.id ?? `${phase.title}:${index}`}>
                  <span>Phase {index + 1}</span>
                  <strong>{phase.title}</strong>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function QcMessageContent({
  content,
  phaseNumbers = new Map(),
  speaker,
  streaming = false,
}: {
  content: string;
  phaseNumbers?: ReadonlyMap<string, number>;
  speaker?: QcMessageSpeaker;
  streaming?: boolean;
}): React.ReactElement {
  const pmRevision = speaker === "pm" ? structuredPmRevision(content) : null;
  if (pmRevision) {
    return <PmRevisionContent revision={pmRevision} phaseNumbers={phaseNumbers} />;
  }
  const findings = structuredQcFindings(content);
  if (!findings) {
    if (streaming && /^[{[]/.test(content.trim())) {
      return (
        <p className="qc-message-text qc-structured-streaming">
          Receiving and organizing the structured response…
        </p>
      );
    }
    return <p className="qc-message-text">{content}</p>;
  }
  return (
    <section className="qc-structured-response" aria-label="Structured QC findings">
      <header>
        <strong>
          {findings.length} {findings.length === 1 ? "finding" : "findings"}
        </strong>
      </header>
      <ul className="qc-structured-findings">
        {findings.map((finding, index) => (
          <li key={`${finding.module_id ?? "plan"}:${index}`} data-severity={finding.severity}>
            <header>
              <span>{severityLabel(finding.severity)}</span>
              <small>
                {finding.module_id
                  ? `${phaseNumbers.has(finding.module_id) ? `Phase ${phaseNumbers.get(finding.module_id)}` : "Plan phase"} · ${finding.module_id}`
                  : "Plan-wide"}
              </small>
            </header>
            <p>{finding.finding}</p>
            <div>
              <strong>Recommendation</strong>
              <p>{finding.recommendation}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QcLiveDialogue({
  review,
  history = [],
  phaseNumbers,
}: {
  review: V2ConversationPlanReviewT;
  history?: V2ConversationPlanReviewT[];
  phaseNumbers?: ReadonlyMap<string, number>;
}): React.ReactElement {
  const messages = [...history]
    .reverse()
    .flatMap((pastReview) => pastReview.chat_messages)
    .concat(review.chat_messages)
    .filter(
      (message) =>
        !(
          message.speaker === "workflow" &&
          /^WORK PLAN CONTRACT ENVELOPE\b/i.test(message.content.trim())
        ),
    )
    .slice(-60);
  const historicalFindings = [...history]
    .reverse()
    .flatMap((pastReview) =>
      pastReview.round_exchanges.flatMap((exchange) =>
        exchange.reviewer.findings.length > 0
          ? [{ review: pastReview, round: exchange.round, findings: exchange.reviewer.findings }]
          : [],
      ),
    );
  const liveOutput = review.live_progress?.output_preview?.trim() ?? "";
  return (
    <section className="qc-live-dialogue" aria-label="Live quality-control dialogue">
      <header>
        <div>
          <strong>Visible agent dialogue</strong>
          <span>Updates automatically while QC is working</span>
        </div>
        {liveOutput ? <b>LIVE</b> : null}
      </header>
      {historicalFindings.length > 0 || messages.length > 0 || liveOutput ? (
        <ol>
          {historicalFindings.map((entry) => (
            <li
              key={`${entry.review.id}:round:${entry.round}`}
              className="is-history"
              data-speaker="reviewer"
            >
              <header>
                <strong>Independent reviewer</strong>
                <span>
                  Prior attempt {entry.review.attempt_number} · Round {entry.round}
                </span>
              </header>
              <QcMessageContent
                content={JSON.stringify({ findings: entry.findings })}
                phaseNumbers={phaseNumbers}
                speaker="reviewer"
              />
            </li>
          ))}
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
                <QcMessageContent
                  content={message.content}
                  phaseNumbers={phaseNumbers}
                  speaker={message.speaker}
                />
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
              <QcMessageContent
                content={liveOutput}
                phaseNumbers={phaseNumbers}
                speaker={review.live_progress?.stage === "revising" ? "pm" : "reviewer"}
                streaming
              />
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

function QcQuestionBox({
  review,
  channel,
  busy,
  onChat,
}: {
  review: V2ConversationPlanReviewT;
  channel: "reviewer" | "pm";
  busy: boolean;
  onChat: QcWorkspaceProps["onChat"];
  phaseNumbers?: ReadonlyMap<string, number>;
}): React.ReactElement {
  const [question, setQuestion] = useState("");
  const label = channel === "reviewer" ? "QC reviewer" : "Project Manager";
  return (
    <section className="qc-agent-chat" aria-label={`Chat with the ${label}`}>
      <h3 className="sr-only">Chat with the {label}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const message = question.trim();
          if (!message || busy) return;
          setQuestion("");
          void onChat(review, channel, message);
        }}
      >
        <textarea
          value={question}
          maxLength={8_000}
          disabled={busy}
          aria-label={`Question for the ${label}`}
          placeholder={`Ask the ${label} about the findings, recommendation, or revised plan…`}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button type="submit" disabled={busy || !question.trim()}>
          {busy ? "Waiting…" : `Ask ${label}`}
        </Button>
      </form>
    </section>
  );
}

function QcProgressPopout({
  review,
  accepted,
  phaseNumbers,
}: {
  review: V2ConversationPlanReviewT;
  accepted: number;
  phaseNumbers: ReadonlyMap<string, number>;
}): React.ReactElement | null {
  const live = review.live_progress;
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
        <header className="qc-progress-focus">
          <span>WORKING AREA</span>
          <h3>Waiting for the independent reviewer</h3>
          <p>This panel stays in place and updates as review activity arrives.</p>
        </header>
        <section className="qc-progress-panel">
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
              <dt>Elapsed this step</dt>
              <dd>{durationLabel(queuedSeconds)}</dd>
            </div>
            <div>
              <dt>Estimated</dt>
              <dd>Calculating after the reviewer starts</dd>
            </div>
          </dl>
        </section>
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
  const planningManagerActive = pmOwnsReviewStep(review);

  return (
    <aside className="qc-progress-popout" aria-label="Quality control progress" aria-live="polite">
      <header className="qc-progress-focus">
        <span>WORKING AREA</span>
        <h3>
          {planningManagerActive
            ? "Planning manager is reviewing the QC findings"
            : "Independent reviewer is checking the plan"}
        </h3>
        <p>Progress and readable agent dialogue update directly below.</p>
      </header>
      <section className="qc-progress-panel">
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
              ? "This step is over its typical time, but QC is still active. The live dialogue below updates as visible output arrives."
              : "No review checkpoint has completed yet. The live dialogue below updates as visible output arrives."}
          </p>
        ) : null}
        <dl>
          <div>
            <dt>Elapsed this step</dt>
            <dd>{durationLabel(stepElapsed)}</dd>
          </div>
          {totalElapsed > stepElapsed + 1 ? (
            <div>
              <dt>Total review</dt>
              <dd>{durationLabel(totalElapsed)}</dd>
            </div>
          ) : null}
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
  status,
  phaseNumber,
}: {
  finding: V2ConversationPlanReviewFindingT;
  selectable: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  response?: { disposition: "accept" | "rebut"; rationale: string } | null;
  status?: { label: string; tone: "neutral" | "success" | "warn" | "muted" };
  phaseNumber?: number;
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
          <span className="qc-new-finding-title">
            <strong>{finding.finding}</strong>
            {status ? (
              <span className="qc-new-finding-status" data-tone={status.tone}>
                {status.label}
              </span>
            ) : null}
          </span>
          <small>
            {finding.module_id
              ? `${phaseNumber ? `Phase ${phaseNumber}` : "Plan phase"} · ${finding.module_id}`
              : "Plan-wide"}
          </small>
        </div>
      </div>
      <div className="qc-new-finding-recommendation">
        <strong>Recommendation</strong>
        <p>{finding.recommendation}</p>
      </div>
      {response ? (
        <div className="qc-new-finding-response">
          <strong>PM response</strong>
          <p>
            <strong>{response.disposition === "accept" ? "Accepted: " : "Rebutted: "}</strong>
            {response.rationale}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function findingStatus(
  review: V2ConversationPlanReviewT,
  finding: V2ConversationPlanReviewFindingT,
): { label: string; tone: "neutral" | "success" | "warn" | "muted" } {
  const decision = review.finding_decisions?.find((item) => item.finding_id === finding.id);
  const disposition = review.dispositions.find((item) => item.finding_id === finding.id);

  if (decision?.decision === "reject") return { label: "Excluded by you", tone: "muted" };
  if (disposition?.adjudication?.ruling === "reviewer") {
    return { label: "Reviewer position chosen", tone: "success" };
  }
  if (disposition?.adjudication?.ruling === "pm") {
    return { label: "PM position chosen", tone: "success" };
  }
  if (disposition?.adjudication?.ruling === "supplied_fact") {
    return { label: "Resolved with supplied fact", tone: "success" };
  }
  if (disposition?.disposition === "accept") {
    return { label: "Accepted by PM", tone: "success" };
  }
  if (disposition?.disposition === "rebut") {
    return { label: "Rebutted by PM", tone: "warn" };
  }
  if (decision?.decision === "accept") return { label: "Sent to PM", tone: "neutral" };
  return { label: "Awaiting your decision", tone: "neutral" };
}

function reviewRecordSummary(
  review: V2ConversationPlanReviewT,
  findings: V2ConversationPlanReviewFindingT[],
): string {
  if (findings.length === 0) return "QC completed without recording any findings.";

  const decisions = review.finding_decisions ?? [];
  const sent = decisions.filter((item) => item.decision === "accept").length;
  const excluded = decisions.filter((item) => item.decision === "reject").length;
  const acceptedByPm = review.dispositions.filter((item) => item.disposition === "accept").length;
  const rebuttedByPm = review.dispositions.filter((item) => item.disposition === "rebut").length;
  const parts = [
    `${findings.length} QC finding${findings.length === 1 ? " was" : "s were"} recorded.`,
  ];
  if (decisions.length > 0) {
    parts.push(`${sent} sent to the PM; ${excluded} excluded by you.`);
  }
  if (review.dispositions.length > 0) {
    parts.push(`${acceptedByPm} accepted by the PM; ${rebuttedByPm} rebutted by the PM.`);
  }
  return parts.join(" ");
}

function QcPlanVersion({
  planVersion,
  heading,
}: {
  planVersion: V2WorkPlanVersionT | null;
  heading: string;
}): React.ReactElement {
  return (
    <section className="qc-new-plan-review" aria-labelledby="qc-current-plan-title">
      <header>
        <div>
          <h3 id="qc-current-plan-title">{heading}</h3>
          <p>
            {planVersion
              ? `Exact saved plan version ${planVersion.version}, including its changes from the prior version.`
              : "The saved plan preview is not available yet."}
          </p>
        </div>
      </header>
      {planVersion ? <ConversationPlanCard version={planVersion} /> : null}
    </section>
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
  onChat,
  onCancel,
  onStopAll,
  phaseNumbers,
}: {
  review: V2ConversationPlanReviewT;
  findings: V2ConversationPlanReviewFindingT[];
  busy: boolean;
  onTriage: QcWorkspaceProps["onTriage"];
  onRejectAll: () => Promise<void>;
  onChat: QcWorkspaceProps["onChat"];
  onCancel: QcWorkspaceProps["onCancel"];
  onStopAll: QcWorkspaceProps["onStopAll"];
  phaseNumbers: ReadonlyMap<string, number>;
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
        <p>Choose one clear action. You can ask the reviewer questions before sending anything.</p>
      </div>

      <ul className="qc-new-findings">
        {findings.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            selectable={mode === "individual"}
            selected={mode === "all" || selected.has(finding.id)}
            phaseNumber={finding.module_id ? phaseNumbers.get(finding.module_id) : undefined}
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

      <fieldset className="qc-new-triage-actions" aria-label="Quality control actions">
        <label className="qc-triage-select" htmlFor={`qc-finding-action-${review.id}`}>
          <span>What should happen next?</span>
          <Select
            id={`qc-finding-action-${review.id}`}
            aria-label="Quality control finding action"
            value={mode}
            disabled={busy}
            onChange={(event) => {
              const nextMode = event.target.value as "all" | "individual" | "none";
              setMode(nextMode);
              if (nextMode === "all") {
                setSelected(new Set(findings.map((finding) => finding.id)));
              }
            }}
          >
            <option value="all">Send all {findings.length} findings to the PM</option>
            <option value="individual">Choose findings to send</option>
            <option value="none">Keep the current plan and skip these findings</option>
          </Select>
        </label>
        {mode === "none" ? (
          <Button variant="primary" disabled={busy} onClick={() => void onRejectAll()}>
            {busy ? "Recording…" : "Keep plan and skip remaining QC"}
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
            {busy
              ? "Sending…"
              : mode === "all"
                ? `Send all ${findings.length} to PM`
                : `Send ${selectedCount} to PM`}
          </Button>
        )}
      </fieldset>

      {mode === "individual" && selectedCount === 0 ? (
        <p className="qc-new-selection-note">
          Select at least one finding, or choose to keep the current plan.
        </p>
      ) : null}

      <QcQuestionBox
        review={review}
        channel="reviewer"
        busy={busy}
        onChat={onChat}
        phaseNumbers={phaseNumbers}
      />

      <details className="qc-stop-options">
        <summary>Stop options</summary>
        <div>
          <QcStopActions review={review} busy={busy} onCancel={onCancel} onStopAll={onStopAll} />
        </div>
      </details>

      {mode === "none" ? (
        <div className="qc-new-confirm" role="alert">
          <strong>
            The PM will not receive these findings and the current plan will move to final review.
          </strong>
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
  actions,
  busy,
  error,
  onTriage,
  onResume,
  onAdjudicate,
  onContinueWithoutQc,
  onCancel,
  onStopAll,
  onChat,
  onConfirmAction,
  view,
  history = [],
}: QcWorkspaceProps): React.ReactElement {
  const findings = useMemo(() => visibleFindings(review), [review]);
  const phaseNumbers = useMemo(
    () =>
      new Map(
        (planVersion?.plan.plan.modules ?? []).map((module, index) => [module.id, index + 1]),
      ),
    [planVersion],
  );
  const currentFindings = useMemo(() => pausedRoundFindings(review, findings), [review, findings]);
  const round = currentRound(review);
  const terminal = TERMINAL.has(review.status);
  const isPlanReview = terminal && (view === "plan_review" || view === undefined);
  const awaitingFindingDecision =
    review.status === "awaiting_human" && review.paused_checkpoint === "after_review";
  const visibleError = error && !/not awaiting human input/i.test(error) ? error : null;
  const accepted = (review.finding_decisions ?? []).filter(
    (item) => item.decision === "accept",
  ).length;
  const stageTitle = isPlanReview
    ? "Final plan decision"
    : `Round ${terminal ? review.rounds_completed : round} of ${review.max_rounds}`;
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
                  : pmOwnsReviewStep(review)
                    ? "The planning manager is reviewing the QC findings you selected. Follow its progress and dialogue directly below."
                    : "The independent reviewer is checking the plan. Follow its progress and dialogue directly below.";
  const activeAgent = activeQcAgent(review);

  return (
    <section
      className={`qc-new-workspace${isPlanReview ? " is-plan-review" : ""}`}
      data-testid="qc-new-workspace"
      aria-labelledby="qc-workspace-title"
    >
      <header className="qc-new-header">
        <div>
          <h2 id="qc-workspace-title">{isPlanReview ? "Plan review" : "Quality control"}</h2>
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

      {!isPlanReview && !terminal && review.status !== "awaiting_human" ? (
        <QcProgressPopout review={review} accepted={accepted} phaseNumbers={phaseNumbers} />
      ) : null}

      {!isPlanReview ? (
        <QcLiveDialogue review={review} history={history} phaseNumbers={phaseNumbers} />
      ) : null}

      {!isPlanReview &&
      findings.length > 0 &&
      (terminal ||
        (review.status === "awaiting_human" && review.paused_checkpoint === "after_revision")) ? (
        <ul className="qc-new-findings is-readonly" aria-label="Quality control findings">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              selectable={false}
              selected={false}
              onSelected={() => undefined}
              response={review.dispositions.find((item) => item.finding_id === finding.id) ?? null}
              status={findingStatus(review, finding)}
              phaseNumber={finding.module_id ? phaseNumbers.get(finding.module_id) : undefined}
            />
          ))}
        </ul>
      ) : null}

      {!isPlanReview &&
      review.status === "awaiting_human" &&
      review.paused_checkpoint === "after_review" ? (
        <FindingTriage
          review={review}
          findings={currentFindings}
          busy={busy}
          onTriage={onTriage}
          onRejectAll={() => onContinueWithoutQc(review)}
          onChat={onChat}
          onCancel={onCancel}
          onStopAll={onStopAll}
          phaseNumbers={phaseNumbers}
        />
      ) : null}

      {!isPlanReview &&
      review.status === "awaiting_human" &&
      review.paused_checkpoint === "after_revision" ? (
        <section className="qc-new-decision">
          <div className="qc-new-decision-copy">
            <span>REVISION SAVED</span>
            <h2>The PM finished the selected changes</h2>
            <p>The plan remains inside QC. Send this revision directly to the reviewer.</p>
          </div>
          <QcPlanVersion planVersion={planVersion} heading="Review the revised plan" />
          <QcQuestionBox
            review={review}
            channel="pm"
            busy={busy}
            onChat={onChat}
            phaseNumbers={phaseNumbers}
          />
          <div className="qc-new-decision-bar">
            <span>Plan version {planVersion?.version ?? "updated"}</span>
            <Button disabled={busy} onClick={() => void onContinueWithoutQc(review)}>
              Skip remaining QC
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void onResume(review, "continue")}
            >
              Send revision to QC
            </Button>
          </div>
        </section>
      ) : null}

      {!isPlanReview &&
      review.status === "awaiting_human" &&
      review.paused_checkpoint === "adjudication" ? (
        <AdjudicationDecision
          review={review}
          findings={findings}
          busy={busy}
          onAdjudicate={onAdjudicate}
        />
      ) : null}

      {isPlanReview ? (
        <section className="qc-new-outcome">
          <div>
            <span>{review.status === "converged" ? "REVIEW COMPLETE" : "DECISION REQUIRED"}</span>
            <h2>
              {review.status === "converged"
                ? "The plan is ready to build"
                : review.status === "cap_reached"
                  ? "Final plan review"
                  : "Choose a recovery path"}
            </h2>
            <p>
              {review.status === "failed"
                ? "The plan is unchanged. A fresh QC attempt will use the new finding-triage flow before the PM revises it."
                : reviewRecordSummary(review, findings)}
            </p>
          </div>
          {["converged", "cap_reached"].includes(review.status) ? (
            <QcPlanVersion planVersion={planVersion} heading="Review the exact plan for approval" />
          ) : null}
          <div className="qc-new-outcome-actions">
            {actions.reject ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (actions.reject) void onConfirmAction(actions.reject);
                }}
              >
                Return to PM
              </Button>
            ) : null}
            {actions.repeat ? (
              <Button
                variant={review.status === "failed" ? "primary" : undefined}
                disabled={busy}
                onClick={() => {
                  if (actions.repeat) {
                    void onConfirmAction(actions.repeat, "gated_when_contested");
                  }
                }}
              >
                Additional QC
              </Button>
            ) : null}
            {review.status === "failed" ? (
              <Button disabled={busy} onClick={() => void onContinueWithoutQc(review)}>
                Keep plan without QC
              </Button>
            ) : null}
            {actions.approve && ["converged", "cap_reached"].includes(review.status) ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  if (actions.approve) void onConfirmAction(actions.approve);
                }}
              >
                {busy ? "Opening development…" : "Develop"}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {!isPlanReview && !terminal && !awaitingFindingDecision ? (
        <details className="qc-stop-options">
          <summary>Stop options</summary>
          <div>
            <QcStopActions review={review} busy={busy} onCancel={onCancel} onStopAll={onStopAll} />
          </div>
        </details>
      ) : null}

      {!isPlanReview &&
      !terminal &&
      !(review.status === "awaiting_human" && review.paused_checkpoint === "after_review") &&
      !(review.status === "awaiting_human" && review.paused_checkpoint === "after_revision") ? (
        <QcQuestionBox
          review={review}
          channel={pmOwnsReviewStep(review) ? "pm" : "reviewer"}
          busy={busy}
          onChat={onChat}
          phaseNumbers={phaseNumbers}
        />
      ) : null}

      {visibleError ? (
        <output className="qc-new-error" role="alert">
          {visibleError}
        </output>
      ) : null}
    </section>
  );
}
