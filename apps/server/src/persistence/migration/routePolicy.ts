import type { V2PersistenceRouteT } from "@norns/contracts";

export class Phase2RoutePolicyError extends Error {
  constructor(
    readonly code:
      | "scope_changed"
      | "version_conflict"
      | "shadow_evidence_required"
      | "project_writes_phase3"
      | "relay_cutover_phase4"
      | "identity_cutover_forward_only"
      | "identity_route_incoherent",
    message: string,
  ) {
    super(message);
    this.name = "Phase2RoutePolicyError";
  }
}

export interface Phase2RouteTransitionInput {
  current: V2PersistenceRouteT | null;
  next: V2PersistenceRouteT;
  green_shadow_evidence: boolean;
}

/**
 * Phase 2 can cut identity forward and canary project reads. It cannot activate
 * project mutation or relay execution paths assigned to later phases.
 */
export function assertPhase2RouteTransition(input: Phase2RouteTransitionInput): void {
  const { current, next } = input;
  if (
    current !== null &&
    (current.scope_type !== next.scope_type || current.scope_key !== next.scope_key)
  ) {
    throw new Phase2RoutePolicyError("scope_changed", "a route transition cannot change scope");
  }
  const expectedVersion = current === null ? 1 : current.aggregate_version + 1;
  if (next.aggregate_version !== expectedVersion) {
    throw new Phase2RoutePolicyError(
      "version_conflict",
      `route version must advance to ${expectedVersion}`,
    );
  }

  if (next.scope_type === "relay") {
    if (next.read_mode !== "legacy" || next.write_mode !== "legacy") {
      throw new Phase2RoutePolicyError(
        "relay_cutover_phase4",
        "relay read/write cutover is assigned to Phase 4",
      );
    }
    return;
  }

  if (
    (next.scope_type === "project" || next.scope_type === "new_projects") &&
    next.write_mode === "relational"
  ) {
    throw new Phase2RoutePolicyError(
      "project_writes_phase3",
      "relational project writes are assigned to Phase 3",
    );
  }

  if (next.read_mode === "relational" && !input.green_shadow_evidence) {
    throw new Phase2RoutePolicyError(
      "shadow_evidence_required",
      "relational reads require a complete green shadow comparison",
    );
  }

  if (next.scope_type === "identity") {
    if (next.write_mode === "relational" && next.read_mode !== "relational") {
      throw new Phase2RoutePolicyError(
        "identity_route_incoherent",
        "relational identity writes require relational identity reads",
      );
    }
    if (
      current?.write_mode === "relational" &&
      (next.write_mode === "legacy" || next.read_mode === "legacy")
    ) {
      throw new Phase2RoutePolicyError(
        "identity_cutover_forward_only",
        "credential cutover cannot reactivate the legacy identity snapshot",
      );
    }
  }
}
