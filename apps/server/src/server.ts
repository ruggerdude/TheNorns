import { timingSafeEqual } from "node:crypto";
// The relay/API server (ADR-002: the backend IS the relay). Exposes:
//   POST /api/commands, GET /api/commands/:id
//   GET  /api/audit, /api/events/:runnerId
//   POST /api/kill-switch
//   WS   /ws/runner  (challenge -> auth -> reconcile -> commands/events)
//   WS   /ws/session (live observation for the browser)
//   GET  /          (React app in production; API notice in server-only dev)
// Connection state is never trusted solely in process memory: every decision
// reads/writes RelayStores, which snapshots to durable storage.
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  AdapterError,
  AnthropicAdapter,
  type ConversationLlmAdapter,
  DEFAULT_MODEL_REGISTRY,
  type LlmAdapter,
  OpenAiAdapter,
  type ProviderName,
  buildSelectableModelCatalog,
  modelAvailabilityFromDebateEnvironment,
} from "@norns/adapters";
import {
  AnthropicPmModel,
  CodexReasoningEffort,
  type CodexReasoningEffortT,
  type CommandEnvelopeT,
  CommandPayload,
  type CommandStateT,
  DEFAULT_PM_MODEL,
  DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
  DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
  DEVICE_VISUAL_EVIDENCE_UPLOAD_HTTP_SIGNATURE_PURPOSE,
  type EventEnvelopeT,
  LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
  LocalExecutionCapabilitiesProjection,
  OpenAiPmModel,
  type OwnedDeviceProjectionT,
  PROTOCOL_VERSION,
  PlanContract,
  ReconcileRequest,
  // EXECUTION E3 — the proxied-inference response frame body.
  type RunnerInferenceResponseT,
  type ServerFrameT,
  type UsageEventT,
  V2ContentAddressedReference,
  V2ControlDebateRunCommand,
  V2CreateDebateCommand,
  V2DecisionResolutionRequest,
  type V2DispatchCommandT,
  V2EvidenceRef,
  V2HumanDirectionRequest,
  V2ImplementationCaptureProfile,
  V2InterveneDebateRunCommand,
  V2MockupArtifactUploadInput,
  V2RecordProjectDeploymentObservationInput,
  V2RepositoryIngestionSeed,
  V2StartDebateRunCommand,
  V2StrategyVersion,
  canonicalDeviceCancellationEvidenceWssTranscript,
  canonicalLegacyRunnerWssAuthenticationTranscript,
  isPmModelForProvider,
  parseRunnerFrame,
} from "@norns/contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ALLOWED_IMAGE_MIMES,
  ATTACHMENT_CAPS,
  AttachmentLookupError,
  AttachmentService,
  AttachmentValidationError,
  isImageAttachmentMime,
} from "./attachments/index.js";
import { bearerToken, verifyRunnerSignature } from "./auth.js";
import {
  ConversationActionCheckpointWorker,
  ConversationActionDeliveryWorker,
  ConversationContextAssembler,
  ConversationHumanSteeringService,
  ConversationPlanChangeProposalService,
  ConversationPlanProposalService,
  ConversationPlanWorkflowService,
  ConversationPmUpdateScheduler,
  ConversationService,
  ConversationTurnError,
  ConversationTurnRepository,
  ConversationTurnService,
  ExecutionConversationService,
  PostgresConversationRepository,
  SqlConversationInferenceBudget,
  registerConversationPlanRoutes,
  registerConversationRoutes,
} from "./conversations/index.js";
// ONBOARDING O4: Actions-hosted execution.
import {
  type ActionsEnrollmentService,
  type ActionsExecutionCoordinator,
  ActionsExecutionError,
  type ActionsExecutionRepository,
  actionsDispatchRunnerId,
} from "./coordinator/actionsExecution.js";
// EXECUTION E2: turns an approved strategy into scheduled work.
import { DispatchContextScopeRepository } from "./coordinator/dispatchContextScope.js";
import {
  HumanWaitContinuationWorker,
  HumanWaitRecoveryWorker,
} from "./coordinator/humanWaitContinuation.js";
import { PauseResumeContinuationWorker } from "./coordinator/pauseResumeContinuation.js";
import type { Phase4CompletionService } from "./coordinator/phase4Completion.js";
import type { Phase4Coordinator } from "./coordinator/phase4Coordinator.js";
import { type Phase4DispatchRepository, Phase4Dispatcher } from "./coordinator/phase4Dispatcher.js";
import type { Phase4EventProcessor } from "./coordinator/phase4EventProcessor.js";
import {
  Phase4RecoveryActionError,
  Phase4RecoveryActionService,
} from "./coordinator/phase4RecoveryActions.js";
import type { Phase4RecoveryMonitor } from "./coordinator/phase4RecoveryMonitor.js";
import type { Phase6CoordinationService } from "./coordinator/phase6Coordination.js";
import { describePhaseConcurrency } from "./coordinator/phaseConcurrency.js";
import { PhaseLaunchError, PhaseLaunchService } from "./coordinator/phaseLaunchService.js";
import { PhaseQueueDrainer } from "./coordinator/phaseQueueDrainer.js";
import {
  RunConflictResolutionRequest,
  RunIntegrationConflictError,
  RunIntegrationConflictService,
} from "./coordinator/runIntegrationConflicts.js";

/**
 * EXECUTION E12 — how long a queued task can sit after a slot frees.
 *
 * Five seconds, matching the order of magnitude of the dispatch loop (500ms)
 * without adding a per-second query for every active phase. The cost of the
 * interval is latency on an operation that already takes minutes; the benefit
 * of not going lower is that this poll touches several tables per active phase.
 */
const PHASE_QUEUE_DRAIN_INTERVAL_MS = 5_000;

function attachmentContentDisposition(filename: string, inline: boolean): string {
  const safeFilename = Array.from(filename, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      character === "/" ||
      character === "\\"
      ? "_"
      : character;
  }).join("");
  const fallback =
    safeFilename
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_")
      .trim() || "attachment";
  const encoded = encodeURIComponent(safeFilename).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
import { DebateConflictError, type DebateService } from "./debates/service.js";
import type { PostgresDeviceActionAuthorization } from "./devices/actionAuthorization.js";
import { DeviceActionAuthorizationError } from "./devices/actionAuthorization.js";
import type { ScopedDeviceBrowserDelivery } from "./devices/browserDelivery.js";
import {
  DeviceRunCancellationError,
  type DeviceRunCancellationService,
} from "./devices/cancellation.js";
import {
  type LegacyRepositoryClaimRouteOptions,
  registerLegacyRepositoryClaimRoutes,
} from "./devices/legacyRepositoryClaimRoutes.js";
import {
  type DeviceManagementRouteService,
  registerDeviceManagementRoutes,
} from "./devices/managementRoutes.js";
import type { DeviceOnlineControlBroker } from "./devices/onlineControl.js";
import { registerProjectCancellationRoutes } from "./devices/projectCancellationRoutes.js";
import {
  type DeviceRepositoryAccessRouteOptions,
  registerDeviceRepositoryAccessRoutes,
} from "./devices/repositoryAccessRoutes.js";
import type { DeviceRevocationService } from "./devices/revocation.js";
import {
  type DeviceEnrollmentRouteService,
  registerDeviceEnrollmentRoutes,
} from "./devices/routes.js";
import type {
  AuthenticatedDeviceWssIdentity,
  DeviceWssAuthenticator,
} from "./devices/wssAuthentication.js";
import { EmailNotConfiguredError, sendEmail } from "./email/resend.js";
// EXECUTION E1: task-context assembly + the runner-facing context fetch route.
import {
  DEVICE_HTTP_DEVICE_ID_HEADER,
  type DeviceHttpAuthResult,
  type DeviceHttpRequestAuthenticator,
  RelationalTaskContextAssembler,
  TASK_CONTEXT_ROUTE_PREFIX,
  type TaskContextAssembler,
  type TaskContextDocumentContent,
  TaskContextStore,
  captureRunnerHttpBodySha256,
  capturedRunnerHttpBodySha256,
  routedDeviceHttpPathSegment,
} from "./execution/index.js";
// EXECUTION E9 — the provider-native streaming gateway that lets Claude Code
// and Codex run credential-free. Everything about it lives in src/gateway/.
import {
  GatewayCredentialService,
  ProviderGateway,
  SqlGatewayCredentialStore,
  registerGatewayRoutes,
} from "./gateway/index.js";
import { AllocationError, AllocationStrategy } from "./graph/allocation.js";
import { GraphEditError, WorkflowGraph } from "./graph/graph.js";
import { newId, nonce, pairingCode } from "./ids.js";
import {
  GitHubIntegrationError,
  type GitHubIntegrationService,
  disabledGitHubStatus,
} from "./integrations/github.js";
// EXECUTION E3: serving the runner tarball the Actions workflow installs.
import {
  type RunnerTarball,
  defaultRunnerTarballDir,
  loadRunnerTarball,
  runnerTarballPath,
} from "./integrations/runnerDistribution.js";
import { type KnowledgeSystemService, registerKnowledgeRoutes } from "./knowledge/index.js";
import type { Phase7OperationsService } from "./operations/phase7Operations.js";
import { SqlAiUsageTelemetryRepository } from "./persistence/v2/aiUsageTelemetry.js";
import type { V2TransactionRunner } from "./persistence/v2/database.js";
import {
  CreateDeploymentInput,
  HealthProbeError,
  Phase6ArtifactError,
  Phase6DashboardService,
  Phase6DeploymentError,
  Phase6DeploymentService,
  Phase6MockupError,
  Phase6MockupService,
  Phase6MockupWorker,
  Phase6VisualEvidenceCollectionWorker,
  Phase6VisualEvidenceError,
  Phase6VisualEvidenceService,
  RecordHumanDeploymentObservationInput,
  probePublicHttpsUrl,
} from "./phase6/index.js";
import {
  AllocationRecommendationError,
  recommendProjectAllocation,
} from "./planning/allocationRecommendation.js";
import {
  PLANNING_RUN_DEFAULT_PM_MODEL,
  PLANNING_RUN_DEFAULT_REVIEWER_MODEL,
  defaultReviewerProviderFor,
  resolvePlanningParticipants,
} from "./planning/reviewerSelection.js";
import {
  type ApprovedPlanExecutionKickoff,
  type ApprovedStaffingEntryDto,
  PlanningRunConflictError,
  PlanningRunDecisionError,
  type PlanningRunDecisionInput,
  PlanningRunService,
  type PlanningStaffingProposalDto,
  QC_MODES,
} from "./planning/runService.js";
import { PlanningRunWorker } from "./planning/runWorker.js";
import { PlanningError, planContentHash, runPlanning } from "./planning/session.js";
import { type AttentionService, DecisionResolutionError } from "./projects/attentionService.js";
// ONBOARDING O2 imports: githubRemoteRepositoryPort, projectOnboardingService,
// remoteRepositoryPort.
import { GitHubActivationPort } from "./projects/githubActivationPort.js";
import { GitHubRemoteRepositoryPort } from "./projects/githubRemoteRepositoryPort.js";
import { GlobalRulesService } from "./projects/globalRulesService.js";
import {
  PhaseWorkflowConflictError,
  type PhaseWorkflowService,
} from "./projects/phaseWorkflowService.js";
import { PostgresProjectAccessRepository } from "./projects/projectAccessRepository.js";
import { registerProjectAccessRoutes } from "./projects/projectAccessRoutes.js";
import { ProjectAccessError, ProjectAccessService } from "./projects/projectAccessService.js";
import {
  ProjectActivationError,
  ProjectActivationService,
} from "./projects/projectActivationService.js";
import {
  OnboardingValidationError,
  ProjectOnboardingService,
  blockerPayload,
} from "./projects/projectOnboardingService.js";
import {
  ProjectResumeNotFoundError,
  type ProjectResumeService,
  ProjectSettingsValidationError,
} from "./projects/projectResumeService.js";
import { ProjectRulesNotFoundError, ProjectRulesService } from "./projects/projectRulesService.js";
import {
  Phase3RequiredError,
  ProjectArchiveConflictError,
  insertProjectCore,
} from "./projects/relationalReadRepository.js";
import {
  RemoteRepositoryVerificationError,
  UnconfiguredRemoteRepositoryPort,
} from "./projects/remoteRepositoryPort.js";
import {
  type ProjectGraphView,
  type ProjectRepository,
  projectRepository,
} from "./projects/repository.js";
// POLISH P3 — the server-side "Analyze the repository" step behind the
// resume payload's recommendation.
import {
  RepositoryAnalysisError,
  type RepositoryAnalysisService,
} from "./projects/repositoryAnalysisService.js";
import {
  RepositoryIngestionConflictError,
  type RepositoryIngestionService,
} from "./projects/repositoryIngestionService.js";
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
  executionModelCatalogFromEnvironment,
  executionModelUnavailableMessage,
} from "./runners/executionModelAvailability.js";
import {
  type HelperRunnerSnapshot,
  helperStatus,
  installCommand,
  installCommandWindows,
  localAgentDownloadsFromEnvironment,
  localAgentPairingUri,
} from "./runners/helperOnboarding.js";
// EXECUTION E3: proxied model inference for credential-free runners.
import {
  InferenceProxy,
  type ProxiedRunLookup,
  RUNNER_ALLOWED_MODELS_ENV,
  SqlInferenceMeter,
  SqlProxiedRunLookup,
  SqlRunReservationBudget,
  parseRunnerAllowedModels,
} from "./runners/inferenceProxy.js";
import {
  type LegacyRunnerAuthorization,
  PostgresLegacyRunnerAuthorization,
} from "./runners/legacyAuthorization.js";
import {
  RunnerWorkspaceBroker,
  WorkspaceBrokerError,
  WorkspaceSelectionTokens,
} from "./runners/workspaceBroker.js";
import {
  type RelationalCompositionBridge,
  RelationalCompositionConflictError,
} from "./startup/relationalCompositionBridge.js";
import type { RelayStores } from "./stores.js";
import { registerUsageAnalyticsRoutes } from "./usage-intelligence/analyticsRoutes.js";
import { UsageAnalyticsService } from "./usage-intelligence/analyticsService.js";
import { PostgresUsageBudgetPolicyRepository } from "./usage-intelligence/budgetPolicyRepository.js";
import { registerUsageBudgetPolicyRoutes } from "./usage-intelligence/budgetPolicyRoutes.js";
import { UsageBudgetPolicyService } from "./usage-intelligence/budgetPolicyService.js";
import { registerUsageIntelligenceRoutes } from "./usage-intelligence/routes.js";
import { UsageIntelligenceService } from "./usage-intelligence/service.js";
import { AiInvocationTelemetry } from "./usage-intelligence/telemetry.js";
import type {
  IdentityService,
  IdentityUser,
  IdentityUserSummary,
} from "./users/identityService.js";
import { IdentityAlreadyBootstrappedError } from "./users/identityService.js";
import { LegacyIdentityService } from "./users/legacyIdentityService.js";
import { LoginAttemptThrottle } from "./users/loginThrottle.js";
import { detectPasswordHashScheme } from "./users/passwords.js";
import { LastActiveAdminError, UserNotFoundError, type UserStore } from "./users/store.js";

const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;

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
   * Phase 1 enrollment slice. Production startup supplies it only after the
   * explicit device-enrollment feature flag and HMAC configuration validate.
   */
  deviceEnrollment?: {
    service: DeviceEnrollmentRouteService;
  };
  /**
   * Owner device-management and privacy-reduced project-target projections.
   * This remains absent unless the separate management rollout flag is on.
   */
  deviceManagement?: {
    service: DeviceManagementRouteService;
  };
  /**
   * Phase 4 repository authorization and publication gates. Production only
   * supplies this under its independent default-off rollout flag.
   */
  deviceRepositoryAccess?: Omit<DeviceRepositoryAccessRouteOptions, "requireUser">;
  /** Phase 6A exact-project claim APIs. Omission is a strict default-off gate. */
  legacyRepositoryClaims?: Omit<LegacyRepositoryClaimRouteOptions, "requireUser" | "now">;
  /**
   * Device installation WSS identity proof. This is deliberately independent
   * from enrollment and remains absent in production until the Phase 2
   * authorization-enforcement gate is complete.
   */
  deviceWssAuthentication?: DeviceWssAuthenticator;
  /**
   * Explicit owner/project-scoped device browser delivery. There is no
   * administrator or all-session fallback.
   */
  deviceBrowserDelivery?: ScopedDeviceBrowserDelivery;
  /**
   * Cancellation is the only device control transport available before general
   * device command execution is enabled. Revocation remains a service concern;
   * the broker only performs best-effort post-commit socket cleanup.
   */
  deviceControl?: {
    broker: DeviceOnlineControlBroker;
    cancellations: DeviceRunCancellationService;
    revocations: DeviceRevocationService;
  };
  /**
   * Strict device HTTP authentication and one-time request-id consumption.
   * Legacy runner acceptance, when required during cutover, is configured
   * explicitly inside this authenticator and never inferred here.
   */
  runnerHttpAuthentication?: DeviceHttpRequestAuthenticator;
  /**
   * Transaction-local JIT authorization for device HTTP acceptance. The
   * service and transaction runner are paired so the device row lock remains
   * held through context reads, credential minting, and evidence persistence.
   */
  deviceActionAuthorization?: {
    service: PostgresDeviceActionAuthorization;
    transactions: V2TransactionRunner;
  };
  /** Device-backed local WSS command/event delivery canary gate. */
  deviceDispatch?: { enabled: true };
  /** Deprecated local enrollment routes. Each compatibility gate defaults off. */
  legacyPairingRoutes?: { enabled: true };
  legacyHelperRoutes?: { enabled: true };
  legacyLocalRunnerAuth?: { enabled: true };
  /**
   * Temporary escape hatch for pre-project legacy runner workflows. Omission
   * is fail-closed; production must opt in explicitly while completing
   * cutover. This never authorizes device identities.
   */
  legacyGlobalRunnerCompatibility?: { enabled: true };
  /**
   * Injectable project/run attribution seam for compatibility runner
   * surfaces. Production derives this from the relational transaction runner;
   * tests can supply an exact fake without enabling global compatibility.
   */
  legacyRunnerAuthorization?: LegacyRunnerAuthorization;
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
  /**
   * Explicit compatibility policy for deployments that enable relational
   * workflows before identity/project reads have completed cutover.
   */
  relationalComposition?: RelationalCompositionBridge;
  phase3?: {
    sourceBindings: SourceBindingService;
    ingestion: RepositoryIngestionService;
    phases: PhaseWorkflowService;
    strategies: StrategyWorkflowService;
    /** FRONT DOOR P3: planning-run -> proposed-StrategyVersion bridge. */
    bridge: StrategyBridgeService;
    resume: ProjectResumeService;
  };
  /**
   * POLISH P3 — POST /api/v2/projects/:id/analyze-repository: fetch a bounded
   * sample of the project's connected GitHub repository, have a model produce
   * a structured architecture summary, and record it through phase3's
   * `ingestion` service. Optional the same way `phase3` is: without it the
   * route refuses honestly (503 analysis_unavailable) instead of mounting a
   * button that silently does nothing.
   */
  repositoryAnalysis?: RepositoryAnalysisService;
  phase4?: {
    coordinator: Phase4Coordinator;
    completion: Phase4CompletionService;
    dispatch: Phase4DispatchRepository;
    events: Phase4EventProcessor;
    recovery: Phase4RecoveryMonitor;
  };
  /**
   * ONBOARDING O4: Actions-hosted execution. Present only when GitHub is
   * configured; its absence leaves every laptop-runner path untouched.
   */
  actionsExecution?: {
    coordinator: ActionsExecutionCoordinator;
    enrollment: ActionsEnrollmentService;
    repository: ActionsExecutionRepository;
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
  planningRuns?: {
    transactions: V2TransactionRunner;
    /**
     * PHASE TAB P1: optional execution kickoff for an approved planning run.
     * Not wired in production yet — see ApprovedPlanExecutionKickoff in
     * planning/runService.ts for why approval must not silently auto-drive
     * the strategy-approval chain. When absent, an approval is recorded fully
     * and the decision response reports `execution: null`.
     */
    executionKickoff?: ApprovedPlanExecutionKickoff;
  };
  /**
   * EXECUTION E10 (E9-10, = E3-10) — the relational runtime behind BOTH the E3
   * completion proxy and the E9 provider-native gateway.
   *
   * Before this option existed, each of them reached for
   * `planningRuns?.transactions ?? onboarding?.transactions ??
   * attachments?.transactions` — whichever unrelated feature happened to be
   * configured. That worked only because production wires all three from the
   * same runner, and would have silently disabled runner inference the day
   * someone turned planning runs off. Naming it makes the dependency explicit
   * and makes `main.ts` the single place that decides it exists.
   *
   * The fallback chain is retained below purely so existing tests that
   * construct `buildServer` with only `planningRuns` keep working.
   */
  runnerInference?: { transactions: V2TransactionRunner };
  /**
   * FRONT DOOR P4 (D3): image attachments (content-addressed Postgres store).
   * Unavailable without its database runtime, same as `planningRuns`. When
   * both are present, objective attachments are injected into planning round 1.
   */
  attachments?: { transactions: V2TransactionRunner };
  /**
   * EXECUTION E1: task-context assembly + the runner-facing fetch route.
   * Needs the relational runtime, same as `attachments`. `baseUrl` is the
   * origin a runner resolves this deployment at and must be HTTPS (or http on
   * localhost, matching the runner's own check); it defaults to
   * `publicOrigin`.
   */
  execution?: { transactions: V2TransactionRunner; baseUrl?: string };
  /**
   * Versioned project knowledge, exact task manifests, structured agent
   * reporting, delta reconciliation, conflict checks, and completion gates.
   */
  knowledge?: { service: KnowledgeSystemService };
  /**
   * ONBOARDING O2: the two project-creation scenarios (new_repo,
   * existing_repo). Every project is GitHub-backed and executes in a GitHub
   * Actions job. Needs the relational runtime, same as `planningRuns`.
   */
  onboarding?: { transactions: V2TransactionRunner };
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
  createPlanningAdapter?: (
    provider: ProviderName,
    model: string,
    apiKey: string,
    reasoningEffort?: CodexReasoningEffortT,
  ) => LlmAdapter;
  /**
   * EXECUTION E3 — proxied model inference for runners that hold no provider
   * credentials. Supplying one overrides the default composition below; the
   * default is used whenever a relational runtime is available, so a normal
   * deployment gets the proxy without extra wiring.
   */
  inferenceProxy?: InferenceProxy;
  /**
   * EXECUTION E9 — the provider-native streaming gateway. Supplying one
   * overrides the default composition below (tests point its surfaces at a
   * local upstream this way); the default is used whenever a relational
   * runtime is available, so a normal deployment gets the gateway with no
   * extra wiring, exactly as E3's proxy does.
   */
  modelGateway?: ProviderGateway;
  /** EXECUTION E9 — override the credential service (tests, and only tests). */
  gatewayCredentials?: GatewayCredentialService;
  /**
   * EXECUTION E9 — the run-ownership lookup shared by the gateway and its mint
   * route. Defaults to E3's `SqlProxiedRunLookup`; overridden only so a test
   * can drive the real decision logic without a database.
   */
  gatewayRuns?: ProxiedRunLookup;
  /** Force Secure browser cookies in production and production-shaped tests. */
  secureCookies?: boolean;
  /** Canonical browser origin used in emailed links. */
  publicOrigin?: string;
  /** Absolute repository scripts directory used for the fixed helper installers. */
  installScriptsDir?: string;
}

export interface NornsServer {
  app: FastifyInstance;
  stores: RelayStores;
  /** runner_ids with a live authenticated socket */
  connectedRunners(): string[];
  /**
   * EXECUTION E1: assembles a task's agent context into content-addressed refs.
   * Present only when `options.execution` supplied the relational runtime.
   */
  taskContext?: TaskContextAssembler;
}

