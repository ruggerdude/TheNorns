import { describe, expect, it } from "vitest";
import {
  V2AgentHeartbeat,
  V2KnowledgeDelta,
  V2KnowledgePackageVersion,
  V2TaskContextManifest,
  V2TaskKnowledgePackage,
} from "../src/v2/knowledge.js";

const actor = { actor_type: "human" as const, actor_id: "owner-1" };
const at = "2026-07-25T12:00:00.000Z";
const hash = "a".repeat(64);

describe("V2 knowledge contracts", () => {
  it("rejects authoritative knowledge without attributable approval", () => {
    const base = {
      schema_version: 2,
      id: "kpv-project-1",
      project_id: "project-1",
      package_id: "kp-project",
      version: "1.0.0",
      status: "active",
      content: {
        purpose: "Keep the project coherent.",
        scope: [],
        out_of_scope: [],
        authoritative_standards: [],
        architecture: [],
        interfaces: [],
        dependencies: [],
        constraints: [],
        current_state: [],
        known_issues: [],
        open_decisions: [],
        acceptance_requirements: [],
        related_packages: [],
        related_decision_records: [],
        change_history: [],
      },
      content_hash: hash,
      created_by: actor,
      approved_by: null,
      approved_at: null,
      supersedes_version_id: null,
      superseded_by_version_id: null,
      created_at: at,
      updated_at: at,
    };
    expect(V2KnowledgePackageVersion.safeParse(base).success).toBe(false);
    expect(
      V2KnowledgePackageVersion.safeParse({
        ...base,
        approved_by: actor,
        approved_at: at,
      }).success,
    ).toBe(true);
  });

  it("pins exact package and interface versions in a context manifest", () => {
    const manifest = V2TaskContextManifest.parse({
      schema_version: 2,
      id: "manifest-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      task_package_id: "task-package-1",
      generated_by: { actor_type: "coordinator", actor_id: "pm-1" },
      repository_commit: "abc123",
      included_packages: [
        {
          package_id: "kp-project",
          version_id: "kpv-project-1",
          name: "Project Package",
          type: "project",
          version: "1.0.0",
          status: "active",
          content_hash: hash,
        },
      ],
      included_decision_records: [],
      included_interface_contracts: [],
      included_source_files: [{ path: "src/index.ts", reason: "task entry point" }],
      included_test_files: [],
      included_current_state: [],
      explicitly_excluded_context: [{ item: "database package", reason: "unrelated to the task" }],
      known_context_limitations: [],
      unresolved_questions: [],
      estimated_tokens: 400,
      content_hash: hash,
      generated_at: at,
    });
    expect(manifest.included_packages[0]?.version).toBe("1.0.0");
  });

  it("requires approval metadata on approved task packages", () => {
    const result = V2TaskKnowledgePackage.safeParse({
      schema_version: 2,
      id: "task-package-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      version: 1,
      status: "approved",
      assignment: "Implement the service.",
      expected_outcome: "A working service.",
      business_or_user_outcome: "",
      scope: [],
      out_of_scope: [],
      deliverables: ["service"],
      file_scope_declared: true,
      permitted_files: [],
      restricted_files: [],
      required_package_ids: [],
      required_interface_contract_ids: [],
      required_decision_record_ids: [],
      dependencies: [],
      acceptance_criteria: ["tests pass"],
      required_tests: ["unit tests"],
      performance_requirements: [],
      accessibility_requirements: [],
      reporting_interval_seconds: 300,
      escalation_conditions: [],
      completion_format: "Agent handoff",
      branch_or_workspace: "",
      token_budget: null,
      content_hash: hash,
      approved_by: null,
      approved_at: null,
      created_at: at,
      updated_at: at,
    });
    expect(result.success).toBe(false);
  });

  it("requires dispositions for non-proposed knowledge deltas", () => {
    const result = V2KnowledgeDelta.safeParse({
      schema_version: 2,
      id: "delta-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      status: "accepted",
      changes: [
        {
          kind: "new_constraint",
          summary: "New constraint",
          detail: "Shared interfaces must be frozen before dispatch.",
          affected_package_ids: ["kp-project"],
        },
      ],
      recommended_package_updates: [],
      submitted_at: at,
      disposition_note: null,
      dispositioned_by: null,
      dispositioned_at: null,
    });
    expect(result.success).toBe(false);
  });

  it("captures the complete five-minute heartbeat shape", () => {
    const heartbeat = V2AgentHeartbeat.parse({
      schema_version: 2,
      id: "heartbeat-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      sequence: 1,
      reported_at: at,
      status: "working",
      completed_since_last_update: ["Read the contract"],
      currently_working_on: ["Implementing lifecycle transitions"],
      findings: [],
      blockers: [],
      decisions_needed: [],
      files_changed: ["src/knowledge.ts"],
      tests: "In progress",
      estimated_remaining_work: "moderate",
      risk_level: "green",
      content_hash: hash,
      repeated_update_count: 0,
    });
    expect(heartbeat.risk_level).toBe("green");
  });
});
