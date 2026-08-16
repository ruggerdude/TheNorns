import { describe, expect, it } from "vitest";

import { DeviceOnlineControlBroker } from "../src/devices/onlineControl.js";
import type {
  V2QueryResult,
  V2SqlExecutor,
  V2TransactionRunner,
} from "../src/persistence/v2/database.js";

const identity = {
  device_id: "device-1",
  owner_user_id: "owner-1",
  credential_id: "credential-1",
  generation: 4,
  protocol_version: "norns-device-wss-v1",
};

const activeIdentityRow = {
  device_lifecycle: "active",
  current_generation: 4,
  owner_user_id: "owner-1",
  owner_status: "active",
  credential_generation: 4,
  credential_state: "active",
};

function transactionRunner(
  query: (statement: string, params?: unknown[]) => Promise<V2QueryResult<unknown>>,
): V2TransactionRunner {
  const sql: V2SqlExecutor = {
    query: async <TRow>(statement: string, params?: unknown[]) =>
      (await query(statement, params)) as V2QueryResult<TRow>,
  };
  return {
    transaction: (work) => work(sql),
  };
}

describe("device online cancellation control", () => {
  it("publishes before locked revalidation so a concurrent revocation closes the candidate", async () => {
    let releaseIdentityQuery: (() => void) | undefined;
    let identityQueryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      identityQueryStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseIdentityQuery = resolve;
    });
    const transactions = transactionRunner(async (statement) => {
      if (!statement.includes("FROM devices device")) {
        throw new Error(`unexpected query: ${statement}`);
      }
      identityQueryStarted?.();
      await release;
      return { rows: [activeIdentityRow] };
    });
    const broker = new DeviceOnlineControlBroker(transactions);
    const sent: unknown[] = [];
    const closed: Array<[number, string]> = [];

    const connecting = broker.connect({
      identity,
      send: (frame) => sent.push(frame),
      close: (code, reason) => closed.push([code, reason]),
    });
    await started;
    broker.closeRevokedDevice(identity.device_id);
    releaseIdentityQuery?.();

    await expect(connecting).resolves.toBeNull();
    expect(closed).toEqual([[1008, "device revoked"]]);
    expect(sent).toEqual([]);
    expect(
      broker.requestCancellation({
        run_id: "run-1",
        device_id: identity.device_id,
        credential_id: identity.credential_id,
        device_generation: identity.generation,
        requested_by_user_id: "owner-1",
        cause: "device_revocation",
        state: "cancellation_requested",
        reason: "device revoked",
        requested_at: "2026-07-30T12:00:00.000Z",
        runner_acknowledged_at: null,
        process_exited_at: null,
        publication_fenced_at: "2026-07-30T12:00:00.000Z",
        unconfirmed_offline_at: null,
        publication_reauthorized_by_user_id: null,
        publication_reauthorized_at: null,
      }),
    ).toBe(false);
  });

  it("rejects an identity revoked in the authentication-to-registration gap", async () => {
    const transactions = transactionRunner(async (statement) => {
      if (!statement.includes("FROM devices device")) {
        throw new Error(`unexpected query: ${statement}`);
      }
      return {
        rows: [
          {
            ...activeIdentityRow,
            device_lifecycle: "revoked",
            credential_state: "revoked",
          },
        ],
      };
    });
    const broker = new DeviceOnlineControlBroker(transactions);
    const closed: Array<[number, string]> = [];

    await expect(
      broker.connect({
        identity,
        send: () => undefined,
        close: (code, reason) => closed.push([code, reason]),
      }),
    ).resolves.toBeNull();
    expect(closed).toEqual([[1008, "device authorization changed"]]);
  });

  it("redelivers only durable cancellations for the exact credential generation", async () => {
    const transactions = transactionRunner(async (statement, params) => {
      if (statement.includes("FROM devices device")) return { rows: [activeIdentityRow] };
      if (!statement.includes("FROM device_run_cancellations")) {
        throw new Error(`unexpected query: ${statement}`);
      }
      expect(params).toEqual(["device-1", "credential-1", 4]);
      return {
        rows: [
          {
            run_id: "run-1",
            device_id: "device-1",
            credential_id: "credential-1",
            device_generation: 4,
            cause: "project_stop",
            requested_at: "2026-07-30T12:00:00.000Z",
            publication_fenced_at: "2026-07-30T12:00:00.000Z",
          },
        ],
      };
    });
    const broker = new DeviceOnlineControlBroker(transactions);
    const sent: unknown[] = [];

    await expect(
      broker.connect({
        identity,
        send: (frame) => sent.push(frame),
        close: () => undefined,
      }),
    ).resolves.toEqual(expect.any(Function));
    expect(sent).toEqual([
      {
        type: "device_cancellation_request",
        device_id: "device-1",
        credential_id: "credential-1",
        generation: 4,
        run_id: "run-1",
        cause: "project_stop",
        requested_at: "2026-07-30T12:00:00.000Z",
        publication_fenced: true,
      },
    ]);
  });

  it("exposes an execution identity only after the exact connection reconciles", async () => {
    const transactions = transactionRunner(async (statement) => {
      if (statement.includes("FROM devices device")) return { rows: [activeIdentityRow] };
      if (statement.includes("FROM device_run_cancellations")) return { rows: [] };
      throw new Error(`unexpected query: ${statement}`);
    });
    const broker = new DeviceOnlineControlBroker(transactions);
    const disconnect = await broker.connect({
      identity,
      send: () => undefined,
      close: () => undefined,
    });

    expect(broker.executionIdentity(identity.device_id)).toBeNull();
    expect(broker.markExecutionReady(identity.device_id, identity.generation + 1)).toBe(false);
    expect(broker.markExecutionReady(identity.device_id, identity.generation)).toBe(true);
    expect(broker.executionIdentity(identity.device_id)).toEqual({
      device_id: identity.device_id,
      generation: identity.generation,
    });

    disconnect?.();
    expect(broker.executionIdentity(identity.device_id)).toBeNull();
  });
});