export async function buildServer(options: ServerOptions): Promise<NornsServer> {
  const { stores, users, deployToken } = options;
  const usesLegacyIdentity = options.identity === undefined;
  const identityService: IdentityService = options.identity ?? new LegacyIdentityService(users);
  const now = options.clock ?? (() => new Date());
  const runnerHttpAuthentication:
    | DeviceHttpRequestAuthenticator
    | { authenticate(): Promise<DeviceHttpAuthResult> } = options.runnerHttpAuthentication ?? {
    async authenticate(): Promise<DeviceHttpAuthResult> {
      return { ok: false, reason: "missing_credentials" };
    },
  };
  // Recovery decision-point ids include durable aggregate identities and can
  // legitimately exceed Fastify's 100-character default. Keep the route
  // bounded while allowing server-generated ids to round-trip through params.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 512 } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RelationalCompositionConflictError) {
      return reply.code(409).send(error.diagnostic());
    }
    return reply.send(error);
  });
  await app.register(websocket);
  app.addContentTypeParser(
    [
      ...ALLOWED_IMAGE_MIMES,
      "text/markdown",
      "text/csv",
      "application/pdf",
      "application/octet-stream",
    ],
    { parseAs: "buffer", bodyLimit: ATTACHMENT_CAPS.maxBytesPerAttachment },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    /^(?!application\/json|text\/plain)/,
    { parseAs: "buffer", bodyLimit: ATTACHMENT_CAPS.maxBytesPerAttachment },
    (_request, body, done) => done(null, body),
  );

  // EXECUTION E1: assigned in the task-context section below when the
  // relational runtime is present, and handed back on NornsServer so E2's
  // trigger can assemble refs without reaching into route internals.
  let taskContextAssembler: TaskContextAssembler | undefined;
  // EXECUTION E2: authorizes the fetch route above (not merely authenticates
  // it) and is shared with the start-phase section below.
  let dispatchContextScope: DispatchContextScopeRepository | undefined;
  // Assigned when the full Phase 4 execution runtime is composed below. The
  // earlier attention route closes over this seam at request time.
  let decisionRecoveryActions: Phase4RecoveryActionService | undefined;

  const runnerSockets = new Map<string, WsLike>();
  // The socket+generation a runner most recently reconciled at. Event and
  // inference frames are only honored when they arrive on this exact socket
  // at this exact generation (see /ws/runner below).
  const reconciledRunners = new Map<
    string,
    {
      socket: WsLike;
      generation: number;
      workspacePicker: boolean;
      workspaceRepositoryInventory: boolean;
      workspaceClone: boolean;
    }
  >();
  const sessionSockets = new Map<WsLike, SessionSocketBinding>();
  const loginThrottle = new LoginAttemptThrottle();
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === "production";
  const integrationEnvironment = options.integrationEnvironment ?? process.env;
  const localAgentDownloads = localAgentDownloadsFromEnvironment(integrationEnvironment);
  const configuredDebateModels = () =>
    buildSelectableModelCatalog(
      modelAvailabilityFromDebateEnvironment(integrationEnvironment),
    ).filter((entry) => entry.available);
  const executionModelCatalog = () => executionModelCatalogFromEnvironment(integrationEnvironment);
  const configuredExecutionModels = () =>
    executionModelCatalog().filter((entry) => entry.available);
  const runtimeTransactionsForInference =
    options.runnerInference?.transactions ??
    options.planningRuns?.transactions ??
    options.onboarding?.transactions ??
    options.attachments?.transactions;
  const legacyGlobalRunnerCompatibilityEnabled =
    options.legacyGlobalRunnerCompatibility?.enabled === true;
  const legacyPairingRoutesEnabled = options.legacyPairingRoutes?.enabled === true;
  const legacyHelperRoutesEnabled = options.legacyHelperRoutes?.enabled === true;
  const legacyLocalRunnerAuthEnabled = options.legacyLocalRunnerAuth?.enabled === true;
  const deviceDispatchEnabled = options.deviceDispatch?.enabled === true;
  const legacyRunnerAuthorization: LegacyRunnerAuthorization | null =
    options.legacyRunnerAuthorization ??
    (runtimeTransactionsForInference
      ? new PostgresLegacyRunnerAuthorization(runtimeTransactionsForInference)
      : null);
  const phase6Mockups = options.execution
    ? new Phase6MockupService(options.execution.transactions)
    : null;
  const phase6Deployments = options.execution
    ? new Phase6DeploymentService(options.execution.transactions)
    : null;
  const phase6VisualEvidence = options.execution
    ? new Phase6VisualEvidenceService(options.execution.transactions)
    : null;
  const phase6Dashboard =
    options.execution && phase6Mockups && phase6Deployments
      ? new Phase6DashboardService(
          options.execution.transactions,
          phase6Mockups,
          phase6Deployments,
          now,
        )
      : null;
  const canonicalTelemetry = runtimeTransactionsForInference
    ? new AiInvocationTelemetry(
        new SqlAiUsageTelemetryRepository(runtimeTransactionsForInference),
        now,
      )
    : undefined;
  const instrumentAdapter = (adapter: LlmAdapter): LlmAdapter =>
    canonicalTelemetry?.wrapAdapter(adapter) ?? adapter;
  const globalRulesService = runtimeTransactionsForInference
    ? new GlobalRulesService(runtimeTransactionsForInference, now)
    : null;
  const buildPlanningAdapter = (
    provider: ProviderName,
    model: string,
    reasoningEffort?: CodexReasoningEffortT,
  ): LlmAdapter => {
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
      return instrumentAdapter(
        options.createPlanningAdapter(provider, model, apiKey, reasoningEffort),
      );
    }
    return instrumentAdapter(
      provider === "anthropic"
        ? new AnthropicAdapter({ apiKey, model })
        : new OpenAiAdapter({
            apiKey,
            model,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }),
    );
  };

  // === EXECUTION E3 (proxied model inference) ==============================
  // Composed here rather than in main.ts because main.ts belongs to another
  // phase in flight. Every input already exists on ServerOptions: the runtime
  // transaction runner (the same instance behind planningRuns/onboarding/
  // attachments in production), the provider credentials, and the usage sink.
  // A deployment with no relational runtime gets no proxy, and every request
  // is answered `unsupported` — never silently executed without metering.
  //
  // EXECUTION E10 (E9-10, = E3-10) — DONE. `runnerInference` is now a named
  // option, wired from main.ts alongside the other relational features, so the
  // dependency is stated rather than inferred from whichever unrelated feature
  // happens to be configured. The remaining fallbacks are compatibility only:
  // they keep every existing test (and any deployment not yet passing the new
  // option) behaving exactly as before. Production always supplies the named
  // one, and a boot-shape test asserts it.
  const inferenceProxy: InferenceProxy | null =
    options.inferenceProxy ??
    (runtimeTransactionsForInference
      ? new InferenceProxy({
          runs: new SqlProxiedRunLookup(runtimeTransactionsForInference),
          budget: new SqlRunReservationBudget(runtimeTransactionsForInference),
          meter: new SqlInferenceMeter(runtimeTransactionsForInference, options.recordUsage),
          allowedModels: parseRunnerAllowedModels(
            integrationEnvironment[RUNNER_ALLOWED_MODELS_ENV],
          ),
          createAdapter: (provider, model) => {
            // The raw key never leaves this closure: the adapter holds it, the
            // proxy holds the adapter, and nothing that touches a runner frame
            // can read it back out.
            const apiKey =
              provider === "anthropic"
                ? integrationEnvironment.ANTHROPIC_API_KEY
                : integrationEnvironment.OPENAI_API_KEY;
            if (!apiKey?.trim()) return null;
            if (options.createPlanningAdapter) {
              return instrumentAdapter(options.createPlanningAdapter(provider, model, apiKey));
            }
            return instrumentAdapter(
              provider === "anthropic"
                ? new AnthropicAdapter({ apiKey, model })
                : new OpenAiAdapter({ apiKey, model }),
            );
          },
          audit: (actor, action, detail) => stores.audit(actor, action, detail, now()),
        })
      : null);
  // === end EXECUTION E3 (proxied model inference) ==========================
  const configuredOrigin =
    options.publicOrigin ??
    process.env.NORNS_PUBLIC_ORIGIN ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : undefined);
  // === EXECUTION E9 (provider-native streaming gateway) ====================
  //
  // WHY IT EXISTS. E3's completion proxy works and is metered, but it cannot
  // serve Claude Code or Codex: both speak a provider's own streaming HTTP API
  // and `LlmAdapter` has no token-level surface. An agent on the E3 proxy
  // cannot read a second file, so it cannot write code (E3-9). The human's
  // decision was a provider-native gateway: keys never leave this server,
  // never enter a repository, and spend stays metered.
  //
  // IT REUSES E3 WHOLESALE — deliberately, and this is the security-critical
  // part. Same `SqlProxiedRunLookup` for run ownership, same
  // `authorizeProxiedRunAccess` decision (extracted from `InferenceProxy` so
  // there is one implementation and not two), same `SqlRunReservationBudget`,
  // same `SqlInferenceMeter` writing the same `usage_events` rows, same
  // `NORNS_RUNNER_ALLOWED_MODELS` allowlist failing closed on empty. Two
  // notions of "this runner owns this run" is how a bypass gets built; there
  // is only one.
  //
  // E3-10 / E9-10 CLOSED BY E10: `runtimeTransactionsForInference` above now
  // prefers the named `ServerOptions.runnerInference`, wired from main.ts. The
  // gateway and the E3 proxy therefore share one explicitly-supplied runtime
  // rather than each inferring one.
  const gatewayOrigin = configuredOrigin ?? "http://127.0.0.1";
  // The mint route and the gateway MUST agree about run ownership, so they are
  // handed the same lookup rather than each constructing one.
  const gatewayRuns =
    options.gatewayRuns ??
    (runtimeTransactionsForInference
      ? new SqlProxiedRunLookup(runtimeTransactionsForInference)
      : undefined);
  const gatewayCredentials =
    options.gatewayCredentials ??
    (runtimeTransactionsForInference
      ? new GatewayCredentialService(
          new SqlGatewayCredentialStore(runtimeTransactionsForInference),
          now,
        )
      : undefined);
  const modelGateway =
    options.modelGateway ??
    (runtimeTransactionsForInference && gatewayCredentials
      ? new ProviderGateway({
          runs: gatewayRuns ?? new SqlProxiedRunLookup(runtimeTransactionsForInference),
          credentials: gatewayCredentials,
          deviceActionAuthorization: options.deviceActionAuthorization,
          budget: new SqlRunReservationBudget(runtimeTransactionsForInference),
          meter: new SqlInferenceMeter(runtimeTransactionsForInference, options.recordUsage),
          allowedModels: parseRunnerAllowedModels(
            integrationEnvironment[RUNNER_ALLOWED_MODELS_ENV],
          ),
          conversationAllowedModels: configuredDebateModels().map(
            (entry) => `${entry.provider}/${entry.model}`,
          ),
          conversationBudget: new SqlConversationInferenceBudget(
            runtimeTransactionsForInference,
            now,
          ),
          // The raw provider key is read here and used in exactly one place —
          // the outbound request's auth header. It is never audited, never put
          // in a refusal body, and never returned on any error path.
          apiKey: (provider) => {
            const key =
              provider === "anthropic"
                ? integrationEnvironment.ANTHROPIC_API_KEY
                : integrationEnvironment.OPENAI_API_KEY;
            return key?.trim() ? key.trim() : null;
          },
          audit: (actor, action, detail) => stores.audit(actor, action, detail, now()),
          telemetry: canonicalTelemetry,
          now,
        })
      : undefined);
  if (modelGateway && gatewayCredentials && gatewayRuns) {
    await registerGatewayRoutes(app, {
      gateway: modelGateway,
      credentials: gatewayCredentials,
      runs: gatewayRuns,
      runnerHttpAuthentication,
      deviceActionAuthorization: options.deviceActionAuthorization,
      audit: (actor, action, detail) => stores.audit(actor, action, detail, now()),
      publicOrigin: gatewayOrigin,
    });
  }
  // === end EXECUTION E9 (provider-native streaming gateway) ================

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
    const reconciled = reconciledRunners.get(runnerId);
    if (
      !socket ||
      !reconciled ||
      reconciled.socket !== socket ||
      reconciled.generation !== generation ||
      !reconciled.workspacePicker
    ) {
      return false;
    }
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
  let humanWaitContinuationTimer: ReturnType<typeof setInterval> | undefined;
  let humanWaitRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  let conversationActionDeliveryTimer: ReturnType<typeof setInterval> | undefined;
  let phase6MockupTimer: ReturnType<typeof setInterval> | undefined;
  let phase6VisualEvidenceTimer: ReturnType<typeof setInterval> | undefined;
  let conversationPmUpdateTimer: ReturnType<typeof setInterval> | undefined;
  let usageBudgetEvaluationTimer: ReturnType<typeof setInterval> | undefined;
  let conversationKickoffTimer: ReturnType<typeof setInterval> | undefined;
  // EXECUTION E12 — declared here, assigned far below where PhaseLaunchService
  // is constructed, so the onClose hook can clear it alongside its siblings.
  let phaseQueueDrainTimer: ReturnType<typeof setInterval> | undefined;
  let conversationTurns: ConversationTurnService | null = null;
  let conversationService: ConversationService | null = null;
  let conversationContextAssembler: ConversationContextAssembler | null = null;
  let conversationAttempts: ConversationTurnRepository | null = null;
  let conversationPlanWorkflow: ConversationPlanWorkflowService | null = null;
  let executionConversationService: ExecutionConversationService | null = null;
  let conversationActionDelivery: ConversationActionDeliveryWorker | null = null;
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
      // EXECUTION E2: a rejection here (a transient DB error, or the pool
      // closing during shutdown) was previously unhandled — `.finally()`
      // does not catch, and nothing else held the promise. Node treats an
      // unhandled rejection as fatal by default, so a single failed tick
      // could crash the whole server. Caught and logged the same way the
      // debate worker's own tick already is in main.ts.
      void dispatcher
        .tick()
        .catch((error) =>
          console.error(
            `phase 4 dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          ticking = false;
        });
    }, 500);
    phase4DispatchTimer.unref();
    let scanning = false;
    phase4RecoveryTimer = setInterval(() => {
      if (scanning) return;
      scanning = true;
      void options.phase4?.recovery
        .scan()
        .catch((error) =>
          console.error(
            `phase 4 recovery scan failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          scanning = false;
        });
    }, 60_000);
    phase4RecoveryTimer.unref();
  }
  if (options.phase4 && options.execution) {
    const continuationWorker = new HumanWaitContinuationWorker(
      options.execution.transactions,
      async (candidate) => {
        if (candidate.repository_binding_type === "local_runner") {
          const paired = candidate.repository_runner_id
            ? stores.runner(candidate.repository_runner_id)
            : null;
          return paired
            ? {
                kind: "local" as const,
                runner_id: paired.runner_id,
                runner_generation: paired.generation,
              }
            : null;
        }
        if (!options.actionsExecution) return null;
        const prepared = await options.actionsExecution.coordinator.prepareContinuation(
          candidate.project_id,
        );
        if (prepared.repository_binding_id !== candidate.repository_binding_id) {
          throw new Error("continuation Actions binding changed during provisioning");
        }
        const runnerId = actionsDispatchRunnerId(candidate.project_id, candidate.continuation_id);
        const reserved = stores.runner(runnerId);
        return {
          kind: "actions" as const,
          runner_id: runnerId,
          runner_generation: reserved?.generation ?? stores.reserveRunnerGeneration(runnerId),
        };
      },
      {
        ...(options.deviceActionAuthorization
          ? { deviceAuthorization: options.deviceActionAuthorization.service }
          : {}),
        afterProvision: async (provisioned) => {
          if (provisioned.target.kind !== "actions") return;
          if (!options.actionsExecution) {
            throw new Error("Actions continuation was provisioned without an Actions runtime");
          }
          await options.actionsExecution.coordinator.launchContinuation({
            project_id: provisioned.command.project_id,
            repository_binding_id: provisioned.command.repository_binding_id,
            dispatch_job_id: provisioned.command.dispatch_job_id,
            run_id: provisioned.command.run_id,
            runner_id: provisioned.target.runner_id,
            runner_generation: provisioned.target.runner_generation,
          });
        },
      },
    );
    const pauseResumeWorker = new PauseResumeContinuationWorker(
      options.execution.transactions,
      async (candidate) => {
        if (candidate.repository_binding_type === "local_runner") {
          const paired = candidate.repository_runner_id
            ? stores.runner(candidate.repository_runner_id)
            : null;
          return paired
            ? {
                kind: "local" as const,
                runner_id: paired.runner_id,
                runner_generation: paired.generation,
              }
            : null;
        }
        if (!options.actionsExecution) return null;
        const prepared = await options.actionsExecution.coordinator.prepareContinuation(
          candidate.project_id,
        );
        if (prepared.repository_binding_id !== candidate.repository_binding_id) {
          throw new Error("pause-resume Actions binding changed during provisioning");
        }
        const runnerId = actionsDispatchRunnerId(candidate.project_id, candidate.continuation_id);
        const reserved = stores.runner(runnerId);
        return {
          kind: "actions" as const,
          runner_id: runnerId,
          runner_generation: reserved?.generation ?? stores.reserveRunnerGeneration(runnerId),
        };
      },
      async (provisioned) => {
        if (provisioned.target.kind !== "actions") return;
        if (!options.actionsExecution) {
          throw new Error("Actions pause resume was provisioned without an Actions runtime");
        }
        await options.actionsExecution.coordinator.launchContinuation({
          project_id: provisioned.command.project_id,
          repository_binding_id: provisioned.command.repository_binding_id,
          dispatch_job_id: provisioned.command.dispatch_job_id,
          run_id: provisioned.command.run_id,
          runner_id: provisioned.target.runner_id,
          runner_generation: provisioned.target.runner_generation,
        });
      },
      undefined,
      options.deviceActionAuthorization?.service,
    );
    let continuationTicking = false;
    humanWaitContinuationTimer = setInterval(() => {
      if (continuationTicking) return;
      continuationTicking = true;
      void continuationWorker
        .tick()
        .then(() => pauseResumeWorker.tick())
        .then(() => options.actionsExecution?.coordinator.recoverNextLaunch())
        .then(() => options.actionsExecution?.coordinator.reconcileNextUnenrolledRun())
        .catch((error) => app.log.error({ err: error }, "human-wait continuation tick failed"))
        .finally(() => {
          continuationTicking = false;
        });
    }, 500);
    humanWaitContinuationTimer.unref();
    const humanWaitRecovery = new HumanWaitRecoveryWorker(options.execution.transactions);
    let humanWaitRecoveryRunning = false;
    humanWaitRecoveryTimer = setInterval(() => {
      if (humanWaitRecoveryRunning) return;
      humanWaitRecoveryRunning = true;
      void humanWaitRecovery
        .scan()
        .catch((error) => app.log.error({ err: error }, "human-wait recovery scan failed"))
        .finally(() => {
          humanWaitRecoveryRunning = false;
        });
    }, 60_000);
    humanWaitRecoveryTimer.unref();
  }
  if (options.execution) {
    conversationActionDelivery = new ConversationActionDeliveryWorker(
      options.execution.transactions,
      {
        resolveTarget: async (candidate) => {
          const runner = stores.runner(candidate.runner_id);
          const socket = runnerSockets.get(candidate.runner_id);
          const reconciled = reconciledRunners.get(candidate.runner_id);
          if (
            !runner ||
            !socket ||
            !reconciled ||
            reconciled.socket !== socket ||
            reconciled.generation !== runner.generation ||
            runner.generation !== candidate.runner_generation
          ) {
            return null;
          }
          return { runner_id: runner.runner_id, generation: runner.generation };
        },
        enqueue: (command) => {
          const record = stores.enqueueCommand(command, now());
          return record.state === "queued" || record.state === "delivered";
        },
        notify: (runnerId) => {
          if (!runnerSockets.has(runnerId)) return false;
          deliverPending(runnerId, new Set());
          return true;
        },
        cancel: (commandId) => {
          stores.setCommandState(commandId, "cancelled", now());
        },
      },
      {
        ...(options.deviceActionAuthorization
          ? { deviceAuthorization: options.deviceActionAuthorization.service }
          : {}),
      },
    );
    const conversationActionCheckpoint = new ConversationActionCheckpointWorker(
      options.execution.transactions,
      {
        contextBaseUrl: options.execution.baseUrl ?? options.publicOrigin ?? "http://127.0.0.1",
        ...(phase6Mockups ? { phase6: phase6Mockups } : {}),
      },
    );
    const phase6MockupWorker = phase6Mockups
      ? new Phase6MockupWorker(options.execution.transactions, phase6Mockups)
      : null;
    let actionDeliveryTicking = false;
    conversationActionDeliveryTimer = setInterval(() => {
      if (actionDeliveryTicking) return;
      actionDeliveryTicking = true;
      void conversationActionDelivery
        ?.tick()
        .then(() => conversationActionCheckpoint.tick())
        .catch((error) => app.log.error({ err: error }, "conversation action delivery tick failed"))
        .finally(() => {
          actionDeliveryTicking = false;
        });
    }, 500);
    conversationActionDeliveryTimer.unref();
    if (phase6MockupWorker) {
      let mockupTicking = false;
      phase6MockupTimer = setInterval(() => {
        if (mockupTicking) return;
        mockupTicking = true;
        void phase6MockupWorker
          .tick()
          .catch((error) => app.log.error({ err: error }, "Phase 6 mockup render tick failed"))
          .finally(() => {
            mockupTicking = false;
          });
      }, 1_000);
      phase6MockupTimer.unref();
    }
    const pmUpdateScheduler = new ConversationPmUpdateScheduler(options.execution.transactions);
    let pmUpdateTicking = false;
    conversationPmUpdateTimer = setInterval(() => {
      if (pmUpdateTicking) return;
      pmUpdateTicking = true;
      void pmUpdateScheduler
        .scan()
        .catch((error) => app.log.error({ err: error }, "conversation PM update tick failed"))
        .finally(() => {
          pmUpdateTicking = false;
        });
    }, 60_000);
    conversationPmUpdateTimer.unref();
  }
  app.addHook("onClose", async () => {
    if (phase4DispatchTimer) clearInterval(phase4DispatchTimer);
    if (phase4RecoveryTimer) clearInterval(phase4RecoveryTimer);
    if (humanWaitContinuationTimer) clearInterval(humanWaitContinuationTimer);
    if (humanWaitRecoveryTimer) clearInterval(humanWaitRecoveryTimer);
    if (conversationActionDeliveryTimer) clearInterval(conversationActionDeliveryTimer);
    if (phase6MockupTimer) clearInterval(phase6MockupTimer);
    if (phase6VisualEvidenceTimer) clearInterval(phase6VisualEvidenceTimer);
    if (conversationPmUpdateTimer) clearInterval(conversationPmUpdateTimer);
    if (phaseQueueDrainTimer) clearInterval(phaseQueueDrainTimer);
    if (usageBudgetEvaluationTimer) clearInterval(usageBudgetEvaluationTimer);
    if (conversationKickoffTimer) clearInterval(conversationKickoffTimer);
    conversationTurns?.abortAll();
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

  const queueValidatedSessionDelivery = (
    binding: SessionSocketBinding,
    raw: string,
    authorize: (userId: string) => Promise<boolean> = async () => true,
  ): Promise<void> => {
    const delivery = binding.delivery.then(async () => {
      if (!binding.active) throw new Error("session inactive");
      const currentUser = await identityService.userForToken(binding.token);
      if (!currentUser || currentUser.id !== binding.userId || currentUser.status !== "active") {
        closeSessionSocket(binding, "session no longer valid");
        throw new Error("session no longer valid");
      }
      if (!binding.active) throw new Error("session inactive");
      if (!(await authorize(binding.userId))) return;
      try {
        binding.socket.send(raw);
      } catch {
        closeSessionSocket(binding, "connection unavailable");
        throw new Error("connection unavailable");
      }
    });
    binding.delivery = delivery.catch(() => {
      closeSessionSocket(binding, "session validation failed");
    });
    return delivery;
  };

  /**
   * Historical runner frames are project-scoped by durable attribution.
   * Device metadata must use ScopedDeviceBrowserDelivery instead. The global
   * branch exists only behind the explicit disabled-by-default compatibility
   * option.
   */
  type LegacyBrowserFrameScope =
    | { kind: "runner"; runner_id: string }
    | {
        kind: "command";
        command_id: string;
        runner_id?: string;
        project_id?: string;
      }
    | { kind: "run"; run_id: string; runner_id: string }
    | { kind: "project_runner"; project_id: string; runner_id: string };
  const canReceiveLegacyBrowserFrame = async (
    userId: string,
    scope: LegacyBrowserFrameScope,
  ): Promise<boolean> => {
    if (legacyGlobalRunnerCompatibilityEnabled) return true;
    if (!legacyRunnerAuthorization) return false;
    if (scope.kind === "runner") {
      return (await legacyRunnerAuthorization.runnerIdsForUser(userId)).has(scope.runner_id);
    }
    if (scope.kind === "command") {
      const durableCommandAccess = await legacyRunnerAuthorization.canAccessCommand({
        user_id: userId,
        command_id: scope.command_id,
        ...(scope.runner_id === undefined ? {} : { runner_id: scope.runner_id }),
      });
      if (durableCommandAccess || scope.project_id === undefined || scope.runner_id === undefined) {
        return durableCommandAccess;
      }
      // Relay-only compatibility commands are not rows in the v2 command
      // ledger. Their immutable in-memory envelope still supplies exact
      // project/runner attribution, which is revalidated at delivery time.
      return legacyRunnerAuthorization.canAccessProjectRunner({
        user_id: userId,
        project_id: scope.project_id,
        runner_id: scope.runner_id,
      });
    }
    if (scope.kind === "run") {
      return legacyRunnerAuthorization.canAccessRun({
        user_id: userId,
        run_id: scope.run_id,
        runner_id: scope.runner_id,
      });
    }
    return legacyRunnerAuthorization.canAccessProjectRunner({
      user_id: userId,
      project_id: scope.project_id,
      runner_id: scope.runner_id,
    });
  };
  const broadcastLegacyRunnerCompatibility = (
    message: Record<string, unknown>,
    scope: LegacyBrowserFrameScope,
  ): void => {
    const raw = JSON.stringify(message);
    for (const binding of sessionSockets.values()) {
      void queueValidatedSessionDelivery(binding, raw, (userId) =>
        canReceiveLegacyBrowserFrame(userId, scope),
      );
    }
  };

  const legacyRunnerCompatibilitySnapshot = async (userId: string) => {
    const allowedRunnerIds = legacyGlobalRunnerCompatibilityEnabled
      ? null
      : await legacyRunnerAuthorization?.runnerIdsForUser(userId);
    if (allowedRunnerIds === undefined) return [];
    return stores
      .runners()
      .filter((runner) => allowedRunnerIds?.has(runner.runner_id) ?? true)
      .map((runner) => ({
        runner_id: runner.runner_id,
        connected: runnerSockets.has(runner.runner_id),
      }));
  };

  const scopedDeviceBrowserSessions = () =>
    [...sessionSockets.values()].map((binding) => ({
      user_id: binding.userId,
      send: (frame: unknown) => queueValidatedSessionDelivery(binding, JSON.stringify(frame)),
    }));

  /** Resolve the caller's bearer token to a real user, or undefined. Real
   *  per-user sessions are the only session credential — the deploy token is
   *  never accepted here, only by the bootstrap route below. */
  const compatibilityActorPromises = new Map<string, Promise<void>>();
  const ensureCompatibilityActor = (user: IdentityUser): Promise<void> => {
    if (!usesLegacyIdentity || !runtimeTransactionsForInference || options.relationalComposition) {
      return Promise.resolve();
    }
    const legacy = users.snapshot().users.find((candidate) => candidate.id === user.id);
    if (!legacy?.passwordHash) {
      return Promise.reject(
        new RelationalCompositionConflictError(
          "legacy_actor_credential_invalid",
          "identity_bridge",
          "Sign out and sign in again. If the problem persists, repair the legacy user snapshot.",
          `authenticated legacy actor ${user.id} has no durable credential`,
        ),
      );
    }
    const passwordScheme = detectPasswordHashScheme(legacy.passwordHash);
    if (!passwordScheme) {
      return Promise.reject(
        new RelationalCompositionConflictError(
          "legacy_actor_credential_invalid",
          "identity_bridge",
          "Repair or re-create the legacy account before using relational workflows.",
          `legacy actor ${user.id} has an unsupported credential`,
        ),
      );
    }
    const key = [
      user.id,
      user.email,
      user.name,
      user.role,
      user.status,
      user.createdAt,
      legacy.passwordHash,
    ].join("\u0000");
    const existing = compatibilityActorPromises.get(key);
    if (existing) return existing;
    const pending = runtimeTransactionsForInference
      .transaction(async (sql) => {
        const normalizedEmail = user.email.trim().toLowerCase();
        await sql.query(
          `INSERT INTO users (
             id, username, display_name, email, name, password_hash,
             password_hash_scheme, role, status, source, source_record_id,
             created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,'legacy_snapshot',$1,$10,$10
           )
           ON CONFLICT (id) DO NOTHING`,
          [
            user.id,
            normalizedEmail,
            user.name ?? user.email,
            normalizedEmail,
            user.name,
            legacy.passwordHash,
            passwordScheme,
            user.role,
            user.status,
            user.createdAt,
          ],
        );
        const stored = (
          await sql.query<{
            email: string;
            role: string;
            status: string;
          }>("SELECT email, role, status FROM users WHERE id=$1", [user.id])
        ).rows[0];
        if (
          !stored ||
          stored.email !== normalizedEmail ||
          stored.role !== user.role ||
          stored.status !== user.status
        ) {
          throw new RelationalCompositionConflictError(
            "relational_actor_conflict",
            "identity_bridge",
            "Reconcile the legacy and relational identity records before retrying.",
            `relational actor ${user.id} conflicts with the authenticated legacy identity`,
          );
        }
      })
      .catch((error) => {
        compatibilityActorPromises.delete(key);
        if (error instanceof RelationalCompositionConflictError) throw error;
        throw new RelationalCompositionConflictError(
          "relational_actor_conflict",
          "identity_bridge",
          "Reconcile duplicate identity records, then retry the authenticated action.",
          `relational identity cannot accept legacy actor ${user.id}`,
        );
      });
    compatibilityActorPromises.set(key, pending);
    return pending;
  };

  const resolveUser = async (req: FastifyRequest): Promise<IdentityUser | undefined> => {
    const token = credentialFor(req);
    if (!token) return undefined;
    const user = await identityService.userForToken(token);
    if (user) {
      await options.relationalComposition?.ensureActor(user);
      await ensureCompatibilityActor(user);
    }
    return user;
  };

  const requireSessionUser = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<IdentityUser | null> => {
    const user = await resolveUser(req);
    if (!user) {
      stores.audit("anonymous", "auth.rejected", `${req.method} ${req.url}`, now());
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return user;
  };
  const requireSession = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> =>
    (await requireSessionUser(req, reply)) !== null;
  const requireRecentSessionUser = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<IdentityUser | null> => {
    const user = await requireSessionUser(req, reply);
    if (!user) return null;
    const token = credentialFor(req);
    if (
      !token ||
      !identityService.isRecentSession ||
      !(await identityService.isRecentSession(token, RECENT_AUTH_MS))
    ) {
      stores.audit(user.email, "auth.recent_required", `${req.method} ${req.url}`, now());
      reply.code(403).send({ error: "recent_auth_required" });
      return null;
    }
    return user;
  };

  app.get("/api/v2/capabilities/local-execution", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    return reply
      .header("Cache-Control", "no-store")
      .header("Pragma", "no-cache")
      .send(
        LocalExecutionCapabilitiesProjection.parse({
          schema_version: 1,
          enrollment_available: options.deviceEnrollment !== undefined,
          computers_available: options.deviceManagement !== undefined,
          repository_grants_available: options.deviceRepositoryAccess !== undefined,
          legacy_claim_available: options.legacyRepositoryClaims !== undefined,
          legacy_local_creation_available: legacyHelperRoutesEnabled,
        }),
      );
  });
  const rejectLegacyRunnerAccess = (
    user: IdentityUser,
    reply: FastifyReply,
    operation: string,
  ): false => {
    stores.audit(user.id, "legacy_runner.forbidden", operation, now());
    reply.code(403).send({
      error: "legacy_runner_access_forbidden",
      message: "This legacy runner operation is not attributed to one of your projects.",
    });
    return false;
  };
  const requireLegacyGlobalCompatibility = (
    user: IdentityUser,
    reply: FastifyReply,
    operation: string,
  ): boolean =>
    legacyGlobalRunnerCompatibilityEnabled || rejectLegacyRunnerAccess(user, reply, operation);
  const requireLegacyHelperRoutes = (reply: FastifyReply): boolean => {
    if (legacyHelperRoutesEnabled) return true;
    reply.code(404).send({ error: "not_found" });
    return false;
  };
  const canUseLegacyProjectRunner = async (input: {
    user_id: string;
    project_id: string;
    runner_id: string;
    payload: z.infer<typeof CommandPayload>;
  }): Promise<boolean> => {
    if (legacyGlobalRunnerCompatibilityEnabled) return true;
    if (!legacyRunnerAuthorization) return false;
    const runId = "run_id" in input.payload ? input.payload.run_id : undefined;
    if (
      runId !== undefined &&
      !(await legacyRunnerAuthorization.canAccessRun({
        user_id: input.user_id,
        project_id: input.project_id,
        run_id: runId,
        runner_id: input.runner_id,
      }))
    ) {
      return false;
    }
    if (
      input.payload.kind !== "launch_run" &&
      input.payload.kind !== "collect_visual_evidence" &&
      runId !== undefined
    ) {
      return true;
    }
    const repositoryBindingId =
      input.payload.kind === "collect_visual_evidence"
        ? input.payload.repository_binding_id
        : input.payload.kind === "launch_run"
          ? input.payload.dispatch?.repository_binding_id
          : undefined;
    return legacyRunnerAuthorization.canAccessProjectRunner({
      user_id: input.user_id,
      project_id: input.project_id,
      runner_id: input.runner_id,
      ...(repositoryBindingId === undefined ? {} : { repository_binding_id: repositoryBindingId }),
    });
  };

  if (options.deviceEnrollment) {
    await registerDeviceEnrollmentRoutes(app, {
      service: options.deviceEnrollment.service,
      requireUser: requireSessionUser,
      requireRecentUser: requireRecentSessionUser,
      now,
    });
  }

  if (options.deviceManagement) {
    await registerDeviceManagementRoutes(app, {
      service: options.deviceManagement.service,
      localAgentDownloads,
      requireUser: requireSessionUser,
    });
  }
  if (options.deviceRepositoryAccess) {
    await registerDeviceRepositoryAccessRoutes(app, {
      ...options.deviceRepositoryAccess,
      requireUser: requireSessionUser,
    });
  }
  if (options.deviceControl) {
    await registerProjectCancellationRoutes(app, {
      service: options.deviceControl.cancellations,
      requireUser: requireSessionUser,
      now,
    });
  }
  if (options.legacyRepositoryClaims) {
    await registerLegacyRepositoryClaimRoutes(app, {
      ...options.legacyRepositoryClaims,
      requireUser: requireSessionUser,
      now,
    });
  }

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

  let projectAccessService: ProjectAccessService | null = null;
  const projectRepositoryForAccess = options.projects
    ? projectRepository(options.projects)
    : undefined;

  // Canonical AI usage host composition. The relational runtime is the single
  // source for collaboration, reporting, budget, and analytics authorization.
  // When it is absent these routes remain unavailable, matching every other
  // relational V2 feature instead of silently falling back to broad access.
  if (runtimeTransactionsForInference) {
    const projectAccess = new ProjectAccessService(
      new PostgresProjectAccessRepository(runtimeTransactionsForInference),
    );
    projectAccessService = projectAccess;
    const strictProjectAccess = async (userId: string, projectId: string): Promise<boolean> => {
      try {
        const access = await projectAccess.access(projectId, { id: userId });
        // The legacy-unowned compatibility state is intentionally not enough
        // to authorize cost/usage data. Reporting is deny-by-default until an
        // owner or explicit active membership exists.
        return access.can_access && access.source !== "legacy_unowned";
      } catch {
        return false;
      }
    };
    const projectForPhase = async (phaseId: string): Promise<string | null> => {
      try {
        return await runtimeTransactionsForInference.transaction(async (sql) => {
          const result = await sql.query<{ project_id: string }>(
            "SELECT project_id FROM phases WHERE id=$1",
            [phaseId],
          );
          return result.rows[0]?.project_id ?? null;
        });
      } catch {
        return null;
      }
    };

    // Every project-scoped host route registered below this composition point
    // shares one deny-by-default authorization gate. Collaboration's explicit
    // access-decision route remains callable so a signed-in non-member can
    // receive a truthful `can_access: false`; membership/ownership routes add
    // their stricter owner-only checks inside ProjectAccessService.
    app.addHook("preHandler", async (request, reply) => {
      const route = request.routeOptions.url ?? "";
      if (route === "/api/v2/project-access" || route === "/api/v2/projects/:projectId/access") {
        return;
      }
      if (
        !route.startsWith("/api/projects/:id") &&
        !route.startsWith("/api/v2/projects/:id") &&
        !route.startsWith("/api/v2/projects/:projectId")
      ) {
        return;
      }
      const params = request.params as { id?: string; projectId?: string };
      const projectId = params.id ?? params.projectId;
      if (!projectId) return;
      const user = await requireSessionUser(request, reply);
      if (!user) return reply;
      try {
        await projectAccess.assertCanAccess(projectId, { id: user.id });
      } catch (error) {
        if (!(error instanceof ProjectAccessError)) throw error;
        if (
          error.code === "project_not_found" &&
          user.role === "admin" &&
          options.relationalComposition &&
          projectRepositoryForAccess
        ) {
          try {
            const legacyProject = await projectRepositoryForAccess.summary(projectId);
            await options.relationalComposition.ensureProjectAnchor(legacyProject, user.id);
            await projectAccess.assertCanAccess(projectId, { id: user.id });
            return;
          } catch (anchorError) {
            if (
              anchorError instanceof RelationalCompositionConflictError ||
              !(anchorError instanceof ProjectNotFoundError)
            ) {
              throw anchorError;
            }
          }
        }
        const status =
          error.code === "project_not_found" ? 404 : error.code === "identity_inactive" ? 401 : 403;
        const responseCode =
          error.code === "project_not_found" && route === "/api/v2/projects/:id/planning-reviewer"
            ? "not_found"
            : error.code;
        return reply.code(status).send({ error: responseCode, message: error.message });
      }
    });

    registerProjectAccessRoutes(app, {
      service: projectAccess,
      requireIdentity: requireSessionUser,
    });

    const usageIntelligence = new UsageIntelligenceService(runtimeTransactionsForInference);
    registerUsageIntelligenceRoutes(app, {
      service: usageIntelligence,
      resolveUser,
      authorizeScope: async (user, scope) => {
        if (scope.kind === "project") {
          return strictProjectAccess(user.id, scope.id);
        }
        const projectId = await projectForPhase(scope.id);
        return projectId !== null && strictProjectAccess(user.id, projectId);
      },
    });

    const usageBudgets = new UsageBudgetPolicyService(
      new PostgresUsageBudgetPolicyRepository(runtimeTransactionsForInference),
      { clock: now },
    );
    registerUsageBudgetPolicyRoutes(app, {
      service: usageBudgets,
      resolveUser,
      authorizeProject: async (user, projectId, action) => {
        try {
          const access = await projectAccess.access(projectId, { id: user.id });
          if (access.source === "legacy_unowned") return false;
          return action === "read"
            ? access.can_access
            : access.can_manage_members || user.role === "admin";
        } catch {
          return false;
        }
      },
    });

    registerUsageAnalyticsRoutes(app, {
      service: new UsageAnalyticsService(runtimeTransactionsForInference, now),
      requireAdmin,
    });

    // Evaluation is periodic rather than inline with provider settlement.
    // Telemetry writes are deliberately best-effort and provider responses
    // must never wait on a cross-scope budget scan. The notification table's
    // period/threshold/metric uniqueness makes every scan retry-safe.
    let evaluationInFlight = false;
    usageBudgetEvaluationTimer = setInterval(() => {
      if (evaluationInFlight) return;
      evaluationInFlight = true;
      void usageBudgets
        .evaluate()
        .catch((error) =>
          console.error(
            `usage budget evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          evaluationInFlight = false;
        });
    }, 60_000);
    usageBudgetEvaluationTimer.unref();
  }

  const ensureAuthenticatedProjectOwner = async (
    project: Awaited<ReturnType<ProjectRepository["create"]>>,
    ownerUserId: string,
  ): Promise<void> => {
    if (!runtimeTransactionsForInference) return;
    await runtimeTransactionsForInference.transaction((sql) =>
      insertProjectCore(sql, {
        projectId: project.id,
        name: project.name,
        description: project.description,
        pmProvider: project.pm_provider,
        pmModel: project.pm_model,
        reviewerProvider: project.reviewer_provider,
        createdAt: project.created_at,
        ownerUserId,
        onboardingScenario: project.onboarding_scenario,
      }),
    );
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

  if (options.execution) {
    const visualEvidenceCollectionWorker = new Phase6VisualEvidenceCollectionWorker(
      options.execution.transactions,
      {
        prepareTarget: async (collection) => {
          if (!options.actionsExecution) {
            throw new Error(
              "GitHub Actions execution is required for fresh visual evidence collection",
            );
          }
          const prepared = await options.actionsExecution.coordinator.prepareContinuation(
            collection.project_id,
          );
          if (prepared.repository_binding_id !== collection.repository_binding_id) {
            throw new Error("visual evidence Actions binding changed during provisioning");
          }
          const runnerId = actionsDispatchRunnerId(collection.project_id, collection.id);
          const reserved = stores.runner(runnerId);
          return {
            repository_binding_id: prepared.repository_binding_id,
            runner_id: runnerId,
            runner_generation: reserved?.generation ?? stores.reserveRunnerGeneration(runnerId),
          };
        },
        launch: async (input) => {
          if (!options.actionsExecution) {
            throw new Error(
              "GitHub Actions execution is required for fresh visual evidence collection",
            );
          }
          await options.actionsExecution.coordinator.launchContinuation(input);
        },
        enqueue: (command) => {
          const record = stores.enqueueCommand(command, now());
          return record.state === "queued" || record.state === "delivered";
        },
        notify: (runnerId) => deliverPending(runnerId, new Set()),
      },
    );
    let visualEvidenceTicking = false;
    phase6VisualEvidenceTimer = setInterval(() => {
      if (visualEvidenceTicking) return;
      visualEvidenceTicking = true;
      void visualEvidenceCollectionWorker
        .tick()
        .catch((error) =>
          app.log.error({ err: error }, "Phase 6 visual evidence collection tick failed"),
        )
        .finally(() => {
          visualEvidenceTicking = false;
        });
    }, 1_000);
    phase6VisualEvidenceTimer.unref();
  }

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

  const UpdateUserRoleBody = z
    .object({
      role: z.enum(["admin", "member"]),
    })
    .strict();

  app.patch("/api/admin/users/:id/role", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    const body = UpdateUserRoleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const { id } = req.params as { id: string };
    try {
      const updated = await identityService.updateRole(id, body.data.role);
      stores.audit(admin.email, "admin.user_role_updated", id, now());
      reply.send(updated);
    } catch (error) {
      if (error instanceof LastActiveAdminError) {
        return reply.code(409).send({
          error: "last_active_admin",
          message: error.message,
        });
      }
      if (error instanceof UserNotFoundError) {
        return reply.code(404).send({ error: "not_found" });
      }
      throw error;
    }
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

  app.get("/api/v2/admin/rules", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    if (!globalRulesService) {
      return reply.code(503).send({
        error: "global_rules_unavailable",
        message: "Global rules require the relational database runtime.",
      });
    }
    reply.header("Cache-Control", "no-store").send(await globalRulesService.get());
  });

  app.put("/api/v2/admin/rules", async (req, reply) => {
    const admin = await requireAdmin(req, reply);
    if (!admin) return;
    if (!globalRulesService) {
      return reply.code(503).send({
        error: "global_rules_unavailable",
        message: "Global rules require the relational database runtime.",
      });
    }
    const body = z
      .object({ content: z.string().max(100_000) })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const rules = await globalRulesService.save(admin.id, body.data.content);
    stores.audit(admin.id, "global.rules_updated", `${rules.version}`, now());
    reply.send(rules);
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
      if (
        !legacyGlobalRunnerCompatibilityEnabled &&
        (!legacyRunnerAuthorization ||
          !(await legacyRunnerAuthorization.canRevokeRunner({
            user_id: admin.id,
            runner_id: runnerId,
          })))
      ) {
        return rejectLegacyRunnerAccess(admin, reply, "admin runner revocation");
      }
      await options.phase7?.operations.revokeRunner({
        runner_id: runnerId,
        ...body.data,
        revoked_by: admin.id,
        revoked_at: now().toISOString(),
      });
      stores.revokeRunnerSessions(runnerId);
      reconciledRunners.delete(runnerId);
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

  // ---- native local-folder helper -------------------------------------------

  app.post("/api/pairing/start", async (req, reply) => {
    if (!legacyPairingRoutesEnabled) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!(await requireSession(req, reply))) return;
    const code = pairingCode();
    const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS);
    stores.createPairing(code, expiresAt);
    stores.audit("operator", "pairing.started", code, now());
    const origin = externalOrigin(req);
    const runnerId = (req.query as { runner_id?: string } | undefined)?.runner_id;
    if (runnerId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(runnerId)) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const target = { origin, code, ...(runnerId ? { runnerId } : {}) };
    return reply.send({
      code,
      expires_at: expiresAt.toISOString(),
      runner_id: runnerId ?? "runner-1",
      pairing_uri: localAgentPairingUri(target),
      downloads: localAgentDownloads,
      install_command: installCommand(target),
      install_command_windows: installCommandWindows(target),
    });
  });

  const PairingComplete = z.object({
    code: z.string().min(1),
    runner_id: z.string().min(1),
    public_key_pem: z.string().min(1),
  });

  app.post("/api/pairing/complete", (req, reply) => {
    if (!legacyPairingRoutesEnabled) {
      return reply.code(404).send({ error: "not_found" });
    }
    const parsed = PairingComplete.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const { code, runner_id, public_key_pem } = parsed.data;
    if (!stores.consumePairing(code, now())) {
      stores.audit(`runner:${runner_id}`, "pairing.rejected", "invalid or expired code", now());
      return reply.code(403).send({ error: "invalid_pairing_code" });
    }
    const record = stores.registerRunner(runner_id, public_key_pem);
    reconciledRunners.delete(runner_id);
    workspaceBroker.disconnect(runner_id);
    const priorSocket = runnerSockets.get(runner_id);
    if (priorSocket) {
      runnerSockets.delete(runner_id);
      sendFrame(priorSocket, { type: "fenced", current_generation: record.generation });
      priorSocket.close(1008, "runner re-paired");
      broadcastLegacyRunnerCompatibility(
        {
          type: "runner_status",
          runner_id,
          connected: false,
        },
        { kind: "runner", runner_id },
      );
    }
    stores.audit(
      `runner:${runner_id}`,
      "pairing.completed",
      `generation=${record.generation}`,
      now(),
    );
    return reply.send({ runner_id, generation: record.generation });
  });

  if (options.installScriptsDir && legacyHelperRoutesEnabled) {
    for (const [route, filename] of Object.entries({
      "/install/runner.sh": "install-runner.sh",
      "/install/runner.ps1": "install-runner.ps1",
    })) {
      app.get(route, (_req, reply) => {
        try {
          return reply
            .type("text/plain; charset=utf-8")
            .header("cache-control", "no-store")
            .header("x-content-type-options", "nosniff")
            .send(readFileSync(join(options.installScriptsDir ?? "", filename), "utf8"));
        } catch {
          return reply.code(404).send({ error: "installer_unavailable" });
        }
      });
    }
  }

  // ---- ONBOARDING O4: GitHub Actions-hosted execution ------------------------
  //
  // The human will not install or run Norns software on their machine, so
  // execution moves into GitHub Actions. The *existing* runner is what runs
  // there — ephemerally, inside a job, dialling this relay outbound exactly as
  // a laptop runner does, and evaporating when the job ends. These three
  // routes are the whole server-side surface of that path.

  // Identical to ScheduleTaskBody except that `runner_id` is absent: the
  // ephemeral runner identity belongs to the repository binding and is never
  // client-supplied, and its generation is reserved server-side per launch.
  const ScheduleActionsTaskBody = z.object({
    assignment_id: z.string().min(1),
    context_refs: z.array(V2ContentAddressedReference).min(1),
    target_branch: z.string().min(1),
    worktree_policy_ref: z.string().min(1),
    sandbox_policy_ref: z.string().min(1),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    max_duration_seconds: z.number().int().positive(),
  });

  if (options.actionsExecution) {
    const actions = options.actionsExecution;

    const ActionsEnroll = z.object({
      enrollment_token: z.string().min(1),
      runner_id: z.string().min(1),
      dispatch_job_id: z.string().min(1),
      public_key_pem: z.string().min(1),
    });

    // Deliberately NOT session-authenticated: the caller is an ephemeral runner
    // in a CI job, and the repository-scoped enrollment token is its
    // credential. Every rejection returns the same opaque 403 so the endpoint
    // cannot be used to probe which projects or jobs exist.
    app.post("/api/actions/enroll", async (req, reply) => {
      const parsed = ActionsEnroll.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const body = parsed.data;
      try {
        const enrolled = await actions.enrollment.redeem(body);
        stores.audit(
          `runner:${body.runner_id}`,
          "actions.enrollment.completed",
          `job=${body.dispatch_job_id} generation=${enrolled.generation}`,
          now(),
        );
        return reply.send({ runner_id: enrolled.runner_id, generation: enrolled.generation });
      } catch (error) {
        stores.audit(
          `runner:${body.runner_id}`,
          "actions.enrollment.rejected",
          `job=${body.dispatch_job_id} ${error instanceof ActionsExecutionError ? error.code : "error"}`,
          now(),
        );
        return reply.code(403).send({ error: "invalid_enrollment" });
      }
    });

    // Schedule a task and launch an Actions-hosted runner for it. This does not
    // weaken the Phase 4 dispatch gate — ActionsExecutionCoordinator calls
    // Phase4Coordinator.schedule() unchanged and only adds preconditions.
    app.post(
      "/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/schedule-actions",
      async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const { id, phaseId, taskId } = req.params as {
          id: string;
          phaseId: string;
          taskId: string;
        };
        const body = ScheduleActionsTaskBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const issuedAt = now();
        try {
          const scheduled = await actions.coordinator.schedule({
            ...body.data,
            project_id: id,
            phase_id: phaseId,
            task_id: taskId,
            authorized_by: { actor_type: "human", actor_id: user.id },
            authorized_by_session_id: `authenticated-request:${req.id}`,
            correlation_id: newId("correlation"),
            causation_id: null,
            issued_at: issuedAt.toISOString(),
            expires_at: new Date(issuedAt.getTime() + DEFAULT_COMMAND_TTL_MS).toISOString(),
          });
          stores.audit(
            user.email,
            "actions.run.dispatched",
            `${scheduled.run_id} -> ${scheduled.actions.github_run_url ?? "queued"}`,
            issuedAt,
          );
          return reply.code(202).send(scheduled);
        } catch (error) {
          if (error instanceof ActionsExecutionError) {
            return reply.code(409).send({
              error: error.code,
              detail: error.message,
              action_required: error.action_required,
            });
          }
          return reply.code(409).send({ error: "schedule_conflict", detail: String(error) });
        }
      },
    );

    // Status of the Actions job backing a run, for the UI to show a live link.
    app.get("/api/v2/projects/:id/actions/runs/:githubRunId", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, githubRunId } = req.params as { id: string; githubRunId: string };
      const numeric = Number(githubRunId);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        return reply.code(400).send({ error: "bad_request" });
      }
      try {
        return reply.send(await actions.coordinator.runStatus(id, numeric));
      } catch (error) {
        if (error instanceof ActionsExecutionError) {
          return reply.code(409).send({ error: error.code, detail: error.message });
        }
        return reply.code(409).send({ error: "actions_status_unavailable", detail: String(error) });
      }
    });
  }

  // ---- command issuance --------------------------------------------------------

  const IssueCommand = z.object({
    runner_id: z.string().min(1),
    payload: CommandPayload,
    project_id: z.string().min(1).default("proj-fixture"),
    correlation_id: z.string().min(1).optional(),
    expires_in_ms: z.number().int().optional(),
  });

  app.post("/api/commands", async (req, reply) => {
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    const parsed = IssueCommand.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    const body = parsed.data;
    if (
      !(await canUseLegacyProjectRunner({
        user_id: user.id,
        project_id: body.project_id,
        runner_id: body.runner_id,
        payload: body.payload,
      }))
    ) {
      return rejectLegacyRunnerAccess(user, reply, "command issuance");
    }
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
      issued_by_session: user.id,
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
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const record = stores.command(id);
    if (!record) return reply.code(404).send({ error: "not_found" });
    if (
      !(await canUseLegacyProjectRunner({
        user_id: user.id,
        project_id: record.envelope.project_id,
        runner_id: record.envelope.runner_id,
        payload: record.envelope.payload,
      }))
    ) {
      return rejectLegacyRunnerAccess(user, reply, "command observation");
    }
    return reply.send({
      command_id: id,
      state: record.state,
      superseded_terminal: record.superseded_terminal,
      payload: record.envelope.payload,
    });
  });

  // ---- observation -------------------------------------------------------------

  const helperRunnerSnapshots = (): HelperRunnerSnapshot[] =>
    stores
      .runners()
      .filter((runner) => !runner.runner_id.startsWith("actions:"))
      .map((runner) => {
        const reconciled = reconciledRunners.get(runner.runner_id);
        return {
          runner_id: runner.runner_id,
          generation: runner.generation,
          connected:
            runnerSockets.has(runner.runner_id) && reconciled?.generation === runner.generation,
          workspace_picker_ready:
            reconciled?.generation === runner.generation && reconciled.workspacePicker,
          workspace_repository_inventory_ready:
            reconciled?.generation === runner.generation && reconciled.workspaceRepositoryInventory,
          workspace_clone_ready:
            reconciled?.generation === runner.generation && reconciled.workspaceClone,
          last_seen_at: runner.last_seen_at,
        };
      });

  const helperStatusPayload = (req: FastifyRequest) => {
    const origin = externalOrigin(req);
    return {
      ...helperStatus(helperRunnerSnapshots()),
      downloads: localAgentDownloads,
      install_command: installCommand({ origin }),
      install_command_windows: installCommandWindows({ origin }),
    };
  };
  const authorizedHelperRunnerSnapshots = async (
    userId: string,
  ): Promise<HelperRunnerSnapshot[]> => {
    if (legacyGlobalRunnerCompatibilityEnabled) return helperRunnerSnapshots();
    const runnerIds = await legacyRunnerAuthorization?.runnerIdsForUser(userId);
    if (!runnerIds) return [];
    return helperRunnerSnapshots().filter((runner) => runnerIds.has(runner.runner_id));
  };

  app.get("/api/runners/helper/status", async (req, reply) => {
    if (!requireLegacyHelperRoutes(reply)) return;
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    if (!requireLegacyGlobalCompatibility(user, reply, "global helper status")) return;
    return reply.send(helperStatusPayload(req));
  });

  app.get("/api/runners", async (req, reply) => {
    if (!requireLegacyHelperRoutes(reply)) return;
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    return reply.send(await authorizedHelperRunnerSnapshots(user.id));
  });

  app.get("/api/audit", async (req, reply) => {
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    if (legacyGlobalRunnerCompatibilityEnabled) {
      return reply.send(stores.auditEntries());
    }
    const computerActionPrefixes = [
      "device.",
      "runner.",
      "command.",
      "pairing.",
      "workspace.",
      "legacy_runner.",
      "execution.context.",
      "gateway.credential_",
      "phase6.visual_evidence.",
    ];
    return reply.send(
      stores
        .auditEntries()
        .filter(
          (entry) =>
            !entry.actor.startsWith("device:") &&
            !entry.actor.startsWith("runner:") &&
            entry.action !== "kill_switch" &&
            !computerActionPrefixes.some((prefix) => entry.action.startsWith(prefix)),
        ),
    );
  });

  app.get("/api/events/:runnerId", async (req, reply) => {
    if (!requireLegacyHelperRoutes(reply)) return;
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    const { runnerId } = req.params as { runnerId: string };
    const events = stores.eventsFor(runnerId);
    if (legacyGlobalRunnerCompatibilityEnabled) return reply.send(events);
    if (!legacyRunnerAuthorization) {
      return rejectLegacyRunnerAccess(user, reply, "runner event listing");
    }
    const visible = [];
    for (const event of events) {
      const payload = event.payload;
      const authorized =
        "run_id" in payload
          ? await legacyRunnerAuthorization.canAccessRun({
              user_id: user.id,
              run_id: payload.run_id,
              runner_id: runnerId,
            })
          : "command_id" in payload
            ? await legacyRunnerAuthorization.canAccessCommand({
                user_id: user.id,
                command_id: payload.command_id,
                runner_id: runnerId,
              })
            : false;
      if (authorized) visible.push(event);
    }
    return reply.send(visible);
  });

  app.post("/api/kill-switch", async (req, reply) => {
    const user = await requireSessionUser(req, reply);
    if (!user) return;
    if (!requireLegacyGlobalCompatibility(user, reply, "global kill switch")) return;
    const body = z.object({ engaged: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    stores.setKillSwitch(body.data.engaged);
    stores.audit("operator", "kill_switch", body.data.engaged ? "engaged" : "disengaged", now());
    return reply.send({ engaged: body.data.engaged });
  });

  app.get("/health", (_req, reply) => {
    reply.send({ ok: true, contracts: "1.2.0" });
  });

  app.get("/ready", async (_req, reply) => {
    const checkedAt = now().toISOString();
    let databaseStatus: "ready" | "unavailable" | "not_configured" = "not_configured";
    if (runtimeTransactionsForInference) {
      try {
        await runtimeTransactionsForInference.transaction(async (sql) => {
          await sql.query("SELECT 1 AS ready");
        });
        databaseStatus = "ready";
      } catch {
        databaseStatus = "unavailable";
      }
    }

    const runnerSnapshots = helperRunnerSnapshots();
    const connectedRunners = runnerSnapshots.filter((runner) => runner.connected);
    const modelReadiness = modelAvailabilityFromDebateEnvironment(integrationEnvironment);
    const executionModels = executionModelCatalog();
    const availableExecutionModels = executionModels.filter((model) => model.available);
    const anthropicReady = modelReadiness.some(
      (model) => model.provider === "anthropic" && model.available,
    );
    const openAiReady = modelReadiness.some(
      (model) => model.provider === "openai" && model.available,
    );
    const compositionReadiness = options.relationalComposition?.readiness() ?? null;
    const ready =
      databaseStatus !== "unavailable" &&
      (compositionReadiness === null || compositionReadiness.status === "ready");
    return reply.code(ready ? 200 : 503).send({
      ok: ready,
      contracts: "1.2.0",
      checked_at: checkedAt,
      dependencies: {
        database: {
          required: runtimeTransactionsForInference !== undefined,
          status: databaseStatus,
        },
        identity: {
          status: "ready",
          mode: usesLegacyIdentity ? "legacy" : "relational",
        },
        persistence_composition: compositionReadiness ?? {
          status: "not_configured",
          compatibility_bridge: false,
        },
        runners: {
          required: false,
          status:
            connectedRunners.length > 0
              ? "connected"
              : runnerSnapshots.length > 0
                ? "disconnected"
                : "not_registered",
          registered: runnerSnapshots.length,
          connected: connectedRunners.length,
          last_seen_at:
            runnerSnapshots
              .map((runner) => runner.last_seen_at)
              .filter(Boolean)
              .sort()
              .at(-1) ?? null,
        },
        providers: {
          required: false,
          anthropic: anthropicReady,
          openai: openAiReady,
          cross_provider_ready: anthropicReady && openAiReady,
        },
        execution_models: {
          required: false,
          status: availableExecutionModels.length > 0 ? "ready" : "unavailable",
          available: availableExecutionModels.length,
          configured: availableExecutionModels.map((model) => ({
            provider: model.provider,
            model: model.model,
          })),
          required_environment: [RUNNER_ALLOWED_MODELS_ENV],
        },
      },
    });
  });

  // === EXECUTION E3 =======================================================
  // Runner distribution. The GitHub Actions workflow installs the runner from
  // here instead of npm (apps/runner is private and unpublished, so the old
  // `npm install --global @norns/runner` step could never succeed).
  //
  // DELIBERATELY UNAUTHENTICATED. The workflow fetches this before it holds
  // any Norns identity — enrollment happens after the runner is installed, so
  // there is nothing to authenticate with. That is acceptable because the
  // response is the same public build for everyone and contains no secret,
  // and because confidentiality is not what protects the job: integrity is.
  // The dispatch pins a sha256 into the committed workflow and the job refuses
  // any other bytes, so serving this openly does not let anyone substitute
  // code into a run.
  //
  // The artifact is loaded and re-hashed once, lazily, and cached: the server
  // will not advertise a digest it is not serving.
  let runnerTarballCache: RunnerTarball | null = null;
  const currentRunnerTarball = (): RunnerTarball | null => {
    if (runnerTarballCache) return runnerTarballCache;
    try {
      runnerTarballCache = loadRunnerTarball(defaultRunnerTarballDir());
      return runnerTarballCache;
    } catch {
      return null;
    }
  };

  app.get("/install/runner/manifest.json", (_req, reply) => {
    const tarball = currentRunnerTarball();
    if (!tarball) return reply.code(503).send({ error: "runner_tarball_unavailable" });
    return reply.send({
      version: tarball.version,
      sha256: tarball.sha256,
      byte_size: tarball.byte_size,
      url: runnerTarballPath(tarball.version),
    });
  });

  app.get<{ Params: { version: string } }>(
    "/install/runner/:version/norns-runner.tgz",
    (req, reply) => {
      const tarball = currentRunnerTarball();
      if (!tarball) return reply.code(503).send({ error: "runner_tarball_unavailable" });
      // Version-scoped and exact-matched. A job pinned to a version this
      // server no longer has must fail rather than silently receive a
      // different build than the digest in its workflow file expects.
      if (req.params.version !== tarball.version) {
        return reply.code(404).send({ error: "runner_version_unavailable" });
      }
      return (
        reply
          .header("content-type", "application/gzip")
          .header("content-length", String(tarball.byte_size))
          // The bytes for a given version never change, so this is immutable.
          .header("cache-control", "public, max-age=31536000, immutable")
          .header("x-norns-runner-sha256", tarball.sha256)
          .send(tarball.bytes)
      );
    },
  );
  // === end EXECUTION E3 (runner distribution) ============================

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
    //
    // POLISH P2 (Safari stale-content fix): index.html is the one file whose
    // content changes on every deploy without its URL changing, so it must
    // always be revalidated — `no-cache` (not max-age=0) so Safari's
    // heuristic bfcache/memory-cache reuse can't serve a stale shell.
    // Vite content-hashes everything under /assets/*, so those responses are
    // immutable by construction and safe to cache for a year. Everything else
    // static (favicon, manifest, etc.) gets a short, conservative max-age.
    await app.register(fastifyStatic, {
      root: options.webDist,
      wildcard: false,
      setHeaders(reply, path) {
        if (path.endsWith(`${sep}index.html`) || path === "index.html") {
          reply.header("cache-control", "no-cache");
        } else if (path.includes(`${sep}assets${sep}`)) {
          reply.header("cache-control", "public, max-age=31536000, immutable");
        } else {
          reply.header("cache-control", "public, max-age=3600");
        }
      },
    });
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
    const availableExecutionModels = configuredExecutionModels();
    reply.header("Cache-Control", "no-store").send({
      cross_provider_ready: anthropicConfigured && openaiConfigured,
      execution_ready: availableExecutionModels.length > 0,
      execution_models: availableExecutionModels.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        label: entry.label,
      })),
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

  app.get("/api/v2/capabilities/execution-models", async (req, reply) => {
    if (!(await requireSession(req, reply))) return;
    const models = executionModelCatalog();
    reply.header("Cache-Control", "no-store").send({
      ready: models.some((model) => model.available),
      required_environment: [RUNNER_ALLOWED_MODELS_ENV],
      models: models.map((model) => ({
        id: model.model,
        provider: model.provider,
        label: model.label,
        available: model.available,
        unavailable_reason: model.unavailable_reason,
      })),
    });
  });

  // ---- durable debate workflow ------------------------------------------------
  // Browser routes construct application commands from the authenticated
  // identity. Clients never choose actor attribution, command IDs, or
  // correlation IDs themselves.
  if (options.debates) {
    const debates = options.debates;
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

  const GitHubAuthorizeQuery = z.object({
    next: z.literal("install").optional(),
  });
  app.get("/api/integrations/github/authorize", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github || !github.isConfigured()) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    const query = GitHubAuthorizeQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "bad_request" });
    reply.header("Cache-Control", "no-store").send({
      authorization_url: github.authorizationUrl(user.id, query.data.next ?? null),
    });
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

  app.delete("/api/integrations/github/authorization", async (req, reply) => {
    const user = await resolveUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!github) {
      return reply
        .code(503)
        .send({ error: "github_not_configured", message: "GitHub App is not configured" });
    }
    await github.removeAuthorization(user.id);
    stores.audit(user.email, "integration.github.authorization_deleted", user.id, now());
    reply.code(204).send();
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
      await github.completeInstallation(stateUserId, query.data.state, query.data.installation_id);
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
      await github.remove(id);
      stores.audit(user.email, "integration.github.deleted", id, now());
      reply.code(204).send();
    } catch (error) {
      githubError(reply, error);
    }
  });

  app.post("/api/integrations/github/connections/:id/disconnect", async (req, reply) => {
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
      reply.send({ status: "disconnected" });
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

  const projects = projectRepositoryForAccess;
  const attachmentService = options.attachments
    ? new AttachmentService(options.attachments.transactions)
    : null;
  if (
    projects !== undefined &&
    attachmentService &&
    runtimeTransactionsForInference &&
    canonicalTelemetry &&
    modelGateway
  ) {
    const conversationRepository = new PostgresConversationRepository(
      runtimeTransactionsForInference,
    );
    conversationService = new ConversationService(conversationRepository);
    executionConversationService = new ExecutionConversationService(
      runtimeTransactionsForInference,
      {
        now,
      },
    );
    conversationAttempts = new ConversationTurnRepository(runtimeTransactionsForInference);
    conversationContextAssembler = new ConversationContextAssembler(
      runtimeTransactionsForInference,
    );
    conversationTurns = new ConversationTurnService(
      conversationService,
      conversationContextAssembler,
      conversationAttempts,
      attachmentService,
      canonicalTelemetry,
      (provider, model): ConversationLlmAdapter => {
        const apiKey =
          provider === "anthropic"
            ? integrationEnvironment.ANTHROPIC_API_KEY
            : integrationEnvironment.OPENAI_API_KEY;
        if (!apiKey?.trim()) {
          throw new ConversationTurnError(
            "models_unavailable",
            `${provider} is not configured for planning conversations`,
            503,
          );
        }
        const adapter =
          options.createPlanningAdapter?.(provider, model, apiKey) ??
          (provider === "anthropic"
            ? new AnthropicAdapter({ apiKey, model })
            : new OpenAiAdapter({ apiKey, model }));
        if (!adapter.streamConversation) {
          throw new ConversationTurnError(
            "streaming_unavailable",
            `${provider}:${model} does not support streaming conversations`,
            503,
          );
        }
        // Intentionally raw: ConversationTurnService owns the one canonical
        // request trace so attempt and usage identities cannot be double-driven.
        return adapter as ConversationLlmAdapter;
      },
      modelGateway,
      { now },
    );
    await conversationAttempts.reconcileOrphans();
    await modelGateway.reconcileConversationReservations();
    registerConversationRoutes(app, {
      requireUser: requireSessionUser,
      conversations: conversationService,
      turns: conversationTurns,
      attempts: conversationAttempts,
      execution: executionConversationService,
      planDetail: (userId, projectId, workItemId, conversationId) =>
        conversationPlanWorkflow
          ? conversationPlanWorkflow.detail(userId, projectId, workItemId, conversationId)
          : Promise.resolve({
              plan_versions: [],
              actions: [],
              plan_reviews: [],
              action_effects: [],
              project_runs_qc: false,
            }),
      pinForProject: async (projectId) => {
        const selected = await projects.pmSelectionOf(projectId);
        return {
          provider: selected.provider,
          model:
            selected.model ??
            (selected.provider === "anthropic"
              ? (integrationEnvironment.NORNS_PM_MODEL ?? DEFAULT_PM_MODEL.anthropic)
              : (integrationEnvironment.NORNS_OPENAI_MODEL ?? DEFAULT_PM_MODEL.openai)),
        };
      },
    });
  }
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
      if (error instanceof ProjectArchiveConflictError) {
        reply.code(409).send({
          error: error.code,
          message: error.message,
          active_runs: error.activeRuns,
          active_planning_runs: error.activePlanningRuns,
          active_debate_runs: error.activeDebateRuns,
        });
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
      const user = await requireSessionUser(req, reply);
      if (!user) return;
      const listed = await projects.list();
      if (!projectAccessService) {
        reply.send(listed);
        return;
      }
      const accessible = new Set(
        await projectAccessService.listAccessibleProjectIds({ id: user.id }),
      );
      reply.send(listed.filter((project) => accessible.has(project.id)));
    });

    app.get("/api/admin/projects/archived", async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      reply.send(await projects.listArchived());
    });

    app.post("/api/admin/projects/:id/restore", async (req, reply) => {
      const admin = await requireAdmin(req, reply);
      if (!admin) return;
      const { id } = req.params as { id: string };
      try {
        await projects.restore(id, admin.id);
        stores.audit(admin.email, "project.restored", id, now());
        reply.send({ ok: true });
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/admin/projects/:id/destroy", async (req, reply) => {
      const admin = await requireAdmin(req, reply);
      if (!admin) return;
      const { id } = req.params as { id: string };
      try {
        await projects.destroy(id, admin.id);
        stores.audit(admin.email, "project.destroyed", id, now());
        reply.code(204).send();
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/projects/:id", async (req, reply) => {
      const user = await resolveUser(req);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const { id } = req.params as { id: string };
      try {
        await projects.archive(id, user.id);
        stores.audit(user.email, "project.archived", id, now());
        reply.code(204).send();
      } catch (error) {
        projectError(reply, error);
      }
    });

    app.delete("/api/v2/projects/:id/destroy", async (req, reply) => {
      const user = await resolveUser(req);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const { id } = req.params as { id: string };
      try {
        await projects.destroy(id, user.id);
        stores.audit(user.email, "project.destroyed", id, now());
        reply.code(204).send();
      } catch (error) {
        projectError(reply, error);
      }
    });

    const CreateProjectFields = {
      name: z.string().min(1),
      description: z.string().min(1),
      source_type: z.enum(["local", "github"]).optional(),
      source_location: z.string().trim().min(1).max(4096).optional(),
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
        // Raw filesystem paths are never a web API input. Local projects are
        // created without a source and then bound through a user-bound
        // selection token minted by the authenticated native folder helper.
        if (value.source_type === "local" || value.source_location) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["source_location"],
            message: "use the secure local folder chooser",
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
      // The source-less legacy form creates a local project. Retiring its UI
      // is insufficient: keep the mutation absent unless the independent
      // local-helper compatibility gate is explicitly enabled. GitHub-backed
      // creation remains available.
      if (body.data.source_type !== "github" && !requireLegacyHelperRoutes(reply)) return;
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
        ownerUserId: user.id,
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
      await ensureAuthenticatedProjectOwner(project, user.id);
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

    // =====================================================================
    // ONBOARDING O2 -- project setup. Two scenarios, both GitHub-backed.
    //
    // GitHub Actions remains the default execution workspace. For a new
    // repository, the operator can instead ask the authenticated local helper
    // to choose a parent folder, clone the repository, and make that verified
    // local binding primary while retaining GitHub as the remote. So setup is:
    //
    //   new_repo       Norns creates the GitHub repository.
    //   existing_repo  The operator selects one the installation can see.
    //
    // Each creates TWO attachments naming the same repository:
    //   * WORKSPACE (role 'workspace') -- where execution happens: an Actions
    //     job by default, or the verified local clone when explicitly chosen.
    //     This is what the Phase 4 dispatch gate resolves.
    //   * REMOTE    (role 'remote')    -- where the work is pushed.
    // The roles stay distinct because they are expected to diverge later
    // (fork-and-PR: execute in a fork, push to upstream).
    //
    // Pushes need no brokered credential: inside an Actions job GitHub
    // provides GITHUB_TOKEN, already scoped to that repository. Norns's own
    // App token is still used, but only for control-plane calls.
    //
    // The legacy `POST /api/projects` route is untouched and still serves the
    // pre-existing GitHub-only and local paths.
    // =====================================================================
    /**
     * ONBOARDING O6 — run activation without letting its failure destroy a
     * successful creation.
     *
     * A blocked activation is a normal, reportable outcome and is returned. An
     * unexpected failure (GitHub down mid-request) is swallowed to null: the
     * project genuinely exists, so answering 500 would tell the user creation
     * failed when it did not, and would strand the repository they can see on
     * GitHub. The retry endpoint is the recovery path either way.
     */
    const activateQuietly = async (
      service: ProjectActivationService | null,
      projectId: string,
      actorId: string,
    ): Promise<Awaited<ReturnType<ProjectActivationService["activate"]>> | null> => {
      if (!service) return null;
      try {
        return await service.activate({ project_id: projectId, actor_id: actorId });
      } catch {
        return null;
      }
    };

    if (options.onboarding) {
      // ONBOARDING O6: promotes a candidate to a `connected` binding on
      // GitHub-observed evidence. Constructed unconditionally so the failure
      // mode when GitHub is unconfigured is an honest refusal, not a missing
      // route.
      const activation = github
        ? new ProjectActivationService(
            options.onboarding.transactions,
            new GitHubActivationPort(github),
          )
        : null;
      const onboarding = new ProjectOnboardingService({
        transactions: options.onboarding.transactions,
        remotes: github
          ? new GitHubRemoteRepositoryPort(github)
          : new UnconfiguredRemoteRepositoryPort(),
      });

      const OnboardingFields = {
        name: z.string().trim().min(1),
        // DESIGN R2 starts planning in the project conversation, so a project
        // may be created before the user has written a brief.
        description: z.string().trim(),
        connection_id: z.string().min(1),
        idempotency_key: z.string().trim().min(1).max(200),
      };
      // The scenario is the discriminator: `new_repo` names a repository to
      // create, `existing_repo` names one to select. Separate shapes mean a
      // body can never half-say both.
      const ScenarioBody = z.discriminatedUnion("scenario", [
        z.object({
          ...OnboardingFields,
          scenario: z.literal("new_repo"),
          repository_name: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[A-Za-z0-9._-]+$/, "repository name must be a valid GitHub repository name"),
          private: z.boolean().default(true),
          local_working_copy: z.boolean().default(false),
          computer_id: z.string().trim().min(1).max(512).optional(),
        }),
        z.object({
          ...OnboardingFields,
          scenario: z.literal("existing_repo"),
          repository_id: z.string().min(1),
        }),
      ]);
      const PmBody = z.discriminatedUnion("pm_provider", [
        z.object({
          pm_provider: z.literal("anthropic"),
          pm_model: AnthropicPmModel.default(DEFAULT_PM_MODEL.anthropic),
        }),
        z.object({
          pm_provider: z.literal("openai"),
          pm_model: OpenAiPmModel.default(DEFAULT_PM_MODEL.openai),
        }),
      ]);

      app.post("/api/v2/projects/onboarding", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const scenario = ScenarioBody.safeParse(req.body);
        const pm = PmBody.safeParse(req.body);
        if (!scenario.success || !pm.success) {
          const issue = scenario.success ? pm.error?.issues[0] : scenario.error?.issues[0];
          const field = issue?.path.map(String).join(".") || "request";
          return reply.code(400).send({
            error: "bad_request",
            field,
            message:
              field === "request"
                ? "Check the project setup details and try again."
                : `Check ${field.replaceAll("_", " ")}: ${issue?.message ?? "invalid value"}`,
          });
        }
        const base = {
          name: scenario.data.name,
          description: scenario.data.description,
          pm_provider: pm.data.pm_provider,
          pm_model: pm.data.pm_model,
          connection_id: scenario.data.connection_id,
          actor: { actor_type: "human" as const, actor_id: user.id },
          idempotency_key: scenario.data.idempotency_key,
        };
        try {
          let localRunner:
            | {
                runner_id: string;
                generation: number;
                socket: WsLike;
                device_backed: boolean;
              }
            | undefined;
          if (scenario.data.scenario === "new_repo" && scenario.data.local_working_copy) {
            if (!github || !options.phase3) {
              console.error(
                "project onboarding refused: local_working_copy_unavailable (503) — GitHub integration or local execution services not configured",
              );
              return reply.code(503).send({
                error: "local_working_copy_unavailable",
                message:
                  "GitHub + this computer requires the GitHub integration and local execution services.",
              });
            }
            if (scenario.data.computer_id) {
              if (!options.deviceManagement || !options.deviceRepositoryAccess) {
                return reply.code(503).send({
                  error: "computer_working_copy_unavailable",
                  message:
                    "Computer working copies are not enabled on this Norns installation. Choose GitHub Actions.",
                });
              }
              let computer: OwnedDeviceProjectionT;
              try {
                computer = await options.deviceManagement.service.getOwnedDevice(
                  user.id,
                  scenario.data.computer_id,
                );
              } catch {
                return reply.code(404).send({
                  error: "computer_not_found",
                  message: "That computer is no longer connected to your account.",
                });
              }
              const runnerId = computer.device_id;
              const reconciled = reconciledRunners.get(runnerId);
              if (
                computer.lifecycle !== "active" ||
                computer.status.availability !== "online" ||
                !reconciled ||
                !reconciled.workspacePicker ||
                !reconciled.workspaceRepositoryInventory ||
                !reconciled.workspaceClone ||
                reconciled.socket !== runnerSockets.get(runnerId) ||
                reconciled.generation !== computer.active_credential?.generation
              ) {
                const updateRequired =
                  computer.status.availability === "online" &&
                  computer.agent !== null &&
                  !computer.agent.capabilities.includes("workspace_clone");
                return reply.code(409).send({
                  error: updateRequired ? "computer_upgrade_required" : "computer_unavailable",
                  message: updateRequired
                    ? "Update the Norns Local Agent on that computer before creating a working copy."
                    : "That computer must be online with the Norns Local Agent open before creating a working copy.",
                });
              }
              localRunner = {
                runner_id: runnerId,
                generation: reconciled.generation,
                socket: reconciled.socket,
                device_backed: true,
              };
            } else {
              if (!requireLegacyHelperRoutes(reply)) return;
              const status = helperStatus(helperRunnerSnapshots());
              const runnerId = status.runner_id;
              const runner = runnerId ? stores.runner(runnerId) : undefined;
              const reconciled = runnerId ? reconciledRunners.get(runnerId) : undefined;
              if (
                status.state !== "connected" ||
                !runnerId ||
                !runner ||
                !reconciled ||
                !reconciled.workspacePicker ||
                !reconciled.workspaceRepositoryInventory ||
                !reconciled.workspaceClone ||
                reconciled.socket !== runnerSockets.get(runnerId) ||
                reconciled.generation !== runner.generation
              ) {
                const refusal =
                  status.state === "connected" ? "runner_upgrade_required" : "runner_unavailable";
                console.error(
                  `project onboarding refused: ${refusal} (409) — local helper not ready for a working copy`,
                );
                return reply.code(409).send({
                  error: refusal,
                  message:
                    status.state === "connected"
                      ? "Update the local helper before creating a GitHub working copy."
                      : "The local helper must be connected before creating a working copy on this computer.",
                });
              }
              localRunner = {
                runner_id: runnerId,
                generation: runner.generation,
                socket: reconciled.socket,
                device_backed: false,
              };
            }
          }
          const result =
            scenario.data.scenario === "new_repo"
              ? await onboarding.createNewRepo({
                  ...base,
                  repository_name: scenario.data.repository_name,
                  private: scenario.data.private,
                })
              : await onboarding.createFromExistingRepo({
                  ...base,
                  repository_id: scenario.data.repository_id,
                });
          await options.relationalComposition?.mirrorOnboardedProject({
            project_id: result.project_id,
            scenario: scenario.data.scenario,
            name: scenario.data.name,
            description: scenario.data.description,
            pm_provider: pm.data.pm_provider,
            pm_model: pm.data.pm_model,
            connection_id: scenario.data.connection_id,
            repository_id:
              scenario.data.scenario === "existing_repo" ? scenario.data.repository_id : null,
            default_branch: result.workspace?.default_branch ?? null,
            github_url: result.workspace?.github?.url ?? null,
          });
          stores.audit(
            user.email,
            "project.onboarded",
            `${result.project_id} ${scenario.data.scenario}`,
            now(),
          );
          // ---- ONBOARDING O6 -------------------------------------------
          // Activate inline, as part of creation. This is deliberate: the
          // reason GitHub projects could never run was an endpoint
          // (`source-bindings/github`) that existed but nothing ever called.
          // Putting activation behind a second call the client must remember
          // to make would rebuild exactly that failure. A project is created
          // AND made runnable in one request, or it reports why not.
          //
          // Activation failure is never fatal to creation: the project and its
          // repository exist and are recorded, so the human can fix the
          // installation and retry via POST /api/v2/projects/:id/activate
          // rather than being stranded with an orphaned repository.
          const activated = await activateQuietly(activation, result.project_id, user.id);
          const responsePayload = {
            ...result,
            ...(activated
              ? {
                  activation: {
                    activated: activated.activated,
                    observed_head: activated.observed_head,
                    workspace_binding_id: activated.workspace_binding_id,
                  },
                  ...blockerPayload([
                    ...result.blocker_details,
                    ...activated.blockers.map((blocker) => ({
                      code: blocker.code,
                      role: "workspace" as const,
                      message: blocker.message,
                    })),
                  ]),
                }
              : {}),
          };
          if (scenario.data.scenario === "new_repo" && scenario.data.local_working_copy) {
            if (!activated) {
              console.error(
                `project onboarding refused: local_working_copy_unavailable (409) — activation unavailable for ${result.project_id}`,
              );
              return reply.code(409).send({
                error: "local_working_copy_unavailable",
                message:
                  "The GitHub repository and project were created, but local setup could not start. Try again to finish the working copy.",
                project_id: result.project_id,
              });
            }
            if (!activated.activated) {
              return reply.code(result.replayed ? 200 : 201).send({
                ...responsePayload,
                execution_location: "local",
                local_working_copy: { status: "blocked" },
              });
            }
            if (!github || !options.phase3 || !localRunner) {
              console.error(
                `project onboarding refused: local_working_copy_unavailable (503) — GitHub or local execution services vanished mid-request for ${result.project_id}`,
              );
              return reply.code(503).send({ error: "local_working_copy_unavailable" });
            }
            const repositoryName = scenario.data.repository_name;
            const repositories = await github.listRepositories(
              user.id,
              scenario.data.connection_id,
              repositoryName,
            );
            const repository = repositories.find(
              (candidate) => candidate.name.toLowerCase() === repositoryName.toLowerCase(),
            );
            if (!repository) {
              console.error(
                `project onboarding refused: local_working_copy_unavailable (409) — repository not visible to the GitHub App for ${result.project_id}`,
              );
              return reply.code(409).send({
                error: "local_working_copy_unavailable",
                message:
                  "The GitHub repository was created, but it is not visible to the Norns GitHub App yet. Grant repository access, then try again.",
                project_id: result.project_id,
              });
            }
            const credential = await github.localCloneCredential(
              user.id,
              scenario.data.connection_id,
              repository.id,
            );
            const clone = await workspaceBroker.request(
              localRunner.runner_id,
              localRunner.generation,
              {
                operation: "clone",
                clone_url: credential.repository.clone_url,
                repository_name: credential.repository.name,
                clone_token: credential.token,
              },
            );
            if (clone.status !== "ok" || !clone.repository) {
              const message =
                clone.status === "cancelled"
                  ? "The GitHub repository was created. Choose a parent folder to finish the local working copy."
                  : clone.status === "destination_exists"
                    ? `A folder named ${credential.repository.name} already exists in that location. Choose a different parent folder.`
                    : "The GitHub repository was created, but the local helper could not clone it. Check this computer's Git access and try again.";
              console.error(
                `project onboarding refused: local_working_copy_${clone.status} (409) — helper clone did not complete for ${result.project_id}`,
              );
              return reply.code(409).send({
                error: `local_working_copy_${clone.status}`,
                message,
                project_id: result.project_id,
              });
            }
            const current = reconciledRunners.get(localRunner.runner_id);
            if (
              current?.socket !== localRunner.socket ||
              current.generation !== localRunner.generation ||
              runnerSockets.get(localRunner.runner_id) !== localRunner.socket
            ) {
              console.error(
                `project onboarding refused: runner_unavailable (409) — helper reconnected before the clone could be bound for ${result.project_id}`,
              );
              return reply.code(409).send({
                error: "runner_unavailable",
                message:
                  "The working copy was cloned, but the helper reconnected before it could be bound. Try again to finish setup.",
                project_id: result.project_id,
              });
            }
            let workspaceBinding: {
              id: string;
              status: string;
              verified: boolean;
            };
            if (localRunner.device_backed) {
              if (!clone.repository_registration_id || !options.deviceRepositoryAccess) {
                return reply.code(409).send({
                  error: "computer_repository_registration_failed",
                  message:
                    "The repository was cloned, but this computer could not register the working copy. Open the Local Control Center and try again.",
                  project_id: result.project_id,
                });
              }
              const grant = await options.deviceRepositoryAccess.service.grantRepository({
                actor_user_id: user.id,
                project_id: result.project_id,
                repository_registration_id: clone.repository_registration_id,
              });
              const targets =
                await options.deviceRepositoryAccess.service.selectProjectExecutionTarget({
                  actor_user_id: user.id,
                  project_id: result.project_id,
                  execution_target_id: grant.grant_id,
                  expected_current_execution_target_id: null,
                });
              const selectedTarget = targets.execution_targets.find(
                (target) => target.execution_target_id === grant.grant_id,
              );
              workspaceBinding = {
                id: grant.grant_id,
                status:
                  selectedTarget?.status.availability === "online" ? "connected" : "disconnected",
                verified: selectedTarget?.status.compatibility === "ready",
              };
            } else {
              const binding = await options.phase3.sourceBindings.createLocal(
                {
                  project_id: result.project_id,
                  runner_id: localRunner.runner_id,
                  workspace_id: clone.repository.workspace_id,
                  repository_id: clone.repository.repository_id,
                  repository_display_name: clone.repository.repository_display_name,
                  default_branch: clone.repository.default_branch,
                  observed_head: clone.repository.observed_head,
                  verification_policy_ref: "verification",
                  created_by: { actor_type: "human", actor_id: user.id },
                },
                { makePrimary: true },
              );
              workspaceBinding = {
                id: binding.id,
                status: binding.status,
                verified: binding.status === "connected",
              };
            }
            stores.audit(
              user.email,
              "project.local_working_copy.created",
              `${result.project_id} ${credential.repository.full_name}`,
              now(),
            );
            return reply.code(result.replayed ? 200 : 201).send({
              ...responsePayload,
              workspace: {
                id: workspaceBinding.id,
                tier: "binding",
                role: "workspace",
                kind: "local_runner",
                display_name: clone.repository.repository_display_name,
                status: workspaceBinding.status,
                verified: workspaceBinding.verified,
                default_branch: clone.repository.default_branch,
                installation_ready: null,
                workflow_installed: false,
                github: null,
                observed_head: clone.repository.observed_head,
                push_credential_strategy: null,
              },
              execution_location: "local",
              local_working_copy: {
                status: "ready",
                repository_display_name: clone.repository.repository_display_name,
              },
            });
          }
          return reply.code(result.replayed ? 200 : 201).send({
            ...responsePayload,
            execution_location: "github_actions",
          });
        } catch (error) {
          // Honest errors: a repository GitHub would not confirm, or a reused
          // idempotency key. Neither is silently downgraded.
          if (error instanceof RemoteRepositoryVerificationError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
          }
          if (error instanceof GitHubIntegrationError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
          }
          if (error instanceof OnboardingValidationError) {
            return reply.code(409).send({ error: error.code, message: error.message });
          }
          if (error instanceof RelationalCompositionConflictError) {
            return reply.code(409).send(error.diagnostic());
          }
          // Include the PostgreSQL error surface when present (code/detail/
          // table), so a permission or schema failure under the restricted
          // production role is diagnosable from this line alone.
          const pgError =
            error && typeof error === "object"
              ? (error as { code?: unknown; detail?: unknown; table?: unknown })
              : undefined;
          console.error(
            "project onboarding failed",
            error,
            ...(pgError?.code || pgError?.detail || pgError?.table
              ? [{ code: pgError.code, detail: pgError.detail, table: pgError.table }]
              : []),
          );
          return reply.code(500).send({
            error: "onboarding_failed",
            message:
              "Project setup couldn't finish. Try again; if it continues, verify GitHub and the Local Agent in Connections.",
          });
        }
      });

      // ONBOARDING O6 — retry activation after a human clears a blocker.
      // This is the recovery path for `installation_not_ready`: the project
      // and its repository already exist, so granting the installation access
      // and calling this makes the project runnable without re-creating
      // anything.
      app.post("/api/v2/projects/:id/activate", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        if (!activation) {
          return reply
            .code(503)
            .send({ error: "github_not_configured", message: "GitHub App is not configured" });
        }
        const { id } = req.params as { id: string };
        try {
          const result = await activation.activate({ project_id: id, actor_id: user.id });
          stores.audit(
            user.email,
            result.activated ? "project.activated" : "project.activation_blocked",
            `${id} ${result.blockers.map((blocker) => blocker.code).join(",")}`.trim(),
            now(),
          );
          return reply.send(result);
        } catch (error) {
          if (error instanceof ProjectActivationError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
          }
          return reply.code(500).send({ error: "activation_failed", detail: String(error) });
        }
      });
    }
    // ===================== end ONBOARDING O2 =============================

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

      const workspaceFailure = (
        reply: FastifyReply,
        error: unknown,
        timeoutMessage = "The local helper did not respond in time. Update or restart it, then try again.",
      ): FastifyReply => {
        const code = error instanceof WorkspaceBrokerError ? error.code : "runner_unavailable";
        return reply.code(code === "request_limit" ? 429 : code === "timeout" ? 504 : 409).send({
          error: code,
          message:
            code === "runner_upgrade_required"
              ? "Update the local helper before choosing a folder."
              : code === "timeout"
                ? timeoutMessage
                : "The local helper is not available.",
        });
      };

      const chooseLocalRepository = async (
        req: FastifyRequest,
        reply: FastifyReply,
        requestedRunnerId?: string,
      ) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        if (!requireLegacyGlobalCompatibility(user, reply, "global workspace selection")) return;
        const status = helperStatus(helperRunnerSnapshots());
        const runnerId = requestedRunnerId ?? status.runner_id;
        if (status.state !== "connected" || !runnerId) {
          return workspaceFailure(reply, new WorkspaceBrokerError("runner_unavailable"));
        }
        const runner = stores.runner(runnerId);
        const reconciled = reconciledRunners.get(runnerId);
        if (
          !runner ||
          !reconciled ||
          reconciled.socket !== runnerSockets.get(runnerId) ||
          reconciled.generation !== runner.generation
        ) {
          return workspaceFailure(reply, new WorkspaceBrokerError("runner_unavailable"));
        }
        if (!reconciled.workspacePicker || !reconciled.workspaceRepositoryInventory) {
          return workspaceFailure(reply, new WorkspaceBrokerError("runner_upgrade_required"));
        }
        try {
          const generation = runner.generation;
          const response = await workspaceBroker.request(runnerId, generation, {
            operation: "choose",
          });
          if (response.status === "cancelled") return reply.send({ cancelled: true });
          if (response.status !== "ok" || !response.repository) {
            return reply.code(response.status === "invalid_request" ? 422 : 409).send({
              error: response.status,
              message:
                response.status === "invalid_request"
                  ? "Choose the root folder of a Git repository with at least one commit."
                  : "The system folder chooser is unavailable.",
            });
          }
          const current = reconciledRunners.get(runnerId);
          if (
            runnerSockets.get(runnerId) !== reconciled.socket ||
            current?.socket !== reconciled.socket ||
            current.generation !== generation
          ) {
            return reply.code(409).send({ error: "runner_unavailable" });
          }
          const grant = workspaceSelections.issue(
            user.id,
            runnerId,
            generation,
            response.repository,
          );
          return reply.send({
            ...grant,
            repository: { runner_id: runnerId, ...response.repository },
          });
        } catch (error) {
          return workspaceFailure(reply, error, "The folder chooser timed out. Try again.");
        }
      };

      app.post("/api/runners/:runnerId/workspaces/choose", async (req, reply) => {
        if (!requireLegacyHelperRoutes(reply)) return;
        const { runnerId } = req.params as { runnerId: string };
        return chooseLocalRepository(req, reply, runnerId);
      });

      // Account-level local source setup. Projects consume this reusable
      // inventory and never install/pair helpers or open native pickers.
      app.post("/api/runners/helper/repositories/choose", async (req, reply) => {
        if (!requireLegacyHelperRoutes(reply)) return;
        return chooseLocalRepository(req, reply);
      });

      app.get("/api/runners/helper/repositories", async (req, reply) => {
        if (!requireLegacyHelperRoutes(reply)) return;
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        if (!requireLegacyGlobalCompatibility(user, reply, "global repository catalog")) return;
        const status = helperStatus(helperRunnerSnapshots());
        if (status.state !== "connected" || !status.runner_id) {
          return reply.send({ ...helperStatusPayload(req), repositories: [] });
        }
        const runnerId = status.runner_id;
        const runner = stores.runner(runnerId);
        const reconciled = reconciledRunners.get(runnerId);
        if (!runner || !reconciled) {
          return reply.send({ ...helperStatusPayload(req), repositories: [] });
        }
        try {
          const catalog = await workspaceBroker.request(runnerId, runner.generation, {
            operation: "catalog",
          });
          if (catalog.status !== "ok" || !catalog.repositories) {
            return reply.send({ ...helperStatusPayload(req), repositories: [] });
          }
          const repositories = catalog.repositories.map((repository) => {
            const grant = workspaceSelections.issue(
              user.id,
              runnerId,
              runner.generation,
              repository,
            );
            return {
              ...grant,
              repository: { runner_id: runnerId, ...repository },
            };
          });
          return reply.send({ ...helperStatusPayload(req), repositories });
        } catch (error) {
          return workspaceFailure(reply, error);
        }
      });

      const LocalProjectBody = z.discriminatedUnion("pm_provider", [
        z.object({
          name: z.string().trim().min(1),
          description: z.string().trim().min(1),
          selection_token: z.string().min(1),
          verification_policy_ref: z.string().min(1).default("verification"),
          pm_provider: z.literal("anthropic"),
          pm_model: AnthropicPmModel.default(DEFAULT_PM_MODEL.anthropic),
        }),
        z.object({
          name: z.string().trim().min(1),
          description: z.string().trim().min(1),
          selection_token: z.string().min(1),
          verification_policy_ref: z.string().min(1).default("verification"),
          pm_provider: z.literal("openai"),
          pm_model: OpenAiPmModel.default(DEFAULT_PM_MODEL.openai),
        }),
      ]);

      app.post("/api/v2/projects/local", async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        if (!requireLegacyHelperRoutes(reply)) return;
        const body = LocalProjectBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const reserved = workspaceSelections.reserve(user.id, body.data.selection_token);
        if (!reserved) return reply.code(409).send({ error: "local_selection_invalid" });
        const selection = reserved.selection;
        const currentRunner = stores.runner(selection.runner_id);
        const reconciled = reconciledRunners.get(selection.runner_id);
        if (
          !currentRunner ||
          !reconciled ||
          reconciled.socket !== runnerSockets.get(selection.runner_id) ||
          reconciled.generation !== selection.runner_generation ||
          !reconciled.workspacePicker ||
          !reconciled.workspaceRepositoryInventory ||
          currentRunner.generation !== selection.runner_generation
        ) {
          workspaceSelections.release(body.data.selection_token, reserved.reservation_id);
          return reply.code(409).send({ error: "local_selection_invalid" });
        }
        let project: Awaited<ReturnType<ProjectRepository["create"]>> | undefined;
        try {
          project = await projects.create({
            name: body.data.name,
            description: body.data.description,
            pmProvider: body.data.pm_provider,
            pmModel: body.data.pm_model,
            ownerUserId: user.id,
            ...(options.relationalComposition?.readiness().new_project_write_authority === "legacy"
              ? {
                  sourceType: "local" as const,
                  sourceLocation: selection.repository_display_name,
                  sourceConnectionId: selection.workspace_id,
                  sourceRepositoryId: selection.repository_id,
                  sourceDefaultBranch: selection.default_branch,
                }
              : {}),
          });
          if (options.relationalComposition) {
            await options.relationalComposition.ensureProjectAnchor(project, user.id);
          } else {
            await ensureAuthenticatedProjectOwner(project, user.id);
          }
          await options.phase3?.sourceBindings.createLocal({
            project_id: project.id,
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
          stores.audit(user.email, "project.created.local", project.id, now());
          return reply.code(201).send(await projects.summary(project.id));
        } catch (error) {
          workspaceSelections.release(body.data.selection_token, reserved.reservation_id);
          if (project) {
            try {
              await projects.archive(project.id, user.id);
            } catch {
              // The original create/bind failure remains the public result.
            }
          }
          if (error instanceof RelationalCompositionConflictError) {
            return reply.code(409).send(error.diagnostic());
          }
          return reply.code(409).send({ error: "local_project_creation_failed" });
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

      // ---------------------------------------------------------------
      // FRONT DOOR P5 (tracking): configurable resume-poll cadence. Allowed
      // values are enforced by both this request schema and, independently,
      // ProjectResumeService.updateSettings (defense in depth against a
      // future caller that bypasses this route's validation).
      // ---------------------------------------------------------------
      const ProjectSettingsBody = z
        .object({
          update_interval_seconds: z.union([z.literal(60), z.literal(300), z.literal(900)]),
        })
        .strict();
      app.patch("/api/v2/projects/:id/settings", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        const body = ProjectSettingsBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          const result = await options.phase3?.resume.updateSettings(
            id,
            body.data.update_interval_seconds,
          );
          if (!result) return reply.code(503).send({ error: "resume_unavailable" });
          reply.send(result);
        } catch (error) {
          if (error instanceof ProjectResumeNotFoundError) {
            return reply.code(404).send({ error: "project_not_found" });
          }
          if (error instanceof ProjectSettingsValidationError) {
            return reply.code(400).send({ error: "invalid_settings", detail: error.message });
          }
          reply.code(500).send({ error: "internal_error", detail: String(error) });
        }
      });

      app.post("/api/v2/projects/:id/source-bindings/local", async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        if (!requireLegacyHelperRoutes(reply)) return;
        const body = LocalBindingBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const { id } = req.params as { id: string };
        const reserved = workspaceSelections.reserve(user.id, body.data.selection_token);
        if (!reserved) return reply.code(409).send({ error: "local_selection_invalid" });
        const selection = reserved.selection;
        const currentRunner = stores.runner(selection.runner_id);
        const reconciled = reconciledRunners.get(selection.runner_id);
        if (
          !currentRunner ||
          !reconciled ||
          reconciled.socket !== runnerSockets.get(selection.runner_id) ||
          reconciled.generation !== selection.runner_generation ||
          !reconciled.workspacePicker ||
          !reconciled.workspaceRepositoryInventory ||
          currentRunner.generation !== selection.runner_generation
        ) {
          workspaceSelections.release(body.data.selection_token, reserved.reservation_id);
          return reply.code(409).send({ error: "local_selection_invalid" });
        }
        try {
          if (options.relationalComposition) {
            await options.relationalComposition.ensureProjectAnchor(
              await projects.summary(id),
              user.id,
            );
          }
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
          return reply.code(201).send(binding);
        } catch (error) {
          workspaceSelections.release(body.data.selection_token, reserved.reservation_id);
          if (error instanceof RelationalCompositionConflictError) {
            return reply.code(409).send(error.diagnostic());
          }
          return reply.code(409).send({ error: "source_binding_conflict" });
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
          if (options.relationalComposition) {
            await options.relationalComposition.ensureProjectAnchor(
              await projects.summary(id),
              user.id,
            );
          }
          reply.code(201).send(
            await options.phase3?.sourceBindings.createGitHub({
              project_id: id,
              ...body.data,
              created_by: { actor_type: "human", actor_id: user.id },
            }),
          );
        } catch (error) {
          if (error instanceof RelationalCompositionConflictError) {
            return reply.code(409).send(error.diagnostic());
          }
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

      // POLISH P3 — the producer for the ingest seed above. The resume payload
      // has recommended "Analyze the repository and record its architecture"
      // since Phase 3 while nothing in the web app could perform it; this route
      // is that step. Synchronous by design: the analysis input is bounded (see
      // RepositoryAnalysisService's stated caps), so one request/response
      // round-trip stays well inside interactive limits.
      app.post("/api/v2/projects/:id/analyze-repository", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return;
        const analysis = options.repositoryAnalysis;
        if (!analysis) {
          return reply.code(503).send({
            error: "analysis_unavailable",
            message: "Repository analysis requires the relational runtime and is not configured.",
          });
        }
        const { id } = req.params as { id: string };
        try {
          const target = await analysis.target(id);
          if (target.binding.binding_type === "local_runner") {
            const runner = stores.runner(target.binding.runner_id);
            const reconciled = reconciledRunners.get(target.binding.runner_id);
            if (
              !runner ||
              !reconciled ||
              reconciled.socket !== runnerSockets.get(target.binding.runner_id) ||
              reconciled.generation !== runner.generation ||
              !reconciled.workspaceRepositoryInventory
            ) {
              return reply.code(409).send({
                error: "local_helper_unavailable",
                message:
                  "Update or open the Norns helper on the computer that owns this repository, then retry analysis.",
              });
            }
            const response = await workspaceBroker.request(
              target.binding.runner_id,
              runner.generation,
              {
                operation: "inspect",
                repository_id: target.binding.repository_id,
              },
            );
            if (response.status !== "ok" || !response.inspection) {
              return reply.code(409).send({
                error: "local_inspection_failed",
                message:
                  "The local helper could not inspect the repository's committed files. Confirm the folder is still available, then retry.",
              });
            }
            return reply.send(
              await analysis.analyzeTarget(target, { actor_id: user.id }, response.inspection),
            );
          }
          return reply.send(await analysis.analyzeTarget(target, { actor_id: user.id }));
        } catch (error) {
          if (error instanceof WorkspaceBrokerError) {
            return workspaceFailure(reply, error);
          }
          if (error instanceof RepositoryAnalysisError || error instanceof GitHubIntegrationError) {
            return reply.code(error.status).send({ error: error.code, message: error.message });
          }
          if (error instanceof AdapterError) {
            return reply.code(502).send({
              error: "model_call_failed",
              message: `The analysis model call failed (${error.kind}): ${error.message}`,
            });
          }
          if (error instanceof RepositoryIngestionConflictError) {
            return reply.code(409).send({ error: "ingestion_conflict", detail: String(error) });
          }
          throw error;
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
          if (
            !legacyGlobalRunnerCompatibilityEnabled &&
            (!legacyRunnerAuthorization ||
              !(await legacyRunnerAuthorization.canAccessProjectRunner({
                user_id: user.id,
                project_id: id,
                runner_id: body.data.runner_id,
              })))
          ) {
            return rejectLegacyRunnerAccess(user, reply, "task scheduling");
          }
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
            const recoveryIntent = await options.phase5?.attention.recoveryDecisionIntent({
              project_id: id,
              decision_point_id: decisionPointId,
              expected_condition_fingerprint: body.data.expected_condition_fingerprint,
              selected_option_id: body.data.selected_option_id,
            });
            let recovery:
              | Awaited<ReturnType<Phase4RecoveryActionService["retry"]>>
              | Awaited<ReturnType<Phase4RecoveryActionService["cancel"]>>
              | null = null;
            if (recoveryIntent) {
              if (!decisionRecoveryActions) {
                return reply.code(503).send({
                  error: "decision_recovery_unavailable",
                  detail:
                    "Execution recovery is not configured on this deployment. The decision remains open.",
                  retriable: true,
                });
              }
              // A decision can remain open far longer than the command TTL.
              // Its created_at is historical evidence, not the authorization
              // time for work launched by the human resolving it now.
              const recoveryIssuedAt = now().toISOString();
              const common = {
                project_id: recoveryIntent.project_id,
                phase_id: recoveryIntent.phase_id,
                task_id: recoveryIntent.task_id,
                failed_run_id: recoveryIntent.failed_run_id,
                expected_task_version: recoveryIntent.expected_task_version,
                actor: { actor_type: "human" as const, actor_id: user.id },
                authorized_by_session_id: `decision-recovery:${decisionPointId}`,
                idempotency_key: body.data.idempotency_key,
                correlation_id: `decision-recovery:${decisionPointId}`,
                causation_id: decisionPointId,
                issued_at: recoveryIssuedAt,
                resolve_decisions: false,
              };
              recovery =
                recoveryIntent.action === "retry"
                  ? await decisionRecoveryActions.retry(common)
                  : await decisionRecoveryActions.cancel({
                      ...common,
                      reason:
                        body.data.rationale.trim() ||
                        body.data.direction_text.trim() ||
                        "Cancelled by recovery decision.",
                    });
              if (recovery.action === "retry" && !recovery.started) {
                return reply.code(409).send({
                  error: "recovery_not_started",
                  detail: `${recovery.detail} The decision remains open; retry after resolving the prerequisite.`,
                  retriable: true,
                });
              }
            }
            const resolution = await options.phase5?.attention.resolveDecision({
              user_id: user.id,
              project_id: id,
              decision_point_id: decisionPointId,
              ...body.data,
            });
            reply.send(recovery ? { ...resolution, recovery } : resolution);
          } catch (error) {
            if (error instanceof Phase4RecoveryActionError) {
              return reply.code(error.status).send({
                error: error.code,
                detail: `${error.message} The decision remains open.`,
                retriable: error.retriable,
              });
            }
            if (error instanceof PhaseLaunchError) {
              return reply.code(409).send({
                error: "recovery_not_started",
                detail: `${error.message} The decision remains open; retry after resolving the prerequisite.`,
                action_required: error.action_required,
                retriable: true,
              });
            }
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

      // -----------------------------------------------------------------
      // PHASE TAB P1: lightweight per-phase execution progress for a whole
      // project, poll-friendly. Derived from the same phases/tasks/agent_runs
      // data the per-phase execution view reads (AttentionService
      // .projectExecution) — additive fields, not a parallel status system.
      // -----------------------------------------------------------------
      app.get("/api/v2/projects/:id/execution-status", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          reply
            .header("Cache-Control", "no-store")
            .send(await options.phase5?.attention.projectExecution(id));
        } catch (error) {
          reply.code(404).send({ error: "project_not_found", detail: String(error) });
        }
      });

      // -----------------------------------------------------------------
      // EXECUTION E13 — live run-log tail for a task's designated run. See
      // `AttentionService.runLog` for the two-mode (tail / `after`-cursor)
      // contract. Bounded server-side (RUN_LOG_PAGE_LIMIT), so a chatty agent
      // cannot make either this endpoint or a page polling it unbounded.
      // -----------------------------------------------------------------
      app.get("/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/run-log", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id, phaseId, taskId } = req.params as {
          id: string;
          phaseId: string;
          taskId: string;
        };
        const query = req.query as { after?: string };
        let after: number | undefined;
        if (query.after !== undefined) {
          after = Number(query.after);
          if (!Number.isInteger(after) || after < 0) {
            return reply.code(400).send({ error: "bad_request", detail: "invalid after cursor" });
          }
        }
        reply.send(
          await options.phase5?.attention.runLog(
            id,
            phaseId,
            taskId,
            after !== undefined ? { after } : {},
          ),
        );
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
      const user = await requireSessionUser(req, reply);
      if (!user) return;
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
          initiatedByUserId: user.id,
          projectName: summary.name,
          objective: body.data.objective ?? summary.plan_objective ?? summary.description,
          graph: graphView.graph,
          models: configuredExecutionModels(),
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
      const user = await requireSessionUser(req, reply);
      if (!user) return;
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
          initiatedByUserId: user.id,
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
      const projectRulesService = new ProjectRulesService(planningTransactions, now);
      const resolvePlanningModels = async (
        projectId: string,
        run?: {
          mode: "planned" | "quick" | "review_only";
          pm: {
            provider: ProviderName;
            model: string;
            reasoning_effort?: CodexReasoningEffortT;
          } | null;
        },
      ) => {
        const [projectPm, persistedReviewer] = await Promise.all([
          projects.pmSelectionOf(projectId),
          planningRunService.reviewerSelectionOf(projectId),
        ]);
        const pmSelection = run?.pm ?? projectPm;
        const pmReasoningEffort = run?.pm?.reasoning_effort;
        if (run?.mode === "quick") {
          const pmModel =
            pmSelection.model ??
            (pmSelection.provider === "anthropic"
              ? PLANNING_RUN_DEFAULT_PM_MODEL
              : DEFAULT_PM_MODEL.openai);
          return {
            pm: {
              provider: pmSelection.provider,
              model: pmModel,
              ...(pmReasoningEffort ? { reasoning_effort: pmReasoningEffort } : {}),
            },
            // Quick changes never instantiate or call this reviewer. Keeping a
            // complete pair preserves the worker's shared resolution shape.
            reviewer: { provider: pmSelection.provider, model: pmModel },
          };
        }
        // Throws PlanningConfigurationError when the deployment lacks what's
        // needed; the worker catches it and records a truthful failure.
        // PHASE TAB P1: durable planning runs pin their last-resort defaults
        // to claude-fable-5 (PM, anthropic) and gpt-5.6-sol (reviewer,
        // openai). Project PM selection, persisted reviewer settings, and the
        // NORNS_* env vars all still win — these apply only when nothing else
        // resolved a model.
        const resolved = resolvePlanningParticipants({
          pmSelection,
          persistedReviewer:
            persistedReviewer?.provider === pmSelection.provider ? null : persistedReviewer,
          env: integrationEnvironment,
          defaultPmModel: {
            anthropic: PLANNING_RUN_DEFAULT_PM_MODEL,
            openai: DEFAULT_PM_MODEL.openai,
          },
          defaultReviewerModel: { openai: PLANNING_RUN_DEFAULT_REVIEWER_MODEL },
        });
        return {
          ...resolved,
          pm: {
            ...resolved.pm,
            ...(pmReasoningEffort ? { reasoning_effort: pmReasoningEffort } : {}),
          },
        };
      };
      let executeReviewNow: (runId: string) => Promise<unknown> = async () => {
        throw new Error("planning worker is not initialized");
      };
      let cancelReviewNow: (runId: string) => boolean = () => false;
      if (
        conversationService &&
        conversationContextAssembler &&
        conversationAttempts &&
        runtimeTransactionsForInference
      ) {
        conversationPlanWorkflow = new ConversationPlanWorkflowService(planningTransactions, {
          now,
          resolveReviewModels: async (projectId, pm) => {
            const resolved = await resolvePlanningModels(projectId, {
              mode: "review_only",
              pm,
            });
            return { pm: resolved.pm, reviewer: resolved.reviewer };
          },
          runReviewNow: (runId) => executeReviewNow(runId),
          cancelReviewNow: (runId) => cancelReviewNow(runId),
          qcModeSettingsOf: (projectId) => planningRunService.qcModeSettingsOf(projectId),
          defaultMaxRoundsOf: (projectId) => planningRunService.defaultMaxRoundsOf(projectId),
          createReviewAdapter: (provider, model) => buildPlanningAdapter(provider, model),
          ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
          ...(options.planningRuns.executionKickoff
            ? { executionKickoff: options.planningRuns.executionKickoff }
            : {}),
        });
        await conversationPlanWorkflow.reconcileKickoffIntents();
        let kickoffReconcileInFlight = false;
        conversationKickoffTimer = setInterval(() => {
          if (kickoffReconcileInFlight || !conversationPlanWorkflow) return;
          kickoffReconcileInFlight = true;
          void conversationPlanWorkflow
            .reconcileKickoffIntents()
            .catch(() => undefined)
            .finally(() => {
              kickoffReconcileInFlight = false;
            });
        }, 5_000);
        conversationKickoffTimer.unref?.();
      }
      const reviewWorkflow = conversationPlanWorkflow;
      const planningWorker = new PlanningRunWorker(planningTransactions, buildPlanningAdapter, {
        resolveModels: resolvePlanningModels,
        ...(reviewWorkflow
          ? {
              loadReviewOnlySeed: (runId: string) => reviewWorkflow.loadReviewOnlySeed(runId),
              markReviewOnlyStarted: (reviewId: string) =>
                reviewWorkflow.markReviewOnlyStarted(reviewId),
              recordReviewOnlyProgress: (input) => reviewWorkflow.recordReviewOnlyProgress(input),
              recordReviewOnlyChatEvent: (input) => reviewWorkflow.recordReviewOnlyChatEvent(input),
              completeReviewOnly: (input: {
                reviewId: string;
                planningRunId: string;
                result: import("./planning/reviewOnlySession.js").ReviewOnlyPlanningResult;
                totalCostUsd: number;
              }) => reviewWorkflow.completeReviewOnly(input),
              pauseReviewOnly: (input: {
                reviewId: string;
                planningRunId: string;
                result: import("./planning/reviewOnlySession.js").ReviewOnlyPlanningPausedResult;
              }) => reviewWorkflow.pauseReviewOnly(input),
              failReviewOnly: (runId: string, error: unknown) =>
                reviewWorkflow.failReviewOnly(runId, error),
            }
          : {}),
        ...(options.planningRuns.executionKickoff
          ? { executionKickoff: options.planningRuns.executionKickoff }
          : {}),
        ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
        // FRONT DOOR P4: resolve a run's objective attachment ids to image parts
        // for round-1 injection. Only wired when the attachments runtime exists.
        ...(attachmentService
          ? {
              loadRoundOneImages: (projectId: string, attachmentIds: readonly string[]) =>
                attachmentService.imagePartsFor(projectId, attachmentIds),
            }
          : {}),
        buildStaffingProposal: async ({
          projectId,
          initiatedByUserId,
          objective,
          plan,
          pm,
          workerProviders,
        }): Promise<PlanningStaffingProposalDto | null> => {
          const summary = await projects.summary(projectId);
          const staffingPm = buildPlanningAdapter(pm.provider, pm.model, pm.reasoning_effort);
          const recommendation = await recommendProjectAllocation({
            pm: staffingPm,
            projectId,
            ...(initiatedByUserId ? { initiatedByUserId } : {}),
            projectName: summary.name,
            objective,
            graph: WorkflowGraph.fromPlan(plan).snapshot(),
            models: configuredExecutionModels(),
            // PHASE TAB P1: the run's implementation-provider constraint.
            // Reviewers stay cross-provider (see allocationRecommendation.ts).
            ...(workerProviders !== "both" ? { allowedWorkerProviders: [workerProviders] } : {}),
          });
          options.recordUsage?.([recommendation.usage]);
          return {
            summary: recommendation.summary,
            recommendations: recommendation.recommendations,
          };
        },
      });
      executeReviewNow = (runId) => planningWorker.runNow(runId);
      cancelReviewNow = (runId) => planningWorker.cancelReview(runId);

      if (
        conversationPlanWorkflow &&
        conversationService &&
        conversationContextAssembler &&
        runtimeTransactionsForInference
      ) {
        const planProposals = new ConversationPlanProposalService(
          runtimeTransactionsForInference,
          conversationService,
          conversationContextAssembler,
          conversationPlanWorkflow,
          {
            now,
            createAdapter: (provider, model) => buildPlanningAdapter(provider, model),
          },
        );
        const planChanges = new ConversationPlanChangeProposalService(
          runtimeTransactionsForInference,
          conversationPlanWorkflow,
        );
        const humanSteering = new ConversationHumanSteeringService(
          runtimeTransactionsForInference,
          {
            contextBaseUrl:
              options.execution?.baseUrl ?? options.publicOrigin ?? "http://127.0.0.1",
          },
        );
        await planProposals.reconcileOrphans();
        registerConversationPlanRoutes(app, {
          requireUser: requireSessionUser,
          workflow: conversationPlanWorkflow,
          proposals: planProposals,
          changes: planChanges,
          steering: humanSteering,
        });
      }

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
        if (error instanceof ProjectNotFoundError) {
          reply.code(404).send({ error: "project_not_found", message: error.message });
          return;
        }
        if (error instanceof PlanningRunConflictError) {
          reply.code(404).send({ error: error.code, message: error.message });
          return;
        }
        // PHASE TAB P1: a decision against a run that is not in a
        // terminal-review state (converged/cap_reached) is a conflict.
        if (error instanceof PlanningRunDecisionError) {
          reply.code(409).send({ error: error.code, message: error.message });
          return;
        }
        throw error;
      };

      const projectRulesError = (reply: FastifyReply, error: unknown): void => {
        if (error instanceof ProjectRulesNotFoundError) {
          reply.code(404).send({ error: "project_not_found", message: error.message });
          return;
        }
        throw error;
      };

      const PlanningParticipantBody = z
        .object({
          provider: z.enum(["anthropic", "openai"]),
          model: z.string().trim().min(1).max(200),
          reasoning_effort: CodexReasoningEffort.optional(),
        })
        .strict()
        .superRefine((participant, context) => {
          if (participant.provider !== "openai" && participant.reasoning_effort !== undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["reasoning_effort"],
              message: "reasoning effort is available only for OpenAI/Codex models",
            });
          }
        });

      const CreatePlanningRunBody = z
        .object({
          objective: z.string().trim().min(1).max(100_000),
          max_rounds: z.number().int().min(1).max(5).optional(),
          // PHASE TAB P1: per-run review-round cap. Same semantics as
          // max_rounds (it IS the round cap); when both are supplied,
          // review_rounds wins.
          review_rounds: z.number().int().min(0).max(5).optional(),
          mode: z.enum(["planned", "quick"]).optional(),
          pm: PlanningParticipantBody.optional(),
          agent: PlanningParticipantBody.optional(),
          // PHASE TAB P1: which implementation providers allocation staffing
          // may use. Default "both".
          worker_providers: z.enum(["anthropic", "openai", "both"]).optional(),
          // FRONT DOOR P4: objective attachment ids, persisted on the run and
          // injected into the PM's and reviewer's round-1 messages.
          attachment_ids: z.array(z.string().trim().min(1)).max(50).optional(),
        })
        .strict();

      app.post("/api/v2/projects/:id/planning-runs", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const { id } = req.params as { id: string };
        const body = CreatePlanningRunBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        const mode = body.data.mode ?? "planned";
        if (mode === "planned" && body.data.review_rounds === 0) {
          return reply.code(400).send({
            error: "bad_request",
            message: "planned phases require at least one review round",
          });
        }
        if (
          mode === "quick" &&
          body.data.review_rounds !== undefined &&
          body.data.review_rounds !== 0
        ) {
          return reply.code(400).send({
            error: "bad_request",
            message: "quick changes do not use review rounds",
          });
        }
        if (body.data.pm && !isPmModelForProvider(body.data.pm.provider, body.data.pm.model)) {
          return reply.code(422).send({
            error: "invalid_model",
            message: `model "${body.data.pm.model}" is not available for ${body.data.pm.provider}`,
          });
        }
        if (
          body.data.agent &&
          !isPmModelForProvider(body.data.agent.provider, body.data.agent.model)
        ) {
          return reply.code(422).send({
            error: "invalid_model",
            message: `model "${body.data.agent.model}" is not available for ${body.data.agent.provider}`,
          });
        }
        if (
          body.data.agent &&
          body.data.worker_providers &&
          body.data.worker_providers !== "both" &&
          body.data.worker_providers !== body.data.agent.provider
        ) {
          return reply.code(400).send({
            error: "bad_request",
            message: "the selected agent must be inside the allowed provider pool",
          });
        }
        const maxRounds = mode === "quick" ? 1 : (body.data.review_rounds ?? body.data.max_rounds);
        try {
          if (options.relationalComposition) {
            await options.relationalComposition.ensureProjectAnchor(
              await projects.summary(id),
              user.id,
            );
          }

          const availableExecutionModels = configuredExecutionModels().filter(
            (model) =>
              !body.data.worker_providers ||
              body.data.worker_providers === "both" ||
              model.provider === body.data.worker_providers,
          );
          if (body.data.agent) {
            const problem = executionModelUnavailableMessage(
              body.data.agent.provider,
              body.data.agent.model,
              executionModelCatalog(),
            );
            if (problem) {
              return reply.code(422).send({
                error: "agent_model_unavailable",
                message: problem,
              });
            }
          } else if (availableExecutionModels.length === 0) {
            return reply.code(422).send({
              error: "agent_model_unavailable",
              message: `No execution agent is available for the selected provider pool. Configure ${RUNNER_ALLOWED_MODELS_ENV} and the corresponding provider API key before starting work.`,
            });
          }

          const agent = body.data.agent;

          const run = await planningRunService.create(id, {
            objective: body.data.objective,
            mode,
            requestedBy: user.id,
            ...(maxRounds !== undefined ? { maxRounds } : {}),
            ...(agent
              ? { workerProviders: agent.provider }
              : body.data.worker_providers !== undefined
                ? { workerProviders: body.data.worker_providers }
                : {}),
            ...(body.data.pm ? { pm: body.data.pm } : {}),
            ...(agent ? { agent } : {}),
            // FRONT DOOR P4: persist objective attachments so the worker injects
            // them into round 1. Previously validated-but-ignored input.
            ...(body.data.attachment_ids !== undefined
              ? { attachmentIds: body.data.attachment_ids }
              : {}),
          });
          stores.audit(user.id, "planning_run.created", `${id}:${run.id}:${mode}`, now());
          reply.code(202).send({ planning_run_id: run.id });
          void planningWorker.runNow(run.id).catch((error) => {
            stores.audit(
              user.id,
              "planning_run.dispatch_failed",
              `${id}:${run.id}:${error instanceof Error ? error.message : String(error)}`,
              now(),
            );
          });
        } catch (error) {
          planningRunError(reply, error);
        }
      });

      app.get("/api/v2/projects/:id/planning-runs", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          reply
            .header("Cache-Control", "no-store")
            .send({ planning_runs: await planningRunService.list(id) });
        } catch (error) {
          planningRunError(reply, error);
        }
      });

      app.get("/api/v2/projects/:id/rules", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          reply.header("Cache-Control", "no-store").send(await projectRulesService.get(id));
        } catch (error) {
          projectRulesError(reply, error);
        }
      });

      app.put("/api/v2/projects/:id/rules", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const { id } = req.params as { id: string };
        const body = z
          .object({ content: z.string().max(100_000) })
          .strict()
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          const rules = await projectRulesService.save(id, user.id, body.data.content);
          stores.audit(user.id, "project.rules_updated", `${id}:${rules.version}`, now());
          reply.send(rules);
        } catch (error) {
          projectRulesError(reply, error);
        }
      });

      // The newest run is the durable resume pointer for the planning-to-code
      // journey. A browser refresh must not send the user back to a blank
      // setup form merely because the transient focus_planning_run_id was
      // lost.
      app.get("/api/v2/projects/:id/planning-runs/latest", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          reply.header("Cache-Control", "no-store").send({
            planning_run: await planningRunService.latest(id),
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

      // Retry only the materialize/approve/launch half of an already-approved
      // run. The kickoff implementation is an idempotent saga, so a temporary
      // dispatch or setup failure does not require another planning decision.
      app.post("/api/v2/projects/:id/planning-runs/:runId/execution", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const { id, runId } = req.params as { id: string; runId: string };
        try {
          const run = await planningRunService.get(id, runId);
          if (run.status !== "approved" || run.decision?.decision !== "approve") {
            return reply.code(409).send({
              error: "invalid_status",
              message: `planning run "${runId}" must be approved before execution can be retried`,
            });
          }
          let execution: { started: boolean; detail: string } | null = null;
          const kickoff = options.planningRuns?.executionKickoff;
          if (kickoff) {
            try {
              execution = await kickoff.kickoff({
                projectId: id,
                planningRunId: runId,
                staffing: run.decision.staffing ?? null,
                decidedBy: user.id,
              });
            } catch (error) {
              execution = {
                started: false,
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          }
          stores.audit(
            user.id,
            "planning_run.execution_retry",
            `${id}:${runId}:${execution?.started ? "started" : "not_started"}`,
            now(),
          );
          reply.send({ ...run, execution });
        } catch (error) {
          planningRunError(reply, error);
        }
      });

      // -----------------------------------------------------------------
      // PHASE TAB P1: human decision on a terminal-review planning run.
      //   approve — optional staffing overrides (validated against the model
      //             registry), records the approval, then calls the
      //             execution-kickoff seam when one is wired (see
      //             ApprovedPlanExecutionKickoff). Response carries the
      //             updated run plus `execution` ({started, detail} | null).
      //   modify  — requires `direction`; re-queues the run through
      //             revise→review cycles against its configured round cap
      //             with the direction injected into the revision prompt.
      //   reject  — records the rejection and closes the run.
      // 409 when the run is not converged/cap_reached.
      // -----------------------------------------------------------------
      const PlanningRunDecisionBody = z
        .object({
          decision: z.enum(["approve", "modify", "reject"]),
          direction: z.string().trim().min(1).max(20_000).optional(),
          staffing: z
            .array(
              z
                .object({
                  node_id: z.string().trim().min(1),
                  provider: z.enum(["anthropic", "openai"]),
                  model: z.string().trim().min(1).max(200),
                  reasoning_effort: CodexReasoningEffort.nullable().optional(),
                })
                .strict()
                .superRefine((entry, context) => {
                  if (entry.provider !== "openai" && entry.reasoning_effort != null) {
                    context.addIssue({
                      code: z.ZodIssueCode.custom,
                      path: ["reasoning_effort"],
                      message: "reasoning effort is available only for OpenAI/Codex models",
                    });
                  }
                }),
            )
            .max(200)
            .optional(),
        })
        .strict();

      const invalidStaffingEntry = (entry: ApprovedStaffingEntryDto): string | null => {
        const registered = DEFAULT_MODEL_REGISTRY[entry.model];
        if (!registered || !registered.selectable) {
          return `unknown or non-selectable model "${entry.model}" for node "${entry.node_id}"`;
        }
        if (registered.provider !== entry.provider) {
          return (
            `model "${entry.model}" belongs to provider "${registered.provider}", ` +
            `not "${entry.provider}" (node "${entry.node_id}")`
          );
        }
        if (entry.provider !== "openai" && entry.reasoning_effort != null) {
          return `reasoning effort is available only for OpenAI/Codex models (node "${entry.node_id}")`;
        }
        return executionModelUnavailableMessage(
          entry.provider,
          entry.model,
          executionModelCatalog(),
        );
      };

      app.post("/api/v2/projects/:id/planning-runs/:runId/decision", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        // PHASE TAB P4: the kickoff records a strategy approval attributed to
        // the deciding human (approvals.actor_id is FK-bound to users), so
        // the route resolves the session user rather than passing "operator".
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const { id, runId } = req.params as { id: string; runId: string };
        const body = PlanningRunDecisionBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        let input: PlanningRunDecisionInput;
        if (body.data.decision === "modify") {
          if (!body.data.direction) {
            return reply
              .code(400)
              .send({ error: "bad_request", message: "modify requires a non-empty direction" });
          }
          input = { decision: "modify", direction: body.data.direction };
        } else if (body.data.decision === "approve") {
          for (const entry of body.data.staffing ?? []) {
            const problem = invalidStaffingEntry(entry);
            if (problem) {
              return reply.code(422).send({ error: "invalid_staffing", message: problem });
            }
          }
          input = {
            decision: "approve",
            ...(body.data.staffing !== undefined ? { staffing: body.data.staffing } : {}),
          };
        } else {
          input = { decision: "reject" };
        }
        try {
          // PHASE TAB P5b: an approve's staffing overrides must also honor the
          // run's own worker_providers constraint (set at creation), not just
          // the model registry — otherwise a human override could staff a
          // provider the run's allocation was explicitly forbidden to use.
          // Message phrasing mirrors allocationRecommendation's
          // provider_constraint refusal. worker_providers is immutable after
          // creation, so reading it outside decide()'s transaction is safe.
          if (input.decision === "approve" && input.staffing && input.staffing.length > 0) {
            const existing = await planningRunService.get(id, runId);
            if (existing.worker_providers !== "both") {
              const violation = input.staffing.find(
                (entry) => entry.provider !== existing.worker_providers,
              );
              if (violation) {
                return reply.code(422).send({
                  error: "invalid_staffing",
                  message:
                    `Node "${violation.node_id}" uses implementation provider ${violation.provider}, ` +
                    `but this run only allows ${existing.worker_providers}.`,
                });
              }
            }
          }
          const run = await planningRunService.decide(id, runId, input);
          // PHASE TAB P5b: the decision is the resolved session user's act, so
          // the audit actor is that user — not the legacy "operator" literal.
          stores.audit(user.id, `planning_run.decision.${input.decision}`, `${id}:${runId}`, now());
          if (input.decision === "modify") {
            // Same fire-and-forget dispatch as creation: the poller timer is
            // the safety net if this immediate kick is lost.
            reply.code(202).send(run);
            void planningWorker.runNow(runId).catch((error) => {
              stores.audit(
                user.id,
                "planning_run.dispatch_failed",
                `${id}:${runId}:${error instanceof Error ? error.message : String(error)}`,
                now(),
              );
            });
            return;
          }
          if (input.decision === "approve") {
            // Execution kickoff is best-effort and honestly reported: a
            // recorded approval is never rolled back because kickoff failed.
            let execution: { started: boolean; detail: string } | null = null;
            const kickoff = options.planningRuns?.executionKickoff;
            if (kickoff) {
              try {
                execution = await kickoff.kickoff({
                  projectId: id,
                  planningRunId: runId,
                  staffing: run.decision?.staffing ?? null,
                  decidedBy: user.id,
                });
              } catch (error) {
                execution = {
                  started: false,
                  detail: error instanceof Error ? error.message : String(error),
                };
              }
              stores.audit(
                user.id,
                "planning_run.execution_kickoff",
                `${id}:${runId}:${execution?.started ? "started" : "not_started"}`,
                now(),
              );
            }
            reply.send({ ...run, execution });
            return;
          }
          reply.send(run);
        } catch (error) {
          planningRunError(reply, error);
        }
      });

      // ---------------------------------------------------------------
      // FRONT DOOR P2b: reviewer-selection write path. P2 built the storage
      // (planning_reviewer_settings) and the read/resolution in
      // planning/reviewerSelection.ts, but shipped no route to set it. GET
      // reports the effective reviewer (an explicit override, or the
      // automatic opposite-provider default); PATCH sets an explicit
      // override; DELETE clears it back to automatic. resolvePlanningParticipants()
      // — and therefore every future planning run — picks up either state
      // unchanged, since it only ever reads reviewerSelectionOf().
      //
      // Model validity: there is no static catalog that legitimately governs
      // reviewer models the way NORNS_DEBATE_ALLOWED_MODELS governs debate
      // models — that catalog is for implementation-worker/debate models, a
      // different model space, and resolvePlanningParticipants() itself
      // already accepts any non-empty persisted model string (see
      // planningReviewerSelection.test.ts). So this route validates only
      // provider enum + non-empty model; an unusable model surfaces as a
      // truthful planning-run failure at run time, same as today.
      //
      // QCP-4A: the same body also carries the project-layer QC cadence
      // default — qc_mode and its allow_unadjudicated_rebuttals escape
      // hatch. Both are independently optional so a caller can change one
      // without resupplying the reviewer override (see
      // PlanningRunService.setQcModeSettings); provider/model stay a
      // required pair when either is present, matching the pre-existing
      // "both or neither" behavior.
      // ---------------------------------------------------------------
      const PlanningReviewerBody = z
        .object({
          provider: z.enum(["anthropic", "openai"]).optional(),
          model: z.string().trim().min(1).max(200).optional(),
          qc_mode: z.enum(QC_MODES).optional(),
          allow_unadjudicated_rebuttals: z.boolean().optional(),
          // QCP-14: 0 means review is off; drizzle/0071_qc_zero_rounds.sql
          // widened planning_reviewer_settings_default_max_rounds_check to
          // BETWEEN 0 AND 5 to match.
          default_max_rounds: z.number().int().min(0).max(5).optional(),
        })
        .strict()
        .refine((body) => (body.provider === undefined) === (body.model === undefined), {
          message: "provider and model must be set together",
        });

      app.get("/api/v2/projects/:id/planning-reviewer", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          const [pmSelection, persisted, qcModeSettings, defaultMaxRounds] = await Promise.all([
            projects.pmSelectionOf(id),
            planningRunService.reviewerSelectionOf(id),
            planningRunService.qcModeSettingsOf(id),
            planningRunService.defaultMaxRoundsOf(id),
          ]);
          reply.send({
            ...(persisted
              ? { provider: persisted.provider, model: persisted.model, mode: "explicit" as const }
              : {
                  provider: defaultReviewerProviderFor(pmSelection.provider),
                  model: null,
                  mode: "automatic" as const,
                }),
            qc_mode: qcModeSettings.qcMode,
            allow_unadjudicated_rebuttals: qcModeSettings.allowUnadjudicatedRebuttals,
            default_max_rounds: defaultMaxRounds,
          });
        } catch (error) {
          projectError(reply, error);
        }
      });

      app.patch("/api/v2/projects/:id/planning-reviewer", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        const body = PlanningReviewerBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        try {
          await projects.pmSelectionOf(id); // project-existence check with the shared 404 mapping
          if (body.data.provider !== undefined && body.data.model !== undefined) {
            await planningRunService.setReviewerSelection(id, {
              provider: body.data.provider,
              model: body.data.model,
            });
          }
          if (
            body.data.qc_mode !== undefined ||
            body.data.allow_unadjudicated_rebuttals !== undefined ||
            body.data.default_max_rounds !== undefined
          ) {
            await planningRunService.setQcModeSettings(id, {
              qcMode: body.data.qc_mode,
              allowUnadjudicatedRebuttals: body.data.allow_unadjudicated_rebuttals,
              defaultMaxRounds: body.data.default_max_rounds,
            });
          }
          reply.code(204).send();
        } catch (error) {
          projectError(reply, error);
        }
      });

      app.delete("/api/v2/projects/:id/planning-reviewer", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          await projects.pmSelectionOf(id);
          await planningRunService.setReviewerSelection(id, null);
          reply.code(204).send();
        } catch (error) {
          projectError(reply, error);
        }
      });
    }

    // ---- FRONT DOOR P4 (D3): model-readable attachments ---------------------
    // Content-addressed storage for project objectives. Raw file bytes
    // are the preferred upload transport; legacy base64 JSON remains accepted.
    // Metadata JSON out; the GET serves the raw bytes. Session auth + project
    // authorization mirror the neighboring v2 project routes (the service 404s
    // an unknown project). Caps, mime allow-list, dedupe, and quotas live in the
    // AttachmentService. Fully additive — its own tables (drizzle/0013) and its
    // own route surface. `attachmentService` is constructed above and shared
    // with the planning round-1 image injection.
    if (attachmentService) {
      const attachmentError = (reply: FastifyReply, error: unknown): void => {
        if (error instanceof AttachmentLookupError) {
          reply.code(404).send({ error: error.code, message: error.message });
          return;
        }
        if (error instanceof AttachmentValidationError) {
          const status =
            error.code === "unsupported_media_type"
              ? 415
              : error.code === "payload_too_large"
                ? 413
                : error.code === "invalid_image" || error.code === "invalid_file"
                  ? 400
                  : 409; // objective_limit | project_quota | attachment_in_use
          reply.code(status).send({ error: error.code, message: error.message });
          return;
        }
        throw error;
      };

      const CreateAttachmentBody = z
        .object({
          mime: z.string().trim().min(1).max(100),
          base64: z.string().min(1),
          purpose: z.string().trim().min(1).max(200).optional(),
          filename: z.string().trim().min(1).max(255).optional(),
        })
        .strict();

      // A 10 MB PDF is ~13.4 MB base64; leave bounded envelope headroom. The
      // decoded per-MIME limits remain enforced by AttachmentService.
      app.post(
        "/api/v2/projects/:id/attachments",
        { bodyLimit: 16 * 1024 * 1024 },
        async (req, reply) => {
          const user = await resolveUser(req);
          if (!user) return reply.code(401).send({ error: "unauthorized" });
          const { id } = req.params as { id: string };
          try {
            const requestedMime =
              String(req.headers["content-type"] ?? "")
                .split(";", 1)[0]
                ?.trim()
                .toLowerCase() ?? "";
            const binary = Buffer.isBuffer(req.body)
              ? req.body
              : typeof req.body === "string"
                ? Buffer.from(req.body, "utf8")
                : null;
            const body = binary ? null : CreateAttachmentBody.safeParse(req.body);
            const resemblesEnvelope =
              typeof req.body === "object" &&
              req.body !== null &&
              ("mime" in req.body || "base64" in req.body);
            const rawJson =
              !binary &&
              !body?.success &&
              requestedMime === "application/json" &&
              !resemblesEnvelope
                ? Buffer.from(JSON.stringify(req.body), "utf8")
                : null;
            const rawContent = binary ?? rawJson;
            if (!rawContent && !body?.success) {
              return reply.code(400).send({ error: "bad_request" });
            }
            const headerPurpose = req.headers["x-attachment-purpose"];
            const purpose =
              typeof headerPurpose === "string" ? headerPurpose.trim().slice(0, 200) : undefined;
            const headerFilename = req.headers["x-attachment-filename"];
            const filename =
              typeof headerFilename === "string" ? headerFilename.trim().slice(0, 255) : undefined;
            const attachment = rawContent
              ? await attachmentService.create(id, {
                  mime: requestedMime,
                  content: rawContent,
                  ...(purpose ? { purpose } : {}),
                  ...(filename ? { filename } : {}),
                  createdBy: user.id,
                })
              : body?.success
                ? await attachmentService.create(id, {
                    mime: body.data.mime,
                    base64: body.data.base64,
                    ...(body.data.purpose !== undefined ? { purpose: body.data.purpose } : {}),
                    ...(body.data.filename !== undefined ? { filename: body.data.filename } : {}),
                    createdBy: user.id,
                  })
                : undefined;
            if (!attachment) return reply.code(400).send({ error: "bad_request" });
            stores.audit(user.email, "attachment.created", `${id}:${attachment.id}`, now());
            reply.code(201).send(attachment);
          } catch (error) {
            attachmentError(reply, error);
          }
        },
      );

      app.get("/api/v2/projects/:id/attachments/usage", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id } = req.params as { id: string };
        try {
          reply.header("Cache-Control", "no-store").send(await attachmentService.usage(id));
        } catch (error) {
          attachmentError(reply, error);
        }
      });

      app.get("/api/v2/projects/:id/attachments/:attachmentId", async (req, reply) => {
        if (!(await requireSession(req, reply))) return;
        const { id, attachmentId } = req.params as { id: string; attachmentId: string };
        try {
          const { mime, filename, bytes } = await attachmentService.content(id, attachmentId);
          reply
            .header("Content-Type", mime)
            .header("Cache-Control", "private, max-age=300, immutable")
            .header(
              "Content-Disposition",
              attachmentContentDisposition(filename, isImageAttachmentMime(mime)),
            )
            .header("X-Content-Type-Options", "nosniff")
            .header("ETag", `"${attachmentId}"`)
            .send(bytes);
        } catch (error) {
          attachmentError(reply, error);
        }
      });

      app.delete("/api/v2/projects/:id/attachments/:attachmentId", async (req, reply) => {
        const user = await resolveUser(req);
        if (!user) return reply.code(401).send({ error: "unauthorized" });
        const { id, attachmentId } = req.params as { id: string; attachmentId: string };
        try {
          await attachmentService.delete(id, attachmentId);
          stores.audit(user.email, "attachment.deleted", `${id}:${attachmentId}`, now());
          reply.code(204).send();
        } catch (error) {
          attachmentError(reply, error);
        }
      });
    }
  }

  // ---- EXECUTION E1: assembled task context --------------------------------
  //
  // The one route a dispatched runner uses to read the prompt Norns assembled
  // for its task. Everything else about assembly lives in src/execution/.
  //
  // AUTH: this route is NOT session-authenticated — the caller is a runner, not
  // a browser. The active device credential signs the purpose, identity,
  // credential, generation, method, canonical path/query, empty body digest,
  // timestamp, and one-time request id. The compatibility runner identity uses
  // the same transcript under a distinct scheme. Nothing secret appears in the
  // URL, so a `storage_ref` is safe to persist in a command, log, or audit.
  //
  // INTEGRITY: the bytes are content-addressed. The runner's
  // HashVerifiedContextLoader recomputes the sha256 and the byte size and
  // refuses anything that does not match the ref it was dispatched with, so a
  // tampered response is caught at the runner regardless of transport.
  if (options.execution) {
    const taskContextStore = new TaskContextStore(options.execution.transactions);
    taskContextAssembler = new RelationalTaskContextAssembler(
      options.execution.transactions,
      taskContextStore,
      {
        baseUrl: options.execution.baseUrl ?? options.publicOrigin ?? "http://127.0.0.1",
        ...(options.knowledge ? { knowledgeSource: options.knowledge.service } : {}),
      },
    );
    // EXECUTION E2: the fetch route below authenticates identity; this is
    // what additionally authorizes a specific document to a specific runner.
    dispatchContextScope = new DispatchContextScopeRepository(options.execution.transactions);

    app.get(`${TASK_CONTEXT_ROUTE_PREFIX}/:documentId`, async (req, reply) => {
      const auth = await runnerHttpAuthentication.authenticate({
        purpose: DEVICE_CONTEXT_RETRIEVAL_HTTP_SIGNATURE_PURPOSE,
        method: req.method,
        path_and_query: req.url,
        routed_path: `${TASK_CONTEXT_ROUTE_PREFIX}/${routedDeviceHttpPathSegment(
          (req.params as { documentId: string }).documentId,
        )}`,
        body_sha256: capturedRunnerHttpBodySha256(req),
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      if (!auth.ok) {
        stores.audit(
          `runner:${
            req.headers[DEVICE_HTTP_DEVICE_ID_HEADER] ??
            req.headers["x-norns-runner-id"] ??
            "unknown"
          }`,
          "execution.context.auth_failed",
          auth.reason,
          now(),
        );
        return reply.code(401).send({ error: "unauthorized" });
      }
      const subjectId = auth.identity.authorization_subject_id;
      const { documentId } = req.params as { documentId: string };
      if (auth.identity.kind === "device") {
        const deviceIdentity = auth.identity;
        const authorization = options.deviceActionAuthorization;
        if (!authorization) {
          return reply.code(503).send({ error: "device_authorization_unavailable" });
        }
        try {
          const content = await authorization.transactions.transaction(async (sql) => {
            await authorization.service.lockTransportIdentity(sql, {
              subject: "device",
              runner_id: deviceIdentity.device_id,
              generation: deviceIdentity.generation,
              credential_id: deviceIdentity.credential_id,
            });
            const runId = await dispatchContextScope?.authorizedRunIdInTransaction(
              sql,
              deviceIdentity.device_id,
              deviceIdentity.generation,
              documentId,
            );
            if (!runId) return null;
            await authorization.service.assertRun(sql, {
              subject: "device",
              runner_id: deviceIdentity.device_id,
              generation: deviceIdentity.generation,
              credential_id: deviceIdentity.credential_id,
              run_id: runId,
            });
            return taskContextStore.contentInTransaction(sql, documentId);
          });
          if (!content) {
            stores.audit(
              `device:${deviceIdentity.device_id}`,
              "execution.context.auth_failed",
              "not_scoped_to_authorized_device_run",
              now(),
            );
            return reply.code(403).send({ error: "forbidden" });
          }
          return reply
            .type(content.media_type)
            .header("cache-control", "private, no-store")
            .send(content.bytes);
        } catch (error) {
          if (error instanceof DeviceActionAuthorizationError) {
            stores.audit(
              `device:${deviceIdentity.device_id}`,
              "execution.context.auth_failed",
              error.code,
              now(),
            );
            return reply.code(403).send({ error: "forbidden" });
          }
          throw error;
        }
      }
      if (auth.identity.kind !== "legacy_runner") {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const legacyIdentity = auth.identity;
      let legacyAuthorized = false;
      let legacyDocument: TaskContextDocumentContent | null | undefined;
      try {
        const authorizationResult = options.deviceActionAuthorization
          ? await options.deviceActionAuthorization.transactions.transaction(async (sql) => {
              const runId = await dispatchContextScope?.authorizedRunIdInTransaction(
                sql,
                legacyIdentity.runner_id,
                legacyIdentity.generation,
                documentId,
              );
              if (!runId) return { authorized: false, document: null };
              await options.deviceActionAuthorization?.service.assertRun(sql, {
                subject: "legacy_runner",
                runner_id: legacyIdentity.runner_id,
                generation: legacyIdentity.generation,
                run_id: runId,
              });
              return {
                authorized: true,
                document: await taskContextStore.contentInTransaction(sql, documentId),
              };
            })
          : await (async () => {
              const authorized = await dispatchContextScope?.isAuthorized(
                legacyIdentity.runner_id,
                legacyIdentity.generation,
                documentId,
              );
              return {
                authorized: authorized === true,
                document: authorized ? await taskContextStore.content(documentId) : null,
              };
            })();
        legacyAuthorized = authorizationResult.authorized;
        legacyDocument = authorizationResult.document;
      } catch (error) {
        if (!(error instanceof DeviceActionAuthorizationError)) throw error;
        stores.audit(
          `runner:${legacyIdentity.runner_id}`,
          "execution.context.auth_failed",
          error.code,
          now(),
        );
        return reply.code(403).send({ error: "forbidden" });
      }
      // EXECUTION E2: a valid signature proves WHO is asking, not WHAT they
      // are entitled to read. Checked before the existence response so an
      // unscoped caller learns nothing about whether the id is real.
      if (!legacyAuthorized) {
        stores.audit(
          `runner:${subjectId}`,
          "execution.context.auth_failed",
          "not_scoped_to_runner",
          now(),
        );
        return reply.code(403).send({ error: "forbidden" });
      }
      if (!legacyDocument) return reply.code(404).send({ error: "not_found" });
      return reply
        .header("content-type", legacyDocument.media_type)
        .header("cache-control", "private, max-age=0, no-store")
        .send(legacyDocument.bytes);
    });
  }

  // ---- EXECUTION E2: start a phase ------------------------------------------
  //
  // The caller `Phase4Coordinator.schedule()` never had. Given an approved (or
  // already active) phase, finds its dependency-ready tasks, assembles each
  // one's context through EXECUTION E1's assembler, and schedules it through
  // the EXISTING coordinator gate -- unchanged, unweakened. See
  // coordinator/phaseLaunchService.ts for the full design note.
  if (options.phase4 && options.execution && taskContextAssembler && dispatchContextScope) {
    const phaseLaunch = new PhaseLaunchService(
      options.execution.transactions,
      options.phase4.coordinator,
      taskContextAssembler,
      dispatchContextScope,
      (runnerId) => {
        const runner = stores.runner(runnerId);
        return runner
          ? { runner_id: runner.runner_id, runner_generation: runner.generation }
          : null;
      },
      options.actionsExecution
        ? {
            coordinator: options.actionsExecution.coordinator,
            repository: options.actionsExecution.repository,
          }
        : undefined,
    );
    const recoveryActions = new Phase4RecoveryActionService(
      options.execution.transactions,
      phaseLaunch,
    );
    decisionRecoveryActions = recoveryActions;

    // ---- EXECUTION E12: drain the queue when a slot frees -------------------
    //
    // `startPhase` was always idempotent and always meant to be called again
    // after a task finishes. Nothing ever called it, so over-cap work was
    // dropped rather than queued. This timer is that caller; see
    // coordinator/phaseQueueDrainer.ts for why it is a poll rather than an
    // event hook, and for how it derives its authorization from the human who
    // started the phase.
    // Narrowed once here: the enclosing `if` already established it, but the
    // route closures below outlive that narrowing.
    const executionTransactions = options.execution.transactions;
    const phaseQueueDrainer = new PhaseQueueDrainer(executionTransactions, phaseLaunch, {
      now,
      onError: (projectId, phaseId, error) => {
        app.log.error(
          { projectId, phaseId, err: error },
          "phase queue drain failed; queued tasks in this phase are not being dispatched",
        );
      },
    });
    let draining = false;
    phaseQueueDrainTimer = setInterval(() => {
      // Non-overlapping: a slow drain must never stack up parallel drains,
      // which would race each other for the same free slot. Losing a tick is
      // harmless -- the next one re-derives the queue from scratch.
      if (draining) return;
      draining = true;
      void phaseQueueDrainer
        .drain()
        .catch((error) => app.log.error({ err: error }, "phase queue drain tick failed"))
        .finally(() => {
          draining = false;
        });
    }, PHASE_QUEUE_DRAIN_INTERVAL_MS);
    phaseQueueDrainTimer.unref();

    // ---- EXECUTION E12: fan-out visibility ---------------------------------
    //
    // "How many are running, how many are queued, and is anything waiting on
    // me?" -- the three numbers a human needs before they trust a cap above 1.
    app.get("/api/v2/projects/:id/phases/:phaseId/concurrency", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, phaseId } = req.params as { id: string; phaseId: string };
      try {
        const snapshot = await executionTransactions.transaction((tx) =>
          describePhaseConcurrency(tx, id, phaseId),
        );
        reply.send(snapshot);
      } catch (error) {
        reply.code(409).send({ error: "concurrency_unavailable", detail: String(error) });
      }
    });

    // ---- EXECUTION E12: integration conflicts a human must resolve ---------
    //
    // Norns never merges and never resolves. These two routes are the entire
    // human interface to a conflict: read what was observed, and record what
    // you did about it. Completion of either task stays refused until then.
    const runConflicts = new RunIntegrationConflictService(executionTransactions);

    app.get("/api/v2/projects/:id/phases/:phaseId/conflicts", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { phaseId } = req.params as { id: string; phaseId: string };
      const query = req.query as { open_only?: string };
      try {
        reply.send({
          conflicts: await runConflicts.listForPhase(phaseId, {
            open_only: query.open_only === "true",
          }),
        });
      } catch (error) {
        reply.code(409).send({ error: "conflicts_unavailable", detail: String(error) });
      }
    });

    app.post("/api/v2/run-conflicts/:conflictId/resolve", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const user = await resolveUser(req);
      if (!user) return;
      const { conflictId } = req.params as { conflictId: string };
      const parsed = RunConflictResolutionRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_resolution", detail: parsed.error.message });
      }
      const resolvedAt = now();
      try {
        const conflict = await runConflicts.resolve({
          conflict_id: conflictId,
          resolution: parsed.data.resolution,
          note: parsed.data.note ?? null,
          // A human, named. The database CHECK constraint refuses a resolved
          // row without an actor, so there is no path on which this becomes
          // an anonymous or automatic resolution.
          actor: { actor_type: "human", actor_id: user.id },
          resolved_at: resolvedAt.toISOString(),
        });
        stores.audit(
          user.email,
          "execution.conflict.resolve",
          `${conflictId} -> ${parsed.data.resolution}`,
          resolvedAt,
        );
        reply.send(conflict);
      } catch (error) {
        if (error instanceof RunIntegrationConflictError) {
          return reply.code(409).send({ error: error.code, detail: error.message });
        }
        reply.code(409).send({ error: "conflict_resolution_failed", detail: String(error) });
      }
    });

    // Read-only preflight so the UI can show a truthful disabled reason
    // without side effects a human didn't ask for -- never schedules
    // anything and never spends budget.
    app.get("/api/v2/projects/:id/phases/:phaseId/start-readiness", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const { id, phaseId } = req.params as { id: string; phaseId: string };
      try {
        reply.send(await phaseLaunch.readiness({ project_id: id, phase_id: phaseId }));
      } catch (error) {
        reply.code(409).send({ error: "start_readiness_unavailable", detail: String(error) });
      }
    });

    app.post("/api/v2/projects/:id/phases/:phaseId/start", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const user = await resolveUser(req);
      if (!user) return;
      const { id, phaseId } = req.params as { id: string; phaseId: string };
      const issuedAt = now();
      try {
        const result = await phaseLaunch.startPhase({
          project_id: id,
          phase_id: phaseId,
          authorized_by: { actor_type: "human", actor_id: user.id },
          authorized_by_session_id: `authenticated-request:${req.id}`,
          issued_at: issuedAt.toISOString(),
        });
        stores.audit(
          user.email,
          "execution.phase.start",
          `${result.scheduled.length} scheduled, ${result.blocked.length} blocked`,
          issuedAt,
        );
        reply.code(202).send(result);
      } catch (error) {
        if (error instanceof PhaseLaunchError) {
          return reply.code(409).send({
            error: error.code,
            detail: error.message,
            action_required: error.action_required,
          });
        }
        reply.code(409).send({ error: "phase_start_conflict", detail: String(error) });
      }
    });

    const TerminalRecoveryBody = z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("retry"),
          failed_run_id: z.string().trim().min(1),
          expected_task_version: z.number().int().positive(),
          idempotency_key: z.string().trim().min(1),
        })
        .strict(),
      z
        .object({
          action: z.literal("cancel"),
          failed_run_id: z.string().trim().min(1),
          expected_task_version: z.number().int().positive(),
          idempotency_key: z.string().trim().min(1),
          reason: z.string().trim().min(1).max(4_000),
        })
        .strict(),
    ]);

    app.post("/api/v2/projects/:id/phases/:phaseId/tasks/:taskId/recovery", async (req, reply) => {
      if (!(await requireSession(req, reply))) return;
      const user = await resolveUser(req);
      if (!user) return;
      const body = TerminalRecoveryBody.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "bad_request", detail: body.error.message });
      }
      const { id, phaseId, taskId } = req.params as {
        id: string;
        phaseId: string;
        taskId: string;
      };
      const issuedAt = now();
      const common = {
        project_id: id,
        phase_id: phaseId,
        task_id: taskId,
        failed_run_id: body.data.failed_run_id,
        expected_task_version: body.data.expected_task_version,
        actor: { actor_type: "human" as const, actor_id: user.id },
        authorized_by_session_id: `authenticated-request:${req.id}`,
        idempotency_key: body.data.idempotency_key,
        correlation_id: `recovery:${req.id}`,
        causation_id: body.data.failed_run_id,
        issued_at: issuedAt.toISOString(),
      };
      try {
        const result =
          body.data.action === "retry"
            ? await recoveryActions.retry(common)
            : await recoveryActions.cancel({ ...common, reason: body.data.reason });
        if (!result.replayed) {
          stores.audit(
            user.email,
            `execution.recovery.${body.data.action}`,
            `${taskId} from ${body.data.failed_run_id}`,
            issuedAt,
          );
        }
        return reply.code(body.data.action === "retry" ? 202 : 200).send(result);
      } catch (error) {
        if (error instanceof Phase4RecoveryActionError) {
          return reply.code(error.status).send({
            error: error.code,
            detail: error.message,
            retriable: error.retriable,
          });
        }
        return reply.code(409).send({
          error: "recovery_conflict",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // ---- runner websocket ----------------------------------------------------------

  app.get("/ws/runner", { websocket: true }, (conn) => {
    const socket = asSocket(conn);
    const legacyRunnerChallenge = nonce();
    const deviceProtocolVersions = [
      ...(options.deviceWssAuthentication?.supportedProtocolVersions ?? []),
    ];
    const deviceChallenge =
      options.deviceWssAuthentication && deviceProtocolVersions.length > 0 ? nonce() : null;
    let authenticationState:
      | "awaiting"
      | "authenticating"
      | "authenticated_legacy_runner"
      | "authenticated_device"
      | "closed" = "awaiting";
    let authedRunnerId: string | null = null;
    let authedDevice: AuthenticatedDeviceWssIdentity | null = null;
    let disconnectDeviceControl: (() => void) | null = null;
    let runnerEventDelivery = Promise.resolve();
    let runnerEventIngressOpen = true;

    const rejectAuthentication = (principal: string, action: string): void => {
      if (authenticationState === "closed") return;
      authenticationState = "closed";
      stores.audit(principal, action, "authentication failed", now());
      sendFrame(socket, { type: "auth_error", reason: "authentication failed" });
      socket.close(1008, "authentication failed");
    };

    const rejectRunnerEvents = (
      runnerId: string,
      detail: string,
      options: { fencedGeneration?: number } = {},
    ): void => {
      if (!runnerEventIngressOpen) return;
      runnerEventIngressOpen = false;
      stores.auditRateLimited(`runner:${runnerId}`, "runner.event_rejected", detail, now());
      if (options.fencedGeneration !== undefined) {
        sendFrame(socket, {
          type: "fenced",
          current_generation: options.fencedGeneration,
        });
      }
      socket.close(1008, "runner event rejected");
    };

    sendFrame(socket, {
      type: "challenge",
      nonce: legacyRunnerChallenge,
      ...(deviceChallenge === null
        ? {}
        : {
            device_auth: {
              challenge: deviceChallenge,
              supported_protocol_versions: deviceProtocolVersions,
            },
          }),
    });

    socket.on("message", async (data) => {
      const frame = parseRunnerFrame(String(data));
      if (!frame) return;

      if (frame.type === "auth") {
        // Deprecated compatibility path for paired and ephemeral legacy
        // runners. Device frames are distinct and can never fall through here.
        if (authenticationState !== "awaiting") {
          rejectAuthentication(`runner:${frame.runner_id}`, "runner.auth_failed");
          return;
        }
        authenticationState = "authenticating";
        let runner = stores.runner(frame.runner_id);
        let durableActionsIdentity = false;
        if (frame.runner_id.startsWith("actions:") && options.actionsExecution) {
          try {
            const durable = await options.actionsExecution.repository.enrolledRunnerIdentity(
              frame.runner_id,
            );
            if (!durable) {
              runner = undefined;
            } else {
              durableActionsIdentity = true;
              const restored = stores.restoreDurableRunnerIdentity(
                frame.runner_id,
                durable.public_key_pem,
                durable.runner_generation,
              );
              runner = restored;
            }
          } catch (error) {
            stores.audit(
              `runner:${frame.runner_id}`,
              "runner.auth_restore_failed",
              error instanceof Error ? error.message : String(error),
              now(),
            );
            authenticationState = "closed";
            socket.close(1011, "runner authentication persistence unavailable");
            return;
          }
        }
        if (!durableActionsIdentity && !legacyLocalRunnerAuthEnabled) {
          rejectAuthentication(`runner:${frame.runner_id}`, "runner.auth_disabled");
          return;
        }
        if (authenticationState !== "authenticating") return;
        const authenticationTranscript = canonicalLegacyRunnerWssAuthenticationTranscript({
          purpose: LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE,
          runner_id: frame.runner_id,
          generation: frame.generation,
          protocol_version: frame.protocol_version,
          challenge: legacyRunnerChallenge,
        });
        if (
          !runner ||
          frame.protocol_version !== PROTOCOL_VERSION ||
          !verifyRunnerSignature(
            runner.public_key_pem,
            authenticationTranscript,
            frame.transcript_signature,
          )
        ) {
          rejectAuthentication(`runner:${frame.runner_id}`, "runner.auth_failed");
          return;
        }
        if (frame.generation !== runner.generation) {
          authenticationState = "closed";
          stores.audit(
            `runner:${frame.runner_id}`,
            "runner.fenced",
            `stale generation ${frame.generation} (current ${runner.generation})`,
            now(),
          );
          sendFrame(socket, { type: "fenced", current_generation: runner.generation });
          socket.close(1008, "runner generation fenced");
          return;
        }
        authedRunnerId = frame.runner_id;
        authenticationState = "authenticated_legacy_runner";
        sendFrame(socket, { type: "auth_ok" });
        return;
      }

      if (frame.type === "device_auth") {
        const authenticator = options.deviceWssAuthentication;
        if (authenticationState !== "awaiting" || !authenticator || deviceChallenge === null) {
          rejectAuthentication(`device:${frame.device_id}`, "device.wss_auth_failed");
          return;
        }
        authenticationState = "authenticating";
        let authenticated: AuthenticatedDeviceWssIdentity | null;
        try {
          authenticated = await authenticator.authenticate({
            device_id: frame.device_id,
            credential_id: frame.credential_id,
            generation: frame.generation,
            protocol_version: frame.protocol_version,
            ...(frame.agent_version !== undefined
              ? {
                  agent_version: frame.agent_version,
                  capabilities: frame.capabilities ?? [],
                }
              : {}),
            challenge: deviceChallenge,
            transcript_signature: frame.transcript_signature,
          });
        } catch (error) {
          stores.audit(
            `device:${frame.device_id}`,
            "device.wss_auth_unavailable",
            error instanceof Error ? error.message : String(error),
            now(),
          );
          authenticationState = "closed";
          socket.close(1011, "device authentication unavailable");
          return;
        }
        if (authenticationState !== "authenticating") return;
        if (!authenticated) {
          rejectAuthentication(`device:${frame.device_id}`, "device.wss_auth_failed");
          return;
        }
        authedDevice = authenticated;
        authenticationState = "authenticated_device";
        const advertisedDeviceCapabilities = new Set(frame.capabilities ?? []);
        if (
          advertisedDeviceCapabilities.has("workspace_picker") &&
          advertisedDeviceCapabilities.has("workspace_repository_inventory")
        ) {
          const priorSocket = runnerSockets.get(authenticated.device_id);
          if (priorSocket && priorSocket !== socket) {
            workspaceBroker.disconnect(authenticated.device_id);
            reconciledRunners.delete(authenticated.device_id);
            priorSocket.close(1008, "superseded device connection");
          }
          runnerSockets.set(authenticated.device_id, socket);
          reconciledRunners.set(authenticated.device_id, {
            socket,
            generation: authenticated.generation,
            workspacePicker: true,
            workspaceRepositoryInventory: true,
            workspaceClone: advertisedDeviceCapabilities.has("workspace_clone"),
          });
        }
        stores.audit(`device:${authenticated.device_id}`, "device.wss_authenticated", "", now());
        sendFrame(socket, {
          type: "device_auth_ok",
          device_id: authenticated.device_id,
          generation: authenticated.generation,
          protocol_version: authenticated.protocol_version,
        });
        if (options.deviceControl) {
          try {
            const connectedDeviceControl = await options.deviceControl.broker.connect({
              identity: authenticated,
              send: (frame) => sendFrame(socket, frame),
              close: (code, reason) => socket.close(code, reason),
            });
            if (!connectedDeviceControl) {
              authenticationState = "closed";
              return;
            }
            disconnectDeviceControl = connectedDeviceControl;
          } catch (error) {
            authenticationState = "closed";
            stores.audit(
              `device:${authenticated.device_id}`,
              "device.cancellation_reconcile_failed",
              error instanceof Error ? error.message : String(error),
              now(),
            );
            socket.close(1011, "device cancellation reconciliation unavailable");
            return;
          }
        }
        void options.deviceBrowserDelivery
          ?.deliverOwnerAvailability(
            {
              device_id: authenticated.device_id,
              availability: "online",
              observed_at: now().toISOString(),
            },
            scopedDeviceBrowserSessions(),
          )
          .catch(() => {
            // Browser presence delivery is best-effort and cannot weaken or
            // retroactively change the authenticated transport decision.
          });
        return;
      }

      if (authenticationState === "authenticated_device") {
        if (
          frame.type === "workspace_response" &&
          authedDevice &&
          frame.generation === authedDevice.generation
        ) {
          const reconciled = reconciledRunners.get(authedDevice.device_id);
          if (
            runnerSockets.get(authedDevice.device_id) === socket &&
            reconciled?.socket === socket &&
            reconciled.generation === frame.generation
          ) {
            workspaceBroker.receive(authedDevice.device_id, frame.generation, frame.response);
          }
          return;
        }
        if (
          frame.type === "device_cancellation_evidence" &&
          authedDevice &&
          options.deviceControl &&
          options.deviceWssAuthentication
        ) {
          const exactConnection =
            frame.device_id === authedDevice.device_id &&
            frame.credential_id === authedDevice.credential_id &&
            frame.generation === authedDevice.generation;
          let signatureValid = false;
          if (exactConnection) {
            try {
              // Parse the purpose-separated transcript before the repository
              // verifier so semantically impossible state/proof combinations
              // never reach durable evidence handling.
              canonicalDeviceCancellationEvidenceWssTranscript({
                purpose: DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE,
                device_id: frame.device_id,
                credential_id: frame.credential_id,
                generation: frame.generation,
                run_id: frame.run_id,
                evidence_state: frame.evidence_state,
                acknowledged_at: frame.acknowledged_at,
                process_exited_at: frame.process_exited_at,
                process_tree_reaped: frame.process_tree_reaped,
              });
              signatureValid =
                await options.deviceWssAuthentication.verifyCancellationEvidence(frame);
            } catch {
              signatureValid = false;
            }
          }
          if (!signatureValid) {
            stores.audit(
              `device:${authedDevice.device_id}`,
              "device.cancellation_evidence_rejected",
              `run=${frame.run_id} invalid proof`,
              now(),
            );
            authenticationState = "closed";
            socket.close(1008, "invalid cancellation evidence");
            return;
          }
          try {
            if (frame.evidence_state === "process_exited") {
              await options.deviceControl.cancellations.confirmProcessExited({
                run_id: frame.run_id,
                device_id: frame.device_id,
                credential_id: frame.credential_id,
                device_generation: frame.generation,
                acknowledged_at: frame.acknowledged_at,
                process_exited_at: frame.process_exited_at as string,
                process_tree_reaped: true,
              });
            } else {
              await options.deviceControl.cancellations.acknowledge({
                run_id: frame.run_id,
                device_id: frame.device_id,
                credential_id: frame.credential_id,
                device_generation: frame.generation,
                acknowledged_at: frame.acknowledged_at,
              });
            }
            sendFrame(socket, {
              type: "device_cancellation_evidence_ack",
              run_id: frame.run_id,
              evidence_state: frame.evidence_state,
            });
            stores.audit(
              `device:${authedDevice.device_id}`,
              "device.cancellation_evidence_recorded",
              `run=${frame.run_id} state=${frame.evidence_state}`,
              now(),
            );
          } catch (error) {
            const detail =
              error instanceof DeviceRunCancellationError ? error.code : "persistence_unavailable";
            stores.audit(
              `device:${authedDevice.device_id}`,
              "device.cancellation_evidence_rejected",
              `run=${frame.run_id} ${detail}`,
              now(),
            );
            authenticationState = "closed";
            socket.close(
              error instanceof DeviceRunCancellationError ? 1008 : 1011,
              "cancellation evidence rejected",
            );
          }
          return;
        }
        if (!deviceDispatchEnabled) {
          authenticationState = "closed";
          socket.close(1008, "device execution protocol is disabled");
          return;
        }
        if (!authedDevice || !options.deviceActionAuthorization || !options.phase4) {
          authenticationState = "closed";
          socket.close(1011, "device execution authorization is unavailable");
          return;
        }
        const deviceIdentity = authedDevice;
        const deviceActionAuthorization = options.deviceActionAuthorization;
        if (frame.type === "reconcile_request") {
          const body = ReconcileRequest.parse(frame.body);
          if (
            body.runner_id !== deviceIdentity.device_id ||
            body.generation !== deviceIdentity.generation
          ) {
            authenticationState = "closed";
            socket.close(1008, "device reconciliation identity changed");
            return;
          }
          try {
            await deviceActionAuthorization.transactions.transaction((sql) =>
              deviceActionAuthorization.service.lockTransportIdentity(sql, {
                subject: "device",
                runner_id: deviceIdentity.device_id,
                generation: deviceIdentity.generation,
                credential_id: deviceIdentity.credential_id,
              }),
            );
            const priorSocket = runnerSockets.get(deviceIdentity.device_id);
            if (priorSocket && priorSocket !== socket) {
              reconciledRunners.delete(deviceIdentity.device_id);
              priorSocket.close(1008, "superseded device connection");
            }
            runnerSockets.set(deviceIdentity.device_id, socket);
            reconciledRunners.set(deviceIdentity.device_id, {
              socket,
              generation: deviceIdentity.generation,
              workspacePicker: body.capabilities.includes("workspace_picker"),
              workspaceRepositoryInventory: body.capabilities.includes(
                "workspace_repository_inventory",
              ),
              workspaceClone: body.capabilities.includes("workspace_clone"),
            });
            const recentlyExecuted = new Set(body.recently_executed_command_ids);
            sendFrame(socket, {
              type: "reconcile_response",
              body: {
                protocol: PROTOCOL_VERSION as 1,
                ack_event_seq: stores.eventWatermark(deviceIdentity.device_id),
                generation: deviceIdentity.generation,
                capabilities: body.capabilities.includes("knowledge_transport")
                  ? (["knowledge_transport"] as const)
                  : [],
                resend_commands: [],
              },
            });
            await options.phase4.dispatch.deliverPendingForRunner(
              deviceIdentity.device_id,
              deviceIdentity.generation,
              recentlyExecuted,
              async (command) => {
                if (
                  runnerSockets.get(deviceIdentity.device_id) !== socket ||
                  reconciledRunners.get(deviceIdentity.device_id)?.socket !== socket
                ) {
                  throw new Error("device socket changed before pending command delivery");
                }
                sendFrame(socket, { type: "command", command: v2WireCommand(command) });
              },
            );
          } catch (error) {
            stores.audit(
              `device:${deviceIdentity.device_id}`,
              "device.reconcile_failed",
              error instanceof Error ? error.message : String(error),
              now(),
            );
            authenticationState = "closed";
            socket.close(1011, "device reconciliation failed");
          }
          return;
        }
        if (frame.type === "event") {
          const event: EventEnvelopeT = frame.event;
          if (
            !runnerEventIngressOpen ||
            runnerSockets.get(deviceIdentity.device_id) !== socket ||
            reconciledRunners.get(deviceIdentity.device_id)?.socket !== socket ||
            event.runner_id !== deviceIdentity.device_id ||
            event.generation !== deviceIdentity.generation
          ) {
            authenticationState = "closed";
            runnerEventIngressOpen = false;
            socket.close(1008, "device event identity changed");
            return;
          }
          runnerEventDelivery = runnerEventDelivery
            .then(async () => {
              const authenticatedIdentity = {
                subject: "device" as const,
                runner_id: deviceIdentity.device_id,
                generation: deviceIdentity.generation,
                credential_id: deviceIdentity.credential_id,
              };
              const actionAckHandled =
                (await conversationActionDelivery?.applyCommandAck(event, authenticatedIdentity)) ??
                false;
              if (!actionAckHandled) {
                await options.phase4?.events.apply(event, authenticatedIdentity);
              }
              stores.ingestEvent(event);
              sendFrame(socket, {
                type: "event_ack",
                ack_event_seq: stores.eventWatermark(deviceIdentity.device_id),
              });
            })
            .catch((error) => {
              runnerEventIngressOpen = false;
              stores.audit(
                `device:${deviceIdentity.device_id}`,
                "device.event_rejected",
                error instanceof Error ? error.message : String(error),
                now(),
              );
              authenticationState = "closed";
              socket.close(1008, "device event rejected");
            });
          return;
        }
        authenticationState = "closed";
        socket.close(1008, "unsupported device execution frame");
        return;
      }

      if (authenticationState !== "authenticated_legacy_runner" || !authedRunnerId) return;

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
          reconciledRunners.delete(authedRunnerId);
          priorSocket.close(1008, "superseded runner connection");
        }
        runnerSockets.set(authedRunnerId, socket);
        reconciledRunners.set(authedRunnerId, {
          socket,
          generation: runner.generation,
          workspacePicker: body.capabilities.includes("workspace_picker"),
          workspaceRepositoryInventory: body.capabilities.includes(
            "workspace_repository_inventory",
          ),
          workspaceClone: body.capabilities.includes("workspace_clone"),
        });
        stores.markSeen(authedRunnerId, now());
        stores.audit(`runner:${authedRunnerId}`, "runner.connected", "", now());
        broadcastLegacyRunnerCompatibility(
          {
            type: "runner_status",
            runner_id: authedRunnerId,
            connected: true,
          },
          { kind: "runner", runner_id: authedRunnerId },
        );
        const recentlyExecuted = new Set(body.recently_executed_command_ids);
        let durablePending: Awaited<
          ReturnType<NonNullable<typeof options.phase4>["dispatch"]["pendingForRunner"]>
        > = [];
        if (options.phase4) {
          try {
            durablePending = (
              await options.phase4.dispatch.pendingForRunner(authedRunnerId, runner.generation)
            ).filter((command) => !recentlyExecuted.has(command.command_id));
          } catch (error) {
            // Never acknowledge a successful reconcile while durable command
            // promotion/fetch is unknown. Closing makes the daemon reconnect
            // and retry the exact reconcile instead of idling forever.
            stores.audit(
              `runner:${authedRunnerId}`,
              "runner.reconcile_failed",
              error instanceof Error ? error.message : String(error),
              now(),
            );
            socket.close(1011, "reconcile persistence failed");
            return;
          }
        }
        const inMemoryPending = stores.pendingCommandsFor(authedRunnerId, recentlyExecuted, now());
        sendFrame(socket, {
          type: "reconcile_response",
          body: {
            protocol: PROTOCOL_VERSION as 1,
            ack_event_seq: stores.eventWatermark(authedRunnerId),
            generation: runner.generation,
            capabilities:
              options.phase4?.events && body.capabilities.includes("knowledge_transport")
                ? (["knowledge_transport"] as const)
                : [],
            resend_commands: inMemoryPending,
          },
        });
        for (const command of durablePending) {
          sendFrame(socket, { type: "command", command: v2WireCommand(command) });
        }
        // mark the resends delivered
        for (const cmd of inMemoryPending) {
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
        const reconciled = reconciledRunners.get(authedRunnerId);
        if (
          runnerSockets.get(authedRunnerId) === socket &&
          reconciled?.socket === socket &&
          reconciled.generation === frame.generation
        ) {
          workspaceBroker.receive(authedRunnerId, frame.generation, frame.response);
        }
        return;
      }

      // EXECUTION E3 — proxied model inference. The socket has already proved
      // this runner's identity; `authedRunnerId` is that proof and is the only
      // identity passed on. The frame's own fields are treated as claims.
      //
      // Answered inline and asynchronously: unlike events there is no ordering
      // requirement between calls, and serialising them behind the event chain
      // would make one slow provider call stall the run's event stream.
      if (frame.type === "inference_request") {
        const requestingRunnerId = authedRunnerId;
        const reconciled = reconciledRunners.get(requestingRunnerId);
        const respond = (response: RunnerInferenceResponseT): void => {
          // Only answer on the socket that asked, and only while it is still
          // the current one — a superseded connection must not receive a
          // completion the project paid for.
          if (runnerSockets.get(requestingRunnerId) === socket) {
            sendFrame(socket, {
              type: "inference_response",
              generation: frame.generation,
              response,
            });
          }
        };
        if (!inferenceProxy) {
          respond({
            request_id: frame.request.request_id,
            status: "error",
            code: "unsupported",
            message: "model proxying is not enabled on this deployment",
          });
          return;
        }
        if (runnerSockets.get(requestingRunnerId) !== socket || reconciled?.socket !== socket) {
          respond({
            request_id: frame.request.request_id,
            status: "error",
            code: "unauthorized",
            message: "not authorized for this run",
          });
          return;
        }
        void inferenceProxy
          .handle(frame.request, requestingRunnerId, frame.generation, runner.generation)
          .then(respond)
          .catch(() => {
            // The proxy is written not to throw; if it ever does, the runner
            // still gets an answer rather than blocking until its timeout.
            respond({
              request_id: frame.request.request_id,
              status: "error",
              code: "provider_error",
              message: "inference failed",
            });
          });
        return;
      }

      if (frame.type === "event") {
        const event: EventEnvelopeT = frame.event;
        const authenticatedRunnerId = authedRunnerId;
        if (!runnerEventIngressOpen) return;

        // Fence synchronously before adding work to the promise chain. An old
        // daemon used to replay tens of thousands of stale events at once;
        // discovering the stale socket asynchronously queued every frame and
        // audited every rejection before close could take effect.
        const currentRunner = stores.runner(authenticatedRunnerId);
        const reconciled = reconciledRunners.get(authenticatedRunnerId);
        if (
          runnerSockets.get(authenticatedRunnerId) !== socket ||
          reconciled?.socket !== socket ||
          event.runner_id !== authenticatedRunnerId ||
          !currentRunner ||
          reconciled.generation !== currentRunner.generation ||
          event.generation !== reconciled.generation
        ) {
          rejectRunnerEvents(
            authenticatedRunnerId,
            "event did not match the current reconciled runner generation",
            { fencedGeneration: currentRunner?.generation ?? event.generation + 1 },
          );
          return;
        }

        runnerEventDelivery = runnerEventDelivery
          .then(async () => {
            if (!runnerEventIngressOpen) return;
            const currentRunner = stores.runner(authenticatedRunnerId);
            const reconciled = reconciledRunners.get(authenticatedRunnerId);
            if (
              runnerSockets.get(authenticatedRunnerId) !== socket ||
              reconciled?.socket !== socket ||
              event.runner_id !== authenticatedRunnerId ||
              !currentRunner ||
              reconciled.generation !== currentRunner.generation ||
              event.generation !== reconciled.generation
            ) {
              rejectRunnerEvents(
                authenticatedRunnerId,
                "event did not match the current reconciled runner generation",
                { fencedGeneration: currentRunner?.generation ?? event.generation + 1 },
              );
              return;
            }
            const authenticatedIdentity = {
              subject: "legacy_runner" as const,
              runner_id: authenticatedRunnerId,
              generation: event.generation,
            };
            const actionAckHandled =
              (await conversationActionDelivery?.applyCommandAck(event, authenticatedIdentity)) ??
              false;
            if (!actionAckHandled) {
              await options.phase4?.events.apply(event, authenticatedIdentity);
            }
            const outcome = stores.ingestEvent(event);
            if (outcome === "accepted") applyEventSideEffects(event);
            sendFrame(socket, {
              type: "event_ack",
              ack_event_seq: stores.eventWatermark(event.runner_id),
            });
          })
          .catch((error) => {
            rejectRunnerEvents(
              authenticatedRunnerId,
              error instanceof Error ? error.message : String(error),
            );
          });
        return;
      }
    });

    socket.on("close", () => {
      authenticationState = "closed";
      if (authedDevice) {
        if (runnerSockets.get(authedDevice.device_id) === socket) {
          runnerSockets.delete(authedDevice.device_id);
          reconciledRunners.delete(authedDevice.device_id);
          workspaceBroker.disconnect(authedDevice.device_id);
        }
        disconnectDeviceControl?.();
        disconnectDeviceControl = null;
        void options.deviceBrowserDelivery
          ?.deliverOwnerAvailability(
            {
              device_id: authedDevice.device_id,
              availability: "offline",
              observed_at: now().toISOString(),
            },
            scopedDeviceBrowserSessions(),
          )
          .catch(() => {
            // Connection cleanup must complete even if browser delivery fails.
          });
        stores.audit(`device:${authedDevice.device_id}`, "device.wss_disconnected", "", now());
        authedDevice = null;
      }
      if (authedRunnerId && runnerSockets.get(authedRunnerId) === socket) {
        runnerSockets.delete(authedRunnerId);
        reconciledRunners.delete(authedRunnerId);
        workspaceBroker.disconnect(authedRunnerId);
        stores.audit(`runner:${authedRunnerId}`, "runner.disconnected", "", now());
        broadcastLegacyRunnerCompatibility(
          {
            type: "runner_status",
            runner_id: authedRunnerId,
            connected: false,
          },
          { kind: "runner", runner_id: authedRunnerId },
        );
      }
    });
  });

  const applyEventSideEffects = (event: EventEnvelopeT): void => {
    stores.markSeen(event.runner_id, now());
    const payload = event.payload;
    if (payload.kind === "command_ack") {
      stores.setCommandState(payload.command_id, payload.state as CommandStateT, now());
      const command = stores.command(payload.command_id);
      stores.audit(
        `runner:${event.runner_id}`,
        "command.ack",
        `${payload.command_id} -> ${payload.state}`,
        now(),
      );
      broadcastLegacyRunnerCompatibility(
        {
          type: "command_state",
          command_id: payload.command_id,
          state: payload.state,
        },
        {
          kind: "command",
          command_id: payload.command_id,
          runner_id: event.runner_id,
          ...(command === undefined ? {} : { project_id: command.envelope.project_id }),
        },
      );
    } else if (payload.kind === "run_log") {
      broadcastLegacyRunnerCompatibility(
        {
          type: "log",
          runner_id: event.runner_id,
          run_id: payload.run_id,
          chunk: payload.chunk,
        },
        { kind: "run", runner_id: event.runner_id, run_id: payload.run_id },
      );
    } else if (payload.kind === "run_status") {
      stores.audit(
        `runner:${event.runner_id}`,
        "run.status",
        `${payload.run_id} ${payload.status}`,
        now(),
      );
      broadcastLegacyRunnerCompatibility(
        {
          type: "run_status",
          runner_id: event.runner_id,
          run_id: payload.run_id,
          status: payload.status,
        },
        { kind: "run", runner_id: event.runner_id, run_id: payload.run_id },
      );
    }
    // heartbeat: markSeen above is the whole effect
  };

  // ---- session websocket -----------------------------------------------------------

  app.get("/ws/session", { websocket: true }, (conn) => {
    const socket = asSocket(conn);
    let authState: "awaiting" | "authenticating" | "authenticated" | "closed" = "awaiting";
    const authenticationClosed = (): boolean => authState === "closed";
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
        .then(async (user) => {
          if (authenticationClosed()) return;
          if (!user || user.status !== "active") {
            authState = "closed";
            clearTimeout(authTimeout);
            socket.close(1008, "unauthorized");
            return;
          }
          const runners = await legacyRunnerCompatibilitySnapshot(user.id);
          if (authenticationClosed()) return;
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
                // Historical runner visibility remains isolated behind this
                // explicitly named compatibility projection. Devices never
                // enter it.
                runners,
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

  if (options.knowledge) {
    registerKnowledgeRoutes(app, {
      service: options.knowledge.service,
      clock: now,
      requireSession,
      requireAdmin,
      resolveUser,
    });
  }

  // ---- Phase 6 immutable mockups and evidence bytes -------------------------
  if (phase6Mockups) {
    const artifactService = phase6Mockups.artifactService();
    const ArtifactUploadEnvelope = z
      .object({
        metadata: V2MockupArtifactUploadInput,
        content_base64: z.string().min(1),
        label: z.string().trim().min(1).max(500),
      })
      .strict();
    const phase6Error = (reply: FastifyReply, error: unknown): void => {
      if (error instanceof z.ZodError) {
        reply.code(400).send({ error: "bad_request", issues: error.issues });
        return;
      }
      if (error instanceof Phase6ArtifactError) {
        const status =
          error.code === "artifact_not_found"
            ? 404
            : error.code === "unsupported_media_type"
              ? 415
              : error.code === "project_quota" || error.code === "idempotency_conflict"
                ? 409
                : 400;
        reply.code(status).send({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof Phase6MockupError) {
        const status = error.code === "mockup_not_found" ? 404 : 409;
        reply.code(status).send({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof Phase6DeploymentError) {
        reply
          .code(error.code === "deployment_not_found" ? 404 : 409)
          .send({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof HealthProbeError) {
        reply.code(422).send({ error: error.code, message: error.message });
        return;
      }
      throw error;
    };

    app.post(
      "/api/v2/projects/:projectId/artifacts",
      { bodyLimit: 16 * 1024 * 1024 },
      async (request, reply) => {
        const user = await requireSessionUser(request, reply);
        if (!user) return;
        const { projectId } = request.params as { projectId: string };
        try {
          let metadata: z.infer<typeof V2MockupArtifactUploadInput>;
          let content: Buffer;
          let label: string;
          if (Buffer.isBuffer(request.body)) {
            const header = (name: string): string => {
              const value = request.headers[name];
              if (typeof value !== "string" || value.trim().length === 0) {
                throw new Phase6ArtifactError("invalid_content", `missing ${name} header`);
              }
              return value.trim();
            };
            content = request.body;
            label = header("x-norns-artifact-label").slice(0, 500);
            metadata = V2MockupArtifactUploadInput.parse({
              project_id: projectId,
              work_item_id: header("x-norns-work-item-id"),
              conversation_id: header("x-norns-conversation-id"),
              media_type: String(request.headers["content-type"] ?? "").split(";")[0],
              purpose: header("x-norns-artifact-purpose"),
              content_hash: header("x-norns-content-sha256"),
              byte_size: content.byteLength,
              idempotency_key: header("x-idempotency-key"),
            });
          } else {
            const envelope = ArtifactUploadEnvelope.parse(request.body);
            if (envelope.metadata.project_id !== projectId) {
              return reply.code(409).send({ error: "project_scope_mismatch" });
            }
            metadata = envelope.metadata;
            content = Buffer.from(envelope.content_base64, "base64");
            label = envelope.label;
          }
          const storedArtifact = await artifactService.put({
            metadata,
            content,
            label,
            provenance: { actor_type: "human", actor_id: user.id },
          });
          if (!storedArtifact.replayed) {
            stores.audit(
              user.email,
              "phase6.artifact.created",
              `${projectId}:${storedArtifact.id}`,
              now(),
            );
          }
          return reply.code(201).send(storedArtifact);
        } catch (error) {
          phase6Error(reply, error);
        }
      },
    );

    app.get("/api/v2/projects/:projectId/artifacts/:artifactId/content", async (request, reply) => {
      if (!(await requireSession(request, reply))) return;
      const { projectId, artifactId } = request.params as {
        projectId: string;
        artifactId: string;
      };
      try {
        const artifact = await artifactService.content(projectId, artifactId);
        return reply
          .header("Content-Type", artifact.media_type)
          .header("Content-Length", String(artifact.byte_size))
          .header("Cache-Control", "private, max-age=31536000, immutable")
          .header(
            "Content-Disposition",
            artifact.media_type === "image/png" ? "inline" : "attachment",
          )
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Security-Policy", "default-src 'none'; sandbox")
          .header("ETag", `"sha256:${artifact.content_hash}"`)
          .send(artifact.bytes);
      } catch (error) {
        phase6Error(reply, error);
      }
    });

    const listMockups = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!(await requireSession(request, reply))) return;
      const { projectId, workItemId, conversationId } = request.params as {
        projectId: string;
        workItemId?: string;
        conversationId: string;
      };
      try {
        const mockups = await phase6Mockups.list(projectId, conversationId);
        if (workItemId && mockups.some((mockup) => mockup.work_item_id !== workItemId)) {
          return reply.code(404).send({ error: "conversation_not_found" });
        }
        return reply.header("Cache-Control", "no-store").send({ mockups });
      } catch (error) {
        phase6Error(reply, error);
      }
    };
    app.get("/api/v2/projects/:projectId/conversations/:conversationId/mockups", listMockups);
    app.get(
      "/api/v2/projects/:projectId/work-items/:workItemId/conversations/:conversationId/mockups",
      listMockups,
    );
    app.get(
      "/api/v2/projects/:projectId/work-items/:workItemId/conversations/:conversationId/mockups/:mockupVersionId",
      async (request, reply) => {
        if (!(await requireSession(request, reply))) return;
        const { projectId, workItemId, conversationId, mockupVersionId } = request.params as {
          projectId: string;
          workItemId: string;
          conversationId: string;
          mockupVersionId: string;
        };
        try {
          const mockup = await phase6Mockups.version(projectId, conversationId, mockupVersionId);
          if (mockup.work_item_id !== workItemId) {
            return reply.code(404).send({ error: "mockup_not_found" });
          }
          return reply.header("Cache-Control", "no-store").send(mockup);
        } catch (error) {
          phase6Error(reply, error);
        }
      },
    );

    if (phase6Deployments) {
      app.post("/api/v2/projects/:projectId/deployments", async (request, reply) => {
        const user = await requireSessionUser(request, reply);
        if (!user) return;
        const { projectId } = request.params as { projectId: string };
        try {
          const parsed = CreateDeploymentInput.parse({
            ...(request.body as Record<string, unknown>),
            project_id: projectId,
            source_id: user.id,
          });
          const result = await phase6Deployments.createWithReplay(parsed);
          if (!result.replayed) {
            stores.audit(
              user.email,
              "phase6.deployment.observed",
              `${projectId}:${result.deployment.id}:pending`,
              now(),
            );
          }
          return reply.code(result.replayed ? 200 : 201).send(result.deployment);
        } catch (error) {
          phase6Error(reply, error);
        }
      });

      app.post(
        "/api/v2/projects/:projectId/deployments/:deploymentId/observations",
        async (request, reply) => {
          const user = await requireSessionUser(request, reply);
          if (!user) return;
          const { projectId, deploymentId } = request.params as {
            projectId: string;
            deploymentId: string;
          };
          try {
            const input = RecordHumanDeploymentObservationInput.parse({
              ...(request.body as Record<string, unknown>),
              project_id: projectId,
              delivery_record_id: deploymentId,
            });
            const replay = await phase6Deployments.replayHumanObservation(input, user.id);
            if (replay) return reply.code(200).send(replay);
            if (input.status === "succeeded" && input.health_url) {
              const probe = await probePublicHttpsUrl(input.health_url);
              if (
                probe.status_code !== input.health_status_code ||
                probe.status_code < 200 ||
                probe.status_code >= 400
              ) {
                return reply.code(409).send({
                  error: "health_observation_mismatch",
                  observed_status_code: probe.status_code,
                });
              }
            }
            const result = await phase6Deployments.recordHumanObservation(input, user.id);
            if (!result.replayed) {
              stores.audit(
                user.email,
                "phase6.deployment.human_observed",
                `${projectId}:${deploymentId}:${result.observation.sequence}`,
                now(),
              );
            }
            return reply.code(result.replayed ? 200 : 201).send(result);
          } catch (error) {
            phase6Error(reply, error);
          }
        },
      );

      app.post("/api/integrations/deployments/observations", async (request, reply) => {
        let input: z.infer<typeof V2RecordProjectDeploymentObservationInput>;
        try {
          input = V2RecordProjectDeploymentObservationInput.parse(request.body);
        } catch (error) {
          phase6Error(reply, error);
          return;
        }
        const authorization = request.headers.authorization;
        const presented = bearerToken(authorization);
        let configured: unknown = {};
        try {
          configured = JSON.parse(
            integrationEnvironment.NORNS_DEPLOYMENT_PROVIDER_TOKENS_JSON ?? "{}",
          );
        } catch {
          configured = {};
        }
        const expected =
          configured &&
          typeof configured === "object" &&
          !Array.isArray(configured) &&
          typeof (configured as Record<string, unknown>)[input.provider_id] === "string"
            ? String((configured as Record<string, unknown>)[input.provider_id])
            : null;
        const authenticated =
          presented !== null &&
          expected !== null &&
          presented.length === expected.length &&
          timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
        if (!authenticated) {
          stores.audit(
            `provider:${input.provider_id}`,
            "phase6.deployment.provider_auth_failed",
            input.delivery_record_id,
            now(),
          );
          return reply.code(401).send({ error: "unauthorized" });
        }
        try {
          const replay = await phase6Deployments.replayProviderObservation(input);
          if (replay) return reply.code(200).send(replay);
          if (input.status === "succeeded" && input.health_url) {
            const probe = await probePublicHttpsUrl(input.health_url);
            if (
              probe.status_code !== input.health_status_code ||
              probe.status_code < 200 ||
              probe.status_code >= 400
            ) {
              return reply.code(409).send({
                error: "health_observation_mismatch",
                observed_status_code: probe.status_code,
              });
            }
          }
          const result = await phase6Deployments.recordProviderObservation(input);
          if (!result.replayed) {
            stores.audit(
              `provider:${input.provider_id}`,
              "phase6.deployment.provider_observed",
              `${input.project_id}:${input.delivery_record_id}:${result.observation.sequence}`,
              now(),
            );
          }
          return reply.code(result.replayed ? 200 : 201).send(result);
        } catch (error) {
          phase6Error(reply, error);
        }
      });

      app.get("/api/v2/projects/:projectId/deployments", async (request, reply) => {
        if (!(await requireSession(request, reply))) return;
        const { projectId } = request.params as { projectId: string };
        try {
          return reply
            .header("Cache-Control", "no-store")
            .send({ deployments: await phase6Deployments.list(projectId) });
        } catch (error) {
          phase6Error(reply, error);
        }
      });

      app.get(
        "/api/v2/projects/:projectId/deployments/:deploymentId/observations",
        async (request, reply) => {
          if (!(await requireSession(request, reply))) return;
          const { projectId, deploymentId } = request.params as {
            projectId: string;
            deploymentId: string;
          };
          try {
            return reply.header("Cache-Control", "no-store").send({
              observations: await phase6Deployments.observations(projectId, deploymentId),
            });
          } catch (error) {
            phase6Error(reply, error);
          }
        },
      );

      app.post("/api/v2/projects/:projectId/deployments/health-probe", async (request, reply) => {
        if (!(await requireSession(request, reply))) return;
        try {
          const body = z.object({ url: z.string().url() }).strict().parse(request.body);
          return reply
            .header("Cache-Control", "no-store")
            .send(await probePublicHttpsUrl(body.url));
        } catch (error) {
          phase6Error(reply, error);
        }
      });
    }

    if (phase6Dashboard) {
      app.get("/api/v2/projects/:projectId/dashboard", async (request, reply) => {
        if (!(await requireSession(request, reply))) return;
        const { projectId } = request.params as { projectId: string };
        return reply
          .header("Cache-Control", "no-store")
          .send(await phase6Dashboard.read(projectId));
      });
    }
  }

  if (phase6VisualEvidence) {
    app.get(
      "/api/v2/projects/:projectId/work-items/:workItemId/conversations/:conversationId/visual-evidence/:visualEvidenceId",
      async (request, reply) => {
        if (!(await requireSession(request, reply))) return;
        const { projectId, workItemId, conversationId, visualEvidenceId } = request.params as {
          projectId: string;
          workItemId: string;
          conversationId: string;
          visualEvidenceId: string;
        };
        try {
          return reply
            .header("Cache-Control", "no-store")
            .send(
              await phase6VisualEvidence.getForConversation(
                projectId,
                workItemId,
                conversationId,
                visualEvidenceId,
              ),
            );
        } catch (error) {
          if (error instanceof Phase6VisualEvidenceError) {
            return reply
              .code(error.code === "evidence_not_found" ? 404 : 409)
              .send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );
    const base64 = z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.length % 4 === 0 &&
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
        "invalid base64",
      );
    const RunnerVisualEvidenceEnvelope = z
      .object({
        work_item_id: z.string().trim().min(1),
        conversation_id: z.string().trim().min(1),
        phase_id: z.string().trim().min(1),
        task_id: z.string().trim().min(1),
        run_id: z.string().trim().min(1),
        approved_mockup_version_id: z.string().trim().min(1),
        repository_binding_id: z.string().trim().min(1),
        verification_result_id: z.string().trim().min(1),
        deployment_record_id: z.string().trim().min(1),
        deployment_observation_id: z.string().trim().min(1),
        commit_sha: z.string().regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/),
        capture_profile: V2ImplementationCaptureProfile,
        verified_at: z.string().datetime(),
        desktop_png_base64: base64,
        mobile_png_base64: base64,
      })
      .strict();
    app.post(
      "/api/runner/v2/projects/:projectId/visual-evidence",
      {
        bodyLimit: 30 * 1024 * 1024,
        preParsing: captureRunnerHttpBodySha256,
      },
      async (request, reply) => {
        const auth = await runnerHttpAuthentication.authenticate({
          purpose: DEVICE_VISUAL_EVIDENCE_UPLOAD_HTTP_SIGNATURE_PURPOSE,
          method: request.method,
          path_and_query: request.url,
          routed_path: `/api/runner/v2/projects/${routedDeviceHttpPathSegment(
            (request.params as { projectId: string }).projectId,
          )}/visual-evidence`,
          body_sha256: capturedRunnerHttpBodySha256(request),
          headers: request.headers as Record<string, string | string[] | undefined>,
        });
        if (!auth.ok) {
          stores.audit(
            `runner:${
              request.headers[DEVICE_HTTP_DEVICE_ID_HEADER] ??
              request.headers["x-norns-runner-id"] ??
              "unknown"
            }`,
            "phase6.visual_evidence.auth_failed",
            auth.reason,
            now(),
          );
          return reply.code(401).send({ error: "unauthorized" });
        }
        const subjectId = auth.identity.authorization_subject_id;
        const { projectId } = request.params as { projectId: string };
        try {
          const body = RunnerVisualEvidenceEnvelope.parse(request.body);
          const evidenceInput = {
            project_id: projectId,
            work_item_id: body.work_item_id,
            conversation_id: body.conversation_id,
            phase_id: body.phase_id,
            task_id: body.task_id,
            run_id: body.run_id,
            approved_mockup_version_id: body.approved_mockup_version_id,
            repository_binding_id: body.repository_binding_id,
            verification_result_id: body.verification_result_id,
            deployment_record_id: body.deployment_record_id,
            deployment_observation_id: body.deployment_observation_id,
            commit_sha: body.commit_sha,
            capture_profile: body.capture_profile,
            verified_at: body.verified_at,
            runner_id: subjectId,
            runner_generation: auth.identity.generation,
            desktop_png: Buffer.from(body.desktop_png_base64, "base64"),
            mobile_png: Buffer.from(body.mobile_png_base64, "base64"),
          };
          let result: Awaited<ReturnType<typeof phase6VisualEvidence.recordWithReplay>>;
          if (auth.identity.kind === "device") {
            const deviceIdentity = auth.identity;
            const authorization = options.deviceActionAuthorization;
            if (!authorization) {
              throw new DeviceActionAuthorizationError("device_run_unauthorized");
            }
            result = await authorization.transactions.transaction(async (sql) => {
              await authorization.service.assertRun(sql, {
                subject: "device",
                runner_id: deviceIdentity.device_id,
                generation: deviceIdentity.generation,
                credential_id: deviceIdentity.credential_id,
                run_id: body.run_id,
                project_id: projectId,
                repository_binding_id: body.repository_binding_id,
              });
              return phase6VisualEvidence.recordWithReplayInTransaction(sql, evidenceInput);
            });
          } else if (options.deviceActionAuthorization) {
            const legacyIdentity = auth.identity;
            result = await options.deviceActionAuthorization.transactions.transaction(
              async (sql) => {
                await options.deviceActionAuthorization?.service.assertRun(sql, {
                  subject: "legacy_runner",
                  runner_id: legacyIdentity.runner_id,
                  generation: legacyIdentity.generation,
                  run_id: body.run_id,
                  project_id: projectId,
                  repository_binding_id: body.repository_binding_id,
                });
                return phase6VisualEvidence.recordWithReplayInTransaction(sql, evidenceInput);
              },
            );
          } else {
            result = await phase6VisualEvidence.recordWithReplay(evidenceInput);
          }
          if (!result.replayed) {
            stores.audit(
              `runner:${subjectId}`,
              "phase6.visual_evidence.recorded",
              `${projectId}:${result.evidence.id}`,
              now(),
            );
          }
          return reply.code(result.replayed ? 200 : 201).send(result.evidence);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return reply.code(400).send({ error: "bad_request", issues: error.issues });
          }
          if (error instanceof DeviceActionAuthorizationError) {
            stores.audit(
              `runner:${subjectId}`,
              "phase6.visual_evidence.auth_failed",
              error.code,
              now(),
            );
            return reply.code(403).send({ error: "forbidden" });
          }
          if (error instanceof Phase6VisualEvidenceError) {
            return reply
              .code(error.code === "evidence_not_found" ? 404 : 409)
              .send({ error: error.code, message: error.message });
          }
          if (error instanceof Phase6ArtifactError) {
            return reply
              .code(error.code === "project_quota" ? 409 : 400)
              .send({ error: error.code, message: error.message });
          }
          throw error;
        }
      },
    );
  }

  return {
    app,
    stores,
    connectedRunners: () => [...runnerSockets.keys()],
    ...(taskContextAssembler ? { taskContext: taskContextAssembler } : {}),
  };
}
