import type { V2ConversationPlanReviewT, V2WorkPlanVersionT } from "@norns/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationQcCard, findGateInterimVersion } from "./ConversationQcCard";
import { makePlan } from "./test/fixtures";

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
        adjudication: null,
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
  it("shows the durable live stage, exact model identity, and advancing stage and total timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-27T12:02:00.000Z");
    const activeReview = review({
      status: "running",
      rounds_completed: 1,
      findings: [],
      dispositions: [],
      revised_plan_version_id: null,
      result_plan_content_hash: "a".repeat(64),
      started_at: "2026-07-27T12:00:00.000Z",
      completed_at: null,
    });
    (
      activeReview as V2ConversationPlanReviewT & {
        live_progress: {
          stage: "repairing";
          round: number;
          attempt: number;
          provider: "anthropic";
          model: string;
          started_at: string;
          checkpoint_at: string;
        };
      }
    ).live_progress = {
      stage: "repairing",
      round: 2,
      attempt: 2,
      provider: "anthropic",
      model: "claude-opus-4-8",
      started_at: "2026-07-27T12:01:15.000Z",
      checkpoint_at: "2026-07-27T12:01:15.000Z",
    };

    const rendered = render(<ConversationQcCard planVersion={null} review={activeReview} />);
    try {
      expect(screen.getByText("Round 2 of 3 · Repairing · Attempt 2")).toBeInTheDocument();
      expect(screen.getByText("anthropic · claude-opus-4-8")).toBeInTheDocument();
      expect(screen.getByText("Stage 0:45 · Total 2:00")).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "QC review progress" })).toHaveAttribute(
        "aria-valuetext",
        "Round 2 of 3 · Repairing · Attempt 2 · anthropic · claude-opus-4-8 · Stage 0:45 · Total 2:00",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.getByText("Stage 0:46 · Total 2:01")).toBeInTheDocument();
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });

  it("falls back to the latest chat event when durable live progress is absent", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "running",
          rounds_completed: 0,
          findings: [],
          dispositions: [],
          revised_plan_version_id: null,
          result_plan_content_hash: "a".repeat(64),
          started_at: now,
          completed_at: null,
          chat_messages: [
            {
              id: "chat-reviewer-instruction",
              request_id: "request-reviewer-1",
              channel: "reviewer",
              round: 1,
              attempt: 1,
              speaker: "workflow",
              kind: "instruction",
              content: "Review the immutable plan.",
              error_code: null,
              created_at: now,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Round 1 of 3 · waiting for the QC reviewer")).toBeInTheDocument();
  });

  it("shows the exact review receipt, findings, recommendations, and PM dispositions", () => {
    render(<ConversationQcCard planVersion={null} review={review()} />);

    const card = screen.getByTestId("conversation-qc-card");
    fireEvent.click(within(card).getByRole("button", { name: /open audit trail/i }));
    expect(within(card).getByText("anthropic · claude-sonnet-5")).toBeInTheDocument();
    expect(within(card).getByText("openai · gpt-5.6")).toBeInTheDocument();
    expect(within(card).getAllByTitle("a".repeat(64))).toHaveLength(2);
    expect(within(card).getByText("The retry budget is unbounded.")).toBeInTheDocument();
    expect(within(card).getByText("Set an explicit attempt ceiling.")).toBeInTheDocument();
    expect(within(card).getByText("The PM added a bounded retry requirement.")).toBeInTheDocument();
    expect(within(card).getByText("No response")).toBeInTheDocument();
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

  it("explains a partial failure while retaining the completed reviewer exchange", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "failed",
          findings: [],
          dispositions: [],
          revised_plan_version_id: null,
          failure_code: "invalid_response",
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
                    finding: "The response contract is incomplete.",
                    recommendation: "Return the complete strict plan envelope.",
                  },
                ],
              },
              pm: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "an agent could not produce a complete applicable QC result after the reminder",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("reviewer feedback below was saved");
    expect(screen.getByText("The response contract is incomplete.")).toBeInTheDocument();
    expect(screen.getByText("No response")).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /open audit trail/i }));
    expect(screen.getByRole("heading", { name: "Agent review transcript" })).toBeInTheDocument();
    expect(screen.getByText("QC reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planning agent")).toBeInTheDocument();
    expect(screen.getByText("The stop path is not attributable.")).toBeInTheDocument();
    expect(
      screen.getByText("Cancellation attribution was added to the review receipt."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Review controls"));
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

  it("shows detailed status, opens each raw QC chat, and supports guided takeover or waiver", async () => {
    const onContinueChat = vi.fn().mockResolvedValue(undefined);
    const onContinueWithoutQc = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "failed",
          findings: [],
          dispositions: [],
          revised_plan_version_id: null,
          result_plan_content_hash: "a".repeat(64),
          failure_code: "invalid_response",
          chat_messages: [
            {
              id: "chat-reviewer-instruction",
              request_id: "request-reviewer-1",
              channel: "reviewer",
              round: 1,
              attempt: 1,
              speaker: "workflow",
              kind: "instruction",
              content: "Review the immutable plan.",
              error_code: null,
              created_at: now,
            },
            {
              id: "chat-reviewer-response",
              request_id: "request-reviewer-1",
              channel: "reviewer",
              round: 1,
              attempt: 1,
              speaker: "reviewer",
              kind: "response",
              content: "# Review\n\nOne concern remains.",
              error_code: null,
              created_at: now,
            },
            {
              id: "chat-pm-error",
              request_id: "request-pm-2",
              channel: "pm",
              round: 1,
              attempt: 2,
              speaker: "pm",
              kind: "error",
              content: "The second response was empty.",
              error_code: "invalid_response",
              created_at: now,
            },
          ],
          markdown_artifacts: [
            {
              artifact_id: "artifact-reviewer-1",
              channel: "reviewer",
              round: 1,
              attempt: 1,
              source: "automatic",
              filename: "qc-attempt-1-reviewer.md",
              content_hash: "e".repeat(64),
              byte_size: 42,
              valid: true,
              created_at: now,
            },
          ],
        })}
        onContinueChat={onContinueChat}
        onContinueWithoutQc={onContinueWithoutQc}
        onConfirmAction={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /open audit trail/i }));
    fireEvent.click(screen.getByText(/Technical event log/));
    const status = screen.getByRole("region", { name: "Detailed QC status" });
    expect(within(status).getByText(/Response received and Markdown saved/)).toBeInTheDocument();
    expect(within(status).getByText(/Request failed · invalid_response/)).toBeInTheDocument();

    const reviewerChat = screen.getByRole("region", { name: "Reviewer and PM conversation" });
    expect(within(reviewerChat).getByText("Review the immutable plan.")).toBeInTheDocument();
    fireEvent.click(within(reviewerChat).getByText(/Saved Markdown files/));
    expect(
      within(reviewerChat).getByRole("link", {
        name: "qc-attempt-1-reviewer.md",
      }),
    ).toHaveAttribute("href", "/api/v2/projects/project-1/artifacts/artifact-reviewer-1/content");
    fireEvent.click(within(reviewerChat).getByText("Guide an agent"));
    fireEvent.change(within(reviewerChat).getByLabelText("Send to"), {
      target: { value: "reviewer" },
    });
    fireEvent.change(within(reviewerChat).getByLabelText("Your guidance"), {
      target: { value: "Focus on the incomplete acceptance test." },
    });
    fireEvent.click(within(reviewerChat).getByRole("button", { name: "Send to reviewer" }));
    await waitFor(() =>
      expect(onContinueChat).toHaveBeenCalledWith(
        expect.objectContaining({ id: "review-1" }),
        "reviewer",
        "Focus on the incomplete acceptance test.",
      ),
    );

    fireEvent.click(screen.getByText("Other options"));
    fireEvent.click(screen.getByRole("button", { name: "Continue without QC" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm continue without QC" }));
    expect(onContinueWithoutQc).toHaveBeenCalledWith(expect.objectContaining({ id: "review-1" }));
  });
});

