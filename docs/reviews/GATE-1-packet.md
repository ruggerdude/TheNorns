# TheNorns — Phase-Gate Review 1 (Implementation vs. Architecture)

> **What this is.** The first phase-gate review under the REVIEW-002 process
> decision ("no further broad architecture reviews; validate implementation
> against the architecture"). It covers the implementation of Phases 0A–7:
> monorepo + contracts, the remote-control relay + runner, the workflow
> engine, LLM adapters, the planning loop, graph + allocation, runtime
> execution, the dashboard, and multi-agent coordination. Generated
> 2026-07-14 from the repo at 108 passing tests.

> **Instructions for the reviewing agent.** The architecture (PRD R4 +
> ADR-001/002/003) was approved by you in REVIEW-002 — do not re-litigate it.
> Your question is narrower: **does this implementation faithfully realize
> the approved architecture, and where does it not?** Focus on: (a) protocol
> and state-machine semantics vs. the spec (Appendix A carries the actual
> source); (b) trust-boundary violations (worker vs. runner vs. engine);
> (c) gaps between what the tests prove and what the spec requires;
> (d) the deviations list in §4 — are any of them load-bearing rather than
> cosmetic? Return structured findings: `severity` (P0/P1/P2), `area`,
> `finding`, `recommendation`. Targeted questions in §5.

---

## 1. Status summary

| Phase | Status | Evidence |
|---|---|---|
| 0A/0B | Complete | pnpm monorepo; `@norns/contracts` 1.2.0 (tagged); 31 contract tests incl. reducer determinism/idempotency |
| 1A | Complete (local half) | Relay + runner over real WebSockets: Ed25519 challenge/response, reconciliation/watermark replay, outbox delivery, generation fencing, audit; 8 integration tests incl. forced-disconnect replay (no gaps/dupes), server-restart recovery (no double execution) |
| 1B | Complete | Event-sourced engine (replay-identical), budget reservations (race-tested), lease-based dispatch, real-git worktrees, fail-closed sandbox launcher |
| 2 | Complete (mock-conformance half) | Anthropic + OpenAI adapters over official SDKs; identical 5-part conformance suite over both via baseURL-override mock; failure taxonomy; ledger-valid usage events |
| 3 | Complete (loop-logic half) | runPlanning: convergence/3-round cap, must-fix disposition enforcement, validation round-trips, memory injection, review-policy exceptions, canonical plan hashing; 8 tests over 3 objectives |
| 4 | Complete | Graph editing (atomic cycle rejection w/ path, reparent/cascade, post-start restrictions, versioning), 3-strategy allocation with persisting overrides, hashed approval; React Flow editor browser-verified |
| 5 | Complete (deterministic-runtime half) | ClaudeCode/Codex/Process runtime adapters + capability matrices; executeNode: budget-before-dispatch, runner-executed verification at exact commit |
| 6 | Complete | Dashboard derives solely from engine + ledger; gate-only progress; source-labeled usage; browser-verified |
| 7 | Complete | Clean-merge-only integration; conflict nodes w/ replacement semantics + human-confirmation gate; 2-worker coordination with retry/escalation — all on real git |

**Test inventory: 108 passing** — contracts 31 (plan validation, lifecycle,
reducer determinism/idempotency, protocol state machines, dedup, domain
schemas), adapters 10 (+2 live-gated), server 67 (relay 8, engine 8, budget 4,
dispatch 3, git 2, sandbox 2, planning 8, graph 13, graph API 4, execution 6,
coordination 4, dashboard 5).

## 2. Architecture-conformance claims (what to verify)

1. **Verification trust chain** (REVIEW-002 P1-2): workers only ever produce
   commits; `runVerification` re-checks out the exact commit in a fresh
   detached worktree and executes the commands itself; module `test_commands`
   are additive to required commands and a failing module command blocks
   review. Source: Appendix A5.
2. **Budget-before-dispatch** (REVIEW-001 P1-6): `executeNode` calls
   `engine.startRun` (atomic reservation) before any worktree exists; the
   exhaustion test asserts zero branches were created. Project-cap breach
   auto-engages the kill switch. Source: A4/A5.
3. **At-least-once + idempotent + fenced protocol** (REVIEW-001 P0-2):
   command state machine with first-terminal-commits; runner-side durable
   dedup (replay re-acks, never re-executes); per-runner generation fencing
   after revocation; contiguous event seq with watermark replay. Source: A2/A3.
4. **Clean merges only + conflict-node replacement** (REVIEW-002 P1-3/P1-10):
   integration aborts on conflict, escalates, spawns `<node>-conflict`
   inheriting deps, rewires dependents, supersedes the original; both-sides
   resolutions refuse integration without `humanConfirmed`. Source: A6.
5. **Bounded coordination** (PRD §Allocation): lead split hard-capped;
   workers isolated per `-w<k>` worktree; questions route only through the
   lead; retry-once-from-fresh-worktree then PM escalation. Source: A7.
6. **Dashboard derivation** (PRD §PM Dashboard): progress moves only on gate
   transitions (byte-identical output between transitions is tested); usage
   never aggregates across source labels; ETA hard-coded experimental.
   Source: A8.
7. **Kill-switch reachability**: engaged state refuses dispatch at both the
   engine (`startRun`) and the relay (`POST /api/commands` → 423).

## 3. Credential/infra-gated halves (tracked, not hidden)

- **Deployed 1A acceptance** (Fly + Neon + passkey + second device) — gated
  on human account setup (NORN-008/023/024). Stores are in-memory reference
  implementations with snapshot/restore durability semantics; the restart
  test recovers through serialization, not process memory.
- **Live LLM execution** (adapter live smoke, Phase 3 prompt iteration,
  Phase 5 live Claude Code/Codex nodes) — gated on API keys (NORN-027).
- **Live container sandbox** — Docker absent on the dev host; fail-closed
  path and policy-arg construction are tested; a live containerized run
  awaits a Docker host (pre-Phase 8).

## 4. Known deviations from the spec (assess these)

1. **Browser auth is a bearer token, not passkeys** — WebAuthn lands with
   the deployed web UI (the spec allows this only for 1A-local).
2. **Stores are in-memory + snapshot/restore**, not Postgres — semantics
   (SKIP-LOCKED-style leases, atomic reservations, watermark rows) are
   test-pinned as the contract for the Drizzle port (NORN-024).
3. **Command delivery is push-on-connect + reconcile-resend**, not a polling
   dispatch loop; the durable `dispatch_jobs` lease store exists and is
   tested but is not yet wired between the engine and the relay outbox.
4. **The engine's approval gate checks presence, not content-hash match**,
   of plan/allocation approvals.
5. **suspend** is declared unsupported by all three runtimes (capability
   matrix honest); the fixture runtime maps suspend to pause.
6. **Reviewer at node review gates** is currently the human/API caller
   (`reviewerDecision`); the LLM reviewer wiring for implementation diffs
   (as opposed to plans) is Phase 8/9 work.
7. **Graph session is single-project, in-process** (demo project on the dev
   server); multi-project persistence arrives with the Postgres port.

## 5. Targeted questions

1. Does the command state machine + dedup + fencing implementation (A2/A3)
   close REVIEW-001 P0-2, or are there interleavings the tests miss (e.g.
   reconcile-resend racing a live delivery of the same command)?
2. Is deviation #3 (no engine→outbox dispatch loop yet) acceptable to defer
   to the Postgres port, or is it load-bearing now?
3. In `runVerification`, commands execute with the repo's default shell
   environment. Is that an acceptable pre-Phase-8 posture, or does
   verification itself need sandbox confinement before any live LLM run?
4. `spawnConflictNode` supersedes the original node while its branch still
   holds the conflicting commits. Any state the replacement loses that
   review or audit later needs?
5. The budget settle path caps at the reservation (`min(actual, held)`).
   Does the overshoot beyond the cap need separate surfacing in the ledger?
6. Multi-worker: one node-level reservation covers both workers. Should
   per-worker sub-reservations exist before live LLM workers?
7. Are the capability matrices (interrupt/resume/cancel true, suspend false)
   consistent with how the SDKs actually behave under abort mid-tool-call?
8. Anything in Appendix A that contradicts the R4 spec text outright?

---

# Appendix A — contract-critical source (verbatim from the repo)


## A1: Node lifecycle + reducer — \`packages/contracts/src/lifecycle.ts\`

```ts
// Node lifecycle (PRD R4 §Graph & Execution Workflow). The engine owns these
// states; gate transitions are objective. `in_review` is deliberately not
// named `review` to avoid colliding with the Review entity. `superseded`
// marks a node replaced by a conflict-resolution node.

export const NODE_STATES = [
  "pending",
  "ready",
  "assigned",
  "running",
  "verifying",
  "in_review",
  "verified",
  "integrated",
  "blocked",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type NodeState = (typeof NODE_STATES)[number];

export const BLOCKED_REASONS = ["dependency", "budget", "runner", "integration"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set([
  "integrated",
  "cancelled",
  "superseded",
]);

export const NODE_TRANSITIONS: Record<NodeState, readonly NodeState[]> = {
  pending: ["ready", "cancelled"],
  ready: ["assigned", "blocked", "cancelled"],
  assigned: ["running", "blocked", "cancelled"],
  running: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["in_review", "failed", "blocked", "cancelled"],
  // in_review -> assigned is reviewer-requested rework
  in_review: ["verified", "assigned", "failed", "cancelled"],
  // verified -> blocked is `blocked: integration` (conflict); the engine then
  // spawns a conflict-resolution node and the original becomes superseded.
  verified: ["integrated", "blocked", "superseded"],
  // blocked resumes to the state it interrupted (engine records which).
  blocked: [
    "ready",
    "assigned",
    "running",
    "verifying",
    "in_review",
    "verified",
    "cancelled",
    "superseded",
  ],
  failed: ["assigned", "cancelled", "superseded"],
  integrated: [],
  cancelled: [],
  superseded: [],
};

export function isNodeState(value: string): value is NodeState {
  return (NODE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: NodeState, to: NodeState): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

```

## A1b: Pure reducer (determinism/idempotency contract) — \`packages/contracts/src/reducer.ts\`

```ts
// Pure, deterministic lifecycle reducer. The Phase 1B workflow engine wraps
// this in the durable event-sourced store; the contract itself guarantees:
// (1) determinism — same event log, same state, always; (2) idempotency —
// replayed events (same event_id) are no-ops. ADR-001 requires both to hold
// under test before any engine code is written.
import { z } from "zod";
import { type NodeState, canTransition, isNodeState } from "./lifecycle.js";

export const LifecycleEvent = z.object({
  event_id: z.string().min(1),
  node_id: z.string().min(1),
  to: z.string().refine(isNodeState, "not a valid node state"),
  reason: z.string().optional(),
});
export type LifecycleEventT = z.infer<typeof LifecycleEvent>;

export interface NodeSnapshot {
  state: NodeState;
  history: NodeState[];
}

export interface RejectedEvent {
  event_id: string;
  reason: string;
}

export interface ReducedState {
  nodes: Record<string, NodeSnapshot>;
  applied_event_ids: string[];
  rejected: RejectedEvent[];
}

const INITIAL_STATE: NodeState = "pending";

export function reduceLifecycle(events: readonly LifecycleEventT[]): ReducedState {
  const seen = new Set<string>();
  const nodes: Record<string, NodeSnapshot> = {};
  const applied: string[] = [];
  const rejected: RejectedEvent[] = [];

  for (const event of events) {
    if (seen.has(event.event_id)) continue; // idempotent replay: exact no-op
    seen.add(event.event_id);

    const to = event.to as NodeState;
    const node = nodes[event.node_id] ?? { state: INITIAL_STATE, history: [INITIAL_STATE] };
    if (!canTransition(node.state, to)) {
      rejected.push({
        event_id: event.event_id,
        reason: `invalid transition ${node.state} -> ${to} for node ${event.node_id}`,
      });
      continue;
    }
    node.state = to;
    node.history.push(to);
    nodes[event.node_id] = node;
    applied.push(event.event_id);
  }

  return { nodes, applied_event_ids: applied, rejected };
}

```

## A2: Runner protocol (command state machine, envelopes, fencing, dedup) — \`packages/contracts/src/protocol.ts\`

```ts
// Runner protocol (PRD R4 §Runner Protocol). Delivery guarantee: at-least-once
// transport with idempotent command execution and durable deduplication.
// Exactly-once is not claimed. Every envelope carries correlation_id (thread
// of related activity) and causation_id (the message that directly caused it).
import { z } from "zod";

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

// ---------------------------------------------------------------------------
// Reconciliation handshake (every reconnect: exchange watermarks, replay both
// directions; recovery is idempotent)
// ---------------------------------------------------------------------------

export const ReconcileRequest = z.object({
  protocol: z.literal(1),
  runner_id: nonEmpty,
  generation: z.number().int().nonnegative(),
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

```

## A3: Runner daemon (replay, dedup, fencing behavior) — \`apps/runner/src/daemon.ts\`

```ts
// The Local Runner daemon: pairs once (Ed25519 keypair), then maintains an
// outbound-only WebSocket to the relay. Survives disconnects: events buffer
// on disk and replay from the server's watermark; replayed commands never
// execute twice (durable dedup); a stale generation fences the daemon off.
import { sign as edSign, generateKeyPairSync } from "node:crypto";
import {
  type CommandEnvelopeT,
  type CommandStateT,
  type EventEnvelopeT,
  type EventPayloadT,
  PROTOCOL_VERSION,
  isCommandExpired,
  parseServerFrame,
} from "@norns/contracts";
import WebSocket from "ws";
import { FixtureExecutor } from "./fixture.js";
import { RunnerStateFile } from "./state.js";

export interface DaemonOptions {
  serverUrl: string; // http://host:port
  runnerId: string;
  dataDir: string;
  heartbeatMs?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export class RunnerDaemon {
  private readonly opts: Required<DaemonOptions>;
  private stateFile: RunnerStateFile | null = null;
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fenced = false;
  private readonly executor: FixtureExecutor;
  private serverAckSeq = 0;

  constructor(options: DaemonOptions) {
    this.opts = {
      heartbeatMs: 2000,
      reconnect: true,
      reconnectDelayMs: 150,
      ...options,
    };
    this.executor = new FixtureExecutor((payload, meta) => this.emit(payload, meta));
  }

  get isFenced(): boolean {
    return this.fenced;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** One-time enrollment: generate the keypair and redeem the pairing code. */
  async pair(code: string): Promise<void> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const res = await fetch(`${this.opts.serverUrl}/api/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, runner_id: this.opts.runnerId, public_key_pem: publicPem }),
    });
    if (!res.ok) throw new Error(`pairing failed: ${res.status}`);
    const body = (await res.json()) as { generation: number };
    this.stateFile = new RunnerStateFile(this.opts.dataDir, {
      runner_id: this.opts.runnerId,
      private_key_pem: privatePem,
      generation: body.generation,
    });
  }

  /** Load previously-paired state from disk (after a daemon restart). */
  loadState(): void {
    this.stateFile = new RunnerStateFile(this.opts.dataDir, {
      runner_id: this.opts.runnerId,
      private_key_pem: "",
      generation: 0,
    });
  }

  connect(): void {
    if (this.stopped || this.fenced) return;
    const state = this.requireState();
    const wsUrl = `${this.opts.serverUrl.replace(/^http/, "ws")}/ws/runner`;
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.on("message", (data) => {
      const frame = parseServerFrame(String(data));
      if (!frame) return;
      switch (frame.type) {
        case "challenge": {
          const signature = edSign(
            null,
            Buffer.from(frame.nonce, "utf8"),
            state.state.private_key_pem,
          ).toString("base64");
          socket.send(
            JSON.stringify({
              type: "auth",
              runner_id: this.opts.runnerId,
              nonce_signature: signature,
            }),
          );
          break;
        }
        case "auth_ok": {
          socket.send(
            JSON.stringify({
              type: "reconcile_request",
              body: {
                protocol: PROTOCOL_VERSION,
                runner_id: this.opts.runnerId,
                generation: state.state.generation,
                last_event_seq_sent: state.state.seq,
                recently_executed_command_ids: state.executedIds(),
              },
            }),
          );
          break;
        }
        case "auth_error": {
          socket.close();
          break;
        }
        case "reconcile_response": {
          this.serverAckSeq = frame.body.ack_event_seq;
          state.pruneAcked(frame.body.ack_event_seq);
          // replay everything the server has not acked, in order
          for (const event of state.unackedSince(frame.body.ack_event_seq)) {
            socket.send(JSON.stringify({ type: "event", event }));
          }
          for (const command of frame.body.resend_commands) {
            this.handleCommand(command);
          }
          this.startHeartbeat();
          break;
        }
        case "command": {
          this.handleCommand(frame.command);
          break;
        }
        case "event_ack": {
          this.serverAckSeq = frame.ack_event_seq;
          state.pruneAcked(frame.ack_event_seq);
          break;
        }
        case "fenced": {
          // A newer pairing owns this runner id. Stop acting entirely.
          this.fenced = true;
          this.executor.cancelAll();
          this.stopHeartbeat();
          socket.close();
          break;
        }
      }
    });

    socket.on("close", () => {
      this.stopHeartbeat();
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
    socket.on("error", () => {
      // close handler drives reconnection
    });
  }

  /** Test hook: drop the socket abruptly (network kill). Runs keep going. */
  disconnectNow(): void {
    this.socket?.terminate();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.executor.cancelAll();
    this.socket?.close();
  }

  // -- internals ---------------------------------------------------------------

  private requireState(): RunnerStateFile {
    if (!this.stateFile) throw new Error("runner not paired: call pair() or loadState() first");
    return this.stateFile;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fenced || !this.opts.reconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectDelayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.emit({ kind: "heartbeat" }, {});
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * At-least-once + idempotent execution: a command_id seen before is never
   * re-executed — we re-ack its recorded state instead.
   */
  private handleCommand(command: CommandEnvelopeT): void {
    const state = this.requireState();
    const recorded = state.executionState(command.command_id);
    const meta = { correlation: command.correlation_id, causation: command.command_id };
    if (recorded) {
      this.ack(command.command_id, recorded, meta);
      return;
    }
    if (isCommandExpired(command, new Date())) {
      state.recordExecution(command.command_id, "expired");
      this.ack(command.command_id, "expired", meta);
      return;
    }
    state.recordExecution(command.command_id, "executing");
    this.ack(command.command_id, "accepted", meta);
    this.ack(command.command_id, "executing", meta);

    const payload = command.payload;
    switch (payload.kind) {
      case "launch_fixture":
        this.executor.launch(`run_${command.command_id}`, payload.fixture, meta);
        break;
      case "interrupt":
        this.executor.interrupt(payload.run_id);
        break;
      case "resume_session":
        this.executor.resume(payload.run_id);
        break;
      case "suspend":
        this.executor.interrupt(payload.run_id); // fixture capability matrix: suspend == pause
        break;
      case "stop_after_current":
        this.executor.stopAfterCurrent(payload.run_id);
        break;
      case "cancel":
        this.executor.cancel(payload.run_id);
        break;
      default:
        // launch_run / send_message / run_verification arrive with Phase 5
        state.recordExecution(command.command_id, "rejected");
        this.ack(command.command_id, "rejected", meta);
        return;
    }
    state.recordExecution(command.command_id, "succeeded");
    this.ack(command.command_id, "succeeded", meta);
  }

  private ack(
    commandId: string,
    ackState: CommandStateT,
    meta: { correlation?: string; causation?: string },
  ): void {
    this.emit({ kind: "command_ack", command_id: commandId, state: ackState, detail: "" }, meta);
  }

  /** Buffer durably, then send if connected. Replay covers the rest. */
  private emit(payload: EventPayloadT, meta: { correlation?: string; causation?: string }): void {
    if (this.fenced) return;
    const state = this.requireState();
    const event: EventEnvelopeT = {
      protocol: PROTOCOL_VERSION as 1,
      event_seq: state.nextSeq(),
      runner_id: this.opts.runnerId,
      generation: state.state.generation,
      correlation_id: meta.correlation ?? `runner:${this.opts.runnerId}`,
      causation_id: meta.causation ?? null,
      occurred_at: new Date().toISOString(),
      payload,
    };
    state.bufferEvent(event);
    if (this.connected) {
      this.socket?.send(JSON.stringify({ type: "event", event }));
    }
  }
}

```

## A4: Budget ledger (atomic reservations) — \`apps/server/src/engine/budget.ts\`

```ts
// Budget enforcement with atomic reservations (PRD R4 §Budget Enforcement):
// available = approved − settled − active reservations. Each reserve() is a
// synchronous check-and-set, so concurrent dispatch attempts cannot
// oversubscribe. No agent can extend a budget — there is no API for it here;
// extension is a human Approval that constructs a new ledger entry.
import { availableBudgetUsd, budgetThresholdReached } from "@norns/contracts";

export class BudgetExceededError extends Error {
  constructor(
    nodeId: string,
    requested: number,
    available: number,
    readonly scope: "node" | "project" = "node",
  ) {
    super(`budget exceeded for ${nodeId}: requested $${requested}, available $${available}`);
    this.name = "BudgetExceededError";
  }
}

interface NodeBudget {
  approvedUsd: number;
  settledUsd: number;
  reservations: Map<string, number>; // reservation_id -> max charge
}

export class BudgetLedger {
  private readonly nodes = new Map<string, NodeBudget>();
  private reservationCounter = 0;
  private onThreshold: ((nodeId: string) => void) | null = null;

  constructor(private readonly projectCapUsd: number) {}

  /** PM notification hook for the 80% threshold. */
  notifyThreshold(callback: (nodeId: string) => void): void {
    this.onThreshold = callback;
  }

  approve(nodeId: string, approvedUsd: number): void {
    this.nodes.set(nodeId, { approvedUsd, settledUsd: 0, reservations: new Map() });
  }

  available(nodeId: string): number {
    const node = this.require(nodeId);
    return availableBudgetUsd(node.approvedUsd, node.settledUsd, this.activeUsd(node));
  }

  /** Atomic: throws BudgetExceededError instead of oversubscribing. */
  reserve(nodeId: string, maxChargeUsd: number): string {
    const node = this.require(nodeId);
    const available = this.available(nodeId);
    if (maxChargeUsd > available) {
      throw new BudgetExceededError(nodeId, maxChargeUsd, available);
    }
    if (this.projectActiveUsd() + this.projectSettledUsd() + maxChargeUsd > this.projectCapUsd) {
      throw new BudgetExceededError("project-cap", maxChargeUsd, this.projectCapUsd, "project");
    }
    this.reservationCounter += 1;
    const id = `res_${this.reservationCounter}`;
    node.reservations.set(id, maxChargeUsd);
    if (budgetThresholdReached(node.approvedUsd, node.settledUsd, this.activeUsd(node))) {
      this.onThreshold?.(nodeId);
    }
    return id;
  }

  /** Settle against actual usage; the unused remainder is released. */
  settle(nodeId: string, reservationId: string, actualUsd: number): void {
    const node = this.require(nodeId);
    const held = node.reservations.get(reservationId);
    if (held === undefined) throw new Error(`unknown reservation ${reservationId}`);
    node.reservations.delete(reservationId);
    node.settledUsd += Math.min(actualUsd, held); // per-call cap bounds overshoot
  }

  release(nodeId: string, reservationId: string): void {
    this.require(nodeId).reservations.delete(reservationId);
  }

  settledUsd(nodeId: string): number {
    return this.require(nodeId).settledUsd;
  }

  activeReservationsUsd(nodeId: string): number {
    return this.activeUsd(this.require(nodeId));
  }

  projectHardCapReached(): boolean {
    return this.projectSettledUsd() + this.projectActiveUsd() >= this.projectCapUsd;
  }

  /** Ledger rollup for the dashboard — settled, held, approved, cap. */
  summary(): {
    settled_usd: number;
    active_reservations_usd: number;
    approved_usd: number;
    project_cap_usd: number;
  } {
    let approved = 0;
    for (const node of this.nodes.values()) approved += node.approvedUsd;
    return {
      settled_usd: this.projectSettledUsd(),
      active_reservations_usd: this.projectActiveUsd(),
      approved_usd: approved,
      project_cap_usd: this.projectCapUsd,
    };
  }

  private require(nodeId: string): NodeBudget {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`no approved budget for node ${nodeId}`);
    return node;
  }

  private activeUsd(node: NodeBudget): number {
    let total = 0;
    for (const amount of node.reservations.values()) total += amount;
    return total;
  }

  private projectActiveUsd(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += this.activeUsd(node);
    return total;
  }

  private projectSettledUsd(): number {
    let total = 0;
    for (const node of this.nodes.values()) total += node.settledUsd;
    return total;
  }
}

```

## A5: Execution pipeline (runner-executed verification) — \`apps/server/src/engine/execution.ts\`

```ts
// Phase 5 execution pipeline: worktree -> runtime run (worker commits
// locally) -> RUNNER-EXECUTED verification in a clean worktree at the exact
// commit (a worker's claim is evidence, not state) -> in_review gate, with
// budget reservation before dispatch and settlement from reported usage.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { VerificationResultT } from "@norns/contracts";
import type { CodingRuntime } from "@norns/runner";
import { newId } from "../ids.js";
import type { LocalGitRepo, WorktreeHandle } from "./git.js";
import type { WorkflowEngine } from "./workflow.js";

const run = promisify(execFile);

export interface VerificationPlan {
  /** project-level Required Verification Commands (human-approved, always run) */
  required: string[];
  /** module test_commands — ADDITIVE only */
  module: string[];
}

export interface ExecuteNodeOptions {
  engine: WorkflowEngine;
  repo: LocalGitRepo;
  runtime: CodingRuntime;
  nodeId: string;
  prompt: string;
  maxChargeUsd: number;
  verification: VerificationPlan;
  /** estimate used to settle usage; live adapters report real tokens */
  actualUsd?: number;
  onLog?: (chunk: string) => void;
}

export interface ExecuteNodeResult {
  outcome: "in_review" | "failed";
  commit: string | null;
  branch: string;
  verification: VerificationResultT[];
  runtimeDetail: string;
}

async function headOf(worktreePath: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
  return stdout.trim();
}

/** Runner-side verification: fresh detached worktree at the exact commit. */
export async function runVerification(
  repo: LocalGitRepo,
  commit: string,
  nodeId: string,
  runId: string,
  plan: VerificationPlan,
): Promise<VerificationResultT[]> {
  const verifyPath = `${repo.worktreesDir}/verify-${nodeId}-${Date.now()}`;
  await run("git", ["worktree", "add", "--detach", verifyPath, commit], { cwd: repo.repoDir });
  const results: VerificationResultT[] = [];
  try {
    const commands: { command: string; kind: "required" | "module" }[] = [
      ...plan.required.map((command) => ({ command, kind: "required" as const })),
      ...plan.module.map((command) => ({ command, kind: "module" as const })),
    ];
    for (const entry of commands) {
      let passed = true;
      let output = "";
      try {
        const { stdout, stderr } = await run("sh", ["-c", entry.command], {
          cwd: verifyPath,
          timeout: 60_000,
        });
        output = stdout + stderr;
      } catch (error) {
        passed = false;
        output = error instanceof Error ? error.message : String(error);
      }
      results.push({
        id: newId("verif"),
        node_id: nodeId,
        run_id: runId,
        commit_sha: commit,
        command: entry.command,
        kind: entry.kind,
        passed,
        output_digest: createHash("sha256").update(output).digest("hex"),
        executed_at: new Date().toISOString(),
      });
    }
  } finally {
    await run("git", ["worktree", "remove", "--force", verifyPath], { cwd: repo.repoDir }).catch(
      () => undefined,
    );
  }
  return results;
}

/**
 * Drive one assigned node through running -> verifying -> in_review|failed.
 * Throws BudgetExceededError/KillSwitchEngagedError from startRun — the
 * caller decides escalation (Phase 7 coordinator adds retry + PM escalation).
 */
export async function executeNode(options: ExecuteNodeOptions): Promise<ExecuteNodeResult> {
  const { engine, repo, runtime, nodeId } = options;
  engine.startRun(nodeId, options.maxChargeUsd); // budget gate BEFORE dispatch

  let worktree: WorktreeHandle | null = null;
  try {
    worktree = await repo.createWorktree(nodeId);
    const runId = `run_${nodeId}_${Date.now()}`;
    const result = await runtime.run({
      runId,
      worktreePath: worktree.path,
      prompt: options.prompt,
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
    });

    if (result.outcome !== "completed") {
      engine.completeRun(nodeId, options.actualUsd ?? 0);
      engine.recordVerification(nodeId, false);
      return {
        outcome: "failed",
        commit: null,
        branch: worktree.branch,
        verification: [],
        runtimeDetail: result.detail,
      };
    }

    const commit = await headOf(worktree.path);
    engine.completeRun(nodeId, options.actualUsd ?? options.maxChargeUsd * 0.5);

    const verification = await runVerification(repo, commit, nodeId, runId, options.verification);
    const allPassed = verification.every((entry) => entry.passed);
    engine.recordVerification(nodeId, allPassed);

    return {
      outcome: allPassed ? "in_review" : "failed",
      commit,
      branch: worktree.branch,
      verification,
      runtimeDetail: result.detail,
    };
  } finally {
    // worktree removed; the branch survives for review/integration/audit
    if (worktree) await repo.removeWorktree(worktree).catch(() => undefined);
  }
}

```

## A6: Integration agent + conflict nodes — \`apps/server/src/engine/integration.ts\`

```ts
// Integration agent (PRD R4): merges verified node branches into the
// integration branch in dependency order. CLEAN MERGES ONLY — on conflict the
// node blocks, and the engine spawns a conflict-resolution node that REPLACES
// the original (outgoing edges move, original archived `superseded`).
// Integrating a conflict node that materially modified both sides requires
// explicit human confirmation. Never force-pushes, never touches main.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkflowGraph } from "../graph/graph.js";
import type { LocalGitRepo } from "./git.js";
import type { WorkflowEngine } from "./workflow.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-integration",
  GIT_AUTHOR_EMAIL: "integration@norns.local",
  GIT_COMMITTER_NAME: "norns-integration",
  GIT_COMMITTER_EMAIL: "integration@norns.local",
};

