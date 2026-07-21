// Relay state with durable-row semantics (PRD R4 §Runner Protocol, ADR-002):
// the command outbox, per-runner event log + watermark, runner registry, and
// the append-only audit trail. This in-memory implementation is the reference
// for the Postgres adapter (gated on NORN-008); `snapshot()`/`restore()` model
// durability so the server-restart acceptance test recovers from persisted
// state, never process memory.
import {
  type CommandEnvelopeT,
  type CommandStateT,
  type EventEnvelopeT,
  TERMINAL_COMMAND_STATES,
  canCommandTransition,
  isCommandExpired,
} from "@norns/contracts";

export interface RunnerRecord {
  runner_id: string;
  public_key_pem: string;
  generation: number;
  last_seen_at: string | null;
}

export interface CommandRecord {
  envelope: CommandEnvelopeT;
  state: CommandStateT;
  updated_at: string;
  // conflict rule: a terminal ack that lost the race is recorded, not applied
  superseded_terminal: CommandStateT | null;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface PairingRecord {
  code: string;
  expires_at: string;
}

interface StoreState {
  runners: Record<string, RunnerRecord>;
  commands: Record<string, CommandRecord>;
  eventsByRunner: Record<string, EventEnvelopeT[]>;
  watermark: Record<string, number>;
  audit: AuditEntry[];
  pairings: Record<string, PairingRecord>;
  killSwitch: boolean;
}

export type IngestOutcome = "accepted" | "duplicate" | "out_of_order";

export class RelayStores {
  private state: StoreState;

  constructor(initial?: StoreState) {
    this.state = initial ?? {
      runners: {},
      commands: {},
      eventsByRunner: {},
      watermark: {},
      audit: [],
      pairings: {},
      killSwitch: false,
    };
  }

  /** Serialize durable state; the restart test recovers a server from this. */
  snapshot(): string {
    return JSON.stringify(this.state);
  }

  static restore(json: string): RelayStores {
    return new RelayStores(JSON.parse(json) as StoreState);
  }

  // -- audit ----------------------------------------------------------------

  audit(actor: string, action: string, detail: string, now: Date): void {
    this.state.audit.push({ at: now.toISOString(), actor, action, detail });
  }

  auditEntries(): readonly AuditEntry[] {
    return this.state.audit;
  }

  // -- pairing / runners ----------------------------------------------------

  createPairing(code: string, expiresAt: Date): void {
    this.state.pairings[code] = { code, expires_at: expiresAt.toISOString() };
  }

  consumePairing(code: string, now: Date): boolean {
    const record = this.state.pairings[code];
    if (!record) return false;
    delete this.state.pairings[code];
    return Date.parse(record.expires_at) > now.getTime();
  }

  registerRunner(runnerId: string, publicKeyPem: string): RunnerRecord {
    const existing = this.state.runners[runnerId];
    const record: RunnerRecord = {
      runner_id: runnerId,
      public_key_pem: publicKeyPem,
      generation: (existing?.generation ?? 0) + 1, // re-pair fences the old runner
      last_seen_at: null,
    };
    this.state.runners[runnerId] = record;
    return record;
  }

  /**
   * ONBOARDING O4 — reserve the generation an ephemeral GitHub Actions runner
   * will enroll at, *before* the job that will occupy it exists.
   *
   * A laptop runner pairs first and is scheduled second, so its generation is
   * known when the command is built. An Actions runner is the other way round:
   * the job cannot exist until Norns dispatches it, and Norns cannot dispatch
   * until a run is scheduled. Reserving the generation up front lets the
   * command be built with the generation the job will later prove it owns,
   * instead of re-stamping a queued command after the fact.
   *
   * The reserved record deliberately carries an EMPTY public key: it fences the
   * previous generation immediately, and until `enrollRunnerAtGeneration`
   * supplies a real key nothing can authenticate as this runner
   * (`verifyRunnerSignature` fails closed on an unparseable key).
   */
  reserveRunnerGeneration(runnerId: string): number {
    const existing = this.state.runners[runnerId];
    const record: RunnerRecord = {
      runner_id: runnerId,
      public_key_pem: "",
      generation: (existing?.generation ?? 0) + 1,
      last_seen_at: null,
    };
    this.state.runners[runnerId] = record;
    return record.generation;
  }

