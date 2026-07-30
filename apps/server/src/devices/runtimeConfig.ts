import { type KeyObject, createPrivateKey } from "node:crypto";
import type { DeviceCodeHmacKey } from "./crypto.js";

export interface DeviceEnrollmentRuntimeEnvironment {
  NORNS_ENABLE_DEVICE_ENROLLMENT?: string | undefined;
  NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID?: string | undefined;
  NORNS_DEVICE_ENROLLMENT_HMAC_KEY?: string | undefined;
}

export interface DeviceManagementRuntimeEnvironment {
  NORNS_ENABLE_DEVICE_MANAGEMENT?: string | undefined;
}

export interface DeviceRepositoryAccessRuntimeEnvironment {
  NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS?: string | undefined;
  NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID?: string | undefined;
  NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY?: string | undefined;
}

export interface DeviceCutoverRuntimeEnvironment {
  NORNS_ENABLE_LEGACY_REPOSITORY_CLAIMS?: string | undefined;
  NORNS_ENABLE_LEGACY_PAIRING_ROUTES?: string | undefined;
  NORNS_ENABLE_LEGACY_HELPER_ROUTES?: string | undefined;
  NORNS_ENABLE_LEGACY_LOCAL_RUNNER_AUTH?: string | undefined;
  NORNS_LEGACY_GLOBAL_RUNNER_COMPATIBILITY?: string | undefined;
  NORNS_ENABLE_DEVICE_DISPATCH?: string | undefined;
}

export interface DeviceCutoverRuntimeConfiguration {
  legacy_repository_claims_enabled: boolean;
  legacy_pairing_routes_enabled: boolean;
  legacy_helper_routes_enabled: boolean;
  legacy_local_runner_auth_enabled: boolean;
  legacy_global_runner_compatibility_enabled: boolean;
  device_dispatch_enabled: boolean;
}

export class DeviceCutoverRuntimeConfigurationError extends Error {
  constructor(readonly variable: keyof DeviceCutoverRuntimeEnvironment) {
    super(`${variable} must be exactly true or false`);
    this.name = "DeviceCutoverRuntimeConfigurationError";
  }
}

export type DeviceRepositoryAccessRuntimeConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      publication_signing_key_id: string;
      publication_signing_private_key: KeyObject;
    };

export type DeviceRepositoryAccessRuntimeConfigurationErrorCode =
  | "device_repository_access_flag_invalid"
  | "publication_signing_key_id_missing"
  | "publication_signing_key_id_invalid"
  | "publication_signing_private_key_missing"
  | "publication_signing_private_key_invalid"
  | "publication_signing_private_key_too_short"
  | "publication_signing_private_key_not_ed25519";

export class DeviceRepositoryAccessRuntimeConfigurationError extends Error {
  constructor(readonly code: DeviceRepositoryAccessRuntimeConfigurationErrorCode) {
    super(
      code === "device_repository_access_flag_invalid"
        ? "NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS must be exactly true or false"
        : code === "publication_signing_key_id_missing"
          ? "device repository access requires a publication signing key ID"
          : code === "publication_signing_key_id_invalid"
            ? "the publication signing key ID is invalid"
            : code === "publication_signing_private_key_missing"
              ? "device repository access requires a publication signing private key"
              : code === "publication_signing_private_key_too_short"
                ? "the publication signing private key must contain at least 256 bits"
                : code === "publication_signing_private_key_not_ed25519"
                  ? "the publication signing private key must be Ed25519"
                  : "the publication signing private key encoding is invalid",
    );
    this.name = "DeviceRepositoryAccessRuntimeConfigurationError";
  }
}

export type DeviceManagementRuntimeConfiguration = {
  enabled: boolean;
};

export class DeviceManagementRuntimeConfigurationError extends Error {
  constructor(readonly code: "device_management_flag_invalid") {
    super("NORNS_ENABLE_DEVICE_MANAGEMENT must be exactly true or false");
    this.name = "DeviceManagementRuntimeConfigurationError";
  }
}

