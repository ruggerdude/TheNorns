// ProcessRuntime: runs a shell script inside the worktree. This is (a) the
// deterministic stand-in that proves the execution pipeline end-to-end
// without provider credentials, and (b) mechanically what the LLM runtimes
// are too — subprocesses acting on a worktree. Workers commit locally; the
// runner pushes from outside (Runner Trust Contract).
import { spawn } from "node:child_process";
import { ManagedProcessTree, managedProcessDetached } from "../managedProcessTree.js";
import type { CodingRuntime, RuntimeRunRequest, RuntimeRunResult } from "./types.js";

export class ProcessRuntime implements CodingRuntime {
  readonly name = "process";
  readonly capabilities = {
    interrupt: false,
    suspend: false,
    resume_session: false,
    cancel: true,
    stop_after_current: false,
    // EXECUTION E11 — a human's answer is written to the script's stdin. This
    // is real delivery, not a stand-in: the script receives the bytes and can
    // block on `read` until they arrive. Whether the script does anything with
    // them is the script's business, exactly as it is the coding agent's
    // business what it does with an answer.
    send_message: true,
  };

  /** The "prompt" for a process runtime is the script to execute. */
  async run(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", request.prompt], {
        cwd: request.worktreePath,
        // On Unix the shell becomes a process-group leader, so cancellation
        // reaches the shell and every descendant it created. The Windows
        // fallback stops with taskkill but cannot claim verified containment.
        detached: managedProcessDetached(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: request.worktreePath, // no host $HOME (Sandbox Contract)
          GIT_AUTHOR_NAME: "norns-worker",
          GIT_AUTHOR_EMAIL: "worker@norns.local",
          GIT_COMMITTER_NAME: "norns-worker",
          GIT_COMMITTER_EMAIL: "worker@norns.local",
          ...(request.humanWaitPath ? { NORNS_HUMAN_WAIT_PATH: request.humanWaitPath } : {}),
        },
      });
      const processTree = new ManagedProcessTree(child);
      let output = "";
      let settled = false;
      let spawned = false;
      let requestedEnd:
        | { outcome: "cancelled"; detail: string }
        | { outcome: "failed"; detail: string }
        | null = null;
      const finish = (result: RuntimeRunResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const usage = { input_tokens: 0, output_tokens: 0, usage_source: "unavailable" as const };
      const requestTreeStop = (requested: NonNullable<typeof requestedEnd>): void => {
        // Cancellation dominates a timeout that has requested termination but
        // whose process has not closed yet.
        if (!requestedEnd || requested.outcome === "cancelled") requestedEnd = requested;
        if (spawned) processTree.requestStop();
      };

      // EXECUTION E11 — publish the live session before any output arrives, so
      // a message that races the first log line still has somewhere to go.
      request.onSession?.({
        sendMessage: async (message: string) => {
          if (settled || child.stdin.destroyed) {
            throw new Error("the run's process is no longer accepting input");
          }
          await new Promise<void>((ok, fail) => {
            child.stdin.write(`${message}\n`, (error) => (error ? fail(error) : ok()));
          });
        },
      });

      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        request.onLog?.(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
        request.onLog?.(String(chunk));
      });

      const timer = request.timeoutMs
        ? setTimeout(() => {
            requestTreeStop({
              outcome: "failed",
              detail: "timeout; managed process-tree termination requested",
            });
          }, request.timeoutMs)
        : null;

      const cancel = (): void =>
        requestTreeStop({
          outcome: "cancelled",
          detail:
            "cancelled; managed process-tree termination requested and the shell process was reaped",
        });
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();

      child.once("spawn", () => {
        spawned = true;
        if (requestedEnd) requestTreeStop(requestedEnd);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
        void processTree.confirmReaped().then((proof) => {
          if (requestedEnd) {
            finish({ ...requestedEnd, usage, process_tree_reaped: proof.process_tree_reaped });
            return;
          }
          finish({
            outcome: code === 0 ? "completed" : "failed",
            detail: output.slice(-2000),
            usage,
            process_tree_reaped: proof.process_tree_reaped,
          });
        });
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
        // A process that never spawned has nothing to reap. Spawned processes
        // settle only from `close`, after Node has reaped the direct child.
        if (!spawned) {
          finish({
            outcome: "failed",
            detail: error.message,
            usage,
            process_tree_reaped: true,
          });
        }
      });
    });
  }
}