export type MergeResult =
  | { merged: true; commit: string }
  | { merged: false; conflict_files: string[] };

/** Attempt a clean --no-ff merge of a node branch into the integration branch. */
export async function integrateBranch(repo: LocalGitRepo, branch: string): Promise<MergeResult> {
  const integration = await repo.ensureIntegrationBranch();
  const path = `${repo.worktreesDir}/integration-${Date.now()}`;
  await run("git", ["worktree", "add", path, integration], { cwd: repo.repoDir, env: GIT_ENV });
  try {
    try {
      await run("git", ["merge", "--no-ff", "-m", `integrate ${branch}`, branch], {
        cwd: path,
        env: GIT_ENV,
      });
    } catch {
      const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: path,
        env: GIT_ENV,
      });
      await run("git", ["merge", "--abort"], { cwd: path, env: GIT_ENV }).catch(() => undefined);
      return { merged: false, conflict_files: stdout.trim().split("\n").filter(Boolean) };
    }
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: path, env: GIT_ENV });
    return { merged: true, commit: stdout.trim() };
  } finally {
    await run("git", ["worktree", "remove", "--force", path], {
      cwd: repo.repoDir,
      env: GIT_ENV,
    }).catch(() => undefined);
  }
}

export interface ConflictNodeSpec {
  conflictNodeId: string;
  rewiredDependents: string[];
}

