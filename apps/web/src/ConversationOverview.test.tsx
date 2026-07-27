import type { V2WorkConversationT, V2WorkItemT } from "@norns/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationOverview } from "./ConversationOverview";

const now = "2026-07-27T12:00:00.000Z";

function workItem(projectId: string): V2WorkItemT {
  return {
    schema_version: 2,
    id: `work-${projectId}`,
    project_id: projectId,
    created_by_user_id: "user-1",
    title: `Conversation work for ${projectId}`,
    objective: "Deliver the approved work from a compact handoff.",
    status: "executing",
    planning_run_id: null,
    phase_id: null,
    approved_plan_version_id: "plan-1",
    aggregate_version: 2,
    created_at: now,
    updated_at: now,
    execution_started_at: now,
    completed_at: null,
  };
}

function conversation(projectId: string, kind: "planning" | "execution_pm"): V2WorkConversationT {
  return {
    schema_version: 2,
    id: `${projectId}-${kind}`,
    project_id: projectId,
    work_item_id: `work-${projectId}`,
    created_by_user_id: "user-1",
    kind,
    status: kind === "planning" ? "archived" : "active",
    provider: kind === "planning" ? "anthropic" : "openai",
    model: kind === "planning" ? "claude-sonnet-5" : "gpt-5.6-sol",
    next_message_sequence: 2,
    created_at: now,
    updated_at: now,
    archived_at: kind === "planning" ? now : null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConversationOverview", () => {
  it("links planning and execution by exact ID with truthful per-conversation usage", async () => {
    const projectId = "project-overview";
    const planning = conversation(projectId, "planning");
    const execution = conversation(projectId, "execution_pm");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          work_items: [
            {
              work_item: workItem(projectId),
              conversations: [planning, execution],
              conversation_usage: {
                [planning.id]: {
                  input_tokens: 80,
                  output_tokens: 20,
                  cost_usd: 0.015,
                  exact_cost: true,
                  usage_status: "exact",
                  attempt_count: 2,
                },
                [execution.id]: {
                  input_tokens: 10,
                  output_tokens: 0,
                  cost_usd: null,
                  exact_cost: false,
                  usage_status: "pending",
                  attempt_count: 1,
                },
              },
            },
          ],
        }),
      ),
    );
    const open = vi.fn();
    const user = userEvent.setup();
    render(
      <ConversationOverview
        projectId={projectId}
        onOpenConversation={open}
        onUnauthorized={() => undefined}
      />,
    );

    expect(await screen.findByText("100 tokens · $0.0150")).toBeInTheDocument();
    expect(screen.getByText("Usage settling")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: `Open Planning conversation for Conversation work for ${projectId}`,
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: `Open Execution PM conversation for Conversation work for ${projectId}`,
      }),
    );
    expect(open.mock.calls).toEqual([[planning.id], [execution.id]]);
  });

  it("clears the prior project's conversations before rendering a new project response", async () => {
    const firstProject = "project-first";
    const secondProject = "project-second";
    let resolveSecond!: (response: Response) => void;
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes(firstProject)) {
          return Response.json({
            work_items: [
              {
                work_item: workItem(firstProject),
                conversations: [conversation(firstProject, "planning")],
              },
            ],
          });
        }
        if (url.includes(secondProject)) return secondResponse;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const view = render(
      <ConversationOverview
        projectId={firstProject}
        onOpenConversation={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );
    expect(await screen.findByText(`Conversation work for ${firstProject}`)).toBeInTheDocument();

    view.rerender(
      <ConversationOverview
        projectId={secondProject}
        onOpenConversation={() => undefined}
        onUnauthorized={() => undefined}
      />,
    );
    expect(screen.queryByText(`Conversation work for ${firstProject}`)).not.toBeInTheDocument();
    expect(screen.getByText("Loading project conversations…")).toBeInTheDocument();

    resolveSecond(
      Response.json({
        work_items: [
          {
            work_item: workItem(secondProject),
            conversations: [conversation(secondProject, "execution_pm")],
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(`Conversation work for ${secondProject}`)).toBeInTheDocument(),
    );
  });
});
