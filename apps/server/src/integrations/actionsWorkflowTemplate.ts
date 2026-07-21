// ONBOARDING O4 — the GitHub Actions workflow Norns commits into the user's
// repository, as a template asset.
//
// WHY THIS EXISTS: the human refuses any Norns software installed or running on
// their machine. Execution therefore moves to GitHub Actions. This file does
// NOT introduce a new execution architecture — the workflow it renders installs
// and starts the *existing* Norns runner (apps/runner: relay protocol, Ed25519
// pairing, generation fencing, command dedup, buffered replay, Phase 4 dispatch
// integration) ephemerally inside an Actions job. The runner dials the relay
// outbound exactly as a laptop runner does, executes its one dispatched job,
// and evaporates when the job ends.
//
// ADR-003 (execution sandbox) note — the Actions job IS the isolation boundary.
// ADR-003 mandates a disposable OCI container per coding run because a worktree
// on a developer's laptop shares a filesystem, network, and credential store
// with the human's real life. An Actions job supplies that boundary at a
// different layer and, for this deployment, a stronger one:
//   * the VM is created for this job and destroyed with it — there is no
//     persistent $HOME, no SSH key, no browser profile, no cloud credential
//     file, and no sibling process belonging to the user;
//   * the filesystem contains only the checked-out repository and the runner;
//   * the only ambient credential is GITHUB_TOKEN, which GitHub already scopes
//     to this one repository and expires when the job ends;
//   * the wall-clock ceiling is enforced by `timeout-minutes`, and cgroup-style
//     resource limits are enforced by the hosted runner itself.
// What the Actions job does NOT reproduce is ADR-003's deny-by-default egress
// policy: a hosted runner has open outbound internet. That is a genuine
// widening relative to the container posture and is recorded as such — the
// compensating controls are that the blast radius is a disposable VM holding
// one repository and one repository-scoped token, and that the repository
// content is already the user's own.
//
// ADR-006 note — "the server executes no repository shell commands" still
// holds. The server writes a workflow file and triggers it; every git, build,
// and test command runs runner-side, inside the job.
import {
  RUNNER_TARBALL_SPEC_PATTERN,
  parseRunnerTarballSpec,
  runnerTarballPath,
} from "./runnerDistribution.js";

/**
 * Bumped whenever the rendered workflow changes in a way an already-installed
 * repository should receive. `installNornsAgentWorkflow` upgrades in place when
 * the committed file declares a lower version.
 */
// v2: env-indirection for every workflow_dispatch input (a dispatcher could
// previously inject shell through `${{ inputs.* }}` inside `run:` and
// exfiltrate the enrollment secret), an explicit approved-roots allowlist
// without which the runner could not execute at all, and an exact delimited
// run-name marker. Every already-installed v1 file is upgraded in place.
// v3 (EXECUTION E3): the runner is installed from a version-pinned,
// sha256-verified tarball served by the Norns server instead of
// `npm install --global @norns/runner`, which could never have worked — the
// package is private and unpublished. Every already-installed v1/v2 file is
// upgraded in place, because every one of them is currently broken.
export const NORNS_WORKFLOW_VERSION = 3;

/** Canonical path. Committing here requires the App's `workflows` permission. */
export const NORNS_WORKFLOW_PATH = ".github/workflows/norns-agent.yml";

/** The Actions repository secret holding the runner's enrollment credential. */
export const NORNS_ENROLLMENT_SECRET_NAME = "NORNS_RUNNER_ENROLLMENT_TOKEN";

const VERSION_MARKER = /^#\s*norns:workflow-version=(\d+)\s*$/m;
const MANAGED_MARKER = /^#\s*norns:managed=true\s*$/m;

/**
 * The exact `run-name` a Norns-dispatched workflow run carries.
 *
 * `workflow_dispatch` answers 204 with no run id, so the run must be located
 * afterwards. Correlating on a *substring* of the title would both collide
 * (`job-1` matches `job-10`) and be spoofable by anyone able to dispatch with a
 * crafted job id. This is a delimited marker compared for exact equality, and
 * both the template and the matcher call this one function so they cannot
 * drift apart.
 */
export function nornsRunName(jobId: string): string {
  return `Norns [norns-job:${jobId}]`;
}

