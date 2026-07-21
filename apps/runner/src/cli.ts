#!/usr/bin/env node
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
import { type RunnerContextIdentity, RunnerSignedContextFetcher } from "./contextAuth.js";
import { RunnerDaemon } from "./daemon.js";
import type { RelayInferenceClient } from "./inferenceClient.js";
import type { LiveRunRegistry } from "./liveRuns.js";
import { type GatewayCredential, ModelGatewayClient } from "./modelGateway.js";
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
  return new V2RunnerExecutor(
    { id: runnerId, generation, scratch_root: join(dataDir, "scratch") },
    repositories,
    // EXECUTION E3 — signed, not anonymous. This single construction site is
    // shared by BOTH the laptop path and the ephemeral GitHub Actions path
    // (createV2Executor is called once, after the pair/enroll branch has
    // rejoined), so the CI runner authenticates its context fetches too.
    new HashVerifiedContextLoader(new RunnerSignedContextFetcher(identity)),
    new GitWorktreeManager(join(dataDir, "worktrees")),
    new Map<string, RunnerRuntimeProvider>([
      // EXECUTION E9 — both agentic runtimes now mint a per-run gateway
      // credential lazily, at the moment they execute. Minting is per-run and
      // memoized per runtime instance, so a resumed or retried turn inside one
      // run reuses one credential rather than accumulating rows.
      ["codex", (model: string, context) => new CodexRuntime({ model, ...gateway(context.runId) })],
      [
        "claude-code",
        (model: string, context) => new ClaudeCodeRuntime({ model, ...gateway(context.runId) }),
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

const USAGE = `norns-runner — TheNorns Local Runner

Usage:
  norns-runner pair <code> --server <url> [--id <runnerId>] [--data <dir>]
  norns-runner start --server <url> [--id <runnerId>] [--data <dir>]
  norns-runner start --ephemeral --id <runnerId> --job <dispatchJobId>
  norns-runner workspace add <folder> [--label <name>] [--data <dir>]
  norns-runner workspace list [--data <dir>]
  norns-runner workspace remove <workspaceId> [--data <dir>]

Flags:
  --server  Relay URL (e.g. https://your-app.up.railway.app). Or set NORNS_SERVER.
  --id      Runner id (default: runner-1)
  --data    State directory (default: ~/.norns/<runnerId>)

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
  const { runnerId, server, dataDir } = resolveOptions(args.flags);

  if (!args.command || args.command === "help" || args.flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.command === "workspace") {
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
  if (!server) {
    process.stderr.write("error: --server <url> is required (or set NORNS_SERVER)\n");
    process.exit(2);
  }

  if (args.command === "pair") {
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

  if (args.command === "start") {
    // ONBOARDING O4 — ephemeral (GitHub Actions) mode. Purely additive: without
    // --ephemeral every line below behaves exactly as it did for laptop
    // runners. With it, the runner enrolls instead of loading paired state,
    // binds the checked-out CI workspace, and exits when its one job is done.
    const ephemeral = args.flags.ephemeral === "true";
    const execution: { executor?: V2RunnerExecutor; repositories?: ApprovedRepositoryRegistry } =
      {};
    const workspaces = new WorkspaceRegistry(dataDir);
    const settled: { state?: string } = {};
    const daemon = new RunnerDaemon({
      serverUrl: server,
      runnerId,
      dataDir,
      workspaces,
      ...(ephemeral
        ? {
            onRunSettled: (event: { state: string }) => {
              settled.state = event.state;
            },
          }
        : {}),
      executeV2: async (command, emit) => {
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
        return (await execution.executor.execute(command, emit)).outcome;
      },
    });
    if (ephemeral) {
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
    } else {
      try {
        daemon.loadState();
      } catch {
        process.stderr.write(`error: runner "${runnerId}" is not paired — run \`pair\` first\n`);
        process.exit(2);
      }
    }
    // Folder onboarding binds this named policy. A conservative Git commit
    // check is available by default; deployments may replace it with an
    // explicit approved command map through NORNS_VERIFICATION_POLICIES_JSON.
    execution.executor = createV2Executor(
      runnerId,
      daemon.generation,
      dataDir,
      workspaces,
      // The key stays inside the daemon; only a signing capability is handed out.
      { runnerId, sign: (payload) => daemon.sign(payload) },
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
    if (ephemeral) {
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
    }
    // keep the process alive; the daemon's socket + timers drive the loop
    await new Promise<never>(() => {});
    return;
  }

  process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
