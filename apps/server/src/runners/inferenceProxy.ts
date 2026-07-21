// EXECUTION E3 — the server half of proxied model inference.
//
// THE PROBLEM. A runner executing in an ephemeral GitHub Actions job has no
// provider credentials and there is no safe way to give it any: a repository
// secret is readable by every workflow in that repository and lands in the
// environment of a machine Norns does not control. The human's decision was the
// proxy: the key never leaves this server, and every call is authorized,
// metered and budget-checked before it is made.
//
// WHAT THIS MODULE IS. One function of consequence, `InferenceProxy.handle`,
// which turns an `inference_request` frame from an ALREADY-AUTHENTICATED runner
// socket into a `RunnerInferenceResponse`. It never throws at its caller: an
// exception inside the relay's message handler would drop the frame and leave
// the runner blocked until its own timeout, which is indistinguishable from a
// hang. Every failure is a typed refusal instead.
//
// WHAT IT DELIBERATELY DOES NOT TRUST. Everything in the request that could
// decide who pays. The runner names a run; it does not name a project, a phase,
// a budget, or a price. Those are resolved here from this server's own records,
// keyed by a run id whose ownership is then checked against the identity the
// socket already proved. A compromised job can lie about which run it is
// executing and get `unauthorized`; it cannot lie its way into another
// project's budget.
//
// ORDER MATTERS. Fencing, then ownership, then liveness, then model, then
// budget, and only then the provider. The budget hold is taken BEFORE the call
// and resolved after, so concurrent requests cannot each observe the same
// "remaining" figure and collectively overspend.
import {
  AdapterError,
  type AdapterErrorKind,
  DEFAULT_MODEL_REGISTRY,
  type LlmAdapter,
  type ModelEntry,
  type ProviderName,
  conservativeMaxChargeUsd,
  snapshotModelPricing,
} from "@norns/adapters";
import {
  type InferenceErrorCodeT,
  MAX_INFERENCE_PROMPT_CHARS,
  type RunnerInferenceRequestT,
  type RunnerInferenceResponseT,
  type UsageEventT,
} from "@norns/contracts";
import { BudgetExceededError, type BudgetLedger } from "../engine/budget.js";
import { newId } from "../ids.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * What the server knows about a run, resolved from its own records.
 *
 * `runner_id` and `runner_generation` are the authorization facts: the run was
 * dispatched to exactly one runner at exactly one generation, and only that
 * pair may spend against it. The rest are the metering facts. Nothing here is
 * ever taken from the request.
 */
export interface ProxiedRunFacts {
  run_id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  /** The runner this run was dispatched to. */
  runner_id: string;
  /** The generation it was dispatched at, from the durable command record. */
  runner_generation: number;
  /** False once the run is finished, cancelled, expired, or revoked. */
  active: boolean;
}

/**
 * Resolving a run to its authorization facts.
 *
 * A port rather than a hardcoded query because the run tables are written by
 * `apps/server/src/coordinator/**`, which E3 does not own — and because it lets
 * the refusal tests exercise the real decision logic without a database.
 */
export interface ProxiedRunLookup {
  /** Returns null for an unknown run. Must not throw for an unknown run. */
  lookup(runId: string): Promise<ProxiedRunFacts | null>;
}

/** An accepted budget hold. Exactly one of settle/release must follow. */
export interface InferenceBudgetHold {
  settle(actualUsd: number): Promise<void> | void;
  release(): Promise<void> | void;
}

/**
 * Hard budget enforcement. `reserve` returns null when the run cannot afford
 * the call — a refusal, never an approximation, and never a post-hoc check.
 */
export interface InferenceBudget {
  reserve(run: ProxiedRunFacts, maxChargeUsd: number): Promise<InferenceBudgetHold | null>;
}

/** Durable metering. Called once per completed provider call. */
export interface InferenceMeter {
  record(run: ProxiedRunFacts, usage: UsageEventT): Promise<void> | void;
}

/**
 * Constructing the provider client. Returns null when this deployment has no
 * credential for the provider — a configuration state, not a fault, and so a
 * `model_unavailable` refusal rather than an exception.
 */
export type ProxiedAdapterFactory = (provider: ProviderName, model: string) => LlmAdapter | null;

// ---------------------------------------------------------------------------
// Deployment allowlist
// ---------------------------------------------------------------------------

/** `NORNS_RUNNER_ALLOWED_MODELS=anthropic/claude-sonnet-5,openai/gpt-5.6-luna` */
export const RUNNER_ALLOWED_MODELS_ENV = "NORNS_RUNNER_ALLOWED_MODELS";

