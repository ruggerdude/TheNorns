import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const PHASE1_V2_MIGRATION_NAME = "0001_refoundation_v2";
export const PHASE1_V2_MIGRATION_URL = new URL(
  "../../../drizzle/0001_refoundation_v2.sql",
  import.meta.url,
);
export const PHASE2_PRESERVATION_MIGRATION_NAME = "0002_preservation_migration";
export const PHASE2_PRESERVATION_MIGRATION_URL = new URL(
  "../../../drizzle/0002_preservation_migration.sql",
  import.meta.url,
);
export const PHASE3_SOURCE_BINDINGS_MIGRATION_NAME = "0003_phase3_source_bindings";
export const PHASE3_SOURCE_BINDINGS_MIGRATION_URL = new URL(
  "../../../drizzle/0003_phase3_source_bindings.sql",
  import.meta.url,
);
export const PHASE5_ATTENTION_MIGRATION_NAME = "0004_phase5_attention";
export const PHASE5_ATTENTION_MIGRATION_URL = new URL(
  "../../../drizzle/0004_phase5_attention.sql",
  import.meta.url,
);
export const PHASE6_COORDINATION_MIGRATION_NAME = "0005_phase6_coordination";
export const PHASE6_COORDINATION_MIGRATION_URL = new URL(
  "../../../drizzle/0005_phase6_coordination.sql",
  import.meta.url,
);
export const PHASE7_HARDENING_MIGRATION_NAME = "0006_phase7_hardening";
export const PHASE7_HARDENING_MIGRATION_URL = new URL(
  "../../../drizzle/0006_phase7_hardening.sql",
  import.meta.url,
);
export const PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME = "0007_phase8_cutover_completion";
export const PHASE8_CUTOVER_COMPLETION_MIGRATION_URL = new URL(
  "../../../drizzle/0007_phase8_cutover_completion.sql",
  import.meta.url,
);
export const WORKSPACE_CONNECTIONS_MIGRATION_NAME = "0008_workspace_connections";
export const WORKSPACE_CONNECTIONS_MIGRATION_URL = new URL(
  "../../../drizzle/0008_workspace_connections.sql",
  import.meta.url,
);
export const QC_COMMUNICATION_MIGRATION_NAME = "0009_qc_communication_decisions";
export const QC_COMMUNICATION_MIGRATION_URL = new URL(
  "../../../drizzle/0009_qc_communication_decisions.sql",
  import.meta.url,
);
export const GITHUB_APP_MANIFEST_MIGRATION_NAME = "0010_github_app_manifest";
export const GITHUB_APP_MANIFEST_MIGRATION_URL = new URL(
  "../../../drizzle/0010_github_app_manifest.sql",
  import.meta.url,
);
export const DEBATE_WORKFLOW_MIGRATION_NAME = "0011_debate_workflow";
export const DEBATE_WORKFLOW_MIGRATION_URL = new URL(
  "../../../drizzle/0011_debate_workflow.sql",
  import.meta.url,
);
export const PLANNING_RUNS_MIGRATION_NAME = "0012_planning_runs";
export const PLANNING_RUNS_MIGRATION_URL = new URL(
  "../../../drizzle/0012_planning_runs.sql",
  import.meta.url,
);
export const FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME = "0013_frontdoor_phase_bridge";
export const FRONTDOOR_PHASE_BRIDGE_MIGRATION_URL = new URL(
  "../../../drizzle/0013_frontdoor_phase_bridge.sql",
  import.meta.url,
);
// FRONT DOOR P4 (D3): image attachments + planning_runs.attachment_ids.
// Renumbered 0013 -> 0014 at integration: P3 and P4 ran in parallel and both
// claimed 0013; the bridge migration merged first.
export const ATTACHMENTS_MIGRATION_NAME = "0014_attachments";
export const ATTACHMENTS_MIGRATION_URL = new URL(
  "../../../drizzle/0014_attachments.sql",
  import.meta.url,
);
// FRONT DOOR P5: progress tracking settings. Renumbered 0014 -> 0015 at
// integration (same parallel-agent numbering collision as attachments).
export const FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME = "0015_frontdoor_progress_tracking";
export const FRONTDOOR_PROGRESS_TRACKING_MIGRATION_URL = new URL(
  "../../../drizzle/0015_frontdoor_progress_tracking.sql",
  import.meta.url,
);

