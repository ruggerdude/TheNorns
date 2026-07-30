import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type {
  CreateDeviceAuthorizationRecord,
  CreatedDeviceAuthorizationRecord,
  DeviceAuthorizationDecisionRecord,
  DeviceAuthorizationRequestRecord,
  DeviceEnrollmentRepository,
} from "./domain.js";

interface AuthorizationRequestRow {
  id: string;
  state: DeviceAuthorizationRequestRecord["state"];
  public_key_spki_der: Buffer | Uint8Array;
  public_key_fingerprint: string;
  proposed_name: string;
  os_family: DeviceAuthorizationRequestRecord["os_family"];
  architecture: string;
  user_code_hash_version: number | string;
  user_code_hash_key_id: string;
  user_code_keyed_hash: Buffer | Uint8Array;
  expires_at: string | Date;
  approved_by_user_id: string | null;
  approved_at: string | Date | null;
  denied_at: string | Date | null;
  expired_at: string | Date | null;
  redeemed_at: string | Date | null;
  last_polled_at: string | Date | null;
  effective_poll_interval_seconds: number | string;
  next_poll_at: string | Date | null;
  redeemed_device_id: string | null;
  redeemed_credential_id: string | null;
  redeemed_generation: number | string | null;
}

const AUTHORIZATION_REQUEST_COLUMNS = `
  id,state,public_key_spki_der,public_key_fingerprint,
  proposed_name,os_family,architecture,
  user_code_hash_version,user_code_hash_key_id,user_code_keyed_hash,expires_at,
  approved_by_user_id,approved_at,denied_at,expired_at,redeemed_at,
  last_polled_at,effective_poll_interval_seconds,next_poll_at,
  redeemed_device_id,redeemed_credential_id,redeemed_generation`;

function timestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function record(row: AuthorizationRequestRow): DeviceAuthorizationRequestRecord {
  return {
    authorization_request_id: row.id,
    state: row.state,
    public_key_spki_der: Buffer.from(row.public_key_spki_der),
    public_key_fingerprint: row.public_key_fingerprint,
    proposed_name: row.proposed_name,
    os_family: row.os_family,
    architecture: row.architecture,
    owner_user_id: row.approved_by_user_id,
    expires_at: timestamp(row.expires_at) ?? "",
    approved_at: timestamp(row.approved_at),
    redeemed_at: timestamp(row.redeemed_at),
    terminal_at: timestamp(row.denied_at) ?? timestamp(row.expired_at),
    last_polled_at: timestamp(row.last_polled_at),
    poll_interval_seconds: Number(row.effective_poll_interval_seconds),
    device_id: row.redeemed_device_id,
    credential_id: row.redeemed_credential_id,
    generation:
      row.redeemed_generation === null || row.redeemed_generation === undefined
        ? null
        : Number(row.redeemed_generation),
  };
}

function decisionRecord(row: AuthorizationRequestRow): DeviceAuthorizationDecisionRecord {
  return {
    ...record(row),
    human_code_hash: {
      version: Number(row.user_code_hash_version),
      key_id: row.user_code_hash_key_id,
      keyed_hash: Buffer.from(row.user_code_keyed_hash),
    },
  };
}

async function expireIfDue(
  sql: V2SqlExecutor,
  row: AuthorizationRequestRow,
  now: string,
): Promise<AuthorizationRequestRow> {
  if (
    (row.state !== "pending" && row.state !== "approved_pending_redemption") ||
    Date.parse(timestamp(row.expires_at) ?? "") > Date.parse(now)
  ) {
    return row;
  }
  const expired = await sql.query<AuthorizationRequestRow>(
    `UPDATE device_authorization_requests
        SET state='expired',expired_at=$2,updated_at=$2
      WHERE id=$1 AND state IN ('pending','approved_pending_redemption')
      RETURNING ${AUTHORIZATION_REQUEST_COLUMNS}`,
    [row.id, now],
  );
  return expired.rows[0] ?? row;
}

