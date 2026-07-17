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
 * Reads may be legacy, shadow, or relational. Write routing is independent:
 * relational project creation is supported, while legacy graph mutations
 * fail closed after a project's write route becomes relational.
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
    return this.relationalRepositoryFor(route, route.read_mode === "shadow");
  }

  private relationalRepositoryFor(
    route: V2PersistenceRouteT,
    useShadow: boolean,
  ): ProjectRepository {
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
    if (!useShadow) return relational;

    const routeKey = `${route.scope_type}:${route.scope_key}:${migrationRunId}`;
    let shadowRepository = this.shadowByRoute.get(routeKey);
    if (!shadowRepository) {
      shadowRepository = new ShadowProjectRepository({
        migration_run_id: migrationRunId,
        legacy: this.options.legacy,
        relational,
        comparison_sink: this.options.comparison_sink,
        now: this.options.now,
      });
      this.shadowByRoute.set(routeKey, shadowRepository);
    }
    return shadowRepository;
  }

  private projectRead(id: string): ProjectRepository {
    return this.repositoryFor(this.projectRoutes.get(id) ?? null);
  }

  private projectWrite(id: string): ProjectRepository {
    const route = this.projectRoutes.get(id);
    return route?.write_mode === "relational"
      ? this.relationalRepositoryFor(route, false)
      : this.options.legacy;
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
    return this.newProjectsRoute?.write_mode === "relational"
      ? this.relationalRepositoryFor(this.newProjectsRoute, false).create(input)
      : this.options.legacy.create(input);
  }

  addEdge(id: string, from: string, to: string): ReturnType<ProjectRepository["addEdge"]> {
    return this.projectWrite(id).addEdge(id, from, to);
  }

  removeEdge(id: string, from: string, to: string): ReturnType<ProjectRepository["removeEdge"]> {
    return this.projectWrite(id).removeEdge(id, from, to);
  }

  addNode(
    id: string,
    input: Parameters<ProjectRepository["addNode"]>[1],
  ): ReturnType<ProjectRepository["addNode"]> {
    return this.projectWrite(id).addNode(id, input);
  }

  removeNode(
    id: string,
    nodeId: string,
    mode?: Parameters<ProjectRepository["removeNode"]>[2],
  ): ReturnType<ProjectRepository["removeNode"]> {
    return this.projectWrite(id).removeNode(id, nodeId, mode);
  }

  allocate(
    id: string,
    strategy: Parameters<ProjectRepository["allocate"]>[1],
  ): ReturnType<ProjectRepository["allocate"]> {
    return this.projectWrite(id).allocate(id, strategy);
  }

  overrideAssignment(
    id: string,
    nodeId: string,
    patch: Parameters<ProjectRepository["overrideAssignment"]>[2],
  ): ReturnType<ProjectRepository["overrideAssignment"]> {
    return this.projectWrite(id).overrideAssignment(id, nodeId, patch);
  }

  approveAllocation(id: string, actor: string): ReturnType<ProjectRepository["approveAllocation"]> {
    return this.projectWrite(id).approveAllocation(id, actor);
  }

  loadPlan(
    id: string,
    plan: Parameters<ProjectRepository["loadPlan"]>[1],
  ): ReturnType<ProjectRepository["loadPlan"]> {
    return this.projectWrite(id).loadPlan(id, plan);
  }
}
