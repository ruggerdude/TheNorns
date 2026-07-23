// Multi-project management (the "sole point of entry"): a Project is a
// named unit of work with its own PM/reviewer provider choice and, once
// planned, its own GraphSession (plan + workflow graph). This replaces the
// single hardcoded GraphSession the graph editor used to operate on — the
// server can now hold many projects at once, list/create/switch between
// them, and persist all of them under Tier-2.
import type { ProviderName } from "@norns/adapters";
import {
  DEFAULT_PM_MODEL,
  type PlanContractT,
  type PmModelT,
  isPmModelForProvider,
  validatePlan,
} from "@norns/contracts";
import type { AllocationApprovalRecord } from "../graph/allocation.js";
import { type GraphSnapshot, WorkflowGraph } from "../graph/graph.js";
import { GraphSession } from "../graph/session.js";
import { newId } from "../ids.js";
import { safeLocalRepositoryDisplayName } from "./repositoryDisplayName.js";

export type ProjectStatus = "draft" | "planned";
export type ProjectSourceType = "local" | "github";

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  pm_provider: ProviderName;
  pm_model: PmModelT | null;
  reviewer_provider: ProviderName;
  status: ProjectStatus;
  created_at: string;
  plan_objective: string | null;
  source_type: ProjectSourceType | null;
  source_location: string | null;
  // ---- ONBOARDING O2 (additive) -------------------------------------------
  // A project may hold BOTH a local workspace (where execution happens) and a
  // GitHub remote (the push target), so the UI can say
  // "Files at <workspace_location> - Pushes to <remote_location>".
  // Required, not optional: every ProjectSummary producer must answer, so the
  // legacy/relational shadow-read parity check cannot drift.
  workspace_location: string | null;
  remote_location: string | null;
  onboarding_scenario: string | null;
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown project "${id}"`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectNotPlannedError extends Error {
  constructor(id: string) {
    super(`project "${id}" has no plan yet — run and load a plan first`);
    this.name = "ProjectNotPlannedError";
  }
}

interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  pmProvider: ProviderName;
  pmModel: PmModelT | null;
  sourceType: ProjectSourceType | null;
  sourceLocation: string | null;
  sourceConnectionId: string | null;
  sourceRepositoryId: string | null;
  sourceDefaultBranch: string | null;
  createdAt: string;
  archivedAt: string | null;
  session: GraphSession | null;
}

export interface ProjectStoreSnapshot {
  projects: {
    id: string;
    name: string;
    description: string;
    pmProvider: ProviderName;
    /** Optional only so snapshots written before model selection can still be restored. */
    pmModel?: PmModelT | null;
    /** Optional for snapshots created before repository connections were supported. */
    sourceType?: ProjectSourceType | null;
    sourceLocation?: string | null;
    sourceConnectionId?: string | null;
    sourceRepositoryId?: string | null;
    sourceDefaultBranch?: string | null;
    /** Optional so snapshots written before dashboard removal can still be restored. */
    archivedAt?: string | null;
    createdAt: string;
    plan: PlanContractT | null;
    graph: GraphSnapshot | null;
    approval: AllocationApprovalRecord | null;
  }[];
}

/** Cross-provider review is the standing policy: reviewer is always the PM's opposite. */
export function reviewerFor(pmProvider: ProviderName): ProviderName {
  return pmProvider === "anthropic" ? "openai" : "anthropic";
}

function resolvePmModel(provider: ProviderName, model?: string): PmModelT {
  const selected = model ?? DEFAULT_PM_MODEL[provider];
  if (!isPmModelForProvider(provider, selected)) {
    throw new Error(`model "${selected}" is not available for provider "${provider}"`);
  }
  return selected;
}

export class ProjectStore {
  private readonly projects = new Map<string, ProjectRecord>();

  create(input: {
    name: string;
    description: string;
    pmProvider: ProviderName;
    pmModel?: PmModelT;
    sourceType?: ProjectSourceType;
    sourceLocation?: string;
    sourceConnectionId?: string;
    sourceRepositoryId?: string;
    sourceDefaultBranch?: string;
  }): ProjectSummary {
    const record: ProjectRecord = {
      id: newId("proj"),
      name: input.name,
      description: input.description,
      pmProvider: input.pmProvider,
      pmModel: resolvePmModel(input.pmProvider, input.pmModel),
      sourceType: input.sourceType ?? null,
      sourceLocation: input.sourceLocation?.trim() || null,
      sourceConnectionId: input.sourceConnectionId ?? null,
      sourceRepositoryId: input.sourceRepositoryId ?? null,
      sourceDefaultBranch: input.sourceDefaultBranch ?? null,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      session: null,
    };
    this.projects.set(record.id, record);
    return this.summarize(record);
  }

  /** Newest first. Map iteration order is insertion order — a stable tiebreak
   *  that doesn't depend on wall-clock resolution (two projects created in
   *  the same millisecond would otherwise tie under a createdAt sort). */
  list(): ProjectSummary[] {
    return [...this.projects.values()]
      .filter((record) => record.archivedAt === null)
      .reverse()
      .map((record) => this.summarize(record));
  }

  summary(id: string): ProjectSummary {
    return this.summarize(this.record(id));
  }

  /** Remove a project from active product surfaces without deleting its history. */
  archive(id: string): void {
    const record = this.projects.get(id);
    if (!record || record.archivedAt !== null) throw new ProjectNotFoundError(id);
    record.archivedAt = new Date().toISOString();
  }

  /** The live GraphSession for a project — throws if it hasn't been planned yet. */
  session(id: string): GraphSession {
    const record = this.record(id);
    if (!record.session) throw new ProjectNotPlannedError(id);
    return record.session;
  }

  reviewerFor(id: string): ProviderName {
    return reviewerFor(this.record(id).pmProvider);
  }

  pmProviderOf(id: string): ProviderName {
    return this.record(id).pmProvider;
  }

  pmSelectionOf(id: string): { provider: ProviderName; model: PmModelT | null } {
    const record = this.record(id);
    return { provider: record.pmProvider, model: record.pmModel };
  }

  /** Commit a (validated, possibly human-edited) plan as this project's live graph. */
  loadPlan(id: string, plan: PlanContractT): GraphSession {
    const record = this.record(id);
    const result = validatePlan(plan);
    if (!result.ok) {
      throw new Error(`plan failed validation: ${result.errors.map((e) => e.message).join("; ")}`);
    }
    if (record.session) {
      record.session.loadPlan(result.plan);
    } else {
      record.session = new GraphSession(result.plan);
    }
    return record.session;
  }

  snapshot(): ProjectStoreSnapshot {
    return {
      projects: [...this.projects.values()].map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        pmProvider: r.pmProvider,
        pmModel: r.pmModel,
        sourceType: r.sourceType,
        sourceLocation: r.sourceLocation,
        sourceConnectionId: r.sourceConnectionId,
        sourceRepositoryId: r.sourceRepositoryId,
        sourceDefaultBranch: r.sourceDefaultBranch,
        archivedAt: r.archivedAt,
        createdAt: r.createdAt,
        plan: r.session?.plan ?? null,
        graph: r.session?.graph.snapshot() ?? null,
        approval: r.session?.storedApproval ?? null,
      })),
    };
  }

  restoreFrom(snapshot: ProjectStoreSnapshot): void {
    this.projects.clear();
    for (const p of snapshot.projects) {
      let session: GraphSession | null = null;
      if (p.plan) {
        session = new GraphSession(p.plan);
        if (p.graph) session.graph.restoreFrom(p.graph);
        session.restoreApproval(p.approval ?? null);
      }
      this.projects.set(p.id, {
        id: p.id,
        name: p.name,
        description: p.description,
        pmProvider: p.pmProvider,
        // A missing field is a legacy provider-only project. Keep it null so
        // the UI and audit trail do not imply a model was historically chosen.
        pmModel:
          p.pmModel === undefined || p.pmModel === null
            ? null
            : resolvePmModel(p.pmProvider, p.pmModel),
        sourceType: p.sourceType ?? null,
        sourceLocation: p.sourceLocation ?? null,
        sourceConnectionId: p.sourceConnectionId ?? null,
        sourceRepositoryId: p.sourceRepositoryId ?? null,
        sourceDefaultBranch: p.sourceDefaultBranch ?? null,
        createdAt: p.createdAt,
        archivedAt: p.archivedAt ?? null,
        session,
      });
    }
  }

  private record(id: string): ProjectRecord {
    const record = this.projects.get(id);
    if (!record || record.archivedAt !== null) throw new ProjectNotFoundError(id);
    return record;
  }

  private summarize(record: ProjectRecord): ProjectSummary {
    const location =
      record.sourceType === "local"
        ? safeLocalRepositoryDisplayName(record.sourceLocation)
        : record.sourceLocation;
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      pm_provider: record.pmProvider,
      pm_model: record.pmModel,
      reviewer_provider: reviewerFor(record.pmProvider),
      status: record.session ? "planned" : "draft",
      created_at: record.createdAt,
      plan_objective: record.session?.plan.objective ?? null,
      source_type: record.sourceType,
      source_location: location,
      // ONBOARDING O2: emitted here too, with the same values the relational
      // repository produces for a project of this shape. The shadow-read
      // parity check (shadowProjectRepository.ts) compares legacy against
      // relational field by field, so a field present on only one side would
      // register as a spurious mismatch on every project. Parity is real
      // here, not papered over: an in-memory project has no O2 onboarding and
      // no separate push target, so both are genuinely null.
      workspace_location: location,
      remote_location: null,
      onboarding_scenario: null,
    };
  }
}
