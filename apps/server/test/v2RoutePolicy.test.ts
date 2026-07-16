import type { V2PersistenceRouteT } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  type Phase2RoutePolicyError,
  assertPhase2RouteTransition,
} from "../src/persistence/migration/routePolicy.js";

const baseRoute = (
  scope_type: V2PersistenceRouteT["scope_type"],
  scope_key: string,
): V2PersistenceRouteT => ({
  schema_version: 2,
  scope_type,
  scope_key,
  read_mode: "legacy",
  write_mode: "legacy",
  migration_run_id: "migration-phase2",
  aggregate_version: 1,
  changed_by: { actor_type: "system", actor_id: null },
  changed_at: "2026-07-16T21:00:00.000Z",
  v2_writes_started_at: null,
  rollback_window_until: "2026-08-16T21:00:00.000Z",
});

describe("Phase 2 persistence-route policy", () => {
  it("allows green project read cutover but never project relational writes", () => {
    const current = baseRoute("project", "project-1");
    expect(() =>
      assertPhase2RouteTransition({
        current,
        next: {
          ...current,
          read_mode: "relational",
          aggregate_version: 2,
          changed_at: "2026-07-16T21:10:00.000Z",
        },
        green_shadow_evidence: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertPhase2RouteTransition({
        current,
        next: {
          ...current,
          write_mode: "relational",
          aggregate_version: 2,
          changed_at: "2026-07-16T21:10:00.000Z",
          v2_writes_started_at: "2026-07-16T21:10:00.000Z",
        },
        green_shadow_evidence: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<Phase2RoutePolicyError>>({
        code: "project_writes_phase3",
      }),
    );
  });

  it("requires green shadow evidence for relational reads", () => {
    const current = baseRoute("project", "project-1");
    expect(() =>
      assertPhase2RouteTransition({
        current,
        next: {
          ...current,
          read_mode: "relational",
          aggregate_version: 2,
          changed_at: "2026-07-16T21:10:00.000Z",
        },
        green_shadow_evidence: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<Phase2RoutePolicyError>>({
        code: "shadow_evidence_required",
      }),
    );
  });

  it("makes credential cutover forward-only while permitting a write freeze", () => {
    const current: V2PersistenceRouteT = {
      ...baseRoute("identity", "*"),
      read_mode: "relational",
      write_mode: "relational",
      v2_writes_started_at: "2026-07-16T21:05:00.000Z",
    };

    expect(() =>
      assertPhase2RouteTransition({
        current,
        next: {
          ...current,
          write_mode: "frozen",
          aggregate_version: 2,
          changed_at: "2026-07-16T21:10:00.000Z",
        },
        green_shadow_evidence: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertPhase2RouteTransition({
        current,
        next: {
          ...current,
          read_mode: "legacy",
          write_mode: "legacy",
          aggregate_version: 2,
          changed_at: "2026-07-16T21:10:00.000Z",
        },
        green_shadow_evidence: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<Phase2RoutePolicyError>>({
        code: "identity_cutover_forward_only",
      }),
    );
  });

  it("keeps relay entirely legacy in Phase 2", () => {
    const current = baseRoute("relay", "*");
    expect(() =>
      assertPhase2RouteTransition({
        current,
        next: {
          ...current,
          read_mode: "shadow",
          aggregate_version: 2,
          changed_at: "2026-07-16T21:10:00.000Z",
        },
        green_shadow_evidence: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<Phase2RoutePolicyError>>({
        code: "relay_cutover_phase4",
      }),
    );
  });
});
