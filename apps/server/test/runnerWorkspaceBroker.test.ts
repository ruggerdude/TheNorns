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

  it("correlates clone responses without returning the clone credential", async () => {
    let sent: RunnerWorkspaceRequestT | undefined;
    const broker = new RunnerWorkspaceBroker((_runner, _generation, request) => {
      sent = request;
      return true;
    });
    const waiting = broker.request("runner-1", 3, {
      operation: "clone",
      clone_url: "https://github.com/octocat/fresh-app.git",
      repository_name: "fresh-app",
      clone_token: "one-use-secret",
    });
    if (!sent) throw new Error("request was not sent");
    broker.receive("runner-1", 3, {
      request_id: sent.request_id,
      operation: "clone",
      status: "ok",
      repository: {
        workspace_id: "local:workspace",
        repository_id: "local:repository",
        repository_display_name: "fresh-app",
        default_branch: "main",
        observed_head: "abc123",
      },
    });
    const response = await waiting;
    expect(response.status).toBe("ok");
    expect(JSON.stringify(response)).not.toContain("one-use-secret");
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

  it("initiate + poll collects a folder pick out of band, once, without holding a request open", async () => {
    let sent: RunnerWorkspaceRequestT | undefined;
    const broker = new RunnerWorkspaceBroker((_runner, _generation, request) => {
      sent = request;
      return true;
    });
    const { request_id } = broker.initiate("runner-1", 3, { operation: "choose" });
    expect(sent?.request_id).toBe(request_id);
    // Still choosing, and a bogus id is unknown — neither blocks the caller.
    expect(broker.poll(request_id)).toEqual({ state: "pending" });
    expect(broker.poll("workspace:nope")).toEqual({ state: "unknown" });

    broker.receive("runner-1", 3, {
      request_id,
      operation: "choose",
      status: "ok",
      repository: {
        workspace_id: "local:workspace",
        repository_id: "local:repository",
        repository_display_name: "Project",
        default_branch: "main",
        observed_head: "a".repeat(40),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the settle land

    const collected = broker.poll(request_id);
    expect(collected.state).toBe("ok");
    // Idempotent: a retried/duplicated poll keeps returning the same answer
    // (important across replicas), rather than flipping to unknown.
    expect(broker.poll(request_id).state).toBe("ok");
  });

  it("poll surfaces a runner disconnect during a pick as an error, not a hang", async () => {
    const broker = new RunnerWorkspaceBroker(() => true);
    const { request_id } = broker.initiate("runner-1", 3, { operation: "choose" });
    broker.disconnect("runner-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.poll(request_id)).toEqual({ state: "error", code: "runner_unavailable" });
  });
});
