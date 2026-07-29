import type {
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2HumanWaitContinuationT,
  V2HumanWaitT,
} from "@norns/contracts";
import { V2_HUMAN_WAIT_INSTRUCTION_HASH } from "@norns/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationActionCard } from "./ConversationActionCard";
import {
  ExecutionActionComposer,
  HumanWaitCard,
  MockupRequestComposer,
  PmUpdateControls,
} from "./ExecutionConversationControls";

const now = "2026-07-27T12:00:00.000Z";
const sha = "a".repeat(64);

afterEach(() => {
  window.sessionStorage.clear();
});

function action(
  actionType: V2ConversationActionT["action_type"],
  parameters: Record<string, unknown>,
  status: V2ConversationActionT["status"] = "proposed",
): V2ConversationActionT {
  const confirmed = !["proposed", "rejected"].includes(status);
  return {
    schema_version: 2,
    id: `action-${actionType}`,
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    initiated_by_user_id: "user-1",
    actor: { actor_type: "human", actor_id: "user-1" },
    source_message_id: `message-${actionType}`,
    action_type: actionType,
    interaction_class: actionType === "answer_human_wait" ? "human_decision" : "task_direction",
    payload: { parameters },
    payload_hash: sha,
    status,
    confirmed_by_user_id: confirmed ? "user-1" : null,
    confirmation_idempotency_key: confirmed ? `confirm-${actionType}` : null,
    confirmation_request_fingerprint: confirmed ? sha : null,
    confirmed_at: confirmed ? now : null,
    recorded_at:
      confirmed && ["recorded", "sent", "agent_acknowledged", "applied", "failed"].includes(status)
        ? now
        : null,
    sent_at:
      confirmed && ["sent", "agent_acknowledged", "applied", "failed"].includes(status)
        ? now
        : null,
    acknowledged_at:
      confirmed && ["agent_acknowledged", "applied", "failed"].includes(status) ? now : null,
    applied_at: status === "applied" ? now : null,
    failure_code: status === "failed" ? "delivery_failed" : null,
    created_at: now,
    updated_at: now,
  };
}

function deliveryEvent(
  status: V2ConversationActionDeliveryEventT["status"],
  mode: V2ConversationActionDeliveryEventT["delivery_mode"],
): V2ConversationActionDeliveryEventT {
  const receipt =
    status === "sent"
      ? ({ kind: "sent", outbox_id: "outbox-1" } as const)
      : ({ kind: "recorded", record_id: "record-1" } as const);
  return {
    schema_version: 2,
    id: `event-${status}-${mode}`,
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    action_id: "action-redirect_agent",
    sequence: 1,
    status,
    delivery_mode: mode,
    target_run_id: "run-1",
    target_command_id: status === "sent" ? "command-1" : null,
    receipt,
    occurred_at: now,
  };
}

function humanWait(status: V2HumanWaitT["status"] = "awaiting_human"): V2HumanWaitT {
  return {
    schema_version: 2,
    id: "wait-1",
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    phase_id: "phase-1",
    task_id: "task-1",
    source_run_id: "run-1",
    source_event_id: "event-1",
    decision_point: "Choose the migration window",
    question: "Should the database migration run before or after the deploy?",
    question_hash: sha,
    published: {
      branch: "phase5/wait-1",
      commit_sha: sha,
      remote: "origin",
    },
    runtime: {
      runtime_id: "runtime-1",
      session_id: null,
      session_portability: "transcript_only",
      session_portability_evidence: null,
    },
    context: {
      root_command_id: "command-root-1",
      ask_channel_version: 1,
      ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
      root_context_refs: [
        {
          artifact_id: "artifact-context-1",
          content_hash: sha,
          byte_size: 128,
          storage_ref: "artifacts/context-1.json",
        },
      ],
      context_hash: sha,
      task_package_hash: sha,
      compact_summary: "The migration is ready and needs a deployment-window decision.",
      compact_summary_hash: sha,
    },
    budget: {
      reservation_id: "reservation-1",
      root_run_id: "root-run-1",
    },
    status,
    version: 3,
    expires_at: "2026-07-28T12:00:00.000Z",
    answered_at: status === "awaiting_human" ? null : now,
    resumed_at: status === "resumed" ? now : null,
    created_at: now,
    updated_at: now,
  };
}

