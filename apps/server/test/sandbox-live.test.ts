// ADR-003 sandbox — real Docker integration. Docker became available on the
// dev machine for the first time on 2026-07-14 (previously sandbox.test.ts
// only proved argument construction and the fail-closed path against a fake
// probe). This file proves the actual security properties hold against a
// real container runtime: isolated execution, a genuinely writable worktree
// mount, genuinely enforced read-only mounts, and genuinely denied network —
// not just that the right flags appear in a string. Closes NORN-032's gated
// "live sandbox-escape" remainder. Skips cleanly wherever Docker isn't
// installed (same pattern as the live-provider smoke tests).
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerProbe,
  SandboxLauncher,
  type SandboxSpec,
  SandboxUnavailableError,
} from "../src/engine/sandbox.js";

const execFileAsync = promisify(execFile);
const IMAGE = "alpine:3.20";

const probe = new DockerProbe();
const dockerStatus = await probe.available();
if (dockerStatus.ok) {
  // Pull once up front so individual test timeouts aren't spent downloading.
  await execFileAsync("docker", ["pull", IMAGE], { timeout: 60_000 }).catch(() => {});
}

let worktree = "";
let scratch = "";

async function makeDirs(): Promise<void> {
  worktree = await mkdtemp(join(tmpdir(), "norns-sandbox-wt-"));
  scratch = await mkdtemp(join(tmpdir(), "norns-sandbox-scratch-"));
  // GitHub-hosted Docker may map container root to an unprivileged host UID.
  // These are isolated disposable fixtures; make the intended writable bind
  // mounts writable independent of host/container UID mapping.
  await Promise.all([chmod(worktree, 0o777), chmod(scratch, 0o777)]);
}

describe("ADR-003 sandbox — real Docker", () => {
  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it.skipIf(!dockerStatus.ok)(
    "runs a real command in an isolated container and returns real output",
    async () => {
      await makeDirs();
      const launcher = new SandboxLauncher(probe);
      const spec: SandboxSpec = {
        worktreePath: worktree,
        scratchPath: scratch,
        image: IMAGE,
        env: {},
        command: ["sh", "-c", "echo sandboxed-$(id -u)"],
      };
      const result = await launcher.launch(spec);
      expect(result.stdout.trim()).toBe("sandboxed-0"); // root inside the container's own namespace
    },
    30_000,
  );

  it.skipIf(!dockerStatus.ok)(
    "the worktree bind mount is real: writes inside the container land on the host",
    async () => {
      await makeDirs();
      const launcher = new SandboxLauncher(probe);
      const spec: SandboxSpec = {
        worktreePath: worktree,
        scratchPath: scratch,
        image: IMAGE,
        env: {},
        command: ["sh", "-c", "echo proof-of-mount > /worktree/proof.txt"],
      };
      await launcher.launch(spec);
      const content = await readFile(join(worktree, "proof.txt"), "utf8");
      expect(content.trim()).toBe("proof-of-mount");
    },
    30_000,
  );

  it.skipIf(!dockerStatus.ok)(
    "read-only mounts actually reject writes, not just in the arg string",
    async () => {
      await makeDirs();
      const roDir = await mkdtemp(join(tmpdir(), "norns-sandbox-ro-"));
      try {
        // Host permissions allow writes so the failure below proves Docker's
        // read-only mount enforcement rather than an owner-only temp mode.
        await chmod(roDir, 0o777);
        const launcher = new SandboxLauncher(probe);
        const spec: SandboxSpec = {
          worktreePath: worktree,
          scratchPath: scratch,
          image: IMAGE,
          env: {},
          readOnlyMounts: { [roDir]: "/config" },
          command: ["sh", "-c", "echo nope > /config/should-fail.txt"],
        };
        await expect(launcher.launch(spec)).rejects.toThrow();
      } finally {
        await rm(roDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!dockerStatus.ok)(
    "network is actually denied, not just declared: no interface reaches the outside",
    async () => {
      await makeDirs();
      const launcher = new SandboxLauncher(probe);
      const spec: SandboxSpec = {
        worktreePath: worktree,
        scratchPath: scratch,
        image: IMAGE,
        env: {},
        command: ["sh", "-c", "wget -T 3 -q -O - http://1.1.1.1 || echo NETWORK_BLOCKED"],
      };
      const result = await launcher.launch(spec);
      expect(result.stdout.trim()).toBe("NETWORK_BLOCKED");
    },
    30_000,
  );

  it("still fails closed when the substrate reports unavailable — a real launcher, a real spec, only the probe is faked", async () => {
    await makeDirs();
    const launcher = new SandboxLauncher({
      available: async () => ({ ok: false, detail: "simulated: daemon down" }),
    });
    await expect(
      launcher.launch({
        worktreePath: worktree,
        scratchPath: scratch,
        image: IMAGE,
        env: {},
        command: ["true"],
      }),
    ).rejects.toThrow(SandboxUnavailableError);
  });
});
