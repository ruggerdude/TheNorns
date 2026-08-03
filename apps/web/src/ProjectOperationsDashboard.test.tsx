import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectOperationsDashboard } from "./ProjectOperationsDashboard";

const now = "2026-07-27T12:00:00.000Z";
const projectId = "project-phase6";

const available = <T,>(source: string, data: T) => ({
  availability: "available" as const,
  source,
  observed_at: now,
  data,
});

function dashboard() {
  return {
    schema_version: 2,
    project_id: projectId,
    generated_at: now,
    active_work: available("workflow_state", [
      {
        work_item: {
          schema_version: 2,
          id: "work-1",
          project_id: projectId,
          created_by_user_id: "user-1",
          title: "Ship the visual workflow",
          objective: "Deliver reviewable visual evidence.",
          status: "executing",
          planning_run_id: null,
          phase_id: "phase-1",
          approved_plan_version_id: "plan-1",
          aggregate_version: 4,
          created_at: now,
          updated_at: now,
          execution_started_at: now,
          completed_at: null,
        },
        conversation_id: "execution-1",
        deep_link: `/projects/${projectId}/work/execution-1`,
        phase_progress: {
          phase_id: "phase-1",
          percent_complete: 50,
          tasks_completed: 1,
          tasks_total: 2,
        },
      },
    ]),
    needs_attention: available("attention_projection", [
      {
        project_id: projectId,
        key: "mockup:1",
        source_type: "mockup",
        source_id: "mockup-1",
        work_item_id: "work-1",
        conversation_id: "execution-1",
        phase_id: "phase-1",
        task_id: "task-1",
        title: "Review responsive mockup",
        summary: "Version 2 is ready for approval.",
        severity: "high",
        deep_link: `/projects/${projectId}/work/execution-1`,
        occurred_at: now,
      },
      {
        project_id: projectId,
        key: "visual:1",
        source_type: "visual_evidence",
        source_id: "collection-1",
        work_item_id: "work-1",
        conversation_id: "execution-1",
        phase_id: "phase-1",
        task_id: "task-1",
        title: "Visual collection failed",
        summary: "The deployment screenshot collection must be retried.",
        severity: "critical",
        deep_link: `/projects/${projectId}/work/execution-1`,
        occurred_at: now,
      },
    ]),
    open_decisions: available("human_waits_and_decisions", [
      {
        id: "wait-1",
        project_id: projectId,
        work_item_id: "work-1",
        phase_id: "phase-1",
        conversation_id: "execution-1",
        source_type: "human_wait",
        source_id: "wait-1",
        title: "Deployment decision",
        detail: "Deploy before the migration?",
        status: "awaiting_human",
        deep_link: `/projects/${projectId}/work/execution-1`,
        created_at: now,
      },
    ]),
    budget: available("usage_ledger_and_approved_plan", {
      project_id: projectId,
      current_spend_usd: 12.5,
      projected_budget_usd: 42,
      projection_source: "usage_and_plan",
    }),
    recent_deployments: available("deployment_observations", []),
    recent_verification: available("verification_results", []),
    conversations: available("work_conversations", [
      {
        schema_version: 2,
        id: "planning-1",
        project_id: projectId,
        work_item_id: "work-1",
        created_by_user_id: "user-1",
        kind: "planning",
        status: "archived",
        provider: "anthropic",
        model: "claude-sonnet-5",
        next_message_sequence: 3,
        created_at: now,
        updated_at: now,
        archived_at: now,
      },
      {
        schema_version: 2,
        id: "execution-1",
        project_id: projectId,
        work_item_id: "work-1",
        created_by_user_id: "user-1",
        kind: "execution_pm",
        status: "active",
        provider: "openai",
        model: "gpt-5.6-sol",
        next_message_sequence: 2,
        created_at: now,
        updated_at: now,
        archived_at: null,
      },
    ]),
    approved_mockups: available("mockup_decisions", []),
    recent_artifacts: available("artifact_metadata", []),
    legacy_planning_runs: available("legacy_planning_runs", [
      {
        id: "legacy-1",
        project_id: projectId,
        label: "Original architecture plan",
        status: "converged",
        content_hash: "a".repeat(64),
        created_at: now,
        legacy: true,
      },
    ]),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 6 project operations dashboard", () => {
  it("keeps spending, status, and actionable items in a compact overview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(dashboard())),
    );

    render(<ProjectOperationsDashboard projectId={projectId} onUnauthorized={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Spending and status" })).toBeInTheDocument();
    expect(screen.getByText("Visual collection failed")).toBeInTheDocument();
    expect(screen.getByText("Deployment decision")).toBeInTheDocument();
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText("$42.00")).toBeInTheDocument();
    expect(screen.queryByText("No deployment observations are recorded.")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Planning and development chats" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Legacy planning runs" })).not.toBeInTheDocument();
  });

  it("does not convert an unavailable source into a zero or an empty result", async () => {
    const payload = dashboard();
    payload.budget = {
      availability: "unavailable",
      source: "usage_ledger_and_approved_plan",
      observed_at: null,
      data: null,
      reason_code: "usage_source_unavailable",
      detail: "The usage ledger timed out.",
      retryable: true,
    } as never;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );

    render(<ProjectOperationsDashboard projectId={projectId} onUnauthorized={() => undefined} />);

    expect(await screen.findByText("The usage ledger timed out.")).toBeInTheDocument();
    expect(screen.getByText("Spending unavailable")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});
