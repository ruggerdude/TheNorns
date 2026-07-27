import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  V2ImplementationCaptureProfile,
  type V2ImplementationCaptureProfileT,
} from "@norns/contracts";
import {
  RUNNER_AUTHORIZATION_SCHEME,
  RUNNER_ID_HEADER,
  RUNNER_TIMESTAMP_HEADER,
  type RunnerContextIdentity,
  runnerContextFetchPayload,
} from "./contextAuth.js";

const execFileAsync = promisify(execFile);

export const RUNNER_VISUAL_EVIDENCE_MANIFEST = ".norns/visual-evidence.json";

export interface RunnerVisualEvidenceScreenshot {
  viewport: "desktop" | "mobile";
  path: string;
  content_hash: string;
  width: number;
  height: number;
  bytes: Buffer;
}

export interface RunnerVisualEvidence {
  schema_version: 2;
  approved_mockup_version_id: string;
  commit_sha: string;
  capture_profile: V2ImplementationCaptureProfileT;
  screenshots: readonly [
    RunnerVisualEvidenceScreenshot & { viewport: "desktop" },
    RunnerVisualEvidenceScreenshot & { viewport: "mobile" },
  ];
}

export interface RunnerVisualEvidenceDeliveryScope {
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  repository_binding_id: string;
  verification_result_id: string;
  deployment_record_id: string;
  deployment_observation_id: string;
  verified_at: string;
}

interface VisualEvidenceManifestScreenshot {
  viewport: "desktop" | "mobile";
  path: string;
  content_hash: string;
}

interface VisualEvidenceManifest {
  schema_version: 2;
  approved_mockup_version_id: string;
  capture_profile: V2ImplementationCaptureProfileT;
  screenshots: readonly [VisualEvidenceManifestScreenshot, VisualEvidenceManifestScreenshot];
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRepositoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    isAbsolute(value) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return normalized;
}

