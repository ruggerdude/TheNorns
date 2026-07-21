// ONBOARDING O2: the four project-creation commands.
//
// Project setup covers exactly four scenarios, and a project may involve BOTH
// a local folder and a GitHub repository -- build locally, push remotely:
//
//   1. new_local        NEW, local only. An empty local folder stages the work.
//   2. new_local_github NEW, local + GitHub. Local folder stages the work; a
//                       GitHub repository (existing or newly created) is the
//                       push target.
//   3. existing_github  EXISTING on GitHub. Clone/stage into a chosen local
//                       folder, work there, push back.
//   4. existing_local   EXISTING locally. Take the folder as it stands and
//                       connect it to a GitHub repository.
//
// Scenarios 2, 3 and 4 produce TWO attachments in one command:
//   * the WORKSPACE -- where execution happens (role 'workspace'); this is
//     what `projects.primary_repository_binding_id` and therefore the
//     Phase4Coordinator dispatch gate resolve. Untouched by this phase.
//   * the REMOTE    -- the push / PR target (role 'remote'), always GitHub.
//
// A GitHub-only project (no local folder) remains valid and unchanged: it is
// still created through POST /api/projects with source_type 'github', which
// produces a single role='workspace' GitHub attachment.
//
// Tiers: an attachment is materialized either as a real `repository_bindings`
// row (verified, runner-confirmed) or as a `repository_binding_candidates` row
// (FRONT DOOR D2's unverified tier, used when no runner can confirm the
// folder). O2 adds the role concept to both tiers so it survives promotion.
import { createHash } from "node:crypto";
import type { ProviderName } from "@norns/adapters";
import type { PmModelT } from "@norns/contracts";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  type PushCredentialDecision,
  decidePushCredentialStrategy,
  localGitRemoteFallback,
} from "./pushCredentialProvider.js";
import { insertProjectCore } from "./relationalReadRepository.js";
import type { RemoteRepositoryDescriptor, RemoteRepositoryPort } from "./remoteRepositoryPort.js";
import { safeLocalRepositoryDisplayName } from "./repositoryDisplayName.js";
import { reviewerFor } from "./store.js";
import {
  OfflineWorkspaceVerification,
  type WorkspaceFolderExpectationT,
  type WorkspaceFolderReportT,
  type WorkspaceVerificationPort,
  WorkspaceVerificationUnavailableError,
  judgeWorkspaceReport,
} from "./workspaceVerification.js";

export const ONBOARDING_SCENARIOS = [
  "new_local",
  "new_local_github",
  "existing_github",
  "existing_local",
] as const;
export type OnboardingScenario = (typeof ONBOARDING_SCENARIOS)[number];

/** Which folder expectation each scenario places on its workspace. */
const WORKSPACE_EXPECTATION: Record<OnboardingScenario, WorkspaceFolderExpectationT> = {
  new_local: "empty_or_absent",
  new_local_github: "empty_or_absent",
  // The clone target must be empty; the clone itself is the runner's job.
  existing_github: "empty_or_absent",
  existing_local: "existing_git_repository",
};

export interface OnboardingActor {
  readonly actor_type: "human" | "agent" | "system";
  readonly actor_id: string;
}

/** How the command should obtain the remote repository. */
export type RemoteSelection =
  | { readonly mode: "existing"; readonly connection_id: string; readonly repository_id: string }
  | {
      readonly mode: "create";
      readonly connection_id: string;
      readonly name: string;
      readonly private: boolean;
    };

export interface OnboardingCommandBase {
  readonly name: string;
  readonly description: string;
  readonly pm_provider: ProviderName;
  readonly pm_model: PmModelT | null;
  readonly actor: OnboardingActor;
  readonly idempotency_key: string;
}

export interface NewLocalCommand extends OnboardingCommandBase {
  readonly local_path: string;
}

export interface NewLocalWithGitHubCommand extends NewLocalCommand {
  readonly remote: RemoteSelection;
}

export interface ExistingGitHubCommand extends OnboardingCommandBase {
  readonly local_path: string;
  readonly remote: Extract<RemoteSelection, { mode: "existing" }>;
}

export interface ExistingLocalCommand extends OnboardingCommandBase {
  readonly local_path: string;
  readonly remote: RemoteSelection;
}

export class OnboardingValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OnboardingValidationError";
  }
}

