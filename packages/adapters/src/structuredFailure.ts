import type { z } from "zod";
import type { StructuredFailureDiagnostic, StructuredFailureIssue } from "./types.js";

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
