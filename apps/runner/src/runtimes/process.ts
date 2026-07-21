// ProcessRuntime: runs a shell script inside the worktree. This is (a) the
// deterministic stand-in that proves the execution pipeline end-to-end
// without provider credentials, and (b) mechanically what the LLM runtimes
// are too — subprocesses acting on a worktree. Workers commit locally; the
// runner pushes from outside (Runner Trust Contract).
import { spawn } from "node:child_process";
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
        env: {
          PATH: process.env.PATH ?? "",
          HOME: request.worktreePath, // no host $HOME (Sandbox Contract)
          GIT_AUTHOR_NAME: "norns-worker",
          GIT_AUTHOR_EMAIL: "worker@norns.local",
          GIT_COMMITTER_NAME: "norns-worker",
          GIT_COMMITTER_EMAIL: "worker@norns.local",
        },
      });
      let output = "";
      let settled = false;
      const finish = (result: RuntimeRunResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const usage = { input_tokens: 0, output_tokens: 0, usage_source: "unavailable" as const };

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
            child.kill("SIGKILL");
            finish({ outcome: "failed", detail: "timeout", usage });
          }, request.timeoutMs)
        : null;

      request.signal?.addEventListener("abort", () => {
        child.kill("SIGKILL");
        finish({ outcome: "cancelled", detail: "cancelled by operator", usage });
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        finish({
          outcome: code === 0 ? "completed" : "failed",
          detail: output.slice(-2000),
          usage,
        });
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        finish({ outcome: "failed", detail: error.message, usage });
      });
    });
  }
}
