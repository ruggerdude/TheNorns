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

export const PENDING_DEVICE_CREDENTIAL_FILENAME = "pending-device-credential.json";

interface PendingDeviceCredentialRecord {
  version: 1;
  algorithm: "Ed25519";
  public_key_pem: string;
  private_key_pem: string;
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

function parseRecord(raw: string): PendingDeviceCredentialRecord {
  const parsed = JSON.parse(raw) as Partial<PendingDeviceCredentialRecord>;
  if (
    parsed.version !== 1 ||
    parsed.algorithm !== "Ed25519" ||
    typeof parsed.public_key_pem !== "string" ||
    typeof parsed.private_key_pem !== "string" ||
    typeof parsed.created_at !== "string"
  ) {
    throw new Error("pending device credential is malformed");
  }

  const privateKey = createPrivateKey(parsed.private_key_pem);
  const normalizedPrivate = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const derivedPublic = createPublicKey(normalizedPrivate)
    .export({ type: "spki", format: "pem" })
    .toString();
  const expected = createPublicKey(parsed.public_key_pem)
    .export({ type: "spki", format: "pem" })
    .toString();
  if (derivedPublic !== expected) {
    throw new Error("pending device credential keypair does not match");
  }

  return {
    version: 1,
    algorithm: "Ed25519",
    public_key_pem: expected,
    private_key_pem: normalizedPrivate,
    created_at: parsed.created_at,
  };
}

/**
 * Portable, pre-enrollment credential persistence.
 *
 * This is deliberately a file-mode baseline rather than a claim that every OS
 * credential vault is integrated. A future platform adapter may replace this
 * store without changing AgentHost's prepare-before-request contract.
 */
export class PendingDeviceCredentialStore {
  private readonly path: string;

  constructor(
    private readonly dataDir: string,
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
    const record: PendingDeviceCredentialRecord = {
      version: 1,
      algorithm: "Ed25519",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      created_at: this.now().toISOString(),
    };

    const temporaryPath = join(
      this.dataDir,
      `.${PENDING_DEVICE_CREDENTIAL_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let descriptor: number | null = null;
    try {
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
        return summary(this.readRecord());
      }
      throw error;
    }
  }

  sign(payload: string): string {
    const record = this.readRecord();
    return edSign(null, Buffer.from(payload, "utf8"), record.private_key_pem).toString("base64");
  }

  private readRecord(): PendingDeviceCredentialRecord {
    ensurePrivateDirectory(this.dataDir);
    if (!this.exists()) throw new Error("pending device credential has not been prepared");
    chmodSync(this.path, 0o600);
    return parseRecord(readFileSync(this.path, "utf8"));
  }
}
