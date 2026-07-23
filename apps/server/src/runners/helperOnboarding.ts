/** Relay-side status and installer commands for the native local-folder helper. */
export interface HelperRunnerSnapshot {
  runner_id: string;
  generation: number;
  connected: boolean;
  workspace_picker_ready: boolean;
  last_seen_at: string | null;
}

export type HelperConnectionState = "connected" | "degraded" | "disconnected" | "not_installed";

export function helperStatus(runners: readonly HelperRunnerSnapshot[]) {
  const ready = runners.find((runner) => runner.connected && runner.workspace_picker_ready);
  if (ready) {
    return {
      state: "connected" as const,
      runner_id: ready.runner_id,
      runners,
      message: "The Norns helper is ready to choose a folder on this computer.",
    };
  }
  const outdated = runners.find((runner) => runner.connected);
  if (outdated) {
    return {
      state: "degraded" as const,
      runner_id: outdated.runner_id,
      runners,
      message: "The local helper needs an update before it can choose folders.",
    };
  }
  if (runners.length > 0) {
    return {
      state: "disconnected" as const,
      runner_id: runners[0]?.runner_id ?? null,
      runners,
      message: "The local helper is installed but is not currently reachable.",
    };
  }
  return {
    state: "not_installed" as const,
    runner_id: null,
    runners,
    message: "Set up the local helper once, then choose folders with the system picker.",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SAFE_RUNNER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_PAIRING_CODE = /^[a-z0-9]{1,64}$/;

function validated(input: { origin: string; code?: string; runnerId?: string }) {
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol)) {
    throw new Error("install command origin must use http or https");
  }
  const runnerId = input.runnerId ?? "runner-1";
  if (!SAFE_RUNNER_ID.test(runnerId)) throw new Error("unsafe runner id");
  if (input.code !== undefined && !SAFE_PAIRING_CODE.test(input.code)) {
    throw new Error("unsafe pairing code");
  }
  return { origin: origin.origin, runnerId };
}

export function installCommand(input: {
  origin: string;
  code?: string;
  runnerId?: string;
}): string {
  const { origin, runnerId } = validated(input);
  const args = [
    "--server",
    shellQuote(origin),
    ...(input.code ? ["--pair", shellQuote(input.code)] : []),
    ...(runnerId === "runner-1" ? [] : ["--id", shellQuote(runnerId)]),
  ];
  return `curl -fsSL ${shellQuote(`${origin}/install/runner.sh`)} | sh -s -- ${args.join(" ")}`;
}

export function installCommandWindows(input: {
  origin: string;
  code?: string;
  runnerId?: string;
}): string {
  const { origin, runnerId } = validated(input);
  const args = [
    `-Server '${origin}'`,
    ...(input.code ? [`-Pair '${input.code}'`] : []),
    ...(runnerId === "runner-1" ? [] : [`-Id '${runnerId}'`]),
  ];
  return `irm '${origin}/install/runner.ps1' | iex; Install-NornsHelper ${args.join(" ")}`;
}
