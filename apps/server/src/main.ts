// Dev entrypoint: relay + graph API on :8787, plus a self-contained DEMO
// dashboard. The demo is a hardcoded scripted walkthrough (its own engine
// driven through a few gates) that exists purely to illustrate what a fully-
// populated PM Dashboard looks like before live execution exists for real
// projects (NORN-027b). It is exposed at GET /api/demo/dashboard and is wholly
// separate from the real, user-created projects in `ProjectStore` — no real
// project's data ever flows into it, and none of its state ever flows back.
import {
  AnthropicAdapter,
  OpenAiAdapter,
  type ProviderName,
  buildSelectableModelCatalog,
  modelAvailabilityFromDebateEnvironment,
  quoteConservativeMaxCharge,
} from "@norns/adapters";
import { UsageEvent } from "@norns/contracts";
// ONBOARDING O4: Actions-hosted execution.
import {
  ActionsEnrollmentService,
  ActionsExecutionCoordinator,
  ActionsExecutionRepository,
} from "./coordinator/actionsExecution.js";
// PHASE TAB P4: the approve-in-Phase-tab execution kickoff drives the real
// launch chain, so main.ts constructs a PhaseLaunchService the same way the
// start-phase route path inside buildServer does.
import { DispatchContextScopeRepository } from "./coordinator/dispatchContextScope.js";
import { Phase4CompletionService } from "./coordinator/phase4Completion.js";
import { Phase4Coordinator } from "./coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository } from "./coordinator/phase4Dispatcher.js";
import { Phase4EventProcessor } from "./coordinator/phase4EventProcessor.js";
import { Phase4RecoveryMonitor } from "./coordinator/phase4RecoveryMonitor.js";
import { Phase6CoordinationService } from "./coordinator/phase6Coordination.js";
import { PhaseLaunchService } from "./coordinator/phaseLaunchService.js";
import { buildDashboard } from "./dashboard.js";
import { DebateService } from "./debates/service.js";
import { DebateWorker } from "./debates/worker.js";
import { BudgetLedger } from "./engine/budget.js";
import { WorkflowEngine } from "./engine/workflow.js";
import { RelationalTaskContextAssembler, TaskContextStore } from "./execution/index.js";
import { GraphSession } from "./graph/session.js";
import {
  GitHubIntegrationService,
  githubIntegrationConfigFromEnvironment,
} from "./integrations/github.js";
// ONBOARDING O4: Actions-hosted execution.
import { GitHubActionsService } from "./integrations/githubActions.js";
import {
  defaultRunnerTarballDir,
  formatRunnerTarballSpec,
  loadRunnerTarball,
} from "./integrations/runnerDistribution.js";
import { Phase7OperationsService } from "./operations/phase7Operations.js";
import {
  Phase2ApplicationPersistenceLease,
  Phase2PersistenceLeaseUnavailableError,
} from "./persistence/migration/migrationLock.js";
import { PgPersistence, SnapshotFlusher } from "./persistence/pg.js";
import {
  PostgresConnectionConfigurationError,
  assertRestrictedRuntimeDatabase,
  postgresPoolConfig,
} from "./persistence/postgresConnection.js";
import { NodePgTransactionRunner, type V2TransactionRunner } from "./persistence/v2/database.js";
import { ExecutionKickoffService } from "./planning/executionKickoff.js";
import type { ApprovedPlanExecutionKickoff } from "./planning/runService.js";
import { AttentionService } from "./projects/attentionService.js";
import { PhaseWorkflowService } from "./projects/phaseWorkflowService.js";
import { ProjectResumeService } from "./projects/projectResumeService.js";
// POLISH P3 — the "Analyze the repository" producer behind the resume
// payload's next-step recommendation.
import { RepositoryAnalysisService } from "./projects/repositoryAnalysisService.js";
import { RepositoryIngestionService } from "./projects/repositoryIngestionService.js";
import { SourceBindingService } from "./projects/sourceBindingService.js";
import { ProjectStore } from "./projects/store.js";
import { StrategyBridgeService } from "./projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "./projects/strategyWorkflowService.js";
import { buildServer } from "./server.js";
import { evaluateAuthStartup } from "./startup/authPolicy.js";
import {
  IdentityRuntimeConfigurationError,
  assertCredentialHmacKeyCoverage,
  createIdentityRuntime,
  loadDurableIdentityRoute,
  parseOptionalCredentialHmacKeyring,
} from "./startup/identityRuntime.js";
import {
  ProjectRuntimeConfigurationError,
  createProjectRuntime,
  loadDurableProjectRoutes,
} from "./startup/projectRuntime.js";
import { RelayStores } from "./stores.js";
import { UserStore } from "./users/store.js";

