import type { PhasePlanningRunDto } from "./phaseTabApi";

export interface RelationalGraphNode {
  id: string;
  title: string;
  complexity: string;
  risk: string;
  dependencies: string[];
  assignment: {
    provider: string;
    model: string;
    worker_count: number;
    reviewer_model: string;
    budget_usd: number;
    rationale: string;
    source: "pm";
  } | null;
}

export interface RelationalGraphReadModel {
  kind: "planning" | "phase" | "execution";
  title: string;
  status: string;
  graph: {
    version: number;
    nodes: RelationalGraphNode[];
    cost: { total_usd: number; unallocated: string[] };
  };
}

interface ResumePhase {
  id: string;
  objective_summary: string;
  status: string;
}

interface ExecutionPhase {
  id: string;
  objective_summary: string;
  status: string;
  budget_usd?: number;
}

interface ExecutionTask {
  id: string;
  title: string;
  complexity: string;
  risk: string;
  dependencies: string[];
  assignment: { provider: string; model: string } | null;
  implementation_agent: { provider: string; model: string } | null;
  reviewer_agent: { model: string } | null;
}

interface RelationalExecution {
  phase: ExecutionPhase;
  tasks: ExecutionTask[];
}

const PLANNING_STATUSES = new Set([
  "queued",
  "drafting",
  "reviewing",
  "revising",
  "converged",
  "cap_reached",
  "failed",
]);

function planningReadModel(run: PhasePlanningRunDto): RelationalGraphReadModel {
  const modules = run.result?.plan?.modules ?? [];
  const recommendations = new Map(
    (run.result?.staffing_proposal?.recommendations ?? []).map((item) => [item.node_id, item]),
  );
  const nodes: RelationalGraphNode[] =
    modules.length > 0
      ? modules.map((module) => {
          const recommendation = recommendations.get(module.id);
          return {
            id: module.id,
            title: module.title ?? module.id,
            complexity: "planned",
            risk: run.status === "failed" ? "high" : "low",
            dependencies: [],
            assignment: recommendation
              ? {
                  provider: recommendation.provider,
                  model: recommendation.model,
                  worker_count: recommendation.worker_count,
                  reviewer_model: recommendation.reviewer_model ?? "No reviewer",
                  budget_usd: recommendation.budget_usd ?? 0,
                  rationale: recommendation.rationale ?? "Current planning recommendation",
                  source: "pm",
                }
              : null,
          };
        })
      : [
          {
            id: run.id,
            title:
              run.status === "failed"
                ? "Planning stopped"
                : run.status === "converged" || run.status === "cap_reached"
                  ? "Plan ready for decision"
                  : "Planning in progress",
            complexity: "planning",
            risk: run.status === "failed" ? "high" : "low",
            dependencies: [],
            assignment: null,
          },
        ];

  return {
    kind: "planning",
    title: "Current planning run",
    status: run.status,
    graph: {
      version: Math.max(run.round, 0),
      nodes,
      cost: {
        total_usd: run.result?.total_cost_usd ?? 0,
        unallocated: nodes.filter((node) => !node.assignment).map((node) => node.id),
      },
    },
  };
}

function executionReadModel(execution: RelationalExecution): RelationalGraphReadModel {
  const nodes =
    execution.tasks.length > 0
      ? execution.tasks.map((task) => {
          const assignment = task.assignment ?? task.implementation_agent;
          return {
            id: task.id,
            title: task.title,
            complexity: task.complexity,
            risk: task.risk,
            dependencies: task.dependencies,
            assignment: assignment
              ? {
                  provider: assignment.provider,
                  model: assignment.model,
                  worker_count: 1,
                  reviewer_model: task.reviewer_agent?.model ?? "No reviewer",
                  budget_usd: 0,
                  rationale: "Current relational execution assignment",
                  source: "pm" as const,
                }
              : null,
          };
        })
      : [
          {
            id: execution.phase.id,
            title: execution.phase.objective_summary,
            complexity: "phase",
            risk: execution.phase.status === "blocked" ? "high" : "low",
            dependencies: [],
            assignment: null,
          },
        ];

  return {
    kind: "execution",
    title: execution.phase.objective_summary,
    status: execution.phase.status,
    graph: {
      version: 0,
      nodes,
      cost: {
        total_usd: execution.phase.budget_usd ?? 0,
        unallocated: nodes.filter((node) => !node.assignment).map((node) => node.id),
      },
    },
  };
}

function phaseReadModel(phase: ResumePhase): RelationalGraphReadModel {
  return {
    kind: "phase",
    title: phase.objective_summary,
    status: phase.status,
    graph: {
      version: 0,
      nodes: [
        {
          id: phase.id,
          title: phase.objective_summary,
          complexity: "phase",
          risk: phase.status === "blocked" ? "high" : "low",
          dependencies: [],
          assignment: null,
        },
      ],
      cost: { total_usd: 0, unallocated: [phase.id] },
    },
  };
}

export function buildRelationalGraphReadModel(input: {
  planningRun: PhasePlanningRunDto | null;
  phaseExecution: RelationalExecution | null;
  phase: ResumePhase | null;
}): RelationalGraphReadModel | null {
  if (input.planningRun && PLANNING_STATUSES.has(input.planningRun.status)) {
    return planningReadModel(input.planningRun);
  }
  if (input.phaseExecution) return executionReadModel(input.phaseExecution);
  if (input.phase) return phaseReadModel(input.phase);
  if (input.planningRun) return planningReadModel(input.planningRun);
  return null;
}
