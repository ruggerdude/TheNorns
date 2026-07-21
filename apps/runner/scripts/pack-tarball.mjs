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
//
// WHY NOT `bundledDependencies` (this is a REGRESSION GUARD, do not "simplify"
// it back): the first fix shipped `node_modules/@norns/contracts` inside the
// tarball and declared it in `bundledDependencies`. That install *succeeded*
// and the CLI still could not start. `@norns/contracts` needs `zod@^3`, while
// `@anthropic-ai/claude-agent-sdk` drags in `zod@4` and wins the top-level
// hoist, so npm has to place a second `zod@3` nested under `@norns/runner`.
// npm's reifier refuses to write inside a package that declares
// `bundledDependencies`: it creates `node_modules/@norns/runner/node_modules/
// zod` as an EMPTY DIRECTORY, `npm ls zod` claims it is there, and Node's
// resolver finds the empty directory first —
//   Error: Cannot find package '…/@norns/runner/node_modules/zod/index.js'
//     imported from '…/@norns/contracts/dist/plan.js'  (ERR_MODULE_NOT_FOUND)
// Every Actions-hosted run died at its first command.
//
// THE FIX: ship no nested package at all. The compiled contracts output is
// copied into the runner's OWN dist as a plain directory (`dist/_contracts/`)
// and every `@norns/contracts` specifier in the runner's compiled files is
// rewritten to a relative path. The tarball therefore contains no
// `node_modules/` and declares no `bundledDependencies`, so npm's reifier has
// no bundled package to refuse to write into. `zod` becomes an ordinary
// dependency of `@norns/runner` at the range `@norns/contracts` declares, and
// npm nests it the perfectly ordinary way — verified end to end by
// `apps/server/test/runnerTarballInstall.test.ts`, which really installs the
// tarball with npm and really executes the binary.
//
// Considered and rejected: vendoring `zod` itself into dist too (5 MB and a
// second specifier-rewrite surface, to replace an npm behaviour that is proven
// to work); realigning the workspace on zod 4 (large blast radius, and it makes
// the artefact no more structurally sound — the next conflicting transitive
// dependency reintroduces nesting).
//
// Output (all under apps/runner/dist-pack/):
//   norns-runner-<version>.tgz   the artifact the workflow downloads
//   runner-tarball.json          { version, filename, sha256, byte_size }
// The manifest is written *from the bytes actually produced*, so the hash the
// server publishes is by construction the hash of the file it serves.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

const stageDistDir = join(stageDir, "dist");
cpSync(join(runnerRoot, "dist"), stageDistDir, { recursive: true });

// The compiled contracts output travels INSIDE the runner's own dist, as a
// plain directory rather than a package. `_contracts` is prefixed so it can
// never collide with a module name the runner's own sources emit.
const INLINED_CONTRACTS_DIR = "_contracts";
const stageContractsDir = join(stageDistDir, INLINED_CONTRACTS_DIR);
cpSync(join(contractsRoot, "dist"), stageContractsDir, { recursive: true });
// Provenance: which contracts build these bytes came from. Not a package
// manifest — nothing resolves through it — so it cannot reintroduce nesting.
writeFileSync(
  join(stageContractsDir, "INLINED.json"),
  `${JSON.stringify(
    { source: contractsPkg.name, version: contractsPkg.version, inlined_by: "pack-tarball.mjs" },
    null,
    2,
  )}\n`,
);

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (entry.isFile()) yield path;
  }
}

/** `dist/runtimes/x.js` -> `../_contracts/index.js`; always POSIX, always relative. */
function contractsSpecifierFrom(file) {
  const target = join(stageContractsDir, "index.js");
  const rel = relative(dirname(file), target).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Rewrite every `@norns/contracts` module specifier in the runner's compiled
// output to the inlined copy. Only specifier positions are touched: a `from`
// clause, a dynamic `import(...)`, or a `require(...)`.
const CONTRACTS_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])@norns\/contracts\2/g;
let rewrittenFiles = 0;
for (const file of walkFiles(stageDistDir)) {
  if (file.startsWith(stageContractsDir + sep)) continue;
  if (!/\.(js|mjs|cjs|d\.ts|d\.mts|d\.cts|map)$/.test(file)) continue;
  const before = readFileSync(file, "utf8");
  if (!before.includes("@norns/contracts")) continue;
  const after = before.replace(CONTRACTS_SPECIFIER, `$1$2${contractsSpecifierFrom(file)}$2`);
  writeFileSync(file, after);
  rewrittenFiles += 1;
}

// Fail the build rather than ship an artefact that still needs a package npm
// will never place. This is the assertion the previous shape lacked.
const provenanceFile = join(stageContractsDir, "INLINED.json");
for (const file of walkFiles(stageDir)) {
  if (file === provenanceFile) continue; // records the source package by name
  if (!readFileSync(file, "utf8").includes("@norns/contracts")) continue;
  throw new Error(
    `staged tarball still references @norns/contracts in ${relative(stageDir, file)} — the inlining rewrite missed a specifier`,
  );
}
if (rewrittenFiles === 0) {
  throw new Error(
    "no @norns/contracts specifier was rewritten — the runner's compiled output changed shape and this script no longer inlines anything",
  );
}

// The published manifest. Note what is absent: `private`, `devDependencies`,
// every workspace: specifier — and, deliberately, `bundledDependencies` and any
// `@norns/contracts` entry at all. See the header comment: a bundled package is
// exactly what stopped npm from materialising the nested `zod@3` this needs.
const dependencies = {
  zod: contractsPkg.dependencies.zod,
};
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