// The scripted demo walkthrough that drives the DEMO dashboard's example view
// (GET /api/demo/dashboard) — deliberately NOT a real project. It never enters
// `ProjectStore`, is never persisted, and is recreated fresh every boot. Do not
// wire a real project through this; real dashboards must read ProjectStore.
const demoSession = GraphSession.demo();

// Multi-project management: the sole point of entry — create, list, plan,
// and edit real projects. Empty until you create your first one.
const projects = new ProjectStore();

// Real user accounts — replaces the shared deploy token as the day-to-day
// login mechanism. Empty until the first admin is bootstrapped (or, in dev,
// auto-seeded below).
const users = new UserStore();
let identityRuntime = createIdentityRuntime({
  users,
  route: null,
  environment: process.env,
});
let projectRuntime = createProjectRuntime({
  projects,
  routes: { new_projects: null, projects: new Map() },
});
const isProd = process.env.NODE_ENV === "production";

// Tier-2 persistence: when DATABASE_URL is set (Railway Postgres plugin),
// hydrate relay state from the last snapshot and flush changes back durably.
// Development can still run in memory. Production identity state must never
// degrade to an empty in-memory store: doing so would make an existing admin
// disappear and incorrectly reopen first-time setup after a restart.
const databaseUrl = process.env.DATABASE_URL;
let stores = new RelayStores();
const flushers: SnapshotFlusher[] = [];
let usersFlusher: SnapshotFlusher | undefined;
let persistenceReady = false;
let persistenceLease: Phase2ApplicationPersistenceLease | undefined;
let databasePool: import("pg").Pool | undefined;
let phase3Services:
  | {
      sourceBindings: SourceBindingService;
      ingestion: RepositoryIngestionService;
      phases: PhaseWorkflowService;
      strategies: StrategyWorkflowService;
      bridge: StrategyBridgeService;
      resume: ProjectResumeService;
    }
  | undefined;
let phase4Services:
  | {
      coordinator: Phase4Coordinator;
      completion: Phase4CompletionService;
      dispatch: Phase4DispatchRepository;
      events: Phase4EventProcessor;
      recovery: Phase4RecoveryMonitor;
    }
  | undefined;
// ONBOARDING O4: Actions-hosted execution services.
let actionsExecutionServices:
  | {
      coordinator: ActionsExecutionCoordinator;
      enrollment: ActionsEnrollmentService;
      repository: ActionsExecutionRepository;
    }
  | undefined;
// POLISH P3 — the analyze-repository step. Absent without the relational
// runtime, exactly like phase3Services; the route then refuses honestly.
let repositoryAnalysisService: RepositoryAnalysisService | undefined;
let phase5Services: { attention: AttentionService } | undefined;
let phase6Services: { coordination: Phase6CoordinationService } | undefined;
let phase7Services: { operations: Phase7OperationsService } | undefined;
let debateService: DebateService | undefined;
let debateWorkerTimer: NodeJS.Timeout | undefined;
let integrationServices: { github: GitHubIntegrationService | null } | undefined;
// FRONT DOOR P2 §D1: observable planning runs need the relational runtime.
// PHASE TAB P4: `executionKickoff` is the real approve-auto-starts-execution
// implementation — without it the decision route records approvals but always
// reports `execution: null`.
let planningRunsOptions:
  | { transactions: V2TransactionRunner; executionKickoff?: ApprovedPlanExecutionKickoff }
  | undefined;
