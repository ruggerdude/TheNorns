import {
  V2ConversationPlanReview,
  type V2ConversationPlanReviewT,
  type V2WorkPlanVersionT,
} from "@norns/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QcWorkspace, qcReviewJourney } from "./QcWorkspace";
import { makeCoreApiModule, makePlan } from "./test/fixtures";

const now = "2026-08-02T12:00:00.000Z";

function review(overrides: Partial<V2ConversationPlanReviewT> = {}): V2ConversationPlanReviewT {
  return V2ConversationPlanReview.parse({
    schema_version: 2,
    id: "review-1",
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    action_id: "action-1",
    plan_version_id: "plan-1",
    planning_run_id: "run-1",
    initiated_by_user_id: "user-1",
    attempt_number: 1,
    pm_provider: "anthropic",
    pm_model: "claude",
    reviewer_provider: "openai",
    reviewer_model: "gpt",
    review_mode: "qc",
    revision_format: "targeted_v1",
    usage_request_group_id: "usage-1",
    status: "awaiting_human",
    qc_mode: "gated_when_contested",
    qc_mode_source: "project_default",
    qc_mode_changed_at_round: null,
    qc_mode_changed_by_user_id: null,
    allow_unadjudicated_rebuttals: false,
    human_steered_rounds: [],
    rounds_completed: 0,
    max_rounds: 2,
    round_exchanges: [
      {
        round: 1,
        reviewed_plan_content_hash: "a".repeat(64),
        reviewer: {
          provider: "openai",
          model: "gpt",
          findings: [
            {
              severity: "must_fix",
              module_id: null,
              finding: "Deployment target is undefined.",
              recommendation: "Choose and document a deployment target.",
            },
            {
              severity: "should_fix",
              module_id: "parser",
              finding: "Accuracy tolerance is unclear.",
              recommendation: "Add a measurable tolerance.",
            },
          ],
        },
        pm: null,
      },
    ],
    chat_messages: [],
    markdown_artifacts: [],
    live_progress: null,
    plan_content_hash: "a".repeat(64),
    result_plan_content_hash: "a".repeat(64),
    context_manifest: { entries: [], context_hash: "b".repeat(64) },
    findings: [
      {
        id: "finding-1",
        index: 0,
        severity: "must_fix",
        module_id: null,
        finding: "Deployment target is undefined.",
        recommendation: "Choose and document a deployment target.",
        recurs_of_finding_ids: [],
      },
      {
        id: "finding-2",
        index: 1,
        severity: "should_fix",
        module_id: "parser",
        finding: "Accuracy tolerance is unclear.",
        recommendation: "Add a measurable tolerance.",
        recurs_of_finding_ids: [],
      },
    ],
    finding_decisions: [],
    dispositions: [],
    revised_plan_version_id: null,
    paused_checkpoint: "after_review",
    paused_at_round: 1,
    started_at: now,
    completed_at: null,
    failure_code: null,
    cancelled_by_user_id: null,
    cancellation_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function revisedPlanVersion(): V2WorkPlanVersionT {
  const module = makeCoreApiModule({
    description: "Store the selected deployment target and measurable accuracy tolerance.",
  });
  return {
    schema_version: 2,
    id: "plan-version-2",
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    created_by_user_id: "user-1",
    version: 2,
    status: "changes_requested",
    origin: "qc_interim",
    plan: {
      plan: makePlan({
        objective: "Ship the revised, measurable deployment plan",
        modules: [module],
      }),
      staffing: [
        {
          module_id: module.id,
          agent_role: "implementation",
          provider: "anthropic",
          model: "claude",
        },
      ],
      verification_requirements: ["pnpm test"],
      open_decisions: [],
      estimated_budget: { currency: "USD", amount: 20 },
    },
    content_hash: "c".repeat(64),
    created_by_action_id: "action-revision-2",
    supersedes_plan_version_id: "plan-1",
    diff_from_previous: {
      added: ["Documented the deployment target"],
      changed: ["Made the accuracy tolerance measurable"],
      removed: [],
    },
    approved_by_user_id: null,
    approved_at: null,
    created_at: now,
    updated_at: now,
  };
}

function renderWorkspace(
  current = review(),
  error?: string,
  planVersion: V2WorkPlanVersionT | null = null,
) {
  const onTriage = vi.fn().mockResolvedValue(undefined);
  const onContinueWithoutQc = vi.fn().mockResolvedValue(undefined);
  render(
    <QcWorkspace
      review={current}
      planVersion={planVersion}
      history={[]}
      actions={{}}
      busy={false}
      error={error}
      onTriage={onTriage}
      onResume={vi.fn().mockResolvedValue(undefined)}
      onAdjudicate={vi.fn().mockResolvedValue(undefined)}
      onContinueWithoutQc={onContinueWithoutQc}
      onCancel={vi.fn().mockResolvedValue(undefined)}
      onStopAll={vi.fn().mockResolvedValue(undefined)}
      onChat={vi.fn().mockResolvedValue(undefined)}
      onConfirmAction={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { onTriage, onContinueWithoutQc };
}

describe("QcWorkspace", () => {
  it("moves the QC journey from reviewer to PM and back for the next round", () => {
    const liveProgress = (
      stage: "reviewing" | "revising",
      round: number,
      provider: "openai" | "anthropic",
      model: string,
    ) => ({
      stage,
      round,
      attempt: 1,
      provider,
      model,
      completed_items: 0,
      total_items: 2,
      output_characters: 0,
      activity: stage === "revising" ? "Revising the plan" : "Reviewing the plan",
      output_preview: null,
      started_at: now,
      checkpoint_at: now,
    });

    expect(
      qcReviewJourney(
        review({
          status: "running",
          paused_checkpoint: null,
          paused_at_round: null,
          findings: [],
          dispositions: [],
          live_progress: liveProgress("reviewing", 1, "openai", "gpt"),
        }),
      ),
    ).toEqual({ active: "qc", round: 1, maxRounds: 2 });
    expect(
      qcReviewJourney(
        review({
          status: "running",
          paused_checkpoint: null,
          paused_at_round: null,
          findings: [],
          dispositions: [],
          live_progress: liveProgress("revising", 1, "anthropic", "claude"),
        }),
      ),
    ).toEqual({ active: "pm", round: 1, maxRounds: 2 });
    expect(
      qcReviewJourney(
        review({
          status: "running",
          rounds_completed: 1,
          paused_checkpoint: null,
          paused_at_round: null,
          findings: [],
          dispositions: [],
          live_progress: liveProgress("reviewing", 2, "openai", "gpt"),
        }),
      ),
    ).toEqual({ active: "qc", round: 2, maxRounds: 2 });
  });

  it("uses one clear finding-action picker as the primary gate", () => {
    renderWorkspace();
    expect(screen.getByRole("heading", { name: "Quality control" })).toBeVisible();
    expect(screen.getAllByText("Round 1 of 2").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "Which findings should the PM act on?" }),
    ).toBeVisible();
    const picker = screen.getByRole("combobox", { name: "Quality control finding action" });
    expect(picker).toBeVisible();
    expect(picker).toHaveValue("all");
    expect(
      within(picker).getByRole("option", { name: "Send all 2 findings to the PM" }),
    ).toBeVisible();
    expect(within(picker).getByRole("option", { name: "Choose findings to send" })).toBeVisible();
    expect(
      within(picker).getByRole("option", {
        name: "Keep the current plan and skip these findings",
      }),
    ).toBeVisible();
    expect(screen.getByText("Waiting on you")).toBeVisible();
    expect(screen.getAllByText("Independent reviewer").length).toBeGreaterThan(0);
    expect(screen.getByText("OpenAI · gpt")).toBeVisible();
    expect(
      within(screen.getByRole("group", { name: "Quality control actions" })).getByRole("button", {
        name: "Send all 2 to PM",
      }),
    ).toBeVisible();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByText("Choose and document a deployment target.").at(-1)).toBeVisible();
    expect(screen.queryByText("YOUR DECISION")).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing goes back to the planning manager/)).not.toBeInTheDocument();
    expect(screen.getByText("QC record")).toBeVisible();
    expect(screen.queryByText("Need to stop?")).not.toBeInTheDocument();
    expect(screen.queryByText("Plan with PM")).not.toBeInTheDocument();
    expect(screen.queryByText(/No planning manager response/)).not.toBeInTheDocument();
  });

  it("renders structured reviewer JSON as readable finding cards", () => {
    renderWorkspace(
      review({
        chat_messages: [
          {
            id: "message-structured-findings",
            request_id: "request-structured-findings",
            channel: "reviewer",
            round: 1,
            attempt: 1,
            speaker: "reviewer",
            kind: "response",
            content: JSON.stringify({
              findings: [
                {
                  severity: "must_fix",
                  module_id: "ai-validation-e2e",
                  finding: "Provider coverage is not verifiable.",
                  recommendation: "Add contract tests for every advertised provider.",
                },
                {
                  severity: "should_fix",
                  module_id: "scaffold-settings",
                  finding: "Key-safety checks are incomplete.",
                  recommendation: "Test normal and error-path log redaction.",
                },
              ],
            }),
            error_code: null,
            created_at: now,
          },
        ],
      }),
    );

    const reviewerChat = screen.getByRole("region", { name: "Chat with the QC reviewer" });
    expect(
      within(reviewerChat).getByRole("region", { name: "Structured QC findings" }),
    ).toBeVisible();
    expect(within(reviewerChat).getByText("2 findings")).toBeVisible();
    expect(within(reviewerChat).getByText("Required")).toBeVisible();
    expect(within(reviewerChat).getByText("Recommended")).toBeVisible();
    expect(within(reviewerChat).getByText("Plan phase · ai-validation-e2e")).toBeVisible();
    expect(within(reviewerChat).getByText("Provider coverage is not verifiable.")).toBeVisible();
    expect(
      within(reviewerChat).getByText("Add contract tests for every advertised provider."),
    ).toBeVisible();
    expect(within(reviewerChat).queryByText(/\{"findings"/)).not.toBeInTheDocument();
  });

  it("waits for Send to PM after accepting every finding", () => {
    const { onTriage } = renderWorkspace();
    expect(onTriage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send all 2 to PM" }));
    expect(onTriage).toHaveBeenCalledWith(review(), {
      "finding-1": "accept",
      "finding-2": "accept",
    });
  });

  it("sends only the selected findings to the planning manager", () => {
    const { onTriage } = renderWorkspace();
    fireEvent.change(screen.getByRole("combobox", { name: "Quality control finding action" }), {
      target: { value: "individual" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Accuracy tolerance/ }));
    const decision = screen.getByRole("button", { name: "Send 1 to PM" });
    fireEvent.click(decision);
    expect(onTriage).toHaveBeenCalledWith(review(), {
      "finding-1": "accept",
      "finding-2": "reject",
    });
  });

  it("waits for an explicit action before overriding every finding", () => {
    const { onContinueWithoutQc } = renderWorkspace();
    fireEvent.change(screen.getByRole("combobox", { name: "Quality control finding action" }), {
      target: { value: "none" },
    });
    expect(
      within(screen.getByRole("alert")).getByText(/will not receive these findings/),
    ).toBeVisible();
    expect(onContinueWithoutQc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep plan and skip remaining QC" }));
    expect(onContinueWithoutQc).toHaveBeenCalledTimes(1);
  });

  it("does not show a stale-review race as a user-facing error", () => {
    renderWorkspace(review(), 'review "review-1" is not awaiting human input');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps internal work-plan envelopes out of the review record", () => {
    renderWorkspace(
      review({
        status: "converged",
        paused_checkpoint: null,
        paused_at_round: null,
        rounds_completed: 1,
        completed_at: now,
        dispositions: [
          {
            finding_id: "finding-1",
            finding_index: 0,
            disposition: "accept",
            rationale: "Deployment target added.",
            adjudication: null,
          },
          {
            finding_id: "finding-2",
            finding_index: 1,
            disposition: "accept",
            rationale: "Tolerance documented.",
            adjudication: null,
          },
        ],
        chat_messages: [
          {
            id: "message-1",
            request_id: "request-1",
            channel: "reviewer",
            round: 1,
            attempt: 1,
            speaker: "workflow",
            kind: "instruction",
            content: "WORK PLAN CONTRACT ENVELOPE internal structured context",
            error_code: null,
            created_at: now,
          },
        ],
      }),
    );
    expect(screen.getByText("QC record")).toBeVisible();
    fireEvent.click(screen.getByText("QC record"));
    expect(screen.getByRole("heading", { name: "Current review record" })).toBeVisible();
    expect(screen.queryByText(/WORK PLAN CONTRACT ENVELOPE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Full reviewer/)).not.toBeInTheDocument();
  });

  it("shows the exact revised plan, its diff, and inline review evidence at the revision gate", () => {
    const version = revisedPlanVersion();
    const current = review({
      rounds_completed: 1,
      paused_checkpoint: "after_revision",
      paused_at_round: 1,
      revised_plan_version_id: version.id,
      result_plan_content_hash: version.content_hash,
      finding_decisions: [
        {
          finding_id: "finding-1",
          finding_index: 0,
          decision: "accept",
          decided_by_user_id: "user-1",
          decided_at: now,
        },
        {
          finding_id: "finding-2",
          finding_index: 1,
          decision: "accept",
          decided_by_user_id: "user-1",
          decided_at: now,
        },
      ],
      dispositions: [
        {
          finding_id: "finding-1",
          finding_index: 0,
          disposition: "accept",
          rationale: "Deployment target added.",
          adjudication: null,
        },
        {
          finding_id: "finding-2",
          finding_index: 1,
          disposition: "accept",
          rationale: "Tolerance documented.",
          adjudication: null,
        },
      ],
      round_exchanges: [
        {
          round: 1,
          reviewed_plan_content_hash: "a".repeat(64),
          reviewer: {
            provider: "openai",
            model: "gpt",
            findings: [
              {
                severity: "must_fix",
                module_id: null,
                finding: "Deployment target is undefined.",
                recommendation: "Choose and document a deployment target.",
              },
              {
                severity: "should_fix",
                module_id: "parser",
                finding: "Accuracy tolerance is unclear.",
                recommendation: "Add a measurable tolerance.",
              },
            ],
          },
          pm: {
            provider: "anthropic",
            model: "claude",
            dispositions: [
              {
                finding_index: 0,
                disposition: "accept",
                rationale: "Deployment target added.",
              },
              {
                finding_index: 1,
                disposition: "accept",
                rationale: "Tolerance documented.",
              },
            ],
            revised_plan_content_hash: version.content_hash,
          },
        },
      ],
    });

    renderWorkspace(current, undefined, version);

    expect(screen.getByRole("heading", { name: "Review the revised plan" })).toBeVisible();
    const card = screen.getByRole("article", {
      name: "Ship the revised, measurable deployment plan",
    });
    expect(within(card).getByText("Plan Contract · Version 2")).toBeVisible();
    expect(within(card).getByText("Changes from version 1")).toBeVisible();
    expect(within(card).getByText("Documented the deployment target")).toBeVisible();
    fireEvent.click(screen.getByText("QC record"));
    expect(screen.getByRole("heading", { name: "Current review record" })).toBeVisible();
    expect(screen.getAllByText("Accepted by PM")).toHaveLength(2);
    expect(screen.getAllByText("Recommendation")).toHaveLength(2);
    expect(screen.getAllByText("PM response")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Recommendation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PM response" })).not.toBeInTheDocument();
  });

  it("shows the exact terminal plan and factual per-finding outcomes", () => {
    const version = revisedPlanVersion();
    const current = review({
      status: "converged",
      rounds_completed: 1,
      paused_checkpoint: null,
      paused_at_round: null,
      completed_at: now,
      revised_plan_version_id: version.id,
      result_plan_content_hash: version.content_hash,
      finding_decisions: [
        {
          finding_id: "finding-1",
          finding_index: 0,
          decision: "accept",
          decided_by_user_id: "user-1",
          decided_at: now,
        },
        {
          finding_id: "finding-2",
          finding_index: 1,
          decision: "reject",
          decided_by_user_id: "user-1",
          decided_at: now,
        },
      ],
      dispositions: [
        {
          finding_id: "finding-1",
          finding_index: 0,
          disposition: "accept",
          rationale: "Deployment target added.",
          adjudication: null,
        },
      ],
    });

    renderWorkspace(current, undefined, version);

    expect(
      screen.getByRole("heading", { name: "Review the exact plan for approval" }),
    ).toBeVisible();
    expect(
      screen.getByRole("article", { name: "Ship the revised, measurable deployment plan" }),
    ).toBeVisible();
    fireEvent.click(screen.getByText("QC record"));
    expect(screen.getByText("Accepted by PM")).toBeVisible();
    expect(screen.getByText("Excluded by you")).toBeVisible();
    expect(
      screen.getAllByText(
        "2 QC findings were recorded. 1 sent to the PM; 1 excluded by you. 1 accepted by the PM; 0 rebutted by the PM.",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/findings remain/i)).not.toBeInTheDocument();
  });

  it("triages only the findings from the paused reviewer round", () => {
    const current = review({
      rounds_completed: 1,
      paused_at_round: 2,
      round_exchanges: [
        {
          round: 1,
          reviewed_plan_content_hash: "a".repeat(64),
          reviewer: {
            provider: "openai",
            model: "gpt",
            findings: [
              {
                severity: "must_fix",
                module_id: null,
                finding: "Deployment target is undefined.",
                recommendation: "Choose and document a deployment target.",
              },
            ],
          },
          pm: {
            provider: "anthropic",
            model: "claude",
            dispositions: [
              {
                finding_index: 0,
                disposition: "accept",
                rationale: "The deployment target is now explicit.",
              },
            ],
            revised_plan_content_hash: "c".repeat(64),
          },
        },
        {
          round: 2,
          reviewed_plan_content_hash: "c".repeat(64),
          reviewer: {
            provider: "openai",
            model: "gpt",
            findings: [
              {
                severity: "should_fix",
                module_id: "parser",
                finding: "Accuracy tolerance is unclear.",
                recommendation: "Add a measurable tolerance.",
              },
            ],
          },
          pm: null,
        },
      ],
    });
    const { onTriage } = renderWorkspace(current);

    fireEvent.change(screen.getByRole("combobox", { name: "Quality control finding action" }), {
      target: { value: "individual" },
    });
    expect(
      screen.queryByRole("checkbox", { name: /Deployment target is undefined/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Accuracy tolerance is unclear/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Send 1 to PM" }));

    expect(onTriage).toHaveBeenCalledWith(current, { "finding-2": "accept" });
  });

  it("shows how long the running step has been going so a slow review is not mistaken for a frozen one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:05:30.000Z"));
    renderWorkspace(
      review({
        status: "running",
        paused_checkpoint: null,
        paused_at_round: null,
        findings: [],
        finding_decisions: [],
        round_exchanges: [],
        live_progress: {
          stage: "reviewing",
          round: 1,
          attempt: 1,
          provider: "openai",
          model: "gpt",
          completed_items: 2,
          total_items: 5,
          output_characters: 1_284,
          activity: "Checking 5 plan modules against the QC requirements",
          output_preview: '{"findings":[{"severity":"should_fix"',
          started_at: "2026-08-02T12:01:18.000Z",
          checkpoint_at: "2026-08-02T12:01:18.000Z",
        },
        chat_messages: [
          {
            id: "message-1",
            request_id: "request-1",
            channel: "reviewer",
            round: 1,
            attempt: 1,
            speaker: "workflow",
            kind: "instruction",
            content: "Review the saved plan against the QC requirements.",
            error_code: null,
            created_at: "2026-08-02T12:01:18.000Z",
          },
        ],
      }),
    );
    expect(screen.getByText("4:12 on this step")).toBeVisible();
    expect(screen.getAllByText("gpt").length).toBeGreaterThan(0);
    expect(screen.getByText("Working now")).toBeVisible();
    expect(screen.getAllByText("Independent reviewer").length).toBeGreaterThan(0);
    expect(screen.getByText("OpenAI · gpt")).toBeVisible();
    expect(screen.getByText("2 completed of 5 items")).toBeVisible();
    expect(screen.getByText("1,284 characters received")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Quality control" })).toBeVisible();
    expect(screen.getAllByText("Round 1 of 2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Independent reviewer is checking the plan")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Current QC step progress" })).toHaveAttribute(
      "value",
      "2",
    );
    expect(screen.getByText(/over its typical time/i)).toBeVisible();
    expect(screen.getByText("Visible agent dialogue")).toBeVisible();
    expect(screen.getByText("Response streaming now")).toBeVisible();
    expect(screen.getByText(/"severity":"should_fix"/)).toBeVisible();
    expect(screen.getByText(/View instructions sent to reviewer/)).toBeVisible();
    vi.useRealTimers();
  });

  it("does not turn elapsed time into fake progress before QC completes a checkpoint", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:04:08.000Z"));
    renderWorkspace(
      review({
        status: "running",
        paused_checkpoint: null,
        paused_at_round: null,
        findings: [],
        finding_decisions: [],
        round_exchanges: [],
        live_progress: {
          stage: "reviewing",
          round: 1,
          attempt: 1,
          provider: "openai",
          model: "gpt-5.6-sol",
          completed_items: 0,
          total_items: 6,
          output_characters: 0,
          activity: "Checking 6 plan modules against the QC requirements",
          output_preview: "",
          started_at: "2026-08-02T12:01:18.000Z",
          checkpoint_at: "2026-08-02T12:01:18.000Z",
        },
      }),
    );

    expect(screen.getByText("In progress")).toBeVisible();
    expect(screen.queryByText("92%")).not.toBeInTheDocument();
    expect(screen.queryByText("0 of 6 items")).not.toBeInTheDocument();
    expect(screen.getByText("6 items in this review step")).toBeVisible();
    expect(screen.getByText("Waiting for response data")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Current QC step progress" }),
    ).not.toHaveAttribute("value");
    expect(
      screen.getByText("Progress advances only when QC reports a completed checkpoint."),
    ).toBeVisible();
    vi.useRealTimers();
  });
});