function interimPlanVersion(overrides: Partial<V2WorkPlanVersionT> = {}): V2WorkPlanVersionT {
  return {
    schema_version: 2,
    id: "plan-version-interim-1",
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    created_by_user_id: "user-1",
    version: 2,
    status: "in_qc",
    origin: "qc_interim",
    plan: {
      plan: makePlan(),
      staffing: [],
      verification_requirements: [],
      open_decisions: [],
      estimated_budget: { currency: "USD", amount: 10 },
    },
    content_hash: "d".repeat(64),
    created_by_action_id: null,
    supersedes_plan_version_id: "plan-version-1",
    diff_from_previous: {
      added: ["Added a bounded retry ceiling"],
      changed: [],
      removed: [],
    },
    approved_by_user_id: null,
    approved_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("QC gate card", () => {
  it("shows one recommended path and tucks exceptional exits behind more options", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    const onContinueWithoutQc = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_review",
          paused_at_round: 2,
          max_rounds: 3,
          started_at: now,
          completed_at: null,
        })}
        onResume={onResume}
        onContinueWithoutQc={onContinueWithoutQc}
        onCancel={onCancel}
      />,
    );

    const gate = screen.getByTestId("conversation-qc-gate-card");
    expect(within(gate).getByText("Round 2 of 3")).toBeInTheDocument();
    expect(within(gate).getByText(/Gate A/)).toBeInTheDocument();
    expect(within(gate).getByText("1 must fix")).toBeInTheDocument();
    expect(within(gate).getByText("1 suggestions")).toBeInTheDocument();

    const continueButton = within(gate).getByRole("button", { name: "Continue" });
    expect(continueButton).toHaveClass("btn-primary");
    expect(within(gate).getByRole("button", { name: "Add guidance" })).toBeInTheDocument();
    const moreOptions = within(gate).getByText("More options").closest("details");
    expect(moreOptions).not.toHaveAttribute("open");
    fireEvent.click(within(gate).getByText("More options"));
    expect(moreOptions).toHaveAttribute("open");
    expect(within(gate).getByRole("button", { name: "Accept current plan" })).toBeInTheDocument();
    expect(within(gate).getByRole("button", { name: "Cancel review" })).toBeInTheDocument();
  });

  it('offers "Continue, and stop asking" when gated, sending stopAsking: true', () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_review",
          paused_at_round: 2,
          max_rounds: 3,
          qc_mode: "gated_when_contested",
          started_at: now,
          completed_at: null,
        })}
        onResume={onResume}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const gate = screen.getByTestId("conversation-qc-gate-card");
    fireEvent.click(within(gate).getByText("More options"));
    fireEvent.click(within(gate).getByRole("button", { name: "Continue, and stop asking" }));
    expect(onResume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "review-1" }),
      "continue",
      undefined,
      true,
    );
  });

  it("does not offer to stop asking when the review is already automatic", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_review",
          paused_at_round: 2,
          max_rounds: 3,
          qc_mode: "automatic",
          started_at: now,
          completed_at: null,
        })}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Continue, and stop asking" }),
    ).not.toBeInTheDocument();
  });

  it("pairs findings with dispositions and shows the interim plan diff at Gate B (after_revision)", () => {
    const interim = interimPlanVersion();
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_revision",
          paused_at_round: 1,
          started_at: now,
          completed_at: null,
          revised_plan_version_id: interim.id,
        })}
        interimVersion={interim}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const gate = screen.getByTestId("conversation-qc-gate-card");
    expect(within(gate).getByText(/Gate B/)).toBeInTheDocument();
    expect(within(gate).getByText("Changes from version 1")).toBeInTheDocument();
    expect(within(gate).getByText("Added a bounded retry ceiling")).toBeInTheDocument();

    // The finding-plus-disposition pairing reuses the existing Finding
    // component below the gate card rather than a second renderer.
    expect(screen.getByText("The retry budget is unbounded.")).toBeInTheDocument();
    expect(screen.getByText("PM accept")).toBeInTheDocument();
    expect(screen.getByText("The PM added a bounded retry requirement.")).toBeInTheDocument();
  });

  it("renders three ruling options with a rationale field per contested finding at Gate C, and no plain Continue", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "adjudication",
          paused_at_round: 2,
          started_at: now,
          completed_at: null,
          dispositions: [
            {
              finding_id: "finding-1",
              finding_index: 0,
              disposition: "rebut",
              rationale: "The retry budget is intentionally unbounded for this endpoint.",
              adjudication: null,
            },
          ],
        })}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
        onAdjudicate={vi.fn()}
      />,
    );

    const gate = screen.getByTestId("conversation-qc-gate-card");
    const finding = within(gate).getByTestId("conversation-qc-adjudication-finding-finding-1");
    expect(within(finding).getByRole("radio", { name: /rule for reviewer/i })).toBeInTheDocument();
    expect(within(finding).getByRole("radio", { name: /rule for pm/i })).toBeInTheDocument();
    expect(
      within(finding).getByRole("radio", { name: /supply the missing fact/i }),
    ).toBeInTheDocument();
    expect(within(finding).getByLabelText("Rationale")).toBeInTheDocument();

    // Gate C replaces the plain Continue with the ruling controls; the note
    // shortcut is also gone since "supply the missing fact" covers it.
    expect(within(gate).queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(
      within(gate).queryByRole("button", { name: "Continue with a note" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(gate).getByText("More options"));
    expect(within(gate).getByRole("button", { name: "Accept current plan" })).toBeInTheDocument();
    expect(within(gate).getByRole("button", { name: "Cancel review" })).toBeInTheDocument();

    // The PM's rebuttal renders verbatim on the adjudication card itself.
    expect(within(gate).getByText(/PM rebut:/)).toBeInTheDocument();
    expect(
      within(gate).getByText("The retry budget is intentionally unbounded for this endpoint."),
    ).toBeInTheDocument();
  });

  it("shows the context manifest both agents read on the adjudication card", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "adjudication",
          paused_at_round: 2,
          started_at: now,
          completed_at: null,
          dispositions: [
            {
              finding_id: "finding-1",
              finding_index: 0,
              disposition: "rebut",
              rationale: "The retry budget is intentionally unbounded for this endpoint.",
              adjudication: null,
            },
          ],
        })}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
        onAdjudicate={vi.fn()}
      />,
    );

    const manifest = screen.getByTestId("conversation-qc-adjudication-manifest");
    expect(within(manifest).getByText("Project rule")).toBeInTheDocument();
    expect(within(manifest).getByText("project-norn")).toBeInTheDocument();
    expect(within(manifest).getByText("bbbbbbbbbb")).toBeInTheDocument();
  });

  it("shows a recurring finding's prior occurrence and how it was dispositioned", () => {
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "adjudication",
          paused_at_round: 2,
          started_at: now,
          completed_at: null,
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
              id: "finding-3",
              index: 2,
              severity: "must_fix",
              module_id: "core-api",
              finding: "The retry budget is still unbounded in round 2.",
              recommendation: "Set an explicit attempt ceiling.",
              recurs_of_finding_ids: ["finding-1"],
            },
          ],
          dispositions: [
            {
              finding_id: "finding-1",
              finding_index: 0,
              disposition: "rebut",
              rationale: "The retry budget is intentionally unbounded for this endpoint.",
              adjudication: {
                decided_by_user_id: "user-1",
                ruling: "pm",
                rationale: "Confirmed with the team this is deliberate.",
                decided_at: now,
              },
            },
            {
              finding_id: "finding-3",
              finding_index: 2,
              disposition: "rebut",
              rationale: "Same rationale as before.",
              adjudication: null,
            },
          ],
        })}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
        onAdjudicate={vi.fn()}
      />,
    );

    const recurrence = screen.getByTestId("conversation-qc-recurrence-finding-3");
    expect(within(recurrence).getByText(/raised before/i)).toBeInTheDocument();
    expect(within(recurrence).getByText("The retry budget is unbounded.")).toBeInTheDocument();
    expect(within(recurrence).getByText(/ruled by a human: for the pm/i)).toBeInTheDocument();
  });

  it("submits a Gate C ruling with the rationale, and offers to raise the round cap on round_cap_requires_raise", () => {
    const onAdjudicate = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "adjudication",
          paused_at_round: 3,
          max_rounds: 3,
          started_at: now,
          completed_at: null,
          dispositions: [
            {
              finding_id: "finding-1",
              finding_index: 0,
              disposition: "rebut",
              rationale: "The retry budget is intentionally unbounded for this endpoint.",
              adjudication: null,
            },
          ],
        })}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
        onAdjudicate={onAdjudicate}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /rule for reviewer/i }));
    fireEvent.change(screen.getByLabelText("Rationale"), {
      target: { value: "The reviewer read the code correctly; the PM did not." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record ruling" }));

    expect(onAdjudicate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "review-1" }),
      {
        "finding-1": {
          ruling: "reviewer",
          rationale: "The reviewer read the code correctly; the PM did not.",
        },
      },
      undefined,
      false,
    );

    // The review re-renders with capBlocked after the server rejects the
    // ruling with round_cap_requires_raise — the offer, not a dead end.
    rerender(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "adjudication",
          paused_at_round: 3,
          max_rounds: 3,
          started_at: now,
          completed_at: null,
          dispositions: [
            {
              finding_id: "finding-1",
              finding_index: 0,
              disposition: "rebut",
              rationale: "The retry budget is intentionally unbounded for this endpoint.",
              adjudication: null,
            },
          ],
        })}
        onResume={vi.fn()}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
        onAdjudicate={onAdjudicate}
        capBlocked
      />,
    );
    expect(screen.getByText(/at its round cap/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /raise round cap by one and record ruling/i }),
    ).toBeInTheDocument();
  });

  it("Continue calls resume with exit: continue", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_review",
          paused_at_round: 1,
          started_at: now,
          completed_at: null,
        })}
        onResume={onResume}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "review-1" }), "continue");
  });

  it("Add guidance sends the note and channel through resume", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_review",
          paused_at_round: 1,
          started_at: now,
          completed_at: null,
        })}
        onResume={onResume}
        onContinueWithoutQc={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add guidance" }));
    fireEvent.change(screen.getByLabelText("Send a note to"), {
      target: { value: "reviewer" },
    });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "The retry objection was already fixed in the current plan." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send note and continue" }));

    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ id: "review-1" }), "note", {
      channel: "reviewer",
      message: "The retry objection was already fixed in the current plan.",
    });
  });

  it("the exceptional accept and cancel paths remain distinct behind More options", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    const onContinueWithoutQc = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "awaiting_human",
          paused_checkpoint: "after_review",
          paused_at_round: 2,
          started_at: now,
          completed_at: null,
        })}
        onResume={onResume}
        onContinueWithoutQc={onContinueWithoutQc}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByText("More options"));
    fireEvent.click(screen.getByRole("button", { name: "Accept current plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm accept current plan" }));
    expect(onContinueWithoutQc).toHaveBeenCalledWith(expect.objectContaining({ id: "review-1" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel review" }));
    fireEvent.change(screen.getByLabelText("Why cancel this review?"), {
      target: { value: "The plan needs a different approach." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel review" }));
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "review-1" }),
      "The plan needs a different approach.",
    );
    expect(onContinueWithoutQc).toHaveBeenCalledTimes(1);
  });
});

