import type { V2ConversationPlanReviewT } from "@norns/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationQcCard } from "./ConversationQcCard";

const now = "2026-07-27T12:00:00.000Z";

function review(overrides: Partial<V2ConversationPlanReviewT> = {}): V2ConversationPlanReviewT {
  return {
    schema_version: 2,
    id: "review-1",
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
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
    rounds_completed: 1,
    max_rounds: 3,
    round_exchanges: [],
    plan_content_hash: "a".repeat(64),
    result_plan_content_hash: "a".repeat(64),
    context_manifest: {
      entries: [
        {
          kind: "project_rules",
          ref: "project-norn",
          content_hash: "b".repeat(64),
        },
      ],
      context_hash: "c".repeat(64),
    },
    findings: [
      {
        id: "finding-1",
        index: 0,
        severity: "must_fix",
        module_id: "core-api",
        finding: "The retry budget is unbounded.",
        recommendation: "Set an explicit attempt ceiling.",
      },
      {
        id: "finding-2",
        index: 1,
        severity: "suggestion",
        module_id: null,
        finding: "Clarify the deployment note.",
        recommendation: "Name the health endpoint.",
      },
    ],
    dispositions: [
      {
        finding_id: "finding-1",
        finding_index: 0,
        disposition: "accept",
        rationale: "The PM added a bounded retry requirement.",
      },
    ],
    revised_plan_version_id: "plan-version-2",
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

describe("conversation QC card", () => {
  it("shows the exact review receipt, findings, recommendations, and PM dispositions", () => {
    render(<ConversationQcCard planVersion={null} review={review()} />);

    const card = screen.getByRole("article", { name: "Plan plan-version-1" });
    expect(within(card).getByText("anthropic · claude-sonnet-5")).toBeInTheDocument();
    expect(within(card).getByText("openai · gpt-5.6")).toBeInTheDocument();
    expect(within(card).getByTitle("a".repeat(64))).toHaveTextContent("aaaaaaaaaa");
    expect(within(card).getByText("The retry budget is unbounded.")).toBeInTheDocument();
    expect(within(card).getByText("Set an explicit attempt ceiling.")).toBeInTheDocument();
    expect(within(card).getByText("The PM added a bounded retry requirement.")).toBeInTheDocument();
    expect(within(card).getByText("Awaiting PM disposition.")).toBeInTheDocument();
    expect(within(card).getByText(/plan-version-2/)).toBeInTheDocument();
  });

  it("keeps an unchanged candidate available after QC fails", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "failed",
          findings: [],
          dispositions: [],
          revised_plan_version_id: null,
          started_at: null,
          failure_code: "reviewer_unavailable",
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The unchanged plan remains a candidate and can be sent to QC again.",
    );
  });

  it("shows each agent's round separately and lets the human stop active QC", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "running",
          rounds_completed: 1,
          findings: [],
          dispositions: [],
          revised_plan_version_id: null,
          result_plan_content_hash: "a".repeat(64),
          completed_at: null,
          round_exchanges: [
            {
              round: 1,
              reviewed_plan_content_hash: "a".repeat(64),
              reviewer: {
                provider: "openai",
                model: "gpt-5.6-sol",
                findings: [
                  {
                    severity: "must_fix",
                    module_id: "core-api",
                    finding: "The stop path is not attributable.",
                    recommendation: "Record the human actor and reason.",
                  },
                ],
              },
              pm: {
                provider: "anthropic",
                model: "claude-sonnet-5",
                dispositions: [
                  {
                    finding_index: 0,
                    disposition: "accept",
                    rationale: "Cancellation attribution was added to the review receipt.",
                  },
                ],
                revised_plan_content_hash: "d".repeat(64),
              },
            },
          ],
        })}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("heading", { name: "Agent review transcript" })).toBeInTheDocument();
    expect(screen.getByText("QC reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planning agent")).toBeInTheDocument();
    expect(screen.getByText("The stop path is not attributable.")).toBeInTheDocument();
    expect(
      screen.getByText("Cancellation attribution was added to the review receipt."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop QC" }));
    fireEvent.change(screen.getByLabelText("Why are you stopping QC?"), {
      target: { value: "The plan needs a different architecture." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop QC" }));

    await waitFor(() =>
      expect(onCancel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "review-1" }),
        "The plan needs a different architecture.",
      ),
    );
  });
});
