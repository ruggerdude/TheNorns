// ---------------------------------------------------------------------------
// O1 onboarding: execution runs in GitHub Actions — nothing is ever
// installed on the human's machine. The setup wizard's source step is two
// scenarios, both GitHub-backed:
//
//   new_repo:      "Start something new" -> Norns creates a GitHub
//                  repository (name + private/public), backed by
//                  GitHubIntegrationService.createRepository.
//   existing_repo: "Continue existing work" -> pick a repository from the
//                  connected GitHub account (searchable list, or paste a
//                  repo URL as a shortcut), backed by listRepositories /
//                  resolveRepository.
//
// Both scenarios need a connected GitHub account first — there is no
// GitHub-free path anymore.
//
// This is now the REAL, confirmed contract for POST
// /api/v2/projects/onboarding (reconciled against O2's implementation —
// this previously guessed field names that didn't match; see git history
// if you need the old assumed shape). Response: 201 on first creation, 200
// on an idempotent replay of the same idempotency_key.
// ---------------------------------------------------------------------------

export type ProjectOnboardingScenario = "new_repo" | "existing_repo";

/** A GitHub repository the wizard has settled on for the "existing work"
 *  scenario — one of the connected installation's repositories, picked from
 *  the searchable list or resolved from a pasted URL. */
export interface ResolvedGitHubRepository {
  connectionId: string;
  repositoryId: string;
  fullName: string;
}

/** What's needed to create a fresh repository for the "new" scenario. */
export interface NewRepositoryRequest {
  connectionId: string;
  repositoryName: string;
  private: boolean;
}

export interface BuildOnboardingFieldsInput {
  scenario: ProjectOnboardingScenario;
  newRepo?: NewRepositoryRequest;
  existingRepo?: ResolvedGitHubRepository;
}

/**
 * Shape the POST /api/v2/projects/onboarding body's scenario-specific
 * fields — connection_id + repository_name/private for new_repo,
 * connection_id + repository_id for existing_repo. The caller adds the
 * shared fields (name, description, pm_provider, pm_model, idempotency_key,
 * scenario is included here for convenience).
 */
export function buildOnboardingFields(input: BuildOnboardingFieldsInput): Record<string, unknown> {
  if (input.scenario === "new_repo") {
    if (!input.newRepo) return { scenario: "new_repo" };
    return {
      scenario: "new_repo",
      connection_id: input.newRepo.connectionId,
      repository_name: input.newRepo.repositoryName,
      private: input.newRepo.private,
    };
  }
  if (!input.existingRepo) return { scenario: "existing_repo" };
  return {
    scenario: "existing_repo",
    connection_id: input.existingRepo.connectionId,
    repository_id: input.existingRepo.repositoryId,
  };
}

/** POST /api/v2/projects/onboarding's response. `blockers` is the field
 *  that needs surfacing prominently — e.g. "installation_not_ready" means
 *  the repository isn't in the GitHub App's installation, so nothing will
 *  ever run until that's fixed on GitHub's side. `workspace`/`remote`/
 *  `push` are read loosely (only the optional readiness flags are used
 *  today) since their full shape isn't needed by the wizard yet. */
export interface OnboardingResponse {
  project_id: string;
  scenario: ProjectOnboardingScenario;
  replayed: boolean;
  workspace: Record<string, unknown> | null;
  remote: {
    location?: string;
    installation_ready?: boolean;
    workflow_installed?: boolean;
  } | null;
  push: Record<string, unknown> | null;
  blockers: string[];
}

/** Turn a blocker code into an actionable message — never a generic
 *  "something went wrong". `installation_not_ready` is the one named
 *  explicitly by the backend: very common for GitHub App installs scoped
 *  to "selected repositories", and it means execution can never start
 *  until fixed. */
export function describeBlocker(code: string): string {
  switch (code) {
    case "installation_not_ready":
      return "This repository isn't included in the Norns GitHub App installation, so nothing will run until it is. Add this repository to the Norns app on GitHub (Settings → Applications → Norns → Repository access), then continue.";
    default:
      return `Setup needs attention before this project can run: ${code.replaceAll("_", " ")}.`;
  }
}

/** Parse a pasted GitHub repo reference into `{owner, name}` — the "paste a
 *  repo URL as a shortcut" affordance. Accepts:
 *    - "owner/repo"
 *    - "https://github.com/owner/repo", with or without a trailing
 *      ".git"/"/" /query/hash
 *    - "git@github.com:owner/repo.git"
 *  Returns null for anything else (the search box then just filters by
 *  substring, same as before). */
export function parseGitHubRepoRef(text: string): { owner: string; name: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const patterns = [
    /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[?#].*)?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i,
    /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1] && match[2]) return { owner: match[1], name: match[2] };
  }
  return null;
}

/**
 * The confirmation step's one honest, plain-language passage about where
 * the human's code actually lives — execution is a GitHub Actions job
 * inside their repository, never anything running on their own computer.
 * `repositoryFullName` is null before a repository has been chosen/named
 * (the confirmation step then just prompts for that instead).
 *
 * This is a pre-creation preview computed client-side because there is no
 * server data to prefer yet (the project doesn't exist). Once a project
 * exists, prefer the resume payload's own `onboarding.summary_line` instead
 * of calling this function again — see Projects.tsx's dashboard cards.
 */
export function describeSetup(repositoryFullName: string | null): string {
  if (!repositoryFullName) return "Choose or create a GitHub repository to continue.";
  return `Work happens in a GitHub Actions job inside ${repositoryFullName}. Changes arrive as commits and pull requests in that repository — to get the files on your own machine, clone or pull as usual.`;
}
