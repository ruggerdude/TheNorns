import type { V2ConversationActionStatusT, V2ConversationActionT } from "@norns/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConversationActionCard } from "./ConversationActionCard";

const now = "2026-07-27T12:00:00.000Z";

function action(status: V2ConversationActionStatusT): V2ConversationActionT {
  const confirmed = !["proposed", "rejected"].includes(status);
  return {
    schema_version: 2,
    id: `action-${status}`,
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    initiated_by_user_id: "user-1",
    actor: { actor_type: "agent", actor_id: "project-pm" },
    source_message_id: "message-1",
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
    confirmation_idempotency_key: confirmed ? `confirm-${status}` : null,
    confirmation_request_fingerprint: confirmed ? "c".repeat(64) : null,
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
    failure_code: status === "failed" ? "qc_delivery_failed" : null,
    created_at: now,
    updated_at: now,
  };
}

describe("conversation action card", () => {
  it("requires an explicit confirmation while a proposal is still inert", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const proposed = action("proposed");
    const user = userEvent.setup();

    render(
      <ConversationActionCard
        action={proposed}
        busy={false}
        effect={null}
        error={null}
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByText("This project change happens only when you confirm this card."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm action: Send to QC" }));
    expect(onConfirm).toHaveBeenCalledWith(proposed);
  });

  it.each(["confirmed", "recorded", "sent", "agent_acknowledged"] as const)(
    "offers recovery when a %s action has no durable effect",
    async (status) => {
      const onConfirm = vi.fn(async () => undefined);
      const pending = action(status);
      const user = userEvent.setup();
      render(
        <ConversationActionCard
          action={pending}
          busy={false}
          effect={null}
          error={null}
          onConfirm={onConfirm}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Continue action: Send to QC" }));
      expect(onConfirm).toHaveBeenCalledWith(pending);
    },
  );

  it.each(["applied", "failed", "rejected"] as const)(
    "does not re-offer a terminal %s action",
    (status) => {
      render(
        <ConversationActionCard
          action={action(status)}
          busy={false}
          effect={null}
          error={null}
          onConfirm={async () => undefined}
        />,
      );

      expect(screen.queryByRole("button", { name: /action:/i })).not.toBeInTheDocument();
    },
  );
});
