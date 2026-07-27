import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readRunnerVisualEvidence } from "../../runner/src/visualEvidence.js";

const execFileAsync = promisify(execFile);

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Phase 6 runner visual evidence", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads only exact committed ordinary PNG blobs at both fixed viewports", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "norns-visual-evidence-"));
    cleanup.push(repository);
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@norns.invalid"]);
    await mkdir(resolve(repository, ".norns/visual-evidence"), { recursive: true });
    const desktop = png(1440, 1024);
    const mobile = png(390, 844);
    await writeFile(resolve(repository, ".norns/visual-evidence/desktop-1440x1024.png"), desktop);
    await writeFile(resolve(repository, ".norns/visual-evidence/mobile-390x844.png"), mobile);
    await writeFile(
      resolve(repository, ".norns/visual-evidence.json"),
      JSON.stringify({
        schema_version: 2,
        approved_mockup_version_id: "mockup-version:approved",
        capture_profile: {
          renderer: "playwright",
          browser_name: "chromium",
          browser_version: "123.0.0",
          font_revision: "a".repeat(64),
          pixel_ratio: 1,
          network: "application_only",
          locale: "en-US",
          timezone: "UTC",
          fixed_clock: "2026-07-27T12:00:00.000Z",
        },
        screenshots: [
          {
            viewport: "desktop",
            path: ".norns/visual-evidence/desktop-1440x1024.png",
            content_hash: hash(desktop),
          },
          {
            viewport: "mobile",
            path: ".norns/visual-evidence/mobile-390x844.png",
            content_hash: hash(mobile),
          },
        ],
      }),
    );
    await execFileAsync("git", ["-C", repository, "add", ".norns"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "add visual evidence"]);
    const commit = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" })
    ).stdout.trim();

    const evidence = await readRunnerVisualEvidence({
      worktree_path: repository,
      expected_commit: commit,
    });

    expect(evidence.commit_sha).toBe(commit);
    expect(evidence.approved_mockup_version_id).toBe("mockup-version:approved");
    expect(
      evidence.screenshots.map(({ viewport, width, height }) => ({ viewport, width, height })),
    ).toEqual([
      { viewport: "desktop", width: 1440, height: 1024 },
      { viewport: "mobile", width: 390, height: 844 },
    ]);
  });

  it("rejects a mutable working-tree symlink even when Git still has an ordinary blob", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "norns-visual-evidence-link-"));
    cleanup.push(repository);
    await execFileAsync("git", ["init", "-q", repository]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@norns.invalid"]);
    await mkdir(resolve(repository, ".norns/visual-evidence"), { recursive: true });
    const desktop = png(1440, 1024);
    const mobile = png(390, 844);
    await writeFile(resolve(repository, ".norns/visual-evidence/desktop-1440x1024.png"), desktop);
    await writeFile(resolve(repository, ".norns/visual-evidence/mobile-390x844.png"), mobile);
    await writeFile(
      resolve(repository, ".norns/visual-evidence.json"),
      JSON.stringify({
        schema_version: 2,
        approved_mockup_version_id: "mockup-version:approved",
        capture_profile: {
          renderer: "playwright",
          browser_name: "chromium",
          browser_version: "123.0.0",
          font_revision: "b".repeat(64),
          pixel_ratio: 1,
          network: "application_only",
          locale: "en-US",
          timezone: "UTC",
          fixed_clock: "2026-07-27T12:00:00.000Z",
        },
        screenshots: [
          {
            viewport: "desktop",
            path: ".norns/visual-evidence/desktop-1440x1024.png",
            content_hash: hash(desktop),
          },
          {
            viewport: "mobile",
            path: ".norns/visual-evidence/mobile-390x844.png",
            content_hash: hash(mobile),
          },
        ],
      }),
    );
    await execFileAsync("git", ["-C", repository, "add", ".norns"]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "add visual evidence"]);
    const commit = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" })
    ).stdout.trim();
    await rm(resolve(repository, ".norns/visual-evidence/mobile-390x844.png"));
    await symlink(
      "desktop-1440x1024.png",
      resolve(repository, ".norns/visual-evidence/mobile-390x844.png"),
    );

    await expect(
      readRunnerVisualEvidence({ worktree_path: repository, expected_commit: commit }),
    ).rejects.toThrow(/symbolic link/);
  });
});
