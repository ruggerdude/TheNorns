import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

const PUBLIC_KEY_PEM =
  /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/\r\n]+={0,2})\r?\n-----END PUBLIC KEY-----$/;
const HUMAN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NORMALIZED_HUMAN_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{43}$/;
const BASE64_SIGNATURE = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;

export interface CanonicalDevicePublicKey {
  canonical_public_key_pem: string;
  canonical_spki_der: Buffer;
  fingerprint: string;
}

/**
 * Parse one exact DER SubjectPublicKeyInfo and fingerprint its canonical bytes.
 * Hashing PEM text would give the same key several identities through harmless
 * whitespace changes.
 */
export function canonicalDevicePublicKey(publicKeyPem: string): CanonicalDevicePublicKey {
  const match = PUBLIC_KEY_PEM.exec(publicKeyPem.trim());
  if (!match?.[1]) throw new Error("invalid device public key");
  const base64 = match[1].replaceAll(/\s/g, "");
  const der = Buffer.from(base64, "base64");
  if (der.length === 0 || der.toString("base64") !== base64) {
    throw new Error("invalid device public key");
  }

  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    const canonicalDer = Buffer.from(key.export({ format: "der", type: "spki" }));
    if (!timingSafeBufferEqual(der, canonicalDer)) {
      throw new Error("non-canonical key");
    }
    return {
      canonical_public_key_pem: key.export({ format: "pem", type: "spki" }).toString(),
      canonical_spki_der: canonicalDer,
      fingerprint: createHash("sha256").update(canonicalDer).digest("hex"),
    };
  } catch {
    throw new Error("invalid device public key");
  }
}

export function generateDeviceCode(): string {
  // 32 bytes is exactly the required 256 bits. base64url keeps the POST-body
  // credential transport-safe without changing its entropy.
  return randomBytes(32).toString("base64url");
}

