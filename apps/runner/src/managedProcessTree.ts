import { type ChildProcess, spawn } from "node:child_process";

export type ManagedProcessContainmentKind = "unix_process_group" | "windows_best_effort";

export interface ManagedProcessTreeProof {
  containment: ManagedProcessContainmentKind;
  process_tree_reaped: boolean;
}

export interface ManagedProcessTreeOptions {
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  proofTimeoutMs?: number;
  spawnTaskkill?: typeof spawn;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unixProcessGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the group exists but is not signalable. Treat every unknown
    // error as existing: inability to prove absence must never become proof.
    return true;
  }
}

/**
 * OS containment for one Norns-owned subprocess tree.
 *
 * Unix children are launched as process-group leaders by the caller. The
 * controller kills the whole group and verifies the group no longer exists
 * before returning proof. The current Windows baseline uses `taskkill /T` only
 * as a best-effort stop; without a native Job Object and active-process-count
 * query it deliberately cannot produce process-tree-reaped evidence.
 */
export class ManagedProcessTree {
  readonly containment: ManagedProcessContainmentKind;
  readonly verifiedReapingSupported: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly pollIntervalMs: number;
  private readonly proofTimeoutMs: number;
  private readonly spawnTaskkill: typeof spawn;
  private stopRequested = false;
  private taskkillSettled: Promise<void> | null = null;

  constructor(
    private readonly child: ChildProcess,
    options: ManagedProcessTreeOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.pollIntervalMs = options.pollIntervalMs ?? 20;
    this.proofTimeoutMs = options.proofTimeoutMs ?? 5_000;
    this.spawnTaskkill = options.spawnTaskkill ?? spawn;
    this.containment = this.platform === "win32" ? "windows_best_effort" : "unix_process_group";
    this.verifiedReapingSupported = this.platform !== "win32";
  }

  requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    const processId = this.child.pid;
    if (processId === undefined) return;
    if (this.platform !== "win32") {
      try {
        process.kill(-processId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          // A direct-child fallback may stop the shell, but confirmReaped()
          // still refuses proof while the process group can be observed.
          this.child.kill("SIGKILL");
        }
      }
      return;
    }

    let taskkill: ChildProcess;
    try {
      taskkill = this.spawnTaskkill("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      this.child.kill("SIGKILL");
      this.taskkillSettled = Promise.resolve();
      return;
    }
    this.taskkillSettled = new Promise<void>((resolve) => {
      taskkill.once("close", () => resolve());
      taskkill.once("error", () => {
        this.child.kill("SIGKILL");
        resolve();
      });
    });
  }

  async confirmReaped(): Promise<ManagedProcessTreeProof> {
    const processId = this.child.pid;
    if (processId === undefined) {
      return {
        containment: this.containment,
        // A spawn failure created no process and therefore no descendants.
        process_tree_reaped: true,
      };
    }
    if (this.platform === "win32") {
      await this.taskkillSettled;
      return {
        containment: this.containment,
        // `taskkill /T` has no durable containment handle or authoritative
        // descendant-count query. Child close is not enough to claim its
        // descendants exited.
        process_tree_reaped: false,
      };
    }

    // A shell can exit while a background descendant remains in its process
    // group. Stop that group even on an otherwise normal shell exit so no
    // Norns-managed process escapes the run's lifetime.
    if (unixProcessGroupExists(processId)) {
      try {
        process.kill(-processId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          return { containment: this.containment, process_tree_reaped: false };
        }
      }
    }
    const deadline = Date.now() + this.proofTimeoutMs;
    while (unixProcessGroupExists(processId)) {
      if (Date.now() >= deadline) {
        return { containment: this.containment, process_tree_reaped: false };
      }
      await delay(this.pollIntervalMs);
    }
    return { containment: this.containment, process_tree_reaped: true };
  }
}

/** Spawn options callers must use for the matching containment implementation. */
export function managedProcessDetached(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}
