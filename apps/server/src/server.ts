// The relay/API server (ADR-002: the backend IS the relay). Exposes:
//   POST /api/pairing/start | /api/pairing/complete
//   POST /api/commands, GET /api/commands/:id
//   GET  /api/runners, /api/audit, /api/events/:runnerId
//   POST /api/kill-switch
//   WS   /ws/runner  (challenge -> auth -> reconcile -> commands/events)
//   WS   /ws/session (live observation for the browser)
//   GET  /          (minimal control page, Phase 1A)
// Connection state is never trusted solely in process memory: every decision
// reads/writes RelayStores, which snapshots to durable storage.
import websocket from "@fastify/websocket";
import {
  CommandPayload,
  type CommandStateT,
  type EventEnvelopeT,
  PROTOCOL_VERSION,
  ReconcileRequest,
  type ServerFrameT,
  parseRunnerFrame,
} from "@norns/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, verifyRunnerSignature } from "./auth.js";
import { controlPageHtml } from "./controlPage.js";
import { newId, nonce, pairingCode } from "./ids.js";
import type { RelayStores } from "./stores.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;

interface WsLike {
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
}

function asSocket(conn: unknown): WsLike {
  const candidate = conn as { socket?: WsLike } & WsLike;
  return candidate.socket ?? candidate;
}

export interface ServerOptions {
  stores: RelayStores;
  sessionToken: string;
  clock?: () => Date;
}

export interface NornsServer {
  app: FastifyInstance;
  stores: RelayStores;
  /** runner_ids with a live authenticated socket */
  connectedRunners(): string[];
}

