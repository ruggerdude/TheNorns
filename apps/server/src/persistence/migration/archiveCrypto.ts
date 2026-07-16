import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { canonicalJson, canonicalSha256 } from "./canonicalJson.js";

export const LEGACY_ARCHIVE_ALGORITHM = "aes-256-gcm" as const;
const ARCHIVE_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface LegacyArchiveEncryptionKey {
  keyId: string;
  key: Uint8Array;
}

export interface LegacyArchiveAuthenticatedContext {
  archive_id: string;
  migration_run_id: string;
  source_key: string;
  exact_text_sha256: string;
  semantic_sha256: string;
  source_frozen_at: string;
}

export interface LegacyArchiveCiphertext {
  algorithm: typeof LEGACY_ARCHIVE_ALGORITHM;
  key_id: string;
  key_fingerprint: string;
  nonce_base64: string;
  auth_tag_base64: string;
  ciphertext_base64: string;
  aad_sha256: string;
  ciphertext_sha256: string;
}

export class LegacyArchiveCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyArchiveCryptoError";
  }
}

type RandomBytes = (size: number) => Uint8Array;

function checkedKey(input: LegacyArchiveEncryptionKey): Buffer {
  if (input.keyId.trim().length === 0) {
    throw new LegacyArchiveCryptoError("archive key id must not be empty");
  }
  if (input.key.byteLength !== ARCHIVE_KEY_BYTES) {
    throw new LegacyArchiveCryptoError("AES-256-GCM archive keys must contain exactly 32 bytes");
  }
  return Buffer.from(input.key);
}

export function archiveEncryptionKeyFingerprint(input: LegacyArchiveEncryptionKey): string {
  return createHash("sha256").update(checkedKey(input)).digest("hex");
}

function archiveAad(context: LegacyArchiveAuthenticatedContext): Buffer {
  return Buffer.from(canonicalJson(context), "utf8");
}

export function encryptLegacyArchive(
  plaintext: Uint8Array,
  key: LegacyArchiveEncryptionKey,
  context: LegacyArchiveAuthenticatedContext,
  randomBytes: RandomBytes = nodeRandomBytes,
): LegacyArchiveCiphertext {
  const keyBytes = checkedKey(key);
  const nonce = Buffer.from(randomBytes(GCM_NONCE_BYTES));
  if (nonce.byteLength !== GCM_NONCE_BYTES) {
    throw new LegacyArchiveCryptoError("archive nonce source returned an invalid length");
  }

  const aad = archiveAad(context);
  const cipher = createCipheriv(LEGACY_ARCHIVE_ALGORITHM, keyBytes, nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: LEGACY_ARCHIVE_ALGORITHM,
    key_id: key.keyId,
    key_fingerprint: archiveEncryptionKeyFingerprint(key),
    nonce_base64: nonce.toString("base64"),
    auth_tag_base64: authTag.toString("base64"),
    ciphertext_base64: ciphertext.toString("base64"),
    aad_sha256: canonicalSha256(context),
    ciphertext_sha256: createHash("sha256").update(ciphertext).digest("hex"),
  };
}

export function decryptLegacyArchive(
  encrypted: LegacyArchiveCiphertext,
  key: LegacyArchiveEncryptionKey,
  context: LegacyArchiveAuthenticatedContext,
): Buffer {
  const keyBytes = checkedKey(key);
  if (
    encrypted.algorithm !== LEGACY_ARCHIVE_ALGORITHM ||
    encrypted.key_id !== key.keyId ||
    encrypted.key_fingerprint !== archiveEncryptionKeyFingerprint(key)
  ) {
    throw new LegacyArchiveCryptoError("archive encryption metadata does not match the key");
  }
  if (encrypted.aad_sha256 !== canonicalSha256(context)) {
    throw new LegacyArchiveCryptoError("archive authenticated context does not match");
  }

  const nonce = Buffer.from(encrypted.nonce_base64, "base64");
  const authTag = Buffer.from(encrypted.auth_tag_base64, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext_base64, "base64");
  if (nonce.byteLength !== GCM_NONCE_BYTES || authTag.byteLength !== GCM_TAG_BYTES) {
    throw new LegacyArchiveCryptoError("archive encryption metadata is malformed");
  }
  const ciphertextHash = createHash("sha256").update(ciphertext).digest("hex");
  if (ciphertextHash !== encrypted.ciphertext_sha256) {
    throw new LegacyArchiveCryptoError("archive ciphertext checksum does not match");
  }

  try {
    const decipher = createDecipheriv(LEGACY_ARCHIVE_ALGORITHM, keyBytes, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(archiveAad(context));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new LegacyArchiveCryptoError("archive authentication failed");
  }
}
