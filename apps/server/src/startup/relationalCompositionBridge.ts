import type { ProviderName } from "@norns/adapters";
import type { PmModelT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import { insertProjectCore } from "../projects/relationalReadRepository.js";
import type { ProjectStore, ProjectSummary } from "../projects/store.js";
import type { IdentityUser } from "../users/identityService.js";
import {
  CURRENT_PASSWORD_HASH_SCHEME,
  LEGACY_PASSWORD_HASH_SCHEME,
  detectPasswordHashScheme,
} from "../users/passwords.js";
import type { UserStore } from "../users/store.js";

export type CompositionAuthority = "legacy" | "relational";
export type CompositionReadMode = "legacy" | "shadow" | "relational";

export type RelationalCompositionConflictCode =
  | "legacy_actor_missing"
  | "legacy_actor_credential_invalid"
  | "relational_actor_conflict"
  | "relational_project_conflict"
  | "legacy_project_conflict";

export class RelationalCompositionConflictError extends Error {
  constructor(
    readonly code: RelationalCompositionConflictCode,
    readonly operation: "identity_bridge" | "project_anchor" | "project_mirror",
    readonly action: string,
    message: string,
  ) {
    super(message);
    this.name = "RelationalCompositionConflictError";
  }

  diagnostic(): {
    error: "persistence_composition_conflict";
    code: RelationalCompositionConflictCode;
    operation: RelationalCompositionConflictError["operation"];
    message: string;
    action: string;
  } {
    return {
      error: "persistence_composition_conflict",
      code: this.code,
      operation: this.operation,
      message: this.message,
      action: this.action,
    };
  }
}

export interface RelationalCompositionBridgeOptions {
  transactions: V2TransactionRunner;
  users: UserStore;
  projects: ProjectStore;
  identityAuthority: CompositionAuthority;
  newProjectReadMode: CompositionReadMode;
  newProjectWriteAuthority: CompositionAuthority;
}

export interface OnboardedProjectMirrorInput {
  project_id: string;
  scenario: "new_repo" | "existing_repo";
  name: string;
  description: string;
  pm_provider: ProviderName;
  pm_model: PmModelT | null;
  connection_id: string;
  repository_id: string | null;
  default_branch: string | null;
  github_url: string | null;
}

interface StoredActor {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  password_hash_scheme: string | null;
  role: string;
  status: string;
  source: string;
  source_record_id: string | null;
  created_at: Date | string;
}

interface StoredProject {
  id: string;
  name: string;
  description: string;
  pm_provider: string;
  pm_model: string | null;
  reviewer_provider: string;
  onboarding_scenario: string | null;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function same(left: unknown, right: unknown): boolean {
  return left === right;
}

/**
 * Explicit compatibility boundary for a deployment whose legacy snapshots
 * remain authoritative while relational workflows are already enabled.
 *
 * This does not change a durable migration route. It materializes only the
 * stable FK anchors needed by relational workflows, with the same IDs and
 * source metadata the offline migration uses, so a later import converges.
 */
export class RelationalCompositionBridge {
  private readonly actorPromises = new Map<string, Promise<void>>();
  private preparationStatus: "initializing" | "ready" | "degraded" = "initializing";
  private preparationFailure: RelationalCompositionConflictError | null = null;

  constructor(private readonly options: RelationalCompositionBridgeOptions) {}

  readiness(): {
    status: "initializing" | "ready" | "degraded";
    identity_authority: CompositionAuthority;
    new_project_read_mode: CompositionReadMode;
    new_project_write_authority: CompositionAuthority;
    compatibility_bridge: boolean;
    conflict: ReturnType<RelationalCompositionConflictError["diagnostic"]> | null;
  } {
    return {
      status: this.preparationStatus,
      identity_authority: this.options.identityAuthority,
      new_project_read_mode: this.options.newProjectReadMode,
      new_project_write_authority: this.options.newProjectWriteAuthority,
      compatibility_bridge:
        this.options.identityAuthority === "legacy" ||
        this.options.newProjectReadMode !== "relational" ||
        this.options.newProjectWriteAuthority !== "relational",
      conflict: this.preparationFailure?.diagnostic() ?? null,
    };
  }

  /** Validate and materialize the compatibility anchors before readiness. */
  async prepare(): Promise<void> {
    try {
      if (this.options.identityAuthority === "legacy") {
        for (const user of this.options.users.snapshot().users) {
          if (user.status !== "active") continue;
          await this.ensureLegacyActorRecord(user);
        }
      }
      // Do not eagerly materialize every legacy project. The offline project
      // importer owns that migration and intentionally refuses pre-existing
      // project IDs. A relational anchor is created only when a specific
      // project crosses a relational front door.
      this.preparationStatus = "ready";
      this.preparationFailure = null;
    } catch (error) {
      const conflict =
        error instanceof RelationalCompositionConflictError
          ? error
          : new RelationalCompositionConflictError(
              "relational_project_conflict",
              "project_anchor",
              "Inspect the relational database and retry startup after restoring consistency.",
              error instanceof Error ? error.message : String(error),
            );
      this.preparationStatus = "degraded";
      this.preparationFailure = conflict;
      throw conflict;
    }
  }

  ensureActor(user: IdentityUser): Promise<void> {
    if (this.options.identityAuthority === "relational") return Promise.resolve();
    const legacy = this.options.users
      .snapshot()
      .users.find((candidate) => candidate.id === user.id);
    if (!legacy) {
      return Promise.reject(
        new RelationalCompositionConflictError(
          "legacy_actor_missing",
          "identity_bridge",
          "Sign out and sign in again. If the problem persists, restore the legacy user snapshot.",
          `authenticated legacy actor ${user.id} is absent from the legacy user snapshot`,
        ),
      );
    }
    const key = [
      legacy.id,
      legacy.email,
      legacy.name,
      legacy.role,
      legacy.status,
      legacy.passwordHash,
      legacy.createdAt,
    ].join("\u0000");
    const existing = this.actorPromises.get(key);
    if (existing) return existing;
    const pending = this.ensureLegacyActorRecord(legacy).catch((error) => {
      this.actorPromises.delete(key);
      throw error;
    });
    this.actorPromises.set(key, pending);
    return pending;
  }

  private async ensureLegacyActorRecord(
    legacy: ReturnType<UserStore["snapshot"]>["users"][number],
  ): Promise<void> {
    const scheme =
      legacy.passwordHash === null ? null : detectPasswordHashScheme(legacy.passwordHash);
    if (legacy.status === "active" && (!legacy.passwordHash || !scheme)) {
      throw new RelationalCompositionConflictError(
        "legacy_actor_credential_invalid",
        "identity_bridge",
        "Repair or re-create the legacy account before approving or starting work.",
        `legacy actor ${legacy.id} has no supported active credential`,
      );
    }
    try {
      await this.options.transactions.transaction(async (sql) => {
        const normalizedEmail = legacy.email.trim().toLowerCase();
        await sql.query(
          `INSERT INTO users (
           id, username, display_name, email, name, password_hash,
           password_hash_scheme, password_rehashed_at, role, status,
           source, source_record_id, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,'legacy_snapshot',$1,$10,$10
         ) ON CONFLICT (id) DO NOTHING`,
          [
            legacy.id,
            normalizedEmail,
            legacy.name ?? legacy.email,
            normalizedEmail,
            legacy.name,
            legacy.passwordHash,
            scheme,
            legacy.role,
            legacy.status,
            legacy.createdAt,
          ],
        );
        let row = (
          await sql.query<StoredActor>(
            `SELECT id, email, name, password_hash, password_hash_scheme, role,
                  status, source, source_record_id, created_at
           FROM users WHERE id = $1
           FOR UPDATE`,
            [legacy.id],
          )
        ).rows[0];
        if (
          !row ||
          !same(row.email, normalizedEmail) ||
          !same(row.name, legacy.name) ||
          !same(row.role, legacy.role) ||
          !same(row.status, legacy.status) ||
          !same(row.source, "legacy_snapshot") ||
          !same(row.source_record_id, legacy.id) ||
          !same(iso(row.created_at), legacy.createdAt)
        ) {
          throw new RelationalCompositionConflictError(
            "relational_actor_conflict",
            "identity_bridge",
            "Reconcile the legacy and relational identity records before retrying.",
            `relational actor ${legacy.id} conflicts with the authenticated legacy identity`,
          );
        }
        const credentialChanged =
          !same(row.password_hash, legacy.passwordHash) || !same(row.password_hash_scheme, scheme);
        if (credentialChanged) {
          const isSupportedRehash =
            row.password_hash !== null &&
            row.password_hash_scheme === LEGACY_PASSWORD_HASH_SCHEME &&
            legacy.passwordHash !== null &&
            scheme === CURRENT_PASSWORD_HASH_SCHEME;
          if (!isSupportedRehash) {
            throw new RelationalCompositionConflictError(
              "relational_actor_conflict",
              "identity_bridge",
              "Reconcile the legacy and relational identity records before retrying.",
              `relational actor ${legacy.id} has an unsupported credential divergence`,
            );
          }
          row = (
            await sql.query<StoredActor>(
              `UPDATE users
               SET password_hash = $2,
                   password_hash_scheme = $3,
                   password_rehashed_at = transaction_timestamp(),
                   updated_at = transaction_timestamp()
               WHERE id = $1
               RETURNING id, email, name, password_hash, password_hash_scheme,
                         role, status, source, source_record_id, created_at`,
              [legacy.id, legacy.passwordHash, scheme],
            )
          ).rows[0];
        }
        if (
          !row ||
          !same(row.password_hash, legacy.passwordHash) ||
          !same(row.password_hash_scheme, scheme)
        ) {
          throw new RelationalCompositionConflictError(
            "relational_actor_conflict",
            "identity_bridge",
            "Reconcile the legacy and relational identity records before retrying.",
            `relational actor ${legacy.id} credentials could not be synchronized`,
          );
        }
      });
    } catch (error) {
      if (error instanceof RelationalCompositionConflictError) throw error;
      throw new RelationalCompositionConflictError(
        "relational_actor_conflict",
        "identity_bridge",
        "Reconcile duplicate identity records, then retry the authenticated action.",
        `relational identity cannot accept legacy actor ${legacy.id}`,
      );
    }
  }

  async ensureProjectAnchor(project: ProjectSummary, ownerUserId?: string): Promise<void> {
    try {
      await this.options.transactions.transaction(async (sql) => {
        await insertProjectCore(sql, {
          projectId: project.id,
          name: project.name,
          description: project.description,
          pmProvider: project.pm_provider,
          pmModel: project.pm_model,
          reviewerProvider: project.reviewer_provider,
          createdAt: project.created_at,
          ...(ownerUserId ? { ownerUserId } : {}),
          onboardingScenario: project.onboarding_scenario,
        });
        const row = (
          await sql.query<StoredProject>(
            `SELECT project.id, project.name, project.description,
                  preferences.pm_provider, preferences.pm_model,
                  preferences.reviewer_provider, project.onboarding_scenario,
                  project.created_at
           FROM projects project
           JOIN project_planning_preferences preferences
             ON preferences.project_id = project.id
           WHERE project.id = $1`,
            [project.id],
          )
        ).rows[0];
        if (
          !row ||
          !same(row.name, project.name) ||
          !same(row.description, project.description) ||
          !same(row.pm_provider, project.pm_provider) ||
          !same(row.pm_model, project.pm_model) ||
          !same(row.reviewer_provider, project.reviewer_provider) ||
          !same(row.onboarding_scenario, project.onboarding_scenario) ||
          !same(iso(row.created_at), project.created_at)
        ) {
          throw new RelationalCompositionConflictError(
            "relational_project_conflict",
            "project_anchor",
            "Reconcile the legacy and relational project records before attaching a repository.",
            `relational project ${project.id} conflicts with the configured project authority`,
          );
        }
      });
    } catch (error) {
      if (error instanceof RelationalCompositionConflictError) throw error;
      throw new RelationalCompositionConflictError(
        "relational_project_conflict",
        "project_anchor",
        "Inspect the relational project store and retry after restoring consistency.",
        `relational project anchor ${project.id} could not be materialized`,
      );
    }
  }

  async mirrorOnboardedProject(input: OnboardedProjectMirrorInput): Promise<ProjectSummary | null> {
    if (this.options.newProjectReadMode === "relational") return null;
    const createdAt = await this.options.transactions.transaction(async (sql) => {
      const row = (
        await sql.query<{ created_at: Date | string }>(
          "SELECT created_at FROM projects WHERE id = $1",
          [input.project_id],
        )
      ).rows[0];
      if (!row) {
        throw new RelationalCompositionConflictError(
          "relational_project_conflict",
          "project_mirror",
          "Retry onboarding. If the project remains missing, inspect the relational project store.",
          `onboarded relational project ${input.project_id} is missing`,
        );
      }
      return iso(row.created_at);
    });
    try {
      return this.options.projects.ensureRelationalMirror({
        id: input.project_id,
        name: input.name,
        description: input.description,
        pmProvider: input.pm_provider,
        pmModel: input.pm_model,
        createdAt,
        sourceLocation: input.github_url,
        sourceConnectionId: input.connection_id,
        sourceRepositoryId: input.repository_id,
        sourceDefaultBranch: input.default_branch,
        onboardingScenario: input.scenario,
      });
    } catch (error) {
      throw new RelationalCompositionConflictError(
        "legacy_project_conflict",
        "project_mirror",
        "Reconcile the legacy project snapshot with the relational onboarding record.",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
