import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DeviceEnrollmentCodeHasher } from "../src/devices/crypto.js";
import {
  DeviceEnrollmentRuntimeConfigurationError,
  type DeviceManagementRuntimeConfigurationError,
  type DeviceRepositoryAccessRuntimeConfigurationError,
  parseDeviceEnrollmentRuntimeConfiguration,
  parseDeviceManagementRuntimeConfiguration,
  parseDeviceRepositoryAccessRuntimeConfiguration,
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

describe("device repository access runtime configuration", () => {
  const ed25519 = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8",
  });

  it("is independently disabled by default and ignores signing material while false", () => {
    expect(parseDeviceRepositoryAccessRuntimeConfiguration({})).toEqual({ enabled: false });
    expect(
      parseDeviceRepositoryAccessRuntimeConfiguration({
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "false",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: "ignored",
        NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY: "ignored",
      }),
    ).toEqual({ enabled: false });
  });

  it.each(["", "TRUE", "False", "1", "yes", " true", "true "])(
    "rejects unknown repository-access enable value %j",
    (flag) => {
      expect(() =>
        parseDeviceRepositoryAccessRuntimeConfiguration({
          NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: flag,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DeviceRepositoryAccessRuntimeConfigurationError>>({
          code: "device_repository_access_flag_invalid",
        }),
      );
    },
  );

  it.each([
    [{ NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true" }, "publication_signing_key_id_missing"],
    [
      {
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: " bad key ",
      },
      "publication_signing_key_id_invalid",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: "permit-key",
      },
      "publication_signing_private_key_missing",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: "permit-key",
        NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY: Buffer.alloc(31).toString("base64"),
      },
      "publication_signing_private_key_too_short",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: "permit-key",
        NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY: "not*base64",
      },
      "publication_signing_private_key_invalid",
    ],
    [
      {
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: "permit-key",
        NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY: generateKeyPairSync("rsa", {
          modulusLength: 2048,
        })
          .privateKey.export({ format: "der", type: "pkcs8" })
          .toString("base64"),
      },
      "publication_signing_private_key_not_ed25519",
    ],
  ] as const)("fails closed for invalid enabled signing configuration", (environment, code) => {
    expect(() => parseDeviceRepositoryAccessRuntimeConfiguration(environment)).toThrowError(
      expect.objectContaining<Partial<DeviceRepositoryAccessRuntimeConfigurationError>>({ code }),
    );
  });

  it.each(["base64", "base64url"] as const)(
    "accepts a canonical Ed25519 PKCS8 %s key",
    (encoding) => {
      const configuration = parseDeviceRepositoryAccessRuntimeConfiguration({
        NORNS_ENABLE_DEVICE_REPOSITORY_ACCESS: "true",
        NORNS_DEVICE_PUBLICATION_SIGNING_KEY_ID: "permit-key-2026-07",
        NORNS_DEVICE_PUBLICATION_SIGNING_PRIVATE_KEY: ed25519.toString(encoding),
      });
      expect(configuration.enabled).toBe(true);
      if (configuration.enabled) {
        expect(configuration.publication_signing_key_id).toBe("permit-key-2026-07");
        expect(configuration.publication_signing_private_key.asymmetricKeyType).toBe("ed25519");
      }
    },
  );
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
