import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerDaemon, RunnerStateFile } from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { LegacyRunnerAuthorization } from "../src/runners/legacyAuthorization.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, waitFor } from "./helpers.js";

interface BrowserSession {
  socket: WebSocket;
  frames: Record<string, unknown>[];
}

const sockets = new Set<WebSocket>();
let server: NornsServer | null = null;
let daemon: RunnerDaemon | null = null;

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  daemon?.stop();
  daemon = null;
  await server?.app.close();
  server = null;
});

function browserSessionUrl(httpUrl: string): string {
  return `${httpUrl.replace(/^http/, "ws")}/ws/session`;
}

async function connectBrowser(httpUrl: string, token: string): Promise<BrowserSession> {
  const socket = new WebSocket(browserSessionUrl(httpUrl));
  sockets.add(socket);
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => frames.some((frame) => frame.type === "snapshot"), "browser snapshot");
  return { socket, frames };
}

describe.sequential("legacy runner access isolation", () => {
  it("scopes inventory, live frames, commands, and stop surfaces without an admin bypass", async () => {
    const users = new UserStore();
    const owner = users.createActive({
      email: "owner@example.com",
      password: "owner-password",
      role: "member",
    });
    const member = users.createActive({
      email: "member@example.com",
      password: "member-password",
      role: "member",
    });
    const outsider = users.createActive({
      email: "outsider@example.com",
      password: "outsider-password",
      role: "member",
    });
    const administrator = users.createActive({
      email: "administrator@example.com",
      password: "administrator-password",
      role: "admin",
    });
    const tokens = {
      owner: users.login("owner@example.com", "owner-password").token,
      member: users.login("member@example.com", "member-password").token,
      outsider: users.login("outsider@example.com", "outsider-password").token,
      administrator: users.login("administrator@example.com", "administrator-password").token,
    };
    const projectUsers = new Set([owner.id, member.id]);
    const runnerId = "runner-project-1";
    const projectId = "project-1";
    const authorization: LegacyRunnerAuthorization = {
      async canAccessProjectRunner(input) {
        return (
          projectUsers.has(input.user_id) &&
          input.project_id === projectId &&
          input.runner_id === runnerId
        );
      },
      async canAccessRun(input) {
        return projectUsers.has(input.user_id) && input.runner_id === runnerId;
      },
      async canAccessCommand(input) {
        return projectUsers.has(input.user_id) && input.runner_id === runnerId;
      },
      async canRevokeRunner(input) {
        return projectUsers.has(input.user_id) && input.runner_id === runnerId;
      },
      async runnerIdsForUser(userId) {
        return projectUsers.has(userId) ? new Set([runnerId]) : new Set();
      },
    };

    const stores = new RelayStores();
    const dataDir = mkdtempSync(join(tmpdir(), "norns-legacy-access-"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const runner = stores.registerRunner(
      runnerId,
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    new RunnerStateFile(dataDir, {
      runner_id: runnerId,
      private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      generation: runner.generation,
    });

    server = await buildServer({
      stores,
      users,
      legacyRunnerAuthorization: authorization,
    });
    const url = await listen(server);
    const ownerSession = await connectBrowser(url, tokens.owner);
    const memberSession = await connectBrowser(url, tokens.member);
    const outsiderSession = await connectBrowser(url, tokens.outsider);
    const administratorSession = await connectBrowser(url, tokens.administrator);

    expect(ownerSession.frames[0]).toEqual({
      type: "snapshot",
      runners: [{ runner_id: runnerId, connected: false }],
    });
    expect(memberSession.frames[0]).toEqual(ownerSession.frames[0]);
    expect(outsiderSession.frames[0]).toEqual({ type: "snapshot", runners: [] });
    expect(administratorSession.frames[0]).toEqual({ type: "snapshot", runners: [] });

    daemon = new RunnerDaemon({
      serverUrl: url,
      runnerId,
      dataDir,
      heartbeatMs: 500,
      reconnectDelayMs: 100,
    });
    daemon.loadState();
    daemon.connect();
    await waitFor(
      () =>
        ownerSession.frames.some(
          (frame) =>
            frame.type === "runner_status" &&
            frame.runner_id === runnerId &&
            frame.connected === true,
        ),
      "owner runner status",
    );
    await waitFor(
      () =>
        memberSession.frames.some(
          (frame) =>
            frame.type === "runner_status" &&
            frame.runner_id === runnerId &&
            frame.connected === true,
        ),
      "member runner status",
    );
    expect(outsiderSession.frames).toEqual([{ type: "snapshot", runners: [] }]);
    expect(administratorSession.frames).toEqual([{ type: "snapshot", runners: [] }]);

    const api = (token: string, path: string, init?: RequestInit) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init?.headers ?? {}),
        },
      });
    for (const token of [tokens.owner, tokens.member]) {
      const response = await api(token, "/api/runners");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({ runner_id: runnerId, connected: true }),
      ]);
    }
    for (const token of [tokens.outsider, tokens.administrator]) {
      const response = await api(token, "/api/runners");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }

    const issued = await api(tokens.owner, "/api/commands", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId,
        runner_id: runnerId,
        payload: { kind: "launch_fixture", fixture: "count:3:10" },
      }),
    });
    expect(issued.status).toBe(200);
    const { command_id: commandId } = (await issued.json()) as { command_id: string };
    await waitFor(
      () =>
        ownerSession.frames.some((frame) => frame.type === "log" && frame.runner_id === runnerId),
      "owner run log",
    );
    await waitFor(
      () =>
        memberSession.frames.some((frame) => frame.type === "log" && frame.runner_id === runnerId),
      "member run log",
    );
    expect(outsiderSession.frames.some((frame) => frame.type === "log")).toBe(false);
    expect(administratorSession.frames.some((frame) => frame.type === "log")).toBe(false);

    expect((await api(tokens.member, `/api/commands/${commandId}`)).status).toBe(200);
    expect((await api(tokens.outsider, `/api/commands/${commandId}`)).status).toBe(403);
    expect((await api(tokens.administrator, `/api/commands/${commandId}`)).status).toBe(403);

    for (const token of [tokens.outsider, tokens.administrator]) {
      const dispatch = await api(token, "/api/commands", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          runner_id: runnerId,
          payload: { kind: "launch_fixture", fixture: "count:1:1" },
        }),
      });
      expect(dispatch.status).toBe(403);
      const stop = await api(token, "/api/commands", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          runner_id: runnerId,
          payload: { kind: "cancel", run_id: `run_${commandId}` },
        }),
      });
      expect(stop.status).toBe(403);
    }

    for (const action of [
      "command.dispatched",
      "pairing.approved",
      "workspace.catalogued",
      "legacy_runner.forbidden",
      "kill_switch",
      "device.revoked",
      "runner.connected",
    ]) {
      stores.audit("operator", action, "computer activity", new Date());
    }
    stores.audit("operator", "project.updated", "project activity", new Date());
    stores.audit("operator", "planning.approved", "planning activity", new Date());
    const audit = await api(tokens.administrator, "/api/audit");
    expect(audit.status).toBe(200);
    const entries = (await audit.json()) as Array<{ action: string }>;
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["project.updated", "planning.approved"]),
    );
    for (const hidden of [
      "command.dispatched",
      "pairing.approved",
      "workspace.catalogued",
      "legacy_runner.forbidden",
      "kill_switch",
      "device.revoked",
      "runner.connected",
    ]) {
      expect(entries.some((entry) => entry.action === hidden)).toBe(false);
    }
    expect((await api(tokens.administrator, "/api/runners/helper/status")).status).toBe(403);
    expect(
      (
        await api(tokens.administrator, "/api/kill-switch", {
          method: "POST",
          body: JSON.stringify({ engaged: true }),
        })
      ).status,
    ).toBe(403);
    expect(stores.killSwitchEngaged()).toBe(false);
  });
});