// ONBOARDING O2: binding roles (workspace vs remote), the push-credential
// strategy seam, and actor-scoped onboarding idempotency.
export const ONBOARDING_BINDINGS_MIGRATION_NAME = "0016_onboarding_bindings";
export const ONBOARDING_BINDINGS_MIGRATION_URL = new URL(
  "../../../drizzle/0016_onboarding_bindings.sql",
  import.meta.url,
);

// ONBOARDING O4: GitHub Actions execution path.
export const ACTIONS_EXECUTION_MIGRATION_NAME = "0017_actions_execution";
export const ACTIONS_EXECUTION_MIGRATION_URL = new URL(
  "../../../drizzle/0017_actions_execution.sql",
  import.meta.url,
);

// ONBOARDING O6: repository-creation intents, so an idempotent retry can be
// told apart from silently adopting a user's existing repository.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED. 0016 and 0017 are taken; the PM
// assigns this one and renames the file at integration.
export const ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME = "0018_onboarding_repository_intents";
export const ONBOARDING_REPOSITORY_INTENTS_MIGRATION_URL = new URL(
  "../../../drizzle/0018_onboarding_repository_intents.sql",
  import.meta.url,
);

// EXECUTION E1: content-addressed assembled task context (task_context_blobs +
// task_context_documents), the payload every dispatched run fetches.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED. 0018 is the highest number merged when
// E1 was written; the PM assigns the real number and renames the file at
// integration.
export const TASK_CONTEXT_MIGRATION_NAME = "0019_task_context";
export const TASK_CONTEXT_MIGRATION_URL = new URL(
  "../../../drizzle/0019_task_context.sql",
  import.meta.url,
);

// EXECUTION E2: binds an assembled task-context document to the runner that
// was actually dispatched to read it (the fetch route's missing
// authorization check, on top of E1's authentication).
//
// THE NUMBER IS DELIBERATELY UNASSIGNED. 0019 is the highest number merged
// when E2 was written; the PM assigns the real number and renames the file at
// integration.
export const DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME = "0020_dispatch_context_scope";
export const DISPATCH_CONTEXT_SCOPE_MIGRATION_URL = new URL(
  "../../../drizzle/0020_dispatch_context_scope.sql",
  import.meta.url,
);

// EXECUTION E9: per-run credentials for the provider-native model gateway
// (gateway_credentials). Only a sha-256 hash of each token is stored.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED — the file is literally named
// `0021_gateway_credentials.sql`. 0020 is the highest number merged when E9
// was written, and three parallel agents have collided on migration numbers
// already; the PM assigns the real number and renames both the file and the
// string below at integration.
export const GATEWAY_CREDENTIALS_MIGRATION_NAME = "0021_gateway_credentials";
export const GATEWAY_CREDENTIALS_MIGRATION_URL = new URL(
  "../../../drizzle/0021_gateway_credentials.sql",
  import.meta.url,
);

// EXECUTION E10: persists the branch, remote and pull request a run published,
// so a completed task can be clicked through to its review instead of having
// that fact live only in a `run_log` string.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED — the file is literally named
// `0022_run_publication.sql`, matching E9's convention. 0020 is the highest
// number merged when E10 was written and E9 is unnumbered in parallel; the PM
// assigns the real number and renames both the file and the string below at
// integration.
export const RUN_PUBLICATION_MIGRATION_NAME = "0022_run_publication";
export const RUN_PUBLICATION_MIGRATION_URL = new URL(
  "../../../drizzle/0022_run_publication.sql",
  import.meta.url,
);

// EXECUTION E5: per-dispatch runner identity for GitHub Actions-hosted
// execution (github_actions_runs_runner_id_unique_idx) — the fix for
// concurrent Actions-hosted dispatches in one project fencing each other off.
//
// THE NUMBER IS DELIBERATELY UNASSIGNED — the file is literally named
// `0023_actions_dispatch_runner_identity.sql`, matching E9/E10's convention.
// 0020 is the highest assigned number merged when E5 was written, and E9/E10
// are unnumbered in parallel; the PM assigns the real number and renames both
// the file and the string below at integration.
export const ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME =
  "0023_actions_dispatch_runner_identity";