export interface OnboardingAttachmentView {
  readonly id: string;
  /** 'binding' = verified row; 'candidate' = FRONT DOOR D2 unverified tier. */
  readonly tier: "binding" | "candidate";
  readonly role: "workspace" | "remote";
  readonly kind: "local_runner" | "github";
  readonly display_name: string;
  readonly status: string;
  readonly verified: boolean;
  readonly github: { owner: string; name: string; url: string } | null;
  readonly observed_head: string | null;
}

export interface OnboardingResult {
  readonly project_id: string;
  readonly scenario: OnboardingScenario;
  readonly replayed: boolean;
  readonly workspace: OnboardingAttachmentView | null;
  readonly remote: OnboardingAttachmentView | null;
  readonly push: PushCredentialDecision | null;
  /**
   * Honest, non-fatal notes. The runner-offline case lands here rather than
   * failing the command (FRONT DOOR D2).
   */
  readonly warnings: readonly string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic, actor-scoped project identity: the idempotency mechanism. */
function onboardingProjectId(actor: OnboardingActor, idempotencyKey: string): string {
  const digest = sha256(
    JSON.stringify(["project-onboarding", actor.actor_type, actor.actor_id, idempotencyKey]),
  ).slice(0, 32);
  return `proj_onboarding_${digest}`;
}

function submissionId(actor: OnboardingActor, idempotencyKey: string): string {
  const digest = sha256(
    JSON.stringify(["onboarding-submission", actor.actor_type, actor.actor_id, idempotencyKey]),
  ).slice(0, 32);
  return `onboarding:${digest}`;
}

/**
 * The operator's raw folder path never reaches storage. Only an opaque
 * fingerprint and a sanitized last-segment display name do -- the same rule
 * RelationalProjectReadRepository.create already follows.
 */
function localIdentity(localPath: string): { fingerprint: string; displayName: string } {
  const segment = localPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
  return {
    fingerprint: sha256(localPath),
    displayName: safeLocalRepositoryDisplayName(segment) ?? "Local workspace",
  };
}

export interface AttachmentRow {
  id: string;
  tier: "binding" | "candidate";
  role: "workspace" | "remote";
  kind: "local_runner" | "github";
  display_name: string;
  status: string;
  github_owner: string | null;
  github_name: string | null;
  observed_head: string | null;
  push_credential_strategy: string | null;
  remote_provisioning: string | null;
  remote_installation_ready: boolean | null;
}

const VERIFIED_STATUSES = new Set(["connected", "promoted"]);

export function attachmentView(row: AttachmentRow): OnboardingAttachmentView {
  return {
    id: row.id,
    tier: row.tier,
    role: row.role,
    kind: row.kind,
    display_name:
      row.kind === "local_runner"
        ? (safeLocalRepositoryDisplayName(row.display_name) ?? "Local workspace")
        : row.display_name,
    status: row.status,
    verified: row.tier === "binding" && VERIFIED_STATUSES.has(row.status),
    github:
      row.github_owner && row.github_name
        ? {
            owner: row.github_owner,
            name: row.github_name,
            url: `github.com/${row.github_owner}/${row.github_name}`,
          }
        : null,
    observed_head: row.observed_head,
  };
}

/**
 * Both tiers, unioned and resolved by role. Shared by this service and the
 * resume read model so a project can only ever describe itself one way.
 */
export const ONBOARDING_ATTACHMENTS_SQL = `
  SELECT binding.id,
         'binding'::text AS tier,
         binding.role,
         binding.binding_type AS kind,
         binding.repository_display_name AS display_name,
         binding.status,
         binding.github_owner,
         binding.github_name,
         binding.observed_head,
         binding.push_credential_strategy,
         binding.remote_provisioning,
         binding.remote_installation_ready,
         binding.created_at
  FROM repository_bindings binding
  WHERE binding.project_id = $1
    AND binding.status NOT IN ('revoked', 'disconnected')
  UNION ALL
  SELECT candidate.id,
         'candidate'::text AS tier,
         candidate.role,
         CASE candidate.source_type
           WHEN 'local' THEN 'local_runner'::text
           ELSE 'github'::text
         END AS kind,
         candidate.display_name,
         candidate.status,
         candidate.github_owner,
         candidate.github_name,
         NULL::text AS observed_head,
         candidate.push_credential_strategy,
         candidate.remote_provisioning,
         candidate.remote_installation_ready,
         candidate.created_at
  FROM repository_binding_candidates candidate
  WHERE candidate.project_id = $1
    AND candidate.status <> 'dismissed'
    AND NOT EXISTS (
      SELECT 1 FROM repository_bindings promoted
      WHERE promoted.project_id = candidate.project_id
        AND promoted.role = candidate.role
        AND promoted.status NOT IN ('revoked', 'disconnected')
    )
`;

async function readAttachments(
  tx: V2SqlExecutor,
  projectId: string,
): Promise<{ workspace: AttachmentRow | null; remote: AttachmentRow | null }> {
  const rows = await tx.query<AttachmentRow>(
    `SELECT id, tier, role, kind, display_name, status, github_owner, github_name,
            observed_head, push_credential_strategy, remote_provisioning,
            remote_installation_ready
     FROM (${ONBOARDING_ATTACHMENTS_SQL}) attachment
     ORDER BY CASE tier WHEN 'binding' THEN 0 ELSE 1 END, created_at, id`,
    [projectId],
  );
  return {
    workspace: rows.rows.find((row) => row.role === "workspace") ?? null,
    remote: rows.rows.find((row) => row.role === "remote") ?? null,
  };
}

export interface ProjectOnboardingServiceOptions {
  readonly transactions: V2TransactionRunner;
  readonly remotes: RemoteRepositoryPort;
  /** Defaults to the offline port: every folder-first creation is unverified. */
  readonly workspaces?: WorkspaceVerificationPort;
}

export class ProjectOnboardingService {
  private readonly transactions: V2TransactionRunner;
  private readonly remotes: RemoteRepositoryPort;
  private readonly workspaces: WorkspaceVerificationPort;