describe("Phase 5 execution conversation controls", () => {
  it("prepares a mockup from task and artifact selectors without free-form IDs", async () => {
    const onPrepare = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <MockupRequestComposer
        taskOptions={[{ id: "task-7", label: "Checkout · task-7" }]}
        artifactOptions={[
          { id: "artifact-wireframe", label: "Wireframe" },
          { id: "artifact-copy", label: "Approved copy" },
        ]}
        busy={false}
        error={null}
        disabledReason={null}
        onPrepare={onPrepare}
      />,
    );

    await user.click(screen.getByText("UI preview"));
    await user.type(
      screen.getByRole("textbox", { name: "Mockup brief" }),
      "Show checkout on desktop and mobile.",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Mockup task" }), "task-7");
    await user.click(screen.getByRole("checkbox", { name: "Wireframe" }));
    await user.click(screen.getByRole("button", { name: "Prepare UI preview" }));

    expect(onPrepare).toHaveBeenCalledWith({
      brief: "Show checkout on desktop and mobile.",
      target: "responsive",
      task_id: "task-7",
      artifact_refs: ["artifact-wireframe"],
    });
    expect(screen.queryByText(/comma-separated/i)).not.toBeInTheDocument();
  });

  it("prepares typed task direction without treating discussion as a mutation", async () => {
    const onPrepare = vi.fn(async () => true);
    const user = userEvent.setup();
    render(
      <ExecutionActionComposer
        actions={[]}
        planVersions={[]}
        busy={false}
        error={null}
        disabledReason={null}
        lockedRequest={null}
        onPrepare={onPrepare}
        onRetryLocked={async () => false}
      />,
    );

    expect(
      screen.getByText(/Discussion in the message box never changes project state/i),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Task ID" }), "task-7");
    await user.type(screen.getByRole("textbox", { name: "Active run ID" }), "run-7");
    await user.type(screen.getByRole("textbox", { name: "Direction" }), "Use the safe adapter.");
    await user.click(screen.getByRole("button", { name: "Prepare action for confirmation" }));

    expect(onPrepare).toHaveBeenCalledWith("redirect_agent", {
      task_id: "task-7",
      run_id: "run-7",
      direction: "Use the safe adapter.",
      delivery_preference: "live_or_checkpoint",
    });
  });

  it("distinguishes checkpoint queued from checkpoint sent", () => {
    const direction = action(
      "redirect_agent",
      {
        task_id: "task-1",
        run_id: "run-1",
        direction: "Stop after the migration boundary.",
        delivery_preference: "live_or_checkpoint",
      },
      "recorded",
    );
    const { rerender } = render(
      <ConversationActionCard
        action={direction}
        busy={false}
        effect={null}
        deliveryEvents={[deliveryEvent("recorded", "checkpoint")]}
        error={null}
        onConfirm={async () => undefined}
      />,
    );
    expect(screen.getByText(/Queued for the next safe checkpoint/i)).toBeInTheDocument();
    expect(screen.getByText(/It has not been sent/i)).toBeInTheDocument();

    rerender(
      <ConversationActionCard
        action={{ ...direction, status: "sent", sent_at: now }}
        busy={false}
        effect={null}
        deliveryEvents={[deliveryEvent("sent", "checkpoint")]}
        error={null}
        onConfirm={async () => undefined}
      />,
    );
    expect(screen.getByText(/Sent at a safe checkpoint/i)).toBeInTheDocument();
    expect(screen.queryByText(/It has not been sent/i)).not.toBeInTheDocument();
  });

  it("prepares an exact durable answer, then requires separate action confirmation", async () => {
    const wait = humanWait();
    const onPrepareAnswer = vi.fn(async () => true);
    const onConfirm = vi.fn(async () => undefined);
    const user = userEvent.setup();
    const proposed = action("answer_human_wait", {
      wait_id: wait.id,
      expected_version: wait.version,
      question_hash: wait.question_hash,
      answer: "Run it before the deploy.",
      rationale: "Rollback is simpler before traffic moves.",
    });
    const { rerender } = render(
      <HumanWaitCard
        view={{ wait, answer: null, continuation: null }}
        answerAction={null}
        deliveryEvents={[]}
        effect={null}
        busy={false}
        error={null}
        onPrepareAnswer={onPrepareAnswer}
        onConfirm={onConfirm}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("phase5/wait-1")).toBeInTheDocument();
    expect(
      screen.getByText(/runner was released after publishing its branch/i),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Exact answer" }),
      "Run it before the deploy.",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Rationale (optional)" }),
      "Rollback is simpler before traffic moves.",
    );
    await user.click(screen.getByRole("button", { name: "Prepare answer for confirmation" }));
    expect(onPrepareAnswer).toHaveBeenCalledWith(
      wait,
      "Run it before the deploy.",
      "Rollback is simpler before traffic moves.",
    );
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(
      <HumanWaitCard
        view={{ wait, answer: null, continuation: null }}
        answerAction={proposed}
        deliveryEvents={[]}
        effect={null}
        busy={false}
        error={null}
        onPrepareAnswer={onPrepareAnswer}
        onConfirm={onConfirm}
        onRefresh={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Confirm action: Submit exact answer" }));
    expect(onConfirm).toHaveBeenCalledWith(proposed);
  });

  it("locks an uncertain human-wait answer to the exact persisted draft for retry", async () => {
    const wait = humanWait();
    window.sessionStorage.setItem(
      `norns:human-wait-answer-draft:${wait.id}`,
      JSON.stringify({
        answer: "Keep the migration before deployment.",
        rationale: "This preserves the tested rollback path.",
      }),
    );
    const onPrepareAnswer = vi.fn(async () => false);
    const user = userEvent.setup();
    render(
      <HumanWaitCard
        view={{ wait, answer: null, continuation: null }}
        answerAction={null}
        deliveryEvents={[]}
        effect={null}
        busy={false}
        error="Answer status is uncertain. The exact draft is locked for a safe retry."
        exactRetryLocked
        onPrepareAnswer={onPrepareAnswer}
        onConfirm={async () => undefined}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Exact answer" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Rationale (optional)" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry exact answer proposal" }));
    expect(onPrepareAnswer).toHaveBeenCalledWith(
      wait,
      "Keep the migration before deployment.",
      "This preserves the tested rollback path.",
    );
  });

  it("shows one continuation's durable progress and terminal cancelled truthfully", () => {
    const continuation: V2HumanWaitContinuationT = {
      schema_version: 2,
      id: "continuation-1",
      wait_id: "wait-1",
      answer_id: "answer-1",
      root_run_id: "root-run-1",
      resume_command_id: "command-1",
      resume_job_id: "job-1",
      budget_reservation_id: "reservation-1",
      saved_commit_sha: sha,
      context_hash: sha,
      answer_receipt_hash: sha,
      replay_context_ref: {
        artifact_id: "artifact-replay-1",
        content_hash: sha,
        byte_size: 256,
        storage_ref: "artifacts/replay-1.json",
      },
      runner_id: "runner-1",
      runner_generation: 2,
      delivery_receipt_hash: sha,
      status: "dispatched",
      created_at: now,
      updated_at: now,
    };
    const { rerender } = render(
      <HumanWaitCard
        view={{ wait: humanWait("continuation_queued"), answer: null, continuation }}
        answerAction={null}
        deliveryEvents={[]}
        effect={null}
        busy={false}
        error={null}
        onPrepareAnswer={async () => false}
        onConfirm={async () => undefined}
        onRefresh={vi.fn()}
      />,
    );
    const timeline = within(
      screen.getByRole("region", { name: "Continuation delivery" }),
    ).getByRole("list");
    expect(within(timeline).getByText("dispatched")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/One continuation is queued/i)).toBeInTheDocument();

    rerender(
      <HumanWaitCard
        view={{ wait: humanWait("cancelled"), answer: null, continuation: null }}
        answerAction={null}
        deliveryEvents={[]}
        effect={null}
        busy={false}
        error={null}
        onPrepareAnswer={async () => false}
        onConfirm={async () => undefined}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/cancelled\. No continuation was sent/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Exact answer" })).not.toBeInTheDocument();
  });

  it("saves an explicit project PM update override or clears it to inherit", async () => {
    const onSave = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <PmUpdateControls
        settings={{
          project_id: "project-1",
          update_interval_seconds: 300,
          content_level: "standard",
          interval_inherited: true,
          content_level_inherited: true,
          updated_at: null,
        }}
        updates={[
          {
            schema_version: 2,
            id: "update-1",
            project_id: "project-1",
            work_item_id: "work-1",
            conversation_id: "conversation-1",
            transition_sequence: 1,
            state_hash: sha,
            status: "working",
            content: "Two tasks are active; no decisions are waiting.",
            created_at: now,
          },
        ]}
        busy={false}
        error={null}
        onSave={onSave}
      />,
    );
    await user.click(screen.getByText(/PM updates · every 5 min/i));
    expect(screen.getByText(/generated from durable project state/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Update frequency"), "900");
    await user.selectOptions(screen.getByLabelText("Update detail"), "detailed");
    await user.click(screen.getByRole("button", { name: "Save PM update override" }));
    expect(onSave).toHaveBeenCalledWith({
      update_interval_seconds: 900,
      content_level: "detailed",
    });
  });
});
