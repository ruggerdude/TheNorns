// POLISH P3 — the server-side "Analyze the repository" step.
//
// The resume payload has recommended "Analyze the repository and record its
// architecture" since Phase 3, while the only recorder was
// POST /api/v2/projects/:id/ingest — a route with zero web callers that
// expects the CALLER to supply a finished architecture. This service is the
// missing producer: for a project with a connected GitHub repository binding
// it fetches a bounded sample of the repository through the existing GitHub
// App integration (installation-token pattern, `contents: read` scope only),
// has a model produce a structured architecture summary, and records the
// result through the EXISTING `RepositoryIngestionService.ingest()` seed —
// no parallel storage path, same replay identity, same memory-entry rules.
//
// Input bounding (cost control, stated caps):
//   * at most MAX_TREE_PATHS (400) tree paths are shown to the model;
//   * at most MAX_KEY_FILES (12) files are fetched, chosen by a fixed
//     priority (READMEs, manifests, workspace/config files, entry points);
//   * each file is truncated to MAX_FILE_CHARS (16 000) characters;
//   * the whole prompt payload is capped at MAX_TOTAL_CHARS (120 000)
//     characters (~30k tokens), which keeps a synchronous request/response
//     round-trip well under the route timeout.
import { createHash } from "node:crypto";
import type { LlmAdapter } from "@norns/adapters";
import { z } from "zod";
import {
  GITHUB_TOKEN_SCOPES,
  type GitHubFetch,
  GitHubIntegrationError,
  type GitHubIntegrationService,
} from "../integrations/github.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import type { RepositoryIngestionService } from "./repositoryIngestionService.js";

const API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export const MAX_TREE_PATHS = 400;
export const MAX_KEY_FILES = 12;
export const MAX_FILE_CHARS = 16_000;
export const MAX_TOTAL_CHARS = 120_000;

/**
 * Refusals a human can act on. `code` follows the existing error-shape
 * conventions (`github_not_configured`, `no_repository`, …); `status` follows
 * `GitHubIntegrationError`'s (503 for "this deployment cannot do this at
 * all", 409 for "this project is not in a state where it can").
 */
export class RepositoryAnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "RepositoryAnalysisError";
  }
}

export interface RepositoryAnalysisResult {
  architecture_revision_id: string;
  architecture_revision: number;
  replayed: boolean;
  title: string;
  summary: string;
  repository_revision: string;
  model: { provider: string; model: string };
}

/**
 * What the model must return. Deliberately narrower than the ingestion seed:
 * the seed's artifact block (hash/size/ref) is computed here from the
 * document the model wrote, and `directives` stay empty — a directive is an
 * auto-approved human statement, which a model inference is not. The output
 * is ADAPTED to the `V2RepositoryIngestionSeed` contract; the contract is
 * never widened to fit the model.
 */
