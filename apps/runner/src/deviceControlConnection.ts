import { DEVICE_WSS_PROTOCOL_VERSION, type ServerFrameT, parseServerFrame } from "@norns/contracts";
import WebSocket from "ws";
import {
  type DeviceCancellationEvidenceRecord,
  DeviceCancellationJournal,
} from "./deviceCancellationJournal.js";
import {
  type DeviceWssIdentity,
  createDeviceCancellationEvidenceFrame,
  createDeviceWssAuthenticationFrame,
} from "./deviceWssAuth.js";

export interface DeviceCancellationStopResult {
  target_found: boolean;
  process_tree_reaped: boolean;
  /** Late proof after the bounded confirmation window, if the run was hung. */
  eventual_process_tree_reaped?: Promise<boolean>;
}

export interface DeviceControlConnectionOptions {
  serverUrl: string;
  dataDir: string;
  identity: DeviceWssIdentity;
  sign(canonicalTranscript: string): string;
  stopRun(
    runId: string,
    reason: string,
    publication: "allow_committed" | "fenced",
  ): Promise<DeviceCancellationStopResult>;
  stopAll(runId: string, reason: string): Promise<DeviceCancellationStopResult>;
  fence(reason: string): void;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  evidenceRetryMs?: number;
  now?: () => Date;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_EVIDENCE_RETRY_MS = 2_000;

function sameIdentity(
  frame: Extract<ServerFrameT, { type: "device_cancellation_request" }>,
  identity: DeviceWssIdentity,
): boolean {
  return (
    frame.device_id === identity.device_id &&
    frame.credential_id === identity.credential_id &&
    frame.generation === identity.generation
  );
}

/**
 * Cancellation-only device WebSocket.
 *
 * General device command and event transport remains fail-closed. This
 * companion connection authenticates an enrolled installation, receives only
 * exact-generation cancellation requests, and replays path-free signed
 * evidence until the server acknowledges it.
 */
export class DeviceControlConnection {
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly evidenceRetryMs: number;
  private readonly now: () => Date;
  private readonly journal: DeviceCancellationJournal;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private evidenceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private fenced = false;
  private authenticated = false;
  private readonly cancellationHandlers = new Map<string, Promise<void>>();

  constructor(private readonly options: DeviceControlConnectionOptions) {
    this.reconnect = options.reconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.evidenceRetryMs = options.evidenceRetryMs ?? DEFAULT_EVIDENCE_RETRY_MS;
    if (this.reconnectDelayMs <= 0 || this.evidenceRetryMs <= 0) {
      throw new Error("device control retry intervals must be positive");
    }
    this.now = options.now ?? (() => new Date());
    this.journal = new DeviceCancellationJournal(options.dataDir, options.identity);
  }

  get connected(): boolean {
    return this.authenticated && this.socket?.readyState === WebSocket.OPEN;
  }

  get isFenced(): boolean {
    return this.fenced;
  }

  start(): void {
    if (this.fenced) throw new Error("device credential generation is fenced");
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.evidenceRetryTimer) clearTimeout(this.evidenceRetryTimer);
    this.reconnectTimer = null;
    this.evidenceRetryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  /** Test/network hook. Durable evidence remains queued for reconnect. */
  disconnectNow(): void {
    this.socket?.terminate();
  }

  pendingEvidence(): readonly DeviceCancellationEvidenceRecord[] {
    return this.journal.records();
  }

  private connect(): void {
    if (this.stopped || this.fenced || this.socket !== null) return;
    const socket = new WebSocket(`${this.options.serverUrl.replace(/^http/, "ws")}/ws/runner`);
    this.socket = socket;
    this.authenticated = false;

    socket.on("message", (data) => {
      const frame = parseServerFrame(String(data));
      if (!frame) {
        this.fenceAndClose("invalid device control frame");
        return;
      }
      void this.handleFrame(socket, frame);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authenticated = false;
      if (this.evidenceRetryTimer) clearTimeout(this.evidenceRetryTimer);
      this.evidenceRetryTimer = null;
      this.scheduleReconnect();
    });
    socket.on("error", () => {
      // The close handler owns reconnect behavior.
    });
  }

