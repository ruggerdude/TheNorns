import { describe, expect, it } from "vitest";
import {
  RunnerFrame,
  RunnerWorkspaceRequest,
  RunnerWorkspaceResponse,
  ServerFrame,
} from "../src/wire.js";

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

  it("accepts native folder selection without exposing a path", () => {
    expect(
      RunnerWorkspaceRequest.safeParse({
        request_id: "workspace:choose",
        operation: "choose",
      }).success,
    ).toBe(true);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: "workspace:choose",
        operation: "choose",
        status: "ok",
        repository: {
          workspace_id: "local:workspace",
          repository_id: "local:repository",
          repository_display_name: "Project One",
          default_branch: "main",
          observed_head: "abc123",
        },
      }).success,
    ).toBe(true);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: "workspace:choose",
        operation: "choose",
        status: "cancelled",
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

  it("requires a runner generation on workspace request and response frames", () => {
    const request = { request_id: "workspace:request", operation: "list" as const };
    const response = {
      request_id: "workspace:request",
      operation: "list" as const,
      status: "ok" as const,
      workspaces: [],
    };
    expect(
      ServerFrame.safeParse({ type: "workspace_request", generation: 4, request }).success,
    ).toBe(true);
    expect(ServerFrame.safeParse({ type: "workspace_request", request }).success).toBe(false);
    expect(
      RunnerFrame.safeParse({ type: "workspace_response", generation: 4, response }).success,
    ).toBe(true);
    expect(RunnerFrame.safeParse({ type: "workspace_response", response }).success).toBe(false);
  });
});
