import type {
  V2ConversationActionT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useState } from "react";
import { artifactContentPath } from "./ArtifactImage";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { Badge, Button, TextArea } from "./ui";

const SEVERITIES = [
  { value: "must_fix", label: "Must fix", tone: "danger" },
  { value: "should_fix", label: "Should fix", tone: "warn" },
  { value: "suggestion", label: "Suggestions", tone: "info" },
] as const;

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

function Finding({
  finding,
  review,
}: {
  finding: V2ConversationPlanReviewFindingT;
  review: V2ConversationPlanReviewT;
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
        {review.status === "failed" && onContinue ? (
          <section className="conversation-qc-takeover">
            <h5>Temporarily take over this chat</h5>
            <p>
              Give the agent direct guidance. Its complete reply will be saved verbatim as a new
              Markdown artifact and supplied as context when you retry QC.
            </p>
            <label htmlFor={`qc-chat-${review.id}-${channel}`}>Your guidance</label>
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
                : `Send to ${channel === "reviewer" ? "reviewer" : "planning manager"}`}
            </Button>
          </section>
        ) : null}
      </div>
    </details>
  );
}

export function ConversationQcCard({
  planVersion,
  review,
  actions = {},
  busy = false,
  error = null,
  onCancel,
  onContinueChat,
  onContinueWithoutQc,
  onConfirmAction,
  onReturnToPlanning,
}: {
  planVersion: V2WorkPlanVersionT | null;
  review: V2ConversationPlanReviewT;
  actions?: {
    approve?: V2ConversationActionT | null;
    repeat?: V2ConversationActionT | null;
    skip?: V2ConversationActionT | null;
    reject?: V2ConversationActionT | null;
  };
  busy?: boolean;
  error?: string | null;
  onCancel?: (review: V2ConversationPlanReviewT, reason: string) => Promise<void>;
  onContinueChat?: (
    review: V2ConversationPlanReviewT,
    channel: "reviewer" | "pm",
    message: string,
  ) => Promise<void>;
  onContinueWithoutQc?: (review: V2ConversationPlanReviewT) => Promise<void>;
  onConfirmAction?: (action: V2ConversationActionT) => Promise<void>;
  onReturnToPlanning?: () => void;
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

      {!terminal ? (
        <>
          <output className="conversation-qc-progress" aria-live="polite">
            <span>
              QC is {review.status}. Findings and PM dispositions will appear here after the review
              settles.
            </span>
            <span>{percent}%</span>
          </output>
          <div className="conversation-qc-progress-track" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
        </>
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

      {planVersion ? (
        <details className="conversation-qc-plan-under-review" open>
          <summary>Plan under review · Version {planVersion.version}</summary>
          <ConversationPlanCard version={planVersion} />
        </details>
      ) : null}

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
                <Finding key={finding.id} finding={finding} review={review} />
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

      {!terminal && onCancel ? (
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
      {!terminal && error ? (
        <output className="conversation-action-error" role="alert">
          {error}
        </output>
      ) : null}

      {terminal && onConfirmAction ? (
        <section className="conversation-qc-decision" aria-label="Human plan decision">
          <div>
            <h4>What happens next?</h4>
            <p>
              {review.status === "failed"
                ? "Automated QC is stopped. Review or take over either chat, then choose explicitly."
                : "Review the transcript and final staffing before choosing."}
            </p>
          </div>
          <div>
            {actions.approve && ["converged", "cap_reached"].includes(review.status) ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  if (actions.approve) void onConfirmAction(actions.approve);
                }}
              >
                Approve plan & start
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
          {error ? (
            <output className="conversation-action-error" role="alert">
              {error}
            </output>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}
