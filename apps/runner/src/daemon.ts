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
  TERMINAL_COMMAND_STATES,
  type V2DispatchCommandT,
  isCommandExpired,
  parseServerFrame,
} from "@norns/contracts";
import WebSocket from "ws";
import { FixtureExecutor } from "./fixture.js";
import { RelayInferenceClient } from "./inferenceClient.js";
import { type LiveControlKind, LiveRunRegistry } from "./liveRuns.js";
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
  /**
   * ONBOARDING O4 — fires once when a `launch_run` command reaches a terminal
   * state. Additive: laptop runners simply do not supply it and behave exactly
   * as before. The ephemeral GitHub Actions runner uses it to exit as soon as
   * the one job it was created for is finished.
   */
  onRunSettled?: (settled: { command_id: string; state: CommandStateT }) => void;
}

export class RunnerDaemon {
  private readonly opts: Required<
    Omit<DaemonOptions, "executeV2" | "workspaces" | "onRunSettled">
  > &
    Pick<DaemonOptions, "executeV2" | "workspaces" | "onRunSettled">;
  /** ONBOARDING O4: launch_run commands awaiting a terminal ack. */
  private readonly launchCommands = new Set<string>();
  private settledReported = false;
  private stateFile: RunnerStateFile | null = null;
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fenced = false;
  private readonly executor: FixtureExecutor;
  private serverAckSeq = 0;
  readonly redactor = new Redactor();
  /**
   * EXECUTION E3 — proxied model inference. Always constructed (it is inert
   * until something calls it) so the runtimes can be handed a client without
   * the daemon needing to know whether this deployment enables the proxy; the
   * server refuses with `unsupported` if it does not.
   */
  readonly inference: RelayInferenceClient;
  /**
   * EXECUTION E11 — the live V2 runs this daemon can actually control.
   *
   * Owned here, exposed like `inference`, and handed to the V2 executor by the
   * CLI. Before E11 every control command in `handleCommand` went to
   * `this.executor`, the Phase 1A demo fixture, which never holds a real coding
   * run: cancel, interrupt, suspend and resume all reached a scripted counter
   * while the actual agent kept spending. Controls now consult this registry
   * FIRST and fall through to the fixture only for runs it has never heard of,
   * so the demo path is untouched.
   */
  readonly liveRuns = new LiveRunRegistry();

