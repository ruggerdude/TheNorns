import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
  DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
  DEVICE_WSS_PROTOCOL_VERSION,
  type DeviceCancellationEvidenceFrameT,
  canonicalDeviceCancellationEvidenceWssTranscript,
  canonicalDeviceWssAuthenticationTranscript,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export interface DeviceWssAuthenticationCandidate {
  device_id: string;
  owner_user_id: string | null;
  device_lifecycle: "active" | "revoked";
  current_generation: number;
  credential_id: string;
  credential_device_id: string;
  credential_generation: number;
  credential_state: "active" | "revoked";
  public_key_spki_der: Buffer;
  owner_status: string | null;
}

export interface DeviceWssAuthenticationRepository {
  withLockedCandidate<T>(
    deviceId: string,
    credentialId: string,
    assess: (candidate: DeviceWssAuthenticationCandidate | null) => Promise<T> | T,
  ): Promise<T>;
  recordObservation?(input: {
    device_id: string;
    credential_id: string;
    generation: number;
    agent_version: string;
    protocol_version: string;
    capabilities: readonly string[];
    observed_at: string;
  }): Promise<void>;
}

export interface DeviceWssAuthenticationRequest {
  device_id: string;
  credential_id: string;
  generation: number;
  protocol_version: string;
  agent_version?: string;
  capabilities?: readonly string[];
  challenge: string;
  transcript_signature: string;
}

export interface AuthenticatedDeviceWssIdentity {
  device_id: string;
  owner_user_id: string;
  credential_id: string;
  generation: number;
  protocol_version: string;
}

export interface DeviceWssAuthenticator {
  readonly supportedProtocolVersions: readonly string[];
  authenticate(
    request: DeviceWssAuthenticationRequest,
  ): Promise<AuthenticatedDeviceWssIdentity | null>;
  verifyCancellationEvidence(frame: DeviceCancellationEvidenceFrameT): Promise<boolean>;
}

interface DeviceWssAuthenticationRow {
  device_id: string;
  owner_user_id: string | null;
  device_lifecycle: "active" | "revoked";
  current_generation: number | string;
  credential_id: string;
  credential_device_id: string;
  credential_generation: number | string;
  credential_state: "active" | "revoked";
  public_key_spki_der: Buffer | Uint8Array;
  owner_status: string | null;
}

/**
 * Exact device+credential lookup. Deliberately no repository registration,
 * project membership, or grant table participates in connection identity.
 */
export class PostgresDeviceWssAuthenticationRepository
  implements DeviceWssAuthenticationRepository
{
  constructor(private readonly transactions: V2TransactionRunner) {}

  withLockedCandidate<T>(
    deviceId: string,
    credentialId: string,
    assess: (candidate: DeviceWssAuthenticationCandidate | null) => Promise<T> | T,
  ): Promise<T> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<DeviceWssAuthenticationRow>(
        `SELECT
           device.id AS device_id,
           device.owner_user_id,
           device.lifecycle AS device_lifecycle,
           device.current_generation,
           credential.id AS credential_id,
           credential.device_id AS credential_device_id,
           credential.generation AS credential_generation,
           credential.state AS credential_state,
           credential.public_key_spki_der,
           owner.status AS owner_status
         FROM devices device
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.id=$2
         JOIN users owner ON owner.id=device.owner_user_id
        WHERE device.id=$1
        FOR UPDATE OF device,credential,owner`,
        [deviceId, credentialId],
      );
      const row = selected.rows[0];
      return assess(
        row
          ? {
              device_id: row.device_id,
              owner_user_id: row.owner_user_id,
              device_lifecycle: row.device_lifecycle,
              current_generation: Number(row.current_generation),
              credential_id: row.credential_id,
              credential_device_id: row.credential_device_id,
              credential_generation: Number(row.credential_generation),
              credential_state: row.credential_state,
              public_key_spki_der: Buffer.from(row.public_key_spki_der),
              owner_status: row.owner_status,
            }
          : null,
      );
    });
  }

  recordObservation(input: {
    device_id: string;
    credential_id: string;
    generation: number;
    agent_version: string;
    protocol_version: string;
    capabilities: readonly string[];
    observed_at: string;
  }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      await sql.query(
        `UPDATE devices device
            SET agent_version=$4,
                agent_protocol_version=$5,
                agent_capabilities=$6::jsonb,
                last_seen_at=GREATEST(COALESCE(last_seen_at,$7),$7)
          WHERE device.id=$1
            AND device.lifecycle='active'
            AND device.current_generation=$3
            AND EXISTS (
              SELECT 1
                FROM device_credentials credential
               WHERE credential.device_id=device.id
                 AND credential.id=$2
                 AND credential.generation=$3
                 AND credential.state='active'
            )`,
        [
          input.device_id,
          input.credential_id,
          input.generation,
          input.agent_version,
          input.protocol_version,
          JSON.stringify(input.capabilities),
          input.observed_at,
        ],
      );
    });
  }
}