export async function buildServer(options: ServerOptions): Promise<NornsServer> {
  const { stores, sessionToken } = options;
  const now = options.clock ?? (() => new Date());
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const runnerSockets = new Map<string, WsLike>();
  const sessionSockets = new Set<WsLike>();

  const sendFrame = (socket: WsLike, frame: ServerFrameT): void => {
    socket.send(JSON.stringify(frame));
  };

  const broadcast = (message: Record<string, unknown>): void => {
    const raw = JSON.stringify(message);
    for (const socket of sessionSockets) {
      try {
        socket.send(raw);
      } catch {
        // session sockets are pure views; drop failures
      }
    }
  };

  const requireSession = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const token = bearerToken(req.headers.authorization);
    if (token !== sessionToken) {
      stores.audit("anonymous", "auth.rejected", `${req.method} ${req.url}`, now());
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  const deliverPending = (runnerId: string, executed: ReadonlySet<string>): void => {
    const socket = runnerSockets.get(runnerId);
    if (!socket) return;
    for (const envelope of stores.pendingCommandsFor(runnerId, executed, now())) {
      sendFrame(socket, { type: "command", command: envelope });
      stores.setCommandState(envelope.command_id, "delivered", now());
      stores.audit("server", "command.delivered", envelope.command_id, now());
    }
  };

  // ---- pairing ---------------------------------------------------------------

  app.post("/api/pairing/start", (req, reply) => {
    if (!requireSession(req, reply)) return;
    const code = pairingCode();
    const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS);
    stores.createPairing(code, expiresAt);
    stores.audit("operator", "pairing.started", code, now());
    reply.send({ code, expires_at: expiresAt.toISOString() });
  });

  const PairingComplete = z.object({
    code: z.string().min(1),
    runner_id: z.string().min(1),
    public_key_pem: z.string().min(1),
  });

  app.post("/api/pairing/complete", (req, reply) => {
    const parsed = PairingComplete.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { code, runner_id, public_key_pem } = parsed.data;
    if (!stores.consumePairing(code, now())) {
      stores.audit(`runner:${runner_id}`, "pairing.rejected", "invalid or expired code", now());
      return reply.code(403).send({ error: "invalid_pairing_code" });
    }
    const record = stores.registerRunner(runner_id, public_key_pem);
    stores.audit(
      `runner:${runner_id}`,
      "pairing.completed",
      `generation=${record.generation}`,
      now(),
    );
    return reply.send({ runner_id, generation: record.generation });
  });

  // ---- command issuance --------------------------------------------------------

  const IssueCommand = z.object({
    runner_id: z.string().min(1),
    payload: CommandPayload,
    project_id: z.string().min(1).default("proj-fixture"),
    correlation_id: z.string().min(1).optional(),
    expires_in_ms: z.number().int().optional(),
  });

  app.post("/api/commands", (req, reply) => {
    if (!requireSession(req, reply)) return;
    const parsed = IssueCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const body = parsed.data;
    const runner = stores.runner(body.runner_id);
    if (!runner) return reply.code(404).send({ error: "unknown_runner" });
    if (stores.killSwitchEngaged()) {
      stores.audit("operator", "command.refused", "kill switch engaged", now());
      return reply.code(423).send({ error: "kill_switch_engaged" });
    }
    const issuedAt = now();
    const commandId = newId("cmd");
    const envelope = {
      protocol: PROTOCOL_VERSION as 1,
      command_id: commandId,
      idempotency_key: commandId,
      correlation_id: body.correlation_id ?? newId("corr"),
      causation_id: null,
      project_id: body.project_id,
      runner_id: body.runner_id,
      generation: runner.generation,
      issued_by_session: "operator",
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(
        issuedAt.getTime() + (body.expires_in_ms ?? DEFAULT_COMMAND_TTL_MS),
      ).toISOString(),
      payload: body.payload,
    };
    stores.enqueueCommand(envelope, issuedAt);
    stores.audit("operator", "command.issued", `${commandId} ${body.payload.kind}`, issuedAt);
    deliverPending(body.runner_id, new Set());
    return reply.send({ command_id: commandId });
  });

  app.get("/api/commands/:id", (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const record = stores.command(id);
    if (!record) return reply.code(404).send({ error: "not_found" });
    return reply.send({
      command_id: id,
      state: record.state,
      superseded_terminal: record.superseded_terminal,
      payload: record.envelope.payload,
    });
  });

  // ---- observation -------------------------------------------------------------

  app.get("/api/runners", (req, reply) => {
    if (!requireSession(req, reply)) return;
    reply.send(
      stores.runners().map((r) => ({
        runner_id: r.runner_id,
        generation: r.generation,
        connected: runnerSockets.has(r.runner_id),
        last_seen_at: r.last_seen_at,
      })),
    );
  });

  app.get("/api/audit", (req, reply) => {
    if (!requireSession(req, reply)) return;
    reply.send(stores.auditEntries());
  });

  app.get("/api/events/:runnerId", (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { runnerId } = req.params as { runnerId: string };
    reply.send(stores.eventsFor(runnerId));
  });

  app.post("/api/kill-switch", (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = z.object({ engaged: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    stores.setKillSwitch(body.data.engaged);
    stores.audit("operator", "kill_switch", body.data.engaged ? "engaged" : "disengaged", now());
    return reply.send({ engaged: body.data.engaged });
  });

  app.get("/", (_req, reply) => {
    reply.type("text/html").send(controlPageHtml());
  });

  // ---- runner websocket ----------------------------------------------------------

  app.get("/ws/runner", { websocket: true }, (conn) => {
    const socket = asSocket(conn);
    const challenge = nonce();
    let authedRunnerId: string | null = null;

    sendFrame(socket, { type: "challenge", nonce: challenge });

    socket.on("message", (data) => {
      const frame = parseRunnerFrame(String(data));
      if (!frame) return;

      if (frame.type === "auth") {
        const runner = stores.runner(frame.runner_id);
        if (
          !runner ||
          !verifyRunnerSignature(runner.public_key_pem, challenge, frame.nonce_signature)
        ) {
          stores.audit(
            `runner:${frame.runner_id}`,
            "runner.auth_failed",
            "bad signature or unknown",
            now(),
          );
          sendFrame(socket, { type: "auth_error", reason: "authentication failed" });
          socket.close();
          return;
        }
        authedRunnerId = frame.runner_id;
        runnerSockets.set(frame.runner_id, socket);
        stores.markSeen(frame.runner_id, now());
        stores.audit(`runner:${frame.runner_id}`, "runner.connected", "", now());
        broadcast({ type: "runner_status", runner_id: frame.runner_id, connected: true });
        sendFrame(socket, { type: "auth_ok" });
        return;
      }

      if (!authedRunnerId) return; // everything else requires auth

      const runner = stores.runner(authedRunnerId);
      if (!runner) return;

      if (frame.type === "reconcile_request") {
        const body = ReconcileRequest.parse(frame.body);
        if (body.generation !== runner.generation) {
          stores.audit(
            `runner:${authedRunnerId}`,
            "runner.fenced",
            `stale generation ${body.generation} (current ${runner.generation})`,
            now(),
          );
          sendFrame(socket, { type: "fenced", current_generation: runner.generation });
          socket.close();
          return;
        }
        sendFrame(socket, {
          type: "reconcile_response",
          body: {
            protocol: PROTOCOL_VERSION as 1,
            ack_event_seq: stores.eventWatermark(authedRunnerId),
            generation: runner.generation,
            resend_commands: stores.pendingCommandsFor(
              authedRunnerId,
              new Set(body.recently_executed_command_ids),
              now(),
            ),
          },
        });
        // mark the resends delivered
        for (const cmd of stores.pendingCommandsFor(
          authedRunnerId,
          new Set(body.recently_executed_command_ids),
          now(),
        )) {
          stores.setCommandState(cmd.command_id, "delivered", now());
        }
        stores.audit(
          `runner:${authedRunnerId}`,
          "runner.reconciled",
          `ack_seq=${stores.eventWatermark(authedRunnerId)}`,
          now(),
        );
        return;
      }

      if (frame.type === "event") {
        const event: EventEnvelopeT = frame.event;
        if (event.generation !== runner.generation) {
          sendFrame(socket, { type: "fenced", current_generation: runner.generation });
          socket.close();
          return;
        }
        const outcome = stores.ingestEvent(event);
        if (outcome === "accepted") {
          applyEventSideEffects(event);
        }
        sendFrame(socket, {
          type: "event_ack",
          ack_event_seq: stores.eventWatermark(authedRunnerId),
        });
      }
    });

    socket.on("close", () => {
      if (authedRunnerId && runnerSockets.get(authedRunnerId) === socket) {
        runnerSockets.delete(authedRunnerId);
        stores.audit(`runner:${authedRunnerId}`, "runner.disconnected", "", now());
        broadcast({ type: "runner_status", runner_id: authedRunnerId, connected: false });
      }
    });
  });

  const applyEventSideEffects = (event: EventEnvelopeT): void => {
    stores.markSeen(event.runner_id, now());
    const payload = event.payload;
    if (payload.kind === "command_ack") {
      stores.setCommandState(payload.command_id, payload.state as CommandStateT, now());
      stores.audit(
        `runner:${event.runner_id}`,
        "command.ack",
        `${payload.command_id} -> ${payload.state}`,
        now(),
      );
      broadcast({ type: "command_state", command_id: payload.command_id, state: payload.state });
    } else if (payload.kind === "run_log") {
      broadcast({
        type: "log",
        runner_id: event.runner_id,
        run_id: payload.run_id,
        chunk: payload.chunk,
      });
    } else if (payload.kind === "run_status") {
      stores.audit(
        `runner:${event.runner_id}`,
        "run.status",
        `${payload.run_id} ${payload.status}`,
        now(),
      );
      broadcast({
        type: "run_status",
        runner_id: event.runner_id,
        run_id: payload.run_id,
        status: payload.status,
      });
    }
    // heartbeat: markSeen above is the whole effect
  };

  // ---- session websocket -----------------------------------------------------------

  app.get("/ws/session", { websocket: true }, (conn, req) => {
    const socket = asSocket(conn);
    const token = (req.query as { token?: string }).token;
    if (token !== sessionToken) {
      socket.close();
      return;
    }
    sessionSockets.add(socket);
    socket.send(
      JSON.stringify({
        type: "snapshot",
        runners: stores.runners().map((r) => ({
          runner_id: r.runner_id,
          connected: runnerSockets.has(r.runner_id),
        })),
      }),
    );
    socket.on("close", () => {
      sessionSockets.delete(socket);
    });
    socket.on("message", () => {
      // session sockets are read-only views; commands go through POST /api/commands
    });
  });

  return {
    app,
    stores,
    connectedRunners: () => [...runnerSockets.keys()],
  };
}
