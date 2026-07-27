// Runner protocol (PRD R4 §Runner Protocol). Delivery guarantee: at-least-once
// transport with idempotent command execution and durable deduplication.
// Exactly-once is not claimed. Every envelope carries correlation_id (thread
// of related activity) and causation_id (the message that directly caused it).
import { z } from "zod";
import { V2DispatchCommand } from "./v2/commands.js";
import { V2_HUMAN_WAIT_CHANNEL_VERSION, V2_HUMAN_WAIT_INSTRUCTION_HASH } from "./v2/common.js";

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
  "waiting_for_human",
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
  executing: ["waiting_for_human", "succeeded", "failed", "cancelled"],
  waiting_for_human: [],
  succeeded: [],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export const TERMINAL_COMMAND_STATES: ReadonlySet<CommandStateT> = new Set([
  "succeeded",
  "waiting_for_human",
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
  "waiting_for_human",
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

/**
 * Machine-readable runner failure diagnostics.
 *
 * `stage` identifies the execution boundary that failed, `code` is stable for
 * automation and UI copy, and `detail` is a runner-redacted explanation. The
 * object is optional so events from older runners remain valid.
 */
export const RunnerFailure = z
  .object({
    stage: nonEmpty,
    code: nonEmpty,
    detail: nonEmpty,
  })
  .strict();
export type RunnerFailureT = z.infer<typeof RunnerFailure>;

const knowledgeText = z.string().trim().min(1).max(4_000);
const knowledgeSummary = z.string().trim().min(1).max(500);
const knowledgeList = z.array(knowledgeText).max(32);

/**
 * Optional, capability-negotiated knowledge transport.
 *
 * The shapes are deliberately bounded at the wire boundary. Runner output is
 * durable and replayed at least once, so accepting unbounded prose here would
 * turn one noisy runtime into an unbounded database and reconnect payload.
 */
export const RunnerKnowledgeRegistration = z
  .object({
    kind: z.literal("knowledge_registration"),
    run_id: nonEmpty,
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    branch_or_workspace: z.string().trim().min(1).max(500),
    token_budget: z.number().int().positive().nullable(),
  })
  .strict();

export const RunnerKnowledgeHeartbeat = z
  .object({
    kind: z.literal("knowledge_heartbeat"),
    run_id: nonEmpty,
    status: z.enum(["working", "waiting", "blocked", "completed"]),
    completed_since_last_update: knowledgeList,
    currently_working_on: knowledgeList,
    findings: knowledgeList,
    blockers: knowledgeList,
    decisions_needed: knowledgeList,
    files_changed: knowledgeList,
    tests: knowledgeText,
    estimated_remaining_work: z.enum(["small", "moderate", "significant"]),
    risk_level: z.enum(["green", "yellow", "red"]),
  })
  .strict();

export const RunnerKnowledgeDelta = z
  .object({
    kind: z.literal("knowledge_delta"),
    run_id: nonEmpty,
    changes: z
      .array(
        z
          .object({
            kind: z.enum([
              "new_standard",
              "modified_standard",
              "new_interface",
              "changed_interface",
              "new_dependency",
              "new_constraint",
              "discovered_limitation",
              "confirmed_assumption",
              "invalidated_assumption",
              "new_defect",
              "performance_finding",
              "reusable_component",
              "suggested_decision_record",
            ]),
            summary: knowledgeSummary,
            detail: knowledgeText,
            affected_package_ids: z.array(nonEmpty).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    recommended_package_updates: z
      .array(
        z
          .object({
            package_id: nonEmpty,
            current_version: nonEmpty,
            recommended_version: nonEmpty,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export const RunnerKnowledgeHandoff = z
  .object({
    kind: z.literal("knowledge_handoff"),
    run_id: nonEmpty,
    status: z.enum(["completed", "blocked", "failed"]),
    summary: knowledgeText,
    deliverables: knowledgeList,
    files_changed: knowledgeList,
    interfaces_used: knowledgeList,
    interfaces_changed: knowledgeList,
    tests_added: knowledgeList,
    test_results: knowledgeList,
    acceptance_criteria: z
      .array(
        z
          .object({
            criterion: knowledgeText,
            result: z.enum(["pass", "fail", "partial"]),
            evidence: knowledgeText,
          })
          .strict(),
      )
      .max(32),
    known_limitations: knowledgeList,
    open_issues: knowledgeList,
    dependencies_created: knowledgeList,
    recommended_package_updates: knowledgeList,
    recommended_follow_up_tasks: knowledgeList,
    branch: z.string().trim().min(1).max(500),
    commit: z.string().trim().min(1).max(500),
    artifacts: knowledgeList,
  })
  .strict();

export const EventPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heartbeat") }),
  z.object({
    kind: z.literal("command_ack"),
    command_id: nonEmpty,
    state: CommandState,
    detail: z.string().default(""),
  }),
  z.object({ kind: z.literal("run_log"), run_id: nonEmpty, chunk: z.string() }),
  z.object({
    kind: z.literal("run_status"),
    run_id: nonEmpty,
    status: RunStatus,
    failure: RunnerFailure.optional(),
  }),
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
  z.object({
    kind: z.literal("runtime_result"),
    run_id: nonEmpty,
    runtime: nonEmpty,
    outcome: z.enum(["completed", "waiting_for_human", "failed", "cancelled"]),
    session_id: nonEmpty.nullable(),
    stop_reason: z.string().trim().min(1).max(500).nullable(),
    detail: z.string().max(4_000),
  }),
  z
    .object({
      kind: z.literal("human_wait_requested"),
      run_id: nonEmpty,
      decision_point: z.string().trim().min(1).max(500),
      question: z.string().trim().min(1).max(8_000),
      question_hash: z.string().regex(/^[a-f0-9]{64}$/),
      compact_summary: z.string().trim().min(1).max(16_000),
      compact_summary_hash: z.string().regex(/^[a-f0-9]{64}$/),
      runtime: nonEmpty,
      session_id: nonEmpty.nullable(),
      ask_channel_version: z.literal(V2_HUMAN_WAIT_CHANNEL_VERSION),
      ask_instruction_hash: z.literal(V2_HUMAN_WAIT_INSTRUCTION_HASH),
    })
    .strict(),
  z
    .object({
      kind: z.literal("continuation_context_applied"),
      run_id: nonEmpty,
      wait_id: nonEmpty,
      root_command_id: nonEmpty,
      context_hash: z.string().regex(/^[a-f0-9]{64}$/),
      replay_context_hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  RunnerKnowledgeRegistration,
  RunnerKnowledgeHeartbeat,
  RunnerKnowledgeDelta,
  RunnerKnowledgeHandoff,
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
  capabilities: z
    .array(z.enum(["workspace_picker", "model_proxy", "knowledge_transport"]))
    .default([]),
  last_event_seq_sent: z.number().int().nonnegative(),
  recently_executed_command_ids: z.array(nonEmpty),
});
export type ReconcileRequestT = z.infer<typeof ReconcileRequest>;

export const ReconcileResponse = z.object({
  protocol: z.literal(1),
  ack_event_seq: z.number().int().nonnegative(), // server's event watermark
  generation: z.number().int().nonnegative(), // authoritative; runner must adopt or die
  // Server-side feature negotiation. A legacy server omits this field, so a
  // new runner keeps the optional knowledge channel disabled.
  capabilities: z.array(z.enum(["knowledge_transport"])).optional(),
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
