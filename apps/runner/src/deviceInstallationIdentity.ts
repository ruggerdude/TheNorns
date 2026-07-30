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
import type { DeviceWssIdentity } from "./deviceWssAuth.js";

export const ACTIVE_DEVICE_IDENTITY_FILENAME = "active-device-identity.json";

export interface ActiveDeviceIdentity extends DeviceWssIdentity {
  activated_at: string;
}

interface ActiveDeviceIdentityRecord extends ActiveDeviceIdentity {
  version: 1;
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function parseActiveIdentity(raw: string): ActiveDeviceIdentityRecord {
  const parsed = JSON.parse(raw) as Partial<ActiveDeviceIdentityRecord>;
  if (
    parsed.version !== 1 ||
    !validOpaqueId(parsed.device_id) ||
    !validOpaqueId(parsed.credential_id) ||
    !Number.isSafeInteger(parsed.generation) ||
    (parsed.generation as number) < 0 ||
    typeof parsed.activated_at !== "string" ||
    Number.isNaN(Date.parse(parsed.activated_at))
  ) {
    throw new Error("active device identity is malformed");
  }
  return {
    version: 1,
    device_id: parsed.device_id,
    credential_id: parsed.credential_id,
    generation: parsed.generation as number,
    activated_at: parsed.activated_at,
  };
}

function privateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

/**
 * Persists only the opaque identity returned by a successful, key-proven
 * enrollment redemption.
 *
 * This class deliberately does not accept loopback HTTP input or perform the
 * redemption itself. The Phase 6 fresh-enrollment/claim client must call
 * `activateFromRedemption` only after validating the server's `active` result
 * against the already-persisted credential. Different identity is never
 * overwritten in place: revoke and re-enroll into a fresh installation state.
 */
export class ActiveDeviceIdentityStore {
  private readonly path: string;

  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, ACTIVE_DEVICE_IDENTITY_FILENAME);
  }

  get filePath(): string {
    return this.path;
  }

  read(): ActiveDeviceIdentity | null {
    if (!existsSync(this.path)) return null;
    privateDirectory(this.dataDir);
    chmodSync(this.path, 0o600);
    const record = parseActiveIdentity(readFileSync(this.path, "utf8"));
    return {
      device_id: record.device_id,
      credential_id: record.credential_id,
      generation: record.generation,
      activated_at: record.activated_at,
    };
  }

  activateFromRedemption(identity: ActiveDeviceIdentity): ActiveDeviceIdentity {
    const record = parseActiveIdentity(JSON.stringify({ version: 1, ...identity }));
    privateDirectory(this.dataDir);
    const existing = this.read();
    if (existing) {
      if (
        existing.device_id !== record.device_id ||
        existing.credential_id !== record.credential_id ||
        existing.generation !== record.generation
      ) {
        throw new Error("active device identity already exists; revoke and re-enroll");
      }
      return existing;
    }

    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(record), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporaryPath, 0o600);
      linkSync(temporaryPath, this.path);
      unlinkSync(temporaryPath);
      chmodSync(this.path, 0o600);
      let directoryDescriptor: number | null = null;
      try {
        directoryDescriptor = openSync(this.dataDir, "r");
        fsyncSync(directoryDescriptor);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      } finally {
        if (directoryDescriptor !== null) closeSync(directoryDescriptor);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const concurrentlyActivated = this.read();
        if (
          concurrentlyActivated &&
          concurrentlyActivated.device_id === record.device_id &&
          concurrentlyActivated.credential_id === record.credential_id &&
          concurrentlyActivated.generation === record.generation
        ) {
          return concurrentlyActivated;
        }
        throw new Error("active device identity already exists; revoke and re-enroll");
      }
      throw error;
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A mode-0600 orphaned temp file is safer than allowing cleanup to
        // overwrite the authoritative activation result.
      }
    }
    return {
      device_id: record.device_id,
      credential_id: record.credential_id,
      generation: record.generation,
      activated_at: record.activated_at,
    };
  }
}
