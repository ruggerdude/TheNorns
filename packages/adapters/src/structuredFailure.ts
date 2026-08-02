import type { z } from "zod";
import {
  AdapterError,
  type AdapterFailureMetadata,
  type StructuredFailureDiagnostic,
  type StructuredFailureIssue,
} from "./types.js";

const MAX_DIAGNOSTIC_ISSUES = 12;
const MAX_DIAGNOSTIC_FIELD_LENGTH = 240;
const TRUNCATION_REASONS = new Set(["length", "max_output_tokens", "max_tokens"]);

function bounded(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH - 1)}…`;
}

export function outputWasTruncated(finishReason: string | undefined): boolean {
  return finishReason !== undefined && TRUNCATION_REASONS.has(finishReason);
}

function schemaIssues(issues: readonly z.ZodIssue[]): StructuredFailureIssue[] {
  return issues.slice(0, MAX_DIAGNOSTIC_ISSUES).map((issue) => ({
    path: bounded(issue.path.length === 0 ? "$" : issue.path.map(String).join(".")),
    code: bounded(issue.code),
    message: bounded(issue.message),
  }));
}

export function notJsonDiagnostic(finishReason: string | undefined): StructuredFailureDiagnostic {
  const truncated = outputWasTruncated(finishReason);
  return {
    kind: truncated ? "output_truncated" : "not_json",
    issues: [
      {
        path: "$",
        code: truncated ? "output_truncated" : "invalid_json",
        message: truncated
          ? "The provider stopped because the configured output limit was reached."
          : "The response was not valid JSON.",
      },
    ],
  };
}

export function schemaDiagnostic(
  issues: readonly z.ZodIssue[],
  finishReason: string | undefined,
): StructuredFailureDiagnostic {
  if (outputWasTruncated(finishReason)) {
    return {
      kind: "output_truncated",
      issues: [
        {
          path: "$",
          code: "output_truncated",
          message: "The provider stopped because the configured output limit was reached.",
        },
        ...schemaIssues(issues).slice(0, MAX_DIAGNOSTIC_ISSUES - 1),
      ],
    };
  }
  return { kind: "schema_validation", issues: schemaIssues(issues) };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/**
 * The single structured-output parse + contract validation. Both the buffered
 * (`completeStructured`) and streamed (`streamStructured`) provider paths call
 * this, so the failure classification (not_json / schema_validation /
 * output_truncated) is produced in exactly one place for both providers.
 */
export function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
  schemaName: string,
  metadata: AdapterFailureMetadata,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (cause) {
    // A body cut short by the output limit is not a formatting problem, and
    // retrying the identical prompt just burns the same budget again — say so
    // in the message, not only in `structured_failure.kind`.
    const message = outputWasTruncated(metadata.finish_reason)
      ? `${schemaName}: response was truncated at the output limit`
      : `${schemaName}: response is not JSON`;
    throw new AdapterError("invalid_response", message, {
      cause,
      metadata: {
        ...metadata,
        response_text: text,
        structured_failure: notJsonDiagnostic(metadata.finish_reason),
      },
    });
  }
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  throw new AdapterError(
    "invalid_response",
    `${schemaName}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    {
      metadata: {
        ...metadata,
        response_text: text,
        structured_failure: schemaDiagnostic(result.error.issues, metadata.finish_reason),
      },
    },
  );
}
