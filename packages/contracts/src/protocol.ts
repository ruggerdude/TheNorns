// Runner protocol (PRD R4 §Runner Protocol). Delivery guarantee: at-least-once
// transport with idempotent command execution and durable deduplication.
// Exactly-once is not claimed. Every envelope carries correlation_id (thread
// of related activity) and causation_id (the message that directly caused it).
import { z } from "zod";
import { V2DispatchCommand } from "./v2/commands.js";

const nonEmpty = z.string().min(1);
const isoDate = z.string().datetime();

// ---------------------------------------------------------------------------
// Command state machine
// ---------------------------------------------------------------------------

export const CommandState = z.enum([
  "created",
  "queued",
  "delivered",
  "accepted",
  "executing",
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);
export type CommandStateT = z.infer<typeof CommandState>;

// Conflict rule (REVIEW-001 P0-2): cancel racing completion resolves to the
// terminal state that commits first; the loser is recorded as superseded.
export const COMMAND_TRANSITIONS: Record<CommandStateT, readonly CommandStateT[]> = {
  created: ["queued", "cancelled"],
  queued: ["delivered", "expired", "cancelled"],
  delivered: ["accepted", "rejected", "expired", "cancelled"],
  accepted: ["executing", "rejected", "cancelled"],
  executing: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export const TERMINAL_COMMAND_STATES: ReadonlySet<CommandStateT> = new Set([
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);

export function canCommandTransition(from: CommandStateT, to: CommandStateT): boolean {
  return COMMAND_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Commands (server -> runner, via the durable outbox)
// ---------------------------------------------------------------------------

// UI defaults to interrupt + cancel; the rest are advanced controls mapped to
// each runtime's declared capability matrix.
export const CommandPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("launch_fixture"), fixture: nonEmpty }), // Phase 1A
  z.object({
    kind: z.literal("launch_run"),
    node_id: nonEmpty,
    run_id: nonEmpty,
    prompt_ref: nonEmpty,
    dispatch: V2DispatchCommand.optional(),
  }),
  z.object({ kind: z.literal("send_message"), run_id: nonEmpty, message: nonEmpty }),
  z.object({ kind: z.literal("interrupt"), run_id: nonEmpty }),
  z.object({ kind: z.literal("suspend"), run_id: nonEmpty }),
  z.object({ kind: z.literal("resume_session"), run_id: nonEmpty }),
  z.object({ kind: z.literal("cancel"), run_id: nonEmpty }),
  z.object({ kind: z.literal("stop_after_current"), run_id: nonEmpty }),
  z.object({ kind: z.literal("run_verification"), node_id: nonEmpty, commit_sha: nonEmpty }),
]);
export type CommandPayloadT = z.infer<typeof CommandPayload>;

export const CommandEnvelope = z.object({
  protocol: z.literal(1),
  command_id: nonEmpty, // globally unique
  idempotency_key: nonEmpty,
  correlation_id: nonEmpty,
  causation_id: nonEmpty.nullable(),
  project_id: nonEmpty, // authorization binding: project/node/repository
  runner_id: nonEmpty,
  generation: z.number().int().nonnegative(), // fencing token; stale runners cannot act
  issued_by_session: nonEmpty, // browser session that authorized the command
  issued_at: isoDate,
  expires_at: isoDate,
  payload: CommandPayload,
});
export type CommandEnvelopeT = z.infer<typeof CommandEnvelope>;

export function isCommandExpired(
  command: Pick<CommandEnvelopeT, "expires_at">,
  now: Date,
): boolean {
  return Date.parse(command.expires_at) <= now.getTime();
}

// ---------------------------------------------------------------------------
// Events (runner -> server, monotonic per-runner sequence)
// ---------------------------------------------------------------------------

