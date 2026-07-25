import { PM_MODEL_OPTIONS } from "@norns/contracts";
// PHASE TAB (P2): one flow from "describe the goal" to "watch execution".
//   a. Goal input (textarea + image attachments)
//   b. Setup selectors (agents, review rounds) + fixed PM/Reviewer identity
//   c. Start -> live planning-run progress (fast poll while active)
//   d. Decision panel at converged/cap_reached (the awaiting-decision states):
//      per-phase staffing dropdowns, Approve / Modify(direction) / Reject
//   e. Execution status table once approved (fast/idle poll cadence)
// ALL fetches go through phaseTabApi.ts (single reconciliation point for the
// integrator); this file renders and holds state only.
import { useCallback, useEffect, useState } from "react";
import { AttachmentInput } from "./AttachmentInput";
import { UnauthorizedError } from "./auth";
import {
  PHASE_EXECUTION_ACTIVE_STATES,
  PHASE_RUN_ACTIVE_STATUSES,
  PHASE_RUN_DECISION_STATUSES,
  type PhaseExecutionKickoffReport,
  type PhaseExecutionStatusRow,
  type PhasePlanStaffedPhase,
  type PhasePlanningRunDto,
  type WorkerProviders,
  getLatestPhasePlanningRun,
  getPhaseExecutionStatus,
  getPhasePlanningRun,
  planPhasesFromRun,
  postPlanningRunDecision,
  retryPlanningRunExecution,
  startPhasePlanningRun,
} from "./phaseTabApi";
import { Alert, Badge, Button, Field, Select, Spinner, TextArea } from "./ui";

const RUN_ACTIVE_POLL_MS = 3_000;
const RUN_IDLE_POLL_MS = 15_000;
const EXECUTION_ACTIVE_POLL_MS = 5_000;
const EXECUTION_IDLE_POLL_MS = 15_000;

type Provider = "anthropic" | "openai";

function providersFor(workerProviders: WorkerProviders): Provider[] {
  return workerProviders === "both" ? ["anthropic", "openai"] : [workerProviders];
}

const PROVIDER_GROUP_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const JOURNEY_STEPS = [
  {
    label: "Planning",
    description: "Coordinator and reviewer prepare the implementation plan.",
  },
  {
    label: "Plan ready",
    description: "Review one plan and approve it when it is ready.",
  },
  {
    label: "Coding",
    description: "Follow dispatched work and implementation progress.",
  },
] as const;

/** Human status line for the live-progress section. */
function runStatusLabel(run: PhasePlanningRunDto): string {
  const total = run.review_rounds_total;
  const current = Math.min(run.rounds_completed + 1, Math.max(total, 1));
  switch (run.status) {
    case "queued":
      return "Queued";
    case "drafting":
      return "Drafting the plan";
    case "reviewing":
      return `Reviewing — round ${current} of ${total}`;
    case "revising":
      return `Revising after review — round ${current} of ${total}`;
    default:
      return run.status.replaceAll("_", " ");
  }
}

