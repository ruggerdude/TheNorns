import { z } from "zod";
import {
  V2Actor,
  V2EntityId,
  V2IsoDateTime,
  V2NonEmptyString,
  V2PositiveVersion,
} from "./common.js";

export const V2RepositoryBindingStatus = z.enum([
  "unverified_candidate",
  "validating",
  "connected",
  "degraded",
  "disconnected",
  "revoked",
]);
export type V2RepositoryBindingStatusT = z.infer<typeof V2RepositoryBindingStatus>;

export const V2RepositoryHealth = z.enum(["unknown", "healthy", "degraded", "unavailable"]);
export type V2RepositoryHealthT = z.infer<typeof V2RepositoryHealth>;

const V2RepositoryBindingBase = z.object({
  schema_version: z.literal(2),
  id: V2EntityId,
  project_id: V2EntityId,
  status: V2RepositoryBindingStatus,
  default_branch: V2NonEmptyString,
  observed_head: V2NonEmptyString.nullable(),
  verification_policy_ref: V2EntityId,
  repository_health: V2RepositoryHealth,
  last_validated_at: V2IsoDateTime.nullable(),
  last_synced_at: V2IsoDateTime.nullable(),
  created_by: V2Actor,
  aggregate_version: V2PositiveVersion,
  created_at: V2IsoDateTime,
  updated_at: V2IsoDateTime,
});

export const V2LocalRunnerRepositoryBinding = V2RepositoryBindingBase.extend({
  binding_type: z.literal("local_runner"),
  runner_id: V2EntityId,
  workspace_id: V2EntityId,
  repository_id: V2EntityId,
  repository_display_name: V2NonEmptyString,
}).strict();
export type V2LocalRunnerRepositoryBindingT = z.infer<typeof V2LocalRunnerRepositoryBinding>;

export const V2GitHubRepositoryBinding = V2RepositoryBindingBase.extend({
  binding_type: z.literal("github"),
  github_installation_id: V2EntityId,
  github_repository_id: V2EntityId,
  owner: V2NonEmptyString,
  name: V2NonEmptyString,
  runner_id: V2EntityId,
  granted_permissions: z
    .object({
      metadata: z.literal("read"),
      contents: z.enum(["read", "write"]),
      pull_requests: z.enum(["none", "read", "write"]),
      checks: z.enum(["none", "read"]),
      actions: z.enum(["none", "read"]),
    })
    .strict(),
}).strict();
export type V2GitHubRepositoryBindingT = z.infer<typeof V2GitHubRepositoryBinding>;

export const V2RepositoryBinding = z.discriminatedUnion("binding_type", [
  V2LocalRunnerRepositoryBinding,
  V2GitHubRepositoryBinding,
]);
export type V2RepositoryBindingT = z.infer<typeof V2RepositoryBinding>;

export const V2CreateLocalRepositoryBinding = z
  .object({
    project_id: V2EntityId,
    runner_id: V2EntityId,
    workspace_id: V2EntityId,
    repository_id: V2EntityId,
    repository_display_name: V2NonEmptyString,
    default_branch: V2NonEmptyString,
    observed_head: V2NonEmptyString,
    verification_policy_ref: V2EntityId,
    created_by: V2Actor,
  })
  .strict();
export type V2CreateLocalRepositoryBindingT = z.infer<typeof V2CreateLocalRepositoryBinding>;

export const V2CreateGitHubRepositoryBinding = z
  .object({
    project_id: V2EntityId,
    runner_id: V2EntityId,
    github_installation_id: V2EntityId,
    github_repository_id: V2EntityId,
    owner: V2NonEmptyString,
    name: V2NonEmptyString,
    default_branch: V2NonEmptyString,
    observed_head: V2NonEmptyString,
    verification_policy_ref: V2EntityId,
    granted_permissions: V2GitHubRepositoryBinding.shape.granted_permissions,
    created_by: V2Actor,
  })
  .strict();
export type V2CreateGitHubRepositoryBindingT = z.infer<typeof V2CreateGitHubRepositoryBinding>;
