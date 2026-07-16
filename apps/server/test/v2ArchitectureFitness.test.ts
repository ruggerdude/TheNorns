import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(serverRoot, "src");

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("V2 architecture fitness", () => {
  it("keeps raw Task and AgentRun lifecycle SQL inside the guarded adapter", async () => {
    const allowed = "persistence/v2/sqlRepositories.ts";
    const violations: string[] = [];
    const rawLifecycleUpdate =
      /\bUPDATE\s+(?:public\.)?(?:tasks|agent_runs)\b[\s\S]{0,500}?\bSET\b[\s\S]{0,350}?\b(?:state|lifecycle_version)\b/i;

    for (const path of await typescriptFiles(sourceRoot)) {
      const sourcePath = relative(sourceRoot, path);
      if (sourcePath === allowed) continue;
      const source = await readFile(path, "utf8");
      if (rawLifecycleUpdate.test(source)) violations.push(sourcePath);
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
