// QCP-6 / QCP-R9: "Accept now" at Gate A.
//
// When a review parks at Gate A (paused_checkpoint === 'after_review') the
// PM has never revised the plan, so continueWithoutQc()'s target
// (review.revised_plan_version_id ?? review.plan_version_id) falls back to
// the original seed version — whose work_plan_versions.status is still
// 'in_qc' (pauseReviewOnly does not revert it; only
// completeReviewOnly/cancelReview/failReviewOnly do).
//
// QCP-R9's root-cause fix: the seed version being 'in_qc' here is not a
// stale-state error, it is exactly the plan a skip_qc waiver is meant to
// accept. send_plan_to_qc's boundLatestPlan call now only demands
// 'candidate' for non-waiver sends; the skip_qc path accepts a 'candidate'
// or 'in_qc' seed directly, with no revert step and no DB trigger exception
// for the transition that never happens.
//
// Drives the real PlanningRunWorker + ConversationPlanWorkflowService +
// FakeAdapter stack against a PGlite-backed schema so every status
// transition goes through the production UPDATE statements, never a seeded
// row. Harness copied from qcPauseResume.test.ts.
import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter, type ProviderName } from "@norns/adapters";
import { V2WorkPlanContract, type V2WorkPlanContractT } from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationPlanWorkflowService } from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
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

