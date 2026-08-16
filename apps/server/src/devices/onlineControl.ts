import type { ServerFrameT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import type { DeviceRunCancellationRecord } from "./cancellation.js";
import type { AuthenticatedDeviceWssIdentity } from "./wssAuthentication.js";

interface ConnectedDevice {
  identity: AuthenticatedDeviceWssIdentity;
  send(frame: ServerFrameT): void;
  close(code: number, reason: string): void;
}

interface PendingCancellationRow {
  run_id: string;
  device_id: string;
  credential_id: string;
  device_generation: number | string;
  cause: DeviceRunCancellationRecord["cause"];
  requested_at: Date | string;
  publication_fenced_at: Date | string | null;
}

interface ActiveConnectionIdentityRow {
  device_lifecycle: string;
  current_generation: number | string;
  owner_user_id: string | null;
  owner_status: string;
  credential_generation: number | string;
  credential_state: string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Tracks exact authenticated device connections for cancellation and, after a
 * successful execution reconciliation, live development dispatch. Reconnect
 * cancellation delivery comes from durable rows, never memory.
 */
export class DeviceOnlineControlBroker {
  private readonly connections = new Map<string, ConnectedDevice>();
  private readonly executionReadyGenerations = new Map<string, number>();

  constructor(private readonly transactions: V2TransactionRunner) {}

  async connect(connection: ConnectedDevice): Promise<(() => void) | null> {
    const prior = this.connections.get(connection.identity.device_id);
    // Publish first. A revocation that commits after authentication but before
    // this method acquires the device lock must be able to observe and close
    // the candidate connection from its post-commit hook.
    this.executionReadyGenerations.delete(connection.identity.device_id);
    this.connections.set(connection.identity.device_id, connection);
    if (prior && prior !== connection) {
      prior.close(1008, "superseded device connection");
    }
    const disconnect = () => {
      if (this.connections.get(connection.identity.device_id) === connection) {
        this.connections.delete(connection.identity.device_id);
        this.executionReadyGenerations.delete(connection.identity.device_id);
      }
    };
    try {
      const stillActive = await this.revalidateActiveIdentity(connection);
      if (!stillActive) {
        if (this.connections.get(connection.identity.device_id) === connection) {
          this.connections.delete(connection.identity.device_id);
          this.executionReadyGenerations.delete(connection.identity.device_id);
          connection.close(1008, "device authorization changed");
        }
        return null;
      }
      if (this.connections.get(connection.identity.device_id) !== connection) return null;
      await this.deliverPending(connection);
      if (this.connections.get(connection.identity.device_id) !== connection) return null;
      return disconnect;
    } catch (error) {
      disconnect();
      throw error;
    }
  }

  requestCancellation(record: DeviceRunCancellationRecord): boolean {
    const connection = this.connections.get(record.device_id);
    if (
      !connection ||
      connection.identity.credential_id !== record.credential_id ||
      connection.identity.generation !== record.device_generation
    ) {
      return false;
    }
    try {
      connection.send({
        type: "device_cancellation_request",
        device_id: record.device_id,
        credential_id: record.credential_id,
        generation: record.device_generation,
        run_id: record.run_id,
        cause: record.cause,
        requested_at: record.requested_at,
        publication_fenced: record.publication_fenced_at !== null,
      });
      return true;
    } catch {
      return false;
    }
  }

  closeRevokedDevice(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    // Remove before close so an in-flight reconnect reconciliation cannot send
    // a pending cancellation after revocation has fenced the connection.
    this.connections.delete(deviceId);
    this.executionReadyGenerations.delete(deviceId);
    connection.close(1008, "device revoked");
  }

  /** Marks the exact authenticated connection ready only after reconciliation. */
  markExecutionReady(deviceId: string, generation: number): boolean {
    const connection = this.connections.get(deviceId);
    if (connection?.identity.generation !== generation) return false;
    this.executionReadyGenerations.set(deviceId, generation);
    return true;
  }

  /** Exact live device identity available for development task dispatch. */
  executionIdentity(deviceId: string): { device_id: string; generation: number } | null {
    const connection = this.connections.get(deviceId);
    const generation = this.executionReadyGenerations.get(deviceId);
    return connection && generation === connection.identity.generation
      ? { device_id: connection.identity.device_id, generation }
      : null;
  }

  /** Ephemeral presence only. Absence means offline, never revoked. */
  isConnected(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  /** Exact live WSS capability check; device-only presence is insufficient. */
  isConnectedIdentity(identity: {
    device_id: string;
    credential_id: string;
    generation: number;
  }): boolean {
    const connection = this.connections.get(identity.device_id);
    return (
      connection?.identity.device_id === identity.device_id &&
      connection.identity.credential_id === identity.credential_id &&
      connection.identity.generation === identity.generation
    );
  }

  private revalidateActiveIdentity(connection: ConnectedDevice): Promise<boolean> {
    return this.transactions.transaction(async (sql) => {
      const selected = await sql.query<ActiveConnectionIdentityRow>(
        `SELECT
           device.lifecycle AS device_lifecycle,
           device.current_generation,
           device.owner_user_id,
           owner.status AS owner_status,
           credential.generation AS credential_generation,
           credential.state AS credential_state
         FROM devices device
         JOIN users owner ON owner.id=device.owner_user_id
         JOIN device_credentials credential
           ON credential.device_id=device.id
          AND credential.id=$2
        WHERE device.id=$1
        FOR UPDATE OF device,owner,credential`,
        [connection.identity.device_id, connection.identity.credential_id],
      );
      const row = selected.rows[0];
      return (
        row?.device_lifecycle === "active" &&
        row.owner_user_id === connection.identity.owner_user_id &&
        row.owner_status === "active" &&
        row.credential_state === "active" &&
        Number(row.current_generation) === connection.identity.generation &&
        Number(row.credential_generation) === connection.identity.generation
      );
    });
  }

  private async deliverPending(connection: ConnectedDevice): Promise<void> {
    const pending = await this.transactions.transaction(async (sql) =>
      sql.query<PendingCancellationRow>(
        `SELECT
           run_id,device_id,credential_id,device_generation,cause,
           requested_at,publication_fenced_at
         FROM device_run_cancellations
         WHERE device_id=$1
           AND credential_id=$2
           AND device_generation=$3
           AND state IN (
             'cancellation_requested','runner_acknowledged','unconfirmed_offline'
           )
         ORDER BY requested_at,run_id`,
        [
          connection.identity.device_id,
          connection.identity.credential_id,
          connection.identity.generation,
        ],
      ),
    );
    if (this.connections.get(connection.identity.device_id) !== connection) return;
    for (const row of pending.rows) {
      connection.send({
        type: "device_cancellation_request",
        device_id: row.device_id,
        credential_id: row.credential_id,
        generation: Number(row.device_generation),
        run_id: row.run_id,
        cause: row.cause,
        requested_at: timestamp(row.requested_at),
        publication_fenced: row.publication_fenced_at !== null,
      });
    }
  }
}
