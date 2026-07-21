// EXECUTION E4 — publishing the work a run actually produced.
//
// THE BUG THIS FIXES
// ------------------
// `V2RunnerExecutor` prepared a detached worktree, ran the coding agent, read
// HEAD, verified, and then unconditionally removed the worktree in a `finally`.
// Nothing ever pushed. On a laptop runner that is survivable by accident —
// `git worktree remove --force` deletes the working directory but NOT the
// branch ref the worktree created, so the commits stay reachable in the
// developer's own repository. On the ephemeral GitHub Actions runner, which is
// where this product actually executes, the entire checkout is destroyed with
// the job: the agent's commits were its only copy and they went to the grave on
// the SUCCESS path. The workflow has been granting `contents: write` and
// `pull-requests: write` for exactly this, and never exercised either.
//
// THE SHAPE
// ---------
// A run publishes a BRANCH, and then — where the platform allows it — a pull
// request for that branch.
//
// The branch is the load-bearing half, because the branch is what the rest of
// the system already speaks. `engine/integration.ts` merges a node's work with
// `git merge --no-ff <branch>` into the integration branch; the dispatch
// command has carried `target_branch` since the V2 refoundation and
// `GitWorktreeManager.prepare` already does `git switch -c <target_branch>`.
// Publishing means making that exact ref durable somewhere other than the
// disposable machine that produced it. Inventing a second convention (a patch
// artifact, a bundle, a Norns-specific object store) would have left the
// integration stage with nothing it could merge.
//
// The pull request is the human gate. TheNorns is a human-gated product and
// `pushCredentialProvider.ts` already settled how a push is authenticated:
// GitHub hands the Actions job a repository-scoped `GITHUB_TOKEN`, the checkout
// step leaves it configured as the git credential, and Norns mints, brokers,
// and stores nothing. This module holds to that — it never asks for a
// credential, it uses whatever git and the environment already provide.
//
// IDEMPOTENCY
// -----------
// The relay guarantees at-least-once delivery, so this can run twice for one
// logical run. Every step is therefore convergent rather than additive:
//   * the branch name is `target_branch`, derived from the task, not generated;
//   * a push whose remote tip already equals our commit is a no-op success;
//   * a pull request is looked up by head branch BEFORE one is opened, and a
//     422 from a concurrent opener is resolved by re-reading rather than by
//     retrying the create.
// A redelivered command converges on the same branch and the same PR.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

/**
 * What became of the run's commits.
 *
 * `empty` is a first-class outcome and not a quiet flavour of success: an agent
 * that produced no commit has produced nothing to publish, and saying so is the
 * only honest report. It is decided by the caller (which knows the worktree's
 * base revision), never inferred here.
 */
export type PublicationOutcome =
  /** The branch is on the remote. The commits survive the runner. */
  | "pushed"
  /** Already on the remote at this exact commit — a redelivery converged. */
  | "already_published"
  /**
   * The remote branch held a previous attempt at THIS task and was moved to
   * this attempt under a lease. Also a converged redelivery, but one whose
   * commits differ from last time, so it is named separately rather than
   * folded into `pushed`.
   */
  | "republished"
  /**
   * The repository has no remote to push to, so the branch ref in the local
   * repository IS the durable artifact. Only ever true for a laptop runner
   * working in a folder the human owns; an ephemeral CI checkout always has an
   * origin, so this can never silently swallow the case that matters.
   */
  | "local_only";

export interface PublicationResult {
  outcome: PublicationOutcome;
  branch: string;
  commit: string;
  /** Remote the branch was pushed to, or null when `local_only`. */
  remote: string | null;
  /** The pull request for this branch, when the platform provided one. */
  pull_request_url: string | null;
  /**
   * Why there is no pull request, when there is none. Never null-and-silent:
   * a missing PR is always explained, because "no PR" and "PR failed" are very
   * different facts to a human waiting on a review.
   */
  pull_request_note: string | null;
}

/**
 * A publication that did not happen. The caller turns this into a FAILED run
 * with this reason attached — never a silent loss, and never a success whose
 * commits are about to be deleted.
 */
