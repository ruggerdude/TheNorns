import { randomBytes as nodeRandomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const LEGACY_PASSWORD_HASH_SCHEME = "legacy-scrypt-v0" as const;
export const CURRENT_PASSWORD_HASH_SCHEME = "scrypt-v1" as const;
export type PasswordHashScheme =
  | typeof LEGACY_PASSWORD_HASH_SCHEME
  | typeof CURRENT_PASSWORD_HASH_SCHEME;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

type RandomBytes = (size: number) => Uint8Array;

function derive(password: string, salt: Uint8Array): Buffer {
  return scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

function secureEqual(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validHex(value: string, bytes: number): boolean {
  return value.length === bytes * 2 && /^[a-fA-F0-9]+$/.test(value);
}

function currentHashParts(storedHash: string): { salt: Buffer; expected: Buffer } | null {
  const parts = storedHash.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "scrypt" ||
    parts[1] !== "v1" ||
    parts[2] !== String(SCRYPT_N) ||
    parts[3] !== String(SCRYPT_R) ||
    parts[4] !== String(SCRYPT_P)
  ) {
    return null;
  }
  const salt = Buffer.from(parts[5] ?? "", "base64url");
  const expected = Buffer.from(parts[6] ?? "", "base64url");
  return salt.byteLength === SCRYPT_SALT_BYTES && expected.byteLength === SCRYPT_KEY_BYTES
    ? { salt, expected }
    : null;
}

/** Classifies preserved password material without needing the plaintext. */
export function detectPasswordHashScheme(storedHash: string): PasswordHashScheme | null {
  if (currentHashParts(storedHash) !== null) return CURRENT_PASSWORD_HASH_SCHEME;
  const [saltHex, hashHex, ...extra] = storedHash.split(":");
  if (
    extra.length === 0 &&
    saltHex &&
    hashHex &&
    validHex(saltHex, SCRYPT_SALT_BYTES) &&
    validHex(hashHex, SCRYPT_KEY_BYTES)
  ) {
    return LEGACY_PASSWORD_HASH_SCHEME;
  }
  return null;
}

export function verifyLegacyScryptPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  if (
    !saltHex ||
    !hashHex ||
    !validHex(saltHex, SCRYPT_SALT_BYTES) ||
    !validHex(hashHex, SCRYPT_KEY_BYTES)
  ) {
    return false;
  }
  const actual = derive(password, Buffer.from(saltHex, "hex"));
  return secureEqual(actual, Buffer.from(hashHex, "hex"));
}

export function hashCurrentPassword(
  password: string,
  randomBytes: RandomBytes = nodeRandomBytes,
): string {
  const salt = Buffer.from(randomBytes(SCRYPT_SALT_BYTES));
  if (salt.byteLength !== SCRYPT_SALT_BYTES) {
    throw new Error("password salt source returned an invalid length");
  }
  const hash = derive(password, salt);
  return [
    "scrypt",
    "v1",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export function verifyCurrentScryptPassword(password: string, storedHash: string): boolean {
  const parts = currentHashParts(storedHash);
  return parts !== null && secureEqual(derive(password, parts.salt), parts.expected);
}

export function verifyPasswordHash(
  password: string,
  storedHash: string,
  scheme: PasswordHashScheme,
): { valid: boolean; needs_rehash: boolean } {
  const valid =
    scheme === LEGACY_PASSWORD_HASH_SCHEME
      ? verifyLegacyScryptPassword(password, storedHash)
      : verifyCurrentScryptPassword(password, storedHash);
  return {
    valid,
    needs_rehash: valid && scheme === LEGACY_PASSWORD_HASH_SCHEME,
  };
}

export function verifyAndRehashPassword(
  password: string,
  storedHash: string,
  scheme: PasswordHashScheme,
  randomBytes: RandomBytes = nodeRandomBytes,
): { valid: boolean; upgraded_hash: string | null; upgraded_scheme: PasswordHashScheme } {
  const result = verifyPasswordHash(password, storedHash, scheme);
  if (!result.valid) {
    return { valid: false, upgraded_hash: null, upgraded_scheme: scheme };
  }
  if (!result.needs_rehash) {
    return { valid: true, upgraded_hash: null, upgraded_scheme: scheme };
  }
  return {
    valid: true,
    upgraded_hash: hashCurrentPassword(password, randomBytes),
    upgraded_scheme: CURRENT_PASSWORD_HASH_SCHEME,
  };
}
