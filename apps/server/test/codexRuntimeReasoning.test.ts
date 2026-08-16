import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntime } from "../../runner/src/runtimes/codex.js";

const codexSdk = {
  startThread: vi.fn(),
  resumeThread: vi.fn(),
  run: vi.fn(),
};

describe("Codex runtime reasoning effort", () => {
  beforeEach(() => {
    codexSdk.startThread.mockReset();
    codexSdk.resumeThread.mockReset();
    codexSdk.run.mockReset();
    codexSdk.run.mockResolvedValue({ finalResponse: "completed" });
    codexSdk.startThread.mockReturnValue({ id: "thread-1", run: codexSdk.run });
  });

  it("passes the selected effort to the Codex SDK thread options", async () => {
    const runtime = new CodexRuntime({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      createClient: () =>
        ({
          startThread: codexSdk.startThread,
          resumeThread: codexSdk.resumeThread,
        }) as never,
    });

    const result = await runtime.run({
      runId: "run-1",
      worktreePath: "/tmp/norns-codex-runtime-test",
      prompt: "Implement the approved task.",
    });

    expect(result).toMatchObject({ outcome: "completed", sessionId: "thread-1" });
    expect(codexSdk.startThread).toHaveBeenCalledWith({
      workingDirectory: "/tmp/norns-codex-runtime-test",
      skipGitRepoCheck: false,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: true,
      additionalDirectories: [],
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
    });
    expect(codexSdk.run).toHaveBeenCalledWith("Implement the approved task.", {});
  });
});
