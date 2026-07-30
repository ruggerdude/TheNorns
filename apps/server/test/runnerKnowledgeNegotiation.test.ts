import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
  PROTOCOL_VERSION,
  canonicalLegacyRunnerWssAuthenticationTranscript,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Phase4CompletionService } from "../src/coordinator/phase4Completion.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "../src/coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "../src/coordinator/phase4EventProcessor.js";
import { Phase4RecoveryMonitor } from "../src/coordinator/phase4RecoveryMonitor.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, type ServerOptions, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen, testAdminToken, waitFor } from "./helpers.js";

describe.sequential("runner knowledge capability negotiation", () => {
  let server: NornsServer;
  let stores: RelayStores;
  let url: string;
  let token: string;
  let pg: PGlite | null = null;
  const sockets = new Set<WebSocket>();
  const phase3Routes = {
    sourceBindings: {},
    ingestion: {},
    phases: {},
    strategies: {},
    bridge: {},
    resume: {},
  } as unknown as NonNullable<ServerOptions["phase3"]>;

  beforeEach(async () => {
    stores = new RelayStores();
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores,
      users,
      projects: new ProjectStore(),
      phase3: phase3Routes,
      legacyGlobalRunnerCompatibility: { enabled: true },
    });
    url = await listen(server);
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await server.app.close();
    await pg?.close();
    pg = null;
  });

  async function enableDurablePhase4(): Promise<void> {
    await server.app.close();
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    const transactions = new PGliteTransactionRunner(pg);
    server = await buildServer({
      stores,
      users: new UserStore(),
      projects: new ProjectStore(),
      phase3: phase3Routes,
      legacyGlobalRunnerCompatibility: { enabled: true },
      phase4: {
        coordinator: new Phase4Coordinator(transactions),
        completion: new Phase4CompletionService(transactions),
        dispatch: new Phase4DispatchRepository(transactions),
        events: new Phase4EventProcessor(transactions),
        recovery: new Phase4RecoveryMonitor(transactions),
      },
    });
    url = await listen(server);
  }

  function pair(runnerId: string): { generation: number; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const runner = stores.registerRunner(
      runnerId,
      publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    return { generation: runner.generation, privateKey };
  }

  async function reconcile(
    runnerId: string,
    privateKey: KeyObject,
    generation: number,
    capabilities?: string[],
  ): Promise<string[]> {
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/runner`);
    sockets.add(socket);
    let result: string[] | null = null;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as {
        type: string;
        nonce?: string;
        body?: { capabilities?: string[] };
      };
      if (frame.type === "challenge" && frame.nonce) {
        const transcript = canonicalLegacyRunnerWssAuthenticationTranscript({
          purpose: LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
          runner_id: runnerId,
          generation,
          protocol_version: PROTOCOL_VERSION,
          challenge: frame.nonce,
        });
        socket.send(
          JSON.stringify({
            type: "auth",
            runner_id: runnerId,
            generation,
            protocol_version: PROTOCOL_VERSION,
            transcript_signature: sign(null, Buffer.from(transcript), privateKey).toString(
              "base64",
            ),
          }),
        );
      } else if (frame.type === "auth_ok") {
        socket.send(
          JSON.stringify({
            type: "reconcile_request",
            body: {
              protocol: 1,
              runner_id: runnerId,
              generation,
              ...(capabilities ? { capabilities } : {}),
              last_event_seq_sent: 0,
              recently_executed_command_ids: [],
            },
          }),
        );
      } else if (frame.type === "reconcile_response") {
        result = frame.body?.capabilities ?? [];
      }
    });
    await waitFor(() => result !== null, `knowledge negotiation for ${runnerId}`);
    return result ?? [];
  }

  it("does not advertise the side channel when the durable processor is unavailable", async () => {
    const modern = pair("runner-knowledge");
    await expect(
      reconcile("runner-knowledge", modern.privateKey, modern.generation, [
        "workspace_picker",
        "knowledge_transport",
      ]),
    ).resolves.toEqual([]);
  });

  it("reports a legacy folder picker as outdated instead of sending unsupported inventory requests", async () => {
    const legacy = pair("runner-legacy-picker");
    await reconcile("runner-legacy-picker", legacy.privateKey, legacy.generation, [
      "workspace_picker",
    ]);

    const response = await fetch(`${url}/api/runners/helper/repositories`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "degraded",
      runner_id: "runner-legacy-picker",
      repositories: [],
    });
  });

  it("advertises the side channel only when both peers have durable support", async () => {
    await enableDurablePhase4();
    const modern = pair("runner-knowledge");
    await expect(
      reconcile("runner-knowledge", modern.privateKey, modern.generation, [
        "workspace_picker",
        "knowledge_transport",
      ]),
    ).resolves.toEqual(["knowledge_transport"]);

    const legacy = pair("runner-legacy");
    await expect(reconcile("runner-legacy", legacy.privateKey, legacy.generation)).resolves.toEqual(
      [],
    );
  });
});