export const ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_URL = new URL(
  "../../../drizzle/0023_actions_dispatch_runner_identity.sql",
  import.meta.url,
);

// EXECUTION E12 — conflict safety for concurrent tasks inside one phase. The
// number is unassigned for the same reason as every entry above it: parallel
// phases each pick the next free number and the PM renames the file and this
// string at integration.
export const PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME = "0024_phase_concurrency_conflicts";
export const PHASE_CONCURRENCY_CONFLICTS_MIGRATION_URL = new URL(
  "../../../drizzle/0024_phase_concurrency_conflicts.sql",
  import.meta.url,
);

export interface V2MigrationQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  affectedRows?: number;
}

export interface V2MigrationExecutor {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<V2MigrationQueryResult<TRow>>;
  exec?(sql: string): Promise<unknown>;
}

export interface V2MigrationDatabase extends V2MigrationExecutor {
  transaction<T>(work: (tx: V2MigrationExecutor) => Promise<T>): Promise<T>;
}

export interface V2MigrationResult {
  name: string;
  checksum: string;
  applied: boolean;
}

export interface V2MigrationSource {
  name: string;
  sql: string;
}

interface AppliedMigrationRow {
  checksum: string;
}

export async function loadPhase1V2MigrationSql(): Promise<string> {
  return readFile(PHASE1_V2_MIGRATION_URL, "utf8");
}

export async function loadPhase2PreservationMigrationSql(): Promise<string> {
  return readFile(PHASE2_PRESERVATION_MIGRATION_URL, "utf8");
}

export async function loadPhase3SourceBindingsMigrationSql(): Promise<string> {
  return readFile(PHASE3_SOURCE_BINDINGS_MIGRATION_URL, "utf8");
}

export async function loadPhase5AttentionMigrationSql(): Promise<string> {
  return readFile(PHASE5_ATTENTION_MIGRATION_URL, "utf8");
}

export async function loadPhase6CoordinationMigrationSql(): Promise<string> {
  return readFile(PHASE6_COORDINATION_MIGRATION_URL, "utf8");
}

export async function loadPhase7HardeningMigrationSql(): Promise<string> {
  return readFile(PHASE7_HARDENING_MIGRATION_URL, "utf8");
}

export async function loadPhase8CutoverCompletionMigrationSql(): Promise<string> {
  return readFile(PHASE8_CUTOVER_COMPLETION_MIGRATION_URL, "utf8");
}

export async function loadWorkspaceConnectionsMigrationSql(): Promise<string> {
  return readFile(WORKSPACE_CONNECTIONS_MIGRATION_URL, "utf8");
}

export async function loadQcCommunicationMigrationSql(): Promise<string> {
  return readFile(QC_COMMUNICATION_MIGRATION_URL, "utf8");
}

export async function loadGitHubAppManifestMigrationSql(): Promise<string> {
  return readFile(GITHUB_APP_MANIFEST_MIGRATION_URL, "utf8");
}

export async function loadDebateWorkflowMigrationSql(): Promise<string> {
  return readFile(DEBATE_WORKFLOW_MIGRATION_URL, "utf8");
}

export async function loadPlanningRunsMigrationSql(): Promise<string> {
  return readFile(PLANNING_RUNS_MIGRATION_URL, "utf8");
}

export async function loadFrontDoorPhaseBridgeMigrationSql(): Promise<string> {
  return readFile(FRONTDOOR_PHASE_BRIDGE_MIGRATION_URL, "utf8");
}

export async function loadAttachmentsMigrationSql(): Promise<string> {
  return readFile(ATTACHMENTS_MIGRATION_URL, "utf8");
}

export async function loadFrontDoorProgressTrackingMigrationSql(): Promise<string> {
  return readFile(FRONTDOOR_PROGRESS_TRACKING_MIGRATION_URL, "utf8");
}

