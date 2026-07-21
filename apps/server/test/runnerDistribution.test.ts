// EXECUTION E3 — the runner must actually be installable.
//
// The audit found that `npm install --global @norns/runner` could never have
// worked: apps/runner is private and unpublished, so every Actions job died at
// the install step. These tests cover the replacement end to end — the packed
// artifact, the route that serves it, and the workflow step that verifies it —
// and deliberately include a test that RUNS the packed CLI rather than
// asserting on a mock, because a tarball that merely exists is worthless.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORNS_WORKFLOW_VERSION,
  renderNornsAgentWorkflow,
} from "../src/integrations/actionsWorkflowTemplate.js";
import {
  RUNNER_TARBALL_DIR_ENV,
  RunnerTarballUnavailableError,
  formatRunnerTarballSpec,
  loadRunnerTarball,
  parseRunnerTarballSpec,
  runnerTarballPath,
} from "../src/integrations/runnerDistribution.js";
import { buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen } from "./helpers.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(serverRoot, "..", "..");
const runnerRoot = join(workspaceRoot, "apps", "runner");
const packDir = join(runnerRoot, "dist-pack");

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "norns-e3-"));
  temps.push(dir);
  return dir;
}

beforeAll(() => {
  // Build the artifact under test from the real workspace. `pnpm run test`
  // builds first, so dist/ exists for both the runner and contracts.
  execFileSync("node", [join(runnerRoot, "scripts", "pack-tarball.mjs")], { stdio: "pipe" });
}, 120_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  delete process.env[RUNNER_TARBALL_DIR_ENV];
});

describe("the packed runner tarball", () => {
  it("declares no workspace: specifier — the reason a naive pack would fail", () => {
    const tarball = loadRunnerTarball(packDir);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", join(packDir, tarball.filename), "package/package.json"], {
        encoding: "utf8",
      }),
    ) as { dependencies: Record<string, string>; bundledDependencies: string[]; private?: boolean };
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(`${name}@${range}`).not.toContain("workspace:");
    }
    // The workspace package travels inside the tarball instead.
    expect(manifest.bundledDependencies).toContain("@norns/contracts");
    expect(manifest.private).toBeUndefined();
  });

  it("physically contains the compiled contracts package it bundles", () => {
    const tarball = loadRunnerTarball(packDir);
    const entries = execFileSync("tar", ["-tzf", join(packDir, tarball.filename)], {
      encoding: "utf8",
    });
    expect(entries).toContain("package/dist/cli.js");
    expect(entries).toContain("package/node_modules/@norns/contracts/package.json");
    expect(entries).toContain("package/node_modules/@norns/contracts/dist/index.js");
  });

  // THE REAL-PATH TEST. Not a mock: this extracts the shipped artifact and
  // executes its CLI entry point on Node, proving the bundled contracts
  // package actually resolves at run time. The three registry dependencies are
  // linked in from the workspace because the sandbox has no network — that is
  // exactly what `npm install` would place in the same directory.
  it("runs its CLI when extracted, with the bundled contracts resolving", () => {
    const tarball = loadRunnerTarball(packDir);
    const dir = tempDir();
    execFileSync("tar", ["-xzf", join(packDir, tarball.filename), "-C", dir]);
    const nodeModules = join(dir, "package", "node_modules");
    for (const dep of ["@anthropic-ai", "@openai", "ws"]) {
      symlinkSync(join(runnerRoot, "node_modules", dep), join(nodeModules, dep));
    }
    // zod is a real dependency of the tarball; npm would hoist it here.
    const zod = dirname(
      execFileSync("node", ["-e", "process.stdout.write(require.resolve('zod/package.json'))"], {
        cwd: join(workspaceRoot, "packages", "contracts"),
        encoding: "utf8",
      }),
    );
    symlinkSync(zod, join(nodeModules, "zod"));

    const output = execFileSync("node", [join(dir, "package", "dist", "cli.js"), "help"], {
      encoding: "utf8",
    });
    expect(output).toContain("norns-runner — TheNorns Local Runner");
    expect(output).toContain("--ephemeral");
  });
});

describe("integrity: the server refuses to serve bytes that do not match its manifest", () => {
  it("loads a well-formed pack", () => {
    const tarball = loadRunnerTarball(packDir);
    expect(tarball.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(tarball.bytes).digest("hex")).toBe(tarball.sha256);
  });

  it("REFUSES a tarball whose content hash does not match the manifest", () => {
    const dir = tempDir();
    cpSync(packDir, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "runner-tarball.json"), "utf8")) as {
      filename: string;
    };
    // A swapped artifact: same name, same declared digest, different bytes.
    const tampered = Buffer.from(readFileSync(join(dir, manifest.filename)));
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    writeFileSync(join(dir, manifest.filename), tampered);
    expect(() => loadRunnerTarball(dir)).toThrow(RunnerTarballUnavailableError);
    expect(() => loadRunnerTarball(dir)).toThrow(/does not match its manifest/);
  });

  it("REFUSES when the manifest declares a different size than the bytes on disk", () => {
    const dir = tempDir();
    cpSync(packDir, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "runner-tarball.json"), "utf8")) as Record<
      string,
      unknown
    >;
    manifest.byte_size = (manifest.byte_size as number) + 1;
    writeFileSync(join(dir, "runner-tarball.json"), JSON.stringify(manifest));
    expect(() => loadRunnerTarball(dir)).toThrow(/does not match its manifest/);
  });

  it("REFUSES a missing or unparseable manifest instead of serving something arbitrary", () => {
    expect(() => loadRunnerTarball(tempDir())).toThrow(/no usable runner tarball manifest/);
  });

  it("REFUSES a manifest whose tarball file is absent", () => {
    const dir = tempDir();
    cpSync(packDir, dir, { recursive: true });
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".tgz")) rmSync(join(dir, entry));
    }
    expect(() => loadRunnerTarball(dir)).toThrow(/is missing from/);
  });
});

