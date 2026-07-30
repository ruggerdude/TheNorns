import { type KeyObject, createHash, createPublicKey, sign, verify } from "node:crypto";
import {
  DEVICE_PUBLICATION_PERMIT_PURPOSE,
  DevicePublicationPermitClaims,
  type DevicePublicationPermitConsumeResponseT,
  type DevicePublicationPermitIssueRequestT,
  SignedDevicePublicationPermit,
  type SignedDevicePublicationPermitT,
  serializeDevicePublicationPermitClaims,
} from "@norns/contracts";

import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export interface ExactConnectedDeviceIdentity {
  device_id: string;
  credential_id: string;
  generation: number;
}

export interface DevicePublicationPermitPresence {
  isConnectedIdentity(identity: ExactConnectedDeviceIdentity): boolean;
}

interface PublicationScopeRow {
  project_id: string;
}

interface ConsumedPermitRow {
  permit_id: string;
  consumed_at: string | Date;
}

export class DevicePublicationPermitError extends Error {
  constructor(
    readonly code:
      | "publication_not_authorized"
      | "device_offline"
      | "invalid_permit"
      | "permit_expired"
      | "permit_consumed",
  ) {
    super(code);
    this.name = "DevicePublicationPermitError";
  }
}

async function authorizedPublicationScope(
  sql: V2SqlExecutor,
  input: DevicePublicationPermitIssueRequestT & ExactConnectedDeviceIdentity,
  lock: boolean,
): Promise<PublicationScopeRow | null> {
  const selected = await sql.query<PublicationScopeRow>(
    `SELECT project.id AS project_id
       FROM agent_runs run
       JOIN projects project
         ON project.id=run.project_id
        AND project.status='active'
        AND project.primary_repository_binding_id=$4
       JOIN users run_actor
         ON run_actor.id=run.initiated_by_user_id
        AND run_actor.status='active'
       JOIN repository_bindings binding
         ON binding.id=$4
        AND binding.id=run.repository_binding_id
        AND binding.project_id=project.id
        AND binding.binding_type='local_runner'
        AND binding.status='connected'
        AND binding.project_device_repository_grant_id=$3
        AND binding.repository_id=$5
       JOIN project_device_repository_grants grant_record
         ON grant_record.id=$3
         AND grant_record.project_id=project.id
        AND grant_record.repository_registration_id=$2
        AND grant_record.state='active'
       JOIN device_repository_registrations registration
         ON registration.id=$2
        AND registration.id=grant_record.repository_registration_id
        AND registration.device_id=$7
        AND registration.repository_id=$5
        AND registration.workspace_id=binding.workspace_id
        AND registration.state='active'
        AND registration.approved_credential_id=$8
        AND registration.approved_generation=$9
       JOIN devices device
         ON device.id=registration.device_id
        AND device.lifecycle='active'
        AND device.current_generation=$9
       JOIN users device_owner
         ON device_owner.id=device.owner_user_id
        AND device_owner.status='active'
       JOIN device_credentials credential
         ON credential.device_id=device.id
        AND credential.id=$8
        AND credential.generation=$9
        AND credential.state='active'
       JOIN commands command
         ON command.command_id=(
           SELECT latest.command_id
             FROM commands latest
            WHERE latest.run_id=run.id
            ORDER BY latest.created_at DESC,latest.command_id DESC
            LIMIT 1
         )
        AND command.runner_id=device.id
        AND command.runner_generation=$9
        AND command.envelope->>'target_branch'=$6
      WHERE run.id=$1
        AND run.state IN (
          'dispatched','running','waiting_for_human','verifying'
        )
        AND (
          project.owner_user_id=run_actor.id
          OR EXISTS (
            SELECT 1
              FROM project_members membership
             WHERE membership.project_id=project.id
               AND membership.user_id=run_actor.id
               AND membership.status='active'
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM device_run_cancellations cancellation
           WHERE cancellation.run_id=run.id
             AND cancellation.publication_fenced_at IS NOT NULL
             AND cancellation.publication_reauthorized_at IS NULL
        )
      ${lock ? "FOR UPDATE OF run,project,binding,grant_record,registration,device,credential" : ""}`,
    [
      input.run_id,
      input.repository_registration_id,
      input.project_device_repository_grant_id,
      input.repository_binding_id,
      input.repository_id,
      input.branch,
      input.device_id,
      input.credential_id,
      input.generation,
    ],
  );
  return selected.rows[0] ?? null;
}

function timestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function permitHash(permit: SignedDevicePublicationPermitT["permit"]): string {
  return createHash("sha256")
    .update(serializeDevicePublicationPermitClaims(permit), "utf8")
    .digest("hex");
}

/**
 * Server-signed, one-use publication authorization. Authentication proves the
 * caller; this service separately revalidates the complete current execution
 * scope immediately before both issuance and consumption.
 */
