import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

describe("default-off legacy local cutover routes", () => {
  let server: NornsServer | undefined;

  afterEach(async () => {
    await server?.app.close();
    server = undefined;
  });

  it("rejects hidden local helper, pairing, and project creation mutations server-side", async () => {
    const users = new UserStore();
    users.createActive({
      email: "owner@example.test",
      password: "owner-password",
      role: "member",
    });
    const token = users.login("owner@example.test", "owner-password").token;
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
    });
    const headers = { authorization: `Bearer ${token}` };

    for (const request of [
      { method: "POST" as const, url: "/api/pairing/start", payload: {} },
      {
        method: "POST" as const,
        url: "/api/runners/helper/repositories/choose",
        payload: {},
      },
      {
        method: "POST" as const,
        url: "/api/projects",
        payload: {
          name: "Hidden local project",
          description: "must remain disabled",
          pm_provider: "anthropic",
        },
      },
    ]) {
      const response = await server.app.inject({ ...request, headers });
      expect(response.statusCode).toBe(404);
    }
  });

  it("retires only legacy helper installers while allowing an explicit compatibility window", async () => {
    const scripts = mkdtempSync(join(tmpdir(), "norns-legacy-installers-"));
    writeFileSync(join(scripts, "install-runner.sh"), "#!/bin/sh\n");
    writeFileSync(join(scripts, "install-runner.ps1"), "function Install-NornsHelper {}\n");
    const users = new UserStore();

    server = await buildServer({
      stores: new RelayStores(),
      users,
      installScriptsDir: scripts,
    });
    expect(
      (
        await server.app.inject({
          method: "GET",
          url: "/install/runner.sh",
        })
      ).statusCode,
    ).toBe(404);
    await server.app.close();

    server = await buildServer({
      stores: new RelayStores(),
      users,
      installScriptsDir: scripts,
      legacyHelperRoutes: { enabled: true },
    });
    for (const route of ["/install/runner.sh", "/install/runner.ps1"]) {
      const response = await server.app.inject({ method: "GET", url: route });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });
});