export async function loadOnboardingBindingsMigrationSql(): Promise<string> {
  return readFile(ONBOARDING_BINDINGS_MIGRATION_URL, "utf8");
}

export async function loadActionsExecutionMigrationSql(): Promise<string> {
  return readFile(ACTIONS_EXECUTION_MIGRATION_URL, "utf8");
}

export async function loadOnboardingRepositoryIntentsMigrationSql(): Promise<string> {
  return readFile(ONBOARDING_REPOSITORY_INTENTS_MIGRATION_URL, "utf8");
}

export async function loadTaskContextMigrationSql(): Promise<string> {
  return readFile(TASK_CONTEXT_MIGRATION_URL, "utf8");
}

export async function loadDispatchContextScopeMigrationSql(): Promise<string> {
  return readFile(DISPATCH_CONTEXT_SCOPE_MIGRATION_URL, "utf8");
}

export async function loadGatewayCredentialsMigrationSql(): Promise<string> {
  return readFile(GATEWAY_CREDENTIALS_MIGRATION_URL, "utf8");
}

export async function loadRunPublicationMigrationSql(): Promise<string> {
  return readFile(RUN_PUBLICATION_MIGRATION_URL, "utf8");
}

export async function loadActionsDispatchRunnerIdentityMigrationSql(): Promise<string> {
  return readFile(ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_URL, "utf8");
}

export async function loadPhaseConcurrencyConflictsMigrationSql(): Promise<string> {
  return readFile(PHASE_CONCURRENCY_CONFLICTS_MIGRATION_URL, "utf8");
}

export function v2MigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export const phase1V2MigrationChecksum = v2MigrationChecksum;

async function executeMigrationBatch(tx: V2MigrationExecutor, sql: string): Promise<void> {
  if (tx.exec) {
    await tx.exec(sql);
    return;
  }
  await tx.query(sql);
}

/**
 * Applies an ordered forward-only migration list.
 *
 * Every migration and its tracking row commit atomically. An already-applied
 * migration is replay-safe only when its source checksum is unchanged.
 */
