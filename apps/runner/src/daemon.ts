// The Local Runner daemon: pairs once (Ed25519 keypair), then maintains an
// outbound-only WebSocket to the relay. Survives disconnects: events buffer
// on disk and replay from the server's watermark; replayed commands never
// execute twice (durable dedup); a stale generation fences the daemon off.
import { sign as edSign, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  type CommandEnvelopeT,
  type CommandStateT,
  type EventEnvelopeT,
  type EventPayloadT,
  LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
  PROTOCOL_VERSION,
  type ReconcileResponseT,
  type RunnerInferenceResponseT,
  type RunnerWorkspaceRepositoryT,
  type RunnerWorkspaceRequestT,
  TERMINAL_COMMAND_STATES,
  type V2DispatchCommandT,
  canonicalLegacyRunnerWssAuthenticationTranscript,
  isCommandExpired,
  parseServerFrame,
} from "@norns/contracts";
import WebSocket from "ws";
import {
  type DeviceCancellationStopResult,
  DeviceControlConnection,
} from "./deviceControlConnection.js";
import type { DeviceWssIdentity } from "./deviceWssAuth.js";
import { FixtureExecutor } from "./fixture.js";
import { RelayInferenceClient } from "./inferenceClient.js";
import { type LiveControlKind, LiveRunRegistry } from "./liveRuns.js";
import { Redactor } from "./redact.js";
import { RunnerStateFile } from "./state.js";
import type { WorkspaceRegistry } from "./workspaceRegistry.js";

const RUNNER_EVENT_SEND_WINDOW = 32;

export interface DaemonOptions {
  serverUrl: string; // http://host:port
  runnerId: string;
  dataDir: string;
  heartbeatMs?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  /** Bound for local stop confirmation; late proof remains subscribed. */
  liveRunConfirmationTimeoutMs?: number;
  executeV2?: (
    command: V2DispatchCommandT,
    emit: (event: EventPayloadT) => void,
    capabilities: { knowledge_transport: boolean },
  ) => Promise<"succeeded" | "waiting_for_human" | "failed" | "cancelled">;
  collectVisualEvidence?: (
    command: Extract<CommandEnvelopeT["payload"], { kind: "collect_visual_evidence" }>,
  ) => Promise<void>;
  /** Optional runner-local folder registry.  Paths never enter relay frames. */
  workspaces?: WorkspaceRegistry;
  /** Register a freshly selected repository under the active device identity. */
  registerWorkspace?: (
    repository: RunnerWorkspaceRepositoryT,
  ) => Promise<{ registration_id: string | null }>;
  /**
   * ONBOARDING O4 — fires once when a `launch_run` command reaches a terminal
   * state. Additive: laptop runners simply do not supply it and behave exactly
   * as before. The ephemeral GitHub Actions runner uses it to exit as soon as
   * the one job it was created for is finished.
   */
  onRunSettled?: (settled: { command_id: string; state: CommandStateT }) => void;
  /**
   * Explicit enrolled-device cancellation channel. General device execution
   * is still disabled; this separate authenticated socket receives only
   * cancellation and generation-fence control.
   */
  deviceControl?: {
    identity: DeviceWssIdentity;
    sign(canonicalTranscript: string): string;
    agentVersion?: string;
    capabilities?: readonly string[];
    /** Independent dispatch kill switch; cancellation does not imply this. */
    execution?: boolean;
    /** Explicit deprecated local runner transport; never implied by control. */
    legacyLocalCompatibility?: boolean;
    reconnect?: boolean;
    reconnectDelayMs?: number;
    evidenceRetryMs?: number;
  };
}