/**
 * PostgreSQL/PGlite repository for the 0053 additive enrollment tables.
 * Plaintext device and human codes never cross this boundary.
 */
export class PostgresDeviceEnrollmentRepository implements DeviceEnrollmentRepository {
  constructor(private readonly transactions: V2TransactionRunner) {}

  createAuthorization(
    input: CreateDeviceAuthorizationRecord,
  ): Promise<CreatedDeviceAuthorizationRecord | null> {
    return this.transactions.transaction(async (sql) => {
      // Expiry cannot depend on the offline agent polling an old request. Lock
      // the live request for this persisted key before releasing its partial
      // unique-index slot. `created_at` is trusted server time supplied by the
      // enrollment service, never an agent timestamp.
      await sql.query<{ id: string }>(
        `SELECT id
           FROM device_authorization_requests
          WHERE public_key_fingerprint=$1
            AND state IN ('pending','approved_pending_redemption')
          FOR UPDATE`,
        [input.public_key_fingerprint],
      );
      await sql.query(
        `UPDATE device_authorization_requests
            SET state='expired',expired_at=$2,updated_at=$2
          WHERE public_key_fingerprint=$1
            AND state IN ('pending','approved_pending_redemption')
            AND expires_at <= $2`,
        [input.public_key_fingerprint, input.created_at],
      );

      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO device_authorization_requests (
           id,state,public_key_spki_der,public_key_fingerprint,
           proposed_name,os_family,architecture,
           device_code_hash_version,device_code_hash_key_id,device_code_keyed_hash,
           user_code_hash_version,user_code_hash_key_id,user_code_keyed_hash,
           poll_interval_seconds,effective_poll_interval_seconds,
           next_poll_at,expires_at,created_at,updated_at
         )
         SELECT
           $1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           $13,$13,$14,$15,$16,$16
          WHERE NOT EXISTS (
            SELECT 1 FROM device_credentials WHERE public_key_fingerprint=$3
          )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.authorization_request_id,
          input.public_key_spki_der,
          input.public_key_fingerprint,
          input.proposed_name,
          input.os_family,
          input.architecture,
          input.device_code_hash.version,
          input.device_code_hash.key_id,
          input.device_code_hash.keyed_hash,
          input.human_code_hash.version,
          input.human_code_hash.key_id,
          input.human_code_hash.keyed_hash,
          input.poll_interval_seconds,
          input.created_at,
          input.expires_at,
          input.created_at,
        ],
      );
      if (inserted.rows[0]) {
        return {
          authorization_request_id: inserted.rows[0].id,
          expires_at: input.expires_at,
          poll_interval_seconds: input.poll_interval_seconds,
        };
      }

      // A retry after a lost create response carries the same agent-persisted
      // key and codes. Return only that exact request; conflicts on any one of
      // those values (or metadata) are not silently rebound to another live
      // authorization.
      const replay = await sql.query<{
        id: string;
        expires_at: string | Date;
        effective_poll_interval_seconds: number | string;
      }>(
        `SELECT id,expires_at,effective_poll_interval_seconds
           FROM device_authorization_requests
          WHERE public_key_fingerprint=$1
            AND public_key_spki_der=$2
            AND device_code_hash_version=$3
            AND device_code_hash_key_id=$4
            AND device_code_keyed_hash=$5
            AND user_code_hash_version=$6
            AND user_code_hash_key_id=$7
            AND user_code_keyed_hash=$8
            AND proposed_name=$9
            AND os_family=$10
            AND architecture=$11
            AND state IN ('pending','approved_pending_redemption','active')
          ORDER BY created_at DESC,id DESC
          LIMIT 1
          FOR UPDATE`,
        [
          input.public_key_fingerprint,
          input.public_key_spki_der,
          input.device_code_hash.version,
          input.device_code_hash.key_id,
          input.device_code_hash.keyed_hash,
          input.human_code_hash.version,
          input.human_code_hash.key_id,
          input.human_code_hash.keyed_hash,
          input.proposed_name,
          input.os_family,
          input.architecture,
        ],
      );
      const existing = replay.rows[0];
      return existing
        ? {
            authorization_request_id: existing.id,
            expires_at: timestamp(existing.expires_at) ?? input.expires_at,
            poll_interval_seconds: Number(existing.effective_poll_interval_seconds),
          }
        : null;
    });
  }

  lookupByHumanCode(input: {
    human_code_hash: CreateDeviceAuthorizationRecord["human_code_hash"];
    now: string;
  }): Promise<DeviceAuthorizationDecisionRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<AuthorizationRequestRow>(
        `SELECT ${AUTHORIZATION_REQUEST_COLUMNS}
           FROM device_authorization_requests
          WHERE user_code_hash_version=$1
            AND user_code_hash_key_id=$2
            AND user_code_keyed_hash=$3
            AND state='pending'
          FOR UPDATE`,
        [
          input.human_code_hash.version,
          input.human_code_hash.key_id,
          input.human_code_hash.keyed_hash,
        ],
      );
      const selectedRow = selected.rows[0];
      if (!selectedRow) return null;
      const current = await expireIfDue(sql, selectedRow, input.now);
      return current.state === "pending" ? decisionRecord(current) : null;
    });
  }

  getDecisionCandidate(input: {
    authorization_request_id: string;
    now: string;
  }): Promise<DeviceAuthorizationDecisionRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<AuthorizationRequestRow>(
        `SELECT ${AUTHORIZATION_REQUEST_COLUMNS}
           FROM device_authorization_requests
          WHERE id=$1
          FOR UPDATE`,
        [input.authorization_request_id],
      );
      const selectedRow = selected.rows[0];
      if (!selectedRow) return null;
      const current = await expireIfDue(sql, selectedRow, input.now);
      return current.state === "pending" || current.state === "approved_pending_redemption"
        ? decisionRecord(current)
        : null;
    });
  }

  approve(input: {
    authorization_request_id: string;
    human_code_hash: CreateDeviceAuthorizationRecord["human_code_hash"];
    owner_user_id: string;
    now: string;
  }): Promise<DeviceAuthorizationRequestRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<AuthorizationRequestRow & { user_status: string }>(
        `SELECT request.*,owner.status AS user_status
           FROM device_authorization_requests request
           JOIN users owner ON owner.id=$5
          WHERE request.id=$1
            AND request.user_code_hash_version=$2
            AND request.user_code_hash_key_id=$3
            AND request.user_code_keyed_hash=$4
          FOR UPDATE OF request`,
        [
          input.authorization_request_id,
          input.human_code_hash.version,
          input.human_code_hash.key_id,
          input.human_code_hash.keyed_hash,
          input.owner_user_id,
        ],
      );
      const selectedRow = selected.rows[0];
      if (!selectedRow || selectedRow.user_status !== "active") return null;
      const row = await expireIfDue(sql, selectedRow, input.now);
      if (row.state === "approved_pending_redemption") {
        return row.approved_by_user_id === input.owner_user_id ? record(row) : null;
      }
      if (row.state !== "pending") return null;
      const approved = await sql.query<AuthorizationRequestRow>(
        `UPDATE device_authorization_requests
            SET state='approved_pending_redemption',
                approved_by_user_id=$2,approved_at=$3,updated_at=$3
          WHERE id=$1 AND state='pending'
          RETURNING ${AUTHORIZATION_REQUEST_COLUMNS}`,
        [row.id, input.owner_user_id, input.now],
      );
      return approved.rows[0] ? record(approved.rows[0]) : null;
    });
  }

  deny(input: {
    authorization_request_id: string;
    human_code_hash: CreateDeviceAuthorizationRecord["human_code_hash"];
    denied_by_user_id: string;
    now: string;
  }): Promise<DeviceAuthorizationRequestRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<AuthorizationRequestRow & { user_status: string }>(
        `SELECT request.*,actor.status AS user_status
           FROM device_authorization_requests request
           JOIN users actor ON actor.id=$5
          WHERE request.id=$1
            AND request.user_code_hash_version=$2
            AND request.user_code_hash_key_id=$3
            AND request.user_code_keyed_hash=$4
          FOR UPDATE OF request`,
        [
          input.authorization_request_id,
          input.human_code_hash.version,
          input.human_code_hash.key_id,
          input.human_code_hash.keyed_hash,
          input.denied_by_user_id,
        ],
      );
      const selectedRow = selected.rows[0];
      if (
        !selectedRow ||
        selectedRow.user_status !== "active" ||
        (selectedRow.approved_by_user_id !== null &&
          selectedRow.approved_by_user_id !== input.denied_by_user_id)
      ) {
        return null;
      }
      const row = await expireIfDue(sql, selectedRow, input.now);
      if (row.state === "denied") return record(row);
      if (row.state !== "pending" && row.state !== "approved_pending_redemption") return null;
      const denied = await sql.query<AuthorizationRequestRow>(
        `UPDATE device_authorization_requests
            SET state='denied',denied_by_user_id=$2,denied_at=$3,updated_at=$3
          WHERE id=$1 AND state IN ('pending','approved_pending_redemption')
          RETURNING ${AUTHORIZATION_REQUEST_COLUMNS}`,
        [row.id, input.denied_by_user_id, input.now],
      );
      return denied.rows[0] ? record(denied.rows[0]) : null;
    });
  }

  poll(input: {
    device_code_hash: CreateDeviceAuthorizationRecord["device_code_hash"];
    now: string;
  }): ReturnType<DeviceEnrollmentRepository["poll"]> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<AuthorizationRequestRow>(
        `SELECT ${AUTHORIZATION_REQUEST_COLUMNS}
           FROM device_authorization_requests
          WHERE device_code_hash_version=$1
            AND device_code_hash_key_id=$2
            AND device_code_keyed_hash=$3
          FOR UPDATE`,
        [
          input.device_code_hash.version,
          input.device_code_hash.key_id,
          input.device_code_hash.keyed_hash,
        ],
      );
      let row = selected.rows[0];
      if (!row) return { kind: "not_found" };
      row = await expireIfDue(sql, row, input.now);
      if (row.state === "expired") return { kind: "expired_token" };
      if (row.state === "denied") return { kind: "access_denied" };
      // Successful redemption retries bypass polling throttles so a lost HTTP
      // response always converges immediately on the committed result.
      if (row.state === "active") return { kind: "active", record: record(row) };

      const effectiveInterval = Number(row.effective_poll_interval_seconds);
      const nextPollAt = timestamp(row.next_poll_at);
      if (nextPollAt !== null && Date.parse(input.now) < Date.parse(nextPollAt)) {
        const slowedInterval = effectiveInterval + 5;
        const next = new Date(Date.parse(input.now) + slowedInterval * 1_000).toISOString();
        const slowed = await sql.query<AuthorizationRequestRow>(
          `UPDATE device_authorization_requests
              SET effective_poll_interval_seconds=$2,
                  slow_down_count=slow_down_count+1,
                  poll_attempt_count=poll_attempt_count+1,
                  last_polled_at=$3,next_poll_at=$4,updated_at=$3
            WHERE id=$1
            RETURNING ${AUTHORIZATION_REQUEST_COLUMNS}`,
          [row.id, slowedInterval, input.now, next],
        );
        return {
          kind: "slow_down",
          retry_after_seconds: slowedInterval,
        };
      }

      const next = new Date(Date.parse(input.now) + effectiveInterval * 1_000).toISOString();
      const polled = await sql.query<AuthorizationRequestRow>(
        `UPDATE device_authorization_requests
            SET poll_attempt_count=poll_attempt_count+1,
                last_polled_at=$2,next_poll_at=$3,updated_at=$2
          WHERE id=$1
          RETURNING ${AUTHORIZATION_REQUEST_COLUMNS}`,
        [row.id, input.now, next],
      );
      const current = polled.rows[0] ?? row;
      return current.state === "pending"
        ? {
            kind: "authorization_pending",
            retry_after_seconds: Number(current.effective_poll_interval_seconds),
          }
        : { kind: "approved_pending_redemption", record: record(current) };
    });
  }

  redeem(input: {
    authorization_request_id: string;
    device_code_hash: CreateDeviceAuthorizationRecord["device_code_hash"];
    public_key_fingerprint: string;
    device_id: string;
    credential_id: string;
    now: string;
    redemption_result_expires_at: string;
  }): ReturnType<DeviceEnrollmentRepository["redeem"]> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<AuthorizationRequestRow>(
        `SELECT ${AUTHORIZATION_REQUEST_COLUMNS}
           FROM device_authorization_requests
          WHERE id=$1
            AND device_code_hash_version=$2
            AND device_code_hash_key_id=$3
            AND device_code_keyed_hash=$4
          FOR UPDATE`,
        [
          input.authorization_request_id,
          input.device_code_hash.version,
          input.device_code_hash.key_id,
          input.device_code_hash.keyed_hash,
        ],
      );
      let row = selected.rows[0];
      if (!row) return { kind: "access_denied" };
      row = await expireIfDue(sql, row, input.now);
      if (row.state === "expired") return { kind: "expired_token" };
      if (
        row.public_key_fingerprint !== input.public_key_fingerprint ||
        row.state === "denied" ||
        row.state === "pending"
      ) {
        return { kind: "access_denied" };
      }
      if (row.state === "active") {
        if (!row.redeemed_device_id || !row.redeemed_credential_id) {
          return { kind: "access_denied" };
        }
        return {
          kind: "active",
          device_id: row.redeemed_device_id,
          credential_id: row.redeemed_credential_id,
          generation: Number(row.redeemed_generation),
        };
      }
      if (!row.approved_by_user_id) return { kind: "access_denied" };

      const generation = 1;
      await sql.query(
        `INSERT INTO devices (
           id,owner_user_id,display_name,location_label,os_family,architecture,lifecycle,
           current_generation,created_at,updated_at
         ) VALUES ($1,$2,$3,NULL,$4,$5,'active',0,$6,$6)`,
        [
          input.device_id,
          row.approved_by_user_id,
          row.proposed_name,
          row.os_family,
          row.architecture,
          input.now,
        ],
      );
      await sql.query(
        `INSERT INTO device_credentials (
           id,device_id,generation,public_key_spki_der,public_key_fingerprint,
           state,activated_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,'active',$6,$6)`,
        [
          input.credential_id,
          input.device_id,
          generation,
          row.public_key_spki_der,
          row.public_key_fingerprint,
          input.now,
        ],
      );
      const activated = await sql.query<AuthorizationRequestRow>(
        `UPDATE device_authorization_requests
            SET state='active',redeemed_at=$2,
                redeemed_device_id=$3,redeemed_credential_id=$4,
                redeemed_generation=$5,redemption_result_expires_at=$6,updated_at=$2
          WHERE id=$1 AND state='approved_pending_redemption'
          RETURNING ${AUTHORIZATION_REQUEST_COLUMNS}`,
        [
          row.id,
          input.now,
          input.device_id,
          input.credential_id,
          generation,
          input.redemption_result_expires_at,
        ],
      );
      if (!activated.rows[0]) {
        throw new Error("device authorization redemption lost its locked request");
      }
      return {
        kind: "active",
        device_id: input.device_id,
        credential_id: input.credential_id,
        generation,
      };
    });
  }
}
