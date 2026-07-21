#!/usr/bin/env node
// EXECUTION E3 — build the self-contained @norns/runner tarball that the
// GitHub Actions workflow installs.
//
// WHY THIS EXISTS: the workflow used to run `npm install --global @norns/runner`,
// but apps/runner is `"private": true` and has never been published. The job
// failed at the install step before any Norns code ran. The decision (E3) is
// NOT to publish to npm: the Norns server serves a versioned tarball of its own
// runner, so the runner and the server that talks to it can never disagree
// about protocol version — they ship from the same build.
//
// WHY IT MUST BE SELF-CONTAINED: `apps/runner` depends on `@norns/contracts`
// via `workspace:*`. A naive `npm pack` of apps/runner produces a tarball whose
// package.json carries `"@norns/contracts": "workspace:*"`, which npm cannot
// resolve outside a pnpm workspace — the install would fail in a *second* way.
// The fix is npm's own `bundledDependencies` mechanism: the compiled contracts
// package is placed physically inside the tarball under node_modules/ and
// declared bundled, so npm uses the copy in the tarball verbatim and never
// contacts a registry for it. The three genuinely-external runtime dependencies
// (the two coding-agent SDKs, `ws`) and `zod` are ordinary dependencies
// resolved from the public registry inside the Actions job.
//
// Output (all under apps/runner/dist-pack/):
//   norns-runner-<version>.tgz   the artifact the workflow downloads
//   runner-tarball.json          { version, filename, sha256, byte_size }
// The manifest is written *from the bytes actually produced*, so the hash the
// server publishes is by construction the hash of the file it serves.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(runnerRoot, "..", "..");
const contractsRoot = join(workspaceRoot, "packages", "contracts");

/** Everything the runner needs at run time that is NOT a workspace package. */
const EXTERNAL_DEPENDENCY_NAMES = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "ws"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireBuilt(path, what) {
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // fall through to the shared error
  }
  throw new Error(`${what} is not built (${path} missing) — run \`pnpm run build\` first`);
}

const runnerPkg = readJson(join(runnerRoot, "package.json"));
const contractsPkg = readJson(join(contractsRoot, "package.json"));
const version = runnerPkg.version;

requireBuilt(join(runnerRoot, "dist"), "@norns/runner");
requireBuilt(join(contractsRoot, "dist"), "@norns/contracts");

const outDir = join(runnerRoot, "dist-pack");
// `package/` is the prefix npm expects at the root of a package tarball.
const stageDir = join(outDir, "package");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(join(runnerRoot, "dist"), join(stageDir, "dist"), { recursive: true });

const bundledContractsDir = join(stageDir, "node_modules", "@norns", "contracts");
mkdirSync(bundledContractsDir, { recursive: true });
cpSync(join(contractsRoot, "dist"), join(bundledContractsDir, "dist"), { recursive: true });
writeFileSync(
  join(bundledContractsDir, "package.json"),
  `${JSON.stringify(
    {
      name: contractsPkg.name,
      version: contractsPkg.version,
      type: contractsPkg.type,
      main: contractsPkg.main,
      types: contractsPkg.types,
      dependencies: contractsPkg.dependencies,
    },
    null,
    2,
  )}\n`,
);

// The published manifest. Note what is absent: `private`, `devDependencies`,
// and every workspace: specifier. An exact-version dependency on the bundled
// contracts package keeps npm's integrity check meaningful without letting it
// reach a registry for a package that has never been published there.
const dependencies = { "@norns/contracts": contractsPkg.version, zod: contractsPkg.dependencies.zod };
for (const name of EXTERNAL_DEPENDENCY_NAMES) {
  const range = runnerPkg.dependencies[name];
  if (!range) throw new Error(`apps/runner/package.json no longer declares ${name}`);
  dependencies[name] = range;
}
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: runnerPkg.name,
      version,
      type: runnerPkg.type,
      description: runnerPkg.description,
      main: runnerPkg.main,
      types: runnerPkg.types,
      bin: runnerPkg.bin,
      engines: { node: ">=20" },
      dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
      bundledDependencies: ["@norns/contracts"],
    },
    null,
    2,
  )}\n`,
);

const filename = `norns-runner-${version}.tgz`;
// -n omits the gzip timestamp so two builds of identical inputs hash alike.
execFileSync("tar", ["-czf", join(outDir, filename), "-C", outDir, "package"], {
  env: { ...process.env, GZIP: "-n" },
  stdio: "inherit",
});
rmSync(stageDir, { recursive: true, force: true });

const bytes = readFileSync(join(outDir, filename));
const manifest = {
  version,
  filename,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byte_size: bytes.byteLength,
};
writeFileSync(join(outDir, "runner-tarball.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${filename} ${manifest.sha256} (${manifest.byte_size} bytes)\n`);
