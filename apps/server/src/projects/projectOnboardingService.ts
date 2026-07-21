// ONBOARDING O2: the two project-creation commands.
//
// Every project is GitHub-backed. Nothing is installed on the operator's
// machine: the runner runs ephemerally inside a GitHub Actions job in the
// project's own repository and connects back to the relay over the existing
// protocol. So project setup has exactly two shapes:
//
//   new_repo       Norns creates the GitHub repository for this project.
//   existing_repo  The operator selects a repository the installation can see.
//
// Each command produces TWO attachments, atomically, in one transaction:
//
//   * WORKSPACE (role 'workspace') -- where execution happens: an Actions job
//     in that repository. `projects.primary_repository_binding_id` resolves
//     to this one and the Phase 4 dispatch gate reads it. Untouched here.
//   * REMOTE    (role 'remote')    -- where the work is pushed.
//
// Today both name the SAME repository. The roles stay distinct because they
// answer genuinely different questions and are expected to diverge (fork-and-
// PR: execute in a fork, push to upstream). Collapsing them now would mean
// re-deriving the distinction later from nothing.
//
// Both attachments are written to the CANDIDATE tier (FRONT DOOR D2's
// unverified tier). They are promoted to real `repository_bindings` rows when
// something actually confirms them -- an Actions job connecting back, or the
// existing source-binding flow. Creation never claims verification it does
// not have.
import { createHash } from "node:crypto";
import type { ProviderName } from "@norns/adapters";
import type { PmModelT } from "@norns/contracts";
import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  ACTIONS_GITHUB_TOKEN,
  type PushCredentialDescription,
  type PushCredentialStrategy,
  describePushCredential,
} from "./pushCredentialProvider.js";
import { insertProjectCore } from "./relationalReadRepository.js";
import type { RemoteRepositoryDescriptor, RemoteRepositoryPort } from "./remoteRepositoryPort.js";
import { safeLocalRepositoryDisplayName } from "./repositoryDisplayName.js";
import { reviewerFor } from "./store.js";

export const ONBOARDING_SCENARIOS = ["new_repo", "existing_repo"] as const;
export type OnboardingScenario = (typeof ONBOARDING_SCENARIOS)[number];

export const ONBOARDING_ROLES = ["workspace", "remote"] as const;
export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

export interface OnboardingActor {
  readonly actor_type: "human" | "agent" | "system";
  readonly actor_id: string;
}

export interface OnboardingCommandBase {
  readonly name: string;
  readonly description: string;
  readonly pm_provider: ProviderName;
  readonly pm_model: PmModelT | null;
  readonly actor: OnboardingActor;
  readonly idempotency_key: string;
  readonly connection_id: string;
}

/** Scenario 1: Norns creates the repository. */
export interface NewRepoCommand extends OnboardingCommandBase {
  readonly repository_name: string;
  readonly private: boolean;
}

/** Scenario 2: the operator selects a repository the installation can see. */
export interface ExistingRepoCommand extends OnboardingCommandBase {
  readonly repository_id: string;
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
  /** 'binding' = confirmed; 'candidate' = recorded but not yet confirmed. */
  readonly tier: "binding" | "candidate";
  readonly role: OnboardingRole;
  readonly kind: "local_runner" | "github";
  readonly display_name: string;
  readonly status: string;
  readonly verified: boolean;
  readonly default_branch: string | null;
  /**
   * Whether the GitHub App installation actually contains this repository.
   * FIRST-CLASS BLOCKING STATE: false means Norns cannot commit the workflow
   * file, cannot dispatch an Actions run, and cannot read run status.
   */
  readonly installation_ready: boolean | null;
  /** Whether the Norns workflow file is committed. No workflow, no execution. */
  readonly workflow_installed: boolean;
  readonly github: { owner: string; name: string; url: string } | null;
  readonly observed_head: string | null;
  /**
   * Non-null only for attachments this phase created, i.e. ones that actually
   * execute in a GitHub Actions job. Pre-O2 attachments leave it null and are
   * never told about a workflow file they never needed.
   */
  readonly push_credential_strategy: PushCredentialStrategy | null;
}

/** Something concrete the operator must do before the project can execute. */
export interface OnboardingBlocker {
  readonly code: "installation_not_ready" | "workflow_not_installed";
  readonly role: OnboardingRole;
  readonly message: string;
}

