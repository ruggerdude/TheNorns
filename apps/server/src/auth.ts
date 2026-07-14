// Runner auth: Ed25519 challenge/response against the public key registered
// at pairing (PRD R4 §Remote Control). Browser sessions use a bearer token in
// 1A-local; passkeys (WebAuthn) land with the deployed web UI (NORN-008).
import { createPublicKey, verify as edVerify } from "node:crypto";

export function verifyRunnerSignature(
  publicKeyPem: string,
  nonceValue: string,
  signatureB64: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return edVerify(
      null,
      Buffer.from(nonceValue, "utf8"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}
