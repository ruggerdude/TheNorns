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
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { AdapterError, AnthropicAdapter, OpenAiAdapter } from "@norns/adapters";
import {
  CommandPayload,
  type CommandStateT,
  type EventEnvelopeT,
  PROTOCOL_VERSION,
  PlanContract,
  ReconcileRequest,
  type ServerFrameT,
  type UsageEventT,
  parseRunnerFrame,
} from "@norns/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, verifyRunnerSignature } from "./auth.js";
import { controlPageHtml } from "./controlPage.js";
import {
  AllocationError,
  AllocationStrategy,
  approveAllocation,
  autoAllocate,
  costPreview,
  overrideAssignment,
} from "./graph/allocation.js";
import { GraphEditError } from "./graph/graph.js";
import type { GraphSession } from "./graph/session.js";
import { newId, nonce, pairingCode } from "./ids.js";
import { PlanningError, planContentHash, runPlanning } from "./planning/session.js";
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
  /** Phase 4: graph editing + allocation for one project */
  graphSession?: GraphSession;
  /** Phase 6: dashboard provider (engine + ledger composition) */
  dashboard?: () => unknown;
  /** Deploy: absolute path to the built web app (apps/web/dist) to serve. */
  webDist?: string;
  /** Live planning (Tier 3): append real provider usage to the cost ledger. */
  recordUsage?: (events: UsageEventT[]) => void;
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

  // ---- live planning (Tier 3: real cross-provider planning loop) -------------
  // Requires ANTHROPIC_API_KEY + OPENAI_API_KEY + NORNS_OPENAI_MODEL in the
  // environment. Never invents an OpenAI model id — it must come from config.
  const PlanRequest = z.object({
    objective: z.string().min(1),
    maxRounds: z.number().int().min(1).max(5).optional(),
  });
  app.post("/api/plan", async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = PlanRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const openaiModel = process.env.NORNS_OPENAI_MODEL;
    const missing = [
      !anthropicKey && "ANTHROPIC_API_KEY",
      !openaiKey && "OPENAI_API_KEY",
      !openaiModel && "NORNS_OPENAI_MODEL",
    ].filter((v): v is string => typeof v === "string");
    if (missing.length > 0) {
      return reply.code(501).send({
        error: "live_planning_unavailable",
        message: `live planning requires ${missing.join(", ")} to be set as environment variables`,
      });
    }

    const pm = new AnthropicAdapter({
      apiKey: anthropicKey as string,
      model: process.env.NORNS_PM_MODEL ?? "claude-sonnet-5",
    });
    const reviewer = new OpenAiAdapter({
      apiKey: openaiKey as string,
      model: openaiModel as string,
    });

    stores.audit("operator", "planning.started", body.data.objective, now());
    try {
      const result = await runPlanning({
        pm,
        reviewer,
        objective: body.data.objective,
        projectId: "proj-live",
        ...(body.data.maxRounds !== undefined ? { maxRounds: body.data.maxRounds } : {}),
      });
      options.recordUsage?.(result.usage);
      const totalCost = result.usage.reduce((sum, u) => sum + u.estimated_cost_usd, 0);
      stores.audit(
        "operator",
        "planning.completed",
        `${result.status} rounds=${result.rounds} cost_usd=${totalCost.toFixed(4)}`,
        now(),
      );
      reply.send({
        status: result.status,
        rounds: result.rounds,
        plan: result.finalPlan,
        content_hash: planContentHash(result.finalPlan),
        outstanding: result.outstanding,
        policy: result.policy,
        usage: result.usage,
        total_cost_usd: totalCost,
      });
    } catch (error) {
      stores.audit(
        "operator",
        "planning.failed",
        error instanceof Error ? error.message : String(error),
        now(),
      );
      if (error instanceof PlanningError) {
        return reply.code(422).send({ error: error.code, message: error.message });
      }
      if (error instanceof AdapterError) {
        return reply.code(502).send({ error: error.kind, message: error.message });
      }
      throw error;
    }
  });

  app.get("/health", (_req, reply) => {
    reply.send({ ok: true, contracts: "1.2.0" });
  });

  // Legacy Phase 1A control page; the React app (when built) owns "/".
  app.get("/control", (_req, reply) => {
    reply.type("text/html").send(controlPageHtml());
  });

  if (options.webDist) {
    // Single-service deploy: serve the built React app + SPA fallback.
    // Static assets are public; the page authenticates to /api with a token.
    await app.register(fastifyStatic, { root: options.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.get("/", (_req, reply) => {
      reply.type("text/html").send(controlPageHtml());
    });
  }

  if (options.dashboard) {
    const provider = options.dashboard;
    app.get("/api/dashboard", (req, reply) => {
      if (!requireSession(req, reply)) return;
      reply.send(provider());
    });
  }

  // ---- graph editing + allocation (Phase 4) -----------------------------------

  const graph = options.graphSession;
  if (graph) {
    const sendGraph = (reply: FastifyReply): void => {
      reply.send({ ...graph.graph.snapshot(), cost: costPreview(graph.graph) });
    };
    const graphError = (reply: FastifyReply, error: unknown): void => {
      if (error instanceof GraphEditError) {
        reply.code(409).send({
          error: error.code,
          message: error.message,
          ...(error.cyclePath !== undefined ? { cycle_path: error.cyclePath } : {}),
        });
        return;
      }
      if (error instanceof AllocationError) {
        reply.code(409).send({ error: "allocation", message: error.message });
        return;
      }
      throw error;
    };

    app.get("/api/graph", (req, reply) => {
      if (!requireSession(req, reply)) return;
      sendGraph(reply);
    });

    const EdgeBody = z.object({ from: z.string().min(1), to: z.string().min(1) });
    app.post("/api/graph/edges", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const body = EdgeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        graph.graph.addEdge(body.data.from, body.data.to);
        stores.audit("operator", "graph.edge_added", `${body.data.from}->${body.data.to}`, now());
        sendGraph(reply);
      } catch (error) {
        graphError(reply, error);
      }
    });

    app.delete("/api/graph/edges", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const body = EdgeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        graph.graph.removeEdge(body.data.from, body.data.to);
        stores.audit("operator", "graph.edge_removed", `${body.data.from}->${body.data.to}`, now());
        sendGraph(reply);
      } catch (error) {
        graphError(reply, error);
      }
    });

    const NodeBody = z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      complexity: z.enum(["S", "M", "L", "XL"]).optional(),
      risk: z.enum(["low", "medium", "high", "critical"]).optional(),
      dependencies: z.array(z.string().min(1)).optional(),
    });
    app.post("/api/graph/nodes", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const body = NodeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        graph.graph.addNode(body.data);
        stores.audit("operator", "graph.node_added", body.data.id, now());
        sendGraph(reply);
      } catch (error) {
        graphError(reply, error);
      }
    });

    app.delete("/api/graph/nodes/:id", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const { mode } = req.query as { mode?: "reparent" | "cascade" };
      try {
        const removed = graph.graph.removeNode(id, mode);
        stores.audit("operator", "graph.node_removed", removed.join(","), now());
        sendGraph(reply);
      } catch (error) {
        graphError(reply, error);
      }
    });

    app.post("/api/graph/allocate", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const body = z.object({ strategy: AllocationStrategy }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      autoAllocate(graph.graph, body.data.strategy);
      stores.audit("operator", "graph.auto_allocated", body.data.strategy, now());
      sendGraph(reply);
    });

    const OverrideBody = z.object({
      provider: z.enum(["anthropic", "openai"]).optional(),
      model: z.string().min(1).optional(),
      worker_count: z.number().int().min(1).max(3).optional(),
      reviewer_model: z.string().min(1).optional(),
      budget_usd: z.number().positive().optional(),
      rationale: z.string().min(1).optional(),
    });
    app.post("/api/graph/nodes/:id/assignment", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = OverrideBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        overrideAssignment(graph.graph, id, body.data);
        stores.audit("operator", "graph.assignment_overridden", id, now());
        sendGraph(reply);
      } catch (error) {
        graphError(reply, error);
      }
    });

    app.post("/api/graph/approve-allocation", (req, reply) => {
      if (!requireSession(req, reply)) return;
      try {
        const approval = approveAllocation(graph.graph, "operator");
        stores.audit("operator", "allocation.approved", approval.content_hash, now());
        reply.send(approval);
      } catch (error) {
        graphError(reply, error);
      }
    });

    // Commit a (human-reviewed) plan — typically the output of POST /api/plan
    // — into the live graph editor, replacing the current nodes/edges.
    const LoadPlanBody = z.object({ plan: PlanContract });
    app.post("/api/plan/load", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const body = LoadPlanBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        graph.loadPlan(body.data.plan);
        stores.audit("operator", "graph.plan_loaded", body.data.plan.objective, now());
        sendGraph(reply);
      } catch (error) {
        reply.code(422).send({
          error: "plan_invalid",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

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
