import {
  type V2PersistenceScopeTypeT,
  V2ShadowReadComparison,
  type V2ShadowReadComparisonT,
} from "@norns/contracts";
import { canonicalJson, canonicalSha256 } from "./canonicalJson.js";

const MAX_RECORDED_DIFFERENCES = 100;

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function equalCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return Object.is(left, right);
  }
}

/**
 * Returns paths only. Values never enter shadow evidence because legacy DTOs
 * can contain credentials, source paths, prompts, or other protected data.
 */
export function redactedJsonPointerDifferences(legacy: unknown, relational: unknown): string[] {
  const differences: string[] = [];

  const walk = (left: unknown, right: unknown, path: string): void => {
    if (differences.length >= MAX_RECORDED_DIFFERENCES || equalCanonical(left, right)) {
      return;
    }

    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) {
        differences.push(`${path || "/"}/length`.replace("//", "/"));
      }
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        walk(left[index], right[index], `${path}/${index}`);
      }
      return;
    }

    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        walk(left[key], right[key], `${path}/${pointerSegment(key)}`);
      }
      return;
    }

    differences.push(path || "/");
  };

  walk(legacy, relational, "");
  return [...new Set(differences)].slice(0, MAX_RECORDED_DIFFERENCES);
}

export interface BuildShadowReadComparisonInput {
  migration_run_id: string;
  scope_type: V2PersistenceScopeTypeT;
  scope_key: string;
  operation: string;
  legacy: unknown;
  relational: unknown;
  observed_at: string;
}

export function buildShadowReadComparison(
  input: BuildShadowReadComparisonInput,
): V2ShadowReadComparisonT {
  const legacyHash = canonicalSha256(input.legacy);
  const relationalHash = canonicalSha256(input.relational);
  const differences =
    legacyHash === relationalHash
      ? []
      : redactedJsonPointerDifferences(input.legacy, input.relational);
  const identity = {
    migration_run_id: input.migration_run_id,
    scope_type: input.scope_type,
    scope_key: input.scope_key,
    operation: input.operation,
    legacy_hash: legacyHash,
    relational_hash: relationalHash,
    observed_at: input.observed_at,
  };

  return V2ShadowReadComparison.parse({
    schema_version: 2,
    id: `shadow:${canonicalSha256(identity)}`,
    migration_run_id: input.migration_run_id,
    scope_type: input.scope_type,
    scope_key: input.scope_key,
    operation: input.operation,
    legacy_hash: legacyHash,
    relational_hash: relationalHash,
    matched: legacyHash === relationalHash,
    differences,
    observed_at: input.observed_at,
  });
}

export function shadowComparisonsAllowCutover(
  comparisons: readonly V2ShadowReadComparisonT[],
): boolean {
  return comparisons.length > 0 && comparisons.every((comparison) => comparison.matched);
}
