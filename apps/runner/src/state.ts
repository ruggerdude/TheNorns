// Durable runner state (PRD R4 §Runner Protocol): the disk-backed event
// buffer (replayed after disconnects) and the command-dedup record (replays
// must not execute twice). Synchronous JSON writes are sufficient at runner
// scale; the file is the durability boundary the acceptance tests exercise.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandStateT, type EventEnvelopeT, TERMINAL_COMMAND_STATES } from "@norns/contracts";

export interface RunnerPersistedState {
  runner_id: string;
  private_key_pem: string;
  generation: number;
  seq: number;
  buffer: EventEnvelopeT[]; // events not yet acked by the server
  executed: Record<string, CommandStateT>; // command_id -> last acked state
  // A durable tombstone survives server acknowledgement/pruning. Without it,
  // a duplicate command received after pruning could synthesize a fresh
  // terminal acknowledgement on every delivery.
  terminal_acks: Record<string, number>; // command_id -> original event_seq
}

export class RunnerStateFile {
  private readonly path: string;
  state: RunnerPersistedState;

  constructor(
    dataDir: string,
    initial: Omit<RunnerPersistedState, "seq" | "buffer" | "executed" | "terminal_acks">,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "runner-state.json");
    if (existsSync(this.path)) {
      const loaded = JSON.parse(readFileSync(this.path, "utf8")) as Omit<
        RunnerPersistedState,
        "terminal_acks"
      > & { terminal_acks?: Record<string, number> };
      const inferredTerminalAcks: Record<string, number> = {};
      for (const event of loaded.buffer) {
        if (
          event.payload.kind === "command_ack" &&
          TERMINAL_COMMAND_STATES.has(event.payload.state)
        ) {
          inferredTerminalAcks[event.payload.command_id] = event.event_seq;
        }
      }
      this.state = {
        ...loaded,
        terminal_acks: loaded.terminal_acks ?? inferredTerminalAcks,
      };
      if (!loaded.terminal_acks) this.persist();
    } else {
      this.state = { ...initial, seq: 0, buffer: [], executed: {}, terminal_acks: {} };
      this.persist();
    }
  }

  persist(): void {
    writeFileSync(this.path, JSON.stringify(this.state));
  }

  nextSeq(): number {
    this.state.seq += 1;
    this.persist();
    return this.state.seq;
  }

  bufferEvent(event: EventEnvelopeT): void {
    this.state.buffer.push(event);
    this.persist();
  }

  pruneAcked(ackSeq: number): void {
    const before = this.state.buffer.length;
    this.state.buffer = this.state.buffer.filter((e) => e.event_seq > ackSeq);
    if (this.state.buffer.length !== before) this.persist();
  }

  unackedSince(ackSeq: number): EventEnvelopeT[] {
    return this.state.buffer.filter((e) => e.event_seq > ackSeq);
  }

  recordExecution(commandId: string, state: CommandStateT): void {
    this.state.executed[commandId] = state;
    this.persist();
  }

  executionState(commandId: string): CommandStateT | undefined {
    return this.state.executed[commandId];
  }

  executedIds(): string[] {
    return Object.keys(this.state.executed);
  }

  terminalExecutions(): Array<[commandId: string, state: CommandStateT]> {
    return Object.entries(this.state.executed).filter((entry) =>
      TERMINAL_COMMAND_STATES.has(entry[1]),
    );
  }

  /**
   * Ensure one durable terminal acknowledgement for a command.
   *
   * `recordExecution()` and the historical `emit()` path used separate file
   * writes. A crash between them left a terminal command with no acknowledgement
   * and replay suppression then hid it forever. This method checks for an
   * existing buffered acknowledgement, respects a pruned acknowledgement's
   * tombstone, or creates the missing envelope with sequence + buffer +
   * tombstone committed in one write.
   */
  ensureTerminalAck(input: {
    command_id: string;
    state: CommandStateT;
    runner_id: string;
    generation: number;
    correlation_id: string;
    causation_id: string | null;
    occurred_at: string;
    detail: string;
  }): { event: EventEnvelopeT | null; created: boolean } {
    if (!TERMINAL_COMMAND_STATES.has(input.state)) {
      throw new Error(`cannot persist nonterminal acknowledgement ${input.state}`);
    }
    const existing = this.state.buffer.find(
      (event) =>
        event.payload.kind === "command_ack" &&
        event.payload.command_id === input.command_id &&
        TERMINAL_COMMAND_STATES.has(event.payload.state),
    );
    if (existing) {
      if (this.state.terminal_acks[input.command_id] === undefined) {
        this.state.terminal_acks[input.command_id] = existing.event_seq;
        this.persist();
      }
      return { event: existing, created: false };
    }
    if (this.state.terminal_acks[input.command_id] !== undefined) {
      return { event: null, created: false };
    }

    const event: EventEnvelopeT = {
      protocol: 1,
      event_seq: this.state.seq + 1,
      runner_id: input.runner_id,
      generation: input.generation,
      correlation_id: input.correlation_id,
      causation_id: input.causation_id,
      occurred_at: input.occurred_at,
      payload: {
        kind: "command_ack",
        command_id: input.command_id,
        state: input.state,
        detail: input.detail,
      },
    };
    this.state.seq = event.event_seq;
    this.state.buffer.push(event);
    this.state.terminal_acks[input.command_id] = event.event_seq;
    this.persist();
    return { event, created: true };
  }
}
