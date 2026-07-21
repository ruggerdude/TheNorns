// ONBOARDING O4 — the GitHub Actions execution path.
//
// Everything the server needs in order to make a user's repository able to host
// an ephemeral Norns runner:
//   1. commit / upgrade `.github/workflows/norns-agent.yml` (Contents API),
//      idempotently and without ever clobbering unrelated repository content;
//   2. provision the runner's enrollment credential as a repository Actions
//      secret, encrypted with the repository public key (libsodium sealed box);
//   3. trigger a run (`POST .../actions/workflows/{id}/dispatches`) and read
//      back run status, conclusion, and job logs.
//
// The server still executes no repository shell commands (ADR-006). It writes a
// file and pushes a button; every git/build/test command runs inside the job.
import { createHash, randomBytes } from "node:crypto";
import sodium from "libsodium-wrappers";
import {
  NORNS_ENROLLMENT_SECRET_NAME,
  NORNS_WORKFLOW_PATH,
  NORNS_WORKFLOW_VERSION,
  type NornsWorkflowTemplateOptions,
  inspectCommittedWorkflow,
  nornsRunName,
  renderNornsAgentWorkflow,
} from "./actionsWorkflowTemplate.js";
import {
  GITHUB_TOKEN_SCOPES,
  type GitHubFetch,
  GitHubIntegrationError,
  type GitHubIntegrationService,
} from "./github.js";

const API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

/** Identifies one repository through one installation. */
export interface ActionsRepositoryRef {
  installation_id: string;
  /** Numeric GitHub repository id — the unit `repository_ids` token scoping uses. */
  repository_github_id: number;
  owner: string;
  name: string;
  default_branch: string;
}

export type WorkflowInstallAction = "created" | "updated" | "unchanged" | "blocked";

export interface WorkflowInstallResult {
  action: WorkflowInstallAction;
  path: string;
  version: number;
  /** Commit that carries the change; null for `unchanged` / `blocked`. */
  commit_sha: string | null;
  /**
   * Non-null exactly when `action === "blocked"`: a file already occupies the
   * Norns workflow path but is not Norns-managed. Norns refuses to overwrite it
   * and hands the human an explanation instead.
   */
  blocked_reason: string | null;
}

export interface ActionsRunSummary {
  github_run_id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_number: number;
  display_title: string;
  created_at: string;
}

interface ContentsFileResponse {
  type?: string;
  sha?: string;
  content?: string;
  encoding?: string;
}

interface ContentsWriteResponse {
  commit?: { sha?: string };
}

interface RepositoryPublicKeyResponse {
  key_id: string;
  key: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: {
    id: number;
    name?: string | null;
    display_title?: string | null;
    status: string;
    conclusion: string | null;
    html_url: string;
    run_number: number;
    created_at: string;
  }[];
}

interface RunJobsResponse {
  jobs?: { id: number; name: string }[];
}

/**
 * Encrypt a secret for a repository with libsodium's sealed box, which is the
 * only format GitHub's Actions-secrets API accepts.
 *
 * A sealed box is anonymous: it uses a throwaway X25519 keypair per call, so
 * two encryptions of the same value differ, and nothing but the repository's
 * private key (held by GitHub) can open it. Node's built-in crypto cannot
 * construct one — it has no XSalsa20-Poly1305 and no length-parameterised
 * BLAKE2b — so libsodium is a genuine dependency here, not a convenience.
 */
