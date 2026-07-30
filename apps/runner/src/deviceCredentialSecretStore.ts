import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

export interface DeviceCredentialSecretStore {
  readonly protection:
    | "memory"
    | "macos-keychain"
    | "windows-dpapi"
    | "linux-secret-service"
    | "development-file";
  read(reference: string): string | null;
  writeOnce(reference: string, secret: string): void;
  delete(reference: string): void;
}

function validReference(reference: string): void {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(reference)) {
    throw new Error("device credential secret reference is malformed");
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateFileOnce(path: string, value: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, value, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, 0o600);
    linkSync(temporaryPath, path);
    unlinkSync(temporaryPath);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The protected destination or original error remains authoritative.
    }
  }
}

export class InMemoryDeviceCredentialSecretStore implements DeviceCredentialSecretStore {
  readonly protection = "memory" as const;
  private readonly values = new Map<string, string>();

  get size(): number {
    return this.values.size;
  }

  read(reference: string): string | null {
    validReference(reference);
    return this.values.get(reference) ?? null;
  }

  writeOnce(reference: string, secret: string): void {
    validReference(reference);
    if (this.values.has(reference)) throw new Error("device credential secret already exists");
    this.values.set(reference, secret);
  }

  delete(reference: string): void {
    validReference(reference);
    this.values.delete(reference);
  }
}

/**
 * Explicitly insecure development adapter. Installed paths never select this
 * unless NORNS_ALLOW_INSECURE_DEVICE_KEY_FILE is exactly "true".
 */
export class DevelopmentFileDeviceCredentialSecretStore implements DeviceCredentialSecretStore {
  readonly protection = "development-file" as const;
  private readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "development-device-secrets");
  }

  read(reference: string): string | null {
    validReference(reference);
    const path = join(this.directory, `${reference}.secret`);
    if (!existsSync(path)) return null;
    privateDirectory(this.directory);
    chmodSync(path, 0o600);
    return readFileSync(path, "utf8");
  }

  writeOnce(reference: string, secret: string): void {
    validReference(reference);
    privateDirectory(this.directory);
    writePrivateFileOnce(join(this.directory, `${reference}.secret`), secret);
  }

  delete(reference: string): void {
    validReference(reference);
    try {
      unlinkSync(join(this.directory, `${reference}.secret`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const MACOS_KEYCHAIN_SERVICE = "com.thenorns.local-agent.device-credential";

function commandFailure(command: string, result: ReturnType<typeof spawnSync>): Error {
  const code = result.status === null ? "unavailable" : String(result.status);
  return new Error(`${command} failed (${code})`);
}

export class MacOsKeychainDeviceCredentialSecretStore implements DeviceCredentialSecretStore {
  readonly protection = "macos-keychain" as const;

  read(reference: string): string | null {
    validReference(reference);
    const result = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", reference, "-s", MACOS_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 },
    );
    if (result.status === 44) return null;
    if (result.status !== 0) throw commandFailure("macOS Keychain lookup", result);
    return String(result.stdout).replace(/\r?\n$/, "");
  }

  writeOnce(reference: string, secret: string): void {
    validReference(reference);
    if (this.read(reference) !== null) {
      throw new Error("device credential secret already exists");
    }
    // `-w` is deliberately last and has no argument: security(1) reads the
    // value from stdin, so private key material never enters argv.
    const result = spawnSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-a",
        reference,
        "-s",
        MACOS_KEYCHAIN_SERVICE,
        "-l",
        "Norns Local Agent device credential",
        "-w",
      ],
      {
        input: `${secret}\n`,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
        maxBuffer: 64 * 1024,
      },
    );
    if (result.status !== 0) throw commandFailure("macOS Keychain write", result);
  }

  delete(reference: string): void {
    validReference(reference);
    const result = spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-a", reference, "-s", MACOS_KEYCHAIN_SERVICE],
      { encoding: "utf8", stdio: "ignore" },
    );
    if (result.status !== 0 && result.status !== 44) {
      throw commandFailure("macOS Keychain delete", result);
    }
  }
}

export class LinuxSecretServiceDeviceCredentialSecretStore implements DeviceCredentialSecretStore {
  readonly protection = "linux-secret-service" as const;

  read(reference: string): string | null {
    validReference(reference);
    const result = spawnSync(
      "secret-tool",
      ["lookup", "application", "org.thenorns.local-agent", "credential", reference],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 },
    );
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Linux Secret Service client is unavailable");
    }
    if (result.status !== 0) return null;
    return String(result.stdout).replace(/\r?\n$/, "");
  }

  writeOnce(reference: string, secret: string): void {
    validReference(reference);
    if (this.read(reference) !== null) {
      throw new Error("device credential secret already exists");
    }
    const result = spawnSync(
      "secret-tool",
      [
        "store",
        "--label=Norns Local Agent device credential",
        "application",
        "org.thenorns.local-agent",
        "credential",
        reference,
      ],
      {
        input: `${secret}\n`,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "ignore"],
        maxBuffer: 64 * 1024,
      },
    );
    if (result.status !== 0) throw commandFailure("Linux Secret Service write", result);
  }

  delete(reference: string): void {
    validReference(reference);
    const result = spawnSync(
      "secret-tool",
      ["clear", "application", "org.thenorns.local-agent", "credential", reference],
      { encoding: "utf8", stdio: "ignore" },
    );
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (result.status !== 0 && result.status !== 1) {
      throw commandFailure("Linux Secret Service delete", result);
    }
  }
}

export class WindowsDpapiDeviceCredentialSecretStore implements DeviceCredentialSecretStore {
  readonly protection = "windows-dpapi" as const;
  private readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "protected-device-secrets");
  }

  read(reference: string): string | null {
    validReference(reference);
    const path = join(this.directory, `${reference}.dpapi`);
    if (!existsSync(path)) return null;
    const encrypted = readFileSync(path, "utf8");
    const script =
      "$e=[Console]::In.ReadToEnd();" +
      "$s=ConvertTo-SecureString $e;" +
      "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);" +
      "try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}" +
      "finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}";
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: encrypted,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    if (result.status !== 0) throw commandFailure("Windows DPAPI read", result);
    return String(result.stdout);
  }

  writeOnce(reference: string, secret: string): void {
    validReference(reference);
    privateDirectory(this.directory);
    const script =
      "$p=[Console]::In.ReadToEnd();" +
      "$s=ConvertTo-SecureString $p -AsPlainText -Force;" +
      "[Console]::Out.Write((ConvertFrom-SecureString $s))";
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        input: secret,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    if (result.status !== 0) throw commandFailure("Windows DPAPI write", result);
    writePrivateFileOnce(join(this.directory, `${reference}.dpapi`), String(result.stdout).trim());
  }

  delete(reference: string): void {
    validReference(reference);
    try {
      unlinkSync(join(this.directory, `${reference}.dpapi`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function createInstalledDeviceCredentialSecretStore(
  dataDir: string,
  options: { allowInsecureDevelopmentFile?: boolean; platform?: NodeJS.Platform } = {},
): DeviceCredentialSecretStore {
  if (options.allowInsecureDevelopmentFile === true) {
    return new DevelopmentFileDeviceCredentialSecretStore(dataDir);
  }
  switch (options.platform ?? process.platform) {
    case "darwin":
      return new MacOsKeychainDeviceCredentialSecretStore();
    case "win32":
      return new WindowsDpapiDeviceCredentialSecretStore(dataDir);
    case "linux":
      return new LinuxSecretServiceDeviceCredentialSecretStore();
    default:
      throw new Error("no supported OS-protected device credential store is available");
  }
}
