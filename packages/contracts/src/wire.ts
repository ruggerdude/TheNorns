// WebSocket wire frames for the runner protocol (additive in contracts 1.1.0).
// Auth is a challenge/response over the runner's Ed25519 keypair; after auth
// the reconciliation handshake runs, then commands/events flow.
import { z } from "zod";
import { CommandEnvelope, EventEnvelope, ReconcileRequest, ReconcileResponse } from "./protocol.js";

const nonEmpty = z.string().min(1);

// runner -> server
export const RunnerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    runner_id: nonEmpty,
    // base64 Ed25519 signature over the server-issued nonce
    nonce_signature: nonEmpty,
  }),
  z.object({ type: z.literal("reconcile_request"), body: ReconcileRequest }),
  z.object({ type: z.literal("event"), event: EventEnvelope }),
]);
export type RunnerFrameT = z.infer<typeof RunnerFrame>;

// server -> runner
export const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: nonEmpty }),
  z.object({ type: z.literal("auth_ok") }),
  z.object({ type: z.literal("auth_error"), reason: nonEmpty }),
  z.object({ type: z.literal("reconcile_response"), body: ReconcileResponse }),
  z.object({ type: z.literal("command"), command: CommandEnvelope }),
  z.object({ type: z.literal("event_ack"), ack_event_seq: z.number().int().nonnegative() }),
  // fencing: the runner's generation is stale; it must stop acting and re-pair
  z.object({ type: z.literal("fenced"), current_generation: z.number().int().nonnegative() }),
]);
export type ServerFrameT = z.infer<typeof ServerFrame>;

export function parseRunnerFrame(raw: string): RunnerFrameT | null {
  try {
    return RunnerFrame.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseServerFrame(raw: string): ServerFrameT | null {
  try {
    return ServerFrame.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