export class RunnerDaemon {
  private readonly opts: Required<
    Omit<
      DaemonOptions,
      | "executeV2"
      | "collectVisualEvidence"
      | "workspaces"
      | "registerWorkspace"
      | "onRunSettled"
      | "deviceControl"
    >
  > &
    Pick<
      DaemonOptions,
      | "executeV2"
      | "collectVisualEvidence"
      | "workspaces"
      | "registerWorkspace"
      | "onRunSettled"
      | "deviceControl"
    >;
  /** ONBOARDING O4: launch_run commands awaiting a terminal ack. */
  private readonly launchCommands = new Set<string>();
  /**
   * Command ids currently executing in THIS process. Empty on a fresh start,
   * so it distinguishes an orphaned durable `executing` entry (process died
   * mid-run, nothing will settle it) from a genuinely live run seen across a
   * mere reconnect. See the orphan reap in handleReconcileResponse.
   */
  private readonly inFlightCommands = new Set<string>();
  private settledReported = false;
  private stateFile: RunnerStateFile | null = null;
  private readonly deviceStateFile: RunnerStateFile | null;
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fenced = false;
  private executionPaused = false;
  private highestEventSeqSent = 0;
  private readonly executor: FixtureExecutor;
  private serverAckSeq = 0;
  private knowledgeTransportEnabled = false;
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
  readonly liveRuns: LiveRunRegistry;
  private readonly deviceControl: DeviceControlConnection | null;

  constructor(options: DaemonOptions) {
    this.opts = {
      heartbeatMs: 2000,
      reconnect: true,
      reconnectDelayMs: 150,
      liveRunConfirmationTimeoutMs: 10_000,
      ...options,
    };
    this.liveRuns = new LiveRunRegistry(this.opts.liveRunConfirmationTimeoutMs);
    this.deviceStateFile = this.opts.deviceControl
      ? new RunnerStateFile(join(this.opts.dataDir, "device-execution"), {
          runner_id: this.opts.deviceControl.identity.device_id,
          private_key_pem: "",
          generation: this.opts.deviceControl.identity.generation,
        })
      : null;
    if (
      this.deviceStateFile &&
      this.opts.deviceControl &&
      (this.deviceStateFile.state.runner_id !== this.opts.deviceControl.identity.device_id ||
        this.deviceStateFile.state.generation !== this.opts.deviceControl.identity.generation)
    ) {
      throw new Error("device execution state identity does not match the active installation");
    }
    this.executor = new FixtureExecutor((payload, meta) => this.emit(payload, meta));
    this.inference = new RelayInferenceClient({
      send: (request) => {
        // The generation travels with every frame, so a fenced runner's
        // request is refused server-side rather than silently spending.
        if (!this.connected || this.fenced) return false;
        const frame = {
          type: "inference_request" as const,
          generation: this.requireState().state.generation,
          request,
        };
        return this.deviceExecutionEnabled
          ? (this.deviceControl?.sendExecutionFrame(frame) ?? false)
          : this.sendLegacyFrame(frame);
      },
    });
    this.deviceControl = this.opts.deviceControl
      ? new DeviceControlConnection({
          serverUrl: this.opts.serverUrl,
          dataDir: this.opts.dataDir,
          identity: this.opts.deviceControl.identity,
          ...(this.opts.deviceControl.agentVersion !== undefined
            ? { agentVersion: this.opts.deviceControl.agentVersion }
            : {}),
          ...(this.opts.deviceControl.capabilities !== undefined
            ? { capabilities: this.opts.deviceControl.capabilities }
            : {}),
          sign: this.opts.deviceControl.sign,
          ...(this.opts.deviceControl.reconnect !== undefined
            ? { reconnect: this.opts.deviceControl.reconnect }
            : {}),
          ...(this.opts.deviceControl.reconnectDelayMs !== undefined
            ? { reconnectDelayMs: this.opts.deviceControl.reconnectDelayMs }
            : {}),
          ...(this.opts.deviceControl.evidenceRetryMs !== undefined
            ? { evidenceRetryMs: this.opts.deviceControl.evidenceRetryMs }
            : {}),
          stopRun: async (runId, reason, publication) => {
            const result = await this.liveRuns.cancelAndWait(runId, reason, {
              publication,
            });
            return {
              target_found: result.found,
              process_tree_reaped: result.process_tree_reaped,
              ...(result.eventual_terminal
                ? {
                    eventual_process_tree_reaped: result.eventual_terminal.then(
                      (facts) => facts.process_tree_reaped,
                    ),
                  }
                : {}),
            };
          },
          stopAll: (runId, reason) => this.stopAllManagedForEvidence(runId, reason),
          fence: (reason) => this.fenceInstallation(reason),
          ...(this.opts.workspaces
            ? {
                workspace: {
                  request: (request: RunnerWorkspaceRequestT, generation: number) =>
                    this.handleWorkspaceRequest(request, generation),
                },
              }
            : {}),
          ...(this.opts.deviceControl.execution === true
            ? {
                execution: {
                  authenticated: () => this.authenticateDeviceExecution(),
                  disconnected: () => this.deviceExecutionDisconnected(),
                  reconcile: (response: ReconcileResponseT) =>
                    this.handleReconcileResponse(response),
                  command: (command: CommandEnvelopeT) => this.handleCommand(command),
                  eventAcknowledged: (eventSequence: number) =>
                    this.handleEventAcknowledgement(eventSequence),
                },
              }
            : {}),
        })
      : null;
  }

