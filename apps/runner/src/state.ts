// Durable runner state (PRD R4 §Runner Protocol): the disk-backed event
// buffer (replayed after disconnects) and the command-dedup record (replays
// must not execute twice). Synchronous JSON writes are sufficient at runner
// scale; the file is the durability boundary the acceptance tests exercise.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandStateT, EventEnvelopeT } from "@norns/contracts";

export interface RunnerPersistedState {
  runner_id: string;
  private_key_pem: string;
  generation: number;
  seq: number;
  buffer: EventEnvelopeT[]; // events not yet acked by the server
  executed: Record<string, CommandStateT>; // command_id -> last acked state
}

export class RunnerStateFile {
  private readonly path: string;
  state: RunnerPersistedState;

  constructor(dataDir: string, initial: Omit<RunnerPersistedState, "seq" | "buffer" | "executed">) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "runner-state.json");
    if (existsSync(this.path)) {
      this.state = JSON.parse(readFileSync(this.path, "utf8")) as RunnerPersistedState;
    } else {
      this.state = { ...initial, seq: 0, buffer: [], executed: {} };
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
}
