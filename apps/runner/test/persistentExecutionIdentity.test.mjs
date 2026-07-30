import assert from "node:assert/strict";
import test from "node:test";
import { selectPersistentExecutionIdentity } from "../dist/index.js";

test("staged legacy compatibility does not borrow device HTTP authorization", () => {
  const legacy = {
    runner_id: "runner-1",
    generation: 4,
    http_identity: {
      mode: "legacy_runner",
      runnerId: "runner-1",
      generation: 4,
      sign: () => "legacy-signature",
    },
  };
  const device = {
    runner_id: "device-1",
    generation: 8,
    http_identity: {
      mode: "device",
      deviceId: "device-1",
      credentialId: "credential-1",
      generation: 8,
      sign: () => "device-signature",
    },
  };

  assert.equal(
    selectPersistentExecutionIdentity({
      device_execution_enabled: false,
      device,
      legacy,
    }),
    legacy,
  );
  assert.equal(
    selectPersistentExecutionIdentity({
      device_execution_enabled: true,
      device,
      legacy,
    }),
    device,
  );
  assert.throws(
    () =>
      selectPersistentExecutionIdentity({
        device_execution_enabled: true,
        device: null,
        legacy,
      }),
    /active device identity/,
  );
});