export class PublicationError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(reason);
    this.name = "PublicationError";
  }
}

export interface RunnerPublisher {
  publish(input: {
    worktree_path: string;
    branch: string;
    commit: string;
    run_id: string;
    task_id: string;
    verification_passed: boolean;
    verification_summary: string;
  }): Promise<PublicationResult>;
}

export interface GitPublisherOptions {
  /** Remote to push to. Defaults to `NORNS_PUBLISH_REMOTE` or `origin`. */
  remote?: string;
  /** `owner/repo`. Defaults to `GITHUB_REPOSITORY` (set by Actions). */
  repositorySlug?: string;
  /** Defaults to `GITHUB_TOKEN` — the job-scoped token GitHub itself supplies. */
  token?: string;
  /** Injected in tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Pushes the run's branch and opens (or reuses) its pull request.
 *
 * Everything here runs `git` through `execFile` with an argument vector — never
 * a shell — matching the posture the rest of the runner already holds, so a
 * branch or repository name containing shell metacharacters is inert data.
 */
export class GitPublisher implements RunnerPublisher {
  private readonly remote: string;
  private readonly slug: string | undefined;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitPublisherOptions = {}) {
    this.remote = options.remote ?? process.env.NORNS_PUBLISH_REMOTE ?? "origin";
    this.slug = options.repositorySlug ?? process.env.GITHUB_REPOSITORY;
    this.token = options.token ?? process.env.GITHUB_TOKEN;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publish(input: {
    worktree_path: string;
    branch: string;
    commit: string;
    run_id: string;
    task_id: string;
    verification_passed: boolean;
    verification_summary: string;
  }): Promise<PublicationResult> {
    const remote = await this.resolveRemote(input.worktree_path);
    if (!remote) {
      return {
        outcome: "local_only",
        branch: input.branch,
        commit: input.commit,
        remote: null,
        pull_request_url: null,
        pull_request_note:
          "repository has no configured remote; the work is retained as a local branch",
      };
    }
    const outcome = await this.push(input.worktree_path, remote, input.branch, input.commit);
    const pullRequest = await this.ensurePullRequest(input);
    return {
      outcome,
      branch: input.branch,
      commit: input.commit,
      remote,
      pull_request_url: pullRequest.url,
      pull_request_note: pullRequest.note,
    };
  }

  /** The configured remote, or null when this repository has none at all. */
  private async resolveRemote(worktreePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", worktreePath, "remote"]);
      const remotes = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (remotes.length === 0) return null;
      return remotes.includes(this.remote) ? this.remote : (remotes[0] ?? null);
    } catch (error) {
      throw new PublicationError(
        "could not read the repository's remotes",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Push the exact commit to the exact branch, converging under redelivery.
   *
   * The fast path is an ordinary, non-forced push. It is only when that is
   * rejected that this has a decision to make, and it makes it by asking the
   * remote what it actually holds rather than by assuming:
   *
   *   * the remote is already at our commit -> a redelivery got there first,
   *     which is success, not failure;
   *   * the remote holds some other commit -> this branch belongs to this one
   *     task, so that other commit is this task's previous attempt, and the
   *     branch is moved onto the new attempt with `--force-with-lease` PINNED
   *     to the tip we just observed. The lease is the whole point: if anything
   *     moved the branch between our read and our write, the push fails and the
   *     run fails with a reason. We never blind-force, so we can never
   *     overwrite work we did not see.
   */
  private async push(
    worktreePath: string,
    remote: string,
    branch: string,
    commit: string,
  ): Promise<PublicationOutcome> {
    const ref = `refs/heads/${branch}`;
    try {
      await execFileAsync("git", ["-C", worktreePath, "push", remote, `${commit}:${ref}`]);
      return "pushed";
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const tip = await this.remoteTip(worktreePath, remote, ref);
      if (tip === commit) return "already_published";
      if (tip) {
        try {
          await execFileAsync("git", [
            "-C",
            worktreePath,
            "push",
            `--force-with-lease=${ref}:${tip}`,
            remote,
            `${commit}:${ref}`,
          ]);
          return "republished";
        } catch (leaseError) {
          throw new PublicationError(
            `could not update branch ${branch} on ${remote}`,
            leaseError instanceof Error ? leaseError.message : String(leaseError),
          );
        }
      }
      throw new PublicationError(
        `could not push branch ${branch} to ${remote}`,
        // The message may name the physical worktree; the caller redacts it
        // before any of this reaches an event.
        detail,
      );
    }
  }

  /** The commit the remote currently has at `ref`, or null if it has none. */
  private async remoteTip(
    worktreePath: string,
    remote: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", worktreePath, "ls-remote", remote, ref]);
      const sha = stdout.split("\n")[0]?.trim().split(/\s+/)[0];
      return sha ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Reuse this branch's pull request, or open one.
   *
   * Absence of a token or slug is NOT an error: a laptop runner pushing to a
   * plain git remote has no GitHub API to call, and its work is durable on the
   * branch regardless. It is reported as a note so the human knows why no
   * review link appeared.
   */
  private async ensurePullRequest(input: {
    branch: string;
    commit: string;
    run_id: string;
    task_id: string;
    verification_passed: boolean;
    verification_summary: string;
  }): Promise<{ url: string | null; note: string | null }> {
    if (!this.slug || !this.token) {
      return {
        url: null,
        note: "no GITHUB_REPOSITORY/GITHUB_TOKEN in this environment; the branch was pushed without opening a pull request",
      };
    }
    const owner = this.slug.split("/")[0];
    if (!owner) return { url: null, note: `GITHUB_REPOSITORY "${this.slug}" is not owner/repo` };
    try {
      const existing = await this.findPullRequest(input.branch, owner);
      if (existing) return { url: existing, note: null };
      const base = await this.defaultBranch();
      const created = await this.createPullRequest(input, base);
      if (created) return { url: created, note: null };
      // A concurrent redelivery may have opened it between our lookup and our
      // create. Converge on theirs rather than reporting a failure.
      const raced = await this.findPullRequest(input.branch, owner);
      return raced
        ? { url: raced, note: null }
        : { url: null, note: "the pull request could not be created; the branch is pushed" };
    } catch (error) {
      // The branch is already durable at this point, so a GitHub API problem
      // must not fail the run — but it must be reported, not swallowed.
      return {
        url: null,
        note: `the branch is pushed but the pull request call failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async findPullRequest(branch: string, owner: string): Promise<string | null> {
    const url = new URL(`${GITHUB_API_BASE}/repos/${this.slug}/pulls`);
    url.searchParams.set("head", `${owner}:${branch}`);
    url.searchParams.set("state", "all");
    url.searchParams.set("per_page", "1");
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body) || body.length === 0) return null;
    const first = body[0] as { html_url?: unknown };
    return typeof first.html_url === "string" ? first.html_url : null;
  }

  private async defaultBranch(): Promise<string> {
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/repos/${this.slug}`, {
      headers: this.headers(),
    });
    if (!response.ok) return "main";
    const body = (await response.json()) as { default_branch?: unknown };
    return typeof body.default_branch === "string" ? body.default_branch : "main";
  }

  private async createPullRequest(
    input: {
      branch: string;
      commit: string;
      run_id: string;
      task_id: string;
      verification_passed: boolean;
      verification_summary: string;
    },
    base: string,
  ): Promise<string | null> {
    const response = await this.fetchImpl(`${GITHUB_API_BASE}/repos/${this.slug}/pulls`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        title: `Norns: ${input.task_id}`,
        head: input.branch,
        base,
        // The reviewer's first question is always "did its own checks pass?".
        // Answer it in the body rather than making them open the run.
        body: [
          `Automated work for Norns task \`${input.task_id}\` (run \`${input.run_id}\`).`,
          "",
          `Commit: \`${input.commit}\``,
          `Verification: ${input.verification_passed ? "PASSED" : "FAILED"}`,
          "",
          input.verification_summary,
        ].join("\n"),
        maintainer_can_modify: true,
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { html_url?: unknown };
    return typeof body.html_url === "string" ? body.html_url : null;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.token}`,
      "x-github-api-version": GITHUB_API_VERSION,
    };
  }
}
