import { randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nonce(): string {
  return randomBytes(16).toString("hex");
}

/** Human-transcribed, single-use local-helper pairing code. */
export function pairingCode(): string {
  return randomBytes(4).toString("hex");
}
