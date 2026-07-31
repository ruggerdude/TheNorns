import {
  DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
  DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
  DEVICE_WSS_PROTOCOL_VERSION,
  type DeviceCancellationEvidenceFrameT,
  type DeviceRunnerAuthenticationFrameT,
  canonicalDeviceCancellationEvidenceWssTranscript,
  canonicalDeviceWssAuthenticationTranscript,
} from "@norns/contracts";

export interface DeviceWssIdentity {
  device_id: string;
  credential_id: string;
  generation: number;
}

export interface DeviceWssProofInput extends DeviceWssIdentity {
  challenge: string;
  protocol_version?: string;
  agent_version?: string;
  capabilities?: readonly string[];
  sign: (canonicalTranscript: string) => string;
}

/**
 * Builds the device-only WSS proof without exposing private-key material.
 *
 * RunnerDaemon uses this only on its cancellation-only companion connection.
 * General device command/event transport remains independently fail-closed.
 */
export function createDeviceWssAuthenticationFrame(
  input: DeviceWssProofInput,
): DeviceRunnerAuthenticationFrameT {
  const protocolVersion = input.protocol_version ?? DEVICE_WSS_PROTOCOL_VERSION;
  const transcript = canonicalDeviceWssAuthenticationTranscript({
    purpose: DEVICE_WSS_AUTH_SIGNATURE_PURPOSE,
    device_id: input.device_id,
    credential_id: input.credential_id,
    generation: input.generation,
    protocol_version: protocolVersion,
    ...(input.agent_version !== undefined
      ? {
          agent_version: input.agent_version,
          capabilities: [...(input.capabilities ?? [])],
        }
      : {}),
    challenge: input.challenge,
  });
  return {
    type: "device_auth",
    device_id: input.device_id,
    credential_id: input.credential_id,
    generation: input.generation,
    protocol_version: protocolVersion,
    ...(input.agent_version !== undefined
      ? {
          agent_version: input.agent_version,
          capabilities: [...(input.capabilities ?? [])],
        }
      : {}),
    transcript_signature: input.sign(transcript),
  };
}

export function createDeviceCancellationEvidenceFrame(input: {
  identity: DeviceWssIdentity;
  run_id: string;
  evidence_state: "runner_acknowledged" | "process_exited";
  acknowledged_at: string;
  process_exited_at: string | null;
  process_tree_reaped: boolean;
  sign: (canonicalTranscript: string) => string;
}): DeviceCancellationEvidenceFrameT {
  const transcript = {
    purpose: DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
    device_id: input.identity.device_id,
    credential_id: input.identity.credential_id,
    generation: input.identity.generation,
    run_id: input.run_id,
    evidence_state: input.evidence_state,
    acknowledged_at: input.acknowledged_at,
    process_exited_at: input.process_exited_at,
    process_tree_reaped: input.process_tree_reaped,
  } as const;
  return {
    type: "device_cancellation_evidence",
    device_id: transcript.device_id,
    credential_id: transcript.credential_id,
    generation: transcript.generation,
    run_id: transcript.run_id,
    evidence_state: transcript.evidence_state,
    acknowledged_at: transcript.acknowledged_at,
    process_exited_at: transcript.process_exited_at,
    process_tree_reaped: transcript.process_tree_reaped,
    transcript_signature: input.sign(canonicalDeviceCancellationEvidenceWssTranscript(transcript)),
  };
}