  /**
   * ONBOARDING O4 — complete a reservation by binding the ephemeral runner's
   * freshly generated public key to the generation that was reserved for it.
   *
   * Returns false when the reservation has moved on (a newer generation was
   * reserved, or the runner re-paired). The caller must treat that as a
   * rejected enrollment: a job whose generation has been superseded has already
   * lost its claim and must not be handed a live runner identity.
   */
  enrollRunnerAtGeneration(
    runnerId: string,
    publicKeyPem: string,
    generation: number,
  ): RunnerRecord | null {
    const record = this.state.runners[runnerId];
    if (!record || record.generation !== generation) return null;
    record.public_key_pem = publicKeyPem;
    return record;
  }

  runner(runnerId: string): RunnerRecord | undefined {
    return this.state.runners[runnerId];
  }

  runners(): RunnerRecord[] {
    return Object.values(this.state.runners);
  }

  markSeen(runnerId: string, now: Date): void {
    const record = this.state.runners[runnerId];
    if (record) record.last_seen_at = now.toISOString();
  }

  /**
   * Security control (PRD §Remote Control): bump the generation so every
   * connection holding the old generation is fenced off on its next frame.
   */
  revokeRunnerSessions(runnerId: string): number {
    const record = this.state.runners[runnerId];
    if (!record) throw new Error(`unknown runner ${runnerId}`);
    record.generation += 1;
    return record.generation;
  }

  // -- command outbox ---------------------------------------------------------

  enqueueCommand(envelope: CommandEnvelopeT, now: Date): CommandRecord {
    const record: CommandRecord = {
      envelope,
      state: "queued",
      updated_at: now.toISOString(),
      superseded_terminal: null,
    };
    this.state.commands[envelope.command_id] = record;
    return record;
  }

  command(commandId: string): CommandRecord | undefined {
    return this.state.commands[commandId];
  }

  /**
   * Apply a state change through the command state machine. Terminal states
   * commit first; a losing terminal ack is recorded as superseded_terminal.
   */
  setCommandState(commandId: string, to: CommandStateT, now: Date): CommandRecord | undefined {
    const record = this.state.commands[commandId];
    if (!record) return undefined;
    if (record.state === to) return record; // idempotent replayed ack
    if (TERMINAL_COMMAND_STATES.has(record.state)) {
      if (TERMINAL_COMMAND_STATES.has(to)) record.superseded_terminal = to;
      return record;
    }
    if (!canCommandTransition(record.state, to)) return record;
    record.state = to;
    record.updated_at = now.toISOString();
    return record;
  }

  /** Outbox rows to (re)send: queued or delivered-but-unfinished, unexpired. */
  pendingCommandsFor(
    runnerId: string,
    executedCommandIds: ReadonlySet<string>,
    now: Date,
  ): CommandEnvelopeT[] {
    const pending: CommandEnvelopeT[] = [];
    for (const record of Object.values(this.state.commands)) {
      if (record.envelope.runner_id !== runnerId) continue;
      if (record.state !== "queued" && record.state !== "delivered") continue;
      if (executedCommandIds.has(record.envelope.command_id)) continue;
      if (isCommandExpired(record.envelope, now)) {
        this.setCommandState(record.envelope.command_id, "expired", now);
        continue;
      }
      pending.push(record.envelope);
    }
    return pending.sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  }

  // -- runner event log -------------------------------------------------------

  eventWatermark(runnerId: string): number {
    return this.state.watermark[runnerId] ?? 0;
  }

  /** Contiguous-sequence ingestion: duplicates are no-ops, gaps force resync. */
  ingestEvent(event: EventEnvelopeT): IngestOutcome {
    const watermark = this.eventWatermark(event.runner_id);
    if (event.event_seq <= watermark) return "duplicate";
    if (event.event_seq !== watermark + 1) return "out_of_order";
    const log = this.state.eventsByRunner[event.runner_id] ?? [];
    log.push(event);
    this.state.eventsByRunner[event.runner_id] = log;
    this.state.watermark[event.runner_id] = event.event_seq;
    return "accepted";
  }

  eventsFor(runnerId: string): readonly EventEnvelopeT[] {
    return this.state.eventsByRunner[runnerId] ?? [];
  }

  // -- kill switch ------------------------------------------------------------

  killSwitchEngaged(): boolean {
    return this.state.killSwitch;
  }

  setKillSwitch(engaged: boolean): void {
    this.state.killSwitch = engaged;
  }
}
