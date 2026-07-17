import { V2PersistenceRoute, type V2PersistenceRouteT } from "@norns/contracts";
import { SqlPhase2ControlRepository } from "../persistence/migration/controlRepository.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { LegacyProjectRepository, type ProjectRepository } from "../projects/repository.js";
import {
  type ProjectPersistenceRoutes,
  RoutedProjectRepository,
} from "../projects/routedProjectRepository.js";
import type { ProjectStore } from "../projects/store.js";

export type ProjectRuntimeErrorCode =
  | "project_route_invalid"
  | "project_route_incoherent"
  | "project_transactions_missing";

export class ProjectRuntimeConfigurationError extends Error {
  constructor(
    readonly code: ProjectRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectRuntimeConfigurationError";
  }
}

export interface ProjectRouteDatabase {
  query<TRow = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: TRow[] }>;
}

interface ProjectRouteRow {
  scope_type: string;
  scope_key: string;
  read_mode: string;
  write_mode: string;
  migration_run_id: string | null;
  aggregate_version: number | string;
  changed_by_actor_type: string;
  changed_by_actor_id: string | null;
  changed_at: Date | string;
  v2_writes_started_at: Date | string | null;
  rollback_window_until: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function parseRoute(row: ProjectRouteRow): V2PersistenceRouteT {
  const parsed = V2PersistenceRoute.safeParse({
    schema_version: 2,
    scope_type: row.scope_type,
    scope_key: row.scope_key,
    read_mode: row.read_mode,
    write_mode: row.write_mode,
    migration_run_id: row.migration_run_id,
    aggregate_version: Number(row.aggregate_version),
    changed_by: {
      actor_type: row.changed_by_actor_type,
      actor_id: row.changed_by_actor_id,
    },
    changed_at: iso(row.changed_at),
    v2_writes_started_at: optionalIso(row.v2_writes_started_at),
    rollback_window_until: optionalIso(row.rollback_window_until),
  });
  if (!parsed.success) {
    throw new ProjectRuntimeConfigurationError(
      "project_route_invalid",
      `durable project route ${row.scope_type}:${row.scope_key} failed contract validation`,
    );
  }
  if (
    (parsed.data.read_mode !== "legacy" || parsed.data.write_mode === "relational") &&
    parsed.data.migration_run_id === null
  ) {
    throw new ProjectRuntimeConfigurationError(
      "project_route_incoherent",
      `durable project route ${row.scope_type}:${row.scope_key} requires a migration run`,
    );
  }
  return parsed.data;
}

/** Read and freeze the durable project route set for one application boot. */
export async function loadDurableProjectRoutes(
  database: ProjectRouteDatabase,
): Promise<ProjectPersistenceRoutes> {
  const relation = await database.query<{ relation: string | null }>(
    "SELECT to_regclass('persistence_routes')::text AS relation",
  );
  if (relation.rows[0]?.relation === null || relation.rows[0] === undefined) {
    return { new_projects: null, projects: new Map() };
  }

  let rows: ProjectRouteRow[];
  try {
    rows = (
      await database.query<ProjectRouteRow>(
        `SELECT scope_type, scope_key, read_mode, write_mode, migration_run_id,
                aggregate_version, changed_by_actor_type, changed_by_actor_id,
                changed_at, v2_writes_started_at, rollback_window_until
         FROM persistence_routes
         WHERE scope_type IN ('project', 'new_projects')
         ORDER BY scope_type, scope_key`,
      )
    ).rows;
  } catch {
    throw new ProjectRuntimeConfigurationError(
      "project_route_invalid",
      "the durable project routes exist but cannot be read",
    );
  }

  let newProjects: V2PersistenceRouteT | null = null;
  const projects = new Map<string, V2PersistenceRouteT>();
  for (const row of rows) {
    const route = parseRoute(row);
    if (route.scope_type === "new_projects") newProjects = route;
    else if (route.scope_type === "project") projects.set(route.scope_key, route);
  }
  return { new_projects: newProjects, projects };
}

export interface CreateProjectRuntimeInput {
  projects: ProjectStore;
  routes: ProjectPersistenceRoutes;
  transactions?: V2TransactionRunner | undefined;
  now?: (() => string) | undefined;
}

export interface ProjectRuntime {
  repository: ProjectRepository;
  route_count: number;
  routed: boolean;
}

export function createProjectRuntime(input: CreateProjectRuntimeInput): ProjectRuntime {
  const legacy = new LegacyProjectRepository(input.projects);
  const routeCount = input.routes.projects.size + (input.routes.new_projects === null ? 0 : 1);
  if (routeCount === 0) return { repository: legacy, route_count: 0, routed: false };
  if (!input.transactions) {
    throw new ProjectRuntimeConfigurationError(
      "project_transactions_missing",
      "durable project routes require a runtime PostgreSQL transaction runner",
    );
  }
  const comparisonSink = new SqlPhase2ControlRepository(input.transactions);
  return {
    repository: new RoutedProjectRepository({
      legacy,
      routes: input.routes,
      transactions: input.transactions,
      comparison_sink: comparisonSink,
      now: input.now,
    }),
    route_count: routeCount,
    routed: true,
  };
}
