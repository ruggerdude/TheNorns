import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter } from "@norns/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DebateService } from "../src/debates/service.js";
import { DebateWorker } from "../src/debates/worker.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const NOW = "2026-07-18T14:00:00.000Z";

describe.sequential("durable debate worker", () => {
  let pg: PGlite;
  let service: DebateService;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        'project-debate', 'Debate project', 'active',
        'assignment/default', 'verification/default', 'budget/default'
      );
    `);
    const transactions = new PGliteTransactionRunner(pg);
    service = new DebateService(transactions, {
      now: () => new Date(NOW),
      maximumTurnCharge: () => 0.01,
    });
    adapter = new FakeAdapter("openai");
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  it("persists each turn boundary and completes an exact-round debate", async () => {
    const commonActor = {
      actor_kind: "participant" as const,
      instructions: "Argue from the supplied evidence.",
      provider: "openai",
      model: "mock-openai",
      runtime: "provider_api",
      max_turns: 2,
      max_input_tokens: 6_000,
      max_output_tokens: 500,
      budget_limit_usd: 1,
    };
    const debate = await service.create({
      schema_version: 2,
      command_id: "command-create-debate",
      kind: "create_debate",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "create-debate",
      correlation_id: "correlation-create",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      expected_project_version: 1,
      phase_id: null,
      title: "Persistence boundary",
      question: "Which persistence boundary is safest?",
      stopping_policy: {
        exact_rounds: 1,
        max_rounds: 3,
        max_duration_seconds: 600,
        max_total_input_tokens: 20_000,
        max_total_output_tokens: 5_000,
        max_total_cost_usd: 10,
        stop_on_consensus: false,
        no_material_change_rounds: null,
        repeated_disagreement_rounds: null,
        provider_failure_threshold: 3,
      },
      actors: [
        {
          ...commonActor,
          role_label: "designer",
          display_name: "Designer",
          position: 0,
        },
        {
          ...commonActor,
          role_label: "critic",
          display_name: "Critic",
          position: 1,
        },
      ],
      contexts: [],
    });
    const run = await service.start({
      schema_version: 2,
      command_id: "command-start-debate",
      kind: "start_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "start-debate",
      correlation_id: "correlation-start",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      expected_debate_version: 1,
    });

    adapter.enqueue(
      {
        content: "Use normalized rows plus an append-only event stream.",
        summary: "Hybrid persistence",
        claims: ["Rows serve operations", "Events serve history"],
        findings: [],
        consensus_reported: false,
        material_change: true,
        unresolved_disagreements: ["Retention horizon"],
      },
      {
        content: "The hybrid boundary is acceptable with reconciliation.",
        summary: "Qualified agreement",
        claims: ["Reconciliation detects drift"],
        findings: [],
        consensus_reported: true,
        material_change: true,
        unresolved_disagreements: [],
      },
    );
    const worker = new DebateWorker(new PGliteTransactionRunner(pg), () => adapter, {
      now: () => new Date(NOW),
      maximumTurnCharge: () => 0.01,
    });

    expect(await worker.tick()).toBe("completed");
    expect((await service.getRun("project-debate", debate.id, run.id)).status).toBe("running");
    expect(await worker.tick()).toBe("completed");

    const completed = await service.getRun("project-debate", debate.id, run.id);
    expect(completed.status).toBe("completed");
    expect(completed.current_round).toBe(1);
    expect(completed.total_usage.input_tokens).toBe(200);
    expect(completed.total_usage.output_tokens).toBe(100);
    expect(completed.final_output?.content).toContain("acceptable with reconciliation");
    const replay = await service.events("project-debate", debate.id, run.id, 0);
    expect(replay.events.map((event) => event.type)).toEqual([
      "debate_run_queued",
      "debate_run_running",
      "debate_turn_dispatched",
      "participant_turn_completed",
      "debate_turn_dispatched",
      "participant_turn_completed",
      "debate_run_finalizing",
      "debate_run_completed",
    ]);
    expect(adapter.requests).toHaveLength(2);

    const rerun = await service.start({
      schema_version: 2,
      command_id: "command-rerun-debate",
      kind: "start_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "rerun-debate",
      correlation_id: "correlation-rerun",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      expected_debate_version: 1,
    });
    const paused = await service.control({
      schema_version: 2,
      command_id: "command-pause-debate",
      kind: "control_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "pause-debate",
      correlation_id: "correlation-pause",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      debate_run_id: rerun.id,
      expected_run_version: rerun.aggregate_version,
      action: "pause",
      reason: "Review the current setup",
    });
    expect(paused.status).toBe("paused");
    expect(await worker.tick()).toBe("idle");
    const resumed = await service.control({
      schema_version: 2,
      command_id: "command-resume-debate",
      kind: "control_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "resume-debate",
      correlation_id: "correlation-resume",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      debate_run_id: rerun.id,
      expected_run_version: paused.aggregate_version,
      action: "resume",
      reason: "Continue",
    });
    expect(resumed.status).toBe("queued");
    const cancelled = await service.control({
      schema_version: 2,
      command_id: "command-cancel-debate",
      kind: "control_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "cancel-debate",
      correlation_id: "correlation-cancel",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      debate_run_id: rerun.id,
      expected_run_version: resumed.aggregate_version,
      action: "cancel",
      reason: "No longer needed",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.reserved_usd).toBe(0);

    const ambiguous = await service.start({
      schema_version: 2,
      command_id: "command-ambiguous-debate",
      kind: "start_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "ambiguous-debate",
      correlation_id: "correlation-ambiguous",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      expected_debate_version: 1,
    });
    await pg.exec(`
      UPDATE debate_jobs SET state = 'leased', lease_token = 'abandoned',
        leased_until = '2026-07-18T13:59:00.000Z'
      WHERE debate_run_id = '${ambiguous.id}';
      UPDATE debate_turn_attempts SET state = 'running', lease_token = 'abandoned',
        leased_until = '2026-07-18T13:59:00.000Z'
      WHERE debate_run_id = '${ambiguous.id}';
      UPDATE debate_turns SET state = 'running' WHERE debate_run_id = '${ambiguous.id}';
      UPDATE debate_runs SET state = 'running', lifecycle_version = 2
      WHERE id = '${ambiguous.id}';
    `);
    expect(await worker.tick()).toBe("idle");
    const quarantined = await service.getRun("project-debate", debate.id, ambiguous.id);
    expect(quarantined.status).toBe("paused");
    expect(quarantined.retained_ambiguous_usd).toBe(0.01);
    expect(
      (await service.events("project-debate", debate.id, ambiguous.id, 0)).events.at(-1)?.type,
    ).toBe("debate_turn_execution_ambiguous");
    const retryCommand = {
      schema_version: 2,
      command_id: "command-retry-ambiguous",
      kind: "control_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-1" },
      idempotency_key: "retry-ambiguous",
      correlation_id: "correlation-retry-ambiguous",
      causation_id: null,
      issued_at: NOW,
      project_id: "project-debate",
      debate_id: debate.id,
      debate_run_id: ambiguous.id,
      expected_run_version: quarantined.aggregate_version,
      action: "resume",
      reason: "Explicitly authorize a new attempt",
    } as const;
    await expect(service.control(retryCommand)).rejects.toThrow(
      "ambiguous_usage_reconciliation_required",
    );
    const retried = await service.control({
      ...retryCommand,
      command_id: "command-retry-ambiguous-with-disposition",
      idempotency_key: "retry-ambiguous-with-disposition",
      ambiguity_disposition: "assume_full_charge",
    });
    expect(retried.status).toBe("queued");
    expect(retried.reserved_usd).toBe(0.01);
    expect(retried.settled_usd).toBe(0.01);
    expect(retried.retained_ambiguous_usd).toBe(0);
    const callsBeforeAmbiguousRetry = adapter.requests.length;
    expect(await worker.tick()).toBe("failed");
    expect(adapter.requests).toHaveLength(callsBeforeAmbiguousRetry + 1);
    expect(await worker.tick()).toBe("idle");
    expect(adapter.requests).toHaveLength(callsBeforeAmbiguousRetry + 1);
    const retryQuarantined = await service.getRun("project-debate", debate.id, ambiguous.id);
    expect(retryQuarantined.status).toBe("paused");
    expect(retryQuarantined.retained_ambiguous_usd).toBe(0.01);
  });
});
