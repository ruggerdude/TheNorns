import { createHash } from "node:crypto";
import {
  type V2ApplicationCommandT,
  type V2ControlDebateRunCommandT,
  type V2CreateDebateCommandT,
  type V2DebateActorExecutionSnapshotT,
  V2DebateEvent,
  V2DebateEventContentHashEnvelope,
  V2DebateRunState,
  type V2DebateRunStateT,
  type V2InterveneDebateRunCommandT,
  type V2StartDebateRunCommandT,
  v2AssertDebateRunTransition,
} from "@norns/contracts";
import { newId } from "../ids.js";
import {
  type V2CommandExecutionResult,
  type V2CommandMutationResult,
  executeV2ApplicationCommand,
} from "../persistence/v2/application.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function numeric(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

class SqlDebateApplicationTransaction extends SqlV2ApplicationTransaction {
  constructor(readonly executor: V2SqlExecutor) {
    super(executor);
  }
}

const debateTransactionFactory = {
  bind: (executor: V2SqlExecutor) => new SqlDebateApplicationTransaction(executor),
};

interface DebateRow {
  id: string;
  project_id: string;
  phase_id: string | null;
  state: string;
  title: string;
  question: string;
  stopping_policy: Record<string, unknown>;
  aggregate_version: number;
  created_at: string | Date;
  archived_at: string | Date | null;
}

interface DebateActorRow {
  id: string;
  actor_kind: "participant" | "judge" | "synthesizer";
  role_label: string;
  display_name: string;
  instructions: string;
  provider: "anthropic" | "openai";
  model: string;
  runtime: "provider_api" | "codex" | "claude-code";
  position: number;
  max_turns: number;
  max_input_tokens: number;
  max_output_tokens: number;
  budget_limit_usd: string | number;
}

interface DebateRunRow {
  id: string;
  project_id: string;
  debate_id: string;
  attempt: number;
  state: string;
  lifecycle_version: number;
  event_version: number;
  cursor_round_number: number;
  cursor_turn_number: number;
  stop_after: string;
  stop_reason: string | null;
  actor_execution_snapshots: V2DebateActorExecutionSnapshotT[];
  aggregate_version: number;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface DebateEventDto {
  schema_version: 2;
  id: string;
  project_id: string;
  debate_id: string;
  debate_run_id: string;
  sequence: number;
  type: string;
  lifecycle_version: number | null;
  correlation_id: string;
  causation_id: string | null;
  round_number: number | null;
  turn_number: number | null;
  actor_snapshot: Record<string, unknown> | null;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  artifact_ids: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    latency_ms: number;
  } | null;
  occurred_at: string;
  content_hash: string;
}

export interface DebateDto {
  id: string;
  project_id: string;
  status: string;
  revision: number;
  aggregate_version: number;
  current_round: number;
  current_turn: number;
  latest_event_sequence: number;
  reserved_usd: number;
  settled_usd: number;
  retained_ambiguous_usd: number;
  stop_reason: string | null;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  active_run_id: string | null;
  run: { id: string; status: string; aggregate_version: number } | null;
  configuration: {
    title: string;
    question: string;
    actors: Array<Record<string, unknown>>;
    schedule: { kind: "round_robin"; participant_ids: string[] };
    policy: Record<string, unknown>;
  };
}

export interface DebateRunDto {
  id: string;
  debate_id: string;
  status: string;
  aggregate_version: number;
  version: number;
  current_round: number;
  current_turn: number;
  total_usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  reserved_usd: number;
  settled_usd: number;
  retained_ambiguous_usd: number;
  stop_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  judgment: Record<string, unknown> | null;
  final_output: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  revisions: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
}

export interface DebateServiceOptions {
  now?: () => Date;
  /** Returns the conservative maximum charge for one actor turn. */
  maximumTurnCharge?: (input: {
    provider: string;
    model: string;
    max_input_tokens: number;
    max_output_tokens: number;
    actor_budget_limit_usd: number;
  }) => number;
  /** Freezes model selection, token caps, pricing, and the conservative charge for a run. */
  actorExecutionSnapshot?: (input: {
    id: string;
    provider: string;
    model: string;
    runtime: string;
    max_input_tokens: number;
    max_output_tokens: number;
    budget_limit_usd: number;
    max_turns: number;
  }) => V2DebateActorExecutionSnapshotT;
}

export class DebateConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DebateConflictError";
  }
}

export class DebateService {
  private readonly now: () => Date;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly options: DebateServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async execute(
    command: V2ApplicationCommandT,
    mutate: (
      tx: SqlDebateApplicationTransaction,
      command: V2ApplicationCommandT,
    ) => Promise<V2CommandMutationResult>,
  ): Promise<unknown> {
    const result = await executeV2ApplicationCommand({
      command,
      transactionRunner: this.transactions,
      transactionFactory: debateTransactionFactory,
      mutate,
      now: this.now,
    });
    return this.unwrap(result);
  }

  private unwrap(result: V2CommandExecutionResult): unknown {
    if (result.kind === "command_in_progress") {
      throw new DebateConflictError("command_in_progress", "an identical command is in progress");
    }
    if (result.kind === "idempotency_conflict") {
      throw new DebateConflictError("idempotency_conflict", result.reason);
    }
    if (result.response.outcome === "failed") {
      const body = result.response.body as { error?: string; detail?: string } | null;
      throw new DebateConflictError(
        body?.error ?? "debate_command_failed",
        body?.detail ?? body?.error ?? "debate command failed",
      );
    }
    return result.response.body;
  }

  async list(projectId: string): Promise<DebateDto[]> {
    const ids = await this.transactions.transaction(async (tx) =>
      tx.query<{ id: string }>(
        "SELECT id FROM debates WHERE project_id = $1 ORDER BY created_at DESC",
        [projectId],
      ),
    );
    return Promise.all(ids.rows.map((row) => this.get(projectId, row.id)));
  }

