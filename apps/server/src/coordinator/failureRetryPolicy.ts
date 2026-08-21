export type FailureRetryClass = "transient" | "repairable" | "configuration" | "terminal";

export interface FailureRetryPolicy {
  retryClass: FailureRetryClass;
  automaticRetryAllowed: boolean;
  recommendation: "retry" | "cancel";
  explanation: string;
}

const CONFIGURATION_FAILURES = new Set([
  "runner_permission_denied",
  "runner_preflight_failed",
  "runner_worktree_prepare_failed",
  "runner_scratch_prepare_failed",
  "runner_context_scope_denied",
  "runner_context_hash_mismatch",
]);

const TRANSIENT_FAILURES = new Set([
  "runner_context_load_failed",
  "runner_runtime_failed",
  "runner_publication_failed",
  "human_wait_checkpoint_unpublished",
]);

/**
 * One retry policy for recovery surfaces. Configuration failures never loop;
 * transient failures get one replacement attempt; implementation/verification
 * failures remain human-directed and stop being recommended after one retry.
 */
export function classifyFailureRetry(
  failureCode: string | null,
  failureDetail: string | null,
  attempt: number,
): FailureRetryPolicy {
  const code = failureCode?.trim() ?? "";
  const detail = failureDetail?.trim() ?? "";
  if (CONFIGURATION_FAILURES.has(code) || /permission denied|not a git repository/i.test(detail)) {
    return {
      retryClass: "configuration",
      automaticRetryAllowed: false,
      recommendation: "cancel",
      explanation: "Fix the runner, worktree, or permission cause before starting another attempt.",
    };
  }
  if (TRANSIENT_FAILURES.has(code)) {
    const allowed = attempt < 2;
    return {
      retryClass: "transient",
      automaticRetryAllowed: allowed,
      recommendation: allowed ? "retry" : "cancel",
      explanation: allowed
        ? "This transport/runtime failure may clear on one bounded retry."
        : "The transient retry allowance is exhausted; investigate before retrying again.",
    };
  }
  if (code === "runner_verification_failed" || code === "runner_runtime_unsuccessful") {
    return {
      retryClass: "repairable",
      automaticRetryAllowed: false,
      recommendation: attempt < 2 ? "retry" : "cancel",
      explanation:
        attempt < 2
          ? "A single human-authorized continuation may repair the implementation."
          : "Repeated implementation attempts are not converging; inspect the failure before continuing.",
    };
  }
  return {
    retryClass: "terminal",
    automaticRetryAllowed: false,
    recommendation: "cancel",
    explanation: "The failure is not classified as safely retriable.",
  };
}
