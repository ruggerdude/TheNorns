import type { ProviderName } from "@norns/adapters";
import type { PmModelT, V2PersistenceScopeTypeT, V2ShadowReadComparisonT } from "@norns/contracts";
import { buildShadowReadComparison } from "../persistence/migration/shadowRead.js";
import type { ProjectGraphView, ProjectRepository } from "./repository.js";
import type { ProjectSummary } from "./store.js";

type Awaitable<T> = T | Promise<T>;

export interface ProjectShadowComparisonSink {
  recordShadowComparison(comparison: V2ShadowReadComparisonT): Awaitable<void>;
}

export interface ShadowProjectRepositoryOptions {
  migration_run_id: string;
  legacy: ProjectRepository;
  relational: ProjectRepository;
  comparison_sink: ProjectShadowComparisonSink;
  now?: (() => string) | undefined;
}

interface ShadowScope {
  type: V2PersistenceScopeTypeT;
  key: string;
}

/**
 * Executes relational reads only as shadow observations. The legacy value is
 * always returned; comparison evidence stores hashes and JSON-pointer paths,
 * never response values such as a local repository path.
 */
export class ShadowProjectRepository implements ProjectRepository {
  readonly repositoryKind = "project_repository" as const;
  private readonly now: () => string;

  constructor(private readonly options: ShadowProjectRepositoryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async read<T>(
    scope: ShadowScope,
    operation: string,
    legacyRead: () => Awaitable<T>,
    relationalRead: () => Awaitable<T>,
  ): Promise<T> {
    const legacy = await legacyRead();
    let relational: unknown;
    try {
      relational = await relationalRead();
    } catch (error) {
      // Error messages may include source paths or other protected values.
      // Only the stable error class is comparison input/evidence.
      relational = {
        shadow_projection_unavailable: true,
        error_name: error instanceof Error ? error.name : "UnknownError",
      };
    }
    await this.options.comparison_sink.recordShadowComparison(
      buildShadowReadComparison({
        migration_run_id: this.options.migration_run_id,
        scope_type: scope.type,
        scope_key: scope.key,
        operation,
        legacy,
        relational,
        observed_at: this.now(),
      }),
    );
    return legacy;
  }

  list(): Promise<ProjectSummary[]> {
    return this.read(
      { type: "new_projects", key: "*" },
      "list",
      () => this.options.legacy.list(),
      () => this.options.relational.list(),
    );
  }

  summary(id: string): Promise<ProjectSummary> {
    return this.read(
      { type: "project", key: id },
      "summary",
      () => this.options.legacy.summary(id),
      () => this.options.relational.summary(id),
    );
  }

  pmSelectionOf(id: string): Promise<{ provider: ProviderName; model: PmModelT | null }> {
    return this.read(
      { type: "project", key: id },
      "pmSelectionOf",
      () => this.options.legacy.pmSelectionOf(id),
      () => this.options.relational.pmSelectionOf(id),
    );
  }

  graph(id: string): Promise<ProjectGraphView> {
    return this.read(
      { type: "project", key: id },
      "graph",
      () => this.options.legacy.graph(id),
      () => this.options.relational.graph(id),
    );
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