describe("QC cadence control", () => {
  it("shows the effective qc_mode and its source, and calls PATCH on a mid-flight change", () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "running",
          qc_mode: "gated_when_contested",
          qc_mode_source: "work_item",
          started_at: now,
          completed_at: null,
        })}
        onPatch={onPatch}
      />,
    );

    const cadence = screen.getByTestId("conversation-qc-cadence");
    expect(within(cadence).getByText(/set for this work item/i)).toBeInTheDocument();
    expect(within(cadence).getByText(/no mode skips gate c/i)).toBeInTheDocument();

    fireEvent.change(within(cadence).getByLabelText("Change cadence"), {
      target: { value: "gated_each_step" },
    });
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ id: "review-1" }), {
      qcMode: "gated_each_step",
    });
  });

  it('shows "project default" and "changed mid-review" sources, and offers to hold at the next checkpoint while running', () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "running",
          qc_mode: "automatic",
          qc_mode_source: "project_default",
          started_at: now,
          completed_at: null,
        })}
        onPatch={onPatch}
      />,
    );
    expect(
      within(screen.getByTestId("conversation-qc-cadence")).getByText(/project default/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hold at the next checkpoint" }));
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ id: "review-1" }), {
      qcMode: "gated_each_step",
    });

    rerender(
      <ConversationQcCard
        planVersion={null}
        review={review({
          status: "running",
          qc_mode: "gated_each_round",
          qc_mode_source: "in_run",
          qc_mode_changed_at_round: 2,
          qc_mode_changed_by_user_id: "user-2",
          rounds_completed: 2,
          started_at: now,
          completed_at: null,
        })}
        onPatch={onPatch}
      />,
    );
    expect(
      within(screen.getByTestId("conversation-qc-cadence")).getByText(
        /changed mid-review at round 2 by user-2/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hold at the next checkpoint" })).toBeInTheDocument();
  });
});