/**
 * An API key alone must never make every model in the registry reachable from
 * a CI job: the key is deployment-wide, and the runner is the least trusted
 * caller in the system. Absent or empty means NONE — fail closed, exactly as
 * the debate allowlist does.
 */
export function parseRunnerAllowedModels(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Conservative input-token estimate for the hold.
 *
 * The hold must be taken before the call, and before the call nobody knows the
 * real input token count. Four characters per token is the standard rough
 * figure and it UNDER-estimates for code and for non-Latin scripts, so it is
 * inflated by a quarter with a fixed floor added. Under-estimating is the
 * dangerous direction — it would let a job spend past what the budget said was
 * available. Over-estimating only refuses early, and the unused remainder is
 * given back at settle time.
 */
export function estimateInferenceInputTokens(system: string | undefined, prompt: string): number {
  const chars = (system?.length ?? 0) + prompt.length;
  return Math.max(1, Math.ceil((chars / 4) * 1.25) + 256);
}

// ---------------------------------------------------------------------------
// The one run-authorization decision
// ---------------------------------------------------------------------------

/**
 * EXECUTION E9 — extracted VERBATIM from `InferenceProxy.handle` so the
 * streaming gateway and the completion proxy share one implementation.
 *
 * The E9 brief is explicit that two notions of "this runner owns this run" is
 * how an authorization bypass gets built, and it is right: this used to be four
 * inline comparisons, and a second caller copying them would have been the
 * moment the two drifted. `handle` now calls this, so there is nothing to
 * drift from.
 *
 * @param run                the facts resolved from THIS server's records
 * @param requestedRunId     the run the caller claims to be executing
 * @param authenticatedRunner the runner identity the transport already proved
 * @param currentGeneration  the generation this server currently recognises
 */
export function authorizeProxiedRunAccess(
  run: ProxiedRunFacts | null,
  requestedRunId: string,
  authenticatedRunner: string,
  currentGeneration: number,
): "ok" | "unauthorized" | "run_not_active" {
  // Unknown run, someone else's run, and a stale dispatch generation all
  // collapse to the SAME opaque refusal: a compromised job must not be able to
  // probe run ids and learn which exist.
  if (
    !run ||
    run.runner_id !== authenticatedRunner ||
    run.runner_generation !== currentGeneration ||
    run.run_id !== requestedRunId
  ) {
    return "unauthorized";
  }
  if (!run.active) return "run_not_active";
  return "ok";
}

/** Provider failure taxonomy -> the runner-visible refusal code. */
function codeForAdapterKind(kind: AdapterErrorKind): InferenceErrorCodeT {
  switch (kind) {
    case "rate_limit":
      return "rate_limited";
    case "invalid_request":
      return "invalid_request";
    // `auth` is OUR credential being wrong, not the runner's business; it must
    // learn nothing beyond "the provider side failed".
    default:
      return "provider_error";
  }
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

export interface InferenceProxyOptions {
  runs: ProxiedRunLookup;
  createAdapter: ProxiedAdapterFactory;
  /**
   * Budget enforcement. Optional in shape only: when absent EVERY request is
   * refused with `budget_exhausted`. There is deliberately no unmetered mode —
   * an unbudgeted proxy is the thing the human chose the proxy to prevent.
   */
  budget?: InferenceBudget | undefined;
  meter?: InferenceMeter | undefined;
  /** `provider/model` pairs runners may spend on. Empty means none. */
  allowedModels?: Iterable<string> | undefined;
  registry?: Record<string, ModelEntry> | undefined;
  /** Audit sink. Every decision that spends, or refuses to, is recorded. */
  audit?: ((actor: string, action: string, detail: string) => void) | undefined;
}

export class InferenceProxy {
  private readonly registry: Record<string, ModelEntry>;
  private readonly allowed: ReadonlySet<string>;

  constructor(private readonly options: InferenceProxyOptions) {
    this.registry = options.registry ?? DEFAULT_MODEL_REGISTRY;
    this.allowed = new Set(options.allowedModels ?? []);
  }

  /**
   * @param request           the validated frame body — schema-checked, never trusted
   * @param authenticated     the runner id the SOCKET proved, never the frame's
   * @param frameGeneration   the generation stamped on the frame
   * @param currentGeneration the generation this server currently recognises
   */
  async handle(
    request: RunnerInferenceRequestT,
    authenticated: string,
    frameGeneration: number,
    currentGeneration: number,
  ): Promise<RunnerInferenceResponseT> {
    const refuse = (code: InferenceErrorCodeT, message: string): RunnerInferenceResponseT => {
      this.options.audit?.(
        `runner:${authenticated}`,
        "runner.inference_refused",
        `${code} run=${request.run_id}`,
      );
      return { request_id: request.request_id, status: "error", code, message };
    };

    // 1. FENCING. A superseded runner can still sign frames on an open socket;
    //    the generation is what stops it spending.
    if (frameGeneration !== currentGeneration) {
      return refuse("unauthorized", "not authorized for this run");
    }

    // 2. OWNERSHIP. Unknown run, someone else's run, and a stale dispatch
    //    generation all collapse to the SAME opaque refusal: a compromised job
    //    must not be able to probe run ids and learn which exist.
    let run: ProxiedRunFacts | null;
    try {
      run = await this.options.runs.lookup(request.run_id);
    } catch {
      return refuse("provider_error", "run lookup failed");
    }
    // EXECUTION E9 — the comparisons that used to be inline here now live in
    // `authorizeProxiedRunAccess` so the streaming gateway shares them exactly.
    const access = authorizeProxiedRunAccess(run, request.run_id, authenticated, currentGeneration);
    if (access === "unauthorized" || !run) {
      return refuse("unauthorized", "not authorized for this run");
    }
    if (run.task_id !== request.task_id) {
      // Distinct from `unauthorized` only because it reveals nothing extra:
      // the caller has already proved it owns this run.
      return refuse("invalid_request", "task does not belong to this run");
    }
    if (access === "run_not_active") {
      return refuse("run_not_active", "run is not in a state that may spend");
    }

    // 3. SIZE. Belt and braces over the schema's own maximum, so tightening
    //    the ceiling later is a change here rather than a contract bump.
    if (request.prompt.length + (request.system?.length ?? 0) > MAX_INFERENCE_PROMPT_CHARS) {
      return refuse("invalid_request", "prompt exceeds the proxy's size limit");
    }

    // 4. MODEL. Allowlisted, in the registry, at the provider claimed, and
    //    priced. An unpriced model cannot be metered, and an unmeterable call
    //    is precisely what the proxy exists to prevent.
    const selection = `${request.provider}/${request.model}`;
    const entry = this.registry[request.model];
    if (!this.allowed.has(selection) || !entry || entry.provider !== request.provider) {
      return refuse("model_unavailable", "model is not available to runners");
    }

    let maxChargeUsd: number;
    try {
      const pricing = snapshotModelPricing(request.provider, request.model, this.registry);
      maxChargeUsd = conservativeMaxChargeUsd(pricing, {
        max_input_tokens: estimateInferenceInputTokens(request.system, request.prompt),
        max_output_tokens: request.max_tokens,
      });
    } catch {
      return refuse("model_unavailable", "model has no usable pricing");
    }

    const adapter = this.options.createAdapter(request.provider, request.model);
    if (!adapter) return refuse("model_unavailable", "model is not available to runners");

    // 5. BUDGET, BEFORE THE PROVIDER.
    const budget = this.options.budget;
    if (!budget) {
      return refuse("budget_exhausted", "no budget enforcement is configured");
    }
    let hold: InferenceBudgetHold | null;
    try {
      hold = await budget.reserve(run, maxChargeUsd);
    } catch {
      // A budget backend that cannot answer must not be read as "yes".
      return refuse("budget_exhausted", "the run's budget could not be verified");
    }
    if (!hold) {
      this.options.audit?.(
        `runner:${authenticated}`,
        "runner.inference_budget_exhausted",
        `run=${run.run_id} needed=${maxChargeUsd}`,
      );
      return refuse("budget_exhausted", "the run's budget cannot cover this call");
    }

    // 6. THE CALL. From here the hold MUST be resolved on every path, or the
    //    held amount leaks and the run's remaining budget shrinks for good.
    try {
      const result = await adapter.complete({
        projectId: run.project_id,
        nodeId: run.task_id,
        runId: run.run_id,
        prompt: request.prompt,
        maxTokens: request.max_tokens,
        ...(request.system !== undefined ? { system: request.system } : {}),
      });
      await this.settle(run, hold, result.usage);
      this.options.audit?.(
        `runner:${authenticated}`,
        "runner.inference_completed",
        `${selection} run=${run.run_id} in=${result.usage.input_tokens} out=${result.usage.output_tokens} usd=${result.usage.estimated_cost_usd}`,
      );
      return {
        request_id: request.request_id,
        status: "ok",
        provider: request.provider,
        model: request.model,
        text: result.text,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
        ...(result.finish_reason !== undefined ? { finish_reason: result.finish_reason } : {}),
      };
    } catch (error) {
      if (error instanceof AdapterError) {
        // A provider that answered and then failed us still COST us. The
        // adapter surfaces that as failure metadata; meter it rather than
        // pretending a failed call was free.
        const usage = error.metadata?.usage;
        if (usage) await this.settle(run, hold, usage);
        else await hold.release();
        return refuse(codeForAdapterKind(error.kind), `provider call failed (${error.kind})`);
      }
      await hold.release();
      return refuse("provider_error", "provider call failed");
    }
  }

  /** Settle the hold, then meter. In that order: the settle is money. */
  private async settle(
    run: ProxiedRunFacts,
    hold: InferenceBudgetHold,
    usage: UsageEventT,
  ): Promise<void> {
    await hold.settle(usage.actual_cost_usd ?? usage.estimated_cost_usd);
    await this.options.meter?.record(run, usage);
  }
}

// ---------------------------------------------------------------------------
// SQL-backed run lookup — the production authorization source
// ---------------------------------------------------------------------------

/**
 * Resolves a run exactly the way `Phase4EventProcessor` authorizes a runner
 * EVENT: `agent_runs.runner_id` is the ownership anchor, the dispatched
 * `commands.runner_generation` is the durable fence, and `runner_revocations`
 * vetoes both. Using the same three facts as the event path is deliberate —
 * two different notions of "this runner owns this run" is how an authorization
 * bypass gets built by accident.
 */
export class SqlProxiedRunLookup implements ProxiedRunLookup {
  constructor(private readonly transactions: V2TransactionRunner) {}

  /** Run states that may still spend. Terminal states may not, ever. */
  private static readonly SPENDABLE = new Set(["created", "dispatched", "running", "verifying"]);

  lookup(runId: string): Promise<ProxiedRunFacts | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        project_id: string;
        phase_id: string;
        task_id: string;
        state: string;
        runner_id: string | null;
        superseded_at: string | null;
        runner_generation: number;
        revoked_through_generation: number | null;
      }>(
        `SELECT run.id, run.project_id, run.phase_id, run.task_id, run.state,
                run.runner_id, run.superseded_at,
                command.runner_generation,
                revocation.revoked_through_generation
         FROM agent_runs run
         JOIN commands command ON command.run_id = run.id
         LEFT JOIN runner_revocations revocation ON revocation.runner_id = run.runner_id
         WHERE run.id = $1
         ORDER BY command.created_at DESC, command.command_id DESC
         LIMIT 1`,
        [runId],
      );
      const row = result.rows[0];
      if (!row || !row.runner_id) return null;
      const generation = Number(row.runner_generation);
      const revokedThrough =
        row.revoked_through_generation === null ? null : Number(row.revoked_through_generation);
      return {
        run_id: row.id,
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        runner_id: row.runner_id,
        runner_generation: generation,
        active:
          SqlProxiedRunLookup.SPENDABLE.has(row.state) &&
          row.superseded_at === null &&
          (revokedThrough === null || generation > revokedThrough),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// SQL-backed budget — the production enforcement point
// ---------------------------------------------------------------------------

/**
 * Charges proxied inference against THE RUN'S OWN budget reservation.
 *
 * WHY THIS AND NOT THE PHASE CAP: the coordinator already reserved
 * `budget-reservation:<run_id>` for this run out of `phases.approved_budget_usd`
 * before dispatching it. Proxied inference happens INSIDE that run, so it is
 * already covered by that reservation — enforcing against the phase cap again
 * would double-count and, worse, would let one run eat another run's headroom.
 * Bounding each run by its own reservation is both correct arithmetic and the
 * tighter blast radius: the most a fully compromised Actions job can spend is
 * the amount a human already approved for the single task it was dispatched for.
 *
 * SETTLED SPEND is read back from `usage_events`, which this class is the only
 * writer of — so the figure is durable and survives a server restart, and a
 * relaunched job cannot reset its own meter.
 *
 * IN-FLIGHT HOLDS are per-process, held in memory. That is sound because a
 * runner's frames arrive on exactly one relay socket on exactly one process, so
 * two concurrent calls for one run are always seen by one instance of this
 * class. Across processes the durable settled figure still bounds the total;
 * the in-memory part only prevents same-process oversubscription.
 */
export class SqlRunReservationBudget implements InferenceBudget {
  private readonly held = new Map<string, number>();

  constructor(private readonly transactions: V2TransactionRunner) {}

  async reserve(run: ProxiedRunFacts, maxChargeUsd: number): Promise<InferenceBudgetHold | null> {
    const approved = await this.transactions.transaction(async (sql) => {
      const reservation = await sql.query<{ amount_usd: string }>(
        `SELECT amount_usd FROM budget_reservations
         WHERE run_id = $1 AND status IN ('active','retained_ambiguous')
         ORDER BY created_at DESC LIMIT 1`,
        [run.run_id],
      );
      const row = reservation.rows[0];
      if (!row) return null;
      const spent = await sql.query<{ total: string | null }>(
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE run_id = $1",
        [run.run_id],
      );
      return {
        amountUsd: Number(row.amount_usd),
        settledUsd: Number(spent.rows[0]?.total ?? 0),
      };
    });
    // No live reservation means nobody approved money for this run. Refuse.
    if (!approved) return null;

    const inFlight = this.held.get(run.run_id) ?? 0;
    const remaining = approved.amountUsd - approved.settledUsd - inFlight;
    if (maxChargeUsd > remaining) return null;

    this.held.set(run.run_id, inFlight + maxChargeUsd);
    let resolved = false;
    const drop = () => {
      if (resolved) return;
      resolved = true;
      const current = (this.held.get(run.run_id) ?? 0) - maxChargeUsd;
      if (current > 1e-9) this.held.set(run.run_id, current);
      else this.held.delete(run.run_id);
    };
    return {
      // The durable charge is the usage_events row the meter writes; dropping
      // the hold here just stops double-counting it while that row lands.
      settle: () => drop(),
      release: () => drop(),
    };
  }
}

/**
 * The in-memory `BudgetLedger` (apps/server/src/engine/budget.ts) as an
 * `InferenceBudget`. That ledger is the engine's reservation primitive and is
 * currently wired only to the demo dashboard, so this adapter exists so the
 * proxy can be driven by it in tests and by any composition that owns one —
 * without the proxy itself depending on which budget machinery a deployment
 * runs. Node id is the task id, which is the V2 equivalent of a plan node.
 */
export class BudgetLedgerInferenceBudget implements InferenceBudget {
  constructor(private readonly ledger: BudgetLedger) {}

  async reserve(run: ProxiedRunFacts, maxChargeUsd: number): Promise<InferenceBudgetHold | null> {
    const nodeId = run.task_id;
    let reservationId: string;
    try {
      reservationId = this.ledger.reserve(nodeId, maxChargeUsd);
    } catch (error) {
      // BudgetExceededError, and "no approved budget for node", are the same
      // answer to the runner: this run has nothing to spend. Fail closed.
      if (error instanceof BudgetExceededError || error instanceof Error) return null;
      throw error;
    }
    return {
      settle: (actualUsd: number) => this.ledger.settle(nodeId, reservationId, actualUsd),
      release: () => this.ledger.release(nodeId, reservationId),
    };
  }
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/**
 * Writes one `usage_events` row per proxied call.
 *
 * This table has existed since the V2 refoundation with NO writer at all; the
 * proxy is its first. That matters beyond tidiness: `SqlRunReservationBudget`
 * reads these rows back as the run's settled spend, so metering and enforcement
 * are the same fact rather than two that can drift.
 *
 * The row is scoped project/phase/task/run from the SERVER's resolved facts,
 * never from the request, which is also what satisfies the table's composite
 * scope foreign keys.
 */
export class SqlInferenceMeter implements InferenceMeter {
  constructor(
    private readonly transactions: V2TransactionRunner,
    /** Also append to the in-memory ledger the dashboard reads, when present. */
    private readonly also?: ((events: UsageEventT[]) => void) | undefined,
  ) {}

  async record(run: ProxiedRunFacts, usage: UsageEventT): Promise<void> {
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO usage_events (
           id, project_id, phase_id, task_id, run_id, provider, model,
           input_tokens, output_tokens, cost_usd, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          newId("usage"),
          run.project_id,
          run.phase_id,
          run.task_id,
          run.run_id,
          usage.provider,
          usage.model,
          usage.input_tokens,
          usage.output_tokens,
          usage.actual_cost_usd ?? usage.estimated_cost_usd,
          usage.occurred_at,
        ],
      );
    });
    this.also?.([usage]);
  }
}