export interface NornsWorkflowTemplateOptions {
  /**
   * Origin of the Norns relay, e.g. `https://norns.example`.
   *
   * SECURITY: deliberately baked into the file rather than accepted as a
   * `workflow_dispatch` input. If the relay origin were an input, anyone who
   * can click "Run workflow" could point the ephemeral runner — and therefore
   * the enrollment secret — at a host they control, with no repository change
   * to review. Baking it means redirecting the secret requires editing a
   * committed, reviewable, history-recorded file.
   */
  serverOrigin: string;
  /**
   * EXECUTION E3 — the pinned Norns runner tarball, `<version>@sha256:<hex>`
   * (e.g. `0.1.0@sha256:7c38…`), NOT an npm spec.
   *
   * The runner is served by the Norns server itself rather than published to
   * npm, so this identifies which build to fetch AND the exact bytes to accept.
   * Version and digest are one token because they must never be recombined:
   * a version pinned with the wrong hash would either fail the job or, worse,
   * describe an artifact nobody verified.
   */
  runnerPackage: string;
  /** Node major version the runner is supported on. */
  nodeVersion?: string | undefined;
  /** Hard wall-clock ceiling for one Norns run. */
  timeoutMinutes?: number | undefined;
}

function assertSafeOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Norns workflow template requires an absolute origin, got "${origin}"`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
    throw new Error("Norns workflow template requires an https origin");
  }
  return parsed.origin;
}

/**
 * A workflow-file template parameter must never be able to close a YAML string
 * or inject an expression. Every interpolated value is constrained here rather
 * than trusted.
 */
function assertSafeToken(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Norns workflow template rejected an unsafe ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Render the workflow exactly as it will be committed. Deterministic. */
export function renderNornsAgentWorkflow(options: NornsWorkflowTemplateOptions): string {
  const origin = assertSafeOrigin(options.serverOrigin);
  // EXECUTION E3 — note this pattern is strictly NARROWER than the npm-spec
  // pattern it replaces: digits, dots, a fixed `@sha256:` separator and lower
  // hex only. Serving our own tarball did not require widening the template's
  // safe-token grammar; it let us tighten it.
  const { version: runnerVersion, sha256: runnerSha256 } = parseRunnerTarballSpec(
    assertSafeToken("runner tarball", options.runnerPackage, RUNNER_TARBALL_SPEC_PATTERN),
  );
  const runnerTarballUrl = `${origin}${runnerTarballPath(runnerVersion)}`;
  const nodeVersion = assertSafeToken("node version", options.nodeVersion ?? "24", /^\d+(\.\d+)*$/);
  const timeoutMinutes = options.timeoutMinutes ?? 60;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 360) {
    throw new Error("Norns workflow timeout must be a whole number of minutes between 1 and 360");
  }

  return `# This file is managed by The Norns. Local edits are replaced on upgrade.
# norns:managed=true
# norns:workflow-version=${NORNS_WORKFLOW_VERSION}
#
# It runs the Norns agent runner ephemerally: the job checks out this
# repository, installs the runner, the runner connects outbound to Norns,
# executes the one job it was dispatched for, and the whole machine is
# destroyed when the job ends. Nothing is installed on anyone's computer.
name: Norns Agent
run-name: "${nornsRunName("${{ inputs.norns_job_id }}")}"

on:
  workflow_dispatch:
    inputs:
      norns_job_id:
        description: The Norns dispatch job this run exists to execute.
        required: true
        type: string
      norns_runner_id:
        description: The Norns runner identity this job enrolls as.
        required: true
        type: string
      norns_run_id:
        description: The Norns agent run identifier (for traceability).
        required: true
        type: string

# Least privilege (ONBOARDING O4 item 4). GITHUB_TOKEN is provided to the job
# automatically and is already scoped to this repository, so commits, pushes,
# and pull requests need no Norns-built token broker at all.
#   contents: write       -> commit and push the agent's branch
#   pull-requests: write  -> open/update the pull request for that branch
# Everything else is denied.
permissions:
  contents: write
  pull-requests: write

# One live job per Norns dispatch job. Never cancel in flight: a cancelled run
# would leave the Norns dispatch job believing a runner is still working.
concurrency:
  group: norns-agent-\${{ inputs.norns_job_id }}
  cancel-in-progress: false

