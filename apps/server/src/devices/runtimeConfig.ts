import type { DeviceCodeHmacKey } from "./crypto.js";

export interface DeviceEnrollmentRuntimeEnvironment {
  NORNS_ENABLE_DEVICE_ENROLLMENT?: string | undefined;
  NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID?: string | undefined;
  NORNS_DEVICE_ENROLLMENT_HMAC_KEY?: string | undefined;
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