  private async handleFrame(socket: WebSocket, frame: ServerFrameT): Promise<void> {
    if (this.socket !== socket || this.fenced || this.stopped) return;
    switch (frame.type) {
      case "challenge": {
        if (this.authenticated || !frame.device_auth) {
          this.fenceAndClose("device authentication challenge unavailable");
          return;
        }
        if (!frame.device_auth.supported_protocol_versions.includes(DEVICE_WSS_PROTOCOL_VERSION)) {
          this.fenceAndClose("device protocol is incompatible");
          return;
        }
        socket.send(
          JSON.stringify(
            createDeviceWssAuthenticationFrame({
              ...this.options.identity,
              challenge: frame.device_auth.challenge,
              protocol_version: DEVICE_WSS_PROTOCOL_VERSION,
              sign: this.options.sign,
            }),
          ),
        );
        return;
      }
      case "device_auth_ok": {
        if (
          frame.device_id !== this.options.identity.device_id ||
          frame.generation !== this.options.identity.generation ||
          frame.protocol_version !== DEVICE_WSS_PROTOCOL_VERSION
        ) {
          this.fenceAndClose("device authentication identity changed");
          return;
        }
        this.authenticated = true;
        this.flushEvidence();
        return;
      }
      case "device_cancellation_request": {
        if (!this.authenticated || !sameIdentity(frame, this.options.identity)) {
          this.fenceAndClose("device cancellation identity changed");
          return;
        }
        this.receiveCancellation(frame);
        return;
      }
      case "device_cancellation_evidence_ack": {
        if (!this.authenticated) {
          this.fenceAndClose("unauthenticated cancellation evidence acknowledgement");
          return;
        }
        this.journal.markServerAcknowledged(frame.run_id, frame.evidence_state);
        this.flushEvidence();
        return;
      }
      case "fenced":
        this.fenceAndClose("device generation fenced");
        return;
      case "auth_error":
        this.fenceAndClose("device credential rejected");
        return;
      default:
        // The server currently exposes only cancellation on a device socket.
        // Treating command/event/reconcile traffic as a protocol error keeps
        // preview and not-yet-authorized device execution fail-closed.
        this.fenceAndClose("unexpected frame on cancellation-only device socket");
    }
  }

  private receiveCancellation(
    frame: Extract<ServerFrameT, { type: "device_cancellation_request" }>,
  ): void {
    const existing = this.journal.records().find((record) => record.run_id === frame.run_id);
    this.journal.acknowledge(frame.run_id, this.now().toISOString());
    this.flushEvidence();
    if (existing?.process_exited_at !== null && existing?.process_tree_reaped) return;
    if (this.cancellationHandlers.has(frame.run_id)) return;

    const reason =
      frame.cause === "project_stop"
        ? "project work cancellation requested"
        : frame.cause === "device_revocation"
          ? "device authorization revoked"
          : "local emergency stop requested";
    const handling = (async () => {
      const result =
        frame.cause === "project_stop"
          ? await this.options.stopRun(
              frame.run_id,
              reason,
              frame.publication_fenced ? "fenced" : "allow_committed",
            )
          : await this.options.stopAll(frame.run_id, reason);
      // Unknown or unproven work stays runner_acknowledged. The server can
      // render unconfirmed_offline; no local absence is promoted to exit proof.
      if (!result.target_found) return;
      if (result.process_tree_reaped) {
        this.journal.recordProcessExited(frame.run_id, this.now().toISOString());
        this.flushEvidence();
        return;
      }
      if (result.eventual_process_tree_reaped) {
        void result.eventual_process_tree_reaped
          .then((reaped) => {
            if (!reaped) return;
            this.journal.recordProcessExited(frame.run_id, this.now().toISOString());
            this.flushEvidence();
          })
          .catch(() => {
            // Late failure remains unconfirmed.
          });
      }
    })()
      .catch(() => {
        // The durable acknowledgement remains available for replay. A stop
        // failure must never be converted into false process-exit evidence.
      })
      .finally(() => {
        this.cancellationHandlers.delete(frame.run_id);
      });
    this.cancellationHandlers.set(frame.run_id, handling);
  }

  private flushEvidence(): void {
    if (!this.connected || !this.socket) return;
    if (this.evidenceRetryTimer) clearTimeout(this.evidenceRetryTimer);
    this.evidenceRetryTimer = null;
    for (const record of this.journal.records()) {
      if (!record.acknowledged_server_acked) {
        this.sendEvidence(record, "runner_acknowledged");
        continue;
      }
      if (
        record.process_exited_at !== null &&
        record.process_tree_reaped &&
        !record.process_exited_server_acked
      ) {
        this.sendEvidence(record, "process_exited");
      }
    }
    if (this.journal.records().length > 0) {
      this.evidenceRetryTimer = setTimeout(() => {
        this.evidenceRetryTimer = null;
        this.flushEvidence();
      }, this.evidenceRetryMs);
      this.evidenceRetryTimer.unref?.();
    }
  }

  private sendEvidence(
    record: DeviceCancellationEvidenceRecord,
    state: "runner_acknowledged" | "process_exited",
  ): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify(
        createDeviceCancellationEvidenceFrame({
          identity: this.options.identity,
          run_id: record.run_id,
          evidence_state: state,
          acknowledged_at: record.acknowledged_at,
          process_exited_at: state === "process_exited" ? record.process_exited_at : null,
          process_tree_reaped: state === "process_exited",
          sign: this.options.sign,
        }),
      ),
    );
  }

  private fenceAndClose(reason: string): void {
    if (this.fenced) return;
    this.fenced = true;
    this.authenticated = false;
    this.options.fence(reason);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.evidenceRetryTimer) clearTimeout(this.evidenceRetryTimer);
    this.reconnectTimer = null;
    this.evidenceRetryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1008, "device control fenced");
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fenced || !this.reconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref?.();
  }
}
