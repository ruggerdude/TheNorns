import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DeviceWssIdentity } from "./deviceWssAuth.js";

export const DEVICE_CANCELLATION_JOURNAL_FILENAME = "device-cancellation-evidence.json";
const MAX_CANCELLATION_EVIDENCE_RECORDS = 1_000;
const MAX_CANCELLATION_JOURNAL_BYTES = 1024 * 1024;

export type DeviceCancellationEvidenceState = "runner_acknowledged" | "process_exited";

interface PersistedCancellationEvidence {
  run_id: string;
  acknowledged_at: string;
  acknowledged_server_acked: boolean;
  process_exited_at: string | null;
  process_tree_reaped: boolean;
  process_exited_server_acked: boolean;
}

interface PersistedCancellationJournal {
  version: 1;
  device_id: string;
  credential_id: string;
  generation: number;
  evidence: PersistedCancellationEvidence[];
}

export interface DeviceCancellationEvidenceRecord {
  run_id: string;
  acknowledged_at: string;
  acknowledged_server_acked: boolean;
  process_exited_at: string | null;
  process_tree_reaped: boolean;
  process_exited_server_acked: boolean;
}

function privateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseJournal(raw: string): PersistedCancellationJournal {
  if (Buffer.byteLength(raw, "utf8") > MAX_CANCELLATION_JOURNAL_BYTES) {
    throw new Error("device cancellation journal exceeds its safe size limit");
  }
  const parsed = JSON.parse(raw) as Partial<PersistedCancellationJournal>;
  if (
    parsed.version !== 1 ||
    !validOpaqueId(parsed.device_id) ||
    !validOpaqueId(parsed.credential_id) ||
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 0 ||
    !Array.isArray(parsed.evidence) ||
    parsed.evidence.length > MAX_CANCELLATION_EVIDENCE_RECORDS
  ) {
    throw new Error("device cancellation journal is malformed");
  }
  const seen = new Set<string>();
  const evidence = parsed.evidence.map((candidate) => {
    const record = candidate as Partial<PersistedCancellationEvidence>;
    if (
      !validOpaqueId(record.run_id) ||
      seen.has(record.run_id) ||
      !validTimestamp(record.acknowledged_at) ||
      typeof record.acknowledged_server_acked !== "boolean" ||
      !(
        record.process_exited_at === null ||
        (validTimestamp(record.process_exited_at) &&
          record.process_tree_reaped === true &&
          typeof record.process_exited_server_acked === "boolean")
      ) ||
      (record.process_exited_at === null &&
        (record.process_tree_reaped !== false || record.process_exited_server_acked !== false))
    ) {
      throw new Error("device cancellation journal is malformed");
    }
    seen.add(record.run_id);
    return {
      run_id: record.run_id,
      acknowledged_at: record.acknowledged_at,
      acknowledged_server_acked: record.acknowledged_server_acked,
      process_exited_at: record.process_exited_at,
      process_tree_reaped: record.process_tree_reaped as boolean,
      process_exited_server_acked: record.process_exited_server_acked as boolean,
    } satisfies PersistedCancellationEvidence;
  });
  return {
    version: 1,
    device_id: parsed.device_id,
    credential_id: parsed.credential_id,
    generation: parsed.generation as number,
    evidence,
  };
}

/**
 * Minimal, path-free cancellation evidence durability.
 *
 * The file contains only opaque installation/run IDs, the credential
 * generation, timestamps, evidence state, and the process-tree proof bit.
 * Commands, output, hostnames, repository names, and local paths never enter
 * this journal.
 */
export class DeviceCancellationJournal {
  private readonly path: string;
  private state: PersistedCancellationJournal;