export type DeviceEnrollmentRuntimeConfiguration =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      code_hmac_key: DeviceCodeHmacKey;
    };

export type DeviceEnrollmentRuntimeConfigurationErrorCode =
  | "device_enrollment_flag_invalid"
  | "device_enrollment_hmac_key_id_missing"
  | "device_enrollment_hmac_key_id_invalid"
  | "device_enrollment_hmac_key_missing"
  | "device_enrollment_hmac_key_invalid"
  | "device_enrollment_hmac_key_too_short";

export class DeviceEnrollmentRuntimeConfigurationError extends Error {
  constructor(readonly code: DeviceEnrollmentRuntimeConfigurationErrorCode) {
    super(
      code === "device_enrollment_flag_invalid"
        ? "NORNS_ENABLE_DEVICE_ENROLLMENT must be exactly true or false"
        : code === "device_enrollment_hmac_key_id_missing"
          ? "device enrollment requires a stable HMAC key ID"
          : code === "device_enrollment_hmac_key_id_invalid"
            ? "the device enrollment HMAC key ID is invalid"
            : code === "device_enrollment_hmac_key_missing"
              ? "device enrollment requires an HMAC secret"
              : code === "device_enrollment_hmac_key_too_short"
                ? "the device enrollment HMAC secret must contain at least 256 bits"
                : "the device enrollment HMAC secret encoding is invalid",
    );
    this.name = "DeviceEnrollmentRuntimeConfigurationError";
  }
}

function decodeCanonicalSecret(encoded: string): Buffer {
  const canonicalBase64 =
    encoded.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded);
  if (canonicalBase64) {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") === encoded) return decoded;
  }

  if (/^[A-Za-z0-9_-]+$/.test(encoded)) {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") === encoded) return decoded;
  }

  throw new DeviceEnrollmentRuntimeConfigurationError("device_enrollment_hmac_key_invalid");
}

/**
 * Enrollment remains disabled unless its flag is exactly `true`. Enabled
 * startup fails closed unless one stable key identifier and one canonical
 * base64/base64url secret are available.
 */
export function parseDeviceEnrollmentRuntimeConfiguration(
  environment: DeviceEnrollmentRuntimeEnvironment,
): DeviceEnrollmentRuntimeConfiguration {
  const flag = environment.NORNS_ENABLE_DEVICE_ENROLLMENT;
  if (flag === undefined || flag === "false") return { enabled: false };
  if (flag !== "true") {
    throw new DeviceEnrollmentRuntimeConfigurationError("device_enrollment_flag_invalid");
  }

  const keyId = environment.NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID;
  if (keyId === undefined || keyId.length === 0) {
    throw new DeviceEnrollmentRuntimeConfigurationError("device_enrollment_hmac_key_id_missing");
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) {
    throw new DeviceEnrollmentRuntimeConfigurationError("device_enrollment_hmac_key_id_invalid");
  }

  const encodedSecret = environment.NORNS_DEVICE_ENROLLMENT_HMAC_KEY;
  if (encodedSecret === undefined || encodedSecret.length === 0) {
    throw new DeviceEnrollmentRuntimeConfigurationError("device_enrollment_hmac_key_missing");
  }
  const secret = decodeCanonicalSecret(encodedSecret);
  if (secret.byteLength < 32) {
    throw new DeviceEnrollmentRuntimeConfigurationError("device_enrollment_hmac_key_too_short");
  }

  return {
    enabled: true,
    code_hmac_key: {
      version: 1,
      key_id: keyId,
      secret,
    },
  };
}

/**
 * Owned-device and project-target HTTP surfaces are a separate rollout gate.
 * They do not become reachable merely because enrollment or device transport
 * is enabled.
 */
export function parseDeviceManagementRuntimeConfiguration(
  environment: DeviceManagementRuntimeEnvironment,
): DeviceManagementRuntimeConfiguration {
  const flag = environment.NORNS_ENABLE_DEVICE_MANAGEMENT;
  if (flag === undefined || flag === "false") return { enabled: false };
  if (flag !== "true") {
    throw new DeviceManagementRuntimeConfigurationError("device_management_flag_invalid");
  }
  return { enabled: true };
}

