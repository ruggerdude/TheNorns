import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LegacyProjectSnapshot,
  type LegacyProjectSnapshotT,
  LegacyProjectStoreSnapshot,
} from "../src/persistence/migration/legacyProjectSchemas.js";
import { buildLegacyProjectImportPlan } from "../src/persistence/migration/projectImportPlan.js";

const FROZEN_AT = "2026-07-16T16:00:00.000Z";

function fixture(name: string): LegacyProjectSnapshotT {
  return LegacyProjectSnapshot.parse(
    JSON.parse(
      readFileSync(new URL(`./fixtures/phase2/projects/${name}.json`, import.meta.url), "utf8"),
    ),
  );
}

function importPlan(name: string) {
  return buildLegacyProjectImportPlan(fixture(name), {
    source_frozen_at: FROZEN_AT,
  });
}

describe("Phase 2 deterministic legacy project import plan", () => {
  it("tolerates future fields on the store and project envelopes", () => {
    const source = fixture("clean-planned");
    const parsed = LegacyProjectSnapshot.parse({
      ...source,
      futureProjectField: { preserved: true },
    });
    expect(parsed).toMatchObject({ futureProjectField: { preserved: true } });
    expect(
      LegacyProjectStoreSnapshot.parse({
        projects: [parsed],
        futureStoreField: ["preserved"],
      }),
    ).toMatchObject({ futureStoreField: ["preserved"] });
  });

  it("preserves project identity, timestamps, PM selection, and source metadata", () => {
    const plan = importPlan("clean-planned");
    expect(plan.project).toMatchObject({
      id: "proj-clean",
      name: "Clean project",
      description: "A clean legacy project",
      created_at: "2026-07-15T12:00:00.000Z",
      updated_at: FROZEN_AT,
      pm_provider: "anthropic",
      pm_model: "claude-sonnet-5",
      reviewer_provider: "openai",
      source_type: "github",
      source_location: "https://github.com/example/clean.git",
      status: "paused",
    });
    expect(plan.phase?.status).toBe("awaiting_approval");
    expect(plan.strategy).toMatchObject({
      status: "awaiting_approval",
      convergence: "pending",
      approval_id: null,
      requires_fresh_v2_approval: true,
    });
  });

  it("builds the plan/graph union with safe graph-only and deleted-module intent", () => {
    const graphOnly = importPlan("graph-only-node");
    expect(graphOnly.tasks.find((task) => task.local_id === "manual")).toMatchObject({
      source_kind: "graph_only",
      state: "pending",
      non_executable: true,
      acceptance_criteria: ["Human supplies acceptance criteria for legacy graph-only node manual"],
    });
    expect(
      graphOnly.task_dependencies.map((dependency) => ({
        predecessor: dependency.predecessor_task_id,
        successor: dependency.successor_task_id,
      })),
    ).toEqual([
      {
        predecessor: expect.stringContaining(":a"),
        successor: expect.stringContaining(":manual"),
      },
    ]);

    const deleted = importPlan("deleted-module");
    expect(deleted.tasks.find((task) => task.local_id === "removed")).toMatchObject({
      source_kind: "plan_only_deleted",
      state: "cancelled",
      non_executable: true,
      legacy_acceptance: [expect.objectContaining({ id: "AC-R", verification_type: "inspection" })],
    });
    expect(deleted.task_dependencies).toEqual([]);
  });

  it("creates disabled deterministic profiles and non-executable assignments", () => {
    const plan = importPlan("changed-assignment");
    expect(plan.agent_profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-sonnet-5",
          status: "disabled",
        }),
        expect.objectContaining({
          provider: "legacy-unknown",
          model: "openai-reasoning-default",
          status: "disabled",
        }),
      ]),
    );
    expect(plan.agent_assignments).toMatchObject([
      {
        budget_limit_usd: 50,
        legacy_worker_count: 1,
        legacy_source: "auto",
        non_executable: true,
      },
    ]);
  });

  it("retains approval only as historical evidence and never as Strategy approval", () => {
    const source = fixture("stale-approval");
    const legacy = buildLegacyProjectImportPlan(source, {
      source_frozen_at: FROZEN_AT,
    });
    expect(legacy.historical_approval).toMatchObject({
      actor_type: "legacy",
      actor_id: null,
      source_actor_text: "operator",
      current_at_freeze: false,
      eligible_as_v2_strategy_approval: false,
    });
    expect(legacy.strategy?.approval_id).toBeNull();

    const attributable = buildLegacyProjectImportPlan(source, {
      source_frozen_at: FROZEN_AT,
      attributable_user_ids: new Set(["operator"]),
    });
    expect(attributable.historical_approval).toMatchObject({
      actor_type: "legacy",
      actor_id: null,
      eligible_as_v2_strategy_approval: false,
    });
    expect(attributable.strategy?.approval_id).toBeNull();
  });

  it("produces stable IDs, ordering, hashes, and mappings without wall-clock input", () => {
    const source = fixture("graph-only-node");
    const first = buildLegacyProjectImportPlan(source, {
      source_frozen_at: FROZEN_AT,
    });
    const second = buildLegacyProjectImportPlan(source, {
      source_frozen_at: FROZEN_AT,
    });
    expect(first).toEqual(second);
    expect(first.tasks.map((task) => task.local_id)).toEqual(["a", "manual"]);
    expect(new Set(first.tasks.map((task) => task.id)).size).toBe(first.tasks.length);
    expect(
      new Set(first.id_mappings.map((mapping) => `${mapping.v2_entity_type}:${mapping.v2_id}`))
        .size,
    ).toBe(first.id_mappings.length);
    expect(first.strategy?.created_at).toBe(FROZEN_AT);
    expect(first.phase?.created_at).toBe(FROZEN_AT);
  });
});
