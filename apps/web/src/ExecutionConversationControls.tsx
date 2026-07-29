import type {
  V2ConfirmConversationActionResponseT,
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2ConversationPmUpdateSettingsT,
  V2ConversationPmUpdateT,
  V2CreateExecutionActionProposalInputT,
  V2HumanWaitAnswerT,
  V2HumanWaitContinuationT,
  V2HumanWaitT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { useMemo, useState } from "react";
import { ConversationActionCard } from "./ConversationActionCard";
import { Badge, Button, Field, Input, Select, TextArea } from "./ui";

type ProposalActionType = V2CreateExecutionActionProposalInputT["action_type"];
type ActionEffect = V2ConfirmConversationActionResponseT["effect"];

const ACTION_OPTIONS: Array<{ value: ProposalActionType; label: string }> = [
  { value: "record_human_decision", label: "Human decision" },
  { value: "redirect_agent", label: "Task direction" },
  { value: "propose_plan_change", label: "Plan change proposal" },
  { value: "approve_plan_change", label: "Plan-change approval" },
  { value: "pause_work", label: "Stop active agents (pause)" },
  { value: "resume_work", label: "Resume work" },
];

const EXECUTION_ACTION_TYPES = new Set<string>([
  ...ACTION_OPTIONS.map((option) => option.value),
  "answer_human_wait",
]);

export interface HumanWaitView {
  wait: V2HumanWaitT;
  answer: V2HumanWaitAnswerT | null;
  continuation: V2HumanWaitContinuationT | null;
}

function eventsFor(
  actionId: string,
  events: V2ConversationActionDeliveryEventT[],
): V2ConversationActionDeliveryEventT[] {
  return events
    .filter((event) => event.action_id === actionId)
    .sort((left, right) => left.sequence - right.sequence);
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface MockupSelectorOption {
  id: string;
  label: string;
}

export function MockupRequestComposer({
  taskOptions,
  planningPlanVersionId = null,
  artifactOptions,
  busy,
  error,
  disabledReason,
  onPrepare,
}: {
  taskOptions: MockupSelectorOption[];
  planningPlanVersionId?: string | null;
  artifactOptions: MockupSelectorOption[];
  busy: boolean;
  error: string | null;
  disabledReason: string | null;
  onPrepare: (parameters: Record<string, unknown>) => Promise<boolean>;
}): React.ReactElement {
  const [brief, setBrief] = useState("");
  const [taskId, setTaskId] = useState("");
  const [target, setTarget] = useState<"desktop" | "mobile" | "responsive">("responsive");
  const [artifactIds, setArtifactIds] = useState(() => new Set<string>());
  const [open, setOpen] = useState(false);

  return (
    <details
      className="mockup-request-composer"
      data-testid="mockup-request-composer"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title="Generate desktop and mobile screenshots for a plan module or task">
        UI preview
      </summary>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onPrepare({
              brief: brief.trim(),
              target,
              ...(taskId
                ? planningPlanVersionId
                  ? { plan_version_id: planningPlanVersionId, module_id: taskId }
                  : { task_id: taskId }
                : {}),
              artifact_refs: [...artifactIds],
            }).then((created) => {
              if (!created) return;
              setBrief("");
              setArtifactIds(new Set());
            });
          }}
        >
          <p>
            Generate desktop and mobile screenshots for one plan module or task. This only prepares
            the request; you confirm it before an agent runs.
          </p>
          <Field label="Mockup brief">
            <TextArea
              required
              maxLength={8_000}
              value={brief}
              disabled={busy}
              onChange={(event) => setBrief(event.target.value)}
            />
          </Field>
          <Field label={planningPlanVersionId ? "Plan module" : "Task"}>
            <Select
              aria-label="Mockup task"
              value={taskId}
              disabled={busy}
              required
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">
                {planningPlanVersionId ? "Select a plan module" : "Select a task"}
              </option>
              {taskOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Viewport target">
            <Select
              value={target}
              disabled={busy}
              onChange={(event) =>
                setTarget(event.target.value as "desktop" | "mobile" | "responsive")
              }
            >
              <option value="responsive">Desktop and mobile</option>
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
            </Select>
          </Field>
          <fieldset className="mockup-artifact-selector">
            <legend>Reference artifacts (optional)</legend>
            {artifactOptions.length === 0 ? (
              <p className="muted">No project artifacts are available to reference.</p>
            ) : (
              artifactOptions.map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={artifactIds.has(option.id)}
                    disabled={busy}
                    onChange={(event) => {
                      setArtifactIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(option.id);
                        else next.delete(option.id);
                        return next;
                      });
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              ))
            )}
          </fieldset>
          {disabledReason ? <p className="muted">{disabledReason}</p> : null}
          {error ? (
            <output className="conversation-action-error" role="alert">
              {error}
            </output>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy || Boolean(disabledReason) || taskOptions.length === 0 || taskId.length === 0
            }
          >
            {busy ? "Preparing preview…" : "Prepare UI preview"}
          </Button>
          {taskOptions.length === 0 ? (
            <p className="muted">
              No approvable {planningPlanVersionId ? "plan module" : "task package"} target is
              available yet.
            </p>
          ) : null}
        </form>
      ) : null}
    </details>
  );
}

