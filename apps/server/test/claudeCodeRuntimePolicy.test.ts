import {
  CLAUDE_CODE_AUTONOMOUS_TOOLS,
  CLAUDE_CODE_PLANNED_MAX_TURNS,
  CLAUDE_CODE_QUICK_MAX_TURNS,
  ClaudeCodeRuntime,
} from "@norns/runner";
import { describe, expect, it, vi } from "vitest";

describe("Claude Code unattended execution policy", () => {
  it("allows the scoped coding tools without prompting and enforces turn and budget ceilings", async () => {
    let received:
      | {
          prompt: AsyncIterable<unknown>;
          options: Record<string, unknown>;
        }
      | undefined;
    const interrupt = vi.fn(async () => undefined);
    const queryImpl = ((request: {
      prompt: AsyncIterable<unknown>;
      options: Record<string, unknown>;
    }) => {
      received = request;
      return {
        interrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            usage: { input_tokens: 11, output_tokens: 3 },
          };
        },
      };
    }) as never;
    const runtime = new ClaudeCodeRuntime({ queryImpl });

    const result = await runtime.run({
      runId: "run-quick-edit",
      worktreePath: "/isolated/worktree",
      prompt: "Correct the README heading, verify it, and commit the result.",
      maxBudgetUsd: 1.25,
      executionMode: "quick",
    });

    expect(result).toMatchObject({
      outcome: "completed",
      detail: "done",
      usage: { input_tokens: 11, output_tokens: 3 },
    });
    expect(received?.options).toMatchObject({
      cwd: "/isolated/worktree",
      permissionMode: "dontAsk",
      tools: [...CLAUDE_CODE_AUTONOMOUS_TOOLS],
      allowedTools: [...CLAUDE_CODE_AUTONOMOUS_TOOLS],
      maxTurns: CLAUDE_CODE_QUICK_MAX_TURNS,
      maxBudgetUsd: 1.25,
    });
    expect(CLAUDE_CODE_QUICK_MAX_TURNS).toBeGreaterThan(12);
    expect(CLAUDE_CODE_QUICK_MAX_TURNS).toBeLessThan(25);
    expect(CLAUDE_CODE_PLANNED_MAX_TURNS).toBeGreaterThan(25);
  });

  it("emits concrete file and command activity without exposing the worktree root", async () => {
    const logs: string[] = [];
    const queryImpl = (() => ({
      interrupt: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "/isolated/worktree/apps/web/src/App.tsx" },
              },
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "pnpm test --filter web" },
              },
            ],
          },
        };
        yield { type: "result", subtype: "success", result: "done" };
      },
    })) as never;

    await new ClaudeCodeRuntime({ queryImpl }).run({
      runId: "run-visible-activity",
      worktreePath: "/isolated/worktree",
      prompt: "Do the work.",
      onLog: (line) => logs.push(line),
    });

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { type: "norns_activity", text: "Running tests · pnpm test --filter web" },
    ]);
    expect(logs.join(" ")).not.toContain("/isolated/worktree");
  });

  it("does not invent an SDK dollar ceiling for a zero-cost dispatch", async () => {
    let options: Record<string, unknown> | undefined;
    const queryImpl = ((request: { options: Record<string, unknown> }) => {
      options = request.options;
      return {
        interrupt: async () => undefined,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            result: "done",
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        },
      };
    }) as never;

    await new ClaudeCodeRuntime({ queryImpl }).run({
      runId: "run-free",
      worktreePath: "/isolated/worktree",
      prompt: "Do the task.",
      maxBudgetUsd: 0,
    });

    expect(options).not.toHaveProperty("maxBudgetUsd");
    expect(options).toMatchObject({ maxTurns: CLAUDE_CODE_PLANNED_MAX_TURNS });
  });

  it("preserves the SDK session and exact permission-denial stop cause", async () => {
    const queryImpl = (() => ({
      interrupt: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-session-123",
          result: "I could not update the requested file.",
          stop_reason: "end_turn",
          permission_denials: [{ tool_name: "Edit" }, { tool_name: "Bash" }],
          usage: { input_tokens: 50, output_tokens: 10 },
        };
      },
    })) as never;

    const result = await new ClaudeCodeRuntime({ queryImpl }).run({
      runId: "run-denied",
      worktreePath: "/isolated/worktree",
      prompt: "Make and commit the edit.",
    });

    expect(result).toMatchObject({
      outcome: "completed",
      sessionId: "claude-session-123",
      stopReason: "permission_denied:Edit,Bash",
    });
    expect(result.detail).toContain("SDK permission denied for Edit, Bash");
  });

  it("preserves session and max-turn stop metadata from an SDK error result", async () => {
    const queryImpl = (() => ({
      interrupt: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "error_max_turns",
          session_id: "claude-session-max-turns",
          stop_reason: null,
          errors: ["Reached the configured maximum number of turns"],
          permission_denials: [],
          usage: { input_tokens: 175_202, output_tokens: 3_146 },
        };
      },
    })) as never;

    const result = await new ClaudeCodeRuntime({ queryImpl }).run({
      runId: "run-max-turns",
      worktreePath: "/isolated/worktree",
      prompt: "Finish and commit the change.",
      executionMode: "quick",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      sessionId: "claude-session-max-turns",
      stopReason: "error_max_turns",
      detail: "Reached the configured maximum number of turns",
    });
  });

  it("retains an earlier SDK session id when max-turn termination throws before a result", async () => {
    const queryImpl = (() => ({
      interrupt: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "claude-session-before-throw",
        };
        throw new Error("Reached maximum number of turns");
      },
    })) as never;

    const result = await new ClaudeCodeRuntime({ queryImpl }).run({
      runId: "run-max-turn-throw",
      worktreePath: "/isolated/worktree",
      prompt: "Finish and commit the change.",
      executionMode: "quick",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      sessionId: "claude-session-before-throw",
      stopReason: "error_max_turns",
      detail: "Reached maximum number of turns",
    });
  });

  it("aborts the SDK process when the execution timeout expires", async () => {
    let sdkSignal: AbortSignal | undefined;
    const queryImpl = ((request: {
      options: { abortController: AbortController };
    }) => {
      sdkSignal = request.options.abortController.signal;
      return {
        interrupt: async () => undefined,
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_resolve, reject) => {
            request.options.abortController.signal.addEventListener(
              "abort",
              () => reject(new Error("SDK aborted")),
              { once: true },
            );
          });
        },
      };
    }) as never;

    const result = await new ClaudeCodeRuntime({ queryImpl }).run({
      runId: "run-timeout",
      worktreePath: "/isolated/worktree",
      prompt: "Keep working.",
      timeoutMs: 10,
    });

    expect(sdkSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      outcome: "failed",
      stopReason: "timeout",
    });
    expect(result.detail).toContain("timed out after 10ms");
  });
});