  async projectVersion(projectId: string): Promise<number> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ aggregate_version: number }>(
        "SELECT aggregate_version FROM projects WHERE id = $1",
        [projectId],
      );
      const version = result.rows[0]?.aggregate_version;
      if (version === undefined) {
        throw new DebateConflictError("project_not_found", "project not found");
      }
      return version;
    });
  }

  async get(projectId: string, debateId: string): Promise<DebateDto> {
    return this.transactions.transaction(async (tx) => {
      const debate = await this.loadDebate(tx, projectId, debateId);
      const actors = await this.loadActors(tx, debateId);
      const runResult = await tx.query<DebateRunRow>(
        `SELECT * FROM debate_runs
         WHERE project_id = $1 AND debate_id = $2
         ORDER BY attempt DESC LIMIT 1`,
        [projectId, debateId],
      );
      const run = runResult.rows[0] ?? null;
      const accounting = run
        ? await this.loadAccounting(tx, run.id)
        : { reserved: 0, settled: 0, retained: 0, input: 0, output: 0, cost: 0 };
      const updatedAt = run ? iso(run.updated_at) : iso(debate.created_at);
      if (updatedAt === null) throw new Error("debate timestamp missing");
      return {
        id: debate.id,
        project_id: debate.project_id,
        status: run?.state ?? debate.state,
        revision: debate.aggregate_version,
        aggregate_version: run?.aggregate_version ?? debate.aggregate_version,
        current_round: run?.cursor_round_number ?? 0,
        current_turn: run?.cursor_turn_number ?? 0,
        latest_event_sequence: run?.event_version ?? 0,
        reserved_usd: accounting.reserved,
        settled_usd: accounting.settled,
        retained_ambiguous_usd: accounting.retained,
        stop_reason: run?.stop_reason ?? null,
        updated_at: updatedAt,
        started_at: run ? iso(run.started_at) : null,
        ended_at: run ? iso(run.finished_at) : null,
        active_run_id:
          run && !["completed", "cancelled", "failed"].includes(run.state) ? run.id : null,
        run: run
          ? { id: run.id, status: run.state, aggregate_version: run.aggregate_version }
          : null,
        configuration: {
          title: debate.title,
          question: debate.question,
          actors: actors.map((actor) => ({
            id: actor.id,
            kind: actor.actor_kind,
            display_name: actor.display_name,
            role_label: actor.role_label,
            instructions: actor.instructions,
            provider: actor.provider,
            model: actor.model,
            runtime: actor.runtime,
            enabled: true,
            position: actor.position,
            max_turns: actor.max_turns,
            max_input_tokens: actor.max_input_tokens,
            max_output_tokens: actor.max_output_tokens,
            budget_limit_usd: numeric(actor.budget_limit_usd),
          })),
          schedule: {
            kind: "round_robin",
            participant_ids: actors
              .filter((actor) => actor.actor_kind === "participant")
              .sort((left, right) => left.position - right.position)
              .map((actor) => actor.id),
          },
          policy: debate.stopping_policy,
        },
      };
    });
  }

  async create(command: V2CreateDebateCommandT): Promise<DebateDto> {
    const created = (await this.execute(command, async (tx, parsed) => {
      if (parsed.kind !== "create_debate") throw new Error("invalid debate command");
      const project = await tx.executor.query<{ aggregate_version: number }>(
        "SELECT aggregate_version FROM projects WHERE id = $1 FOR UPDATE",
        [parsed.project_id],
      );
      const actual = project.rows[0]?.aggregate_version;
      if (actual === undefined) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 404,
          body: { error: "project_not_found" },
        };
      }
      if (actual !== parsed.expected_project_version) {
        return {
          outcome: "failed",
          failure_disposition: "retriable",
          http_status: 409,
          body: {
            error: "optimistic_concurrency_conflict",
            expected: parsed.expected_project_version,
            actual,
          },
        };
      }

      const debateId = newId("debate");
      const createdAt = this.now().toISOString();
      const contentHash = sha256(
        canonical({
          title: parsed.title,
          question: parsed.question,
          phase_id: parsed.phase_id,
          stopping_policy: parsed.stopping_policy,
          actors: parsed.actors,
          contexts: parsed.contexts,
        }),
      );
      await tx.executor.query(
        `INSERT INTO debates (
           id, project_id, phase_id, state, title, question, stopping_policy,
           content_hash, created_by_actor_type, created_by_actor_id, created_at
         ) VALUES ($1,$2,$3,'ready',$4,$5,$6::jsonb,$7,$8,$9,$10)`,
        [
          debateId,
          parsed.project_id,
          parsed.phase_id,
          parsed.title,
          parsed.question,
          JSON.stringify(parsed.stopping_policy),
          contentHash,
          parsed.actor.actor_type,
          parsed.actor.actor_id,
          createdAt,
        ],
      );
      for (const actor of parsed.actors) {
        await tx.executor.query(
          `INSERT INTO debate_actors (
             id, project_id, debate_id, actor_kind, role_label, display_name,
             instructions, provider, model, runtime, position, max_turns,
             max_input_tokens, max_output_tokens, budget_limit_usd, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            newId("debate_actor"),
            parsed.project_id,
            debateId,
            actor.actor_kind,
            actor.role_label,
            actor.display_name,
            actor.instructions,
            actor.provider,
            actor.model,
            actor.runtime,
            actor.position,
            actor.max_turns,
            actor.max_input_tokens,
            actor.max_output_tokens,
            actor.budget_limit_usd,
            createdAt,
          ],
        );
      }
      for (const [ordinal, context] of parsed.contexts.entries()) {
        const contentHashForContext =
          context.artifact_content_hash ?? sha256(context.inline_content ?? "");
        await tx.executor.query(
          `INSERT INTO debate_contexts (
             id, project_id, debate_id, ordinal, label, artifact_id, inline_content,
             content_hash, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            newId("debate_context"),
            parsed.project_id,
            debateId,
            ordinal,
            context.label,
            context.artifact_id,
            context.inline_content,
            contentHashForContext,
            createdAt,
          ],
        );
      }
      return { outcome: "succeeded", http_status: 201, body: { debate_id: debateId } };
    })) as { debate_id: string };
    return this.get(command.project_id, created.debate_id);
  }

  async start(command: V2StartDebateRunCommandT): Promise<DebateRunDto> {
    const created = (await this.execute(command, async (tx, parsed) => {
      if (parsed.kind !== "start_debate_run") throw new Error("invalid debate command");
      const debate = await this.loadDebate(tx.executor, parsed.project_id, parsed.debate_id, true);
      if (debate.aggregate_version !== parsed.expected_debate_version) {
        return {
          outcome: "failed",
          failure_disposition: "retriable",
          http_status: 409,
          body: { error: "optimistic_concurrency_conflict" },
        };
      }
      if (debate.state !== "ready") {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 409,
          body: { error: "debate_not_ready" },
        };
      }
      const existing = await tx.executor.query<{ id: string }>(
        `SELECT id FROM debate_runs WHERE debate_id = $1
         AND state NOT IN ('completed','cancelled','failed')`,
        [parsed.debate_id],
      );
      if (existing.rows.length > 0) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 409,
          body: { error: "debate_run_already_active", run_id: existing.rows[0]?.id },
        };
      }
      const allActors = await this.loadActors(tx.executor, parsed.debate_id);
      const actors = allActors.filter((actor) => actor.actor_kind === "participant");
      if (actors.length < 2) throw new Error("ready debate has fewer than two participants");
      const attemptResult = await tx.executor.query<{ attempt: number }>(
        "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM debate_runs WHERE debate_id = $1",
        [parsed.debate_id],
      );
      const attempt = Number(attemptResult.rows[0]?.attempt ?? 1);
      const runId = newId("debate_run");
      const roundId = newId("debate_round");
      const turnId = newId("debate_turn");
      const turnAttemptId = newId("debate_attempt");
      const now = this.now();
      const createdAt = now.toISOString();
      const firstActor = actors.sort((left, right) => left.position - right.position)[0];
      if (!firstActor) throw new Error("debate participant missing");
      const actorExecutionSnapshots = allActors.map((actor) => {
        const input = {
          id: actor.id,
          provider: actor.provider,
          model: actor.model,
          runtime: actor.runtime,
          max_input_tokens: actor.max_input_tokens,
          max_output_tokens: actor.max_output_tokens,
          budget_limit_usd: numeric(actor.budget_limit_usd),
          max_turns: actor.max_turns,
        };
        return (
          this.options.actorExecutionSnapshot?.(input) ?? {
            actor_id: actor.id,
            provider: actor.provider,
            model: actor.model,
            runtime: actor.runtime,
            max_input_tokens: actor.max_input_tokens,
            max_output_tokens: actor.max_output_tokens,
            budget_limit_usd: numeric(actor.budget_limit_usd),
            max_turns: actor.max_turns,
            pricing: {
              provider: actor.provider,
              model: actor.model,
              input_per_mtok_usd: 0,
              output_per_mtok_usd: 0,
              pricing_version: "injected-maximum-turn-charge",
              pricing_is_estimate: true,
            },
            maximum_turn_charge_usd:
              this.options.maximumTurnCharge?.({
                provider: actor.provider,
                model: actor.model,
                max_input_tokens: actor.max_input_tokens,
                max_output_tokens: actor.max_output_tokens,
                actor_budget_limit_usd: numeric(actor.budget_limit_usd),
              }) ?? numeric(actor.budget_limit_usd),
          }
        );
      });
      const invalidSnapshot = actorExecutionSnapshots.find(
        (snapshot) => snapshot.maximum_turn_charge_usd > snapshot.budget_limit_usd,
      );
      if (invalidSnapshot) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 422,
          body: {
            error: "actor_budget_below_maximum_turn_charge",
            actor_id: invalidSnapshot.actor_id,
            required_usd: invalidSnapshot.maximum_turn_charge_usd,
          },
        };
      }
      const firstSnapshot = actorExecutionSnapshots.find(
        (snapshot) => snapshot.actor_id === firstActor.id,
      );
      if (!firstSnapshot) throw new Error("first actor execution snapshot missing");
      const maximumCharge = firstSnapshot.maximum_turn_charge_usd;
      if (
        maximumCharge > Number(debate.stopping_policy.max_total_cost_usd) ||
        firstActor.max_input_tokens > Number(debate.stopping_policy.max_total_input_tokens) ||
        firstActor.max_output_tokens > Number(debate.stopping_policy.max_total_output_tokens)
      ) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 422,
          body: { error: "debate_budget_cannot_cover_first_turn" },
        };
      }
      const promptHash = sha256(
        canonical({
          debate_id: parsed.debate_id,
          run_id: runId,
          round: 1,
          actor_id: firstActor.id,
        }),
      );
      v2AssertDebateRunTransition("created", "queued");
      await tx.executor.query(
        `INSERT INTO debate_runs (
           id, project_id, debate_id, attempt, state, lifecycle_version, event_version,
           cursor_round_number, cursor_turn_number, actor_execution_snapshots,
           aggregate_version, started_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'queued',1,1,1,1,$5::jsonb,1,$6,$6,$6)`,
        [
          runId,
          parsed.project_id,
          parsed.debate_id,
          attempt,
          JSON.stringify(actorExecutionSnapshots),
          createdAt,
        ],
      );
      await tx.executor.query(
        `INSERT INTO debate_rounds (
           id, project_id, debate_id, debate_run_id, round_number, state, started_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,1,'active',$5,$5,$5)`,
        [roundId, parsed.project_id, parsed.debate_id, runId, createdAt],
      );
      await tx.executor.query(
        `INSERT INTO debate_turns (
           id, project_id, debate_id, debate_run_id, round_id, turn_number,
           actor_id, state, designated_attempt_id, prompt_hash, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,1,$6,'queued',NULL,$7,$8,$8)`,
        [
          turnId,
          parsed.project_id,
          parsed.debate_id,
          runId,
          roundId,
          firstActor.id,
          promptHash,
          createdAt,
        ],
      );
      await tx.executor.query(
        `INSERT INTO debate_turn_attempts (
           id, project_id, debate_id, debate_run_id, turn_id, attempt_number,
           state, is_designated, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,1,'queued',true,$6,$6)`,
        [turnAttemptId, parsed.project_id, parsed.debate_id, runId, turnId, createdAt],
      );
      await tx.executor.query("UPDATE debate_turns SET designated_attempt_id = $2 WHERE id = $1", [
        turnId,
        turnAttemptId,
      ]);
      await tx.executor.query(
        `INSERT INTO debate_reservations (
           id, project_id, debate_id, debate_run_id, turn_attempt_id, amount_usd,
           status, version, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$8)`,
        [
          newId("debate_reservation"),
          parsed.project_id,
          parsed.debate_id,
          runId,
          turnAttemptId,
          maximumCharge,
          new Date(now.getTime() + 30 * 60_000).toISOString(),
          createdAt,
        ],
      );
      await tx.executor.query(
        `INSERT INTO debate_jobs (
           id, project_id, debate_id, debate_run_id, turn_attempt_id, job_kind,
           state, is_designated, delivery_attempt, idempotency_key, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'execute_turn','queued',true,1,$6,$7,$7)`,
        [
          newId("debate_job"),
          parsed.project_id,
          parsed.debate_id,
          runId,
          turnAttemptId,
          `debate-turn:${turnAttemptId}`,
          createdAt,
        ],
      );
      await this.appendEvent(tx.executor, {
        projectId: parsed.project_id,
        debateId: parsed.debate_id,
        runId,
        sequence: 1,
        eventType: "debate_run_queued",
        lifecycleVersion: 1,
        actorType: parsed.actor.actor_type,
        actorId: parsed.actor.actor_id,
        correlationId: parsed.correlation_id,
        causationId: parsed.causation_id,
        payload: { round_number: 1, turn_number: 1, actor_id: firstActor.id },
        occurredAt: createdAt,
      });
      return { outcome: "succeeded", http_status: 201, body: { run_id: runId } };
    })) as { run_id: string };
    return this.getRun(command.project_id, command.debate_id, created.run_id);
  }

  async control(command: V2ControlDebateRunCommandT): Promise<DebateRunDto> {
    await this.execute(command, async (tx, parsed) => {
      if (parsed.kind !== "control_debate_run") throw new Error("invalid debate command");
      const found = await tx.executor.query<DebateRunRow>(
        "SELECT * FROM debate_runs WHERE id = $1 AND debate_id = $2 AND project_id = $3 FOR UPDATE",
        [parsed.debate_run_id, parsed.debate_id, parsed.project_id],
      );
      const run = found.rows[0];
      if (!run) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 404,
          body: { error: "debate_run_not_found" },
        };
      }
      if (run.aggregate_version !== parsed.expected_run_version) {
        return {
          outcome: "failed",
          failure_disposition: "retriable",
          http_status: 409,
          body: { error: "optimistic_concurrency_conflict" },
        };
      }
      if (["completed", "cancelled", "failed"].includes(run.state)) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 409,
          body: { error: "debate_run_terminal" },
        };
      }
      if (parsed.action === "resume" && run.state !== "paused") {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 409,
          body: { error: "debate_run_not_paused" },
        };
      }
      if (parsed.action === "pause" && run.state === "finalizing") {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 409,
          body: { error: "debate_run_is_finalizing" },
        };
      }

      if (parsed.action === "resume") {
        const retainedResult = await tx.executor.query<{ retained: string | number }>(
          `SELECT COALESCE(SUM(retained_usd), 0) AS retained
           FROM debate_reservations
           WHERE debate_run_id = $1 AND status = 'retained_ambiguous'`,
          [run.id],
        );
        const retained = numeric(retainedResult.rows[0]?.retained);
        if (retained > 0 && parsed.ambiguity_disposition !== "assume_full_charge") {
          return {
            outcome: "failed",
            failure_disposition: "terminal",
            http_status: 409,
            body: {
              error: "ambiguous_usage_reconciliation_required",
              retained_ambiguous_usd: retained,
            },
          };
        }
        if (retained > 0) {
          await tx.executor.query(
            `UPDATE debate_reservations
             SET status = 'settled', settled_usd = amount_usd, retained_usd = 0,
               resolution_outcome = 'human_assumed_full_charge', version = version + 1,
               updated_at = $2
             WHERE debate_run_id = $1 AND status = 'retained_ambiguous'`,
            [run.id, this.now().toISOString()],
          );
        }
        const queued = await tx.executor.query<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM debate_jobs
           WHERE debate_run_id = $1 AND state = 'queued'`,
          [run.id],
        );
        if (numeric(queued.rows[0]?.count) === 0) {
          const retryTarget = await tx.executor.query<
            DebateActorRow & {
              turn_id: string;
              old_attempt_id: string;
              next_attempt_number: number | string;
            }
          >(
            `SELECT a.*, t.id AS turn_id, t.designated_attempt_id AS old_attempt_id,
              COALESCE(MAX(ta.attempt_number), 0) + 1 AS next_attempt_number
             FROM debate_turns t
             JOIN debate_actors a ON a.id = t.actor_id
             JOIN debate_turn_attempts ta ON ta.turn_id = t.id
             WHERE t.debate_run_id = $1 AND t.state IN ('failed','expired')
             GROUP BY a.id, t.id, t.designated_attempt_id, t.turn_number
             ORDER BY t.turn_number DESC LIMIT 1`,
            [run.id],
          );
          const target = retryTarget.rows[0];
          if (!target) {
            return {
              outcome: "failed",
              failure_disposition: "terminal",
              http_status: 409,
              body: { error: "debate_run_has_no_resumable_turn" },
            };
          }
          const executionSnapshot = run.actor_execution_snapshots.find(
            (snapshot) => snapshot.actor_id === target.id,
          );
          if (!executionSnapshot) throw new Error("run actor execution snapshot is missing");
          const maximumCharge = executionSnapshot.maximum_turn_charge_usd;
          if (maximumCharge > numeric(target.budget_limit_usd)) {
            return {
              outcome: "failed",
              failure_disposition: "terminal",
              http_status: 422,
              body: { error: "actor_budget_below_maximum_turn_charge", actor_id: target.id },
            };
          }
          const budget = await tx.executor.query<{
            stopping_policy: Record<string, unknown>;
            run_committed: string | number;
            actor_committed: string | number;
          }>(
            `SELECT d.stopping_policy,
               COALESCE((SELECT SUM(settled_usd + retained_usd +
                 CASE WHEN status = 'active' THEN amount_usd ELSE 0 END)
                 FROM debate_reservations WHERE debate_run_id = r.id), 0) AS run_committed,
               COALESCE((SELECT SUM(res.settled_usd + res.retained_usd +
                 CASE WHEN res.status = 'active' THEN res.amount_usd ELSE 0 END)
                 FROM debate_reservations res
                 JOIN debate_turn_attempts ta ON ta.id = res.turn_attempt_id
                 JOIN debate_turns turn_row ON turn_row.id = ta.turn_id
                 WHERE res.debate_run_id = r.id AND turn_row.actor_id = $2), 0) AS actor_committed
             FROM debate_runs r JOIN debates d ON d.id = r.debate_id
             WHERE r.id = $1`,
            [run.id, target.id],
          );
          const budgetRow = budget.rows[0];
          const maxRunCost = Number(budgetRow?.stopping_policy.max_total_cost_usd ?? 0);
          if (
            numeric(budgetRow?.run_committed) + maximumCharge > maxRunCost ||
            numeric(budgetRow?.actor_committed) + maximumCharge > numeric(target.budget_limit_usd)
          ) {
            return {
              outcome: "failed",
              failure_disposition: "terminal",
              http_status: 422,
              body: { error: "debate_budget_exhausted_after_ambiguity_reconciliation" },
            };
          }
          const retryAttemptId = newId("debate_attempt");
          const retryAt = this.now().toISOString();
          await tx.executor.query(
            "UPDATE debate_turn_attempts SET is_designated = false WHERE id = $1",
            [target.old_attempt_id],
          );
          await tx.executor.query(
            `INSERT INTO debate_turn_attempts (
               id, project_id, debate_id, debate_run_id, turn_id, attempt_number,
               state, is_designated, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,'queued',true,$7,$7)`,
            [
              retryAttemptId,
              parsed.project_id,
              parsed.debate_id,
              run.id,
              target.turn_id,
              Number(target.next_attempt_number),
              retryAt,
            ],
          );
          await tx.executor.query(
            `UPDATE debate_turns SET designated_attempt_id = $2, state = 'queued',
              output_message_id = NULL, completed_at = NULL, updated_at = $3 WHERE id = $1`,
            [target.turn_id, retryAttemptId, retryAt],
          );
          await tx.executor.query(
            `INSERT INTO debate_reservations (
               id, project_id, debate_id, debate_run_id, turn_attempt_id, amount_usd,
               status, version, expires_at, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7,$8,$8)`,
            [
              newId("debate_reservation"),
              parsed.project_id,
              parsed.debate_id,
              run.id,
              retryAttemptId,
              maximumCharge,
              new Date(Date.parse(retryAt) + 30 * 60_000).toISOString(),
              retryAt,
            ],
          );
          await tx.executor.query(
            `INSERT INTO debate_jobs (
               id, project_id, debate_id, debate_run_id, turn_attempt_id, job_kind,
               state, is_designated, delivery_attempt, idempotency_key, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,'execute_turn','queued',true,1,$6,$7,$7)`,
            [
              newId("debate_job"),
              parsed.project_id,
              parsed.debate_id,
              run.id,
              retryAttemptId,
              `debate-turn:${retryAttemptId}`,
              retryAt,
            ],
          );
        }
      }

      const currentState = V2DebateRunState.parse(run.state);
      let nextState: V2DebateRunStateT = currentState;
      let stopAfter = run.stop_after;
      let stopReason = run.stop_reason;
      let finishedAt: string | null = null;
      if (parsed.action === "pause") nextState = currentState === "running" ? "pausing" : "paused";
      if (parsed.action === "resume") nextState = "queued";
      if (parsed.action === "cancel") {
        const inFlight = await tx.executor.query<{ count: string | number }>(
          `SELECT COUNT(*) AS count FROM debate_jobs
           WHERE debate_run_id = $1 AND state = 'leased'`,
          [run.id],
        );
        nextState = numeric(inFlight.rows[0]?.count) > 0 ? "cancelling" : "cancelled";
        stopReason = parsed.reason;
        if (nextState === "cancelled") finishedAt = this.now().toISOString();
        await tx.executor.query(
          `UPDATE debate_reservations SET status = 'settled',
            resolution_outcome = 'cancelled_assumed_full_charge', settled_usd = amount_usd,
            retained_usd = 0, version = version + 1, updated_at = $2
           WHERE debate_run_id = $1 AND status = 'retained_ambiguous'`,
          [run.id, this.now().toISOString()],
        );
      }
      if (parsed.action === "stop_after_turn") stopAfter = "turn";
      if (parsed.action === "stop_after_round") stopAfter = "round";
      const updatedAt = this.now().toISOString();
      v2AssertDebateRunTransition(currentState, nextState);
      await tx.executor.query(
        `UPDATE debate_runs SET state = $2, stop_after = $3, stop_reason = $4,
          lifecycle_version = lifecycle_version + CASE WHEN state <> $2 THEN 1 ELSE 0 END,
          aggregate_version = aggregate_version + 1, finished_at = $5, updated_at = $6 WHERE id = $1`,
        [run.id, nextState, stopAfter, stopReason, finishedAt, updatedAt],
      );
      if (nextState === "cancelled") {
        await tx.executor.query(
          "UPDATE debate_jobs SET state = 'cancelled', updated_at = $2 WHERE debate_run_id = $1 AND state = 'queued'",
          [run.id, updatedAt],
        );
        await tx.executor.query(
          "UPDATE debate_turn_attempts SET state = 'cancelled', finished_at = $2, updated_at = $2 WHERE debate_run_id = $1 AND state IN ('pending','queued','leased')",
          [run.id, updatedAt],
        );
        await tx.executor.query(
          "UPDATE debate_turns SET state = 'cancelled', completed_at = $2, updated_at = $2 WHERE debate_run_id = $1 AND state IN ('pending','queued','leased')",
          [run.id, updatedAt],
        );
        await tx.executor.query(
          "UPDATE debate_rounds SET state = 'cancelled', finished_at = $2, updated_at = $2 WHERE debate_run_id = $1 AND state IN ('pending','active')",
          [run.id, updatedAt],
        );
        await tx.executor.query(
          `UPDATE debate_reservations SET status = 'released', resolution_outcome = 'cancelled',
            released_usd = amount_usd, version = version + 1, updated_at = $2
           WHERE debate_run_id = $1 AND status = 'active'`,
          [run.id, updatedAt],
        );
      }
      const sequence = run.event_version + 1;
      await this.appendEvent(tx.executor, {
        projectId: parsed.project_id,
        debateId: parsed.debate_id,
        runId: parsed.debate_run_id,
        sequence,
        eventType: `debate_run_${parsed.action}`,
        lifecycleVersion: nextState === currentState ? null : run.lifecycle_version + 1,
        actorType: parsed.actor.actor_type,
        actorId: parsed.actor.actor_id,
        correlationId: parsed.correlation_id,
        causationId: parsed.causation_id,
        payload: {
          action: parsed.action,
          reason: parsed.reason,
          ambiguity_disposition: parsed.ambiguity_disposition,
        },
        occurredAt: updatedAt,
      });
      await tx.executor.query("UPDATE debate_runs SET event_version = $2 WHERE id = $1", [
        run.id,
        sequence,
      ]);
      return { outcome: "succeeded", http_status: 200, body: { run_id: run.id } };
    });
    return this.getRun(command.project_id, command.debate_id, command.debate_run_id);
  }

  async intervene(command: V2InterveneDebateRunCommandT): Promise<{ accepted: true }> {
    await this.execute(command, async (tx, parsed) => {
      if (parsed.kind !== "intervene_debate_run") throw new Error("invalid debate command");
      const found = await tx.executor.query<DebateRunRow>(
        "SELECT * FROM debate_runs WHERE id = $1 AND debate_id = $2 AND project_id = $3 FOR UPDATE",
        [parsed.debate_run_id, parsed.debate_id, parsed.project_id],
      );
      const run = found.rows[0];
      if (!run)
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 404,
          body: { error: "debate_run_not_found" },
        };
      if (run.aggregate_version !== parsed.expected_run_version) {
        return {
          outcome: "failed",
          failure_disposition: "retriable",
          http_status: 409,
          body: { error: "optimistic_concurrency_conflict" },
        };
      }
      if (["completed", "cancelled", "failed"].includes(run.state)) {
        return {
          outcome: "failed",
          failure_disposition: "terminal",
          http_status: 409,
          body: { error: "debate_run_terminal" },
        };
      }
      if (parsed.target_actor_id !== null) {
        const target = await tx.executor.query<{ id: string }>(
          "SELECT id FROM debate_actors WHERE debate_id = $1 AND id = $2",
          [parsed.debate_id, parsed.target_actor_id],
        );
        if (!target.rows[0]) {
          return {
            outcome: "failed",
            failure_disposition: "terminal",
            http_status: 422,
            body: { error: "debate_intervention_target_not_found" },
          };
        }
      }
      const createdAt = this.now().toISOString();
      const messageSequenceResult = await tx.executor.query<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM debate_messages WHERE debate_run_id = $1",
        [run.id],
      );
      const messageSequence = Number(messageSequenceResult.rows[0]?.sequence ?? 1);
      const messageId = newId("debate_message");
      await tx.executor.query(
        `INSERT INTO debate_messages (
           id, project_id, debate_id, debate_run_id, sequence, message_kind,
           actor_snapshot, content, content_hash, intervention_kind,
           intervention_target_actor_id, intervention_apply_at,
           intervention_applies_after_round, intervention_applies_after_turn, created_at
         ) VALUES ($1,$2,$3,$4,$5,'human',NULL,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          messageId,
          parsed.project_id,
          parsed.debate_id,
          parsed.debate_run_id,
          messageSequence,
          parsed.text,
          sha256(parsed.text),
          parsed.intervention_kind,
          parsed.target_actor_id,
          parsed.apply_at,
          run.cursor_round_number,
          run.cursor_turn_number,
          createdAt,
        ],
      );
      const eventSequence = run.event_version + 1;
      await this.appendEvent(tx.executor, {
        projectId: parsed.project_id,
        debateId: parsed.debate_id,
        runId: parsed.debate_run_id,
        sequence: eventSequence,
        eventType: "human_intervention_recorded",
        lifecycleVersion: null,
        actorType: parsed.actor.actor_type,
        actorId: parsed.actor.actor_id,
        correlationId: parsed.correlation_id,
        causationId: parsed.causation_id,
        payload: {
          message_id: messageId,
          intervention_kind: parsed.intervention_kind,
          target_actor_id: parsed.target_actor_id,
          apply_at: parsed.apply_at,
          text: parsed.text,
        },
        occurredAt: createdAt,
      });
      await tx.executor.query(
        "UPDATE debate_runs SET event_version = $2, aggregate_version = aggregate_version + 1, updated_at = $3 WHERE id = $1",
        [run.id, eventSequence, createdAt],
      );
      return { outcome: "succeeded", http_status: 202, body: { accepted: true } };
    });
    return { accepted: true };
  }

  async getRun(projectId: string, debateId: string, runId: string): Promise<DebateRunDto> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<DebateRunRow>(
        "SELECT * FROM debate_runs WHERE id = $1 AND debate_id = $2 AND project_id = $3",
        [runId, debateId, projectId],
      );
      const run = result.rows[0];
      if (!run) throw new DebateConflictError("debate_run_not_found", "debate run not found");
      const accounting = await this.loadAccounting(tx, run.id);
      const judgmentResult = await tx.query<Record<string, unknown>>(
        "SELECT conclusion AS summary, rationale, evidence FROM debate_judgments WHERE debate_run_id = $1 ORDER BY created_at DESC LIMIT 1",
        [run.id],
      );
      const outputResult = await tx.query<Record<string, unknown>>(
        `SELECT f.content, f.id AS artifact_id, m.structured_output
         FROM debate_final_outputs f
         LEFT JOIN debate_revisions r ON r.id = f.revision_id
         LEFT JOIN debate_messages m ON m.id = r.payload->>'message_id'
         WHERE f.debate_run_id = $1 ORDER BY f.created_at DESC LIMIT 1`,
        [run.id],
      );
      const messages = await tx.query<Record<string, unknown>>(
        `SELECT id, sequence, message_kind, actor_snapshot, supersedes_message_id,
          content, content_hash, structured_output, structured_output_hash, created_at
         FROM debate_messages WHERE debate_run_id = $1 ORDER BY sequence`,
        [run.id],
      );
      const revisions = await tx.query<Record<string, unknown>>(
        `SELECT id, revision_number, revision_kind, supersedes_revision_id, rationale,
          payload, created_by_actor_type, created_by_actor_id, created_at
         FROM debate_revisions WHERE debate_run_id = $1 ORDER BY revision_number`,
        [run.id],
      );
      const findings = await tx.query<Record<string, unknown>>(
        `SELECT f.id, f.finding_key AS key, f.severity, f.finding, f.recommendation,
          COALESCE((SELECT r.payload->>'disposition' FROM debate_revisions r
            WHERE r.debate_run_id = f.debate_run_id
              AND r.revision_kind = 'finding_disposition'
              AND r.payload->>'finding_id' = f.id
            ORDER BY r.revision_number DESC LIMIT 1), f.disposition) AS disposition,
          f.created_at
         FROM debate_findings f WHERE f.debate_run_id = $1 ORDER BY f.created_at`,
        [run.id],
      );
      return {
        id: run.id,
        debate_id: run.debate_id,
        status: run.state,
        aggregate_version: run.aggregate_version,
        version: run.aggregate_version,
        current_round: run.cursor_round_number,
        current_turn: run.cursor_turn_number,
        total_usage: {
          input_tokens: accounting.input,
          output_tokens: accounting.output,
          cost_usd: accounting.cost,
        },
        reserved_usd: accounting.reserved,
        settled_usd: accounting.settled,
        retained_ambiguous_usd: accounting.retained,
        stop_reason: run.stop_reason,
        started_at: iso(run.started_at),
        ended_at: iso(run.finished_at),
        judgment: judgmentResult.rows[0] ?? null,
        final_output: outputResult.rows[0] ?? null,
        messages: messages.rows.map(normalizeRow),
        revisions: revisions.rows.map(normalizeRow),
        findings: findings.rows.map(normalizeRow),
      };
    });
  }

  async events(
    projectId: string,
    debateId: string,
    runId: string,
    afterVersion: number,
  ): Promise<{ events: DebateEventDto[]; latest_version: number; next_after_version: number }> {
    return this.transactions.transaction(async (tx) => {
      const rows = await tx.query<{
        schema_version: number;
        id: string;
        project_id: string;
        debate_id: string;
        debate_run_id: string;
        sequence: number;
        event_type: string;
        lifecycle_version: number | null;
        actor_type: string;
        actor_id: string | null;
        correlation_id: string;
        causation_id: string | null;
        payload: Record<string, unknown>;
        occurred_at: string | Date;
      }>(
        `SELECT schema_version, id, project_id, debate_id, debate_run_id, sequence, event_type,
                lifecycle_version, actor_type, actor_id, correlation_id, causation_id,
                payload, occurred_at FROM debate_events
         WHERE project_id = $1 AND debate_id = $2 AND debate_run_id = $3 AND sequence > $4
         ORDER BY sequence ASC LIMIT 500`,
        [projectId, debateId, runId, afterVersion],
      );
      const usage = await tx.query<{
        turn_attempt_id: string;
        input_tokens: number | string;
        output_tokens: number | string;
        cost_usd: number | string;
        latency_ms: number;
      }>("SELECT * FROM debate_usage_events WHERE debate_run_id = $1", [runId]);
      const usageByAttempt = new Map(usage.rows.map((row) => [row.turn_attempt_id, row]));
      const events = rows.rows.map((row) => {
        const attemptId =
          typeof row.payload.turn_attempt_id === "string" ? row.payload.turn_attempt_id : null;
        const rowUsage = attemptId ? usageByAttempt.get(attemptId) : undefined;
        const immutableEvent = V2DebateEventContentHashEnvelope.parse({
          schema_version: 2 as const,
          id: row.id,
          project_id: row.project_id,
          debate_id: row.debate_id,
          debate_run_id: row.debate_run_id,
          sequence: Number(row.sequence),
          type: row.event_type,
          lifecycle_version: row.lifecycle_version,
          correlation_id: row.correlation_id,
          causation_id: row.causation_id,
          round_number:
            typeof row.payload.round_number === "number" ? row.payload.round_number : null,
          turn_number: typeof row.payload.turn_number === "number" ? row.payload.turn_number : null,
          actor_snapshot:
            typeof row.payload.actor_snapshot === "object" && row.payload.actor_snapshot !== null
              ? (row.payload.actor_snapshot as Record<string, unknown>)
              : null,
          actor_type: row.actor_type,
          actor_id: row.actor_id,
          payload: row.payload,
          artifact_ids: Array.isArray(row.payload.artifact_ids)
            ? row.payload.artifact_ids.filter((value): value is string => typeof value === "string")
            : [],
          occurred_at: iso(row.occurred_at) ?? this.now().toISOString(),
        });
        const usageEnrichment = rowUsage
          ? {
              input_tokens: numeric(rowUsage.input_tokens),
              output_tokens: numeric(rowUsage.output_tokens),
              cost_usd: numeric(rowUsage.cost_usd),
              latency_ms: rowUsage.latency_ms,
            }
          : null;
        return V2DebateEvent.parse({
          ...immutableEvent,
          usage: usageEnrichment,
          content_hash: sha256(canonical(immutableEvent)),
        });
      });
      const runVersion = await tx.query<{ event_version: number | string }>(
        "SELECT event_version FROM debate_runs WHERE id = $1 AND project_id = $2 AND debate_id = $3",
        [runId, projectId, debateId],
      );
      const latest = Number(runVersion.rows[0]?.event_version ?? afterVersion);
      const next = events.at(-1)?.sequence ?? afterVersion;
      return { events, latest_version: latest, next_after_version: next };
    });
  }

  private async loadDebate(
    tx: V2SqlExecutor,
    projectId: string,
    debateId: string,
    forUpdate = false,
  ): Promise<DebateRow> {
    const result = await tx.query<DebateRow>(
      `SELECT * FROM debates WHERE project_id = $1 AND id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [projectId, debateId],
    );
    const debate = result.rows[0];
    if (!debate) throw new DebateConflictError("debate_not_found", "debate not found");
    return debate;
  }

  private async loadActors(tx: V2SqlExecutor, debateId: string): Promise<DebateActorRow[]> {
    const result = await tx.query<DebateActorRow>(
      "SELECT * FROM debate_actors WHERE debate_id = $1 ORDER BY position ASC",
      [debateId],
    );
    return result.rows;
  }

  private async loadAccounting(tx: V2SqlExecutor, runId: string) {
    const result = await tx.query<{
      reserved: string | number;
      settled: string | number;
      retained: string | number;
      input_tokens: string | number;
      output_tokens: string | number;
      cost: string | number;
    }>(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM debate_reservations WHERE debate_run_id = $1 AND status = 'active'), 0) AS reserved,
         COALESCE((SELECT SUM(settled_usd) FROM debate_reservations WHERE debate_run_id = $1), 0) AS settled,
         COALESCE((SELECT SUM(retained_usd) FROM debate_reservations WHERE debate_run_id = $1), 0) AS retained,
         COALESCE((SELECT SUM(input_tokens) FROM debate_usage_events WHERE debate_run_id = $1), 0) AS input_tokens,
         COALESCE((SELECT SUM(output_tokens) FROM debate_usage_events WHERE debate_run_id = $1), 0) AS output_tokens,
         COALESCE((SELECT SUM(cost_usd) FROM debate_usage_events WHERE debate_run_id = $1), 0) AS cost`,
      [runId],
    );
    const row = result.rows[0];
    return {
      reserved: numeric(row?.reserved),
      settled: numeric(row?.settled),
      retained: numeric(row?.retained),
      input: numeric(row?.input_tokens),
      output: numeric(row?.output_tokens),
      cost: numeric(row?.cost),
    };
  }

  private async appendEvent(
    tx: V2SqlExecutor,
    input: {
      projectId: string;
      debateId: string;
      runId: string;
      sequence: number;
      eventType: string;
      lifecycleVersion: number | null;
      actorType: string;
      actorId: string | null;
      correlationId: string;
      causationId: string | null;
      payload: Record<string, unknown>;
      occurredAt: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO debate_events (
         id, project_id, debate_id, debate_run_id, sequence, event_type,
         lifecycle_version, actor_type, actor_id, correlation_id, causation_id,
         payload, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [
        newId("debate_event"),
        input.projectId,
        input.debateId,
        input.runId,
        input.sequence,
        input.eventType,
        input.lifecycleVersion,
        input.actorType,
        input.actorId,
        input.correlationId,
        input.causationId,
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    );
  }
}
