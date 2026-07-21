// ONBOARDING O6: promoting an onboarded GitHub project to a binding the
// dispatch gate will accept.
//
// THE PROBLEM THIS CLOSES
// -----------------------
// O2 records a new project as two *candidate* attachments (the unverified
// tier). The Phase 4 dispatch gate requires `repository_bindings.status =
// 'connected'` plus a verified revision. Nothing ever moved a GitHub candidate
// across that line — `POST /api/v2/projects/:id/source-bindings/github` was
// never called by the web app, and it demands runner-reported fields
// (`observed_head`, `granted_permissions`) that no web-only flow can honestly
// supply. So every GitHub project was refused at dispatch and the entire
// Actions path was unreachable.
//
// WHAT `connected` MEANS HERE, AND WHY THIS IS THE HONEST MOMENT TO CLAIM IT
// -------------------------------------------------------------------------
// A repository binding is an *identity* claim: this project is bound to this
// repository, Norns can genuinely reach it, and this is the revision it is at.
// It is deliberately NOT a claim that the execution environment is ready.
//
// Promotion is therefore refused until each of those facts has been observed,
// every one by performing the operation rather than inferring it:
//
//   1. the installation can genuinely see the repository — a live probe
//      (GitHubIntegrationService.installationReadiness), NOT inferred from the
//      connection's `repository_selection`. A "selected repositories"
//      installation that excludes this repo answers 404 here;
//   2. the repository resolves through that installation — its numeric id and
//      default branch are read back, not taken from the client;
//   3. `contents: read` genuinely works and the branch has history — the head
//      revision is read back. That SHA becomes `observed_head`. It is a real
//      revision Norns read from GitHub, never a placeholder.
//
// Promotion is NOT gated on the Norns workflow file being installed, and this
// is a deliberate split rather than an omission. Workflow installation is the
// Actions execution module's concern: `ActionsExecutionCoordinator.schedule()`
// installs/upgrades the workflow and refuses with `actions_workflow_blocked`
// BEFORE it ever calls the Phase 4 gate. Duplicating that check here would mean
// two owners of one fact, and — worse — this module writing into a repository
// it does not own the write path for. So each layer refuses on its own
// evidence, and neither claims the other's.
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not weaken, bypass, or special-case the Phase 4 gate — the gate is
// untouched. It fabricates no runner-reported value. And it leaves the
// pre-existing laptop-runner promotion path (SourceBindingService.createLocal,
// driven by a runner's own report) completely alone: this is a second,
// GitHub-evidenced route to `connected`, not a replacement.
import { createHash } from "node:crypto";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { ACTIONS_GITHUB_TOKEN } from "./pushCredentialProvider.js";

/** Live readiness, probed rather than inferred. */
export interface ActivationReadiness {
  readonly ready: boolean;
  readonly reason: string;
  /** Human-actionable next step. Non-null exactly when `ready` is false. */
  readonly action_required: string | null;
  readonly manage_installation_url: string | null;
  readonly installation_id: string;
}

/** Facts read back from GitHub, each one proving a permission actually works. */
export interface RepositoryEvidence {
  readonly installation_id: string;
  readonly repository_github_id: number;
  readonly owner: string;
  readonly name: string;
  readonly default_branch: string;
  /** A real revision read from GitHub. Never synthesized. */
  readonly head_revision: string;
}

/**
 * Everything activation needs from outside the database. A port, so the
 * evidence rules below are testable without stubbing GitHub's HTTP surface and
 * so this module holds no GitHub knowledge of its own.
 */
export interface ProjectActivationPort {
  readiness(input: {
    connection_id: string;
    owner: string;
    name: string;
  }): Promise<ActivationReadiness>;

  evidence(input: {
    connection_id: string;
    repository_id: string;
    owner: string;
    name: string;
    actor_id: string;
  }): Promise<RepositoryEvidence>;
}

export class ProjectActivationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ProjectActivationError";
  }
}

export interface ActivationBlocker {
  readonly code: "installation_not_ready";
  readonly message: string;
  readonly action_required: string | null;
  readonly manage_installation_url: string | null;
}

export interface ActivationResult {
  readonly project_id: string;
  /** True only when a binding actually reached `connected`. */
  readonly activated: boolean;
  readonly workspace_binding_id: string | null;
  readonly remote_binding_id: string | null;
  readonly observed_head: string | null;
  readonly installation_ready: boolean;
  /** Empty exactly when `activated` is true. */
  readonly blockers: readonly ActivationBlocker[];
}

interface CandidateRow {
  id: string;
  role: "workspace" | "remote";
  service_connection_id: string | null;
  external_repository_id: string | null;
  github_owner: string | null;
  github_name: string | null;
  display_name: string;
}

