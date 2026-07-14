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
    const daemon = new RunnerDaemon({ serverUrl: server, runnerId, dataDir });
    try {
      daemon.loadState();
    } catch {
      process.stderr.write(`error: runner "${runnerId}" is not paired — run \`pair\` first\n`);
      process.exit(2);
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
