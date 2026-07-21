// ONBOARDING O2: the seam onto the EXISTING GitHub integration.
//
// Deliberately thin. Every method here maps 1:1 onto a method that already
// exists on GitHubIntegrationService (apps/server/src/integrations/github.ts);
// nothing about connections, installations, OAuth, tokens, or repository
// shape is re-implemented, and this module holds no credentials.
//
//   resolveById  -> GitHubIntegrationService.resolveRepository(userId, connectionId, repositoryId)
//   findByName   -> GitHubIntegrationService.listRepositories(userId, connectionId, name)
//   create       -> GitHubIntegrationService.createRepository(userId, {...})
//
// `findByName` exists only to make `create` idempotent in practice: GitHub's
// repository creation is not idempotent (a retry returns 422 "name already
// exists", which the integration surfaces as a generic github_api_error), so
// the onboarding command looks for the repository first and only creates when
// it genuinely is not there.

export interface RemoteRepositoryDescriptor {
  readonly connection_id: string;
  /** GitHub's numeric repository id, as a string. Stable across renames. */
  readonly repository_id: string;
  readonly owner: string;
  readonly name: string;
  readonly full_name: string;
  readonly default_branch: string;
  readonly clone_url: string;
  readonly html_url: string;
  /**
   * From GitHubIntegrationService.createRepository: false when the
   * installation is scoped to "selected repositories", which means a freshly
   * created repository is NOT yet inside the installation and no brokered
   * installation token will be able to push to it until the operator grants
   * it. Recorded, not silently ignored.
   */
  readonly binding_ready: boolean;
}

export interface RemoteRepositoryPort {
  resolveById(input: {
    readonly actor_id: string;
    readonly connection_id: string;
    readonly repository_id: string;
  }): Promise<RemoteRepositoryDescriptor>;

  findByName(input: {
    readonly actor_id: string;
    readonly connection_id: string;
    readonly name: string;
  }): Promise<RemoteRepositoryDescriptor | null>;

  create(input: {
    readonly actor_id: string;
    readonly connection_id: string;
    readonly name: string;
    readonly description: string;
    readonly private: boolean;
  }): Promise<RemoteRepositoryDescriptor>;
}

/** GitHub could not confirm the repository. Never silently downgraded. */
export class RemoteRepositoryVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "RemoteRepositoryVerificationError";
  }
}

function unconfigured(): RemoteRepositoryVerificationError {
  return new RemoteRepositoryVerificationError(
    "github_not_configured",
    "GitHub App is not configured",
    503,
  );
}

/** The port when no GitHub App is configured at all. */
export class UnconfiguredRemoteRepositoryPort implements RemoteRepositoryPort {
  resolveById(): Promise<RemoteRepositoryDescriptor> {
    return Promise.reject(unconfigured());
  }

  findByName(): Promise<RemoteRepositoryDescriptor | null> {
    return Promise.reject(unconfigured());
  }

  create(): Promise<RemoteRepositoryDescriptor> {
    return Promise.reject(unconfigured());
  }
}