// FRONT DOOR P4 (D3): image attachments need the same relational runtime.
let attachmentsOptions: { transactions: V2TransactionRunner } | undefined;
// ONBOARDING O2: the two GitHub-backed project-creation scenarios, over the
// same relational runtime.
let onboardingOptions: { transactions: V2TransactionRunner } | undefined;
// EXECUTION E1/E2: task-context assembly, its fetch route, and the
// start-phase trigger all need the relational runtime. `buildServer` shipped
// this option in EXECUTION E1 but nothing here ever passed it, leaving the
// assembler permanently inert in production -- the same failure mode that
// shipped an unwired attachments service and a dead onboarding route in
// earlier programs. `baseUrl` must be the deployment's public origin: the
// constructor throws on anything other than HTTPS (or http on localhost),
// so a misconfiguration fails at boot, not silently at runner-fetch time.
let executionOptions: { transactions: V2TransactionRunner; baseUrl?: string } | undefined;
// EXECUTION E10 (E9-10, = E3-10): the relational runtime behind BOTH the E3
// completion proxy and E9's provider-native model gateway. Both previously
// reached for `planningRuns ?? onboarding ?? attachments` inside buildServer --
// working only by the accident that production wires all three from this same
// runner, and one config change away from silently disabling runner inference.
let runnerInferenceOptions: { transactions: V2TransactionRunner } | undefined;

const publicOrigin =
  process.env.NORNS_PUBLIC_ORIGIN ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "http://127.0.0.1:5173");

