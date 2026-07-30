import { generateKeyPairSync, sign } from "node:crypto";

import {
  DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
  canonicalDeviceWssAuthenticationTranscript,
} from "@norns/contracts";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  type DeviceBrowserAudienceRepository,
  ScopedDeviceBrowserDelivery,
} from "../src/devices/browserDelivery.js";
import {
  type DeviceWssAuthenticationCandidate,
  type DeviceWssAuthenticationRepository,
  DeviceWssAuthenticationService,
} from "../src/devices/wssAuthentication.js";
import { buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, waitFor } from "./helpers.js";

const DEVICE_ID = "device-browser-test";
const CREDENTIAL_ID = "credential-browser-test";
const GENERATION = 2;

async function connectSession(
  httpUrl: string,
  token: string,
): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
  const socket = new WebSocket(`${httpUrl.replace(/^http/, "ws")}/ws/session`);
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((frame) => frame.type === "snapshot"), "session snapshot");
  return { socket, frames };
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

describe("device browser WebSocket delivery", () => {
  it("delivers device presence to the owner session without leaking it to an administrator", async () => {
    const users = new UserStore();
    const owner = users.createActive({
      email: "device-owner@example.com",
      password: "owner-password",
      role: "member",
    });
    users.createActive({
      email: "unrelated-admin@example.com",
      password: "admin-password",
      role: "admin",
    });
    const ownerToken = users.login("device-owner@example.com", "owner-password").token;
    const adminToken = users.login("unrelated-admin@example.com", "admin-password").token;

    const keys = generateKeyPairSync("ed25519");
    const candidate: DeviceWssAuthenticationCandidate = {
      device_id: DEVICE_ID,
      owner_user_id: owner.id,
      device_lifecycle: "active",
      current_generation: GENERATION,
      credential_id: CREDENTIAL_ID,
      credential_device_id: DEVICE_ID,
      credential_generation: GENERATION,
      credential_state: "active",
      public_key_spki_der: keys.publicKey.export({ type: "spki", format: "der" }),
      owner_status: "active",
    };
    const deviceRepository: DeviceWssAuthenticationRepository = {
      async withLockedCandidate(deviceId, credentialId, assess) {
        return assess(deviceId === DEVICE_ID && credentialId === CREDENTIAL_ID ? candidate : null);
      },
    };
    const audience: DeviceBrowserAudienceRepository = {
      async ownerUserId(deviceId) {
        return deviceId === DEVICE_ID ? owner.id : null;
      },
      async acceptedProjectUserIds() {
        return [];
      },
      async isAcceptedProjectUser() {
        return false;
      },
    };
    const server = await buildServer({
      stores: new RelayStores(),
      users,
      deviceWssAuthentication: new DeviceWssAuthenticationService(deviceRepository),
      deviceBrowserDelivery: new ScopedDeviceBrowserDelivery(audience),
    });
    const url = await listen(server);
    const ownerSession = await connectSession(url, ownerToken);
    const adminSession = await connectSession(url, adminToken);
    const deviceSocket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);

    try {
      expect(ownerSession.frames).toEqual([{ type: "snapshot", runners: [] }]);
      expect(adminSession.frames).toEqual([{ type: "snapshot", runners: [] }]);

      const challenge = await waitForFrame(deviceSocket, "challenge");
      const deviceChallenge = (challenge.device_auth as { challenge: string }).challenge;
      const transcript = canonicalDeviceWssAuthenticationTranscript({
        purpose: DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
        device_id: DEVICE_ID,
        credential_id: CREDENTIAL_ID,
        generation: GENERATION,
        protocol_version: "1",
        challenge: deviceChallenge,
      });
      const authenticated = waitForFrame(deviceSocket, "device_auth_ok");
      deviceSocket.send(
        JSON.stringify({
          type: "device_auth",
          device_id: DEVICE_ID,
          credential_id: CREDENTIAL_ID,
          generation: GENERATION,
          protocol_version: "1",
          transcript_signature: sign(null, Buffer.from(transcript), keys.privateKey).toString(
            "base64",
          ),
        }),
      );
      await authenticated;
      await waitFor(
        () => ownerSession.frames.some((frame) => frame.type === "device_status"),
        "owner device status",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(ownerSession.frames).toContainEqual({
        type: "device_status",
        audience: "owner",
        device_id: DEVICE_ID,
        availability: "online",
        observed_at: expect.any(String),
      });
      expect(adminSession.frames).toEqual([{ type: "snapshot", runners: [] }]);
      expect(JSON.stringify(adminSession.frames)).not.toContain(DEVICE_ID);
    } finally {
      ownerSession.socket.terminate();
      adminSession.socket.terminate();
      deviceSocket.terminate();
      await server.app.close();
    }
  });
});