describe("the pinned spec", () => {
  it("round-trips version and digest as one inseparable token", () => {
    const tarball = loadRunnerTarball(packDir);
    const spec = formatRunnerTarballSpec(tarball);
    expect(parseRunnerTarballSpec(spec)).toEqual({
      version: tarball.version,
      sha256: tarball.sha256,
    });
  });

  it("rejects an npm-style spec — the shape that could never install", () => {
    expect(() => parseRunnerTarballSpec("@norns/runner@0.1.0")).toThrow(/invalid runner tarball/);
    expect(() => parseRunnerTarballSpec("0.1.0")).toThrow(/invalid runner tarball/);
    expect(() => parseRunnerTarballSpec(`0.1.0@sha256:${"A".repeat(64)}`)).toThrow(
      /invalid runner tarball/,
    );
    expect(() => parseRunnerTarballSpec(`0.1.0@sha256:${"a".repeat(63)}`)).toThrow(
      /invalid runner tarball/,
    );
  });
});

describe("the rendered workflow installs the pinned tarball and verifies it", () => {
  const template = {
    serverOrigin: "https://norns.example",
    runnerPackage: `1.2.3@sha256:${"b".repeat(64)}`,
  } as const;

  it("no longer installs from npm", () => {
    const rendered = renderNornsAgentWorkflow(template);
    expect(rendered).not.toContain('npm install --global --no-fund --no-audit "@norns/runner');
    expect(rendered).toContain("npm install --global --no-fund --no-audit ./norns-runner.tgz");
  });

  it("bakes the version-scoped URL and the digest into the committed file", () => {
    const rendered = renderNornsAgentWorkflow(template);
    expect(rendered).toContain(`https://norns.example${runnerTarballPath("1.2.3")}`);
    expect(rendered).toContain(`NORNS_RUNNER_TARBALL_SHA256: "${"b".repeat(64)}"`);
  });

  it("verifies the digest BEFORE installing, and fails the job on mismatch", () => {
    const rendered = renderNornsAgentWorkflow(template);
    const check = rendered.indexOf("sha256sum --check --strict");
    const install = rendered.indexOf(
      "npm install --global --no-fund --no-audit ./norns-runner.tgz",
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(install);
    // `set -e` is what turns a failed check into a failed job rather than a
    // logged warning followed by installing the wrong code anyway.
    expect(rendered).toContain("set -euo pipefail");
  });

  it("bumps the template version so every broken installed workflow is upgraded", () => {
    expect(NORNS_WORKFLOW_VERSION).toBeGreaterThanOrEqual(3);
    expect(renderNornsAgentWorkflow(template)).toContain(
      `# norns:workflow-version=${NORNS_WORKFLOW_VERSION}`,
    );
  });

  it("is still deterministic", () => {
    expect(renderNornsAgentWorkflow(template)).toBe(renderNornsAgentWorkflow(template));
  });
});

describe("GET /install/runner — the route the Actions job fetches", () => {
  it("serves the exact bytes the manifest advertises", async () => {
    process.env[RUNNER_TARBALL_DIR_ENV] = packDir;
    const server = await buildServer({ stores: new RelayStores(), users: new UserStore() });
    const url = await listen(server);
    try {
      const expected = loadRunnerTarball(packDir);

      const manifest = (await (await fetch(`${url}/install/runner/manifest.json`)).json()) as {
        version: string;
        sha256: string;
        url: string;
      };
      expect(manifest.sha256).toBe(expected.sha256);
      expect(manifest.url).toBe(runnerTarballPath(expected.version));

      const response = await fetch(`${url}${manifest.url}`);
      expect(response.status).toBe(200);
      const served = Buffer.from(await response.arrayBuffer());
      // The property that matters: what the job downloads hashes to what the
      // workflow file was pinned with.
      expect(createHash("sha256").update(served).digest("hex")).toBe(expected.sha256);
      expect(served.equals(expected.bytes)).toBe(true);
    } finally {
      await server.app.close();
    }
  });

  it("404s a version it does not have rather than serving a different build", async () => {
    process.env[RUNNER_TARBALL_DIR_ENV] = packDir;
    const server = await buildServer({ stores: new RelayStores(), users: new UserStore() });
    const url = await listen(server);
    try {
      const response = await fetch(`${url}${runnerTarballPath("99.99.99")}`);
      expect(response.status).toBe(404);
    } finally {
      await server.app.close();
    }
  });

  it("503s rather than serving an unverifiable artifact", async () => {
    process.env[RUNNER_TARBALL_DIR_ENV] = tempDir();
    const server = await buildServer({ stores: new RelayStores(), users: new UserStore() });
    const url = await listen(server);
    try {
      expect((await fetch(`${url}/install/runner/manifest.json`)).status).toBe(503);
    } finally {
      await server.app.close();
    }
  });
});
