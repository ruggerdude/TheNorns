import { describe, expect, it } from "vitest";
import {
  DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
  LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
  RunnerFrame,
  RunnerWorkspaceRequest,
  RunnerWorkspaceResponse,
  ServerFrame,
  canonicalDeviceCancellationEvidenceWssTranscript,
  canonicalLegacyRunnerWssAuthenticationTranscript,
} from "../src/wire.js";

describe("runner workspace wire", () => {
  it("separates device transcript authentication from legacy nonce authentication", () => {
    expect(
      canonicalLegacyRunnerWssAuthenticationTranscript({
        purpose: LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
        runner_id: "legacy-runner",
        generation: 2,
        protocol_version: 1,
        challenge: "legacy-nonce",
      }),
    ).toBe(
      '{"purpose":"norns.legacy-runner-wss-auth.v1","runner_id":"legacy-runner","generation":2,"protocol_version":1,"challenge":"legacy-nonce"}',
    );
    expect(
      ServerFrame.safeParse({
        type: "challenge",
        nonce: "legacy-nonce",
        device_auth: {
          challenge: "device-challenge",
          supported_protocol_versions: ["1"],
        },
      }).success,
    ).toBe(true);
    expect(
      RunnerFrame.safeParse({
        type: "auth",
        runner_id: "legacy-runner",
        generation: 2,
        protocol_version: 1,
        transcript_signature: "base64-signature",
      }).success,
    ).toBe(true);
    expect(
      RunnerFrame.safeParse({
        type: "auth",
        runner_id: "legacy-runner",
        nonce_signature: "bare-nonce-signature",
      }).success,
    ).toBe(false);
    expect(
      RunnerFrame.safeParse({
        type: "device_auth",
        device_id: "device-1",
        credential_id: "credential-1",
        generation: 1,
        protocol_version: "1",
        transcript_signature: "base64-signature",
      }).success,
    ).toBe(true);
    expect(
      RunnerFrame.safeParse({
        type: "device_auth",
        runner_id: "legacy-runner",
        nonce_signature: "base64-signature",
      }).success,
    ).toBe(false);
    expect(
      ServerFrame.safeParse({
        type: "device_auth_ok",
        device_id: "device-1",
        generation: 1,
        protocol_version: "1",
      }).success,
    ).toBe(true);
  });

  it("binds cancellation evidence to an exact domain-separated state transition", () => {
    const acknowledged = {
      type: "device_cancellation_evidence" as const,
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 4,
      run_id: "run-1",
      evidence_state: "runner_acknowledged" as const,
      acknowledged_at: "2026-07-30T12:00:00.000Z",
      process_exited_at: null,
      process_tree_reaped: false,
      transcript_signature: "base64-signature",
    };
    expect(RunnerFrame.safeParse(acknowledged).success).toBe(true);
    expect(
      RunnerFrame.safeParse({
        ...acknowledged,
        process_exited_at: "2026-07-30T12:00:01.000Z",
        process_tree_reaped: true,
      }).success,
    ).toBe(false);

    const exited = {
      ...acknowledged,
      evidence_state: "process_exited" as const,
      process_exited_at: "2026-07-30T12:00:01.000Z",
      process_tree_reaped: true,
    };
    expect(RunnerFrame.safeParse(exited).success).toBe(true);
    expect(
      canonicalDeviceCancellationEvidenceWssTranscript({
        purpose: DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
        device_id: exited.device_id,
        credential_id: exited.credential_id,
        generation: exited.generation,
        run_id: exited.run_id,
        evidence_state: exited.evidence_state,
        acknowledged_at: exited.acknowledged_at,
        process_exited_at: exited.process_exited_at,
        process_tree_reaped: exited.process_tree_reaped,
      }),
    ).toBe(
      '{"purpose":"norns.device-cancellation-evidence-wss.v1","device_id":"device-1","credential_id":"credential-1","generation":4,"run_id":"run-1","evidence_state":"process_exited","acknowledged_at":"2026-07-30T12:00:00.000Z","process_exited_at":"2026-07-30T12:00:01.000Z","process_tree_reaped":true}',
    );
    expect(
      ServerFrame.safeParse({
        type: "device_cancellation_request",
        device_id: "device-1",
        credential_id: "credential-1",
        generation: 4,
        run_id: "run-1",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: true,
      }).success,
    ).toBe(true);
    expect(
      ServerFrame.safeParse({
        type: "device_cancellation_evidence_ack",
        run_id: "run-1",
        evidence_state: "process_exited",
      }).success,
    ).toBe(true);
  });

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
        request_id: "workspace:catalog",
        operation: "catalog",
        status: "ok",
        repositories: [
          {
            workspace_id: "local:workspace",
            repository_id: "local:repository",
            repository_display_name: "Project One",
            default_branch: "main",
            observed_head: "abc123",
          },
        ],
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

  it("accepts a secure GitHub clone request and returns only opaque repository handles", () => {
    expect(
      RunnerWorkspaceRequest.safeParse({
        request_id: "workspace:clone",
        operation: "clone",
        clone_url: "https://github.com/octocat/fresh-app.git",
        repository_name: "fresh-app",
        clone_token: "short-lived-repository-token",
      }).success,
    ).toBe(true);
    expect(
      RunnerWorkspaceRequest.safeParse({
        request_id: "workspace:clone",
        operation: "clone",
        clone_url: "https://token@github.com/octocat/fresh-app.git",
        repository_name: "fresh-app",
        clone_token: "short-lived-repository-token",
      }).success,
    ).toBe(false);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: "workspace:clone",
        operation: "clone",
        status: "ok",
        repository: {
          workspace_id: "local:workspace",
          repository_id: "local:repository",
          repository_display_name: "fresh-app",
          default_branch: "main",
          observed_head: "abc123",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts a bounded committed-repository inspection and rejects path leakage", () => {
    const request = {
      request_id: "workspace:inspect",
      operation: "inspect",
      repository_id: "local:repository",
    };
    expect(RunnerWorkspaceRequest.safeParse(request).success).toBe(true);
    const inspection = {
      repository_id: "local:repository",
      repository_display_name: "Project One",
      default_branch: "main",
      observed_head: "abc123".padEnd(40, "0"),
      total_files: 2,
      tree_truncated: false,
      tree_paths: ["README.md", "src/index.ts"],
      files: [{ path: "README.md", content: "# Project One", truncated: false }],
    };
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: request.request_id,
        operation: "inspect",
        status: "ok",
        inspection,
      }).success,
    ).toBe(true);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: request.request_id,
        operation: "inspect",
        status: "ok",
        inspection: { ...inspection, repository_display_name: "/Users/operator/Project One" },
      }).success,
    ).toBe(false);
    expect(
      RunnerWorkspaceResponse.safeParse({
        request_id: request.request_id,
        operation: "inspect",
        status: "ok",
        inspection: { ...inspection, tree_paths: ["/Users/operator/Project One/README.md"] },
      }).success,
    ).toBe(false);
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
