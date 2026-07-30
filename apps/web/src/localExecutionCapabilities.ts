import { UnauthorizedError, authHeaders } from "./auth";

export interface LocalExecutionCapabilities {
  enrollment_available: boolean;
  computers_available: boolean;
  repository_grants_available: boolean;
  legacy_claim_available: boolean;
  legacy_local_creation_available: boolean;
}

export const DISABLED_LOCAL_EXECUTION_CAPABILITIES: LocalExecutionCapabilities = {
  enrollment_available: false,
  computers_available: false,
  repository_grants_available: false,
  legacy_claim_available: false,
  legacy_local_creation_available: false,
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCapabilities(value: unknown): LocalExecutionCapabilities | null {
  const candidate = record(value);
  const keys = [
    "schema_version",
    "enrollment_available",
    "computers_available",
    "repository_grants_available",
    "legacy_claim_available",
    "legacy_local_creation_available",
  ] as const;
  if (
    !candidate ||
    candidate.schema_version !== 1 ||
    Object.keys(candidate).some((key) => !keys.includes(key as (typeof keys)[number])) ||
    keys
      .filter((key) => key !== "schema_version")
      .some((key) => typeof candidate[key] !== "boolean")
  ) {
    return null;
  }
  return {
    enrollment_available: candidate.enrollment_available as boolean,
    computers_available: candidate.computers_available as boolean,
    repository_grants_available: candidate.repository_grants_available as boolean,
    legacy_claim_available: candidate.legacy_claim_available as boolean,
    legacy_local_creation_available: candidate.legacy_local_creation_available as boolean,
  };
}

/**
 * Local creation and claim UI are fail-closed rollout surfaces. Older servers,
 * unavailable capability routes, and widened/invalid payloads all produce the
 * disabled projection without affecting GitHub-only work.
 */
export async function loadLocalExecutionCapabilities(): Promise<LocalExecutionCapabilities> {
  try {
    const response = await fetch("/api/v2/capabilities/local-execution", {
      credentials: "include",
      headers: authHeaders(false),
    });
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok) return DISABLED_LOCAL_EXECUTION_CAPABILITIES;
    const parsed = parseCapabilities(await response.json().catch(() => null));
    return parsed ?? DISABLED_LOCAL_EXECUTION_CAPABILITIES;
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    return DISABLED_LOCAL_EXECUTION_CAPABILITIES;
  }
}
