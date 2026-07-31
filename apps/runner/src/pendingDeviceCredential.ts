import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DeviceCredentialSecretStore } from "./deviceCredentialSecretStore.js";

export const PENDING_DEVICE_CREDENTIAL_FILENAME = "pending-device-credential.json";

interface PendingDeviceCredentialRecord {
  version: 2;
  algorithm: "Ed25519";
  public_key_pem: string;
  secret_reference: string;
  created_at: string;
}

export interface PendingDeviceCredentialSummary {
  algorithm: "Ed25519";
  public_key_pem: string;
  public_key_fingerprint: string;
  created_at: string;
}

function ensurePrivateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function canonicalPublicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function summary(record: PendingDeviceCredentialRecord): PendingDeviceCredentialSummary {
  return {
    algorithm: record.algorithm,
    public_key_pem: record.public_key_pem,
    public_key_fingerprint: canonicalPublicKeyFingerprint(record.public_key_pem),
    created_at: record.created_at,
  };
}

function parseRecord(
  raw: string,
  secretStore: DeviceCredentialSecretStore,
): PendingDeviceCredentialRecord {
  const parsed = parseMetadata(raw);
  const protectedPrivateKey = secretStore.read(parsed.secret_reference);
  if (!protectedPrivateKey) {
    throw new Error("pending device credential secret is unavailable");
  }
  const privateKeyInput = {
    key: Buffer.from(protectedPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  } as const;
  const privateKey = createPrivateKey(privateKeyInput);
  const privateJwk = privateKey.export({ format: "jwk" });
  const expectedKey = createPublicKey(parsed.public_key_pem);
  const expectedJwk = expectedKey.export({ format: "jwk" });
  const expected = expectedKey.export({ type: "spki", format: "pem" }).toString();
  if (
    privateJwk.kty !== expectedJwk.kty ||
    privateJwk.crv !== expectedJwk.crv ||
    privateJwk.x !== expectedJwk.x
  ) {
    throw new Error("pending device credential keypair does not match");
  }

  return {
    ...parsed,
    public_key_pem: expected,
  };
}

function parseMetadata(raw: string): PendingDeviceCredentialRecord {
  const parsed = JSON.parse(raw) as Partial<PendingDeviceCredentialRecord>;
  if (
    parsed.version !== 2 ||
    parsed.algorithm !== "Ed25519" ||
    typeof parsed.public_key_pem !== "string" ||
    typeof parsed.secret_reference !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.secret_reference) ||
    typeof parsed.created_at !== "string"
  ) {
    throw new Error("pending device credential is malformed");
  }
  return {
    version: 2,
    algorithm: "Ed25519",
    public_key_pem: parsed.public_key_pem,
    secret_reference: parsed.secret_reference,
    created_at: parsed.created_at,
  };
}

/**
 * Pre-enrollment credential persistence with an OS-protected private key.
 *
 * The mode-0600 metadata file contains only the public key and an opaque secret
 * reference. Installed AgentHost construction supplies a platform vault
 * adapter; the private key never enters this metadata file.
 */
export class PendingDeviceCredentialStore {
  private readonly path: string;

  constructor(
    private readonly dataDir: string,
    private readonly secretStore: DeviceCredentialSecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(dataDir, PENDING_DEVICE_CREDENTIAL_FILENAME);
  }

  get filePath(): string {
    return this.path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  protectedSecretAvailable(): boolean {
    if (!this.exists()) return false;
    const record = parseMetadata(readFileSync(this.path, "utf8"));
    return Boolean(this.secretStore.read(record.secret_reference));
  }

  reset(): void {
    if (!this.exists()) return;
    const record = parseMetadata(readFileSync(this.path, "utf8"));
    this.secretStore.delete(record.secret_reference);
    unlinkSync(this.path);
  }

  read(): PendingDeviceCredentialSummary | null {
    if (!this.exists()) return null;
    return summary(this.readRecord());
  }

  /**
   * Create and durably persist an Ed25519 key before enrollment can use its
   * public half. Concurrent callers converge on the first complete file.
   */
  prepare(): PendingDeviceCredentialSummary {
    ensurePrivateDirectory(this.dataDir);
    if (this.exists()) return summary(this.readRecord());

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const secretReference = randomBytes(32).toString("base64url");
    const record: PendingDeviceCredentialRecord = {
      version: 2,
      algorithm: "Ed25519",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      secret_reference: secretReference,
      created_at: this.now().toISOString(),
    };
    const protectedPrivateKey = privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64");

    const temporaryPath = join(
      this.dataDir,
      `.${PENDING_DEVICE_CREDENTIAL_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let descriptor: number | null = null;
    try {
      this.secretStore.writeOnce(secretReference, protectedPrivateKey);
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporaryPath, 0o600);
      // Publish only a complete, fsynced file. `linkSync` is atomic and refuses
      // to replace a credential another AgentHost has already published.
      linkSync(temporaryPath, this.path);
      unlinkSync(temporaryPath);
      return summary(record);
    } catch (error) {
      if (descriptor !== null) {
        closeSync(descriptor);
        descriptor = null;
      }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The original persistence or publication error remains authoritative.
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        this.secretStore.delete(secretReference);
        return summary(this.readRecord());
      }
      this.secretStore.delete(secretReference);
      throw error;
    }
  }

  sign(payload: string): string {
    const record = this.readRecord();
    const protectedPrivateKey = this.secretStore.read(record.secret_reference);
    if (!protectedPrivateKey) throw new Error("pending device credential secret is unavailable");
    return edSign(
      null,
      Buffer.from(payload, "utf8"),
      createPrivateKey({
        key: Buffer.from(protectedPrivateKey, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    ).toString("base64");
  }

  private readRecord(): PendingDeviceCredentialRecord {
    ensurePrivateDirectory(this.dataDir);
    if (!this.exists()) throw new Error("pending device credential has not been prepared");
    chmodSync(this.path, 0o600);
    return parseRecord(readFileSync(this.path, "utf8"), this.secretStore);
  }
}