describe("approval-card evidence", () => {
  it("aggregates rebutted should-fix findings, human-steering provenance, and contested themes across reviews", () => {
    const converged = review({
      status: "converged",
      human_steered_rounds: [2],
      chat_messages: [
        {
          id: "chat-human-1",
          request_id: "request-reviewer-2",
          channel: "reviewer",
          round: 2,
          attempt: 1,
          speaker: "human",
          kind: "instruction",
          content: "Drop the caching objection, it's out of scope for this ticket.",
          error_code: null,
          created_at: now,
        },
      ],
      findings: [
        {
          id: "finding-1",
          index: 0,
          severity: "should_fix",
          module_id: "core-api",
          finding: "Consider caching this lookup.",
          recommendation: "Add a cache layer.",
        },
      ],
      dispositions: [
        {
          finding_id: "finding-1",
          finding_index: 0,
          disposition: "rebut",
          rationale: "Out of scope for this ticket.",
          adjudication: null,
        },
      ],
      round_exchanges: [
        {
          round: 1,
          reviewed_plan_content_hash: "a".repeat(64),
          reviewer: {
            provider: "openai",
            model: "gpt-5.6",
            findings: [
              {
                severity: "should_fix",
                module_id: "core-api",
                finding: "Consider caching this lookup.",
                recommendation: "Add a cache layer.",
              },
            ],
          },
          pm: {
            provider: "anthropic",
            model: "claude-sonnet-5",
            dispositions: [
              {
                finding_index: 0,
                disposition: "rebut",
                rationale: "Out of scope for this ticket.",
              },
            ],
            revised_plan_content_hash: "a".repeat(64),
          },
        },
      ],
    });
    const earlierAttempt = review({
      id: "review-0",
      attempt_number: 1,
      status: "cap_reached",
      findings: [
        {
          id: "finding-0",
          index: 0,
          severity: "must_fix",
          module_id: "core-api",
          finding: "The retry budget is unbounded (attempt 1).",
          recommendation: "Set an explicit attempt ceiling.",
        },
      ],
      dispositions: [],
    });

    render(
      <ConversationQcCard
        planVersion={null}
        review={converged}
        allReviews={[earlierAttempt, converged]}
        onConfirmAction={vi.fn()}
      />,
    );

    const decision = screen.getByRole("region", { name: "Human plan decision" });
    expect(
      within(decision).getByText(/This review was human-steered at round 2/i),
    ).toBeInTheDocument();
    expect(within(decision).getByText(/Drop the caching objection/i)).toBeInTheDocument();
    expect(
      within(decision).getByText(/1 should-fix finding rebutted across 1 round/i),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(/1 contested theme raised more than once/i),
    ).toBeInTheDocument();
  });
});

