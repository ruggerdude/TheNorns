import { createHash } from "node:crypto";

type CanonicalPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonical JSON does not support non-finite numbers");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonical JSON does not support ${typeof value} values`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON does not support cyclic values");
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError("canonical JSON does not support sparse arrays");
        }
        entries.push(canonicalize(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON supports only plain objects");
    }

    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      throw new TypeError("canonical JSON does not support symbol keys");
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Produces deterministic JSON for values that are valid PostgreSQL JSONB
 * payloads. Object keys are sorted; array order remains meaningful.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