function stableBindingId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `repository-binding:${digest}`;
}

/**
 * The runner identity an Actions-hosted ephemeral runner enrolls as. Mirrors
 * the Actions module's `actionsRunnerId()` — deliberately project-scoped, and
 * never shared with a laptop runner.
 *
 * Note this only ever lands in `repository_bindings.runner_id`, which for a
 * `binding_type = 'github'` row the dispatch gate does not match against (that
 * check applies to `local_runner` bindings only). It is provenance, not a
 * capability grant.
 */
export function actionsRunnerIdFor(projectId: string): string {
  return `actions:${projectId}`;
}

export class ProjectActivationService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly port: ProjectActivationPort,
  ) {}

  /**
   * Idempotent, and safe to call again after a human clears a blocker — which
   * is exactly how a project recovers from `installation_not_ready` rather than
   * being stranded with a repository it can never use.
   */
  async activate(input: { project_id: string; actor_id: string }): Promise<ActivationResult> {
    const candidates = await this.loadCandidates(input.project_id);
    const workspace = candidates.find((row) => row.role === "workspace");
    if (!workspace) {
      throw new ProjectActivationError(
        "no_repository_attached",
        "This project has no GitHub repository attached, so there is nothing to activate.",
        409,
      );
    }
    const connectionId = workspace.service_connection_id;
    const repositoryId = workspace.external_repository_id;
    const owner = workspace.github_owner;
    const name = workspace.github_name;
    if (!connectionId || !repositoryId || !owner || !name) {
      throw new ProjectActivationError(
        "repository_identity_incomplete",
        "This project's repository attachment is missing its GitHub identity and " +
          "cannot be activated; reconnect the repository.",
        409,
      );
    }

    // ---- Evidence 1: can the installation actually see the repository? ----
    // A hard blocker, and the reason nothing below runs when it fails: an
    // unreachable repository must never end up looking connected.
    const readiness = await this.port.readiness({ connection_id: connectionId, owner, name });
    if (!readiness.ready) {
      await this.recordInstallationState(input.project_id, false);
      return {
        project_id: input.project_id,
        activated: false,
        workspace_binding_id: null,
        remote_binding_id: null,
        observed_head: null,
        installation_ready: false,
        blockers: [
          {
            code: "installation_not_ready",
            message: `The Norns GitHub App installation does not include ${owner}/${name}, so no work can be dispatched there.`,
            action_required: readiness.action_required,
            manage_installation_url: readiness.manage_installation_url,
          },
        ],
      };
    }

    // ---- Evidence 2 + 3: resolve the repository and read its head ----
    const evidence = await this.port.evidence({
      connection_id: connectionId,
      repository_id: repositoryId,
      owner,
      name,
      actor_id: input.actor_id,
    });

    const bindingIds = await this.promote(input.project_id, candidates, evidence);
    return {
      project_id: input.project_id,
      activated: true,
      workspace_binding_id: bindingIds.workspace,
      remote_binding_id: bindingIds.remote,
      observed_head: evidence.head_revision,
      installation_ready: true,
      blockers: [],
    };
  }

  private loadCandidates(projectId: string): Promise<CandidateRow[]> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<CandidateRow>(
        `SELECT id, role, service_connection_id, external_repository_id,
                github_owner, github_name, display_name
         FROM repository_binding_candidates
         WHERE project_id = $1 AND source_type = 'github' AND status <> 'dismissed'
         ORDER BY role`,
        [projectId],
      );
      return result.rows;
    });
  }

  /** A failed readiness probe is durable state, so every read model agrees. */
  private recordInstallationState(projectId: string, ready: boolean): Promise<void> {
    return this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE repository_binding_candidates
         SET installation_ready = $2, updated_at = now()
         WHERE project_id = $1 AND status <> 'dismissed'`,
        [projectId, ready],
      );
    });
  }

  /**
   * The single moment a binding becomes `connected`, in one transaction, with
   * every field backed by something observed above.
   *
   * Deterministic binding ids make a repeat activation land on the same rows
   * instead of accumulating duplicates. The project's primary binding — the
   * column the dispatch gate resolves — is pointed at the WORKSPACE binding
   * specifically, never the remote.
   */
  private promote(
    projectId: string,
    candidates: readonly CandidateRow[],
    evidence: RepositoryEvidence,
  ): Promise<{ workspace: string; remote: string | null }> {
    return this.transactions.transaction(async (tx) => {
      let workspaceId: string | null = null;
      let remoteId: string | null = null;
      for (const candidate of candidates) {
        const bindingId = stableBindingId([
          projectId,
          candidate.role,
          "github",
          evidence.installation_id,
          String(evidence.repository_github_id),
        ]);
        await connectBinding(tx, {
          bindingId,
          projectId,
          role: candidate.role,
          evidence,
        });
        if (candidate.role === "workspace") workspaceId = bindingId;
        else remoteId = bindingId;
      }
      if (!workspaceId) {
        throw new ProjectActivationError(
          "no_repository_attached",
          "This project has no workspace repository attachment to activate.",
          409,
        );
      }
      await tx.query(
        `UPDATE projects SET primary_repository_binding_id = $2, updated_at = now()
         WHERE id = $1`,
        [projectId, workspaceId],
      );
      await tx.query(
        `UPDATE repository_binding_candidates
         SET status = 'promoted', installation_ready = true, updated_at = now()
         WHERE project_id = $1 AND source_type = 'github' AND status = 'unverified'`,
        [projectId],
      );
      await appendActivationAudit(tx, projectId, workspaceId, evidence);
      return { workspace: workspaceId, remote: remoteId };
    });
  }
}

/**
 * `granted_permissions` is left at its empty default ON PURPOSE. The column was
 * designed for a standing permission grant; Norns has none. Every GitHub call
 * mints a fresh installation token scoped to exactly what that call needs
 * (GITHUB_TOKEN_SCOPES, ADR-006), so writing a permission map here would
 * describe an arrangement that does not exist. Absent beats invented.
 *
 * `workflow_installed` likewise stays false: this module never installs the
 * workflow, so it has no evidence to set it. The read model derives the true
 * value from the Actions execution module's own record instead.
 */
async function connectBinding(
  tx: V2SqlExecutor,
  input: {
    bindingId: string;
    projectId: string;
    role: "workspace" | "remote";
    evidence: RepositoryEvidence;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO repository_bindings (
       id, project_id, role, binding_type, status, runner_id, workspace_id,
       repository_id, repository_display_name, github_installation_id,
       github_owner, github_name, granted_permissions, default_branch,
       observed_head, verification_policy_ref, repository_health,
       installation_ready, workflow_installed, push_credential_strategy,
       created_by_actor_type, created_by_actor_id, last_validated_at,
       last_synced_at
     ) VALUES (
       $1,$2,$3,'github','connected',$4,NULL,$5,$6,$7,$8,$9,'{}'::jsonb,$10,
       $11,'verification-policy:default-v1','healthy',true,false,$12,
       'system',NULL,now(),now()
     )
     ON CONFLICT (id) DO UPDATE SET
       status = 'connected',
       repository_health = 'healthy',
       observed_head = EXCLUDED.observed_head,
       default_branch = EXCLUDED.default_branch,
       installation_ready = true,
       last_validated_at = now(),
       last_synced_at = now(),
       updated_at = now()`,
    [
      input.bindingId,
      input.projectId,
      input.role,
      actionsRunnerIdFor(input.projectId),
      String(input.evidence.repository_github_id),
      `${input.evidence.owner}/${input.evidence.name}`,
      input.evidence.installation_id,
      input.evidence.owner,
      input.evidence.name,
      input.evidence.default_branch,
      input.evidence.head_revision,
      ACTIONS_GITHUB_TOKEN,
    ],
  );
}