describe.sequential("QC accept-now at Gate A (QCP-6)", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workflow: ConversationPlanWorkflowService;
  let worker: PlanningRunWorker;
  let pm: FakeAdapter;
  let reviewerV1: FakeAdapter;
  let id = 0;

  const owner = { id: "qc-accept-owner" };
  const projectId = "qc-accept-project";

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'qc-accept-owner', 'qc-accept-owner@example.com', 'Owner',
        'qc-accept-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'qc-accept-project', 'QC Accept', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'qc-accept-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    const makeId = (prefix: string) => `${prefix}-qc-accept-${++id}`;
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: makeId,
    });
    pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    reviewerV1 = new FakeAdapter("openai", "gpt-5.6-sol");
    workflow = new ConversationPlanWorkflowService(transactions, {
      newId: makeId,
      resolveReviewModels: async () => {
        throw new Error("resolveReviewModels must not be used by an explicit reviewer pin");
      },
      runReviewNow: async () => {},
      cancelReviewNow: (runId) => worker.cancelReview(runId),
    });
    worker = new PlanningRunWorker(
      transactions,
      (provider: ProviderName): LlmAdapter => (provider === "anthropic" ? pm : reviewerV1),
      {
        resolveModels: async () => {
          throw new Error("resolveModels must not be called for review-only mode");
        },
        loadReviewOnlySeed: (runId) => workflow.loadReviewOnlySeed(runId),
        markReviewOnlyStarted: (reviewId) => workflow.markReviewOnlyStarted(reviewId),
        recordReviewOnlyProgress: (input) => workflow.recordReviewOnlyProgress(input),
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

  async function sendToQc(label: string, maxRounds = 3) {
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
      revised_plan_version_id: string | null;
      plan_version_id: string;
    }>(
      `SELECT status, paused_checkpoint, revised_plan_version_id, plan_version_id
         FROM conversation_plan_reviews WHERE id = $1`,
      [reviewId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`review "${reviewId}" not found`);
    return row;
  }

  async function planVersionStatus(planVersionId: string) {
    const rows = await pg.query<{ status: string }>(
      "SELECT status FROM work_plan_versions WHERE id = $1",
      [planVersionId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`plan version "${planVersionId}" not found`);
    return row.status;
  }

  async function planVersionContentHash(planVersionId: string) {
    const rows = await pg.query<{ content_hash: string }>(
      "SELECT content_hash FROM work_plan_versions WHERE id = $1",
      [planVersionId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`plan version "${planVersionId}" not found`);
    return row.content_hash;
  }

  /** Gate A ("after_review"): the review parks after the reviewer's pass,
   *  before the PM ever revises anything, so no revised_plan_version_id
   *  exists yet. qc_mode is set directly on the row (configuration, not a
   *  status transition); the park itself happens through the real worker. */
  async function parkAtGateA(label: string) {
    const sent = await sendToQc(label);
    await pg.query("UPDATE conversation_plan_reviews SET qc_mode='gated_each_step' WHERE id=$1", [
      sent.reviewId,
    ]);
    reviewerV1.enqueue({ findings: [hollowMustFix] });

    const outcome = await worker.runNow(sent.planningRunId);
    expect(outcome).toBe("processed");

    const parked = await reviewRow(sent.reviewId);
    expect(parked.status).toBe("awaiting_human");
    expect(parked.paused_checkpoint).toBe("after_review");
    expect(parked.revised_plan_version_id).toBeNull();

    // Root cause: pauseReviewOnly never reverts the seed plan version's
    // status out of 'in_qc', so the version continueWithoutQc falls back to
    // (plan_version_id, since revised_plan_version_id is null) is not
    // 'candidate' when the skip_qc handler demands it.
    expect(await planVersionStatus(parked.plan_version_id)).toBe("in_qc");

    return { sent, parked };
  }

  it("(a) documents the cause: seed plan version is still 'in_qc' when Gate A parks", async () => {
    await parkAtGateA("gatea-cause");
  });

  it("(b) accept-now on a Gate A park no longer throws invalid_plan_state", async () => {
    const { sent, parked } = await parkAtGateA("gatea-throws");

    // Previously: code "invalid_plan_state", message
    // `plan ${plan_version_id} is in_qc, expected candidate` — NOT
    // "plan_not_reviewed". boundLatestPlan's ternary
    // (expectedStatus === "in_qc" ? "plan_not_reviewed" : "invalid_plan_state")
    // only yields plan_not_reviewed when expectedStatus itself is "in_qc";
    // the send_plan_to_qc/skip_qc handler used to call boundLatestPlan with
    // expectedStatus "candidate" unconditionally, so this path always threw
    // invalid_plan_state instead. Root-cause fixed at that call site: the
    // skip_qc confirm now accepts the seed version's real 'in_qc' status
    // directly, so it is never reverted and stays 'in_qc' afterward — the
    // same state a plan is left in after an ordinary (non-waived) QC review
    // converges, pending an explicit approve_plan.
    await expect(
      workflow.continueWithoutQc(owner.id, sent.scope, sent.reviewId, "accept-now-gatea"),
    ).resolves.toMatchObject({ effect: { kind: "qc_started" } });
    expect(await planVersionStatus(parked.plan_version_id)).toBe("in_qc");
  });

  it("(c) accept-now succeeds and carries the seed plan into the skip_qc flow", async () => {
    const { sent, parked } = await parkAtGateA("gatea-fixed");

    const result = await workflow.continueWithoutQc(
      owner.id,
      sent.scope,
      sent.reviewId,
      "accept-now-gatea",
    );
    expect(result.effect.kind).toBe("qc_started");
    expect(await planVersionStatus(parked.plan_version_id)).toBe("in_qc");
  });

  it("(d) a non-waiver send_plan_to_qc still rejects a non-candidate version", async () => {
    const { sent, parked } = await parkAtGateA("gatea-scoped");

    // The skip_qc loosening is scoped: a plain "qc" mode send against the
    // same still-'in_qc' seed version must still be rejected exactly as it
    // was before this fix — only the skip_qc confirm path accepts 'in_qc'.
    const proposed = await conversations.proposeAction(owner, {
      project_id: sent.scope.projectId,
      work_item_id: sent.scope.workItemId,
      conversation_id: sent.scope.conversationId,
      source_message_id: sent.message.id,
      action_type: "send_plan_to_qc",
      payload: {
        parameters: {
          plan_version_id: parked.plan_version_id,
          content_hash: await planVersionContentHash(parked.plan_version_id),
          review: {
            mode: "qc",
            reviewer: { provider: "openai", model: "gpt-5.6-sol" },
            rounds: 3,
          },
        },
      },
    });

    await expect(
      workflow.confirm(owner.id, {
        project_id: sent.scope.projectId,
        work_item_id: sent.scope.workItemId,
        conversation_id: sent.scope.conversationId,
        action_id: proposed.id,
        idempotency_key: "resend-gatea-scoped",
      }),
    ).rejects.toMatchObject({
      code: "invalid_plan_state",
      message: expect.stringContaining("expected candidate"),
    });
    expect(await planVersionStatus(parked.plan_version_id)).toBe("in_qc");
  });
});
