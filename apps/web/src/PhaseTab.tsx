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
  getPhaseExecutionStatus,
  getPhasePlanningRun,
  planPhasesFromRun,
  postPlanningRunDecision,
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
  onUnauthorized,
}: {
  projectId: string;
  onUnauthorized: () => void;
}): React.ReactElement {
  // a/b — setup form
  const [goal, setGoal] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<WorkerProviders>("both");
  const [reviewRounds, setReviewRounds] = useState(2);
  // c — run lifecycle
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<PhasePlanningRunDto | null>(null);
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
  // recorded but execution did not auto-start (a neutral fact, not an
  // error); undefined until an approve response has been seen this session.
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
      setRun(await getPhasePlanningRun(projectId, runId));
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
      } catch (err) {
        fail(err, setError);
      } finally {
        setDecisionBusy(false);
      }
    },
    [runId, projectId, fail],
  );

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
  const showSetupForm = !runId;

  const reviewerFindings = (run?.transcript ?? []).filter((entry) => entry.role === "reviewer");

  return (
    <div className="form-stack" data-testid="phase-tab">
      {error ? <Alert testId="phase-error">{error}</Alert> : null}

      {showSetupForm ? (
        <section className="card side-section phase-setup" data-testid="phase-setup">
          <div className="side-body form-stack">
            <Field label="What should this phase deliver?">
              <TextArea
                data-testid="phase-goal"
                placeholder="Describe the goal — type or paste it here."
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                disabled={starting}
              />
            </Field>
            <Field label="Attach images">
              <AttachmentInput
                projectId={projectId}
                value={attachmentIds}
                onChange={setAttachmentIds}
                purpose="objective"
                disabled={starting}
              />
              <span className="field-help">
                Images are supported today — paste a screenshot, drop a file, or browse.
              </span>
            </Field>
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
        <section className="card side-section phase-run-progress" data-testid="phase-run-progress">
          <div className="side-body form-stack">
            <div className="section-head">
              <div>
                <div className="eyebrow">Planning</div>
                <h3 data-testid="phase-run-status">{run ? runStatusLabel(run) : "Starting…"}</h3>
              </div>
              <Badge tone="info">{run?.status ?? "queued"}</Badge>
            </div>
            {run ? (
              <p className="muted" data-testid="phase-run-rounds">
                {run.rounds_completed} of {run.review_rounds_total} review rounds complete
              </p>
            ) : null}
            <Spinner label="Coordinator and reviewer are working…" />
            {reviewerFindings.length > 0 ? (
              <div className="phase-findings" data-testid="phase-run-findings">
                <strong>Reviewer findings so far</strong>
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
                        {entry.model}
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
        <section className="card side-section phase-decision" data-testid="phase-decision-panel">
          <div className="side-body form-stack">
            <div className="section-head">
              <div>
                <div className="eyebrow">Plan ready</div>
                <h3>
                  {run.status === "cap_reached"
                    ? "Round cap reached — review the plan"
                    : "Review the plan"}
                </h3>
              </div>
              <Badge tone={run.status === "cap_reached" ? "warn" : "success"}>{run.status}</Badge>
            </div>
            <p className="muted" data-testid="phase-decision-rounds">
              {run.rounds_completed} of {run.review_rounds_total} review rounds complete
              {run.result ? ` · plan cost $${run.result.total_cost_usd.toFixed(2)}` : ""}
            </p>

            {planPhases.map((phase) => (
              <article
                className="card phase-plan-card"
                key={phase.node_id}
                data-testid={`phase-plan-card-${phase.node_id}`}
              >
                <div className="phase-plan-card-head">
                  <strong>{phase.name ?? phase.node_id}</strong>
                  <Badge tone="info">
                    {phase.worker_count} worker{phase.worker_count === 1 ? "" : "s"}
                  </Badge>
                </div>
                {phase.description ? <p className="muted">{phase.description}</p> : null}
                <Field label="Model">
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
              </article>
            ))}

            {modifyOpen ? (
              <div className="form-stack" data-testid="phase-modify-form">
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
              <div className="actions">
                <Button
                  variant="primary"
                  data-testid="phase-approve"
                  disabled={decisionBusy}
                  onClick={() => void approve()}
                >
                  {decisionBusy ? "Working…" : "Approve"}
                </Button>
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
            )}
          </div>
        </section>
      ) : null}

      {runStatus === "approved" ? (
        <section
          className="card side-section phase-execution-status"
          data-testid="phase-execution-panel"
        >
          <div className="side-body form-stack">
            <div className="section-head">
              <div>
                <div className="eyebrow">Executing</div>
                <h3>Phase execution</h3>
              </div>
              <Badge tone="success">approved</Badge>
            </div>
            {executionKickoff === null || executionKickoff?.started === false ? (
              <p className="muted" data-testid="phase-execution-kickoff-note">
                Plan approved and recorded. Execution has not auto-started — it begins through the
                existing strategy and phase start flow.
                {executionKickoff?.started === false && executionKickoff.detail
                  ? ` (${executionKickoff.detail})`
                  : ""}
              </p>
            ) : null}
            {executionError ? <Alert testId="phase-execution-error">{executionError}</Alert> : null}
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
                        <td>{row.name}</td>
                        <td>
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
                        <td className="mono">{Math.round(row.percent_complete)}%</td>
                        <td>{row.est_completion ?? "—"}</td>
                        <td>{row.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Spinner label="Loading execution status…" />
            )}
          </div>
        </section>
      ) : null}

      {runStatus === "rejected" ? (
        <section className="card side-section" data-testid="phase-rejected-panel">
          <div className="side-body form-stack">
            <p className="muted">Plan rejected — this planning run is closed.</p>
            <Button data-testid="phase-new-run" onClick={resetToNewRun}>
              Start a new phase plan
            </Button>
          </div>
        </section>
      ) : null}

      {runStatus === "failed" ? (
        <section className="card side-section" data-testid="phase-failed-panel">
          <div className="side-body form-stack">
            <Alert testId="phase-run-failed">{run?.error ?? "The planning run failed."}</Alert>
            <Button data-testid="phase-new-run" onClick={resetToNewRun}>
              Start a new phase plan
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
