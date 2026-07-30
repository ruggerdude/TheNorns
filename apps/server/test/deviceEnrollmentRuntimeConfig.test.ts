import { describe, expect, it } from "vitest";

import { DeviceEnrollmentCodeHasher } from "../src/devices/crypto.js";
import {
  DeviceEnrollmentRuntimeConfigurationError,
  type DeviceManagementRuntimeConfigurationError,
  parseDeviceEnrollmentRuntimeConfiguration,
  parseDeviceManagementRuntimeConfiguration,
} from "../src/devices/runtimeConfig.js";

describe("device enrollment runtime configuration", () => {
  it("is disabled by default and for the exact false value", () => {
    expect(parseDeviceEnrollmentRuntimeConfiguration({})).toEqual({ enabled: false });
    expect(
      parseDeviceEnrollmentRuntimeConfiguration({
        NORNS_ENABLE_DEVICE_ENROLLMENT: "false",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "ignored",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY: "not-a-secret",
      }),
    ).toEqual({ enabled: false });
  });

  it.each(["", "TRUE", "False", "1", "0", "yes", " true", "true "])(
    "rejects unknown enable value %j",
    (flag) => {
      expect(() =>
        parseDeviceEnrollmentRuntimeConfiguration({
          NORNS_ENABLE_DEVICE_ENROLLMENT: flag,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DeviceEnrollmentRuntimeConfigurationError>>({
          code: "device_enrollment_flag_invalid",
        }),
      );
    },
  );

  it("returns an enabled configuration usable by the enrollment code hasher", () => {
    const secret = Buffer.alloc(32, 23);
    const configuration = parseDeviceEnrollmentRuntimeConfiguration({
      NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
      NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "device-enrollment-2026-07",
      NORNS_DEVICE_ENROLLMENT_HMAC_KEY: secret.toString("base64"),
    });

    expect(configuration.enabled).toBe(true);
    if (!configuration.enabled) throw new Error("expected enabled configuration");
    expect(configuration.code_hmac_key).toMatchObject({
      version: 1,
      key_id: "device-enrollment-2026-07",
    });
    expect(Buffer.from(configuration.code_hmac_key.secret)).toEqual(secret);
    expect(
      new DeviceEnrollmentCodeHasher(configuration.code_hmac_key).hashDeviceCode("device-code")
        .keyed_hash,
    ).toHaveLength(32);
  });

  it("accepts canonical unpadded base64url secrets", () => {
    const secret = Buffer.alloc(48, 255);
    const configuration = parseDeviceEnrollmentRuntimeConfiguration({
      NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
      NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "device-enrollment-url-key",
      NORNS_DEVICE_ENROLLMENT_HMAC_KEY: secret.toString("base64url"),
    });

    expect(configuration.enabled).toBe(true);
    if (configuration.enabled) {
      expect(Buffer.from(configuration.code_hmac_key.secret)).toEqual(secret);
    }
  });

  it.each([
    [
      {
        NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
      },
      "device_enrollment_hmac_key_id_missing",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: " key-with-whitespace ",
      },
      "device_enrollment_hmac_key_id_invalid",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "key-id",
      },
      "device_enrollment_hmac_key_missing",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "key-id",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY: Buffer.alloc(31, 1).toString("base64"),
      },
      "device_enrollment_hmac_key_too_short",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "key-id",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY: "not*canonical*base64",
      },
      "device_enrollment_hmac_key_invalid",
    ],
  ] as const)(
    "fails closed for incomplete or invalid enabled configuration",
    (environment, code) => {
      expect(() => parseDeviceEnrollmentRuntimeConfiguration(environment)).toThrowError(
        expect.objectContaining<Partial<DeviceEnrollmentRuntimeConfigurationError>>({
          code,
        }),
      );
    },
  );

  it("never includes secret material in an error", () => {
    const rawSecret = "raw-secret-material-that-must-not-leak";
    try {
      parseDeviceEnrollmentRuntimeConfiguration({
        NORNS_ENABLE_DEVICE_ENROLLMENT: "true",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY_ID: "key-id",
        NORNS_DEVICE_ENROLLMENT_HMAC_KEY: rawSecret,
      });
      throw new Error("expected invalid secret to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceEnrollmentRuntimeConfigurationError);
      expect(String(error)).not.toContain(rawSecret);
    }
  });
});

describe("device management runtime configuration", () => {
  it("is independently disabled by default and for exact false", () => {
    expect(parseDeviceManagementRuntimeConfiguration({})).toEqual({ enabled: false });
    expect(
      parseDeviceManagementRuntimeConfiguration({
        NORNS_ENABLE_DEVICE_MANAGEMENT: "false",
      }),
    ).toEqual({ enabled: false });
  });

  it("enables only for exact true", () => {
    expect(
      parseDeviceManagementRuntimeConfiguration({
        NORNS_ENABLE_DEVICE_MANAGEMENT: "true",
      }),
    ).toEqual({ enabled: true });
  });

  it.each(["", "TRUE", "False", "1", "yes", " true", "true "])(
    "rejects unknown management enable value %j",
    (flag) => {
      expect(() =>
        parseDeviceManagementRuntimeConfiguration({
          NORNS_ENABLE_DEVICE_MANAGEMENT: flag,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DeviceManagementRuntimeConfigurationError>>({
          code: "device_management_flag_invalid",
        }),
      );
    },
  );
});
