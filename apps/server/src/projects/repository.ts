import type { ApprovalT, PlanContractT } from "@norns/contracts";
import {
  type AllocationApprovalStatus,
  type AllocationStrategyT,
  type CostPreview,
  type PmAssignmentRecommendation,
  applyPmAllocation,
  approveAllocation,
  autoAllocate,
  costPreview,
  overrideAssignment,
} from "../graph/allocation.js";
import type { GraphNode, GraphSnapshot, WorkflowGraph } from "../graph/graph.js";
import type { ProjectStore, ProjectSummary } from "./store.js";

type Awaitable<T> = T | Promise<T>;
type CreateProjectInput = Parameters<ProjectStore["create"]>[0];
type AddNodeInput = Parameters<WorkflowGraph["addNode"]>[0];
type RemoveNodeMode = Parameters<WorkflowGraph["removeNode"]>[1];
type AssignmentPatch = Parameters<typeof overrideAssignment>[2];

export interface ProjectGraphView {
  graph: GraphSnapshot;
  cost: CostPreview;
  approval: AllocationApprovalStatus | null;
}

/**
 * Compatibility application/repository port for the legacy project API.
 *
 * The port exposes operations and immutable response views rather than a
 * mutable GraphSession. That keeps the HTTP layer storage-agnostic: the
 * current adapter delegates to ProjectStore, while a relational compatibility
 * adapter can later implement the same asynchronous surface from V2 rows and
 * TaskDependency projections.
 */
export interface ProjectRepository {
  readonly repositoryKind: "project_repository";
  create(input: CreateProjectInput): Awaitable<ProjectSummary>;
  list(): Awaitable<ProjectSummary[]>;
  summary(id: string): Awaitable<ProjectSummary>;
  pmSelectionOf(id: string): Awaitable<ReturnType<ProjectStore["pmSelectionOf"]>>;
  graph(id: string): Awaitable<ProjectGraphView>;
  addEdge(id: string, from: string, to: string): Awaitable<ProjectGraphView>;
  removeEdge(id: string, from: string, to: string): Awaitable<ProjectGraphView>;
  addNode(id: string, input: AddNodeInput): Awaitable<ProjectGraphView>;
  removeNode(
    id: string,
    nodeId: string,
    mode?: RemoveNodeMode,
  ): Awaitable<{ removed: string[]; view: ProjectGraphView }>;
  allocate(id: string, strategy: AllocationStrategyT): Awaitable<ProjectGraphView>;
  applyPmAllocation(
    id: string,
    recommendations: readonly PmAssignmentRecommendation[],
  ): Awaitable<ProjectGraphView>;
  overrideAssignment(
    id: string,
    nodeId: string,
    patch: AssignmentPatch,
  ): Awaitable<ProjectGraphView>;
  approveAllocation(id: string, actor: string): Awaitable<ApprovalT>;
  loadPlan(id: string, plan: PlanContractT): Awaitable<ProjectGraphView>;
}

function graphView(store: ProjectStore, id: string): ProjectGraphView {
  const session = store.session(id);
  return {
    graph: session.graph.snapshot(),
    cost: costPreview(session.graph),
    approval: session.approvalStatus(),
  };
}

export class LegacyProjectRepository implements ProjectRepository {
  readonly repositoryKind = "project_repository" as const;

  constructor(private readonly store: ProjectStore) {}

  create(input: CreateProjectInput): ProjectSummary {
    return this.store.create(input);
  }

  list(): ProjectSummary[] {
    return this.store.list();
  }

  summary(id: string): ProjectSummary {
    return this.store.summary(id);
  }

  pmSelectionOf(id: string): ReturnType<ProjectStore["pmSelectionOf"]> {
    return this.store.pmSelectionOf(id);
  }

  graph(id: string): ProjectGraphView {
    return graphView(this.store, id);
  }

  addEdge(id: string, from: string, to: string): ProjectGraphView {
    this.store.session(id).graph.addEdge(from, to);
    return graphView(this.store, id);
  }

  removeEdge(id: string, from: string, to: string): ProjectGraphView {
    this.store.session(id).graph.removeEdge(from, to);
    return graphView(this.store, id);
  }

  addNode(id: string, input: AddNodeInput): ProjectGraphView {
    this.store.session(id).graph.addNode(input);
    return graphView(this.store, id);
  }

  removeNode(
    id: string,
    nodeId: string,
    mode?: RemoveNodeMode,
  ): { removed: string[]; view: ProjectGraphView } {
    const removed = this.store.session(id).graph.removeNode(nodeId, mode);
    return { removed, view: graphView(this.store, id) };
  }

  allocate(id: string, strategy: AllocationStrategyT): ProjectGraphView {
    autoAllocate(this.store.session(id).graph, strategy);
    return graphView(this.store, id);
  }

  applyPmAllocation(
    id: string,
    recommendations: readonly PmAssignmentRecommendation[],
  ): ProjectGraphView {
    applyPmAllocation(this.store.session(id).graph, recommendations);
    return graphView(this.store, id);
  }

  overrideAssignment(id: string, nodeId: string, patch: AssignmentPatch): ProjectGraphView {
    overrideAssignment(this.store.session(id).graph, nodeId, patch);
    return graphView(this.store, id);
  }

  approveAllocation(id: string, actor: string): ApprovalT {
    const session = this.store.session(id);
    const approval = approveAllocation(session.graph, actor);
    session.recordApproval(approval);
    return approval;
  }

  loadPlan(id: string, plan: PlanContractT): ProjectGraphView {
    this.store.loadPlan(id, plan);
    return graphView(this.store, id);
  }
}

function isProjectRepository(value: ProjectRepository | ProjectStore): value is ProjectRepository {
  return "repositoryKind" in value && value.repositoryKind === "project_repository";
}

export function projectRepository(
  repositoryOrStore: ProjectRepository | ProjectStore,
): ProjectRepository {
  return isProjectRepository(repositoryOrStore)
    ? repositoryOrStore
    : new LegacyProjectRepository(repositoryOrStore);
}

export type ProjectNodeInput = Pick<GraphNode, "id" | "title"> & {
  complexity?: GraphNode["complexity"];
  risk?: GraphNode["risk"];
  dependencies?: string[];
};
