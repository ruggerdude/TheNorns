// FRONT DOOR P2 §D1: durable planning run lifecycle. Drives the real
// runPlanning() loop (via PlanningRunWorker) against a PGlite-backed
// PlanningRunService, using the same FakeAdapter pattern as
// test/planning.test.ts so the scripted conversations are identical.
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import type { ReviewFindingT } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PlanningRunConflictError, PlanningRunService } from "../src/planning/runService.js";
import {
  PlanningRunWorker,
  type PlanningRunWorkerOptions,
  type ResolvedPlanningModels,
} from "../src/planning/runWorker.js";
import { planContentHash } from "../src/planning/session.js";

function plan(moduleIds: string[]) {
  return {
    objective: "build the demo service",
    modules: moduleIds.map((id) => ({
      id,
      title: `Module ${id}`,
      description: `Implements ${id}`,
      deliverables: [`src/${id}.ts`],
      acceptance: [
        {
          id: "AC-1",
          statement: "tests pass",
          verification_type: "command",
          verification: "pnpm test",
        },
      ],
      dependencies: [],
      estimated_complexity: "M",
      risk: "low",
    })),
  };
}

const mustFix: ReviewFindingT = {
  severity: "must_fix",
  module_id: "api",
  finding: "no error handling module",
  recommendation: "add an error handling module",
};

describe.sequential("durable planning run worker", () => {
  let pg: PGlite;
  let service: PlanningRunService;
  let pm: FakeAdapter;
  let reviewer: FakeAdapter;
  let models: ResolvedPlanningModels;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES ('project-1', 'Planning project', 'active', 'assignment/default', 'verification/default', 'budget/default');
    `);
    const transactions = new PGliteTransactionRunner(pg);
    service = new PlanningRunService(transactions);
    pm = new FakeAdapter("anthropic");
    reviewer = new FakeAdapter("openai");
    models = {
      pm: { provider: pm.provider, model: pm.model },
      reviewer: { provider: reviewer.provider, model: reviewer.model },
    };
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  function makeWorker(overrides: Partial<PlanningRunWorkerOptions> = {}) {
    const transactions = new PGliteTransactionRunner(pg);
    const createAdapter = (provider: ProviderName): LlmAdapter =>
      provider === "anthropic" ? pm : reviewer;
    return new PlanningRunWorker(transactions, createAdapter, {
      resolveModels: async () => models,
      ...overrides,
    });
  }

  it("runs a queued run to convergence and persists transcript + result", async () => {
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });

    const created = await service.create("project-1", { objective: "objective one" });
    expect(created.status).toBe("queued");

    const worker = makeWorker();
    const outcome = await worker.runNow(created.id);
    expect(outcome).toBe("processed");

    const run = await service.get("project-1", created.id);
    expect(run.status).toBe("converged");
    expect(run.round).toBe(1);
    expect(run.error).toBeNull();
    expect(run.transcript.map((entry) => entry.role)).toEqual(["pm", "reviewer"]);
    expect(run.transcript[1]?.finding_counts).toEqual({
      must_fix: 0,
      should_fix: 0,
      suggestion: 0,
    });
    expect(run.result).not.toBeNull();
    expect(run.result?.content_hash).toBe(planContentHash(run.result?.plan as never));
    expect(run.result?.total_cost_usd).toBeGreaterThan(0);
    expect(run.total_cost_usd).toBe(run.result?.total_cost_usd);
  });

  it("reaches cap_reached and surfaces the round cap in the persisted record", async () => {
    pm.enqueue(plan(["api"]));
    for (let round = 0; round < 2; round += 1) reviewer.enqueue({ findings: [mustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "revised" }],
      plan: plan(["api"]),
    });

    const created = await service.create("project-1", { objective: "objective two", maxRounds: 2 });
    const worker = makeWorker();
    await worker.runNow(created.id);

    const run = await service.get("project-1", created.id);
    expect(run.status).toBe("cap_reached");
    expect(run.round).toBe(2);
    expect(run.max_rounds).toBe(2);
    // draft + 2 review rounds + 1 revision = 4 transcript entries
    expect(run.transcript).toHaveLength(4);
  });

  it("records a truthful failure when the deployment lacks required configuration", async () => {
    const created = await service.create("project-1", { objective: "objective three" });
    const transactions = new PGliteTransactionRunner(pg);
    const worker = new PlanningRunWorker(transactions, () => pm, {
      resolveModels: async () => {
        throw new Error("live planning requires ANTHROPIC_API_KEY to be set");
      },
    });
    await worker.runNow(created.id);
    const run = await service.get("project-1", created.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("ANTHROPIC_API_KEY");
  });

  it("runNow no-ops when the run is no longer queued", async () => {
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });
    const created = await service.create("project-1", { objective: "objective four" });
    const worker = makeWorker();
    await worker.runNow(created.id);
    // already converged: a second claim attempt finds nothing queued
    expect(await worker.runNow(created.id)).toBe("not_found");
  });

  it("tick() claims the oldest queued run and idles when none are queued", async () => {
    const worker = makeWorker();
    expect(await worker.tick()).toBe("idle");

    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });
    const created = await service.create("project-1", { objective: "objective five" });
    expect(await worker.tick()).toBe("processed");
    const run = await service.get("project-1", created.id);
    expect(run.status).toBe("converged");
  });

  it("reconcileOrphans marks a run left mid-flight by a dead process as truthfully failed", async () => {
    const created = await service.create("project-1", { objective: "objective six" });
    await pg.query("UPDATE planning_runs SET status = 'reviewing', round = 1 WHERE id = $1", [
      created.id,
    ]);
    const worker = makeWorker();
    const reconciled = await worker.reconcileOrphans();
    expect(reconciled).toBe(1);
    const run = await service.get("project-1", created.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("restarted");
  });

  it("service.create rejects an unknown project and service.get rejects an unknown run", async () => {
    await expect(service.create("no-such-project", { objective: "x" })).rejects.toMatchObject({
      code: "project_not_found",
    });
    await expect(service.get("project-1", "no-such-run")).rejects.toBeInstanceOf(
      PlanningRunConflictError,
    );
  });

  it("defaults max_rounds to the project's persisted default when the caller omits it", async () => {
    await pg.exec(`
      INSERT INTO planning_reviewer_settings (project_id, default_max_rounds)
      VALUES ('project-1', 5);
    `);
    const created = await service.create("project-1", { objective: "objective seven" });
    expect(created.max_rounds).toBe(5);
  });

  it("reviewerSelectionOf returns null without an override and the pair once persisted", async () => {
    expect(await service.reviewerSelectionOf("project-1")).toBeNull();
    await pg.exec(`
      INSERT INTO planning_reviewer_settings (project_id, reviewer_provider, reviewer_model)
      VALUES ('project-1', 'openai', 'gpt-5.6-luna');
    `);
    expect(await service.reviewerSelectionOf("project-1")).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
  });
});