function proposalParameters(
  actionType: ProposalActionType,
  values: {
    taskId: string;
    runId: string;
    decisionPoint: string;
    primary: string;
    rationale: string;
    mockupTarget: "desktop" | "mobile" | "responsive";
    artifactRefs: string;
    selectedProposalId: string;
  },
  approvedPlan: V2WorkPlanVersionT | null,
  proposals: V2ConversationActionT[],
): Record<string, unknown> {
  const taskId = nullable(values.taskId);
  if (actionType === "record_human_decision") {
    return {
      decision_point: values.decisionPoint.trim(),
      decision: values.primary.trim(),
      rationale: values.rationale.trim(),
      ...(taskId ? { task_id: taskId } : {}),
    };
  }
  if (actionType === "redirect_agent") {
    return {
      task_id: values.taskId.trim(),
      run_id: values.runId.trim(),
      direction: values.primary.trim(),
      delivery_preference: "live_or_checkpoint",
    };
  }
  if (actionType === "propose_plan_change") {
    return {
      plan_version_id: approvedPlan?.id ?? "",
      plan_hash: approvedPlan?.content_hash ?? "",
      direction: values.primary.trim(),
      rationale: values.rationale.trim(),
    };
  }
  if (actionType === "approve_plan_change") {
    const proposal = proposals.find((candidate) => candidate.id === values.selectedProposalId);
    const parameters = proposal?.payload.parameters ?? {};
    return {
      proposal_action_id: values.selectedProposalId,
      plan_version_id: parameters.plan_version_id,
      plan_hash: parameters.plan_hash,
    };
  }
  if (actionType === "pause_work") {
    return { reason: values.primary.trim(), ...(taskId ? { task_id: taskId } : {}) };
  }
  if (actionType === "resume_work") {
    const reason = nullable(values.primary);
    return {
      ...(reason ? { reason } : {}),
      ...(taskId ? { task_id: taskId } : {}),
    };
  }
  return {
    brief: values.primary.trim(),
    target: values.mockupTarget,
    ...(taskId ? { task_id: taskId } : {}),
    artifact_refs: values.artifactRefs
      .split(",")
      .map((reference) => reference.trim())
      .filter(Boolean),
  };
}

