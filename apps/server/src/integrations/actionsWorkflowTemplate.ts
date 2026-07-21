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

/**
 * Bumped whenever the rendered workflow changes in a way an already-installed
 * repository should receive. `installNornsAgentWorkflow` upgrades in place when
 * the committed file declares a lower version.
 */
export const NORNS_WORKFLOW_VERSION = 1;

/** Canonical path. Committing here requires the App's `workflows` permission. */
export const NORNS_WORKFLOW_PATH = ".github/workflows/norns-agent.yml";

/** The Actions repository secret holding the runner's enrollment credential. */
export const NORNS_ENROLLMENT_SECRET_NAME = "NORNS_RUNNER_ENROLLMENT_TOKEN";

const VERSION_MARKER = /^#\s*norns:workflow-version=(\d+)\s*$/m;
const MANAGED_MARKER = /^#\s*norns:managed=true\s*$/m;

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
  /** npm spec for the runner, e.g. `@norns/runner@0.1.0`. */
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
  const runnerPackage = assertSafeToken(
    "runner package",
    options.runnerPackage,
    /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.\-+]+)?$/i,
  );
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
run-name: "Norns \${{ inputs.norns_job_id }}"

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
        run: npm install --global --no-fund --no-audit "${runnerPackage}"

      - name: Run the dispatched Norns job
        env:
          # Enrollment credential. Scoped to this repository, single-use
          # against the one dispatch job named below, and rotatable from Norns.
          # Never echoed: the runner reads it from the environment and the step
          # prints no command line containing it.
          NORNS_RUNNER_ENROLLMENT_TOKEN: \${{ secrets.${NORNS_ENROLLMENT_SECRET_NAME} }}
          # Repository-scoped, job-lifetime token supplied by GitHub itself.
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NORNS_SERVER: "${origin}"
        run: |
          norns-runner start \\
            --ephemeral \\
            --id "\${{ inputs.norns_runner_id }}" \\
            --job "\${{ inputs.norns_job_id }}" \\
            --run "\${{ inputs.norns_run_id }}"
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
