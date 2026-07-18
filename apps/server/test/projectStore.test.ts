// Multi-project management: create/list, plan a project, and durably
// round-trip every project (metadata + plan + graph edits/allocations)
// through a snapshot — the same fidelity bar the old single-graph
// persistence test proved, now for N independently-managed projects.
import { PlanContract, type PlanContractT } from "@norns/contracts";
import { describe, expect, it } from "vitest";
import { approveAllocation, autoAllocate, overrideAssignment } from "../src/graph/allocation.js";
import { ProjectNotFoundError, ProjectStore, reviewerFor } from "../src/projects/store.js";

const SMALL_PLAN: PlanContractT = PlanContract.parse({
  objective: "Add a health-check endpoint",
  modules: [
    {
      id: "foundation",
      title: "Foundation",
      description: "Foundation module",
      deliverables: ["foundation deliverable"],
      acceptance: [
        {
          id: "AC-1",
          statement: "foundation passes",
          verification_type: "command",
          verification: "pnpm test",
        },
      ],
      dependencies: [],
      estimated_complexity: "M",
      risk: "low",
      parallelization: { safe: false },
    },
  ],
});

describe("reviewerFor", () => {
  it("always picks the opposite provider from the PM, preserving cross-provider review", () => {
    expect(reviewerFor("anthropic")).toBe("openai");
    expect(reviewerFor("openai")).toBe("anthropic");
  });
});

