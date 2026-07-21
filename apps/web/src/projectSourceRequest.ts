// ---------------------------------------------------------------------------
// O1 onboarding, redirected: execution moves to GitHub Actions — nothing is
// ever installed on the human's machine. That collapses the setup wizard's
// source step to two scenarios, both GitHub-backed:
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
// TODO(O2): this module shapes requests against POST
// /api/v2/projects/onboarding, which the O2 agent is building in parallel
// (scenarios "new_repo"/"existing_repo") — it does not exist yet. The exact
// field names and response shape below are a best-effort guess (mirroring
// today's POST /api/projects + POST /api/integrations/github/repositories
// field names), assuming the new endpoint creates the GitHub repository
// (for new_repo) and the project atomically in one call and returns
// something shaped like today's ProjectSummary. Reconcile at integration —
// every caller in the wizard goes through buildOnboardingFields rather than
// constructing this body inline, so this is a one-file change.
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
 * fields (name/description/pm_provider/pm_model are the same for both and
 * added by the caller). See the TODO(O2) note above this file's scenario
 * summary — no server contract exists yet for this endpoint.
 */
export function buildOnboardingFields(input: BuildOnboardingFieldsInput): Record<string, unknown> {
  if (input.scenario === "new_repo") {
    if (!input.newRepo) return { scenario: "new_repo" };
    return {
      scenario: "new_repo",
      github_connection_id: input.newRepo.connectionId,
      repository_name: input.newRepo.repositoryName,
      private: input.newRepo.private,
    };
  }
  if (!input.existingRepo) return { scenario: "existing_repo" };
  return {
    scenario: "existing_repo",
    github_connection_id: input.existingRepo.connectionId,
    github_repository_id: input.existingRepo.repositoryId,
  };
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
    if (match) return { owner: match[1], name: match[2] };
  }
  return null;
}

/**
 * The confirmation step's one honest, plain-language passage about where
 * the human's code actually lives — execution is a GitHub Actions job
 * inside their repository, never anything running on their own computer.
 * `repositoryFullName` is null before a repository has been chosen/named
 * (the confirmation step then just prompts for that instead).
 */
export function describeSetup(repositoryFullName: string | null): string {
  if (!repositoryFullName) return "Choose or create a GitHub repository to continue.";
  return `Work happens in a GitHub Actions job inside ${repositoryFullName}. Changes arrive as commits and pull requests in that repository — to get the files on your own machine, clone or pull as usual.`;
}