/**
 * Replacement semantics (PRD R4): the conflict node inherits the original's
 * dependencies, every dependent is rewired to it, and the original is
 * archived as `superseded` — preserved for audit, never deleted.
 */
export function spawnConflictNode(
  engine: WorkflowEngine,
  graph: WorkflowGraph | null,
  nodeId: string,
): ConflictNodeSpec {
  const conflictNodeId = `${nodeId}-conflict`;
  const dependencies = [...engine.dependenciesOf(nodeId)];
  engine.registerNode(conflictNodeId, dependencies);

  const rewired: string[] = [];
  for (const candidate of engine.nodeIds()) {
    if (candidate === conflictNodeId) continue;
    if (engine.dependenciesOf(candidate).includes(nodeId)) {
      engine.replaceDependency(candidate, nodeId, conflictNodeId);
      rewired.push(candidate);
    }
  }
  engine.supersede(nodeId);

  if (graph) {
    graph.addNode({ id: conflictNodeId, title: `Conflict resolution: ${nodeId}`, dependencies });
    for (const dependent of rewired) {
      graph.removeEdge(nodeId, dependent);
      graph.addEdge(conflictNodeId, dependent);
    }
  }
  return { conflictNodeId, rewiredDependents: rewired };
}

export class HumanConfirmationRequiredError extends Error {
  constructor(nodeId: string) {
    super(
      `conflict node ${nodeId} materially modified both sides: explicit human confirmation is required before integration`,
    );
    this.name = "HumanConfirmationRequiredError";
  }
}

