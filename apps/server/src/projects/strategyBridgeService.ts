// FRONT DOOR P3 — the planning-run -> relational-strategy bridge.
//
// A converged/cap_reached planning run (FRONT DOOR P2 §D1) produces a
// { plan, staffing_proposal } result but NO relational entities: pre-
// materialization there is no Strategy/Task/AgentProfile to hang a
// V2StrategyAssignmentProposal on. This service closes that gap. It maps a
// plan's modules into a proposed StrategyVersion (objectives + tasks +
// assignment proposals) and drives it through the EXISTING phase-3 workflow
// services (PhaseWorkflowService, StrategyWorkflowService) — the canonical,
// transactional, idempotent lifecycle. It does NOT invent a parallel lifecycle
// and does NOT write phase/strategy rows directly (ADR-005/ADR-007): every
// state transition goes through those services, whose commands are each
// atomic (state + events + outbox) and idempotent.
//
// The bridge itself is a convergent, idempotent saga over those commands:
//   1. ensure the phase (bound to the planning run, one phase per run),
//   2. ensure the agent profiles referenced by the staffing proposal,
//   3. ensure the version-1 proposed StrategyVersion.
// Re-running it after any partial failure converges to the same phase and
// strategy. Approval and materialization reuse StrategyWorkflowService.approve
// verbatim — no new approval semantics.
import { createHash } from "node:crypto";
import {
  type PlanContractT,
  type PlanModuleT,
  type V2StrategyAssignmentProposalT,
  type V2StrategyFindingT,
  type V2StrategyObjectiveProposalT,
  type V2StrategyTaskProposalT,
  type V2StrategyVersionT,
  V2_DEFAULT_VERIFICATION_POLICY_REF,
  fingerprintV2StrategyImmutableContent,
  validatePlan,
} from "@norns/contracts";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { PhaseWorkflowService } from "./phaseWorkflowService.js";
import type { StrategyWorkflowService } from "./strategyWorkflowService.js";

