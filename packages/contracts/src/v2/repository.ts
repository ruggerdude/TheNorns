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

const V2RepositoryDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
    "repository display name must not contain path separators or control characters",
  );

export const V2LocalRunnerRepositoryBinding = V2RepositoryBindingBase.extend({
  binding_type: z.literal("local_runner"),
  runner_id: V2EntityId,
  workspace_id: V2EntityId,
  repository_id: V2EntityId,
  repository_display_name: V2RepositoryDisplayName,
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
    repository_display_name: V2RepositoryDisplayName,
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

export const V2RepositoryIngestionSeed = z
  .object({
    project_id: V2EntityId,
    repository_binding_id: V2EntityId,
    repository_revision: V2NonEmptyString,
    architecture: z
      .object({
        title: V2NonEmptyString,
        summary: V2NonEmptyString,
        artifact: z
          .object({
            storage_ref: V2NonEmptyString,
            content_hash: z.string().regex(/^[a-f0-9]{64}$/),
            byte_size: z.number().int().nonnegative(),
            media_type: V2NonEmptyString,
          })
          .strict(),
      })
      .strict(),
    repository_facts: z
      .array(
        z
          .object({
            key: V2NonEmptyString,
            value: V2NonEmptyString,
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(500),
    constraints: z.array(V2NonEmptyString).max(100),
    directives: z.array(V2NonEmptyString).max(100),
    assignment_policy_ref: V2EntityId,
    verification_policy_ref: V2EntityId,
    budget_policy_ref: V2EntityId,
    created_by: V2Actor,
  })
  .strict()
  .superRefine((seed, ctx) => {
    if (seed.created_by.actor_type !== "human" || seed.created_by.actor_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["created_by"],
        message: "initial project directives require an attributable human actor",
      });
    }
  });
export type V2RepositoryIngestionSeedT = z.infer<typeof V2RepositoryIngestionSeed>;

export const V2ProjectResume = z
  .object({
    schema_version: z.literal(2),
    project: z
      .object({
        id: V2EntityId,
        name: V2NonEmptyString,
        description: z.string(),
        status: V2NonEmptyString,
        aggregate_version: V2PositiveVersion,
      })
      .strict(),
    architecture: z
      .object({
        id: V2EntityId,
        revision: V2PositiveVersion,
        title: V2NonEmptyString,
        summary: V2NonEmptyString,
        repository_revision: V2NonEmptyString,
      })
      .strict()
      .nullable(),
    repositories: z.array(
      z
        .object({
          id: V2EntityId,
          binding_type: z.enum(["local_runner", "github"]),
          display_name: V2NonEmptyString,
          status: V2RepositoryBindingStatus,
          health: V2RepositoryHealth,
          observed_head: V2NonEmptyString.nullable(),
        })
        .strict(),
    ),
    phases: z.array(
      z
        .object({
          id: V2EntityId,
          objective_summary: V2NonEmptyString,
          priority: z.number().int().nonnegative(),
          status: V2NonEmptyString,
          approved_strategy_version_id: V2EntityId.nullable(),
          objectives: z.number().int().nonnegative(),
          tasks: z.number().int().nonnegative(),
          completed_tasks: z.number().int().nonnegative(),
          blocked_tasks: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    attention: z
      .object({
        open_decisions: z.number().int().nonnegative(),
        active_runs: z.number().int().nonnegative(),
        blocked_tasks: z.number().int().nonnegative(),
      })
      .strict(),
    active_memory_entries: z.number().int().nonnegative(),
    recent_completions: z.array(
      z
        .object({
          task_id: V2EntityId,
          title: V2NonEmptyString,
          completed_at: V2IsoDateTime,
        })
        .strict(),
    ),
    next_recommended_action: V2NonEmptyString,
  })
  .strict();
export type V2ProjectResumeT = z.infer<typeof V2ProjectResume>;