export interface IntegrateNodeOptions {
  engine: WorkflowEngine;
  repo: LocalGitRepo;
  nodeId: string;
  branch: string;
  graph?: WorkflowGraph;
  /** conflict nodes touching both sides need this to be true */
  isConflictResolution?: boolean;
  humanConfirmed?: boolean;
  onEscalate?: (nodeId: string, reason: string) => void;
}

export type IntegrateNodeResult =
  | { integrated: true; commit: string }
  | { integrated: false; conflict: ConflictNodeSpec };

/** Full integration step for a `verified` node, with the conflict path. */
export async function integrateNode(options: IntegrateNodeOptions): Promise<IntegrateNodeResult> {
  const { engine, repo, nodeId, branch } = options;
  if (options.isConflictResolution && !options.humanConfirmed) {
    throw new HumanConfirmationRequiredError(nodeId);
  }
  const result = await integrateBranch(repo, branch);
  if (result.merged) {
    engine.integrate(nodeId);
    return { integrated: true, commit: result.commit };
  }
  engine.block(nodeId, "integration");
  options.onEscalate?.(
    nodeId,
    `merge conflict on [${result.conflict_files.join(", ")}]: conflict-resolution node spawned`,
  );
  const conflict = spawnConflictNode(engine, options.graph ?? null, nodeId);
  return { integrated: false, conflict };
}

