import type { V2ShadowReadComparisonT } from "@norns/contracts";
import { buildShadowReadComparison } from "./shadowRead.js";

export const PHASE2_PROJECT_CUTOVER_OPERATIONS = {
  summary: "summary",
  pmSelection: "pmSelectionOf",
  graph: "graph",
} as const;

export const PHASE2_NEW_PROJECTS_CUTOVER_OPERATIONS = {
  list: "list",
} as const;

export const PHASE2_IDENTITY_CUTOVER_OPERATIONS = {
  publicUserProjection: "public-user-projection-match",
  retainedLegacyCredentialRejection: "retained-legacy-session-invite-rejection",
  normalizedSessionRestart: "normalized-session-restart",
  expiredRevokedRejection: "expired-revoked-rejection",
} as const;

export const PHASE2_REQUIRED_IDENTITY_CUTOVER_OPERATIONS = Object.freeze(
  Object.values(PHASE2_IDENTITY_CUTOVER_OPERATIONS),
);

type Awaitable<T> = T | Promise<T>;

export interface IdentityCutoverComparisonSink {
  recordShadowComparison(comparison: V2ShadowReadComparisonT): Awaitable<void>;
}

export interface IdentityCutoverObservation {
  observed_at: string;
}

export interface PublicUserProjectionObservation extends IdentityCutoverObservation {
  legacy: unknown;
  relational: unknown;
}

export interface IdentitySecurityProofObservation extends IdentityCutoverObservation {
  satisfied: boolean;
}

/**
 * Records the four named identity cutover proofs without exposing stringly
 * typed operation names to callers. Evidence stores only canonical hashes and
 * redacted difference paths through buildShadowReadComparison.
 */
export class Phase2IdentityCutoverEvidenceRecorder {
  constructor(
    private readonly migrationRunId: string,
    private readonly sink: IdentityCutoverComparisonSink,
  ) {}

  recordPublicUserProjection(
    observation: PublicUserProjectionObservation,
  ): Promise<V2ShadowReadComparisonT> {
    return this.record(
      PHASE2_IDENTITY_CUTOVER_OPERATIONS.publicUserProjection,
      observation.legacy,
      observation.relational,
      observation.observed_at,
    );
  }

  recordRetainedLegacyCredentialRejection(
    observation: IdentitySecurityProofObservation,
  ): Promise<V2ShadowReadComparisonT> {
    return this.recordSecurityProof(
      PHASE2_IDENTITY_CUTOVER_OPERATIONS.retainedLegacyCredentialRejection,
      observation,
    );
  }

  recordNormalizedSessionRestart(
    observation: IdentitySecurityProofObservation,
  ): Promise<V2ShadowReadComparisonT> {
    return this.recordSecurityProof(
      PHASE2_IDENTITY_CUTOVER_OPERATIONS.normalizedSessionRestart,
      observation,
    );
  }

  recordExpiredRevokedRejection(
    observation: IdentitySecurityProofObservation,
  ): Promise<V2ShadowReadComparisonT> {
    return this.recordSecurityProof(
      PHASE2_IDENTITY_CUTOVER_OPERATIONS.expiredRevokedRejection,
      observation,
    );
  }

  private recordSecurityProof(
    operation: (typeof PHASE2_IDENTITY_CUTOVER_OPERATIONS)[keyof typeof PHASE2_IDENTITY_CUTOVER_OPERATIONS],
    observation: IdentitySecurityProofObservation,
  ): Promise<V2ShadowReadComparisonT> {
    return this.record(
      operation,
      { satisfied: true },
      { satisfied: observation.satisfied },
      observation.observed_at,
    );
  }

  private async record(
    operation: string,
    legacy: unknown,
    relational: unknown,
    observedAt: string,
  ): Promise<V2ShadowReadComparisonT> {
    const comparison = buildShadowReadComparison({
      migration_run_id: this.migrationRunId,
      scope_type: "identity",
      scope_key: "*",
      operation,
      legacy,
      relational,
      observed_at: observedAt,
    });
    await this.sink.recordShadowComparison(comparison);
    return comparison;
  }
}