export class DeviceWssAuthenticationService implements DeviceWssAuthenticator {
  readonly supportedProtocolVersions: readonly string[];
  private readonly supportedProtocolVersionSet: ReadonlySet<string>;

  constructor(
    private readonly repository: DeviceWssAuthenticationRepository,
    options: { supportedProtocolVersions?: readonly string[]; now?: () => Date } = {},
  ) {
    const versions = options.supportedProtocolVersions ?? [DEVICE_WSS_PROTOCOL_VERSION];
    if (versions.length === 0 || versions.some((version) => !version.trim())) {
      throw new Error("at least one non-empty device WSS protocol version is required");
    }
    this.supportedProtocolVersions = Object.freeze([...new Set(versions)]);
    this.supportedProtocolVersionSet = new Set(this.supportedProtocolVersions);
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async authenticate(
    request: DeviceWssAuthenticationRequest,
  ): Promise<AuthenticatedDeviceWssIdentity | null> {
    if (!this.supportedProtocolVersionSet.has(request.protocol_version)) return null;
    if (!Number.isSafeInteger(request.generation) || request.generation <= 0) return null;

    const authenticated = await this.repository.withLockedCandidate(
      request.device_id,
      request.credential_id,
      (candidate) => {
        if (
          !candidate ||
          candidate.device_id !== request.device_id ||
          candidate.credential_id !== request.credential_id ||
          candidate.credential_device_id !== candidate.device_id
        ) {
          return null;
        }

        const transcript = canonicalDeviceWssAuthenticationTranscript({
          purpose: DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
          device_id: request.device_id,
          credential_id: request.credential_id,
          generation: request.generation,
          protocol_version: request.protocol_version,
          ...(request.agent_version !== undefined
            ? {
                agent_version: request.agent_version,
                capabilities: [...(request.capabilities ?? [])],
              }
            : {}),
          challenge: request.challenge,
        });
        try {
          const publicKey = createPublicKey({
            key: candidate.public_key_spki_der,
            format: "der",
            type: "spki",
          });
          const valid = edVerify(
            null,
            Buffer.from(transcript, "utf8"),
            publicKey,
            Buffer.from(request.transcript_signature, "base64"),
          );
          if (!valid) return null;
        } catch {
          return null;
        }

        // This is the final acceptance decision and still runs inside the
        // repository transaction while device, credential, and owner rows are
        // locked. Revocation cannot pass this point concurrently.
        if (
          candidate.device_lifecycle !== "active" ||
          candidate.owner_user_id === null ||
          candidate.owner_status !== "active" ||
          candidate.credential_state !== "active" ||
          candidate.current_generation !== request.generation ||
          candidate.credential_generation !== request.generation
        ) {
          return null;
        }

        return {
          device_id: candidate.device_id,
          owner_user_id: candidate.owner_user_id,
          credential_id: candidate.credential_id,
          generation: candidate.current_generation,
          protocol_version: request.protocol_version,
        };
      },
    );
    if (
      authenticated &&
      request.agent_version !== undefined &&
      request.capabilities !== undefined &&
      this.repository.recordObservation
    ) {
      await this.repository.recordObservation({
        device_id: authenticated.device_id,
        credential_id: authenticated.credential_id,
        generation: authenticated.generation,
        agent_version: request.agent_version,
        protocol_version: authenticated.protocol_version,
        capabilities: [...request.capabilities],
        observed_at: this.now().toISOString(),
      });
    }
    return authenticated;
  }

  verifyCancellationEvidence(frame: DeviceCancellationEvidenceFrameT): Promise<boolean> {
    return this.repository.withLockedCandidate(
      frame.device_id,
      frame.credential_id,
      (candidate) => {
        if (
          !candidate ||
          candidate.device_id !== frame.device_id ||
          candidate.credential_id !== frame.credential_id ||
          candidate.credential_device_id !== candidate.device_id ||
          candidate.credential_generation !== frame.generation
        ) {
          return false;
        }
        try {
          const publicKey = createPublicKey({
            key: candidate.public_key_spki_der,
            format: "der",
            type: "spki",
          });
          const transcript = canonicalDeviceCancellationEvidenceWssTranscript({
            purpose: DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
            device_id: frame.device_id,
            credential_id: frame.credential_id,
            generation: frame.generation,
            run_id: frame.run_id,
            evidence_state: frame.evidence_state,
            acknowledged_at: frame.acknowledged_at,
            process_exited_at: frame.process_exited_at,
            process_tree_reaped: frame.process_tree_reaped,
          });
          return edVerify(
            null,
            Buffer.from(transcript, "utf8"),
            publicKey,
            Buffer.from(frame.transcript_signature, "base64"),
          );
        } catch {
          return false;
        }
      },
    );
  }
}