```

## A7: Multi-worker coordination — \`apps/server/src/engine/coordination.ts\`

```ts
// Phase 7 multi-worker coordination (PRD R4 §Allocation, §Agent Types):
// a Module Lead splits a parallel-safe node into bounded work units (pilot
// cap 2); each worker runs in its OWN worktree on its own -w<k> branch;
// worker questions route through the lead (PM-brokered — workers never talk
// to each other); failures retry once from a fresh worktree, then escalate;
// the lead assembles worker branches into the node branch, which then goes
// through runner verification and the normal review/integration gates.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlanModuleT, VerificationResultT } from "@norns/contracts";
import type { CodingRuntime } from "@norns/runner";
import { type VerificationPlan, runVerification } from "./execution.js";
import type { LocalGitRepo } from "./git.js";
import { EngineError, type WorkflowEngine } from "./workflow.js";

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "norns-lead",
  GIT_AUTHOR_EMAIL: "lead@norns.local",
  GIT_COMMITTER_NAME: "norns-lead",
  GIT_COMMITTER_EMAIL: "lead@norns.local",
};

export interface WorkerSpec {
  worker: number; // 1-based
  prompt: string;
}

export interface ModuleLead {
  /** Bounded decomposition into independent work units. */
  split(module: PlanModuleT): WorkerSpec[];
  /** PM-routed worker question channel. */
  answer(worker: number, question: string): Promise<string>;
}