export const RunStatus = z.enum([
  "started",
  "paused",
  "resumed",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * EXECUTION E10 — one verification command's REAL result.
 *
 * The runner has produced these since E4 and the event contract had nowhere to
 * put them, so `phase4EventProcessor` wrote `'[]'::jsonb` and a failing
 * verification reached a human as a red badge over a sha256 digest of text
 * nobody kept. `output` is the truncated combined stdout/stderr of the command
 * that actually ran — the single most useful artefact a failed run produces.
 */
export const VerificationCommandOutcome = z.object({
  name: nonEmpty,
  command: z.array(nonEmpty).min(1),
  exit_code: z.number().int(),
  passed: z.boolean(),
  output: z.string(),
});
export type VerificationCommandOutcomeT = z.infer<typeof VerificationCommandOutcome>;

export const PublicationOutcomeKind = z.enum(["pushed", "local_only"]);

export const EventPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heartbeat") }),
  z.object({
    kind: z.literal("command_ack"),
    command_id: nonEmpty,
    state: CommandState,
    detail: z.string().default(""),
  }),
  z.object({ kind: z.literal("run_log"), run_id: nonEmpty, chunk: z.string() }),
  z.object({ kind: z.literal("run_status"), run_id: nonEmpty, status: RunStatus }),
  z.object({
    kind: z.literal("verification_result"),
    node_id: nonEmpty,
    commit_sha: nonEmpty,
    passed: z.boolean(),
    output_digest: nonEmpty,
    // ADDITIVE, and deliberately `.optional()` rather than `.default([])`.
    //
    // A default would make the field REQUIRED on the parsed output type, and
    // the runner emits that type — so every existing emit site would stop
    // compiling and a legacy runner build would be unable to construct a valid
    // payload at all. Optional keeps the field absent-able in both directions:
    // a runner that predates E10 emits exactly what it emitted before, and the
    // server records no results, which is the truth about that runner rather
    // than a fabricated empty pass.
    command_results: z.array(VerificationCommandOutcome).optional(),
  }),
  /**
   * EXECUTION E10 — where the run's work went.
   *
   * E4 made the runner push a branch and open a pull request, then reported it
   * as `run_log` PROSE. Nothing could link a task to its review, because a log
   * line is not a field. This event carries the same facts structurally; it is
   * a NEW member of the union, so no existing runner emits it and no existing
   * server path changes.
   */
  z.object({
    kind: z.literal("run_published"),
    run_id: nonEmpty,
    outcome: PublicationOutcomeKind,
    branch: nonEmpty,
    commit_sha: nonEmpty,
    remote: z.string().nullable().default(null),
    pull_request_url: z.string().url().nullable().default(null),
    /** Why there is no pull request, when there is none. Never silent. */
    pull_request_note: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal("usage_report"),
    run_id: nonEmpty,
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
]);
export type EventPayloadT = z.infer<typeof EventPayload>;

export const EventEnvelope = z.object({
  protocol: z.literal(1),
  event_seq: z.number().int().positive(), // monotonic per runner
  runner_id: nonEmpty,
  generation: z.number().int().nonnegative(),
  correlation_id: nonEmpty,
  causation_id: nonEmpty.nullable(),
  occurred_at: isoDate,
  payload: EventPayload,
});
export type EventEnvelopeT = z.infer<typeof EventEnvelope>;
/**
 * The PRE-parse shape. EXECUTION E10 gave `verification_result` a defaulted
 * `command_results`, which makes the field required on the OUTPUT type and
 * still optional on the input — exactly the additive property we want, since a
 * runner that predates E10 emits an envelope without it. Anything that accepts
 * an envelope and parses it should take this type, not the output type, or the
 * compiler would demand a field the wire is allowed to omit.
 */
export type EventEnvelopeInputT = z.input<typeof EventEnvelope>;

// ---------------------------------------------------------------------------
// Reconciliation handshake (every reconnect: exchange watermarks, replay both
// directions; recovery is idempotent)
// ---------------------------------------------------------------------------

export const ReconcileRequest = z.object({
  protocol: z.literal(1),
  runner_id: nonEmpty,
  generation: z.number().int().nonnegative(),
  // Additive capability negotiation. Legacy runners omit this field and are
  // treated as supporting no optional side channels.
  // EXECUTION E3 adds "model_proxy": the runner is able to obtain model
  // completions through the relay instead of from its own environment. Adding
  // an enum member here is backwards compatible in the direction that matters
  // — a legacy runner simply never sends it and the server never offers the
  // side channel — and the server must not assume the capability's presence.
  capabilities: z.array(z.enum(["workspace_picker", "model_proxy"])).default([]),
  last_event_seq_sent: z.number().int().nonnegative(),
  recently_executed_command_ids: z.array(nonEmpty),
});
export type ReconcileRequestT = z.infer<typeof ReconcileRequest>;

export const ReconcileResponse = z.object({
  protocol: z.literal(1),
  ack_event_seq: z.number().int().nonnegative(), // server's event watermark
  generation: z.number().int().nonnegative(), // authoritative; runner must adopt or die
  resend_commands: z.array(CommandEnvelope),
});
export type ReconcileResponseT = z.infer<typeof ReconcileResponse>;

// ---------------------------------------------------------------------------
// Dedup semantics (reference implementation)
// ---------------------------------------------------------------------------

/**
 * In-memory reference implementation of the runner's command-dedup contract:
 * a replayed command_id must NOT execute twice — the recorded outcome is
 * returned instead. Phase 1A replaces the Map with a disk-backed store; the
 * semantics tested against this class are the contract.
 */
export class CommandDedupStore {
  private readonly outcomes = new Map<string, unknown>();

  has(commandId: string): boolean {
    return this.outcomes.has(commandId);
  }

  async execute<T>(
    commandId: string,
    run: () => T | Promise<T>,
  ): Promise<{ duplicate: boolean; result: T }> {
    if (this.outcomes.has(commandId)) {
      return { duplicate: true, result: this.outcomes.get(commandId) as T };
    }
    const result = await run();
    this.outcomes.set(commandId, result);
    return { duplicate: false, result };
  }
}