  constructor(
    private readonly dataDir: string,
    readonly identity: DeviceWssIdentity,
  ) {
    privateDirectory(dataDir);
    this.path = join(dataDir, DEVICE_CANCELLATION_JOURNAL_FILENAME);
    if (existsSync(this.path)) {
      this.state = parseJournal(readFileSync(this.path, "utf8"));
      if (
        this.state.device_id !== identity.device_id ||
        this.state.credential_id !== identity.credential_id ||
        this.state.generation !== identity.generation
      ) {
        throw new Error("device cancellation journal belongs to another credential generation");
      }
      chmodSync(this.path, 0o600);
    } else {
      this.state = {
        version: 1,
        device_id: identity.device_id,
        credential_id: identity.credential_id,
        generation: identity.generation,
        evidence: [],
      };
      this.persist();
    }
  }

  acknowledge(runId: string, acknowledgedAt: string): DeviceCancellationEvidenceRecord {
    if (!validOpaqueId(runId) || !validTimestamp(acknowledgedAt)) {
      throw new Error("invalid cancellation acknowledgement");
    }
    const existing = this.state.evidence.find((record) => record.run_id === runId);
    if (existing) return { ...existing };
    if (this.state.evidence.length >= MAX_CANCELLATION_EVIDENCE_RECORDS) {
      throw new Error("device cancellation journal is full; refusing untracked evidence");
    }
    const record: PersistedCancellationEvidence = {
      run_id: runId,
      acknowledged_at: acknowledgedAt,
      acknowledged_server_acked: false,
      process_exited_at: null,
      process_tree_reaped: false,
      process_exited_server_acked: false,
    };
    this.state.evidence.push(record);
    this.persist();
    return { ...record };
  }

  recordProcessExited(runId: string, processExitedAt: string): DeviceCancellationEvidenceRecord {
    if (!validTimestamp(processExitedAt)) throw new Error("invalid process-exit timestamp");
    const record = this.state.evidence.find((candidate) => candidate.run_id === runId);
    if (!record) throw new Error("cancellation must be acknowledged before process exit");
    if (record.process_exited_at !== null) return { ...record };
    record.process_exited_at = processExitedAt;
    record.process_tree_reaped = true;
    record.process_exited_server_acked = false;
    this.persist();
    return { ...record };
  }

  markServerAcknowledged(runId: string, state: DeviceCancellationEvidenceState): void {
    const record = this.state.evidence.find((candidate) => candidate.run_id === runId);
    if (!record) return;
    if (state === "runner_acknowledged") {
      if (record.acknowledged_server_acked) return;
      record.acknowledged_server_acked = true;
    } else {
      if (record.process_exited_at === null || !record.process_tree_reaped) {
        throw new Error("server acknowledged process exit without local reaping proof");
      }
      if (record.process_exited_server_acked) return;
      record.process_exited_server_acked = true;
    }
    // A fully acknowledged terminal record is no longer needed for replay.
    // The server will not redeliver a cancellation after it durably records
    // process_exited, and pruning prevents this bounded journal growing forever.
    if (record.acknowledged_server_acked && record.process_exited_server_acked) {
      this.state.evidence = this.state.evidence.filter((candidate) => candidate !== record);
    }
    this.persist();
  }

  records(): readonly DeviceCancellationEvidenceRecord[] {
    return this.state.evidence.map((record) => ({ ...record }));
  }

  private persist(): void {
    privateDirectory(this.dataDir);
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const serialized = JSON.stringify(this.state);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CANCELLATION_JOURNAL_BYTES) {
      throw new Error("device cancellation journal exceeds its safe size limit");
    }
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "w", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.path);
      chmodSync(this.path, 0o600);
      let directoryDescriptor: number | null = null;
      try {
        directoryDescriptor = openSync(this.dataDir, "r");
        fsyncSync(directoryDescriptor);
      } catch (error) {
        // Windows does not consistently permit opening/fsyncing directory
        // handles through Node. The file is still atomically replaced and
        // fsynced, but we do not overstate rename durability on that platform.
        if (process.platform !== "win32") throw error;
      } finally {
        if (directoryDescriptor !== null) closeSync(directoryDescriptor);
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A mode-0600 orphaned temp file is safer than allowing cleanup to
        // overwrite the authoritative persistence result.
      }
    }
  }
}
