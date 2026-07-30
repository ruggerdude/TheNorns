import { newId } from "../ids.js";
import {
  type DeviceEnrollmentCodeHasher,
  canonicalDevicePublicKey,
  enrollmentRedemptionProofPayload,
  isValidDeviceCode,
  normalizeHumanCode,
  timingSafeHexEqual,
  verifyEnrollmentProof,
} from "./crypto.js";
import {
  type CreatedDeviceAuthorization,
  type DeviceAuthorizationLookup,
  DeviceEnrollmentError,
  type DeviceEnrollmentPollOutcome,
  type DeviceEnrollmentRepository,
  type DeviceOsFamily,
} from "./domain.js";

const DEFAULT_AUTHORIZATION_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_REDEMPTION_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface DeviceEnrollmentServiceOptions {
  codeHasher: DeviceEnrollmentCodeHasher;
  verificationUri: string;
  now?: () => Date;
  authorizationTtlMs?: number;
  redemptionResultTtlMs?: number;
  initialPollIntervalSeconds?: number;
  newId?: (prefix: string) => string;
}

export class DeviceEnrollmentService {
  private readonly now: () => Date;
  private readonly authorizationTtlMs: number;
  private readonly initialPollIntervalSeconds: number;
  private readonly redemptionResultTtlMs: number;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly repository: DeviceEnrollmentRepository,
    private readonly options: DeviceEnrollmentServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.authorizationTtlMs = options.authorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
    this.initialPollIntervalSeconds =
      options.initialPollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    this.redemptionResultTtlMs = options.redemptionResultTtlMs ?? DEFAULT_REDEMPTION_RESULT_TTL_MS;
    this.createId = options.newId ?? newId;
    if (this.authorizationTtlMs <= 0 || !Number.isSafeInteger(this.authorizationTtlMs)) {
      throw new Error("device authorization TTL must be a positive integer");
    }
    if (
      this.initialPollIntervalSeconds <= 0 ||
      !Number.isSafeInteger(this.initialPollIntervalSeconds)
    ) {
      throw new Error("device polling interval must be a positive integer");
    }
    if (this.redemptionResultTtlMs <= 0 || !Number.isSafeInteger(this.redemptionResultTtlMs)) {
      throw new Error("device redemption result TTL must be a positive integer");
    }
    const uri = new URL(options.verificationUri);
    const isExactLoopbackIp = uri.hostname === "127.0.0.1" || uri.hostname === "[::1]";
    const isAllowedTransport =
      uri.protocol === "https:" || (uri.protocol === "http:" && isExactLoopbackIp);
    if (!isAllowedTransport || uri.search || uri.hash || uri.username || uri.password) {
      throw new Error("device verification URI must be code-free HTTPS or exact loopback HTTP");
    }
  }

  async createAuthorization(input: {
    device_code: string;
    user_code: string;
    public_key_pem: string;
    proposed_name: string;
    os_family: DeviceOsFamily;
    architecture: string;
  }): Promise<CreatedDeviceAuthorization> {
    const proposedName = input.proposed_name.trim();
    const architecture = input.architecture.trim();
    if (
      !proposedName ||
      proposedName.length > 200 ||
      !["macos", "windows", "linux", "other"].includes(input.os_family) ||
      !architecture ||
      architecture.length > 100
    ) {
      throw new DeviceEnrollmentError("invalid_device_metadata");
    }
    let key: ReturnType<typeof canonicalDevicePublicKey>;
    try {
      key = canonicalDevicePublicKey(input.public_key_pem);
    } catch {
      throw new DeviceEnrollmentError("invalid_public_key");
    }
    const issuedAt = this.now();
    const deviceCode = input.device_code;
    const normalizedHumanCode = normalizeHumanCode(input.user_code);
    if (!isValidDeviceCode(deviceCode) || !normalizedHumanCode) {
      throw new Error("device enrollment code generator returned an invalid code");
    }
    const authorizationRequestId = this.createId("deviceauth");
    const expiresAt = new Date(issuedAt.getTime() + this.authorizationTtlMs);
    const created = await this.repository.createAuthorization({
      authorization_request_id: authorizationRequestId,
      device_code_hash: this.options.codeHasher.hashDeviceCode(deviceCode),
      human_code_hash: this.options.codeHasher.hashHumanCode(normalizedHumanCode),
      public_key_spki_der: key.canonical_spki_der,
      public_key_fingerprint: key.fingerprint,
      proposed_name: proposedName,
      os_family: input.os_family,
      architecture,
      expires_at: expiresAt.toISOString(),
      poll_interval_seconds: this.initialPollIntervalSeconds,
      created_at: issuedAt.toISOString(),
    });
    if (!created) {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    return {
      authorization_request_id: created.authorization_request_id,
      device_code: deviceCode,
      user_code: `${normalizedHumanCode.slice(0, 4)}-${normalizedHumanCode.slice(4)}`,
      verification_uri: this.options.verificationUri,
      expires_at: created.expires_at,
      interval_seconds: created.poll_interval_seconds,
    };
  }

  async lookup(input: { user_code: string }): Promise<DeviceAuthorizationLookup> {
    const humanCode = normalizeHumanCode(input.user_code);
    if (!humanCode) throw new DeviceEnrollmentError("authorization_not_available");
    const found = await this.repository.lookupByHumanCode({
      human_code_hash: this.options.codeHasher.hashHumanCode(humanCode),
      now: this.now().toISOString(),
    });
    if (!found || found.state !== "pending") {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    return {
      authorization_request_id: found.authorization_request_id,
      authorization_context: this.options.codeHasher.createAuthorizationContext({
        authorization_request_id: found.authorization_request_id,
        human_code_hash: found.human_code_hash,
      }),
      proposed_name: found.proposed_name,
      os_family: found.os_family,
      architecture: found.architecture,
      public_key_fingerprint: found.public_key_fingerprint,
      expires_at: found.expires_at,
    };
  }

  async approve(input: {
    authorization_request_id: string;
    authorization_context: string;
    owner_user_id: string;
  }): Promise<{ authorization_request_id: string; state: "approved_pending_redemption" }> {
    if (
      !input.authorization_request_id.trim() ||
      !input.authorization_context ||
      !input.owner_user_id.trim()
    ) {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    const now = this.now().toISOString();
    const candidate = await this.repository.getDecisionCandidate({
      authorization_request_id: input.authorization_request_id,
      now,
    });
    if (
      !candidate ||
      !this.options.codeHasher.verifyAuthorizationContext({
        authorization_request_id: input.authorization_request_id,
        human_code_hash: candidate.human_code_hash,
        authorization_context: input.authorization_context,
      })
    ) {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    const approved = await this.repository.approve({
      authorization_request_id: input.authorization_request_id,
      human_code_hash: candidate.human_code_hash,
      owner_user_id: input.owner_user_id,
      now,
    });
    if (!approved || approved.state !== "approved_pending_redemption") {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    return {
      authorization_request_id: approved.authorization_request_id,
      state: "approved_pending_redemption",
    };
  }

  async deny(input: {
    authorization_request_id: string;
    authorization_context: string;
    denied_by_user_id: string;
  }): Promise<{ authorization_request_id: string; state: "denied" }> {
    if (
      !input.authorization_request_id.trim() ||
      !input.authorization_context ||
      !input.denied_by_user_id.trim()
    ) {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    const now = this.now().toISOString();
    const candidate = await this.repository.getDecisionCandidate({
      authorization_request_id: input.authorization_request_id,
      now,
    });
    if (
      !candidate ||
      !this.options.codeHasher.verifyAuthorizationContext({
        authorization_request_id: input.authorization_request_id,
        human_code_hash: candidate.human_code_hash,
        authorization_context: input.authorization_context,
      })
    ) {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    const denied = await this.repository.deny({
      authorization_request_id: input.authorization_request_id,
      human_code_hash: candidate.human_code_hash,
      denied_by_user_id: input.denied_by_user_id,
      now,
    });
    if (!denied || denied.state !== "denied") {
      throw new DeviceEnrollmentError("authorization_not_available");
    }
    return { authorization_request_id: denied.authorization_request_id, state: "denied" };
  }

  async poll(input: {
    device_code: string;
    public_key_pem?: string;
    proof_signature_base64?: string;
  }): Promise<DeviceEnrollmentPollOutcome> {
    if (!isValidDeviceCode(input.device_code)) return { outcome: "access_denied" };
    const deviceCodeHash = this.options.codeHasher.hashDeviceCode(input.device_code);
    const polled = await this.repository.poll({
      device_code_hash: deviceCodeHash,
      now: this.now().toISOString(),
    });
    if (polled.kind === "not_found" || polled.kind === "access_denied") {
      return { outcome: "access_denied" };
    }
    if (polled.kind === "expired_token") return { outcome: "expired_token" };
    if (polled.kind === "authorization_pending" || polled.kind === "slow_down") {
      return {
        outcome: polled.kind,
        retry_after_seconds: polled.retry_after_seconds,
      };
    }

    const record = polled.record;
    if (!input.public_key_pem || !input.proof_signature_base64) {
      return polled.kind === "active"
        ? { outcome: "access_denied" }
        : {
            outcome: "approved_pending_redemption",
            authorization_request_id: record.authorization_request_id,
          };
    }

    let suppliedKey: ReturnType<typeof canonicalDevicePublicKey>;
    try {
      suppliedKey = canonicalDevicePublicKey(input.public_key_pem);
    } catch {
      return { outcome: "access_denied" };
    }
    if (!timingSafeHexEqual(suppliedKey.fingerprint, record.public_key_fingerprint)) {
      return { outcome: "access_denied" };
    }
    const proof = enrollmentRedemptionProofPayload({
      authorization_request_id: record.authorization_request_id,
      device_code: input.device_code,
      public_key_fingerprint: record.public_key_fingerprint,
    });
    if (!verifyEnrollmentProof(record.public_key_spki_der, proof, input.proof_signature_base64)) {
      return { outcome: "access_denied" };
    }

    const redemptionTime = this.now();
    const redeemed = await this.repository.redeem({
      authorization_request_id: record.authorization_request_id,
      device_code_hash: deviceCodeHash,
      public_key_fingerprint: record.public_key_fingerprint,
      // Generated for the first redemption only. The repository ignores these
      // candidates and replays the committed result once the request is active.
      device_id: this.createId("device"),
      credential_id: this.createId("devicecred"),
      now: redemptionTime.toISOString(),
      redemption_result_expires_at: new Date(
        redemptionTime.getTime() + this.redemptionResultTtlMs,
      ).toISOString(),
    });
    if (redeemed.kind === "expired_token") return { outcome: "expired_token" };
    if (redeemed.kind === "access_denied") return { outcome: "access_denied" };
    return {
      outcome: "active",
      identity: {
        device_id: redeemed.device_id,
        credential_id: redeemed.credential_id,
      },
      generation: redeemed.generation,
    };
  }
}
