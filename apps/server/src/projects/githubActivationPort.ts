// ONBOARDING O6: the activation port, backed by the GitHub integration that
// already exists. Adapter only — it adds no GitHub knowledge of its own, and
// deliberately touches nothing in the Actions execution module.
import { GitHubIntegrationError, type GitHubIntegrationService } from "../integrations/github.js";
import {
  type ActivationReadiness,
  ProjectActivationError,
  type ProjectActivationPort,
  type RepositoryEvidence,
} from "./projectActivationService.js";

function rethrow(error: unknown): never {
  if (error instanceof GitHubIntegrationError) {
    throw new ProjectActivationError(error.code, error.message, error.status);
  }
  throw error;
}

export class GitHubActivationPort implements ProjectActivationPort {
  constructor(private readonly github: GitHubIntegrationService) {}

  async readiness(input: {
    connection_id: string;
    owner: string;
    name: string;
  }): Promise<ActivationReadiness> {
    try {
      const readiness = await this.github.installationReadiness(
        input.connection_id,
        input.owner,
        input.name,
      );
      return {
        ready: readiness.ready,
        reason: readiness.reason,
        action_required: readiness.action_required,
        manage_installation_url: readiness.manage_installation_url,
        installation_id: readiness.installation_id,
      };
    } catch (error) {
      return rethrow(error);
    }
  }

  async evidence(input: {
    connection_id: string;
    repository_id: string;
    owner: string;
    name: string;
    actor_id: string;
  }): Promise<RepositoryEvidence> {
    try {
      // Resolving through the installation is itself the second piece of
      // evidence: it proves the repository is reachable with an installation
      // token, and it is where the numeric id and default branch come from —
      // never from the client.
      const repository = await this.github.resolveRepository(
        input.actor_id,
        input.connection_id,
        input.repository_id,
      );
      const repositoryGitHubId = Number(repository.id);
      if (!Number.isSafeInteger(repositoryGitHubId) || repositoryGitHubId <= 0) {
        throw new ProjectActivationError(
          "repository_identity_incomplete",
          `GitHub returned an unusable repository id for ${repository.full_name}.`,
          409,
        );
      }
      const head = await this.github.repositoryHead({
        connectionId: input.connection_id,
        owner: repository.owner,
        name: repository.name,
        repositoryId: repositoryGitHubId,
      });
      const connection = await this.github.installationReadiness(
        input.connection_id,
        repository.owner,
        repository.name,
      );
      return {
        installation_id: connection.installation_id,
        repository_github_id: repositoryGitHubId,
        owner: repository.owner,
        name: repository.name,
        default_branch: repository.default_branch,
        head_revision: head,
      };
    } catch (error) {
      return rethrow(error);
    }
  }
}