  constructor(options: ProjectOnboardingServiceOptions) {
    this.transactions = options.transactions;
    this.remotes = options.remotes;
    this.workspaces = options.workspaces ?? new OfflineWorkspaceVerification();
  }

  /** Scenario 1: NEW, local only. */
  createNewLocal(command: NewLocalCommand): Promise<OnboardingResult> {
    return this.run("new_local", command, null);
  }

  /** Scenario 2: NEW, local folder + GitHub push target. */
  createNewLocalWithGitHub(command: NewLocalWithGitHubCommand): Promise<OnboardingResult> {
    return this.run("new_local_github", command, command.remote);
  }

  /** Scenario 3: EXISTING on GitHub, staged into a chosen local folder. */
  createFromGitHub(command: ExistingGitHubCommand): Promise<OnboardingResult> {
    return this.run("existing_github", command, command.remote);
  }

  /** Scenario 4: EXISTING locally, connected to a GitHub repository. */
  createFromExistingLocal(command: ExistingLocalCommand): Promise<OnboardingResult> {
    return this.run("existing_local", command, command.remote);
  }

  private async run(
    scenario: OnboardingScenario,
    command: OnboardingCommandBase & { local_path: string },
    remoteSelection: RemoteSelection | null,
  ): Promise<OnboardingResult> {
    if (!command.local_path.trim()) {
      throw new OnboardingValidationError("local_path_required", "choose a local folder");
    }
    const projectId = onboardingProjectId(command.actor, command.idempotency_key);

    // ---- replay short-circuit -------------------------------------------
    // A double submit must not re-run folder verification and must never
    // create a second GitHub repository. The deterministic project id plus
    // the submissions row make the replay observable before any side effect.
    const replay = await this.transactions.transaction(async (tx) => {
      const existing = await tx.query<{ scenario: OnboardingScenario }>(
        "SELECT scenario FROM project_onboarding_submissions WHERE idempotency_id = $1",
        [submissionId(command.actor, command.idempotency_key)],
      );
      const row = existing.rows[0];
      if (!row) return null;
      if (row.scenario !== scenario) {
        throw new OnboardingValidationError(
          "idempotency_key_reused",
          `idempotency key already used for a "${row.scenario}" project`,
        );
      }
      const attachments = await readAttachments(tx, projectId);
      return { attachments };
    });
    if (replay) {
      return this.assemble(projectId, scenario, replay.attachments, true, []);
    }

    const warnings: string[] = [];

    // ---- side effects, outside the transaction --------------------------
    // Neither of these may run inside the write transaction: one talks to a
    // runner, the other to GitHub, and ADR-005's transactional boundary must
    // not be held open across a network call.
    let report: WorkspaceFolderReportT | null = null;
    try {
      report = judgeWorkspaceReport(
        WORKSPACE_EXPECTATION[scenario],
        await this.workspaces.inspect({
          local_path: command.local_path,
          expectation: WORKSPACE_EXPECTATION[scenario],
        }),
      );
    } catch (error) {
      // FRONT DOOR D2: runner offline is not a failure. A folder that a
      // runner DID look at and disqualify is.
      if (!(error instanceof WorkspaceVerificationUnavailableError)) throw error;
      warnings.push(
        "no runner was online to check the folder, so it is attached unverified; " +
          "Norns will verify it when a runner reports the workspace",
      );
    }

    const remote = remoteSelection ? await this.provisionRemote(command, remoteSelection) : null;
    if (remote && !remote.descriptor.binding_ready) {
      const grantHint = "grant the installation access to it before Norns can push there";
      warnings.push(
        `${remote.descriptor.full_name} is not inside the GitHub App installation yet; ${grantHint}`,
      );
    }

    // ---- one transaction -------------------------------------------------
    const attachments = await this.transactions.transaction(async (tx) => {
      const createdAt = new Date().toISOString();
      await insertProjectCore(tx, {
        projectId,
        name: command.name,
        description: command.description,
        pmProvider: command.pm_provider,
        pmModel: command.pm_model,
        reviewerProvider: reviewerFor(command.pm_provider),
        createdAt,
        onboardingScenario: scenario,
      });

      const local = localIdentity(command.local_path);
      const push = remote
        ? decidePushCredentialStrategy({ remote: remote.descriptor, hasLocalWorkspace: true })
        : null;
      await this.insertCandidate(tx, {
        projectId,
        role: "workspace",
        sourceType: "local",
        fingerprint: local.fingerprint,
        displayName: local.displayName,
        githubOwner: null,
        githubName: null,
        connectionId: null,
        externalRepositoryId: null,
        defaultBranch: report?.default_branch ?? null,
        pushCredentialStrategy: null,
        remoteProvisioning: null,
        remoteInstallationReady: null,
        createdAt,
      });
      if (remote) {
        await this.insertCandidate(tx, {
          projectId,
          role: "remote",
          sourceType: "github",
          fingerprint: sha256(remote.descriptor.clone_url),
          displayName: remote.descriptor.full_name,
          githubOwner: remote.descriptor.owner,
          githubName: remote.descriptor.name,
          connectionId: remote.descriptor.connection_id,
          externalRepositoryId: remote.descriptor.repository_id,
          defaultBranch: remote.descriptor.default_branch,
          pushCredentialStrategy: push?.strategy ?? null,
          remoteProvisioning: remote.provisioning,
          remoteInstallationReady: remote.descriptor.binding_ready,
          createdAt,
        });
      }

      await tx.query(
        `INSERT INTO project_onboarding_submissions (
           idempotency_id, project_id, scenario, actor_type, actor_id, idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_id) DO NOTHING`,
        [
          submissionId(command.actor, command.idempotency_key),
          projectId,
          scenario,
          command.actor.actor_type,
          command.actor.actor_id,
          command.idempotency_key,
        ],
      );
      await this.appendAudit(tx, projectId, scenario, command.actor, remote);
      return readAttachments(tx, projectId);
    });

    return this.assemble(projectId, scenario, attachments, false, warnings);
  }

