#!/usr/bin/env node
import { mkdirSync } from "node:fs";
// norns-runner — the Local Runner CLI. Runs on the operator's own machine and
// dials the relay outbound (ADR-002 topology). Two commands:
//
//   norns-runner pair <code> --server <url> [--id <runnerId>] [--data <dir>]
//     One-time enrollment: generates an Ed25519 keypair, redeems the pairing
//     code shown in the web UI, and persists runner state to --data.
//
//   norns-runner start --server <url> [--id <runnerId>] [--data <dir>]
//     Connects the paired runner and stays running, streaming logs and
//     handling commands until Ctrl-C.
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentDaemonLifecycle, AgentHost } from "./agentHost.js";
import {
  parseLocalAgentPairingUri,
  readLocalAgentConfig,
  writeLocalAgentConfig,
} from "./agentPairing.js";
import { type RunnerContextIdentity, RunnerSignedContextFetcher } from "./contextAuth.js";
import { RunnerDaemon } from "./daemon.js";
import { ActiveDeviceIdentityStore } from "./deviceInstallationIdentity.js";
import type { RelayInferenceClient } from "./inferenceClient.js";
import type { LiveRunRegistry } from "./liveRuns.js";
import { type GatewayCredential, ModelGatewayClient } from "./modelGateway.js";
import { PendingDeviceCredentialStore } from "./pendingDeviceCredential.js";
import { GitPublisher } from "./publication.js";
import { ClaudeCodeRuntime } from "./runtimes/claudeCode.js";
import { CodexRuntime } from "./runtimes/codex.js";
import { ProxiedCompletionRuntime } from "./runtimes/proxiedCompletion.js";
import {
  ApprovedRepositoryRegistry,
  CommandPolicyVerifier,
  GitWorktreeManager,
  HashVerifiedContextLoader,
  type RunnerRuntimeProvider,
  V2RunnerExecutor,
} from "./v2Execution.js";
import { runnerVerificationPolicies } from "./verificationPolicies.js";
import { RunnerVisualEvidenceUploader, readRunnerVisualEvidence } from "./visualEvidence.js";
import { WorkspaceRegistry } from "./workspaceRegistry.js";

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string>;
}

/** `--help` / `-h` in the command position is a request for usage, not a flag. */
const HELP_TOKENS = new Set(["--help", "-h", "-help", "help"]);