export function isValidDeviceCode(input: string): boolean {
  if (!DEVICE_CODE.test(input)) return false;
  const decoded = Buffer.from(input, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === input;
}

export function generateHumanCode(): string {
  let normalized = "";
  for (const byte of randomBytes(8)) {
    normalized += HUMAN_CODE_ALPHABET[byte & 31];
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function normalizeHumanCode(input: string): string | null {
  const normalized = input.trim().toUpperCase().replaceAll(/[\s-]/g, "");
  return NORMALIZED_HUMAN_CODE.test(normalized) ? normalized : null;
}

export interface DeviceCodeHmacKey {
  /** Hash format version, independent of the secret selected for that format. */
  version: number;
  /** Stable secret-store key identifier persisted for explicit rotation. */
  key_id: string;
  secret: Buffer | Uint8Array;
}

export interface HashedEnrollmentCode {
  version: number;
  key_id: string;
  keyed_hash: Buffer;
}

export class DeviceEnrollmentCodeHasher {
  private readonly secret: Buffer;

  constructor(private readonly key: DeviceCodeHmacKey) {
    if (
      !Number.isSafeInteger(key.version) ||
      key.version <= 0 ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(key.key_id)
    ) {
      throw new Error("invalid device enrollment HMAC key metadata");
    }
    this.secret = Buffer.from(key.secret);
    if (this.secret.byteLength < 32) {
      throw new Error("device enrollment HMAC key must contain at least 256 bits");
    }
  }

  hashDeviceCode(deviceCode: string): HashedEnrollmentCode {
    return this.hash("device-code", deviceCode);
  }

  hashHumanCode(normalizedHumanCode: string): HashedEnrollmentCode {
    return this.hash("human-code", normalizedHumanCode);
  }

  /**
   * Create a short-lived browser capability after a successful human-code
   * lookup. It is bound to one request and its stored keyed hash, so the raw
   * code is not sent again for approval/denial and a guessed request id is not
   * sufficient to make a decision.
   */
  createAuthorizationContext(input: {
    authorization_request_id: string;
    human_code_hash: HashedEnrollmentCode;
  }): string {
    if (
      input.human_code_hash.version !== this.key.version ||
      input.human_code_hash.key_id !== this.key.key_id ||
      input.human_code_hash.keyed_hash.byteLength !== 32
    ) {
      throw new Error("device authorization context uses an unavailable HMAC key");
    }
    return this.authorizationContextDigest(input).toString("base64url");
  }

  verifyAuthorizationContext(input: {
    authorization_request_id: string;
    human_code_hash: HashedEnrollmentCode;
    authorization_context: string;
  }): boolean {
    if (!DEVICE_CODE.test(input.authorization_context)) return false;
    const supplied = Buffer.from(input.authorization_context, "base64url");
    if (
      supplied.byteLength !== 32 ||
      supplied.toString("base64url") !== input.authorization_context ||
      input.human_code_hash.version !== this.key.version ||
      input.human_code_hash.key_id !== this.key.key_id ||
      input.human_code_hash.keyed_hash.byteLength !== 32
    ) {
      return false;
    }
    return timingSafeBufferEqual(
      supplied,
      this.authorizationContextDigest({
        authorization_request_id: input.authorization_request_id,
        human_code_hash: input.human_code_hash,
      }),
    );
  }

  private hash(purpose: "device-code" | "human-code", value: string): HashedEnrollmentCode {
    return {
      version: this.key.version,
      key_id: this.key.key_id,
      keyed_hash: createHmac("sha256", this.secret)
        .update(`norns:device-enrollment:${purpose}:v1`, "utf8")
        .update(Buffer.of(0))
        .update(value, "utf8")
        .digest(),
    };
  }

  private authorizationContextDigest(input: {
    authorization_request_id: string;
    human_code_hash: HashedEnrollmentCode;
  }): Buffer {
    const requestId = Buffer.from(input.authorization_request_id, "utf8");
    const keyId = Buffer.from(input.human_code_hash.key_id, "utf8");
    return createHmac("sha256", this.secret)
      .update("norns:device-enrollment:authorization-context:v1", "utf8")
      .update(Buffer.of(0))
      .update(String(input.human_code_hash.version), "ascii")
      .update(Buffer.of(0))
      .update(String(requestId.byteLength), "ascii")
      .update(Buffer.of(0))
      .update(requestId)
      .update(Buffer.of(0))
      .update(String(keyId.byteLength), "ascii")
      .update(Buffer.of(0))
      .update(keyId)
      .update(Buffer.of(0))
      .update(input.human_code_hash.keyed_hash)
      .digest();
  }
}

export interface EnrollmentProofInput {
  authorization_request_id: string;
  device_code: string;
  public_key_fingerprint: string;
}

/**
 * The device code proves possession of the enrollment credential; this
 * signature additionally proves the caller retained the private key that was
 * persisted before enrollment began.
 */
export function enrollmentRedemptionProofPayload(input: EnrollmentProofInput): Buffer {
  const fields = [
    ["authorization_request_id", input.authorization_request_id],
    ["device_code", input.device_code],
    ["public_key_fingerprint", input.public_key_fingerprint],
  ] as const;
  const chunks: Buffer[] = [Buffer.from("norns:device-enrollment-redemption:v1\n", "utf8")];
  for (const [name, value] of fields) {
    const bytes = Buffer.from(value, "utf8");
    chunks.push(Buffer.from(`${name}:${bytes.byteLength}:`, "ascii"), bytes, Buffer.from("\n"));
  }
  return Buffer.concat(chunks);
}

export function verifyEnrollmentProof(
  canonicalPublicKeySpkiDer: Buffer | Uint8Array,
  payload: Buffer,
  signatureBase64: string,
): boolean {
  if (!BASE64_SIGNATURE.test(signatureBase64)) return false;
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== signatureBase64) return false;
  try {
    return verify(
      null,
      payload,
      {
        key: Buffer.from(canonicalPublicKeySpkiDer),
        format: "der",
        type: "spki",
      },
      signature,
    );
  } catch {
    return false;
  }
}

export function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeBufferEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function timingSafeBufferEqual(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