  get isFenced(): boolean {
    return this.fenced;
  }

  get connected(): boolean {
    return this.deviceExecutionEnabled
      ? (this.deviceControl?.connected ?? false)
      : this.socket?.readyState === WebSocket.OPEN;
  }

  get deviceControlConnected(): boolean {
    return this.deviceControl?.connected ?? false;
  }

  get generation(): number {
    return this.requireState().state.generation;
  }

  private get deviceExecutionEnabled(): boolean {
    return this.opts.deviceControl?.execution === true;
  }

  private get legacyLocalTransportEnabled(): boolean {
    return !this.opts.deviceControl || this.opts.deviceControl.legacyLocalCompatibility === true;
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
   * bound to one dispatch job the server already decided to run. The first
   * successful redemption binds this exact public key; a response-loss retry
   * with the same token and key is idempotent, while a changed key is refused.
   *
   * The token is read from the caller's argument and never persisted, logged,
   * or emitted; only the private key reaches the (job-lifetime) state dir.
   */
  async enroll(input: { enrollmentToken: string; dispatchJobId: string }): Promise<void> {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    // Build the request once. Retrying with a freshly generated key would
    // correctly lose the server's exact-key idempotency fence after a
    // response was committed but lost in transit.
    const bodyJson = JSON.stringify({
      enrollment_token: input.enrollmentToken,
      runner_id: this.opts.runnerId,
      dispatch_job_id: input.dispatchJobId,
      public_key_pem: publicPem,
    });
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        res = await fetch(`${this.opts.serverUrl}/api/actions/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyJson,
        });
        if (res.ok || res.status < 500 || attempt === 3) break;
      } catch {
        if (attempt === 3) break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
    }
    if (!res?.ok) {
      // Deliberately does not echo the response body or network error: an
      // enrollment failure must not become a channel for leaking why it
      // failed into a CI log.
      if (res) throw new Error(`enrollment rejected (${res.status})`);
      throw new Error("enrollment failed after retry");
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
    if (this.deviceExecutionEnabled) return;
    this.stateFile = new RunnerStateFile(this.opts.dataDir, {
      runner_id: this.opts.runnerId,
      private_key_pem: "",
      generation: 0,
    });
  }

  connect(): void {
    if (this.stopped || this.fenced) return;
    this.deviceControl?.start();
    if (this.deviceExecutionEnabled || !this.legacyLocalTransportEnabled) return;
    if (this.socket !== null) return;
    const state = this.requireState();
    const wsUrl = `${this.opts.serverUrl.replace(/^http/, "ws")}/ws/runner`;
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.on("message", (data) => {
      const frame = parseServerFrame(String(data));
      if (!frame) return;
      switch (frame.type) {
        case "challenge": {
          const transcript = canonicalLegacyRunnerWssAuthenticationTranscript({
            purpose: LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
            runner_id: this.opts.runnerId,
            generation: state.state.generation,
            protocol_version: PROTOCOL_VERSION,
            challenge: frame.nonce,
          });
          const signature = edSign(
            null,
            Buffer.from(transcript, "utf8"),
            state.state.private_key_pem,
          ).toString("base64");
          socket.send(
            JSON.stringify({
              type: "auth",
              runner_id: this.opts.runnerId,
              generation: state.state.generation,
              protocol_version: PROTOCOL_VERSION,
              transcript_signature: signature,
            }),
          );
          break;
        }
        case "auth_ok": {
          this.sendReconcileRequest();
          break;
        }
        case "auth_error": {
          socket.close();
          break;
        }
        case "reconcile_response": {
          this.handleReconcileResponse(frame.body);
          break;
        }
        case "command": {
          this.handleCommand(frame.command);
          break;
        }
        case "event_ack": {
          this.handleEventAcknowledgement(frame.ack_event_seq);
          break;
        }
        case "fenced": {
          // A newer pairing owns this runner id. Stop acting entirely.
          this.fenceInstallation("runner generation fenced");
          break;
        }
        case "inference_response": {
          this.handleInferenceResponse(frame.response, frame.generation);
          break;
        }
        case "workspace_request": {
          this.handleWorkspaceRequest(frame.request, frame.generation);
          break;
        }
      }
    });

    socket.on("close", () => {
      // EXECUTION E3 — never leave a runtime awaiting a completion that can no
      // longer arrive; it would burn the job's whole timeout doing nothing.
      this.inference.abortAll();
      this.stopHeartbeat();
      if (this.socket === socket) {
        this.socket = null;
        this.highestEventSeqSent = this.serverAckSeq;
        this.scheduleReconnect();
      }
    });
    socket.on("error", () => {
      // close handler drives reconnection
    });
  }

  /** Test hook: drop the socket abruptly (network kill). Runs keep going. */
  disconnectNow(): void {
    this.socket?.terminate();
  }

  /** Test hook for response-loss/reconnect coverage on the device channel. */
  disconnectDeviceControlNow(): void {
    this.deviceControl?.disconnectNow();
  }

  /** AgentHost lifecycle start. A restart clears a prior local emergency stop. */
  start(): void {
    if (this.fenced) throw new Error("runner credential generation is fenced");
    this.stopped = false;
    this.executionPaused = false;
    this.connect();
  }

  /**
   * Local Control Center emergency stop. It fences publication and waits for
   * every currently registered run, but deliberately leaves AgentHost and the
   * device cancellation channel alive.
   */
  async emergencyStop(): Promise<{
    stop_requested: number;
    process_trees_reaped: number;
    unconfirmed: number;
  }> {
    this.executionPaused = true;
    this.inference.abortAll("local emergency stop");
    this.executor.cancelAll();
    const result = await this.liveRuns.cancelAllAndWait("local emergency stop");
    return {
      stop_requested: result.stop_requested,
      process_trees_reaped: result.process_trees_reaped,
      unconfirmed: result.unconfirmed,
    };
  }

  stop(): void {
    this.stopped = true;
    this.executionPaused = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.inference.abortAll("runner stopped");
    this.executor.cancelAll();
    this.liveRuns.cancelAll("runner stopped");
    this.socket?.close();
    this.deviceControl?.stop();
  }

  // -- internals ---------------------------------------------------------------

  private requireState(): RunnerStateFile {
    if (this.deviceExecutionEnabled && this.deviceStateFile) return this.deviceStateFile;
    if (!this.stateFile) throw new Error("runner not paired: call pair() or loadState() first");
    return this.stateFile;
  }

  private async stopAllManagedForEvidence(
    runId: string,
    reason: string,
  ): Promise<DeviceCancellationStopResult> {
    this.executionPaused = true;
    const targetWasLive = this.liveRuns.isLive(runId);
    const priorTarget = this.liveRuns.terminalFacts(runId);
    const targetEventual = this.liveRuns.waitForTerminal(runId);
    this.inference.abortAll(reason);
    this.executor.cancelAll();
    const stopped = await this.liveRuns.cancelAllAndWait(reason);
    const target = this.liveRuns.terminalFacts(runId) ?? priorTarget;
    const initial = {
      target_found: targetWasLive || target !== null,
      process_tree_reaped: target?.process_tree_reaped === true && stopped.unconfirmed === 0,
    };
    const allEventual = stopped.eventual;
    if (!initial.process_tree_reaped && targetEventual && allEventual) {
      return {
        ...initial,
        eventual_process_tree_reaped: Promise.all([targetEventual, allEventual]).then(
          ([targetFacts, allFacts]) =>
            targetFacts.process_tree_reaped && allFacts.unconfirmed === 0,
        ),
      };
    }
    return initial;
  }

  private fenceInstallation(reason: string): void {
    if (this.fenced) return;
    this.fenced = true;
    this.executionPaused = true;
    this.inference.abortAll(reason);
    this.executor.cancelAll();
    this.liveRuns.cancelAll(reason);
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1008, "runner generation fenced");
    this.deviceControl?.stop();
  }

  private executionCapabilities(): Array<
    | "workspace_picker"
    | "workspace_repository_inventory"
    | "workspace_clone"
    | "workspace_clone_destination"
    | "workspace_delete"
    | "model_proxy"
    | "knowledge_transport"
  > {
    return this.deviceExecutionEnabled
      ? [
          "workspace_picker",
          "workspace_repository_inventory",
          "workspace_clone",
          "workspace_clone_destination",
          "workspace_delete",
          "knowledge_transport",
        ]
      : [
          "workspace_picker",
          "workspace_repository_inventory",
          "workspace_clone",
          "workspace_clone_destination",
          "workspace_delete",
          "model_proxy",
          "knowledge_transport",
        ];
  }

  private authenticateDeviceExecution(): void {
    if (!this.deviceExecutionEnabled || this.fenced || this.stopped) return;
    this.serverAckSeq = 0;
    this.highestEventSeqSent = 0;
    this.sendReconcileRequest();
  }

  private deviceExecutionDisconnected(): void {
    if (!this.deviceExecutionEnabled) return;
    this.inference.abortAll();
    this.stopHeartbeat();
    this.highestEventSeqSent = this.serverAckSeq;
  }

  private sendReconcileRequest(): void {
    const state = this.requireState();
    this.sendTransportFrame({
      type: "reconcile_request",
      body: {
        protocol: PROTOCOL_VERSION,
        runner_id: state.state.runner_id,
        generation: state.state.generation,
        capabilities: this.executionCapabilities(),
        last_event_seq_sent: state.state.seq,
        recently_executed_command_ids: state.executedIds(),
      },
    });
  }

  private handleReconcileResponse(response: ReconcileResponseT): void {
    const state = this.requireState();
    if (response.generation !== state.state.generation) {
      this.fenceInstallation("runner reconciliation identity changed");
      return;
    }
    this.serverAckSeq = response.ack_event_seq;
    this.knowledgeTransportEnabled =
      response.capabilities?.includes("knowledge_transport") ?? false;
    state.pruneAcked(response.ack_event_seq);
    this.highestEventSeqSent = response.ack_event_seq;
    this.sendBufferedEvents();
    for (const [commandId, terminalState] of state.terminalExecutions()) {
      this.terminalAck(
        commandId,
        terminalState,
        { causation: commandId },
        "recovered terminal acknowledgement from durable execution state",
      );
    }
    // Reap orphaned runs. A durable `executing` entry not live in THIS process
    // is orphaned: the subprocess that owned it died (a restart) and its
    // settling promise will never fire, so it would stay `executing` forever —
    // pinning the server's single concurrency slot and blocking every future
    // dispatch. Fail each one once so the run leaves the occupying state and the
    // slot frees. inFlightCommands is empty on a fresh process, so a live run
    // seen across a mere reconnect is skipped, never reaped.
    for (const commandId of state.orphanedExecutingIds(this.inFlightCommands)) {
      state.recordExecution(commandId, "failed");
      this.terminalAck(
        commandId,
        "failed",
        { causation: commandId },
        "runner restarted; the execution process was lost before it reported a result",
      );
    }
    for (const command of response.resend_commands) this.handleCommand(command);
    this.startHeartbeat();
  }

  private handleEventAcknowledgement(eventSequence: number): void {
    const state = this.requireState();
    this.serverAckSeq = Math.max(this.serverAckSeq, eventSequence);
    state.pruneAcked(this.serverAckSeq);
    this.highestEventSeqSent = Math.max(this.highestEventSeqSent, this.serverAckSeq);
    this.sendBufferedEvents();
  }

  private handleInferenceResponse(response: RunnerInferenceResponseT, generation: number): void {
    if (generation === this.requireState().state.generation) {
      this.inference.receive(response);
    }
  }

  private handleWorkspaceRequest(request: RunnerWorkspaceRequestT, generation: number): void {
    const state =
      this.deviceStateFile?.state.generation === generation
        ? this.deviceStateFile
        : this.requireState();
    const unavailable = () =>
      this.sendWorkspaceResponse(state.state.generation, {
        request_id: request.request_id,
        operation: request.operation,
        status: "unavailable" as const,
      });
    if (generation !== state.state.generation || !this.opts.workspaces) {
      unavailable();
      return;
    }
    void this.opts.workspaces.handleAsync(request).then(async (response) => {
      if (
        response.status === "ok" &&
        response.repository &&
        (request.operation === "choose" || request.operation === "clone") &&
        this.opts.registerWorkspace
      ) {
        let registration: { registration_id: string | null };
        try {
          registration = await this.opts.registerWorkspace(response.repository);
        } catch {
          registration = { registration_id: null };
        }
        if (!registration.registration_id) {
          this.sendWorkspaceResponse(state.state.generation, {
            request_id: request.request_id,
            operation: request.operation,
            status: "unavailable",
          });
          return;
        }
        this.sendWorkspaceResponse(state.state.generation, {
          ...response,
          repository_registration_id: registration.registration_id,
        });
        return;
      }
      this.sendWorkspaceResponse(state.state.generation, response);
    });
  }

  private sendWorkspaceResponse(
    generation: number,
    response: Parameters<DeviceControlConnection["sendWorkspaceFrame"]>[0]["response"],
  ): boolean {
    const frame = { type: "workspace_response" as const, generation, response };
    return this.deviceControl?.sendWorkspaceFrame(frame) ?? this.sendLegacyFrame(frame);
  }

  private sendTransportFrame(
    frame: Parameters<DeviceControlConnection["sendExecutionFrame"]>[0],
  ): boolean {
    return this.deviceExecutionEnabled
      ? (this.deviceControl?.sendExecutionFrame(frame) ?? false)
      : this.sendLegacyFrame(frame);
  }

  private sendLegacyFrame(frame: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fenced || !this.opts.reconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.opts.reconnectDelayMs);
  }

  private sendBufferedEvents(): void {
    if (!this.connected || this.fenced) return;
    const state = this.requireState();
    const inFlight = Math.max(0, this.highestEventSeqSent - this.serverAckSeq);
    const available = Math.max(0, RUNNER_EVENT_SEND_WINDOW - inFlight);
    if (available === 0) return;
    const events = state
      .unackedSince(this.serverAckSeq)
      .filter((event) => event.event_seq > this.highestEventSeqSent)
      .slice(0, available);
    for (const event of events) {
      if (!this.sendTransportFrame({ type: "event", event })) break;
      this.highestEventSeqSent = event.event_seq;
    }
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
    if (
      command.runner_id !== state.state.runner_id ||
      command.generation !== state.state.generation
    ) {
      this.fenceInstallation("runner generation fenced");
      return;
    }
    // ONBOARDING O4: registered before any ack so that a replayed, already
    // terminal launch_run still settles an ephemeral host rather than leaving
    // it connected until its job times out.
    if (
      command.payload.kind === "launch_run" ||
      command.payload.kind === "collect_visual_evidence"
    ) {
      this.launchCommands.add(command.command_id);
    }
    const recorded = state.executionState(command.command_id);
    const meta = { correlation: command.correlation_id, causation: command.command_id };
    if (recorded) {
      if (TERMINAL_COMMAND_STATES.has(recorded)) {
        // The normal path buffers a terminal acknowledgement before sending.
        // If a process died after persisting `executed` but before that buffer
        // write, ensureTerminalAck repairs the missing event exactly once.
        // Existing buffered events are replayed by reconciliation, while the
        // durable tombstone prevents a new sequence after server pruning.
        this.terminalAck(
          command.command_id,
          recorded,
          meta,
          "recovered terminal acknowledgement from durable execution state",
        );
      } else {
        this.ack(command.command_id, recorded, meta);
      }
      return;
    }
    if (isCommandExpired(command, new Date())) {
      state.recordExecution(command.command_id, "expired");
      this.ack(command.command_id, "expired", meta);
      return;
    }
    if (
      this.executionPaused &&
      (command.payload.kind === "launch_fixture" ||
        command.payload.kind === "launch_run" ||
        command.payload.kind === "collect_visual_evidence" ||
        command.payload.kind === "run_verification")
    ) {
      state.recordExecution(command.command_id, "rejected");
      this.ack(
        command.command_id,
        "rejected",
        meta,
        "local emergency stop is engaged; restart the daemon before dispatching work",
      );
      return;
    }
    state.recordExecution(command.command_id, "executing");
    this.inFlightCommands.add(command.command_id);
    this.ack(command.command_id, "accepted", meta);
    // EXECUTION E11 — `executing` is deliberately NOT acked yet.
    //
    // `COMMAND_TRANSITIONS` has no `executing -> rejected` edge, so the eager
    // ack made every rejection unrepresentable: the server dropped the frame
    // and the command sat in `executing` until it aged out. That is why the old
    // `default:` branch's rejection of `send_message` was invisible even to
    // someone reading the code and expecting it to work. `accepted -> rejected`
    // IS legal, so a refusal is acked from `accepted` and `executing` is acked
    // only on the paths that genuinely go on to execute.
    const executing = (): void => this.ack(command.command_id, "executing", meta);

    const payload = command.payload;
    switch (payload.kind) {
      case "launch_fixture":
        executing();
        this.executor.launch(`run_${command.command_id}`, payload.fixture, meta);
        break;
      case "launch_run":
        if (!payload.dispatch || !this.opts.executeV2) {
          state.recordExecution(command.command_id, "rejected");
          this.ack(
            command.command_id,
            "rejected",
            meta,
            "this runner cannot execute a V2 dispatch",
          );
          return;
        }
        executing();
        void this.opts
          .executeV2(
            payload.dispatch,
            (event) =>
              this.emit(event, {
                correlation: meta.correlation,
                causation: command.command_id,
              }),
            {
              knowledge_transport: this.knowledgeTransportEnabled,
            },
          )
          .then((outcome) => {
            this.inFlightCommands.delete(command.command_id);
            state.recordExecution(command.command_id, outcome);
            this.ack(command.command_id, outcome, meta);
          })
          .catch((error) => {
            this.inFlightCommands.delete(command.command_id);
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
      case "collect_visual_evidence":
        if (!this.opts.collectVisualEvidence) {
          state.recordExecution(command.command_id, "rejected");
          this.ack(
            command.command_id,
            "rejected",
            meta,
            "this runner cannot collect visual evidence",
          );
          return;
        }
        executing();
        void this.opts
          .collectVisualEvidence(payload)
          .then(() => {
            state.recordExecution(command.command_id, "succeeded");
            this.ack(command.command_id, "succeeded", meta);
          })
          .catch((error) => {
            state.recordExecution(command.command_id, "failed");
            this.ack(
              command.command_id,
              "failed",
              meta,
              error instanceof Error ? error.message : "visual evidence collection failed",
            );
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
          executing,
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
    executing: () => void,
  ): Promise<void> {
    const state = this.requireState();
    const settle = (ackState: CommandStateT, detail: string, visible: boolean): void => {
      if (visible) this.emit({ kind: "run_log", run_id: runId, chunk: detail }, meta);
      // Only a control that is actually being applied passes through
      // `executing`; a refusal goes straight from `accepted` to `rejected`,
      // which is the only legal way for a refusal to reach the server.
      if (ackState !== "rejected") executing();
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
    if (TERMINAL_COMMAND_STATES.has(ackState)) {
      this.terminalAck(commandId, ackState, meta, detail);
      return;
    }
    this.emit({ kind: "command_ack", command_id: commandId, state: ackState, detail }, meta);
    this.reportRunSettled(commandId, ackState);
  }

  private terminalAck(
    commandId: string,
    ackState: CommandStateT,
    meta: { correlation?: string; causation?: string },
    detail: string,
  ): void {
    if (this.fenced) return;
    const state = this.requireState();
    const ensured = state.ensureTerminalAck({
      command_id: commandId,
      state: ackState,
      runner_id: state.state.runner_id,
      generation: state.state.generation,
      correlation_id: meta.correlation ?? `runner:${state.state.runner_id}`,
      causation_id: meta.causation ?? null,
      occurred_at: new Date().toISOString(),
      detail,
    });
    // Reconciliation sends an existing buffered event before redelivering
    // commands. Only a newly synthesized event needs sending here.
    if (ensured.created && ensured.event) this.sendBufferedEvents();
    this.reportRunSettled(commandId, ackState);
  }

  private reportRunSettled(commandId: string, ackState: CommandStateT): void {
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
      runner_id: state.state.runner_id,
      generation: state.state.generation,
      correlation_id: meta.correlation ?? `runner:${state.state.runner_id}`,
      causation_id: meta.causation ?? null,
      occurred_at: new Date().toISOString(),
      payload: safePayload,
    };
    state.bufferEvent(event);
    this.sendBufferedEvents();
  }
}
