import { describe, expect, it } from "vitest";
import {
  V2Approval,
  V2ArtifactMetadata,
  V2RepositoryBinding,
  V2VerificationResult,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const HASH = "a".repeat(64);
const evidence = {
  artifact_id: "artifact-1",
  content_hash: HASH,
  media_type: "text/plain",
  label: "Verification output",
};

describe("V2 repository bindings", () => {
  const common = {
    schema_version: 2,
    id: "repository-binding-1",
    project_id: "project-1",
    status: "connected",
    default_branch: "main",
    observed_head: "abc123",
    verification_policy_ref: "verification-policy-1",
    repository_health: "healthy",
    last_validated_at: NOW,
    last_synced_at: NOW,
    created_by: { actor_type: "human", actor_id: "user-1" },
    aggregate_version: 1,
    created_at: NOW,
    updated_at: NOW,
  } as const;

  it("represents a local repository only through runner-owned opaque identifiers", () => {
    const binding = {
      ...common,
      binding_type: "local_runner",
      runner_id: "runner-1",
      workspace_id: "workspace-1",
      repository_id: "repository-1",
      repository_display_name: "The Norns",
    } as const;
    expect(V2RepositoryBinding.safeParse(binding).success).toBe(true);
    expect(
      V2RepositoryBinding.safeParse({
        ...binding,
        absolute_path: "/Users/operator/The Norns",
      }).success,
    ).toBe(false);
  });

  it("represents a GitHub App installation with an explicit least-privilege grant", () => {
    expect(
      V2RepositoryBinding.safeParse({
        ...common,
        binding_type: "github",
        github_installation_id: "installation-1",
        github_repository_id: "github-repository-1",
        owner: "ruggerdude",
        name: "TheNorns",
        runner_id: "runner-1",
        granted_permissions: {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          checks: "none",
          actions: "none",
        },
      }).success,
    ).toBe(true);
  });
});

describe("V2 approval and evidence metadata", () => {
  it("stores a first-class human approval behind embedded approval evidence", () => {
    const approval = {
      schema_version: 2,
      id: "approval-1",
      project_id: "project-1",
      phase_id: "phase-1",
      kind: "strategy_version",
      subject: { entity_type: "strategy_version", entity_id: "strategy-1" },
      actor: { actor_type: "human", actor_id: "user-1" },
      content_hash: HASH,
      status: "active",
      approved_at: NOW,
      superseded_by_approval_id: null,
      revoked_at: null,
    } as const;
    expect(V2Approval.safeParse(approval).success).toBe(true);
    expect(
      V2Approval.safeParse({
        ...approval,
        actor: { actor_type: "coordinator", actor_id: "coordinator-1" },
      }).success,
    ).toBe(false);
  });

  it("keeps artifact bytes outside PostgreSQL while preserving metadata and provenance", () => {
    expect(
      V2ArtifactMetadata.safeParse({
        schema_version: 2,
        id: "artifact-1",
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        run_id: "run-1",
        kind: "verification_output",
        label: "Test output",
        media_type: "text/plain",
        storage_ref: "objects/sha256/aa",
        content_hash: HASH,
        byte_size: 2048,
        provenance: { actor_type: "runner", actor_id: "runner-1" },
        redaction_status: "applied",
        retention_until: null,
        created_at: NOW,
      }).success,
    ).toBe(true);
  });

  it("requires the aggregate verification result to agree with every command result", () => {
    const verification = {
      schema_version: 2,
      id: "verification-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      repository_binding_id: "repository-binding-1",
      commit_sha: "abc123",
      verification_policy_ref: "verification-policy-1",
      passed: true,
      command_results: [
        {
          command_label: "pnpm test",
          command_digest: HASH,
          exit_code: 0,
          passed: true,
          output_artifact: evidence,
        },
      ],
      evidence: [evidence],
      produced_by_runner_id: "runner-1",
      created_at: NOW,
    } as const;
    expect(V2VerificationResult.safeParse(verification).success).toBe(true);
    expect(
      V2VerificationResult.safeParse({
        ...verification,
        command_results: [{ ...verification.command_results[0], passed: false }],
      }).success,
    ).toBe(false);
  });
});
