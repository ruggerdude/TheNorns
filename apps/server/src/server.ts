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
import {
  AdapterError,
  AnthropicAdapter,
  type LlmAdapter,
  OpenAiAdapter,
  type ProviderName,
} from "@norns/adapters";
import {
  AnthropicPmModel,
  CommandPayload,
  type CommandStateT,
  DEFAULT_PM_MODEL,
  type EventEnvelopeT,
  OpenAiPmModel,
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
import { EmailNotConfiguredError, sendEmail } from "./email/resend.js";
import {
  AllocationError,
  AllocationStrategy,
  approveAllocation,
  autoAllocate,
  costPreview,
  overrideAssignment,
} from "./graph/allocation.js";
import { GraphEditError } from "./graph/graph.js";
import { newId, nonce, pairingCode } from "./ids.js";
import { PlanningError, planContentHash, runPlanning } from "./planning/session.js";
import {
  ProjectNotFoundError,
  ProjectNotPlannedError,
  type ProjectStore,
  reviewerFor,
} from "./projects/store.js";
import type { RelayStores } from "./stores.js";
import type { UserRecord, UserStore } from "./users/store.js";

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
  /** Real user accounts — session auth resolves against this, not a shared secret. */
  users: UserStore;
  /**
   * Deploy-level secret (Railway env var). Its ONLY job is gating the
   * one-time POST /api/auth/bootstrap that creates the first admin account
   * when zero users exist yet. It is never accepted as a session credential
   * for any other route — real per-user sessions replace that entirely.
   * Omit to disable bootstrap (e.g. once you're certain it's no longer needed).
   */
  deployToken?: string;
  clock?: () => Date;
  /** Multi-project management: create/list projects, plan + edit + allocate each one's graph. */
  projects?: ProjectStore;
  /**
   * DEMO-ONLY dashboard provider (engine + ledger composition). When set, it is
   * exposed at GET /api/demo/dashboard and returns the same illustrative demo
   * data for every caller. It is intentionally unscoped: no project_id reaches
   * it. This is not, and must not become, a per-project dashboard.
   */
  dashboard?: () => unknown;
  /** Deploy: absolute path to the built web app (apps/web/dist) to serve. */
  webDist?: string;
  /** Live planning (Tier 3): append real provider usage to the cost ledger. */
  recordUsage?: (events: UsageEventT[]) => void;
  /** Test/deployment seam for constructing an adapter for an exact provider model. */
  createPlanningAdapter?: (provider: ProviderName, model: string, apiKey: string) => LlmAdapter;
}

export interface NornsServer {
  app: FastifyInstance;
  stores: RelayStores;
  /** runner_ids with a live authenticated socket */
  connectedRunners(): string[];
}

