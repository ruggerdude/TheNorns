import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import {
  DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
  DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
  LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
  PROTOCOL_VERSION,
  canonicalDeviceCancellationEvidenceWssTranscript,
  canonicalDeviceWssAuthenticationTranscript,
  canonicalLegacyRunnerWssAuthenticationTranscript,
} from "@norns/contracts";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  type DeviceWssAuthenticationCandidate,
  type DeviceWssAuthenticationRepository,
  DeviceWssAuthenticationService,
  PostgresDeviceWssAuthenticationRepository,
} from "../src/devices/wssAuthentication.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen } from "./helpers.js";

const DEVICE_ID = "device-1";
const CREDENTIAL_ID = "credential-1";
const GENERATION = 3;

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const candidate: DeviceWssAuthenticationCandidate = {
    device_id: DEVICE_ID,
    owner_user_id: "user-1",
    device_lifecycle: "active",
    current_generation: GENERATION,
    credential_id: CREDENTIAL_ID,
    credential_device_id: DEVICE_ID,
    credential_generation: GENERATION,
    credential_state: "active",
    public_key_spki_der: keys.publicKey.export({ type: "spki", format: "der" }),
    owner_status: "active",
  };
  const repository: DeviceWssAuthenticationRepository = {
    async withLockedCandidate(deviceId, credentialId, assess) {
      return assess(deviceId === DEVICE_ID && credentialId === CREDENTIAL_ID ? candidate : null);
    },
  };
  return { keys, candidate, repository };
}

function signedRequest(
  privateKey: KeyObject,
  challenge = "server-challenge",
  overrides: Partial<{
    device_id: string;
    credential_id: string;
    generation: number;
    protocol_version: string;
  }> = {},
) {
  const request = {
    device_id: DEVICE_ID,
    credential_id: CREDENTIAL_ID,
    generation: GENERATION,
    protocol_version: "1",
    ...overrides,
  };
  const transcript = canonicalDeviceWssAuthenticationTranscript({
    purpose: DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
    ...request,
    challenge,
  });
  return {
    ...request,
    challenge,
    transcript_signature: sign(null, Buffer.from(transcript), privateKey).toString("base64"),
  };
}

function deviceAuthenticationFrame(privateKey: KeyObject, challenge: string) {
  const request = signedRequest(privateKey, challenge);
  return {
    type: "device_auth" as const,
    device_id: request.device_id,
    credential_id: request.credential_id,
    generation: request.generation,
    protocol_version: request.protocol_version,
    transcript_signature: request.transcript_signature,
  };
}

function cancellationEvidenceFrame(
  privateKey: KeyObject,
  overrides: Partial<{
    device_id: string;
    credential_id: string;
    generation: number;
    run_id: string;
    evidence_state: "runner_acknowledged" | "process_exited";
    acknowledged_at: string;
    process_exited_at: string | null;
    process_tree_reaped: boolean;
  }> = {},
) {
  const evidence = {
    device_id: DEVICE_ID,
    credential_id: CREDENTIAL_ID,
    generation: GENERATION,
    run_id: "run-1",
    evidence_state: "process_exited" as const,
    acknowledged_at: "2026-07-30T12:00:00.000Z",
    process_exited_at: "2026-07-30T12:00:01.000Z",
    process_tree_reaped: true,
    ...overrides,
  };
  const transcript = canonicalDeviceCancellationEvidenceWssTranscript({
    purpose: DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
    ...evidence,
  });
  return {
    type: "device_cancellation_evidence" as const,
    ...evidence,
    transcript_signature: sign(null, Buffer.from(transcript), privateKey).toString("base64"),
  };
}

function legacyAuthenticationFrame(
  privateKey: KeyObject,
  runnerId: string,
  generation: number,
  challenge: string,
) {
  const transcript = canonicalLegacyRunnerWssAuthenticationTranscript({
    purpose: LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
    runner_id: runnerId,
    generation,
    protocol_version: PROTOCOL_VERSION,
    challenge,
  });
  return {
    type: "auth" as const,
    runner_id: runnerId,
    generation,
    protocol_version: PROTOCOL_VERSION,
    transcript_signature: sign(null, Buffer.from(transcript), privateKey).toString("base64"),
  };
}

async function waitForFrame(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
  });
}

