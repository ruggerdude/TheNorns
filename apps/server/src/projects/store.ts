// Multi-project management (the "sole point of entry"): a Project is a
// named unit of work with its own PM/reviewer provider choice and, once
// planned, its own GraphSession (plan + workflow graph). This replaces the
// single hardcoded GraphSession the graph editor used to operate on — the
// server can now hold many projects at once, list/create/switch between
// them, and persist all of them under Tier-2.
import type { ProviderName } from "@norns/adapters";
import { type PlanContractT, validatePlan } from "@norns/contracts";
import { type GraphSnapshot, WorkflowGraph } from "../graph/graph.js";
import { GraphSession } from "../graph/session.js";
import { newId } from "../ids.js";

export type ProjectStatus = "draft" | "planned";

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  pm_provider: ProviderName;
  reviewer_provider: ProviderName;
  status: ProjectStatus;
  created_at: string;
  plan_objective: string | null;
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
  createdAt: string;
  session: GraphSession | null;
}

export interface ProjectStoreSnapshot {
  projects: {
    id: string;
    name: string;
    description: string;
    pmProvider: ProviderName;
    createdAt: string;
    plan: PlanContractT | null;
    graph: GraphSnapshot | null;
  }[];
}

/** Cross-provider review is the standing policy: reviewer is always the PM's opposite. */
export function reviewerFor(pmProvider: ProviderName): ProviderName {
  return pmProvider === "anthropic" ? "openai" : "anthropic";
}

export class ProjectStore {
  private readonly projects = new Map<string, ProjectRecord>();

  create(input: { name: string; description: string; pmProvider: ProviderName }): ProjectSummary {
    const record: ProjectRecord = {
      id: newId("proj"),
      name: input.name,
      description: input.description,
      pmProvider: input.pmProvider,
      createdAt: new Date().toISOString(),
      session: null,
    };
    this.projects.set(record.id, record);
    return this.summarize(record);
  }

  /** Newest first. Map iteration order is insertion order — a stable tiebreak
   *  that doesn't depend on wall-clock resolution (two projects created in
   *  the same millisecond would otherwise tie under a createdAt sort). */
  list(): ProjectSummary[] {
    return [...this.projects.values()].reverse().map((r) => this.summarize(r));
  }

  summary(id: string): ProjectSummary {
    return this.summarize(this.record(id));
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
        createdAt: r.createdAt,
        plan: r.session?.plan ?? null,
        graph: r.session?.graph.snapshot() ?? null,
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
      }
      this.projects.set(p.id, {
        id: p.id,
        name: p.name,
        description: p.description,
        pmProvider: p.pmProvider,
        createdAt: p.createdAt,
        session,
      });
    }
  }

  private record(id: string): ProjectRecord {
    const record = this.projects.get(id);
    if (!record) throw new ProjectNotFoundError(id);
    return record;
  }

  private summarize(record: ProjectRecord): ProjectSummary {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      pm_provider: record.pmProvider,
      reviewer_provider: reviewerFor(record.pmProvider),
      status: record.session ? "planned" : "draft",
      created_at: record.createdAt,
      plan_objective: record.session?.plan.objective ?? null,
    };
  }
}