export function PhaseTab({
  projectId,
  initialRunId = null,
  onJourneyChanged,
  onUnauthorized,
}: {
  projectId: string;
  initialRunId?: string | null;
  onJourneyChanged?: () => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  // a/b — setup form
  const [goal, setGoal] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<WorkerProviders>("both");
  const [reviewRounds, setReviewRounds] = useState(2);
  // c — run lifecycle
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [run, setRun] = useState<PhasePlanningRunDto | null>(null);
  const [recoveryAttempted, setRecoveryAttempted] = useState(Boolean(initialRunId));
  const [recovering, setRecovering] = useState(!initialRunId);
  // The worker_providers the active run was started with — model dropdowns in
  // the decision panel are filtered to these.
  const [activeProviders, setActiveProviders] = useState<Provider[]>(["anthropic", "openai"]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // d — decision panel
  const [staffingDrafts, setStaffingDrafts] = useState<Record<string, string>>({});
  const [modifyOpen, setModifyOpen] = useState(false);
  const [direction, setDirection] = useState("");
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  // e — execution status
  const [executionRows, setExecutionRows] = useState<PhaseExecutionStatusRow[] | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  // The approve response's kickoff report: null means the approval is
  // recorded but no kickoff report is available (a neutral fact, reconciled
  // against execution status); undefined until an approve response has been
  // seen this session.
  const [executionKickoff, setExecutionKickoff] = useState<
    PhaseExecutionKickoffReport | null | undefined
  >(undefined);

  const fail = useCallback(
    (err: unknown, sink: (message: string) => void) => {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else sink(err instanceof Error ? err.message : String(err));
    },
    [onUnauthorized],
  );

  // A navigation hint opens the just-created run immediately. If the hint was
  // lost to a refresh, recover the newest durable run instead of showing a
  // second setup form and inviting accidental duplicate planning.
  useEffect(() => {
    if (!initialRunId || initialRunId === runId) return;
    setRunId(initialRunId);
    setRun(null);
    setRecoveryAttempted(true);
    setRecovering(false);
  }, [initialRunId, runId]);

  useEffect(() => {
    if (recoveryAttempted || runId) return;
    setRecoveryAttempted(true);
    setRecovering(true);
    void getLatestPhasePlanningRun(projectId)
      .then(({ planning_run }) => {
        if (!planning_run) return;
        setRun(planning_run);
        setRunId(planning_run.id);
        setActiveProviders(providersFor(planning_run.worker_providers));
      })
      .catch((err) => fail(err, setError))
      .finally(() => setRecovering(false));
  }, [recoveryAttempted, runId, projectId, fail]);

  const start = useCallback(async () => {
    if (!goal.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const created = await startPhasePlanningRun(projectId, {
        objective: goal.trim(),
        attachment_ids: attachmentIds,
        review_rounds: reviewRounds,
        worker_providers: agents,
      });
      setActiveProviders(providersFor(agents));
      setRunId(created.planning_run_id);
      setRun(null);
      setStaffingDrafts({});
      setModifyOpen(false);
      setDirection("");
      setConfirmingReject(false);
      setExecutionRows(null);
      setExecutionError(null);
      setExecutionKickoff(undefined);
    } catch (err) {
      fail(err, setError);
    } finally {
      setStarting(false);
    }
  }, [goal, attachmentIds, reviewRounds, agents, projectId, fail]);

  const pollRun = useCallback(async () => {
    if (!runId) return;
    try {
      const next = await getPhasePlanningRun(projectId, runId);
      setRun(next);
      setActiveProviders(providersFor(next.worker_providers));
    } catch (err) {
      fail(err, setError);
    }
  }, [runId, projectId, fail]);

  // Poll the run: fast while the loop is producing, idle while it waits on
  // the human decision, stopped once terminal (approved/rejected/failed).
  const runStatus = run?.status ?? null;
  useEffect(() => {
    if (!runId) return;
    if (runStatus === "approved" || runStatus === "rejected" || runStatus === "failed") return;
    void pollRun();
    const idle = runStatus !== null && PHASE_RUN_DECISION_STATUSES.has(runStatus);
    const timer = window.setInterval(
      () => void pollRun(),
      idle ? RUN_IDLE_POLL_MS : RUN_ACTIVE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [runId, runStatus, pollRun]);

  // Project-scoped: GET /api/v2/projects/:id/execution-status (no runId).
  const pollExecution = useCallback(async () => {
    try {
      setExecutionError(null);
      setExecutionRows((await getPhaseExecutionStatus(projectId)).phases);
    } catch (err) {
      fail(err, setExecutionError);
    }
  }, [projectId, fail]);

  // Poll execution status once approved: fast while any phase is active.
  const executionActive =
    executionRows?.some((row) => PHASE_EXECUTION_ACTIVE_STATES.has(row.state)) ?? true;
  useEffect(() => {
    if (!runId || runStatus !== "approved") return;
    void pollExecution();
    const timer = window.setInterval(
      () => void pollExecution(),
      executionActive ? EXECUTION_ACTIVE_POLL_MS : EXECUTION_IDLE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [runId, runStatus, executionActive, pollExecution]);

  const planPhases = run ? planPhasesFromRun(run) : [];

  const staffingValue = (phase: PhasePlanStaffedPhase): string =>
    staffingDrafts[phase.node_id] ?? `${phase.provider}:${phase.model}`;

  const decide = useCallback(
    async (body: Parameters<typeof postPlanningRunDecision>[2]) => {
      if (!runId) return;
      setDecisionBusy(true);
      setError(null);
      try {
        const decided = await postPlanningRunDecision(projectId, runId, body);
        setRun(decided);
        // Approve responses carry `execution` ({started, detail} | null);
        // modify/reject responses do not — leave the report untouched then.
        if ("execution" in decided) setExecutionKickoff(decided.execution ?? null);
        setModifyOpen(false);
        setDirection("");
        setConfirmingReject(false);
        if (body.decision === "approve") onJourneyChanged?.();
      } catch (err) {
        fail(err, setError);
      } finally {
        setDecisionBusy(false);
      }
    },
    [runId, projectId, fail, onJourneyChanged],
  );

  const retryExecution = useCallback(async () => {
    if (!runId) return;
    setDecisionBusy(true);
    setError(null);
    try {
      const retried = await retryPlanningRunExecution(projectId, runId);
      setRun(retried);
      setExecutionKickoff(retried.execution ?? null);
      await pollExecution();
      onJourneyChanged?.();
    } catch (err) {
      fail(err, setError);
    } finally {
      setDecisionBusy(false);
    }
  }, [runId, projectId, pollExecution, onJourneyChanged, fail]);

  // Plain function (not useCallback): reads the current dropdown drafts at
  // click time, so the approve payload always reflects what is on screen.
  const approve = () => {
    const staffing = planPhases.map((phase) => {
      const [provider, ...modelParts] = staffingValue(phase).split(":");
      return {
        node_id: phase.node_id,
        provider: provider as Provider,
        model: modelParts.join(":"),
      };
    });
    return decide({ decision: "approve", staffing });
  };

  const resetToNewRun = useCallback(() => {
    setRunId(null);
    setRun(null);
    setError(null);
    setStaffingDrafts({});
    setModifyOpen(false);
    setDirection("");
    setConfirmingReject(false);
    setExecutionRows(null);
    setExecutionError(null);
    setExecutionKickoff(undefined);
  }, []);

  const runIsActive = runStatus !== null && PHASE_RUN_ACTIVE_STATUSES.has(runStatus);
  const runAwaitsDecision = runStatus !== null && PHASE_RUN_DECISION_STATUSES.has(runStatus);
  const showSetupForm = recoveryAttempted && !recovering && !runId;
  const journeyStage =
    runStatus === "approved" ? 3 : runAwaitsDecision || runStatus === "rejected" ? 2 : 1;

  const reviewerFindings = (run?.transcript ?? []).filter((entry) => entry.role === "reviewer");
  const executionHasProgress =
    executionKickoff?.started === true ||
    (executionRows?.some((row) => row.state === "active" || row.state === "completed") ?? false);
  const executionStartRetryAvailable =
    executionRows !== null &&
    (executionRows.length === 0 ||
      executionRows.some((row) =>
        ["proposed", "awaiting_approval", "approved", "blocked"].includes(row.state),
      ));
  const executionNeedsStartAttention =
    !executionHasProgress && (executionKickoff?.started === false || executionStartRetryAvailable);

  return (
    <div className="form-stack phase-journey-shell" data-testid="phase-tab">
      {error ? (
        <div className="phase-inline-error" role="alert">
          <Alert testId="phase-error">{error}</Alert>
        </div>
      ) : null}

      {recovering || runId ? (
        <nav
          className="phase-journey"
          aria-label="Planning to coding progress"
          data-testid="phase-journey"
        >
          <ol>
            {JOURNEY_STEPS.map((step, index) => {
              const stepNumber = index + 1;
              const isCurrent = stepNumber === journeyStage;
              const isComplete = stepNumber < journeyStage;
              return (
                <li
                  key={step.label}
                  className={
                    isCurrent
                      ? "phase-journey-step is-current"
                      : isComplete
                        ? "phase-journey-step is-complete"
                        : "phase-journey-step"
                  }
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <span className="phase-journey-marker" aria-hidden="true">
                    {isComplete ? "✓" : stepNumber}
                  </span>
                  <span className="phase-journey-copy">
                    <strong>{step.label}</strong>
                    <span>{step.description}</span>
                    {isComplete ? <span className="sr-only">Complete</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      {recovering ? (
        <section
          className="card side-section phase-state-card phase-run-recovering"
          data-testid="phase-run-recovering"
          aria-label="Resuming planning"
        >
          <output className="side-body" aria-live="polite">
            <Spinner label="Resuming the latest planning work…" />
            <p className="muted">
              Your project and planning progress are saved. This should only take a moment.
            </p>
          </output>
        </section>
      ) : null}

      {showSetupForm ? (
        <section className="card side-section phase-setup" data-testid="phase-setup">
          <div className="side-body form-stack">
            <AttachmentInput
              variant="composer"
              label="What should this phase deliver?"
              textAreaTestId="phase-goal"
              placeholder="Describe the goal, paste a screenshot, or add a reference file…"
              textValue={goal}
              onTextChange={setGoal}
              projectId={projectId}
              value={attachmentIds}
              onChange={setAttachmentIds}
              purpose="objective"
              disabled={starting}
            />
            <div className="two-col-fields">
              <Field label="Agents">
                <Select
                  data-testid="phase-agents"
                  value={agents}
                  disabled={starting}
                  onChange={(event) => setAgents(event.target.value as WorkerProviders)}
                >
                  <option value="anthropic">Claude</option>
                  <option value="openai">ChatGPT</option>
                  <option value="both">Both</option>
                </Select>
              </Field>
              <Field label="Review rounds">
                <Select
                  data-testid="phase-rounds"
                  value={String(reviewRounds)}
                  disabled={starting}
                  onChange={(event) => setReviewRounds(Number(event.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="muted phase-identity-line" data-testid="phase-identity-line">
              PM: Claude Fable · Reviewer: ChatGPT Sol (gpt-5.6-sol)
            </p>
            <Button
              variant="primary"
              data-testid="phase-start"
              disabled={starting || !goal.trim()}
              onClick={() => void start()}
            >
              {starting ? "Starting…" : "Start"}
            </Button>
          </div>
        </section>
      ) : null}

      {runId && (runIsActive || !run) ? (
        <section
          className="card side-section phase-state-card phase-run-progress"
          data-testid="phase-run-progress"
          aria-labelledby="phase-planning-title"
        >
          <div className="side-body form-stack">
            <div className="section-head phase-state-heading">
              <div>
                <div className="eyebrow">Planning</div>
                <h3 id="phase-planning-title" data-testid="phase-run-status" aria-live="polite">
                  {run ? runStatusLabel(run) : "Starting the plan…"}
                </h3>
              </div>
              <Badge tone="info">In progress</Badge>
            </div>
            {run ? (
              <div className="phase-planning-progress">
                <div className="phase-planning-progress-copy">
                  <span data-testid="phase-run-rounds">
                    {run.rounds_completed} of {run.review_rounds_total} review rounds complete
                  </span>
                  <span>
                    {Math.round(
                      (run.rounds_completed / Math.max(run.review_rounds_total, 1)) * 100,
                    )}
                    %
                  </span>
                </div>
                <progress
                  aria-label="Review rounds completed"
                  max={Math.max(run.review_rounds_total, 1)}
                  value={run.rounds_completed}
                />
              </div>
            ) : null}
            <output aria-live="polite">
              <Spinner label="Coordinator and reviewer are working…" />
            </output>
            {reviewerFindings.length > 0 ? (
              <div className="phase-findings" data-testid="phase-run-findings">
                <h4>Reviewer findings so far</h4>
                {reviewerFindings.map((entry, index) => (
                  <article
                    className="planning-finding"
                    key={`${entry.round}-${index}`}
                    data-testid="phase-run-finding"
                  >
                    <div className="outstanding-item-meta">
                      <Badge
                        tone={
                          entry.finding_counts && entry.finding_counts.must_fix > 0
                            ? "danger"
                            : "warn"
                        }
                      >
                        Round {entry.round}
                      </Badge>
                      <span>
                        Reviewer
                        {entry.finding_counts
                          ? ` · ${entry.finding_counts.must_fix} must fix · ${entry.finding_counts.should_fix} should fix · ${entry.finding_counts.suggestion} suggestions`
                          : ""}
                      </span>
                    </div>
                    <p>{entry.summary}</p>
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {run && runAwaitsDecision ? (
        <section
          className="card side-section phase-state-card phase-decision"
          data-testid="phase-decision-panel"
          aria-labelledby="phase-decision-title"
        >
          <div className="side-body form-stack">
            <div className="section-head phase-state-heading">
              <div>
                <div className="eyebrow">Plan ready</div>
                <h3 id="phase-decision-title">
                  {run.status === "cap_reached"
                    ? "The plan needs your review"
                    : "Your implementation plan is ready"}
                </h3>
              </div>
              <Badge tone={run.status === "cap_reached" ? "warn" : "success"}>
                {run.status === "cap_reached" ? "Review needed" : "Ready"}
              </Badge>
            </div>
            <p className="phase-plan-ready-copy">
              The coordinator and reviewer have prepared the first coding plan. Review the phases
              below, then approve once to staff and dispatch the work.
            </p>

            <ul className="phase-plan-meta" data-testid="phase-decision-rounds">
              <li>
                <strong>{planPhases.length}</strong>
                <span>implementation phase{planPhases.length === 1 ? "" : "s"}</span>
              </li>
              <li>
                <strong>
                  {run.rounds_completed}/{run.review_rounds_total}
                </strong>
                <span>review rounds complete</span>
              </li>
              {run.result ? (
                <li>
                  <strong>${run.result.total_cost_usd.toFixed(2)}</strong>
                  <span>planning cost</span>
                </li>
              ) : null}
            </ul>

            <div className="phase-plan-list" aria-label="Implementation phases">
              {planPhases.map((phase, index) => (
                <article
                  className="card phase-plan-card"
                  key={phase.node_id}
                  data-testid={`phase-plan-card-${phase.node_id}`}
                >
                  <div className="phase-plan-card-head">
                    <div className="phase-plan-title">
                      <span className="phase-plan-index" aria-hidden="true">
                        {index + 1}
                      </span>
                      <h4>{phase.name ?? phase.node_id}</h4>
                    </div>
                    <Badge tone="info">
                      {phase.worker_count} worker{phase.worker_count === 1 ? "" : "s"}
                    </Badge>
                  </div>
                  {phase.description ? <p className="muted">{phase.description}</p> : null}
                </article>
              ))}
            </div>

            {planPhases.length > 0 ? (
              <details
                className="card side-section phase-staffing-options"
                data-testid="phase-staffing-options"
              >
                <summary>
                  <span>Optional · adjust staffing</span>
                  <small>Recommended models selected</small>
                </summary>
                <div className="side-body form-stack phase-staffing-body">
                  <p className="muted">
                    The recommended models are ready. Change them only when the implementation needs
                    a specific provider or model.
                  </p>
                  <div className="phase-staffing-grid">
                    {planPhases.map((phase) => (
                      <Field key={phase.node_id} label={phase.name ?? phase.node_id}>
                        <Select
                          data-testid={`phase-staffing-${phase.node_id}`}
                          value={staffingValue(phase)}
                          disabled={decisionBusy}
                          onChange={(event) =>
                            setStaffingDrafts((current) => ({
                              ...current,
                              [phase.node_id]: event.target.value,
                            }))
                          }
                        >
                          {activeProviders.map((provider) => (
                            <optgroup key={provider} label={PROVIDER_GROUP_LABEL[provider]}>
                              {PM_MODEL_OPTIONS[provider].map((model) => (
                                <option key={model.id} value={`${provider}:${model.id}`}>
                                  {model.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                      </Field>
                    ))}
                  </div>
                </div>
              </details>
            ) : null}

            {modifyOpen ? (
              <div className="form-stack phase-modify-form" data-testid="phase-modify-form">
                <div>
                  <h4>Request a revision</h4>
                  <p className="muted">
                    Give the coordinator clear direction. The revised plan will pass through review
                    again before you approve it.
                  </p>
                </div>
                <Field label="Direction for the next revision">
                  <TextArea
                    data-testid="phase-modify-direction"
                    placeholder="What should change? The plan goes back through review with this direction."
                    value={direction}
                    onChange={(event) => setDirection(event.target.value)}
                    disabled={decisionBusy}
                  />
                </Field>
                <div className="actions">
                  <Button disabled={decisionBusy} onClick={() => setModifyOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    data-testid="phase-modify-send"
                    disabled={decisionBusy || !direction.trim()}
                    onClick={() => void decide({ decision: "modify", direction: direction.trim() })}
                  >
                    {decisionBusy ? "Sending…" : "Send direction"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="phase-decision-actions">
                <Button
                  variant="primary"
                  className="phase-primary-action"
                  data-testid="phase-approve"
                  disabled={decisionBusy}
                  onClick={() => void approve()}
                >
                  {decisionBusy ? "Starting coding…" : "Approve & start coding"}
                </Button>
                <div className="phase-secondary-actions">
                  <span className="muted">Need a change before coding?</span>
                  <div className="actions">
                    <Button
                      data-testid="phase-modify"
                      disabled={decisionBusy}
                      onClick={() => {
                        setModifyOpen(true);
                        setConfirmingReject(false);
                      }}
                    >
                      Modify
                    </Button>
                    <Button
                      variant="danger"
                      data-testid="phase-reject"
                      disabled={decisionBusy}
                      onClick={() =>
                        confirmingReject
                          ? void decide({ decision: "reject" })
                          : setConfirmingReject(true)
                      }
                    >
                      {confirmingReject ? "Confirm reject" : "Reject"}
                    </Button>
                    {confirmingReject ? (
                      <Button disabled={decisionBusy} onClick={() => setConfirmingReject(false)}>
                        Keep the plan
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {runStatus === "approved" ? (
        <section
          className="card side-section phase-state-card phase-execution-status"
          data-testid="phase-execution-panel"
          aria-labelledby="phase-execution-title"
        >
          <div className="side-body form-stack">
            <div className="section-head phase-state-heading">
              <div>
                <div className="eyebrow">Coding</div>
                <h3 id="phase-execution-title">
                  {executionNeedsStartAttention
                    ? "Coding needs a restart"
                    : executionHasProgress
                      ? "Coding is underway"
                      : "Preparing coding status…"}
                </h3>
              </div>
              <Badge tone={executionNeedsStartAttention ? "warn" : "success"}>
                {executionNeedsStartAttention ? "Needs attention" : "Approved"}
              </Badge>
            </div>
            <output
              className={
                executionNeedsStartAttention
                  ? "phase-kickoff-note needs-attention"
                  : "phase-kickoff-note"
              }
              aria-live="polite"
            >
              {executionKickoff?.started ? (
                <p data-testid="phase-execution-kickoff-note">
                  Execution started automatically from this approval.
                  {executionKickoff.detail ? ` ${executionKickoff.detail}` : ""}
                </p>
              ) : executionKickoff?.started === false ? (
                <p data-testid="phase-execution-kickoff-note">
                  Plan approved and recorded, but coding did not start.
                  {executionKickoff.detail ? ` ${executionKickoff.detail}` : ""}
                </p>
              ) : (
                <p data-testid="phase-execution-kickoff-note">
                  Plan approved. Checking the current coding status…
                </p>
              )}
            </output>
            {executionStartRetryAvailable ? (
              <Button
                variant="primary"
                className="phase-primary-action"
                data-testid="phase-retry-execution"
                disabled={decisionBusy}
                onClick={() => void retryExecution()}
              >
                {decisionBusy ? "Starting…" : "Retry coding start"}
              </Button>
            ) : null}
            {executionError ? (
              <div className="phase-execution-error" role="alert">
                <Alert testId="phase-execution-error">{executionError}</Alert>
                <Button disabled={decisionBusy} onClick={() => void pollExecution()}>
                  Check coding status again
                </Button>
              </div>
            ) : null}
            {executionRows ? (
              <div className="phase-execution-table-wrap">
                <table className="phase-execution-table" data-testid="phase-execution-table">
                  <thead>
                    <tr>
                      <th scope="col">Phase</th>
                      <th scope="col">State</th>
                      <th scope="col">Complete</th>
                      <th scope="col">Est. completion</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executionRows.map((row) => (
                      <tr key={row.phase_id} data-testid={`phase-execution-row-${row.phase_id}`}>
                        <td data-label="Phase">{row.name}</td>
                        <td data-label="State">
                          <Badge
                            tone={
                              row.state === "completed"
                                ? "success"
                                : PHASE_EXECUTION_ACTIVE_STATES.has(row.state)
                                  ? "info"
                                  : "default"
                            }
                          >
                            {row.state.replaceAll("_", " ")}
                          </Badge>
                        </td>
                        <td className="mono" data-label="Complete">
                          {Math.round(row.percent_complete)}%
                        </td>
                        <td data-label="Est. completion">{row.est_completion ?? "—"}</td>
                        <td data-label="Notes">{row.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <output aria-live="polite">
                <Spinner label="Loading coding status…" />
              </output>
            )}
          </div>
        </section>
      ) : null}

      {runStatus === "rejected" ? (
        <section className="card side-section phase-state-card" data-testid="phase-rejected-panel">
          <div className="side-body form-stack">
            <div>
              <div className="eyebrow">Plan closed</div>
              <h3>Nothing was sent to coding</h3>
              <p className="muted">The rejected plan is saved with this project.</p>
            </div>
            <Button data-testid="phase-new-run" onClick={resetToNewRun}>
              Start a new phase plan
            </Button>
          </div>
        </section>
      ) : null}

      {runStatus === "failed" ? (
        <section
          className="card side-section phase-state-card phase-failed-panel"
          data-testid="phase-failed-panel"
        >
          <div className="side-body form-stack">
            <div>
              <div className="eyebrow">Planning stopped</div>
              <h3>The plan could not be completed</h3>
              <p className="muted">The project is safe. Start a new run when you are ready.</p>
            </div>
            <div role="alert">
              <Alert testId="phase-run-failed">{run?.error ?? "The planning run failed."}</Alert>
            </div>
            <Button
              className="phase-primary-action"
              data-testid="phase-new-run"
              onClick={resetToNewRun}
            >
              Plan again
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
