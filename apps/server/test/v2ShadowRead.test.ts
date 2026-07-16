import { describe, expect, it } from "vitest";
import {
  buildShadowReadComparison,
  redactedJsonPointerDifferences,
  shadowComparisonsAllowCutover,
} from "../src/persistence/migration/shadowRead.js";

const observedAt = "2026-07-16T21:30:00.000Z";

describe("Phase 2 shadow-read evidence", () => {
  it("treats object-key ordering as equal", () => {
    const comparison = buildShadowReadComparison({
      migration_run_id: "migration-phase2",
      scope_type: "project",
      scope_key: "project-1",
      operation: "summary",
      legacy: { name: "Norns", nested: { status: "planned", count: 2 } },
      relational: { nested: { count: 2, status: "planned" }, name: "Norns" },
      observed_at: observedAt,
    });

    expect(comparison.matched).toBe(true);
    expect(comparison.differences).toEqual([]);
  });

  it("stores redacted JSON-pointer paths rather than protected values", () => {
    const legacy = {
      source: { location: "/Users/operator/private/repo" },
      session: { token: "legacy-secret-token" },
      nodes: [{ id: "a", state: "pending" }],
    };
    const relational = {
      source: { location: "opaque:repository-1" },
      session: { token: "redacted" },
      nodes: [{ id: "a", state: "blocked" }],
    };

    const differences = redactedJsonPointerDifferences(legacy, relational);
    expect(differences).toEqual(["/nodes/0/state", "/session/token", "/source/location"]);
    const serialized = JSON.stringify(differences);
    expect(serialized).not.toContain("private/repo");
    expect(serialized).not.toContain("legacy-secret-token");
  });

  it("requires at least one all-green comparison before cutover", () => {
    const matched = buildShadowReadComparison({
      migration_run_id: "migration-phase2",
      scope_type: "identity",
      scope_key: "*",
      operation: "admin-continuity",
      legacy: { active_admin_ids: ["user-1"] },
      relational: { active_admin_ids: ["user-1"] },
      observed_at: observedAt,
    });
    const mismatch = buildShadowReadComparison({
      migration_run_id: "migration-phase2",
      scope_type: "identity",
      scope_key: "*",
      operation: "session-count",
      legacy: { count: 2 },
      relational: { count: 0 },
      observed_at: observedAt,
    });

    expect(shadowComparisonsAllowCutover([])).toBe(false);
    expect(shadowComparisonsAllowCutover([matched])).toBe(true);
    expect(shadowComparisonsAllowCutover([matched, mismatch])).toBe(false);
  });
});
