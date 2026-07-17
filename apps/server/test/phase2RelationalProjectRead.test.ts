import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { type V2ShadowReadComparisonT, isPmModelForProvider } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphSnapshot } from "../src/graph/graph.js";
import {
  LegacyProjectSnapshot,
  type LegacyProjectSnapshotT,
  parseLegacyProjectPayloads,
} from "../src/persistence/migration/legacyProjectSchemas.js";
import { buildLegacyProjectImportPlan } from "../src/persistence/migration/projectImportPlan.js";
import { importLegacyProject } from "../src/persistence/migration/projectImportService.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  Phase3RequiredError,
  RelationalProjectReadRepository,
} from "../src/projects/relationalReadRepository.js";
import { LegacyProjectRepository, type ProjectRepository } from "../src/projects/repository.js";
import {
  type ProjectShadowComparisonSink,
  ShadowProjectRepository,
} from "../src/projects/shadowProjectRepository.js";
import { ProjectStore, type ProjectStoreSnapshot } from "../src/projects/store.js";

const RUN_ID = "migration-shadow-projects";
const MANIFEST_HASH = "a".repeat(64);
const FROZEN_AT = "2026-07-16T16:00:00.000Z";
const IMPORTED_AT = "2026-07-16T16:05:00.000Z";

function fixture(name: string): LegacyProjectSnapshotT {
  return LegacyProjectSnapshot.parse(
    JSON.parse(
      readFileSync(new URL(`./fixtures/phase2/projects/${name}.json`, import.meta.url), "utf8"),
    ),
  );
}

function allocationFingerprint(graph: GraphSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...graph.nodes]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((node) => ({ id: node.id, assignment: node.assignment })),
      ),
    )
    .digest("hex");
}

class MemoryComparisonSink implements ProjectShadowComparisonSink {
  readonly comparisons: V2ShadowReadComparisonT[] = [];

  recordShadowComparison(comparison: V2ShadowReadComparisonT): void {
    this.comparisons.push(comparison);
  }
}

function legacyRepository(source: LegacyProjectSnapshotT): ProjectRepository {
  const parsed = parseLegacyProjectPayloads(source);
  if (!parsed.plan_valid || !parsed.graph_valid || !parsed.approval_valid) {
    throw new Error("test fixture must be a restorable legacy project");
  }
  const selectedModel = source.pmModel ?? null;
  if (selectedModel !== null && !isPmModelForProvider(source.pmProvider, selectedModel)) {
    throw new Error("test fixture has an invalid PM model");
  }
  const store = new ProjectStore();
  const snapshot: ProjectStoreSnapshot = {
    projects: [
      {
        id: source.id,
        name: source.name,
        description: source.description,
        pmProvider: source.pmProvider,
        pmModel: selectedModel,
        sourceType: source.sourceType ?? null,
        sourceLocation: source.sourceLocation ?? null,
        createdAt: source.createdAt,
        plan: parsed.plan,
        graph: parsed.graph,
        approval: parsed.approval,
      },
    ],
  };
  store.restoreFrom(snapshot);
  return new LegacyProjectRepository(store);
}