function parseScreenshot(
  value: unknown,
  expectedViewport: "desktop" | "mobile",
): VisualEvidenceManifestScreenshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${expectedViewport} visual evidence must be an object`);
  }
  const object = value as Record<string, unknown>;
  exactKeys(object, ["viewport", "path", "content_hash"], `${expectedViewport} visual evidence`);
  if (object.viewport !== expectedViewport) {
    throw new Error("visual evidence screenshots must be ordered desktop then mobile");
  }
  if (typeof object.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(object.content_hash)) {
    throw new Error(`${expectedViewport} visual evidence requires a SHA-256 content hash`);
  }
  const expectedPath =
    expectedViewport === "desktop"
      ? ".norns/visual-evidence/desktop-1440x1024.png"
      : ".norns/visual-evidence/mobile-390x844.png";
  const repositoryPath = safeRepositoryPath(
    object.path,
    `${expectedViewport} visual evidence path`,
  );
  if (repositoryPath !== expectedPath) {
    throw new Error(`${expectedViewport} visual evidence path must be ${expectedPath}`);
  }
  return {
    viewport: expectedViewport,
    path: repositoryPath,
    content_hash: object.content_hash,
  };
}

function parseManifest(bytes: Buffer): VisualEvidenceManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("visual evidence manifest is not valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("visual evidence manifest must be an object");
  }
  const object = value as Record<string, unknown>;
  exactKeys(
    object,
    ["schema_version", "approved_mockup_version_id", "capture_profile", "screenshots"],
    "visual evidence manifest",
  );
  if (object.schema_version !== 2) throw new Error("visual evidence schema_version must be 2");
  if (
    typeof object.approved_mockup_version_id !== "string" ||
    object.approved_mockup_version_id.trim().length === 0
  ) {
    throw new Error("visual evidence requires an approved mockup version");
  }
  if (!Array.isArray(object.screenshots) || object.screenshots.length !== 2) {
    throw new Error("visual evidence requires exactly desktop and mobile screenshots");
  }
  return {
    schema_version: 2,
    approved_mockup_version_id: object.approved_mockup_version_id,
    capture_profile: V2ImplementationCaptureProfile.parse(object.capture_profile),
    screenshots: [
      parseScreenshot(object.screenshots[0], "desktop"),
      parseScreenshot(object.screenshots[1], "mobile"),
    ],
  };
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, signature.length).equals(signature) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("visual evidence content is not a PNG image");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("visual evidence PNG has invalid dimensions");
  return { width, height };
}

async function assertNoSymlinkHop(worktreePath: string, repositoryPath: string): Promise<void> {
  const root = await realpath(worktreePath);
  const absolute = resolve(root, repositoryPath);
  const child = relative(root, absolute);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("visual evidence path escapes the worktree");
  }
  let cursor = root;
  for (const component of repositoryPath.split("/")) {
    cursor = resolve(cursor, component);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("visual evidence path contains a symbolic link");
  }
  const physical = await realpath(absolute);
  if (physical !== absolute) throw new Error("visual evidence path resolves through an alias");
}

async function committedBlob(
  worktreePath: string,
  commit: string,
  repositoryPath: string,
): Promise<Buffer> {
  await assertNoSymlinkHop(worktreePath, repositoryPath);
  const tree = await execFileAsync(
    "git",
    ["-C", worktreePath, "ls-tree", commit, "--", repositoryPath],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  const match = tree.stdout.trim().match(/^([0-9]{6}) blob ([a-f0-9]+)\t(.+)$/);
  if (!match || match[1] !== "100644" || match[3] !== repositoryPath) {
    throw new Error("visual evidence path is not an ordinary file in the verified commit");
  }
  const shown = await execFileAsync(
    "git",
    ["-C", worktreePath, "show", `${commit}:${repositoryPath}`],
    {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return Buffer.from(shown.stdout);
}

/**
 * Validates the agent-produced side channel against Git, not mutable workspace
 * bytes. Nothing is accepted from another commit, an untracked path, or a
 * symbolic link.
 */
export async function readRunnerVisualEvidence(input: {
  worktree_path: string;
  expected_commit: string;
  manifest_path?: string;
}): Promise<RunnerVisualEvidence> {
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expected_commit)) {
    throw new Error("visual evidence expected_commit must be a full Git commit SHA");
  }
  const head = (
    await execFileAsync("git", ["-C", input.worktree_path, "rev-parse", "HEAD"], {
      encoding: "utf8",
    })
  ).stdout.trim();
  if (head !== input.expected_commit) {
    throw new Error("visual evidence worktree HEAD is not the verified commit");
  }
  const manifestPath = safeRepositoryPath(
    input.manifest_path ?? RUNNER_VISUAL_EVIDENCE_MANIFEST,
    "visual evidence manifest path",
  );
  const manifest = parseManifest(
    await committedBlob(input.worktree_path, input.expected_commit, manifestPath),
  );
  const screenshots: RunnerVisualEvidenceScreenshot[] = [];
  for (const [index, screenshot] of manifest.screenshots.entries()) {
    const bytes = await committedBlob(input.worktree_path, input.expected_commit, screenshot.path);
    if (sha256(bytes) !== screenshot.content_hash) {
      throw new Error(`${screenshot.viewport} visual evidence content hash does not match`);
    }
    const dimensions = pngDimensions(bytes);
    const expected = index === 0 ? { width: 1440, height: 1024 } : { width: 390, height: 844 };
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      throw new Error(
        `${screenshot.viewport} visual evidence must be ${expected.width}x${expected.height}`,
      );
    }
    screenshots.push({ ...screenshot, ...dimensions, bytes });
  }
  return {
    ...manifest,
    commit_sha: input.expected_commit,
    screenshots: [
      screenshots[0] as RunnerVisualEvidenceScreenshot & { viewport: "desktop" },
      screenshots[1] as RunnerVisualEvidenceScreenshot & { viewport: "mobile" },
    ],
  };
}

/**
 * Authenticated transport for evidence that has already passed the committed
 * path checks above. The server repeats byte, PNG, project, run, verification,
 * deployment, and approved-mockup validation before committing anything.
 */
export class RunnerVisualEvidenceUploader {
  private readonly origin: URL;

  constructor(
    serverUrl: string,
    private readonly identity: RunnerContextIdentity,
    private readonly now: () => Date = () => new Date(),
    private readonly httpFetch: typeof fetch = fetch,
  ) {
    this.origin = new URL(serverUrl);
    const local = this.origin.hostname === "localhost" || this.origin.hostname === "127.0.0.1";
    if (this.origin.protocol !== "https:" && !(local && this.origin.protocol === "http:")) {
      throw new Error("visual evidence server URL must use HTTPS");
    }
  }

  async upload(
    evidence: RunnerVisualEvidence,
    scope: RunnerVisualEvidenceDeliveryScope,
  ): Promise<unknown> {
    if (scope.project_id.trim().length === 0)
      throw new Error("visual evidence project is required");
    const path = `/api/runner/v2/projects/${encodeURIComponent(scope.project_id)}/visual-evidence`;
    const issuedAt = this.now().toISOString();
    const signature = this.identity.sign(
      runnerContextFetchPayload({
        method: "POST",
        path,
        runnerId: this.identity.runnerId,
        issuedAt,
      }),
    );
    const response = await this.httpFetch(new URL(path, this.origin), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `${RUNNER_AUTHORIZATION_SCHEME} ${signature}`,
        [RUNNER_ID_HEADER]: this.identity.runnerId,
        [RUNNER_TIMESTAMP_HEADER]: issuedAt,
      },
      body: JSON.stringify({
        work_item_id: scope.work_item_id,
        conversation_id: scope.conversation_id,
        phase_id: scope.phase_id,
        task_id: scope.task_id,
        run_id: scope.run_id,
        approved_mockup_version_id: evidence.approved_mockup_version_id,
        repository_binding_id: scope.repository_binding_id,
        verification_result_id: scope.verification_result_id,
        deployment_record_id: scope.deployment_record_id,
        deployment_observation_id: scope.deployment_observation_id,
        commit_sha: evidence.commit_sha,
        capture_profile: evidence.capture_profile,
        verified_at: scope.verified_at,
        desktop_png_base64: evidence.screenshots[0].bytes.toString("base64"),
        mobile_png_base64: evidence.screenshots[1].bytes.toString("base64"),
      }),
    });
    if (!response.ok) {
      throw new Error(`visual evidence upload failed with ${response.status}`);
    }
    return response.json();
  }
}