export interface OnboardingResult {
  readonly project_id: string;
  readonly scenario: OnboardingScenario;
  readonly replayed: boolean;
  readonly workspace: OnboardingAttachmentView | null;
  readonly remote: OnboardingAttachmentView | null;
  readonly push: PushCredentialDescription;
  /** Empty when the project is ready to execute. Never a buried warning. */
  readonly blockers: readonly OnboardingBlocker[];
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

export interface AttachmentRow {
  id: string;
  tier: "binding" | "candidate";
  role: OnboardingRole;
  kind: "local_runner" | "github";
  display_name: string;
  status: string;
  github_owner: string | null;
  github_name: string | null;
  observed_head: string | null;
  default_branch: string | null;
  installation_ready: boolean | null;
  workflow_installed: boolean;
  push_credential_strategy: string | null;
  remote_provisioning: string | null;
}

const VERIFIED_STATUSES = new Set(["connected", "promoted"]);

const NAME_TAKEN_HINT =
  "Norns will not take over a repository it did not create -- choose a " +
  "different name, or start the project from that existing repository instead.";

const INSTALLATION_HINT =
  "Norns cannot commit the workflow file, start an Actions run, or read run " +
  "status until the installation is granted access to this repository";

export function attachmentView(row: AttachmentRow): OnboardingAttachmentView {
  return {
    id: row.id,
    tier: row.tier,
    role: row.role,
    kind: row.kind,
    // A local_runner display name can be a raw filesystem path from a
    // pre-Actions binding. It is sanitized to its last segment before it can
    // reach any response body -- the same rule the resume view already
    // applies. GitHub display names are already `owner/name`.
    display_name:
      row.kind === "local_runner"
        ? (safeLocalRepositoryDisplayName(row.display_name) ?? "Local repository")
        : row.display_name,
    status: row.status,
    verified: row.tier === "binding" && VERIFIED_STATUSES.has(row.status),
    default_branch: row.default_branch,
    installation_ready: row.installation_ready,
    workflow_installed: row.workflow_installed,
    github:
      row.github_owner && row.github_name
        ? {
            owner: row.github_owner,
            name: row.github_name,
            url: `github.com/${row.github_owner}/${row.github_name}`,
          }
        : null,
    observed_head: row.observed_head,
    // Narrowed at the boundary: the column is a free-text CHECK in the
    // database, but only this phase's own value means "Actions-managed".
    push_credential_strategy:
      row.push_credential_strategy === ACTIONS_GITHUB_TOKEN ? ACTIONS_GITHUB_TOKEN : null,
  };
}

/**
 * Everything standing between this project and a dispatchable Actions run,
 * derived from durable state rather than remembered from creation time.
 */
export function collectBlockers(
  attachments: ReadonlyArray<OnboardingAttachmentView | null>,
): OnboardingBlocker[] {
  const blockers: OnboardingBlocker[] = [];
  for (const attachment of attachments) {
    if (!attachment || attachment.kind !== "github") continue;
    const where = attachment.github?.url ?? attachment.display_name;
    if (attachment.installation_ready === false) {
      blockers.push({
        code: "installation_not_ready",
        role: attachment.role,
        message: `the GitHub App installation does not include ${where} yet. ${INSTALLATION_HINT}`,
      });
    }
    // Only an Actions-managed workspace needs a workflow file: it is the
    // attachment execution actually runs in. A pre-O2 project (no push
    // strategy recorded) predates Actions execution and must not be told to
    // install a workflow it was never going to use.
    if (
      attachment.role === "workspace" &&
      attachment.push_credential_strategy === ACTIONS_GITHUB_TOKEN &&
      !attachment.workflow_installed
    ) {
      blockers.push({
        code: "workflow_not_installed",
        role: attachment.role,
        message: `the Norns workflow file is not committed to ${where} yet, so there is no Actions job to execute in`,
      });
    }
  }
  return blockers;
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
         binding.default_branch,
         binding.installation_ready,
         binding.workflow_installed,
         binding.push_credential_strategy,
         binding.remote_provisioning,
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
         candidate.default_branch,
         candidate.installation_ready,
         candidate.workflow_installed,
         candidate.push_credential_strategy,
         candidate.remote_provisioning,
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

export const ONBOARDING_ATTACHMENTS_QUERY = `
  SELECT id, tier, role, kind, display_name, status, github_owner, github_name,
         observed_head, default_branch, installation_ready, workflow_installed,
         push_credential_strategy, remote_provisioning
  FROM (${ONBOARDING_ATTACHMENTS_SQL}) attachment
  ORDER BY CASE tier WHEN 'binding' THEN 0 ELSE 1 END, created_at, id
`;

interface ResolvedAttachments {
  workspace: AttachmentRow | null;
  remote: AttachmentRow | null;
}

export function resolveAttachments(rows: readonly AttachmentRow[]): ResolvedAttachments {
  return {
    workspace: rows.find((row) => row.role === "workspace") ?? null,
    remote: rows.find((row) => row.role === "remote") ?? null,
  };
}

async function readAttachments(tx: V2SqlExecutor, projectId: string): Promise<ResolvedAttachments> {
  const rows = await tx.query<AttachmentRow>(ONBOARDING_ATTACHMENTS_QUERY, [projectId]);
  return resolveAttachments(rows.rows);
}

export interface ProjectOnboardingServiceOptions {
  readonly transactions: V2TransactionRunner;
  readonly remotes: RemoteRepositoryPort;
}

export class ProjectOnboardingService {
  private readonly transactions: V2TransactionRunner;
  private readonly remotes: RemoteRepositoryPort;

  constructor(options: ProjectOnboardingServiceOptions) {
    this.transactions = options.transactions;
    this.remotes = options.remotes;
  }

  /** Scenario 1: Norns creates the GitHub repository for this project. */
  createNewRepo(command: NewRepoCommand): Promise<OnboardingResult> {
    if (!command.repository_name.trim()) {
      throw new OnboardingValidationError(
        "repository_name_required",
        "name the repository Norns should create",
      );
    }
    return this.run("new_repo", command, () => this.provisionNewRepo(command));
  }

  /** Scenario 2: the operator selects a repository the installation can see. */
  createFromExistingRepo(command: ExistingRepoCommand): Promise<OnboardingResult> {
    if (!command.repository_id.trim()) {
      throw new OnboardingValidationError(
        "repository_required",
        "select the GitHub repository this project works in",
      );
    }
    return this.run("existing_repo", command, async () => ({
      descriptor: await this.remotes.resolveById({
        actor_id: command.actor.actor_id,
        connection_id: command.connection_id,
        repository_id: command.repository_id,
      }),
      provisioning: "selected_existing" as const,
    }));
  }

  private async run(
    scenario: OnboardingScenario,
    command: OnboardingCommandBase,
    provision: () => Promise<{
      descriptor: RemoteRepositoryDescriptor;
      provisioning: "selected_existing" | "created";
    }>,
  ): Promise<OnboardingResult> {
    const projectId = onboardingProjectId(command.actor, command.idempotency_key);
    const idempotencyId = submissionId(command.actor, command.idempotency_key);

    // ---- replay short-circuit, BEFORE any side effect --------------------
    // This is what guarantees a double submit never creates a second GitHub
    // repository: the deterministic project id plus the submissions row make
    // the replay observable before `provision()` is ever called.
    const replay = await this.transactions.transaction(async (tx) => {
      const existing = await tx.query<{ scenario: OnboardingScenario }>(
        "SELECT scenario FROM project_onboarding_submissions WHERE idempotency_id = $1",
        [idempotencyId],
      );
      const row = existing.rows[0];
      if (!row) return null;
      if (row.scenario !== scenario) {
        throw new OnboardingValidationError(
          "idempotency_key_reused",
          `idempotency key already used for a "${row.scenario}" project`,
        );
      }
      return readAttachments(tx, projectId);
    });
    if (replay) return assemble(projectId, scenario, replay, true);

    // ---- side effect, outside the transaction ---------------------------
    // ADR-005's transactional boundary must not be held open across a network
    // call, so GitHub is talked to first and the result is then committed.
    const remote = await provision();

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

      // One repository, two roles. Both recorded now so the model never has
      // to guess later which repository execution belongs in.
      for (const role of ONBOARDING_ROLES) {
        await insertCandidate(tx, {
          projectId,
          role,
          descriptor: remote.descriptor,
          provisioning: remote.provisioning,
          createdAt,
        });
      }

      await tx.query(
        `INSERT INTO project_onboarding_submissions (
           idempotency_id, project_id, scenario, actor_type, actor_id, idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (idempotency_id) DO NOTHING`,
        [
          idempotencyId,
          projectId,
          scenario,
          command.actor.actor_type,
          command.actor.actor_id,
          command.idempotency_key,
        ],
      );
      await appendAudit(tx, projectId, scenario, command.actor, remote);
      return readAttachments(tx, projectId);
    });

    return assemble(projectId, scenario, attachments, false);
  }

