import type {
  V2ConversationActionT,
  V2ConversationPlanActionEffectT,
  V2ConversationPlanReviewT,
  V2WorkConversationT,
  V2WorkItemT,
  V2WorkMessageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationWorkspace } from "./ConversationWorkspace";
import { makeCoreApiModule, makePlan } from "./test/fixtures";

const projectId = "project-conversation";
const workItemId = "work-item-1";
const conversationId = "conversation-1";
const now = "2026-07-27T12:00:00.000Z";

const workItem: V2WorkItemT = {
  schema_version: 2,
  id: workItemId,
  project_id: projectId,
  created_by_user_id: "user-1",
  title: "Conversation-first planning",
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
    status: "converged",
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
      },
    ],
    revised_plan_version_id: null,
    started_at: now,
    completed_at: now,
    failure_code: null,
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
    planVersions?: V2WorkPlanVersionT[];
    actions?: V2ConversationActionT[];
    reviews?: V2ConversationPlanReviewT[];
    effects?: V2ConversationPlanActionEffectT[];
  } = {},
): Response {
  return Response.json({
    work_item: resources.workItem ?? workItem,
    conversation,
    messages,
    active_attempt: activeAttempt,
    retryable_attempt: retryableAttempt,
    plan_versions: resources.planVersions ?? [],
    actions: resources.actions ?? [],
    plan_reviews: resources.reviews ?? [],
    action_effects: resources.effects ?? [],
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
        ],
      }),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/work-items")) return listResponse();
      if (url.endsWith(`/conversations/${conversationId}`)) return detailResponse(history);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(screen.getByTestId("conversation-model-pin")).toHaveTextContent(
      "anthropic · claude-sonnet-5",
    );
    expect(screen.queryByTestId("conversation-welcome")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry response" })).not.toBeInTheDocument();

    const callsBeforeParentRerender = fetchMock.mock.calls.length;
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

    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeParentRerender);
    expect(screen.getByText("Please inspect the API.")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-model-pin")).toBeInTheDocument();
  });

  it("hydrates exact Plan Contract, QC, and explicit action cards from durable detail", async () => {
    const version = planVersion({ status: "in_qc" });
    const review = planReview();
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
        initialConversationId={conversationId}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("Plan Contract · Version 1")).toBeInTheDocument();
    expect(screen.getByText("Deliver conversation-first planning")).toBeInTheDocument();
    expect(screen.getByText("Make cancellation verification explicit.")).toBeInTheDocument();
    expect(screen.getByText("Added the requested telemetry assertion.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm action: Approve and begin" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Change direction" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Update plan proposal" })).toBeDisabled();
    expect(
      screen.getByText("Plan proposal updates are unavailable while work is awaiting approval."),
    ).toBeInTheDocument();
  });

  it("generates and hydrates an inert plan proposal before any immutable version exists", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Create plan proposal" }));
    expect(screen.getByRole("button", { name: "Create plan proposal" })).toHaveTextContent(
      "Generating proposal…",
    );
    generated = true;
    resolveProposal(Response.json({ message: proposalMessage, action: saveAction }));

    expect(await screen.findByText("I drafted a structured plan proposal.")).toBeInTheDocument();
    expect(screen.getByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update plan proposal" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm action: Save plan candidate" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Plan Contract · Version 1")).not.toBeInTheDocument();
    expect(proposalBodies).toHaveLength(1);
    expect(proposalBodies[0]?.idempotency_key).toEqual(expect.any(String));

    await user.click(screen.getByRole("button", { name: "Confirm action: Save plan candidate" }));
    expect(await screen.findByText("Plan Contract · Version 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm action: Send to QC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm action: Reject plan" })).toBeInTheDocument();
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

    await user.click(await screen.findByRole("button", { name: "Create plan proposal" }));
    expect(await screen.findByTestId("conversation-plan-proposal-error")).toHaveTextContent(
      "A plan proposal request is already in progress.",
    );
    await user.click(screen.getByRole("button", { name: "Create plan proposal" }));

    expect(await screen.findByText("Proposed Plan Contract")).toBeInTheDocument();
    expect(submittedKeys).toHaveLength(2);
    expect(submittedKeys[1]).toBe(submittedKeys[0]);
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

    await user.click(await screen.findByRole("button", { name: "Create plan proposal" }));
    expect(await screen.findByTestId("conversation-plan-proposal-error")).toHaveTextContent(
      "could not produce a valid Plan Contract",
    );
    await user.click(screen.getByRole("button", { name: "Create plan proposal" }));

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
    expect(await screen.findByRole("alert")).toHaveTextContent("plan hash is stale");
    expect(screen.getByRole("textbox", { name: "Change direction" })).toHaveValue(direction);

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
    expect(await screen.findByRole("alert")).toHaveTextContent("Request status is uncertain.");
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
    const settled = planReview();
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
          reviews: [detailCalls === 1 ? queued : settled],
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
    expect(
      screen.getByText(
        "QC is queued. Findings and PM dispositions will appear here after the review settles.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update plan proposal" })).toBeDisabled();
    expect(
      screen.getByText("Plan proposal updates are unavailable while QC is queued."),
    ).toBeInTheDocument();
    expect(detailCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(detailCalls).toBe(2);
    expect(screen.getByText("Make cancellation verification explicit.")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(detailCalls).toBe(2);
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
    expect(screen.getByRole("button", { name: "Update plan proposal" })).toBeDisabled();
    expect(
      screen.getByText("The approved plan is locked. Continue from the current execution state."),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(detailCalls).toBe(2);
    expect(screen.getByText(/coding kickoff failed/i)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(detailCalls).toBe(2);
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
    expect(calls.some(({ url }) => url.includes("/actions"))).toBe(false);
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
      name: "Confirm action: Send to QC",
    });
    await user.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirmation status is uncertain.");
    expect(
      window.sessionStorage.getItem(`norns:conversation-action-confirmation:${proposed.id}`),
    ).toBe(confirmationBodies[0]?.idempotency_key);
    await user.click(screen.getByRole("button", { name: "Confirm action: Send to QC" }));

    await waitFor(() => expect(confirmationBodies).toHaveLength(2));
    expect(confirmationBodies[0]?.idempotency_key).toEqual(expect.any(String));
    expect(confirmationBodies[1]?.idempotency_key).toBe(confirmationBodies[0]?.idempotency_key);
    expect(await screen.findByText("QC attempt 1 is converged.")).toBeInTheDocument();
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
      name: "Confirm action: Send to QC",
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    await user.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirmation status is uncertain.");
    await user.click(screen.getByRole("button", { name: "Confirm action: Send to QC" }));
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

    await user.click(await screen.findByRole("button", { name: "Continue action: Send to QC" }));
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

    await user.click(await screen.findByRole("button", { name: "Confirm action: Send to QC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("stale plan hash");
    expect(screen.getByText("Plan Contract · Version 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm action: Send to QC" })).toBeInTheDocument();
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
        if (url.endsWith("/work-items")) return listResponse();
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(
      <ConversationWorkspace
        projectId={projectId}
        initialNewConversation
        onUnauthorized={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "What work should the PM help you plan?" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Please inspect the API.")).not.toBeInTheDocument();
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
});
