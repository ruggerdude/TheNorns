export interface AuthStartupPolicyInput {
  isProduction: boolean;
  persistenceConfigured: boolean;
  persistenceReady: boolean;
  hasActiveAdmin: boolean;
  hasDeployToken: boolean;
}

export type AuthStartupBlockCode =
  | "persistence_required"
  | "persistence_unavailable"
  | "bootstrap_key_required";

export type AuthStartupDecision =
  | { allowed: true; bootstrapRequired: boolean }
  | { allowed: false; code: AuthStartupBlockCode; message: string };

/**
 * Production auth must never fall back to an empty in-memory user store. That
 * would make an existing admin appear to vanish and expose first-admin setup
 * again after a restart. Development remains permissive for its local seed.
 */
export function evaluateAuthStartup(input: AuthStartupPolicyInput): AuthStartupDecision {
  if (!input.isProduction) return { allowed: true, bootstrapRequired: false };

  if (!input.persistenceConfigured) {
    return {
      allowed: false,
      code: "persistence_required",
      message: "DATABASE_URL is required in production so user accounts survive restarts.",
    };
  }

  if (!input.persistenceReady) {
    return {
      allowed: false,
      code: "persistence_unavailable",
      message: "User-account persistence could not be loaded; refusing to start in memory.",
    };
  }

  if (input.hasActiveAdmin) return { allowed: true, bootstrapRequired: false };

  if (!input.hasDeployToken) {
    return {
      allowed: false,
      code: "bootstrap_key_required",
      message: "NORNS_TOKEN is required once to create the first active admin.",
    };
  }

  return { allowed: true, bootstrapRequired: true };
}
