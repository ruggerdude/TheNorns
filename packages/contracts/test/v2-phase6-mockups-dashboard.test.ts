import { describe, expect, it } from "vitest";
import {
  V2ConversationMockupDecision,
  V2ConversationMockupVersion,
  V2ConversationTaskPackageSupplement,
  V2ConversationTaskPackageSupplementDispatchReceipt,
  V2CreateExecutionActionProposalInput,
  V2DeploymentObservationEvidenceReceipt,
  V2ImplementationVisualEvidence,
  V2MockupArtifactUploadInput,
  V2MockupManifest,
  V2ProjectArtifactQuotaReceipt,
  V2ProjectCodingMetrics,
  V2ProjectDashboard,
  V2ProjectDeployment,
  V2ProjectDeploymentObservation,
  V2PublicHttpsUrl,
  V2RecordProjectDeploymentObservationInput,
  V2VisualComparisonReceipt,
  V2WorkMessage,
} from "../src/index.js";

const NOW = "2026-07-27T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const COMMIT = "d".repeat(40);

const profile = {
  renderer: "norns-deterministic-v1",
  renderer_revision: HASH_A,
  font_revision: HASH_B,
  pixel_ratio: 1,
  network: "disabled",
  scripts: "disabled",
  locale: "en-US",
  timezone: "UTC",
  fixed_clock: NOW,
  seed: HASH_C,
} as const;

const artifact = (
  artifact_id: string,
  content_hash: string,
  media_type: string,
  label: string,
) => ({ artifact_id, content_hash, media_type, label });

const version = {
  schema_version: 2,
  id: "mockup-version-1",
  root_request_id: "mockup-request-1",
  request_id: "mockup-request-1",
  project_id: "project-1",
  work_item_id: "work-1",
  conversation_id: "conversation-1",
  task_id: "task-1",
  created_by_action_id: "action-1",
  version: 1,
  status: "candidate",
  brief: "Show the conversation-first Work page.",
  target: "responsive",
  interaction_notes: ["Approval is explicit.", "Both viewports share one design version."],
  manifest: artifact("artifact-manifest", HASH_A, "application/json", "Mockup manifest"),
  renderer_profile: profile,
  screenshots: [
    {
      viewport: "desktop",
      artifact: artifact("artifact-desktop", HASH_B, "image/png", "Desktop mockup"),
      width: 1440,
      height: 1024,
      capture_profile: profile,
    },
    {
      viewport: "mobile",
      artifact: artifact("artifact-mobile", HASH_C, "image/png", "Mobile mockup"),
      width: 390,
      height: 844,
      capture_profile: profile,
    },
  ],
  supersedes_mockup_version_id: null,
  created_at: NOW,
} as const;

const manifest = {
  schema_version: 2,
  kind: "mockup",
  mockup_version_id: version.id,
  root_request_id: version.root_request_id,
  request_id: version.request_id,
  task_id: version.task_id,
  version: version.version,
  brief: version.brief,
  target: version.target,
  interaction_notes: version.interaction_notes,
  renderer_profile: profile,
  screenshots: version.screenshots,
} as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const unavailable = (source: string) => ({
  availability: "unavailable",
  source,
  observed_at: null,
  data: null,
  reason_code: "source_unavailable",
  detail: null,
  retryable: true,
});

