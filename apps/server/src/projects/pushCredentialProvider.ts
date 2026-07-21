// ONBOARDING O2: how a project's pushes are authenticated.
//
// There is exactly one answer, and it needs no broker.
//
// Execution happens in a GitHub Actions job inside the project's own
// repository. GitHub provides that job with a `GITHUB_TOKEN` secret
// automatically, already scoped to the repository the job is running in, and
// already expiring when the job ends. The ephemeral runner pushes with it.
//
// Norns therefore mints nothing, stores nothing, and hands the runner no push
// credential. There is no brokered-token seam and no local-git-remote seam,
// because there is nothing for either of them to do -- so neither exists here.
// An unused interface with two unimplemented arms would only imply a choice
// that has already been made.
//
// -------------------------------------------------------------------------
// What Norns's OWN GitHub App token is still for
// -------------------------------------------------------------------------
// The App token remains necessary, but strictly for CONTROL-PLANE calls, none
// of which are pushes:
//
//   * create a repository            (GitHubIntegrationService.createRepository)
//   * list / resolve repositories    (listRepositories, resolveRepository)
//   * commit the Norns workflow file into the repository
//   * dispatch an Actions run, and read its status
//
// The App private key stays server-only (ADR-006). It is never handed to a
// runner, and it is never used to push.

/**
 * The only push-credential strategy that exists.
 *
 * Kept as a named constant rather than inlined so the durable column, the
 * read model, and the tests all agree on one spelling, and so a future
 * strategy (fork-and-PR, pushing to an upstream the Actions token cannot
 * reach) has an obvious place to land.
 */
export const ACTIONS_GITHUB_TOKEN = "actions_github_token" as const;
export type PushCredentialStrategy = typeof ACTIONS_GITHUB_TOKEN;

export interface PushCredentialDescription {
  readonly strategy: PushCredentialStrategy;
  /** Whether Norns holds or issues any secret for this strategy. It does not. */
  readonly norns_issues_credential: false;
  readonly rationale: string;
}

const RATIONALE =
  "pushes run inside a GitHub Actions job in this repository, using the " +
  "GITHUB_TOKEN that GitHub scopes to that repository automatically; Norns " +
  "issues no push credential";

/**
 * How a GitHub-backed project pushes. Constant by construction -- there is no
 * per-project decision left to make.
 */
export function describePushCredential(): PushCredentialDescription {
  return {
    strategy: ACTIONS_GITHUB_TOKEN,
    norns_issues_credential: false,
    rationale: RATIONALE,
  };
}
