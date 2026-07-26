import type { V2ProjectAccessDecisionT, V2ProjectMembersResponseT } from "@norns/contracts";
import type {
  ProjectAccessIdentity,
  ProjectAccessRepository,
  ProjectAccessRepositoryStore,
  ProjectMemberCandidate,
} from "./projectAccessRepository.js";

export type ProjectAccessErrorCode =
  | "project_not_found"
  | "identity_not_found"
  | "identity_inactive"
  | "forbidden"
  | "member_not_found"
  | "owner_cannot_be_removed"
  | "ownership_recovery_required";

export class ProjectAccessError extends Error {
  constructor(
    readonly code: ProjectAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectAccessError";
  }
}

export interface ProjectAccessActor {
  id: string;
}

async function activeIdentity(
  repository: ProjectAccessRepository,
  userId: string,
): Promise<ProjectAccessIdentity> {
  const identity = await repository.identity(userId);
  if (!identity) {
    throw new ProjectAccessError("identity_not_found", `unknown user "${userId}"`);
  }
  if (identity.status !== "active") {
    throw new ProjectAccessError("identity_inactive", `user "${userId}" is not active`);
  }
  return identity;
}

async function decision(
  repository: ProjectAccessRepository,
  projectId: string,
  identity: ProjectAccessIdentity,
): Promise<V2ProjectAccessDecisionT> {
  const project = await repository.project(projectId);
  if (!project) {
    throw new ProjectAccessError("project_not_found", `unknown project "${projectId}"`);
  }

  if (project.ownerUserId === identity.id) {
    return {
      schema_version: 2,
      project_id: projectId,
      user_id: identity.id,
      owner_user_id: project.ownerUserId,
      can_access: true,
      can_manage_members: true,
      source: "owner",
    };
  }

  if (identity.role === "admin") {
    return {
      schema_version: 2,
      project_id: projectId,
      user_id: identity.id,
      owner_user_id: project.ownerUserId,
      can_access: true,
      can_manage_members: true,
      source: "admin",
    };
  }

  if (project.ownerUserId === null) {
    return {
      schema_version: 2,
      project_id: projectId,
      user_id: identity.id,
      owner_user_id: null,
      can_access: false,
      can_manage_members: false,
      source: "none",
    };
  }

  const membership = await repository.membership(projectId, identity.id);
  if (membership?.status === "active") {
    return {
      schema_version: 2,
      project_id: projectId,
      user_id: identity.id,
      owner_user_id: project.ownerUserId,
      can_access: true,
      can_manage_members: false,
      source: "membership",
    };
  }

  return {
    schema_version: 2,
    project_id: projectId,
    user_id: identity.id,
    owner_user_id: project.ownerUserId,
    can_access: false,
    can_manage_members: false,
    source: "none",
  };
}

function requireProjectAccess(access: V2ProjectAccessDecisionT): void {
  if (!access.can_access) {
    throw new ProjectAccessError(
      "forbidden",
      `user "${access.user_id}" cannot access project "${access.project_id}"`,
    );
  }
}

function requireMembershipManager(access: V2ProjectAccessDecisionT): void {
  if (!access.can_manage_members) {
    throw new ProjectAccessError(
      "forbidden",
      `user "${access.user_id}" cannot manage project "${access.project_id}" membership`,
    );
  }
}

export class ProjectAccessService {
  constructor(private readonly store: ProjectAccessRepositoryStore) {}

  access(projectId: string, actor: ProjectAccessActor): Promise<V2ProjectAccessDecisionT> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      return decision(repository, projectId, identity);
    });
  }

  listAccessibleProjectIds(actor: ProjectAccessActor): Promise<string[]> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      return repository.listAccessibleProjectIds(identity.id, identity.role === "admin");
    });
  }

  assertCanAccess(projectId: string, actor: ProjectAccessActor): Promise<void> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      requireProjectAccess(await decision(repository, projectId, identity));
    });
  }

  members(projectId: string, actor: ProjectAccessActor): Promise<V2ProjectMembersResponseT> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      const access = await decision(repository, projectId, identity);
      requireProjectAccess(access);
      return {
        schema_version: 2,
        project_id: projectId,
        owner_user_id: access.owner_user_id,
        members: await repository.listMembers(projectId),
      };
    });
  }

  memberCandidates(
    projectId: string,
    actor: ProjectAccessActor,
  ): Promise<ProjectMemberCandidate[]> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      const access = await decision(repository, projectId, identity);
      requireMembershipManager(access);
      return repository.listMemberCandidates(projectId);
    });
  }

  addMember(
    projectId: string,
    actor: ProjectAccessActor,
    userId: string,
  ): Promise<V2ProjectMembersResponseT> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      const access = await decision(repository, projectId, identity);
      requireMembershipManager(access);
      await activeIdentity(repository, userId);
      await repository.upsertMember(projectId, userId, identity.id);
      return {
        schema_version: 2,
        project_id: projectId,
        owner_user_id: access.owner_user_id,
        members: await repository.listMembers(projectId),
      };
    });
  }

  removeMember(
    projectId: string,
    actor: ProjectAccessActor,
    userId: string,
  ): Promise<V2ProjectMembersResponseT> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      const access = await decision(repository, projectId, identity);
      requireMembershipManager(access);
      if (access.owner_user_id === userId) {
        throw new ProjectAccessError(
          "owner_cannot_be_removed",
          "transfer project ownership before removing the current owner",
        );
      }
      const removed = await repository.removeMember(projectId, userId, identity.id);
      if (!removed) {
        throw new ProjectAccessError(
          "member_not_found",
          `user "${userId}" is not an active project member`,
        );
      }
      return {
        schema_version: 2,
        project_id: projectId,
        owner_user_id: access.owner_user_id,
        members: await repository.listMembers(projectId),
      };
    });
  }

  transferOwnership(
    projectId: string,
    actor: ProjectAccessActor,
    ownerUserId: string,
  ): Promise<V2ProjectMembersResponseT> {
    return this.store.transaction(async (repository) => {
      const identity = await activeIdentity(repository, actor.id);
      const access = await decision(repository, projectId, identity);
      const existingOwner =
        access.owner_user_id === null ? null : await repository.identity(access.owner_user_id);
      const isOwner = access.owner_user_id === identity.id;
      const canRecover =
        identity.role === "admin" &&
        (access.owner_user_id === null || existingOwner?.status !== "active");
      if (!isOwner && !canRecover) {
        if (identity.role !== "admin") {
          throw new ProjectAccessError(
            "forbidden",
            `user "${identity.id}" cannot transfer project "${projectId}" ownership`,
          );
        }
        throw new ProjectAccessError(
          "ownership_recovery_required",
          "only the active owner can transfer this project; an administrator may recover orphaned ownership",
        );
      }

      await activeIdentity(repository, ownerUserId);
      if (access.owner_user_id !== ownerUserId) {
        await repository.upsertMember(projectId, ownerUserId, identity.id);
        if (existingOwner?.status === "active") {
          await repository.upsertMember(projectId, existingOwner.id, identity.id);
        }
        await repository.setOwner(projectId, ownerUserId);
      }

      return {
        schema_version: 2,
        project_id: projectId,
        owner_user_id: ownerUserId,
        members: await repository.listMembers(projectId),
      };
    });
  }
}