describe.sequential("Phase 2 relational project read projection", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(
      `CREATE TABLE norns_state (
         key TEXT PRIMARY KEY,
         snapshot JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );
       CREATE ROLE norns_app NOLOGIN;`,
    );
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.query(
      `INSERT INTO migration_runs (
         id, migration_name, source_snapshot_hashes, source_counts,
         source_frozen_at, source_manifest_hash, source_application_version,
         source_application_commit, status, started_at
       ) VALUES ($1,'phase2-shadow-read','{}'::jsonb,'{}'::jsonb,$2,$3,'0.1.0','test','importing',$2)`,
      [RUN_ID, FROZEN_AT, MANIFEST_HASH],
    );
    await pg.query(
      `INSERT INTO archive_encryption_key_registry (key_id, key_fingerprint)
       VALUES ('test-key', $1)`,
      ["9".repeat(64)],
    );
    await pg.query(
      `INSERT INTO legacy_snapshot_archives (
         id, migration_run_id, source_key, source_updated_at, storage_ref,
         key_id, key_fingerprint, cipher, exact_hash, canonical_hash, ciphertext_hash, aad_hash,
         manifest_hash, exact_byte_size, canonical_byte_size, object_counts,
         last_record, nonce, auth_tag, ciphertext, status, captured_at,
         retention_until, verified_at
       ) VALUES (
         'archive-projects',$1,'projects',$2,'postgres://archive/projects','test-key',
         $5,'aes-256-gcm',$3,$3,$3,$3,$4,1,1,'{}'::jsonb,NULL,
         decode('00','hex'),decode('00','hex'),decode('00','hex'),
         'verified',$2,'2026-08-16T16:00:00.000Z',$2
       )`,
      [RUN_ID, FROZEN_AT, "b".repeat(64), MANIFEST_HASH, "9".repeat(64)],
    );
    transactions = new PGliteTransactionRunner(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  async function importSource(source: LegacyProjectSnapshotT): Promise<void> {
    await importLegacyProject({
      transaction_runner: transactions,
      migration_run_id: RUN_ID,
      source_manifest_hash: MANIFEST_HASH,
      occurred_at: IMPORTED_AT,
      plan: buildLegacyProjectImportPlan(source, { source_frozen_at: FROZEN_AT }),
    });
  }

  function relational(): RelationalProjectReadRepository {
    return new RelationalProjectReadRepository(transactions, RUN_ID);
  }

  it("produces clean legacy-shaped reads and records all-green shadow evidence", async () => {
    const source = fixture("clean-planned");
    await importSource(source);
    const sink = new MemoryComparisonSink();
    const shadow = new ShadowProjectRepository({
      migration_run_id: RUN_ID,
      legacy: legacyRepository(source),
      relational: relational(),
      comparison_sink: sink,
      now: () => "2026-07-16T18:00:00.000Z",
    });

    expect(await shadow.list()).toEqual([await shadow.summary(source.id)]);
    expect(await shadow.pmSelectionOf(source.id)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(await shadow.graph(source.id)).toEqual(await legacyRepository(source).graph(source.id));
    expect(sink.comparisons).toHaveLength(4);
    expect(sink.comparisons.every((comparison) => comparison.matched)).toBe(true);
  });

  it("projects graph-only placeholders, omits deleted plan-only tasks, and never duplicates list rows", async () => {
    const graphOnly = fixture("graph-only-node");
    const deleted = fixture("deleted-module");
    expect(graphOnly.createdAt).toBe(deleted.createdAt);
    await importSource(graphOnly);
    await importSource(deleted);
    // Replaying the same import must not multiply compatibility rows.
    await importSource(graphOnly);

    const repository = relational();
    const expectedOrder = ["proj-graph-only", "proj-deleted"];
    expect((await repository.list()).map((project) => project.id)).toEqual(expectedOrder);
    expect((await repository.list()).map((project) => project.id)).toEqual(expectedOrder);
    const graphOnlyView = await repository.graph(graphOnly.id);
    expect(graphOnlyView.graph.nodes.map((node) => node.id)).toEqual(["a", "manual"]);
    expect(graphOnlyView.graph.nodes.find((node) => node.id === "manual")?.dependencies).toEqual([
      "a",
    ]);
    const deletedView = await repository.graph(deleted.id);
    expect(deletedView.graph.version).toBe(2);
    expect(deletedView.graph.nodes.map((node) => node.id)).toEqual(["a"]);
  });

  it("recomputes historical approval currency from the current projected allocation", async () => {
    const source = fixture("changed-assignment");
    const parsed = parseLegacyProjectPayloads(source);
    if (parsed.graph === null || parsed.approval === null) throw new Error("fixture lacks graph");
    source.approval = {
      ...parsed.approval,
      graph_version: parsed.graph.version,
      allocation_fingerprint: allocationFingerprint(parsed.graph),
    };
    await importSource(source);

    const view = await relational().graph(source.id);
    expect(view.approval).toMatchObject({
      actor: parsed.approval.actor,
      current: true,
    });
    const frozenFlag = await pg.query<{ current_at_import: boolean }>(
      "SELECT current_at_import FROM legacy_approval_evidence WHERE project_id = $1",
      [source.id],
    );
    // The intentionally stale content hash makes the frozen reconciliation
    // flag false; the compatibility banner follows legacy graph semantics and
    // derives currentness from graph version + live allocation fingerprint.
    expect(frozenFlag.rows[0]?.current_at_import).toBe(false);
  });

  it("projects only the imported phase and strategy when later V2 work exists", async () => {
    const source = fixture("clean-planned");
    await importSource(source);
    const mappings = await pg.query<{ v2_entity_type: string; v2_id: string }>(
      `SELECT v2_entity_type, v2_id
       FROM legacy_id_mappings
       WHERE migration_run_id = $1
         AND legacy_entity_type IN ('project_initial_phase', 'project_strategy', 'project_objective')`,
      [RUN_ID],
    );
    const mapped = new Map(mappings.rows.map((row) => [row.v2_entity_type, row.v2_id]));
    const initialPhase = mapped.get("phase");
    const initialStrategy = mapped.get("strategy_version");
    const initialObjective = mapped.get("objective");
    if (!initialPhase || !initialStrategy || !initialObjective) {
      throw new Error("imported provenance mappings are incomplete");
    }

    await pg.query(
      `INSERT INTO phases (
         id, project_id, objective_summary, priority, status, approved_budget_usd,
         created_at, updated_at
       ) VALUES (
         'phase:future',$1,'Future phase',0,'proposed',0,
         '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'
       )`,
      [source.id],
    );
    await pg.query(
      `INSERT INTO strategy_versions (
         id, project_id, phase_id, version, status, objective, content,
         convergence, review_rounds, content_hash
       ) VALUES (
         'strategy:future-phase',$1,'phase:future',1,'draft','Future phase','{}'::jsonb,
         'pending',0,$2
       )`,
      [source.id, "c".repeat(64)],
    );
    await pg.query(
      `INSERT INTO objectives (
         id, project_id, phase_id, outcome, success_measures, status, "order"
       ) VALUES (
         'objective:future-phase',$1,'phase:future','Future phase','["future"]'::jsonb,'proposed',0
       )`,
      [source.id],
    );
    await pg.query(
      `INSERT INTO strategy_versions (
         id, project_id, phase_id, version, status, objective, content,
         convergence, review_rounds, content_hash, supersedes_strategy_version_id
       ) VALUES (
         'strategy:future-amendment',$1,$2,2,'draft','Future amendment','{}'::jsonb,
         'pending',0,$3,$4
       )`,
      [source.id, initialPhase, "d".repeat(64), initialStrategy],
    );
    for (const [taskId, phaseId, objectiveId, strategyId, localId] of [
      [
        "task:future-phase",
        "phase:future",
        "objective:future-phase",
        "strategy:future-phase",
        "future-phase",
      ],
      [
        "task:future-amendment",
        initialPhase,
        initialObjective,
        "strategy:future-amendment",
        "future-amendment",
      ],
    ] as const) {
      await pg.query(
        `INSERT INTO tasks (
           id, project_id, phase_id, objective_id, strategy_version_id,
           title, description, deliverables, acceptance_criteria, complexity,
           risk, required_roles, expected_outputs, environment_policy_ref,
           verification_policy_ref, state
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$6,'["future"]'::jsonb,'["future"]'::jsonb,'M',
           'medium','["implementation"]'::jsonb,'["future"]'::jsonb,
           'policy:future-environment','policy:future-verification','pending'
         )`,
        [taskId, source.id, phaseId, objectiveId, strategyId, localId],
      );
      await pg.query(
        `INSERT INTO legacy_id_mappings (
           migration_run_id, legacy_entity_type, legacy_id, v2_entity_type,
           v2_id, source_hash, source_metadata
         ) VALUES ($1,'future_task',$2,'task',$3,$4,$5::jsonb)`,
        [
          RUN_ID,
          `${source.id}#${localId}`,
          taskId,
          "e".repeat(64),
          JSON.stringify({
            source_kind: "graph_only",
            legacy_graph_node: {
              id: localId,
              title: localId,
              complexity: "M",
              risk: "medium",
              parallel_safe: false,
              dependencies: [],
              assignment: null,
            },
          }),
        ],
      );
    }

    const graph = await relational().graph(source.id);
    expect(graph.graph.nodes.map((node) => node.id)).toEqual(["a"]);
    expect((await relational().summary(source.id)).plan_objective).toBe(
      parseLegacyProjectPayloads(source).plan?.objective,
    );
  });

  it("records a deliberate mismatch without placing a raw local path in evidence", async () => {
    const source = fixture("clean-planned");
    source.sourceType = "local";
    source.sourceLocation = "/Users/operator/private/customer-repository";
    await importSource(source);
    const sink = new MemoryComparisonSink();
    const shadow = new ShadowProjectRepository({
      migration_run_id: RUN_ID,
      legacy: legacyRepository(source),
      relational: relational(),
      comparison_sink: sink,
      now: () => "2026-07-16T18:00:00.000Z",
    });

    const returned = await shadow.summary(source.id);
    expect(returned.source_location).toBe(source.sourceLocation);
    expect(sink.comparisons[0]).toMatchObject({
      matched: false,
      differences: ["/source_location"],
    });
    expect(JSON.stringify(sink.comparisons)).not.toContain(source.sourceLocation);
    expect(JSON.stringify(sink.comparisons)).not.toContain("customer-repository");
  });

  it("creates relational projects while legacy graph mutations remain isolated", async () => {
    const source = fixture("clean-planned");
    await importSource(source);
    const relationalRepository = relational();
    const shadowLegacy = legacyRepository(source);
    const shadowRepository = new ShadowProjectRepository({
      migration_run_id: RUN_ID,
      legacy: shadowLegacy,
      relational: relationalRepository,
      comparison_sink: new MemoryComparisonSink(),
    });
    const plan = parseLegacyProjectPayloads(source).plan;
    if (plan === null) throw new Error("fixture lacks plan");

    await expect(
      relationalRepository.create({ name: "x", description: "x", pmProvider: "anthropic" }),
    ).resolves.toMatchObject({ name: "x", pm_provider: "anthropic" });

    const attempts = [
      () => relationalRepository.addEdge(source.id, "a", "b"),
      () => relationalRepository.removeEdge(source.id, "a", "b"),
      () => relationalRepository.addNode(source.id, { id: "b", title: "B" }),
      () => relationalRepository.removeNode(source.id, "a"),
      () => relationalRepository.allocate(source.id, "balanced"),
      () =>
        relationalRepository.overrideAssignment(source.id, "a", {
          model: "claude-sonnet-5",
        }),
      () => relationalRepository.approveAllocation(source.id, "operator"),
      () => relationalRepository.loadPlan(source.id, plan),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(Phase3RequiredError);
    }

    expect(
      await shadowRepository.create({
        name: "legacy-owned",
        description: "legacy write",
        pmProvider: "anthropic",
      }),
    ).toMatchObject({ name: "legacy-owned" });
    expect(
      (await shadowRepository.addNode(source.id, { id: "b", title: "B" })).graph.nodes,
    ).toHaveLength(2);
    expect(
      (await shadowRepository.addEdge(source.id, "a", "b")).graph.nodes[1]?.dependencies,
    ).toEqual(["a"]);
    expect(
      (await shadowRepository.removeEdge(source.id, "a", "b")).graph.nodes[1]?.dependencies,
    ).toEqual([]);
    expect((await shadowRepository.allocate(source.id, "balanced")).cost.unallocated).toEqual([]);
    expect(
      (await shadowRepository.overrideAssignment(source.id, "a", { budget_usd: 11 })).cost
        .total_usd,
    ).toBeGreaterThan(0);
    expect((await shadowRepository.approveAllocation(source.id, "operator")).actor).toBe(
      "operator",
    );
    expect((await shadowRepository.removeNode(source.id, "b")).removed).toEqual(["b"]);
    expect((await shadowRepository.loadPlan(source.id, plan)).graph.nodes).toHaveLength(1);
  });

  it("retains the selected workspace connection and repository identity on native creation", async () => {
    await pg.query(
      `INSERT INTO service_connections (
         id, provider, display_name, status, owner_type, owner_login,
         external_account_id, installation_id, repository_selection,
         connected_by_user_id
       ) VALUES (
         'github:42','github','octocat on GitHub','connected','user','octocat',
         '101','42','all','norns-user-1'
       )`,
    );
    const created = await relational().create({
      name: "Connected project",
      description: "Uses a selected repository",
      pmProvider: "openai",
      sourceType: "github",
      sourceLocation: "https://github.com/octocat/existing-app.git",
      sourceConnectionId: "github:42",
      sourceRepositoryId: "9001",
      sourceDefaultBranch: "main",
    });

    const candidate = await pg.query<{
      service_connection_id: string;
      external_repository_id: string;
      default_branch: string;
    }>(
      `SELECT service_connection_id, external_repository_id, default_branch
       FROM repository_binding_candidates WHERE project_id = $1`,
      [created.id],
    );
    expect(candidate.rows).toEqual([
      {
        service_connection_id: "github:42",
        external_repository_id: "9001",
        default_branch: "main",
      },
    ]);
  });
});
