import type { V2PersistenceRouteT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { RelationalProjectReadRepository } from "./relationalReadRepository.js";
import type { ProjectRepository } from "./repository.js";
import {
  type ProjectShadowComparisonSink,
  ShadowProjectRepository,
} from "./shadowProjectRepository.js";
import type { ProjectSummary } from "./store.js";

export interface ProjectPersistenceRoutes {
  new_projects: V2PersistenceRouteT | null;
  projects: ReadonlyMap<string, V2PersistenceRouteT>;
}

export interface RoutedProjectRepositoryOptions {
  legacy: ProjectRepository;
  routes: ProjectPersistenceRoutes;
  transactions: V2TransactionRunner;
  comparison_sink: ProjectShadowComparisonSink;
  now?: (() => string) | undefined;
}

/**
 * Phase 2 compatibility router.
 *
 * Routes are intentionally loaded once at application startup. A durable
 * route change therefore takes effect only after a restart, which makes a
 * canary promotion observable and reversible without changing a live
 * process underneath in-flight requests.
 *
 * Reads may be legacy, shadow, or relational. Every mutation remains owned
 * by the legacy ProjectStore until Phase 3 supplies relational commands.
 */
export class RoutedProjectRepository implements ProjectRepository {
  readonly repositoryKind = "project_repository" as const;
  private readonly relationalByRun = new Map<string, RelationalProjectReadRepository>();
  private readonly shadowByRoute = new Map<string, ShadowProjectRepository>();
  private readonly newProjectsRoute: V2PersistenceRouteT | null;
  private readonly projectRoutes: ReadonlyMap<string, V2PersistenceRouteT>;

  constructor(private readonly options: RoutedProjectRepositoryOptions) {
    this.newProjectsRoute = options.routes.new_projects;
    this.projectRoutes = new Map(options.routes.projects);
  }

  private repositoryFor(route: V2PersistenceRouteT | null): ProjectRepository {
    if (route === null || route.read_mode === "legacy") return this.options.legacy;
    const migrationRunId = route.migration_run_id;
    if (migrationRunId === null) {
      throw new Error(
        `${route.scope_type}:${route.scope_key} ${route.read_mode} route has no migration run`,
      );
    }
    let relational = this.relationalByRun.get(migrationRunId);
    if (!relational) {
      relational = new RelationalProjectReadRepository(this.options.transactions, migrationRunId);
      this.relationalByRun.set(migrationRunId, relational);
    }
    if (route.read_mode === "relational") return relational;

    const routeKey = `${route.scope_type}:${route.scope_key}:${migrationRunId}`;
    let shadow = this.shadowByRoute.get(routeKey);
    if (!shadow) {
      shadow = new ShadowProjectRepository({
        migration_run_id: migrationRunId,
        legacy: this.options.legacy,
        relational,
        comparison_sink: this.options.comparison_sink,
        now: this.options.now,
      });
      this.shadowByRoute.set(routeKey, shadow);
    }
    return shadow;
  }

  private projectRead(id: string): ProjectRepository {
    return this.repositoryFor(this.projectRoutes.get(id) ?? null);
  }

  list(): Promise<ProjectSummary[]> | ProjectSummary[] {
    return this.repositoryFor(this.newProjectsRoute).list();
  }

  summary(id: string): ReturnType<ProjectRepository["summary"]> {
    return this.projectRead(id).summary(id);
  }

  pmSelectionOf(id: string): ReturnType<ProjectRepository["pmSelectionOf"]> {
    return this.projectRead(id).pmSelectionOf(id);
  }

  graph(id: string): ReturnType<ProjectRepository["graph"]> {
    return this.projectRead(id).graph(id);
  }

  create(
    input: Parameters<ProjectRepository["create"]>[0],
  ): ReturnType<ProjectRepository["create"]> {
    return this.options.legacy.create(input);
  }

  addEdge(id: string, from: string, to: string): ReturnType<ProjectRepository["addEdge"]> {
    return this.options.legacy.addEdge(id, from, to);
  }

  removeEdge(id: string, from: string, to: string): ReturnType<ProjectRepository["removeEdge"]> {
    return this.options.legacy.removeEdge(id, from, to);
  }

  addNode(
    id: string,
    input: Parameters<ProjectRepository["addNode"]>[1],
  ): ReturnType<ProjectRepository["addNode"]> {
    return this.options.legacy.addNode(id, input);
  }

  removeNode(
    id: string,
    nodeId: string,
    mode?: Parameters<ProjectRepository["removeNode"]>[2],
  ): ReturnType<ProjectRepository["removeNode"]> {
    return this.options.legacy.removeNode(id, nodeId, mode);
  }

  allocate(
    id: string,
    strategy: Parameters<ProjectRepository["allocate"]>[1],
  ): ReturnType<ProjectRepository["allocate"]> {
    return this.options.legacy.allocate(id, strategy);
  }

  overrideAssignment(
    id: string,
    nodeId: string,
    patch: Parameters<ProjectRepository["overrideAssignment"]>[2],
  ): ReturnType<ProjectRepository["overrideAssignment"]> {
    return this.options.legacy.overrideAssignment(id, nodeId, patch);
  }

  approveAllocation(id: string, actor: string): ReturnType<ProjectRepository["approveAllocation"]> {
    return this.options.legacy.approveAllocation(id, actor);
  }

  loadPlan(
    id: string,
    plan: Parameters<ProjectRepository["loadPlan"]>[1],
  ): ReturnType<ProjectRepository["loadPlan"]> {
    return this.options.legacy.loadPlan(id, plan);
  }
}
