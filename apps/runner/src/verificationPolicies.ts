export const DEFAULT_VERIFICATION_POLICY_REF = "verification-policy:default-v1";

const DEFAULT_VERIFICATION_POLICY: readonly [string, ...string[]] = [
  "git",
  "diff-tree",
  "--check",
  "--root",
  "HEAD",
];

export function runnerVerificationPolicies(
  raw: string | undefined,
): ReadonlyMap<string, readonly [string, ...string[]]> {
  const parsed =
    raw === undefined
      ? { [DEFAULT_VERIFICATION_POLICY_REF]: DEFAULT_VERIFICATION_POLICY }
      : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("NORNS_VERIFICATION_POLICIES_JSON must be a JSON object");
  }
  const policies = new Map<string, readonly [string, ...string[]]>();
  for (const [policy, command] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((part) => typeof part === "string")
    ) {
      throw new Error(`verification policy ${policy} must be a non-empty string array`);
    }
    policies.set(policy, command as [string, ...string[]]);
  }
  return policies;
}
