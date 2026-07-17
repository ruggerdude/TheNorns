import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(serverRoot, "src");
const workspaceRoot = join(serverRoot, "..", "..");
const workspaceSourceRoots = [join(workspaceRoot, "apps"), join(workspaceRoot, "packages")];
const ignoredDirectories = new Set(["dist", "node_modules", "test", "coverage"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const rawLifecycleUpdate =
  /\bUPDATE\s+(?:public\.)?(?:tasks|agent_runs)\b[\s\S]{0,500}?\bSET\b[\s\S]{0,350}?\b(?:state|lifecycle_version)\b/i;
const drizzleLifecycleUpdate =
  /\.update\s*\(\s*(?:tasks|agentRuns)\s*\)[\s\S]{0,350}?\.set\s*\([\s\S]{0,250}?\b(?:state|lifecycleVersion)\b/i;

function containsLifecycleBypass(source: string): boolean {
  return rawLifecycleUpdate.test(source) || drizzleLifecycleUpdate.test(source);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name) ? [] : sourceFiles(path);
      }
      return entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("V2 architecture fitness", () => {
  it("keeps raw Task and AgentRun lifecycle SQL inside the guarded adapter", async () => {
    const allowed = "apps/server/src/persistence/v2/sqlRepositories.ts";
    const violations: string[] = [];

    const files = (await Promise.all(workspaceSourceRoots.map(sourceFiles))).flat();
    for (const path of files) {
      const sourcePath = relative(workspaceRoot, path);
      if (sourcePath === allowed) continue;
      const source = await readFile(path, "utf8");
      if (containsLifecycleBypass(source)) {
        violations.push(sourcePath);
      }
    }

    expect(violations).toEqual([]);
  });

  it("recognizes raw and Drizzle lifecycle bypass fixtures", () => {
    expect(containsLifecycleBypass("UPDATE tasks SET lifecycle_version = 2 WHERE id = $1")).toBe(
      true,
    );
    expect(containsLifecycleBypass("db.update(tasks).set({ state: 'in_progress' })")).toBe(true);
    expect(containsLifecycleBypass("db.update(projects).set({ status: 'paused' })")).toBe(false);
  });

  it("does not export the mutable Drizzle table set from public server entrypoints", async () => {
    const publicEntrypoints = [
      join(sourceRoot, "index.ts"),
      join(sourceRoot, "persistence/index.ts"),
    ];
    for (const path of publicEntrypoints) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("v2/schema.js");
    }
  });

  it("keeps direct V2 schema imports inside the guarded SQL adapter", async () => {
    const allowed = "apps/server/src/persistence/v2/sqlRepositories.ts";
    const violations: string[] = [];
    const files = (await Promise.all(workspaceSourceRoots.map(sourceFiles))).flat();
    for (const path of files) {
      const sourcePath = relative(workspaceRoot, path);
      if (sourcePath === allowed) continue;
      const source = await readFile(path, "utf8");
      if (/\bfrom\s+["'][^"']*(?:\/|\.)schema\.js["']/.test(source)) {
        violations.push(sourcePath);
      }
    }

    expect(violations).toEqual([]);
  });

  it("routes the lifecycle chokepoint through the reconciliation quarantine", async () => {
    const source = await readFile(join(sourceRoot, "persistence/v2/lifecycleMutation.ts"), "utf8");
    expect(source).toContain('assertV2AutomationAllowed(tx, "task"');
    expect(source).toContain('assertV2AutomationAllowed(tx, "agent_run"');
    expect(source).toContain("commitTaskLifecycleTransition");
    expect(source).toContain("commitAgentRunLifecycleTransition");
  });
});