// The bridge-created agent profiles are real staffing targets (unlike the
// disabled legacy-import profiles), so they carry an executable-shaped default
// rather than context_limit_tokens=1.
const DEFAULT_CONTEXT_LIMIT_TOKENS = 200_000;
const BRIDGE_OBJECTIVE_LOCAL_ID = "objective-1";
const DEFAULT_REQUIRED_ROLE = "implementation";
const DEFAULT_RATIONALE_FACTORS: V2StrategyAssignmentProposalT["rationale_factors"] = [
  "capability",
  "budget",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Cross-provider default: the reviewer runs on the opposite provider. */
function crossProvider(provider: string): string {
  if (provider === "anthropic") return "openai";
  if (provider === "openai") return "anthropic";
  return provider;
}

function deterministicProfileId(provider: string, model: string): string {
  return `agent-profile:${sha256(JSON.stringify([provider, provider, model])).slice(0, 32)}`;
}

export type StrategyBridgeErrorCode =
  | "planning_run_not_found"
  | "planning_run_not_ready"
  | "planning_run_result_missing"
  | "invalid_plan"
  | "phase_not_found"
  | "no_proposed_strategy"
  | "assignment_not_found"
  | "profile_pair_incomplete";

export class StrategyBridgeError extends Error {
  constructor(
    readonly code: StrategyBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StrategyBridgeError";
  }
}

/** Actor attributed to the bridge's phase/strategy/approval commands. */
export interface StrategyBridgeActor {
  actor_id: string;
}

export interface CreatePhaseFromPlanningRunInput {
  projectId: string;
  planningRunId: string;
  name?: string;
  actor: StrategyBridgeActor;
}

export interface StaffingAssignmentEdit {
  /** The assignment's stable local_id, as surfaced in the review DTO. */
  assignment_id: string;
  provider?: string | undefined;
  model?: string | undefined;
  /** Set the reviewer provider/model. Both are required together to resolve a
   *  reviewer profile; omit `reviewer_model` (or set clear_reviewer) to drop
   *  the reviewer. */
  reviewer_provider?: string | undefined;
  reviewer_model?: string | undefined;
  clear_reviewer?: boolean | undefined;
  budget_limit_usd?: number | undefined;
}

export interface EditStaffingInput {
  projectId: string;
  phaseId: string;
  edits: StaffingAssignmentEdit[];
  actor: StrategyBridgeActor;
}

export interface ApproveStrategyInput {
  projectId: string;
  phaseId: string;
  /** Optional anti-stale guard: the content hash the approver reviewed. When
   *  provided it must match the current proposed strategy (existing approval
   *  staleness semantics); when omitted the bridge fills the current hash. */
  expectedContentHash?: string;
  idempotencyKey?: string;
  actor: StrategyBridgeActor;
}

// ---- plan-review DTO (deliverable 4; consumed by the P1 Plan Review screen) --

export interface StrategyReviewObjectiveDto {
  local_id: string;
  outcome: string;
  success_measures: string[];
}

export interface StrategyReviewTaskDto {
  local_id: string;
  objective_local_id: string;
  title: string;
  description: string;
  deliverables: string[];
  acceptance_criteria: string[];
  complexity: string;
  risk: string;
  required_roles: string[];
  dependency_local_ids: string[];
}

export interface StrategyReviewStaffingDto {
  assignment_id: string;
  task_local_id: string;
  task_title: string;
  required_roles: string[];
  provider: string | null;
  model: string | null;
  reviewer_provider: string | null;
  reviewer_model: string | null;
  budget_limit_usd: number;
  rationale: string;
  rationale_factors: string[];
}

export interface StrategyReviewRoundsDto {
  planning_run_id: string;
  status: string;
  round: number;
  max_rounds: number;
  transcript: unknown[];
}

export interface StrategyReviewDto {
  phase: {
    id: string;
    status: string;
    objective_summary: string;
    approved_strategy_version_id: string | null;
    approved_budget_usd: number;
    aggregate_version: number;
  };
  rounds: StrategyReviewRoundsDto | null;
  strategy: {
    id: string;
    version: number;
    status: string;
    aggregate_version: number;
    content_hash: string;
    objective: string;
    assumptions: string[];
    risks: string[];
    scope_in: string[];
    scope_out: string[];
    architecture_impact: string;
    convergence: string;
    review_rounds: number;
    proposed_concurrency: number;
    proposed_budget_usd: number;
    objectives: StrategyReviewObjectiveDto[];
    tasks: StrategyReviewTaskDto[];
    staffing: StrategyReviewStaffingDto[];
    findings: V2StrategyFindingT[];
  } | null;
  outstanding_findings: V2StrategyFindingT[];
}

export interface ApproveStrategyResult {
  strategy_version_id: string;
  approval_id: string;
  objectives: number;
  tasks: number;
  review: StrategyReviewDto;
}

interface PlanningRunRow {
  id: string;
  project_id: string;
  status: string;
  round: number;
  max_rounds: number;
  objective: string;
  transcript: unknown;
  result: unknown;
}

interface PhaseRow {
  id: string;
  status: string;
  objective_summary: string;
  approved_strategy_version_id: string | null;
  approved_budget_usd: string | number;
  aggregate_version: number;
  planning_run_id: string | null;
}

interface StrategyRow {
  id: string;
  version: number;
  status: string;
  aggregate_version: number;
  content: Record<string, unknown>;
  content_hash: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StaffingRecommendation {
  node_id: string;
  provider: string;
  model: string;
  reviewer_model: string;
  budget_usd: number;
  rationale: string;
}

interface ResolvedProfile {
  provider: string;
  model: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function numeric(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

/** Extracts the well-formed staffing recommendations from the loosely-typed
 *  persisted proposal. A malformed entry is skipped rather than failing the
 *  bridge; the affected task falls back to a placeholder assignment. */
function readStaffingRecommendations(result: unknown): Map<string, StaffingRecommendation> {
  const proposal = asRecord(asRecord(result).staffing_proposal);
  const raw = Array.isArray(proposal.recommendations) ? proposal.recommendations : [];
  const byNode = new Map<string, StaffingRecommendation>();
  for (const entry of raw) {
    const record = asRecord(entry);
    const nodeId = record.node_id;
    const provider = record.provider;
    const model = record.model;
    if (typeof nodeId !== "string" || typeof provider !== "string" || typeof model !== "string") {
      continue;
    }
    byNode.set(nodeId, {
      node_id: nodeId,
      provider,
      model,
      reviewer_model: typeof record.reviewer_model === "string" ? record.reviewer_model : "",
      budget_usd: typeof record.budget_usd === "number" ? record.budget_usd : 0,
      rationale: typeof record.rationale === "string" ? record.rationale : "",
    });
  }
  return byNode;
}

function taskLocalId(moduleId: string): string {
  return `task-${moduleId}`;
}

function assignmentLocalId(moduleId: string): string {
  return `assignment-${moduleId}`;
}

/** Findings the reviewer left on the table, reconstructed from the last review
 *  round's severity counts (the raw finding list is not persisted in the run
 *  result). Must-fix findings stay `open` — for a cap_reached run this is what
 *  keeps approval blocked and tells the UI why it did not converge; for a
 *  converged run the count is zero so nothing blocks approval. */
function synthesizeFindings(
  phaseId: string,
  status: string,
  transcript: unknown[],
): V2StrategyFindingT[] {
  let counts: { must_fix: number; should_fix: number; suggestion: number } | null = null;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(transcript[index]);
    if (entry.role === "reviewer" && entry.finding_counts) {
      const raw = asRecord(entry.finding_counts);
      counts = {
        must_fix: typeof raw.must_fix === "number" ? raw.must_fix : 0,
        should_fix: typeof raw.should_fix === "number" ? raw.should_fix : 0,
        suggestion: typeof raw.suggestion === "number" ? raw.suggestion : 0,
      };
      break;
    }
  }
  if (!counts) return [];
  const findings: V2StrategyFindingT[] = [];
  const stoppedBecause =
    status === "cap_reached" ? "the review round cap was reached" : "planning finished";
  if (counts.must_fix > 0) {
    findings.push({
      id: `finding:${phaseId}:must_fix`,
      severity: "must_fix",
      status: "open",
      summary: `${counts.must_fix} must-fix issue(s) were still open when ${stoppedBecause}.`,
      disposition: null,
    });
  }
  if (counts.should_fix > 0) {
    findings.push({
      id: `finding:${phaseId}:recommended`,
      severity: "recommended",
      status: "accepted",
      summary: `${counts.should_fix} recommended improvement(s) were noted by the reviewer.`,
      disposition: null,
    });
  }
  if (counts.suggestion > 0) {
    findings.push({
      id: `finding:${phaseId}:question`,
      severity: "question",
      status: "accepted",
      summary: `${counts.suggestion} optional suggestion(s) were noted by the reviewer.`,
      disposition: null,
    });
  }
  return findings;
}

export interface StrategyBridgeServiceDeps {
  transactions: V2TransactionRunner;
  phases: PhaseWorkflowService;
  strategies: StrategyWorkflowService;
  now?: () => Date;
}

export class StrategyBridgeService {
  private readonly transactions: V2TransactionRunner;
  private readonly phases: PhaseWorkflowService;
  private readonly strategies: StrategyWorkflowService;
  private readonly now: () => Date;

  constructor(deps: StrategyBridgeServiceDeps) {
    this.transactions = deps.transactions;
    this.phases = deps.phases;
    this.strategies = deps.strategies;
    this.now = deps.now ?? (() => new Date());
  }

  // ---- deliverable 1: create a phase from a completed planning run ----------

  async createPhaseFromPlanningRun(
    input: CreatePhaseFromPlanningRunInput,
  ): Promise<StrategyReviewDto> {
    const run = await this.loadPlanningRun(input.projectId, input.planningRunId);
    if (run.status !== "converged" && run.status !== "cap_reached") {
      throw new StrategyBridgeError(
        "planning_run_not_ready",
        `planning run "${input.planningRunId}" is ${run.status}; only converged or cap_reached runs can be materialized`,
      );
    }
    if (run.result === null || run.result === undefined) {
      throw new StrategyBridgeError(
        "planning_run_result_missing",
        `planning run "${input.planningRunId}" has no persisted result`,
      );
    }
    const result = jsonValue<Record<string, unknown>>(run.result);
    const validation = validatePlan(result.plan);
    if (!validation.ok) {
      throw new StrategyBridgeError(
        "invalid_plan",
        `planning run "${input.planningRunId}" produced a plan that failed validation: ${validation.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    const plan = validation.plan;
    const transcript = jsonValue<unknown[]>(run.transcript) ?? [];
    const recommendations = readStaffingRecommendations(result);

    const phaseId = await this.ensurePhase(input, run.objective, plan);
    await this.ensureStrategy(input.projectId, phaseId, run, plan, transcript, recommendations);
    return this.review(input.projectId, phaseId);
  }

  // ---- deliverable 2: edit staffing on the proposed strategy -----------------

  async editStaffing(input: EditStaffingInput): Promise<StrategyReviewDto> {
    const { strategy: latest } = await this.transactions.transaction(async (tx) => ({
      strategy: await this.loadLatestStrategy(tx, input.projectId, input.phaseId),
    }));
    if (!latest) {
      throw new StrategyBridgeError(
        "no_proposed_strategy",
        `phase "${input.phaseId}" has no strategy version to edit`,
      );
    }
    const current = this.reconstructStrategy(latest);

    // Resolve each edit against the current assignment's provider/model so a
    // partial edit (e.g. budget only) preserves the rest.
    const profileToPair = await this.loadProfilePairs(current.proposed_assignments);
    const editsById = new Map(input.edits.map((edit) => [edit.assignment_id, edit]));
    const requiredProfiles = new Map<string, ResolvedProfile>();

    const nextAssignments = current.proposed_assignments.map(
      (assignment): V2StrategyAssignmentProposalT => {
        const edit = editsById.get(assignment.local_id);
        if (!edit) return assignment;
        const currentPair = profileToPair.get(assignment.agent_profile_id) ?? null;
        const provider = edit.provider ?? currentPair?.provider ?? "anthropic";
        const model = edit.model ?? currentPair?.model ?? "";
        const profileId = deterministicProfileId(provider, model);
        requiredProfiles.set(profileId, { provider, model });

        let reviewerProfileId = assignment.reviewer_agent_profile_id;
        if (edit.clear_reviewer) {
          reviewerProfileId = null;
        } else if (edit.reviewer_model !== undefined) {
          const reviewerProvider = edit.reviewer_provider ?? crossProvider(provider);
          reviewerProfileId = deterministicProfileId(reviewerProvider, edit.reviewer_model);
          requiredProfiles.set(reviewerProfileId, {
            provider: reviewerProvider,
            model: edit.reviewer_model,
          });
        }

        return {
          ...assignment,
          agent_profile_id: profileId,
          reviewer_agent_profile_id: reviewerProfileId,
          budget_limit_usd: edit.budget_limit_usd ?? assignment.budget_limit_usd,
        };
      },
    );

    const unknownEdits = [...editsById.keys()].filter(
      (id) => !current.proposed_assignments.some((assignment) => assignment.local_id === id),
    );
    if (unknownEdits.length > 0) {
      throw new StrategyBridgeError(
        "assignment_not_found",
        `unknown assignment id(s): ${unknownEdits.join(", ")}`,
      );
    }

    await this.ensureProfiles(requiredProfiles);
    const next = this.buildSupersedingStrategy(current, latest, nextAssignments);
    await this.strategies.saveAwaitingApproval(next);
    return this.review(input.projectId, input.phaseId);
  }

  // ---- deliverable 3: approve + materialize (reuses the existing path) --------

  async approve(input: ApproveStrategyInput): Promise<ApproveStrategyResult> {
    const { strategy, phaseVersion } = await this.transactions.transaction(async (tx) => {
      const proposed = await this.loadProposedStrategy(tx, input.projectId, input.phaseId);
      const phase = await this.loadPhase(tx, input.projectId, input.phaseId);
      return { strategy: proposed, phaseVersion: phase?.aggregate_version ?? null };
    });
    if (!strategy || phaseVersion === null) {
      throw new StrategyBridgeError(
        "no_proposed_strategy",
        `phase "${input.phaseId}" has no strategy awaiting approval`,
      );
    }
    const issuedAt = this.now().toISOString();
    const result = await this.strategies.approve({
      schema_version: 2,
      command_id: newId("command"),
      kind: "approve_strategy_version",
      command_family: "strategy_approval",
      actor: { actor_type: "human", actor_id: input.actor.actor_id },
      idempotency_key: input.idempotencyKey ?? `frontdoor-approve:${strategy.id}`,
      correlation_id: newId("correlation"),
      causation_id: null,
      issued_at: issuedAt,
      project_id: input.projectId,
      phase_id: input.phaseId,
      strategy_version_id: strategy.id,
      expected_phase_version: phaseVersion,
      expected_strategy_version: strategy.version,
      expected_strategy_aggregate_version: strategy.aggregate_version,
      expected_content_hash: input.expectedContentHash ?? strategy.content_hash,
    });
    const review = await this.review(input.projectId, input.phaseId);
    return { ...result, review };
  }

  // ---- deliverable 4: the plan-review DTO ------------------------------------

  async review(projectId: string, phaseId: string): Promise<StrategyReviewDto> {
    return this.transactions.transaction(async (tx) => {
      const phase = await this.loadPhase(tx, projectId, phaseId);
      if (!phase) {
        throw new StrategyBridgeError("phase_not_found", `unknown phase "${phaseId}"`);
      }
      const rounds = await this.loadRounds(tx, phase.planning_run_id);
      const strategyRow = await this.loadLatestStrategy(tx, projectId, phaseId);
      const strategy = strategyRow ? this.reconstructStrategy(strategyRow) : null;
      const staffing = strategy ? await this.buildStaffing(tx, strategy) : [];
      return {
        phase: {
          id: phase.id,
          status: phase.status,
          objective_summary: phase.objective_summary,
          approved_strategy_version_id: phase.approved_strategy_version_id,
          approved_budget_usd: numeric(phase.approved_budget_usd),
          aggregate_version: phase.aggregate_version,
        },
        rounds,
        strategy: strategy
          ? {
              id: strategy.id,
              version: strategy.version,
              status: strategy.status,
              aggregate_version: strategy.aggregate_version,
              content_hash: strategy.content_hash,
              objective: strategy.objective,
              assumptions: strategy.assumptions,
              risks: strategy.risks,
              scope_in: strategy.scope_in,
              scope_out: strategy.scope_out,
              architecture_impact: strategy.architecture_impact,
              convergence: strategy.convergence,
              review_rounds: strategy.review_rounds,
              proposed_concurrency: strategy.proposed_concurrency,
              proposed_budget_usd: strategy.proposed_budget_usd,
              objectives: strategy.proposed_objectives.map((objective) => ({
                local_id: objective.local_id,
                outcome: objective.outcome,
                success_measures: objective.success_measures,
              })),
              tasks: strategy.proposed_tasks.map((task) => ({
                local_id: task.local_id,
                objective_local_id: task.objective_local_id,
                title: task.title,
                description: task.description,
                deliverables: task.deliverables,
                acceptance_criteria: task.acceptance_criteria,
                complexity: task.complexity,
                risk: task.risk,
                required_roles: task.required_roles,
                dependency_local_ids: task.dependency_local_ids,
              })),
              staffing,
              findings: strategy.findings,
            }
          : null,
        outstanding_findings: strategy
          ? strategy.findings.filter((finding) => finding.status === "open")
          : [],
      };
    });
  }

  // ---- internals -------------------------------------------------------------

  private async loadPlanningRun(projectId: string, runId: string): Promise<PlanningRunRow> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<PlanningRunRow>(
        `SELECT id, project_id, status, round, max_rounds, objective, transcript, result
         FROM planning_runs WHERE id = $1 AND project_id = $2`,
        [runId, projectId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new StrategyBridgeError(
          "planning_run_not_found",
          `unknown planning run "${runId}" for project "${projectId}"`,
        );
      }
      return row;
    });
  }

  /** Find-or-create the phase bound to this planning run. Idempotent: the
   *  planning-run binding (a partial unique index) guarantees one phase per
   *  run even across a concurrent second attempt. */
  private async ensurePhase(
    input: CreatePhaseFromPlanningRunInput,
    runObjective: string,
    plan: PlanContractT,
  ): Promise<string> {
    const existing = await this.transactions.transaction(async (tx) =>
      this.loadPhaseByPlanningRun(tx, input.projectId, input.planningRunId),
    );
    if (existing) return existing.id;

    const projectVersion = await this.transactions.transaction(async (tx) => {
      const project = await tx.query<{ aggregate_version: number }>(
        "SELECT aggregate_version FROM projects WHERE id = $1",
        [input.projectId],
      );
      const version = project.rows[0]?.aggregate_version;
      if (version === undefined) {
        throw new StrategyBridgeError("phase_not_found", `unknown project "${input.projectId}"`);
      }
      const count = await tx.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM phases WHERE project_id = $1",
        [input.projectId],
      );
      return { version, priority: count.rows[0]?.count ?? 0 };
    });

    const objectiveSummary = (input.name ?? plan.objective ?? runObjective).trim();
    const phase = await this.phases.create({
      schema_version: 2,
      command_id: newId("command"),
      kind: "create_phase",
      command_family: "phase",
      actor: { actor_type: "human", actor_id: input.actor.actor_id },
      idempotency_key: `frontdoor-phase:${input.planningRunId}`,
      correlation_id: newId("correlation"),
      causation_id: null,
      issued_at: this.now().toISOString(),
      project_id: input.projectId,
      objective_summary: objectiveSummary.length > 0 ? objectiveSummary : "Planned phase",
      priority: projectVersion.priority,
      predecessor_phase_ids: [],
      expected_project_version: projectVersion.version,
    });

    // Bind the run to the phase. A unique-index violation means another phase
    // already claimed this run (a concurrent attempt by a different actor):
    // resolve back to that phase and leave ours unbound.
    try {
      const bound = await this.transactions.transaction(async (tx) =>
        tx.query<{ id: string }>(
          `UPDATE phases SET planning_run_id = $1
           WHERE id = $2 AND project_id = $3 AND planning_run_id IS NULL
           RETURNING id`,
          [input.planningRunId, phase.id, input.projectId],
        ),
      );
      if (bound.rows[0]) return phase.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const winner = await this.transactions.transaction(async (tx) =>
      this.loadPhaseByPlanningRun(tx, input.projectId, input.planningRunId),
    );
    return winner?.id ?? phase.id;
  }

  /** Ensure the version-1 proposed StrategyVersion exists for the phase. */
  private async ensureStrategy(
    projectId: string,
    phaseId: string,
    run: PlanningRunRow,
    plan: PlanContractT,
    transcript: unknown[],
    recommendations: Map<string, StaffingRecommendation>,
  ): Promise<void> {
    const already = await this.transactions.transaction(async (tx) =>
      this.loadLatestStrategy(tx, projectId, phaseId),
    );
    if (already) return;

    const requiredProfiles = new Map<string, ResolvedProfile>();
    const fallback = fallbackImplementer(transcript);
    const assignments = plan.modules.map((module): V2StrategyAssignmentProposalT => {
      const recommendation = recommendations.get(module.id);
      if (recommendation) {
        const providerModelId = deterministicProfileId(
          recommendation.provider,
          recommendation.model,
        );
        requiredProfiles.set(providerModelId, {
          provider: recommendation.provider,
          model: recommendation.model,
        });
        let reviewerProfileId: string | null = null;
        if (recommendation.reviewer_model) {
          const reviewerProvider = crossProvider(recommendation.provider);
          reviewerProfileId = deterministicProfileId(
            reviewerProvider,
            recommendation.reviewer_model,
          );
          requiredProfiles.set(reviewerProfileId, {
            provider: reviewerProvider,
            model: recommendation.reviewer_model,
          });
        }
        return {
          local_id: assignmentLocalId(module.id),
          task_local_id: taskLocalId(module.id),
          agent_profile_id: providerModelId,
          rationale: recommendation.rationale || `Staffed for module "${module.title}".`,
          rationale_factors: DEFAULT_RATIONALE_FACTORS,
          budget_limit_usd: recommendation.budget_usd,
          reviewer_agent_profile_id: reviewerProfileId,
          allocation_policy_ref: "allocation",
        };
      }
      // No recommendation for this module (staffing was null/partial). Assign a
      // placeholder the user edits before approving; falls back to the model
      // that drafted the plan.
      const profileId = deterministicProfileId(fallback.provider, fallback.model);
      requiredProfiles.set(profileId, fallback);
      return {
        local_id: assignmentLocalId(module.id),
        task_local_id: taskLocalId(module.id),
        agent_profile_id: profileId,
        rationale: "Pending staffing — no recommendation was produced for this task.",
        rationale_factors: DEFAULT_RATIONALE_FACTORS,
        budget_limit_usd: 0,
        reviewer_agent_profile_id: null,
        allocation_policy_ref: "allocation",
      };
    });

    await this.ensureProfiles(requiredProfiles);

    const draft = this.buildInitialStrategy(projectId, phaseId, run, plan, transcript, assignments);
    await this.strategies.saveAwaitingApproval(draft);
  }

  private buildInitialStrategy(
    projectId: string,
    phaseId: string,
    run: PlanningRunRow,
    plan: PlanContractT,
    transcript: unknown[],
    assignments: V2StrategyAssignmentProposalT[],
  ): V2StrategyVersionT {
    const objectives: V2StrategyObjectiveProposalT[] = [
      {
        local_id: BRIDGE_OBJECTIVE_LOCAL_ID,
        outcome: plan.objective,
        success_measures: successMeasures(plan),
      },
    ];
    const tasks = plan.modules.map((module) => this.taskProposalFor(module));
    const nowIso = this.now().toISOString();
    const candidate: V2StrategyVersionT = {
      schema_version: 2,
      id: `strategy:${phaseId}:v1`,
      project_id: projectId,
      phase_id: phaseId,
      version: 1,
      status: "awaiting_approval",
      objective: plan.objective,
      assumptions: plan.assumptions,
      risks: plan.risks.map((risk) => risk.description),
      scope_in: plan.modules.map((module) => module.title),
      scope_out: plan.out_of_scope,
      architecture_impact: `Materialized from planning run ${run.id}: ${plan.modules.length} module(s).`,
      proposed_objectives: objectives,
      proposed_tasks: tasks,
      proposed_assignments: assignments,
      proposed_concurrency: proposedConcurrency(plan),
      proposed_budget_usd: assignments.reduce(
        (sum, assignment) => sum + assignment.budget_limit_usd,
        0,
      ),
      provenance: provenanceFrom(transcript, run.id, nowIso),
      convergence: run.status === "cap_reached" ? "cap_reached" : "converged",
      review_rounds: run.round,
      findings: synthesizeFindings(phaseId, run.status, transcript),
      content_hash: "0".repeat(64),
      approval: null,
      supersedes_strategy_version_id: null,
      aggregate_version: 1,
      created_at: nowIso,
      updated_at: nowIso,
    };
    candidate.content_hash = fingerprintV2StrategyImmutableContent(candidate, sha256);
    return candidate;
  }

  private buildSupersedingStrategy(
    current: V2StrategyVersionT,
    latest: StrategyRow,
    assignments: V2StrategyAssignmentProposalT[],
  ): V2StrategyVersionT {
    const nowIso = this.now().toISOString();
    const version = latest.version + 1;
    const candidate: V2StrategyVersionT = {
      ...current,
      id: `strategy:${current.phase_id}:v${version}`,
      version,
      status: "awaiting_approval",
      proposed_assignments: assignments,
      proposed_budget_usd: assignments.reduce(
        (sum, assignment) => sum + assignment.budget_limit_usd,
        0,
      ),
      content_hash: "0".repeat(64),
      approval: null,
      supersedes_strategy_version_id: latest.id,
      aggregate_version: 1,
      created_at: nowIso,
      updated_at: nowIso,
    };
    candidate.content_hash = fingerprintV2StrategyImmutableContent(candidate, sha256);
    return candidate;
  }

  private taskProposalFor(module: PlanModuleT): V2StrategyTaskProposalT {
    const acceptance = module.acceptance.map((criterion) => criterion.statement);
    const expectedOutputs = module.outputs.length > 0 ? module.outputs : module.deliverables;
    return {
      local_id: taskLocalId(module.id),
      objective_local_id: BRIDGE_OBJECTIVE_LOCAL_ID,
      title: module.title,
      description: module.description,
      deliverables: module.deliverables,
      acceptance_criteria: acceptance,
      complexity: module.estimated_complexity,
      risk: module.risk,
      required_roles: [DEFAULT_REQUIRED_ROLE],
      required_capabilities: [],
      required_inputs: [],
      expected_outputs: expectedOutputs,
      environment_policy_ref: "environment",
      // EXECUTION E10. This was the bare word "verification", which is not a
      // key in the runner's default policy map — so every task materialized
      // through the normal planning path shipped a policy ref that no runner
      // could resolve. Before E4 that threw into an opaque catch; after E4 it
      // fails closed with a message about a manifest the project may not have.
      // The default deployment could not verify anything at all.
      verification_policy_ref: V2_DEFAULT_VERIFICATION_POLICY_REF,
      dependency_local_ids: module.dependencies.map((dependency) => taskLocalId(dependency)),
    };
  }

  private reconstructStrategy(row: StrategyRow): V2StrategyVersionT {
    // strategy_versions.content holds the projected immutable payload; the
    // mutable lifecycle fields live in dedicated columns. Same reconstruction
    // StrategyWorkflowService.approve performs.
    return jsonValue<V2StrategyVersionT>({
      ...asRecord(row.content),
      status: row.status,
      aggregate_version: row.aggregate_version,
      content_hash: row.content_hash,
      approval: null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    });
  }

  private async ensureProfiles(profiles: Map<string, ResolvedProfile>): Promise<void> {
    if (profiles.size === 0) return;
    await this.transactions.transaction(async (tx) => {
      for (const [id, pair] of profiles) {
        await tx.query(
          `INSERT INTO agent_profiles (
             id, schema_version, provider, runtime, model, roles, capabilities,
             context_limit_tokens, security_restrictions, status, active_workload,
             cost_metadata
           ) VALUES ($1,2,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,'[]'::jsonb,'available',0,$7::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            pair.provider,
            pair.provider,
            pair.model,
            JSON.stringify(["implementation", "review"]),
            DEFAULT_CONTEXT_LIMIT_TOKENS,
            JSON.stringify({
              billing_mode: "unknown",
              input_usd_per_million: null,
              output_usd_per_million: null,
            }),
          ],
        );
      }
    });
  }

  private async buildStaffing(
    tx: V2SqlExecutor,
    strategy: V2StrategyVersionT,
  ): Promise<StrategyReviewStaffingDto[]> {
    const pairs = await this.loadProfilePairs(strategy.proposed_assignments, tx);
    const taskById = new Map(strategy.proposed_tasks.map((task) => [task.local_id, task]));
    return strategy.proposed_assignments.map((assignment) => {
      const impl = pairs.get(assignment.agent_profile_id) ?? null;
      const reviewer =
        assignment.reviewer_agent_profile_id === null
          ? null
          : (pairs.get(assignment.reviewer_agent_profile_id) ?? null);
      const task = taskById.get(assignment.task_local_id) ?? null;
      return {
        assignment_id: assignment.local_id,
        task_local_id: assignment.task_local_id,
        task_title: task?.title ?? assignment.task_local_id,
        required_roles: task?.required_roles ?? [],
        provider: impl?.provider ?? null,
        model: impl?.model ?? null,
        reviewer_provider: reviewer?.provider ?? null,
        reviewer_model: reviewer?.model ?? null,
        budget_limit_usd: assignment.budget_limit_usd,
        rationale: assignment.rationale,
        rationale_factors: assignment.rationale_factors,
      };
    });
  }

  private async loadProfilePairs(
    assignments: readonly V2StrategyAssignmentProposalT[],
    executor?: V2SqlExecutor,
  ): Promise<Map<string, ResolvedProfile>> {
    const ids = [
      ...new Set(
        assignments.flatMap((assignment) =>
          assignment.reviewer_agent_profile_id === null
            ? [assignment.agent_profile_id]
            : [assignment.agent_profile_id, assignment.reviewer_agent_profile_id],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const run = async (tx: V2SqlExecutor) => {
      const result = await tx.query<{ id: string; provider: string; model: string }>(
        "SELECT id, provider, model FROM agent_profiles WHERE id = ANY($1::text[])",
        [ids],
      );
      return new Map(
        result.rows.map((row) => [row.id, { provider: row.provider, model: row.model }]),
      );
    };
    return executor ? run(executor) : this.transactions.transaction(run);
  }

  private async loadPhase(
    tx: V2SqlExecutor,
    projectId: string,
    phaseId: string,
  ): Promise<PhaseRow | null> {
    const result = await tx.query<PhaseRow>(
      `SELECT id, status, objective_summary, approved_strategy_version_id,
              approved_budget_usd, aggregate_version, planning_run_id
       FROM phases WHERE id = $1 AND project_id = $2`,
      [phaseId, projectId],
    );
    return result.rows[0] ?? null;
  }

  private async loadPhaseByPlanningRun(
    tx: V2SqlExecutor,
    projectId: string,
    planningRunId: string,
  ): Promise<PhaseRow | null> {
    const result = await tx.query<PhaseRow>(
      `SELECT id, status, objective_summary, approved_strategy_version_id,
              approved_budget_usd, aggregate_version, planning_run_id
       FROM phases WHERE project_id = $1 AND planning_run_id = $2`,
      [projectId, planningRunId],
    );
    return result.rows[0] ?? null;
  }

  private async loadRounds(
    tx: V2SqlExecutor,
    planningRunId: string | null,
  ): Promise<StrategyReviewRoundsDto | null> {
    if (!planningRunId) return null;
    const result = await tx.query<PlanningRunRow>(
      "SELECT id, status, round, max_rounds, transcript FROM planning_runs WHERE id = $1",
      [planningRunId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      planning_run_id: row.id,
      status: row.status,
      round: row.round,
      max_rounds: row.max_rounds,
      transcript: jsonValue<unknown[]>(row.transcript) ?? [],
    };
  }

  private async loadLatestStrategy(
    tx: V2SqlExecutor,
    projectId: string,
    phaseId: string,
  ): Promise<StrategyRow | null> {
    const result = await tx.query<StrategyRow>(
      `SELECT id, version, status, aggregate_version, content, content_hash, created_at, updated_at
       FROM strategy_versions
       WHERE project_id = $1 AND phase_id = $2
       ORDER BY version DESC LIMIT 1`,
      [projectId, phaseId],
    );
    return result.rows[0] ?? null;
  }

  private async loadProposedStrategy(
    tx: V2SqlExecutor,
    projectId: string,
    phaseId: string,
  ): Promise<StrategyRow | null> {
    const latest = await this.loadLatestStrategy(tx, projectId, phaseId);
    return latest && latest.status === "awaiting_approval" ? latest : null;
  }
}

/** The model that drafted the plan, used as the fallback implementer for tasks
 *  with no staffing recommendation. */
function fallbackImplementer(transcript: unknown[]): ResolvedProfile {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(transcript[index]);
    if (
      entry.role === "pm" &&
      typeof entry.provider === "string" &&
      typeof entry.model === "string"
    ) {
      return { provider: entry.provider, model: entry.model };
    }
  }
  return { provider: "anthropic", model: "unstaffed" };
}

function successMeasures(plan: PlanContractT): string[] {
  const measures = plan.modules.flatMap((module) =>
    module.acceptance.map((criterion) => criterion.statement),
  );
  return measures.length > 0 ? measures : [`Deliver: ${plan.objective}`];
}

function proposedConcurrency(plan: PlanContractT): number {
  const parallelSafe = plan.modules.filter((module) => module.parallelization.safe).length;
  return Math.max(1, Math.min(parallelSafe, plan.modules.length));
}

function provenanceFrom(
  transcript: unknown[],
  runId: string,
  generatedAt: string,
): V2StrategyVersionT["provenance"] {
  const seen = new Set<string>();
  const provenance: V2StrategyVersionT["provenance"] = [];
  for (const entry of transcript) {
    const record = asRecord(entry);
    if (typeof record.provider !== "string" || typeof record.model !== "string") continue;
    const key = `${record.provider}:${record.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    provenance.push({
      provider: record.provider,
      model: record.model,
      runtime: record.provider,
      generated_at: generatedAt,
      invocation_id: runId,
    });
  }
  if (provenance.length === 0) {
    provenance.push({
      provider: "anthropic",
      model: "unknown",
      runtime: "anthropic",
      generated_at: generatedAt,
      invocation_id: runId,
    });
  }
  return provenance;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // Postgres unique_violation; pglite surfaces the same SQLSTATE.
  return (
    code === "23505" || /unique/i.test(String((error as { message?: unknown })?.message ?? ""))
  );
}
