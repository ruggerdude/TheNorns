import type { RunnerWorkspaceRequestT } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import {
  RunnerWorkspaceBroker,
  WorkspaceBrokerError,
  WorkspaceSelectionTokens,
} from "../src/runners/workspaceBroker.js";

describe("runner workspace broker", () => {
  it("correlates only the current runner generation and bounds outstanding requests", async () => {
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
    if (!sent) throw new Error("workspace request was not sent");
    const requestId = sent.request_id;
    expect(
      broker.receive("runner-1", 2, {
        request_id: requestId,
        operation: "list",
        status: "ok",
        workspaces: [],
      }),
    ).toBe(false);
    expect(
      broker.receive("runner-1", 3, {
        request_id: requestId,
        operation: "browse",
        status: "ok",
        entries: [],
      }),
    ).toBe(false);
    await expect(waiting).rejects.toMatchObject({ code: "invalid_response" });

    const retried = broker.request("runner-1", 3, { operation: "list" });
    if (!sent) throw new Error("workspace retry was not sent");
    expect(
      broker.receive("runner-1", 3, {
        request_id: sent.request_id,
        operation: "list",
        status: "ok",
        workspaces: [{ workspace_id: "local:workspace", label: "Work" }],
      }),
    ).toBe(true);
    await expect(retried).resolves.toMatchObject({ status: "ok" });
  });

  it("invalidates a user-bound selection after first consumption", () => {
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
    expect(reserved.selection).toMatchObject({
      runner_id: "runner-1",
      repository_id: "local:repository",
    });
    tokens.release(issued.selection_token, reserved.reservation_id);
    const retried = tokens.reserve("user-1", issued.selection_token);
    if (!retried) throw new Error("released selection was not reservable");
    tokens.commit(issued.selection_token, retried.reservation_id);
    expect(tokens.reserve("user-1", issued.selection_token)).toBeUndefined();
  });

  it("rejects in-flight browse work when the runner disconnects", async () => {
    const broker = new RunnerWorkspaceBroker(() => true);
    const waiting = broker.request("runner-1", 1, { operation: "list" });
    broker.disconnect("runner-1");
    await expect(waiting).rejects.toBeInstanceOf(WorkspaceBrokerError);
  });
});
