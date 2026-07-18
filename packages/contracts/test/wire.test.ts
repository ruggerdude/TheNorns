import { describe, expect, it } from "vitest";
import { RunnerWorkspaceRequest, RunnerWorkspaceResponse } from "../src/wire.js";

describe("runner workspace wire", () => {
  it("accepts opaque browse handles and the matching response payload", () => {
    expect(
      RunnerWorkspaceRequest.safeParse({
        request_id: "workspace:request",
        operation: "browse",
        workspace_id: "local:workspace",
      }).success,
    ).toBe(true);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: "workspace:request",
        operation: "browse",
        status: "ok",
        entries: [
          { entry_id: "entry:one", label: "Project One", kind: "repository", can_browse: false },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects raw paths, unknown fields, and mismatched operation payloads", () => {
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: "workspace:request",
        operation: "list",
        status: "ok",
        workspaces: [{ workspace_id: "local:workspace", label: "/Users/operator/projects" }],
      }).success,
    ).toBe(false);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: "workspace:request",
        operation: "validate",
        status: "ok",
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      RunnerWorkspaceRequest.safeParse({
        request_id: "workspace:request",
        operation: "list",
        raw_path: "/Users/operator/projects",
      }).success,
    ).toBe(false);
  });
});