export interface MultiWorkerOptions {
  engine: WorkflowEngine;
  repo: LocalGitRepo;
  nodeId: string;
  module: PlanModuleT;
  lead: ModuleLead;
  runtimeFor: (spec: WorkerSpec) => CodingRuntime;
  maxChargeUsd: number;
  verification: VerificationPlan;
  actualUsd?: number;
  workerCap?: number; // pilot cap 2
  onEscalate?: (nodeId: string, reason: string) => void;
}

export interface MultiWorkerResult {
  outcome: "in_review" | "failed";
  branch: string;
  commit: string | null;
  workerBranches: string[];
  attempts: Record<number, number>;
  verification: VerificationResultT[];
}

interface WorkerOutcome {
  spec: WorkerSpec;
  branch: string;
  succeeded: boolean;
  attempts: number;
  detail: string;
}

async function runWorkerWithRetry(
  options: MultiWorkerOptions,
  spec: WorkerSpec,
): Promise<WorkerOutcome> {
  const branch = options.repo.branchFor(options.nodeId, spec.worker);
  let detail = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // retry starts from a FRESH worktree (PRD §Failure Handling)
    await options.repo.deleteBranch(branch);
    const worktree = await options.repo.createWorktree(options.nodeId, spec.worker);
    try {
      const result = await options.runtimeFor(spec).run({
        runId: `run_${options.nodeId}_w${spec.worker}_a${attempt}`,
        worktreePath: worktree.path,
        prompt: spec.prompt,
      });
      detail = result.detail;
      if (result.outcome === "completed") {
        return { spec, branch, succeeded: true, attempts: attempt, detail };
      }
    } finally {
      await options.repo.removeWorktree(worktree).catch(() => undefined);
    }
  }
  return { spec, branch, succeeded: false, attempts: 2, detail };
}

/** Lead assembly: merge worker branches into the node branch, in order. */
async function assemble(
  repo: LocalGitRepo,
  nodeId: string,
  workerBranches: string[],
): Promise<{ ok: true; commit: string; branch: string } | { ok: false; conflict: string[] }> {
  const worktree = await repo.createWorktree(nodeId);
  try {
    for (const branch of workerBranches) {
      try {
        await run("git", ["merge", "--no-ff", "-m", `assemble ${branch}`, branch], {
          cwd: worktree.path,
          env: GIT_ENV,
        });
      } catch {
        const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=U"], {
          cwd: worktree.path,
          env: GIT_ENV,
        });
        await run("git", ["merge", "--abort"], { cwd: worktree.path, env: GIT_ENV }).catch(
          () => undefined,
        );
        return { ok: false, conflict: stdout.trim().split("\n").filter(Boolean) };
      }
    }
    const { stdout } = await run("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      env: GIT_ENV,
    });
    return { ok: true, commit: stdout.trim(), branch: worktree.branch };
  } finally {
    await repo.removeWorktree(worktree).catch(() => undefined);
  }
}

export async function executeMultiWorkerNode(
  options: MultiWorkerOptions,
): Promise<MultiWorkerResult> {
  const cap = options.workerCap ?? 2;
  const specs = options.lead.split(options.module);
  if (specs.length === 0 || specs.length > cap) {
    throw new EngineError(
      `module lead produced ${specs.length} work units; bounded decomposition requires 1..${cap}`,
    );
  }

  const { engine, nodeId } = options;
  engine.startRun(nodeId, options.maxChargeUsd); // one node-level budget gate

  const outcomes = await Promise.all(specs.map((spec) => runWorkerWithRetry(options, spec)));
  const attempts: Record<number, number> = {};
  for (const outcome of outcomes) attempts[outcome.spec.worker] = outcome.attempts;
  const workerBranches = outcomes.map((outcome) => outcome.branch);

  const fail = (reason: string): MultiWorkerResult => {
    engine.completeRun(nodeId, options.actualUsd ?? 0);
    engine.recordVerification(nodeId, false);
    options.onEscalate?.(nodeId, reason);
    return {
      outcome: "failed",
      branch: options.repo.branchFor(nodeId),
      commit: null,
      workerBranches,
      attempts,
      verification: [],
    };
  };

  const failedWorker = outcomes.find((outcome) => !outcome.succeeded);
  if (failedWorker) {
    return fail(
      `worker ${failedWorker.spec.worker} failed after ${failedWorker.attempts} attempts: ${failedWorker.detail.slice(0, 300)}`,
    );
  }

  const assembly = await assemble(options.repo, nodeId, workerBranches);
  if (!assembly.ok) {
    return fail(`lead assembly conflict on [${assembly.conflict.join(", ")}]`);
  }

  engine.completeRun(nodeId, options.actualUsd ?? options.maxChargeUsd * 0.5);
  const verification = await runVerification(
    options.repo,
    assembly.commit,
    nodeId,
    `run_${nodeId}_assembled`,
    options.verification,
  );
  const allPassed = verification.every((entry) => entry.passed);
  engine.recordVerification(nodeId, allPassed);

  return {
    outcome: allPassed ? "in_review" : "failed",
    branch: assembly.branch,
    commit: assembly.commit,
    workerBranches,
    attempts,
    verification,
  };
}

```

## A8: Dashboard derivation — \`apps/server/src/dashboard.ts\`

```ts
// Phase 6 dashboard (PRD R4 §PM Dashboard): every figure derives from the
// workflow engine and the usage ledger — never LLM self-report. Progress
// moves only on gate transitions; ETA stays experimental; cost carries
// usage-source labels and a live burn rate; completion badges carry
// provenance, not invented confidence numbers.
import type { NodeState, UsageEventT } from "@norns/contracts";
import type { BudgetLedger } from "./engine/budget.js";
import type { WorkflowEngine } from "./engine/workflow.js";
import type { AuditEntry } from "./stores.js";

const COMPLEXITY_WEIGHT: Record<string, number> = { S: 1, M: 2, L: 3, XL: 5 };

// Gate-derived progress fractions per lifecycle state (deterministic).
const GATE_FRACTION: Record<NodeState, number> = {
  pending: 0,
  ready: 0.1,
  assigned: 0.2,
  running: 0.4,
  verifying: 0.6,
  in_review: 0.75,
  verified: 0.9,
  integrated: 1,
  blocked: 0.3,
  failed: 0.2,
  cancelled: 0,
  superseded: 0,
};

export interface DashboardInputs {
  engine: WorkflowEngine;
  budget: BudgetLedger;
  ledger: readonly UsageEventT[];
  audit: readonly AuditEntry[];
  complexityOf: (nodeId: string) => "S" | "M" | "L" | "XL";
  graphVersion: number;
  timelineLimit?: number;
}