  constructor(options: DaemonOptions) {
    this.opts = {
      heartbeatMs: 2000,
      reconnect: true,
      reconnectDelayMs: 150,
      ...options,
    };
    this.executor = new FixtureExecutor((payload, meta) => this.emit(payload, meta));
    this.inference = new RelayInferenceClient({
      send: (request) => {
        // The generation travels with every frame, so a fenced runner's
        // request is refused server-side rather than silently spending.
        if (!this.connected || this.fenced || !this.stateFile) return false;
        this.socket?.send(
          JSON.stringify({
            type: "inference_request",
            generation: this.requireState().state.generation,
            request,
          }),
        );
        return true;
      },
    });
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

  /**
   * EXECUTION E3 — sign a domain-separated payload with the runner's existing
   * relay keypair, for authenticating outbound HTTP (context fetches) to the
   * same server this socket talks to.
   *
   * Exposed as a signing operation rather than as a key accessor on purpose:
   * the private key never leaves this object, so no other component can log,
   * persist, or forward it. Callers must domain-separate their payloads (see
   * contextAuth.ts) so a signature minted for one purpose cannot be replayed
   * as another — this method deliberately does not add a prefix itself, since
   * doing so here would silently break the relay's own challenge signing if it
   * were ever routed through the same path.
   */
  sign(payload: string): string {
    return edSign(
      null,
      Buffer.from(payload, "utf8"),
      this.requireState().state.private_key_pem,
    ).toString("base64");
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

  /**
   * ONBOARDING O4 — one-shot enrollment for an ephemeral runner hosted in a
   * GitHub Actions job.
   *
   * This is `pair()` for a machine that will not exist in ten minutes. It is
   * deliberately the same shape: generate a fresh Ed25519 keypair here, send
   * only the public half, and receive the generation the relay expects. The
   * difference is the credential presented — a repository-scoped enrollment
   * token instead of a human-typed pairing code — and that the enrollment is
   * bound to one dispatch job the server already decided to run, so it is
   * single-use rather than an open invitation to join the relay.
   *
   * The token is read from the caller's argument and never persisted, logged,
   * or emitted; only the private key reaches the (job-lifetime) state dir.
   */
  async enroll(input: { enrollmentToken: string; dispatchJobId: string }): Promise<void> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const res = await fetch(`${this.opts.serverUrl}/api/actions/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_token: input.enrollmentToken,
        runner_id: this.opts.runnerId,
        dispatch_job_id: input.dispatchJobId,
        public_key_pem: publicPem,
      }),
    });
    if (!res.ok) {
      // Deliberately does not echo the response body: an enrollment failure
      // must not become a channel for leaking why it failed into a CI log.
      throw new Error(`enrollment rejected (${res.status})`);
    }
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
                // EXECUTION E3 adds model_proxy. Advertised unconditionally:
                // it costs nothing if the server does not offer it.
                capabilities: ["workspace_picker", "model_proxy"],
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
          this.inference.abortAll("runner generation fenced");
          this.executor.cancelAll();
          this.liveRuns.cancelAll("runner generation fenced");
          this.stopHeartbeat();
          socket.close();
          break;
        }
        case "inference_response": {
          // EXECUTION E3. Generation-checked like every other frame: a
          // response minted for a superseded generation is not ours.
          if (frame.generation === state.state.generation) {
            this.inference.receive(frame.response);
          }
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
      // EXECUTION E3 — never leave a runtime awaiting a completion that can no
      // longer arrive; it would burn the job's whole timeout doing nothing.
      this.inference.abortAll();
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
    this.inference.abortAll("runner stopped");
    this.executor.cancelAll();
    this.liveRuns.cancelAll("runner stopped");
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
      this.inference.abortAll("runner generation fenced");
      this.executor.cancelAll();
      this.liveRuns.cancelAll("runner generation fenced");
      this.stopHeartbeat();
      this.socket?.close(1008, "runner generation fenced");
      return;
    }
    // ONBOARDING O4: registered before any ack so that a replayed, already
    // terminal launch_run still settles an ephemeral host rather than leaving
    // it connected until its job times out.
    if (command.payload.kind === "launch_run") this.launchCommands.add(command.command_id);
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
      // EXECUTION E11 — every control now asks the live V2 run first.
      case "interrupt":
      case "resume_session":
      case "suspend":
      case "stop_after_current":
      case "cancel":
      case "send_message":
        void this.routeControl(
          payload.kind,
          payload.run_id,
          payload.kind === "send_message" ? payload.message : undefined,
          command.command_id,
          meta,
        );
        return;
      default:
        // run_verification has no runner-side implementation.
        state.recordExecution(command.command_id, "rejected");
        this.ack(command.command_id, "rejected", meta, "run_verification is not implemented here");
        return;
    }
    state.recordExecution(command.command_id, "succeeded");
    this.ack(command.command_id, "succeeded", meta);
  }

  /**
   * EXECUTION E11 — deliver a control to whichever executor actually owns the
   * run.
   *
   * Order matters and is not arbitrary. The live registry is asked first and is
   * allowed to decline only by never having seen the run id; anything it *has*
   * seen — including a run that finished ten seconds ago — it answers for. Only
   * an id it has never heard of falls through to the Phase 1A fixture, which is
   * how the existing demo and its relay tests keep behaving exactly as before.
   *
   * Nothing here is silently successful. A refusal is acked as `rejected` with
   * the reason attached AND streamed as a `run_log`, because the command ack is
   * a protocol detail while the run log is where a human is actually looking.
   */
  private async routeControl(
    kind: LiveControlKind,
    runId: string,
    message: string | undefined,
    commandId: string,
    meta: { correlation?: string; causation?: string },
  ): Promise<void> {
    const state = this.requireState();
    const settle = (ackState: CommandStateT, detail: string, visible: boolean): void => {
      if (visible) this.emit({ kind: "run_log", run_id: runId, chunk: detail }, meta);
      state.recordExecution(commandId, ackState);
      this.ack(commandId, ackState, meta, detail);
    };
    try {
      const live = await this.liveRuns.control(runId, kind, { ...(message ? { message } : {}) });
      if (live) {
        settle(live.state, live.detail, !live.applied);
        return;
      }
      if (!this.executor.isActive(runId)) {
        // Neither a live coding run nor a fixture run. The old code called a
        // no-op on the fixture and acked `succeeded`, so a control aimed at a
        // run this runner has never executed reported success. It did not.
        settle("rejected", `run ${runId} is not running on this runner`, false);
        return;
      }
      switch (kind) {
        case "interrupt":
          this.executor.interrupt(runId);
          break;
        case "resume_session":
          this.executor.resume(runId);
          break;
        case "suspend":
          this.executor.interrupt(runId); // fixture capability matrix: suspend == pause
          break;
        case "stop_after_current":
          this.executor.stopAfterCurrent(runId);
          break;
        case "cancel":
          this.executor.cancel(runId);
          break;
        case "send_message":
          settle("rejected", "the fixture executor cannot receive a message", true);
          return;
      }
      settle("succeeded", "", false);
    } catch (error) {
      settle(
        "failed",
        `the ${kind} could not be applied to run ${runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
  }

  private ack(
    commandId: string,
    ackState: CommandStateT,
    meta: { correlation?: string; causation?: string },
    detail = "",
  ): void {
    this.emit({ kind: "command_ack", command_id: commandId, state: ackState, detail }, meta);
    // ONBOARDING O4: report the first terminal outcome of a launch_run so an
    // ephemeral host can shut down. Reported at most once, and only when a
    // caller asked for it.
    if (
      this.opts.onRunSettled &&
      !this.settledReported &&
      this.launchCommands.has(commandId) &&
      TERMINAL_COMMAND_STATES.has(ackState)
    ) {
      this.settledReported = true;
      this.opts.onRunSettled({ command_id: commandId, state: ackState });
    }
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
