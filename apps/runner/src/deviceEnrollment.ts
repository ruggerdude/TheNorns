import { randomBytes } from "node:crypto";
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
import { arch, platform } from "node:os";
import { join } from "node:path";
import {
  DeviceAuthorizationPollOutcome,
  type DeviceAuthorizationPollOutcomeT,
} from "@norns/contracts";
import type { DeviceCredentialSecretStore } from "./deviceCredentialSecretStore.js";
import {
  type ActiveDeviceIdentity,
  ActiveDeviceIdentityStore,
} from "./deviceInstallationIdentity.js";
import type { PendingDeviceCredentialStore } from "./pendingDeviceCredential.js";

export const DEVICE_ENROLLMENT_STATE_FILENAME = "device-enrollment-state.json";

export type DeviceEnrollmentState =
  | "not_enrolled"
  | "credential_prepared"
  | "pending"
  | "approved_pending_redemption"
  | "active"
  | "denied"
  | "expired";

export interface PublicDeviceEnrollmentStatus {
  state: DeviceEnrollmentState;
  user_code: string | null;
  verification_uri: string | null;
  expires_at: string | null;
  next_poll_at: string | null;
}

interface LiveEnrollmentRecord {
  version: 1;
  state: "pending" | "approved_pending_redemption";
  authorization_request_id: string;
  device_code_reference: string;
  user_code: string;
  verification_uri: string;
  expires_at: string;
  poll_interval_seconds: number;
  network_backoff_seconds: number;
  next_poll_at: string;
}

interface InitiatingEnrollmentRecord {
  version: 1;
  state: "creating";
  authorization_request_id: null;
  device_code_reference: string;
  user_code: string;
  proposed_name: string;
  os_family: "macos" | "windows" | "linux" | "other";
  architecture: string;
  network_backoff_seconds: number;
  next_retry_at: string;
}

interface TerminalEnrollmentRecord {
  version: 1;
  state: "active" | "denied" | "expired";
  authorization_request_id: string;
  device_code_reference: string;
  user_code: null;
  verification_uri: null;
  expires_at: string;
  poll_interval_seconds: number;
  network_backoff_seconds: 0;
  next_poll_at: null;
}

type EnrollmentRecord =
  | InitiatingEnrollmentRecord
  | LiveEnrollmentRecord
  | TerminalEnrollmentRecord;

function isLiveEnrollmentRecord(record: EnrollmentRecord): record is LiveEnrollmentRecord {
  return record.state === "pending" || record.state === "approved_pending_redemption";
}

function isTerminalEnrollmentRecord(record: EnrollmentRecord): record is TerminalEnrollmentRecord {
  return record.state === "active" || record.state === "denied" || record.state === "expired";
}

interface CreatedAuthorization {
  authorization_request_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_at: string;
  interval_seconds: number;
}

export interface DeviceEnrollmentCoordinatorOptions {
  serverUrl: string;
  dataDir: string;
  credentialStore: PendingDeviceCredentialStore;
  secretStore: DeviceCredentialSecretStore;
  activeIdentityStore?: ActiveDeviceIdentityStore;
  fetch?: typeof fetch;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onStateChange?: (status: PublicDeviceEnrollmentStatus) => void;
  requestTimeoutMs?: number;
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validDeviceCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validUserCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9-]{4,32}$/.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validatedVerificationUri(value: unknown): string {
  if (typeof value !== "string") throw new Error("device enrollment response is malformed");
  const uri = new URL(value);
  const loopback = uri.hostname === "127.0.0.1" || uri.hostname === "[::1]";
  if (
    (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback)) ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash
  ) {
    throw new Error("device enrollment verification URI is unsafe");
  }
  return uri.toString();
}

