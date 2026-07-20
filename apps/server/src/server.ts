// The relay/API server (ADR-002: the backend IS the relay). Exposes:
//   POST /api/pairing/start | /api/pairing/complete
//   POST /api/commands, GET /api/commands/:id
//   GET  /api/runners, /api/audit, /api/events/:runnerId
//   POST /api/kill-switch
//   WS   /ws/runner  (challenge -> auth -> reconcile -> commands/events)
//   WS   /ws/session (live observation for the browser)
//   GET  /          (React app in production; API notice in server-only dev)
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
  buildSelectableModelCatalog,
  modelAvailabilityFromDebateEnvironment,
} from "@norns/adapters";
import {
  AnthropicPmModel,
  type CommandEnvelopeT,
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
  V2ContentAddressedReference,
  V2ControlDebateRunCommand,
  V2CreateDebateCommand,
  V2DecisionResolutionRequest,
  type V2DispatchCommandT,
  V2EvidenceRef,
  V2HumanDirectionRequest,
  V2InterveneDebateRunCommand,
  V2RepositoryIngestionSeed,
  V2StartDebateRunCommand,
  V2StrategyVersion,
  parseRunnerFrame,
} from "@norns/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, verifyRunnerSignature } from "./auth.js";
import type { Phase4CompletionService } from "./coordinator/phase4Completion.js";
import type { Phase4Coordinator } from "./coordinator/phase4Coordinator.js";
import { type Phase4DispatchRepository, Phase4Dispatcher } from "./coordinator/phase4Dispatcher.js";
import type { Phase4EventProcessor } from "./coordinator/phase4EventProcessor.js";
import type { Phase4RecoveryMonitor } from "./coordinator/phase4RecoveryMonitor.js";
import type { Phase6CoordinationService } from "./coordinator/phase6Coordination.js";
import { DebateConflictError, type DebateService } from "./debates/service.js";
import { EmailNotConfiguredError, sendEmail } from "./email/resend.js";
import { AllocationError, AllocationStrategy } from "./graph/allocation.js";
import { GraphEditError, WorkflowGraph } from "./graph/graph.js";
import { newId, nonce, pairingCode } from "./ids.js";
import {
  GitHubIntegrationError,
  type GitHubIntegrationService,
  disabledGitHubStatus,
} from "./integrations/github.js";
import type { Phase7OperationsService } from "./operations/phase7Operations.js";
import type { V2TransactionRunner } from "./persistence/v2/database.js";
import {
  AllocationRecommendationError,
  recommendProjectAllocation,
} from "./planning/allocationRecommendation.js";
import { resolvePlanningParticipants } from "./planning/reviewerSelection.js";
import {
  PlanningRunConflictError,
  PlanningRunService,
  type PlanningStaffingProposalDto,
} from "./planning/runService.js";
import { PlanningRunWorker } from "./planning/runWorker.js";
import { PlanningError, planContentHash, runPlanning } from "./planning/session.js";
import { type AttentionService, DecisionResolutionError } from "./projects/attentionService.js";
import {
  PhaseWorkflowConflictError,
  type PhaseWorkflowService,
} from "./projects/phaseWorkflowService.js";
import type { ProjectResumeService } from "./projects/projectResumeService.js";
import { Phase3RequiredError } from "./projects/relationalReadRepository.js";
import {
  type ProjectGraphView,
  type ProjectRepository,
  projectRepository,
} from "./projects/repository.js";
import type { RepositoryIngestionService } from "./projects/repositoryIngestionService.js";
import type { SourceBindingService } from "./projects/sourceBindingService.js";
import {
  ProjectNotFoundError,
  ProjectNotPlannedError,
  type ProjectStore,
  reviewerFor,
} from "./projects/store.js";
import {
  type StrategyBridgeActor,
  StrategyBridgeError,
  type StrategyBridgeService,
} from "./projects/strategyBridgeService.js";
import {
  StrategyWorkflowConflictError,
  type StrategyWorkflowService,
} from "./projects/strategyWorkflowService.js";
import {
  RunnerWorkspaceBroker,
  WorkspaceBrokerError,
  WorkspaceSelectionTokens,
} from "./runners/workspaceBroker.js";
import type { RelayStores } from "./stores.js";
import type {
  IdentityService,
  IdentityUser,
  IdentityUserSummary,
} from "./users/identityService.js";
import { IdentityAlreadyBootstrappedError } from "./users/identityService.js";
import { LegacyIdentityService } from "./users/legacyIdentityService.js";
import { LoginAttemptThrottle } from "./users/loginThrottle.js";
import { LastActiveAdminError, type UserStore } from "./users/store.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;

interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
}

interface SessionSocketBinding {
  socket: WsLike;
  token: string;
  userId: string;
  active: boolean;
  /** Keeps validation and delivery ordered for a single browser connection. */
  delivery: Promise<void>;
}

const SessionAuthFrame = z
  .object({
    type: z.literal("auth"),
    token: z.string().min(1),
  })
  .strict();

const SESSION_AUTH_TIMEOUT_MS = 5_000;

function asSocket(conn: unknown): WsLike {
  const candidate = conn as { socket?: WsLike } & WsLike;
  return candidate.socket ?? candidate;
}

export interface ServerOptions {
  stores: RelayStores;
  /**
   * Legacy account store retained for existing callers and snapshot bootstrap.
   * It remains the identity source whenever `identity` is omitted.
   */
  users: UserStore;
  /**
   * Optional async identity implementation. When omitted, `users` is adapted
   * through LegacyIdentityService so all existing callers retain their
   * snapshot-backed behavior while route handlers use one async seam.
   */
  identity?: IdentityService;
  /**
   * Deploy-level secret (Railway env var). Its ONLY job is gating the
   * one-time POST /api/auth/bootstrap that creates the first admin account
   * when zero users exist yet. It is never accepted as a session credential
   * for any other route — real per-user sessions replace that entirely.
   * Omit to disable bootstrap (e.g. once you're certain it's no longer needed).
   */
  deployToken?: string;
  /**
   * Optional durability barrier for the one-time first-admin bootstrap.
   * When supplied, bootstrap is not acknowledged until the user snapshot is
   * durable. A failed write rolls the UserStore back to its pre-bootstrap
   * state so the operator can safely retry.
   */
  persistUsers?: () => Promise<void>;
  clock?: () => Date;
  /** Multi-project management: create/list projects, plan + edit + allocate each one's graph. */
  projects?: ProjectRepository | ProjectStore;
  phase3?: {
    sourceBindings: SourceBindingService;
    ingestion: RepositoryIngestionService;
    phases: PhaseWorkflowService;
    strategies: StrategyWorkflowService;
    /** FRONT DOOR P3: planning-run -> proposed-StrategyVersion bridge. */
    bridge: StrategyBridgeService;
    resume: ProjectResumeService;
  };
  /** New-project local onboarding is safe only after durable relational writes are active. */
  localProjectOnboardingReady?: boolean;
  phase4?: {
    coordinator: Phase4Coordinator;
    completion: Phase4CompletionService;
    dispatch: Phase4DispatchRepository;
    events: Phase4EventProcessor;
    recovery: Phase4RecoveryMonitor;
  };
  phase5?: { attention: AttentionService };
  phase6?: { coordination: Phase6CoordinationService };
  phase7?: { operations: Phase7OperationsService };
  /** Durable relational debate workflow, unavailable without its database runtime. */
  debates?: DebateService;
  /**
   * Durable, user-configurable, observable planning runs (FRONT DOOR P2 §D1):
   * wraps runPlanning() with a pollable record. Unavailable without its
   * database runtime, same as `debates`.
   */
  planningRuns?: { transactions: V2TransactionRunner };
  integrations?: { github: GitHubIntegrationService | null };
  /**
   * Deployment configuration inspected by safe integration-status routes.
   * Only presence and public model identifiers are returned; secret values
   * never cross the server boundary. Tests may inject an isolated environment.
   */
  integrationEnvironment?: NodeJS.ProcessEnv;
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
  /** Force Secure browser cookies in production and production-shaped tests. */
  secureCookies?: boolean;
  /** Canonical browser origin used in emailed links. */
  publicOrigin?: string;
}

export interface NornsServer {
  app: FastifyInstance;
  stores: RelayStores;
  /** runner_ids with a live authenticated socket */
  connectedRunners(): string[];
}