jobs:
  norns-agent:
    name: Norns agent run
    runs-on: ubuntu-latest
    timeout-minutes: ${timeoutMinutes}
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4
        with:
          # Full history: the runner verifies the exact expected revision.
          fetch-depth: 0
          # Leaves GITHUB_TOKEN configured as the git credential for this
          # repository, which is what makes pushes work with no broker.
          persist-credentials: true

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "${nodeVersion}"

      - name: Install the Norns runner
        env:
          # Baked at dispatch, exactly like NORNS_SERVER and for the same
          # reason: changing where the runner comes from, or which bytes are
          # acceptable, must require a reviewable commit to this file rather
          # than a workflow_dispatch input anyone with write access can set.
          NORNS_RUNNER_TARBALL_URL: "${runnerTarballUrl}"
          NORNS_RUNNER_TARBALL_SHA256: "${runnerSha256}"
        run: |
          set -euo pipefail
          # Fail closed, in this order: a download that does not succeed, or
          # whose bytes do not hash to the digest pinned above, must never
          # reach \`npm install\`. sha256sum --check exits non-zero on any
          # mismatch and \`set -e\` turns that into a failed job, so a swapped
          # or corrupted artifact is never executed — it is not merely logged.
          curl --fail --silent --show-error --location \\
            --retry 3 --retry-connrefused --max-time 180 \\
            --output norns-runner.tgz "$NORNS_RUNNER_TARBALL_URL"
          printf '%s  norns-runner.tgz\\n' "$NORNS_RUNNER_TARBALL_SHA256" | sha256sum --check --strict -
          npm install --global --no-fund --no-audit ./norns-runner.tgz

      - name: Run the dispatched Norns job
        env:
          # Enrollment credential. Scoped to this repository, rotated on every
          # dispatch, and single-use against the one dispatch job below.
          # Never echoed: the runner reads it from the environment and the step
          # prints no command line containing it.
          NORNS_RUNNER_ENROLLMENT_TOKEN: \${{ secrets.${NORNS_ENROLLMENT_SECRET_NAME} }}
          # Repository-scoped, job-lifetime token supplied by GitHub itself.
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NORNS_SERVER: "${origin}"
          # SECURITY — env indirection, NOT \\\${{ }} interpolation inside run:.
          # workflow_dispatch inputs are supplied at RUN time by anyone with
          # repository write access (which does not require the ability to edit
          # a protected .github/workflows/ file). Interpolating them into the
          # shell script would let a dispatcher inject arbitrary commands and
          # exfiltrate NORNS_RUNNER_ENROLLMENT_TOKEN. Bound to variables here,
          # they are inert data the shell never parses as syntax.
          NORNS_RUNNER_ID: \${{ inputs.norns_runner_id }}
          NORNS_JOB_ID: \${{ inputs.norns_job_id }}
          NORNS_RUN_ID: \${{ inputs.norns_run_id }}
        run: |
          # The checked-out repository is the only tree this ephemeral runner
          # may touch. ApprovedRepositoryRegistry fails closed on an empty
          # allowlist, so the root must be set explicitly — the job's workspace
          # is the sanctioned root precisely because the job is disposable.
          # Built with node rather than string interpolation so a workspace
          # path containing quotes or backslashes still yields valid JSON.
          NORNS_APPROVED_ROOTS_JSON="$(node -e 'process.stdout.write(JSON.stringify([process.env.GITHUB_WORKSPACE]))')"
          export NORNS_APPROVED_ROOTS_JSON
          norns-runner start \\
            --ephemeral \\
            --id "$NORNS_RUNNER_ID" \\
            --job "$NORNS_JOB_ID" \\
            --run "$NORNS_RUN_ID"
`;
}

export interface CommittedWorkflowState {
  /** True when the committed file carries the Norns managed marker. */
  managed: boolean;
  /** Declared template version, or null when absent/unparseable. */
  version: number | null;
}

/**
 * Inspect a workflow file already present in the repository.
 *
 * An unmanaged file at the Norns path is never overwritten — that is the
 * "must never clobber unrelated repo content" rule, and it is enforced by the
 * installer reading this result, not by hoping the path is unused.
 */
export function inspectCommittedWorkflow(content: string): CommittedWorkflowState {
  const version = VERSION_MARKER.exec(content);
  return {
    managed: MANAGED_MARKER.test(content),
    version: version?.[1] === undefined ? null : Number(version[1]),
  };
}