if (databaseUrl) {
  try {
    const { Pool } = await import("pg");
    const pool = new Pool(postgresPoolConfig(databaseUrl));
    databasePool = pool;
    await assertRestrictedRuntimeDatabase(pool, process.env);
    persistenceLease = await Phase2ApplicationPersistenceLease.acquire(pool);
    const persistence = new PgPersistence({
      query: (sql, params) => pool.query(sql, params as unknown[]),
    });
    await persistence.init();
    const identityRoute = await loadDurableIdentityRoute({
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await pool.query(sql, params);
        return { rows: result.rows as TRow[] };
      },
    });
    const runtimeTransactions = new NodePgTransactionRunner(pool, {
      mode: "runtime",
      role: "norns_app",
    });
    // GitHub manifest credentials are durable PostgreSQL data and may be used
    // before identity routing completes its relational cutover. Coupling this
    // keyring to the identity route incorrectly disabled guided GitHub setup
    // on otherwise fully configured deployments.
    const credentialKeyring = parseOptionalCredentialHmacKeyring(process.env);
    const githubConfig = githubIntegrationConfigFromEnvironment(process.env, publicOrigin);
    const githubManifestBootstrap = credentialKeyring
      ? {
          publicOrigin,
          currentKey: {
            keyId: credentialKeyring.current.keyId,
            key: credentialKeyring.current.key,
          },
          keys: new Map(
            [...credentialKeyring.byId].map(([keyId, key]) => [
              keyId,
              { keyId: key.keyId, key: key.key },
            ]),
          ),
        }
      : null;
    const github =
      githubConfig || githubManifestBootstrap
        ? new GitHubIntegrationService(
            runtimeTransactions,
            githubConfig,
            fetch,
            githubManifestBootstrap,
          )
        : null;
    await github?.loadStoredConfiguration();
    integrationServices = {
      github,
    };
    const phaseWorkflow = new PhaseWorkflowService(runtimeTransactions);
    const strategyWorkflow = new StrategyWorkflowService(runtimeTransactions);
    phase3Services = {
      sourceBindings: new SourceBindingService(runtimeTransactions),
      ingestion: new RepositoryIngestionService(runtimeTransactions),
      phases: phaseWorkflow,
      strategies: strategyWorkflow,
      // FRONT DOOR P3: bridges a completed planning run into a proposed
      // StrategyVersion via the two workflow services above.
      bridge: new StrategyBridgeService({
        transactions: runtimeTransactions,
        phases: phaseWorkflow,
        strategies: strategyWorkflow,
      }),
      resume: new ProjectResumeService(runtimeTransactions),
    };
    // POLISH P3 — the analyze-repository step. `github` may be null (the
    // service then refuses with github_not_configured rather than leaving the
    // route unmounted), and the adapter factory mirrors the debate worker's:
    // Anthropic by default, resolved lazily so a deployment without a key
    // still boots and refuses honestly per request.
    repositoryAnalysisService = new RepositoryAnalysisService({
      transactions: runtimeTransactions,
      github,
      ingestion: phase3Services.ingestion,
      createAdapter: () => {
        const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
        if (!apiKey) throw new Error("Anthropic is not configured for repository analysis");
        return new AnthropicAdapter({
          apiKey,
          model: process.env.NORNS_REPOSITORY_ANALYSIS_MODEL?.trim() || "claude-sonnet-5",
        });
      },
    });
    phase4Services = {
      coordinator: new Phase4Coordinator(runtimeTransactions),
      completion: new Phase4CompletionService(runtimeTransactions),
      dispatch: new Phase4DispatchRepository(runtimeTransactions),
      events: new Phase4EventProcessor(runtimeTransactions),
      recovery: new Phase4RecoveryMonitor(runtimeTransactions),
    };
    // ONBOARDING O4: Actions-hosted execution. Only constructible when GitHub
    // is configured — without it the whole path is absent and laptop runners
    // remain the only execution host.
    if (github) {
      const actionsRepository = new ActionsExecutionRepository(runtimeTransactions);
      const actionsService = new GitHubActionsService(github, fetch);
      actionsExecutionServices = {
        repository: actionsRepository,
        coordinator: new ActionsExecutionCoordinator(
          phase4Services.coordinator,
          actionsRepository,
          actionsService,
          {
            serverOrigin: publicOrigin,
            // EXECUTION E3 — the pinned tarball this server is actually able
            // to serve, `<version>@sha256:<hex>`. Resolved here (inside the
            // `if (github)` branch) so that a deployment which never uses
            // Actions execution is not required to stage a runner artifact.
            // Loading fails loudly: a missing or hash-mismatched tarball must
            // stop startup rather than commit a workflow into a user's
            // repository that is guaranteed to fail at the install step.
            runnerPackage:
              process.env.NORNS_RUNNER_PACKAGE ??
              formatRunnerTarballSpec(loadRunnerTarball(defaultRunnerTarballDir())),
            ...(process.env.NORNS_ACTIONS_NODE_VERSION
              ? { nodeVersion: process.env.NORNS_ACTIONS_NODE_VERSION }
              : {}),
            reserveGeneration: (runnerId: string) => stores.reserveRunnerGeneration(runnerId),
          },
        ),
        enrollment: new ActionsEnrollmentService(
          actionsRepository,
          (runnerId, publicKeyPem, generation) =>
            stores.enrollRunnerAtGeneration(runnerId, publicKeyPem, generation),
        ),
      };
    }
    phase5Services = { attention: new AttentionService(runtimeTransactions) };
    phase6Services = { coordination: new Phase6CoordinationService(runtimeTransactions) };
    phase7Services = { operations: new Phase7OperationsService(runtimeTransactions) };
    // An API key does not itself authorize every model accessible to that key.
    // NORNS_DEBATE_ALLOWED_MODELS is the static, deployment-level allowlist;
    // it is evaluated locally once at startup and never via a provider probe.
    const configuredDebateModelKeys = new Set(
      buildSelectableModelCatalog(modelAvailabilityFromDebateEnvironment(process.env))
        .filter((entry) => entry.available)
        .map((entry) => `${entry.provider}:${entry.model}`),
    );
    const assertDebateModelConfigured = (provider: string, model: string): void => {
      if (!configuredDebateModelKeys.has(`${provider}:${model}`)) {
        throw new Error(
          `debate model ${provider}/${model} is not enabled by NORNS_DEBATE_ALLOWED_MODELS`,
        );
      }
    };
    const maximumTurnCharge = (input: {
      provider: string;
      model: string;
      max_input_tokens: number;
      max_output_tokens: number;
    }) => {
      assertDebateModelConfigured(input.provider, input.model);
      return quoteConservativeMaxCharge(
        { provider: input.provider as ProviderName, model: input.model },
        {
          max_input_tokens: input.max_input_tokens,
          max_output_tokens: input.max_output_tokens,
        },
      ).max_charge_usd;
    };
    const actorExecutionSnapshot = (actor: {
      id: string;
      provider: string;
      model: string;
      runtime: string;
      max_input_tokens: number;
      max_output_tokens: number;
      budget_limit_usd: number;
      max_turns: number;
    }) => {
      assertDebateModelConfigured(actor.provider, actor.model);
      const quote = quoteConservativeMaxCharge(
        { provider: actor.provider as ProviderName, model: actor.model },
        {
          max_input_tokens: actor.max_input_tokens,
          max_output_tokens: actor.max_output_tokens,
        },
      );
      return {
        actor_id: actor.id,
        provider: actor.provider,
        model: actor.model,
        runtime: actor.runtime,
        max_input_tokens: actor.max_input_tokens,
        max_output_tokens: actor.max_output_tokens,
        budget_limit_usd: actor.budget_limit_usd,
        max_turns: actor.max_turns,
        pricing: {
          provider: quote.pricing.provider,
          model: quote.pricing.model,
          input_per_mtok_usd: quote.pricing.input_per_mtok,
          output_per_mtok_usd: quote.pricing.output_per_mtok,
          pricing_version: quote.pricing.pricing_version,
          pricing_is_estimate: quote.pricing.pricing_is_estimate,
        },
        maximum_turn_charge_usd: quote.max_charge_usd,
      };
    };
    debateService = new DebateService(runtimeTransactions, {
      maximumTurnCharge,
      actorExecutionSnapshot,
    });
    const debateWorker = new DebateWorker(
      runtimeTransactions,
      (provider, model) => {
        assertDebateModelConfigured(provider, model);
        if (provider === "anthropic") {
          const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
          if (!apiKey) throw new Error("Anthropic is not configured for debate execution");
          return new AnthropicAdapter({ apiKey, model });
        }
        if (provider === "openai") {
          const apiKey = process.env.OPENAI_API_KEY?.trim();
          if (!apiKey) throw new Error("OpenAI is not configured for debate execution");
          return new OpenAiAdapter({ apiKey, model });
        }
        throw new Error(`unsupported debate provider: ${provider}`);
      },
      {},
    );
    let debateTickRunning = false;
    debateWorkerTimer = setInterval(() => {
      if (debateTickRunning) return;
      debateTickRunning = true;
      void debateWorker
        .tick()
        .catch((error) =>
          console.error(
            `debate worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => {
          debateTickRunning = false;
        });
    }, 1_000);
    debateWorkerTimer.unref();
    if (credentialKeyring) {
      await assertCredentialHmacKeyCoverage(runtimeTransactions, credentialKeyring);
    }
    // FRONT DOOR P2 §D1: expose observable planning runs over the same
    // relational runtime the debate workflow uses.
    //
    // PHASE TAB P4: approve in the Phase tab auto-starts execution. The
    // kickoff drives the existing chain (StrategyBridgeService -> strategy
    // approval -> PhaseLaunchService.startPhase), so it needs a
    // PhaseLaunchService constructed EXACTLY the way buildServer's
    // start-phase route path constructs its own: same assembler, same scope
    // repository, same runner resolution against the live RelayStores (the
    // closure reads the `stores` binding, which may be re-assigned by the
    // relay-snapshot restore below — deliberately late-bound).
    const kickoffPhaseLaunch = new PhaseLaunchService(
      runtimeTransactions,
      phase4Services.coordinator,
      new RelationalTaskContextAssembler(
        runtimeTransactions,
        new TaskContextStore(runtimeTransactions),
        { baseUrl: publicOrigin },
      ),
      new DispatchContextScopeRepository(runtimeTransactions),
      (runnerId) => {
        const runner = stores.runner(runnerId);
        return runner
          ? { runner_id: runner.runner_id, runner_generation: runner.generation }
          : null;
      },
      actionsExecutionServices
        ? {
            coordinator: actionsExecutionServices.coordinator,
            repository: actionsExecutionServices.repository,
          }
        : undefined,
    );
    planningRunsOptions = {
      transactions: runtimeTransactions,
      executionKickoff: new ExecutionKickoffService({
        transactions: runtimeTransactions,
        bridge: phase3Services.bridge,
        phaseLaunch: kickoffPhaseLaunch,
      }),
    };
    attachmentsOptions = { transactions: runtimeTransactions };
    // ONBOARDING O2: POST /api/v2/projects/onboarding. The route also needs
    // `integrations.github` (set just above) to reach GitHub; without it the
    // service still mounts and refuses honestly with github_not_configured
    // rather than mounting a route that silently does nothing.
    onboardingOptions = { transactions: runtimeTransactions };
    // EXECUTION E1/E2: wire the assembler + start-phase trigger in. Without
    // this, `buildServer` never receives `options.execution`, the fetch route
    // and start-phase routes never mount, and `server.taskContext` stays
    // undefined -- exactly the dead-on-arrival state the EXECUTION audit
    // found.
    executionOptions = { transactions: runtimeTransactions, baseUrl: publicOrigin };
    // EXECUTION E10 (E9-10, = E3-10): state the dependency instead of letting
    // buildServer infer it from an unrelated feature's option.
    runnerInferenceOptions = { transactions: runtimeTransactions };
    identityRuntime = createIdentityRuntime({
      users,
      route: identityRoute,
      environment: process.env,
      transactions: runtimeTransactions,
    });

    // relay state (runners, outbox, events, audit)
    const relaySnap = await persistence.load("relay");
    if (relaySnap) stores = RelayStores.restore(relaySnap);

    // your real projects: metadata, plans, graph edits, allocations
    const projectsSnap = await persistence.load("projects");
    if (projectsSnap) projects.restoreFrom(JSON.parse(projectsSnap));
    const projectRoutes = await loadDurableProjectRoutes({
      query: async <TRow = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await pool.query(sql, params);
        return { rows: result.rows as TRow[] };
      },
    });
    projectRuntime = createProjectRuntime({
      projects,
      routes: projectRoutes,
      transactions: runtimeTransactions,
    });
    // Legacy accounts remain snapshot-backed until the durable route records
    // relational/relational cutover. After cutover, raw legacy users/sessions
    // are neither loaded nor flushed by the application.
    let usersPersistenceState = "relational";
    if (identityRuntime.usesLegacyUserSnapshot) {
      const usersSnap = await persistence.load("users");
      if (usersSnap) users.restoreFrom(JSON.parse(usersSnap));
      usersFlusher = new SnapshotFlusher(persistence, "users", () =>
        JSON.stringify(users.snapshot()),
      );
      usersPersistenceState = usersSnap ? "restored" : "fresh";
    }
    flushers.push(
      new SnapshotFlusher(persistence, "relay", () => stores.snapshot()),
      new SnapshotFlusher(persistence, "projects", () => JSON.stringify(projects.snapshot())),
    );
    if (usersFlusher) flushers.push(usersFlusher);
    for (const f of flushers) f.start();
    persistenceReady = true;
    console.log(
      `postgres: relay ${relaySnap ? "restored" : "fresh"}, projects ${projectsSnap ? "restored" : "fresh"}, identity ${identityRuntime.mode} ${usersPersistenceState}`,
    );
    let shutdownRequested = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        if (debateWorkerTimer) clearInterval(debateWorkerTimer);
        void Promise.all(flushers.map((f) => f.stop()))
          .then(() => persistenceLease?.release())
          .then(() => databasePool?.end())
          .then(() => process.exit(0));
      });
    }
  } catch (error) {
    const identityMustFailClosed =
      error instanceof IdentityRuntimeConfigurationError || identityRuntime.mode === "relational";
    const databaseBoundaryMustFailClosed =
      error instanceof Phase2PersistenceLeaseUnavailableError ||
      error instanceof PostgresConnectionConfigurationError;
    await persistenceLease?.release();
    persistenceLease = undefined;
    await databasePool?.end();
    databasePool = undefined;
    if (
      identityMustFailClosed ||
      databaseBoundaryMustFailClosed ||
      error instanceof ProjectRuntimeConfigurationError
    ) {
      const code =
        error instanceof IdentityRuntimeConfigurationError
          ? error.code
          : error instanceof ProjectRuntimeConfigurationError
            ? error.code
            : error instanceof PostgresConnectionConfigurationError
              ? error.code
              : error instanceof Phase2PersistenceLeaseUnavailableError
                ? "phase2_persistence_lease_unavailable"
                : "relational_identity_unavailable";
      console.error(
        `startup refused [${code}]: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    console.error(
      `postgres persistence unavailable${isProd ? " — production startup will be refused" : " — continuing in-memory"}. reason: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    stores = new RelayStores();
    flushers.length = 0;
    usersFlusher = undefined;
    persistenceReady = false;
    identityRuntime = createIdentityRuntime({
      users,
      route: null,
      environment: process.env,
    });
    projectRuntime = createProjectRuntime({
      projects,
      routes: { new_projects: null, projects: new Map() },
    });
  }
}

// demo engine over the same plan, driven partway for a live-looking dashboard
const budget = new BudgetLedger(2000);
for (const mod of demoSession.plan.modules) budget.approve(mod.id, 150);
const engine = new WorkflowEngine({ plan: demoSession.plan, budget });
for (const kind of ["plan", "allocation"] as const) {
  engine.recordApproval({
    id: `ap-${kind}`,
    kind,
    actor: "dhatwell",
    approved_at: new Date().toISOString(),
    content_hash: "f".repeat(64),
  });
}
engine.start();
engine.assign("contracts");
engine.startRun("contracts", 30);
engine.completeRun("contracts", 11);
engine.recordVerification("contracts", true);
engine.reviewerDecision("contracts", "approve");
engine.integrate("contracts");
engine.assign("db-schema");
engine.startRun("db-schema", 25);
engine.assign("auth");
engine.block("auth", "runner");

const ledger = [
  UsageEvent.parse({
    id: "use_demo_1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    project_id: "proj-demo",
    node_id: "contracts",
    run_id: "run_demo_1",
    input_tokens: 42_000,
    output_tokens: 9_000,
    estimated_cost_usd: 0.26,
    actual_cost_usd: null,
    usage_source: "provider_api",
    pricing_version: "anthropic-2026-06",
    occurred_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  }),
  UsageEvent.parse({
    id: "use_demo_2",
    provider: "openai",
    model: "openai-reasoning-default",
    project_id: "proj-demo",
    node_id: "contracts",
    run_id: "run_demo_1",
    input_tokens: 12_000,
    output_tokens: 3_000,
    estimated_cost_usd: 0.24,
    actual_cost_usd: null,
    usage_source: "estimate",
    pricing_version: "openai-config-placeholder",
    occurred_at: new Date().toISOString(),
  }),
];

const complexityOf = (nodeId: string): "S" | "M" | "L" | "XL" =>
  demoSession.plan.modules.find((mod) => mod.id === nodeId)?.estimated_complexity ?? "M";

// NORNS_TOKEN's only remaining job is gating one-time first-admin bootstrap
// (POST /api/auth/bootstrap) — it is never accepted as a day-to-day session
// credential anymore. Real accounts replace that entirely.
const deployToken = process.env.NORNS_TOKEN;

let hasActiveAdmin: boolean;
try {
  hasActiveAdmin = await identityRuntime.identity.hasActiveAdmin();
} catch (error) {
  await Promise.all(flushers.map((flusher) => flusher.stop())).catch(() => undefined);
  await persistenceLease?.release();
  await databasePool?.end();
  console.error(
    `identity startup refused [identity_probe_failed]: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (!isProd && identityRuntime.allowsDevelopmentSeed && !hasActiveAdmin) {
  // Local dev convenience: skip the bootstrap ceremony so `pnpm dev` keeps
  // working out of the box, same spirit as the old default dev token.
  await identityRuntime.identity.createActive({
    email: "dev@local.test",
    name: "Dev Admin",
    password: "dev-password",
    role: "admin",
  });
  hasActiveAdmin = true;
  console.log("dev mode: seeded dev@local.test / dev-password as the first admin");
}

const authStartup = evaluateAuthStartup({
  isProduction: isProd,
  persistenceConfigured: Boolean(databaseUrl),
  persistenceReady,
  hasActiveAdmin,
  hasDeployToken: Boolean(deployToken),
});

if (!authStartup.allowed) {
  console.error(`auth startup refused [${authStartup.code}]: ${authStartup.message}`);
  process.exit(1);
}

// Even if NORNS_TOKEN is still present in Railway, do not retain it as a
// runtime capability after a durable active admin has been restored.
const bootstrapDeployToken = authStartup.bootstrapRequired ? deployToken : undefined;

// When NORNS_WEB_DIST points at the built web app, serve it from this service.
const webDist = process.env.NORNS_WEB_DIST;

const server = await buildServer({
  stores,
  users,
  ...(identityRuntime.mode === "relational" ? { identity: identityRuntime.identity } : {}),
  projects: projectRuntime.repository,
  ...(phase3Services !== undefined ? { phase3: phase3Services } : {}),
  // POLISH P3: the analyze-repository step. A service that is not passed here
  // is dead in production while CI stays green — this line IS the feature.
  // (POLISH P1 removed localProjectOnboardingReady along with the local-runner
  // onboarding surface it fed.)
  ...(repositoryAnalysisService !== undefined
    ? { repositoryAnalysis: repositoryAnalysisService }
    : {}),
  ...(phase4Services !== undefined ? { phase4: phase4Services } : {}),
  // ONBOARDING O4: Actions-hosted execution.
  ...(actionsExecutionServices !== undefined ? { actionsExecution: actionsExecutionServices } : {}),
  ...(phase5Services !== undefined ? { phase5: phase5Services } : {}),
  ...(phase6Services !== undefined ? { phase6: phase6Services } : {}),
  ...(phase7Services !== undefined ? { phase7: phase7Services } : {}),
  ...(debateService !== undefined ? { debates: debateService } : {}),
  ...(planningRunsOptions !== undefined ? { planningRuns: planningRunsOptions } : {}),
  ...(attachmentsOptions !== undefined ? { attachments: attachmentsOptions } : {}),
  ...(onboardingOptions !== undefined ? { onboarding: onboardingOptions } : {}),
  ...(executionOptions !== undefined ? { execution: executionOptions } : {}),
  // EXECUTION E10 (E9-10, = E3-10): the E3 proxy and the E9 gateway.
  ...(runnerInferenceOptions !== undefined ? { runnerInference: runnerInferenceOptions } : {}),
  ...(integrationServices !== undefined ? { integrations: integrationServices } : {}),
  recordUsage: (events) => ledger.push(...events),
  ...(bootstrapDeployToken !== undefined ? { deployToken: bootstrapDeployToken } : {}),
  ...(usersFlusher !== undefined ? { persistUsers: () => usersFlusher.flush() } : {}),
  ...(webDist !== undefined ? { webDist } : {}),
  ...(process.env.NORNS_INSTALL_SCRIPTS_DIR
    ? { installScriptsDir: process.env.NORNS_INSTALL_SCRIPTS_DIR }
    : {}),
  publicOrigin,
  dashboard: () =>
    buildDashboard({
      engine,
      budget,
      ledger,
      audit: stores.auditEntries(),
      complexityOf,
      graphVersion: demoSession.graph.version,
    }),
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.NORNS_HOST ?? (isProd ? "0.0.0.0" : "127.0.0.1");
await server.app.listen({ port, host });
console.log(`norns server on ${host}:${port}${webDist ? " (serving web)" : ""}`);
