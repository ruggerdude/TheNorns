// QCP-1B: park and resume a QC review through the worker (QC-PAUSE-POINTS.md,
// "Durability: a gate parks, it does not wait"). Drives the real
// PlanningRunWorker + ConversationPlanWorkflowService + FakeAdapter stack
// against a PGlite-backed schema so every status transition goes through the
// production UPDATE statements (and their DB triggers/CHECK constraints),
// not a seeded row.
import { PGlite } from "@electric-sql/pglite";
import {
  AdapterError,
  type CompletionRequest,
  FakeAdapter,
  type LlmAdapter,
  type ProviderName,
  type StructuredResult,
} from "@norns/adapters";
import {
  type V2ConversationPlanReviewFindingT,
  type V2QcModeT,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { ConversationPlanWorkflowService } from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { runReviewOnlyPlanning } from "../src/planning/reviewOnlySession.js";
import { PlanningRunWorker } from "../src/planning/runWorker.js";

function plan(objective: string, moduleDescription: string): V2WorkPlanContractT {
  return V2WorkPlanContract.parse({
    plan: {
      objective,
      assumptions: ["The existing execution bridge remains authoritative."],
      modules: [
        {
          id: "workflow",
          title: "Workflow",
          description: moduleDescription,
          deliverables: ["Durable workflow"],
          acceptance: [
            {
              id: "workflow-pass",
              statement: "The workflow passes focused tests.",
              verification_type: "test",
              verification: "Run the workflow suite.",
            },
          ],
          dependencies: [],
          estimated_complexity: "M",
          risk: "medium",
          execution: {
            likely_paths: ["apps/server/src/conversations/planWorkflow.ts"],
            owned_components: ["conversation plan workflow"],
            test_commands: ["pnpm --filter @norns/server test"],
            environment_requirements: [],
            migration_required: true,
          },
          parallelization: {
            safe: false,
            candidate_work_units: [],
            shared_files: [],
            integration_owner_required: true,
          },
          inputs: ["Human planning discussion"],
          outputs: ["Approved immutable plan"],
          open_decisions: [],
        },
      ],
      risks: [{ description: "State drift", mitigation: "Lock exact versions." }],
      out_of_scope: ["Execution conversation handoff"],
    },
    staffing: [
      {
        module_id: "workflow",
        agent_role: "implementation",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    ],
    verification_requirements: ["Focused workflow tests pass."],
    open_decisions: [],
    estimated_budget: { currency: "USD", amount: 20 },
  });
}

const hollowMustFix = {
  severity: "must_fix" as const,
  module_id: "workflow",
  finding: "Clarify the objective.",
  recommendation: "State the objective precisely.",
};

class BlockingReviewer extends FakeAdapter {
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  override async completeStructured<T>(
    request: CompletionRequest,
    _schema: z.ZodType<T>,
    _schemaName: string,
  ): Promise<StructuredResult<T>> {
    this.startedResolve();
    return new Promise<StructuredResult<T>>((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => reject(new AdapterError("cancelled", "request aborted for graceful drain")),
        { once: true },
      );
    });
  }
}

describe.sequential("QC pause and resume (QCP-1B)", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workflow: ConversationPlanWorkflowService;
  let worker: PlanningRunWorker;
  let pm: FakeAdapter;
  let reviewerV1: FakeAdapter;
  let reviewerV2: FakeAdapter;
  let dispatchCount = 0;
  let id = 0;

  const owner = { id: "qc-pause-owner" };
  const projectId = "qc-pause-project";

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'qc-pause-owner', 'qc-pause-owner@example.com', 'Owner',
        'qc-pause-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'qc-pause-project', 'QC Pause', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'qc-pause-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    dispatchCount = 0;
    const makeId = (prefix: string) => `${prefix}-qc-pause-${++id}`;
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: makeId,
    });
    pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    reviewerV1 = new FakeAdapter("openai", "gpt-5.6-sol");
    // A distinct instance/model the reviewer would resolve to if a resume
    // ever re-derived it from "current project settings" instead of reading
    // the pinned reviewer_provider/reviewer_model off the review row.
    reviewerV2 = new FakeAdapter("openai", "gpt-5.6-terra");
    workflow = new ConversationPlanWorkflowService(transactions, {
      newId: makeId,
      resolveReviewModels: async () => {
        throw new Error("resolveReviewModels must not be used by an explicit reviewer pin");
      },
      // Dispatch is driven explicitly in each test (via worker.runNow) so
      // round processing is deterministic; only the invocation count is
      // observed here, to prove resume's idempotent replay never redispatches.
      runReviewNow: async () => {
        dispatchCount += 1;
      },
      cancelReviewNow: (runId) => worker.cancelReview(runId),
    });
    worker = new PlanningRunWorker(
      transactions,
      (provider: ProviderName, model: string): LlmAdapter => {
        if (provider === "anthropic") return pm;
        return model === "gpt-5.6-terra" ? reviewerV2 : reviewerV1;
      },
      {
        // review-only mode must never call this — a resume that re-resolved
        // the reviewer from live project settings would hit it.
        resolveModels: async () => {
          throw new Error("resolveModels must not be called for review-only mode");
        },
        loadReviewOnlySeed: (runId) => workflow.loadReviewOnlySeed(runId),
        markReviewOnlyStarted: (reviewId) => workflow.markReviewOnlyStarted(reviewId),
        recordReviewOnlyProgress: (input) => workflow.recordReviewOnlyProgress(input),
        recordReviewOnlyCheckpoint: (input) => workflow.recordReviewOnlyCheckpoint(input),
        recordReviewOnlyChatEvent: (input) => workflow.recordReviewOnlyChatEvent(input),
        completeReviewOnly: (input) => workflow.completeReviewOnly(input),
        pauseReviewOnly: (input) => workflow.pauseReviewOnly(input),
        failReviewOnly: (runId, error) => workflow.failReviewOnly(runId, error),
      },
    );
  }, 30_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  async function workspace(label: string) {
    const created = await conversations.createPlanningWorkspace(
      owner,
      { project_id: projectId, title: `Work ${label}`, objective: `Objective ${label}` },
      { provider: "anthropic", model: "claude-sonnet-5" },
    );
    const message = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      client_message_id: `client-${label}`,
      parts: [{ type: "text", format: "markdown", text: `brainstorm ${label}` }],
    });
    return { ...created, message };
  }

  async function sendToQc(label: string, maxRounds = 3, qcMode: V2QcModeT = "gated_each_round") {
    const created = await workspace(label);
    const envelope = plan(`Objective ${label}`, "Deliver the durable workflow.");
    const saveAction = await conversations.proposeAction(owner, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      source_message_id: created.message.id,
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: envelope,
          handoff: {
            execution_agent: { provider: "openai", model: "gpt-5.6-sol" },
            review: {
              mode: "qc",
              reviewer: { provider: "openai", model: "gpt-5.6-sol" },
              rounds: maxRounds,
            },
          },
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
          referenced_artifacts: [],
        },
      },
    });
    const saved = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: saveAction.id,
      idempotency_key: `save-${label}`,
    });
    if (saved.effect.kind !== "plan_saved") throw new Error("expected plan_saved effect");
    const detail = await workflow.detail(
      owner.id,
      projectId,
      created.work_item.id,
      created.conversation.id,
    );
    const send = detail.actions.find(
      (action) => action.action_type === "send_plan_to_qc" && action.status === "proposed",
    );
    if (!send) throw new Error("save must emit a send-to-QC action");
    const sent = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: send.id,
      idempotency_key: `send-${label}`,
      qc_mode: qcMode,
    });
    if (sent.effect.kind !== "qc_started") throw new Error("expected QC effect");
    return {
      ...created,
      envelope,
      scope: {
        projectId,
        workItemId: created.work_item.id,
        conversationId: created.conversation.id,
      },
      reviewId: sent.effect.plan_review.id,
      planningRunId: sent.effect.planning_run_id,
    };
  }

  async function reviewRow(reviewId: string) {
    const rows = await pg.query<{
      status: string;
      paused_checkpoint: string | null;
      paused_at_round: number | null;
      rounds_completed: number;
      completed_at: string | null;
      revised_plan_version_id: string | null;
      result_plan_content_hash: string;
      plan_content_hash: string;
      reviewer_provider: string;
      reviewer_model: string;
      findings: V2ConversationPlanReviewFindingT[];
      dispositions: unknown;
    }>(
      `SELECT review.status, review.paused_checkpoint, review.paused_at_round,
              run.round AS rounds_completed, review.completed_at,
              review.revised_plan_version_id, review.result_plan_content_hash,
              review.plan_content_hash, review.reviewer_provider, review.reviewer_model,
              review.findings, review.dispositions
         FROM conversation_plan_reviews review
         JOIN planning_runs run ON run.id = review.planning_run_id
        WHERE review.id = $1`,
      [reviewId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`review "${reviewId}" not found`);
    return row;
  }

  async function planningRunRow(planningRunId: string) {
    const rows = await pg.query<{
      status: string;
      lease_token: string | null;
      leased_until: string | null;
    }>("SELECT status, lease_token, leased_until FROM planning_runs WHERE id = $1", [
      planningRunId,
    ]);
    const row = rows.rows[0];
    if (!row) throw new Error(`planning run "${planningRunId}" not found`);
    return row;
  }

  /** Rounds the reviewer/PM through a real, non-hollow accepted revision —
   *  Gate C does not fire (the finding's target module genuinely changed) —
   *  so the pause comes from Gate B ("after_revision", qc_mode
   *  gated_each_round pinned by sendToQc). The PM's revision is a genuine
   *  content change, so a "qc_interim" plan version is materialized. */
  function scriptGatedRoundPause(label: string) {
    reviewerV1.enqueue({ findings: [hollowMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Addressed now." }],
      plan: plan(
        `Objective ${label}`,
        "Deliver the durable workflow, now with the objective clarified.",
      ),
    });
  }

  it("(a) a paused result parks the review durably", async () => {
    const sent = await sendToQc("park");
    scriptGatedRoundPause("park");

    const outcome = await worker.runNow(sent.planningRunId);
    expect(outcome).toBe("processed");

    const review = await reviewRow(sent.reviewId);
    expect(review.status).toBe("awaiting_human");
    expect(review.paused_checkpoint).toBe("after_revision");
    expect(review.paused_at_round).toBe(1);
    expect(review.completed_at).toBeNull();
    expect(review.revised_plan_version_id).not.toBeNull();
    expect(review.result_plan_content_hash).not.toBe(review.plan_content_hash);
    expect(review.findings).toHaveLength(1);
    expect(review.dispositions).toHaveLength(1);

    const interim = await pg.query<{ origin: string; status: string }>(
      "SELECT origin, status FROM work_plan_versions WHERE id = $1",
      [review.revised_plan_version_id],
    );
    expect(interim.rows[0]?.origin).toBe("qc_interim");
  });

  it("(b) the lease is released and a subsequent tick() does not re-claim the parked run", async () => {
    const sent = await sendToQc("lease");
    scriptGatedRoundPause("lease");
    await worker.runNow(sent.planningRunId);

    const run = await planningRunRow(sent.planningRunId);
    expect(run.status).toBe("awaiting_human");
    expect(run.lease_token).toBeNull();
    expect(run.leased_until).toBeNull();

    expect(await worker.tick()).toBe("idle");
    const stillParked = await planningRunRow(sent.planningRunId);
    expect(stillParked.status).toBe("awaiting_human");
  });

  it("(c) resume re-claims and continues using the pinned reviewer, never a re-derived one", async () => {
    const sent = await sendToQc("resume");
    scriptGatedRoundPause("resume");
    await worker.runNow(sent.planningRunId);
    expect((await reviewRow(sent.reviewId)).status).toBe("awaiting_human");

    // Round 2, scripted on reviewerV1 only — if resume ever re-derived the
    // reviewer it would either hit resolveModels' throw guard or try to pull
    // a response from reviewerV2's empty queue and throw "queue is empty".
    reviewerV1.enqueue({ findings: [] });

    const resumed = await workflow.resumeReview(owner.id, sent.scope, sent.reviewId, {
      exit: "continue",
    });
    expect(resumed.status).toBe("awaiting_human"); // flips to running only once the worker re-claims
    expect(await planningRunRow(sent.planningRunId)).toMatchObject({ status: "queued" });

    const outcome = await worker.runNow(sent.planningRunId);
    expect(outcome).toBe("processed");

    expect(reviewerV2.requests).toHaveLength(0);
    expect(reviewerV1.requests).toHaveLength(2);

    const finalReview = await reviewRow(sent.reviewId);
    expect(finalReview.status).toBe("converged");
    expect(finalReview.reviewer_provider).toBe("openai");
    expect(finalReview.reviewer_model).toBe("gpt-5.6-sol");
  });

  it("(d) reconcileOrphans() does not fail a parked review", async () => {
    const sent = await sendToQc("orphan");
    scriptGatedRoundPause("orphan");
    await worker.runNow(sent.planningRunId);

    const reconciled = await worker.reconcileOrphans();
    expect(reconciled).toBe(0);

    const review = await reviewRow(sent.reviewId);
    expect(review.status).toBe("awaiting_human");
    const run = await planningRunRow(sent.planningRunId);
    expect(run.status).toBe("awaiting_human");
  });

  it("(e) resume is idempotent under a repeated idempotency_key", async () => {
    const sent = await sendToQc("idempotent");
    scriptGatedRoundPause("idempotent");
    await worker.runNow(sent.planningRunId);
    // sendToQc's own send_plan_to_qc confirmation already dispatched once;
    // measure resume's dispatches relative to that baseline.
    const baseline = dispatchCount;

    const first = await workflow.resumeReview(owner.id, sent.scope, sent.reviewId, {
      exit: "continue",
      idempotencyKey: "resume-key-1",
    });
    expect(dispatchCount).toBe(baseline + 1);
    const replay = await workflow.resumeReview(owner.id, sent.scope, sent.reviewId, {
      exit: "continue",
      idempotencyKey: "resume-key-1",
    });
    expect(dispatchCount).toBe(baseline + 1); // no second dispatch on replay
    expect(replay).toEqual(first);

    // A resume with a different key against an already-resumed (no longer
    // awaiting_human, once claimed) review is rejected, not silently replayed.
    reviewerV1.enqueue({ findings: [] });
    await worker.runNow(sent.planningRunId);
    await expect(
      workflow.resumeReview(owner.id, sent.scope, sent.reviewId, {
        exit: "continue",
        idempotencyKey: "resume-key-2",
      }),
    ).rejects.toMatchObject({ code: "invalid_plan_state" });
  });

  it("(f) cancel while parked succeeds and cancelReviewNow no-ops with no controller present", async () => {
    const sent = await sendToQc("cancel");
    scriptGatedRoundPause("cancel");
    await worker.runNow(sent.planningRunId);

    // No in-process controller exists for a parked run — the worker exited.
    expect(worker.cancelReview(sent.planningRunId)).toBe(false);

    const cancelled = await workflow.cancelReview(
      owner.id,
      sent.scope,
      sent.reviewId,
      "human stopped it while parked",
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.findings).toEqual([]);
    expect(cancelled.dispositions).toEqual([]);
    expect(cancelled.revised_plan_version_id).toBeNull();

    const run = await planningRunRow(sent.planningRunId);
    expect(run.status).toBe("cancelled");
  });

  it("(g) full round trip: park, resume, and converge", async () => {
    const sent = await sendToQc("roundtrip");
    scriptGatedRoundPause("roundtrip");

    await worker.runNow(sent.planningRunId);
    expect((await reviewRow(sent.reviewId)).status).toBe("awaiting_human");

    reviewerV1.enqueue({ findings: [] });
    await workflow.resumeReview(owner.id, sent.scope, sent.reviewId, { exit: "continue" });
    await worker.runNow(sent.planningRunId);

    const review = await reviewRow(sent.reviewId);
    expect(review.status).toBe("converged");
    expect(review.completed_at).not.toBeNull();

    const items = await pg.query<{ status: string }>(
      "SELECT status FROM work_items WHERE id = $1",
      [sent.work_item.id],
    );
    expect(items.rows[0]?.status).toBe("awaiting_approval");

    const versions = await pg.query<{ origin: string; status: string }>(
      "SELECT origin, status FROM work_plan_versions WHERE id = $1",
      [review.revised_plan_version_id],
    );
    expect(versions.rows[0]?.origin).toBe("qc_result");
  });

  // QCP-3A step 1: Gate A ("after_review") already parks correctly per
  // reviewOnlySession's unit tests (reviewOnlyPlanning.test.ts); this drives
  // the same gate through the real park/resume path — worker claim, DB
  // UPDATE, lease release, re-claim — the way the other gates are proven
  // above, and confirms resume actually runs the PM's revision pass rather
  // than just flipping status. qc_mode is pinned atomically at kickoff (the
  // confirm wire, QC-PAUSE-POINTS.md "Settings: three layers" layer 2)
  // rather than patched onto the row afterward, so this also proves the
  // pin survives into the worker's first checkpoint on round 1.
  it("(h) Gate A parks after the reviewer pass before the PM ever runs; resume runs the PM revision", async () => {
    const sent = await sendToQc("gatea", 3, "gated_each_step");
    reviewerV1.enqueue({ findings: [hollowMustFix] });

    const outcome = await worker.runNow(sent.planningRunId);
    expect(outcome).toBe("processed");

    const parked = await reviewRow(sent.reviewId);
    expect(parked.status).toBe("awaiting_human");
    expect(parked.paused_checkpoint).toBe("after_review");
    expect(parked.paused_at_round).toBe(1);
    expect(pm.requests).toHaveLength(0);

    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Addressed now." }],
      plan: plan(
        "Objective gatea",
        "Deliver the durable workflow, now with the objective clarified.",
      ),
    });
    await workflow.resumeReview(owner.id, sent.scope, sent.reviewId, {
      exit: "continue",
      findingDecisions: Object.fromEntries(
        parked.findings.map((finding) => [finding.id, "accept" as const]),
      ),
    });
    await worker.runNow(sent.planningRunId);

    expect(pm.requests).toHaveLength(1);
    const afterRevision = await reviewRow(sent.reviewId);
    // qc_mode is still gated_each_step, so Gate B parks the round-1 revision
    // rather than converging outright — the PM pass genuinely ran either way.
    expect(afterRevision.status).toBe("awaiting_human");
    expect(afterRevision.paused_checkpoint).toBe("after_revision");
    expect(afterRevision.dispositions).toHaveLength(1);
  });

  it("recovers after a durable reviewer checkpoint without repeating the reviewer", async () => {
    const sent = await sendToQc("restart-review", 1, "automatic");
    const leaseToken = "dead-review-lease";
    await pg.query(
      `UPDATE planning_runs
          SET status='reviewing', lease_token=$2, leased_until=$3, execution_attempt=1
        WHERE id=$1`,
      [sent.planningRunId, leaseToken, new Date(Date.now() + 60_000).toISOString()],
    );
    await workflow.markReviewOnlyStarted(sent.reviewId, leaseToken);
    const seed = await workflow.loadReviewOnlySeed(sent.planningRunId, leaseToken);
    reviewerV1.enqueue({ findings: [hollowMustFix] });

    await expect(
      runReviewOnlyPlanning({
        pm,
        reviewer: reviewerV1,
        projectId,
        initiatedByUserId: owner.id,
        seedPlan: seed.seedPlan,
        frozenContext: seed.frozenContext,
        telemetryGroupId: seed.usageRequestGroupId,
        maxRounds: 1,
        qcMode: "automatic",
        executionAttempt: 1,
        onCheckpoint: async (checkpoint) => {
          await workflow.recordReviewOnlyCheckpoint({
            reviewId: sent.reviewId,
            planningRunId: sent.planningRunId,
            checkpoint,
            leaseToken,
          });
          throw new Error("simulated process death after reviewer checkpoint");
        },
      }),
    ).rejects.toThrow("simulated process death");

    const savedCheckpoint = await pg.query<{
      execution_checkpoint: { usage_events: Array<{ estimated_cost_usd: number }> };
    }>("SELECT execution_checkpoint FROM conversation_plan_reviews WHERE id=$1", [sent.reviewId]);
    expect(savedCheckpoint.rows[0]?.execution_checkpoint.usage_events).toHaveLength(1);
    expect(await worker.reconcileOrphans()).toBe(0);
    expect((await planningRunRow(sent.planningRunId)).status).toBe("reviewing");

    await pg.query("UPDATE planning_runs SET leased_until=$2 WHERE id=$1", [
      sent.planningRunId,
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    expect(await worker.reconcileOrphans()).toBe(1);
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Recovered." }],
      plan: plan(
        "Objective restart-review",
        "Deliver the durable workflow with restart recovery clarified.",
      ),
    });
    await worker.runNow(sent.planningRunId);

    expect(reviewerV1.requests).toHaveLength(1);
    expect(pm.requests).toHaveLength(1);
    const recovered = await reviewRow(sent.reviewId);
    expect(recovered.status).toBe("cap_reached");
    const checkpoint = await pg.query<{ execution_checkpoint: unknown | null }>(
      "SELECT execution_checkpoint FROM conversation_plan_reviews WHERE id=$1",
      [sent.reviewId],
    );
    expect(checkpoint.rows[0]?.execution_checkpoint).toBeNull();
    const completedRun = await pg.query<{ total_cost_usd: number }>(
      "SELECT total_cost_usd::float8 AS total_cost_usd FROM planning_runs WHERE id=$1",
      [sent.planningRunId],
    );
    expect(completedRun.rows[0]?.total_cost_usd).toBeGreaterThan(
      savedCheckpoint.rows[0]?.execution_checkpoint.usage_events[0]?.estimated_cost_usd ?? 0,
    );
  });

  it("recovers after a durable revision checkpoint without repeating the PM", async () => {
    const sent = await sendToQc("restart-revision", 2, "automatic");
    const leaseToken = "dead-revision-lease";
    await pg.query(
      `UPDATE planning_runs
          SET status='reviewing', lease_token=$2, leased_until=$3, execution_attempt=1
        WHERE id=$1`,
      [sent.planningRunId, leaseToken, new Date(Date.now() + 60_000).toISOString()],
    );
    await workflow.markReviewOnlyStarted(sent.reviewId, leaseToken);
    const seed = await workflow.loadReviewOnlySeed(sent.planningRunId, leaseToken);
    reviewerV1.enqueue({ findings: [hollowMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Addressed." }],
      plan: plan(
        "Objective restart-revision",
        "Deliver the durable workflow with a persisted revision checkpoint.",
      ),
    });

    await expect(
      runReviewOnlyPlanning({
        pm,
        reviewer: reviewerV1,
        projectId,
        initiatedByUserId: owner.id,
        seedPlan: seed.seedPlan,
        frozenContext: seed.frozenContext,
        telemetryGroupId: seed.usageRequestGroupId,
        maxRounds: 2,
        qcMode: "automatic",
        executionAttempt: 1,
        onCheckpoint: async (checkpoint) => {
          await workflow.recordReviewOnlyCheckpoint({
            reviewId: sent.reviewId,
            planningRunId: sent.planningRunId,
            checkpoint,
            leaseToken,
          });
          if (checkpoint.completed_step === "revision") {
            throw new Error("simulated process death after revision checkpoint");
          }
        },
      }),
    ).rejects.toThrow("simulated process death");

    await pg.query("UPDATE planning_runs SET leased_until=$2 WHERE id=$1", [
      sent.planningRunId,
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    expect(await worker.reconcileOrphans()).toBe(1);
    reviewerV1.enqueue({ findings: [] });
    await worker.runNow(sent.planningRunId);

    expect(reviewerV1.requests).toHaveLength(2);
    expect(pm.requests).toHaveLength(1);
    expect((await reviewRow(sent.reviewId)).status).toBe("converged");
  });

  it("deduplicates replayed automatic chat responses and their Markdown artifact", async () => {
    const sent = await sendToQc("restart-chat", 1, "automatic");
    const leaseToken = "chat-lease";
    await pg.query(
      `UPDATE planning_runs
          SET status='reviewing', lease_token=$2, leased_until=$3, execution_attempt=1
        WHERE id=$1`,
      [sent.planningRunId, leaseToken, new Date(Date.now() + 60_000).toISOString()],
    );
    await workflow.markReviewOnlyStarted(sent.reviewId, leaseToken);
    const input = {
      reviewId: sent.reviewId,
      planningRunId: sent.planningRunId,
      leaseToken,
      event: {
        request_id: "restart-chat:review:1:exec:1",
        channel: "reviewer" as const,
        round: 1,
        attempt: 1,
        speaker: "reviewer" as const,
        kind: "response" as const,
        content: '{"findings":[]}',
        error_code: null,
        artifact_markdown: "# Reviewer response\n\nNo findings.",
        artifact_valid: true,
      },
    };
    await workflow.recordReviewOnlyChatEvent(input);
    await workflow.recordReviewOnlyChatEvent(input);

    const evidence = await pg.query<{
      chat_messages: unknown[];
      markdown_artifacts: unknown[];
    }>("SELECT chat_messages, markdown_artifacts FROM conversation_plan_reviews WHERE id=$1", [
      sent.reviewId,
    ]);
    expect(evidence.rows[0]?.chat_messages).toHaveLength(1);
    expect(evidence.rows[0]?.markdown_artifacts).toHaveLength(1);
    const artifacts = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM artifacts WHERE project_id=$1 AND kind='qc_review_markdown'",
      [projectId],
    );
    expect(artifacts.rows[0]?.count).toBe(1);
  });

  it("graceful drain requeues the matching claim and fences its late callbacks", async () => {
    const sent = await sendToQc("restart-drain", 1, "automatic");
    const blockingReviewer = new BlockingReviewer("openai", "gpt-5.6-sol");
    const drainingWorker = new PlanningRunWorker(
      transactions,
      (provider: ProviderName): LlmAdapter => (provider === "anthropic" ? pm : blockingReviewer),
      {
        resolveModels: async () => {
          throw new Error("review-only runs use pinned models");
        },
        loadReviewOnlySeed: (runId, leaseToken) => workflow.loadReviewOnlySeed(runId, leaseToken),
        markReviewOnlyStarted: (reviewId, leaseToken) =>
          workflow.markReviewOnlyStarted(reviewId, leaseToken),
        recordReviewOnlyCheckpoint: (input) => workflow.recordReviewOnlyCheckpoint(input),
        recordReviewOnlyProgress: (input) => workflow.recordReviewOnlyProgress(input),
        recordReviewOnlyChatEvent: (input) => workflow.recordReviewOnlyChatEvent(input),
        recordReviewOnlyStage: (input) => workflow.recordReviewOnlyStage(input),
        completeReviewOnly: (input) => workflow.completeReviewOnly(input),
        pauseReviewOnly: (input) => workflow.pauseReviewOnly(input),
        failReviewOnly: (runId, error, leaseToken) =>
          workflow.failReviewOnly(runId, error, leaseToken),
      },
    );
    const execution = drainingWorker.runNow(sent.planningRunId);
    await blockingReviewer.started;
    const claimed = await pg.query<{ lease_token: string }>(
      "SELECT lease_token FROM planning_runs WHERE id=$1",
      [sent.planningRunId],
    );
    const oldLease = claimed.rows[0]?.lease_token;
    if (!oldLease) throw new Error("review claim did not acquire a lease");

    await drainingWorker.drain();
    await execution;
    const run = await planningRunRow(sent.planningRunId);
    expect(run).toMatchObject({ status: "queued", lease_token: null, leased_until: null });
    expect((await reviewRow(sent.reviewId)).status).toBe("running");

    await workflow.recordReviewOnlyChatEvent({
      reviewId: sent.reviewId,
      planningRunId: sent.planningRunId,
      leaseToken: oldLease,
      event: {
        request_id: "late-old-claim",
        channel: "reviewer",
        round: 1,
        attempt: 1,
        speaker: "reviewer",
        kind: "response",
        content: '{"findings":[]}',
        error_code: null,
      },
    });
    const evidence = await pg.query<{ chat_messages: Array<{ request_id: string }> }>(
      "SELECT chat_messages FROM conversation_plan_reviews WHERE id=$1",
      [sent.reviewId],
    );
    expect(evidence.rows[0]?.chat_messages).toHaveLength(1);
    expect(
      evidence.rows[0]?.chat_messages.some((message) => message.request_id === "late-old-claim"),
    ).toBe(false);
  });
});
