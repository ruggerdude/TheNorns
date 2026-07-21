import { createHash } from "node:crypto";
import {
  V2CreateGitHubRepositoryBinding,
  type V2CreateGitHubRepositoryBindingT,
  V2CreateLocalRepositoryBinding,
  type V2CreateLocalRepositoryBindingT,
  V2RepositoryBinding,
  type V2RepositoryBindingT,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { safeLocalRepositoryDisplayName } from "./repositoryDisplayName.js";

interface RepositoryBindingRow {
  id: string;
  project_id: string;
  binding_type: "local_runner" | "github";
  status: V2RepositoryBindingT["status"];
  runner_id: string;
  workspace_id: string | null;
  repository_id: string;
  repository_display_name: string;
  github_installation_id: string | null;
  github_owner: string | null;
  github_name: string | null;
  granted_permissions: unknown;
  default_branch: string;
  observed_head: string | null;
  verification_policy_ref: string;
  repository_health: V2RepositoryBindingT["repository_health"];
  created_by_actor_type: V2RepositoryBindingT["created_by"]["actor_type"];
  created_by_actor_id: string | null;
  aggregate_version: number;
  last_validated_at: Date | string | null;
  last_synced_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export class SourceBindingProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} does not exist`);
    this.name = "SourceBindingProjectNotFoundError";
  }
}

function stableBindingId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `repository-binding:${digest}`;
}

function stableBindingAuditId(bindingId: string): string {
  const digest = createHash("sha256").update(bindingId).digest("hex").slice(0, 32);
  return `audit:repository-binding:${digest}`;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapBinding(row: RepositoryBindingRow): V2RepositoryBindingT {
  const base = {
    schema_version: 2 as const,
    id: row.id,
    project_id: row.project_id,
    status: row.status,
    default_branch: row.default_branch,
    observed_head: row.observed_head,
    verification_policy_ref: row.verification_policy_ref,
    repository_health: row.repository_health,
    last_validated_at: row.last_validated_at === null ? null : iso(row.last_validated_at),
    last_synced_at: row.last_synced_at === null ? null : iso(row.last_synced_at),
    created_by: {
      actor_type: row.created_by_actor_type,
      actor_id: row.created_by_actor_id,
    },
    aggregate_version: row.aggregate_version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
  return V2RepositoryBinding.parse(
    row.binding_type === "local_runner"
      ? {
          ...base,
          binding_type: "local_runner",
          runner_id: row.runner_id,
          workspace_id: row.workspace_id,
          repository_id: row.repository_id,
          repository_display_name:
            safeLocalRepositoryDisplayName(row.repository_display_name) ?? "Local repository",
        }
      : {
          ...base,
          binding_type: "github",
          runner_id: row.runner_id,
          github_installation_id: row.github_installation_id,
          github_repository_id: row.repository_id,
          owner: row.github_owner,
          name: row.github_name,
          granted_permissions: row.granted_permissions,
        },
  );
}

async function assertProject(tx: V2SqlExecutor, projectId: string): Promise<void> {
  const project = await tx.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
  if (project.rows.length === 0) throw new SourceBindingProjectNotFoundError(projectId);
}

async function insertAndSelect(
  tx: V2SqlExecutor,
  values: readonly unknown[],
): Promise<V2RepositoryBindingT> {
  await tx.query(
    `INSERT INTO repository_bindings (
       id, project_id, binding_type, status, runner_id, workspace_id,
       repository_id, repository_display_name, github_installation_id,
       github_owner, github_name, granted_permissions, default_branch,
       observed_head, verification_policy_ref, repository_health,
       created_by_actor_type, created_by_actor_id, last_validated_at
     ) VALUES (
       $1,$2,$3,'connected',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,
       'healthy',$15,$16,now()
     ) ON CONFLICT DO NOTHING`,
    [...values],
  );
  const selected = await tx.query<RepositoryBindingRow>(
    "SELECT * FROM repository_bindings WHERE id = $1",
    [values[0]],
  );
  const row = selected.rows[0];
  if (!row) throw new Error("repository binding conflict did not resolve to its stable identity");
  await tx.query(
    `UPDATE projects SET primary_repository_binding_id = $2, updated_at = now()
     WHERE id = $1 AND primary_repository_binding_id IS NULL`,
    [row.project_id, row.id],
  );
  return mapBinding(row);
}

async function appendBindingAudit(tx: V2SqlExecutor, binding: V2RepositoryBindingT): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (
       audit_id, audit_type, project_id, actor_type, actor_id, outcome, severity,
       correlation_id, causation_id, occurred_at, targets, summary, details,
       redaction_applied
     ) VALUES (
       $1,'repository_binding.connected',$2,$3,$4,'succeeded','info',$5,NULL,now(),
       $6::jsonb,'Repository binding connected',$7::jsonb,true
     ) ON CONFLICT (audit_id) DO NOTHING`,
    [
      stableBindingAuditId(binding.id),
      binding.project_id,
      binding.created_by.actor_type,
      binding.created_by.actor_id,
      `repository-binding:${binding.id}`,
      JSON.stringify([
        { entity_type: "project", entity_id: binding.project_id },
        { entity_type: "repository_binding", entity_id: binding.id },
      ]),
      JSON.stringify({
        binding_type: binding.binding_type,
        runner_id: binding.runner_id,
        ...(binding.binding_type === "local_runner"
          ? {
              workspace_id: binding.workspace_id,
              repository_id: binding.repository_id,
            }
          : {
              github_installation_id: binding.github_installation_id,
              github_repository_id: binding.github_repository_id,
            }),
      }),
    ],
  );
}