describe("device WSS authentication service", () => {
  it("authenticates an active owner, credential, generation, and protocol without grants", async () => {
    const { keys, repository } = fixture();
    const service = new DeviceWssAuthenticationService(repository);

    await expect(service.authenticate(signedRequest(keys.privateKey))).resolves.toEqual({
      device_id: DEVICE_ID,
      owner_user_id: "user-1",
      credential_id: CREDENTIAL_ID,
      generation: GENERATION,
      protocol_version: "1",
    });
  });

  it("rejects a signature created for a different purpose", async () => {
    const { keys, repository } = fixture();
    const service = new DeviceWssAuthenticationService(repository);
    const request = signedRequest(keys.privateKey);
    const wrongPurposeTranscript = canonicalLegacyRunnerWssAuthenticationTranscript({
      purpose: LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
      runner_id: request.device_id,
      generation: request.generation,
      protocol_version: PROTOCOL_VERSION,
      challenge: request.challenge,
    });

    await expect(
      service.authenticate({
        ...request,
        transcript_signature: sign(
          null,
          Buffer.from(wrongPurposeTranscript),
          keys.privateKey,
        ).toString("base64"),
      }),
    ).resolves.toBeNull();
  });

  it("rejects proof from a different private key", async () => {
    const { repository } = fixture();
    const wrongKeys = generateKeyPairSync("ed25519");
    const service = new DeviceWssAuthenticationService(repository);

    await expect(service.authenticate(signedRequest(wrongKeys.privateKey))).resolves.toBeNull();
  });

  it("rejects stale generation and incompatible protocol before connection authentication", async () => {
    const { keys, repository } = fixture();
    const service = new DeviceWssAuthenticationService(repository);

    await expect(
      service.authenticate(signedRequest(keys.privateKey, "server-challenge", { generation: 2 })),
    ).resolves.toBeNull();
    await expect(
      service.authenticate(
        signedRequest(keys.privateKey, "server-challenge", { protocol_version: "999" }),
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["revoked device", { device_lifecycle: "revoked" as const }],
    ["revoked credential", { credential_state: "revoked" as const }],
    ["ownerless device", { owner_user_id: null }],
    ["inactive owner", { owner_status: "disabled" }],
  ])("rejects %s", async (_label, candidateOverride) => {
    const { keys, candidate, repository } = fixture();
    Object.assign(candidate, candidateOverride);
    const service = new DeviceWssAuthenticationService(repository);

    await expect(service.authenticate(signedRequest(keys.privateKey))).resolves.toBeNull();
  });

  it("accepts exact cancellation-only proof after ordinary device authority is fenced", async () => {
    const { keys, candidate, repository } = fixture();
    const service = new DeviceWssAuthenticationService(repository);
    const frame = cancellationEvidenceFrame(keys.privateKey);

    candidate.device_lifecycle = "revoked";
    candidate.current_generation = GENERATION + 1;
    candidate.credential_state = "revoked";

    await expect(service.verifyCancellationEvidence(frame)).resolves.toBe(true);
    await expect(
      service.verifyCancellationEvidence({ ...frame, run_id: "run-other" }),
    ).resolves.toBe(false);
    await expect(
      service.verifyCancellationEvidence({
        ...frame,
        credential_id: "credential-other",
      }),
    ).resolves.toBe(false);
  });

  it("serializes concurrent revocation after the locked final authentication decision", async () => {
    const database = new PGlite();
    const { keys } = fixture();
    const publicKeyDer = keys.publicKey.export({ type: "spki", format: "der" });
    await database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT REFERENCES users(id),
        lifecycle TEXT NOT NULL,
        current_generation BIGINT NOT NULL
      );
      CREATE TABLE device_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        generation BIGINT NOT NULL,
        state TEXT NOT NULL,
        public_key_spki_der BYTEA NOT NULL
      );
      INSERT INTO users (id,status) VALUES ('user-1','active');
      INSERT INTO devices (id,owner_user_id,lifecycle,current_generation)
      VALUES ('device-1','user-1','active',3);
    `);
    await database.query(
      `INSERT INTO device_credentials (
         id,device_id,generation,state,public_key_spki_der
       ) VALUES ('credential-1','device-1',3,'active',$1)`,
      [publicKeyDer],
    );

    const postgres = new PostgresDeviceWssAuthenticationRepository(
      new PGliteTransactionRunner(database),
    );
    let releaseAuthentication!: () => void;
    const holdAuthentication = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    let finalDecisionReached!: () => void;
    const finalDecision = new Promise<void>((resolve) => {
      finalDecisionReached = resolve;
    });
    const repository: DeviceWssAuthenticationRepository = {
      withLockedCandidate: (deviceId, credentialId, assess) =>
        postgres.withLockedCandidate(deviceId, credentialId, async (candidate) => {
          const result = await assess(candidate);
          finalDecisionReached();
          await holdAuthentication;
          return result;
        }),
    };
    const service = new DeviceWssAuthenticationService(repository);
    const authentication = service.authenticate(signedRequest(keys.privateKey));
    await finalDecision;

    let revocationSettled = false;
    const revocation = database
      .query(`UPDATE devices SET lifecycle='revoked',current_generation=4 WHERE id='device-1'`)
      .then(async () => {
        await database.query(
          "UPDATE device_credentials SET state='revoked' WHERE id='credential-1'",
        );
        revocationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(revocationSettled).toBe(false);

    releaseAuthentication();
    await expect(authentication).resolves.toMatchObject({
      device_id: DEVICE_ID,
      credential_id: CREDENTIAL_ID,
      generation: GENERATION,
    });
    await revocation;
    expect(revocationSettled).toBe(true);
    await expect(service.authenticate(signedRequest(keys.privateKey))).resolves.toBeNull();
    await database.close();
  });
});

describe.sequential("device WSS authentication state machine", () => {
  it("records exact signed process-exit evidence after ordinary authority is fenced", async () => {
    const { keys, candidate, repository } = fixture();
    const recorded: unknown[] = [];
    const record = {
      run_id: "run-1",
      device_id: DEVICE_ID,
      credential_id: CREDENTIAL_ID,
      device_generation: GENERATION,
      cause: "project_stop" as const,
      state: "process_exited" as const,
      requested_by_user_id: "user-1",
      reason: "stop requested",
      requested_at: "2026-07-30T11:59:59.000Z",
      runner_acknowledged_at: "2026-07-30T12:00:00.000Z",
      process_exited_at: "2026-07-30T12:00:01.000Z",
      unconfirmed_offline_at: null,
      publication_fenced_at: "2026-07-30T11:59:59.000Z",
      publication_reauthorized_by_user_id: null,
      publication_reauthorized_at: null,
    };
    const server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      deviceWssAuthentication: new DeviceWssAuthenticationService(repository),
      deviceControl: {
        broker: {
          connect: async () => () => undefined,
        },
        cancellations: {
          confirmProcessExited: async (input: unknown) => {
            recorded.push(input);
            return record;
          },
        },
        revocations: {},
      } as never,
    });
    const url = await listen(server);
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);

    try {
      const challenge = await waitForFrame(socket, "challenge");
      const authenticated = waitForFrame(socket, "device_auth_ok");
      socket.send(
        JSON.stringify(
          deviceAuthenticationFrame(
            keys.privateKey,
            (challenge.device_auth as { challenge: string }).challenge,
          ),
        ),
      );
      await authenticated;

      candidate.device_lifecycle = "revoked";
      candidate.current_generation = GENERATION + 1;
      candidate.credential_state = "revoked";
      const acknowledged = waitForFrame(socket, "device_cancellation_evidence_ack");
      socket.send(JSON.stringify(cancellationEvidenceFrame(keys.privateKey)));
      await expect(acknowledged).resolves.toEqual({
        type: "device_cancellation_evidence_ack",
        run_id: "run-1",
        evidence_state: "process_exited",
      });
      expect(recorded).toEqual([
        {
          run_id: "run-1",
          device_id: DEVICE_ID,
          credential_id: CREDENTIAL_ID,
          device_generation: GENERATION,
          acknowledged_at: "2026-07-30T12:00:00.000Z",
          process_exited_at: "2026-07-30T12:00:01.000Z",
          process_tree_reaped: true,
        },
      ]);
    } finally {
      socket.terminate();
      await server.app.close();
    }
  });

  it("allows an active zero-grant device to authenticate but not enter legacy transport", async () => {
    const { keys, repository } = fixture();
    const server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      deviceWssAuthentication: new DeviceWssAuthenticationService(repository),
    });
    const url = await listen(server);
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);

    try {
      const challenge = await waitForFrame(socket, "challenge");
      expect(challenge.device_auth).toEqual({
        challenge: expect.any(String),
        supported_protocol_versions: ["1"],
      });
      const deviceChallenge = (challenge.device_auth as { challenge: string }).challenge;
      const authenticated = waitForFrame(socket, "device_auth_ok");
      socket.send(JSON.stringify(deviceAuthenticationFrame(keys.privateKey, deviceChallenge)));
      await expect(authenticated).resolves.toEqual({
        type: "device_auth_ok",
        device_id: DEVICE_ID,
        generation: GENERATION,
        protocol_version: "1",
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const rejected = waitForFrame(socket, "auth_error");
      const closed = once(socket, "close");
      socket.send(
        JSON.stringify({
          type: "auth",
          runner_id: DEVICE_ID,
          generation: GENERATION,
          protocol_version: PROTOCOL_VERSION,
          transcript_signature: "cannot-fall-through",
        }),
      );
      await expect(rejected).resolves.toEqual({
        type: "auth_error",
        reason: "authentication failed",
      });
      await closed;
    } finally {
      socket.terminate();
      await server.app.close();
    }
  });

  it("fails device frames closed when the device feature is absent", async () => {
    const { keys } = fixture();
    const stores = new RelayStores();
    stores.registerRunner(
      DEVICE_ID,
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const server: NornsServer = await buildServer({ stores, users: new UserStore() });
    const url = await listen(server);
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);

    try {
      const challenge = await waitForFrame(socket, "challenge");
      expect(challenge.device_auth).toBeUndefined();
      const rejected = waitForFrame(socket, "auth_error");
      const closed = once(socket, "close");
      socket.send(
        JSON.stringify(deviceAuthenticationFrame(keys.privateKey, String(challenge.nonce))),
      );
      await expect(rejected).resolves.toEqual({
        type: "auth_error",
        reason: "authentication failed",
      });
      await closed;
    } finally {
      socket.terminate();
      await server.app.close();
    }
  });

  it("preserves deprecated legacy runner authentication while the device seam is enabled", async () => {
    const legacyKeys = generateKeyPairSync("ed25519");
    const stores = new RelayStores();
    stores.registerRunner(
      "legacy-runner",
      legacyKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const { repository } = fixture();
    const server = await buildServer({
      stores,
      users: new UserStore(),
      deviceWssAuthentication: new DeviceWssAuthenticationService(repository),
      legacyLocalRunnerAuth: { enabled: true },
    });
    const url = await listen(server);
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);

    try {
      const challenge = await waitForFrame(socket, "challenge");
      const authenticated = waitForFrame(socket, "auth_ok");
      socket.send(
        JSON.stringify({
          ...legacyAuthenticationFrame(
            legacyKeys.privateKey,
            "legacy-runner",
            1,
            String(challenge.nonce),
          ),
        }),
      );
      await expect(authenticated).resolves.toEqual({ type: "auth_ok" });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.terminate();
      await server.app.close();
    }
  });

  it("rejects a device-domain signature presented as legacy runner proof", async () => {
    const keys = generateKeyPairSync("ed25519");
    const stores = new RelayStores();
    stores.registerRunner(
      "legacy-runner",
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const server = await buildServer({
      stores,
      users: new UserStore(),
      legacyLocalRunnerAuth: { enabled: true },
    });
    const url = await listen(server);
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);

    try {
      const challenge = await waitForFrame(socket, "challenge");
      const deviceTranscript = canonicalDeviceWssAuthenticationTranscript({
        purpose: DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
        device_id: "legacy-runner",
        credential_id: "legacy-credential",
        generation: 1,
        protocol_version: "1",
        challenge: String(challenge.nonce),
      });
      const rejected = waitForFrame(socket, "auth_error");
      const closed = once(socket, "close");
      socket.send(
        JSON.stringify({
          type: "auth",
          runner_id: "legacy-runner",
          generation: 1,
          protocol_version: PROTOCOL_VERSION,
          transcript_signature: sign(null, Buffer.from(deviceTranscript), keys.privateKey).toString(
            "base64",
          ),
        }),
      );
      await expect(rejected).resolves.toEqual({
        type: "auth_error",
        reason: "authentication failed",
      });
      await closed;
    } finally {
      socket.terminate();
      await server.app.close();
    }
  });

  it("rejects replay of a valid legacy proof on a new connection challenge", async () => {
    const keys = generateKeyPairSync("ed25519");
    const stores = new RelayStores();
    stores.registerRunner(
      "legacy-runner",
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const server = await buildServer({
      stores,
      users: new UserStore(),
      legacyLocalRunnerAuth: { enabled: true },
    });
    const url = await listen(server);
    const first = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);
    let second: WebSocket | null = null;

    try {
      const firstChallenge = await waitForFrame(first, "challenge");
      const replayedFrame = legacyAuthenticationFrame(
        keys.privateKey,
        "legacy-runner",
        1,
        String(firstChallenge.nonce),
      );
      const firstAuthenticated = waitForFrame(first, "auth_ok");
      first.send(JSON.stringify(replayedFrame));
      await firstAuthenticated;

      second = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);
      const secondChallenge = await waitForFrame(second, "challenge");
      expect(secondChallenge.nonce).not.toBe(firstChallenge.nonce);
      const rejected = waitForFrame(second, "auth_error");
      const closed = once(second, "close");
      second.send(JSON.stringify(replayedFrame));
      await expect(rejected).resolves.toEqual({
        type: "auth_error",
        reason: "authentication failed",
      });
      await closed;
    } finally {
      first.terminate();
      second?.terminate();
      await server.app.close();
    }
  });
});