  /**
   * Resolves or creates the GitHub repository, without ever creating twice.
   *
   * GitHub's repository creation is not idempotent; a retry returns 422 and
   * GitHubIntegrationService surfaces that as a generic github_api_error. So
   * a 'create' selection always looks for the repository by name first and
   * only creates when it genuinely is not there.
   */
  private async provisionRemote(
    command: OnboardingCommandBase,
    selection: RemoteSelection,
  ): Promise<{
    descriptor: RemoteRepositoryDescriptor;
    provisioning: "selected_existing" | "created";
  }> {
    if (selection.mode === "existing") {
      const descriptor = await this.remotes.resolveById({
        actor_id: command.actor.actor_id,
        connection_id: selection.connection_id,
        repository_id: selection.repository_id,
      });
      return { descriptor, provisioning: "selected_existing" };
    }
    const found = await this.remotes.findByName({
      actor_id: command.actor.actor_id,
      connection_id: selection.connection_id,
      name: selection.name,
    });
    if (found) return { descriptor: found, provisioning: "created" };
    const descriptor = await this.remotes.create({
      actor_id: command.actor.actor_id,
      connection_id: selection.connection_id,
      name: selection.name,
      description: command.description,
      private: selection.private,
    });
    return { descriptor, provisioning: "created" };
  }