export async function runV2Migrations(
  database: V2MigrationDatabase,
  migrations: readonly V2MigrationSource[],
): Promise<V2MigrationResult[]> {
  await database.query(
    `CREATE TABLE IF NOT EXISTS norns_schema_migrations (
       name TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const results: V2MigrationResult[] = [];
  for (const migration of migrations) {
    const checksum = v2MigrationChecksum(migration.sql);
    const result = await database.transaction(async (tx) => {
      const existing = await tx.query<AppliedMigrationRow>(
        "SELECT checksum FROM norns_schema_migrations WHERE name = $1 FOR UPDATE",
        [migration.name],
      );
      const applied = existing.rows[0];
      if (applied) {
        if (applied.checksum !== checksum) {
          throw new Error(
            `migration ${migration.name} checksum mismatch: ` +
              `database=${applied.checksum} source=${checksum}`,
          );
        }
        return {
          name: migration.name,
          checksum,
          applied: false,
        };
      }

      await executeMigrationBatch(tx, migration.sql);
      await tx.query(
        `INSERT INTO norns_schema_migrations (name, checksum)
         VALUES ($1, $2)`,
        [migration.name, checksum],
      );

      return {
        name: migration.name,
        checksum,
        applied: true,
      };
    });
    results.push(result);
  }
  return results;
}

/**
 * Backward-compatible Phase 1 wrapper used by the frozen Phase 1 evidence.
 */
export async function runPhase1V2Migration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const [result] = await runV2Migrations(database, [
    {
      name: PHASE1_V2_MIGRATION_NAME,
      sql: migrationSql ?? (await loadPhase1V2MigrationSql()),
    },
  ]);
  if (!result) throw new Error("Phase 1 migration runner produced no result");
  return result;
}

export async function runPhase2PreservationMigration(
  database: V2MigrationDatabase,
  migrationSql?: string,
): Promise<V2MigrationResult> {
  const [result] = await runV2Migrations(database, [
    {
      name: PHASE2_PRESERVATION_MIGRATION_NAME,
      sql: migrationSql ?? (await loadPhase2PreservationMigrationSql()),
    },
  ]);
  if (!result) throw new Error("Phase 2 migration runner produced no result");
  return result;
}

export async function runCurrentV2Migrations(
  database: V2MigrationDatabase,
): Promise<V2MigrationResult[]> {
  return runV2Migrations(database, [
    {
      name: PHASE1_V2_MIGRATION_NAME,
      sql: await loadPhase1V2MigrationSql(),
    },
    {
      name: PHASE2_PRESERVATION_MIGRATION_NAME,
      sql: await loadPhase2PreservationMigrationSql(),
    },
    {
      name: PHASE3_SOURCE_BINDINGS_MIGRATION_NAME,
      sql: await loadPhase3SourceBindingsMigrationSql(),
    },
    {
      name: PHASE5_ATTENTION_MIGRATION_NAME,
      sql: await loadPhase5AttentionMigrationSql(),
    },
    {
      name: PHASE6_COORDINATION_MIGRATION_NAME,
      sql: await loadPhase6CoordinationMigrationSql(),
    },
    {
      name: PHASE7_HARDENING_MIGRATION_NAME,
      sql: await loadPhase7HardeningMigrationSql(),
    },
    {
      name: PHASE8_CUTOVER_COMPLETION_MIGRATION_NAME,
      sql: await loadPhase8CutoverCompletionMigrationSql(),
    },
    {
      name: WORKSPACE_CONNECTIONS_MIGRATION_NAME,
      sql: await loadWorkspaceConnectionsMigrationSql(),
    },
    {
      name: QC_COMMUNICATION_MIGRATION_NAME,
      sql: await loadQcCommunicationMigrationSql(),
    },
    {
      name: GITHUB_APP_MANIFEST_MIGRATION_NAME,
      sql: await loadGitHubAppManifestMigrationSql(),
    },
    {
      name: DEBATE_WORKFLOW_MIGRATION_NAME,
      sql: await loadDebateWorkflowMigrationSql(),
    },
    {
      name: PLANNING_RUNS_MIGRATION_NAME,
      sql: await loadPlanningRunsMigrationSql(),
    },
    {
      name: FRONTDOOR_PHASE_BRIDGE_MIGRATION_NAME,
      sql: await loadFrontDoorPhaseBridgeMigrationSql(),
    },
    {
      name: ATTACHMENTS_MIGRATION_NAME,
      sql: await loadAttachmentsMigrationSql(),
    },
    {
      name: FRONTDOOR_PROGRESS_TRACKING_MIGRATION_NAME,
      sql: await loadFrontDoorProgressTrackingMigrationSql(),
    },
    {
      name: ONBOARDING_BINDINGS_MIGRATION_NAME,
      sql: await loadOnboardingBindingsMigrationSql(),
    },
    {
      name: ACTIONS_EXECUTION_MIGRATION_NAME,
      sql: await loadActionsExecutionMigrationSql(),
    },
    {
      name: ONBOARDING_REPOSITORY_INTENTS_MIGRATION_NAME,
      sql: await loadOnboardingRepositoryIntentsMigrationSql(),
    },
    {
      name: TASK_CONTEXT_MIGRATION_NAME,
      sql: await loadTaskContextMigrationSql(),
    },
    {
      name: DISPATCH_CONTEXT_SCOPE_MIGRATION_NAME,
      sql: await loadDispatchContextScopeMigrationSql(),
    },
    {
      name: GATEWAY_CREDENTIALS_MIGRATION_NAME,
      sql: await loadGatewayCredentialsMigrationSql(),
    },
    {
      name: RUN_PUBLICATION_MIGRATION_NAME,
      sql: await loadRunPublicationMigrationSql(),
    },
    {
      name: ACTIONS_DISPATCH_RUNNER_IDENTITY_MIGRATION_NAME,
      sql: await loadActionsDispatchRunnerIdentityMigrationSql(),
    },
    {
      name: PHASE_CONCURRENCY_CONFLICTS_MIGRATION_NAME,
      sql: await loadPhaseConcurrencyConflictsMigrationSql(),
    },
  ]);
}