export async function sealRepositorySecret(
  publicKeyBase64: string,
  value: string,
): Promise<string> {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/** Generate a fresh enrollment credential. 256 bits from the CSPRNG. */
export function generateEnrollmentToken(): string {
  return `nrt_${randomBytes(32).toString("base64url")}`;
}

/**
 * Only the hash is ever stored. A database reader — or a database backup —
 * cannot recover a credential that would let them impersonate a runner.
 */
export function enrollmentTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class GitHubActionsService {
  constructor(
    private readonly github: GitHubIntegrationService,
    private readonly http: GitHubFetch = fetch,
  ) {}

  /**
   * Idempotently install or upgrade the Norns workflow.
   *
   * Four outcomes, all deliberate:
   *   * no file        -> create it;
   *   * byte-identical -> `unchanged`, no commit, no repository churn;
   *   * Norns-managed at an older version -> upgrade in place (the upgrade path);
   *   * present but NOT Norns-managed -> `blocked`. Norns never overwrites a
   *     file it did not write. Repositories legitimately contain workflows and
   *     silently replacing one would be data loss.
   */
  async installWorkflow(
    repository: ActionsRepositoryRef,
    template: NornsWorkflowTemplateOptions,
  ): Promise<WorkflowInstallResult> {
    const token = await this.github.installationToken(
      repository.installation_id,
      GITHUB_TOKEN_SCOPES.writeWorkflowFile(repository.repository_github_id),
    );
    const desired = renderNornsAgentWorkflow(template);
    const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${NORNS_WORKFLOW_PATH}`;
    const existing = await this.request<ContentsFileResponse>(
      `${path}?ref=${encodeURIComponent(repository.default_branch)}`,
      token,
      { allowStatuses: [404] },
    );

    let sha: string | undefined;
    if (existing.status !== 404) {
      const body = existing.body;
      if (body.type !== "file" || typeof body.content !== "string") {
        return {
          action: "blocked",
          path: NORNS_WORKFLOW_PATH,
          version: NORNS_WORKFLOW_VERSION,
          commit_sha: null,
          blocked_reason: `${NORNS_WORKFLOW_PATH} exists in ${repository.owner}/${repository.name} but is not a regular file, so Norns will not replace it.`,
        };
      }
      const current = Buffer.from(body.content, "base64").toString("utf8");
      if (current === desired) {
        return {
          action: "unchanged",
          path: NORNS_WORKFLOW_PATH,
          version: NORNS_WORKFLOW_VERSION,
          commit_sha: null,
          blocked_reason: null,
        };
      }
      const state = inspectCommittedWorkflow(current);
      if (!state.managed) {
        return {
          action: "blocked",
          path: NORNS_WORKFLOW_PATH,
          version: NORNS_WORKFLOW_VERSION,
          commit_sha: null,
          blocked_reason: `${repository.owner}/${repository.name} already has a workflow at ${NORNS_WORKFLOW_PATH} that Norns did not create. Norns will not overwrite it — rename or remove that file, or point Norns at a different repository.`,
        };
      }
      if (state.version !== null && state.version > NORNS_WORKFLOW_VERSION) {
        return {
          action: "blocked",
          path: NORNS_WORKFLOW_PATH,
          version: NORNS_WORKFLOW_VERSION,
          commit_sha: null,
          blocked_reason: `${NORNS_WORKFLOW_PATH} declares Norns workflow version ${state.version}, which is newer than this Norns deployment understands (${NORNS_WORKFLOW_VERSION}). Downgrading it could break runs started by a newer Norns.`,
        };
      }
      sha = body.sha;
    }

    const written = await this.request<ContentsWriteResponse>(path, token, {
      method: "PUT",
      body: {
        message:
          sha === undefined
            ? "Add the Norns agent workflow"
            : `Update the Norns agent workflow to version ${NORNS_WORKFLOW_VERSION}`,
        content: Buffer.from(desired, "utf8").toString("base64"),
        branch: repository.default_branch,
        ...(sha === undefined ? {} : { sha }),
      },
    });
    return {
      action: sha === undefined ? "created" : "updated",
      path: NORNS_WORKFLOW_PATH,
      version: NORNS_WORKFLOW_VERSION,
      commit_sha: written.body.commit?.sha ?? null,
      blocked_reason: null,
    };
  }

  /**
   * Write (or rotate) the ephemeral runner's enrollment credential as a
   * repository-scoped Actions secret. Returns the plaintext exactly once, to
   * its caller, which stores only the hash.
   */
  async putEnrollmentSecret(
    repository: ActionsRepositoryRef,
    token: string,
    secretName = NORNS_ENROLLMENT_SECRET_NAME,
  ): Promise<void> {
    const apiToken = await this.github.installationToken(
      repository.installation_id,
      GITHUB_TOKEN_SCOPES.writeRepositorySecret(repository.repository_github_id),
    );
    const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/secrets`;
    const publicKey = await this.request<RepositoryPublicKeyResponse>(
      `${base}/public-key`,
      apiToken,
    );
    const encrypted = await sealRepositorySecret(publicKey.body.key, token);
    await this.request(`${base}/${encodeURIComponent(secretName)}`, apiToken, {
      method: "PUT",
      body: { encrypted_value: encrypted, key_id: publicKey.body.key_id },
      // 201 (created) and 204 (updated) are both success here.
      allowStatuses: [201, 204],
    });
  }

  /**
   * Trigger the workflow. GitHub answers 204 with no body and does NOT return
   * the run id, so `findRunForJob` correlates afterwards through the run name,
   * which the template sets to the Norns dispatch job id.
   */
  async dispatchWorkflow(
    repository: ActionsRepositoryRef,
    inputs: { norns_job_id: string; norns_runner_id: string; norns_run_id: string },
  ): Promise<void> {
    const token = await this.github.installationToken(
      repository.installation_id,
      GITHUB_TOKEN_SCOPES.dispatchWorkflow(repository.repository_github_id),
    );
    const workflowFile = NORNS_WORKFLOW_PATH.slice(NORNS_WORKFLOW_PATH.lastIndexOf("/") + 1);
    await this.request(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      token,
      {
        method: "POST",
        body: { ref: repository.default_branch, inputs },
        allowStatuses: [204],
      },
    );
  }

  /**
   * Find the workflow run that a `dispatchWorkflow` call produced. The template
   * sets `run-name` to `Norns <job id>`, so the dispatch job id is carried in
   * the run's display title — a deterministic correlation key rather than a
   * "most recent run, probably" guess.
   */
  async findRunForJob(
    repository: ActionsRepositoryRef,
    jobId: string,
  ): Promise<ActionsRunSummary | null> {
    const token = await this.github.installationToken(
      repository.installation_id,
      GITHUB_TOKEN_SCOPES.dispatchWorkflow(repository.repository_github_id),
    );
    const workflowFile = NORNS_WORKFLOW_PATH.slice(NORNS_WORKFLOW_PATH.lastIndexOf("/") + 1);
    const response = await this.request<WorkflowRunsResponse>(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&per_page=50`,
      token,
    );
    // Exact equality on the shared delimited marker — never a substring, which
    // would match `job-1` against `job-10` and be spoofable by a crafted id.
    const expected = nornsRunName(jobId);
    const match = (response.body.workflow_runs ?? []).find((run) =>
      [run.display_title, run.name].some((title) => title === expected),
    );
    if (!match) return null;
    return {
      github_run_id: match.id,
      status: match.status,
      conclusion: match.conclusion,
      html_url: match.html_url,
      run_number: match.run_number,
      display_title: match.display_title ?? match.name ?? "",
      created_at: match.created_at,
    };
  }

  /** Read one run's live status / conclusion. */
  async runStatus(
    repository: ActionsRepositoryRef,
    githubRunId: number,
  ): Promise<ActionsRunSummary> {
    const token = await this.github.installationToken(
      repository.installation_id,
      GITHUB_TOKEN_SCOPES.dispatchWorkflow(repository.repository_github_id),
    );
    const response = await this.request<NonNullable<WorkflowRunsResponse["workflow_runs"]>[number]>(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/runs/${githubRunId}`,
      token,
    );
    const run = response.body;
    return {
      github_run_id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      run_number: run.run_number,
      display_title: run.display_title ?? run.name ?? "",
      created_at: run.created_at,
    };
  }

  /**
   * Plain-text logs for every job in a run, concatenated.
   *
   * Used for diagnosing a job that died before its runner ever reached the
   * relay — once the runner is connected, its own redacted event stream is the
   * authoritative log and this is not consulted.
   */
  async runLogs(repository: ActionsRepositoryRef, githubRunId: number): Promise<string> {
    const token = await this.github.installationToken(
      repository.installation_id,
      GITHUB_TOKEN_SCOPES.dispatchWorkflow(repository.repository_github_id),
    );
    const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const jobs = await this.request<RunJobsResponse>(
      `${repoPath}/actions/runs/${githubRunId}/jobs?per_page=50`,
      token,
    );
    const sections: string[] = [];
    for (const job of jobs.body.jobs ?? []) {
      const response = await this.http(`${API_BASE}${repoPath}/actions/jobs/${job.id}/logs`, {
        headers: this.headers(token),
        redirect: "follow",
      });
      sections.push(
        `=== ${job.name} ===\n${response.ok ? await response.text() : `<logs unavailable: ${response.status}>`}`,
      );
    }
    return sections.join("\n\n");
  }

  // -- internals -------------------------------------------------------------

  private headers(token: string, hasBody = false): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "TheNorns",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async request<T = unknown>(
    path: string,
    token: string,
    init: { method?: string; body?: unknown; allowStatuses?: number[] } = {},
  ): Promise<{ status: number; body: T }> {
    const response = await this.http(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: this.headers(token, init.body !== undefined),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (init.allowStatuses?.includes(response.status)) {
      return { status: response.status, body: {} as T };
    }
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new GitHubIntegrationError(
        "github_actions_api_error",
        `${body.message ?? `GitHub Actions request failed (${response.status})`} [${init.method ?? "GET"} ${path}]`,
        response.status === 404 ? 404 : 409,
      );
    }
    return { status: response.status, body };
  }
}
