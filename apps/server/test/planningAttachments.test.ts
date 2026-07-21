// FRONT DOOR P4 (D3): objective attachments flow into planning round 1 only.
// Drives the real PlanningRunWorker + runPlanning() loop against a PGlite-backed
// PlanningRunService and a real AttachmentService, capturing the exact per-call
// image parts via FakeAdapter.requests.
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import type { ReviewFindingT } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentService } from "../src/attachments/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { PlanningRunService } from "../src/planning/runService.js";
import { PlanningRunWorker, type ResolvedPlanningModels } from "../src/planning/runWorker.js";

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

function pngBase64(width: number, height: number): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.from([0, 0, 0, 13]);
  const ihdr = Buffer.from("IHDR", "ascii");
  const w = Buffer.alloc(4);
  w.writeUInt32BE(width);
  const h = Buffer.alloc(4);
  h.writeUInt32BE(height);
  const trailer = Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([signature, ihdrLength, ihdr, w, h, trailer]).toString("base64");
}

const mustFix: ReviewFindingT = {
  severity: "must_fix",
  module_id: "api",
  finding: "no error handling",
  recommendation: "add error handling",
};

describe.sequential("planning round-1 attachment injection (FRONT DOOR P4)", () => {
  let pg: PGlite;
  let runs: PlanningRunService;
  let attachments: AttachmentService;
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
    runs = new PlanningRunService(transactions);
    attachments = new AttachmentService(transactions);
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

  function makeWorker() {
    const transactions = new PGliteTransactionRunner(pg);
    const createAdapter = (provider: ProviderName): LlmAdapter =>
      provider === "anthropic" ? pm : reviewer;
    return new PlanningRunWorker(transactions, createAdapter, {
      resolveModels: async () => models,
      loadRoundOneImages: (projectId, ids) => attachments.imagePartsFor(projectId, ids),
    });
  }

  it("injects objective images into the PM draft and round-1 review, not later rounds", async () => {
    const a = await attachments.create("project-1", { mime: "image/png", base64: pngBase64(1, 1) });
    const b = await attachments.create("project-1", { mime: "image/png", base64: pngBase64(2, 2) });

    // Two rounds: draft -> review(mustFix) -> revise -> review(clean).
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [mustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "revised" }],
      plan: plan(["api", "errors"]),
    });
    reviewer.enqueue({ findings: [] });

    const created = await runs.create("project-1", {
      objective: "objective with screenshots",
      maxRounds: 3,
      attachmentIds: [a.id, b.id],
    });
    expect(await makeWorker().runNow(created.id)).toBe("processed");

    const run = await runs.get("project-1", created.id);
    expect(run.status).toBe("converged");

    // PM call 1 = round-1 draft (carries both images); PM call 2 = revision (none).
    expect(pm.requests[0]?.images?.map((i) => i.base64)).toEqual([
      pngBase64(1, 1),
      pngBase64(2, 2),
    ]);
    expect(pm.requests[0]?.images?.every((i) => i.mime === "image/png")).toBe(true);
    expect(pm.requests[1]?.images).toBeUndefined();

    // Reviewer call 1 = round-1 review (carries images); call 2 = round-2 (none).
    expect(reviewer.requests[0]?.images).toHaveLength(2);
    expect(reviewer.requests[1]?.images).toBeUndefined();
  });

  it("runs text-only when no attachments are supplied", async () => {
    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });

    const created = await runs.create("project-1", { objective: "no images", maxRounds: 2 });
    expect(await makeWorker().runNow(created.id)).toBe("processed");

    expect(pm.requests[0]?.images).toBeUndefined();
    expect(reviewer.requests[0]?.images).toBeUndefined();
  });

  it("drops unknown/deleted attachment ids and proceeds with the survivors", async () => {
    const a = await attachments.create("project-1", { mime: "image/png", base64: pngBase64(3, 3) });
    const b = await attachments.create("project-1", { mime: "image/png", base64: pngBase64(4, 4) });
    await attachments.delete("project-1", b.id);

    pm.enqueue(plan(["api"]));
    reviewer.enqueue({ findings: [] });

    const created = await runs.create("project-1", {
      objective: "one live, one deleted, one bogus",
      maxRounds: 2,
      attachmentIds: [a.id, b.id, "att_does_not_exist"],
    });
    expect(await makeWorker().runNow(created.id)).toBe("processed");

    // Only the live attachment survives, in order.
    expect(pm.requests[0]?.images?.map((i) => i.base64)).toEqual([pngBase64(3, 3)]);
  });
});
