import { randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nonce(): string {
  return randomBytes(16).toString("hex");
}