export function ExecutionActionComposer({
  actions,
  planVersions,
  busy,
  error,
  disabledReason,
  lockedRequest,
  onPrepare,
  onRetryLocked,
}: {
  actions: V2ConversationActionT[];
  planVersions: V2WorkPlanVersionT[];
  busy: boolean;
  error: string | null;
  disabledReason: string | null;
  lockedRequest: V2CreateExecutionActionProposalInputT | null;
  onPrepare: (
    actionType: ProposalActionType,
    parameters: Record<string, unknown>,
  ) => Promise<boolean>;
  onRetryLocked: () => Promise<boolean>;
}): React.ReactElement {
  const [actionType, setActionType] = useState<ProposalActionType>("redirect_agent");
  const [taskId, setTaskId] = useState("");
  const [runId, setRunId] = useState("");
  const [decisionPoint, setDecisionPoint] = useState("");
  const [primary, setPrimary] = useState("");
  const [rationale, setRationale] = useState("");
  const [mockupTarget, setMockupTarget] = useState<"desktop" | "mobile" | "responsive">(
    "responsive",
  );
  const [artifactRefs, setArtifactRefs] = useState("");
  const approvedPlan =
    [...planVersions].reverse().find((version) => version.status === "approved") ?? null;
  const planChangeProposals = actions.filter(
    (action) =>
      action.action_type === "propose_plan_change" &&
      !["failed", "rejected"].includes(action.status),
  );
  const [selectedProposalId, setSelectedProposalId] = useState(
    planChangeProposals.at(-1)?.id ?? "",
  );
  const requiresPrimary = actionType !== "resume_work" && actionType !== "approve_plan_change";
  const requiresRationale = ["record_human_decision", "propose_plan_change"].includes(actionType);
  const unavailable =
    disabledReason ??
    (actionType === "propose_plan_change" && !approvedPlan
      ? "An approved plan is required before proposing a plan change."
      : actionType === "approve_plan_change" && planChangeProposals.length === 0
        ? "No plan-change proposal is available for approval."
        : null);

  if (lockedRequest) {
    return (
      <section
        className="execution-action-composer is-locked"
        aria-labelledby="execution-action-composer-title"
        data-testid="execution-action-composer"
      >
        <div>
          <span className="eyebrow">Exact request locked</span>
          <h3 id="execution-action-composer-title">
            {lockedRequest.action_type.replaceAll("_", " ")}
          </h3>
          <p>
            The previous response was uncertain. This byte-equivalent request and idempotency key
            are locked until the server confirms the outcome.
          </p>
        </div>
        <blockquote>
          <strong>Visible source message</strong>
          <p>{lockedRequest.message}</p>
        </blockquote>
        {error ? (
          <output className="conversation-action-error" role="alert">
            {error}
          </output>
        ) : null}
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={() => void onRetryLocked()}
        >
          {busy ? "Checking exact request…" : "Retry exact action proposal"}
        </Button>
      </section>
    );
  }

  return (
    <section
      className="execution-action-composer"
      aria-labelledby="execution-action-composer-title"
      data-testid="execution-action-composer"
    >
      <div>
        <span className="eyebrow">Explicit project action</span>
        <h3 id="execution-action-composer-title">Prepare execution action</h3>
        <p>
          Discussion in the message box never changes project state. Preparing an action creates an
          inert card; you must confirm that card separately.
        </p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parameters = proposalParameters(
            actionType,
            {
              taskId,
              runId,
              decisionPoint,
              primary,
              rationale,
              mockupTarget,
              artifactRefs,
              selectedProposalId,
            },
            approvedPlan,
            planChangeProposals,
          );
          void onPrepare(actionType, parameters).then((created) => {
            if (!created) return;
            setPrimary("");
            setRationale("");
            setDecisionPoint("");
            setArtifactRefs("");
          });
        }}
      >
        <Field label="Interaction class">
          <Select
            aria-label="Execution action type"
            value={actionType}
            disabled={busy}
            onChange={(event) => setActionType(event.target.value as ProposalActionType)}
          >
            {ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        {actionType === "record_human_decision" ? (
          <Field label="Decision point">
            <Input
              required
              maxLength={500}
              value={decisionPoint}
              onChange={(event) => setDecisionPoint(event.target.value)}
            />
          </Field>
        ) : null}

        {actionType === "approve_plan_change" ? (
          <Field label="Plan-change proposal">
            <Select
              required
              value={selectedProposalId}
              onChange={(event) => setSelectedProposalId(event.target.value)}
            >
              <option value="">Select a proposal</option>
              {planChangeProposals.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.id}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {["record_human_decision", "redirect_agent", "pause_work", "resume_work"].includes(
          actionType,
        ) ? (
          <Field label={actionType === "redirect_agent" ? "Task ID" : "Task ID (optional)"}>
            <Input
              required={actionType === "redirect_agent"}
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            />
          </Field>
        ) : null}

        {actionType === "redirect_agent" ? (
          <Field label="Active run ID">
            <Input required value={runId} onChange={(event) => setRunId(event.target.value)} />
          </Field>
        ) : null}

        {actionType !== "approve_plan_change" ? (
          <Field
            label={
              actionType === "record_human_decision"
                ? "Decision"
                : actionType === "pause_work" || actionType === "resume_work"
                  ? "Reason"
                  : "Direction"
            }
          >
            <TextArea
              required={requiresPrimary}
              maxLength={actionType === "redirect_agent" ? 8_000 : 4_000}
              value={primary}
              onChange={(event) => setPrimary(event.target.value)}
            />
          </Field>
        ) : null}

        {requiresRationale ? (
          <Field label="Rationale">
            <TextArea
              required
              maxLength={4_000}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          </Field>
        ) : null}

        {unavailable ? <p className="muted">{unavailable}</p> : null}
        {error ? (
          <output className="conversation-action-error" role="alert">
            {error}
          </output>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || unavailable !== null}>
          {busy ? "Preparing…" : "Prepare action for confirmation"}
        </Button>
      </form>
    </section>
  );
}

function waitStatusCopy(wait: V2HumanWaitT): string {
  if (wait.status === "awaiting_human") {
    return "The runner was released after publishing its branch. Your answer will create one continuation.";
  }
  if (wait.status === "answered")
    return "Your answer is recorded. Continuation dispatch is pending.";
  if (wait.status === "continuation_queued") {
    return "One continuation is queued from the saved commit and budget reservation.";
  }
  if (wait.status === "resumed") return "The saved run resumed from this answer.";
  if (wait.status === "expired") return "This question expired without resuming work.";
  if (wait.status === "cancelled") return "This question was cancelled. No continuation was sent.";
  return "The continuation failed. Review the evidence before retrying.";
}

function continuationStepState(
  continuation: V2HumanWaitContinuationT,
  step: V2HumanWaitContinuationT["status"],
): "complete" | "current" | "pending" {
  const statuses: V2HumanWaitContinuationT["status"][] = [
    "queued",
    "dispatched",
    "acknowledged",
    "applied",
  ];
  if (continuation.status === "failed") return step === "queued" ? "complete" : "pending";
  const current = statuses.indexOf(continuation.status);
  const candidate = statuses.indexOf(step);
  return candidate === current ? "current" : candidate < current ? "complete" : "pending";
}

function waitDraftKey(waitId: string): string {
  return `norns:human-wait-answer-draft:${waitId}`;
}

function storedWaitDraft(waitId: string): { answer: string; rationale: string } {
  try {
    const raw = window.sessionStorage.getItem(waitDraftKey(waitId));
    if (!raw) return { answer: "", rationale: "" };
    const parsed = JSON.parse(raw) as { answer?: unknown; rationale?: unknown };
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer : "",
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch {
    return { answer: "", rationale: "" };
  }
}

export function HumanWaitCard({
  view,
  answerAction,
  deliveryEvents,
  effect,
  busy,
  error,
  exactRetryLocked = false,
  onPrepareAnswer,
  onConfirm,
  onRefresh,
}: {
  view: HumanWaitView;
  answerAction: V2ConversationActionT | null;
  deliveryEvents: V2ConversationActionDeliveryEventT[];
  effect: ActionEffect | null;
  busy: boolean;
  error: string | null;
  exactRetryLocked?: boolean;
  onPrepareAnswer: (
    wait: V2HumanWaitT,
    answer: string,
    rationale: string | null,
  ) => Promise<boolean>;
  onConfirm: (action: V2ConversationActionT) => Promise<void>;
  onRefresh: () => void;
}): React.ReactElement {
  const initialDraft = useMemo(() => storedWaitDraft(view.wait.id), [view.wait.id]);
  const [answer, setAnswer] = useState(initialDraft.answer);
  const [rationale, setRationale] = useState(initialDraft.rationale);
  const titleId = `human-wait-${view.wait.id}`;
  const terminal = ["resumed", "expired", "cancelled", "failed"].includes(view.wait.status);
  const matchingEffect = effect?.kind === "human_wait_answered" ? effect : null;
  const continuation = matchingEffect?.continuation ?? view.continuation;
  const immutableAnswer = matchingEffect?.answer ?? view.answer;
  const retryLocked =
    exactRetryLocked || (error?.startsWith("Answer status is uncertain.") ?? false);

  const persistDraft = (nextAnswer: string, nextRationale: string) => {
    try {
      window.sessionStorage.setItem(
        waitDraftKey(view.wait.id),
        JSON.stringify({ answer: nextAnswer, rationale: nextRationale }),
      );
    } catch {
      // The controlled fields still retain the exact draft for this mount.
    }
  };

  return (
    <article
      className="human-wait-card"
      data-testid={`human-wait-${view.wait.id}`}
      aria-labelledby={titleId}
    >
      <header>
        <div>
          <span className="eyebrow">Needs your attention</span>
          <h3 id={titleId}>{view.wait.decision_point}</h3>
        </div>
        <Badge
          tone={
            view.wait.status === "resumed"
              ? "success"
              : ["expired", "cancelled", "failed"].includes(view.wait.status)
                ? "danger"
                : "warn"
          }
        >
          {view.wait.status.replaceAll("_", " ")}
        </Badge>
      </header>
      <p className="human-wait-question">{view.wait.question}</p>
      <p className="muted">{waitStatusCopy(view.wait)}</p>
      <dl className="human-wait-evidence">
        <div>
          <dt>Published branch</dt>
          <dd>{view.wait.published.branch}</dd>
        </div>
        <div>
          <dt>Saved commit</dt>
          <dd>
            <code title={view.wait.published.commit_sha}>
              {view.wait.published.commit_sha.slice(0, 12)}
            </code>
          </dd>
        </div>
        <div>
          <dt>Budget reservation</dt>
          <dd>{view.wait.budget.reservation_id}</dd>
        </div>
      </dl>

      {immutableAnswer ? (
        <blockquote>
          <strong>Recorded answer</strong>
          <p>{immutableAnswer.answer}</p>
          {immutableAnswer.rationale ? <small>{immutableAnswer.rationale}</small> : null}
        </blockquote>
      ) : null}

      {view.wait.status === "awaiting_human" && !answerAction ? (
        <form
          className="human-wait-answer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onPrepareAnswer(view.wait, answer.trim(), nullable(rationale)).then((created) => {
              if (!created) return;
              try {
                window.sessionStorage.removeItem(waitDraftKey(view.wait.id));
              } catch {
                // The proposed answer is now durable.
              }
            });
          }}
        >
          <Field label="Exact answer">
            <TextArea
              required
              maxLength={8_000}
              value={answer}
              disabled={busy || retryLocked}
              onChange={(event) => {
                setAnswer(event.target.value);
                persistDraft(event.target.value, rationale);
              }}
            />
          </Field>
          <Field label="Rationale (optional)">
            <TextArea
              maxLength={4_000}
              value={rationale}
              disabled={busy || retryLocked}
              onChange={(event) => {
                setRationale(event.target.value);
                persistDraft(answer, event.target.value);
              }}
            />
          </Field>
          <p>
            Preparing this answer does not resume work. Confirm the resulting action card
            separately.
          </p>
          {error ? (
            <output className="conversation-action-error" role="alert">
              {error}
            </output>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy || !answer.trim()}>
            {busy
              ? "Preparing exact answer…"
              : retryLocked
                ? "Retry exact answer proposal"
                : "Prepare answer for confirmation"}
          </Button>
        </form>
      ) : null}

      {answerAction ? (
        <ConversationActionCard
          action={answerAction}
          busy={busy}
          effect={effect}
          deliveryEvents={eventsFor(answerAction.id, deliveryEvents)}
          error={error}
          onConfirm={onConfirm}
        />
      ) : null}

      {continuation ? (
        <section className="human-wait-continuation" aria-label="Continuation delivery">
          <strong>Continuation</strong>
          <ol>
            {(["queued", "dispatched", "acknowledged", "applied"] as const).map((status) => (
              <li
                key={status}
                className={`is-${continuationStepState(continuation, status)}`}
                aria-current={continuation.status === status ? "step" : undefined}
              >
                {status}
              </li>
            ))}
          </ol>
          {continuation.status === "failed" ? (
            <output className="conversation-action-outcome is-failed" aria-live="polite">
              Continuation failed
            </output>
          ) : null}
        </section>
      ) : null}

      {!terminal && view.wait.status !== "awaiting_human" ? (
        <Button className="btn-small" onClick={onRefresh}>
          Refresh continuation status
        </Button>
      ) : null}
    </article>
  );
}