  private async insertCandidate(
    tx: V2SqlExecutor,
    input: {
      projectId: string;
      role: "workspace" | "remote";
      sourceType: "local" | "github";
      fingerprint: string;
      displayName: string;
      githubOwner: string | null;
      githubName: string | null;
      connectionId: string | null;
      externalRepositoryId: string | null;
      defaultBranch: string | null;
      pushCredentialStrategy: string | null;
      remoteProvisioning: string | null;
      remoteInstallationReady: boolean | null;
      createdAt: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO repository_binding_candidates (
         id, project_id, role, source_type, source_fingerprint, display_name,
         github_owner, github_name, service_connection_id,
         external_repository_id, default_branch, push_credential_strategy,
         remote_provisioning, remote_installation_ready, status,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'unverified',$15,$15)
       ON CONFLICT (project_id, source_type, source_fingerprint) DO NOTHING`,
      [
        newId("binding_candidate"),
        input.projectId,
        input.role,
        input.sourceType,
        input.fingerprint,
        input.displayName,
        input.githubOwner,
        input.githubName,
        input.connectionId,
        input.externalRepositoryId,
        input.defaultBranch,
        input.pushCredentialStrategy,
        input.remoteProvisioning,
        input.remoteInstallationReady,
        input.createdAt,
      ],
    );
  }

  private async appendAudit(
    tx: V2SqlExecutor,
    projectId: string,
    scenario: OnboardingScenario,
    actor: OnboardingActor,
    remote: { descriptor: RemoteRepositoryDescriptor; provisioning: string } | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO audit_events (
         audit_id, audit_type, project_id, actor_type, actor_id, outcome, severity,
         correlation_id, causation_id, occurred_at, targets, summary, details,
         redaction_applied
       ) VALUES (
         $1,'project.onboarded',$2,$3,$4,'succeeded','info',$5,NULL,now(),
         $6::jsonb,'Project onboarded',$7::jsonb,true
       ) ON CONFLICT (audit_id) DO NOTHING`,
      [
        `audit:onboarding:${sha256(projectId).slice(0, 32)}`,
        projectId,
        actor.actor_type,
        actor.actor_id,
        `project:${projectId}`,
        JSON.stringify([{ entity_type: "project", entity_id: projectId }]),
        JSON.stringify({
          scenario,
          remote_provisioning: remote?.provisioning ?? null,
          remote_full_name: remote?.descriptor.full_name ?? null,
        }),
      ],
    );
  }

  private assemble(
    projectId: string,
    scenario: OnboardingScenario,
    attachments: { workspace: AttachmentRow | null; remote: AttachmentRow | null },
    replayed: boolean,
    warnings: readonly string[],
  ): OnboardingResult {
    return {
      project_id: projectId,
      scenario,
      replayed,
      workspace: attachments.workspace ? attachmentView(attachments.workspace) : null,
      remote: attachments.remote ? attachmentView(attachments.remote) : null,
      push: describePush(attachments.remote),
      warnings: [...warnings],
    };
  }
}

/**
 * The push decision as it was DURABLY RECORDED, not as it would be recomputed.
 * A project's push story must not silently change under it because a GitHub
 * installation's shape changed between reads.
 */
export function describePush(remote: AttachmentRowLike | null): PushCredentialDecision | null {
  if (!remote) return null;
  if (remote.push_credential_strategy === "local_git_remote") {
    return localGitRemoteFallback(
      "this remote has no usable Norns GitHub connection, so pushes use the local " +
        "folder's own git remote and the machine's existing credentials",
    );
  }
  return {
    strategy: "norns_github_app_token",
    implemented: false,
    rationale:
      "Norns brokers a just-in-time GitHub App installation token scoped to this " +
      "repository; the App private key never leaves the server (ADR-006)",
    needs_operator_action: remote.remote_installation_ready === false,
  };
}

export interface AttachmentRowLike {
  readonly push_credential_strategy: string | null;
  readonly remote_installation_ready: boolean | null;
}
