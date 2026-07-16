import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const CREDENTIAL_HASH_SCHEME = "hmac-sha256" as const;
const CREDENTIAL_KEY_BYTES = 32;
const CREDENTIAL_ID_BYTES = 16;
const CREDENTIAL_SECRET_BYTES = 32;

export type CredentialKind = "session" | "invite";

export interface CredentialHmacKey {
  keyId: string;
  key: Uint8Array;
}

export interface CredentialHmacKeyring {
  current: CredentialHmacKey;
  byId: ReadonlyMap<string, CredentialHmacKey>;
}

export interface StoredSplitCredential {
  id: string;
  kind: CredentialKind;
  secret_hash: string;
  hash_scheme: typeof CREDENTIAL_HASH_SCHEME;
  key_id: string;
}

export interface IssuedSplitCredential {
  token: string;
  stored: StoredSplitCredential;
}

type RandomBytes = (size: number) => Uint8Array;

function checkedKey(input: CredentialHmacKey): Buffer {
  if (input.keyId.trim().length === 0) throw new Error("credential key id must not be empty");
  if (input.key.byteLength !== CREDENTIAL_KEY_BYTES) {
    throw new Error("credential HMAC keys must contain exactly 32 bytes");
  }
  return Buffer.from(input.key);
}

export function credentialHmacKeyFingerprint(input: CredentialHmacKey): string {
  return createHash("sha256").update(checkedKey(input)).digest("hex");
}

export function createCredentialHmacKeyring(
  current: CredentialHmacKey,
  verificationKeys: readonly CredentialHmacKey[] = [],
): CredentialHmacKeyring {
  const byId = new Map<string, CredentialHmacKey>();
  for (const candidate of [current, ...verificationKeys]) {
    const existing = byId.get(candidate.keyId);
    if (
      existing &&
      credentialHmacKeyFingerprint(existing) !== credentialHmacKeyFingerprint(candidate)
    ) {
      throw new Error(`credential key ID is bound to different key material: ${candidate.keyId}`);
    }
    checkedKey(candidate);
    byId.set(candidate.keyId, candidate);
  }
  return { current, byId };
}

function digest(kind: CredentialKind, id: string, secret: string, key: CredentialHmacKey): string {
  return createHmac("sha256", checkedKey(key))
    .update(`norns:${kind}:${id}:`, "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

function tokenPrefix(kind: CredentialKind): string {
  return `norns_${kind}`;
}

export function issueSplitCredential(
  kind: CredentialKind,
  key: CredentialHmacKey,
  randomBytes: RandomBytes = nodeRandomBytes,
): IssuedSplitCredential {
  const idBytes = Buffer.from(randomBytes(CREDENTIAL_ID_BYTES));
  const secretBytes = Buffer.from(randomBytes(CREDENTIAL_SECRET_BYTES));
  if (
    idBytes.byteLength !== CREDENTIAL_ID_BYTES ||
    secretBytes.byteLength !== CREDENTIAL_SECRET_BYTES
  ) {
    throw new Error("credential randomness source returned an invalid length");
  }
  const id = idBytes.toString("base64url");
  const secret = secretBytes.toString("base64url");
  const token = `${tokenPrefix(kind)}_${id}.${secret}`;
  return {
    token,
    stored: {
      id,
      kind,
      secret_hash: digest(kind, id, secret, key),
      hash_scheme: CREDENTIAL_HASH_SCHEME,
      key_id: key.keyId,
    },
  };
}

export function parseSplitCredential(
  token: string,
  expectedKind: CredentialKind,
): { id: string; secret: string } | null {
  const prefix = `${tokenPrefix(expectedKind)}_`;
  if (!token.startsWith(prefix)) return null;
  const separator = token.indexOf(".", prefix.length);
  if (separator < 0 || token.indexOf(".", separator + 1) >= 0) return null;
  const id = token.slice(prefix.length, separator);
  const secret = token.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  return { id, secret };
}

export function verifySplitCredential(
  token: string,
  stored: StoredSplitCredential,
  key: CredentialHmacKey,
): boolean {
  if (stored.hash_scheme !== CREDENTIAL_HASH_SCHEME || stored.key_id !== key.keyId) {
    return false;
  }
  const parsed = parseSplitCredential(token, stored.kind);
  if (!parsed || parsed.id !== stored.id) return false;
  const actual = Buffer.from(digest(stored.kind, stored.id, parsed.secret, key), "hex");
  const expected = Buffer.from(stored.secret_hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Converts a legacy opaque token into irreversible inventory material. The
 * stable identity is supplied by the importer and the raw token is never
 * returned or embedded in an error.
 */
export function hashLegacyCredentialToken(
  token: string,
  kind: CredentialKind,
  stableId: string,
  key: CredentialHmacKey,
): string {
  return digest(kind, `legacy:${stableId}`, token, key);
}