  /**
   * Creates the repository without ever creating it twice -- and without ever
   * silently adopting one Norns did not create.
   *
   * Two rules pull against each other here. GitHub repository creation is not
   * idempotent (a retry answers 422), so a genuine retry of the same submission
   * must be able to reuse a repository that is already there. But a first-time
   * submission must NEVER quietly take over a same-named repository that
   * already existed -- a user typing "website" into the *create a new
   * repository* form must not have their production `website` repo adopted,
   * labelled `created`, and later committed into.
   *
   * A bare name lookup cannot tell those apart: a same-named repository carries
   * no marker saying who made it. So the INTENT is recorded durably before
   * GitHub is called. A pre-existing intent for this exact (actor, idempotency
   * key, connection, name) is proof Norns already reached the creation step for
   * THIS submission, which makes a same-named repository its own earlier
   * attempt. No such intent means the collision is somebody else's repository,
   * and it is surfaced for the human to resolve rather than absorbed.
   */
  private async provisionNewRepo(command: NewRepoCommand): Promise<{
    descriptor: RemoteRepositoryDescriptor;
    provisioning: "created";
  }> {
    const reservation = await this.reserveRepositoryIntent(command);
    const existing = await this.remotes.findByName({
      actor_id: command.actor.actor_id,
      connection_id: command.connection_id,
      name: command.repository_name,
    });
    if (existing) {
      if (!reservation.retry_of_this_submission) {
        throw new OnboardingValidationError(
          "repository_name_taken",
          `A repository named "${command.repository_name}" already exists on this GitHub connection. ${NAME_TAKEN_HINT}`,
        );
      }
      return { descriptor: existing, provisioning: "created" };
    }
    const descriptor = await this.remotes.create({
      actor_id: command.actor.actor_id,
      connection_id: command.connection_id,
      name: command.repository_name,
      description: command.description,
      private: command.private,
    });
    return { descriptor, provisioning: "created" };
  }

