import type {
  V2ConversationActionT,
  V2ConversationPlanReviewDispositionT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2ConversationUsageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useState } from "react";
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

function statusTone(
  status: V2ConversationPlanReviewT["status"],
): "default" | "success" | "warn" | "danger" | "info" {
  if (status === "converged") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "cap_reached") return "warn";
  return "info";
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

// What the review is doing right now, derived from the newest recorded event.
function livePhase(review: V2ConversationPlanReviewT): string {
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

function QcChatPanel({
  review,
  channel,
  busy,
  onContinue,
}: {
  review: V2ConversationPlanReviewT;
  channel: "reviewer" | "pm";
  busy: boolean;
  onContinue?: (
    review: V2ConversationPlanReviewT,
    channel: "reviewer" | "pm",
    message: string,
  ) => Promise<void>;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const messages = review.chat_messages.filter((message) => message.channel === channel);
  const artifacts = review.markdown_artifacts.filter((artifact) => artifact.channel === channel);
  const label = channel === "reviewer" ? "QC reviewer chat" : "Planning manager chat";
  return (
    <details className={`conversation-qc-chat is-${channel}`}>
      <summary>
        <span>{label}</span>
        <Badge tone={channel === "reviewer" ? "warn" : "info"}>{messages.length} messages</Badge>
      </summary>
      <div className="conversation-qc-chat-body">
        {messages.length > 0 ? (
          <ol>
            {messages.map((message) => (
              <li key={message.id} className={`is-${message.speaker}`}>
                <header>
                  <strong>
                    {message.speaker === "workflow"
                      ? "QC workflow"
                      : message.speaker === "human"
                        ? "You"
                        : message.speaker === "reviewer"
                          ? "QC reviewer"
                          : "Planning manager"}
                  </strong>
                  <small>
                    Round {message.round} · Attempt {message.attempt} ·{" "}
                    {message.kind.replaceAll("_", " ")}
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
          <p>No raw messages were captured for this chat in this historical attempt.</p>
        )}
        {artifacts.length > 0 ? (
          <section className="conversation-qc-artifacts" aria-label={`${label} Markdown files`}>
            <h5>Markdown artifacts</h5>
            <ul>
              {artifacts.map((artifact) => (
                <li key={artifact.artifact_id}>
                  <a
                    href={artifactContentPath(review.project_id, artifact.artifact_id)}
                    download={artifact.filename}
                  >
                    {artifact.filename}
                  </a>
                  <Badge tone={artifact.valid ? "success" : "warn"}>
                    {artifact.valid ? "applicable" : "partial"}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {(review.status === "failed" || review.status === "awaiting_human") && onContinue ? (
          <section className="conversation-qc-takeover">
            <h5>
              {review.status === "awaiting_human"
                ? "Ask a question"
                : "Temporarily take over this chat"}
            </h5>
            <p>
              {review.status === "awaiting_human"
                ? "Answered in place. This does not advance the paused review — use Continue for that."
                : "Give the agent direct guidance. Its complete reply will be saved verbatim as a new Markdown artifact and supplied as context when you retry QC."}
            </p>
            <label htmlFor={`qc-chat-${review.id}-${channel}`}>
              {review.status === "awaiting_human" ? "Your question" : "Your guidance"}
            </label>
            <TextArea
              id={`qc-chat-${review.id}-${channel}`}
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
          </section>
        ) : null}
      </div>
    </details>
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
          <strong>
            Round {review.paused_at_round} of {review.max_rounds}
          </strong>
          <span>{review.paused_checkpoint ? CHECKPOINT_LABELS[review.paused_checkpoint] : ""}</span>
        </div>
        <div className="conversation-qc-gate-counts">
          {counts.map((severity) => (
            <Badge key={severity.value} tone={severity.tone}>
              {severity.count} {severity.label.toLowerCase()}
            </Badge>
          ))}
        </div>
      </header>
      {spend ? <p className="conversation-qc-gate-spend">{spend}</p> : null}

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
            Continue with a note
          </Button>
        ) : null}
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
              {busy ? "Accepting…" : "Confirm accept now"}
            </Button>
          </span>
        ) : (
          <Button
            className="conversation-qc-gate-accept"
            disabled={busy}
            onClick={() => setConfirmingAccept(true)}
          >
            Accept now
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
              {busy ? "Cancelling…" : "Confirm cancel"}
            </Button>
          </span>
        ) : (
          <Button variant="danger" disabled={busy} onClick={() => setConfirmingCancel(true)}>
            Cancel
          </Button>
        )}
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
  const titleId = `conversation-qc-${review.id}`;
  const terminal = ["converged", "cap_reached", "failed", "cancelled"].includes(review.status);
  const waived = review.review_mode === "waived";
  const percent = Math.min(
    100,
    Math.round((review.rounds_completed / Math.max(1, review.max_rounds)) * 100),
  );
  const lastExchange = review.round_exchanges.at(-1) ?? null;
  const failedAfterReviewer =
    review.status === "failed" &&
    lastExchange !== null &&
    lastExchange.reviewer.findings.length > 0 &&
    lastExchange.pm === null;

  return (
    <article
      className="conversation-qc-card"
      data-testid="conversation-qc-card"
      aria-labelledby={titleId}
    >
      <div className="conversation-qc-pinned">
        <header>
          <div>
            <div className="eyebrow">
              {waived
                ? "QC skipped by human choice"
                : `Cross-provider QC · Attempt ${review.attempt_number}`}
            </div>
            <h3 id={titleId}>
              Plan {planVersion ? `version ${planVersion.version}` : review.plan_version_id}
            </h3>
          </div>
          <Badge tone={statusTone(review.status)}>{review.status.replaceAll("_", " ")}</Badge>
        </header>

        {!terminal ? (
          <>
            <output className="conversation-qc-progress" aria-live="polite">
              <span>{livePhase(review)}</span>
              <span>{percent}%</span>
            </output>
            <div className="conversation-qc-progress-track" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </div>
          </>
        ) : null}
        {!terminal && !waived ? (
          <QcCadenceControl review={review} busy={busy} onPatch={onPatch} />
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

        {!terminal && review.status !== "awaiting_human" && onCancel ? (
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

        {terminal && onConfirmAction ? (
          <section className="conversation-qc-decision" aria-label="Human plan decision">
            <ApprovalEvidence review={review} allReviews={allReviews ?? [review]} />
            <div>
              {actions.approve && ["converged", "cap_reached"].includes(review.status) ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    if (actions.approve) void onConfirmAction(actions.approve);
                  }}
                >
                  Approve plan &amp; start
                </Button>
              ) : null}
              {actions.repeat ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (actions.repeat) void onConfirmAction(actions.repeat);
                  }}
                >
                  {review.status === "failed"
                    ? "Retry QC with retained guidance"
                    : "Run more QC rounds"}
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
                  Stop this plan
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}
        {error ? (
          <output className="conversation-action-error" role="alert">
            {error}
          </output>
        ) : null}
      </div>

      {!waived ? (
        <>
          <QcDetailedStatus review={review} />
          <section className="conversation-qc-chats" aria-label="QC agent chats">
            <div>
              <h4>QC chats</h4>
              <p>Open either conversation to inspect every retained instruction and response.</p>
            </div>
            <QcChatPanel
              review={review}
              channel="reviewer"
              busy={busy}
              onContinue={onContinueChat}
            />
            <QcChatPanel review={review} channel="pm" busy={busy} onContinue={onContinueChat} />
          </section>
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
        <section className="conversation-qc-transcript" aria-labelledby={`${titleId}-transcript`}>
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
                          <li key={`${exchange.round}:response:${disposition.finding_index}`}>
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

      {SEVERITIES.map((severity) => {
        const findings = review.findings.filter((finding) => finding.severity === severity.value);
        if (findings.length === 0) return null;
        return (
          <section
            className={`conversation-qc-group is-${severity.value}`}
            key={severity.value}
            aria-labelledby={`${titleId}-${severity.value}`}
          >
            <div>
              <h4 id={`${titleId}-${severity.value}`}>{severity.label}</h4>
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

      {waived ? (
        <p className="conversation-qc-clear">
          No reviewer was called. You explicitly chose to proceed with the selected execution agent.
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
              <code title={review.plan_content_hash}>{review.plan_content_hash.slice(0, 10)}</code>
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
    </article>
  );
}
