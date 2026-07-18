import { describe, expect, it } from "vitest";
import {
  V2DebateActor,
  V2DebateActorExecutionSnapshot,
  V2DebateEvent,
  V2DebateMessage,
  V2DebateStoppingPolicy,
  V2DebateTurnAttempt,
  evaluateV2DebateStopping,
  v2AssertDebateRunTransition,
  v2CanDebateDefinitionTransition,
  v2CanDebateRoundTransition,
  v2CanDebateRunTransition,
  v2CanDebateTurnTransition,
} from "../src/v2/index.js";

const policy = {
  exact_rounds: 2,
  max_rounds: 3,
  max_duration_seconds: 3600,
  max_total_input_tokens: 100_000,
  max_total_output_tokens: 30_000,
  max_total_cost_usd: 50,
  stop_on_consensus: true,
  no_material_change_rounds: 2,
  repeated_disagreement_rounds: 2,
  provider_failure_threshold: 3,
} as const;

describe("V2 debate contracts", () => {
  it("preserves arbitrary participant role, provider, model, and runtime snapshots", () => {
    const actor = V2DebateActor.parse({
      schema_version: 2,
      id: "actor-1",
      debate_id: "debate-1",
      actor_kind: "participant",
      role_label: "contrarian systems economist",
      display_name: "Ava",
      instructions: "Challenge unstated assumptions.",
      provider: "provider-selected-by-user",
      model: "model-selected-by-user",
      runtime: "runtime-selected-by-user",
      position: 0,
      max_turns: 3,
      max_input_tokens: 20_000,
      max_output_tokens: 4_000,
      budget_limit_usd: 10,
      created_at: "2026-07-18T12:00:00.000Z",
    });
    expect(actor.role_label).toBe("contrarian systems economist");
  });

  it("requires a bound immutable per-run actor execution snapshot", () => {
    const snapshot = V2DebateActorExecutionSnapshot.parse({
      actor_id: "actor-1",
      provider: "openai",
      model: "gpt-selected",
      runtime: "provider_api",
      max_input_tokens: 20_000,
      max_output_tokens: 4_000,
      budget_limit_usd: 10,
      max_turns: 3,
      pricing: {
        provider: "openai",
        model: "gpt-selected",
        input_per_mtok_usd: 2,
        output_per_mtok_usd: 8,
        pricing_version: "2026-07-18",
        pricing_is_estimate: false,
      },
      maximum_turn_charge_usd: 0.072,
    });
    expect(snapshot.pricing.model).toBe(snapshot.model);
    expect(
      V2DebateActorExecutionSnapshot.safeParse({
        ...snapshot,
        pricing: { ...snapshot.pricing, model: "different-model" },
      }).success,
    ).toBe(false);
  });

  it("requires a human intervention to bind target and replay boundary metadata", () => {
    const base = {
      schema_version: 2,
      id: "message-1",
      debate_run_id: "run-1",
      sequence: 1,
      actor_snapshot: null,
      turn_id: null,
      turn_attempt_id: null,
      content: "Focus on the cost tradeoff.",
      content_hash: "a".repeat(64),
      created_at: "2026-07-18T12:00:00.000Z",
    };
    expect(
      V2DebateMessage.safeParse({
        ...base,
        message_kind: "human",
        intervention_kind: "direction",
        intervention_target_actor_id: null,
        intervention_apply_at: "next_turn",
        intervention_applies_after_round: 0,
        intervention_applies_after_turn: 0,
      }).success,
    ).toBe(true);
    expect(
      V2DebateMessage.safeParse({
        ...base,
        message_kind: "human",
        intervention_kind: "direction",
        intervention_target_actor_id: null,
        intervention_apply_at: "next_turn",
        intervention_applies_after_round: 0,
        intervention_applies_after_turn: null,
      }).success,
    ).toBe(false);
  });

  it("freezes terminal run, round, and turn states", () => {
    expect(v2CanDebateDefinitionTransition("draft", "ready")).toBe(true);
    expect(v2CanDebateDefinitionTransition("archived", "ready")).toBe(false);
    expect(v2CanDebateRunTransition("created", "queued")).toBe(true);
    expect(v2CanDebateRunTransition("running", "paused")).toBe(true);
    expect(v2CanDebateRunTransition("finalizing", "paused")).toBe(true);
    expect(v2CanDebateRunTransition("pausing", "finalizing")).toBe(true);
    expect(v2CanDebateRunTransition("running", "cancelled")).toBe(true);
    expect(v2CanDebateRunTransition("finalizing", "cancelled")).toBe(true);
    expect(v2CanDebateRunTransition("completed", "running")).toBe(false);
    expect(() => v2AssertDebateRunTransition("created", "paused")).toThrow(
      "illegal debate run transition created->paused",
    );
    expect(v2CanDebateRoundTransition("pending", "active")).toBe(true);
    expect(v2CanDebateRoundTransition("completed", "active")).toBe(false);
    expect(v2CanDebateTurnTransition("leased", "running")).toBe(true);
    expect(v2CanDebateTurnTransition("expired", "queued")).toBe(false);
  });

  it("evaluates deterministic stopping rules without model identity", () => {
    const parsed = V2DebateStoppingPolicy.parse(policy);
    expect(
      evaluateV2DebateStopping(parsed, {
        completed_rounds: 1,
        elapsed_seconds: 2,
        input_tokens: 100,
        output_tokens: 100,
        cost_usd: 0.1,
        consensus_reported: false,
        consecutive_no_material_change_rounds: 0,
        consecutive_repeated_disagreement_rounds: 0,
        consecutive_provider_failures: 0,
        requested_stop: false,
      }),
    ).toBeNull();
    expect(
      evaluateV2DebateStopping(parsed, {
        completed_rounds: 1,
        elapsed_seconds: 2,
        input_tokens: 100,
        output_tokens: 100,
        cost_usd: 0.1,
        consensus_reported: true,
        consecutive_no_material_change_rounds: 2,
        consecutive_repeated_disagreement_rounds: 2,
        consecutive_provider_failures: 0,
        requested_stop: false,
      }),
    ).toBeNull();
    expect(
      evaluateV2DebateStopping(parsed, {
        completed_rounds: 2,
        elapsed_seconds: 2,
        input_tokens: 100,
        output_tokens: 100,
        cost_usd: 0.1,
        consensus_reported: false,
        consecutive_no_material_change_rounds: 0,
        consecutive_repeated_disagreement_rounds: 0,
        consecutive_provider_failures: 0,
        requested_stop: false,
      }),
    ).toBe("exact_rounds");
  });

  it("requires an attempt lease to be paired with its expiry", () => {
    expect(
      V2DebateTurnAttempt.safeParse({
        schema_version: 2,
        id: "attempt-1",
        turn_id: "turn-1",
        attempt_number: 1,
        state: "leased",
        provider_execution_id: null,
        lease_token: "lease-1",
        leased_until: null,
        started_at: null,
        finished_at: null,
        failure_code: null,
        failure_detail: null,
        created_at: "2026-07-18T12:00:00.000Z",
        updated_at: "2026-07-18T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("freezes the content-addressed event replay envelope", () => {
    expect(
      V2DebateEvent.safeParse({
        schema_version: 2,
        id: "event-1",
        project_id: "project-1",
        debate_id: "debate-1",
        debate_run_id: "run-1",
        sequence: 1,
        type: "debate_run_queued",
        round_number: null,
        turn_number: null,
        lifecycle_version: 1,
        actor_type: "human",
        actor_id: "user-1",
        correlation_id: "correlation-1",
        causation_id: null,
        actor_snapshot: null,
        payload: {},
        artifact_ids: [],
        usage: null,
        occurred_at: "2026-07-18T12:00:00.000Z",
        content_hash: "a".repeat(64),
      }).success,
    ).toBe(true);
  });
});
