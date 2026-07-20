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
  type V2DispatchCommandT,
  isCommandExpired,
  parseServerFrame,
} from "@norns/contracts";
import WebSocket from "ws";
import { FixtureExecutor } from "./fixture.js";
import { Redactor } from "./redact.js";
import { RunnerStateFile } from "./state.js";
import type { WorkspaceRegistry } from "./workspaceRegistry.js";

export interface DaemonOptions {
  serverUrl: string; // http://host:port
  runnerId: string;
  dataDir: string;
  heartbeatMs?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  executeV2?: (
    command: V2DispatchCommandT,
    emit: (event: EventPayloadT) => void,
  ) => Promise<"succeeded" | "failed" | "cancelled">;
  /** Optional runner-local folder registry.  Paths never enter relay frames. */
  workspaces?: WorkspaceRegistry;
}

export class RunnerDaemon {
  private readonly opts: Required<Omit<DaemonOptions, "executeV2" | "workspaces">> &
    Pick<DaemonOptions, "executeV2" | "workspaces">;
  private stateFile: RunnerStateFile | null = null;
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fenced = false;
  private readonly executor: FixtureExecutor;
  private serverAckSeq = 0;
  readonly redactor = new Redactor();

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

  get generation(): number {
    return this.requireState().state.generation;
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
                capabilities: ["workspace_picker"],
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
        case "workspace_request": {
          if (frame.generation !== state.state.generation) {
            socket.send(
              JSON.stringify({
                type: "workspace_response",
                generation: state.state.generation,
                response: {
                  request_id: frame.request.request_id,
                  operation: frame.request.operation,
                  status: "unavailable",
                },
              }),
            );
            break;
          }
          if (!this.opts.workspaces) {
            socket.send(
              JSON.stringify({
                type: "workspace_response",
                generation: state.state.generation,
                response: {
                  request_id: frame.request.request_id,
                  operation: frame.request.operation,
                  status: "unavailable",
                },
              }),
            );
            break;
          }
          // Native selection is asynchronous so the runner can keep its relay
          // connection alive while the operating-system dialog is open.
          // WorkspaceRegistry converts every failure to a stable code and no
          // local pathname or operating-system message crosses this socket.
          void this.opts.workspaces.handleAsync(frame.request).then((response) => {
            if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
            socket.send(
              JSON.stringify({
                type: "workspace_response",
                generation: state.state.generation,
                response,
              }),
            );
          });
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
    if (command.runner_id !== this.opts.runnerId || command.generation !== state.state.generation) {
      this.fenced = true;
      this.executor.cancelAll();
      this.stopHeartbeat();
      this.socket?.close(1008, "runner generation fenced");
      return;
    }
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
      case "launch_run":
        if (!payload.dispatch || !this.opts.executeV2) {
          state.recordExecution(command.command_id, "rejected");
          this.ack(command.command_id, "rejected", meta);
          return;
        }
        void this.opts
          .executeV2(payload.dispatch, (event) => this.emit(event, meta))
          .then((outcome) => {
            state.recordExecution(command.command_id, outcome);
            this.ack(command.command_id, outcome, meta);
          })
          .catch((error) => {
            this.emit(
              {
                kind: "run_log",
                run_id: payload.dispatch?.run_id ?? payload.run_id,
                chunk: `runner execution failed: ${error instanceof Error ? error.message : String(error)}`,
              },
              meta,
            );
            state.recordExecution(command.command_id, "failed");
            this.ack(command.command_id, "failed", meta);
          });
        return;
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
        // send_message / run_verification require a live runtime session.
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
    // redaction happens BEFORE buffering: secrets never persist, never leave
    const safePayload: EventPayloadT =
      payload.kind === "run_log"
        ? { ...payload, chunk: this.redactor.redact(payload.chunk) }
        : payload;
    const state = this.requireState();
    const event: EventEnvelopeT = {
      protocol: PROTOCOL_VERSION as 1,
      event_seq: state.nextSeq(),
      runner_id: this.opts.runnerId,
      generation: state.state.generation,
      correlation_id: meta.correlation ?? `runner:${this.opts.runnerId}`,
      causation_id: meta.causation ?? null,
      occurred_at: new Date().toISOString(),
      payload: safePayload,
    };
    state.bufferEvent(event);
    if (this.connected) {
      this.socket?.send(JSON.stringify({ type: "event", event }));
    }
  }
}
