import type { V2WorkPlanVersionT } from "@norns/contracts";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { makeCoreApiModule, makePlan, makeWebUiModule } from "./test/fixtures";

function planVersion(): V2WorkPlanVersionT {
  const api = makeCoreApiModule({
    open_decisions: ["Choose the pagination ceiling."],
  });
  const web = makeWebUiModule({ dependencies: [api.id] });
  return {
    schema_version: 2,
    id: "plan-version-2",
    project_id: "project-1",
    work_item_id: "work-1",
    conversation_id: "conversation-1",
    created_by_user_id: "user-1",
    version: 2,
    status: "changes_requested",
    origin: "human",
    plan: {
      plan: makePlan({
        objective: "Ship a dependable notification experience",
        modules: [api, web],
        risks: [
          {
            description: "Delivery bursts may exhaust provider quotas.",
            mitigation: "Use bounded queues and retry budgets.",
          },
        ],
      }),
      staffing: [
        {
          module_id: api.id,
          agent_role: "implementation",
          provider: "anthropic",
          model: "claude-sonnet-5",
        },
        {
          module_id: web.id,
          agent_role: "implementation",
          provider: "openai",
          model: "gpt-5.6-terra",
        },
      ],
      verification_requirements: ["pnpm test", "pnpm typecheck"],
      open_decisions: ["Confirm the launch window."],
      estimated_budget: { currency: "USD", amount: 73.5 },
    },
    content_hash: "a".repeat(64),
    created_by_action_id: "action-save-plan-2",
    supersedes_plan_version_id: "plan-version-1",
    diff_from_previous: {
      added: ["Added Web UI task"],
      changed: ["Raised API verification coverage"],
      removed: ["Removed manual retry step"],
    },
    approved_by_user_id: null,
    approved_at: null,
    created_at: "2026-07-27T12:00:00.000Z",
    updated_at: "2026-07-27T12:01:00.000Z",
  };
}

describe("conversation Plan Contract card", () => {
  it("shows the server-authored version, ordered work, controls, evidence, budget, diff, and footer", () => {
    render(
      <ConversationPlanCard
        version={planVersion()}
        footer={<button type="button">Send to QC</button>}
      />,
    );

    const card = screen.getByRole("article", {
      name: "Ship a dependable notification experience",
    });
    expect(within(card).getByText("Plan Contract · Version 2")).toBeInTheDocument();
    expect(within(card).getByText("Changes requested")).toBeInTheDocument();
    expect(within(card).queryByTitle("a".repeat(64))).not.toBeInTheDocument();
    expect(within(card).getByText("$73.50")).toBeInTheDocument();

    const sequence = within(card).getByRole("list", { name: "Plan task sequence" });
    expect(sequence.children[0]).toHaveTextContent("Core API");
    expect(sequence.children[1]).toHaveTextContent("Web UI");
    expect(sequence.children[1]).toHaveTextContent("Depends oncore-api");
    expect(
      within(card).getByText("implementation · anthropic · claude-sonnet-5"),
    ).toBeInTheDocument();
    expect(within(card).getByText("implementation · openai · gpt-5.6-terra")).toBeInTheDocument();
    expect(within(card).getByText("pnpm test")).toBeInTheDocument();
    expect(within(card).getByText("Confirm the launch window.")).toBeInTheDocument();
    expect(within(card).getByText("Core API: Choose the pagination ceiling.")).toBeInTheDocument();
    expect(
      within(card).getByText("Delivery bursts may exhaust provider quotas."),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("Mitigation: Use bounded queues and retry budgets."),
    ).toBeInTheDocument();

    expect(within(card).getByText("Changes from version 1")).toBeInTheDocument();
    expect(within(card).getByText("Added Web UI task")).toBeInTheDocument();
    expect(within(card).getByText("Raised API verification coverage")).toBeInTheDocument();
    expect(within(card).getByText("Removed manual retry step")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Send to QC" })).toBeInTheDocument();
  });
});
