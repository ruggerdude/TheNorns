import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebateBuilder } from "./DebateBuilder";
import { DebateRun } from "./DebateRun";
import { type AiModelOption, type DebateDto, catalogModels } from "./Debates";
import { MockFetch } from "./test/mockFetch";

const models: AiModelOption[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", configured: true },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", configured: true },
];

function debate(overrides: Partial<DebateDto> = {}): DebateDto {
  return {
    id: "debate-1",
    project_id: "project-1",
    status: "running",
    revision: 2,
    aggregate_version: 3,
    current_round: 1,
    current_turn: 2,
    latest_event_sequence: 1,
    reserved_usd: 8,
    settled_usd: 4,
    retained_ambiguous_usd: 0,
    stop_reason: null,
    updated_at: "2026-07-18T12:00:00.000Z",
    active_run_id: "run-1",
    configuration: {
      title: "Migration strategy",
      question: "Should we use a dual-write migration?",
      actors: [
        {
          id: "actor-a",
          kind: "participant",
          display_name: "Reliability lead",
          role_label: "Skeptic",
          instructions: "Seek rollback evidence.",
          provider: "anthropic",
          model: "claude-sonnet-5",
          enabled: true,
          position: 0,
          max_turns: 3,
          max_input_tokens: 12000,
          max_output_tokens: 4000,
          budget_limit_usd: 12,
        },
        {
          id: "actor-b",
          kind: "participant",
          display_name: "Delivery lead",
          role_label: "Advocate",
          instructions: "Make the delivery case.",
          provider: "openai",
          model: "gpt-5.6-terra",
          enabled: true,
          position: 1,
          max_turns: 3,
          max_input_tokens: 12000,
          max_output_tokens: 4000,
          budget_limit_usd: 12,
        },
      ],
      schedule: { kind: "round_robin", participant_ids: ["actor-a", "actor-b"] },
      policy: {
        exact_rounds: null,
        max_rounds: 3,
        max_duration_seconds: 1800,
        max_total_input_tokens: 120000,
        max_total_output_tokens: 40000,
        max_total_cost_usd: 50,
        stop_on_consensus: true,
        no_material_change_rounds: 2,
        repeated_disagreement_rounds: 2,
        provider_failure_threshold: 2,
      },
    },
    ...overrides,
  };
}

describe("debate frontend", () => {
  let mock: MockFetch | undefined;

  afterEach(() => mock?.restore());

  it("normalizes both supported model catalog response shapes without inventing models", () => {
    expect(
      catalogModels({
        providers: [
          { id: "openai", configured: true, models: [{ id: "gpt-5.6-terra", label: "Terra" }] },
        ],
        models: [{ id: "claude-sonnet-5", provider: "anthropic", configured: true }],
      }),
    ).toEqual([
      {
        id: "claude-sonnet-5",
        label: "claude-sonnet-5",
        provider: "anthropic",
        configured: true,
        description: undefined,
      },
      {
        id: "gpt-5.6-terra",
        label: "Terra",
        provider: "openai",
        configured: true,
        description: undefined,
      },
    ]);
  });

  it("creates a draft with arbitrary participant roles and exact selected models", async () => {
    const user = userEvent.setup();
    const create = vi.fn().mockResolvedValue(debate({ status: "draft", active_run_id: null }));
    render(
      <DebateBuilder
        projectId="project-1"
        models={models}
        onCancel={vi.fn()}
        onCreate={create}
        onCreated={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Debate title"), "Migration strategy");
    await user.type(screen.getByLabelText("Question"), "Should we dual write?");
    const names = screen.getAllByLabelText("Display name");
    const roles = screen.getAllByLabelText("Role label");
    const instructions = screen.getAllByLabelText("Instructions");
    const providers = screen.getAllByLabelText("Provider");
    const selectedModels = screen.getAllByLabelText("Exact model");
    await user.type(names[0] as HTMLInputElement, "Reliability lead");
    await user.type(names[1] as HTMLInputElement, "Delivery lead");
    await user.type(roles[0] as HTMLInputElement, "Rollback skeptic");
    await user.type(roles[1] as HTMLInputElement, "Delivery advocate");
    await user.type(instructions[0] as HTMLTextAreaElement, "Demand a tested rollback.");
    await user.type(instructions[1] as HTMLTextAreaElement, "Defend a safe rollout.");
    await user.selectOptions(selectedModels[0] as HTMLSelectElement, "claude-sonnet-5");
    await user.selectOptions(providers[1] as HTMLSelectElement, "openai");
    await user.selectOptions(selectedModels[1] as HTMLSelectElement, "gpt-5.6-terra");

    await user.click(screen.getByRole("button", { name: "Save debate draft" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0].configuration.actors).toMatchObject([
      { role_label: "Rollback skeptic", model: "claude-sonnet-5", provider: "anthropic" },
      { role_label: "Delivery advocate", model: "gpt-5.6-terra", provider: "openai" },
    ]);
  });

  it("replays attributed events and sends bounded control and intervention commands", async () => {
    const user = userEvent.setup();
    mock = new MockFetch();
    const base = "/api/v2/projects/project-1/debates/debate-1";
    mock.get(base, { body: debate() });
    mock.get(`${base}/runs/run-1`, {
      body: {
        id: "run-1",
        status: "running",
        aggregate_version: 5,
        settled_usd: 4,
        reserved_usd: 8,
      },
    });
    mock.get(`${base}/runs/run-1/events?after_version=0`, {
      body: {
        next_after_version: 1,
        events: [
          {
            id: "event-1",
            sequence: 1,
            type: "turn_completed",
            round_number: 1,
            turn_number: 1,
            actor_snapshot: debate().configuration.actors[0],
            payload: {
              content: "A dual write needs a tested rollback path.",
              findings: [
                {
                  severity: "must_fix",
                  finding: "Rollback drill missing",
                  recommendation: "Run it before cutover",
                },
              ],
            },
            artifact_ids: ["artifact-1"],
            usage: { input_tokens: 400, output_tokens: 100, cost_usd: 0.04 },
            occurred_at: "2026-07-18T12:00:00.000Z",
          },
        ],
      },
    });
    mock.get(`${base}/runs/run-1/events?after_version=1`, { body: { events: [] } });
    mock.post(`${base}/runs/run-1/control`, {
      body: { id: "run-1", status: "pause_requested", aggregate_version: 6 },
    });
    mock.post(`${base}/runs/run-1/interventions`, { body: {} });
    mock.install();

    render(
      <DebateRun
        projectId="project-1"
        debateId="debate-1"
        onUnauthorized={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(await screen.findByText("A dual write needs a tested rollback path.")).toBeVisible();
    expect(screen.getByText(/Reliability lead · Skeptic/i)).toBeVisible();
    expect(screen.getByText("artifact-1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(mock?.calls.find((call) => call.url.endsWith("/control"))).toMatchObject({
        body: { action: "pause", expected_version: 5 },
      }),
    );
    await user.type(screen.getByLabelText("Message"), "Include the recovery drill.");
    await user.click(screen.getByRole("button", { name: "Record intervention" }));
    await waitFor(() =>
      expect(mock?.calls.find((call) => call.url.endsWith("/interventions"))).toMatchObject({
        body: {
          kind: "direction",
          target: "all",
          apply_at: "next_turn",
          text: "Include the recovery drill.",
        },
      }),
    );
  });
});
