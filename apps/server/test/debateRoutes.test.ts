import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DebateDto, DebateRunDto, DebateService } from "../src/debates/service.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

const policy = {
  exact_rounds: null,
  max_rounds: 3,
  max_duration_seconds: 600,
  max_total_input_tokens: 20_000,
  max_total_output_tokens: 10_000,
  max_total_cost_usd: 5,
  stop_on_consensus: false,
  no_material_change_rounds: null,
  repeated_disagreement_rounds: null,
  provider_failure_threshold: 3,
};

const debate: DebateDto = {
  id: "debate-1",
  project_id: "project-1",
  status: "ready",
  revision: 4,
  aggregate_version: 4,
  current_round: 0,
  current_turn: 0,
  latest_event_sequence: 0,
  reserved_usd: 0,
  settled_usd: 0,
  retained_ambiguous_usd: 0,
  stop_reason: null,
  updated_at: "2026-07-18T00:00:00.000Z",
  started_at: null,
  ended_at: null,
  active_run_id: null,
  run: null,
  configuration: {
    title: "Architecture debate",
    question: "Which architecture should we choose?",
    actors: [],
    schedule: { kind: "round_robin", participant_ids: [] },
    policy,
  },
};

const run: DebateRunDto = {
  id: "run-1",
  debate_id: debate.id,
  status: "queued",
  aggregate_version: 7,
  version: 7,
  current_round: 1,
  current_turn: 1,
  total_usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  reserved_usd: 0,
  settled_usd: 0,
  retained_ambiguous_usd: 0,
  stop_reason: null,
  started_at: "2026-07-18T00:00:00.000Z",
  ended_at: null,
  judgment: null,
  final_output: null,
  messages: [],
  revisions: [],
  findings: [],
};