function parseCreatedAuthorization(value: unknown): CreatedAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("device enrollment response is malformed");
  }
  const record = value as Record<string, unknown>;
  if (
    !validOpaqueId(record.authorization_request_id) ||
    !validDeviceCode(record.device_code) ||
    !validUserCode(record.user_code) ||
    !validDate(record.expires_at) ||
    !Number.isSafeInteger(record.interval_seconds) ||
    (record.interval_seconds as number) <= 0 ||
    (record.interval_seconds as number) > 3_600
  ) {
    throw new Error("device enrollment response is malformed");
  }
  const allowed = new Set([
    "authorization_request_id",
    "device_code",
    "user_code",
    "verification_uri",
    "expires_at",
    "interval_seconds",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("device enrollment response is malformed");
  }
  return {
    authorization_request_id: record.authorization_request_id,
    device_code: record.device_code,
    user_code: record.user_code,
    verification_uri: validatedVerificationUri(record.verification_uri),
    expires_at: record.expires_at,
    interval_seconds: record.interval_seconds as number,
  };
}

function parseEnrollmentRecord(raw: string): EnrollmentRecord {
  const value = JSON.parse(raw) as Partial<EnrollmentRecord>;
  if (value.version === 1 && value.state === "creating") {
    const record = value as Partial<InitiatingEnrollmentRecord>;
    if (
      record.authorization_request_id !== null ||
      typeof record.device_code_reference !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(record.device_code_reference) ||
      !validUserCode(record.user_code) ||
      typeof record.proposed_name !== "string" ||
      record.proposed_name.length < 1 ||
      record.proposed_name.length > 200 ||
      (record.os_family !== "macos" &&
        record.os_family !== "windows" &&
        record.os_family !== "linux" &&
        record.os_family !== "other") ||
      typeof record.architecture !== "string" ||
      record.architecture.length < 1 ||
      record.architecture.length > 100 ||
      !Number.isSafeInteger(record.network_backoff_seconds) ||
      (record.network_backoff_seconds as number) < 0 ||
      !validDate(record.next_retry_at)
    ) {
      throw new Error("device enrollment state is malformed");
    }
    return {
      version: 1,
      state: "creating",
      authorization_request_id: null,
      device_code_reference: record.device_code_reference,
      user_code: record.user_code,
      proposed_name: record.proposed_name,
      os_family: record.os_family,
      architecture: record.architecture,
      network_backoff_seconds: record.network_backoff_seconds as number,
      next_retry_at: record.next_retry_at,
    };
  }
  const established = value as Partial<LiveEnrollmentRecord | TerminalEnrollmentRecord>;
  if (
    established.version !== 1 ||
    !validOpaqueId(established.authorization_request_id) ||
    !validDate(established.expires_at) ||
    !Number.isSafeInteger(established.poll_interval_seconds) ||
    (established.poll_interval_seconds as number) <= 0 ||
    !Number.isSafeInteger(established.network_backoff_seconds) ||
    (established.network_backoff_seconds as number) < 0
  ) {
    throw new Error("device enrollment state is malformed");
  }
  if (established.state === "pending" || established.state === "approved_pending_redemption") {
    if (
      typeof established.device_code_reference !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(established.device_code_reference) ||
      !validUserCode(established.user_code) ||
      typeof established.verification_uri !== "string" ||
      !validDate(established.next_poll_at)
    ) {
      throw new Error("device enrollment state is malformed");
    }
    return {
      version: 1,
      state: established.state,
      authorization_request_id: established.authorization_request_id,
      device_code_reference: established.device_code_reference,
      user_code: established.user_code,
      verification_uri: validatedVerificationUri(established.verification_uri),
      expires_at: established.expires_at,
      poll_interval_seconds: established.poll_interval_seconds as number,
      network_backoff_seconds: established.network_backoff_seconds as number,
      next_poll_at: established.next_poll_at,
    };
  }
  if (
    (established.state === "active" ||
      established.state === "denied" ||
      established.state === "expired") &&
    typeof established.device_code_reference === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(established.device_code_reference) &&
    established.user_code === null &&
    established.verification_uri === null &&
    established.next_poll_at === null
  ) {
    return {
      version: 1,
      state: established.state,
      authorization_request_id: established.authorization_request_id,
      device_code_reference: established.device_code_reference,
      user_code: null,
      verification_uri: null,
      expires_at: established.expires_at,
      poll_interval_seconds: established.poll_interval_seconds as number,
      network_backoff_seconds: 0,
      next_poll_at: null,
    };
  }
  throw new Error("device enrollment state is malformed");
}

function ensurePrivateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function redemptionProofPayload(input: {
  authorization_request_id: string;
  device_code: string;
  public_key_fingerprint: string;
}): string {
  const fields = [
    ["authorization_request_id", input.authorization_request_id],
    ["device_code", input.device_code],
    ["public_key_fingerprint", input.public_key_fingerprint],
  ] as const;
  let payload = "norns:device-enrollment-redemption:v1\n";
  for (const [name, value] of fields) {
    payload += `${name}:${Buffer.byteLength(value, "utf8")}:${value}\n`;
  }
  return payload;
}

function localOsFamily(): "macos" | "windows" | "linux" | "other" {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

const HUMAN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newHumanCode(): string {
  const bytes = randomBytes(8);
  const characters = [...bytes].map((value) => HUMAN_CODE_ALPHABET[value & 31]);
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

/**
 * Trusted installed-device enrollment producer.
 *
 * The private key is committed to an OS-protected store before the first
 * network request. The 256-bit device code is then kept only in that protected
 * store and appears solely in POST bodies. It is never returned by AgentHost,
 * placed in a URL, logged, or accepted through argv/custom URI input.
 */
export class DeviceEnrollmentCoordinator {
  private readonly path: string;
  private readonly activeIdentityStore: ActiveDeviceIdentityStore;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly requestTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private stopped = true;
  private readonly listeners = new Set<(status: PublicDeviceEnrollmentStatus) => void>();

  constructor(private readonly options: DeviceEnrollmentCoordinatorOptions) {
    const origin = new URL(options.serverUrl);
    const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
    if (
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
      origin.username ||
      origin.password ||
      (origin.pathname !== "" && origin.pathname !== "/") ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("device enrollment server must be a code-free HTTPS origin");
    }
    this.path = join(options.dataDir, DEVICE_ENROLLMENT_STATE_FILENAME);
    this.activeIdentityStore =
      options.activeIdentityStore ?? new ActiveDeviceIdentityStore(options.dataDir);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("device enrollment request timeout must be a positive integer");
    }
    const activeIdentity = this.activeIdentityStore.read();
    let existing = this.readRecord();
    if (
      !activeIdentity &&
      this.options.credentialStore.exists() &&
      !this.options.credentialStore.protectedSecretAvailable()
    ) {
      if (existing) this.options.secretStore.delete(existing.device_code_reference);
      this.options.credentialStore.reset();
      this.clearRecord();
      existing = null;
    }
    if (
      !activeIdentity &&
      existing &&
      (existing.state === "creating" || isLiveEnrollmentRecord(existing))
    ) {
      const deviceCode = this.options.secretStore.read(existing.device_code_reference);
      if (!deviceCode || !validDeviceCode(deviceCode)) {
        this.options.secretStore.delete(existing.device_code_reference);
        this.options.credentialStore.reset();
        this.clearRecord();
        existing = null;
      }
    }
    if (
      activeIdentity &&
      existing &&
      (existing.state === "creating" || isLiveEnrollmentRecord(existing))
    ) {
      if (existing.state === "creating") {
        this.options.secretStore.delete(existing.device_code_reference);
      } else {
        this.finish(existing, "active");
      }
    } else if (existing && isTerminalEnrollmentRecord(existing)) {
      this.options.secretStore.delete(existing.device_code_reference);
    }
  }

  get status(): PublicDeviceEnrollmentStatus {
    if (this.activeIdentityStore.read()) {
      return {
        state: "active",
        user_code: null,
        verification_uri: null,
        expires_at: null,
        next_poll_at: null,
      };
    }
    const record = this.readRecord();
    if (record?.state === "creating") {
      return {
        state: "credential_prepared",
        user_code: null,
        verification_uri: null,
        expires_at: null,
        next_poll_at: record.next_retry_at,
      };
    }
    if (record) return this.publicStatus(record);
    return {
      state: this.options.credentialStore.exists() ? "credential_prepared" : "not_enrolled",
      user_code: null,
      verification_uri: null,
      expires_at: null,
      next_poll_at: null,
    };
  }

  start(): void {
    this.stopped = false;
    this.scheduleFromRecord();
  }

  subscribe(listener: (status: PublicDeviceEnrollmentStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  async begin(input: { proposed_name: string }): Promise<PublicDeviceEnrollmentStatus> {
    if (this.activeIdentityStore.read()) return this.status;
    const existing = this.readRecord();
    if (existing?.state === "pending" || existing?.state === "approved_pending_redemption") {
      this.stopped = false;
      this.scheduleFromRecord();
      return this.publicStatus(existing);
    }
    if (existing?.state === "creating") {
      this.stopped = false;
      await this.performCreate(existing);
      return this.status;
    }

    // Durability boundary: the key and both codes exist before any request.
    this.options.credentialStore.prepare();
    const deviceCodeReference = randomBytes(32).toString("base64url");
    const deviceCode = randomBytes(32).toString("base64url");
    const initiating: InitiatingEnrollmentRecord = {
      version: 1,
      state: "creating",
      authorization_request_id: null,
      device_code_reference: deviceCodeReference,
      user_code: newHumanCode(),
      proposed_name: input.proposed_name.trim() || "This computer",
      os_family: localOsFamily(),
      architecture: arch(),
      network_backoff_seconds: 0,
      next_retry_at: this.now().toISOString(),
    };
    try {
      this.options.secretStore.writeOnce(deviceCodeReference, deviceCode);
      this.persist(initiating);
    } catch (error) {
      this.options.secretStore.delete(deviceCodeReference);
      throw error;
    }
    this.stopped = false;
    await this.performCreate(initiating);
    return this.status;
  }

  /** Focused test and explicit local retry hook; normal operation uses timers. */
  async pollNow(): Promise<PublicDeviceEnrollmentStatus> {
    if (!this.polling) {
      this.polling = this.performPoll().finally(() => {
        this.polling = null;
      });
    }
    await this.polling;
    return this.status;
  }

  private async performPoll(): Promise<void> {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const record = this.readRecord();
    if (!record) return;
    if (record.state === "creating") {
      await this.performCreate(record);
      return;
    }
    if (!isLiveEnrollmentRecord(record)) return;
    if (this.now().getTime() >= Date.parse(record.expires_at)) {
      this.finish(record, "expired");
      return;
    }
    const deviceCode = this.options.secretStore.read(record.device_code_reference);
    if (!deviceCode || !validDeviceCode(deviceCode)) {
      throw new Error("device enrollment credential is unavailable");
    }
    const credential = this.options.credentialStore.read();
    if (!credential) throw new Error("device enrollment key is unavailable");
    const redeeming = record.state === "approved_pending_redemption";
    const body: Record<string, string> = { device_code: deviceCode };
    if (redeeming) {
      body.public_key_pem = credential.public_key_pem;
      body.proof_signature_base64 = this.options.credentialStore.sign(
        redemptionProofPayload({
          authorization_request_id: record.authorization_request_id,
          device_code: deviceCode,
          public_key_fingerprint: credential.public_key_fingerprint,
        }),
      );
    }

    let outcome: DeviceAuthorizationPollOutcomeT;
    try {
      const response = await this.fetcher(
        new URL("/api/device-authorizations/token", this.options.serverUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        throw new Error(`device authorization polling was refused (${response.status})`);
      }
      outcome = DeviceAuthorizationPollOutcome.parse(await response.json());
    } catch {
      this.scheduleNetworkRetry(record);
      throw new Error("device authorization polling failed");
    }

    switch (outcome.outcome) {
      case "authorization_pending":
        this.scheduleRetry(record, outcome.retry_after_seconds, true);
        return;
      case "slow_down":
        this.scheduleRetry(record, outcome.retry_after_seconds, true);
        return;
      case "approved_pending_redemption": {
        if (outcome.authorization_request_id !== record.authorization_request_id) {
          throw new Error("device authorization response changed request identity");
        }
        const approved: LiveEnrollmentRecord = {
          ...record,
          state: "approved_pending_redemption",
          network_backoff_seconds: 0,
          next_poll_at: this.now().toISOString(),
        };
        this.persist(approved);
        this.notify(approved);
        // Persist approval before proof redemption. A lost active response is
        // retried with the same protected code and key, so server idempotency
        // replays the exact committed identity.
        this.scheduleRetry(approved, 0);
        return;
      }
      case "active":
        if (!redeeming) throw new Error("unproven device activation was refused locally");
        this.activate(record, outcome.identity, outcome.generation);
        return;
      case "access_denied":
        this.finish(record, "denied");
        return;
      case "expired_token":
        this.finish(record, "expired");
        return;
    }
  }

  private async performCreate(record: InitiatingEnrollmentRecord): Promise<void> {
    const deviceCode = this.options.secretStore.read(record.device_code_reference);
    if (!deviceCode || !validDeviceCode(deviceCode)) {
      throw new Error("device enrollment credential is unavailable");
    }
    const credential = this.options.credentialStore.read();
    if (!credential) throw new Error("device enrollment key is unavailable");

    let response: Response;
    try {
      response = await this.fetcher(new URL("/api/device-authorizations", this.options.serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        body: JSON.stringify({
          device_code: deviceCode,
          user_code: record.user_code,
          public_key_pem: credential.public_key_pem,
          proposed_name: record.proposed_name,
          os_family: record.os_family,
          architecture: record.architecture,
        }),
      });
      if (!response.ok) {
        throw new Error(`device enrollment request was refused (${response.status})`);
      }
    } catch {
      this.scheduleCreateNetworkRetry(record);
      throw new Error("device enrollment request failed");
    }
    let created: CreatedAuthorization;
    try {
      created = parseCreatedAuthorization(await response.json());
    } catch {
      this.scheduleCreateNetworkRetry(record);
      throw new Error("device enrollment response was incomplete");
    }
    if (created.device_code !== deviceCode || created.user_code !== record.user_code) {
      throw new Error("device enrollment response changed the persisted codes");
    }
    const live: LiveEnrollmentRecord = {
      version: 1,
      state: "pending",
      authorization_request_id: created.authorization_request_id,
      device_code_reference: record.device_code_reference,
      user_code: created.user_code,
      verification_uri: created.verification_uri,
      expires_at: created.expires_at,
      poll_interval_seconds: created.interval_seconds,
      network_backoff_seconds: 0,
      next_poll_at: new Date(this.now().getTime() + created.interval_seconds * 1_000).toISOString(),
    };
    this.persist(live);
    this.notify(live);
    if (Date.parse(live.expires_at) <= this.now().getTime()) {
      this.finish(live, "expired");
      return;
    }
    this.scheduleFromRecord();
  }

  private activate(
    record: LiveEnrollmentRecord,
    identity: { device_id: string; credential_id: string },
    generation: number,
  ): ActiveDeviceIdentity {
    const active = this.activeIdentityStore.activateFromRedemption({
      device_id: identity.device_id,
      credential_id: identity.credential_id,
      generation,
      activated_at: this.now().toISOString(),
    });
    this.finish(record, "active");
    return active;
  }

  private finish(record: LiveEnrollmentRecord, state: "active" | "denied" | "expired"): void {
    const terminal: TerminalEnrollmentRecord = {
      version: 1,
      state,
      authorization_request_id: record.authorization_request_id,
      device_code_reference: record.device_code_reference,
      user_code: null,
      verification_uri: null,
      expires_at: record.expires_at,
      poll_interval_seconds: record.poll_interval_seconds,
      network_backoff_seconds: 0,
      next_poll_at: null,
    };
    this.persist(terminal);
    this.options.secretStore.delete(record.device_code_reference);
    this.notify(terminal);
  }

  private scheduleRetry(
    record: LiveEnrollmentRecord,
    seconds: number,
    resetNetworkBackoff = false,
  ): void {
    const boundedSeconds = Math.max(0, Math.min(3_600, Math.ceil(seconds)));
    const updated: LiveEnrollmentRecord = {
      ...record,
      poll_interval_seconds: Math.max(record.poll_interval_seconds, boundedSeconds || 1),
      network_backoff_seconds: resetNetworkBackoff ? 0 : record.network_backoff_seconds,
      next_poll_at: new Date(this.now().getTime() + boundedSeconds * 1_000).toISOString(),
    };
    this.persist(updated);
    this.notify(updated);
    this.scheduleFromRecord();
  }

  private scheduleNetworkRetry(record: LiveEnrollmentRecord): void {
    const nextBackoff =
      record.network_backoff_seconds === 0
        ? Math.min(300, Math.max(10, record.poll_interval_seconds * 2))
        : Math.min(300, record.network_backoff_seconds * 2);
    const updated: LiveEnrollmentRecord = {
      ...record,
      network_backoff_seconds: nextBackoff,
      next_poll_at: new Date(this.now().getTime() + nextBackoff * 1_000).toISOString(),
    };
    this.persist(updated);
    this.notify(updated);
    this.scheduleFromRecord();
  }

  private scheduleCreateNetworkRetry(record: InitiatingEnrollmentRecord): void {
    const nextBackoff =
      record.network_backoff_seconds === 0 ? 10 : Math.min(300, record.network_backoff_seconds * 2);
    const updated: InitiatingEnrollmentRecord = {
      ...record,
      network_backoff_seconds: nextBackoff,
      next_retry_at: new Date(this.now().getTime() + nextBackoff * 1_000).toISOString(),
    };
    this.persist(updated);
    this.scheduleFromRecord();
  }

  private scheduleFromRecord(): void {
    if (this.stopped || this.timer) return;
    const record = this.readRecord();
    if (!record || (!isLiveEnrollmentRecord(record) && record.state !== "creating")) return;
    const nextAttempt = record.state === "creating" ? record.next_retry_at : record.next_poll_at;
    const delay = Math.max(0, Date.parse(nextAttempt) - this.now().getTime());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.pollNow().catch(() => {
        // State retains the protected credential and next retry. No response
        // body or device code is surfaced through an error/log path.
      });
    }, delay);
    this.timer.unref?.();
  }

  private readRecord(): EnrollmentRecord | null {
    if (!existsSync(this.path)) return null;
    ensurePrivateDirectory(this.options.dataDir);
    chmodSync(this.path, 0o600);
    return parseEnrollmentRecord(readFileSync(this.path, "utf8"));
  }

  private clearRecord(): void {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist(record: EnrollmentRecord): void {
    ensurePrivateDirectory(this.options.dataDir);
    const temporaryPath = `${this.path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.path);
      chmodSync(this.path, 0o600);
      let directoryDescriptor: number | null = null;
      try {
        directoryDescriptor = openSync(this.options.dataDir, "r");
        fsyncSync(directoryDescriptor);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      } finally {
        if (directoryDescriptor !== null) closeSync(directoryDescriptor);
      }
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The previous complete state remains authoritative.
      }
    }
  }

  private publicStatus(
    record: LiveEnrollmentRecord | TerminalEnrollmentRecord,
  ): PublicDeviceEnrollmentStatus {
    return {
      state: record.state,
      user_code: record.user_code,
      verification_uri: record.verification_uri,
      expires_at: record.expires_at,
      next_poll_at: record.next_poll_at,
    };
  }

  private notify(record: LiveEnrollmentRecord | TerminalEnrollmentRecord): void {
    const status = this.publicStatus(record);
    this.options.onStateChange?.(status);
    for (const listener of this.listeners) listener(status);
  }
}