describe("ProjectStore", () => {
  it("creates and lists projects, newest first, starting in draft status", () => {
    const store = new ProjectStore();
    const a = store.create({ name: "First", description: "d1", pmProvider: "anthropic" });
    const b = store.create({ name: "Second", description: "d2", pmProvider: "openai" });

    expect(a.status).toBe("draft");
    expect(a.pm_provider).toBe("anthropic");
    expect(a.pm_model).toBe("claude-sonnet-5");
    expect(a.reviewer_provider).toBe("openai");
    expect(a.plan_objective).toBeNull();

    const listed = store.list();
    expect(listed.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("stores an explicit provider-matched model and rejects a mismatch", () => {
    const store = new ProjectStore();
    const project = store.create({
      name: "Fable project",
      description: "d",
      pmProvider: "anthropic",
      pmModel: "claude-fable-5",
    });

    expect(project.pm_model).toBe("claude-fable-5");
    expect(store.pmSelectionOf(project.id)).toEqual({
      provider: "anthropic",
      model: "claude-fable-5",
    });
    expect(() =>
      store.create({
        name: "Mismatch",
        description: "d",
        pmProvider: "anthropic",
        pmModel: "gpt-5.6-sol",
      }),
    ).toThrow(/not available for provider/);
  });

  it("stores and restores a connected project source", () => {
    const store = new ProjectStore();
    const project = store.create({
      name: "Connected",
      description: "d",
      pmProvider: "openai",
      sourceType: "github",
      sourceLocation: "https://github.com/example/connected.git",
    });

    expect(project.source_type).toBe("github");
    expect(project.source_location).toBe("https://github.com/example/connected.git");

    const restored = new ProjectStore();
    restored.restoreFrom(store.snapshot());
    expect(restored.summary(project.id)).toMatchObject({
      source_type: "github",
      source_location: "https://github.com/example/connected.git",
    });
  });

  it("never exposes an absolute path from a legacy local project snapshot", () => {
    const store = new ProjectStore();
    const project = store.create({
      name: "Legacy local",
      description: "d",
      pmProvider: "openai",
      sourceType: "local",
      sourceLocation: "/Users/operator/private/repository",
    });

    expect(project.source_location).toBe("Local repository");
    expect(store.list()[0]?.source_location).toBe("Local repository");
    expect(JSON.stringify(store.summary(project.id))).not.toContain("/Users/operator");
  });

  it("throws ProjectNotFoundError for an unknown id", () => {
    const store = new ProjectStore();
    expect(() => store.summary("proj-does-not-exist")).toThrow(ProjectNotFoundError);
  });

  it("loadPlan turns a draft project into a planned one with a real graph", () => {
    const store = new ProjectStore();
    const project = store.create({ name: "P", description: "d", pmProvider: "anthropic" });
    expect(() => store.session(project.id)).toThrow();

    const session = store.loadPlan(project.id, SMALL_PLAN);
    expect(session.graph.node("foundation")).toBeDefined();
    expect(store.summary(project.id).status).toBe("planned");
    expect(store.summary(project.id).plan_objective).toBe(SMALL_PLAN.objective);
  });

  it("loadPlan rejects an invalid plan and leaves the project untouched", () => {
    const store = new ProjectStore();
    const project = store.create({ name: "P", description: "d", pmProvider: "anthropic" });
    const firstModule = SMALL_PLAN.modules[0];
    if (!firstModule) throw new Error("unreachable: SMALL_PLAN always has a module");
    const bad = PlanContract.parse({
      ...SMALL_PLAN,
      modules: [{ ...firstModule, dependencies: ["ghost"] }],
    });
    expect(() => store.loadPlan(project.id, bad)).toThrow();
    expect(store.summary(project.id).status).toBe("draft");
  });

  it("round-trips every project (metadata, plan, graph edits, allocations) through a snapshot", () => {
    const store = new ProjectStore();
    const draft = store.create({
      name: "Draft only",
      description: "no plan yet",
      pmProvider: "openai",
    });
    const planned = store.create({
      name: "Planned",
      description: "has a plan",
      pmProvider: "anthropic",
    });
    const session = store.loadPlan(planned.id, SMALL_PLAN);
    autoAllocate(session.graph, "balanced");
    overrideAssignment(session.graph, "foundation", { budget_usd: 55 });
    const versionBefore = session.graph.version;

    const restored = new ProjectStore();
    restored.restoreFrom(store.snapshot());

    const restoredList = restored.list().sort((a, b) => a.name.localeCompare(b.name));
    expect(restoredList.map((p) => p.name)).toEqual(["Draft only", "Planned"]);
    expect(restored.summary(draft.id).status).toBe("draft");
    expect(restored.summary(draft.id).pm_model).toBe("gpt-5.6-terra");
    expect(() => restored.session(draft.id)).toThrow();

    const restoredSession = restored.session(planned.id);
    expect(restoredSession.graph.version).toBe(versionBefore);
    expect(restoredSession.graph.node("foundation")?.assignment?.budget_usd).toBe(55);
    expect(restoredSession.graph.node("foundation")?.assignment?.source).toBe("override");
    expect(restoredSession.graph.snapshot()).toEqual(session.graph.snapshot());
  });

  it("restores a provider-only legacy snapshot without inventing historical model provenance", () => {
    const store = new ProjectStore();
    store.create({ name: "Legacy", description: "d", pmProvider: "openai" });
    const snapshot = store.snapshot();
    const saved = snapshot.projects[0];
    if (!saved) throw new Error("expected project snapshot");
    Reflect.deleteProperty(saved, "pmModel");

    const restored = new ProjectStore();
    restored.restoreFrom(snapshot);

    expect(restored.list()[0]?.pm_model).toBeNull();
    expect(restored.pmSelectionOf(saved.id)).toEqual({ provider: "openai", model: null });
  });

  it("round-trips a persisted allocation approval and re-derives staleness after restore (ADR-1)", () => {
    const store = new ProjectStore();
    const project = store.create({ name: "P", description: "d", pmProvider: "anthropic" });
    const session = store.loadPlan(project.id, SMALL_PLAN);
    autoAllocate(session.graph, "balanced");
    session.recordApproval(approveAllocation(session.graph, "operator"));
    expect(session.approvalStatus()).toMatchObject({ current: true, actor: "operator" });

    const restored = new ProjectStore();
    restored.restoreFrom(store.snapshot());
    const restoredSession = restored.session(project.id);

    // The approval survived the snapshot and is still current (nothing changed).
    expect(restoredSession.approvalStatus()).toMatchObject({ current: true, actor: "operator" });

    // A later override on the restored graph makes it stale — staleness is
    // computed live against the current fingerprint, not persisted as a flag.
    overrideAssignment(restoredSession.graph, "foundation", { budget_usd: 999 });
    expect(restoredSession.approvalStatus()).toMatchObject({ current: false });
  });
});
