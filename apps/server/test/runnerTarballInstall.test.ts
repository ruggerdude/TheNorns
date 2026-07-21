// EXECUTION E3 — the test that would have caught B1.
//
// `runnerDistribution.test.ts` verifies the tarball's manifest, its hash, the
// route that serves it, and even extracts it and runs the CLI — but it extracts
// with `tar` and hand-symlinks the dependencies npm "would have placed". That
// is precisely the assumption that was false: npm installed the artefact
// successfully and then created
// `node_modules/@norns/runner/node_modules/zod` as an EMPTY DIRECTORY (its
// reifier will not write inside a package declaring `bundledDependencies`), so
// every GitHub-Actions-hosted run died on ERR_MODULE_NOT_FOUND before printing
// a single line of its own output. CI was green throughout.
//
// So this file does the only thing that could have caught it: it runs the real
// `npm install`, in the exact mode `actionsWorkflowTemplate.ts` uses
// (`npm install --global --no-fund --no-audit ./norns-runner.tgz`), and then
// executes the installed `norns-runner` binary by name, as the workflow's
// "Run the dispatched Norns job" step does.
//
// It needs the network, because that is the point — the three registry
// dependencies and their transitive trees are what create the zod version
// conflict this artefact has to survive. It is NOT skipped by default: a test
// that skips itself is how the defect reached production. Set
// NORNS_SKIP_TARBALL_INSTALL_TEST=1 to opt out while working offline; CI does
// not set it, so CI always runs it.
import { execFileSync } from "node:child_process";
import {
  type Dirent,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRunnerTarball } from "../src/integrations/runnerDistribution.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(serverRoot, "..", "..");
const runnerRoot = join(workspaceRoot, "apps", "runner");
const packDir = join(runnerRoot, "dist-pack");

const skip = process.env.NORNS_SKIP_TARBALL_INSTALL_TEST === "1";

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "norns-tarball-install-"));
  temps.push(dir);
  return dir;
}

beforeAll(() => {
  execFileSync("node", [join(runnerRoot, "scripts", "pack-tarball.mjs")], { stdio: "pipe" });
}, 180_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Every `node_modules/zod` under the install root, with whether it has content. */
function zodCopies(root: string): { path: string; populated: boolean; version: string | null }[] {
  const found: { path: string; populated: boolean; version: string | null }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "zod" && dir.endsWith("node_modules")) {
        const manifest = join(path, "package.json");
        const populated = existsSync(manifest);
        found.push({
          path,
          populated,
          version: populated
            ? ((JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version ?? null)
            : null,
        });
        continue;
      }
      walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

describe.skipIf(skip)("the built runner tarball installs with npm and then actually runs", () => {
  it("ships no bundled package and no node_modules — the shape that could not install", () => {
    const tarball = loadRunnerTarball(packDir);
    const entries = execFileSync("tar", ["-tzf", join(packDir, tarball.filename)], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(entries.filter((entry) => entry.includes("node_modules"))).toEqual([]);

    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", join(packDir, tarball.filename), "package/package.json"], {
        encoding: "utf8",
      }),
    ) as { dependencies: Record<string, string>; bundledDependencies?: string[] };
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.dependencies["@norns/contracts"]).toBeUndefined();
    // The contracts code travels inlined in the runner's own dist instead.
    expect(entries).toContain("package/dist/_contracts/index.js");
    // zod stays an ordinary registry dependency; npm nests it the normal way.
    expect(manifest.dependencies.zod).toMatch(/^\^?3\./);
  });

  it(
    "installs --global exactly as the Actions workflow does, and the binary runs",
    { timeout: 600_000 },
    () => {
      const tarball = loadRunnerTarball(packDir);
      const dir = tempDir();
      const prefix = join(dir, "prefix");
      // Same filename and same flags as the rendered workflow's install step.
      copyFileSync(join(packDir, tarball.filename), join(dir, "norns-runner.tgz"));
      execFileSync(
        "npm",
        [
          "install",
          "--global",
          "--prefix",
          prefix,
          "--no-fund",
          "--no-audit",
          "./norns-runner.tgz",
        ],
        { cwd: dir, stdio: "pipe", timeout: 480_000 },
      );

      // The corpse B1 left behind: an empty `zod` directory npm claimed to have
      // installed. Assert on it directly so a regression names itself instead
      // of surfacing as an opaque ERR_MODULE_NOT_FOUND.
      const copies = zodCopies(join(prefix, "lib", "node_modules"));
      expect(copies.length).toBeGreaterThan(0);
      for (const copy of copies) {
        expect(copy.populated, `npm left an empty zod directory at ${copy.path}`).toBe(true);
      }
      // Something satisfying zod@3 must be present for the inlined contracts.
      expect(copies.some((copy) => copy.version?.startsWith("3."))).toBe(true);

      // Run the INSTALLED BIN by name — the workflow calls `norns-runner`, not
      // a path into dist. This loads the whole import graph (contracts, zod,
      // both agent SDKs, ws); B1 died here.
      const output = execFileSync(join(prefix, "bin", "norns-runner"), ["--help"], {
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(output).toContain("norns-runner — TheNorns Local Runner");
      expect(output).toContain("--ephemeral");

      // And the real dispatch invocation shape must fail on missing
      // configuration, never on module resolution.
      let stderr = "";
      try {
        execFileSync(
          join(prefix, "bin", "norns-runner"),
          ["start", "--ephemeral", "--id", "runner-test", "--job", "job-test", "--run", "run-test"],
          { encoding: "utf8", timeout: 120_000, stdio: "pipe" },
        );
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? "");
      }
      expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(stderr).not.toContain("Cannot find package");
      expect(stderr).toContain("--server");
    },
  );
});
