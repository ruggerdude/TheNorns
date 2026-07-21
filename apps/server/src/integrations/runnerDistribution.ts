// EXECUTION E3 — serving the Norns runner to an ephemeral GitHub Actions job.
//
// WHY NOT npm: the workflow previously ran `npm install --global @norns/runner`
// against a package that is `"private": true` and has never been published.
// The job died at the install step. The decision was to serve a versioned
// tarball from the Norns server rather than publish, for two reasons:
//   * runner and server ship from one build, so a runner can never speak a
//     protocol version its relay does not understand;
//   * there is no third party in the trust path — the same origin that holds
//     the relay, and that the workflow already trusts with its enrollment
//     secret, is the origin that serves the code.
//
// INTEGRITY: publishing a URL is not enough. A tarball swapped in transit or at
// rest would execute with the job's GITHUB_TOKEN and the enrollment secret in
// its environment. So the artifact is pinned by version AND content hash: the
// dispatch bakes a sha256 into the committed workflow file, and the job refuses
// to install a tarball whose hash differs. This module is the server half of
// that promise — it refuses to advertise a hash it is not actually serving, by
// re-hashing the bytes on disk at load time instead of trusting the manifest.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Written by apps/runner/scripts/pack-tarball.mjs alongside the tarball. */
const RunnerTarballManifest = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
    filename: z.string().regex(/^norns-runner-[\w.-]+\.tgz$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byte_size: z.number().int().positive(),
  })
  .strict();
export type RunnerTarballManifestT = z.infer<typeof RunnerTarballManifest>;

export interface RunnerTarball extends RunnerTarballManifestT {
  /** The verified bytes, held once so every request serves the hashed artifact. */
  readonly bytes: Buffer;
}

export const RUNNER_TARBALL_DIR_ENV = "NORNS_RUNNER_TARBALL_DIR";
const MANIFEST_FILENAME = "runner-tarball.json";

/**
 * Where the packed tarball lives. A deployment that stages the artifact
 * elsewhere (a Docker image layer, a mounted volume) sets the env var; the
 * default resolves apps/runner/dist-pack relative to this compiled module, so a
 * checkout that has run `pnpm run build && pnpm --filter @norns/runner
 * pack:tarball` works with no configuration.
 */
export function defaultRunnerTarballDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[RUNNER_TARBALL_DIR_ENV];
  if (configured) return resolve(configured);
  // .../apps/server/dist/integrations/ -> .../apps/runner/dist-pack
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "runner", "dist-pack");
}

export class RunnerTarballUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunnerTarballUnavailableError";
  }
}

/**
 * Load and VERIFY the packed runner.
 *
 * The manifest is treated as a claim, not as truth: the tarball is re-hashed
 * and the declared size re-checked. A mismatch throws rather than serving,
 * because the alternative is publishing a hash into a user's repository that
 * does not match the bytes their CI will download — which would turn the
 * integrity check into a guaranteed, confusing job failure at best, and at
 * worst paper over a tampered artifact.
 */
export function loadRunnerTarball(directory: string): RunnerTarball {
  let manifest: RunnerTarballManifestT;
  try {
    manifest = RunnerTarballManifest.parse(
      JSON.parse(readFileSync(join(directory, MANIFEST_FILENAME), "utf8")),
    );
  } catch (error) {
    throw new RunnerTarballUnavailableError(
      `no usable runner tarball manifest in ${directory} — run \`pnpm --filter @norns/runner pack:tarball\``,
      { cause: error },
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(directory, manifest.filename));
  } catch (error) {
    throw new RunnerTarballUnavailableError(
      `runner tarball ${manifest.filename} is missing from ${directory}`,
      { cause: error },
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== manifest.sha256 || bytes.byteLength !== manifest.byte_size) {
    throw new RunnerTarballUnavailableError(
      `runner tarball ${manifest.filename} does not match its manifest (refusing to serve)`,
    );
  }
  return { ...manifest, bytes };
}

// ---------------------------------------------------------------------------
// The workflow's pinned spec
// ---------------------------------------------------------------------------

/**
 * The single opaque token threaded to the workflow template, e.g.
 * `0.1.0@sha256:7c38…`. One token rather than two fields so that a version and
 * the hash it was pinned with cannot be recombined by accident anywhere along
 * the way — they travel and are validated together.
 */
export const RUNNER_TARBALL_SPEC_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?@sha256:[0-9a-f]{64}$/;

export function formatRunnerTarballSpec(manifest: {
  version: string;
  sha256: string;
}): string {
  const spec = `${manifest.version}@sha256:${manifest.sha256}`;
  if (!RUNNER_TARBALL_SPEC_PATTERN.test(spec)) {
    throw new Error(`refusing to publish an unparseable runner tarball spec: ${spec}`);
  }
  return spec;
}

export function parseRunnerTarballSpec(spec: string): { version: string; sha256: string } {
  if (!RUNNER_TARBALL_SPEC_PATTERN.test(spec)) {
    throw new Error(`invalid runner tarball spec: ${JSON.stringify(spec)}`);
  }
  const [version, digest] = spec.split("@sha256:");
  return { version: version as string, sha256: digest as string };
}

/** The path the workflow downloads from. Version-scoped so it is immutable. */
export function runnerTarballPath(version: string): string {
  return `/install/runner/${version}/norns-runner.tgz`;
}
