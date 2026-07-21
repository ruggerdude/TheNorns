// ONBOARDING O2: the RemoteRepositoryPort backed by the GitHub integration
// that already exists. Adapter only -- it adds no GitHub knowledge of its own.
import {
  GitHubIntegrationError,
  type GitHubIntegrationService,
  type GitHubRepositorySummary,
} from "../integrations/github.js";
import {
  type RemoteRepositoryDescriptor,
  type RemoteRepositoryPort,
  RemoteRepositoryVerificationError,
} from "./remoteRepositoryPort.js";

function descriptor(
  summary: GitHubRepositorySummary,
  installationReady: boolean,
): RemoteRepositoryDescriptor {
  return {
    connection_id: summary.connection_id,
    repository_id: summary.id,
    owner: summary.owner,
    name: summary.name,
    full_name: summary.full_name,
    default_branch: summary.default_branch,
    clone_url: summary.clone_url,
    html_url: summary.html_url,
    installation_ready: installationReady,
  };
}

/**
 * GitHubIntegrationService collapses almost every non-transient GitHub failure
 * into `github_api_error` with HTTP 409 -- a 404 for a repository the
 * installation cannot see is indistinguishable from a 403 permission failure.
 * The adapter re-raises faithfully rather than inventing a more specific code
 * it cannot actually justify. (Flagged for remediation; not fixed here.)
 */
function rethrow(error: unknown): never {
  if (error instanceof GitHubIntegrationError) {
    throw new RemoteRepositoryVerificationError(error.code, error.message, error.status);
  }
  throw error;
}

export class GitHubRemoteRepositoryPort implements RemoteRepositoryPort {
  constructor(private readonly github: GitHubIntegrationService) {}

  async resolveById(input: {
    actor_id: string;
    connection_id: string;
    repository_id: string;
  }): Promise<RemoteRepositoryDescriptor> {
    try {
      const summary = await this.github.resolveRepository(
        input.actor_id,
        input.connection_id,
        input.repository_id,
      );
      // Reaching a repository through `resolveRepository` means the
      // installation token could read it, which is exactly the "is this repo
      // inside the installation?" question that gates Actions dispatch.
      return descriptor(summary, true);
    } catch (error) {
      return rethrow(error);
    }
  }

  async findByName(input: {
    actor_id: string;
    connection_id: string;
    name: string;
  }): Promise<RemoteRepositoryDescriptor | null> {
    try {
      const matches = await this.github.listRepositories(
        input.actor_id,
        input.connection_id,
        input.name,
      );
      const wanted = input.name.toLowerCase();
      const exact = matches.find((summary) => summary.name.toLowerCase() === wanted);
      return exact ? descriptor(exact, true) : null;
    } catch (error) {
      return rethrow(error);
    }
  }

  async create(input: {
    actor_id: string;
    connection_id: string;
    name: string;
    description: string;
    private: boolean;
  }): Promise<RemoteRepositoryDescriptor> {
    try {
      const created = await this.github.createRepository(input.actor_id, {
        connection_id: input.connection_id,
        name: input.name,
        description: input.description,
        private: input.private,
        // A repository with no commits has no default branch and no ref for
        // Actions to check out, so the workflow file could not be committed
        // and no run could be dispatched. Initializing gives the first run
        // something to stand on.
        auto_init: true,
      });
      // `binding_ready` is false when the installation is scoped to selected
      // repositories: the new repository is not in it yet, so Norns cannot
      // commit a workflow file or dispatch an Actions run there. Carried
      // through as first-class state, not swallowed.
      return descriptor(created, created.binding_ready);
    } catch (error) {
      return rethrow(error);
    }
  }
}