export async function buildServer(options: ServerOptions): Promise<NornsServer> {
  const { stores, users, deployToken } = options;
  const usesLegacyIdentity = options.identity === undefined;
  const identityService: IdentityService = options.identity ?? new LegacyIdentityService(users);
  const now = options.clock ?? (() => new Date());
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const runnerSockets = new Map<string, WsLike>();
  const reconciledWorkspaceRunners = new Map<
    string,
    { socket: WsLike; generation: number; workspacePicker: boolean }
  >();
  const sessionSockets = new Map<WsLike, SessionSocketBinding>();
  const loginThrottle = new LoginAttemptThrottle();
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === "production";
  const integrationEnvironment = options.integrationEnvironment ?? process.env;
  const configuredWorkerModels = () =>
    buildSelectableModelCatalog(
      modelAvailabilityFromDebateEnvironment(integrationEnvironment),
    ).filter((entry) => entry.available);
  const buildPlanningAdapter = (provider: ProviderName, model: string): LlmAdapter => {
    const apiKey =
      provider === "anthropic"
        ? integrationEnvironment.ANTHROPIC_API_KEY
        : integrationEnvironment.OPENAI_API_KEY;
    if (!apiKey?.trim()) {
      throw new AllocationRecommendationError(
        "models_unavailable",
        `${provider} is not configured for project-manager recommendations.`,
      );
    }
    if (options.createPlanningAdapter) {
      return options.createPlanningAdapter(provider, model, apiKey);
    }
    return provider === "anthropic"
      ? new AnthropicAdapter({ apiKey, model })
      : new OpenAiAdapter({ apiKey, model });
  };
  const configuredOrigin =
    options.publicOrigin ??
    process.env.NORNS_PUBLIC_ORIGIN ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : undefined);
  const SESSION_COOKIE = "norns_session";
  const CSRF_COOKIE = "norns_csrf";
  const GITHUB_MANIFEST_STATE_COOKIE = "norns_github_manifest_state";
  const RECENT_AUTH_MS = 15 * 60_000;

  const cookies = (req: FastifyRequest): Map<string, string> => {
    const result = new Map<string, string>();
    for (const segment of (req.headers.cookie ?? "").split(";")) {
      const separator = segment.indexOf("=");
      if (separator <= 0) continue;
      const key = segment.slice(0, separator).trim();
      const value = segment.slice(separator + 1).trim();
      try {
        result.set(key, decodeURIComponent(value));
      } catch {
        // Invalid cookie encoding is treated as absent.
      }
    }
    return result;
  };
  const credentialFor = (req: FastifyRequest): string | undefined =>
    bearerToken(req.headers.authorization) ?? cookies(req).get(SESSION_COOKIE);
  const cookieAttributes = `Path=/; SameSite=Strict${secureCookies ? "; Secure" : ""}`;
  const setBrowserSession = (reply: FastifyReply, token: string, csrf: string): void => {
    reply.header("Set-Cookie", [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${cookieAttributes}`,
      `${CSRF_COOKIE}=${encodeURIComponent(csrf)}; ${cookieAttributes}`,
    ]);
    reply.header("Cache-Control", "no-store");
  };
  const clearBrowserSession = (reply: FastifyReply): void => {
    reply.header("Set-Cookie", [
      `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; ${cookieAttributes}`,
      `${CSRF_COOKIE}=; Max-Age=0; ${cookieAttributes}`,
    ]);
    reply.header("Cache-Control", "no-store");
  };
  const manifestStateCookie = (state: string): string =>
    `${GITHUB_MANIFEST_STATE_COOKIE}=${encodeURIComponent(state)}; Max-Age=600; Path=/api/integrations/github/manifest/callback; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`;
  const clearManifestStateCookie = (reply: FastifyReply): FastifyReply =>
    reply.header(
      "Set-Cookie",
      `${GITHUB_MANIFEST_STATE_COOKIE}=; Max-Age=0; Path=/api/integrations/github/manifest/callback; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`,
    );
  const externalOrigin = (req: FastifyRequest): string => {
    if (configuredOrigin) {
      const parsed = new URL(configuredOrigin);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("NORNS_PUBLIC_ORIGIN must use http or https");
      }
      return parsed.origin;
    }
    return `${req.protocol}://${req.headers.host}`;
  };
  const escapeHtml = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  app.addHook("preHandler", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (bearerToken(req.headers.authorization)) return;
    const requestCookies = cookies(req);
    if (!requestCookies.has(SESSION_COOKIE)) return;
    const cookieCsrf = requestCookies.get(CSRF_COOKIE);
    const headerCsrf = req.headers["x-csrf-token"];
    if (!cookieCsrf || typeof headerCsrf !== "string" || headerCsrf !== cookieCsrf) {
      reply.code(403).send({ error: "csrf_rejected" });
    }
  });

  const sendFrame = (socket: WsLike, frame: ServerFrameT): void => {
    socket.send(JSON.stringify(frame));
  };
  const workspaceBroker = new RunnerWorkspaceBroker((runnerId, generation, request) => {
    const socket = runnerSockets.get(runnerId);
    const reconciled = reconciledWorkspaceRunners.get(runnerId);
    if (
      !socket ||
      !reconciled ||
      reconciled.socket !== socket ||
      reconciled.generation !== generation ||
      !reconciled.workspacePicker
    )
      return false;
    try {
      sendFrame(socket, { type: "workspace_request", generation, request });
      return true;
    } catch {
      return false;
    }
  });
  const workspaceSelections = new WorkspaceSelectionTokens();

  const v2WireCommand = (command: V2DispatchCommandT): CommandEnvelopeT => ({
    protocol: 1,
    command_id: command.command_id,
    idempotency_key: command.idempotency_key,
    correlation_id: command.correlation_id,
    causation_id: command.causation_id,
    project_id: command.project_id,
    runner_id: command.runner_id,
    generation: command.runner_generation,
    issued_by_session: command.authorized_by_session_id,
    issued_at: command.issued_at,
    expires_at: command.expires_at,
    payload: {
      kind: "launch_run",
      node_id: command.task_id,
      run_id: command.run_id,
      prompt_ref: command.context_refs[0]?.storage_ref ?? "content-addressed-context",
      dispatch: command,
    },
  });

  let phase4DispatchTimer: ReturnType<typeof setInterval> | undefined;
  let phase4RecoveryTimer: ReturnType<typeof setInterval> | undefined;
  if (options.phase4) {
    const dispatcher = new Phase4Dispatcher(
      options.phase4.dispatch,
      `server:${process.pid}`,
      async (command) => {
        const socket = runnerSockets.get(command.runner_id);
        if (!socket) throw new Error(`runner ${command.runner_id} is not connected`);
        sendFrame(socket, {
          type: "command",
          command: v2WireCommand(command),
        });
      },
    );
    let ticking = false;
    phase4DispatchTimer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void dispatcher.tick().finally(() => {
        ticking = false;
      });
    }, 500);
    phase4DispatchTimer.unref();
    let scanning = false;
    phase4RecoveryTimer = setInterval(() => {
      if (scanning) return;
      scanning = true;
      void options.phase4?.recovery.scan().finally(() => {
        scanning = false;
      });
    }, 60_000);
    phase4RecoveryTimer.unref();
  }
  app.addHook("onClose", async () => {
    if (phase4DispatchTimer) clearInterval(phase4DispatchTimer);
    if (phase4RecoveryTimer) clearInterval(phase4RecoveryTimer);
    workspaceBroker.close();
  });

  const closeSessionSocket = (binding: SessionSocketBinding, reason: string): void => {
    if (!binding.active) return;
    binding.active = false;
    sessionSockets.delete(binding.socket);
    try {
      binding.socket.close(1008, reason);
    } catch {
      // The connection is already gone. Removing it from the map is enough.
    }
  };

  const closeMatchingSessionSockets = (
    predicate: (binding: SessionSocketBinding) => boolean,
    reason: string,
  ): void => {
    for (const binding of sessionSockets.values()) {
      if (predicate(binding)) closeSessionSocket(binding, reason);
    }
  };

  const broadcast = (message: Record<string, unknown>): void => {
    const raw = JSON.stringify(message);
    for (const binding of sessionSockets.values()) {
      binding.delivery = binding.delivery
        .then(async () => {
          if (!binding.active) return;
          const currentUser = await identityService.userForToken(binding.token);
          if (
            !currentUser ||
            currentUser.id !== binding.userId ||
            currentUser.status !== "active"
          ) {
            closeSessionSocket(binding, "session no longer valid");
            return;
          }
          if (!binding.active) return;
          try {
            binding.socket.send(raw);
          } catch {
            closeSessionSocket(binding, "connection unavailable");
          }
        })
        .catch(() => {
          closeSessionSocket(binding, "session validation failed");
        });
    }
  };

  /** Resolve the caller's bearer token to a real user, or undefined. Real
   *  per-user sessions are the only session credential — the deploy token is
   *  never accepted here, only by the bootstrap route below. */
  const resolveUser = async (req: FastifyRequest): Promise<IdentityUser | undefined> => {
    const token = credentialFor(req);
    if (!token) return undefined;
    return identityService.userForToken(token);
  };

  const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!(await resolveUser(req))) {
      stores.audit("anonymous", "auth.rejected", `${req.method} ${req.url}`, now());
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  /** Like requireSession, but also enforces the admin role. Returns the
   *  resolved admin user (so the caller can attribute audit entries), or
   *  null if it already sent a 401/403. */
  const requireAdmin = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<IdentityUser | null> => {
    const user = await resolveUser(req);
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
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      identityService.isRecentSession &&
      !(await identityService.isRecentSession(credentialFor(req) ?? "", RECENT_AUTH_MS))
    ) {
      stores.audit(user.email, "auth.recent_required", `${req.method} ${req.url}`, now());
      reply.code(403).send({ error: "recent_auth_required" });
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

  app.get("/api/auth/status", async (_req, reply) => {
    reply.send({ needs_bootstrap: !(await identityService.hasActiveAdmin()) });
  });

  const BootstrapBody = z.object({
    deploy_token: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1).optional(),
  });
  app.post("/api/auth/bootstrap", async (req, reply) => {
    // Keep the established response semantics while the service-level
    // bootstrap operation performs the authoritative, atomic re-check.
    if (await identityService.hasActiveAdmin()) {
      return reply.code(403).send({ error: "already_bootstrapped" });
    }
    if (!deployToken) return reply.code(501).send({ error: "bootstrap_disabled" });
    const body = BootstrapBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (body.data.deploy_token !== deployToken) {
      stores.audit("anonymous", "auth.bootstrap_rejected", "bad deploy token", now());
      return reply.code(403).send({ error: "invalid_deploy_token" });
    }
    // Snapshot rollback remains exclusive to the legacy adapter. Relational
    // identity operations are already committed by their transaction runner.
    const beforeBootstrap = usesLegacyIdentity ? users.snapshot() : undefined;
    let summary: IdentityUserSummary;
    try {
      summary = await identityService.bootstrapAdmin({
        email: body.data.email,
        name: body.data.name,
        password: body.data.password,
      });
    } catch (error) {
      if (error instanceof IdentityAlreadyBootstrappedError) {
        return reply.code(403).send({ error: "already_bootstrapped" });
      }
      throw error;
    }
    const { token } = await identityService.login(body.data.email, body.data.password);
    try {
      if (usesLegacyIdentity) await options.persistUsers?.();
    } catch {
      if (beforeBootstrap) users.restoreFrom(beforeBootstrap);
      stores.audit("anonymous", "auth.bootstrap_persistence_failed", summary.id, now());
      return reply.code(503).send({ error: "auth_persistence_unavailable" });
    }
    stores.audit(summary.email, "auth.bootstrapped", summary.id, now());
    const csrf = nonce();
    setBrowserSession(reply, token, csrf);
    const bearerRequested = req.headers["x-norns-api-client"] === "bearer";
    reply.code(201).send({
      user: summary,
      csrf_token: csrf,
      ...(bearerRequested || usesLegacyIdentity ? { token } : {}),
    });
  });

  const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
  app.post("/api/auth/login", async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const attemptedAt = now();
    const throttleKey = loginThrottle.key(body.data.email, req.ip);
    const allowance = loginThrottle.check(throttleKey, attemptedAt);
    if (!allowance.allowed) {
      stores.audit("anonymous", "auth.login_throttled", "credential_pair", attemptedAt);
      reply.header("Retry-After", String(allowance.retry_after_seconds));
      return reply.code(429).send({ error: "login_throttled" });
    }
    try {
      const { token, user } = await identityService.login(body.data.email, body.data.password);
      loginThrottle.recordSuccess(throttleKey);
      stores.audit(user.email, "auth.login", user.id, now());
      const csrf = nonce();
      setBrowserSession(reply, token, csrf);
      const bearerRequested = req.headers["x-norns-api-client"] === "bearer";
      reply.send({
        user,
        csrf_token: csrf,
        ...(bearerRequested || usesLegacyIdentity ? { token } : {}),
      });
    } catch {
      loginThrottle.recordFailure(throttleKey, attemptedAt);
      stores.audit("anonymous", "auth.login_failed", body.data.email, now());
      reply.code(401).send({ error: "invalid_credentials" });
    }
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = credentialFor(req);
    if (token) {
      await identityService.logout(token);
      closeMatchingSessionSockets((binding) => binding.token === token, "session logged out");
    }
    clearBrowserSession(reply);
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    reply.send({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
    });
  });

  app.get("/api/auth/sessions", async (req, reply) => {
    const user = await resolveUser(req);
    const token = credentialFor(req);
    if (!user || !token) return reply.code(401).send({ error: "unauthorized" });
    if (!identityService.listSessions) {
      return reply.code(409).send({ error: "relational_identity_required" });
    }
    reply.send({ sessions: await identityService.listSessions(user.id, token) });
  });

  app.delete("/api/auth/sessions/:sessionId", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!identityService.revokeSession) {
      return reply.code(409).send({ error: "relational_identity_required" });
    }
    const { sessionId } = req.params as { sessionId: string };
    await identityService.revokeSession(user.id, sessionId);
    closeMatchingSessionSockets(
      (binding) => binding.userId === user.id,
      "session inventory changed",
    );
    stores.audit(user.email, "auth.session_revoked", sessionId, now());
    reply.send({ ok: true });
  });

  const RecoveryRequestBody = z.object({ email: z.string().email() });
  app.post("/api/auth/recovery/request", async (req, reply) => {
    const body = RecoveryRequestBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const token = await identityService.requestPasswordRecovery?.(body.data.email);
    if (token) {
      const origin = externalOrigin(req);
      const resetUrl = `${origin}/?recovery=${encodeURIComponent(token)}`;
      try {
        await sendEmail({
          to: body.data.email,
          subject: "Reset your TheNorns password",
          html: `<p><a href="${resetUrl}">Reset your password</a>. This link expires in one hour.</p>`,
        });
      } catch {
        stores.audit("system", "auth.recovery_email_failed", "redacted-recipient", now());
      }
    }
    reply.code(202).send({ accepted: true });
  });

  const RecoveryCompleteBody = z.object({
    recovery_token: z.string().min(1),
    password: z.string().min(8),
  });
  app.post("/api/auth/recovery/complete", async (req, reply) => {
    const body = RecoveryCompleteBody.safeParse(req.body);
    if (!body.success || !identityService.resetPassword) {
      return reply.code(400).send({ error: "invalid_recovery" });
    }
    try {
      await identityService.resetPassword(body.data.recovery_token, body.data.password);
      clearBrowserSession(reply);
      reply.send({ ok: true });
    } catch {
      reply.code(400).send({ error: "invalid_recovery" });
    }
  });

  const AcceptInviteBody = z.object({
    invite_token: z.string().min(1),
    password: z.string().min(8),
  });
  app.post("/api/auth/accept-invite", async (req, reply) => {
    const body = AcceptInviteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const summary = await identityService.acceptInvite(
        body.data.invite_token,
        body.data.password,
      );
      const { token } = await identityService.login(summary.email, body.data.password);
      stores.audit(summary.email, "auth.invite_accepted", summary.id, now());
      const csrf = nonce();
      setBrowserSession(reply, token, csrf);
      const bearerRequested = req.headers["x-norns-api-client"] === "bearer";
      reply.send({
        user: summary,
        csrf_token: csrf,
        ...(bearerRequested || usesLegacyIdentity ? { token } : {}),
      });
    } catch {
      reply.code(400).send({
        error: "invalid_invite",
        message: "Invitation is invalid, expired, or already used.",
      });
    }
  });

  // ---- admin: user management (admin role required) ---------------------------

  app.get("/api/admin/users", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    reply.send(await identityService.list());
  });

  const CreateUserBody = z.object({
    email: z.string().email(),
    name: z.string().min(1).optional(),
    password: z.string().min(8),
    role: z.enum(["admin", "member"]).default("member"),
  });
  app.post("/api/admin/users", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const body = CreateUserBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const summary = await identityService.createActive(body.data);
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
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const body = InviteUserBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    let created: { summary: IdentityUserSummary; inviteToken: string };
    try {
      created = await identityService.createInvite(body.data);
    } catch (error) {
      return reply.code(409).send({
        error: "user_exists",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const origin = externalOrigin(req);
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

  app.delete("/api/admin/users/:id", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const { id } = req.params as { id: string };
    try {
      await identityService.remove(id);
      closeMatchingSessionSockets((binding) => binding.userId === id, "account disabled");
      stores.audit(admin.email, "admin.user_removed", id, now());
      reply.send({ ok: true });
    } catch (error) {
      if (error instanceof LastActiveAdminError) {
        return reply.code(409).send({
          error: "last_active_admin",
          message: error.message,
        });
      }
      reply.code(404).send({ error: "not_found" });
    }
  });

  if (options.phase7) {
    const RevokeRunnerBody = z.object({
      revoked_through_generation: z.number().int().nonnegative(),
      reason: z.string().min(1),
    });
    app.post("/api/admin/runners/:runnerId/revoke", async (req, reply) => {
      const admin = await requireAdmin(req, reply);
      if (!admin) return;
      const body = RevokeRunnerBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      const { runnerId } = req.params as { runnerId: string };
      await options.phase7?.operations.revokeRunner({
        runner_id: runnerId,
        ...body.data,
        revoked_by: admin.id,
        revoked_at: now().toISOString(),
      });
      stores.revokeRunnerSessions(runnerId);
      reconciledWorkspaceRunners.delete(runnerId);
      workspaceBroker.disconnect(runnerId);
      const socket = runnerSockets.get(runnerId);
      if (socket) {
        runnerSockets.delete(runnerId);
        const currentGeneration = stores.runner(runnerId)?.generation;
        if (currentGeneration !== undefined)
          sendFrame(socket, { type: "fenced", current_generation: currentGeneration });
        socket.close(1008, "runner revoked");
      }
      reply.send({ ok: true });
    });

    const DrillBody = z.object({
      id: z.string().min(1),
      drill_type: z.enum(["restore", "chaos", "load", "soak", "runner_fencing", "audit"]),
      source_revision: z.string().min(1),
      target_reference: z.string().min(1),
      started_at: z.string().datetime(),
      completed_at: z.string().datetime(),
      recovery_time_seconds: z.number().int().nonnegative(),
      recovery_point_seconds: z.number().int().nonnegative(),
      passed: z.boolean(),
      evidence: z.array(z.unknown()).min(1),
    });
    app.post("/api/admin/resilience/drills", async (req, reply) => {
      const admin = await requireAdmin(req, reply);
      if (!admin) return;
      const body = DrillBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        await options.phase7?.operations.recordDrill({ ...body.data, recorded_by: admin.id });
        reply.code(201).send({ ok: true });
      } catch (error) {
        reply.code(409).send({ error: "drill_rejected", detail: String(error) });
      }
    });

    const CutoverBody = z.object({
      id: z.string().min(1),
      cohort_type: z.enum(["internal", "selected", "new_projects", "remaining"]),
      project_id: z.string().min(1).nullable(),
      status: z.enum(["shadow", "canary", "authoritative", "paused"]),
      reconciliation_material: z.union([
        z.record(z.unknown()),
        z.array(z.unknown()),
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
      ]),
      restore_drill_id: z.string().min(1),
    });
    app.post("/api/admin/cutover/cohorts", async (req, reply) => {
      const admin = await requireAdmin(req, reply);
      if (!admin) return;
      const body = CutoverBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        await options.phase7?.operations.promoteCutover({
          ...body.data,
          authorized_by: admin.id,
          authorized_at: now().toISOString(),
        });
        reply.send({ ok: true });
      } catch (error) {
        reply.code(409).send({ error: "cutover_rejected", detail: String(error) });
      }
    });

    app.get("/api/admin/cutover/authoritative", async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      try {
        reply.send(await options.phase7?.operations.assertRelationalAuthoritative());
      } catch (error) {
        reply.code(409).send({ error: "relational_not_authoritative", detail: String(error) });
      }
    });
  }

  // ---- pairing ---------------------------------------------------------------

  app.post("/api/pairing/start", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
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
    reconciledWorkspaceRunners.delete(runner_id);
    workspaceBroker.disconnect(runner_id);
    const priorSocket = runnerSockets.get(runner_id);
    if (priorSocket) {
      runnerSockets.delete(runner_id);
      sendFrame(priorSocket, { type: "fenced", current_generation: record.generation });
      priorSocket.close(1008, "runner re-paired");
      broadcast({ type: "runner_status", runner_id, connected: false });
    }
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

  app.post("/api/commands", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
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

  app.get("/api/commands/:id", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
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

  app.get("/api/runners", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    reply.send(
      stores.runners().map((r) => ({
        runner_id: r.runner_id,
        generation: r.generation,
        connected: runnerSockets.has(r.runner_id),
        workspace_picker_ready:
          reconciledWorkspaceRunners.get(r.runner_id)?.generation === r.generation &&
          reconciledWorkspaceRunners.get(r.runner_id)?.workspacePicker === true,
        local_project_onboarding_ready: options.localProjectOnboardingReady === true,
        last_seen_at: r.last_seen_at,
      })),
    );
  });

  app.get("/api/audit", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    reply.send(stores.auditEntries());
  });

  app.get("/api/events/:runnerId", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const { runnerId } = req.params as { runnerId: string };
    reply.send(stores.eventsFor(runnerId));
  });

  app.post("/api/kill-switch", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const body = z.object({ engaged: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    stores.setKillSwitch(body.data.engaged);
    stores.audit("operator", "kill_switch", body.data.engaged ? "engaged" : "disengaged", now());
    return reply.send({ engaged: body.data.engaged });
  });

  app.get("/health", (_req, reply) => {
    reply.send({ ok: true, contracts: "1.2.0" });
  });

  // The legacy Phase 1A page asked operators to paste a raw session token.
  // Account auth in the React app supersedes it; keep old bookmarks safe by
  // sending them to the normal email/password entry point.
  app.get("/control", (_req, reply) => {
    reply.redirect("/");
  });

  if (options.webDist) {
    // Single-service deploy: serve the built React app + SPA fallback.
    // Static assets are public; the page authenticates with an account-backed
    // browser session issued after email/password login.
    await app.register(fastifyStatic, { root: options.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.get("/", (_req, reply) => {
      reply.type("text/html").send(`<!doctype html>
<meta charset="utf-8"><title>TheNorns API</title>
<h1>TheNorns API is running</h1>
<p>Start <code>@norns/web</code> and sign in there with your email and password.</p>`);
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
    app.get("/api/demo/dashboard", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      reply.send(demoDashboard());
    });
  }

  // ---- workspace service connections -----------------------------------------
  // GitHub credentials live here, at the workspace/user authorization boundary.
  // Project records receive only stable installation/repository identities.
  app.get("/api/integrations/ai/status", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const anthropicConfigured = Boolean(integrationEnvironment.ANTHROPIC_API_KEY?.trim());
    const openaiConfigured = Boolean(integrationEnvironment.OPENAI_API_KEY?.trim());
    reply.header("Cache-Control", "no-store").send({
      cross_provider_ready: anthropicConfigured && openaiConfigured,
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          configured: anthropicConfigured,
          model: integrationEnvironment.NORNS_PM_MODEL ?? DEFAULT_PM_MODEL.anthropic,
          required_environment: ["ANTHROPIC_API_KEY"],
        },
        {
          id: "openai",
          name: "OpenAI",
          configured: openaiConfigured,
          model: integrationEnvironment.NORNS_OPENAI_MODEL ?? DEFAULT_PM_MODEL.openai,
          required_environment: ["OPENAI_API_KEY", "NORNS_OPENAI_MODEL"],
        },
      ],
    });
  });

  // ---- durable debate workflow ------------------------------------------------
  // Browser routes construct application commands from the authenticated
  // identity. Clients never choose actor attribution, command IDs, or
  // correlation IDs themselves.
  if (options.debates) {
    const debates = options.debates;
    const configuredDebateModels = configuredWorkerModels;
    const debateError = (reply: FastifyReply, error: unknown): void => {
      if (error instanceof DebateConflictError) {
        const status = ["debate_not_found", "debate_run_not_found", "project_not_found"].includes(
          error.code,
        )
          ? 404
          : 409;
        reply.code(status).send({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        reply.code(400).send({ error: "bad_request", message: error.message });
        return;
      }
      throw error;
    };
    const DebateActorBody = z
      .object({
        id: z.string().min(1).optional(),
        kind: z.enum(["participant", "judge", "synthesizer"]).optional(),
        actor_kind: z.enum(["participant", "judge", "synthesizer"]).optional(),
        display_name: z.string().trim().min(1).max(200),
        role_label: z.string().trim().min(1).max(200),
        instructions: z.string().trim().min(1).max(100_000),
        provider: z.enum(["anthropic", "openai"]),
        model: z.string().trim().min(1).max(500),
        runtime: z.literal("provider_api").default("provider_api"),
        enabled: z.boolean().default(true),
        position: z.number().int().nonnegative(),
        max_turns: z.number().int().positive().max(200),
        max_input_tokens: z.number().int().positive(),
        max_output_tokens: z.number().int().positive(),
        budget_limit_usd: z.number().finite().nonnegative(),
      })
      .strict()
      .superRefine((actor, context) => {
        if (actor.kind === undefined && actor.actor_kind === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["kind"],
            message: "actor kind is required",
          });
        }
        if (
          actor.kind !== undefined &&
          actor.actor_kind !== undefined &&
          actor.kind !== actor.actor_kind
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actor_kind"],
            message: "kind and actor_kind must agree",
          });
        }
      });
    const DebateContextBody = z
      .object({
        label: z.string().trim().min(1).max(500),
        artifact_id: z.string().trim().min(1).nullable(),
        artifact_content_hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        artifact_media_type: z.string().trim().min(1).nullable(),
        inline_content: z.string().max(100_000).nullable(),
      })
      .strict();
    const CreateDebateBody = z
      .object({
        idempotency_key: z.string().trim().min(1),
        expected_project_version: z.number().int().positive().optional(),
        configuration: z
          .object({
            title: z.string().trim().min(1).max(500),
            question: z.string().trim().min(1).max(100_000),
            phase_id: z.string().trim().min(1).nullable().optional(),
            context_artifact_ids: z.array(z.string().trim().min(1)).default([]),
            contexts: z.array(DebateContextBody).default([]),
            actors: z.array(DebateActorBody).min(2).max(32),
            schedule: z
              .object({
                kind: z.literal("round_robin"),
                participant_ids: z.array(z.string().trim().min(1)).min(2),
              })
              .optional(),
            policy: z.object({
              exact_rounds: z.number().int().positive().max(50).nullable(),
              max_rounds: z.number().int().positive().max(50),
              max_duration_seconds: z.number().int().positive(),
              max_total_input_tokens: z.number().int().positive(),
              max_total_output_tokens: z.number().int().positive(),
              max_total_cost_usd: z.number().finite().nonnegative(),
              stop_on_consensus: z.boolean(),
              no_material_change_rounds: z.number().int().positive().max(50).nullable(),
              repeated_disagreement_rounds: z.number().int().positive().max(50).nullable(),
              provider_failure_threshold: z.number().int().positive().max(100),
            }),
          })
          .strict(),
      })
      .strict();
    const StartDebateBody = z
      .object({
        idempotency_key: z.string().trim().min(1),
        expected_debate_version: z.number().int().positive().optional(),
      })
      .strict();
    const ControlDebateBody = z
      .object({
        action: z.enum(["pause", "resume", "cancel", "stop_after_turn", "stop_after_round"]),
        expected_version: z.number().int().positive(),
        idempotency_key: z.string().trim().min(1),
        reason: z.string().trim().max(10_000).optional(),
        ambiguity_disposition: z.enum(["assume_full_charge"]).nullable().optional(),
      })
      .strict();
    const InterventionBody = z
      .object({
        kind: z.enum(["direction", "statement"]),
        target: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(100_000),
        apply_at: z.enum(["next_turn", "next_round"]),
        expected_version: z.number().int().positive(),
        idempotency_key: z.string().trim().min(1),
      })
      .strict();

    app.get("/api/v2/capabilities/ai-models", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const models = configuredDebateModels().map((entry) => ({
        id: entry.model,
        provider: entry.provider,
        label: entry.label,
        configured: true,
        available: true,
      }));
      reply.header("Cache-Control", "no-store").send({ models });
    });

    app.get("/api/v2/projects/:id/debates", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      try {
        reply.send(await debates.list(id));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.post("/api/v2/projects/:id/debates", async (req, reply) => {
      const user = await resolveUser(req);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const body = CreateDebateBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      const { id: projectId } = req.params as { id: string };
      const hasArtifactContext =
        body.data.configuration.context_artifact_ids.length > 0 ||
        body.data.configuration.contexts.some(
          (context) =>
            context.artifact_id !== null ||
            context.artifact_content_hash !== null ||
            context.artifact_media_type !== null,
        );
      if (hasArtifactContext) {
        return reply.code(400).send({
          error: "artifact_contexts_not_supported",
          message:
            "debate MVP supports inline contexts only; artifact-backed contexts are unavailable",
        });
      }
      const selectable = new Set(
        configuredDebateModels().map((entry) => `${entry.provider}:${entry.model}`),
      );
      const enabledActors = body.data.configuration.actors.filter((actor) => actor.enabled);
      if (enabledActors.some((actor) => !selectable.has(`${actor.provider}:${actor.model}`))) {
        return reply.code(400).send({ error: "model_not_configured" });
      }
      try {
        const expectedProjectVersion =
          body.data.expected_project_version ?? (await debates.projectVersion(projectId));
        const command = V2CreateDebateCommand.parse({
          schema_version: 2,
          kind: "create_debate",
          command_id: newId("command"),
          command_family: "debate",
          actor: { actor_type: "human", actor_id: user.id },
          idempotency_key: body.data.idempotency_key,
          correlation_id: newId("correlation"),
          causation_id: null,
          issued_at: now().toISOString(),
          project_id: projectId,
          expected_project_version: expectedProjectVersion,
          title: body.data.configuration.title,
          question: body.data.configuration.question,
          phase_id: body.data.configuration.phase_id ?? null,
          stopping_policy: body.data.configuration.policy,
          actors: enabledActors.map((actor) => ({
            actor_kind: actor.actor_kind ?? actor.kind,
            role_label: actor.role_label,
            display_name: actor.display_name,
            instructions: actor.instructions,
            provider: actor.provider,
            model: actor.model,
            runtime: actor.runtime,
            position: actor.position,
            max_turns: actor.max_turns,
            max_input_tokens: actor.max_input_tokens,
            max_output_tokens: actor.max_output_tokens,
            budget_limit_usd: actor.budget_limit_usd,
          })),
          contexts: body.data.configuration.contexts,
        });
        reply.code(201).send(await debates.create(command));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.get("/api/v2/projects/:id/debates/:debateId", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, debateId } = req.params as { id: string; debateId: string };
      try {
        reply.send(await debates.get(id, debateId));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.post("/api/v2/projects/:id/debates/:debateId/runs", async (req, reply) => {
      const user = await resolveUser(req);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const body = StartDebateBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      const { id, debateId } = req.params as { id: string; debateId: string };
      try {
        const snapshot = await debates.get(id, debateId);
        const selectable = new Set(
          configuredDebateModels().map((entry) => `${entry.provider}:${entry.model}`),
        );
        if (
          snapshot.configuration.actors.some((actor) => {
            const provider = typeof actor.provider === "string" ? actor.provider : "";
            const model = typeof actor.model === "string" ? actor.model : "";
            return !selectable.has(`${provider}:${model}`);
          })
        ) {
          return reply.code(400).send({ error: "model_not_configured" });
        }
        const command = V2StartDebateRunCommand.parse({
          schema_version: 2,
          kind: "start_debate_run",
          command_id: newId("command"),
          command_family: "debate",
          actor: { actor_type: "human", actor_id: user.id },
          idempotency_key: body.data.idempotency_key,
          correlation_id: newId("correlation"),
          causation_id: null,
          issued_at: now().toISOString(),
          project_id: id,
          debate_id: debateId,
          expected_debate_version: body.data.expected_debate_version ?? snapshot.revision,
        });
        reply.code(201).send(await debates.start(command));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.get("/api/v2/projects/:id/debates/:debateId/runs/:runId", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, debateId, runId } = req.params as { id: string; debateId: string; runId: string };
      try {
        reply.send(await debates.getRun(id, debateId, runId));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.get("/api/v2/projects/:id/debates/:debateId/runs/:runId/events", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, debateId, runId } = req.params as { id: string; debateId: string; runId: string };
      const query = z
        .object({ after_version: z.coerce.number().int().nonnegative().default(0) })
        .safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: "bad_request" });
      try {
        reply.send(await debates.events(id, debateId, runId, query.data.after_version));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.post("/api/v2/projects/:id/debates/:debateId/runs/:runId/control", async (req, reply) => {
      const user = await resolveUser(req);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const body = ControlDebateBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      const { id, debateId, runId } = req.params as { id: string; debateId: string; runId: string };
      try {
        const command = V2ControlDebateRunCommand.parse({
          schema_version: 2,
          kind: "control_debate_run",
          command_id: newId("command"),
          command_family: "debate",
          actor: { actor_type: "human", actor_id: user.id },
          idempotency_key: body.data.idempotency_key,
          correlation_id: newId("correlation"),
          causation_id: null,
          issued_at: now().toISOString(),
          project_id: id,
          debate_id: debateId,
          debate_run_id: runId,
          expected_run_version: body.data.expected_version,
          action: body.data.action,
          reason: body.data.reason ?? body.data.action,
          ambiguity_disposition: body.data.ambiguity_disposition ?? null,
        });
        reply.send(await debates.control(command));
      } catch (error) {
        debateError(reply, error);
      }
    });

    app.post(
      "/api/v2/projects/:id/debates/:debateId/runs/:runId/interventions",
      async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const body = InterventionBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { id, debateId, runId } = req.params as {
          id: string;
          debateId: string;
          runId: string;
        };
        try {
          const command = V2InterveneDebateRunCommand.parse({
            schema_version: 2,
            kind: "intervene_debate_run",
            command_id: newId("command"),
            command_family: "debate",
            actor: { actor_type: "human", actor_id: user.id },
            idempotency_key: body.data.idempotency_key,
            correlation_id: newId("correlation"),
            causation_id: null,
            issued_at: now().toISOString(),
            project_id: id,
            debate_id: debateId,
            debate_run_id: runId,
            expected_run_version: body.data.expected_version,
            intervention_kind: body.data.kind,
            target_actor_id: body.data.target === "all" ? null : body.data.target,
            apply_at: body.data.apply_at,
            text: body.data.text,
          });
          reply.code(202).send(await debates.intervene(command));
        } catch (error) {
          debateError(reply, error);
        }
      },
    );
  }

  const github = options.integrations?.github ?? null;
  const githubError = (reply: FastifyReply, error: unknown): void => {
    if (error instanceof GitHubIntegrationError) {
      reply.code(error.status).send({ error: error.code, message: error.message });
      return;
    }
    throw error;
  };

  app.get("/api/integrations/github/status", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github) return reply.send(disabledGitHubStatus());
    try {
      reply.header("Cache-Control", "no-store").send(await github.status(user.id));
    } catch (error) {
      githubError(reply, error);
    }
  });

  const GitHubManifestStartQuery = z.object({
    owner_type: z.enum(["personal", "organization"]).default("personal"),
    organization: z.string().trim().max(39).optional(),
  });
  app.get("/api/integrations/github/manifest/start", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!github) {
      return reply.code(503).send({
        error: "github_manifest_unavailable",
        message: "Guided GitHub setup requires relational persistence",
      });
    }
    const query = GitHubManifestStartQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "bad_request" });
    if (query.data.owner_type === "organization" && !query.data.organization) {
      return reply.code(400).send({
        error: "organization_required",
        message: "Enter the GitHub organization that should own the App",
      });
    }
    try {
      const registration = github.manifestRegistration(
        user.id,
        query.data.owner_type === "organization" ? query.data.organization : undefined,
      );
      const cspNonce = nonce();
      reply
        .header("Cache-Control", "no-store")
        .header("Set-Cookie", manifestStateCookie(registration.state))
        .header(
          "Content-Security-Policy",
          `default-src 'none'; form-action https://github.com; script-src 'nonce-${cspNonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
        )
        .type("text/html")
        .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connecting GitHub…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0d0f12;color:#f5f3ee;font:16px system-ui;margin:3rem;line-height:1.5}button{padding:.75rem 1rem}</style>
</head><body><p>Opening GitHub to create your preconfigured App…</p>
<form method="post" action="${escapeHtml(registration.action)}">
<input type="hidden" name="manifest" value="${escapeHtml(registration.manifest)}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form><script nonce="${cspNonce}">document.forms[0].submit()</script></body></html>`);
    } catch (error) {
      githubError(reply, error);
    }
  });

  const GitHubManifestCallback = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
  });
  app.get("/api/integrations/github/manifest/callback", async (req, reply) => {
    clearManifestStateCookie(reply);
    if (!github)
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=disabled`);
    const query = GitHubManifestCallback.safeParse(req.query);
    const state = query.success
      ? (query.data.state ?? cookies(req).get(GITHUB_MANIFEST_STATE_COOKIE))
      : undefined;
    if (!query.success || query.data.error || !query.data.code || !state) {
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=denied`);
    }
    try {
      const stateUserId = github.manifestUserId(state);
      const currentUser = await resolveUser(req);
      if (currentUser && currentUser.id !== stateUserId) {
        return reply.redirect(
          `${externalOrigin(req)}/?settings=connections&github=invalid_oauth_state`,
        );
      }
      await github.completeManifest(stateUserId, query.data.code, state);
      stores.audit(
        currentUser?.email ?? stateUserId,
        "integration.github.app_created",
        stateUserId,
        now(),
      );
      return reply.redirect(github.authorizationUrl(stateUserId, "install"));
    } catch (error) {
      const code = error instanceof GitHubIntegrationError ? error.code : "failed";
      console.error(
        `GitHub manifest callback failed [${code}]: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      return reply.redirect(
        `${externalOrigin(req)}/?settings=connections&github=${encodeURIComponent(code)}`,
      );
    }
  });

  app.get("/api/integrations/github/authorize", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github || !github.isConfigured()) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    reply
      .header("Cache-Control", "no-store")
      .send({ authorization_url: github.authorizationUrl(user.id) });
  });

  app.get("/api/integrations/github/install", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github || !github.isConfigured()) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    reply
      .header("Cache-Control", "no-store")
      .send({ installation_url: github.installationUrl(user.id) });
  });

  const GitHubAuthorizationCallback = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
  });
  app.get("/api/integrations/github/callback", async (req, reply) => {
    if (!github)
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=disabled`);
    const query = GitHubAuthorizationCallback.safeParse(req.query);
    if (!query.success || query.data.error || !query.data.code || !query.data.state) {
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=denied`);
    }
    try {
      const stateUserId = github.authorizationUserId(query.data.state);
      const currentUser = await resolveUser(req);
      if (currentUser && currentUser.id !== stateUserId) {
        return reply.redirect(
          `${externalOrigin(req)}/?settings=connections&github=invalid_oauth_state`,
        );
      }
      const result = await github.completeAuthorization(
        stateUserId,
        query.data.code,
        query.data.state,
      );
      stores.audit(
        currentUser?.email ?? stateUserId,
        "integration.github.authorized",
        stateUserId,
        now(),
      );
      return reply.redirect(
        result.next === "install"
          ? github.installationUrl(stateUserId)
          : `${externalOrigin(req)}/?settings=connections&github=connected`,
      );
    } catch (error) {
      const code = error instanceof GitHubIntegrationError ? error.code : "failed";
      return reply.redirect(
        `${externalOrigin(req)}/?settings=connections&github=${encodeURIComponent(code)}`,
      );
    }
  });

  const GitHubSetupCallback = z.object({
    state: z.string().min(1).optional(),
    installation_id: z.string().min(1).optional(),
    setup_action: z.string().optional(),
  });
  app.get("/api/integrations/github/setup", async (req, reply) => {
    if (!github)
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=disabled`);
    const query = GitHubSetupCallback.safeParse(req.query);
    if (!query.success) {
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=failed`);
    }
    try {
      if (!query.data.state) {
        return reply.redirect(
          `${externalOrigin(req)}/?settings=connections&github=invalid_oauth_state`,
        );
      }
      const stateUserId = github.installationUserId(query.data.state);
      const currentUser = await resolveUser(req);
      if (currentUser && currentUser.id !== stateUserId) {
        return reply.redirect(
          `${externalOrigin(req)}/?settings=connections&github=invalid_oauth_state`,
        );
      }
      await github.completeInstallation(stateUserId, query.data.state);
      stores.audit(
        currentUser?.email ?? stateUserId,
        "integration.github.installed",
        query.data.installation_id ?? "installation synchronized",
        now(),
      );
      return reply.redirect(`${externalOrigin(req)}/?settings=connections&github=installed`);
    } catch (error) {
      const code = error instanceof GitHubIntegrationError ? error.code : "failed";
      return reply.redirect(
        `${externalOrigin(req)}/?settings=connections&github=${encodeURIComponent(code)}`,
      );
    }
  });

  app.get("/api/integrations/github/connections/:id/repositories", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    const { id } = req.params as { id: string };
    const query = z.object({ q: z.string().max(200).optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "bad_request" });
    try {
      reply.send(await github.listRepositories(user.id, id, query.data.q));
    } catch (error) {
      githubError(reply, error);
    }
  });

  const CreateGitHubRepositoryBody = z.object({
    connection_id: z.string().min(1),
    name: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .max(100),
    description: z.string().max(350).default(""),
    private: z.boolean().default(true),
    auto_init: z.boolean().default(true),
  });
  app.post("/api/integrations/github/repositories", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    const body = CreateGitHubRepositoryBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const repository = await github.createRepository(user.id, body.data);
      stores.audit(
        user.email,
        "integration.github.repository_created",
        repository.full_name,
        now(),
      );
      reply.code(201).send(repository);
    } catch (error) {
      githubError(reply, error);
    }
  });

  app.delete("/api/integrations/github/connections/:id", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!github) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    const { id } = req.params as { id: string };
    try {
      await github.disconnect(id);
      stores.audit(user.email, "integration.github.disconnected", id, now());
      reply.code(204).send();
    } catch (error) {
      githubError(reply, error);
    }
  });

  app.post("/api/integrations/github/connections/:id/reconnect", async (req, reply) => {
    const user = await requireAdmin(req, reply);
    if (!user) return;
    if (!github) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    const { id } = req.params as { id: string };
    try {
      await github.reconnect(id);
      stores.audit(user.email, "integration.github.reconnected", id, now());
      reply.send({ status: "connected" });
    } catch (error) {
      githubError(reply, error);
    }
  });

  // ---- multi-project management: create/list projects; plan, edit, and ------
  // ---- allocate each one's own graph ------------------------------------------

  const projects = options.projects ? projectRepository(options.projects) : undefined;
  if (projects !== undefined) {
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
      if (error instanceof Phase3RequiredError) {
        reply
          .code(409)
          .send({ error: error.code, operation: error.operation, message: error.message });
        return;
      }
      throw error;
    };

    const sendGraph = (
      reply: FastifyReply,
      view: ProjectGraphView,
      extra: Record<string, unknown> = {},
    ): void => {
      // ADR-1: every graph response carries the server-authoritative approval
      // status, with `current` computed against the live version/fingerprint.
      reply.send({
        ...view.graph,
        cost: view.cost,
        approval: view.approval,
        ...extra,
      });
    };

    app.get("/api/projects", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      reply.send(await projects.list());
    });

    const CreateProjectFields = {
      name: z.string().min(1),
      description: z.string().min(1),
      source_type: z.enum(["local", "github"]).optional(),
      source_location: z.string().trim().min(1).optional(),
      github_connection_id: z.string().min(1).optional(),
      github_repository_id: z.string().min(1).optional(),
    };
    const CreateProjectBody = z
      .discriminatedUnion("pm_provider", [
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
      ])
      .superRefine((value, context) => {
        if (value.source_type === "local" || value.source_location) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: value.source_location ? ["source_location"] : ["source_type"],
            message:
              "raw local paths are not accepted; create the project and bind a runner selection token",
          });
        }
        if (value.source_type === "github" && !value.github_connection_id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["github_connection_id"],
            message: "select a GitHub connection",
          });
        }
        if (value.source_type === "github" && !value.github_repository_id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["github_repository_id"],
            message: "select a GitHub repository",
          });
        }
        if (
          value.source_type !== "github" &&
          (value.github_connection_id || value.github_repository_id)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source_type"],
            message: "GitHub repository selection requires source_type=github",
          });
        }
      });
    app.post("/api/projects", async (req, reply) => {
      const user = await resolveUser(req);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const body = CreateProjectBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      let resolvedGitHubRepository:
        | Awaited<ReturnType<GitHubIntegrationService["resolveRepository"]>>
        | undefined;
      if (body.data.source_type === "github") {
        if (!github) {
          return reply.code(503).send({
            error: "github_not_configured",
            message: "GitHub App is not configured",
          });
        }
        try {
          resolvedGitHubRepository = await github.resolveRepository(
            user.id,
            body.data.github_connection_id ?? "",
            body.data.github_repository_id ?? "",
          );
        } catch (error) {
          return githubError(reply, error);
        }
      }
      const project = await projects.create({
        name: body.data.name,
        description: body.data.description,
        pmProvider: body.data.pm_provider,
        pmModel: body.data.pm_model,
        ...(body.data.source_type ? { sourceType: body.data.source_type } : {}),
        ...(resolvedGitHubRepository
          ? {
              sourceLocation: resolvedGitHubRepository.clone_url,
              sourceConnectionId: resolvedGitHubRepository.connection_id,
              sourceRepositoryId: resolvedGitHubRepository.id,
              sourceDefaultBranch: resolvedGitHubRepository.default_branch,
            }
          : {}),
      });
      stores.audit(
        user.email,
        "project.created",
        `${project.id} ${project.name} pm=${project.pm_provider}:${project.pm_model}`,
        now(),
      );
      reply.code(201).send(project);
    });

    app.get("/api/projects/:id", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      try {
        reply.send(await projects.summary(id));
      } catch (error) {
        projectError(reply, error);
      }
    });

    if (options.phase3) {
      const LocalBindingBody = z.object({
        selection_token: z.string().min(1),
        verification_policy_ref: z.string().min(1),
      });
      const GitHubBindingBody = z.object({
        runner_id: z.string().min(1),
        github_installation_id: z.string().min(1),
        github_repository_id: z.string().min(1),
        owner: z.string().min(1),
        name: z.string().min(1),
        default_branch: z.string().min(1),
        observed_head: z.string().min(1),
        verification_policy_ref: z.string().min(1),
        granted_permissions: z.object({
          metadata: z.literal("read"),
          contents: z.enum(["read", "write"]),
          pull_requests: z.enum(["none", "read", "write"]),
          checks: z.enum(["none", "read"]),
          actions: z.enum(["none", "read"]),
        }),
      });
      const CreatePhaseBody = z.object({
        objective_summary: z.string().min(1),
        priority: z.number().int().nonnegative(),
        predecessor_phase_ids: z.array(z.string().min(1)).default([]),
        expected_project_version: z.number().int().positive(),
        idempotency_key: z.string().min(1),
      });
      const ApproveStrategyBody = z.object({
        phase_id: z.string().min(1),
        expected_phase_version: z.number().int().positive(),
        expected_strategy_version: z.number().int().positive(),
        expected_strategy_aggregate_version: z.number().int().positive(),
        expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/),
        idempotency_key: z.string().min(1),
      });

      // ---- FRONT DOOR P3: planning-run -> strategy bridge -------------------
      // High-level routes that turn a completed planning run into an editable,
      // staffed, approvable StrategyVersion. They reuse the phase-3 workflow
      // services above (no parallel lifecycle); see strategyBridgeService.ts.
      const bridge = options.phase3.bridge;
      const CreatePhaseFromRunBody = z
        .object({
          planning_run_id: z.string().trim().min(1),
          name: z.string().trim().min(1).max(200).optional(),
        })
        .strict();
      const StaffingEditBody = z
        .object({
          assignments: z
            .array(
              z
                .object({
                  assignment_id: z.string().trim().min(1),
                  provider: z.string().trim().min(1).optional(),
                  model: z.string().trim().min(1).optional(),
                  reviewer_provider: z.string().trim().min(1).optional(),
                  reviewer_model: z.string().trim().min(1).optional(),
                  clear_reviewer: z.boolean().optional(),
                  budget_limit_usd: z.number().nonnegative().optional(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict();
      const ApproveFromBridgeBody = z
        .object({
          expected_content_hash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          idempotency_key: z.string().trim().min(1).optional(),
        })
        .strict();
      const bridgeActor = (user: IdentityUser): StrategyBridgeActor => ({ actor_id: user.id });
      const sendBridgeError = (reply: FastifyReply, error: unknown): void => {
        if (error instanceof StrategyBridgeError) {
          const notFound: string[] = ["planning_run_not_found", "phase_not_found"];
          reply
            .code(notFound.includes(error.code) ? 404 : 409)
            .send({ error: error.code, message: error.message });
          return;
        }
        if (
          error instanceof StrategyWorkflowConflictError ||
          error instanceof PhaseWorkflowConflictError
        ) {
          reply.code(409).send({ error: "strategy_conflict", detail: String(error) });
          return;
        }
        throw error;
      };

      const workspaceRequest = async (
        runnerId: string,
        input: {
          operation: "list" | "browse" | "validate" | "choose";
          workspace_id?: string;
          entry_id?: string;
        },
      ) => {
        const runner = stores.runner(runnerId);
        const reconciled = reconciledWorkspaceRunners.get(runnerId);
        if (
          !runner ||
          !reconciled ||
          reconciled.socket !== runnerSockets.get(runnerId) ||
          reconciled.generation !== runner.generation
        )
          throw new WorkspaceBrokerError("runner_unavailable");
        if (!reconciled.workspacePicker) throw new WorkspaceBrokerError("runner_upgrade_required");
        const generation = runner.generation;
        const response = await workspaceBroker.request(runnerId, generation, input);
        return { response, generation };
      };
      const workspaceFailure = (reply: FastifyReply, error: unknown): FastifyReply => {
        // Stable public codes only: never serialize runner/OS failure messages.
        const code = error instanceof WorkspaceBrokerError ? error.code : "runner_unavailable";
        return reply.code(code === "request_limit" ? 429 : code === "timeout" ? 504 : 409).send({
          error: code,
          ...(code === "runner_upgrade_required"
            ? { message: "Update this local runner to use folder selection." }
            : {}),
        });
      };

      app.get("/api/runners/:runnerId/workspaces", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { runnerId } = req.params as { runnerId: string };
        try {
          const { response } = await workspaceRequest(runnerId, { operation: "list" });
          if (response.status !== "ok") return reply.code(409).send({ error: response.status });
          const runner = stores.runner(runnerId);
          reply.send({
            runner_id: runnerId,
            generation: runner?.generation ?? 0,
            workspaces: response.workspaces ?? [],
          });
        } catch (error) {
          return workspaceFailure(reply, error);
        }
      });

      app.post("/api/runners/:runnerId/workspaces/choose", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const { runnerId } = req.params as { runnerId: string };
        try {
          const { response, generation } = await workspaceRequest(runnerId, {
            operation: "choose",
          });
          if (response.status === "cancelled") return reply.send({ cancelled: true });
          if (response.status !== "ok" || !response.repository) {
            return reply.code(response.status === "invalid_request" ? 422 : 409).send({
              error: response.status,
              message:
                response.status === "invalid_request"
                  ? "Choose the root folder of a Git repository with at least one commit."
                  : "The local folder chooser is unavailable.",
            });
          }
          const runner = stores.runner(runnerId);
          const reconciled = reconciledWorkspaceRunners.get(runnerId);
          if (
            !runner ||
            !reconciled ||
            reconciled.socket !== runnerSockets.get(runnerId) ||
            reconciled.generation !== generation ||
            runner.generation !== generation ||
            !reconciled.workspacePicker
          ) {
            return reply.code(409).send({ error: "runner_unavailable" });
          }
          const grant = workspaceSelections.issue(
            user.id,
            runnerId,
            generation,
            response.repository,
          );
          reply.send({
            ...grant,
            repository: { runner_id: runnerId, ...response.repository },
          });
        } catch (error) {
          return workspaceFailure(reply, error);
        }
      });

      app.post("/api/runners/:runnerId/workspaces/browse", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const body = z
          .object({ workspace_id: z.string().min(1), entry_id: z.string().min(1).optional() })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { runnerId } = req.params as { runnerId: string };
        try {
          const { response } = await workspaceRequest(runnerId, {
            operation: "browse",
            workspace_id: body.data.workspace_id,
            ...(body.data.entry_id ? { entry_id: body.data.entry_id } : {}),
          });
          if (response.status !== "ok") return reply.code(409).send({ error: response.status });
          reply.send({
            runner_id: runnerId,
            workspace_id: body.data.workspace_id,
            entries: response.entries ?? [],
          });
        } catch (error) {
          return workspaceFailure(reply, error);
        }
      });

      app.post("/api/runners/:runnerId/workspaces/validate", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const body = z
          .object({ workspace_id: z.string().min(1), entry_id: z.string().min(1) })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { runnerId } = req.params as { runnerId: string };
        try {
          const { response, generation } = await workspaceRequest(runnerId, {
            operation: "validate",
            ...body.data,
          });
          if (response.status !== "ok" || !response.repository)
            return reply.code(409).send({ error: response.status });
          const runner = stores.runner(runnerId);
          const reconciled = reconciledWorkspaceRunners.get(runnerId);
          if (
            !runner ||
            !reconciled ||
            reconciled.socket !== runnerSockets.get(runnerId) ||
            reconciled.generation !== generation ||
            runner.generation !== generation ||
            !reconciled.workspacePicker
          )
            return reply.code(409).send({ error: "runner_unavailable" });
          const grant = workspaceSelections.issue(
            user.id,
            runnerId,
            generation,
            response.repository,
          );
          reply.send({ ...grant, repository: { runner_id: runnerId, ...response.repository } });
        } catch (error) {
          return workspaceFailure(reply, error);
        }
      });

      app.get("/api/v2/projects/:id/resume", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          reply.send(await options.phase3?.resume.open(id));
        } catch (error) {
          reply.code(404).send({ error: "project_not_found", detail: String(error) });
        }
      });

      app.post("/api/v2/projects/:id/source-bindings/local", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const body = LocalBindingBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { id } = req.params as { id: string };
        const reserved = workspaceSelections.reserve(user.id, body.data.selection_token);
        if (!reserved) return reply.code(409).send({ error: "local_selection_invalid" });
        const selection = reserved.selection;
        const currentRunner = stores.runner(selection.runner_id);
        if (
          !currentRunner ||
          reconciledWorkspaceRunners.get(selection.runner_id)?.socket !==
            runnerSockets.get(selection.runner_id) ||
          reconciledWorkspaceRunners.get(selection.runner_id)?.generation !==
            selection.runner_generation ||
          reconciledWorkspaceRunners.get(selection.runner_id)?.workspacePicker !== true ||
          currentRunner.generation !== selection.runner_generation
        ) {
          workspaceSelections.release(body.data.selection_token, reserved.reservation_id);
          return reply.code(409).send({ error: "local_selection_invalid" });
        }
        try {
          const binding = await options.phase3?.sourceBindings.createLocal({
            project_id: id,
            runner_id: selection.runner_id,
            workspace_id: selection.workspace_id,
            repository_id: selection.repository_id,
            repository_display_name: selection.repository_display_name,
            default_branch: selection.default_branch,
            observed_head: selection.observed_head,
            verification_policy_ref: body.data.verification_policy_ref,
            created_by: { actor_type: "human", actor_id: user.id },
          });
          workspaceSelections.commit(body.data.selection_token, reserved.reservation_id);
          reply.code(201).send(binding);
        } catch (error) {
          workspaceSelections.release(body.data.selection_token, reserved.reservation_id);
          reply.code(409).send({ error: "source_binding_conflict" });
        }
      });

      app.post("/api/v2/projects/:id/source-bindings/github", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const body = GitHubBindingBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { id } = req.params as { id: string };
        try {
          reply.code(201).send(
            await options.phase3?.sourceBindings.createGitHub({
              project_id: id,
              ...body.data,
              created_by: { actor_type: "human", actor_id: user.id },
            }),
          );
        } catch (error) {
          reply.code(409).send({ error: "source_binding_conflict", detail: String(error) });
        }
      });

      app.post("/api/v2/projects/:id/ingest", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const { id } = req.params as { id: string };
        const body = V2RepositoryIngestionSeed.safeParse({
          ...(typeof req.body === "object" && req.body !== null ? req.body : {}),
          project_id: id,
          created_by: { actor_type: "human", actor_id: user.id },
        });
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          reply.send(await options.phase3?.ingestion.ingest(body.data));
        } catch (error) {
          reply.code(409).send({ error: "ingestion_conflict", detail: String(error) });
        }
      });

      app.post("/api/v2/projects/:id/phases", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const { id } = req.params as { id: string };
        // FRONT DOOR P3: a { planning_run_id } body materializes a completed
        // planning run into a phase + proposed StrategyVersion via the bridge.
        // Any other body keeps the pre-existing raw create-phase behavior.
        if (typeof req.body === "object" && req.body !== null && "planning_run_id" in req.body) {
          const fromRun = CreatePhaseFromRunBody.safeParse(req.body);
          if (!fromRun.success) return reply.code(400).send({ error: "bad_request" });
          try {
            reply.code(201).send(
              await bridge.createPhaseFromPlanningRun({
                projectId: id,
                planningRunId: fromRun.data.planning_run_id,
                ...(fromRun.data.name !== undefined ? { name: fromRun.data.name } : {}),
                actor: bridgeActor(user),
              }),
            );
          } catch (error) {
            sendBridgeError(reply, error);
          }
          return;
        }
        const body = CreatePhaseBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          reply.code(201).send(
            await options.phase3?.phases.create({
              schema_version: 2,
              command_id: newId("command"),
              kind: "create_phase",
              command_family: "phase",
              actor: { actor_type: "human", actor_id: user.id },
              idempotency_key: body.data.idempotency_key,
              correlation_id: newId("correlation"),
              causation_id: null,
              issued_at: now().toISOString(),
              project_id: id,
              objective_summary: body.data.objective_summary,
              priority: body.data.priority,
              predecessor_phase_ids: body.data.predecessor_phase_ids,
              expected_project_version: body.data.expected_project_version,
            }),
          );
        } catch (error) {
          reply.code(409).send({ error: "phase_conflict", detail: String(error) });
        }
      });

      app.post("/api/v2/projects/:id/strategies", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        const body = V2StrategyVersion.safeParse(req.body);
        if (!body.success || body.data.project_id !== id) {
          return reply.code(400).send({ error: "bad_request" });
        }
        try {
          reply.code(201).send(await options.phase3?.strategies.saveAwaitingApproval(body.data));
        } catch (error) {
          reply.code(409).send({ error: "strategy_conflict", detail: String(error) });
        }
      });

      app.post("/api/v2/projects/:id/strategies/:strategyId/approve", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const body = ApproveStrategyBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { id, strategyId } = req.params as { id: string; strategyId: string };
        try {
          reply.send(
            await options.phase3?.strategies.approve({
              schema_version: 2,
              command_id: newId("command"),
              kind: "approve_strategy_version",
              command_family: "strategy_approval",
              actor: { actor_type: "human", actor_id: user.id },
              idempotency_key: body.data.idempotency_key,
              correlation_id: newId("correlation"),
              causation_id: null,
              issued_at: now().toISOString(),
              project_id: id,
              phase_id: body.data.phase_id,
              strategy_version_id: strategyId,
              expected_phase_version: body.data.expected_phase_version,
              expected_strategy_version: body.data.expected_strategy_version,
              expected_strategy_aggregate_version: body.data.expected_strategy_aggregate_version,
              expected_content_hash: body.data.expected_content_hash,
            }),
          );
        } catch (error) {
          reply.code(409).send({ error: "strategy_approval_conflict", detail: String(error) });
        }
      });

      // ---- FRONT DOOR P3: proposed-strategy review, staffing, approval -----
      // GET  the plan-review DTO the Plan Review screen renders.
      app.get("/api/v2/projects/:id/phases/:phaseId/strategy", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id, phaseId } = req.params as { id: string; phaseId: string };
        try {
          reply.header("Cache-Control", "no-store").send(await bridge.review(id, phaseId));
        } catch (error) {
          sendBridgeError(reply, error);
        }
      });

      // PATCH assignment proposals (provider/model/reviewer/budget) on the
      // proposed strategy. An edit mints a superseding StrategyVersion — it
      // never mutates an already-approved one (existing staleness semantics).
      app.patch("/api/v2/projects/:id/phases/:phaseId/strategy/staffing", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const { id, phaseId } = req.params as { id: string; phaseId: string };
        const body = StaffingEditBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          reply.send(
            await bridge.editStaffing({
              projectId: id,
              phaseId,
              edits: body.data.assignments,
              actor: bridgeActor(user),
            }),
          );
        } catch (error) {
          sendBridgeError(reply, error);
        }
      });

      // POST approval — reuses StrategyWorkflowService.approve verbatim, which
      // materializes tasks + dependencies and readies the phase for the
      // coordinator. No new approval semantics.
      app.post("/api/v2/projects/:id/phases/:phaseId/strategy/approve", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const { id, phaseId } = req.params as { id: string; phaseId: string };
        const body = ApproveFromBridgeBody.safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          reply.send(
            await bridge.approve({
              projectId: id,
              phaseId,
              ...(body.data.expected_content_hash !== undefined
                ? { expectedContentHash: body.data.expected_content_hash }
                : {}),
              ...(body.data.idempotency_key !== undefined
                ? { idempotencyKey: body.data.idempotency_key }
                : {}),
              actor: bridgeActor(user),
            }),
          );
        } catch (error) {
          sendBridgeError(reply, error);
        }
      });
    }

    if (options.phase4) {
      const ScheduleTaskBody = z.object({
        assignment_id: z.string().min(1),
        runner_id: z.string().min(1),
        context_refs: z.array(V2ContentAddressedReference).min(1),
        target_branch: z.string().min(1),
        worktree_policy_ref: z.string().min(1),
        sandbox_policy_ref: z.string().min(1),
        max_input_tokens: z.number().int().positive(),
        max_output_tokens: z.number().int().positive(),
        max_duration_seconds: z.number().int().positive(),
      });
      const CompleteTaskBody = z.object({
        run_id: z.string().min(1),
        review_evidence: z.array(V2EvidenceRef).min(1),
        integration_evidence: z.array(V2EvidenceRef).min(1),
        review_summary: z.string().min(1),
      });

      app.post(
        "/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/schedule",
        async (req, reply) => {
          if (!(await requireSession(req, reply))) return;
          const user = await resolveUser(req);
          if (!user) return;
          const body = ScheduleTaskBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: "bad_request" });
          const { id, phaseId, taskId } = req.params as {
            id: string;
            phaseId: string;
            taskId: string;
          };
          const runner = stores.runner(body.data.runner_id);
          if (!runner) return reply.code(409).send({ error: "runner_unavailable" });
          const issuedAt = now();
          try {
            reply.code(202).send(
              await options.phase4?.coordinator.schedule({
                project_id: id,
                phase_id: phaseId,
                task_id: taskId,
                ...body.data,
                runner_generation: runner.generation,
                authorized_by: { actor_type: "human", actor_id: user.id },
                authorized_by_session_id: `authenticated-request:${req.id}`,
                correlation_id: newId("correlation"),
                causation_id: null,
                issued_at: issuedAt.toISOString(),
                expires_at: new Date(issuedAt.getTime() + DEFAULT_COMMAND_TTL_MS).toISOString(),
              }),
            );
          } catch (error) {
            reply.code(409).send({ error: "schedule_conflict", detail: String(error) });
          }
        },
      );

      app.post(
        "/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/complete",
        async (req, reply) => {
          if (!(await requireSession(req, reply))) return;
          const user = await resolveUser(req);
          if (!user) return;
          const body = CompleteTaskBody.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: "bad_request" });
          const { id, phaseId, taskId } = req.params as {
            id: string;
            phaseId: string;
            taskId: string;
          };
          try {
            reply.send(
              await options.phase4?.completion.complete({
                project_id: id,
                phase_id: phaseId,
                task_id: taskId,
                ...body.data,
                actor: { actor_type: "human", actor_id: user.id },
                correlation_id: newId("correlation"),
                completed_at: now().toISOString(),
              }),
            );
          } catch (error) {
            reply.code(409).send({ error: "completion_conflict", detail: String(error) });
          }
        },
      );
    }

    if (options.phase6) {
      const AgentReviewBody = z.object({
        run_id: z.string().min(1),
        reviewer_agent_profile_id: z.string().min(1),
        decision: z.enum(["approved", "rework", "escalated"]),
        summary: z.string().min(1),
        evidence: z.array(V2EvidenceRef).min(1),
      });
      app.post(
        "/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/allocate",
        async (req, reply) => {
          if (!(await requireSession(req, reply))) return;
          const { id, phaseId, taskId } = req.params as {
            id: string;
            phaseId: string;
            taskId: string;
          };
          try {
            const allocation = await options.phase6?.coordination.allocate(
              taskId,
              now().toISOString(),
            );
            if (allocation?.project_id !== id || allocation.phase_id !== phaseId) {
              return reply.code(404).send({ error: "task_not_found" });
            }
            reply.send(allocation);
          } catch (error) {
            reply.code(409).send({ error: "allocation_conflict", detail: String(error) });
          }
        },
      );
      app.get("/api/v2/projects/:id/phases/:phaseId/coordination", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id, phaseId } = req.params as { id: string; phaseId: string };
        try {
          reply.send(await options.phase6?.coordination.snapshot(id, phaseId, now().toISOString()));
        } catch (error) {
          reply.code(404).send({ error: "phase_not_found", detail: String(error) });
        }
      });
      app.post("/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/review", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const body = AgentReviewBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { id, phaseId, taskId } = req.params as {
          id: string;
          phaseId: string;
          taskId: string;
        };
        try {
          reply.send(
            await options.phase6?.coordination.recordReview({
              project_id: id,
              phase_id: phaseId,
              task_id: taskId,
              ...body.data,
              created_at: now().toISOString(),
            }),
          );
        } catch (error) {
          reply.code(409).send({ error: "review_conflict", detail: String(error) });
        }
      });
    }

    if (options.phase5) {
      const AttentionDispositionBody = z
        .object({
          item_key: z.string().min(1),
          condition_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          disposition: z.enum(["acknowledged", "snoozed"]),
          snoozed_until: z.string().datetime().nullable(),
        })
        .strict();

      app.get("/api/v2/attention", async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        reply.send(await options.phase5?.attention.portfolio(user.id));
      });

      app.post("/api/v2/attention/disposition", async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const body = AttentionDispositionBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          await options.phase5?.attention.disposition({ user_id: user.id, ...body.data });
          reply.code(204).send();
        } catch (error) {
          reply.code(409).send({ error: "stale_attention_item", detail: String(error) });
        }
      });

      app.post(
        "/api/v2/projects/:id/decision-points/:decisionPointId/resolve",
        async (req, reply) => {
          const user = await resolveUser(req);
          if (!user) return reply.code(401).send({ error: "unauthorized" });
          const { id, decisionPointId } = req.params as { id: string; decisionPointId: string };
          const body = V2DecisionResolutionRequest.safeParse(req.body);
          if (!body.success) return reply.code(400).send({ error: "bad_request" });
          try {
            reply.send(
              await options.phase5?.attention.resolveDecision({
                user_id: user.id,
                project_id: id,
                decision_point_id: decisionPointId,
                ...body.data,
              }),
            );
          } catch (error) {
            if (error instanceof DecisionResolutionError) {
              const status =
                error.code === "decision_not_found"
                  ? 404
                  : error.code === "invalid_option"
                    ? 400
                    : 409;
              return reply.code(status).send({ error: error.code, detail: error.message });
            }
            throw error;
          }
        },
      );

      app.post("/api/v2/projects/:id/directions", async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const { id } = req.params as { id: string };
        const body = V2HumanDirectionRequest.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          reply.send(
            await options.phase5?.attention.recordDirection({
              user_id: user.id,
              project_id: id,
              direction_target: body.data.direction_target,
              direction_text: body.data.direction_text,
              idempotency_key: body.data.idempotency_key,
              ...(body.data.phase_id !== undefined ? { phase_id: body.data.phase_id } : {}),
              ...(body.data.task_id !== undefined ? { task_id: body.data.task_id } : {}),
            }),
          );
        } catch (error) {
          if (error instanceof DecisionResolutionError) {
            const status = error.code === "scope_not_found" ? 404 : 409;
            return reply.code(status).send({ error: error.code, detail: error.message });
          }
          throw error;
        }
      });

      app.get("/api/v2/projects/:id/phases/:phaseId/execution", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id, phaseId } = req.params as { id: string; phaseId: string };
        try {
          reply.send(await options.phase5?.attention.phase(id, phaseId));
        } catch (error) {
          reply.code(404).send({ error: "phase_not_found", detail: String(error) });
        }
      });
    }

    app.get("/api/projects/:id/graph", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      try {
        sendGraph(reply, await projects.graph(id));
      } catch (error) {
        projectError(reply, error);
      }
    });

    const EdgeBody = z.object({ from: z.string().min(1), to: z.string().min(1) });
    app.post("/api/projects/:id/graph/edges", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      const body = EdgeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const view = await projects.addEdge(id, body.data.from, body.data.to);
        stores.audit(
          "operator",
          "graph.edge_added",
          `${id}:${body.data.from}->${body.data.to}`,
          now(),
        );
        sendGraph(reply, view);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/projects/:id/graph/edges", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      const body = EdgeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const view = await projects.removeEdge(id, body.data.from, body.data.to);
        stores.audit(
          "operator",
          "graph.edge_removed",
          `${id}:${body.data.from}->${body.data.to}`,
          now(),
        );
        sendGraph(reply, view);
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
    app.post("/api/projects/:id/graph/nodes", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      const body = NodeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const view = await projects.addNode(id, body.data);
        stores.audit("operator", "graph.node_added", `${id}:${body.data.id}`, now());
        sendGraph(reply, view);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/projects/:id/graph/nodes/:nodeId", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, nodeId } = req.params as { id: string; nodeId: string };
      const { mode } = req.query as { mode?: "reparent" | "cascade" };
      try {
        const { removed, view } = await projects.removeNode(id, nodeId, mode);
        stores.audit("operator", "graph.node_removed", `${id}:${removed.join(",")}`, now());
        sendGraph(reply, view);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.post("/api/projects/:id/graph/allocate", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      const body = z.object({ strategy: AllocationStrategy }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const view = await projects.allocate(id, body.data.strategy);
        stores.audit("operator", "graph.auto_allocated", `${id}:${body.data.strategy}`, now());
        sendGraph(reply, view);
      } catch (error) {
        projectError(reply, error);
      }
    });

    const RecommendAllocationBody = z
      .object({ objective: z.string().trim().min(1).max(100_000).optional() })
      .strict();
    app.post("/api/projects/:id/graph/recommend-allocation", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      const body = RecommendAllocationBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const [summary, graphView, pmSelection] = await Promise.all([
          projects.summary(id),
          projects.graph(id),
          projects.pmSelectionOf(id),
        ]);
        const pmModel =
          pmSelection.model ??
          (pmSelection.provider === "anthropic"
            ? (integrationEnvironment.NORNS_PM_MODEL ?? DEFAULT_PM_MODEL.anthropic)
            : (integrationEnvironment.NORNS_OPENAI_MODEL ?? DEFAULT_PM_MODEL.openai));
        const pm = buildPlanningAdapter(pmSelection.provider, pmModel);
        stores.audit(
          "operator",
          "allocation.pm_recommendation_started",
          `${id} pm=${pm.provider}:${pm.model}`,
          now(),
        );
        const recommendation = await recommendProjectAllocation({
          pm,
          projectId: id,
          projectName: summary.name,
          objective: body.data.objective ?? summary.plan_objective ?? summary.description,
          graph: graphView.graph,
          models: configuredWorkerModels(),
        });
        const view = await projects.applyPmAllocation(id, recommendation.recommendations);
        options.recordUsage?.([recommendation.usage]);
        stores.audit(
          "operator",
          "allocation.pm_recommended",
          `${id} pm=${pm.provider}:${pm.model} nodes=${recommendation.recommendations.length} cost_usd=${view.cost.total_usd}`,
          now(),
        );
        sendGraph(reply, view, {
          allocation_advice: {
            summary: recommendation.summary,
            pm_provider: pm.provider,
            pm_model: pm.model,
          },
        });
      } catch (error) {
        stores.audit(
          "operator",
          "allocation.pm_recommendation_failed",
          `${id}:${error instanceof Error ? error.message : String(error)}`,
          now(),
        );
        if (error instanceof AllocationRecommendationError) {
          return reply.code(error.code === "models_unavailable" ? 501 : 422).send({
            error: error.code,
            message: error.message,
          });
        }
        if (error instanceof AdapterError) {
          return reply.code(502).send({ error: error.kind, message: error.message });
        }
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
    app.post("/api/projects/:id/graph/nodes/:nodeId/assignment", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, nodeId } = req.params as { id: string; nodeId: string };
      const body = OverrideBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const view = await projects.overrideAssignment(id, nodeId, body.data);
        stores.audit("operator", "graph.assignment_overridden", `${id}:${nodeId}`, now());
        sendGraph(reply, view);
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.post("/api/projects/:id/graph/approve-allocation", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      try {
        const approval = await projects.approveAllocation(id, "operator");
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
    app.post("/api/projects/:id/plan", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      let pmSelection: { provider: ProviderName; model: string | null };
      try {
        pmSelection = await projects.pmSelectionOf(id);
      } catch (error) {
        projectError(reply, error);
        return;
      }
      const body = PlanRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });

      const anthropicKey = integrationEnvironment.ANTHROPIC_API_KEY;
      const openaiKey = integrationEnvironment.OPENAI_API_KEY;
      const reviewerProvider = reviewerFor(pmSelection.provider);
      const pmModel =
        pmSelection.model ??
        (pmSelection.provider === "anthropic"
          ? (integrationEnvironment.NORNS_PM_MODEL ?? DEFAULT_PM_MODEL.anthropic)
          : integrationEnvironment.NORNS_OPENAI_MODEL);
      const reviewerModel =
        reviewerProvider === "openai"
          ? integrationEnvironment.NORNS_OPENAI_MODEL
          : (integrationEnvironment.NORNS_REVIEWER_ANTHROPIC_MODEL ??
            integrationEnvironment.NORNS_PM_MODEL ??
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

      const pm = buildPlanningAdapter(pmSelection.provider, pmModel as string);
      const reviewer = buildPlanningAdapter(reviewerProvider, reviewerModel as string);

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
          versions: result.versions.map((version) => ({
            version: version.version,
            findings: version.findings,
            responses: version.responses,
          })),
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
    app.post("/api/projects/:id/plan/load", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id } = req.params as { id: string };
      const body = LoadPlanBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      try {
        const view = await projects.loadPlan(id, body.data.plan);
        stores.audit("operator", "graph.plan_loaded", `${id}:${body.data.plan.objective}`, now());
        sendGraph(reply, view);
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

    // ---- durable planning runs (FRONT DOOR P2 §D1) --------------------------
    // A user-configurable, observable wrapper around the runPlanning() loop
    // above: rounds, reviewer selection, and the terminal result/failure are
    // held in a durable, pollable record (planning_runs) instead of only a
    // single request/response. Fully additive — its own tables
    // (drizzle/0012_planning_runs.sql) and its own route surface; the
    // existing /api/projects/:id/plan route above is untouched.
    if (options.planningRuns) {
      const { transactions: planningTransactions } = options.planningRuns;
      const planningRunService = new PlanningRunService(planningTransactions);
      const resolvePlanningModels = async (projectId: string) => {
        const [pmSelection, persistedReviewer] = await Promise.all([
          projects.pmSelectionOf(projectId),
          planningRunService.reviewerSelectionOf(projectId),
        ]);
        // Throws PlanningConfigurationError when the deployment lacks what's
        // needed; the worker catches it and records a truthful failure.
        return resolvePlanningParticipants({
          pmSelection,
          persistedReviewer,
          env: integrationEnvironment,
          defaultPmModel: DEFAULT_PM_MODEL,
        });
      };
      const planningWorker = new PlanningRunWorker(planningTransactions, buildPlanningAdapter, {
        resolveModels: resolvePlanningModels,
        ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
        buildStaffingProposal: async ({
          projectId,
          objective,
          plan,
        }): Promise<PlanningStaffingProposalDto | null> => {
          const [pmSelection, summary] = await Promise.all([
            projects.pmSelectionOf(projectId),
            projects.summary(projectId),
          ]);
          const pmModel =
            pmSelection.model ??
            (pmSelection.provider === "anthropic"
              ? (integrationEnvironment.NORNS_PM_MODEL ?? DEFAULT_PM_MODEL.anthropic)
              : (integrationEnvironment.NORNS_OPENAI_MODEL ?? DEFAULT_PM_MODEL.openai));
          const pm = buildPlanningAdapter(pmSelection.provider, pmModel);
          const recommendation = await recommendProjectAllocation({
            pm,
            projectId,
            projectName: summary.name,
            objective,
            graph: WorkflowGraph.fromPlan(plan).snapshot(),
            models: configuredWorkerModels(),
          });
          options.recordUsage?.([recommendation.usage]);
          return {
            summary: recommendation.summary,
            recommendations: recommendation.recommendations,
          };
        },
      });

      // A restarted process can never resume a run that was mid-flight when
      // it died (runPlanning() isn't itself resumable mid-round), so any run
      // left in a non-terminal state is marked failed with a truthful reason
      // rather than left silently stuck. Single-instance MVP: see
      // PlanningRunWorker's module comment for the multi-instance caveat.
      void planningWorker.reconcileOrphans().catch(() => undefined);

      // The common case has no poll latency (the POST handler below kicks
      // execution immediately after enqueueing); this interval exists only so
      // a run is never silently stranded if that immediate kick is lost to a
      // crash between insert and dispatch.
      let planningTickInFlight = false;
      const planningWorkerTimer = setInterval(() => {
        if (planningTickInFlight) return;
        planningTickInFlight = true;
        void planningWorker
          .tick()
          .catch(() => undefined)
          .finally(() => {
            planningTickInFlight = false;
          });
      }, 2_000);
      planningWorkerTimer.unref?.();

      const planningRunError = (reply: FastifyReply, error: unknown): void => {
        if (error instanceof PlanningRunConflictError) {
          reply.code(404).send({ error: error.code, message: error.message });
          return;
        }
        throw error;
      };

      const CreatePlanningRunBody = z
        .object({
          objective: z.string().trim().min(1).max(100_000),
          max_rounds: z.number().int().min(1).max(5).optional(),
          // Accepted for forward-compatibility; wired to the run in Phase 4.
          attachment_ids: z.array(z.string().trim().min(1)).max(50).optional(),
        })
        .strict();

      app.post("/api/v2/projects/:id/planning-runs", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        const body = CreatePlanningRunBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          const run = await planningRunService.create(id, {
            objective: body.data.objective,
            ...(body.data.max_rounds !== undefined ? { maxRounds: body.data.max_rounds } : {}),
          });
          stores.audit("operator", "planning_run.created", `${id}:${run.id}`, now());
          reply.code(202).send({ planning_run_id: run.id });
          void planningWorker.runNow(run.id).catch((error) => {
            stores.audit(
              "operator",
              "planning_run.dispatch_failed",
              `${id}:${run.id}:${error instanceof Error ? error.message : String(error)}`,
              now(),
            );
          });
        } catch (error) {
          planningRunError(reply, error);
        }
      });

      app.get("/api/v2/projects/:id/planning-runs/:runId", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id, runId } = req.params as { id: string; runId: string };
        try {
          reply.header("Cache-Control", "no-store").send(await planningRunService.get(id, runId));
        } catch (error) {
          planningRunError(reply, error);
        }
      });
    }
  }

  // ---- runner websocket ----------------------------------------------------------

  app.get("/ws/runner", { websocket: true }, (conn) => {
    const socket = asSocket(conn);
    const challenge = nonce();
    let authedRunnerId: string | null = null;
    let runnerEventDelivery = Promise.resolve();

    sendFrame(socket, { type: "challenge", nonce: challenge });

    socket.on("message", async (data) => {
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
        const priorSocket = runnerSockets.get(authedRunnerId);
        if (priorSocket && priorSocket !== socket) {
          workspaceBroker.disconnect(authedRunnerId);
          reconciledWorkspaceRunners.delete(authedRunnerId);
          priorSocket.close(1008, "superseded runner connection");
        }
        runnerSockets.set(authedRunnerId, socket);
        reconciledWorkspaceRunners.set(authedRunnerId, {
          socket,
          generation: runner.generation,
          workspacePicker: body.capabilities.includes("workspace_picker"),
        });
        stores.markSeen(authedRunnerId, now());
        stores.audit(`runner:${authedRunnerId}`, "runner.connected", "", now());
        broadcast({ type: "runner_status", runner_id: authedRunnerId, connected: true });
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
        if (options.phase4) {
          for (const command of await options.phase4.dispatch.pendingForRunner(authedRunnerId)) {
            sendFrame(socket, { type: "command", command: v2WireCommand(command) });
          }
        }
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

      if (frame.type === "workspace_response") {
        // The broker verifies runner identity and generation before resolving
        // the HTTP request.  Workspace frames are transient and bypass the
        // durable event log by design: they contain no project mutation.
        const reconciled = reconciledWorkspaceRunners.get(authedRunnerId);
        if (
          runnerSockets.get(authedRunnerId) === socket &&
          reconciled?.socket === socket &&
          reconciled.generation === frame.generation
        ) {
          workspaceBroker.receive(authedRunnerId, frame.generation, frame.response);
        }
        return;
      }

      if (frame.type === "event") {
        const event: EventEnvelopeT = frame.event;
        const authenticatedRunnerId = authedRunnerId;
        runnerEventDelivery = runnerEventDelivery
          .then(async () => {
            const currentRunner = stores.runner(authenticatedRunnerId);
            const reconciled = reconciledWorkspaceRunners.get(authenticatedRunnerId);
            if (
              runnerSockets.get(authenticatedRunnerId) !== socket ||
              reconciled?.socket !== socket ||
              event.runner_id !== authenticatedRunnerId ||
              !currentRunner ||
              reconciled.generation !== currentRunner.generation ||
              event.generation !== reconciled.generation
            ) {
              stores.audit(
                `runner:${authenticatedRunnerId}`,
                "runner.event_rejected",
                "event did not match the current reconciled runner generation",
                now(),
              );
              sendFrame(socket, {
                type: "fenced",
                current_generation: currentRunner?.generation ?? event.generation + 1,
              });
              socket.close(1008, "runner event rejected");
              return;
            }
            await options.phase4?.events.apply(event);
            const outcome = stores.ingestEvent(event);
            if (outcome === "accepted") applyEventSideEffects(event);
            sendFrame(socket, {
              type: "event_ack",
              ack_event_seq: stores.eventWatermark(event.runner_id),
            });
          })
          .catch((error) => {
            stores.audit(
              `runner:${authenticatedRunnerId}`,
              "runner.event_rejected",
              error instanceof Error ? error.message : String(error),
              now(),
            );
            socket.close(1008, "runner event rejected");
          });
        return;
      }
    });

    socket.on("close", () => {
      if (authedRunnerId && runnerSockets.get(authedRunnerId) === socket) {
        runnerSockets.delete(authedRunnerId);
        reconciledWorkspaceRunners.delete(authedRunnerId);
        workspaceBroker.disconnect(authedRunnerId);
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

  app.get("/ws/session", { websocket: true }, (conn) => {
    const socket = asSocket(conn);
    let authState: "awaiting" | "authenticating" | "authenticated" | "closed" = "awaiting";
    const authTimeout = setTimeout(() => {
      if (authState !== "awaiting") return;
      authState = "closed";
      socket.close(1008, "authentication required");
    }, SESSION_AUTH_TIMEOUT_MS);
    authTimeout.unref();

    socket.on("close", () => {
      authState = "closed";
      clearTimeout(authTimeout);
      sessionSockets.delete(socket);
    });

    socket.on("message", (data) => {
      // After authentication, session sockets remain read-only views; commands
      // continue to go through the authenticated HTTP command routes.
      if (authState === "authenticated" || authState === "closed") return;
      if (authState === "authenticating") {
        authState = "closed";
        clearTimeout(authTimeout);
        socket.close(1008, "authentication already in progress");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        authState = "closed";
        clearTimeout(authTimeout);
        socket.close(1008, "invalid authentication frame");
        return;
      }
      const frame = SessionAuthFrame.safeParse(parsed);
      if (!frame.success) {
        authState = "closed";
        clearTimeout(authTimeout);
        socket.close(1008, "invalid authentication frame");
        return;
      }

      authState = "authenticating";
      void identityService
        .userForToken(frame.data.token)
        .then((user) => {
          if (authState === "closed") return;
          if (!user || user.status !== "active") {
            authState = "closed";
            clearTimeout(authTimeout);
            socket.close(1008, "unauthorized");
            return;
          }
          authState = "authenticated";
          clearTimeout(authTimeout);
          const binding: SessionSocketBinding = {
            socket,
            token: frame.data.token,
            userId: user.id,
            active: true,
            delivery: Promise.resolve(),
          };
          sessionSockets.set(socket, binding);
          try {
            socket.send(
              JSON.stringify({
                type: "snapshot",
                runners: stores.runners().map((runner) => ({
                  runner_id: runner.runner_id,
                  connected: runnerSockets.has(runner.runner_id),
                })),
              }),
            );
          } catch {
            closeSessionSocket(binding, "connection unavailable");
          }
        })
        .catch(() => {
          if (authState === "closed") return;
          authState = "closed";
          clearTimeout(authTimeout);
          socket.close(1011, "authentication unavailable");
        });
    });
  });

  return {
    app,
    stores,
    connectedRunners: () => [...runnerSockets.keys()],
  };
}