describe("durable debate HTTP API", () => {
  let server: NornsServer;
  let token: string;
  let userId: string;
  const calls: Record<string, unknown[]> = {};

  beforeEach(async () => {
    for (const key of Object.keys(calls)) delete calls[key];
    const users = new UserStore();
    token = testAdminToken(users);
    userId = users.list()[0]?.id ?? "";
    const service = {
      projectVersion: async (...args: unknown[]) => {
        calls.projectVersion = args;
        return 1;
      },
      list: async (...args: unknown[]) => {
        calls.list = args;
        return [debate];
      },
      get: async (...args: unknown[]) => {
        calls.get = args;
        return debate;
      },
      create: async (...args: unknown[]) => {
        calls.create = args;
        return debate;
      },
      start: async (...args: unknown[]) => {
        calls.start = args;
        return run;
      },
      getRun: async (...args: unknown[]) => {
        calls.getRun = args;
        return run;
      },
      events: async (...args: unknown[]) => {
        calls.events = args;
        return { events: [], latest_version: 7, next_after_version: 7 };
      },
      control: async (...args: unknown[]) => {
        calls.control = args;
        return run;
      },
      intervene: async (...args: unknown[]) => {
        calls.intervene = args;
        return { accepted: true as const };
      },
    } as unknown as DebateService;
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      debates: service,
      integrationEnvironment: {
        ANTHROPIC_API_KEY: "anthropic-test-secret",
        OPENAI_API_KEY: "openai-test-secret",
        NORNS_DEBATE_ALLOWED_MODELS: "openai/gpt-5.6-terra,anthropic/claude-sonnet-5",
      },
    });
  });

  afterEach(async () => {
    await server.app.close();
  });

  const inject = async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: string; json: () => unknown }> => {
    const response = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return response as unknown as { statusCode: number; body: string; json: () => unknown };
  };

  it("requires a session, returns a secret-free configured model catalog, and constructs attributed commands", async () => {
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v2/projects/project-1/debates" }))
        .statusCode,
    ).toBe(401);

    const catalog = await inject("GET", "/api/v2/capabilities/ai-models");
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", configured: true, available: true }),
        expect.objectContaining({ provider: "openai", configured: true, available: true }),
      ]),
    });
    expect(
      (catalog.json() as { models: Array<{ id: string }> }).models.map((model) => model.id),
    ).toEqual(expect.arrayContaining(["gpt-5.6-terra", "claude-sonnet-5"]));
    expect((catalog.json() as { models: Array<{ id: string }> }).models).toHaveLength(2);
    expect(catalog.body).not.toContain("test-secret");

    const created = await inject("POST", "/api/v2/projects/project-1/debates", {
      idempotency_key: "create-debate-1",
      configuration: {
        title: debate.configuration.title,
        question: debate.configuration.question,
        context_artifact_ids: [],
        actors: [
          {
            id: "participant-a",
            kind: "participant",
            display_name: "Ada",
            role_label: "Proposer",
            instructions: "Argue for the most robust solution.",
            provider: "openai",
            model: "gpt-5.6-terra",
            runtime: "provider_api",
            enabled: true,
            position: 0,
            max_turns: 3,
            max_input_tokens: 2_000,
            max_output_tokens: 1_000,
            budget_limit_usd: 1,
          },
          {
            id: "participant-b",
            kind: "participant",
            display_name: "Grace",
            role_label: "Critic",
            instructions: "Challenge assumptions and explain tradeoffs.",
            provider: "anthropic",
            model: "claude-sonnet-5",
            runtime: "provider_api",
            enabled: true,
            position: 1,
            max_turns: 3,
            max_input_tokens: 2_000,
            max_output_tokens: 1_000,
            budget_limit_usd: 1,
          },
        ],
        schedule: { kind: "round_robin", participant_ids: ["participant-a", "participant-b"] },
        policy,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(calls.create?.[0]).toMatchObject({
      kind: "create_debate",
      project_id: "project-1",
      actor: { actor_type: "human", actor_id: userId },
      idempotency_key: "create-debate-1",
      actors: [
        expect.objectContaining({ actor_kind: "participant", display_name: "Ada" }),
        expect.objectContaining({ actor_kind: "participant", display_name: "Grace" }),
      ],
    });
    expect((calls.create?.[0] as { command_id: string }).command_id).toMatch(/^command_/);
    expect((calls.create?.[0] as { correlation_id: string }).correlation_id).toMatch(
      /^correlation_/,
    );

    expect((await inject("GET", "/api/v2/projects/project-1/debates")).json()).toEqual([debate]);
    expect((await inject("GET", "/api/v2/projects/project-1/debates/debate-1")).json()).toEqual(
      debate,
    );

    const started = await inject("POST", "/api/v2/projects/project-1/debates/debate-1/runs", {
      idempotency_key: "start-run-1",
    });
    expect(started.statusCode).toBe(201);
    expect(calls.start?.[0]).toMatchObject({
      kind: "start_debate_run",
      expected_debate_version: debate.revision,
      actor: { actor_type: "human", actor_id: userId },
    });

    expect(
      (await inject("GET", "/api/v2/projects/project-1/debates/debate-1/runs/run-1")).json(),
    ).toEqual(run);
    expect(
      (
        await inject(
          "GET",
          "/api/v2/projects/project-1/debates/debate-1/runs/run-1/events?after_version=3",
        )
      ).json(),
    ).toEqual({ events: [], latest_version: 7, next_after_version: 7 });
    expect(calls.events).toEqual(["project-1", "debate-1", "run-1", 3]);

    const controlled = await inject(
      "POST",
      "/api/v2/projects/project-1/debates/debate-1/runs/run-1/control",
      { action: "pause", expected_version: 7, idempotency_key: "pause-run-1" },
    );
    expect(controlled.statusCode).toBe(200);
    expect(calls.control?.[0]).toMatchObject({
      kind: "control_debate_run",
      action: "pause",
      expected_run_version: 7,
      actor: { actor_type: "human", actor_id: userId },
    });

    const intervened = await inject(
      "POST",
      "/api/v2/projects/project-1/debates/debate-1/runs/run-1/interventions",
      {
        kind: "direction",
        target: "all",
        text: "Compare operational risks explicitly.",
        apply_at: "next_turn",
        expected_version: 7,
        idempotency_key: "direction-1",
      },
    );
    expect(intervened.statusCode).toBe(202);
    expect(calls.intervene?.[0]).toMatchObject({
      kind: "intervene_debate_run",
      expected_run_version: 7,
      actor: { actor_type: "human", actor_id: userId },
      intervention_kind: "direction",
      target_actor_id: null,
      apply_at: "next_turn",
      text: "Compare operational risks explicitly.",
    });
  });

  it("fails closed for artifact-backed contexts and requires the version shown to the user for interventions", async () => {
    const artifactContext = await inject("POST", "/api/v2/projects/project-1/debates", {
      idempotency_key: "artifact-context",
      configuration: {
        title: debate.configuration.title,
        question: debate.configuration.question,
        context_artifact_ids: [],
        contexts: [
          {
            label: "Repository report",
            artifact_id: "artifact-1",
            artifact_content_hash: "a".repeat(64),
            artifact_media_type: "text/plain",
            inline_content: null,
          },
        ],
        actors: [
          {
            kind: "participant",
            display_name: "Ada",
            role_label: "Proposer",
            instructions: "Argue for the most robust solution.",
            provider: "openai",
            model: "gpt-5.6-terra",
            position: 0,
            max_turns: 3,
            max_input_tokens: 2_000,
            max_output_tokens: 1_000,
            budget_limit_usd: 1,
          },
          {
            kind: "participant",
            display_name: "Grace",
            role_label: "Critic",
            instructions: "Challenge assumptions and explain tradeoffs.",
            provider: "anthropic",
            model: "claude-sonnet-5",
            position: 1,
            max_turns: 3,
            max_input_tokens: 2_000,
            max_output_tokens: 1_000,
            budget_limit_usd: 1,
          },
        ],
        schedule: { kind: "round_robin", participant_ids: ["participant-a", "participant-b"] },
        policy,
      },
    });
    expect(artifactContext.statusCode).toBe(400);
    expect(artifactContext.json()).toMatchObject({ error: "artifact_contexts_not_supported" });

    const missingVersion = await inject(
      "POST",
      "/api/v2/projects/project-1/debates/debate-1/runs/run-1/interventions",
      {
        kind: "statement",
        target: "all",
        text: "Keep the scope narrow.",
        apply_at: "next_round",
        idempotency_key: "missing-version",
      },
    );
    expect(missingVersion.statusCode).toBe(400);
  });
});