export interface DashboardDto {
  graph_version: number;
  nodes: Record<string, NodeState>;
  blocked: { node_id: string; reason: string }[];
  review_queue: string[];
  progress_pct: number;
  eta: { label: "experimental"; value: null };
  cost: {
    settled_usd: number;
    active_reservations_usd: number;
    approved_usd: number;
    project_cap_usd: number;
    burn_rate_usd_per_hour: number;
  };
  usage_by_source: Record<
    string,
    { input_tokens: number; output_tokens: number; cost_usd: number }
  >;
  kill_switch: boolean;
  timeline: AuditEntry[];
  pm_summary: string;
}

export function buildDashboard(inputs: DashboardInputs): DashboardDto {
  const states = inputs.engine.states();

  // progress: weighted by complexity, moved ONLY by gate transitions
  let earned = 0;
  let total = 0;
  for (const [nodeId, state] of Object.entries(states)) {
    if (state === "cancelled" || state === "superseded") continue;
    const weight = COMPLEXITY_WEIGHT[inputs.complexityOf(nodeId)] ?? 2;
    total += weight;
    earned += weight * GATE_FRACTION[state];
  }
  const progressPct = total === 0 ? 0 : Math.round((earned / total) * 1000) / 10;

  // blocked reasons come from the engine's own lifecycle log
  const blocked: { node_id: string; reason: string }[] = [];
  for (const [nodeId, state] of Object.entries(states)) {
    if (state !== "blocked") continue;
    const lastBlock = [...inputs.engine.log]
      .reverse()
      .find((event) => event.node_id === nodeId && event.to === "blocked");
    blocked.push({ node_id: nodeId, reason: lastBlock?.reason ?? "unknown" });
  }

  // usage rollup by source label — never merged into one unlabeled number
  const bySource: DashboardDto["usage_by_source"] = {};
  for (const event of inputs.ledger) {
    const bucket = bySource[event.usage_source] ?? {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    bucket.input_tokens += event.input_tokens;
    bucket.output_tokens += event.output_tokens;
    bucket.cost_usd = Math.round((bucket.cost_usd + event.estimated_cost_usd) * 10000) / 10000;
    bySource[event.usage_source] = bucket;
  }

  // live burn rate from ledger timestamps
  let burnRate = 0;
  if (inputs.ledger.length >= 2) {
    const times = inputs.ledger.map((event) => Date.parse(event.occurred_at)).sort((a, b) => a - b);
    const first = times[0];
    const last = times[times.length - 1];
    const spanHours = first !== undefined && last !== undefined ? (last - first) / 3_600_000 : 0;
    const totalCost = inputs.ledger.reduce((sum, event) => sum + event.estimated_cost_usd, 0);
    burnRate = spanHours > 0 ? Math.round((totalCost / spanHours) * 100) / 100 : 0;
  }

  const reviewQueue = Object.entries(states)
    .filter(([, state]) => state === "in_review")
    .map(([nodeId]) => nodeId);
  const integrated = Object.values(states).filter((state) => state === "integrated").length;

  return {
    graph_version: inputs.graphVersion,
    nodes: states,
    blocked,
    review_queue: reviewQueue,
    progress_pct: progressPct,
    eta: { label: "experimental", value: null },
    cost: { ...inputs.budget.summary(), burn_rate_usd_per_hour: burnRate },
    usage_by_source: bySource,
    kill_switch: inputs.engine.killSwitchEngaged(),
    timeline: [...inputs.audit].slice(-(inputs.timelineLimit ?? 20)),
    pm_summary:
      `${integrated}/${Object.keys(states).length} nodes integrated, ` +
      `${reviewQueue.length} awaiting review, ${blocked.length} blocked` +
      `${inputs.engine.killSwitchEngaged() ? " — KILL SWITCH ENGAGED" : ""}.`,
  };
}

```

## A9: Sandbox launcher (fail-closed + policy args) — \`apps/server/src/engine/sandbox.ts\`

```ts
// Execution sandbox launcher (ADR-003): disposable OCI containers, fail
// CLOSED — if the sandbox substrate is unavailable, the run does not start,
// ever. Only the worktree and scratch are writable; network is deny-by-
// default; no container-management access inside; the runner brokers
// credentials and performs git push/fetch from outside.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`sandbox unavailable — failing closed, run will not start: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

export interface SandboxSpec {
  worktreePath: string;
  scratchPath: string;
  image: string;
  env: Record<string, string>; // explicit allowlist; nothing inherited
  readOnlyMounts?: Record<string, string>; // hostPath -> containerPath
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutSec?: number;
  command: string[];
}

/** Deterministic docker-run argument construction (unit-testable contract). */
export function buildDockerArgs(spec: SandboxSpec): string[] {
  const args = [
    "run",
    "--rm",
    "--network",
    "none", // deny by default; provider egress arrives via proxy in Phase 5
    "--pids-limit",
    String(spec.pidsLimit ?? 256),
    "--memory",
    spec.memory ?? "2g",
    "--cpus",
    spec.cpus ?? "1",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--mount",
    `type=bind,source=${spec.worktreePath},target=/worktree`,
    "--mount",
    `type=bind,source=${spec.scratchPath},target=/scratch`,
    "--workdir",
    "/worktree",
  ];
  for (const [host, container] of Object.entries(spec.readOnlyMounts ?? {})) {
    args.push("--mount", `type=bind,source=${host},target=${container},readonly`);
  }
  for (const [key, value] of Object.entries(spec.env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

export interface SandboxProbe {
  available(): Promise<{ ok: boolean; detail: string }>;
}

export class DockerProbe implements SandboxProbe {
  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
      return { ok: true, detail: "docker available" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "docker probe failed" };
    }
  }
}

export class SandboxLauncher {
  constructor(private readonly probe: SandboxProbe) {}

  /**
   * Fail-closed launch: probes the substrate first; if it is not available,
   * throws SandboxUnavailableError — there is no unsandboxed fallback path.
   */
  async launch(spec: SandboxSpec): Promise<{ args: string[]; stdout: string }> {
    const probe = await this.probe.available();
    if (!probe.ok) throw new SandboxUnavailableError(probe.detail);
    const args = buildDockerArgs(spec);
    const { stdout } = await run("docker", args, {
      timeout: (spec.timeoutSec ?? 300) * 1000,
    });
    return { args, stdout };
  }
}

```

## A10: Workflow engine (gates, kill switch, conflict-node registration) — \`apps/server/src/engine/workflow.ts\`

```ts
// The workflow engine (PRD R4 §Graph & Execution): an event-sourced wrapper
// over the pure contracts reducer. State is always derived by replaying the
// append-only lifecycle log — never mutated directly — so a persisted log
// reconstructs identical state (the 1B exit criterion). Approval gates and
// the kill switch are enforced here; no agent path bypasses them.
import {
  type ApprovalT,
  type BlockedReason,
  type LifecycleEventT,
  type NodeState,
  type PlanContractT,
  canTransition,
  reduceLifecycle,
} from "@norns/contracts";
import { BudgetExceededError, type BudgetLedger } from "./budget.js";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export class KillSwitchEngagedError extends EngineError {
  constructor() {
    super("kill switch engaged: dispatch refused, human action required to resume");
    this.name = "KillSwitchEngagedError";
  }
}

interface NodeMeta {
  dependencies: string[];
  blockedFrom: NodeState | null;
  activeReservation: string | null;
}

export interface EngineOptions {
  plan: PlanContractT;
  budget: BudgetLedger;
}

export class WorkflowEngine {
  readonly log: LifecycleEventT[] = [];
  private readonly meta = new Map<string, NodeMeta>();
  private readonly approvals = new Map<string, ApprovalT>();
  private readonly budget: BudgetLedger;
  private killSwitch = false;
  private eventCounter = 0;
  private started = false;

  constructor(options: EngineOptions) {
    this.budget = options.budget;
    for (const mod of options.plan.modules) {
      this.meta.set(mod.id, {
        dependencies: mod.dependencies,
        blockedFrom: null,
        activeReservation: null,
      });
    }
  }

  // -- approvals & kill switch --------------------------------------------------

  recordApproval(approval: ApprovalT): void {
    this.approvals.set(approval.kind, approval);
  }

  engageKillSwitch(): void {
    this.killSwitch = true;
  }

  /** Human action only (PRD: kill switch requires human action to resume). */
  disengageKillSwitch(): void {
    this.killSwitch = false;
  }

  killSwitchEngaged(): boolean {
    return this.killSwitch;
  }

  // -- graph mutations during execution (conflict nodes) -------------------------

  /** Register a node created after planning — e.g. a conflict-resolution node. */
  registerNode(nodeId: string, dependencies: readonly string[]): void {
    if (this.meta.has(nodeId)) throw new EngineError(`node ${nodeId} already exists`);
    this.meta.set(nodeId, {
      dependencies: [...dependencies],
      blockedFrom: null,
      activeReservation: null,
    });
    this.cascadeReady();
  }

  /** Rewire a dependent from the superseded node to its replacement. */
  replaceDependency(nodeId: string, oldDep: string, newDep: string): void {
    const meta = this.requireMeta(nodeId);
    meta.dependencies = meta.dependencies.map((dep) => (dep === oldDep ? newDep : dep));
  }

  dependenciesOf(nodeId: string): readonly string[] {
    return this.requireMeta(nodeId).dependencies;
  }

  nodeIds(): string[] {
    return [...this.meta.keys()];
  }

  // -- lifecycle drives -----------------------------------------------------------

  /** Approval gate: execution starts only with plan + allocation approvals. */
  start(): void {
    if (!this.approvals.has("plan") || !this.approvals.has("allocation")) {
      throw new EngineError("cannot start: plan and allocation approvals are required");
    }
    this.started = true;
    this.cascadeReady();
  }

  assign(nodeId: string): void {
    this.append(nodeId, "assigned");
  }

  /**
   * Budget gate: metering happens BEFORE dispatch via an atomic reservation.
   * Exceeding the budget blocks the node (`blocked: budget`) instead of
   * dispatching; the kill switch refuses outright.
   */
  startRun(nodeId: string, maxChargeUsd: number): { reservationId: string } {
    if (this.killSwitch) throw new KillSwitchEngagedError();
    const meta = this.requireMeta(nodeId);
    try {
      const reservationId = this.budget.reserve(nodeId, maxChargeUsd);
      meta.activeReservation = reservationId;
      this.append(nodeId, "running");
      return { reservationId };
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        this.block(nodeId, "budget");
        // a dispatch that would breach the project hard cap IS the kill-switch
        // threshold (PRD: auto-triggered by the project budget hard cap)
        if (error.scope === "project" || this.budget.projectHardCapReached()) {
          this.engageKillSwitch();
        }
      }
      throw error;
    }
  }

  /** Worker reported completion -> runner-executed verification begins. */
  completeRun(nodeId: string, actualUsd: number): void {
    const meta = this.requireMeta(nodeId);
    if (meta.activeReservation) {
      this.budget.settle(nodeId, meta.activeReservation, actualUsd);
      meta.activeReservation = null;
    }
    this.append(nodeId, "verifying");
  }

  /** Runner-produced verification result gates entry to review. */
  recordVerification(nodeId: string, passed: boolean): void {
    this.append(nodeId, passed ? "in_review" : "failed");
  }

  reviewerDecision(nodeId: string, decision: "approve" | "rework"): void {
    this.append(nodeId, decision === "approve" ? "verified" : "assigned");
  }

  /** Clean merge into the integration branch; unlocks dependents. */
  integrate(nodeId: string): void {
    this.append(nodeId, "integrated");
    this.cascadeReady();
  }

  block(nodeId: string, reason: BlockedReason): void {
    const meta = this.requireMeta(nodeId);
    meta.blockedFrom = this.stateOf(nodeId);
    this.append(nodeId, "blocked", reason);
  }

  /** Resume to the state the block interrupted (engine remembers which). */
  resume(nodeId: string): void {
    const meta = this.requireMeta(nodeId);
    if (!meta.blockedFrom) throw new EngineError(`node ${nodeId} is not blocked`);
    const target = meta.blockedFrom;
    meta.blockedFrom = null;
    this.append(nodeId, target);
  }

  cancel(nodeId: string): void {
    this.append(nodeId, "cancelled");
  }

  /** Conflict-resolution replacement: the original is archived, not deleted. */
  supersede(nodeId: string): void {
    this.append(nodeId, "superseded");
  }

  // -- state ------------------------------------------------------------------------

  stateOf(nodeId: string): NodeState {
    const reduced = reduceLifecycle(this.log);
    return reduced.nodes[nodeId]?.state ?? "pending";
  }

  states(): Record<string, NodeState> {
    const reduced = reduceLifecycle(this.log);
    const out: Record<string, NodeState> = {};
    for (const nodeId of this.meta.keys()) {
      out[nodeId] = reduced.nodes[nodeId]?.state ?? "pending";
    }
    return out;
  }

  /** Replaying the persisted log must reconstruct identical state. */
  replayFrom(log: readonly LifecycleEventT[]): Record<string, NodeState> {
    const reduced = reduceLifecycle(log);
    const out: Record<string, NodeState> = {};
    for (const [nodeId] of this.meta) {
      out[nodeId] = reduced.nodes[nodeId]?.state ?? "pending";
    }
    return out;
  }

  // -- internals ----------------------------------------------------------------------

  private requireMeta(nodeId: string): NodeMeta {
    const meta = this.meta.get(nodeId);
    if (!meta) throw new EngineError(`unknown node ${nodeId}`);
    return meta;
  }

  private append(nodeId: string, to: NodeState, reason?: string): void {
    this.requireMeta(nodeId);
    const from = this.stateOf(nodeId);
    if (!canTransition(from, to)) {
      throw new EngineError(`invalid transition ${from} -> ${to} for node ${nodeId}`);
    }
    this.eventCounter += 1;
    const event: LifecycleEventT = {
      event_id: `evt_${this.eventCounter}`,
      node_id: nodeId,
      to,
      ...(reason !== undefined ? { reason } : {}),
    };
    this.log.push(event);
  }

  /** Dependency gate: a node becomes ready only when every dep is integrated. */
  private cascadeReady(): void {
    if (!this.started) return;
    for (const [nodeId, meta] of this.meta) {
      if (this.stateOf(nodeId) !== "pending") continue;
      const depsIntegrated = meta.dependencies.every((dep) => this.stateOf(dep) === "integrated");
      if (depsIntegrated) this.append(nodeId, "ready");
    }
  }
}

```
