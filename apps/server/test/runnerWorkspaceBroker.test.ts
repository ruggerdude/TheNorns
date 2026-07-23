import type { RunnerWorkspaceRequestT } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  RunnerWorkspaceBroker,
  WorkspaceBrokerError,
  WorkspaceSelectionTokens,
} from "../src/runners/workspaceBroker.js";

describe("runner workspace broker", () => {
  it("correlates only the current generation and bounds pending requests", async () => {
    let sent: RunnerWorkspaceRequestT | undefined;
    const broker = new RunnerWorkspaceBroker(
      (_runner, _generation, request) => {
        sent = request;
        return true;
      },
      { maxPerRunner: 1 },
    );
    const waiting = broker.request("runner-1", 3, { operation: "list" });
    await expect(broker.request("runner-1", 3, { operation: "list" })).rejects.toMatchObject({
      code: "request_limit",
    });
    if (!sent) throw new Error("request was not sent");
    expect(
      broker.receive("runner-1", 2, {
        request_id: sent.request_id,
        operation: "list",
        status: "ok",
        workspaces: [],
      }),
    ).toBe(false);
    broker.disconnect("runner-1");
    await expect(waiting).rejects.toBeInstanceOf(WorkspaceBrokerError);
  });

  it("binds selections to one user and consumes them once", () => {
    const tokens = new WorkspaceSelectionTokens();
    const issued = tokens.issue("user-1", "runner-1", 1, {
      workspace_id: "local:workspace",
      repository_id: "local:repository",
      repository_display_name: "Project",
      default_branch: "main",
      observed_head: "abc123",
    });
    expect(tokens.reserve("user-2", issued.selection_token)).toBeUndefined();
    const reserved = tokens.reserve("user-1", issued.selection_token);
    if (!reserved) throw new Error("selection was not reserved");
    tokens.commit(issued.selection_token, reserved.reservation_id);
    expect(tokens.reserve("user-1", issued.selection_token)).toBeUndefined();
  });

  it("rejects an expired selection", () => {
    let time = Date.parse("2026-07-23T12:00:00Z");
    const tokens = new WorkspaceSelectionTokens(() => time);
    const issued = tokens.issue("user-1", "runner-1", 1, {
      workspace_id: "local:workspace",
      repository_id: "local:repository",
      repository_display_name: "Project",
      default_branch: "main",
      observed_head: "abc123",
    });

    time += 5 * 60_000;
    expect(tokens.reserve("user-1", issued.selection_token)).toBeUndefined();
  });
});
