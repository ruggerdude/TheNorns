import { V2ConversationPlanReview, type V2ConversationPlanReviewT } from "@norns/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QcWorkspace } from "./QcWorkspace";

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

function renderWorkspace(current = review()) {
  const onTriage = vi.fn().mockResolvedValue(undefined);
  const onContinueWithoutQc = vi.fn().mockResolvedValue(undefined);
  render(
    <QcWorkspace
      review={current}
      planVersion={null}
      history={[]}
      actions={{}}
      busy={false}
      onTriage={onTriage}
      onResume={vi.fn().mockResolvedValue(undefined)}
      onAdjudicate={vi.fn().mockResolvedValue(undefined)}
      onContinueWithoutQc={onContinueWithoutQc}
      onCancel={vi.fn().mockResolvedValue(undefined)}
      onStopAll={vi.fn().mockResolvedValue(undefined)}
      onConfirmAction={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  return { onTriage, onContinueWithoutQc };
}

describe("QcWorkspace", () => {
  it("makes accept all, choose individually, and accept none the primary gate", () => {
    renderWorkspace();
    expect(
      screen.getByRole("heading", { name: "Which findings should the PM act on?" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Accept all 2/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Choose individually/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Accept none/ })).toBeVisible();
    expect(screen.queryByText("Plan with PM")).not.toBeInTheDocument();
    expect(screen.queryByText(/No planning manager response/)).not.toBeInTheDocument();
  });

  it("sends only the selected findings to the planning manager", () => {
    const { onTriage } = renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /Choose individually/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Accuracy tolerance/ }));
    const decision = screen.getByRole("button", { name: "Send 1 to PM" });
    fireEvent.click(decision);
    expect(onTriage).toHaveBeenCalledWith(review(), {
      "finding-1": "accept",
      "finding-2": "reject",
    });
  });

  it("requires confirmation before overriding every finding", () => {
    const { onContinueWithoutQc } = renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: /Accept none/ }));
    const alert = screen.getByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Reject all and keep plan" }));
    expect(onContinueWithoutQc).toHaveBeenCalledTimes(1);
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

    fireEvent.click(screen.getByRole("button", { name: /Choose individually/ }));
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
    expect(screen.getByText("gpt")).toBeVisible();
    expect(screen.getByText("2 of 5 items")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Total QC progress" })).toBeVisible();
    expect(screen.getByText(/taking longer than usual/i)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Live dialogue" }));
    expect(screen.getByText("Visible agent dialogue")).toBeVisible();
    expect(screen.getByText("Response streaming now")).toBeVisible();
    expect(screen.getByText(/"severity":"should_fix"/)).toBeVisible();
    expect(screen.getByText(/View instructions sent to reviewer/)).toBeVisible();
    vi.useRealTimers();
  });
});