export class SourceBindingService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  createLocal(input: V2CreateLocalRepositoryBindingT): Promise<V2RepositoryBindingT> {
    const command = V2CreateLocalRepositoryBinding.parse(input);
    const id = stableBindingId([
      command.project_id,
      "local_runner",
      command.runner_id,
      command.workspace_id,
      command.repository_id,
    ]);
    return this.transactions.transaction(async (tx) => {
      await assertProject(tx, command.project_id);
      const binding = await insertAndSelect(tx, [
        id,
        command.project_id,
        "local_runner",
        command.runner_id,
        command.workspace_id,
        command.repository_id,
        command.repository_display_name,
        null,
        null,
        null,
        JSON.stringify({}),
        command.default_branch,
        command.observed_head,
        command.verification_policy_ref,
        command.created_by.actor_type,
        command.created_by.actor_id,
      ]);
      // FRONT DOOR P2b (D2): "when a paired runner later reports the
      // workspace, existing verification flows mark it verified" — this is
      // that state connection. A folder-first local project (created with
      // no runner online) has only an 'unverified' repository_binding_candidates
      // row; once this runner-verified binding lands, close that candidate
      // out as 'promoted' so it stops appearing as a separate pending
      // repository in the resume view (see projectResumeService's NOT
      // EXISTS clause).
      await tx.query(
        `UPDATE repository_binding_candidates
           SET status = 'promoted', updated_at = now()
         WHERE project_id = $1 AND source_type = 'local' AND status = 'unverified'`,
        [command.project_id],
      );
      await appendBindingAudit(tx, binding);
      return binding;
    });
  }

  createGitHub(input: V2CreateGitHubRepositoryBindingT): Promise<V2RepositoryBindingT> {
    const command = V2CreateGitHubRepositoryBinding.parse(input);
    const id = stableBindingId([
      command.project_id,
      "github",
      command.github_installation_id,
      command.github_repository_id,
    ]);
    return this.transactions.transaction(async (tx) => {
      await assertProject(tx, command.project_id);
      const binding = await insertAndSelect(tx, [
        id,
        command.project_id,
        "github",
        command.runner_id,
        null,
        command.github_repository_id,
        `${command.owner}/${command.name}`,
        command.github_installation_id,
        command.owner,
        command.name,
        JSON.stringify(command.granted_permissions),
        command.default_branch,
        command.observed_head,
        command.verification_policy_ref,
        command.created_by.actor_type,
        command.created_by.actor_id,
      ]);
      await appendBindingAudit(tx, binding);
      return binding;
    });
  }
}
