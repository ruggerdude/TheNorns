import {
  type CodexReasoningEffortT,
  DEFAULT_CODEX_REASONING_EFFORT,
  PM_MODEL_OPTIONS,
} from "@norns/contracts";
// PHASE TAB (P2): one flow from "describe the goal" to "watch execution".
//   a. Goal input (textarea + image attachments)
//   b. Setup selectors (agents, review rounds) + fixed PM/Reviewer identity
//   c. Start -> live planning-run progress (fast poll while active)
//   d. Decision panel at converged/cap_reached (the awaiting-decision states):
//      per-phase staffing dropdowns, Approve / Modify(direction) / Reject
//   e. Execution status table once approved (fast/idle poll cadence)
// ALL fetches go through phaseTabApi.ts (single reconciliation point for the
// integrator); this file renders and holds state only.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentInput } from "./AttachmentInput";
import "./PhaseTab.css";
import { UnauthorizedError } from "./auth";
import {
  type ExecutionModelCapability,
  PHASE_EXECUTION_ACTIVE_STATES,
  PHASE_RUN_ACTIVE_STATUSES,
  PHASE_RUN_DECISION_STATUSES,
  type PhaseExecutionKickoffReport,
  type PhaseExecutionStatusRow,
  type PhaseParticipantSelection,
  type PhasePlanStaffedPhase,
  type PhasePlanningRunDto,
  type PhaseRunMode,
  type WorkerProviders,
  getExecutionModelCapabilities,
  getLatestPhasePlanningRun,
  getPhaseExecutionStatus,
  getPhasePlanningRun,
  planPhasesFromRun,
  postPlanningRunDecision,
  retryPlanningRunExecution,
  startPhasePlanningRun,
} from "./phaseTabApi";
import { Alert, Badge, Button, Field, Select, Spinner, TextArea } from "./ui";

const ConversationWorkspace = lazy(() =>
  import("./ConversationWorkspace").then(({ ConversationWorkspace }) => ({
    default: ConversationWorkspace,
  })),
);

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