export async function buildServer(options: ServerOptions): Promise<NornsServer> {
  const { stores, users, deployToken } = options;
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

  /** Resolve the caller's bearer token to a real user, or undefined. Real
   *  per-user sessions are the only session credential — the deploy token is
   *  never accepted here, only by the bootstrap route below. */
  const resolveUser = (req: FastifyRequest): UserRecord | undefined => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return undefined;
    return users.userForToken(token);
  };

  const requireSession = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!resolveUser(req)) {
      stores.audit("anonymous", "auth.rejected", `${req.method} ${req.url}`, now());
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  /** Like requireSession, but also enforces the admin role. Returns the
   *  resolved admin user (so the caller can attribute audit entries), or
   *  null if it already sent a 401/403. */
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): UserRecord | null => {
    const user = resolveUser(req);
    if (!user) {
      stores.audit("anonymous", "auth.rejected", `${req.method} ${req.url}`, now());
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (user.role !== "admin") {
      stores.audit(user.email, "auth.forbidden", `${req.method} ${req.url}`, now());
      reply.code(403).send({ error: "forbidden", message: "admin role required" });
      return null;
    }
    return user;
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

  // ---- auth: real user accounts -------------------------------------------------
  // Replaces the single shared deploy token as the day-to-day login mechanism.
  // The deploy token's only remaining job is gating the one-time bootstrap
  // below; every other route resolves a real per-user session.

  app.get("/api/auth/status", (_req, reply) => {
    reply.send({ needs_bootstrap: users.count === 0 });
  });

  const BootstrapBody = z.object({
    deploy_token: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1).optional(),
  });
  app.post("/api/auth/bootstrap", (req, reply) => {
    // The zero-users check is the real gate — it means this route can never
    // be used to mint a SECOND admin later, even by someone who knows the
    // deploy token. It's a one-time bootstrap, not a standing back door.
    if (users.count > 0) return reply.code(403).send({ error: "already_bootstrapped" });
    if (!deployToken) return reply.code(501).send({ error: "bootstrap_disabled" });
    const body = BootstrapBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.deploy_token !== deployToken) {
      stores.audit("anonymous", "auth.bootstrap_rejected", "bad deploy token", now());
      return reply.code(403).send({ error: "invalid_deploy_token" });
    }
    const summary = users.createActive({
      email: body.data.email,
      name: body.data.name,
      password: body.data.password,
      role: "admin",
    });
    const { token } = users.login(body.data.email, body.data.password);
    stores.audit(summary.email, "auth.bootstrapped", summary.id, now());
    reply.code(201).send({ token, user: summary });
  });

  const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
  app.post("/api/auth/login", (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const { token, user } = users.login(body.data.email, body.data.password);
      stores.audit(user.email, "auth.login", user.id, now());
      reply.send({ token, user });
    } catch {
      stores.audit("anonymous", "auth.login_failed", body.data.email, now());
      reply.code(401).send({ error: "invalid_credentials" });
    }
  });

  app.post("/api/auth/logout", (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (token) users.logout(token);
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", (req, reply) => {
    const user = resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    reply.send({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
    });
  });

  const AcceptInviteBody = z.object({
    invite_token: z.string().min(1),
    password: z.string().min(8),
  });
  app.post("/api/auth/accept-invite", (req, reply) => {
    const body = AcceptInviteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const summary = users.acceptInvite(body.data.invite_token, body.data.password);
      const { token } = users.login(summary.email, body.data.password);
      stores.audit(summary.email, "auth.invite_accepted", summary.id, now());
      reply.send({ token, user: summary });
    } catch (error) {
      reply.code(400).send({
        error: "invalid_invite",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ---- admin: user management (admin role required) ---------------------------

  app.get("/api/admin/users", (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    reply.send(users.list());
  });

  const CreateUserBody = z.object({
    email: z.string().email(),
    name: z.string().min(1).optional(),
    password: z.string().min(8),
    role: z.enum(["admin", "member"]).default("member"),
  });
  app.post("/api/admin/users", (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const body = CreateUserBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const summary = users.createActive(body.data);
      stores.audit(admin.email, "admin.user_created", summary.id, now());
      reply.code(201).send(summary);
    } catch (error) {
      reply.code(409).send({
        error: "user_exists",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const InviteUserBody = z.object({
    email: z.string().email(),
    name: z.string().min(1).optional(),
    role: z.enum(["admin", "member"]).default("member"),
  });
  app.post("/api/admin/users/invite", async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const body = InviteUserBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    let created: { summary: ReturnType<UserStore["list"]>[number]; inviteToken: string };
    try {
      created = users.createInvite(body.data);
    } catch (error) {
      return reply.code(409).send({
        error: "user_exists",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const origin = `${req.protocol}://${req.headers.host}`;
    const acceptUrl = `${origin}/?invite=${created.inviteToken}`;
    try {
      await sendEmail({
        to: created.summary.email,
        subject: "You're invited to TheNorns",
        html:
          `<p>${admin.name ?? admin.email} invited you to TheNorns.</p>` +
          `<p><a href="${acceptUrl}">Accept the invite</a> to set your password.</p>`,
      });
    } catch (error) {
      // The user record exists either way — the admin can share the link
      // manually or resend later. Not fatal, just reported clearly.
      stores.audit(admin.email, "admin.invite_email_failed", created.summary.id, now());
      return reply.code(502).send({
        error:
          error instanceof EmailNotConfiguredError ? "email_not_configured" : "email_send_failed",
        message: error instanceof Error ? error.message : String(error),
        user: created.summary,
        invite_url: acceptUrl,
      });
    }
    stores.audit(admin.email, "admin.user_invited", created.summary.id, now());
    reply.code(201).send({ user: created.summary });
  });

  app.delete("/api/admin/users/:id", (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const { id } = req.params as { id: string };
    try {
      users.remove(id);
      stores.audit(admin.email, "admin.user_removed", id, now());
      reply.send({ ok: true });
    } catch {
      reply.code(404).send({ error: "not_found" });
    }
  });

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

  // ---- DEMO dashboard (NOT project-scoped) -----------------------------------
  // This is the illustrative "what a fully-populated PM Dashboard looks like"
  // surface, backed by main.ts's hardcoded `demoSession` walkthrough. It is
  // deliberately mounted under /api/demo/* and takes NO project_id: there is no
  // route, parameter, or code path by which a real project can reach it or
  // influence its output. It always returns the same scripted demo data.
  //
  // Do NOT repurpose this into a per-project dashboard. A durable, project-
  // scoped dashboard (GET /api/projects/:id/dashboard) is a separate, gated
  // future pass — wire that as its own route reading ProjectStore, never here.
  if (options.dashboard) {
    const demoDashboard = options.dashboard;
    app.get("/api/demo/dashboard", (req, reply) => {
      if (!requireSession(req, reply)) return;
      reply.send(demoDashboard());
    });
  }

  // ---- multi-project management: create/list projects; plan, edit, and ------
  // ---- allocate each one's own graph ------------------------------------------

  const projects = options.projects;
  if (projects) {
    const projectError = (reply: FastifyReply, error: unknown): void => {
      if (error instanceof ProjectNotFoundError) {
        reply.code(404).send({ error: "not_found", message: error.message });
        return;
      }
      if (error instanceof ProjectNotPlannedError) {
        reply.code(409).send({ error: "not_planned", message: error.message });
        return;
      }
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

    const sendGraph = (reply: FastifyReply, id: string): void => {
      const session = projects.session(id);
      const graph = session.graph;
      // ADR-1: every graph response carries the server-authoritative approval
      // status, with `current` computed against the live version/fingerprint.
      reply.send({
        ...graph.snapshot(),
        cost: costPreview(graph),
        approval: session.approvalStatus(),
      });
    };

    app.get("/api/projects", (req, reply) => {
      if (!requireSession(req, reply)) return;
      reply.send(projects.list());
    });

    const CreateProjectFields = {
      name: z.string().min(1),
      description: z.string().min(1),
    };
    const CreateProjectBody = z.discriminatedUnion("pm_provider", [
      z.object({
        ...CreateProjectFields,
        pm_provider: z.literal("anthropic"),
        pm_model: AnthropicPmModel.default(DEFAULT_PM_MODEL.anthropic),
      }),
      z.object({
        ...CreateProjectFields,
        pm_provider: z.literal("openai"),
        pm_model: OpenAiPmModel.default(DEFAULT_PM_MODEL.openai),
      }),
    ]);
    app.post("/api/projects", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const body = CreateProjectBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      const project = projects.create({
        name: body.data.name,
        description: body.data.description,
        pmProvider: body.data.pm_provider,
        pmModel: body.data.pm_model,
      });
      stores.audit(
        "operator",
        "project.created",
        `${project.id} ${project.name} pm=${project.pm_provider}:${project.pm_model}`,
        now(),
      );
      reply.code(201).send(project);
    });

    app.get("/api/projects/:id", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      try {
        reply.send(projects.summary(id));
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.get("/api/projects/:id/graph", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      try {
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    const EdgeBody = z.object({ from: z.string().min(1), to: z.string().min(1) });
    app.post("/api/projects/:id/graph/edges", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = EdgeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        projects.session(id).graph.addEdge(body.data.from, body.data.to);
        stores.audit(
          "operator",
          "graph.edge_added",
          `${id}:${body.data.from}->${body.data.to}`,
          now(),
        );
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/projects/:id/graph/edges", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = EdgeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        projects.session(id).graph.removeEdge(body.data.from, body.data.to);
        stores.audit(
          "operator",
          "graph.edge_removed",
          `${id}:${body.data.from}->${body.data.to}`,
          now(),
        );
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    const NodeBody = z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      complexity: z.enum(["S", "M", "L", "XL"]).optional(),
      risk: z.enum(["low", "medium", "high", "critical"]).optional(),
      dependencies: z.array(z.string().min(1)).optional(),
    });
    app.post("/api/projects/:id/graph/nodes", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = NodeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        projects.session(id).graph.addNode(body.data);
        stores.audit("operator", "graph.node_added", `${id}:${body.data.id}`, now());
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/projects/:id/graph/nodes/:nodeId", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id, nodeId } = req.params as { id: string; nodeId: string };
      const { mode } = req.query as { mode?: "reparent" | "cascade" };
      try {
        const removed = projects.session(id).graph.removeNode(nodeId, mode);
        stores.audit("operator", "graph.node_removed", `${id}:${removed.join(",")}`, now());
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.post("/api/projects/:id/graph/allocate", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = z.object({ strategy: AllocationStrategy }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        autoAllocate(projects.session(id).graph, body.data.strategy);
        stores.audit("operator", "graph.auto_allocated", `${id}:${body.data.strategy}`, now());
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    const OverrideBody = z.object({
      provider: z.enum(["anthropic", "openai"]).optional(),
      model: z.string().min(1).optional(),
      worker_count: z.number().int().min(1).max(3).optional(),
      reviewer_model: z.string().min(1).optional(),
      budget_usd: z.number().positive().optional(),
      rationale: z.string().min(1).optional(),
    });
    app.post("/api/projects/:id/graph/nodes/:nodeId/assignment", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id, nodeId } = req.params as { id: string; nodeId: string };
      const body = OverrideBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        overrideAssignment(projects.session(id).graph, nodeId, body.data);
        stores.audit("operator", "graph.assignment_overridden", `${id}:${nodeId}`, now());
        sendGraph(reply, id);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.post("/api/projects/:id/graph/approve-allocation", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      try {
        const session = projects.session(id);
        const approval = approveAllocation(session.graph, "operator");
        // Persist the approval server-side (ADR-1) so staleness is judged by
        // the server, not reconstructed from client memory.
        session.recordApproval(approval);
        stores.audit("operator", "allocation.approved", `${id}:${approval.content_hash}`, now());
        reply.send(approval);
      } catch (error) {
        projectError(reply, error);
      }
    });

    // ---- live planning, scoped to the project's chosen PM model --------------
    // Both provider keys are required for cross-provider review. An OpenAI
    // reviewer model remains deployment-configured; the PM model is always the
    // exact model persisted on the project.
    const PlanRequest = z.object({
      objective: z.string().min(1),
      maxRounds: z.number().int().min(1).max(5).optional(),
    });
    const buildAdapter = (
      provider: ProviderName,
      model: string,
      anthropicKey: string,
      openaiKey: string,
    ): LlmAdapter => {
      const apiKey = provider === "anthropic" ? anthropicKey : openaiKey;
      if (options.createPlanningAdapter) {
        return options.createPlanningAdapter(provider, model, apiKey);
      }
      return provider === "anthropic"
        ? new AnthropicAdapter({ apiKey, model })
        : new OpenAiAdapter({ apiKey, model });
    };

    app.post("/api/projects/:id/plan", async (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      let pmSelection: { provider: ProviderName; model: string | null };
      try {
        pmSelection = projects.pmSelectionOf(id);
      } catch (error) {
        projectError(reply, error);
        return;
      }
      const body = PlanRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });

      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const openaiKey = process.env.OPENAI_API_KEY;
      const reviewerProvider = reviewerFor(pmSelection.provider);
      const pmModel =
        pmSelection.model ??
        (pmSelection.provider === "anthropic"
          ? (process.env.NORNS_PM_MODEL ?? DEFAULT_PM_MODEL.anthropic)
          : process.env.NORNS_OPENAI_MODEL);
      const reviewerModel =
        reviewerProvider === "openai"
          ? process.env.NORNS_OPENAI_MODEL
          : (process.env.NORNS_REVIEWER_ANTHROPIC_MODEL ??
            process.env.NORNS_PM_MODEL ??
            DEFAULT_PM_MODEL.anthropic);
      const missing = [
        !anthropicKey && "ANTHROPIC_API_KEY",
        !openaiKey && "OPENAI_API_KEY",
        !pmModel && "NORNS_OPENAI_MODEL",
        reviewerProvider === "openai" && !reviewerModel && "NORNS_OPENAI_MODEL",
      ].filter(
        (v, index, values): v is string => typeof v === "string" && values.indexOf(v) === index,
      );
      if (missing.length > 0) {
        return reply.code(501).send({
          error: "live_planning_unavailable",
          message: `live planning requires ${missing.join(", ")} to be set as environment variables`,
        });
      }

      const pm = buildAdapter(
        pmSelection.provider,
        pmModel as string,
        anthropicKey as string,
        openaiKey as string,
      );
      const reviewer = buildAdapter(
        reviewerProvider,
        reviewerModel as string,
        anthropicKey as string,
        openaiKey as string,
      );

      stores.audit(
        "operator",
        "planning.started",
        `${id} pm=${pm.provider}:${pm.model} reviewer=${reviewer.provider}:${reviewer.model} objective=${body.data.objective}`,
        now(),
      );
      try {
        const result = await runPlanning({
          pm,
          reviewer,
          objective: body.data.objective,
          projectId: id,
          ...(body.data.maxRounds !== undefined ? { maxRounds: body.data.maxRounds } : {}),
        });
        options.recordUsage?.(result.usage);
        const totalCost = result.usage.reduce((sum, u) => sum + u.estimated_cost_usd, 0);
        stores.audit(
          "operator",
          "planning.completed",
          `${id}:${result.status} pm=${pm.provider}:${pm.model} reviewer=${reviewer.provider}:${reviewer.model} rounds=${result.rounds} cost_usd=${totalCost.toFixed(4)}`,
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
          `${id}:${error instanceof Error ? error.message : String(error)}`,
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

    // Commit a (human-reviewed) plan — typically the output of POST
    // /api/projects/:id/plan — into that project's graph.
    const LoadPlanBody = z.object({ plan: PlanContract });
    app.post("/api/projects/:id/plan/load", (req, reply) => {
      if (!requireSession(req, reply)) return;
      const { id } = req.params as { id: string };
      const body = LoadPlanBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        projects.loadPlan(id, body.data.plan);
        stores.audit("operator", "graph.plan_loaded", `${id}:${body.data.plan.objective}`, now());
        sendGraph(reply, id);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          projectError(reply, error);
          return;
        }
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
    if (!token || !users.userForToken(token)) {
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
