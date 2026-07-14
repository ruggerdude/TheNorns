// ADR-003: fail-closed is the contract — no sandbox substrate, no run,
// no unsandboxed fallback. Argument construction encodes the sandbox policy.
import { describe, expect, it } from "vitest";
import {
  SandboxLauncher,
  type SandboxSpec,
  SandboxUnavailableError,
  buildDockerArgs,
} from "../src/engine/sandbox.js";

const spec: SandboxSpec = {
  worktreePath: "/tmp/wt",
  scratchPath: "/tmp/scratch",
  image: "node:24-slim",
  env: { NODE_ENV: "test" },
  readOnlyMounts: { "/tmp/shared-config": "/config" },
  command: ["node", "--version"],
};

describe("sandbox launcher", () => {
  it("fails closed when the substrate is unavailable", async () => {
    const launcher = new SandboxLauncher({
      available: async () => ({ ok: false, detail: "docker daemon not running" }),
    });
    await expect(launcher.launch(spec)).rejects.toThrow(SandboxUnavailableError);
  });

  it("encodes the sandbox policy in the container args", () => {
    const args = buildDockerArgs(spec);
    const joined = args.join(" ");
    expect(joined).toContain("--network none"); // deny-by-default egress
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("no-new-privileges");
    expect(joined).toContain("--pids-limit 256");
    expect(joined).toContain("source=/tmp/wt,target=/worktree"); // writable worktree
    expect(joined).toContain("source=/tmp/shared-config,target=/config,readonly");
    expect(joined).toContain("--env NODE_ENV=test"); // explicit allowlist only
    expect(args.at(-2)).toBe("node");
    expect(args.at(-1)).toBe("--version");
  });
});
