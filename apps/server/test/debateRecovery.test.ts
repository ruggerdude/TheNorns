import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  AdapterError,
  type CompletionRequest,
  type CompletionResult,
  type LlmAdapter,
  type ProviderName,
  type StructuredResult,
} from "@norns/adapters";
import type {
  UsageEventT,
  V2DebateActorExecutionSnapshotT,
  V2DebateActorT,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { type DebateRunDto, DebateService } from "../src/debates/service.js";
import { DebateWorker } from "../src/debates/worker.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const NOW = "2026-07-18T15:00:00.000Z";
const PROJECT_ID = "project-debate-recovery";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

interface AdapterReply {
  value: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

interface CapturedRequest {
  request: CompletionRequest;
  schemaName: string;
}

class ControlledAdapter implements LlmAdapter {
  readonly provider: ProviderName = "openai";
  readonly model = "mock-openai";
  readonly requests: CapturedRequest[] = [];
  private readonly replies: Array<Promise<AdapterReply>> = [];

  enqueue(...values: unknown[]): void {
    for (const value of values) {
      this.replies.push(Promise.resolve({ value, inputTokens: 100, outputTokens: 50 }));
    }
  }

  enqueueWithUsage(value: unknown, inputTokens: number, outputTokens: number): void {
    this.replies.push(Promise.resolve({ value, inputTokens, outputTokens }));
  }

  enqueueDeferred(reply: Deferred<AdapterReply>): void {
    this.replies.push(reply.promise);
  }

  enqueueError(error: unknown): void {
    this.replies.push(Promise.reject(error));
  }

  async complete(_request: CompletionRequest): Promise<CompletionResult> {
    throw new Error("debate worker must use structured completion");
  }

  async completeStructured<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<StructuredResult<T>> {
    this.requests.push({ request, schemaName });
    const next = this.replies.shift();
    if (!next) throw new Error("controlled adapter response queue is empty");
    const reply = await next;
    return {
      value: schema.parse(reply.value),
      usage: usageFor(request, reply.inputTokens ?? 100, reply.outputTokens ?? 50),
      provider_execution_id: `provider-execution-${this.requests.length}`,
      finish_reason: "stop",
    };
  }
}

function usageFor(
  request: CompletionRequest,
  inputTokens: number,
  outputTokens: number,
): UsageEventT {
  return {
    id: `usage-${request.debateTurnAttemptId ?? "unknown"}`,
    provider: "openai",
    model: "mock-openai",
    project_id: request.projectId,
    node_id: null,
    run_id: request.debateRunId ?? null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    usage_source: "provider_api",
    pricing_version: "adapter-value-that-must-not-settle-the-run",
    occurred_at: NOW,
  };
}

function proposal(
  content: string,
  findings: Array<{
    key: string;
    severity: "must_fix" | "should_fix" | "suggestion";
    finding: string;
    recommendation: string;
  }> = [],
) {
  return {
    content,
    summary: content,
    claims: [content],
    findings,
    consensus_reported: false,
    material_change: true,
    unresolved_disagreements: [],
  };
}

function revision(content: string, findingKey: string) {
  return {
    ...proposal(content),
    finding_dispositions: [
      {
        key: findingKey,
        disposition: "accepted" as const,
        rationale: "The repeated issue is addressed once.",
      },
    ],
  };
}

async function eventually(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe.sequential("debate worker recovery invariants", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let service: DebateService;
  let adapter: ControlledAdapter;
  let commandSequence: number;
  let snapshotPricing: {
    inputPerMtokUsd: number;
    outputPerMtokUsd: number;
    version: string;
    maxChargeUsd: number;
  };

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        '${PROJECT_ID}', 'Debate recovery project', 'active',
        'assignment/default', 'verification/default', 'budget/default'
      );
    `);
    commandSequence = 0;
    snapshotPricing = {
      inputPerMtokUsd: 2,
      outputPerMtokUsd: 4,
      version: "frozen-pricing-v1",
      maxChargeUsd: 0.5,
    };
    transactions = new PGliteTransactionRunner(pg);
    service = new DebateService(transactions, {
      now: () => new Date(NOW),
      actorExecutionSnapshot: (actor) => executionSnapshot(actor, snapshotPricing),
    });
    adapter = new ControlledAdapter();
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  it("honors stop-after-turn issued while the provider call is in flight", async () => {
    const { debate, run } = await createAndStart({ exactRounds: 3 });
    const inFlight = deferred<AdapterReply>();
    adapter.enqueueDeferred(inFlight);
    const worker = workerWith(adapter);

    const tick = worker.tick();
    await eventually(() => expect(adapter.requests).toHaveLength(1));
    const current = await service.getRun(PROJECT_ID, debate.id, run.id);
    await control(debate.id, current, "stop_after_turn", "Stop after the current provider call");

    inFlight.resolve({
      value: proposal("One turn is enough."),
      inputTokens: 120,
      outputTokens: 30,
    });
    await expect(tick).resolves.toBe("completed");

    const stopped = await service.getRun(PROJECT_ID, debate.id, run.id);
    expect(stopped.status).toBe("completed");
    expect(stopped.stop_reason).toBe("requested_stop");
    expect(stopped.messages).toHaveLength(1);
    expect(stopped.reserved_usd).toBe(0);
    expect(stopped.retained_ambiguous_usd).toBe(0);
    expect(
      await scalar(
        "SELECT COUNT(*) FROM debate_jobs WHERE debate_run_id = $1 AND state = 'queued'",
        run.id,
      ),
    ).toBe(0);
    expect(await scalar("SELECT COUNT(*) FROM debate_turns WHERE debate_run_id = $1", run.id)).toBe(
      1,
    );
    expect(
      await textValue("SELECT state FROM debate_rounds WHERE debate_run_id = $1", run.id),
    ).toBe("completed");
  });

  it.each([
    ["rate-limit", new AdapterError("rate_limit", "provider asks us to retry")],
    ["ambiguous-network", new AdapterError("network", "socket closed after request write")],
  ])(
    "finishes an in-flight cancellation after a %s failure without active or retained funds",
    async (_label, providerError) => {
      const { debate, run } = await createAndStart({ exactRounds: 2 });
      const inFlight = deferred<AdapterReply>();
      adapter.enqueueDeferred(inFlight);
      const worker = workerWith(adapter);

      const tick = worker.tick();
      await eventually(() => expect(adapter.requests).toHaveLength(1));
      const running = await service.getRun(PROJECT_ID, debate.id, run.id);
      const cancelling = await control(debate.id, running, "cancel", "Cancel in-flight work");
      expect(cancelling.status).toBe("cancelling");

      inFlight.reject(providerError);
      await expect(tick).resolves.toBe("failed");

      const cancelled = await service.getRun(PROJECT_ID, debate.id, run.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.reserved_usd).toBe(0);
      expect(cancelled.retained_ambiguous_usd).toBe(0);
      expect(
        await scalar(
          "SELECT COUNT(*) FROM debate_reservations WHERE debate_run_id = $1 AND status IN ('active','retained_ambiguous')",
          run.id,
        ),
      ).toBe(0);
      expect(
        await textValue("SELECT state FROM debate_rounds WHERE debate_run_id = $1", run.id),
      ).toBe("cancelled");
      expect(
        await textValue("SELECT state FROM debate_turns WHERE debate_run_id = $1", run.id),
      ).toBe("cancelled");
      expect(
        await textValue("SELECT state FROM debate_jobs WHERE debate_run_id = $1", run.id),
      ).toBe("cancelled");
    },
  );

  it("releases the reservation and pauses on an adapter-factory failure before dispatch", async () => {
    const { debate, run } = await createAndStart({ exactRounds: 1 });
    const worker = new DebateWorker(
      transactions,
      () => {
        throw new Error("provider credential unavailable before dispatch");
      },
      { now: () => new Date(NOW) },
    );

    await expect(worker.tick()).resolves.toBe("failed");

    const paused = await service.getRun(PROJECT_ID, debate.id, run.id);
    expect(paused.status).toBe("paused");
    expect(paused.reserved_usd).toBe(0);
    expect(paused.retained_ambiguous_usd).toBe(0);
    expect(
      await textValue("SELECT status FROM debate_reservations WHERE debate_run_id = $1", run.id),
    ).toBe("released");
    expect(
      await textValue(
        "SELECT resolution_outcome FROM debate_reservations WHERE debate_run_id = $1",
        run.id,
      ),
    ).toBe("provider_rejected");
    const eventTypes = await eventTypesFor(run.id);
    expect(eventTypes).not.toContain("debate_turn_dispatched");
    expect(eventTypes).toContain("debate_turn_paused_after_failure");
  });

  it("places targeted human direction only in the intended next-turn or next-round transport prompt", async () => {
    const { debate, run, actorIds } = await createAndStart({ exactRounds: 2 });
    const [designerId, criticId] = actorIds;
    expect(designerId).toBeTruthy();
    expect(criticId).toBeTruthy();

    await intervene(debate.id, run, {
      targetActorId: criticId as string,
      applyAt: "next_turn",
      text: "TURN_ONLY_DIRECTION",
    });
    const afterFirstDirection = await service.getRun(PROJECT_ID, debate.id, run.id);
    await intervene(debate.id, afterFirstDirection, {
      targetActorId: designerId as string,
      applyAt: "next_round",
      text: "ROUND_ONLY_DIRECTION",
    });

    adapter.enqueue(
      proposal("Designer round one"),
      proposal("Critic round one"),
      proposal("Designer round two"),
      proposal("Critic round two"),
    );
    const worker = workerWith(adapter);
    for (let turn = 0; turn < 4; turn += 1) {
      const outcome = await worker.tick();
      const failureDetail =
        outcome === "failed"
          ? await textValue(
              "SELECT COALESCE(failure_detail, '') FROM debate_turn_attempts WHERE debate_run_id = $1 ORDER BY created_at DESC LIMIT 1",
              run.id,
            )
          : "";
      expect(outcome, `turn ${turn + 1}: ${failureDetail}`).toBe("completed");
    }

    expect(adapter.requests).toHaveLength(4);
    const prompts = adapter.requests.map(({ request }) => request.prompt);
    expect(prompts[0]).not.toContain("TURN_ONLY_DIRECTION");
    expect(prompts[0]).not.toContain("ROUND_ONLY_DIRECTION");
    expect(prompts[1]).toContain("TURN_ONLY_DIRECTION");
    expect(prompts[1]).not.toContain("ROUND_ONLY_DIRECTION");
    expect(prompts[2]).not.toContain("TURN_ONLY_DIRECTION");
    expect(prompts[2]).toContain("ROUND_ONLY_DIRECTION");
    expect(prompts[3]).not.toContain("TURN_ONLY_DIRECTION");
    expect(prompts[3]).not.toContain("ROUND_ONLY_DIRECTION");
  });

  it("hashes the exact system plus transport prompt, including the appended JSON Schema", async () => {
    const { run } = await createAndStart({ exactRounds: 2 });
    adapter.enqueue(proposal("Prompt provenance"));
    const worker = workerWith(adapter);

    await expect(worker.tick()).resolves.toBe("completed");

    const captured = adapter.requests[0];
    expect(captured).toBeDefined();
    expect(captured?.request.prompt).toContain("JSON Schema:");
    expect(captured?.request.prompt).toContain('"$schema"');
    expect(captured?.request.structuredOutputPrepared).toBe(true);
    const expectedHash = createHash("sha256")
      .update(`${captured?.request.system}\n\n${captured?.request.prompt}`)
      .digest("hex");
    expect(
      await textValue(
        "SELECT prompt_hash FROM debate_turns WHERE debate_run_id = $1 AND turn_number = 1",
        run.id,
      ),
    ).toBe(expectedHash);
    const dispatch = await pg.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM debate_events WHERE debate_run_id = $1 AND event_type = 'debate_turn_dispatched'",
      [run.id],
    );
    expect(dispatch.rows[0]?.payload.prompt_hash).toBe(expectedHash);
    expect(dispatch.rows[0]?.payload.prompt_protocol).toBe(captured?.schemaName);
  });

  it("settles usage against the immutable run pricing snapshot", async () => {
    snapshotPricing = {
      inputPerMtokUsd: 2,
      outputPerMtokUsd: 4,
      version: "run-frozen-v1",
      maxChargeUsd: 0.5,
    };
    const { run } = await createAndStart({ exactRounds: 2 });
    snapshotPricing = {
      inputPerMtokUsd: 200,
      outputPerMtokUsd: 400,
      version: "catalog-mutated-after-start",
      maxChargeUsd: 9,
    };
    adapter.enqueueWithUsage(proposal("Use frozen pricing"), 100, 50);
    const worker = workerWith(adapter);

    await expect(worker.tick()).resolves.toBe("completed");

    const usage = await pg.query<{
      cost_usd: string | number;
      pricing_version: string;
      input_price: string | number;
      output_price: string | number;
    }>(
      `SELECT cost_usd,
        pricing_snapshot->>'pricing_version' AS pricing_version,
        pricing_snapshot->>'input_per_mtok_usd' AS input_price,
        pricing_snapshot->>'output_per_mtok_usd' AS output_price
       FROM debate_usage_events WHERE debate_run_id = $1`,
      [run.id],
    );
    expect(Number(usage.rows[0]?.cost_usd)).toBeCloseTo(0.0004, 8);
    expect(usage.rows[0]?.pricing_version).toBe("run-frozen-v1");
    expect(Number(usage.rows[0]?.input_price)).toBe(2);
    expect(Number(usage.rows[0]?.output_price)).toBe(4);
    expect(
      Number(
        await textValue(
          "SELECT settled_usd FROM debate_reservations WHERE debate_run_id = $1",
          run.id,
        ),
      ),
    ).toBeCloseTo(0.0004, 8);
  });

  it("consolidates repeated semantic finding keys before preparing a revision", async () => {
    const { run } = await createAndStart({ exactRounds: 2 });
    const finding = {
      key: "shared-persistence-risk",
      severity: "must_fix" as const,
      finding: "Both participants found the same persistence risk.",
      recommendation: "Address the risk once in the revision.",
    };
    adapter.enqueue(
      proposal("First proposal", [finding]),
      proposal("Second proposal", [finding]),
      revision("Revised first proposal", finding.key),
    );
    const worker = workerWith(adapter);

    await expect(worker.tick()).resolves.toBe("completed");
    await expect(worker.tick()).resolves.toBe("completed");
    expect(
      await scalar(
        "SELECT COUNT(*) FROM debate_findings WHERE debate_run_id = $1 AND finding_key = 'shared-persistence-risk'",
        run.id,
      ),
    ).toBe(2);
    const thirdOutcome = await worker.tick();
    const thirdFailure =
      thirdOutcome === "failed"
        ? await textValue(
            "SELECT COALESCE(failure_detail, '') FROM debate_turn_attempts WHERE debate_run_id = $1 ORDER BY created_at DESC LIMIT 1",
            run.id,
          )
        : "";
    expect(thirdOutcome, thirdFailure).toBe("completed");

    const revisionRequest = adapter.requests[2];
    expect(revisionRequest?.schemaName).toBe("debate_participant_revision_v2");
    const operationRecord = revisionRequest?.request.prompt.split("\n\nRespond with ONLY")[0] ?? "";
    const findingKeyMatches = operationRecord.match(/shared-persistence-risk/g) ?? [];
    expect(findingKeyMatches).toHaveLength(1);
  });

  it("honors cancellation when a previously leased turn expires", async () => {
    const { debate, run } = await createAndStart({ exactRounds: 2 });
    await pg.query(
      `UPDATE debate_jobs SET state = 'leased', lease_token = 'abandoned-lease',
         leased_until = '2026-07-18T14:59:00.000Z'
       WHERE debate_run_id = $1`,
      [run.id],
    );
    await pg.query(
      `UPDATE debate_turn_attempts SET state = 'running', lease_token = 'abandoned-lease',
         leased_until = '2026-07-18T14:59:00.000Z'
       WHERE debate_run_id = $1`,
      [run.id],
    );
    await pg.query("UPDATE debate_turns SET state = 'running' WHERE debate_run_id = $1", [run.id]);

    const current = await service.getRun(PROJECT_ID, debate.id, run.id);
    const cancelling = await control(debate.id, current, "cancel", "Cancel abandoned work");
    expect(cancelling.status).toBe("cancelling");

    await expect(workerWith(adapter).tick()).resolves.toBe("idle");

    const cancelled = await service.getRun(PROJECT_ID, debate.id, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.reserved_usd).toBe(0);
    expect(cancelled.retained_ambiguous_usd).toBe(0);
    expect(
      await textValue("SELECT state FROM debate_rounds WHERE debate_run_id = $1", run.id),
    ).toBe("cancelled");
    expect(
      await textValue("SELECT status FROM debate_reservations WHERE debate_run_id = $1", run.id),
    ).toBe("settled");
    expect(
      await textValue(
        "SELECT resolution_outcome FROM debate_reservations WHERE debate_run_id = $1",
        run.id,
      ),
    ).toBe("cancelled_assumed_full_charge");
    expect(await eventTypesFor(run.id)).toContain("debate_run_cancelled_after_expired_lease");
  });

  function workerWith(controlledAdapter: ControlledAdapter): DebateWorker {
    return new DebateWorker(transactions, () => controlledAdapter, {
      now: () => new Date(NOW),
      leaseMs: 60_000,
    });
  }

  async function createAndStart(input: { exactRounds: number }): Promise<{
    debate: Awaited<ReturnType<DebateService["create"]>>;
    run: DebateRunDto;
    actorIds: string[];
  }> {
    const suffix = nextCommandSuffix();
    const commonActor = {
      actor_kind: "participant" as const,
      instructions: "Use the supplied record and respond through the structured protocol.",
      provider: "openai",
      model: "mock-openai",
      runtime: "provider_api",
      max_turns: 10,
      max_input_tokens: 10_000,
      max_output_tokens: 1_000,
      budget_limit_usd: 10,
    };
    const debate = await service.create({
      ...commandBase(`create-${suffix}`),
      kind: "create_debate",
      command_family: "debate",
      project_id: PROJECT_ID,
      expected_project_version: 1,
      phase_id: null,
      title: `Recovery debate ${suffix}`,
      question: "How should durable recovery behave?",
      stopping_policy: {
        exact_rounds: input.exactRounds,
        max_rounds: Math.max(input.exactRounds, 3),
        max_duration_seconds: 600,
        max_total_input_tokens: 100_000,
        max_total_output_tokens: 20_000,
        max_total_cost_usd: 20,
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
      ...commandBase(`start-${suffix}`),
      kind: "start_debate_run",
      command_family: "debate",
      project_id: PROJECT_ID,
      debate_id: debate.id,
      expected_debate_version: debate.revision,
    });
    return {
      debate,
      run,
      actorIds: debate.configuration.actors.map((actor) => String(actor.id)),
    };
  }

  async function control(
    debateId: string,
    run: DebateRunDto,
    action: "cancel" | "stop_after_turn",
    reason: string,
  ): Promise<DebateRunDto> {
    const suffix = nextCommandSuffix();
    return service.control({
      ...commandBase(`control-${suffix}`),
      kind: "control_debate_run",
      command_family: "debate",
      project_id: PROJECT_ID,
      debate_id: debateId,
      debate_run_id: run.id,
      expected_run_version: run.aggregate_version,
      action,
      reason,
    });
  }

  async function intervene(
    debateId: string,
    run: DebateRunDto,
    input: { targetActorId: string; applyAt: "next_turn" | "next_round"; text: string },
  ): Promise<void> {
    const suffix = nextCommandSuffix();
    await service.intervene({
      ...commandBase(`intervene-${suffix}`),
      kind: "intervene_debate_run",
      command_family: "debate",
      actor: { actor_type: "human", actor_id: "user-recovery" },
      project_id: PROJECT_ID,
      debate_id: debateId,
      debate_run_id: run.id,
      expected_run_version: run.aggregate_version,
      intervention_kind: "direction",
      target_actor_id: input.targetActorId,
      apply_at: input.applyAt,
      text: input.text,
    });
  }

  function commandBase(seed: string) {
    return {
      schema_version: 2 as const,
      command_id: `command-${seed}`,
      actor: { actor_type: "human" as const, actor_id: "user-recovery" },
      idempotency_key: `idempotency-${seed}`,
      correlation_id: `correlation-${seed}`,
      causation_id: null,
      issued_at: NOW,
    };
  }

  function nextCommandSuffix(): string {
    commandSequence += 1;
    return String(commandSequence);
  }

  async function scalar(sql: string, runId: string): Promise<number> {
    const result = await pg.query<Record<string, unknown>>(sql, [runId]);
    return Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
  }

  async function textValue(sql: string, runId: string): Promise<string> {
    const result = await pg.query<Record<string, unknown>>(sql, [runId]);
    return String(Object.values(result.rows[0] ?? {})[0] ?? "");
  }

  async function eventTypesFor(runId: string): Promise<string[]> {
    const result = await pg.query<{ event_type: string }>(
      "SELECT event_type FROM debate_events WHERE debate_run_id = $1 ORDER BY sequence",
      [runId],
    );
    return result.rows.map((row) => row.event_type);
  }
});

function executionSnapshot(
  actor: {
    id: string;
    provider: string;
    model: string;
    runtime: string;
    max_input_tokens: number;
    max_output_tokens: number;
    budget_limit_usd: number;
    max_turns: number;
  },
  pricing: {
    inputPerMtokUsd: number;
    outputPerMtokUsd: number;
    version: string;
    maxChargeUsd: number;
  },
): V2DebateActorExecutionSnapshotT {
  return {
    actor_id: actor.id,
    provider: actor.provider,
    model: actor.model,
    runtime: actor.runtime,
    max_input_tokens: actor.max_input_tokens,
    max_output_tokens: actor.max_output_tokens,
    budget_limit_usd: actor.budget_limit_usd,
    max_turns: actor.max_turns,
    pricing: {
      provider: actor.provider,
      model: actor.model,
      input_per_mtok_usd: pricing.inputPerMtokUsd,
      output_per_mtok_usd: pricing.outputPerMtokUsd,
      pricing_version: pricing.version,
      pricing_is_estimate: false,
    },
    maximum_turn_charge_usd: pricing.maxChargeUsd,
  };
}

// Compile-time sentinel: test actors deliberately exercise the same contract type
// the worker loads from its immutable run snapshot.
void ({} as V2DebateActorT);