export function ExecutionActionHistory({
  actions,
  deliveryEvents,
  effects,
  busyActionId,
  errors,
  onConfirm,
}: {
  actions: V2ConversationActionT[];
  deliveryEvents: V2ConversationActionDeliveryEventT[];
  effects: Map<string, ActionEffect>;
  busyActionId: string | null;
  errors: Map<string, string>;
  onConfirm: (action: V2ConversationActionT) => Promise<void>;
}): React.ReactElement | null {
  const executionActions = actions.filter(
    (action) =>
      EXECUTION_ACTION_TYPES.has(action.action_type) && action.action_type !== "answer_human_wait",
  );
  if (executionActions.length === 0) return null;
  return (
    <section className="execution-action-history" aria-label="Execution actions">
      {executionActions.map((action) => (
        <ConversationActionCard
          key={action.id}
          action={action}
          busy={busyActionId === action.id}
          effect={effects.get(action.id) ?? null}
          deliveryEvents={eventsFor(action.id, deliveryEvents)}
          error={errors.get(action.id) ?? null}
          onConfirm={onConfirm}
        />
      ))}
    </section>
  );
}

export function PmUpdateControls({
  settings,
  updates,
  busy,
  error,
  onSave,
}: {
  settings: V2ConversationPmUpdateSettingsT;
  updates: V2ConversationPmUpdateT[];
  busy: boolean;
  error: string | null;
  onSave: (input: {
    update_interval_seconds?: number | null;
    content_level?: "concise" | "standard" | "detailed" | null;
  }) => Promise<void>;
}): React.ReactElement {
  const [interval, setInterval] = useState(
    settings.interval_inherited ? "inherit" : String(settings.update_interval_seconds),
  );
  const [contentLevel, setContentLevel] = useState(
    settings.content_level_inherited ? "inherit" : settings.content_level,
  );
  return (
    <details className="pm-update-controls" data-testid="pm-update-controls">
      <summary>PM updates · every {Math.round(settings.update_interval_seconds / 60)} min</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            update_interval_seconds: interval === "inherit" ? null : Number(interval),
            content_level:
              contentLevel === "inherit"
                ? null
                : (contentLevel as "concise" | "standard" | "detailed"),
          });
        }}
      >
        <p>
          Routine updates are generated from durable project state when possible. Project overrides
          inherit the server default when cleared.
        </p>
        <Field label="Update frequency">
          <Select value={interval} onChange={(event) => setInterval(event.target.value)}>
            <option value="inherit">Use server default</option>
            <option value="60">Every minute</option>
            <option value="300">Every 5 minutes</option>
            <option value="900">Every 15 minutes</option>
            <option value="1800">Every 30 minutes</option>
          </Select>
        </Field>
        <Field label="Update detail">
          <Select value={contentLevel} onChange={(event) => setContentLevel(event.target.value)}>
            <option value="inherit">Use server default</option>
            <option value="concise">Concise</option>
            <option value="standard">Standard</option>
            <option value="detailed">Detailed</option>
          </Select>
        </Field>
        {error ? (
          <output className="conversation-action-error" role="alert">
            {error}
          </output>
        ) : null}
        <Button type="submit" className="btn-small" disabled={busy}>
          {busy ? "Saving…" : "Save PM update override"}
        </Button>
      </form>
      {updates.length > 0 ? (
        <ol className="pm-update-history" aria-label="Recent deterministic PM updates">
          {updates.slice(-3).map((update) => (
            <li key={update.id}>
              <Badge tone={update.status === "blocked" ? "danger" : "info"}>
                {update.status.replaceAll("_", " ")}
              </Badge>
              <span>{update.content}</span>
              <code title={update.state_hash}>{update.state_hash.slice(0, 10)}</code>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}