const RepositoryArchitectureAnalysis = z
  .object({
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(2_000),
    /** Full markdown architecture document — becomes the recorded artifact. */
    architecture_document: z.string().min(1).max(40_000),
    repository_facts: z
      .array(
        z
          .object({
            key: z.string().min(1).max(120),
            value: z.string().min(1).max(500),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(50),
    constraints: z.array(z.string().min(1).max(300)).max(30),
  })
  .strict();
export type RepositoryArchitectureAnalysisT = z.infer<typeof RepositoryArchitectureAnalysis>;

interface GitHubBindingRow {
  id: string;
  repository_id: string;
  github_installation_id: string;
  github_owner: string;
  github_name: string;
  default_branch: string;
}

interface ProjectPolicyRow {
  assignment_policy_ref: string;
  verification_policy_ref: string;
  budget_policy_ref: string;
}

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
}

/**
 * Fixed key-file priority. Lower score = fetched first. Anything unmatched is
 * never fetched — the tree listing alone represents it.
 */
export function keyFileScore(path: string): number | null {
  const depth = path.split("/").length - 1;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const depthPenalty = depth * 10;
  if (/^readme(\.(md|rst|txt|adoc))?$/.test(base)) return 0 + depthPenalty;
  if (
    [
      "package.json",
      "pyproject.toml",
      "cargo.toml",
      "go.mod",
      "pom.xml",
      "build.gradle",
      "gemfile",
      "composer.json",
      "mix.exs",
    ].includes(base)
  ) {
    return 1 + depthPenalty;
  }
  if (
    [
      "pnpm-workspace.yaml",
      "lerna.json",
      "turbo.json",
      "nx.json",
      "tsconfig.base.json",
      "tsconfig.json",
      "dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      "makefile",
    ].includes(base)
  ) {
    return 2 + depthPenalty;
  }
  if (/^(architecture|design|contributing)\.md$/.test(base)) return 2 + depthPenalty;
  if (/^(main|index|app|server|cli)\.(ts|tsx|js|mjs|py|go|rs|rb|java)$/.test(base)) {
    return 3 + depthPenalty;
  }
  return null;
}

/** Deterministic selection of at most MAX_KEY_FILES fetch-worthy blobs. */
export function selectKeyFiles(
  tree: ReadonlyArray<{ path: string; size: number }>,
): Array<{ path: string; size: number }> {
  return tree
    .map((entry) => ({ entry, score: keyFileScore(entry.path) }))
    .filter(
      (candidate): candidate is { entry: { path: string; size: number }; score: number } =>
        candidate.score !== null && candidate.entry.size <= 512 * 1024,
    )
    .sort(
      (left, right) =>
        left.score - right.score || left.entry.path.localeCompare(right.entry.path),
    )
    .slice(0, MAX_KEY_FILES)
    .map((candidate) => candidate.entry);
}

export class RepositoryAnalysisService {
  private readonly http: GitHubFetch;

  constructor(
    private readonly deps: {
      transactions: V2TransactionRunner;
      github: GitHubIntegrationService | null;
      ingestion: RepositoryIngestionService;
      /**
       * Adapter factory — the same seam `main.ts` uses for debate execution.
       * Throwing here (e.g. no ANTHROPIC_API_KEY) is reported to the human as
       * `model_not_configured` before any GitHub traffic happens.
       */
      createAdapter: () => LlmAdapter;
      http?: GitHubFetch;
    },
  ) {
    this.http = deps.http ?? fetch;
  }

  async analyze(
    projectId: string,
    actor: { actor_id: string },
  ): Promise<RepositoryAnalysisResult> {
    // 1. Preconditions, cheapest first, each with its own honest refusal.
    const github = this.deps.github;
    if (!github || !github.isConfigured()) {
      throw new RepositoryAnalysisError(
        "github_not_configured",
        "Repository analysis reads the repository through the GitHub App, which is not configured on this deployment.",
        503,
      );
    }
    let adapter: LlmAdapter;
    try {
      adapter = this.deps.createAdapter();
    } catch (error) {
      throw new RepositoryAnalysisError(
        "model_not_configured",
        `Repository analysis needs a configured model provider: ${
          error instanceof Error ? error.message : String(error)
        }`,
        503,
      );
    }

    const { project, binding } = await this.deps.transactions.transaction(async (tx) => {
      const projects = await tx.query<ProjectPolicyRow>(
        `SELECT assignment_policy_ref, verification_policy_ref, budget_policy_ref
         FROM projects WHERE id = $1`,
        [projectId],
      );
      const projectRow = projects.rows[0];
      if (!projectRow) {
        throw new RepositoryAnalysisError("project_not_found", `project ${projectId} not found`, 404);
      }
      const bindings = await tx.query<GitHubBindingRow & { binding_type: string }>(
        `SELECT id, binding_type, repository_id, github_installation_id,
                github_owner, github_name, default_branch
         FROM repository_bindings
         WHERE project_id = $1 AND status = 'connected'
         ORDER BY created_at, id`,
        [projectId],
      );
      const githubBinding = bindings.rows.find((row) => row.binding_type === "github");
      if (!githubBinding) {
        if (bindings.rows.length === 0) {
          throw new RepositoryAnalysisError(
            "no_repository",
            "This project has no connected repository to analyze. Connect a repository first.",
          );
        }
        throw new RepositoryAnalysisError(
          "no_github_repository",
          "This project's connected repository is not GitHub-backed, and analysis currently reads repositories through the GitHub App only.",
        );
      }
      return { project: projectRow, binding: githubBinding };
    });

    const repositoryGithubId = Number(binding.repository_id);
    if (!Number.isInteger(repositoryGithubId) || repositoryGithubId <= 0) {
      throw new RepositoryAnalysisError(
        "repository_identity_invalid",
        `The connected repository binding does not carry a numeric GitHub repository id (${binding.repository_id}), so a repository-scoped token cannot be minted for it.`,
      );
    }

    // 2. Bounded repository sample, read-only (`contents: read`), through the
    //    existing installation-token broker.
    const token = await github.installationToken(
      binding.github_installation_id,
      GITHUB_TOKEN_SCOPES.readRepositoryContents(repositoryGithubId),
    );
    const repoPath = `/repos/${encodeURIComponent(binding.github_owner)}/${encodeURIComponent(binding.github_name)}`;
    const branch = await this.request<{ commit?: { sha?: string } }>(
      `${repoPath}/branches/${encodeURIComponent(binding.default_branch)}`,
      token,
    );
    const headSha = branch.commit?.sha;
    if (typeof headSha !== "string" || headSha.length === 0) {
      throw new RepositoryAnalysisError(
        "repository_head_unavailable",
        `${binding.github_owner}/${binding.github_name} has no commits on ${binding.default_branch} yet, so there is nothing to analyze.`,
      );
    }
    const treeResponse = await this.request<{ tree?: TreeEntry[]; truncated?: boolean }>(
      `${repoPath}/git/trees/${encodeURIComponent(headSha)}?recursive=1`,
      token,
    );
    const blobs = (treeResponse.tree ?? [])
      .filter(
        (entry): entry is { path: string; type: string; size?: number } =>
          typeof entry.path === "string" && entry.type === "blob",
      )
      .map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
    if (blobs.length === 0) {
      throw new RepositoryAnalysisError(
        "repository_empty",
        `${binding.github_owner}/${binding.github_name} has no files at ${headSha.slice(0, 12)}, so there is nothing to analyze.`,
      );
    }

    let budget = MAX_TOTAL_CHARS;
    const treeListing = blobs
      .slice(0, MAX_TREE_PATHS)
      .map((entry) => entry.path)
      .join("\n")
      .slice(0, Math.floor(MAX_TOTAL_CHARS / 4));
    budget -= treeListing.length;

    const files: Array<{ path: string; content: string; truncated: boolean }> = [];
    for (const file of selectKeyFiles(blobs)) {
      if (budget <= 0) break;
      const content = await this.fileContent(repoPath, file.path, headSha, token);
      if (content === null) continue;
      const cap = Math.min(MAX_FILE_CHARS, budget);
      files.push({
        path: file.path,
        content: content.slice(0, cap),
        truncated: content.length > cap,
      });
      budget -= Math.min(content.length, cap);
    }

    // 3. One structured model call over the bounded sample.
    const analysis = await this.runModel(adapter, {
      projectId,
      owner: binding.github_owner,
      name: binding.github_name,
      defaultBranch: binding.default_branch,
      headSha,
      totalFiles: blobs.length,
      treeTruncated: blobs.length > MAX_TREE_PATHS || treeResponse.truncated === true,
      treeListing,
      files,
    });

    // 4. Record through the EXISTING ingestion seed — replay-stable identity,
    //    same memory-entry semantics as the manual ingest route. Policy refs
    //    are the project's current ones: analysis records evidence, it does
    //    not change policy.
    const documentBytes = Buffer.from(analysis.architecture_document, "utf8");
    const contentHash = createHash("sha256").update(documentBytes).digest("hex");
    const result = await this.deps.ingestion.ingest({
      project_id: projectId,
      repository_binding_id: binding.id,
      repository_revision: headSha,
      architecture: {
        title: analysis.title,
        summary: analysis.summary,
        artifact: {
          storage_ref: `artifact://${projectId}/architecture/${headSha}`,
          content_hash: contentHash,
          byte_size: documentBytes.byteLength,
          media_type: "text/markdown",
        },
      },
      repository_facts: analysis.repository_facts.filter(
        (fact) => fact.key.trim().length > 0 && fact.value.trim().length > 0,
      ),
      constraints: analysis.constraints.filter((entry) => entry.trim().length > 0),
      // A directive is an auto-approved human instruction; a model inference
      // must never enter memory pre-approved, so this stays empty.
      directives: [],
      assignment_policy_ref: project.assignment_policy_ref,
      verification_policy_ref: project.verification_policy_ref,
      budget_policy_ref: project.budget_policy_ref,
      created_by: { actor_type: "human", actor_id: actor.actor_id },
    });
    return {
      architecture_revision_id: result.architecture_revision_id,
      architecture_revision: result.architecture_revision,
      replayed: result.replayed,
      title: analysis.title,
      summary: analysis.summary,
      repository_revision: headSha,
      model: { provider: adapter.provider, model: adapter.model },
    };
  }

  private async runModel(
    adapter: LlmAdapter,
    input: {
      projectId: string;
      owner: string;
      name: string;
      defaultBranch: string;
      headSha: string;
      totalFiles: number;
      treeTruncated: boolean;
      treeListing: string;
      files: ReadonlyArray<{ path: string; content: string; truncated: boolean }>;
    },
  ): Promise<RepositoryArchitectureAnalysisT> {
    const fileSections = input.files
      .map(
        (file) =>
          `--- FILE: ${file.path}${file.truncated ? " (truncated)" : ""} ---\n${file.content}`,
      )
      .join("\n\n");
    const prompt = [
      `Analyze the software repository ${input.owner}/${input.name} (branch ${input.defaultBranch}, commit ${input.headSha}).`,
      `You are given its file tree${input.treeTruncated ? ` (first ${MAX_TREE_PATHS} of ${input.totalFiles} files)` : ""} and the content of up to ${MAX_KEY_FILES} key files (READMEs, manifests, entry points; long files truncated).`,
      "Produce:",
      "- title: a short name for this architecture snapshot;",
      "- summary: 2-4 sentences a project manager can read at a glance;",
      "- architecture_document: a markdown document describing structure, key components, how they interact, technology choices, and build/test entry points. Describe only what the provided material supports;",
      "- repository_facts: individually useful key/value facts (language, package manager, test command, deployment target, ...) with your confidence in each;",
      "- constraints: rules future work on this repository must respect, only where the material clearly supports them.",
      "Do not invent facts about files you were not shown.",
      "",
      "FILE TREE:",
      input.treeListing,
      "",
      fileSections,
    ].join("\n");
    const { value } = await adapter.completeStructured(
      { projectId: input.projectId, prompt, maxTokens: 8_192 },
      RepositoryArchitectureAnalysis,
      "RepositoryArchitectureAnalysis",
    );
    return value;
  }

  /** GET one file's decoded content; null skips a file that cannot be read. */
  private async fileContent(
    repoPath: string,
    path: string,
    ref: string,
    token: string,
  ): Promise<string | null> {
    try {
      const body = await this.request<{ type?: string; content?: string; encoding?: string }>(
        `${repoPath}/contents/${path
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}?ref=${encodeURIComponent(ref)}`,
        token,
      );
      if (body.type !== "file" || typeof body.content !== "string") return null;
      if (body.encoding !== undefined && body.encoding !== "base64") return null;
      return Buffer.from(body.content, "base64").toString("utf8");
    } catch {
      // One unreadable file (binary, submodule, permissions edge) must not
      // sink the whole analysis; the tree listing still represents it.
      return null;
    }
  }

  /** Same request shape `GitHubActionsService` uses beside the shared broker. */
  private async request<T>(path: string, token: string): Promise<T> {
    const response = await this.http(`${API_BASE}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "TheNorns",
      },
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new GitHubIntegrationError(
        "github_api_error",
        `${body.message ?? `GitHub request failed (${response.status})`} [GET ${path}]`,
        response.status === 404 ? 404 : 409,
      );
    }
    return body;
  }
}
