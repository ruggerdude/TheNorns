import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
  DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
  canonicalDeviceCancellationEvidenceWssTranscript,
  canonicalDeviceWssAuthenticationTranscript,
} from "@norns/contracts";
import { InMemoryDeviceCredentialSecretStore } from "../dist/deviceCredentialSecretStore.js";
import {
  PendingDeviceCredentialStore,
  createDeviceCancellationEvidenceFrame,
  createDeviceWssAuthenticationFrame,
} from "../dist/index.js";

test("device WSS proof signs the canonical domain-separated transcript", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "norns-device-wss-test-"));
  try {
    const credential = new PendingDeviceCredentialStore(
      dataDir,
      new InMemoryDeviceCredentialSecretStore(),
    );
    const prepared = credential.prepare();
    const frame = createDeviceWssAuthenticationFrame({
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 4,
      challenge: "server-issued-challenge",
      agent_version: "0.3.1",
      capabilities: ["device_control", "repository_access"],
      sign: (payload) => credential.sign(payload),
    });

    assert.equal(frame.type, "device_auth");
    assert.equal(frame.protocol_version, "1");
    assert.equal(frame.agent_version, "0.3.1");
    assert.deepEqual(frame.capabilities, ["device_control", "repository_access"]);
    const transcript = canonicalDeviceWssAuthenticationTranscript({
      purpose: DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
      device_id: frame.device_id,
      credential_id: frame.credential_id,
      generation: frame.generation,
      protocol_version: frame.protocol_version,
      agent_version: frame.agent_version,
      capabilities: frame.capabilities,
      challenge: "server-issued-challenge",
    });
    assert.equal(
      verify(
        null,
        Buffer.from(transcript, "utf8"),
        createPublicKey(prepared.public_key_pem),
        Buffer.from(frame.transcript_signature, "base64"),
      ),
      true,
    );
    assert.equal(
      verify(
        null,
        Buffer.from("server-issued-challenge", "utf8"),
        createPublicKey(prepared.public_key_pem),
        Buffer.from(frame.transcript_signature, "base64"),
      ),
      false,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("device cancellation evidence signs only the exact state-bound transcript", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "norns-device-cancellation-wss-test-"));
  try {
    const credential = new PendingDeviceCredentialStore(
      dataDir,
      new InMemoryDeviceCredentialSecretStore(),
    );
    const prepared = credential.prepare();
    const frame = createDeviceCancellationEvidenceFrame({
      identity: {
        device_id: "device-1",
        credential_id: "credential-1",
        generation: 4,
      },
      run_id: "run-1",
      evidence_state: "process_exited",
      acknowledged_at: "2026-07-30T12:00:00.000Z",
      process_exited_at: "2026-07-30T12:00:01.000Z",
      process_tree_reaped: true,
      sign: (payload) => credential.sign(payload),
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
    const publicKey = createPublicKey(prepared.public_key_pem);
    assert.equal(
      verify(
        null,
        Buffer.from(transcript, "utf8"),
        publicKey,
        Buffer.from(frame.transcript_signature, "base64"),
      ),
      true,
    );
    assert.equal(
      verify(
        null,
        Buffer.from(
          canonicalDeviceCancellationEvidenceWssTranscript({
            purpose: DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
            device_id: frame.device_id,
            credential_id: frame.credential_id,
            generation: frame.generation,
            run_id: "run-other",
            evidence_state: frame.evidence_state,
            acknowledged_at: frame.acknowledged_at,
            process_exited_at: frame.process_exited_at,
            process_tree_reaped: frame.process_tree_reaped,
          }),
          "utf8",
        ),
        publicKey,
        Buffer.from(frame.transcript_signature, "base64"),
      ),
      false,
    );
    assert.throws(() =>
      createDeviceCancellationEvidenceFrame({
        identity: {
          device_id: "device-1",
          credential_id: "credential-1",
          generation: 4,
        },
        run_id: "run-1",
        evidence_state: "runner_acknowledged",
        acknowledged_at: "2026-07-30T12:00:00.000Z",
        process_exited_at: "2026-07-30T12:00:01.000Z",
        process_tree_reaped: true,
        sign: (payload) => credential.sign(payload),
      }),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