/**
 * Phase 4 remains absent unless explicitly enabled. Publication permits use a
 * dedicated Ed25519 key; enrollment HMAC material is never accepted here.
 */
export function parseDeviceRepositoryAccessRuntimeConfiguration(
  environment: DeviceRepositoryAccessRuntimeEnvironment,
): DeviceRepositoryAccessRuntimeConfiguration {
  const flag = environment.NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS;
  if (flag === undefined || flag === "false") return { enabled: false };
  if (flag !== "true") {
    throw new DeviceRepositoryAccessRuntimeConfigurationError(
      "device_repository_access_flag_invalid",
    );
  }

  const keyId = environment.NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID;
  if (keyId === undefined || keyId.length === 0) {
    throw new DeviceRepositoryAccessRuntimeConfigurationError("publication_signing_key_id_missing");
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) {
    throw new DeviceRepositoryAccessRuntimeConfigurationError("publication_signing_key_id_invalid");
  }

  const encoded = environment.NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY;
  if (encoded === undefined || encoded.length === 0) {
    throw new DeviceRepositoryAccessRuntimeConfigurationError(
      "publication_signing_private_key_missing",
    );
  }

  let der: Buffer;
  try {
    if (
      encoded.length % 4 === 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    ) {
      der = Buffer.from(encoded, "base64");
      if (der.toString("base64") !== encoded) throw new Error("non-canonical base64");
    } else if (/^[A-Za-z0-9_-]+$/.test(encoded)) {
      der = Buffer.from(encoded, "base64url");
      if (der.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    } else {
      throw new Error("invalid alphabet");
    }
  } catch {
    throw new DeviceRepositoryAccessRuntimeConfigurationError(
      "publication_signing_private_key_invalid",
    );
  }
  if (der.byteLength < 32) {
    throw new DeviceRepositoryAccessRuntimeConfigurationError(
      "publication_signing_private_key_too_short",
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new DeviceRepositoryAccessRuntimeConfigurationError(
      "publication_signing_private_key_invalid",
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new DeviceRepositoryAccessRuntimeConfigurationError(
      "publication_signing_private_key_not_ed25519",
    );
  }

  return {
    enabled: true,
    publication_signing_key_id: keyId,
    publication_signing_private_key: privateKey,
  };
}

function strictDefaultOffFlag(
  environment: DeviceCutoverRuntimeEnvironment,
  variable: keyof DeviceCutoverRuntimeEnvironment,
): boolean {
  const value = environment[variable];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new DeviceCutoverRuntimeConfigurationError(variable);
}

/**
 * Phase 6/7 cutover gates are independent and default off. Device dispatch is
 * deliberately separate from the global engine kill switch so canaries can
 * stop local-device delivery while GitHub Actions remains available.
 */
export function parseDeviceCutoverRuntimeConfiguration(
  environment: DeviceCutoverRuntimeEnvironment,
): DeviceCutoverRuntimeConfiguration {
  return {
    legacy_repository_claims_enabled: strictDefaultOffFlag(
      environment,
      "NORNS_ENABLE_LEGACY_REPOSITORY_CLAIMS",
    ),
    legacy_pairing_routes_enabled: strictDefaultOffFlag(
      environment,
      "NORNS_ENABLE_LEGACY_PAIRING_ROUTES",
    ),
    legacy_helper_routes_enabled: strictDefaultOffFlag(
      environment,
      "NORNS_ENABLE_LEGACY_HELPER_ROUTES",
    ),
    legacy_local_runner_auth_enabled: strictDefaultOffFlag(
      environment,
      "NORNS_ENABLE_LEGACY_LOCAL_RUNNER_AUTH",
    ),
    legacy_global_runner_compatibility_enabled: strictDefaultOffFlag(
      environment,
      "NORNS_LEGACY_GLOBAL_RUNNER_COMPATIBILITY",
    ),
    device_dispatch_enabled: strictDefaultOffFlag(environment, "NORNS_ENABLE_DEVICE_DISPATCH"),
  };
}