describe("Phase 6 mockup and dashboard contracts", () => {
  it("requires one immutable manifest plus distinct fixed desktop and mobile PNGs", () => {
    expect(V2ConversationMockupVersion.safeParse(version).success).toBe(true);
    expect(
      V2ConversationMockupVersion.safeParse({
        ...version,
        screenshots: [version.screenshots[1], version.screenshots[0]],
      }).success,
    ).toBe(false);
    expect(
      V2ConversationMockupVersion.safeParse({
        ...version,
        screenshots: [
          version.screenshots[0],
          {
            ...version.screenshots[1],
            artifact: version.screenshots[0].artifact,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      V2ConversationMockupVersion.safeParse({
        ...version,
        version: 2,
        supersedes_mockup_version_id: null,
      }).success,
    ).toBe(false);
  });

  it("makes every human-reviewed field part of the strict manifest", () => {
    expect(V2MockupManifest.safeParse(manifest).success).toBe(true);
    expect(V2MockupManifest.safeParse({ ...manifest, interaction_notes: [] }).success).toBe(false);
    expect(
      V2MockupManifest.safeParse({
        ...manifest,
        task_id: "different-task",
        injected_html: "<script />",
      }).success,
    ).toBe(false);
    expect(
      V2MockupManifest.safeParse({
        ...manifest,
        screenshots: [{ ...manifest.screenshots[0], width: 1280 }, manifest.screenshots[1]],
      }).success,
    ).toBe(false);
    expect(
      V2MockupManifest.safeParse({
        ...manifest,
        screenshots: [
          {
            ...manifest.screenshots[0],
            artifact: { ...manifest.screenshots[0].artifact, media_type: "image/jpeg" },
          },
          manifest.screenshots[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      V2MockupManifest.safeParse({
        ...manifest,
        screenshots: [
          {
            ...manifest.screenshots[0],
            capture_profile: { ...profile, seed: HASH_A },
          },
          manifest.screenshots[1],
        ],
      }).success,
    ).toBe(false);
  });

  it("binds every decision action to the exact manifest artifact and hash", () => {
    const decision = {
      schema_version: 2,
      id: "mockup-decision-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      mockup_version_id: version.id,
      action_id: "action-2",
      decided_by_user_id: "user-1",
      decision: "revision_requested",
      manifest_artifact_id: version.manifest.artifact_id,
      manifest_artifact_hash: version.manifest.content_hash,
      rationale: null,
      direction: "Increase the density of the project overview.",
      created_at: NOW,
    } as const;
    expect(V2ConversationMockupDecision.safeParse(decision).success).toBe(true);
    expect(V2ConversationMockupDecision.safeParse({ ...decision, direction: null }).success).toBe(
      false,
    );
    expect(
      V2ConversationMockupDecision.safeParse({
        ...decision,
        decision: "approved",
        direction: null,
        rationale: "Unrecorded rationale",
      }).success,
    ).toBe(false);

    for (const action_type of ["approve_mockup", "revise_mockup", "reject_mockup"] as const) {
      const parameters =
        action_type === "approve_mockup"
          ? {
              mockup_version_id: version.id,
              task_id: version.task_id,
              manifest_artifact_id: version.manifest.artifact_id,
              manifest_artifact_hash: version.manifest.content_hash,
            }
          : action_type === "revise_mockup"
            ? {
                mockup_version_id: version.id,
                manifest_artifact_id: version.manifest.artifact_id,
                manifest_artifact_hash: version.manifest.content_hash,
                direction: "Show the decision state more clearly.",
              }
            : {
                mockup_version_id: version.id,
                manifest_artifact_id: version.manifest.artifact_id,
                manifest_artifact_hash: version.manifest.content_hash,
                reason: "This does not satisfy the approved flow.",
              };
      expect(
        V2CreateExecutionActionProposalInput.safeParse({
          idempotency_key: `idempotency-${action_type}`,
          message: "Record this explicit mockup decision.",
          action_type,
          payload: { parameters },
        }).success,
      ).toBe(true);
      const { manifest_artifact_hash: _, ...missingHash } = parameters;
      expect(
        V2CreateExecutionActionProposalInput.safeParse({
          idempotency_key: `missing-${action_type}`,
          message: "Record this explicit mockup decision.",
          action_type,
          payload: { parameters: missingHash },
        }).success,
      ).toBe(false);
    }
  });

  it("stores only a reference in the visible mockup card", () => {
    const message = {
      schema_version: 2,
      id: "message-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      initiated_by_user_id: "user-1",
      actor: { actor_type: "agent", actor_id: "pm-1" },
      role: "assistant",
      visibility_status: "complete",
      sequence: 1,
      parts: [{ type: "mockup", mockup_version_id: version.id }],
      client_message_id: null,
      request_fingerprint: null,
      created_at: NOW,
    } as const;
    expect(V2WorkMessage.safeParse(message).success).toBe(true);
    expect(
      V2WorkMessage.safeParse({
        ...message,
        parts: [{ type: "mockup", mockup_version_id: version.id, html: "<script />" }],
      }).success,
    ).toBe(false);
  });

  it("never describes publication alone as a successful deployment", () => {
    const deployment = {
      schema_version: 2,
      id: "deployment-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      repository_binding_id: "repository-1",
      environment: "production",
      service: "web",
      commit_sha: COMMIT,
      provider_id: "railway",
      provider_deployment_id: "railway-deployment-1",
      status: "succeeded",
      current_observation_sequence: 2,
      public_url: "https://norns.example.test",
      health_url: "https://norns.example.test/health",
      health_status_code: 200,
      evidence: artifact("deployment-evidence-1", HASH_A, "application/json", "Deployment receipt"),
      started_at: NOW,
      completed_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    } as const;
    expect(V2ProjectDeployment.safeParse(deployment).success).toBe(true);
    expect(V2ProjectDeployment.safeParse({ ...deployment, evidence: null }).success).toBe(false);
    expect(V2ProjectDeployment.safeParse({ ...deployment, health_status_code: 503 }).success).toBe(
      false,
    );
    expect(
      V2ProjectDeployment.safeParse({
        ...deployment,
        status: "pending",
        completed_at: null,
        evidence: artifact("deployment-log", HASH_A, "text/plain", "Deployment log"),
      }).success,
    ).toBe(false);
  });

  it("requires attributed deployment observations and public HTTPS probe targets", () => {
    const observation = {
      schema_version: 2,
      id: "observation-1",
      deployment_record_id: "deployment-1",
      project_id: "project-1",
      sequence: 2,
      status: "succeeded",
      public_url: "https://norns.example.test",
      health_url: "https://norns.example.test/health",
      health_status_code: 200,
      evidence: artifact("deployment-evidence-1", HASH_A, "application/json", "Deployment receipt"),
      source_type: "provider",
      source_id: "railway",
      provider_event_id: "railway-event-1",
      observed_at: NOW,
      created_at: NOW,
    } as const;
    expect(V2ProjectDeploymentObservation.safeParse(observation).success).toBe(true);
    expect(
      V2ProjectDeploymentObservation.safeParse({
        ...observation,
        provider_event_id: null,
      }).success,
    ).toBe(false);
    expect(
      V2ProjectDeploymentObservation.safeParse({
        ...observation,
        source_type: "system",
      }).success,
    ).toBe(false);
    expect(
      V2RecordProjectDeploymentObservationInput.safeParse({
        project_id: "project-1",
        delivery_record_id: "deployment-1",
        expected_sequence: 2,
        status: "deploying",
        provider_id: "railway",
        provider_event_id: "event-2",
        public_url: "https://example.test",
        health_url: "https://169.254.169.254/latest/meta-data",
        health_status_code: null,
        evidence: null,
        observed_at: NOW,
        idempotency_key: "observation-key",
      }).success,
    ).toBe(false);
    expect(
      V2RecordProjectDeploymentObservationInput.safeParse({
        project_id: "project-1",
        delivery_record_id: "deployment-1",
        expected_sequence: 2,
        status: "deploying",
        provider_event_id: "event-without-provider",
        public_url: null,
        health_url: null,
        health_status_code: null,
        evidence: null,
        observed_at: NOW,
        idempotency_key: "observation-key-without-provider",
      }).success,
    ).toBe(false);
    const receipt = {
      schema_version: 2,
      kind: "deployment_observation",
      delivery_record_id: observation.deployment_record_id,
      project_id: observation.project_id,
      provider_id: observation.source_id,
      provider_deployment_id: "railway-deployment-1",
      commit_sha: COMMIT,
      environment: "production",
      service: "web",
      sequence: observation.sequence,
      status: observation.status,
      source_type: observation.source_type,
      source_id: observation.source_id,
      provider_event_id: observation.provider_event_id,
      public_url: observation.public_url,
      health_url: observation.health_url,
      health_status_code: observation.health_status_code,
      observed_at: observation.observed_at,
    } as const;
    expect(V2DeploymentObservationEvidenceReceipt.safeParse(receipt).success).toBe(true);
    expect(
      V2DeploymentObservationEvidenceReceipt.safeParse({
        ...receipt,
        injected_provider_token: "secret",
      }).success,
    ).toBe(false);
    expect(
      V2DeploymentObservationEvidenceReceipt.safeParse({
        ...receipt,
        source_id: "different-provider",
      }).success,
    ).toBe(false);
    expect(
      V2DeploymentObservationEvidenceReceipt.safeParse({
        ...receipt,
        commit_sha: "e".repeat(64),
      }).success,
    ).toBe(true);
    for (const unsafeUrl of [
      "https://localhost/private",
      "https://127.1/private",
      "https://2130706433/private",
      "https://169.254.169.254/latest/meta-data",
      "https://[::]/private",
      "https://[::ffff:127.0.0.1]/private",
      "https://[fe90::1]/private",
      "https://[fea0::1]/private",
      "https://[feb0::1]/private",
      "https://[ff02::1]/private",
      "https://[2001:db8::1]/private",
    ]) {
      expect(V2PublicHttpsUrl.safeParse(unsafeUrl).success, unsafeUrl).toBe(false);
    }
    expect(V2PublicHttpsUrl.safeParse("https://[2606:4700:4700::1111]/health").success).toBe(true);
  });

  it("binds a strict approved mockup supplement and its exact command receipt", () => {
    const content = {
      schema_version: 2,
      kind: "approved_mockup",
      mockup_version_id: version.id,
      manifest_artifact_id: version.manifest.artifact_id,
      manifest_artifact_hash: version.manifest.content_hash,
      approval: {
        decision_id: "decision-1",
        action_id: "approval-action-1",
        decided_by_user_id: "user-1",
        decided_at: NOW,
      },
      brief: version.brief,
      target: version.target,
      interaction_notes: version.interaction_notes,
      renderer_profile: profile,
      screenshots: version.screenshots,
    } as const;
    const supplement = {
      schema_version: 2,
      id: "supplement-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      task_id: "task-1",
      base_package_id: "package-1",
      ordinal: 1,
      source_mockup_version_id: version.id,
      approval_decision_id: "decision-1",
      manifest_artifact_id: version.manifest.artifact_id,
      manifest_artifact_hash: version.manifest.content_hash,
      supplement: content,
      canonical_supplement: stableJson(content),
      content_hash: HASH_A,
      context_ref: {
        context_document_id: "context-1",
        content_hash: HASH_A,
        byte_size: 1024,
        media_type: "application/json",
      },
      created_at: NOW,
    } as const;
    expect(V2ConversationTaskPackageSupplement.safeParse(supplement).success).toBe(true);
    expect(
      V2ConversationTaskPackageSupplement.safeParse({
        ...supplement,
        canonical_supplement: JSON.stringify(content),
      }).success,
    ).toBe(false);
    expect(
      V2ConversationTaskPackageSupplement.safeParse({
        ...supplement,
        context_ref: { ...supplement.context_ref, media_type: "text/plain" },
      }).success,
    ).toBe(false);
    expect(
      V2ConversationTaskPackageSupplement.safeParse({
        ...supplement,
        supplement: {
          ...content,
          screenshots: [
            {
              ...content.screenshots[0],
              artifact: {
                ...content.screenshots[0].artifact,
                artifact_id: content.manifest_artifact_id,
              },
            },
            content.screenshots[1],
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      V2ConversationTaskPackageSupplement.safeParse({
        ...supplement,
        supplement: {
          ...content,
          screenshots: [content.screenshots[0], content.screenshots[0]],
        },
      }).success,
    ).toBe(false);

    const receipt = {
      schema_version: 2,
      command_id: "command-1",
      run_id: "run-1",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      base_package_id: "package-1",
      supplement_id: "supplement-1",
      ordinal: 1,
      content_hash: HASH_A,
      context_document_id: "context-1",
      context_ref: {
        artifact_id: "context-1",
        content_hash: HASH_A,
        byte_size: 1024,
        storage_ref: "https://norns.example.test/api/v2/execution/task-context/context-1",
      },
      created_at: NOW,
    } as const;
    expect(V2ConversationTaskPackageSupplementDispatchReceipt.safeParse(receipt).success).toBe(
      true,
    );
    expect(
      V2ConversationTaskPackageSupplementDispatchReceipt.safeParse({
        ...receipt,
        context_ref: { ...receipt.context_ref, artifact_id: "other-context" },
      }).success,
    ).toBe(false);
  });

  it("models source unavailability separately from authoritative empty dashboard data", () => {
    const dashboard = {
      schema_version: 2,
      project_id: "project-1",
      generated_at: NOW,
      active_work: {
        availability: "available",
        source: "workflow_state",
        observed_at: NOW,
        data: [],
      },
      needs_attention: unavailable("attention_projection"),
      open_decisions: unavailable("human_waits_and_decisions"),
      budget: unavailable("usage_ledger_and_approved_plan"),
      coding_metrics: unavailable("coding_metrics"),
      recent_deployments: unavailable("deployment_observations"),
      recent_verification: unavailable("verification_results"),
      conversations: unavailable("work_conversations"),
      approved_mockups: unavailable("mockup_decisions"),
      recent_artifacts: unavailable("artifact_metadata"),
      legacy_planning_runs: unavailable("legacy_planning_runs"),
    } as const;
    expect(V2ProjectDashboard.safeParse(dashboard).success).toBe(true);
    expect(
      V2ProjectDashboard.safeParse({
        ...dashboard,
        budget: {
          availability: "available",
          source: "usage_ledger_and_approved_plan",
          observed_at: NOW,
          data: {
            current_spend_usd: 12,
            projected_budget_usd: null,
            projection_source: "usage_and_plan",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      V2ProjectDashboard.safeParse({
        ...dashboard,
        active_work: {
          ...unavailable("workflow_state"),
          data: [],
        },
      }).success,
    ).toBe(false);
    expect(
      V2ProjectDashboard.safeParse({
        ...dashboard,
        approved_mockups: {
          availability: "available",
          source: "mockup_decisions",
          observed_at: NOW,
          data: [{ ...version, status: "candidate" }],
        },
      }).success,
    ).toBe(false);
    expect(
      V2ProjectDashboard.safeParse({
        ...dashboard,
        approved_mockups: {
          availability: "available",
          source: "mockup_decisions",
          observed_at: NOW,
          data: [{ ...version, status: "approved", project_id: "other-project" }],
        },
      }).success,
    ).toBe(false);
    expect(
      V2ProjectDashboard.safeParse({
        ...dashboard,
        active_work: {
          availability: "available",
          source: "workflow_state",
          observed_at: NOW,
          data: [
            {
              work_item: {
                schema_version: 2,
                id: "work-1",
                project_id: "project-1",
                created_by_user_id: "user-1",
                title: "Completed work",
                objective: "Should not be active",
                status: "completed",
                planning_run_id: null,
                phase_id: "phase-1",
                approved_plan_version_id: "plan-1",
                aggregate_version: 1,
                created_at: NOW,
                updated_at: NOW,
                execution_started_at: NOW,
                completed_at: NOW,
              },
              phase_progress: {
                phase_id: "other-phase",
                percent_complete: 100,
                tasks_completed: 1,
                tasks_total: 1,
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps project coding metrics outcome-normalized and internally bounded", () => {
    const metrics = {
      project_id: "project-1",
      total_tasks: 2,
      completed_tasks: 1,
      completed_tasks_last_30_days: 1,
      terminal_runs: 2,
      active_coding_seconds: 900,
      time_to_verified_delivery: {
        sample_size: 1,
        median_seconds: 1200,
        p75_seconds: 1200,
      },
      first_pass_yield: { completed_tasks: 1, first_pass_tasks: 1, rate: 1 },
      tokens_per_accepted_task: {
        accepted_tasks: 1,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 25,
        cache_write_tokens: 5,
        reasoning_tokens: null,
        total_tokens: 120,
        per_accepted_task: 120,
      },
      cost_per_accepted_task: {
        accepted_tasks: 1,
        priced_runs: 2,
        total_runs: 2,
        coverage_rate: 1,
        total_cost_usd: 1.25,
        per_accepted_task_usd: 1.25,
      },
      rework_ratio: { total_tokens: 120, rework_tokens: 0, rate: 0 },
      change_failure_rate: { terminal_deployments: 1, failed_deployments: 0, rate: 0 },
      phase_breakdown: [],
      agent_breakdown: [],
      task_breakdown: [],
    } as const;

    expect(V2ProjectCodingMetrics.safeParse(metrics).success).toBe(true);
    expect(
      V2ProjectCodingMetrics.safeParse({
        ...metrics,
        rework_ratio: { total_tokens: 120, rework_tokens: 121, rate: 1 },
      }).success,
    ).toBe(false);
    expect(
      V2ProjectCodingMetrics.safeParse({
        ...metrics,
        change_failure_rate: { terminal_deployments: 1, failed_deployments: 2, rate: 1 },
      }).success,
    ).toBe(false);
  });

  it("caps artifact upload classes and makes quota outcomes self-consistent", () => {
    expect(
      V2MockupArtifactUploadInput.safeParse({
        project_id: "project-1",
        work_item_id: "work-1",
        conversation_id: "conversation-1",
        media_type: "image/png",
        purpose: "mockup_desktop",
        content_hash: HASH_A,
        byte_size: 1024,
        idempotency_key: "upload-1",
      }).success,
    ).toBe(true);
    expect(
      V2MockupArtifactUploadInput.safeParse({
        project_id: "project-1",
        work_item_id: "work-1",
        conversation_id: "conversation-1",
        media_type: "image/svg+xml",
        purpose: "mockup_desktop",
        content_hash: HASH_A,
        byte_size: 1024,
        idempotency_key: "upload-2",
      }).success,
    ).toBe(false);
    expect(
      V2ProjectArtifactQuotaReceipt.safeParse({
        project_id: "project-1",
        limit_bytes: 100,
        used_bytes_before: 90,
        requested_bytes: 20,
        allowed: true,
      }).success,
    ).toBe(false);
    expect(
      V2CreateExecutionActionProposalInput.safeParse({
        idempotency_key: "duplicate-artifact-refs",
        message: "Create a mockup from exact artifacts.",
        action_type: "create_mockup",
        payload: {
          parameters: {
            brief: "Create a strict mockup.",
            target: "responsive",
            task_id: "task-1",
            artifact_refs: ["artifact-1", "artifact-1"],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires exact verification and deployment provenance for delivered visuals", () => {
    const capture = {
      renderer: "playwright",
      browser_name: "chromium",
      browser_version: "130.0",
      font_revision: HASH_A,
      pixel_ratio: 1,
      network: "application_only",
      locale: "en-US",
      timezone: "UTC",
      fixed_clock: NOW,
    } as const;
    const visual = {
      schema_version: 2,
      id: "visual-1",
      project_id: "project-1",
      work_item_id: "work-1",
      conversation_id: "conversation-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      approved_mockup_version_id: version.id,
      repository_binding_id: "repository-1",
      verification_result_id: "verification-1",
      deployment_record_id: "deployment-1",
      deployment_observation_id: "observation-1",
      commit_sha: COMMIT,
      capture_profile: capture,
      screenshots: [
        {
          viewport: "desktop",
          artifact: artifact("delivered-desktop", HASH_A, "image/png", "Delivered desktop"),
          width: 1440,
          height: 1024,
          capture_profile: capture,
        },
        {
          viewport: "mobile",
          artifact: artifact("delivered-mobile", HASH_B, "image/png", "Delivered mobile"),
          width: 390,
          height: 844,
          capture_profile: capture,
        },
      ],
      comparison_artifact: null,
      verified_at: NOW,
      created_at: NOW,
    } as const;
    expect(V2ImplementationVisualEvidence.safeParse(visual).success).toBe(true);
    expect(
      V2ImplementationVisualEvidence.safeParse({
        ...visual,
        screenshots: [visual.screenshots[0], visual.screenshots[0]],
      }).success,
    ).toBe(false);
    const { deployment_observation_id: _, ...missingObservation } = visual;
    expect(V2ImplementationVisualEvidence.safeParse(missingObservation).success).toBe(false);
    expect(
      V2ImplementationVisualEvidence.safeParse({
        ...visual,
        commit_sha: "e".repeat(64),
      }).success,
    ).toBe(true);
    const comparison = {
      schema_version: 2,
      kind: "visual_comparison",
      implementation_visual_evidence_id: visual.id,
      approved_mockup_version_id: visual.approved_mockup_version_id,
      commit_sha: visual.commit_sha,
      comparisons: [
        {
          viewport: "desktop",
          mockup_artifact_id: version.screenshots[0].artifact.artifact_id,
          mockup_artifact_hash: version.screenshots[0].artifact.content_hash,
          implementation_artifact_id: visual.screenshots[0].artifact.artifact_id,
          implementation_artifact_hash: visual.screenshots[0].artifact.content_hash,
        },
        {
          viewport: "mobile",
          mockup_artifact_id: version.screenshots[1].artifact.artifact_id,
          mockup_artifact_hash: version.screenshots[1].artifact.content_hash,
          implementation_artifact_id: visual.screenshots[1].artifact.artifact_id,
          implementation_artifact_hash: visual.screenshots[1].artifact.content_hash,
        },
      ],
    } as const;
    expect(V2VisualComparisonReceipt.safeParse(comparison).success).toBe(true);
    expect(
      V2VisualComparisonReceipt.safeParse({
        ...comparison,
        comparisons: [
          {
            ...comparison.comparisons[0],
            implementation_artifact_id: comparison.comparisons[0].mockup_artifact_id,
          },
          comparison.comparisons[1],
        ],
      }).success,
    ).toBe(false);
  });
});
