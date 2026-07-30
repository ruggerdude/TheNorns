import type { RunnerContextIdentity } from "./contextAuth.js";

export interface PersistentExecutionIdentitySelection {
  runner_id: string;
  generation: number;
  http_identity: RunnerContextIdentity;
}

/**
 * Keeps the staged local compatibility path internally consistent.
 *
 * Merely possessing an active device credential never changes a legacy
 * command's HTTP identity. Device identity is selected only when the separate
 * device-execution gate moves both WSS commands and HTTP authorization to the
 * device subject together.
 */
export function selectPersistentExecutionIdentity(input: {
  device_execution_enabled: boolean;
  device: PersistentExecutionIdentitySelection | null;
  legacy: PersistentExecutionIdentitySelection;
}): PersistentExecutionIdentitySelection {
  if (!input.device_execution_enabled) return input.legacy;
  if (!input.device) {
    throw new Error("device execution requires an active device identity");
  }
  return input.device;
}
