import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { type RuntimeCredentialMode, credentialFreeEnvironment } from "./modelGateway.js";

export type LocalSubscriptionAuthMode = "chatgpt" | "claude.ai";

/**
 * Deliberately small, non-secret runtime metadata suitable for local status
 * and capability reports. Raw command output, identities, org IDs, and tokens
 * never leave this module.
 */
export interface LocalRuntimeAuthCapability {
  runtime: "codex" | "claude-code";
  installed: boolean;
  supported_credential_modes: readonly RuntimeCredentialMode[];
  subscription_authenticated: boolean;
  subscription_auth_mode: LocalSubscriptionAuthMode | null;
  subscription_type: "pro" | "max" | "team" | "enterprise" | null;
}

interface AuthProbeCommandOptions {
  encoding: "utf8";
  timeout: number;
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
  env: Record<string, string>;
}

type AuthProbeCommand = (
  command: string,
  args: readonly string[],
  options: AuthProbeCommandOptions,
) => Pick<SpawnSyncReturns<string>, "error" | "status" | "stderr" | "stdout">;

const runAuthProbe: AuthProbeCommand = (command, args, options) =>
  spawnSync(command, [...args], options);

const SUPPORTED_CREDENTIAL_MODES = ["api", "subscription"] as const;
const CLAUDE_SUBSCRIPTION_TYPES = new Set(["pro", "max", "team", "enterprise"] as const);

function installed(result: ReturnType<AuthProbeCommand>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}

function commandOptions(baseEnv: NodeJS.ProcessEnv): AuthProbeCommandOptions {
  return {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // A provider key in the parent shell must not change what auth source the
    // probe reports. We are checking persisted subscription login only.
    env: credentialFreeEnvironment(baseEnv),
  };
}

export function probeCodexSubscriptionAuth(
  baseEnv: NodeJS.ProcessEnv = process.env,
  run: AuthProbeCommand = runAuthProbe,
): LocalRuntimeAuthCapability {
  const result = run("codex", ["login", "status"], commandOptions(baseEnv));
  const statusLines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const subscriptionAuthenticated =
    result.status === 0 && statusLines.length === 1 && statusLines[0] === "Logged in using ChatGPT";
  return {
    runtime: "codex",
    installed: installed(result),
    supported_credential_modes: SUPPORTED_CREDENTIAL_MODES,
    subscription_authenticated: subscriptionAuthenticated,
    subscription_auth_mode: subscriptionAuthenticated ? "chatgpt" : null,
    subscription_type: null,
  };
}

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function probeClaudeSubscriptionAuth(
  baseEnv: NodeJS.ProcessEnv = process.env,
  run: AuthProbeCommand = runAuthProbe,
): LocalRuntimeAuthCapability {
  const result = run("claude", ["auth", "status", "--json"], commandOptions(baseEnv));
  const status = result.status === 0 ? jsonObject(result.stdout) : null;
  const subscriptionType =
    typeof status?.subscriptionType === "string" &&
    CLAUDE_SUBSCRIPTION_TYPES.has(
      status.subscriptionType.toLowerCase() as "pro" | "max" | "team" | "enterprise",
    )
      ? (status.subscriptionType.toLowerCase() as "pro" | "max" | "team" | "enterprise")
      : null;
  const subscriptionAuthenticated =
    status?.loggedIn === true && status.authMethod === "claude.ai" && subscriptionType !== null;
  return {
    runtime: "claude-code",
    installed: installed(result),
    supported_credential_modes: SUPPORTED_CREDENTIAL_MODES,
    subscription_authenticated: subscriptionAuthenticated,
    subscription_auth_mode: subscriptionAuthenticated ? "claude.ai" : null,
    subscription_type: subscriptionAuthenticated ? subscriptionType : null,
  };
}

export function probeLocalRuntimeAuthCapabilities(
  baseEnv: NodeJS.ProcessEnv = process.env,
  run: AuthProbeCommand = runAuthProbe,
): readonly LocalRuntimeAuthCapability[] {
  return [probeCodexSubscriptionAuth(baseEnv, run), probeClaudeSubscriptionAuth(baseEnv, run)];
}