describe("findGateInterimVersion", () => {
  const human: V2WorkPlanVersionT = {
    ...interimPlanVersion(),
    id: "plan-version-1",
    version: 1,
    origin: "human",
    supersedes_plan_version_id: null,
    diff_from_previous: null,
  };
  const interim = interimPlanVersion();

  it("resolves the interim version at Gate B via the review's own pointer", () => {
    const r = review({
      paused_checkpoint: "after_revision",
      paused_at_round: 1,
      revised_plan_version_id: interim.id,
    });
    expect(findGateInterimVersion(r, [human, interim])).toEqual(interim);
  });

  it("falls back to matching the paused round's PM revision hash when no pointer is set", () => {
    const r = review({
      paused_checkpoint: "after_revision",
      paused_at_round: 1,
      revised_plan_version_id: null,
      round_exchanges: [
        {
          round: 1,
          reviewed_plan_content_hash: "a".repeat(64),
          reviewer: { provider: "openai", model: "gpt-5.6", findings: [] },
          pm: {
            provider: "anthropic",
            model: "claude-sonnet-5",
            dispositions: [],
            revised_plan_content_hash: interim.content_hash,
          },
        },
      ],
    });
    expect(findGateInterimVersion(r, [human, interim])).toEqual(interim);
  });

  it("never resolves a human-origin version even if the pointer wrongly names one", () => {
    const r = review({
      paused_checkpoint: "after_revision",
      paused_at_round: 1,
      revised_plan_version_id: human.id,
    });
    expect(findGateInterimVersion(r, [human, interim])).toBeNull();
  });

  it("returns null outside Gate B", () => {
    const r = review({
      paused_checkpoint: "after_review",
      paused_at_round: 1,
      revised_plan_version_id: interim.id,
    });
    expect(findGateInterimVersion(r, [human, interim])).toBeNull();
  });
});
