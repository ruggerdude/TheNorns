import { describe, expect, it } from "vitest";
import {
  V2LegacyProjectImportProvenance,
  V2LegacySnapshotArchive,
  V2LegacySnapshotManifest,
  V2MigrationReconciliationFinding,
  V2MigrationStep,
  V2PersistenceRoute,
  V2RepositoryBindingCandidate,
  V2ShadowReadComparison,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const LATER = "2026-10-16T12:00:00.000Z";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

describe("V2 preservation migration contracts", () => {
  it("pins a unique, content-addressed recovery manifest", () => {
    const manifest = {
      schema_version: 2,
      migration_run_id: "migration-run-1",
      migration_name: "legacy-preservation",
      source_frozen_at: NOW,
      manifest_hash: HASH,
      recovery_marker: {
        provider: "postgres",
        backup_reference: "backup-2026-07-16",
        database_time: NOW,
        wal_lsn: "0/16B6C50",
        transaction_id: "100",
        application_version: "0.1.0",
        application_commit: "0123456789abcdef",
      },
      snapshots: [
        {
          key: "users",
          exact_text_hash: HASH,
          semantic_hash: OTHER_HASH,
          updated_at: NOW,
          exact_byte_size: 42,
          object_counts: { users: 1, sessions: 1 },
          last_record: { last_session_id: "session-1", last_session_at: NOW },
        },
      ],
    } as const;

    expect(V2LegacySnapshotManifest.safeParse(manifest).success).toBe(true);
    expect(
      V2LegacySnapshotManifest.safeParse({
        ...manifest,
        snapshots: [manifest.snapshots[0], manifest.snapshots[0]],
      }).success,
    ).toBe(false);
  });

  it("requires archive verification/destruction evidence and bounded retention", () => {
    const archive = {
      schema_version: 2,
      id: "archive-1",
      migration_run_id: "migration-run-1",
      source_key: "users",
      source_updated_at: NOW,
      storage_ref: "s3://private/archive-1",
      key_id: "migration-key-1",
      key_fingerprint: HASH,
      cipher: "aes-256-gcm",
      exact_hash: HASH,
      canonical_hash: HASH,
      ciphertext_hash: OTHER_HASH,
      aad_hash: HASH,
      manifest_hash: HASH,
      exact_byte_size: 1024,
      canonical_byte_size: 1000,
      object_counts: { users: 1, sessions: 1 },
      last_record: { last_session_id: "session-1", last_session_at: NOW },
      nonce_b64: "bm9uY2U=",
      auth_tag_b64: "dGFn",
      ciphertext_b64: "Y2lwaGVydGV4dA==",
      status: "verified",
      captured_at: NOW,
      retention_until: LATER,
      verified_at: NOW,
    } as const;

    expect(V2LegacySnapshotArchive.safeParse(archive).success).toBe(true);
    expect(
      V2LegacySnapshotArchive.safeParse({
        ...archive,
        retention_until: NOW,
      }).success,
    ).toBe(false);
  });

  it("pins resumable step terminal evidence", () => {
    const step = {
      schema_version: 2,
      migration_run_id: "migration-run-1",
      step_key: "project:project-1",
      input_hash: HASH,
      status: "succeeded",
      attempt: 1,
      output_hash: OTHER_HASH,
      output_counts: { projects: 1, tasks: 4 },
      error_code: null,
      error_summary: null,
      started_at: NOW,
      completed_at: NOW,
    } as const;
    expect(V2MigrationStep.safeParse(step).success).toBe(true);
    expect(V2MigrationStep.safeParse({ ...step, output_hash: null }).success).toBe(false);
  });

  it("requires explicit route scope and relational-write cutover time", () => {
    const route = {
      schema_version: 2,
      scope_type: "project",
      scope_key: "project-1",
      read_mode: "relational",
      write_mode: "relational",
      migration_run_id: "migration-run-1",
      aggregate_version: 2,
      changed_by: { actor_type: "human", actor_id: "user-1" },
      changed_at: NOW,
      v2_writes_started_at: NOW,
      rollback_window_until: LATER,
    } as const;
    expect(V2PersistenceRoute.safeParse(route).success).toBe(true);
    expect(V2PersistenceRoute.safeParse({ ...route, scope_key: "*" }).success).toBe(false);
    expect(V2PersistenceRoute.safeParse({ ...route, v2_writes_started_at: null }).success).toBe(
      false,
    );
  });

  it("binds mismatches to redacted differences and stable finding codes", () => {
    const comparison = {
      schema_version: 2,
      id: "comparison-1",
      migration_run_id: "migration-run-1",
      scope_type: "project",
      scope_key: "project-1",
      operation: "graph",
      legacy_hash: HASH,
      relational_hash: OTHER_HASH,
      matched: false,
      differences: ["/nodes/task-1/title"],
      observed_at: NOW,
    } as const;
    expect(V2ShadowReadComparison.safeParse(comparison).success).toBe(true);
    expect(V2ShadowReadComparison.safeParse({ ...comparison, differences: [] }).success).toBe(
      false,
    );

    expect(
      V2MigrationReconciliationFinding.safeParse({
        schema_version: 2,
        id: "finding-1",
        migration_run_id: "migration-run-1",
        project_id: "project-1",
        code: "graph_node_without_plan_module",
        severity: "blocking",
        status: "open",
        source_entity_type: "graph_node",
        source_entity_id: "task-1",
        source_fingerprint: HASH,
        details: { title: "Imported placeholder" },
        detected_at: NOW,
        resolved_at: null,
        resolved_by_actor_id: null,
        disposition_note: null,
      }).success,
    ).toBe(true);
  });

  it("preserves project import provenance and unparseable repository candidates", () => {
    expect(
      V2LegacyProjectImportProvenance.safeParse({
        schema_version: 2,
        migration_run_id: "migration-run-1",
        project_id: "project-1",
        source_hash: HASH,
        plan_hash: OTHER_HASH,
        graph_hash: HASH,
        approval_hash: null,
        graph_version: 2,
        source_counts: { modules: 2, nodes: 3 },
        import_hash: OTHER_HASH,
        archive_id: "archive-projects",
        imported_at: NOW,
      }).success,
    ).toBe(true);

    expect(
      V2RepositoryBindingCandidate.safeParse({
        schema_version: 2,
        id: "candidate-1",
        project_id: "project-1",
        source_type: "github",
        source_fingerprint: HASH,
        display_name: "Legacy GitHub repository",
        github_owner: null,
        github_name: null,
        status: "unverified",
        archive_id: "archive-projects",
        source_record_id: "project-1",
        created_at: NOW,
        updated_at: NOW,
      }).success,
    ).toBe(true);
  });
});