async function appendActivationAudit(
  tx: V2SqlExecutor,
  projectId: string,
  workspaceBindingId: string,
  evidence: RepositoryEvidence,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (
       audit_id, audit_type, project_id, actor_type, actor_id, outcome, severity,
       correlation_id, causation_id, occurred_at, targets, summary, details,
       redaction_applied
     ) VALUES (
       $1,'repository_binding.connected',$2,'system',NULL,'succeeded','info',$3,NULL,now(),
       $4::jsonb,'Repository binding connected from GitHub-observed evidence',$5::jsonb,true
     ) ON CONFLICT (audit_id) DO NOTHING`,
    [
      `audit:activation:${createHash("sha256").update(workspaceBindingId).digest("hex").slice(0, 32)}`,
      projectId,
      `repository-binding:${workspaceBindingId}`,
      JSON.stringify([
        { entity_type: "project", entity_id: projectId },
        { entity_type: "repository_binding", entity_id: workspaceBindingId },
      ]),
      // Named evidence, so an auditor can see exactly what was verified rather
      // than having to trust that "connected" meant something.
      JSON.stringify({
        evidence: ["installation_probe", "repository_resolved", "head_revision_read"],
        observed_head: evidence.head_revision,
        repository: `${evidence.owner}/${evidence.name}`,
      }),
    ],
  );
}