function parseArgs(argv: string[]): Args {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand !== undefined && HELP_TOKENS.has(rawCommand) ? "help" : rawCommand;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    } else if (token !== undefined) {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function strictFeatureFlag(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly "true" or "false" when set`);
}

function resolveOptions(flags: Record<string, string>) {
  const runnerId = flags.id ?? "runner-1";
  const server = flags.server ?? process.env.NORNS_SERVER;
  const dataDir = flags.data ?? join(homedir(), ".norns", runnerId);
  return { runnerId, server, dataDir };
}

function jsonObject(name: string, required = true): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) {
    if (!required) return {};
    throw new Error(`${name} is required for Phase 4 execution`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function createV2Executor(
  runnerId: string,
  generation: number,
  dataDir: string,
  workspaces: WorkspaceRegistry,
  /**
   * EXECUTION E3 — how this runner proves who it is when fetching its own
   * context document over HTTP. Required: an unauthenticated fetch gets a 401
   * and the agent runs with no prompt at all, so there is no sensible default.
   */
  identity: RunnerContextIdentity,
  /**
   * EXECUTION E3 — the relay's model-proxy client. Registers the
   * `proxied-completion` runtime, which is the ONLY runtime that works when
   * the process holds no provider credentials — which is exactly the situation
   * in an ephemeral GitHub Actions job. See the E3 report: `claude-code` and
   * `codex` cannot be served by this proxy, and remain credential-dependent.
   */
  inference: RelayInferenceClient,
  /**
   * EXECUTION E9 — the relay origin the agentic runtimes are pointed at.
   * When present, `claude-code` and `codex` mint a short-lived, per-run
   * gateway credential instead of needing a provider key in this process.
   * Absent (a laptop runner started without --server) leaves both runtimes on
   * whatever credentials the environment already holds, unchanged.
   */
  serverOrigin: string | undefined,
  /**
   * EXECUTION E11 — the daemon's live-run registry. Required, not optional:
   * without it a dispatched coding run executes with no way to stop it, which
   * is precisely the defect E11 exists to fix. Wiring it here is what makes
   * cancel/interrupt/send_message reach a real run in production rather than
   * only in a test that constructs the executor by hand.
   */
  liveRuns: LiveRunRegistry,
  /**
   * ONBOARDING O4: receives the repository registry so the ephemeral CI mode
   * can bind the checked-out workspace to whatever repository binding the
   * dispatch command names. Optional — laptop runners ignore it entirely.
   */
  onRegistry?: (repositories: ApprovedRepositoryRegistry) => void,
): V2RunnerExecutor {
  const bindingConfig = jsonObject("NORNS_REPOSITORY_BINDINGS_JSON", false);
  const approvedRoots = JSON.parse(process.env.NORNS_APPROVED_ROOTS_JSON ?? "[]") as unknown;
  if (!Array.isArray(approvedRoots) || !approvedRoots.every((root) => typeof root === "string")) {
    throw new Error("NORNS_APPROVED_ROOTS_JSON must be a JSON string array");
  }
  const repositories = new ApprovedRepositoryRegistry(approvedRoots);
  for (const [repository_binding_id, repository_path] of Object.entries(bindingConfig)) {
    if (typeof repository_path !== "string") {
      throw new Error("every repository binding value must be a local path");
    }
    repositories.register({ repository_binding_id, repository_path });
  }
  onRegistry?.(repositories);
  const policies = runnerVerificationPolicies(process.env.NORNS_VERIFICATION_POLICIES_JSON);
  // EXECUTION E9 — one client for the process, one memoized credential per run.
  const gatewayClient = serverOrigin ? new ModelGatewayClient(serverOrigin, identity) : null;
  const minted = new Map<string, Promise<GatewayCredential>>();
  const gateway = (runId: string) => {
    if (!gatewayClient) return {};
    return {
      gateway: () => {
        const existing = minted.get(runId);
        if (existing) return existing;
        const pending = gatewayClient.mint(runId);
        minted.set(runId, pending);
        // A failed mint must not be cached: the run should be able to retry.
        pending.catch(() => minted.delete(runId));
        return pending;
      },
    };
  };
  const scratchRoot = join(dataDir, "scratch");
  const worktreeRoot = join(dataDir, "worktrees");
  // A freshly paired runner has only runner-state.json. Create both execution
  // parents before the first dispatch so mkdtemp/worktree setup cannot fail
  // merely because this is the runner's first real task.
  mkdirSync(scratchRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  return new V2RunnerExecutor(
    { id: runnerId, generation, scratch_root: scratchRoot },
    repositories,
    // EXECUTION E3 — signed, not anonymous. This single construction site is
    // shared by BOTH the laptop path and the ephemeral GitHub Actions path
    // (createV2Executor is called once, after the pair/enroll branch has
    // rejoined), so the CI runner authenticates its context fetches too.
    new HashVerifiedContextLoader(new RunnerSignedContextFetcher(identity)),
    new GitWorktreeManager(worktreeRoot),
    new Map<string, RunnerRuntimeProvider>([
      // EXECUTION E9 — both agentic runtimes now mint a per-run gateway
      // credential lazily, at the moment they execute. Minting is per-run and
      // memoized per runtime instance, so a resumed or retried turn inside one
      // run reuses one credential rather than accumulating rows.
      [
        "codex",
        (model: string, context) =>
          new CodexRuntime({
            model,
            ...(context.reasoningEffort ? { reasoningEffort: context.reasoningEffort } : {}),
            ...(context.resumeSessionId ? { resumeThreadId: context.resumeSessionId } : {}),
            ...gateway(context.runId),
          }),
      ],
      [
        "claude-code",
        (model: string, context) =>
          new ClaudeCodeRuntime({
            model,
            ...(context.resumeSessionId ? { resumeSessionId: context.resumeSessionId } : {}),
            ...gateway(context.runId),
          }),
      ],
      // EXECUTION E3 — credential-free. Gets its model access from the relay,
      // where the call is authorized against the run and charged to the
      // project's budget before it is made.
      [
        "proxied-completion",
        (model: string, context) =>
          new ProxiedCompletionRuntime(inference, {
            provider: model.startsWith("gpt") || model.startsWith("o") ? "openai" : "anthropic",
            model,
            runId: context.runId,
            taskId: context.taskId,
            maxTokens: context.maxOutputTokens,
          }),
      ],
    ]),
    new CommandPolicyVerifier(policies),
    workspaces,
    // EXECUTION E4 — the run's work is pushed and opened as a pull request
    // before the worktree is removed. Credential-free by construction: in an
    // Actions job `actions/checkout` has already configured GITHUB_TOKEN as the
    // git credential and GitHub exports GITHUB_REPOSITORY/GITHUB_TOKEN, so this
    // asks Norns for no secret and stores none (see pushCredentialProvider.ts).
    new GitPublisher(),
    liveRuns,
  );
}

function persistentDeviceIdentity(
  dataDir: string,
  enabled: boolean,
): {
  identity: RunnerContextIdentity & { mode: "device" };
  wss: {
    identity: {
      device_id: string;
      credential_id: string;
      generation: number;
    };
    sign(payload: string): string;
  };
} | null {
  if (!enabled) return null;
  const active = new ActiveDeviceIdentityStore(dataDir).read();
  if (!active) {
    throw new Error(
      "device control is enabled but no server-validated active device identity is persisted",
    );
  }
  const credential = new PendingDeviceCredentialStore(dataDir);
  if (!credential.read()) throw new Error("active device identity has no persisted credential");
  return {
    identity: {
      mode: "device",
      deviceId: active.device_id,
      credentialId: active.credential_id,
      generation: active.generation,
      sign: (payload) => credential.sign(payload),
    },
    wss: {
      identity: {
        device_id: active.device_id,
        credential_id: active.credential_id,
        generation: active.generation,
      },
      sign: (payload) => credential.sign(payload),
    },
  };
}

/**
 * The single persistent production runner construction path used by both the
 * foreground `start` command and AgentHost. Sharing the instance is what lets
 * the local emergency control reach the exact LiveRunRegistry that owns work.
 */
function createPersistentRunner(input: {
  server: string;
  runnerId: string;
  dataDir: string;
  deviceControlEnabled: boolean;
}): RunnerDaemon {
  const device = persistentDeviceIdentity(input.dataDir, input.deviceControlEnabled);
  const execution: {
    executor?: V2RunnerExecutor;
    repositories?: ApprovedRepositoryRegistry;
  } = {};
  const workspaces = new WorkspaceRegistry(input.dataDir);
  const daemon = new RunnerDaemon({
    serverUrl: input.server,
    runnerId: input.runnerId,
    dataDir: input.dataDir,
    workspaces,
    ...(device ? { deviceControl: device.wss } : {}),
    executeV2: async (command, emit, capabilities) => {
      if (!execution.executor) throw new Error("Phase 4 executor is not initialized");
      return (await execution.executor.execute(command, emit, capabilities)).outcome;
    },
    collectVisualEvidence: async (command) => {
      if (!execution.repositories) {
        throw new Error("visual evidence repository registry is not initialized");
      }
      const evidence = await readRunnerVisualEvidence({
        worktree_path: execution.repositories.resolve(command.repository_binding_id),
        expected_commit: command.commit_sha,
      });
      if (evidence.approved_mockup_version_id !== command.approved_mockup_version_id) {
        throw new Error("visual evidence manifest names a different approved mockup");
      }
      await new RunnerVisualEvidenceUploader(
        input.server,
        device?.identity ?? {
          mode: "legacy_runner",
          runnerId: input.runnerId,
          generation: daemon.generation,
          sign: (payload) => daemon.sign(payload),
        },
      ).upload(evidence, {
        project_id: command.project_id,
        work_item_id: command.work_item_id,
        conversation_id: command.conversation_id,
        phase_id: command.phase_id,
        task_id: command.task_id,
        run_id: command.run_id,
        repository_binding_id: command.repository_binding_id,
        verification_result_id: command.verification_result_id,
        deployment_record_id: command.deployment_record_id,
        deployment_observation_id: command.deployment_observation_id,
        verified_at: new Date().toISOString(),
      });
    },
  });
  daemon.loadState();
  execution.executor = createV2Executor(
    input.runnerId,
    daemon.generation,
    input.dataDir,
    workspaces,
    device?.identity ?? {
      mode: "legacy_runner",
      runnerId: input.runnerId,
      generation: daemon.generation,
      sign: (payload) => daemon.sign(payload),
    },
    daemon.inference,
    input.server,
    daemon.liveRuns,
    (repositories) => {
      execution.repositories = repositories;
    },
  );
  return daemon;
}

const USAGE = `norns-runner — TheNorns Local Runner

Usage:
  norns-runner pair <code> --server <url> [--id <runnerId>] [--data <dir>]
  norns-runner pair-url <norns-agent://pair?...> [--data <dir>]
  norns-runner agent-host [--data <dir>]
  norns-runner agent-start [--data <dir>]
  norns-runner start --server <url> [--id <runnerId>] [--data <dir>]
  norns-runner start --ephemeral --id <runnerId> --job <dispatchJobId>
  norns-runner workspace add <folder> [--label <name>] [--data <dir>]
  norns-runner workspace list [--data <dir>]
  norns-runner workspace remove <workspaceId> [--data <dir>]

Flags:
  --server  Relay URL (e.g. https://your-app.up.railway.app). Or set NORNS_SERVER.
  --id      Runner id (default: runner-1)
  --data    State directory (default: ~/.norns/<runnerId>)

Device AgentHost preview:
  agent-host starts only the foreground, loopback Control Center. Enable it
  explicitly with NORNS_ENABLE_DEVICE_AGENT_HOST=true. Enrolled device control
  additionally requires NORNS_ENABLE_DEVICE_CONTROL=true plus a validated,
  persisted active redemption result. Installed agent-start owns both the
  Control Center and runner lifecycle when that device-control flag is enabled.

Ephemeral (GitHub Actions) mode:
  --ephemeral  Enroll for one dispatched job, run it, then exit. Reads the
               enrollment credential from NORNS_RUNNER_ENROLLMENT_TOKEN and
               the relay origin from NORNS_SERVER; binds GITHUB_WORKSPACE as
               the repository. Nothing is installed on anyone's machine — the
               whole runner is destroyed with the job.
  --job        The Norns dispatch job this ephemeral runner exists to execute.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveOptions(args.flags);
  const installedAgentStart = args.command === "agent-start";
  const agentConfig = installedAgentStart ? readLocalAgentConfig(resolved.dataDir) : undefined;
  const runnerId = agentConfig?.runner_id ?? resolved.runnerId;
  const server = agentConfig?.server ?? resolved.server;
  const dataDir = resolved.dataDir;
  const command = installedAgentStart
    ? strictFeatureFlag("NORNS_ENABLE_DEVICE_CONTROL")
      ? "agent-host"
      : "start"
    : args.command;

  if (!command || command === "help" || args.flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "agent-host") {
    if (!installedAgentStart && process.env.NORNS_ENABLE_DEVICE_AGENT_HOST !== "true") {
      throw new Error(
        "AgentHost is disabled; set NORNS_ENABLE_DEVICE_AGENT_HOST=true to run the local preview",
      );
    }

    const deviceControlEnabled = strictFeatureFlag("NORNS_ENABLE_DEVICE_CONTROL");
    let agentDaemon: AgentDaemonLifecycle;
    if (deviceControlEnabled) {
      const config = readLocalAgentConfig(dataDir);
      agentDaemon = createPersistentRunner({
        server: config.server,
        runnerId: config.runner_id,
        dataDir,
        deviceControlEnabled: true,
      });
    } else {
      agentDaemon = {
        async start() {
          throw new Error("cloud device dispatch is disabled until device enrollment is complete");
        },
        async stop() {},
      };
    }
    const agentHost = new AgentHost({
      dataDir,
      daemon: agentDaemon,
      startDaemonOnHostStart: deviceControlEnabled,
    });
    const started = await agentHost.start();
    let stopping = false;
    const stopAgentHost = (): void => {
      if (stopping) return;
      stopping = true;
      void agentHost
        .stop()
        .then(() => {
          process.stdout.write("\nNorns Local Agent Control Center stopped\n");
          process.exit(0);
        })
        .catch((error: unknown) => {
          process.stderr.write(
            `error: failed to stop AgentHost: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
          process.exit(1);
        });
    };
    process.once("SIGINT", stopAgentHost);
    process.once("SIGTERM", stopAgentHost);
    process.stdout.write(
      [
        `Norns Local Agent Control Center: ${started.bootstrap_url}`,
        deviceControlEnabled
          ? "Enrolled device control and the managed runner are active."
          : "Cloud device dispatch is disabled in this preview.",
        "Press Ctrl-C to stop.",
        "",
      ].join("\n"),
    );
    await new Promise<never>(() => {});
    return;
  }
  if (command === "workspace") {
    const registry = new WorkspaceRegistry(dataDir);
    const action = args.positional[0];
    if (action === "add") {
      const folder = args.positional[1];
      if (!folder) throw new Error("workspace folder required");
      const workspace = registry.addWorkspace(folder, args.flags.label);
      process.stdout.write(`approved workspace ${workspace.workspace_id} (${workspace.label})\n`);
      return;
    }
    if (action === "list") {
      for (const workspace of registry.listConfigured()) {
        process.stdout.write(`${workspace.workspace_id}\t${workspace.label}\n`);
      }
      return;
    }
    if (action === "remove") {
      const workspaceId = args.positional[1];
      if (!workspaceId) throw new Error("workspace id required");
      if (!registry.removeWorkspace(workspaceId)) throw new Error("workspace not found");
      process.stdout.write("workspace removed\n");
      return;
    }
    throw new Error("workspace command must be add, list, or remove");
  }
  if (command === "pair-url") {
    const pairingUri = args.positional[0];
    if (!pairingUri) throw new Error("local-agent pairing link required");
    const pairing = parseLocalAgentPairingUri(pairingUri);
    const allowedOrigin = process.env.NORNS_AGENT_ALLOWED_ORIGIN;
    if (allowedOrigin && new URL(allowedOrigin).origin !== pairing.server) {
      throw new Error("this Norns Local Agent installer belongs to a different server");
    }
    const pairingDataDir = args.flags.data ?? join(homedir(), ".norns", pairing.runnerId);
    const daemon = new RunnerDaemon({
      serverUrl: pairing.server,
      runnerId: pairing.runnerId,
      dataDir: pairingDataDir,
    });
    await daemon.pair(pairing.code);
    writeLocalAgentConfig(pairingDataDir, {
      version: 1,
      server: pairing.server,
      runner_id: pairing.runnerId,
    });
    process.stdout.write(`Norns Local Agent connected as "${pairing.runnerId}"\n`);
    return;
  }
  if (!server) {
    process.stderr.write("error: --server <url> is required (or set NORNS_SERVER)\n");
    process.exit(2);
  }

  if (command === "pair") {
    const code = args.positional[0];
    if (!code) {
      process.stderr.write("error: pairing code required — `norns-runner pair <code> ...`\n");
      process.exit(2);
    }
    const daemon = new RunnerDaemon({ serverUrl: server, runnerId, dataDir });
    await daemon.pair(code);
    process.stdout.write(
      `paired runner "${runnerId}" with ${server}\nstate saved to ${dataDir}\nrun: norns-runner start --server ${server} --id ${runnerId}\n`,
    );
    return;
  }

  if (command === "start") {
    // ONBOARDING O4 — ephemeral (GitHub Actions) mode. Purely additive: without
    // --ephemeral every line below behaves exactly as it did for laptop
    // runners. With it, the runner enrolls instead of loading paired state,
    // binds the checked-out CI workspace, and exits when its one job is done.
    const ephemeral = args.flags.ephemeral === "true";
    const deviceControlEnabled = strictFeatureFlag("NORNS_ENABLE_DEVICE_CONTROL");
    if (ephemeral && deviceControlEnabled) {
      throw new Error("device control is not available in ephemeral runner mode");
    }
    if (!ephemeral) {
      const daemon = createPersistentRunner({
        server,
        runnerId,
        dataDir,
        deviceControlEnabled,
      });
      daemon.connect();
      process.stdout.write(`runner "${runnerId}" connecting to ${server} — Ctrl-C to stop\n`);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
          daemon.stop();
          process.stdout.write("\nrunner stopped\n");
          process.exit(0);
        });
      }
      await new Promise<never>(() => {});
      return;
    }
    const execution: { executor?: V2RunnerExecutor; repositories?: ApprovedRepositoryRegistry } =
      {};
    const workspaces = new WorkspaceRegistry(dataDir);
    const settled: { state?: string } = {};
    const daemon = new RunnerDaemon({
      serverUrl: server,
      runnerId,
      dataDir,
      workspaces,
      onRunSettled: (event: { state: string }) => {
        settled.state = event.state;
      },
      executeV2: async (command, emit, capabilities) => {
        if (!execution.executor) throw new Error("Phase 4 executor is not initialized");
        // In CI the repository binding is only knowable from the command, and
        // the one checked-out tree is the only thing that could satisfy it.
        // register() still enforces the approved-root check, so this cannot
        // reach outside GITHUB_WORKSPACE.
        if (ephemeral && execution.repositories) {
          const workspace = process.env.GITHUB_WORKSPACE;
          if (!workspace) throw new Error("GITHUB_WORKSPACE is not set in this job");
          execution.repositories.register({
            repository_binding_id: command.repository_binding_id,
            repository_path: workspace,
          });
        }
        return (await execution.executor.execute(command, emit, capabilities)).outcome;
      },
      collectVisualEvidence: async (command) => {
        if (!execution.repositories) {
          throw new Error("visual evidence repository registry is not initialized");
        }
        if (ephemeral) {
          const workspace = process.env.GITHUB_WORKSPACE;
          if (!workspace) throw new Error("GITHUB_WORKSPACE is not set in this job");
          execution.repositories.register({
            repository_binding_id: command.repository_binding_id,
            repository_path: workspace,
          });
        }
        const evidence = await readRunnerVisualEvidence({
          worktree_path: execution.repositories.resolve(command.repository_binding_id),
          expected_commit: command.commit_sha,
        });
        if (evidence.approved_mockup_version_id !== command.approved_mockup_version_id) {
          throw new Error("visual evidence manifest names a different approved mockup");
        }
        await new RunnerVisualEvidenceUploader(server, {
          mode: "legacy_runner",
          runnerId,
          generation: daemon.generation,
          sign: (payload) => daemon.sign(payload),
        }).upload(evidence, {
          project_id: command.project_id,
          work_item_id: command.work_item_id,
          conversation_id: command.conversation_id,
          phase_id: command.phase_id,
          task_id: command.task_id,
          run_id: command.run_id,
          repository_binding_id: command.repository_binding_id,
          verification_result_id: command.verification_result_id,
          deployment_record_id: command.deployment_record_id,
          deployment_observation_id: command.deployment_observation_id,
          verified_at: new Date().toISOString(),
        });
      },
    });
    const enrollmentToken = process.env.NORNS_RUNNER_ENROLLMENT_TOKEN;
    const dispatchJobId = args.flags.job;
    if (!enrollmentToken) {
      process.stderr.write("error: NORNS_RUNNER_ENROLLMENT_TOKEN is required in --ephemeral\n");
      process.exit(2);
    }
    if (!dispatchJobId) {
      process.stderr.write("error: --job <dispatchJobId> is required in --ephemeral\n");
      process.exit(2);
    }
    await daemon.enroll({ enrollmentToken, dispatchJobId });
    // Folder onboarding binds this named policy. A conservative Git commit
    // check is available by default; deployments may replace it with an
    // explicit approved command map through NORNS_VERIFICATION_POLICIES_JSON.
    execution.executor = createV2Executor(
      runnerId,
      daemon.generation,
      dataDir,
      workspaces,
      // The key stays inside the daemon; only a signing capability is handed out.
      {
        mode: "legacy_runner",
        runnerId,
        generation: daemon.generation,
        sign: (payload) => daemon.sign(payload),
      },
      daemon.inference,
      // EXECUTION E9 — the relay origin the agentic runtimes mint against.
      // `server` is already required to reach this point.
      server,
      daemon.liveRuns,
      (repositories) => {
        execution.repositories = repositories;
      },
    );
    daemon.connect();
    process.stdout.write(`runner "${runnerId}" connecting to ${server} — Ctrl-C to stop\n`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        daemon.stop();
        process.stdout.write("\nrunner stopped\n");
        process.exit(0);
      });
    }
    // Wait for the one dispatched job to reach a terminal state, then stop.
    // The job's own `timeout-minutes` is the outer ceiling; this loop simply
    // means the machine is not held open for a second longer than the work.
    while (settled.state === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Let the terminal ack drain to the relay before tearing down the socket.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    daemon.stop();
    const outcome = settled.state;
    process.stdout.write(`norns run ${outcome}\n`);
    process.exit(outcome === "succeeded" ? 0 : 1);
    return;
  }

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
