import { describe, expect, it } from "vitest";
import type { PhasePlanningRunDto } from "./phaseTabApi";
import { buildRelationalGraphReadModel } from "./relationalGraphReadModel";

function planningRun(overrides: Partial<PhasePlanningRunDto> = {}): PhasePlanningRunDto {
  return {
    id: "run-1",
    mode: "planned",
    status: "converged",
    round: 2,
    max_rounds: 3,
    review_rounds_total: 3,
    rounds_completed: 2,
    worker_providers: "both",
    decision: null,
    transcript: [],
    result: {
      plan: {
        modules: [
          { id: "api", title: "Core API", description: "Build the API." },
          { id: "web", title: "Web interface", description: "Build the UI." },
        ],
      },
      content_hash: "a".repeat(64),
      total_cost_usd: 1.25,
      staffing_proposal: {
        summary: "Staff both tasks.",
        recommendations: [
          {
            node_id: "api",
            provider: "anthropic",
            model: "claude-sonnet-5",
            worker_count: 1,
            reviewer_model: "gpt-5.6-sol",
            budget_usd: 20,
          },
        ],
      },
    },
    error: null,
    execution: null,
    ...overrides,
  };
}

describe("relational graph read model", () => {
  it("turns the current planning result into visible work items and assignments", () => {
    const model = buildRelationalGraphReadModel({
      planningRun: planningRun(),
      phaseExecution: null,
      phase: null,
    });

    expect(model).toMatchObject({
      kind: "planning",
      status: "converged",
      graph: {
        nodes: [
          {
            id: "api",
            title: "Core API",
            assignment: {
              provider: "anthropic",
              model: "claude-sonnet-5",
              reviewer_model: "gpt-5.6-sol",
            },
          },
          { id: "web", title: "Web interface", assignment: null },
        ],
      },
    });
  });

  it("prefers current phase execution after the planning run is approved", () => {
    const model = buildRelationalGraphReadModel({
      planningRun: planningRun({ status: "approved" }),
      phaseExecution: {
        phase: {
          id: "phase-1",
          objective_summary: "Ship notifications",
          status: "active",
        },
        tasks: [
          {
            id: "task-1",
            title: "Deliver email",
            complexity: "medium",
            risk: "low",
            dependencies: [],
            assignment: { provider: "openai", model: "gpt-5.6-terra" },
            implementation_agent: null,
            reviewer_agent: null,
          },
        ],
      },
      phase: {
        id: "phase-1",
        objective_summary: "Ship notifications",
        status: "active",
      },
    });

    expect(model).toMatchObject({
      kind: "execution",
      title: "Ship notifications",
      status: "active",
      graph: {
        nodes: [
          {
            id: "task-1",
            title: "Deliver email",
            assignment: { model: "gpt-5.6-terra", reviewer_model: "No reviewer" },
          },
        ],
      },
    });
  });
});