const CODEX_EFFORT_OPTIONS: readonly {
  value: CodexReasoningEffortT;
  label: string;
}[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

const PM_PARTICIPANT_OPTIONS = (Object.keys(PM_MODEL_OPTIONS) as Provider[]).flatMap((provider) =>
  PM_MODEL_OPTIONS[provider].map((model) => ({
    value: `${provider}:${model.id}`,
    label: model.label,
    provider,
    model: model.id,
  })),
);

interface ParticipantOption {
  value: string;
  label: string;
  provider: Provider;
  model: string;
}

export interface PhaseDesignatedExecutionSnapshot {
  phase: {
    id: string;
    objective_summary: string;
    status?: string;
  };
  tasks: Array<{
    id: string;
    title: string;
    run: {
      id: string;
      attempt: number;
      state: string;
      failure_detail: string | null;
    } | null;
  }>;
}

interface DesignatedAttempt {
  phaseId: string;
  attempt: number;
  state: string;
  failureDetail: string | null;
}

function participantFor(
  value: string,
  options: readonly ParticipantOption[],
  reasoningEffort?: CodexReasoningEffortT,
): PhaseParticipantSelection | undefined {
  const option = options.find((candidate) => candidate.value === value);
  return option
    ? {
        provider: option.provider,
        model: option.model,
        ...(option.provider === "openai" && reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : {}),
      }
    : undefined;
}

function participantLabel(
  value: string,
  fallback: string,
  options: readonly ParticipantOption[],
): string {
  return options.find((candidate) => candidate.value === value)?.label ?? fallback;
}

function effortLabel(effort: CodexReasoningEffortT | null | undefined): string {
  return CODEX_EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? "Medium";
}

function executionScopeForRun(
  run: PhasePlanningRunDto | null,
  kickoff: PhaseExecutionKickoffReport | null | undefined,
): { phaseIds: Set<string>; objectives: Set<string> } {
  const phaseIds = new Set(run?.result?.plan?.modules?.map((module) => module.id) ?? []);
  const objectives = new Set(
    [run?.objective, run?.result?.plan?.objective].filter((objective): objective is string =>
      Boolean(objective?.trim()),
    ),
  );

  // A successful kickoff identifies the new phase. A refusal may name the
  // *other* active phase that prevented dispatch, so only trust its id when
  // the detail explicitly says it belongs to this plan.
  if (
    kickoff?.detail &&
    (kickoff.started ||
      /phase for this plan/i.test(kickoff.detail) ||
      /was approved/i.test(kickoff.detail))
  ) {
    for (const match of kickoff.detail.matchAll(/\bphase\s+"[^"]+"\s+\(([^)]+)\)/gi)) {
      const phaseId = match[1]?.trim();
      if (phaseId) phaseIds.add(phaseId);
    }
    for (const match of kickoff.detail.matchAll(/phase for this plan\s+\("[^"]+",\s*([^)]+)\)/gi)) {
      const phaseId = match[1]?.trim();
      if (phaseId) phaseIds.add(phaseId);
    }
  }

  return { phaseIds, objectives };
}

/**
 * Execution status is project-scoped, while this screen presents one planning
 * run. Planned runs intentionally retain the full project view. A quick run
 * only shows rows that can be tied back to its objective, task ids, or durable
 * kickoff report so another active phase cannot mask a failed quick kickoff.
 */
function scopeExecutionRowsToRun(
  run: PhasePlanningRunDto | null,
  rows: PhaseExecutionStatusRow[] | null,
  kickoff: PhaseExecutionKickoffReport | null | undefined,
): PhaseExecutionStatusRow[] | null {
  if (!rows || run?.mode !== "quick") return rows;

  const { phaseIds, objectives } = executionScopeForRun(run, kickoff);

  return rows.filter((row) => phaseIds.has(row.phase_id) || objectives.has(row.name));
}

/**
 * The per-phase execution DTO carries the task's current designated run. It
 * is more precise than the phase-level progress row and newer than the
 * planning run's immutable kickoff report, so it is the primary presentation
 * source whenever it belongs to this planning run.
 */
function designatedAttemptsForRun(
  run: PhasePlanningRunDto | null,
  snapshot: PhaseDesignatedExecutionSnapshot | null | undefined,
  kickoff: PhaseExecutionKickoffReport | null | undefined,
): DesignatedAttempt[] {
  if (!run || !snapshot) return [];
  const { phaseIds, objectives } = executionScopeForRun(run, kickoff);
  if (!phaseIds.has(snapshot.phase.id) && !objectives.has(snapshot.phase.objective_summary)) {
    return [];
  }
  return snapshot.tasks.flatMap((task) =>
    task.run
      ? [
          {
            phaseId: snapshot.phase.id,
            attempt: task.run.attempt,
            state: task.run.state,
            failureDetail: task.run.failure_detail,
          },
        ]
      : [],
  );
}

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

const QUICK_JOURNEY_STEPS = [
  {
    label: "Preparing",
    description: "The PM turns your request into one executable task.",
  },
  {
    label: "Starting",
    description: "The selected agent is assigned without a review round.",
  },
  {
    label: "Working",
    description: "Follow implementation and verification progress.",
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

export interface PhaseTabProps {
  projectId: string;
  initialRunId?: string | null;
  initialConversationId?: string | null;
  initialNewConversation?: boolean;
  designatedExecution?: PhaseDesignatedExecutionSnapshot | null;
  composerRequested?: boolean;
  onComposerOpened?: () => void;
  onRunStarted?: (runId: string) => void;
  onJourneyChanged?: () => void;
  onOpenRecoveryDetails?: (phaseId: string) => void;
  onConversationSelected?: (conversationId: string, replace?: boolean) => void;
  onNewConversation?: () => void;
  onUnauthorized: () => void;
}

function LegacyPhaseTab({
  projectId,
  initialRunId = null,
  designatedExecution = null,
  composerRequested = false,
  onComposerOpened,
  onRunStarted,
  onJourneyChanged,
  onOpenRecoveryDetails,
  onUnauthorized,
}: PhaseTabProps): React.ReactElement {
  // a/b — setup form
  const [goal, setGoal] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [mode, setMode] = useState<PhaseRunMode>("quick");
  const [agents, setAgents] = useState<WorkerProviders>("both");
  const [reviewRounds, setReviewRounds] = useState(2);
  const [pmSelection, setPmSelection] = useState("");
  const [pmEffort, setPmEffort] = useState<CodexReasoningEffortT>(DEFAULT_CODEX_REASONING_EFFORT);
  const [agentSelection, setAgentSelection] = useState("");
  const [agentEffort, setAgentEffort] = useState<CodexReasoningEffortT>(
    DEFAULT_CODEX_REASONING_EFFORT,
  );
  const [customizeTeam, setCustomizeTeam] = useState(false);
  const [executionModels, setExecutionModels] = useState<ExecutionModelCapability[] | null>(null);
  const [executionCapabilityError, setExecutionCapabilityError] = useState<string | null>(null);
  // c — run lifecycle
  const [runId, setRunId] = useState<string | null>(composerRequested ? null : initialRunId);
  const [run, setRun] = useState<PhasePlanningRunDto | null>(null);
  const [recoveryAttempted, setRecoveryAttempted] = useState(
    composerRequested || Boolean(initialRunId),
  );
  const [recovering, setRecovering] = useState(!composerRequested && !initialRunId);
  // The worker_providers the active run was started with — model dropdowns in
  // the decision panel are filtered to these.
  const [activeProviders, setActiveProviders] = useState<Provider[]>(["anthropic", "openai"]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // d — decision panel
  const [staffingDrafts, setStaffingDrafts] = useState<Record<string, string>>({});
  const [staffingEffortDrafts, setStaffingEffortDrafts] = useState<
    Record<string, CodexReasoningEffortT>
  >({});
  const [modifyOpen, setModifyOpen] = useState(false);
  const [direction, setDirection] = useState("");
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const quickApprovalAttempts = useRef(new Set<string>());
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
  const lastInitialRunId = useRef(initialRunId);

  const fail = useCallback(
    (err: unknown, sink: (message: string) => void) => {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else sink(err instanceof Error ? err.message : String(err));
    },
    [onUnauthorized],
  );

  useEffect(() => {
    let current = true;
    void getExecutionModelCapabilities()
      .then((capabilities) => {
        if (!current) return;
        setExecutionModels(capabilities.models);
        setExecutionCapabilityError(null);
      })
      .catch((err) => {
        if (!current) return;
        if (err instanceof UnauthorizedError) onUnauthorized();
        setExecutionModels([]);
        setExecutionCapabilityError(
          err instanceof Error ? err.message : "Could not verify execution agent availability.",
        );
      });
    return () => {
      current = false;
    };
  }, [onUnauthorized]);

  const executionParticipantOptions = useMemo<ParticipantOption[]>(
    () =>
      (executionModels ?? [])
        .filter((model) => model.available)
        .map((model) => ({
          value: `${model.provider}:${model.id}`,
          label: model.label,
          provider: model.provider,
          model: model.id,
        })),
    [executionModels],
  );
  const availableExecutionProviders = useMemo(
    () => new Set(executionParticipantOptions.map((option) => option.provider)),
    [executionParticipantOptions],
  );

  // A navigation hint opens the just-created run immediately. If the hint was
  // lost to a refresh, recover the newest durable run instead of showing a
  // second setup form and inviting accidental duplicate planning.
  useEffect(() => {
    if (!initialRunId || initialRunId === lastInitialRunId.current) return;
    lastInitialRunId.current = initialRunId;
    setRunId(initialRunId);
    setRun(null);
    setRecoveryAttempted(true);
    setRecovering(false);
  }, [initialRunId]);

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
        setExecutionKickoff(planning_run.execution ?? null);
      })
      .catch((err) => fail(err, setError))
      .finally(() => setRecovering(false));
  }, [recoveryAttempted, runId, projectId, fail]);

  const start = useCallback(async () => {
    if (!goal.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const pm = participantFor(pmSelection, PM_PARTICIPANT_OPTIONS, pmEffort);
      const agent = participantFor(agentSelection, executionParticipantOptions, agentEffort);
      const workerProviders = agent?.provider ?? agents;
      const created = await startPhasePlanningRun(projectId, {
        objective: goal.trim(),
        attachment_ids: attachmentIds,
        mode,
        review_rounds: mode === "quick" ? 0 : reviewRounds,
        worker_providers: workerProviders,
        ...(pm ? { pm } : {}),
        ...(agent ? { agent } : {}),
      });
      setActiveProviders(providersFor(workerProviders));
      setRunId(created.planning_run_id);
      setRun(null);
      setStaffingDrafts({});
      setStaffingEffortDrafts({});
      setModifyOpen(false);
      setDirection("");
      setConfirmingReject(false);
      setExecutionRows(null);
      setExecutionError(null);
      setExecutionKickoff(undefined);
      quickApprovalAttempts.current.delete(created.planning_run_id);
      onRunStarted?.(created.planning_run_id);
    } catch (err) {
      fail(err, setError);
    } finally {
      setStarting(false);
    }
  }, [
    goal,
    attachmentIds,
    mode,
    reviewRounds,
    agents,
    pmSelection,
    pmEffort,
    agentSelection,
    agentEffort,
    executionParticipantOptions,
    projectId,
    fail,
    onRunStarted,
  ]);

  const pollRun = useCallback(async () => {
    if (!runId) return;
    try {
      const next = await getPhasePlanningRun(projectId, runId);
      setRun(next);
      setActiveProviders(providersFor(next.worker_providers));
      setExecutionKickoff(next.execution ?? null);
    } catch (err) {
      fail(err, setError);
    }
  }, [runId, projectId, fail]);

  // Poll the run: fast while the loop is producing, idle while it waits on
  // the human decision, stopped once terminal (approved/rejected/failed).
  const runStatus = run?.status ?? null;
  const runMode = run?.mode ?? "planned";
  const visibleExecutionRows = useMemo(
    () => scopeExecutionRowsToRun(run, executionRows, executionKickoff),
    [run, executionRows, executionKickoff],
  );
  const designatedAttempts = useMemo(
    () => designatedAttemptsForRun(run, designatedExecution, executionKickoff),
    [run, designatedExecution, executionKickoff],
  );
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
    visibleExecutionRows?.some((row) => PHASE_EXECUTION_ACTIVE_STATES.has(row.state)) ?? true;
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
  const staffingProvider = (phase: PhasePlanStaffedPhase): Provider =>
    staffingValue(phase).split(":", 1)[0] as Provider;
  const staffingEffortValue = (phase: PhasePlanStaffedPhase): CodexReasoningEffortT =>
    staffingEffortDrafts[phase.node_id] ?? phase.reasoning_effort ?? DEFAULT_CODEX_REASONING_EFFORT;

  const decide = useCallback(
    async (body: Parameters<typeof postPlanningRunDecision>[2]) => {
      if (!runId) return;
      setDecisionBusy(true);
      setError(null);
      try {
        const decided = await postPlanningRunDecision(projectId, runId, body);
        setRun(decided);
        setExecutionKickoff(decided.execution ?? null);
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

  useEffect(() => {
    if (
      !runId ||
      run?.mode !== "quick" ||
      !PHASE_RUN_DECISION_STATUSES.has(run.status) ||
      quickApprovalAttempts.current.has(runId)
    ) {
      return;
    }
    quickApprovalAttempts.current.add(runId);
    void decide({ decision: "approve" });
  }, [runId, run, decide]);

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
        reasoning_effort: provider === "openai" ? staffingEffortValue(phase) : null,
      };
    });
    return decide({ decision: "approve", staffing });
  };

  const resetToNewRun = useCallback(
    (nextMode: PhaseRunMode = "quick") => {
      if (runId) quickApprovalAttempts.current.delete(runId);
      setGoal("");
      setAttachmentIds([]);
      setMode(nextMode);
      setRunId(null);
      setRun(null);
      setError(null);
      setStaffingDrafts({});
      setStaffingEffortDrafts({});
      setModifyOpen(false);
      setDirection("");
      setConfirmingReject(false);
      setExecutionRows(null);
      setExecutionError(null);
      setExecutionKickoff(undefined);
      setRecoveryAttempted(true);
      setRecovering(false);
      onComposerOpened?.();
    },
    [runId, onComposerOpened],
  );

  const runIsActive = runStatus !== null && PHASE_RUN_ACTIVE_STATUSES.has(runStatus);
  const runAwaitsDecision = runStatus !== null && PHASE_RUN_DECISION_STATUSES.has(runStatus);
  const showSetupForm = recoveryAttempted && !recovering && !runId;
  const journeyStage =
    runStatus === "approved" ? 3 : runAwaitsDecision || runStatus === "rejected" ? 2 : 1;
  const journeySteps = runMode === "quick" ? QUICK_JOURNEY_STEPS : JOURNEY_STEPS;

  const reviewerFindings = (run?.transcript ?? []).filter((entry) => entry.role === "reviewer");
  const failedExecutionRows = visibleExecutionRows?.filter((row) => row.state === "failed") ?? [];
  const blockedExecutionRows = visibleExecutionRows?.filter((row) => row.state === "blocked") ?? [];
  const terminalDesignatedAttempt = designatedAttempts
    .filter((attempt) => attempt.state === "failed" || attempt.state === "expired")
    .sort((left, right) => right.attempt - left.attempt)[0];
  const activeDesignatedAttempt = designatedAttempts
    .filter((attempt) => ["created", "dispatched", "running", "verifying"].includes(attempt.state))
    .sort((left, right) => right.attempt - left.attempt)[0];
  const executionHasActivePhase =
    visibleExecutionRows?.some((row) => PHASE_EXECUTION_ACTIVE_STATES.has(row.state)) ?? false;
  const executionHasActiveWork = Boolean(activeDesignatedAttempt) || executionHasActivePhase;
  const designatedPhaseIsClosed =
    designatedAttempts.length > 0 &&
    ["completed", "cancelled"].includes(designatedExecution?.phase.status ?? "");
  const executionIsClosed =
    designatedPhaseIsClosed ||
    (Boolean(visibleExecutionRows?.length) &&
      (visibleExecutionRows?.every(
        (row) => row.state === "completed" || row.state === "cancelled",
      ) ??
        false));
  const executionStartRetryAvailable =
    executionRows !== null &&
    failedExecutionRows.length === 0 &&
    blockedExecutionRows.length === 0 &&
    !executionHasActiveWork &&
    !executionIsClosed &&
    ((visibleExecutionRows?.length ?? 0) === 0 ||
      visibleExecutionRows?.some((row) =>
        ["proposed", "awaiting_approval", "approved"].includes(row.state),
      ));
  const quickKickoffNeedsAttention = runMode === "quick" && executionKickoff?.started === false;
  const executionDisplayState:
    | "failed"
    | "blocked"
    | "active"
    | "closed"
    | "start_attention"
    | "loading" = terminalDesignatedAttempt
    ? "failed"
    : activeDesignatedAttempt
      ? "active"
      : failedExecutionRows.length > 0
        ? "failed"
        : blockedExecutionRows.length > 0
          ? "blocked"
          : executionHasActiveWork
            ? "active"
            : executionIsClosed
              ? "closed"
              : quickKickoffNeedsAttention
                ? "start_attention"
                : executionStartRetryAvailable || executionKickoff?.started === false
                  ? "start_attention"
                  : executionRows === null && executionKickoff?.started === true
                    ? "active"
                    : "loading";
  const executionNeedsAttention =
    executionDisplayState === "failed" ||
    executionDisplayState === "blocked" ||
    executionDisplayState === "start_attention";
  const recoveryPhaseId = executionIsClosed
    ? null
    : (terminalDesignatedAttempt?.phaseId ??
      failedExecutionRows[0]?.phase_id ??
      blockedExecutionRows[0]?.phase_id ??
      null);
  const affectedExecutionNames = [...failedExecutionRows, ...blockedExecutionRows]
    .map((row) => row.name)
    .join(", ");

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
            {journeySteps.map((step, index) => {
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
            <fieldset className="phase-mode-picker">
              <legend className="sr-only">Choose a phase workflow</legend>
              <button
                type="button"
                className={mode === "quick" ? "phase-mode-option is-selected" : "phase-mode-option"}
                data-testid="phase-mode-quick"
                aria-pressed={mode === "quick"}
                disabled={starting}
                onClick={() => setMode("quick")}
              >
                <strong>Quick change</strong>
                <span>One task · no reviewer · starts automatically</span>
              </button>
              <button
                type="button"
                className={
                  mode === "planned" ? "phase-mode-option is-selected" : "phase-mode-option"
                }
                data-testid="phase-mode-planned"
                aria-pressed={mode === "planned"}
                disabled={starting}
                onClick={() => setMode("planned")}
              >
                <strong>Planned phase</strong>
                <span>Detailed plan · review rounds · approval</span>
              </button>
            </fieldset>
            <AttachmentInput
              variant="composer"
              label={mode === "quick" ? "What should change?" : "What should this phase deliver?"}
              textAreaTestId="phase-goal"
              placeholder={
                mode === "quick"
                  ? "Describe the tweak, paste a screenshot, or add a reference file…"
                  : "Describe the goal, paste a screenshot, or add a reference file…"
              }
              textValue={goal}
              onTextChange={setGoal}
              projectId={projectId}
              value={attachmentIds}
              onChange={setAttachmentIds}
              purpose="objective"
              disabled={starting}
            />
            {mode === "planned" ? (
              <div className="two-col-fields">
                <Field label="Available agent providers">
                  <Select
                    data-testid="phase-agents"
                    value={agents}
                    disabled={starting || Boolean(agentSelection)}
                    onChange={(event) => setAgents(event.target.value as WorkerProviders)}
                  >
                    <option
                      value="anthropic"
                      disabled={!availableExecutionProviders.has("anthropic")}
                    >
                      Claude
                    </option>
                    <option value="openai" disabled={!availableExecutionProviders.has("openai")}>
                      ChatGPT
                    </option>
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
            ) : (
              <div className="phase-quick-summary" data-testid="phase-quick-summary">
                <span aria-hidden="true">↗</span>
                <p>
                  The PM prepares one focused task, the agent implements it, and relevant checks
                  still run. There is no reviewer or plan approval step.
                </p>
              </div>
            )}

            <button
              type="button"
              className="phase-team-toggle"
              aria-expanded={customizeTeam}
              data-testid="phase-team-toggle"
              disabled={starting}
              onClick={() => setCustomizeTeam((current) => !current)}
            >
              <span>
                <strong>Override PM or agent</strong>
                <small>Optional · Recommended staffing is ready by default</small>
              </span>
              <span aria-hidden="true">{customizeTeam ? "−" : "+"}</span>
            </button>

            {customizeTeam ? (
              <div className="two-col-fields phase-team-fields" data-testid="phase-team-fields">
                <Field label="PM">
                  <Select
                    data-testid="phase-pm"
                    value={pmSelection}
                    disabled={starting}
                    onChange={(event) => setPmSelection(event.target.value)}
                  >
                    <option value="">Project default</option>
                    {(Object.keys(PM_MODEL_OPTIONS) as Provider[]).map((provider) => (
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
                {participantFor(pmSelection, PM_PARTICIPANT_OPTIONS)?.provider === "openai" ? (
                  <Field label="PM Codex effort">
                    <Select
                      data-testid="phase-pm-effort"
                      value={pmEffort}
                      disabled={starting}
                      onChange={(event) => setPmEffort(event.target.value as CodexReasoningEffortT)}
                    >
                      {CODEX_EFFORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
                <Field label="Agent">
                  <Select
                    data-testid="phase-agent"
                    value={agentSelection}
                    disabled={starting || executionModels === null}
                    onChange={(event) => setAgentSelection(event.target.value)}
                  >
                    <option value="">Recommended model for each task</option>
                    {(Object.keys(PM_MODEL_OPTIONS) as Provider[]).map((provider) => (
                      <optgroup key={provider} label={PROVIDER_GROUP_LABEL[provider]}>
                        {executionParticipantOptions
                          .filter((option) => option.provider === provider)
                          .map((option) => (
                            <option key={option.model} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </Select>
                </Field>
                {participantFor(agentSelection, executionParticipantOptions)?.provider ===
                "openai" ? (
                  <Field label="Agent Codex effort">
                    <Select
                      data-testid="phase-agent-effort"
                      value={agentEffort}
                      disabled={starting}
                      onChange={(event) =>
                        setAgentEffort(event.target.value as CodexReasoningEffortT)
                      }
                    >
                      {CODEX_EFFORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}
              </div>
            ) : null}

            <p className="muted phase-identity-line" data-testid="phase-identity-line">
              PM: {participantLabel(pmSelection, "Project default", PM_PARTICIPANT_OPTIONS)}
              {participantFor(pmSelection, PM_PARTICIPANT_OPTIONS)?.provider === "openai"
                ? ` (${effortLabel(pmEffort)} effort)`
                : ""}{" "}
              · Agent:{" "}
              {participantLabel(
                agentSelection,
                "Recommended model for each task",
                executionParticipantOptions,
              )}
              {participantFor(agentSelection, executionParticipantOptions)?.provider === "openai"
                ? ` (${effortLabel(agentEffort)} effort)`
                : ""}
              {mode === "planned" ? " · Reviewer: Automatic cross-provider" : " · No reviewer"}
            </p>
            {executionCapabilityError ? (
              <Alert testId="phase-execution-models-unavailable">
                Execution agent availability could not be verified. {executionCapabilityError}
              </Alert>
            ) : executionModels !== null && executionParticipantOptions.length === 0 ? (
              <Alert testId="phase-execution-models-unavailable">
                No execution agents are available. Configure the runner model allowlist and a
                provider API key before starting work.
              </Alert>
            ) : null}
            <Button
              variant="primary"
              data-testid="phase-start"
              disabled={
                starting ||
                !goal.trim() ||
                executionModels === null ||
                executionParticipantOptions.length === 0
              }
              onClick={() => void start()}
            >
              {starting
                ? mode === "quick"
                  ? "Preparing change…"
                  : "Starting plan…"
                : mode === "quick"
                  ? "Make change"
                  : "Start planning"}
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
                <div className="eyebrow">{runMode === "quick" ? "Quick change" : "Planning"}</div>
                <h3 id="phase-planning-title" data-testid="phase-run-status" aria-live="polite">
                  {runMode === "quick"
                    ? "Preparing one focused task"
                    : run
                      ? runStatusLabel(run)
                      : "Starting the plan…"}
                </h3>
              </div>
              <Badge tone="info">In progress</Badge>
            </div>
            {run && runMode !== "quick" ? (
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
              <Spinner
                label={
                  runMode === "quick"
                    ? "The PM is preparing the change for the selected agent…"
                    : "Coordinator and reviewer are working…"
                }
              />
            </output>
            {runMode !== "quick" && reviewerFindings.length > 0 ? (
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

      {run && runAwaitsDecision && runMode === "quick" ? (
        <section
          className="card side-section phase-state-card phase-quick-starting"
          data-testid="phase-quick-starting"
          aria-labelledby="phase-quick-starting-title"
        >
          <div className="side-body form-stack">
            <div className="section-head phase-state-heading">
              <div>
                <div className="eyebrow">No review required</div>
                <h3 id="phase-quick-starting-title">Starting the selected agent</h3>
              </div>
              <Badge tone="info">Automatic</Badge>
            </div>
            <p className="muted">
              The focused task is ready. It is being approved and dispatched without a reviewer or
              another decision from you.
            </p>
            {error ? (
              <Button
                variant="primary"
                disabled={decisionBusy}
                onClick={() => void decide({ decision: "approve" })}
              >
                {decisionBusy ? "Starting…" : "Try starting again"}
              </Button>
            ) : (
              <Spinner label="Starting implementation…" />
            )}
          </div>
        </section>
      ) : null}

      {run && runAwaitsDecision && runMode !== "quick" ? (
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
              The coordinator and reviewer have prepared the coding plan. Review the work items
              below, then approve once to staff and dispatch them.
            </p>

            <ul className="phase-plan-meta" data-testid="phase-decision-rounds">
              <li>
                <strong>{planPhases.length}</strong>
                <span>implementation task{planPhases.length === 1 ? "" : "s"}</span>
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

            <div className="phase-plan-list" aria-label="Implementation tasks">
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
                    <div className="phase-plan-badges">
                      <Badge tone="success">Recommended</Badge>
                      <Badge tone="info">
                        {phase.worker_count} worker{phase.worker_count === 1 ? "" : "s"}
                      </Badge>
                    </div>
                  </div>
                  {phase.description ? <p className="muted">{phase.description}</p> : null}
                  <div
                    className="phase-agent-recommendation"
                    data-testid={`phase-agent-recommendation-${phase.node_id}`}
                  >
                    <strong>
                      {participantLabel(
                        `${phase.provider}:${phase.model}`,
                        phase.model,
                        executionParticipantOptions,
                      )}
                    </strong>
                    {phase.provider === "openai" ? (
                      <span>{effortLabel(phase.reasoning_effort)} effort</span>
                    ) : null}
                  </div>
                  {phase.rationale ? (
                    <p className="phase-agent-rationale">{phase.rationale}</p>
                  ) : null}
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
                        <div className="phase-staffing-controls">
                          <Select
                            aria-label={`${phase.name ?? phase.node_id} agent model`}
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
                                {executionParticipantOptions
                                  .filter((option) => option.provider === provider)
                                  .map((option) => (
                                    <option key={option.model} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                          </Select>
                          {staffingProvider(phase) === "openai" ? (
                            <Select
                              aria-label={`${phase.name ?? phase.node_id} Codex effort`}
                              data-testid={`phase-staffing-effort-${phase.node_id}`}
                              value={staffingEffortValue(phase)}
                              disabled={decisionBusy}
                              onChange={(event) =>
                                setStaffingEffortDrafts((current) => ({
                                  ...current,
                                  [phase.node_id]: event.target.value as CodexReasoningEffortT,
                                }))
                              }
                            >
                              {CODEX_EFFORT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label} effort
                                </option>
                              ))}
                            </Select>
                          ) : null}
                        </div>
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
                  {executionDisplayState === "failed"
                    ? "Coding stopped"
                    : executionDisplayState === "blocked"
                      ? "Coding needs attention"
                      : executionDisplayState === "active"
                        ? "Coding is underway"
                        : executionDisplayState === "closed"
                          ? "Coding is complete"
                          : executionDisplayState === "start_attention"
                            ? "Coding needs a restart"
                            : "Preparing coding status…"}
                </h3>
              </div>
              <Badge
                tone={
                  executionDisplayState === "failed"
                    ? "danger"
                    : executionNeedsAttention
                      ? "warn"
                      : executionDisplayState === "active"
                        ? "info"
                        : "success"
                }
              >
                {executionDisplayState === "failed"
                  ? "Stopped"
                  : executionNeedsAttention
                    ? "Needs attention"
                    : executionDisplayState === "closed"
                      ? "Complete"
                      : executionDisplayState === "active"
                        ? "In progress"
                        : "Approved"}
              </Badge>
            </div>
            {planPhases.length > 0 ? (
              <div
                className="phase-execution-team"
                data-testid="phase-execution-team"
                aria-label="Assigned implementation team"
              >
                {planPhases.map((phase) => (
                  <div key={phase.node_id}>
                    <span>{phase.name ?? phase.node_id}</span>
                    <strong>
                      {participantLabel(
                        `${phase.provider}:${phase.model}`,
                        phase.model,
                        executionParticipantOptions,
                      )}
                      {phase.provider === "openai"
                        ? ` · ${effortLabel(phase.reasoning_effort)} effort`
                        : ""}
                    </strong>
                  </div>
                ))}
              </div>
            ) : null}
            <output
              className={
                executionNeedsAttention
                  ? "phase-kickoff-note needs-attention"
                  : "phase-kickoff-note"
              }
              aria-live="polite"
            >
              {executionDisplayState === "failed" ? (
                <p data-testid="phase-execution-kickoff-note">
                  {terminalDesignatedAttempt ? (
                    <>
                      Attempt {terminalDesignatedAttempt.attempt} {terminalDesignatedAttempt.state}
                      {terminalDesignatedAttempt.failureDetail
                        ? `: ${terminalDesignatedAttempt.failureDetail.replace(/[.!?]+$/, "")}`
                        : " without a verified result"}
                      {executionIsClosed
                        ? ". This closed phase is retained here as read-only history."
                        : ". Open recovery details to inspect the current attempt and decide the next step."}
                    </>
                  ) : (
                    <>
                      Coding stopped after it started
                      {affectedExecutionNames ? ` for ${affectedExecutionNames}` : ""}. Open
                      recovery details to inspect the failed work and decide the next step.
                    </>
                  )}
                </p>
              ) : executionDisplayState === "blocked" ? (
                <p data-testid="phase-execution-kickoff-note">
                  Coding is blocked
                  {affectedExecutionNames ? ` for ${affectedExecutionNames}` : ""}. Open recovery
                  details to see what needs attention.
                </p>
              ) : executionDisplayState === "closed" ? (
                <p data-testid="phase-execution-kickoff-note">
                  This implementation work is complete or closed. You can start the next planned
                  phase or make a quick change.
                </p>
              ) : executionDisplayState === "active" &&
                executionHasActiveWork &&
                quickKickoffNeedsAttention ? (
                <p data-testid="phase-execution-kickoff-note">
                  {runMode === "quick"
                    ? "The recovered quick change is now running."
                    : "Implementation is currently running."}
                  {activeDesignatedAttempt
                    ? ` Attempt ${activeDesignatedAttempt.attempt} is ${activeDesignatedAttempt.state}.`
                    : ""}
                </p>
              ) : executionKickoff?.started ? (
                <p data-testid="phase-execution-kickoff-note">
                  {runMode === "quick"
                    ? "The quick change started automatically."
                    : "Execution started automatically from this approval."}
                  {executionKickoff.detail ? ` ${executionKickoff.detail}` : ""}
                </p>
              ) : executionKickoff?.started === false ? (
                <p data-testid="phase-execution-kickoff-note">
                  {runMode === "quick"
                    ? "The quick change is recorded, but coding did not start."
                    : "Plan approved and recorded, but coding did not start."}
                  {executionKickoff.detail ? ` ${executionKickoff.detail}` : ""}
                </p>
              ) : (
                <p data-testid="phase-execution-kickoff-note">
                  {runMode === "quick"
                    ? "Quick change dispatched. Checking the current coding status…"
                    : "Plan approved. Checking the current coding status…"}
                </p>
              )}
            </output>
            {recoveryPhaseId && onOpenRecoveryDetails ? (
              <Button
                variant="primary"
                className="phase-primary-action"
                data-testid="phase-open-recovery-details"
                onClick={() => onOpenRecoveryDetails(recoveryPhaseId)}
              >
                Open recovery details
              </Button>
            ) : null}
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
            {visibleExecutionRows?.length ? (
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
                    {visibleExecutionRows.map((row) => (
                      <tr key={row.phase_id} data-testid={`phase-execution-row-${row.phase_id}`}>
                        <td data-label="Phase">{row.name}</td>
                        <td data-label="State">
                          <Badge
                            tone={
                              row.state === "failed"
                                ? "danger"
                                : row.state === "blocked"
                                  ? "warn"
                                  : row.state === "completed"
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
            ) : executionRows === null ? (
              <output aria-live="polite">
                <Spinner label="Loading coding status…" />
              </output>
            ) : null}
          </div>
        </section>
      ) : null}

      {runStatus === "approved" && executionIsClosed ? (
        <section
          className="card side-section phase-state-card phase-new-work"
          data-testid="phase-new-work"
          aria-labelledby="phase-new-work-title"
        >
          <div className="side-body form-stack">
            <div>
              <div className="eyebrow">New work</div>
              <h3 id="phase-new-work-title">Start something new</h3>
              <p className="muted">
                The previous phase remains above as read-only history. Start a new planned phase or
                make another focused change.
              </p>
            </div>
            <div className="phase-next-actions" data-testid="phase-next-actions">
              <Button
                variant="primary"
                data-testid="phase-start-another"
                onClick={() => resetToNewRun("planned")}
              >
                New planned phase
              </Button>
              <Button data-testid="phase-start-quick" onClick={() => resetToNewRun("quick")}>
                New quick change
              </Button>
            </div>
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
            <Button data-testid="phase-new-run" onClick={() => resetToNewRun("planned")}>
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
              onClick={() => resetToNewRun("planned")}
            >
              Plan again
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Conversation-first Work surface. The legacy phase journey remains a
 * compatibility fallback only for deployments that have not yet installed
 * the conversation routes; all assistant-ui and AI SDK code stays behind the
 * dynamic import so the application entry bundle remains unchanged.
 */
export function PhaseTab(props: PhaseTabProps): React.ReactElement {
  const [conversationUnsupported, setConversationUnsupported] = useState(false);

  if (conversationUnsupported) return <LegacyPhaseTab {...props} />;

  return (
    <Suspense
      fallback={
        <section
          className="card side-section phase-state-card phase-run-recovering"
          aria-label="Loading conversation workspace"
        >
          <div className="side-body">
            <Spinner label="Loading conversations…" />
          </div>
        </section>
      }
    >
      <ConversationWorkspace
        projectId={props.projectId}
        initialConversationId={props.initialConversationId}
        initialNewConversation={props.initialNewConversation}
        onConversationSelected={props.onConversationSelected}
        onNewConversation={props.onNewConversation}
        onUnsupported={() => setConversationUnsupported(true)}
        onUnauthorized={props.onUnauthorized}
      />
    </Suspense>
  );
}
