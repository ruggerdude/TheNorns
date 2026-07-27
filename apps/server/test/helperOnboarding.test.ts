import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseLocalAgentPairingUri,
  readLocalAgentConfig,
  writeLocalAgentConfig,
} from "@norns/runner";
import { describe, expect, it } from "vitest";
import {
  type HelperRunnerSnapshot,
  helperStatus,
  localAgentDownloadsFromEnvironment,
  localAgentPairingUri,
} from "../src/runners/helperOnboarding.js";

const installerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/install-runner.sh",
);
const runnerCliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../runner/dist/cli.js");
const execFileAsync = promisify(execFile);

function runner(overrides: Partial<HelperRunnerSnapshot> = {}): HelperRunnerSnapshot {
  return {
    runner_id: "runner-1",
    generation: 1,
    connected: true,
    workspace_picker_ready: true,
    workspace_repository_inventory_ready: true,
    workspace_clone_ready: true,
    last_seen_at: "2026-07-27T18:00:00.000Z",
    ...overrides,
  };
}

describe("local helper capability status", () => {
  it("accepts a helper that supports the current repository inventory", () => {
    expect(helperStatus([runner()])).toMatchObject({
      state: "connected",
      runner_id: "runner-1",
    });
  });

  it("requires an update when a legacy picker cannot catalog or inspect repositories", () => {
    expect(helperStatus([runner({ workspace_repository_inventory_ready: false })])).toMatchObject({
      state: "degraded",
      runner_id: "runner-1",
      message: expect.stringMatching(/out of date/i),
    });
  });

  it("prefers a clone-capable helper when more than one helper is connected", () => {
    expect(
      helperStatus([
        runner({ runner_id: "legacy-helper", workspace_clone_ready: false }),
        runner({ runner_id: "current-helper" }),
      ]),
    ).toMatchObject({
      state: "connected",
      runner_id: "current-helper",
      workspace_clone_ready: true,
    });
  });
});

describe("local helper installer", () => {
  it("runs the shipped Node version check as valid JavaScript", () => {
    const versionCheck = `[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]`;
    expect(readFileSync(installerPath, "utf8")).toContain(versionCheck);
    expect(() => execFileSync("sh", ["-c", versionCheck])).not.toThrow();
  });

  it("creates a one-use desktop pairing URI that the runner parses without ambiguity", () => {
    const uri = localAgentPairingUri({
      origin: "https://norns.example",
      code: "a1b2c3d4",
      runnerId: "beginner-laptop",
    });
    expect(parseLocalAgentPairingUri(uri)).toEqual({
      server: "https://norns.example",
      code: "a1b2c3d4",
      runnerId: "beginner-laptop",
    });
    expect(() =>
      parseLocalAgentPairingUri(
        "norns-agent://pair?server=http%3A%2F%2Fevil.example&code=a1b2c3d4",
      ),
    ).toThrow(/HTTPS/);
  });

  it("persists only the normalized server and runner id needed for login startup", () => {
    const data = mkdtempSync(join(tmpdir(), "norns-agent-config-"));
    writeLocalAgentConfig(data, {
      version: 1,
      server: "https://norns.example/",
      runner_id: "runner-1",
    });
    expect(readLocalAgentConfig(data)).toEqual({
      version: 1,
      server: "https://norns.example",
      runner_id: "runner-1",
    });
    expect(readFileSync(join(data, "agent-config.json"), "utf8")).not.toContain("pair");
  });

  it("lets the packaged CLI redeem a pairing link and persist login-start configuration", async () => {
    let received: Record<string, unknown> | null = null;
    const relay = createServer((request, response) => {
      if (request.url !== "/api/pairing/complete") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ generation: 1 }));
      });
    });
    await new Promise<void>((resolveListen) => relay.listen(0, "127.0.0.1", resolveListen));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("test relay did not listen");
    const origin = `http://127.0.0.1:${address.port}`;
    const data = mkdtempSync(join(tmpdir(), "norns-agent-cli-"));
    try {
      const uri = localAgentPairingUri({ origin, code: "a1b2c3d4" });
      await execFileAsync(process.execPath, [runnerCliPath, "pair-url", uri, "--data", data], {
        env: { ...process.env, NORNS_AGENT_ALLOWED_ORIGIN: origin },
      });
      expect(received).toMatchObject({ code: "a1b2c3d4", runner_id: "runner-1" });
      expect(readLocalAgentConfig(data)).toEqual({
        version: 1,
        server: origin,
        runner_id: "runner-1",
      });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        relay.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });

  it("advertises only explicitly configured HTTPS installer downloads", () => {
    expect(
      localAgentDownloadsFromEnvironment({
        NORNS_WINDOWS_AGENT_DOWNLOAD_URL: "https://downloads.example/Norns-Local-Agent-Setup.exe",
      }),
    ).toEqual({
      windows: "https://downloads.example/Norns-Local-Agent-Setup.exe",
      macos: null,
    });
    expect(() =>
      localAgentDownloadsFromEnvironment({
        NORNS_WINDOWS_AGENT_DOWNLOAD_URL: "http://downloads.example/agent.exe",
      }),
    ).toThrow(/HTTPS/);
  });
});
