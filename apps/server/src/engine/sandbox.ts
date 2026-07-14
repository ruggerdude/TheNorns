// Execution sandbox launcher (ADR-003): disposable OCI containers, fail
// CLOSED — if the sandbox substrate is unavailable, the run does not start,
// ever. Only the worktree and scratch are writable; network is deny-by-
// default; no container-management access inside; the runner brokers
// credentials and performs git push/fetch from outside.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`sandbox unavailable — failing closed, run will not start: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

export interface SandboxSpec {
  worktreePath: string;
  scratchPath: string;
  image: string;
  env: Record<string, string>; // explicit allowlist; nothing inherited
  readOnlyMounts?: Record<string, string>; // hostPath -> containerPath
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutSec?: number;
  command: string[];
}

/** Deterministic docker-run argument construction (unit-testable contract). */
export function buildDockerArgs(spec: SandboxSpec): string[] {
  const args = [
    "run",
    "--rm",
    "--network",
    "none", // deny by default; provider egress arrives via proxy in Phase 5
    "--pids-limit",
    String(spec.pidsLimit ?? 256),
    "--memory",
    spec.memory ?? "2g",
    "--cpus",
    spec.cpus ?? "1",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--mount",
    `type=bind,source=${spec.worktreePath},target=/worktree`,
    "--mount",
    `type=bind,source=${spec.scratchPath},target=/scratch`,
    "--workdir",
    "/worktree",
  ];
  for (const [host, container] of Object.entries(spec.readOnlyMounts ?? {})) {
    args.push("--mount", `type=bind,source=${host},target=${container},readonly`);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

export interface SandboxProbe {
  available(): Promise<{ ok: boolean; detail: string }>;
}

export class DockerProbe implements SandboxProbe {
  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
      return { ok: true, detail: "docker available" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "docker probe failed" };
    }
  }
}

export class SandboxLauncher {
  constructor(private readonly probe: SandboxProbe) {}

  /**
   * Fail-closed launch: probes the substrate first; if it is not available,
   * throws SandboxUnavailableError — there is no unsandboxed fallback path.
   */
  async launch(spec: SandboxSpec): Promise<{ args: string[]; stdout: string }> {
    const probe = await this.probe.available();
    if (!probe.ok) throw new SandboxUnavailableError(probe.detail);
    const args = buildDockerArgs(spec);
    const { stdout } = await run("docker", args, {
      timeout: (spec.timeoutSec ?? 300) * 1000,
    });
    return { args, stdout };
  }
}