  /**
   * Durably claims "this submission is about to create this repository".
   *
   * `retry_of_this_submission` is true only when an intent row was already
   * present AND names the same connection and repository -- so reusing an
   * idempotency key with a different repository name cannot license adopting
   * something else.
   */
  private reserveRepositoryIntent(
    command: NewRepoCommand,
  ): Promise<{ retry_of_this_submission: boolean }> {
    const idempotencyId = submissionId(command.actor, command.idempotency_key);
    return this.transactions.transaction(async (tx) => {
      const existing = await tx.query<{ connection_id: string; repository_name: string }>(
        `SELECT connection_id, repository_name
         FROM project_onboarding_repository_intents
         WHERE idempotency_id = $1
         FOR UPDATE`,
        [idempotencyId],
      );
      const intent = existing.rows[0];
      if (intent) {
        return {
          retry_of_this_submission:
            intent.connection_id === command.connection_id &&
            intent.repository_name === command.repository_name,
        };
      }
      await tx.query(
        `INSERT INTO project_onboarding_repository_intents (
           idempotency_id, actor_type, actor_id, connection_id, repository_name
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (idempotency_id) DO NOTHING`,
        [
          idempotencyId,
          command.actor.actor_type,
          command.actor.actor_id,
          command.connection_id,
          command.repository_name,
        ],
      );
      return { retry_of_this_submission: false };
    });
  }
}

async function insertCandidate(
  tx: V2SqlExecutor,
  input: {
    projectId: string;
    role: OnboardingRole;
    descriptor: RemoteRepositoryDescriptor;
    provisioning: "selected_existing" | "created";
    createdAt: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO repository_binding_candidates (
       id, project_id, role, source_type, source_fingerprint, display_name,
       github_owner, github_name, service_connection_id,
       external_repository_id, default_branch, push_credential_strategy,
       remote_provisioning, installation_ready, workflow_installed,
       status, created_at, updated_at
     ) VALUES ($1,$2,$3,'github',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,
               'unverified',$14,$14)
     ON CONFLICT (project_id, role, source_type, source_fingerprint) DO NOTHING`,
    [
      newId("binding_candidate"),
      input.projectId,
      input.role,
      sha256(input.descriptor.clone_url),
      input.descriptor.full_name,
      input.descriptor.owner,
      input.descriptor.name,
      input.descriptor.connection_id,
      input.descriptor.repository_id,
      input.descriptor.default_branch,
      ACTIONS_GITHUB_TOKEN,
      input.provisioning,
      input.descriptor.installation_ready,
      input.createdAt,
    ],
  );
}

async function appendAudit(
  tx: V2SqlExecutor,
  projectId: string,
  scenario: OnboardingScenario,
  actor: OnboardingActor,
  remote: { descriptor: RemoteRepositoryDescriptor; provisioning: string },
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
        remote_provisioning: remote.provisioning,
        repository: remote.descriptor.full_name,
        installation_ready: remote.descriptor.installation_ready,
      }),
    ],
  );
}

function assemble(
  projectId: string,
  scenario: OnboardingScenario,
  attachments: ResolvedAttachments,
  replayed: boolean,
): OnboardingResult {
  const workspace = attachments.workspace ? attachmentView(attachments.workspace) : null;
  const remote = attachments.remote ? attachmentView(attachments.remote) : null;
  return {
    project_id: projectId,
    scenario,
    replayed,
    workspace,
    remote,
    push: describePushCredential(),
    blockers: collectBlockers([workspace, remote]),
  };
}