export class DevicePublicationPermitService {
  private readonly publicKey: KeyObject;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly presence: DevicePublicationPermitPresence,
    private readonly signingKey: { key_id: string; private_key: KeyObject },
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 30_000,
  ) {
    if (signingKey.private_key.asymmetricKeyType !== "ed25519") {
      throw new Error("publication permit signing key must be Ed25519");
    }
    if (ttlMs <= 0 || ttlMs > 30_000) {
      throw new Error("publication permit TTL must be between 1 and 30000 milliseconds");
    }
    this.publicKey = createPublicKey(
      signingKey.private_key.export({ format: "pem", type: "pkcs8" }),
    );
  }

  async issue(
    identity: ExactConnectedDeviceIdentity,
    request: DevicePublicationPermitIssueRequestT,
  ): Promise<SignedDevicePublicationPermitT> {
    if (!this.presence.isConnectedIdentity(identity)) {
      throw new DevicePublicationPermitError("device_offline");
    }
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs);
    return this.transactions.transaction(async (sql) => {
      const scope = await authorizedPublicationScope(sql, { ...request, ...identity }, true);
      if (!scope) throw new DevicePublicationPermitError("publication_not_authorized");
      const permit = DevicePublicationPermitClaims.parse({
        purpose: DEVICE_PUBLICATION_PERMIT_PURPOSE,
        permit_id: newId("publication-permit"),
        ...request,
        ...identity,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
      const signatureBase64 = sign(
        null,
        Buffer.from(serializeDevicePublicationPermitClaims(permit), "utf8"),
        this.signingKey.private_key,
      ).toString("base64");
      const signed = SignedDevicePublicationPermit.parse({
        permit,
        key_id: this.signingKey.key_id,
        signature_base64: signatureBase64,
      });
      await sql.query(
        `INSERT INTO device_publication_permits (
           id,run_id,project_id,device_id,credential_id,device_generation,
           repository_registration_id,project_device_repository_grant_id,
           repository_binding_id,repository_id,branch,commit_sha,signing_key_id,
           permit_sha256,issued_at,expires_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )`,
        [
          permit.permit_id,
          permit.run_id,
          scope.project_id,
          permit.device_id,
          permit.credential_id,
          permit.generation,
          permit.repository_registration_id,
          permit.project_device_repository_grant_id,
          permit.repository_binding_id,
          permit.repository_id,
          permit.branch,
          permit.commit_sha,
          signed.key_id,
          permitHash(permit),
          permit.issued_at,
          permit.expires_at,
        ],
      );
      return signed;
    });
  }

  async consume(
    identity: ExactConnectedDeviceIdentity,
    signed: SignedDevicePublicationPermitT,
  ): Promise<DevicePublicationPermitConsumeResponseT> {
    const parsed = SignedDevicePublicationPermit.safeParse(signed);
    if (!parsed.success || parsed.data.key_id !== this.signingKey.key_id) {
      throw new DevicePublicationPermitError("invalid_permit");
    }
    const permit = parsed.data.permit;
    if (
      permit.device_id !== identity.device_id ||
      permit.credential_id !== identity.credential_id ||
      permit.generation !== identity.generation
    ) {
      throw new DevicePublicationPermitError("invalid_permit");
    }
    const signature = Buffer.from(parsed.data.signature_base64, "base64");
    if (
      signature.byteLength !== 64 ||
      signature.toString("base64") !== parsed.data.signature_base64 ||
      !verify(
        null,
        Buffer.from(serializeDevicePublicationPermitClaims(permit), "utf8"),
        this.publicKey,
        signature,
      )
    ) {
      throw new DevicePublicationPermitError("invalid_permit");
    }
    const now = this.now();
    const issuedAt = Date.parse(permit.issued_at);
    const expiresAt = Date.parse(permit.expires_at);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 30_000 ||
      now.getTime() < issuedAt ||
      now.getTime() > expiresAt
    ) {
      throw new DevicePublicationPermitError("permit_expired");
    }
    if (!this.presence.isConnectedIdentity(identity)) {
      throw new DevicePublicationPermitError("device_offline");
    }

    return this.transactions.transaction(async (sql) => {
      const stored = await sql.query<{ id: string; consumed_at: string | Date | null }>(
        `SELECT id,consumed_at
           FROM device_publication_permits
          WHERE id=$1
            AND permit_sha256=$2
            AND signing_key_id=$3
            AND run_id=$4
            AND device_id=$5
            AND credential_id=$6
            AND device_generation=$7
            AND repository_registration_id=$8
            AND project_device_repository_grant_id=$9
            AND repository_binding_id=$10
            AND repository_id=$11
            AND branch=$12
            AND commit_sha=$13
            AND issued_at=$14
            AND expires_at=$15
          FOR UPDATE`,
        [
          permit.permit_id,
          permitHash(permit),
          parsed.data.key_id,
          permit.run_id,
          permit.device_id,
          permit.credential_id,
          permit.generation,
          permit.repository_registration_id,
          permit.project_device_repository_grant_id,
          permit.repository_binding_id,
          permit.repository_id,
          permit.branch,
          permit.commit_sha,
          permit.issued_at,
          permit.expires_at,
        ],
      );
      if (!stored.rows[0]) throw new DevicePublicationPermitError("invalid_permit");
      if (stored.rows[0].consumed_at !== null) {
        throw new DevicePublicationPermitError("permit_consumed");
      }
      const scope = await authorizedPublicationScope(
        sql,
        {
          run_id: permit.run_id,
          repository_registration_id: permit.repository_registration_id,
          project_device_repository_grant_id: permit.project_device_repository_grant_id,
          repository_binding_id: permit.repository_binding_id,
          repository_id: permit.repository_id,
          branch: permit.branch,
          commit_sha: permit.commit_sha,
          ...identity,
        },
        true,
      );
      if (!scope) throw new DevicePublicationPermitError("publication_not_authorized");
      const consumed = await sql.query<ConsumedPermitRow>(
        `UPDATE device_publication_permits
            SET consumed_at=$2
          WHERE id=$1
            AND consumed_at IS NULL
            AND expires_at >= $2
          RETURNING id AS permit_id,consumed_at`,
        [permit.permit_id, now.toISOString()],
      );
      const row = consumed.rows[0];
      if (!row) throw new DevicePublicationPermitError("permit_expired");
      return {
        outcome: "authorized",
        permit_id: row.permit_id,
        consumed_at: timestamp(row.consumed_at),
      };
    });
  }
}
