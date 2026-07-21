// ONBOARDING O2: the PUSH-CREDENTIAL SEAM. Interface only.
//
// This module deliberately does not push anything. Phase O4 owns the runner-
// facing broker and the actual git operations. What O2 fixes is the *shape* of
// the question -- "when this project pushes, whose credential does it use, and
// where does that credential come from?" -- so the durable model can record
// the answer per project and the read model can state it out loud.
//
// -------------------------------------------------------------------------
// PRIMARY:  'norns_github_app_token'
// -------------------------------------------------------------------------
// ADR-006: a Norns-brokered GitHub App installation token, minted just in
// time, scoped to the single repository being pushed to, with the App private
// key never leaving the server. The runner receives a short-lived token, not a
// key. This is the chosen direction for the product.
//
// The minting primitive already exists but is NOT yet ADR-006 shaped. What O4
// must build on, by exact name, in apps/server/src/integrations/github.ts:
//
//   * `GitHubIntegrationService.appJwt()` (private, ~line 1152)
//       Signs the App JWT from the server-only private key. Reuse as-is.
//   * `GitHubIntegrationService.installationToken(installationId)` (private,
//     ~line 1166)
//       POSTs /app/installations/:id/access_tokens with an EMPTY body, so the
//       token it returns carries the installation's full permission set across
//       ALL repositories in the installation. ADR-006 requires a single-repo
//       JIT token, so O4 must send
//         { repository_ids: [<numeric repo id>], permissions: { contents:
//           "write", pull_requests: "write", metadata: "read" } }
//       and must make the method reachable (it is `private` today and is used
//       only for server-side API calls). It also discards GitHub's
//       `expires_at`, so nothing downstream can reason about token lifetime --
//       O4 needs that value to hand a runner an expiry.
//   * `GitHubIntegrationService.connection(connectionId)` -> installation_id,
//     owner_login, repository_selection. `repository_selection === 'selected'`
//     means a repository must have been explicitly granted to the
//     installation; see `binding_ready` on RemoteRepositoryDescriptor.
//   * `GitHubIntegrationService.resolveRepository(...)` for the numeric
//     repository id the scoped token must name.
//
// -------------------------------------------------------------------------
// FALLBACK: 'local_git_remote'
// -------------------------------------------------------------------------
// Push through the local folder's own git remote using whatever credentials
// the operator's machine already holds (ssh agent, credential helper, gh
// auth). Norns holds no secret and mints nothing. This is the honest answer
// when a project's remote has no usable Norns GitHub connection -- for
// example a remote recorded against a disconnected connection, or a
// non-GitHub remote. It is a fallback, not the default.
import type { RemoteRepositoryDescriptor } from "./remoteRepositoryPort.js";

export const PUSH_CREDENTIAL_STRATEGIES = ["norns_github_app_token", "local_git_remote"] as const;
export type PushCredentialStrategy = (typeof PUSH_CREDENTIAL_STRATEGIES)[number];

/** The product direction: brokered, server-held key, JIT single-repo token. */
export const DEFAULT_PUSH_CREDENTIAL_STRATEGY: PushCredentialStrategy = "norns_github_app_token";

export interface PushCredentialRequest {
  readonly project_id: string;
  /** The remote binding (or candidate) id the push targets. */
  readonly remote_binding_id: string;
  readonly connection_id: string | null;
  readonly repository_id: string | null;
  readonly owner: string | null;
  readonly name: string | null;
  /** Who the push is attributed to. Never used as a credential. */
  readonly actor_id: string;
}

/**
 * What a broker hands the runner. `token` is null for the fallback strategy --
 * there is no server-held secret in that path, by design.
 */
export interface PushCredential {
  readonly strategy: PushCredentialStrategy;
  readonly remote_url: string;
  readonly token: string | null;
  readonly expires_at: string | null;
}

export interface PushCredentialBroker {
  readonly strategy: PushCredentialStrategy;
  issue(request: PushCredentialRequest): Promise<PushCredential>;
}

export class PushCredentialNotImplementedError extends Error {
  readonly code = "push_credential_not_implemented" as const;

  constructor(readonly strategy: PushCredentialStrategy) {
    super(
      `the "${strategy}" push-credential broker is defined but not implemented; ` +
        "phase O4 owns the runner-facing broker and the git operations",
    );
    this.name = "PushCredentialNotImplementedError";
  }
}

export class PushCredentialUnavailableError extends Error {
  readonly code = "push_credential_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "PushCredentialUnavailableError";
  }
}

/**
 * PRIMARY seam. Declared, wired, and reachable -- and it refuses rather than
 * improvises. Nothing in O2 calls `issue()`; O4 replaces the body.
 */
export class NornsBrokeredGitHubAppPushCredentials implements PushCredentialBroker {
  readonly strategy = "norns_github_app_token" as const;

  issue(_request: PushCredentialRequest): Promise<PushCredential> {
    return Promise.reject(new PushCredentialNotImplementedError(this.strategy));
  }
}

/**
 * FALLBACK seam. Also unimplemented as an *issuer* -- there is no secret for
 * the server to issue -- but it is the strategy a project records when no
 * Norns GitHub connection can back the remote.
 */
export class LocalGitRemotePushCredentials implements PushCredentialBroker {
  readonly strategy = "local_git_remote" as const;

  issue(_request: PushCredentialRequest): Promise<PushCredential> {
    return Promise.reject(new PushCredentialNotImplementedError(this.strategy));
  }
}

export interface PushCredentialDecision {
  readonly strategy: PushCredentialStrategy;
  readonly implemented: boolean;
  readonly rationale: string;
  /**
   * True when the strategy cannot work yet for a reason the operator must fix
   * (as opposed to a reason a later phase must build).
   */
  readonly needs_operator_action: boolean;
}

/**
 * Chooses the strategy a project's remote records at creation time.
 *
 * Brokered whenever the remote is a GitHub repository reachable through a
 * Norns GitHub connection; the local-git fallback only when it is not.
 */
export function decidePushCredentialStrategy(input: {
  readonly remote: RemoteRepositoryDescriptor | null;
  readonly hasLocalWorkspace: boolean;
}): PushCredentialDecision | null {
  if (!input.remote) return null;
  if (!input.remote.binding_ready) {
    return {
      strategy: "norns_github_app_token",
      implemented: false,
      rationale:
        "the GitHub App installation is scoped to selected repositories and this " +
        "repository is not one of them yet, so no brokered token can reach it",
      needs_operator_action: true,
    };
  }
  return {
    strategy: DEFAULT_PUSH_CREDENTIAL_STRATEGY,
    implemented: false,
    rationale:
      "Norns brokers a just-in-time GitHub App installation token scoped to this " +
      "repository; the App private key never leaves the server (ADR-006)",
    needs_operator_action: false,
  };
}

/** The fallback decision, for a remote with no usable Norns connection. */
export function localGitRemoteFallback(reason: string): PushCredentialDecision {
  return {
    strategy: "local_git_remote",
    implemented: false,
    rationale: reason,
    needs_operator_action: false,
  };
}
