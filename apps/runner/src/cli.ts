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
import { RunnerDaemon } from "./daemon.js";
import { ClaudeCodeRuntime } from "./runtimes/claudeCode.js";
import { CodexRuntime } from "./runtimes/codex.js";
import {
  ApprovedRepositoryRegistry,
  CommandPolicyVerifier,
  GitWorktreeManager,
  HashVerifiedContextLoader,
  type RunnerRuntimeProvider,
  SignedUrlContentFetcher,
  V2RunnerExecutor,
} from "./v2Execution.js";

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
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

function jsonObject(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for Phase 4 execution`);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function createV2Executor(runnerId: string, generation: number, dataDir: string): V2RunnerExecutor {
  const bindingConfig = jsonObject("NORNS_REPOSITORY_BINDINGS_JSON");
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
  const policyConfig = jsonObject("NORNS_VERIFICATION_POLICIES_JSON");
  const policies = new Map<string, [string, ...string[]]>();
  for (const [policy, command] of Object.entries(policyConfig)) {
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((part) => typeof part === "string")
    ) {
      throw new Error(`verification policy ${policy} must be a non-empty string array`);
    }
    policies.set(policy, command as [string, ...string[]]);
  }
  return new V2RunnerExecutor(
    { id: runnerId, generation, scratch_root: join(dataDir, "scratch") },
    repositories,
    new HashVerifiedContextLoader(new SignedUrlContentFetcher()),
    new GitWorktreeManager(join(dataDir, "worktrees")),
    new Map<string, RunnerRuntimeProvider>([
      ["codex", (model: string) => new CodexRuntime({ model })],
      ["claude-code", (model: string) => new ClaudeCodeRuntime({ model })],
    ]),
    new CommandPolicyVerifier(policies),
  );
}

const USAGE = `norns-runner — TheNorns Local Runner

Usage:
  norns-runner pair <code> --server <url> [--id <runnerId>] [--data <dir>]
  norns-runner start --server <url> [--id <runnerId>] [--data <dir>]

Flags:
  --server  Relay URL (e.g. https://your-app.up.railway.app). Or set NORNS_SERVER.
  --id      Runner id (default: runner-1)
  --data    State directory (default: ~/.norns/<runnerId>)
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { runnerId, server, dataDir } = resolveOptions(args.flags);

  if (!args.command || args.command === "help" || args.flags.help) {
    process.stdout.write(USAGE);
    return;
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
    let executor: V2RunnerExecutor | undefined;
    const daemon = new RunnerDaemon({
      serverUrl: server,
      runnerId,
      dataDir,
      executeV2: async (command, emit) => {
        if (!executor) throw new Error("Phase 4 executor is not initialized");
        return (await executor.execute(command, emit)).outcome;
      },
    });
    try {
      daemon.loadState();
    } catch {
      process.stderr.write(`error: runner "${runnerId}" is not paired — run \`pair\` first\n`);
      process.exit(2);
    }
    if (process.env.NORNS_REPOSITORY_BINDINGS_JSON) {
      executor = createV2Executor(runnerId, daemon.generation, dataDir);
    }
    daemon.connect();
    process.stdout.write(`runner "${runnerId}" connecting to ${server} — Ctrl-C to stop\n`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        daemon.stop();
        process.stdout.write("\nrunner stopped\n");
        process.exit(0);
      });
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
