import type {
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2ConversationMessageBranchT,
  V2ConversationMockupVersionT,
  V2ConversationPlanActionEffectT,
  V2ConversationPlanReviewT,
  V2ConversationPmUpdateSettingsT,
  V2ConversationPmUpdateT,
  V2HumanWaitAnswerT,
  V2HumanWaitContinuationT,
  V2HumanWaitT,
  V2WorkConversationT,
  V2WorkItemT,
  V2WorkMessageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { V2_HUMAN_WAIT_INSTRUCTION_HASH } from "@norns/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationWorkspace } from "./ConversationWorkspace";
import { makeCoreApiModule, makePlan, makeWebUiModule } from "./test/fixtures";

const projectId = "project-conversation";
const workItemId = "work-item-1";
const conversationId = "conversation-1";
const now = "2026-07-27T12:00:00.000Z";

const workItem: V2WorkItemT = {
  schema_version: 2,
  id: workItemId,
  project_id: projectId,
  created_by_user_id: "user-1",
  title: "# Conversation-first planning",
  objective: "Plan a durable project conversation.",
  status: "planning",
  planning_run_id: null,
  phase_id: null,
  approved_plan_version_id: null,
  aggregate_version: 1,
  created_at: now,
  updated_at: now,
  execution_started_at: null,
  completed_at: null,
};

const conversation: V2WorkConversationT = {
  schema_version: 2,
  id: conversationId,
  project_id: projectId,
  work_item_id: workItemId,
  created_by_user_id: "user-1",
  kind: "planning",
  status: "active",
  provider: "anthropic",
  model: "claude-sonnet-5",
  next_message_sequence: 3,
  created_at: now,
  updated_at: now,
  archived_at: null,
};

function executionConversation(overrides: Partial<V2WorkConversationT> = {}): V2WorkConversationT {
  return {
    ...conversation,
    id: "execution-conversation-1",
    kind: "execution_pm",
    provider: "openai",
    model: "gpt-5.6-sol",
    next_message_sequence: 2,
    ...overrides,
  };
}

function mockupVersion(
  version = 1,
  supersedesMockupVersionId: string | null = null,
): V2ConversationMockupVersionT {
  const renderer = {
    renderer: "norns-deterministic-v1" as const,
    renderer_revision: "a".repeat(64),
    font_revision: "b".repeat(64),
    pixel_ratio: 1 as const,
    network: "disabled" as const,
    scripts: "disabled" as const,
    locale: "en-US" as const,
    timezone: "UTC" as const,
    fixed_clock: now,
    seed: "c".repeat(64),
  };
  const id = `mockup-version-${version}`;
  return {
    schema_version: 2,
    id,
    root_request_id: "mockup-request-1",
    request_id: `mockup-request-${version}`,
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    task_id: "core-api",
    plan_version_id: null,
    module_id: null,
    created_by_action_id: `mockup-action-${version}`,
    version,
    status: "candidate",
    brief: "Show the conversation-first project workspace.",
    target: "responsive",
    interaction_notes: ["Approval remains an explicit project action."],
    manifest: {
      artifact_id: `manifest-${version}`,
      content_hash: "d".repeat(64),
      media_type: "application/json",
      label: `Mockup manifest v${version}`,
    },
    renderer_profile: renderer,
    screenshots: [
      {
        viewport: "desktop",
        artifact: {
          artifact_id: `desktop-${version}`,
          content_hash: "e".repeat(64),
          media_type: "image/png",
          label: `Desktop v${version}`,
        },
        width: 1440,
        height: 1024,
        capture_profile: renderer,
      },
      {
        viewport: "mobile",
        artifact: {
          artifact_id: `mobile-${version}`,
          content_hash: "f".repeat(64),
          media_type: "image/png",
          label: `Mobile v${version}`,
        },
        width: 390,
        height: 844,
        capture_profile: renderer,
      },
    ],
    supersedes_mockup_version_id: supersedesMockupVersionId,
    created_at: now,
  };
}

function humanWait(overrides: Partial<V2HumanWaitT> = {}): V2HumanWaitT {
  const hash = "a".repeat(64);
  const execution = executionConversation();
  return {
    schema_version: 2,
    id: "wait-1",
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: execution.id,
    phase_id: "phase-1",
    task_id: "task-1",
    source_run_id: "run-1",
    source_event_id: "event-ask-1",
    decision_point: "Choose the deployment window",
    question: "Should the migration run before the deployment?",
    question_hash: hash,
    published: {
      branch: "phase5/wait-1",
      commit_sha: hash,
      remote: "origin",
    },
    runtime: {
      runtime_id: "runtime-1",
      session_id: null,
      session_portability: "transcript_only",
      session_portability_evidence: null,
    },
    context: {
      root_command_id: "root-command-1",
      ask_channel_version: 1,
      ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
      root_context_refs: [
        {
          artifact_id: "context-artifact-1",
          content_hash: hash,
          byte_size: 64,
          storage_ref: "artifacts/context-1.json",
        },
      ],
      context_hash: hash,
      task_package_hash: hash,
      compact_summary: "The migration is ready and waiting on its deployment window.",
      compact_summary_hash: hash,
    },
    budget: {
      reservation_id: "reservation-1",
      root_run_id: "root-run-1",
    },
    status: "awaiting_human",
    version: 1,
    expires_at: "2026-07-28T12:00:00.000Z",
    answered_at: null,
    resumed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function planVersion(overrides: Partial<V2WorkPlanVersionT> = {}): V2WorkPlanVersionT {
  const module = makeCoreApiModule();
  return {
    schema_version: 2,
    id: "plan-version-1",
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    created_by_user_id: "user-1",
    version: 1,
    status: "candidate",
    origin: "human",
    plan: {
      plan: makePlan({
        objective: "Deliver conversation-first planning",
        modules: [module],
        risks: [
          {
            description: "A stale approval could start the wrong work.",
            mitigation: "Bind actions to the exact immutable content hash.",
          },
        ],
      }),
      staffing: [
        {
          module_id: module.id,
          agent_role: "implementation",
          provider: "openai",
          model: "gpt-5.6",
        },
      ],
      verification_requirements: ["pnpm --filter @norns/web test"],
      open_decisions: ["Confirm the launch window."],
      estimated_budget: { currency: "USD", amount: 42 },
    },
    content_hash: "a".repeat(64),
    created_by_action_id: "action-save-1",
    supersedes_plan_version_id: null,
    diff_from_previous: null,
    approved_by_user_id: null,
    approved_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function handoffFor(
  version: V2WorkPlanVersionT,
  targetConversationId = "execution-conversation-1",
) {
  return {
    schema_version: 2 as const,
    id: "handoff-1",
    project_id: projectId,
    work_item_id: workItemId,
    source_conversation_id: conversationId,
    target_conversation_id: targetConversationId,
    approved_plan_version_id: version.id,
    created_by_user_id: "user-1",
    kind: "planning_to_execution" as const,
    package: {
      approved_plan_version_id: version.id,
      approved_plan_content_hash: version.content_hash,
      approved_plan: version.plan,
      objective: version.plan.plan.objective,
      binding_rules: ["Keep the execution conversation task-scoped."],
      human_decisions: [
        {
          id: "decision-1",
          summary: "Use the existing coordinator.",
          rationale: "It already owns delivery state.",
        },
      ],
      qc_findings_and_dispositions: [],
      unresolved_risks_and_questions: ["Confirm the production rollout window."],
      task_sequence: version.plan.plan.modules.map((module) => module.id),
      staffing: version.plan.staffing,
      budget: version.plan.estimated_budget,
      required_mockup_artifact_ids: [],
      acceptance_evidence: ["Focused and repository-wide tests pass."],
      artifact_ids: ["artifact-approved-mockup"],
      phase_ids: [],
      task_ids: [],
      repository_binding_ids: ["repository-main"],
      context_manifest: [
        {
          kind: "approved_plan" as const,
          ref: version.id,
          content_hash: version.content_hash,
        },
      ],
    },
    content_hash: "e".repeat(64),
    created_at: now,
  };
}

function compactSummary(targetConversationId = "execution-conversation-1") {
  return {
    schema_version: 2 as const,
    id: "summary-1",
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: targetConversationId,
    created_by_user_id: "user-1",
    version: 1,
    from_message_sequence: 1,
    through_message_sequence: 7,
    summary: {
      objective: "Deliver conversation-first planning without replaying the full transcript.",
      constraints: ["Use the existing provider gateway.", "Keep explicit action cards."],
      decisions: [],
      risks: ["Execution kickoff can fail after approval."],
      open_questions: [],
      artifact_ids: ["artifact-approved-mockup"],
    },
    content_hash: "f".repeat(64),
    created_at: now,
  };
}

function planAction(overrides: Partial<V2ConversationActionT> = {}): V2ConversationActionT {
  const status = overrides.status ?? "proposed";
  const confirmed = !["proposed", "rejected"].includes(status);
  return {
    schema_version: 2,
    id: "action-qc-1",
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    initiated_by_user_id: "user-1",
    actor: { actor_type: "agent", actor_id: "project-pm" },
    source_message_id: "message-action",
    action_type: "send_plan_to_qc",
    interaction_class: overrides.interaction_class ?? "approval",
    payload: {
      parameters: {
        plan_version_id: "plan-version-1",
        content_hash: "a".repeat(64),
      },
    },
    payload_hash: "b".repeat(64),
    status,
    confirmed_by_user_id: confirmed ? "user-1" : null,
    confirmation_idempotency_key: confirmed ? "confirm-action-qc-1" : null,
    confirmation_request_fingerprint: confirmed ? "c".repeat(64) : null,
    confirmed_at: confirmed ? now : null,
    recorded_at: status === "applied" ? now : null,
    sent_at: status === "applied" ? now : null,
    acknowledged_at: status === "applied" ? now : null,
    applied_at: status === "applied" ? now : null,
    failure_code: status === "failed" ? "action_failed" : null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function planReview(overrides: Partial<V2ConversationPlanReviewT> = {}): V2ConversationPlanReviewT {
  return {
    schema_version: 2,
    id: "review-1",
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    action_id: "action-qc-1",
    plan_version_id: "plan-version-1",
    planning_run_id: "planning-run-1",
    usage_request_group_id: "usage-request-group-review-1",
    initiated_by_user_id: "user-1",
    attempt_number: 1,
    pm_provider: "anthropic",
    pm_model: "claude-sonnet-5",
    reviewer_provider: "openai",
    reviewer_model: "gpt-5.6",
    revision_format: "legacy_full",
    status: "converged",
    qc_mode: "automatic",
    qc_mode_source: "project_default",
    allow_unadjudicated_rebuttals: false,
    human_steered_rounds: [],
    paused_checkpoint: null,
    paused_at_round: null,
    rounds_completed: 1,
    max_rounds: 3,
    round_exchanges: [],
    chat_messages: [],
    markdown_artifacts: [],
    plan_content_hash: "a".repeat(64),
    result_plan_content_hash: "a".repeat(64),
    context_manifest: { entries: [], context_hash: "d".repeat(64) },
    findings: [
      {
        id: "finding-1",
        index: 0,
        severity: "should_fix",
        module_id: "core-api",
        finding: "Make cancellation verification explicit.",
        recommendation: "Add a cancellation telemetry test.",
      },
    ],
    dispositions: [
      {
        finding_id: "finding-1",
        finding_index: 0,
        disposition: "accept",
        rationale: "Added the requested telemetry assertion.",
        adjudication: null,
      },
    ],
    revised_plan_version_id: null,
    started_at: now,
    completed_at: now,
    failure_code: null,
    cancelled_by_user_id: null,
    cancellation_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function message(
  overrides: Pick<V2WorkMessageT, "id" | "role" | "sequence" | "parts"> & Partial<V2WorkMessageT>,
): V2WorkMessageT {
  const isUser = overrides.role === "user";
  return {
    schema_version: 2,
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    initiated_by_user_id: "user-1",
    actor: isUser
      ? { actor_type: "human", actor_id: "user-1" }
      : { actor_type: "agent", actor_id: "project-pm" },
    visibility_status: "complete",
    client_message_id: isUser ? `client-${overrides.id}` : null,
    request_fingerprint: isUser ? "a".repeat(64) : null,
    created_at: now,
    ...overrides,
  };
}

function listResponse(): Response {
  return Response.json({
    work_items: [{ work_item: workItem, conversations: [conversation] }],
  });
}

function detailResponse(
  messages: V2WorkMessageT[] = [],
  activeAttempt: unknown = null,
  retryableAttempt: unknown = null,
  resources: {
    workItem?: V2WorkItemT;
    conversation?: V2WorkConversationT;
    planVersions?: V2WorkPlanVersionT[];
    actions?: V2ConversationActionT[];
    reviews?: V2ConversationPlanReviewT[];
    effects?: V2ConversationPlanActionEffectT[];
    runsQc?: boolean;
    handoff?: unknown;
    latestSummary?: unknown;
    usage?: unknown;
    excerptReceipts?: unknown[];
    humanWaits?: Array<{
      wait: V2HumanWaitT;
      answer: V2HumanWaitAnswerT | null;
      continuation: V2HumanWaitContinuationT | null;
    }>;
    deliveryEvents?: V2ConversationActionDeliveryEventT[];
    pmUpdates?: V2ConversationPmUpdateT[];
    pmUpdateSettings?: V2ConversationPmUpdateSettingsT | null;
    branchLineage?: V2ConversationMessageBranchT | null;
  } = {},
): Response {
  return Response.json({
    work_item: resources.workItem ?? workItem,
    conversation: resources.conversation ?? conversation,
    messages,
    active_attempt: activeAttempt,
    retryable_attempt: retryableAttempt,
    plan_versions: resources.planVersions ?? [],
    actions: resources.actions ?? [],
    plan_reviews: resources.reviews ?? [],
    action_effects: resources.effects ?? [],
    project_runs_qc: resources.runsQc ?? false,
    handoff: resources.handoff ?? null,
    latest_summary: resources.latestSummary ?? null,
    usage:
      resources.usage ??
      ({
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: null,
        exact_cost: false,
        usage_status: "unavailable",
        attempt_count: 0,
      } as const),
    planning_excerpt_receipts: resources.excerptReceipts ?? [],
    human_waits: resources.humanWaits ?? [],
    action_delivery_events: resources.deliveryEvents ?? [],
    pm_updates: resources.pmUpdates ?? [],
    pm_update_settings: resources.pmUpdateSettings ?? null,
    branch_lineage: resources.branchLineage ?? null,
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("conversation workspace", () => {
  it("shows conversation loading immediately and recovers from a failed list request", async () => {
    let listAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) {
        listAttempts += 1;
        return listAttempts === 1
          ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
          : listResponse();
      }
      if (url.endsWith(`/conversations/${conversationId}`)) {
        return detailResponse([
          message({
            id: "message-recovered",
            role: "assistant",
            sequence: 1,
            parts: [{ type: "text", format: "markdown", text: "Conversation recovered." }],
          }),
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationWorkspace
        projectId={projectId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(screen.getByText("Loading conversations…")).toBeInTheDocument();
    expect(screen.getByText("Loading work items…")).toBeInTheDocument();
    expect(await screen.findByText("Conversations could not be loaded.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Conversation recovered.")).toBeInTheDocument();
    expect(listAttempts).toBe(2);
  });

  it("restores durable visible history, structured parts, and the pinned PM", async () => {
    const history = [
      message({
        id: "message-user",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "markdown", text: "Please inspect the API." }],
      }),
      message({
        id: "message-assistant",
        role: "assistant",
        sequence: 2,
        parts: [
          { type: "text", format: "markdown", text: "I found **one risk**." },
          { type: "code", language: "ts", code: "const durable = true;" },
          {
            type: "artifact",
            artifact_id: "artifact-1",
            label: "API review",
            media_type: "text/markdown",
          },
          { type: "mockup", mockup_version_id: "mockup-version-1" },
        ],
      }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(history);
      if (url.endsWith("/mockups/mockup-version-1")) return Response.json(mockupVersion());
      if (url.includes("/artifacts/") && url.endsWith("/content")) {
        return new Response(new Blob(["png"], { type: "image/png" }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const clipboardWrite = vi
      .spyOn(window.navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    const view = render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Please inspect the API.")).toBeInTheDocument();
    expect(screen.getByText("one risk")).toBeInTheDocument();
    expect(screen.getByText("const durable = true;")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-artifact")).toHaveTextContent("API review");
    expect(await screen.findByRole("heading", { name: "Mockup version 1" })).toBeInTheDocument();
    expect(screen.getByText("Approval remains an explicit project action.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revise" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    const conversationHeader = document.querySelector(".conversation-thread-chrome");
    expect(conversationHeader?.querySelector(".conversation-header-identity > span")).toBeNull();
    expect(screen.queryByRole("region", { name: "Planning workflow" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("combobox", { name: "Conversation model" })).toHaveValue(
      "claude-sonnet-5",
    );
    expect(document.querySelector(".conversation-header")).toContainElement(
      screen.getByRole("combobox", { name: "Conversation model" }),
    );
    expect(
      screen.getByRole("heading", { name: "Conversation-first planning" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("# Conversation-first planning", { exact: true }),
    ).not.toBeInTheDocument();
    const combinedHeader = document.querySelector(".conversation-thread-chrome");
    expect(combinedHeader).not.toContainElement(screen.queryByText("UI preview", { exact: true }));
    expect(combinedHeader).not.toContainElement(
      screen.getByRole("button", { name: "Use conversation as plan" }),
    );
    expect(screen.getByRole("button", { name: "Use conversation as plan" })).toHaveTextContent(
      "Plan",
    );
    expect(screen.getByRole("button", { name: "Add file" })).toHaveTextContent("+");
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy last response" }));
    expect(clipboardWrite).toHaveBeenCalledWith(
      "I found **one risk**.\n\n```ts\nconst durable = true;\n```",
    );
    expect(screen.queryByTestId("conversation-welcome")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry response" })).not.toBeInTheDocument();

    const workspaceReadsBeforeParentRerender = fetchMock.mock.calls.filter(([input]) => {
      const url = urlOf(input);
      return url.endsWith("/work-items") || url.endsWith(`/conversations/${conversationId}`);
    }).length;
    view.rerender(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(
      fetchMock.mock.calls.filter(([input]) => {
        const url = urlOf(input);
        return url.endsWith("/work-items") || url.endsWith(`/conversations/${conversationId}`);
      }),
    ).toHaveLength(workspaceReadsBeforeParentRerender);
    expect(screen.getByText("Please inspect the API.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("combobox", { name: "Conversation model" })).toHaveValue(
      "claude-sonnet-5",
    );
  });

  it("presents attributable human, PM, worker, runner, coordinator, and system actors", async () => {
    const actors = [
      message({
        id: "actor-human",
        role: "user",
        sequence: 1,
        actor: { actor_type: "human", actor_id: "user-1" },
        parts: [{ type: "text", format: "markdown", text: "Human direction" }],
      }),
      message({
        id: "actor-pm",
        role: "assistant",
        sequence: 2,
        actor: { actor_type: "agent", actor_id: "pm:conversation-1" },
        parts: [{ type: "text", format: "markdown", text: "PM response" }],
      }),
      message({
        id: "actor-worker",
        role: "assistant",
        sequence: 3,
        actor: { actor_type: "agent", actor_id: "worker:api" },
        parts: [{ type: "text", format: "markdown", text: "Worker response" }],
      }),
      message({
        id: "actor-runner",
        role: "assistant",
        sequence: 4,
        actor: { actor_type: "runner", actor_id: "runner:task-1" },
        parts: [{ type: "text", format: "markdown", text: "Runner response" }],
      }),
      message({
        id: "actor-coordinator",
        role: "assistant",
        sequence: 5,
        actor: { actor_type: "coordinator", actor_id: "qc:review-1" },
        parts: [{ type: "text", format: "markdown", text: "Coordinator response" }],
      }),
      message({
        id: "actor-system",
        role: "system",
        sequence: 6,
        actor: { actor_type: "system", actor_id: null },
        parts: [{ type: "text", format: "plain", text: "System event" }],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(actors);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      (await screen.findByText("Human direction")).closest(".conversation-message"),
    ).toHaveClass("actor-human");
    expect(screen.getByTitle("pm:conversation-1").closest(".conversation-message")).toHaveClass(
      "actor-pm",
    );
    expect(screen.getByTitle("worker:api")).toHaveTextContent("Agent");
    expect(screen.getByTitle("worker:api").closest(".conversation-message")).toHaveClass(
      "actor-agent",
    );
    expect(screen.getByTitle("runner:task-1")).toHaveTextContent("Runner");
    expect(screen.getByTitle("qc:review-1")).toHaveTextContent("Coordinator");
    expect(screen.getByText("System event").closest(".conversation-message")).toHaveClass(
      "actor-system",
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();
  });

  it("pastes an image, preserves its filename and MIME, previews it, and removes it", async () => {
    const NativeURL = URL;
    class ObjectURL extends NativeURL {
      static createObjectURL(): string {
        return "blob:conversation-image-preview";
      }

      static revokeObjectURL(): void {}
    }
    vi.stubGlobal("URL", ObjectURL);
    const uploads: Array<{ headers: Headers; body: BodyInit | null | undefined }> = [];
    let removed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
        if (url.endsWith("/attachments") && init?.method === "POST") {
          uploads.push({ headers: new Headers(init.headers), body: init.body });
          return Response.json({ id: "attachment-image" }, { status: 201 });
        }
        if (url.endsWith("/attachments/attachment-image") && init?.method === "DELETE") {
          removed = true;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    const image = new File(["png"], "launch-map.png", { type: "image/png" });
    fireEvent.paste(composer, { clipboardData: { files: [image] } });

    expect(await screen.findByText("launch-map.png")).toBeInTheDocument();
    expect(document.querySelector(".conversation-composer-attachment img")).toHaveAttribute(
      "src",
      "blob:conversation-image-preview",
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.headers.get("content-type")).toBe("image/png");
    expect(uploads[0]?.headers.get("x-attachment-filename")).toBe("launch-map.png");
    expect(uploads[0]?.body).toBe(image);

    await userEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    await waitFor(() => expect(removed).toBe(true));
    expect(screen.queryByText("launch-map.png")).not.toBeInTheDocument();
  });

  it("adds a PDF from the plus picker and a Markdown file by drag and drop", async () => {
    const uploaded: Array<{ name: string | null; mime: string | null }> = [];
    let submittedBody: unknown = null;
    const stream =
      'data: {"type":"start","messageId":"message-file-response"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
        if (url.endsWith("/attachments") && init?.method === "POST") {
          const headers = new Headers(init.headers);
          uploaded.push({
            name: headers.get("x-attachment-filename"),
            mime: headers.get("content-type"),
          });
          return Response.json({ id: `attachment-${uploaded.length}` }, { status: 201 });
        }
        if (url.endsWith(`/conversations/${conversationId}/messages`) && init?.method === "POST") {
          submittedBody = JSON.parse(String(init.body));
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const addFile = await screen.findByRole("button", { name: "Add file" });
    expect(addFile).toHaveAttribute("title", "Add images or files");
    await user.click(addFile);
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw new Error("Expected the file picker input.");
    // The conversation attachment adapter now accepts all file types ("*").
    const pdf = new File(["pdf"], "release-notes.pdf", { type: "application/pdf" });
    Object.defineProperty(picker, "files", { configurable: true, value: [pdf] });
    fireEvent.change(picker);
    expect(await screen.findByText("release-notes.pdf")).toBeInTheDocument();

    const markdown = new File(["# Launch"], "launch.md", {
      type: "application/octet-stream",
    });
    fireEvent.drop(screen.getByRole("form", { name: "Message composer and file dropzone" }), {
      dataTransfer: { files: [markdown] },
    });
    expect(await screen.findByText("launch.md")).toBeInTheDocument();
    expect(uploaded).toEqual([
      { name: "release-notes.pdf", mime: "application/pdf" },
      { name: "launch.md", mime: "text/markdown" },
    ]);
    await user.type(
      screen.getByRole("textbox", { name: "Message the project PM" }),
      "Review these files{enter}",
    );
    await waitFor(() => expect(submittedBody).not.toBeNull());
    expect(submittedBody).toMatchObject({
      parts: [
        { type: "text", format: "markdown", text: "Review these files" },
        {
          type: "attachment",
          attachment_id: "attachment-1",
          name: "release-notes.pdf",
          media_type: "application/pdf",
        },
        {
          type: "attachment",
          attachment_id: "attachment-2",
          name: "launch.md",
          media_type: "text/markdown",
        },
      ],
    });
  });

  it("shows the three weaving logo strands while the PM is thinking", async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const responseBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const push = (chunk: unknown) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    let completed = false;
    const persistedMessages = [
      message({
        id: "message-thinking-user",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "markdown", text: "Map the rollout" }],
      }),
      message({
        id: "message-thinking-reply",
        role: "assistant",
        sequence: 2,
        parts: [{ type: "text", format: "markdown", text: "The rollout is mapped." }],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(completed ? persistedMessages : []);
        }
        if (url.endsWith(`/conversations/${conversationId}/messages`) && init?.method === "POST") {
          return new Response(responseBody, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "Message the project PM" }),
      "Map the rollout{enter}",
    );
    push({ type: "start", messageId: "message-thinking-reply" });

    const indicator = await screen.findByLabelText("PM is thinking");
    expect(indicator).toHaveTextContent("Weaving the plan…");
    expect(
      Array.from(indicator.querySelectorAll("[data-strand]")).map((strand) =>
        strand.getAttribute("data-strand"),
      ),
    ).toEqual(expect.arrayContaining(["0", "1", "2"]));

    push({ type: "text-start", id: "text-thinking" });
    push({ type: "text-delta", id: "text-thinking", delta: "The rollout is mapped." });
    push({ type: "text-end", id: "text-thinking" });
    completed = true;
    push({ type: "finish", finishReason: "stop" });
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();

    expect(await screen.findByText("The rollout is mapped.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("PM is thinking")).not.toBeInTheDocument());
  });

  it("renders durable images as thumbnails and documents as accessible download chips", async () => {
    const history = [
      message({
        id: "message-durable-files",
        role: "user",
        sequence: 1,
        parts: [
          {
            type: "attachment",
            attachment_id: "attachment-image-durable",
            name: "architecture.png",
            media_type: "image/png",
          },
          {
            type: "attachment",
            attachment_id: "attachment-pdf-durable",
            name: "brief.pdf",
            media_type: "application/pdf",
          },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(history);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByAltText("architecture.png")).toHaveAttribute(
      "src",
      `/api/v2/projects/${projectId}/attachments/attachment-image-durable`,
    );
    const pdf = screen.getByRole("link", { name: "Open brief.pdf" });
    expect(pdf).toHaveAttribute(
      "href",
      `/api/v2/projects/${projectId}/attachments/attachment-pdf-durable`,
    );
    expect(pdf).toHaveAttribute("download", "brief.pdf");
    expect(pdf).toHaveTextContent("PDF");
  });

  it("silently accepts a previously-unsupported pasted file now that all types are allowed", async () => {
    const uploaded: { name: string; mime: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
      if (url.endsWith("/attachments")) {
        uploaded.push({
          name: (init?.headers as Record<string, string>)?.["x-attachment-filename"] ?? "",
          mime: (init?.headers as Record<string, string>)?.["content-type"] ?? "",
        });
        return new Response(JSON.stringify({ id: "att-exe", url: "/attachments/att-exe" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File(["binary"], "installer.exe", { type: "application/x-msdownload" })],
      },
    });

    expect(await screen.findByText("installer.exe")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "That file type is not supported. Add an image, PDF, plain text, Markdown, JSON, or CSV file.",
      ),
    ).not.toBeInTheDocument();
  });

  it("edits a human planning message through a durable child branch and leaves the parent unchanged", async () => {
    const originalText = "Use a Friday launch window.";
    const editedText = "Use a Tuesday launch window.";
    const source = message({
      id: "message-edit-source",
      role: "user",
      sequence: 1,
      parts: [{ type: "text", format: "markdown", text: originalText }],
    });
    const child = {
      ...conversation,
      id: "conversation-edit-child",
      next_message_sequence: 1,
    };
    const branchLineage: V2ConversationMessageBranchT = {
      schema_version: 2,
      id: "branch-edit-1",
      project_id: projectId,
      work_item_id: workItemId,
      child_conversation_id: child.id,
      parent_conversation_id: conversationId,
      source_message_id: source.id,
      created_by_user_id: "user-1",
      created_at: now,
    };
    const selectedConversations: string[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let branched = false;
    let submitted = false;
    const stream =
      'data: {"type":"start","messageId":"message-edited-response"}\n\n' +
      'data: {"type":"text-start","id":"text-edited"}\n\n' +
      'data: {"type":"text-delta","id":"text-edited","delta":"Tuesday is recorded."}\n\n' +
      'data: {"type":"text-end","id":"text-edited"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: workItem,
                conversations: branched ? [conversation, child] : [conversation],
              },
            ],
          });
        }
        if (url.includes("/conversation-navigation?")) {
          return Response.json({ folders: [], items: [], next_cursor: null });
        }
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse([source]);
        }
        if (url.endsWith(`/conversations/${conversationId}/branches`) && init?.method === "POST") {
          branched = true;
          return Response.json(
            { conversation: child, branch_lineage: branchLineage },
            { status: 201 },
          );
        }
        if (
          url.endsWith(`/conversations/${child.id}`) &&
          (!init?.method || init.method === "GET")
        ) {
          const childHistory = submitted
            ? [
                message({
                  id: "message-edited-user",
                  role: "user",
                  sequence: 1,
                  conversation_id: child.id,
                  parts: [{ type: "text", format: "markdown", text: editedText }],
                }),
              ]
            : [];
          return detailResponse(childHistory, null, null, {
            conversation: child,
            branchLineage,
          });
        }
        if (url.endsWith(`/conversations/${child.id}/messages`) && init?.method === "POST") {
          submitted = true;
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={(id) => selectedConversations.push(id)}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText(originalText)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", { name: "Edited message" });
    expect(editor).toHaveValue(originalText);
    expect(screen.getByRole("form", { name: "Edit message" })).toHaveTextContent(
      "The original conversation stays unchanged.",
    );
    await user.clear(editor);
    await user.type(editor, editedText);
    await user.click(screen.getByRole("button", { name: "Create edited branch" }));

    await waitFor(() =>
      expect(
        calls.find(
          ({ url, init }) =>
            url.endsWith(`/conversations/${conversationId}/branches`) && init?.method === "POST",
        ),
      ).toBeDefined(),
    );
    const branchCall = calls.find(({ url }) => url.endsWith("/branches"));
    expect(JSON.parse(String(branchCall?.init?.body))).toEqual({
      source_message_id: source.id,
    });
    expect(await screen.findByLabelText("Edited conversation branch")).toHaveTextContent(
      "original conversation is unchanged",
    );
    expect(await screen.findByText("Tuesday is recorded.")).toBeInTheDocument();
    const editedSubmit = calls.find(
      ({ url, init }) => url.endsWith(`/${child.id}/messages`) && init?.method === "POST",
    );
    expect(JSON.parse(String(editedSubmit?.init?.body))).toMatchObject({
      parts: [{ type: "text", format: "markdown", text: editedText }],
    });
    expect(
      calls.some(
        ({ url, init }) => url.endsWith(`/${conversationId}/messages`) && init?.method === "POST",
      ),
    ).toBe(false);
    expect(selectedConversations).toContain(child.id);

    await user.click(screen.getByRole("button", { name: "Open original" }));
    expect(await screen.findByText(originalText, {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByText(editedText)).not.toBeInTheDocument();
  });

  it("keeps the original conversation selected and shows branch creation failures inline", async () => {
    const source = message({
      id: "message-edit-failure",
      role: "user",
      sequence: 1,
      parts: [{ type: "text", format: "markdown", text: "Original direction" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse([source]);
        if (url.endsWith(`/conversations/${conversationId}/branches`) && init?.method === "POST") {
          return Response.json(
            { message: "Stop the active response before editing this message." },
            { status: 409 },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", { name: "Edited message" });
    await user.clear(editor);
    await user.type(editor, "Replacement direction");
    await user.click(screen.getByRole("button", { name: "Create edited branch" }));

    expect(
      await screen.findByText("Stop the active response before editing this message."),
    ).toBeInTheDocument();
    expect(screen.getByText("Original direction")).toBeInTheDocument();
    expect(screen.queryByLabelText("Edited conversation branch")).not.toBeInTheDocument();
  });

  it("hides Edit for non-human, attachment-bearing, attachment-only, and workflow messages", async () => {
    const history = [
      message({
        id: "eligible-edit",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "markdown", text: "Eligible direction" }],
      }),
      message({
        id: "non-human-user",
        role: "user",
        sequence: 2,
        actor: { actor_type: "agent", actor_id: "worker:api" },
        parts: [{ type: "text", format: "markdown", text: "Agent-authored direction" }],
      }),
      message({
        id: "attachment-only",
        role: "user",
        sequence: 3,
        parts: [
          {
            type: "attachment",
            attachment_id: "attachment-only-1",
            name: "context.pdf",
            media_type: "application/pdf",
          },
        ],
      }),
      message({
        id: "text-and-attachment",
        role: "user",
        sequence: 4,
        parts: [
          { type: "text", format: "markdown", text: "Use this context" },
          {
            type: "attachment",
            attachment_id: "attachment-with-text-1",
            name: "context.md",
            media_type: "text/markdown",
          },
        ],
      }),
      message({
        id: "workflow-bearing",
        role: "user",
        sequence: 5,
        parts: [
          { type: "text", format: "markdown", text: "Workflow direction" },
          { type: "action", action_id: "action-workflow" },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(history);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Eligible direction")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit message" })).toHaveLength(1);
  });

  it.each([
    ["execution conversations", executionConversation(), null],
    [
      "read-only conversations",
      { ...conversation, status: "archived" as const, archived_at: now },
      null,
    ],
    ["active responses", conversation, { status: "streaming" }],
  ])("hides Edit in %s", async (_label, selectedConversation, activeAttempt) => {
    const source = message({
      id: `message-no-edit-${selectedConversation.id}`,
      role: "user",
      sequence: 1,
      conversation_id: selectedConversation.id,
      parts: [{ type: "text", format: "markdown", text: "Do not edit here" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [{ work_item: workItem, conversations: [selectedConversation] }],
          });
        }
        if (url.endsWith(`/conversations/${selectedConversation.id}`)) {
          return detailResponse(source ? [source] : [], activeAttempt, null, {
            conversation: selectedConversation,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={selectedConversation.id}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Do not edit here")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit message" })).not.toBeInTheDocument();
  });

  it("discards the obsolete pre-migration review_mode error from the browser session", async () => {
    const storageKey = `norns:conversation-plan-proposal-error:${conversationId}`;
    window.sessionStorage.setItem(storageKey, 'column "review_mode" does not exist');
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse([]);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "Message the project PM" })).toBeVisible();
    expect(screen.queryByTestId("conversation-plan-proposal-error")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("switches models inside the pinned provider ecosystem", async () => {
    let switchBody: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (
        url.endsWith(`/conversations/${conversationId}`) &&
        (!init?.method || init.method === "GET")
      ) {
        return detailResponse();
      }
      if (url.endsWith(`/conversations/${conversationId}/model`) && init?.method === "PATCH") {
        switchBody = JSON.parse(String(init.body));
        return Response.json({
          conversation: { ...conversation, model: "claude-opus-4-8" },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Chat options" }));
    const modelSelect = (await screen.findByRole("combobox", {
      name: "Conversation model",
    })) as HTMLSelectElement;
    expect(Array.from(modelSelect.options).map((option) => option.value)).not.toContain(
      "gpt-5.6-sol",
    );
    await user.selectOptions(modelSelect, "claude-opus-4-8");

    await waitFor(() => expect(modelSelect).toHaveValue("claude-opus-4-8"));
    expect(switchBody).toEqual({ model: "claude-opus-4-8" });
  });

  it("keeps a DeepSeek conversation inside the DeepSeek model ecosystem", async () => {
    const deepseekConversation: V2WorkConversationT = {
      ...conversation,
      provider: "deepseek",
      model: "deepseek-v4-flash",
    };
    let switchBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse([], null, null, { conversation: deepseekConversation });
        }
        if (url.endsWith(`/conversations/${conversationId}/model`) && init?.method === "PATCH") {
          switchBody = JSON.parse(String(init.body));
          return Response.json({
            conversation: { ...deepseekConversation, model: "deepseek-v4-pro" },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Chat options" }));
    const modelSelect = await screen.findByRole("combobox", { name: "Conversation model" });
    expect(modelSelect).toHaveDisplayValue("DeepSeek · DeepSeek V4 Flash");
    expect(
      Array.from((modelSelect as HTMLSelectElement).options).map((option) => option.value),
    ).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    await user.selectOptions(modelSelect, "deepseek-v4-pro");
    await waitFor(() => expect(modelSelect).toHaveValue("deepseek-v4-pro"));
    expect(switchBody).toEqual({ model: "deepseek-v4-pro" });
  });

  it("keeps the prior mockup visible in a responsive before-and-after revision comparison", async () => {
    const history = [
      message({
        id: "message-mockups",
        role: "assistant",
        sequence: 1,
        parts: [
          { type: "mockup", mockup_version_id: "mockup-version-1" },
          { type: "mockup", mockup_version_id: "mockup-version-2" },
        ],
      }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(history);
      if (url.endsWith("/mockups/mockup-version-1")) return Response.json(mockupVersion());
      if (url.endsWith("/mockups/mockup-version-2")) {
        return Response.json(mockupVersion(2, "mockup-version-1"));
      }
      if (url.includes("/artifacts/") && url.endsWith("/content")) {
        return new Response(new Blob(["png"], { type: "image/png" }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Mockup version 1" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Mockup version 2" })).toBeInTheDocument();
    const comparison = await screen.findByTestId("conversation-mockup-comparison");
    expect(comparison).toHaveTextContent("Before");
    expect(comparison).toHaveTextContent("Version 1 remains visible");
    expect(comparison).toHaveTextContent("After");
    expect(comparison).toHaveTextContent("Version 2");
    expect(
      screen.getAllByText("Approval remains an explicit project action.").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("renders the exact approved and delivered visual evidence for the verified commit", async () => {
    const execution = executionConversation();
    const onJourneyStageChange = vi.fn();
    const executionWorkItem: V2WorkItemT = {
      ...workItem,
      status: "executing",
      phase_id: "phase-1",
      execution_started_at: now,
    };
    const commitSha = "1".repeat(40);
    const captureProfile = {
      renderer: "playwright" as const,
      browser_name: "chromium",
      browser_version: "130.0.0",
      font_revision: "2".repeat(64),
      pixel_ratio: 1 as const,
      network: "application_only" as const,
      locale: "en-US" as const,
      timezone: "UTC" as const,
      fixed_clock: now,
    };
    const evidence = {
      schema_version: 2,
      id: "visual-evidence-1",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: execution.id,
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      approved_mockup_version_id: "mockup-version-approved",
      repository_binding_id: "repository-main",
      verification_result_id: "verification-1",
      deployment_record_id: "deployment-1",
      deployment_observation_id: "observation-1",
      commit_sha: commitSha,
      capture_profile: captureProfile,
      screenshots: [
        {
          viewport: "desktop",
          artifact: {
            artifact_id: "delivered-desktop",
            content_hash: "3".repeat(64),
            media_type: "image/png",
            label: "Delivered desktop",
          },
          width: 1440,
          height: 1024,
          capture_profile: captureProfile,
        },
        {
          viewport: "mobile",
          artifact: {
            artifact_id: "delivered-mobile",
            content_hash: "4".repeat(64),
            media_type: "image/png",
            label: "Delivered mobile",
          },
          width: 390,
          height: 844,
          capture_profile: captureProfile,
        },
      ],
      comparison_artifact: {
        artifact_id: "comparison-1",
        content_hash: "5".repeat(64),
        media_type: "application/json",
        label: "Approved and delivered comparison",
      },
      verified_at: now,
      created_at: now,
    };
    const comparison = {
      schema_version: 2,
      kind: "visual_comparison",
      implementation_visual_evidence_id: evidence.id,
      approved_mockup_version_id: evidence.approved_mockup_version_id,
      commit_sha: commitSha,
      comparisons: [
        {
          viewport: "desktop",
          mockup_artifact_id: "approved-desktop",
          mockup_artifact_hash: "6".repeat(64),
          implementation_artifact_id: "delivered-desktop",
          implementation_artifact_hash: "3".repeat(64),
        },
        {
          viewport: "mobile",
          mockup_artifact_id: "approved-mobile",
          mockup_artifact_hash: "7".repeat(64),
          implementation_artifact_id: "delivered-mobile",
          implementation_artifact_hash: "4".repeat(64),
        },
      ],
    };
    const history = [
      message({
        id: "message-implementation-visual-evidence",
        role: "assistant",
        sequence: 1,
        conversation_id: execution.id,
        parts: [
          {
            type: "implementation_visual_evidence",
            visual_evidence_id: evidence.id,
          },
        ],
      }),
    ];
    const NativeURL = URL;
    class ObjectURL extends NativeURL {
      static createObjectURL(): string {
        return "blob:norns-visual-evidence";
      }

      static revokeObjectURL(): void {}
    }
    vi.stubGlobal("URL", ObjectURL);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [{ work_item: executionWorkItem, conversations: [execution] }],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          return detailResponse(history, null, null, {
            workItem: executionWorkItem,
            conversation: execution,
          });
        }
        if (url.endsWith(`/visual-evidence/${evidence.id}`)) return Response.json(evidence);
        if (url.endsWith(`/artifacts/${evidence.comparison_artifact.artifact_id}/content`)) {
          return Response.json(comparison);
        }
        if (url.includes("/artifacts/") && url.endsWith("/content")) {
          return new Response(new Blob(["png"], { type: "image/png" }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const view = render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onJourneyStageChange={onJourneyStageChange}
        onConversationSelected={() => undefined}
        onUnsupported={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    const card = await screen.findByTestId("implementation-visual-evidence");
    expect(card).toHaveTextContent(commitSha);
    expect(await screen.findByAltText("Approved desktop mockup")).toBeInTheDocument();
    expect(await screen.findByAltText("Delivered desktop implementation")).toBeInTheDocument();
    expect(await screen.findByAltText("Approved mobile mockup")).toBeInTheDocument();
    expect(await screen.findByAltText("Delivered mobile implementation")).toBeInTheDocument();
    await waitFor(() => expect(onJourneyStageChange).toHaveBeenLastCalledWith(5, [3, 4], null));
    view.unmount();
  });

  it("replaces the planning transcript with the QC-owned decision workspace", async () => {
    const version = planVersion({ status: "in_qc" });
    const review = planReview();
    const onJourneyStageChange = vi.fn();
    const action = planAction({
      id: "action-approve-after-qc",
      action_type: "approve_plan",
      payload: {
        parameters: {
          plan_version_id: version.id,
          content_hash: version.content_hash,
          plan_review_id: review.id,
        },
      },
    });
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [
          { type: "text", format: "markdown", text: "Here is the current candidate." },
          { type: "plan", plan_version_id: version.id },
          { type: "action", action_id: action.id },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(history, null, null, {
            workItem: { ...workItem, status: "awaiting_approval" },
            planVersions: [version],
            actions: [action],
            reviews: [review],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        projectName="Signal Studio"
        initialConversationId={conversationId}
        onJourneyStageChange={onJourneyStageChange}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Quality control workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Signal Studio" })).toBeInTheDocument();
    expect(screen.queryByText(/Execution target/)).not.toBeInTheDocument();
    expect(screen.queryByText(/QC checks planned/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quality control" })).toBeInTheDocument();
    expect(screen.getByText(/Quality review passed/)).toBeInTheDocument();
    expect(screen.getByText("Plan Contract · Version 1")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-action-approve_plan")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QC" })).not.toBeInTheDocument();
    expect(screen.getByText("Make cancellation verification explicit.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current review record" })).toBeInTheDocument();
    expect(screen.getByText("PM response")).toBeInTheDocument();
    expect(screen.getByText("Added the requested telemetry assertion.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve plan" })).toBeInTheDocument();
    await waitFor(() =>
      expect(onJourneyStageChange).toHaveBeenLastCalledWith(4, [], {
        active: "complete",
        round: 1,
        maxRounds: 3,
      }),
    );
  });

  it("shows only the live attempt and archives a failed prior run with its retained feedback", async () => {
    const version = planVersion({ status: "candidate" });
    const failedReview = planReview({
      status: "failed",
      findings: [],
      dispositions: [],
      round_exchanges: [
        {
          round: 1,
          reviewed_plan_content_hash: version.content_hash,
          reviewer: {
            provider: "openai",
            model: "gpt-5.6",
            findings: [
              {
                severity: "must_fix",
                module_id: "core-api",
                finding: "The retry boundary is not explicit.",
                recommendation: "Add one bounded structured-output repair attempt.",
              },
            ],
          },
          pm: null,
        },
      ],
      revised_plan_version_id: null,
      failure_code: "invalid_response",
    });
    const runningReview = planReview({
      id: "review-2",
      attempt_number: 2,
      status: "running",
      findings: [],
      dispositions: [],
      round_exchanges: [],
      chat_messages: [],
      revised_plan_version_id: null,
      rounds_completed: 0,
      started_at: "2026-08-02T12:05:00.000Z",
      completed_at: null,
      created_at: "2026-08-02T12:05:00.000Z",
      updated_at: "2026-08-02T12:05:00.000Z",
      failure_code: null,
    });
    const history = [
      message({
        id: "message-after-qc",
        role: "system",
        sequence: 3,
        parts: [
          {
            type: "text",
            format: "markdown",
            text: "QC could not complete. The candidate is unchanged.",
          },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(history, null, null, {
            planVersions: [version],
            reviews: [failedReview, runningReview],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect((await screen.findAllByText("Round 1 of 3")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current review record" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Previous attempts · 1"));
    expect(screen.getByText("The retry boundary is not explicit.")).toBeInTheDocument();
  });

  it("generates, saves, and hydrates a plan from the composer intent", async () => {
    const version = planVersion({ created_by_action_id: "action-save-proposal" });
    const saveAction = planAction({
      id: "action-save-proposal",
      source_message_id: "message-plan-proposal",
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: version.plan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
        },
      },
    });
    const proposalMessage = message({
      id: "message-plan-proposal",
      role: "system",
      sequence: 1,
      parts: [
        { type: "text", format: "markdown", text: "I drafted a structured plan proposal." },
        { type: "action", action_id: saveAction.id },
      ],
    });
    const appliedSaveAction = planAction({
      ...saveAction,
      status: "applied",
      confirmed_by_user_id: "user-1",
      confirmation_idempotency_key: "confirm-save-proposal",
      confirmation_request_fingerprint: "c".repeat(64),
      confirmed_at: now,
      recorded_at: now,
      sent_at: now,
      acknowledged_at: now,
      applied_at: now,
    });
    const sendQcAction = planAction({
      id: "action-send-qc-followup",
      source_message_id: "message-plan-followups",
    });
    const exactDirection = "Reduce scope to one cancellation path and add a restart-safe test.";
    const requestChangesAction = planAction({
      id: "action-request-changes-exact",
      source_message_id: "message-plan-change-exact",
      action_type: "request_plan_changes",
      payload: {
        parameters: {
          plan_version_id: version.id,
          content_hash: version.content_hash,
          direction: exactDirection,
        },
      },
    });
    const rejectAction = planAction({
      id: "action-reject-followup",
      source_message_id: "message-plan-followups",
      action_type: "reject_plan",
      payload: {
        parameters: {
          plan_version_id: version.id,
          content_hash: version.content_hash,
          reason: "The current scope is too broad.",
        },
      },
    });
    const followupMessage = message({
      id: "message-plan-followups",
      role: "assistant",
      sequence: 2,
      parts: [
        { type: "plan", plan_version_id: version.id },
        { type: "action", action_id: sendQcAction.id },
        { type: "action", action_id: rejectAction.id },
      ],
    });
    const planChangeMessage = message({
      id: "message-plan-change-exact",
      role: "assistant",
      sequence: 3,
      parts: [
        { type: "text", format: "markdown", text: "Recorded your exact requested direction." },
        { type: "action", action_id: requestChangesAction.id },
      ],
    });
    const saveEffectValue = { kind: "plan_saved" as const, plan_version: version };
    const saveEffect: V2ConversationPlanActionEffectT = {
      schema_version: 2,
      id: "effect-save-proposal",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: saveAction.id,
      effect: saveEffectValue,
      created_at: now,
      updated_at: now,
    };
    let generated = false;
    let saved = false;
    let changePrepared = false;
    let resolveProposal!: (response: Response) => void;
    const proposalResponse = new Promise<Response>((resolve) => {
      resolveProposal = resolve;
    });
    const proposalBodies: Array<{ idempotency_key: string }> = [];
    const planChangeBodies: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          const messages = generated
            ? saved
              ? changePrepared
                ? [proposalMessage, followupMessage, planChangeMessage]
                : [proposalMessage, followupMessage]
              : [proposalMessage]
            : [];
          return detailResponse(messages, null, null, {
            planVersions: saved ? [version] : [],
            actions: generated
              ? saved
                ? [
                    appliedSaveAction,
                    sendQcAction,
                    rejectAction,
                    ...(changePrepared ? [requestChangesAction] : []),
                  ]
                : [saveAction]
              : [],
            effects: saved ? [saveEffect] : [],
          });
        }
        if (url.endsWith(`/actions/${saveAction.id}/confirm`) && init?.method === "POST") {
          saved = true;
          return Response.json({
            action: appliedSaveAction,
            effect: saveEffectValue,
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
          proposalBodies.push(JSON.parse(String(init?.body)));
          return proposalResponse;
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-change-proposals`)) {
          planChangeBodies.push(JSON.parse(String(init?.body)));
          changePrepared = true;
          return Response.json({
            message: planChangeMessage,
            action: requestChangesAction,
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "Message the project PM" }),
      "Use this as the plan.{enter}",
    );
    expect(screen.getByRole("button", { name: "Use conversation as plan" })).toHaveTextContent(
      "Planning…",
    );
    const progress = screen.getByTestId("conversation-plan-busy");
    expect(progress).toHaveTextContent("Building your plan");
    expect(progress).toHaveTextContent("0:00 elapsed");
    expect(screen.getByRole("progressbar", { name: "Plan generation progress" })).toHaveAttribute(
      "aria-valuetext",
      "In progress, 0:00 elapsed",
    );
    generated = true;
    resolveProposal(Response.json({ message: proposalMessage, action: saveAction }));

    expect(await screen.findByText("I drafted a structured plan proposal.")).toBeInTheDocument();
    expect(screen.queryByText("Proposed Plan Contract")).not.toBeInTheDocument();
    expect(await screen.findByText("Plan Contract · Version 1")).toBeInTheDocument();
    expect(proposalBodies).toHaveLength(1);
    expect(proposalBodies[0]?.idempotency_key).toEqual(expect.any(String));

    expect(screen.getByRole("combobox", { name: "Review cadence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to QC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject plan" })).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-action-send_plan_to_qc")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversation-action-reject_plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Exact content hash")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivery status")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm action: Request changes" }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Change direction" }), exactDirection);
    await user.click(screen.getByRole("button", { name: "Prepare request changes action" }));

    expect(await screen.findByText("Recorded your exact requested direction.")).toBeInTheDocument();
    expect(screen.getByText(exactDirection)).toBeInTheDocument();
    expect(planChangeBodies).toEqual([
      {
        idempotency_key: expect.any(String),
        plan_version_id: version.id,
        plan_hash: version.content_hash,
        direction: exactDirection,
      },
    ]);
    expect(
      screen.getByRole("button", { name: "Confirm action: Request changes" }),
    ).toBeInTheDocument();
  });

  it("returns a rejected plan to the PM chat as the latest plan document", async () => {
    const version = planVersion();
    const rejectedVersion = planVersion({ status: "rejected" });
    const sendAction = planAction({
      id: "action-send-before-reject",
      source_message_id: "message-plan-before-reject",
    });
    const rejectAction = planAction({
      id: "action-reject-plan",
      source_message_id: "message-plan-before-reject",
      action_type: "reject_plan",
      payload: {
        parameters: {
          plan_version_id: version.id,
          content_hash: version.content_hash,
          reason: "The plan needs another PM pass.",
        },
      },
    });
    const appliedRejectAction = planAction({
      ...rejectAction,
      status: "applied",
      confirmed_by_user_id: "user-1",
      confirmation_idempotency_key: "confirm-reject-plan",
      confirmation_request_fingerprint: "c".repeat(64),
      confirmed_at: now,
      recorded_at: now,
      sent_at: now,
      acknowledged_at: now,
      applied_at: now,
    });
    const planMessage = message({
      id: "message-plan-before-reject",
      role: "assistant",
      sequence: 1,
      parts: [
        { type: "plan", plan_version_id: version.id },
        { type: "action", action_id: sendAction.id },
        { type: "action", action_id: rejectAction.id },
      ],
    });
    const rejectedMessage = message({
      id: "message-rejected-plan",
      role: "system",
      sequence: 2,
      parts: [
        {
          type: "text",
          format: "markdown",
          text: "Rejected Plan v1: The plan needs another PM pass.",
        },
        { type: "plan", plan_version_id: rejectedVersion.id },
        { type: "action", action_id: rejectAction.id },
      ],
    });
    const effect = { kind: "plan_rejected" as const, plan_version: rejectedVersion };
    let rejected = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith("/planning-reviewer")) {
          return Response.json({
            provider: "openai",
            model: "gpt-5.6-sol",
            mode: "explicit",
            qc_mode: "automatic",
            allow_unadjudicated_rebuttals: false,
            default_max_rounds: 1,
          });
        }
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(
            rejected ? [planMessage, rejectedMessage] : [planMessage],
            null,
            null,
            {
              workItem: { ...workItem, status: "planning" },
              planVersions: [rejected ? rejectedVersion : version],
              actions: rejected ? [appliedRejectAction] : [sendAction, rejectAction],
            },
          );
        }
        if (url.endsWith(`/actions/${rejectAction.id}/confirm`) && init?.method === "POST") {
          rejected = true;
          return Response.json({ action: appliedRejectAction, effect });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Reject plan" }));

    expect(await screen.findByText(/Rejected Plan v1/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message the project PM" })).toBeInTheDocument();
    const planCards = screen.getAllByRole("article", {
      name: "Deliver conversation-first planning",
    });
    expect(within(planCards.at(-1) as HTMLElement).getByText("Rejected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject plan" })).not.toBeInTheDocument();
  });

  it.each(["typed command", "Plan button", "Plan button — skip QC"] as const)(
    "turns the conversation into a saved plan via the %s and requires explicit handoff confirmation",
    async (trigger) => {
      const openedFromPlanButton = trigger !== "typed command";
      const skipsQc = trigger === "Plan button — skip QC";
      const intentText = trigger === "typed command" ? "Use this" : "Use this as the plan.";
      const version = planVersion({ created_by_action_id: "action-save-natural-plan" });
      const saveAction = planAction({
        id: "action-save-natural-plan",
        source_message_id: "message-plan-proposal-natural",
        action_type: "save_plan_candidate",
        payload: {
          parameters: {
            plan: version.plan,
            predecessor_plan_version_id: null,
            predecessor_content_hash: null,
          },
        },
      });
      const appliedSaveAction = planAction({
        ...saveAction,
        status: "applied",
        confirmed_by_user_id: "user-1",
        confirmation_idempotency_key: "confirm-natural-plan",
        confirmation_request_fingerprint: "c".repeat(64),
        confirmed_at: now,
        recorded_at: now,
        sent_at: now,
        acknowledged_at: now,
        applied_at: now,
      });
      const sendQcAction = planAction({
        id: "action-send-natural-plan-to-qc",
        source_message_id: "message-plan-followups-natural",
        payload: {
          parameters: {
            plan_version_id: version.id,
            content_hash: version.content_hash,
            ...(openedFromPlanButton
              ? {
                  review: skipsQc
                    ? { mode: "skip_qc" }
                    : {
                        mode: "qc",
                        reviewer: { provider: "openai", model: "gpt-5.6-terra" },
                        rounds: 2,
                      },
                }
              : {}),
          },
        },
      });
      const appliedSendQcAction = planAction({
        ...sendQcAction,
        status: "applied",
        confirmed_by_user_id: "user-1",
        confirmation_idempotency_key: "confirm-natural-plan-qc",
        confirmation_request_fingerprint: "d".repeat(64),
        confirmed_at: now,
        recorded_at: now,
        sent_at: now,
        acknowledged_at: now,
        applied_at: now,
      });
      const selectedReview = planReview({
        id: "review-natural-plan",
        action_id: sendQcAction.id,
        plan_version_id: version.id,
        status: skipsQc ? "converged" : "queued",
        findings: [],
        dispositions: [],
        review_mode: skipsQc ? "waived" : "qc",
        reviewer_model: skipsQc ? "qc-waived-by-human" : "gpt-5.6-terra",
        max_rounds: skipsQc ? 3 : 2,
        started_at: skipsQc ? now : null,
        completed_at: skipsQc ? now : null,
      });
      const approvalAction = planAction({
        id: "action-approve-natural-plan",
        source_message_id: "message-plan-followups-natural",
        action_type: "approve_plan",
        payload: {
          parameters: {
            plan_version_id: version.id,
            content_hash: version.content_hash,
            plan_review_id: selectedReview.id,
          },
        },
      });
      const appliedApprovalAction = planAction({
        ...approvalAction,
        status: "applied",
        confirmed_by_user_id: "user-1",
        confirmation_idempotency_key: "confirm-natural-plan-approval",
        confirmation_request_fingerprint: "e".repeat(64),
        confirmed_at: now,
        recorded_at: now,
        sent_at: now,
        acknowledged_at: now,
        applied_at: now,
      });
      const approvedVersion = planVersion({
        ...version,
        status: "approved",
        approved_by_user_id: "user-1",
        approved_at: now,
      });
      const intentMessage = message({
        id: "message-plan-intent-natural",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "plain", text: intentText }],
      });
      const proposalMessage = message({
        id: "message-plan-proposal-natural",
        role: "assistant",
        sequence: 2,
        parts: [
          { type: "text", format: "markdown", text: "I prepared and saved the plan." },
          { type: "action", action_id: saveAction.id },
        ],
      });
      const followupMessage = message({
        id: "message-plan-followups-natural",
        role: "assistant",
        sequence: 3,
        parts: [
          { type: "plan", plan_version_id: version.id },
          { type: "action", action_id: sendQcAction.id },
        ],
      });
      const saveEffectValue = { kind: "plan_saved" as const, plan_version: version };
      const saveEffect: V2ConversationPlanActionEffectT = {
        schema_version: 2,
        id: "effect-save-natural-plan",
        project_id: projectId,
        work_item_id: workItemId,
        conversation_id: conversationId,
        action_id: saveAction.id,
        effect: saveEffectValue,
        created_at: now,
        updated_at: now,
      };
      const qcEffectValue = {
        kind: "qc_started" as const,
        plan_review: selectedReview,
        planning_run_id: selectedReview.planning_run_id,
      };
      const qcEffect: V2ConversationPlanActionEffectT = {
        schema_version: 2,
        id: "effect-natural-plan-qc",
        project_id: projectId,
        work_item_id: workItemId,
        conversation_id: conversationId,
        action_id: sendQcAction.id,
        effect: qcEffectValue,
        created_at: now,
        updated_at: now,
      };
      const approvalEffectValue = {
        kind: "plan_approved" as const,
        plan_version: approvedVersion,
        plan_review_id: selectedReview.id,
        planning_run_id: selectedReview.planning_run_id,
        transition_status: "legacy_unavailable" as const,
        execution_conversation_id: null,
        handoff_id: null,
        kickoff_intent_id: null,
        execution: {
          status: "refused" as const,
          started: false,
          detail: "The test isolates the automatic approval request.",
        },
      };
      const approvalEffect: V2ConversationPlanActionEffectT = {
        schema_version: 2,
        id: "effect-natural-plan-approval",
        project_id: projectId,
        work_item_id: workItemId,
        conversation_id: conversationId,
        action_id: approvalAction.id,
        effect: approvalEffectValue,
        created_at: now,
        updated_at: now,
      };
      let generated = false;
      let saved = false;
      let handedOff = false;
      let approved = false;
      const proposalBodies: Array<{
        idempotency_key: string;
        intent_message?: string;
        handoff?: unknown;
      }> = [];
      const messagePosts: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = urlOf(input);
          if (url.endsWith("/work-items")) return listResponse();
          if (url.endsWith("/api/v2/capabilities/execution-models")) {
            return Response.json({
              ready: true,
              required_environment: [],
              models: [
                {
                  id: "claude-sonnet-5",
                  provider: "anthropic",
                  label: "Claude Sonnet 5",
                  available: true,
                  unavailable_reason: null,
                },
              ],
            });
          }
          if (url.endsWith(`/api/v2/projects/${projectId}/planning-reviewer`)) {
            return Response.json({
              provider: "openai",
              model: "gpt-5.6-terra",
              mode: "explicit",
              qc_mode: "automatic",
              allow_unadjudicated_rebuttals: false,
              default_max_rounds: 2,
            });
          }
          if (
            url.endsWith(`/conversations/${conversationId}`) &&
            (!init?.method || init.method === "GET")
          ) {
            return detailResponse(
              generated
                ? saved
                  ? [intentMessage, proposalMessage, followupMessage]
                  : [intentMessage, proposalMessage]
                : [],
              null,
              null,
              {
                planVersions: saved ? [approved ? approvedVersion : version] : [],
                actions: generated
                  ? saved
                    ? [
                        appliedSaveAction,
                        handedOff ? appliedSendQcAction : sendQcAction,
                        ...(skipsQc && handedOff
                          ? [approved ? appliedApprovalAction : approvalAction]
                          : []),
                      ]
                    : [saveAction]
                  : [],
                reviews: handedOff ? [selectedReview] : [],
                effects: saved
                  ? [
                      saveEffect,
                      ...(handedOff ? [qcEffect] : []),
                      ...(approved ? [approvalEffect] : []),
                    ]
                  : [],
              },
            );
          }
          if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
            proposalBodies.push(JSON.parse(String(init?.body)));
            generated = true;
            return Response.json({ message: proposalMessage, action: saveAction });
          }
          if (url.endsWith(`/actions/${saveAction.id}/confirm`) && init?.method === "POST") {
            saved = true;
            return Response.json({ action: appliedSaveAction, effect: saveEffectValue });
          }
          if (url.endsWith(`/actions/${sendQcAction.id}/confirm`) && init?.method === "POST") {
            handedOff = true;
            return Response.json({ action: appliedSendQcAction, effect: qcEffectValue });
          }
          if (url.endsWith(`/actions/${approvalAction.id}/confirm`) && init?.method === "POST") {
            approved = true;
            return Response.json({
              action: appliedApprovalAction,
              effect: approvalEffectValue,
            });
          }
          if (url.endsWith(`/conversations/${conversationId}/messages`)) {
            messagePosts.push(url);
          }
          throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
        }),
      );
      const user = userEvent.setup();
      render(
        <ConversationWorkspace
          projectId={projectId}
          initialConversationId={conversationId}
          onUnauthorized={() => undefined}
        />,
      );

      const input = await screen.findByRole("textbox", { name: "Message the project PM" });
      expect(input).toHaveAttribute(
        "placeholder",
        "Message the PM, or say “Use this as the plan”…",
      );
      if (trigger === "typed command") {
        await user.type(input, intentText);
        await user.keyboard("{Enter}");
      } else {
        expect(screen.queryByText("UI preview", { exact: true })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Use conversation as plan" }));
        const handoffDialog = await screen.findByRole("dialog", {
          name: "Confirm QC Settings",
        });
        expect(handoffDialog.closest(".plan-handoff-backdrop")?.parentElement).toBe(document.body);
        const savedQcAgent = await screen.findByRole("combobox", { name: "QC agent" });
        await waitFor(() => expect(savedQcAgent).toHaveValue("gpt-5.6-terra"));
        expect(screen.getByRole("combobox", { name: "QC rounds" })).toHaveValue("2");
        if (skipsQc) {
          await user.click(await screen.findByRole("radio", { name: /Skip QC/ }));
          expect(screen.queryByRole("combobox", { name: "QC agent" })).not.toBeInTheDocument();
          await user.click(screen.getByRole("button", { name: "Build plan for review" }));
        } else {
          await user.click(screen.getByRole("button", { name: "Build plan for review" }));
        }
      }

      if (trigger === "typed command") {
        expect(await screen.findByText(intentText)).toBeInTheDocument();
        expect(await screen.findByText("Plan Contract · Version 1")).toBeInTheDocument();
        expect(await screen.findByText("UI preview", { exact: true })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Send to QC" })).toBeInTheDocument();
      } else if (skipsQc) {
        await waitFor(() => expect(saved).toBe(true));
        expect(handedOff).toBe(false);
        expect(approved).toBe(false);
        await user.click(await screen.findByRole("button", { name: "Continue without QC" }));
        await waitFor(() => expect(handedOff).toBe(true));
        expect(approved).toBe(false);
        expect(await screen.findByTestId("qc-new-workspace")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Quality control" })).toBeInTheDocument();
        expect(screen.getByText(/Quality review passed/)).toBeInTheDocument();
        expect(await screen.findByRole("button", { name: "Approve plan" })).toBeInTheDocument();
      } else {
        await waitFor(() => expect(saved).toBe(true));
        expect(handedOff).toBe(false);
        expect(await screen.findByRole("button", { name: "Send to QC" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Plan with PM" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Send to QC" }));
        await waitFor(() => expect(handedOff).toBe(true));
        expect(await screen.findByTestId("qc-new-workspace")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
        expect(screen.queryByText("QC checks planned: 2 · Agents: 1")).not.toBeInTheDocument();
      }
      expect(proposalBodies).toEqual([
        {
          idempotency_key: expect.any(String),
          intent_message: intentText,
          ...(openedFromPlanButton
            ? {
                handoff: {
                  execution_agent: { provider: "anthropic", model: "claude-sonnet-5" },
                  review: skipsQc
                    ? { mode: "skip_qc" }
                    : {
                        mode: "qc",
                        reviewer: { provider: "openai", model: "gpt-5.6-terra" },
                        rounds: 2,
                      },
                },
              }
            : {}),
        },
      ]);
      expect(messagePosts).toEqual([]);
    },
  );

  it("shows proposal generation conflicts and safely retries the same request", async () => {
    const version = planVersion();
    const saveAction = planAction({
      id: "action-save-proposal",
      source_message_id: "message-plan-proposal",
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: version.plan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
        },
      },
    });
    const proposalMessage = message({
      id: "message-plan-proposal",
      role: "system",
      sequence: 1,
      parts: [{ type: "action", action_id: saveAction.id }],
    });
    const submittedKeys: string[] = [];
    let generated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(generated ? [proposalMessage] : [], null, null, {
            actions: generated ? [saveAction] : [],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
          submittedKeys.push(JSON.parse(String(init?.body)).idempotency_key);
          if (submittedKeys.length === 1) {
            return Response.json(
              {
                error: "proposal_in_progress",
                message: "A plan proposal request is already in progress.",
              },
              { status: 409 },
            );
          }
          generated = true;
          return Response.json({ message: proposalMessage, action: saveAction });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    await user.type(composer, "Use this as the plan.{enter}");
    expect(await screen.findByTestId("conversation-plan-proposal-error")).toHaveTextContent(
      "A plan proposal request is already in progress.",
    );
    await user.type(composer, "Use this as the plan.{enter}");

    expect(await screen.findByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(submittedKeys).toHaveLength(2);
    expect(submittedKeys[1]).toBe(submittedKeys[0]);
  });

  function streamedProposalFixtures(suffix: string) {
    const version = planVersion();
    const saveAction = planAction({
      id: `action-save-${suffix}`,
      source_message_id: `message-plan-${suffix}`,
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: version.plan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
        },
      },
    });
    return {
      saveAction,
      proposalMessage: message({
        id: `message-plan-${suffix}`,
        role: "system",
        sequence: 1,
        parts: [{ type: "action", action_id: saveAction.id }],
      }),
    };
  }

  it("renders each streamed plan module title while the proposal is still generating", async () => {
    const { saveAction, proposalMessage } = streamedProposalFixtures("streamed");
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const push = (chunk: unknown) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    let generated = false;
    let jsonProposals = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(generated ? [proposalMessage] : [], null, null, {
            actions: generated ? [saveAction] : [],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals/stream`)) {
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
          jsonProposals += 1;
          generated = true;
          return Response.json({ message: proposalMessage, action: saveAction });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "Message the project PM" }),
      "Use this as the plan.{enter}",
    );
    expect(await screen.findByTestId("conversation-plan-busy")).toHaveTextContent(
      "Building your plan",
    );

    push({ type: "start", messageId: "plan-proposal:key-streamed" });
    push({
      type: "data-plan-progress",
      transient: true,
      data: { stage: "generating", modules: ["Auth rewrite"], output_tokens_estimate: 400 },
    });
    expect(await screen.findByText("Auth rewrite")).toBeInTheDocument();

    push({
      type: "data-plan-progress",
      transient: true,
      data: {
        stage: "validating",
        modules: ["Auth rewrite", "Billing migration"],
        output_tokens_estimate: 1_800,
      },
    });
    expect(await screen.findByText("Billing migration")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-plan-busy")).toHaveTextContent("Validating the plan");

    generated = true;
    push({ type: "data-plan-proposal", data: { message: proposalMessage, action: saveAction } });
    push({ type: "finish" });
    controller.close();

    expect(await screen.findByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(jsonProposals).toBe(0);
  });

  it("falls back to the non-streaming plan route when the stream fails", async () => {
    const { saveAction, proposalMessage } = streamedProposalFixtures("fallback");
    let generated = false;
    let streamAttempts = 0;
    const jsonKeys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(generated ? [proposalMessage] : [], null, null, {
            actions: generated ? [saveAction] : [],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals/stream`)) {
          streamAttempts += 1;
          throw new TypeError("Failed to fetch");
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
          jsonKeys.push(JSON.parse(String(init?.body)).idempotency_key);
          generated = true;
          return Response.json({ message: proposalMessage, action: saveAction });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "Message the project PM" }),
      "Use this as the plan.{enter}",
    );

    expect(await screen.findByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(streamAttempts).toBe(1);
    expect(jsonKeys).toHaveLength(1);
  });

  it("uses a fresh plan-proposal key after an explicit terminal generation failure", async () => {
    const version = planVersion();
    const saveAction = planAction({
      id: "action-save-after-failure",
      source_message_id: "message-plan-after-failure",
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: version.plan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
        },
      },
    });
    const proposalMessage = message({
      id: "message-plan-after-failure",
      role: "assistant",
      sequence: 1,
      parts: [{ type: "action", action_id: saveAction.id }],
    });
    const keys: string[] = [];
    let generated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(generated ? [proposalMessage] : [], null, null, {
            actions: generated ? [saveAction] : [],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
          keys.push(JSON.parse(String(init?.body)).idempotency_key);
          if (keys.length === 1) {
            return Response.json(
              {
                error: "proposal_failed",
                message: "The PM could not produce a valid Plan Contract.",
              },
              { status: 502 },
            );
          }
          generated = true;
          return Response.json({ message: proposalMessage, action: saveAction });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    await user.type(composer, "Use this as the plan.{enter}");
    expect(await screen.findByTestId("conversation-plan-proposal-error")).toHaveTextContent(
      "could not produce a valid Plan Contract",
    );
    await user.type(composer, "Use this as the plan.{enter}");

    expect(await screen.findByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("uses a fresh plan-proposal key after an explicit terminal generation failure", async () => {
    const version = planVersion();
    const saveAction = planAction({
      id: "action-save-after-failure",
      source_message_id: "message-plan-after-failure",
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: version.plan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
        },
      },
    });
    const proposalMessage = message({
      id: "message-plan-after-failure",
      role: "assistant",
      sequence: 1,
      parts: [{ type: "action", action_id: saveAction.id }],
    });
    const keys: string[] = [];
    let generated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(generated ? [proposalMessage] : [], null, null, {
            actions: generated ? [saveAction] : [],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals`)) {
          keys.push(JSON.parse(String(init?.body)).idempotency_key);
          if (keys.length === 1) {
            return Response.json(
              {
                error: "proposal_failed",
                message: "The PM could not produce a valid Plan Contract.",
              },
              { status: 502 },
            );
          }
          generated = true;
          return Response.json({ message: proposalMessage, action: saveAction });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    await user.type(composer, "Use this as the plan.{enter}");
    expect(await screen.findByTestId("conversation-plan-proposal-error")).toHaveTextContent(
      "could not produce a valid Plan Contract",
    );
    await user.type(composer, "Use this as the plan.{enter}");

    expect(await screen.findByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("retains exact change direction across a stale-plan error and refresh", async () => {
    const version = planVersion();
    const history = [
      message({
        id: "message-plan",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "plan", plan_version_id: version.id }],
      }),
    ];
    const bodies: Array<Record<string, string>> = [];
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          detailCalls += 1;
          return detailResponse(history, null, null, { planVersions: [version] });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-change-proposals`)) {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json(
            {
              error: "stale_plan_hash",
              message: "The plan hash is stale. Refresh before preparing changes.",
            },
            { status: 409 },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    const direction = "Keep the API task, remove the dashboard, and add a cancellation test.";
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.type(await screen.findByRole("textbox", { name: "Change direction" }), direction);
    await user.click(screen.getByRole("button", { name: "Prepare request changes action" }));
    expect(
      await screen.findByText("plan hash is stale", {
        exact: false,
        selector: "output.conversation-action-error",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Change direction" })).toHaveValue(direction);

    await user.click(screen.getByRole("button", { name: "Chat options" }));
    await user.click(screen.getByRole("button", { name: "Refresh conversation" }));
    await waitFor(() => expect(detailCalls).toBe(2));
    expect(screen.getByRole("textbox", { name: "Change direction" })).toHaveValue(direction);

    await user.click(screen.getByRole("button", { name: "Prepare request changes action" }));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.direction).toBe(direction);
    expect(bodies[1]?.idempotency_key).not.toBe(bodies[0]?.idempotency_key);
  });

  it("does not offer another change request after the exact direction is recorded", async () => {
    const version = planVersion({ status: "changes_requested" });
    const history = [
      message({
        id: "message-plan",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "plan", plan_version_id: version.id }],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(history, null, null, { planVersions: [version] });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByTestId("conversation-plan-card")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Change direction" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare request changes action" }),
    ).not.toBeInTheDocument();
  });

  it("locks an uncertain change direction and retries it with the same request key", async () => {
    const version = planVersion();
    const exactDirection = "Add explicit provider cancellation accounting.";
    const action = planAction({
      id: "action-exact-change",
      source_message_id: "message-exact-change",
      action_type: "request_plan_changes",
      payload: {
        parameters: {
          plan_version_id: version.id,
          content_hash: version.content_hash,
          direction: exactDirection,
        },
      },
    });
    const actionMessage = message({
      id: "message-exact-change",
      role: "assistant",
      sequence: 2,
      parts: [{ type: "action", action_id: action.id }],
    });
    const history = [
      message({
        id: "message-plan",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "plan", plan_version_id: version.id }],
      }),
    ];
    const keys: string[] = [];
    let prepared = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(prepared ? [...history, actionMessage] : history, null, null, {
            planVersions: [version],
            actions: prepared ? [action] : [],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-change-proposals`)) {
          keys.push(JSON.parse(String(init?.body)).idempotency_key);
          if (keys.length === 1) throw new Error("connection closed after send");
          prepared = true;
          return Response.json({ message: actionMessage, action });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "Change direction" }),
      exactDirection,
    );
    await user.click(screen.getByRole("button", { name: "Prepare request changes action" }));
    expect(
      await screen.findByText("Request status is uncertain.", {
        exact: false,
        selector: "output.conversation-action-error",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Change direction" })).toBeDisabled();
    expect(
      screen.getByText("Direction locked until this exact request is safely retried."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Prepare request changes action" }));
    expect(await screen.findByText(exactDirection)).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("polls active QC until it settles, then stops polling", async () => {
    vi.useFakeTimers();
    const version = planVersion({ status: "in_qc" });
    const queued = planReview({
      status: "queued",
      findings: [],
      dispositions: [],
      started_at: null,
      completed_at: null,
    });
    const running = planReview({
      status: "running",
      findings: [],
      dispositions: [],
      completed_at: null,
    });
    const awaitingDecision = planReview({
      status: "awaiting_human",
      paused_checkpoint: "after_review",
      paused_at_round: 1,
      dispositions: [],
      completed_at: null,
    });
    const qcAction = planAction({ status: "agent_acknowledged" });
    const history = [
      message({
        id: "message-plan",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "plan", plan_version_id: version.id }],
      }),
    ];
    let detailCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) {
        detailCalls += 1;
        return detailResponse(history, null, null, {
          planVersions: [version],
          actions: [qcAction],
          reviews: [detailCalls === 1 ? queued : detailCalls === 2 ? running : awaitingDecision],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("Round 2 of 3").length).toBeGreaterThan(0);
    expect(detailCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(detailCalls).toBe(2);
    expect(screen.getByText("Working now")).toBeInTheDocument();
    expect(screen.getByText("Independent reviewer")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(detailCalls).toBe(3);
    expect(screen.getByText("Make cancellation verification explicit.")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(detailCalls).toBe(3);
  });

  it("offers retry after a failure that already produced a PM revision", async () => {
    // The server proposes retry/skip/reject against the originally reviewed
    // version, so a review carrying a mid-review revision must still match them.
    const version = planVersion({ status: "candidate" });
    const failed = planReview({
      status: "failed",
      failure_code: "invalid_response",
      findings: [],
      dispositions: [],
      revised_plan_version_id: "plan-version-2",
      completed_at: null,
    });
    const retry = planAction({
      id: "action-qc-retry",
      action_type: "send_plan_to_qc",
      payload: {
        parameters: {
          plan_version_id: "plan-version-1",
          content_hash: "a".repeat(64),
          review: { mode: "qc", reviewer: { provider: "openai", model: "gpt-5.6" }, rounds: 3 },
        },
      },
    });
    const history = [
      message({
        id: "message-plan",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "plan", plan_version_id: version.id }],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(history, null, null, {
            planVersions: [version],
            actions: [retry],
            reviews: [failed],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByRole("button", { name: "Run QC again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
  });

  it("polls a pending approved-plan kickoff until its durable outcome settles", async () => {
    vi.useFakeTimers();
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const approval = planAction({
      id: "action-approve-pending",
      action_type: "approve_plan",
      status: "applied",
      payload: {
        parameters: {
          plan_version_id: approvedVersion.id,
          content_hash: approvedVersion.content_hash,
          plan_review_id: "review-1",
        },
      },
    });
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: approval.id }],
      }),
    ];
    let detailCalls = 0;
    const effectRecord = (status: "pending" | "failed"): V2ConversationPlanActionEffectT => ({
      schema_version: 2,
      id: "effect-approval-pending",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: approval.id,
      effect: {
        kind: "plan_approved",
        plan_version: approvedVersion,
        plan_review_id: "review-1",
        planning_run_id: "planning-run-1",
        transition_status: "created",
        execution_conversation_id: "execution-conversation-pending",
        handoff_id: "handoff-pending",
        kickoff_intent_id: "kickoff-intent-pending",
        execution:
          status === "pending"
            ? { status: "pending", started: null, detail: null }
            : {
                status: "failed",
                started: false,
                detail: "Coordinator unavailable.",
              },
      },
      created_at: now,
      updated_at: now,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          detailCalls += 1;
          return detailResponse(history, null, null, {
            planVersions: [approvedVersion],
            actions: [approval],
            effects: [effectRecord(detailCalls === 1 ? "pending" : "failed")],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText("The plan is approved. Coding kickoff is still pending."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open development chat" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/work/execution-conversation-pending`,
    );
    expect(screen.queryByRole("region", { name: "Planning workflow" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open linked development chat" }),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(detailCalls).toBe(2);
    expect(screen.getByText(/coding kickoff failed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open development chat" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/work/execution-conversation-pending`,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(detailCalls).toBe(2);
  });

  it("retries a failed approved-plan kickoff from the QC workspace", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const approval = planAction({
      id: "action-approve-retry",
      action_type: "approve_plan",
      status: "applied",
      payload: {
        parameters: {
          plan_version_id: approvedVersion.id,
          content_hash: approvedVersion.content_hash,
          plan_review_id: "review-1",
        },
      },
    });
    const review = planReview({
      action_id: approval.id,
      plan_version_id: approvedVersion.id,
      planning_run_id: "planning-run-retry",
      result_plan_content_hash: approvedVersion.content_hash,
    });
    const effect: V2ConversationPlanActionEffectT = {
      schema_version: 2,
      id: "effect-approval-retry",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: approval.id,
      effect: {
        kind: "plan_approved",
        plan_version: approvedVersion,
        plan_review_id: review.id,
        planning_run_id: review.planning_run_id,
        transition_status: "created",
        execution_conversation_id: "execution-conversation-retry",
        handoff_id: "handoff-retry",
        kickoff_intent_id: "kickoff-intent-retry",
        execution: {
          status: "failed",
          started: false,
          detail: "Coordinator unavailable.",
        },
      },
      created_at: now,
      updated_at: now,
    };
    let activationCalls = 0;
    let analysisCalls = 0;
    let retryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, {
            planVersions: [approvedVersion],
            actions: [approval],
            reviews: [review],
            effects: [effect],
          });
        }
        if (url.endsWith(`/projects/${projectId}/activate`) && init?.method === "POST") {
          activationCalls += 1;
          return Response.json({ project_id: projectId, activated: true, blockers: [] });
        }
        if (url.endsWith(`/projects/${projectId}/analyze-repository`) && init?.method === "POST") {
          analysisCalls += 1;
          return Response.json({
            architecture_revision_id: "architecture-revision-1",
            architecture_revision: 1,
            replayed: false,
            repository_revision: "abc123",
          });
        }
        if (
          url.endsWith("/planning-runs/planning-run-retry/execution") &&
          init?.method === "POST"
        ) {
          retryCalls += 1;
          if (retryCalls === 1) {
            return Response.json({
              execution: {
                started: false,
                detail: "Repository context recorded. Retry available.",
              },
            });
          }
          return Response.json({
            execution: { started: true, detail: "4 tasks dispatched." },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByTestId("conversation-retry-execution")).toBeInTheDocument();
    const reconnect = screen.getByTestId("conversation-activate-retry-execution");
    const analyze = screen.getByTestId("conversation-analyze-retry-execution");
    expect(screen.getByText("Coordinator unavailable.")).toBeInTheDocument();
    await user.click(analyze);

    expect(
      await screen.findByText("Repository context recorded. Retry available."),
    ).toBeInTheDocument();
    expect(analysisCalls).toBe(1);
    expect(retryCalls).toBe(1);
    await user.click(reconnect);

    expect(await screen.findByText("4 tasks dispatched.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Development started" })).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-retry-execution")).not.toBeInTheDocument();
    expect(activationCalls).toBe(1);
    expect(retryCalls).toBe(2);
  });

  it("submits the visible parts through the AI SDK stream and hides the welcome immediately", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let submitted = false;
    const persistedAfterStream = [
      message({
        id: "message-user-stream",
        role: "user",
        sequence: 1,
        parts: [{ type: "text", format: "markdown", text: "Draft the plan" }],
      }),
      message({
        id: "message-assistant-stream",
        role: "assistant",
        sequence: 2,
        parts: [{ type: "text", format: "markdown", text: "Streaming **works**." }],
      }),
    ];
    const stream =
      'data: {"type":"start","messageId":"message-assistant-stream"}\n\n' +
      'data: {"type":"text-start","id":"text-1"}\n\n' +
      'data: {"type":"text-delta","id":"text-1","delta":"Streaming **works**."}\n\n' +
      'data: {"type":"text-end","id":"text-1"}\n\n' +
      'data: {"type":"data-usage","data":{"input_tokens":12,"output_tokens":4,"cost_usd":0.0012},"transient":true}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(submitted ? persistedAfterStream : []);
        }
        if (url.endsWith(`/conversations/${conversationId}/messages`) && init?.method === "POST") {
          submitted = true;
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    expect(screen.getByTestId("conversation-welcome")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Conversation-first planning" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(workItem.objective)).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversation-summary-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversation-total-usage")).not.toBeInTheDocument();
    await user.type(composer, "Draft the plan{enter}");

    await waitFor(() =>
      expect(screen.queryByTestId("conversation-welcome")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByText("works")).toBeInTheDocument());

    const submit = calls.find(
      ({ url, init }) => url.endsWith("/messages") && init?.method === "POST",
    );
    expect(submit).toBeDefined();
    expect(JSON.parse(String(submit?.init?.body))).toMatchObject({
      parts: [{ type: "text", format: "markdown", text: "Draft the plan" }],
    });
    expect(JSON.parse(String(submit?.init?.body)).client_message_id).toEqual(expect.any(String));
    expect(new Headers(submit?.init?.headers).get("content-type")).toBe("application/json");
    expect(calls.some(({ url }) => url.includes("/actions"))).toBe(false);
  });

  it("shows a readable message instead of a raw Fastify 415 payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
        if (url.endsWith(`/conversations/${conversationId}/messages`)) {
          return Response.json(
            {
              statusCode: 415,
              code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
              error: "Unsupported Media Type",
              message: "Unsupported Media Type",
            },
            { status: 415 },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "Message the project PM" });
    await user.type(composer, "Try this message{enter}");

    expect(
      await screen.findByText(
        "The message request was rejected. Refresh the page and try sending it again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/FST_ERR_CTP_INVALID_MEDIA_TYPE/)).not.toBeInTheDocument();
  });

  it("retries an uncertain confirmation with the identical caller-stable key", async () => {
    const proposed = planAction();
    const applied = planAction({
      status: "applied",
      confirmation_idempotency_key: "confirm-from-browser",
    });
    const review = planReview();
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: proposed.id }],
      }),
    ];
    const confirmationBodies: Array<{ idempotency_key: string }> = [];
    let confirmed = false;
    const effectValue = {
      kind: "qc_started" as const,
      plan_review: review,
      planning_run_id: review.planning_run_id,
    };
    const effectRecord: V2ConversationPlanActionEffectT = {
      schema_version: 2,
      id: "effect-qc-1",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: proposed.id,
      effect: effectValue,
      created_at: now,
      updated_at: now,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(history, null, null, {
            actions: [confirmed ? applied : proposed],
            reviews: confirmed ? [review] : [],
            effects: confirmed ? [effectRecord] : [],
          });
        }
        if (url.endsWith(`/actions/${proposed.id}/confirm`) && init?.method === "POST") {
          confirmationBodies.push(JSON.parse(String(init.body)));
          if (confirmationBodies.length === 1) {
            throw new Error("connection reset after the request was sent");
          }
          confirmed = true;
          return Response.json({ action: applied, effect: effectValue });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const confirm = await screen.findByRole("button", {
      name: "Confirm action: Approve plan and send to QC",
    });
    await user.click(confirm);
    expect(
      await screen.findByText("Confirmation status is uncertain.", {
        exact: false,
        selector: "output.conversation-action-error",
      }),
    ).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem(`norns:conversation-action-confirmation:${proposed.id}`),
    ).toBe(confirmationBodies[0]?.idempotency_key);
    await user.click(
      screen.getByRole("button", { name: "Confirm action: Approve plan and send to QC" }),
    );

    await waitFor(() => expect(confirmationBodies).toHaveLength(2));
    expect(confirmationBodies[0]?.idempotency_key).toEqual(expect.any(String));
    expect(confirmationBodies[1]?.idempotency_key).toBe(confirmationBodies[0]?.idempotency_key);
    expect(await screen.findByRole("heading", { name: "Quality control" })).toBeInTheDocument();
  });

  it("keeps one in-memory confirmation key when session storage is unavailable", async () => {
    const proposed = planAction();
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: proposed.id }],
      }),
    ];
    const confirmationBodies: Array<{ idempotency_key: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(history, null, null, { actions: [proposed] });
        }
        if (url.endsWith(`/actions/${proposed.id}/confirm`) && init?.method === "POST") {
          confirmationBodies.push(JSON.parse(String(init.body)));
          throw new Error("network status unavailable");
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );
    const confirm = await screen.findByRole("button", {
      name: "Confirm action: Approve plan and send to QC",
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    await user.click(confirm);
    expect(
      await screen.findByText("Confirmation status is uncertain.", {
        exact: false,
        selector: "output.conversation-action-error",
      }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Confirm action: Approve plan and send to QC" }),
    );
    await waitFor(() => expect(confirmationBodies).toHaveLength(2));
    expect(confirmationBodies[1]?.idempotency_key).toBe(confirmationBodies[0]?.idempotency_key);
  });

  it("continues a confirmed action with its server-recorded confirmation key", async () => {
    const confirmedAction = planAction({
      status: "confirmed",
      confirmation_idempotency_key: "original-confirmation-key",
    });
    const appliedAction = planAction({
      status: "applied",
      confirmation_idempotency_key: "original-confirmation-key",
    });
    const review = planReview();
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: confirmedAction.id }],
      }),
    ];
    let submittedKey: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(history, null, null, { actions: [confirmedAction] });
        }
        if (url.endsWith(`/actions/${confirmedAction.id}/confirm`) && init?.method === "POST") {
          submittedKey = JSON.parse(String(init.body)).idempotency_key;
          return Response.json({
            action: appliedAction,
            effect: {
              kind: "qc_started",
              plan_review: review,
              planning_run_id: review.planning_run_id,
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Continue action: Approve plan and send to QC",
      }),
    );
    expect(submittedKey).toBe("original-confirmation-key");
  });

  it("keeps the exact plan and action visible when the server rejects a stale hash", async () => {
    const version = planVersion();
    const proposed = planAction();
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [
          { type: "plan", plan_version_id: version.id },
          { type: "action", action_id: proposed.id },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(history, null, null, {
            planVersions: [version],
            actions: [proposed],
          });
        }
        if (url.endsWith(`/actions/${proposed.id}/confirm`) && init?.method === "POST") {
          return Response.json(
            {
              error: "stale_plan_hash",
              message: "The proposal targets a stale plan hash. Refresh before confirming.",
            },
            { status: 409 },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Send to QC" }));
    expect(
      await screen.findByText("stale plan hash", {
        exact: false,
        selector: "output.conversation-action-error",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Plan Contract · Version 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to QC" })).toBeInTheDocument();
  });

  it("sends the kickoff QC-mode selection on the confirm request and issues no follow-up PATCH", async () => {
    // QCP-4A: the kickoff control used to pin its choice with a follow-up
    // PATCH .../plan-reviews/:reviewId once the review already existed — a
    // race against the worker's first checkpoint. It now rides the confirm
    // request itself, so no PATCH should ever be issued for this flow.
    const proposed = planAction({
      payload: {
        parameters: {
          plan_version_id: "plan-version-1",
          content_hash: "a".repeat(64),
          review: { mode: "qc", reviewer: { provider: "openai", model: "gpt-5.6" }, rounds: 3 },
        },
      },
    });
    const review = planReview({ qc_mode: "gated_when_contested", qc_mode_source: "work_item" });
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: proposed.id }],
      }),
    ];
    const confirmationBodies: Array<{ idempotency_key: string; qc_mode?: string }> = [];
    const requestLog: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        requestLog.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith("/planning-reviewer")) {
          return Response.json({
            provider: "openai",
            model: null,
            mode: "automatic",
            qc_mode: "gated_when_contested",
            allow_unadjudicated_rebuttals: false,
          });
        }
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(history, null, null, { actions: [proposed] });
        }
        if (url.endsWith(`/actions/${proposed.id}/confirm`) && init?.method === "POST") {
          confirmationBodies.push(JSON.parse(String(init.body)));
          return Response.json({
            action: { ...proposed, status: "applied" },
            effect: {
              kind: "qc_started",
              plan_review: review,
              planning_run_id: review.planning_run_id,
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const select = await screen.findByLabelText("QC cadence for this review");
    await waitFor(() => expect(select).toHaveValue("gated_when_contested"));

    await user.click(
      screen.getByRole("button", { name: "Confirm action: Approve plan and send to QC" }),
    );

    await waitFor(() => expect(confirmationBodies).toHaveLength(1));
    expect(confirmationBodies[0]).toMatchObject({ qc_mode: "gated_when_contested" });
    expect(requestLog.some((entry) => entry.includes("/plan-reviews/"))).toBe(false);
  });

  it("restores a failed approval kickoff outcome from durable effect data", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const approval = planAction({
      id: "action-approve-1",
      action_type: "approve_plan",
      status: "applied",
      payload: {
        parameters: {
          plan_version_id: approvedVersion.id,
          content_hash: approvedVersion.content_hash,
          plan_review_id: "review-1",
        },
      },
    });
    const approvalEffect: V2ConversationPlanActionEffectT = {
      schema_version: 2,
      id: "effect-approval-1",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: approval.id,
      effect: {
        kind: "plan_approved",
        plan_version: approvedVersion,
        plan_review_id: "review-1",
        planning_run_id: "planning-run-1",
        transition_status: "created",
        execution_conversation_id: "execution-conversation-failed",
        handoff_id: "handoff-failed",
        kickoff_intent_id: "kickoff-intent-failed",
        execution: {
          status: "failed",
          started: false,
          detail: "The execution bridge returned an unavailable coordinator.",
        },
      },
      created_at: now,
      updated_at: now,
    };
    const history = [
      message({
        id: "message-action",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: approval.id }],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(history, null, null, {
            planVersions: [approvedVersion],
            actions: [approval],
            effects: [approvalEffect],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByText(/plan is approved, but coding kickoff failed/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open project recovery" })).toHaveAttribute(
      "href",
      `/projects/${projectId}`,
    );
    expect(screen.queryByRole("button", { name: /action:/i })).not.toBeInTheDocument();
  });

  it("keeps new-work mode explicit instead of silently reopening the latest conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith(`/api/projects/${projectId}`)) {
          return Response.json({
            name: "Release dashboard",
            workspace_location: "/Users/example/release-dashboard",
            pm_provider: "anthropic",
            pm_model: "claude-sonnet-5",
          });
        }
        if (url.endsWith("/work-items")) return listResponse();
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialNewConversation
        initialBrief="Improve the deployment workflow"
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Describe the project" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("New work", { selector: ".eyebrow" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /Describe the outcome, constraints, and anything the team should preserve/,
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Title (optional)")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe the work" })).toHaveValue(
      "Improve the deployment workflow",
    );
    expect(screen.getByText("Release dashboard")).toBeInTheDocument();
    expect(screen.getByText("/Users/example/release-dashboard")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Phased work/i })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start Planning" })).toBeEnabled(),
    );
    expect(screen.queryByText("Please inspect the API.")).not.toBeInTheDocument();
  });

  it("starts the PM chat with the first message and files without generating a plan", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const uploadContentTypes: string[] = [];
    const firstMessage =
      "I want to build a release dashboard. It should show deployments and current health.";
    const version = planVersion({ created_by_action_id: "action-save-initial" });
    const saveAction = planAction({
      id: "action-save-initial",
      source_message_id: "message-plan-initial",
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: version.plan,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
        },
      },
    });
    const appliedSaveAction = planAction({ ...saveAction, status: "applied" });
    const proposalMessage = message({
      id: "message-plan-initial",
      role: "system",
      sequence: 3,
      parts: [{ type: "action", action_id: saveAction.id }],
    });
    const firstUserMessage = message({
      id: "message-first-user",
      role: "user",
      sequence: 1,
      parts: [{ type: "text", format: "markdown", text: firstMessage }],
    });
    const firstAssistantMessage = message({
      id: "message-first-reply",
      role: "assistant",
      sequence: 2,
      parts: [{ type: "text", format: "markdown", text: "Ready to plan." }],
    });
    let uploaded = 0;
    let planRequested = false;
    let planSaved = false;
    const stream =
      'data: {"type":"start","messageId":"message-first-reply"}\n\n' +
      'data: {"type":"text-start","id":"text-first"}\n\n' +
      'data: {"type":"text-delta","id":"text-first","delta":"Ready to plan."}\n\n' +
      'data: {"type":"text-end","id":"text-first"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    const planStream = `data: {"type":"start"}\n\ndata: ${JSON.stringify({
      type: "data-plan-proposal",
      data: { message: proposalMessage, action: saveAction },
    })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith(`/api/projects/${projectId}`)) {
          return Response.json({ pm_provider: "anthropic", pm_model: "claude-sonnet-5" });
        }
        if (url.endsWith("/work-items") && init?.method === "POST") {
          return Response.json({ work_item: workItem, conversation }, { status: 201 });
        }
        if (url.endsWith("/work-items")) return Response.json({ work_items: [] });
        if (url.endsWith("/attachments") && init?.method === "POST") {
          uploaded += 1;
          const contentType = new Headers(init.headers).get("content-type") ?? "";
          uploadContentTypes.push(contentType);
          return Response.json(
            {
              id: `attachment-${uploaded}`,
              mime: contentType,
              bytes: 12,
              width: null,
              height: null,
              purpose: "objective",
            },
            { status: 201 },
          );
        }
        if (url.endsWith(`/conversations/${conversationId}/plan-proposals/stream`)) {
          planRequested = true;
          return new Response(planStream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        if (url.endsWith(`/actions/${saveAction.id}/confirm`)) {
          planSaved = true;
          return Response.json({
            action: appliedSaveAction,
            effect: { kind: "plan_saved", plan_version: version },
          });
        }
        if (url.endsWith(`/conversations/${conversationId}/messages`)) {
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(
            [firstUserMessage, firstAssistantMessage, ...(planRequested ? [proposalMessage] : [])],
            null,
            null,
            {
              planVersions: planSaved ? [version] : [],
              actions: planRequested ? [planSaved ? appliedSaveAction : saveAction] : [],
            },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    const selectedConversations: string[] = [];
    function RoutedNewWorkspace(): React.ReactElement {
      const [route, setRoute] = useState<{ conversationId: string | null; isNew: boolean }>({
        conversationId: null,
        isNew: true,
      });
      return (
        <ConversationWorkspace
          projectId={projectId}
          initialConversationId={route.conversationId}
          initialNewConversation={route.isNew}
          onConversationSelected={(selectedId) => {
            selectedConversations.push(selectedId);
            setRoute({ conversationId: selectedId, isNew: false });
          }}
          onUnauthorized={() => undefined}
        />
      );
    }
    render(<RoutedNewWorkspace />);

    const composer = await screen.findByRole("textbox", { name: "Describe the work" });
    const modelSelect = await screen.findByRole("combobox", { name: "Conversation model" });
    await waitFor(() => expect(modelSelect).toHaveValue("claude-sonnet-5"));
    fireEvent.change(screen.getByTestId("attachment-file-input"), {
      target: {
        files: [
          new File(["project brief"], "brief.pdf", { type: "application/pdf" }),
          new File(["binary data"], "design-assets.zip", { type: "application/zip" }),
        ],
      },
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    expect(await screen.findByText("design-assets.zip")).toBeInTheDocument();
    await user.type(composer, firstMessage);
    await user.click(screen.getByRole("button", { name: "Start Planning" }));

    expect(await screen.findByText("Ready to plan.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send message" })).toBeInTheDocument();
    await act(async () => undefined);
    const create = calls.find(
      ({ url, init }) => url.endsWith("/work-items") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      title: "Build a release dashboard",
      objective: firstMessage,
      model: "claude-sonnet-5",
      workflow: "phased",
    });
    const submit = calls.find(({ url }) => url.endsWith("/messages"));
    expect(JSON.parse(String(submit?.init?.body)).parts).toEqual([
      { type: "text", format: "markdown", text: firstMessage },
      {
        type: "attachment",
        attachment_id: "attachment-1",
        name: "brief.pdf",
        media_type: "application/pdf",
      },
      {
        type: "attachment",
        attachment_id: "attachment-2",
        name: "design-assets.zip",
        media_type: "application/octet-stream",
      },
    ]);
    expect(new Headers(submit?.init?.headers).get("content-type")).toBe("application/json");
    expect(uploadContentTypes).toEqual(["application/pdf", "application/octet-stream"]);
    expect(planRequested).toBe(false);
    expect(planSaved).toBe(false);
    expect(calls.some(({ url }) => url.endsWith("/plan-proposals/stream"))).toBe(false);
    expect(calls.some(({ url }) => url.endsWith(`/actions/${saveAction.id}/confirm`))).toBe(false);
    expect(selectedConversations).toContain(conversationId);
  });

  it("starts a quick push in Development chat without empty planning or QC stages", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const quickConversation = executionConversation({ id: "conversation-quick" });
    const quickWorkItem = { ...workItem, status: "executing" as const };
    const stream =
      'data: {"type":"start","messageId":"message-quick-reply"}\n\n' +
      'data: {"type":"text-start","id":"text-quick"}\n\n' +
      'data: {"type":"text-delta","id":"text-quick","delta":"Starting the quick push."}\n\n' +
      'data: {"type":"text-end","id":"text-quick"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith(`/api/projects/${projectId}`)) {
          return Response.json({ pm_provider: "anthropic", pm_model: "claude-sonnet-5" });
        }
        if (url.endsWith("/work-items") && init?.method === "POST") {
          return Response.json(
            { work_item: quickWorkItem, conversation: quickConversation },
            { status: 201 },
          );
        }
        if (url.endsWith("/work-items")) return Response.json({ work_items: [] });
        if (url.endsWith(`/conversations/${quickConversation.id}/messages`)) {
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialNewConversation
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("radio", { name: /Quick push/i }));
    await user.type(
      screen.getByRole("textbox", { name: "Describe the work" }),
      "Fix the footer copy",
    );
    await user.click(screen.getByRole("button", { name: "Start Development" }));

    await waitFor(() =>
      expect(
        calls.find(({ url, init }) => url.endsWith("/work-items") && init?.method === "POST"),
      ).toBeDefined(),
    );
    const create = calls.find(
      ({ url, init }) => url.endsWith("/work-items") && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({ workflow: "quick" });
    expect(await screen.findByText("Brief ✓")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Development chat" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QC" })).not.toBeInTheDocument();
  });

  it("renames a conversation from its sidebar context menu", async () => {
    const renamed = {
      ...workItem,
      title: "Release readiness",
      aggregate_version: workItem.aggregate_version + 1,
    };
    let patchedBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
        if (url.endsWith(`/work-items/${workItemId}`) && init?.method === "PATCH") {
          patchedBody = JSON.parse(String(init.body));
          return Response.json({ work_item: renamed });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Actions for Conversation-first planning" }),
    );
    const menu = screen.getByRole("menu", { name: "Conversation actions" });
    expect(menu.parentElement).toBe(document.body);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);
    expect(menu.style.maxHeight).toContain("100dvh");
    await user.click(screen.getByRole("menuitem", { name: "Rename title" }));
    const title = screen.getByRole("textbox", { name: "Work item title" });
    await user.clear(title);
    await user.type(title, "Release readiness");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("heading", { name: "Release readiness" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open work item Release readiness" }),
    ).toBeInTheDocument();
    expect(patchedBody).toEqual({ title: "Release readiness" });
  });

  it("deletes a chat family from its sidebar context menu", async () => {
    let archived = false;
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items") && (!init?.method || init.method === "GET")) {
          return archived ? Response.json({ work_items: [] }) : listResponse();
        }
        if (url.includes("/conversation-navigation?")) {
          return Response.json({ folders: [], items: [], next_cursor: null });
        }
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
        if (url.endsWith(`/work-items/${workItemId}`) && init?.method === "DELETE") {
          archived = true;
          deleted.push(workItemId);
          return Response.json({
            archived_work_item_id: workItemId,
            archived_conversation_count: 1,
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Actions for Conversation-first planning" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete chat" }));
    expect(screen.getByText("Delete this chat? Its history will be archived.")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Confirm delete" }));

    await waitFor(() => expect(deleted).toEqual([workItemId]));
    expect(
      screen.queryByRole("button", { name: "Open work item Conversation-first planning" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Describe the project" }),
    ).toBeInTheDocument();
  });

  it("keeps chat-family navigation persistent, searchable, and collapsible", async () => {
    const execution = executionConversation();
    const secondWorkItem = {
      ...workItem,
      id: "work-item-2",
      title: "Second release train",
      objective: "Coordinate the second release train.",
    };
    const secondConversation = {
      ...conversation,
      id: "conversation-2",
      work_item_id: secondWorkItem.id,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              { work_item: workItem, conversations: [conversation, execution] },
              { work_item: secondWorkItem, conversations: [secondConversation] },
            ],
          });
        }
        if (url.includes("/conversation-navigation?")) {
          return Response.json({
            folders: [],
            items: [
              {
                schema_version: 2,
                id: workItem.id,
                project_id: projectId,
                title: workItem.title,
                status: workItem.status,
                folder_id: null,
                pinned_at: null,
                latest_activity_at: now,
                conversation_count: 2,
                latest_conversation: {
                  id: execution.id,
                  kind: execution.kind,
                  status: execution.status,
                  provider: execution.provider,
                  model: execution.model,
                },
              },
              {
                schema_version: 2,
                id: secondWorkItem.id,
                project_id: projectId,
                title: secondWorkItem.title,
                status: secondWorkItem.status,
                folder_id: null,
                pinned_at: null,
                latest_activity_at: now,
                conversation_count: 1,
                latest_conversation: {
                  id: secondConversation.id,
                  kind: secondConversation.kind,
                  status: secondConversation.status,
                  provider: secondConversation.provider,
                  model: secondConversation.model,
                },
              },
            ],
            next_cursor: null,
          });
        }
        if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    const sidebar = await screen.findByRole("complementary", {
      name: "Project work items",
    });
    expect(sidebar).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pinned" })).toHaveAttribute(
      "data-organization-state",
      "available",
    );
    expect(screen.getByLabelText("Threads in Conversation-first planning")).toContainElement(
      screen.getByRole("button", {
        name: `Open Development chat conversation for ${workItem.title} (active)`,
      }),
    );
    const workItemButton = screen.getByRole("button", {
      name: "Open work item Conversation-first planning",
    });
    expect(workItemButton.querySelector(".conversation-sidebar-item-icon")).toBeInTheDocument();
    expect(workItemButton.querySelector(".conversation-family-title")?.tagName).toBe("SPAN");
    expect(workItemButton.querySelector(".conversation-list-status")).toBeNull();
    expect(workItemButton.querySelector("small")).toBeNull();

    await user.type(screen.getByRole("searchbox", { name: "Search work" }), "second");
    expect(
      screen.queryByRole("button", { name: "Open work item Conversation-first planning" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open work item Second release train" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse work items" }));
    expect(sidebar).toHaveClass("is-collapsed");
    const expandSidebar = sidebar.querySelector<HTMLButtonElement>(
      '[aria-label="Expand work items"]',
    );
    if (!expandSidebar) throw new Error("Expected the collapsed sidebar to expose its toggle.");
    await user.click(expandSidebar);
    expect(sidebar).not.toHaveClass("is-collapsed");
  });

  it("pins chats and creates, renames, moves into, and deletes personal folders", async () => {
    const folder = {
      schema_version: 2 as const,
      id: "folder-release",
      project_id: projectId,
      user_id: "user-1",
      name: "Release",
      sort_order: 0,
      created_at: now,
      updated_at: now,
    };
    let currentFolder = folder;
    let folderId: string | null = null;
    let pinnedAt: string | null = null;
    const organizationBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse();
      if (url.includes("/conversation-navigation?")) {
        return Response.json({
          folders: [],
          items: [
            {
              schema_version: 2,
              id: workItem.id,
              project_id: projectId,
              title: workItem.title,
              status: workItem.status,
              folder_id: folderId,
              pinned_at: pinnedAt,
              latest_activity_at: now,
              conversation_count: 1,
              latest_conversation: {
                id: conversation.id,
                kind: conversation.kind,
                status: conversation.status,
                provider: conversation.provider,
                model: conversation.model,
              },
            },
          ],
          next_cursor: null,
        });
      }
      if (url.endsWith("/conversation-folders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        currentFolder = { ...folder, name: body.name };
        return Response.json({ folder: currentFolder });
      }
      if (url.endsWith(`/conversation-folders/${folder.id}`) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { name: string };
        currentFolder = { ...currentFolder, name: body.name };
        return Response.json({ folder: currentFolder });
      }
      if (url.endsWith(`/conversation-folders/${folder.id}`) && init?.method === "DELETE") {
        folderId = null;
        return Response.json({ deleted_folder_id: folder.id, unfiled_work_item_count: 1 });
      }
      if (url.endsWith(`/work-items/${workItemId}/organization`) && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          folder_id?: string | null;
          pinned?: boolean;
        };
        organizationBodies.push(body);
        if (body.folder_id !== undefined) folderId = body.folder_id;
        if (body.pinned !== undefined) pinnedAt = body.pinned ? now : null;
        return Response.json({
          organization: {
            schema_version: 2,
            project_id: projectId,
            user_id: "user-1",
            work_item_id: workItemId,
            folder_id: folderId,
            pinned_at: pinnedAt,
            created_at: now,
            updated_at: now,
          },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Create folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Release");
    await user.click(screen.getByRole("button", { name: "Create" }));
    const folderName = await screen.findByText("Release");
    expect(folderName.closest(".conversation-folder-row")?.querySelector("svg")).toHaveClass(
      "conversation-sidebar-item-icon",
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Conversation-first planning" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(organizationBodies).toContainEqual({ pinned: true }));
    expect(screen.getByRole("region", { name: "Pinned" })).toContainElement(
      screen.getByRole("button", { name: "Open work item Conversation-first planning" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for Conversation-first planning" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Release" }));
    await waitFor(() => expect(organizationBodies).toContainEqual({ folder_id: "folder-release" }));
    await user.click(
      screen.getByRole("button", { name: "Actions for Conversation-first planning" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(organizationBodies).toContainEqual({ pinned: false }));
    expect(screen.getByText("Release").closest(".conversation-folder")).toContainElement(
      screen.getByRole("button", { name: "Open work item Conversation-first planning" }),
    );

    await user.click(screen.getByRole("button", { name: "Rename folder Release" }));
    const renamedFolder = screen.getByRole("textbox", { name: "New folder name" });
    await user.clear(renamedFolder);
    await user.type(renamedFolder, "Launch");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Launch")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete folder Launch" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Its work items move to Recent.");
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/conversation-folders/${folder.id}`),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Recent" })).toContainElement(
      screen.getByRole("button", { name: "Open work item Conversation-first planning" }),
    );
  });

  it("keeps the target read-only and separates project-run stop from pause proposals", async () => {
    const execution = executionConversation();
    const approvedVersion = planVersion({ status: "approved" });
    const baseHandoff = handoffFor(approvedVersion, execution.id);
    const handoff = {
      ...baseHandoff,
      package: {
        ...baseHandoff.package,
        task_ids: ["task-api"],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [execution],
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          return detailResponse([], null, null, {
            workItem: { ...workItem, status: "executing" },
            conversation: execution,
            planVersions: [approvedVersion],
            handoff,
          });
        }
        if (url.endsWith(`/conversations/${execution.id}/execution`)) {
          return Response.json({
            project_id: projectId,
            conversation_id: execution.id,
            presentation: "active",
            target: {
              execution_target_id: "grant-office",
              name: "Office Mac mini",
            },
            run: {
              run_id: "run-office-1",
              state: "running",
              can_stop: true,
              cancellation: null,
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onUnauthorized={() => undefined}
      />,
    );

    const executionTargetLabel = await screen.findByText("Running on · Office Mac mini");
    expect(executionTargetLabel).toBeVisible();
    expect(document.querySelector(".conversation-header-identity")).toContainElement(
      executionTargetLabel,
    );
    await user.click(screen.getByRole("button", { name: "Chat options" }));
    const agents = await screen.findByRole("button", { name: "Agents 1" });
    expect(screen.queryByRole("complementary", { name: "Agent activity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Agent task to stop" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save execution target/i }),
    ).not.toBeInTheDocument();
    await user.click(agents);

    const drawer = screen.getByRole("complementary", { name: "Agent activity" });
    expect(drawer).toHaveTextContent("1 planned agent task");
    expect(drawer).toHaveTextContent("task-api");
    expect(screen.queryByRole("combobox", { name: "Agent task to stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Stop reason" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop project work" })).toBeDisabled();
    expect(drawer).toHaveTextContent("pause requests remain proposals");

    const closeAgentActivity = screen
      .getAllByRole("button", { name: "Close agent activity" })
      .at(0);
    if (!closeAgentActivity) throw new Error("Expected the agent drawer close control.");
    await user.click(closeAgentActivity);
    expect(screen.queryByRole("complementary", { name: "Agent activity" })).not.toBeInTheDocument();
  });

  it("offers a truthful status refresh instead of claiming an active stream can resume", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) {
        return detailResponse([], { status: "streaming" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("A PM response is streaming.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume response" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          urlOf(input as RequestInfo | URL).endsWith(`/conversations/${conversationId}`),
        ),
      ).toHaveLength(2),
    );
  });

  it("retries the latest terminal pre-visible failure without advertising stale retries", async () => {
    const userMessage = message({
      id: "message-user-retry",
      role: "user",
      sequence: 1,
      parts: [{ type: "text", format: "markdown", text: "Try the provider." }],
    });
    const assistantMessage = message({
      id: "message-assistant-retry",
      role: "assistant",
      sequence: 2,
      parts: [{ type: "text", format: "markdown", text: "The fresh retry worked." }],
    });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let retried = false;
    const stream =
      'data: {"type":"start","messageId":"message-assistant-retry"}\n\n' +
      'data: {"type":"text-start","id":"text-retry"}\n\n' +
      'data: {"type":"text-delta","id":"text-retry","delta":"The fresh retry worked."}\n\n' +
      'data: {"type":"text-end","id":"text-retry"}\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n' +
      "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, init });
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(
            retried ? [userMessage, assistantMessage] : [userMessage],
            null,
            retried ? null : { status: "failed", output_message_id: null },
          );
        }
        if (url.endsWith(`/conversations/${conversationId}/resume`) && init?.method === "POST") {
          retried = true;
          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-vercel-ai-ui-message-stream": "v1",
            },
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByText("The last PM response failed before it completed."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry response" }));

    expect(await screen.findByText("The fresh retry worked.")).toBeInTheDocument();
    const retry = calls.find(({ url, init }) => url.endsWith("/resume") && init?.method === "POST");
    expect(JSON.parse(String(retry?.init?.body))).toEqual({});
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry response" })).not.toBeInTheDocument(),
    );
  });

  it("opens the approved Development chat and waits for an explicit start", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const proposed = planAction({
      id: "action-approve-exact",
      action_type: "approve_plan",
      payload: {
        parameters: {
          plan_version_id: approvedVersion.id,
          content_hash: approvedVersion.content_hash,
          plan_review_id: "review-1",
        },
      },
    });
    const applied = planAction({
      ...proposed,
      status: "applied",
      confirmation_idempotency_key: "confirm-approval-exact",
    });
    const execution = executionConversation();
    const handoff = handoffFor(approvedVersion, execution.id);
    const planningHistory = [
      message({
        id: "message-approve-exact",
        role: "assistant",
        sequence: 1,
        parts: [{ type: "action", action_id: proposed.id }],
      }),
    ];
    const executionHistory = [
      message({
        id: "message-execution-seed",
        role: "system",
        sequence: 1,
        conversation_id: execution.id,
        parts: [
          {
            type: "text",
            format: "markdown",
            text: "Execution starts from the compact approved handoff.",
          },
          { type: "handoff", handoff_id: handoff.id },
        ],
      }),
    ];
    const effect = {
      kind: "plan_approved" as const,
      plan_version: approvedVersion,
      plan_review_id: "review-1",
      planning_run_id: "planning-run-1",
      transition_status: "created" as const,
      execution_conversation_id: execution.id,
      handoff_id: handoff.id,
      kickoff_intent_id: "kickoff-intent-exact",
      execution: { status: "pending" as const, started: null, detail: null },
    };
    let approved = false;
    let developmentStarted = false;
    let developmentStartRequests = 0;
    let releaseDevelopmentRefresh!: () => void;
    const developmentRefresh = new Promise<void>((resolve) => {
      releaseDevelopmentRefresh = resolve;
    });
    const selected = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: {
                  ...workItem,
                  status: approved && !developmentStarted ? "awaiting_approval" : "executing",
                },
                conversations: approved ? [conversation, execution] : [conversation],
              },
            ],
          });
        }
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(planningHistory, null, null, {
            actions: [proposed],
            planVersions: [approvedVersion],
          });
        }
        if (url.endsWith(`/actions/${proposed.id}/confirm`) && init?.method === "POST") {
          approved = true;
          return Response.json({ action: applied, effect });
        }
        if (
          url.endsWith(`/conversations/${execution.id}`) &&
          (!init?.method || init.method === "GET")
        ) {
          if (developmentStarted) await developmentRefresh;
          return detailResponse(executionHistory, null, null, {
            workItem: {
              ...workItem,
              status: developmentStarted ? "executing" : "awaiting_approval",
            },
            conversation: execution,
            planVersions: [approvedVersion],
            handoff,
            latestSummary: compactSummary(execution.id),
            usage: {
              input_tokens: 120,
              output_tokens: 30,
              cost_usd: 0.0123,
              exact_cost: true,
              usage_status: "exact",
              attempt_count: 1,
            },
          });
        }
        if (url.endsWith(`/conversations/${execution.id}/start-development`)) {
          developmentStartRequests += 1;
          developmentStarted = true;
          return Response.json({
            status: "succeeded",
            execution_started: true,
            execution_detail: "Development started.",
          });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    function RoutedWorkspace(): React.ReactElement {
      const [routedConversationId, setRoutedConversationId] = useState(conversationId);
      return (
        <ConversationWorkspace
          projectId={projectId}
          initialConversationId={routedConversationId}
          onConversationSelected={(nextConversationId) => {
            selected(nextConversationId);
            setRoutedConversationId(nextConversationId);
          }}
          onUnauthorized={() => undefined}
        />
      );
    }
    render(<RoutedWorkspace />);

    await user.click(
      await screen.findByRole("button", { name: "Confirm action: Approve and begin" }),
    );

    expect(
      await screen.findByText("Execution starts from the compact approved handoff."),
    ).toBeInTheDocument();
    expect(selected).toHaveBeenCalledWith(execution.id);
    expect(
      screen.getByRole("region", { name: "Development chat conversation" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("conversation-handoff-card")).toHaveTextContent(
      approvedVersion.content_hash.slice(0, 12),
    );
    expect(screen.getByTestId("conversation-handoff-receipt")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-summary-indicator")).toHaveTextContent(
      "Compacted summary v1",
    );
    expect(screen.queryByTestId("conversation-total-usage")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Approved plan ready for development" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start development" }));
    await waitFor(() => expect(developmentStartRequests).toBe(1));
    const busyStart = screen.getByRole("button", { name: "Starting development…" });
    expect(busyStart).toBeDisabled();
    fireEvent.click(busyStart);
    expect(developmentStartRequests).toBe(1);
    await act(async () => {
      releaseDevelopmentRefresh();
      await developmentRefresh;
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Approved plan ready for development" }),
      ).not.toBeInTheDocument(),
    );
    expect(developmentStarted).toBe(true);
    await user.click(screen.getByRole("button", { name: "Chat options" }));
    expect(screen.getByRole("combobox", { name: "Conversation model" })).toHaveValue("gpt-5.6-sol");
  });

  it("replays a lost approval response into the exact durable execution target once", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const approval = planAction({
      id: "action-approve-lost-response",
      action_type: "approve_plan",
      status: "applied",
      payload: {
        parameters: {
          plan_version_id: approvedVersion.id,
          content_hash: approvedVersion.content_hash,
          plan_review_id: "review-1",
        },
      },
    });
    const execution = executionConversation({ id: "execution-after-lost-response" });
    const handoff = handoffFor(approvedVersion, execution.id);
    const effect: V2ConversationPlanActionEffectT = {
      schema_version: 2,
      id: "effect-approval-lost-response",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: approval.id,
      effect: {
        kind: "plan_approved",
        plan_version: approvedVersion,
        plan_review_id: "review-1",
        planning_run_id: "planning-run-1",
        transition_status: "created",
        execution_conversation_id: execution.id,
        handoff_id: handoff.id,
        kickoff_intent_id: "kickoff-after-lost-response",
        execution: { status: "pending", started: null, detail: null },
      },
      created_at: now,
      updated_at: now,
    };
    window.sessionStorage.setItem(
      `norns:conversation-approval-transition:${conversationId}`,
      approval.id,
    );
    const selected = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [{ work_item: workItem, conversations: [conversation, execution] }],
          });
        }
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, {
            conversation: { ...conversation, status: "archived", archived_at: now },
            actions: [approval],
            effects: [effect],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          return detailResponse(
            [
              message({
                id: "message-execution-recovered",
                role: "system",
                sequence: 1,
                conversation_id: execution.id,
                parts: [
                  {
                    type: "text",
                    format: "markdown",
                    text: "Recovered the fresh execution conversation.",
                  },
                  { type: "handoff", handoff_id: handoff.id },
                ],
              }),
            ],
            null,
            null,
            { conversation: execution, handoff },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    function RoutedWorkspace(): React.ReactElement {
      const [routedConversationId, setRoutedConversationId] = useState(conversationId);
      return (
        <ConversationWorkspace
          projectId={projectId}
          initialConversationId={routedConversationId}
          onConversationSelected={(nextConversationId) => {
            selected(nextConversationId);
            setRoutedConversationId(nextConversationId);
          }}
          onUnauthorized={() => undefined}
        />
      );
    }
    render(<RoutedWorkspace />);

    expect(
      await screen.findByText("Recovered the fresh execution conversation."),
    ).toBeInTheDocument();
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith(execution.id);
    expect(
      window.sessionStorage.getItem(`norns:conversation-approval-transition:${conversationId}`),
    ).toBeNull();
  });

  it("keeps archived planning readable and exposes truthful linked-conversation usage", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const archived = { ...conversation, status: "archived" as const, archived_at: now };
    const execution = executionConversation();
    const handoff = handoffFor(approvedVersion, execution.id);
    const planningSentinel = "PLANNING_SENTINEL remains readable only in the archived thread.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [archived, execution],
                conversation_usage: {
                  [archived.id]: {
                    input_tokens: 44,
                    output_tokens: 6,
                    cost_usd: null,
                    exact_cost: false,
                    usage_status: "pending",
                    attempt_count: 1,
                  },
                  [execution.id]: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: null,
                    exact_cost: false,
                    usage_status: "unavailable",
                    attempt_count: 0,
                  },
                },
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${archived.id}`)) {
          return detailResponse(
            [
              message({
                id: "message-planning-sentinel",
                role: "assistant",
                sequence: 1,
                parts: [{ type: "text", format: "markdown", text: planningSentinel }],
              }),
            ],
            null,
            null,
            {
              conversation: archived,
              planVersions: [approvedVersion],
              handoff,
            },
          );
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          return detailResponse([], null, null, { conversation: execution, handoff });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const selected = vi.fn();
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={archived.id}
        onConversationSelected={selected}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText(planningSentinel)).toBeInTheDocument();
    expect(screen.getByText("This plan with pm conversation is archived.")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Message the project PM" }),
    ).not.toBeInTheDocument();
    const archivedConversationButton = screen.getByRole("button", {
      name: `Open Plan with PM conversation for ${workItem.title} (archived)`,
    });
    expect(archivedConversationButton).toHaveAttribute("data-status", "archived");
    expect(archivedConversationButton).not.toHaveTextContent(/tokens|requests|usage|\$/i);
    const executionConversationButton = screen.getByRole("button", {
      name: `Open Development chat conversation for ${workItem.title} (active)`,
    });
    expect(executionConversationButton).toHaveAttribute("data-status", "active");
    expect(executionConversationButton).not.toHaveTextContent(/tokens|requests|usage|\$/i);

    await user.click(screen.getByRole("button", { name: "Open linked development chat" }));
    expect(
      await screen.findByRole("textbox", { name: "Message the development chat" }),
    ).toBeEnabled();
    expect(selected).toHaveBeenCalledWith(execution.id);
  });

  it("retrieves only explicitly selected planning messages and caps one receipt at 20", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const archived = { ...conversation, status: "archived" as const, archived_at: now };
    const execution = executionConversation();
    const handoff = handoffFor(approvedVersion, execution.id);
    const planningMessages = Array.from({ length: 21 }, (_, index) =>
      message({
        id: `planning-message-${index + 1}`,
        role: "assistant",
        sequence: index + 1,
        parts: [
          {
            type: "text",
            format: "markdown",
            text:
              index === 0
                ? "PLANNING_SENTINEL is available only after an explicit planning read."
                : `Planning detail ${index + 1}`,
          },
        ],
      }),
    );
    const receipt = {
      schema_version: 2 as const,
      id: "excerpt-receipt-1",
      project_id: projectId,
      work_item_id: workItemId,
      source_conversation_id: archived.id,
      target_conversation_id: execution.id,
      handoff_id: handoff.id,
      requested_by_user_id: "user-1",
      idempotency_key: "excerpt-request-1",
      request_fingerprint: "1".repeat(64),
      source_message_ids: planningMessages.slice(0, 20).map((item) => item.id),
      source_message_hashes: planningMessages.slice(0, 20).map(() => "2".repeat(64)),
      result_message_id: "message-excerpt-result",
      created_at: now,
    };
    const seed = message({
      id: "message-execution-handoff-only",
      role: "system",
      sequence: 1,
      conversation_id: execution.id,
      parts: [
        { type: "text", format: "markdown", text: "Start only from the compact handoff." },
        { type: "handoff", handoff_id: handoff.id },
      ],
    });
    const excerptResult = message({
      id: receipt.result_message_id,
      role: "system",
      sequence: 2,
      conversation_id: execution.id,
      parts: [
        {
          type: "text",
          format: "markdown",
          text: "Explicitly retrieved 20 planning messages.",
        },
        { type: "planning_excerpt", excerpt_receipt_id: receipt.id },
      ],
    });
    let delivered = false;
    let planningReads = 0;
    let excerptBody: {
      idempotency_key: string;
      source_conversation_id: string;
      message_ids: string[];
    } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [archived, execution],
              },
            ],
          });
        }
        if (
          url.endsWith(`/conversations/${execution.id}`) &&
          (!init?.method || init.method === "GET")
        ) {
          return detailResponse(delivered ? [seed, excerptResult] : [seed], null, null, {
            conversation: execution,
            handoff,
            latestSummary: compactSummary(execution.id),
            excerptReceipts: delivered ? [receipt] : [],
          });
        }
        if (
          url.endsWith(`/conversations/${archived.id}`) &&
          (!init?.method || init.method === "GET")
        ) {
          planningReads += 1;
          return detailResponse(planningMessages, null, null, {
            conversation: archived,
            handoff,
          });
        }
        if (
          url.endsWith(`/conversations/${execution.id}/planning-excerpts`) &&
          init?.method === "POST"
        ) {
          excerptBody = JSON.parse(String(init.body));
          delivered = true;
          return Response.json({ message: excerptResult, receipt });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Start only from the compact handoff.")).toBeInTheDocument();
    expect(screen.queryByText(/PLANNING_SENTINEL/)).not.toBeInTheDocument();
    expect(planningReads).toBe(0);

    await user.click(screen.getByText("Planning context"));
    await user.click(screen.getByRole("button", { name: "Retrieve planning excerpt" }));
    expect(planningReads).toBe(0);
    await user.click(screen.getByRole("button", { name: "Load planning messages" }));
    expect(await screen.findByText(/PLANNING_SENTINEL/)).toBeInTheDocument();
    expect(planningReads).toBe(1);

    const checkboxes = screen.getAllByRole("checkbox");
    for (const checkbox of checkboxes.slice(0, 20)) {
      await user.click(checkbox);
    }
    expect(screen.getByText("20 of 20 messages selected")).toBeInTheDocument();
    expect(checkboxes[20]).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add selected excerpt to execution" }));

    expect(
      await screen.findByText("Explicitly retrieved 20 planning messages."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("conversation-planning-excerpt-receipt")).toHaveTextContent(
      "20 planning messages added",
    );
    expect(excerptBody).toMatchObject({
      idempotency_key: expect.any(String),
      source_conversation_id: archived.id,
      message_ids: planningMessages
        .slice(0, 20)
        .map((item) => item.id)
        .sort(),
    });
  });

  it("shows historical approval truthfully without routing to a null execution thread", async () => {
    const approvedVersion = planVersion({
      status: "approved",
      approved_by_user_id: "user-1",
      approved_at: now,
    });
    const approval = planAction({
      id: "action-approval-before-handoffs",
      action_type: "approve_plan",
      status: "applied",
      payload: {
        parameters: {
          plan_version_id: approvedVersion.id,
          content_hash: approvedVersion.content_hash,
          plan_review_id: "review-1",
        },
      },
    });
    const legacyEffect: V2ConversationPlanActionEffectT = {
      schema_version: 2,
      id: "effect-approval-before-handoffs",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: approval.id,
      effect: {
        kind: "plan_approved",
        plan_version: approvedVersion,
        plan_review_id: "review-1",
        planning_run_id: "planning-run-legacy",
        transition_status: "legacy_unavailable",
        execution_conversation_id: null,
        handoff_id: null,
        kickoff_intent_id: null,
        execution: {
          status: "started",
          started: true,
          detail: "Historical execution started before conversation handoffs existed.",
        },
      },
      created_at: now,
      updated_at: now,
    };
    window.sessionStorage.setItem(
      `norns:conversation-approval-transition:${conversationId}`,
      approval.id,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse(
            [
              message({
                id: "message-legacy-approval",
                role: "assistant",
                sequence: 1,
                parts: [{ type: "action", action_id: approval.id }],
              }),
            ],
            null,
            null,
            {
              planVersions: [approvedVersion],
              actions: [approval],
              effects: [legacyEffect],
            },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const selected = vi.fn();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onConversationSelected={selected}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByText(/approved before development handoffs were recorded/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-execution-link")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /development chat/i })).not.toBeInTheDocument();
    expect(selected).not.toHaveBeenCalled();
  });

  it("hydrates one durable human-wait card on an execution deep link and refreshes its continuation outcome", async () => {
    const execution = executionConversation({ next_message_sequence: 3 });
    const hash = "a".repeat(64);
    const baseWait: V2HumanWaitT = {
      schema_version: 2,
      id: "wait-deep-link",
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: execution.id,
      phase_id: "phase-1",
      task_id: "task-1",
      source_run_id: "run-1",
      source_event_id: "event-ask-1",
      decision_point: "Choose the deployment window",
      question: "Should the migration run before the deployment?",
      question_hash: hash,
      published: {
        branch: "phase5/wait-deep-link",
        commit_sha: hash,
        remote: "origin",
      },
      runtime: {
        runtime_id: "runtime-1",
        session_id: null,
        session_portability: "transcript_only",
        session_portability_evidence: null,
      },
      context: {
        root_command_id: "root-command-1",
        ask_channel_version: 1,
        ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
        root_context_refs: [
          {
            artifact_id: "context-artifact-1",
            content_hash: hash,
            byte_size: 64,
            storage_ref: "artifacts/context-1.json",
          },
        ],
        context_hash: hash,
        task_package_hash: hash,
        compact_summary: "The migration is ready and waiting on its deployment window.",
        compact_summary_hash: hash,
      },
      budget: {
        reservation_id: "reservation-1",
        root_run_id: "root-run-1",
      },
      status: "awaiting_human",
      version: 1,
      expires_at: "2026-07-28T12:00:00.000Z",
      answered_at: null,
      resumed_at: null,
      created_at: now,
      updated_at: now,
    };
    const answer: V2HumanWaitAnswerT = {
      schema_version: 2,
      id: "answer-1",
      wait_id: baseWait.id,
      project_id: projectId,
      answered_by_user_id: "user-1",
      action_id: "action-answer-1",
      idempotency_key: "answer-proposal-1",
      request_fingerprint: hash,
      answer: "Run it before deployment.",
      rationale: "Rollback is simpler before traffic moves.",
      answer_receipt_hash: hash,
      created_at: now,
    };
    const continuation: V2HumanWaitContinuationT = {
      schema_version: 2,
      id: "continuation-1",
      wait_id: baseWait.id,
      answer_id: answer.id,
      root_run_id: "root-run-1",
      resume_command_id: "resume-command-1",
      resume_job_id: "resume-job-1",
      budget_reservation_id: "reservation-1",
      saved_commit_sha: hash,
      context_hash: hash,
      answer_receipt_hash: hash,
      replay_context_ref: {
        artifact_id: "replay-artifact-1",
        content_hash: hash,
        byte_size: 128,
        storage_ref: "artifacts/replay-1.json",
      },
      runner_id: "runner-2",
      runner_generation: 4,
      delivery_receipt_hash: hash,
      status: "applied",
      created_at: now,
      updated_at: now,
    };
    const initialMessage = message({
      id: "message-human-wait",
      role: "assistant",
      conversation_id: execution.id,
      sequence: 1,
      parts: [{ type: "human_wait", human_wait_id: baseWait.id }],
    });
    const updateMessage = message({
      id: "message-human-wait-update",
      role: "assistant",
      conversation_id: execution.id,
      sequence: 2,
      parts: [
        {
          type: "human_wait_update",
          human_wait_id: baseWait.id,
          status: "resumed",
        },
      ],
    });
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [conversation, execution],
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          detailCalls += 1;
          const resumed = detailCalls > 1;
          return detailResponse(
            resumed ? [initialMessage, updateMessage] : [initialMessage],
            null,
            null,
            {
              workItem: { ...workItem, status: "executing" },
              conversation: execution,
              humanWaits: [
                {
                  wait: resumed
                    ? {
                        ...baseWait,
                        status: "resumed",
                        version: 3,
                        answered_at: now,
                        resumed_at: now,
                      }
                    : baseWait,
                  answer: resumed ? answer : null,
                  continuation: resumed ? continuation : null,
                },
              ],
            },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onConversationSelected={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("article", { name: "Choose the deployment window" }),
    ).toHaveTextContent("Should the migration run before the deployment?");
    expect(screen.getByText("phase5/wait-deep-link")).toBeInTheDocument();
    expect(screen.getAllByTestId(`human-wait-${baseWait.id}`)).toHaveLength(1);

    // Execution-side controls live in the Development chat stage.
    await user.click(screen.getByRole("button", { name: "Development chat" }));
    expect(screen.getByTestId("execution-action-composer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chat options" }));
    await user.click(screen.getByRole("button", { name: "Refresh conversation" }));

    expect(await screen.findByTestId(`human-wait-update-${baseWait.id}`)).toHaveTextContent(
      "resumed · continuation applied",
    );
    expect(screen.getAllByTestId(`human-wait-${baseWait.id}`)).toHaveLength(1);
    expect(screen.getByText("Run it before deployment.")).toBeInTheDocument();
  });

  it("retries a byte-equivalent execution proposal whose action points to its new visible source message", async () => {
    const execution = executionConversation({ next_message_sequence: 3 });
    const exactDirection = "Use the restart-safe adapter and stop at the migration boundary.";
    const sourceMessage = message({
      id: "message-visible-direction",
      role: "user",
      conversation_id: execution.id,
      sequence: 2,
      parts: [
        { type: "text", format: "plain", text: exactDirection },
        { type: "action", action_id: "action-visible-direction" },
      ],
    });
    const directionAction = planAction({
      id: "action-visible-direction",
      conversation_id: execution.id,
      actor: { actor_type: "human", actor_id: "user-1" },
      source_message_id: sourceMessage.id,
      action_type: "redirect_agent",
      payload: {
        parameters: {
          task_id: "task-7",
          run_id: "run-7",
          direction: exactDirection,
          delivery_preference: "live_or_checkpoint",
        },
      },
    });
    const seedMessage = message({
      id: "message-execution-existing",
      role: "system",
      conversation_id: execution.id,
      sequence: 1,
      parts: [{ type: "text", format: "plain", text: "Execution handoff loaded." }],
    });
    const requestBodies: string[] = [];
    let proposalRecorded = false;
    let proposalAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [conversation, execution],
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}/actions`) && init?.method === "POST") {
          requestBodies.push(String(init.body));
          proposalAttempts += 1;
          if (proposalAttempts === 1) throw new TypeError("connection reset");
          proposalRecorded = true;
          return Response.json({ message: sourceMessage, action: directionAction });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          return detailResponse(
            proposalRecorded ? [seedMessage, sourceMessage] : [seedMessage],
            null,
            null,
            {
              workItem: { ...workItem, status: "executing" },
              conversation: execution,
              actions: proposalRecorded ? [directionAction] : [],
            },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onConversationSelected={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Execution handoff loaded.")).toBeInTheDocument();
    expect(requestBodies).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Development chat" }));
    await user.click(screen.getByText("Decisions, direction, pause, and artifacts"));
    await user.type(screen.getByRole("textbox", { name: "Task ID" }), "task-7");
    await user.type(screen.getByRole("textbox", { name: "Active run ID" }), "run-7");
    await user.type(screen.getByRole("textbox", { name: "Direction" }), exactDirection);
    await user.click(screen.getByRole("button", { name: "Prepare action for confirmation" }));

    expect(await screen.findByText("Exact request locked")).toBeInTheDocument();
    expect(screen.getByText(/byte-equivalent request and idempotency key/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry exact action proposal" }));

    expect(
      await screen.findByRole("button", { name: "Confirm action: Send task direction" }),
    ).toBeInTheDocument();
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    const proposalBody = JSON.parse(requestBodies[0] ?? "{}") as Record<string, unknown>;
    expect(proposalBody).not.toHaveProperty("source_message_id");
    expect(proposalBody).toMatchObject({
      message: exactDirection,
      action_type: "redirect_agent",
    });
    expect(screen.getByText(sourceMessage.id)).toBeInTheDocument();
    expect(screen.getAllByTestId("conversation-action-redirect_agent")).toHaveLength(1);
  });

  it("keeps an uncertain execution request locked across reload until its exact source-message receipt appears", async () => {
    const execution = executionConversation({ next_message_sequence: 4 });
    const exactDirection = "Apply the migration only at the saved checkpoint.";
    const exactRequest = {
      idempotency_key: "execution-proposal-owned-key",
      message: exactDirection,
      action_type: "redirect_agent" as const,
      payload: {
        parameters: {
          task_id: "task-7",
          run_id: "run-7",
          direction: exactDirection,
          delivery_preference: "live_or_checkpoint",
        },
      },
    };
    const storageKey = `norns:execution-action-proposal:request:${execution.id}`;
    window.sessionStorage.setItem(storageKey, JSON.stringify(exactRequest));
    window.sessionStorage.setItem(
      `norns:execution-action-proposal:${execution.id}`,
      exactRequest.idempotency_key,
    );
    const unrelatedSource = message({
      id: "message-unrelated-direction",
      role: "user",
      conversation_id: execution.id,
      client_message_id: "execution-proposal-someone-else",
      sequence: 2,
      parts: [
        { type: "text", format: "plain", text: exactDirection },
        { type: "action", action_id: "action-unrelated-direction" },
      ],
    });
    const unrelatedAction = planAction({
      id: "action-unrelated-direction",
      conversation_id: execution.id,
      actor: { actor_type: "human", actor_id: "user-2" },
      source_message_id: unrelatedSource.id,
      action_type: exactRequest.action_type,
      payload: exactRequest.payload,
    });
    const exactSource = message({
      id: "message-exact-direction-receipt",
      role: "user",
      conversation_id: execution.id,
      client_message_id: exactRequest.idempotency_key,
      sequence: 3,
      parts: [
        { type: "text", format: "plain", text: exactDirection },
        { type: "action", action_id: "action-exact-direction-receipt" },
      ],
    });
    const exactAction = planAction({
      id: "action-exact-direction-receipt",
      conversation_id: execution.id,
      actor: { actor_type: "human", actor_id: "user-1" },
      source_message_id: exactSource.id,
      action_type: exactRequest.action_type,
      payload: exactRequest.payload,
    });
    const seedMessage = message({
      id: "message-execution-reload",
      role: "system",
      conversation_id: execution.id,
      sequence: 1,
      parts: [{ type: "text", format: "plain", text: "Execution handoff loaded." }],
    });
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [conversation, execution],
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          detailCalls += 1;
          const exactReceiptVisible = detailCalls > 1;
          return detailResponse(
            exactReceiptVisible
              ? [seedMessage, unrelatedSource, exactSource]
              : [seedMessage, unrelatedSource],
            null,
            null,
            {
              workItem: { ...workItem, status: "executing" },
              conversation: execution,
              actions: exactReceiptVisible ? [unrelatedAction, exactAction] : [unrelatedAction],
            },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onConversationSelected={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Development chat" }));
    expect(await screen.findByText("Exact request locked")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify(exactRequest));

    await user.click(screen.getByRole("button", { name: "Chat options" }));
    await user.click(screen.getByRole("button", { name: "Refresh conversation" }));

    // A hard refresh remounts the conversation thread, which resets the work
    // tab back to its Plan default.
    await user.click(await screen.findByRole("button", { name: "Development chat" }));
    expect(await screen.findByText("Prepare execution action")).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
  });

  it("keeps an uncertain human-wait answer locked until the matching source-message client key appears", async () => {
    const execution = executionConversation({ next_message_sequence: 4 });
    const wait = humanWait({ conversation_id: execution.id });
    const exactRequest = {
      idempotency_key: "wait-answer-owned-key",
      expected_version: wait.version,
      question_hash: wait.question_hash,
      answer: "Run it before deployment.",
      rationale: "Rollback is simpler before traffic moves.",
    };
    const storageKey = `norns:human-wait-answer-proposal:request:${wait.id}`;
    window.sessionStorage.setItem(storageKey, JSON.stringify(exactRequest));
    window.sessionStorage.setItem(
      `norns:human-wait-answer-proposal:${wait.id}`,
      exactRequest.idempotency_key,
    );
    const waitMessage = message({
      id: "message-wait-reload",
      role: "assistant",
      conversation_id: execution.id,
      sequence: 1,
      parts: [{ type: "human_wait", human_wait_id: wait.id }],
    });
    const unrelatedSource = message({
      id: "message-unrelated-wait-answer",
      role: "user",
      conversation_id: execution.id,
      client_message_id: "wait-answer-someone-else",
      sequence: 2,
      parts: [
        { type: "text", format: "plain", text: exactRequest.answer },
        { type: "action", action_id: "action-unrelated-wait-answer" },
      ],
    });
    const actionPayload = {
      parameters: {
        wait_id: wait.id,
        expected_version: exactRequest.expected_version,
        question_hash: exactRequest.question_hash,
        answer: exactRequest.answer,
        rationale: exactRequest.rationale,
      },
    };
    const unrelatedAction = planAction({
      id: "action-unrelated-wait-answer",
      conversation_id: execution.id,
      actor: { actor_type: "human", actor_id: "user-2" },
      source_message_id: unrelatedSource.id,
      action_type: "answer_human_wait",
      payload: actionPayload,
    });
    const exactSource = message({
      id: "message-exact-wait-answer-receipt",
      role: "user",
      conversation_id: execution.id,
      client_message_id: exactRequest.idempotency_key,
      sequence: 3,
      parts: [
        { type: "text", format: "plain", text: exactRequest.answer },
        { type: "action", action_id: "action-exact-wait-answer-receipt" },
      ],
    });
    const exactAction = planAction({
      id: "action-exact-wait-answer-receipt",
      conversation_id: execution.id,
      actor: { actor_type: "human", actor_id: "user-1" },
      source_message_id: exactSource.id,
      action_type: "answer_human_wait",
      payload: actionPayload,
    });
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) {
          return Response.json({
            work_items: [
              {
                work_item: { ...workItem, status: "executing" },
                conversations: [conversation, execution],
              },
            ],
          });
        }
        if (url.endsWith(`/conversations/${execution.id}`)) {
          detailCalls += 1;
          const exactReceiptVisible = detailCalls > 1;
          return detailResponse(
            exactReceiptVisible
              ? [waitMessage, unrelatedSource, exactSource]
              : [waitMessage, unrelatedSource],
            null,
            null,
            {
              workItem: { ...workItem, status: "executing" },
              conversation: execution,
              actions: exactReceiptVisible ? [unrelatedAction, exactAction] : [unrelatedAction],
              humanWaits: [{ wait, answer: null, continuation: null }],
            },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={execution.id}
        onConversationSelected={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("article", { name: "Choose the deployment window" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify(exactRequest)),
    );

    await user.click(screen.getByRole("button", { name: "Chat options" }));
    await user.click(screen.getByRole("button", { name: "Refresh conversation" }));

    await waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
  });

  it("does not resolve a conversation ID outside the current project scope", async () => {
    const foreignConversationId = "conversation-from-another-project";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/projects/${projectId}/conversations/${foreignConversationId}`)) {
        return Response.json(
          { error: "conversation_not_found", message: "Conversation not found." },
          { status: 404 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const selected = vi.fn();
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={foreignConversationId}
        onConversationSelected={selected}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByTestId("conversation-error")).toHaveTextContent(
      "Conversation not found.",
    );
    expect(selected).not.toHaveBeenCalled();
    expect(screen.queryByText("PLANNING_SENTINEL")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v2/projects/${projectId}/conversations/${foreignConversationId}`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("shows two work tabs with no QC history and three once a review exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, { reviews: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await screen.findByRole("button", { name: "Plan with PM" });
    expect(screen.getByRole("button", { name: "Development chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QC" })).not.toBeInTheDocument();
  });

  it("keeps planning visible until QC actually owns the work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, { reviews: [], runsQc: true });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByRole("button", { name: "Plan with PM" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QC" })).not.toBeInTheDocument();
  });

  it("hides the QC tab when the project has review turned off (zero rounds)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, { reviews: [], runsQc: false });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await screen.findByRole("button", { name: "Plan with PM" });
    expect(screen.queryByRole("button", { name: "QC" })).not.toBeInTheDocument();
  });

  it("removes all planning navigation and shows finding choices when QC needs the user", async () => {
    const review = planReview({
      status: "awaiting_human",
      paused_checkpoint: "after_review",
      paused_at_round: 1,
      rounds_completed: 1,
      max_rounds: 3,
      completed_at: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, { reviews: [review] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Quality control" })).toBeInTheDocument();
    expect(screen.getAllByText("Round 1 of 3").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QC" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Accept all 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Choose individually/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Accept none/ })).toBeInTheDocument();
  });

  it("opens PM progress on the first Send to PM click while the handoff request is pending", async () => {
    const awaitingDecision = planReview({
      status: "awaiting_human",
      qc_mode: "gated_when_contested",
      paused_checkpoint: "after_review",
      paused_at_round: 1,
      rounds_completed: 1,
      completed_at: null,
      dispositions: [],
    });
    let resolveResume!: (response: Response) => void;
    const pendingResume = new Promise<Response>((resolve) => {
      resolveResume = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (
        url.endsWith(`/conversations/${conversationId}`) &&
        (!init?.method || init.method === "GET")
      ) {
        return detailResponse([], null, null, { reviews: [awaitingDecision] });
      }
      if (url.endsWith(`/plan-reviews/${awaitingDecision.id}/resume`) && init?.method === "POST") {
        return pendingResume;
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Send to PM" }));

    expect(await screen.findByLabelText("Quality control progress")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send to PM" })).not.toBeInTheDocument();
    expect(screen.getByText("Working now")).toBeVisible();
    expect(screen.getByText("Planning manager")).toBeVisible();
    expect(screen.getByText("Anthropic · claude-sonnet-5")).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          urlOf(input).endsWith(`/plan-reviews/${awaitingDecision.id}/resume`) &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);

    await act(async () => {
      resolveResume(Response.json({ review: awaitingDecision }));
      await pendingResume;
    });
  });

  it("refreshes a stale QC decision instead of showing the raw state race", async () => {
    const awaitingDecision = planReview({
      status: "awaiting_human",
      qc_mode: "gated_when_contested",
      paused_checkpoint: "after_review",
      paused_at_round: 1,
      rounds_completed: 1,
      completed_at: null,
      dispositions: [],
    });
    const running = planReview({
      status: "running",
      qc_mode: "gated_when_contested",
      paused_checkpoint: null,
      paused_at_round: null,
      rounds_completed: 1,
      completed_at: null,
      dispositions: [],
    });
    let detailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (
          url.endsWith(`/conversations/${conversationId}`) &&
          (!init?.method || init.method === "GET")
        ) {
          detailCalls += 1;
          return detailResponse([], null, null, {
            reviews: [detailCalls === 1 ? awaitingDecision : running],
          });
        }
        if (
          url.endsWith(`/plan-reviews/${awaitingDecision.id}/resume`) &&
          init?.method === "POST"
        ) {
          return Response.json(
            {
              error: "invalid_plan_state",
              message: `review "${awaitingDecision.id}" is not awaiting human input`,
            },
            { status: 409 },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Send to PM" }));
    await waitFor(() => expect(detailCalls).toBeGreaterThan(1));
    expect(screen.queryByText(/not awaiting human input/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to PM" })).not.toBeInTheDocument();
  });

  it("never offers a qc_interim plan version as the default target for mockups", async () => {
    const human = planVersion();
    const interim = planVersion({
      id: "plan-version-interim-1",
      version: 2,
      status: "candidate",
      origin: "qc_interim",
      supersedes_plan_version_id: human.id,
      diff_from_previous: { added: ["Added Web UI task"], changed: [], removed: [] },
      plan: {
        plan: makePlan({ modules: [makeCoreApiModule(), makeWebUiModule()] }),
        staffing: [
          {
            module_id: "core-api",
            agent_role: "implementation",
            provider: "openai",
            model: "gpt-5.6",
          },
          {
            module_id: "web-ui",
            agent_role: "implementation",
            provider: "openai",
            model: "gpt-5.6",
          },
        ],
        verification_requirements: [],
        open_decisions: [],
        estimated_budget: { currency: "USD", amount: 50 },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, { planVersions: [human, interim] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    await user.click(await screen.findByText("UI preview", { exact: true }));
    const taskSelect = (await screen.findByLabelText("Plan module")) as HTMLSelectElement;
    const optionLabels = Array.from(taskSelect.options).map((option) => option.textContent);

    expect(optionLabels.some((label) => label?.includes("Core API"))).toBe(true);
    expect(optionLabels.some((label) => label?.includes("Web UI"))).toBe(false);
  });

  it("never routes a QC finding back into the PM screen", async () => {
    const version = planVersion({ status: "in_qc" });
    const review = planReview({ plan_version_id: version.id });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/work-items")) return listResponse();
        if (url.endsWith(`/conversations/${conversationId}`)) {
          return detailResponse([], null, null, { planVersions: [version], reviews: [review] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    render(
      <ConversationWorkspace
        projectId={projectId}
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByTestId("qc-new-workspace")).toBeInTheDocument();
    expect(screen.getByText("Make cancellation verification explicit.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discuss in Plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan with PM" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Message the project PM" }),
    ).not.toBeInTheDocument();
  });
});
