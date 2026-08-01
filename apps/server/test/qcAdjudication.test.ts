// QCP-3A: adjudication rulings and mid-flight mutability (QC-PAUSE-POINTS.md
// "Adjudication: unresolved must-fix rebuttals" and "Mutability mid-flight").
// Same harness style as qcPauseResume.test.ts: every status change is driven
// through the real worker/workflow UPDATE path against a PGlite-backed
// schema, never a seeded row, so the migration 0067 columns and the DB guard
// trigger are exercised for real.
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

const rebuttableMustFix = {
  severity: "must_fix" as const,
  module_id: "workflow",
  finding: "Clarify the objective.",
  recommendation: "State the objective precisely.",
};

describe.sequential("QC adjudication (QCP-3A)", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workflow: ConversationPlanWorkflowService;
  let worker: PlanningRunWorker;
  let pm: FakeAdapter;
  let reviewerV1: FakeAdapter;
  let chatAdapter: FakeAdapter;
  let dispatchCount = 0;
  let id = 0;

  const owner = { id: "qc-adj-owner" };
  const projectId = "qc-adj-project";

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'qc-adj-owner', 'qc-adj-owner@example.com', 'Owner',
        'qc-adj-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'qc-adj-project', 'QC Adjudication', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'qc-adj-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    dispatchCount = 0;
    const makeId = (prefix: string) => `${prefix}-qc-adj-${++id}`;
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: makeId,
    });
    pm = new FakeAdapter("anthropic", "claude-sonnet-5");
    reviewerV1 = new FakeAdapter("openai", "gpt-5.6-sol");
    chatAdapter = new FakeAdapter("openai", "gpt-5.6-sol");
    workflow = new ConversationPlanWorkflowService(transactions, {
      newId: makeId,
      resolveReviewModels: async () => {
        throw new Error("resolveReviewModels must not be used by an explicit reviewer pin");
      },
      runReviewNow: async () => {
        dispatchCount += 1;
      },
      cancelReviewNow: (runId) => worker.cancelReview(runId),
      // A "question" at a gate goes through continueReviewChat's live model
      // call; only the reviewer channel is exercised below.
      createReviewAdapter: () => chatAdapter,
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
    dispatchCount = 0; // isolate ruling/resume dispatch counts from kickoff's own dispatch
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
      max_rounds: number;
      findings: Array<{ id: string; module_id: string | null; severity: string }>;
      dispositions: Array<{
        finding_id: string;
        finding_index: number;
        disposition: string;
        rationale: string;
        adjudication: { ruling: string; decided_by_user_id: string } | null;
      }>;
      chat_messages: unknown[];
    }>(
      `SELECT review.status, review.paused_checkpoint, review.paused_at_round,
              run.round AS rounds_completed, run.max_rounds AS max_rounds,
              review.findings, review.dispositions, review.chat_messages
         FROM conversation_plan_reviews review
         JOIN planning_runs run ON run.id = review.planning_run_id
        WHERE review.id = $1`,
      [reviewId],
    );
    const row = rows.rows[0];
    if (!row) throw new Error(`review "${reviewId}" not found`);
    return row;
  }

  async function planningRunStatus(planningRunId: string) {
    const rows = await pg.query<{ status: string }>(
      "SELECT status FROM planning_runs WHERE id = $1",
      [planningRunId],
    );
    return rows.rows[0]?.status;
  }

  it("a question at a live gate is answered in place and does not advance the run", async () => {
    const sent = await sendToQc("question");
    reviewerV1.enqueue({ findings: [rebuttableMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "The finding is wrong." }],
      plan: sent.envelope,
    });
    await worker.runNow(sent.planningRunId);
    const parked = await reviewRow(sent.reviewId);
    expect(parked.status).toBe("awaiting_human");
    expect(parked.paused_checkpoint).toBe("adjudication");
    const chatMessagesBefore = parked.chat_messages.length;

    chatAdapter.enqueue("Because the reviewer read the module description literally.");
    const answered = await workflow.continueReviewChat(
      owner.id,
      sent.scope,
      sent.reviewId,
      "reviewer",
      "Why is finding 1 a must-fix?",
    );

    expect(answered.status).toBe("awaiting_human");
    expect(answered.paused_checkpoint).toBe("adjudication");
    expect(dispatchCount).toBe(0);
    expect(await planningRunStatus(sent.planningRunId)).toBe("awaiting_human");
    const stillParked = await reviewRow(sent.reviewId);
    // Exactly the human instruction + the reviewer's answer were appended —
    // the round's own automatic reviewer/PM chat events are unaffected.
    expect(stillParked.chat_messages).toHaveLength(chatMessagesBefore + 2);
  });

  it("rule-for-reviewer forces a revision pass and blocks re-rebuttal on recurrence", async () => {
    const sent = await sendToQc("rule-reviewer", 2);
    reviewerV1.enqueue({ findings: [rebuttableMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "The finding is wrong." }],
      plan: sent.envelope,
    });
    await worker.runNow(sent.planningRunId);
    const parked = await reviewRow(sent.reviewId);
    expect(parked.paused_checkpoint).toBe("adjudication");
    const findingId = parked.findings[0]?.id;
    if (!findingId) throw new Error("expected a pending finding");

    const ruled = await workflow.adjudicateReview(owner.id, sent.scope, sent.reviewId, {
      rulings: { [findingId]: { ruling: "reviewer", rationale: "The code does require this." } },
    });
    expect(ruled.status).toBe("awaiting_human");
    expect(dispatchCount).toBe(1);

    // Round 2: reviewer raises another must_fix against the same module — the
    // dumb same-module match — and the PM tries to rebut it again.
    reviewerV1.enqueue({
      findings: [
        {
          severity: "must_fix",
          module_id: "workflow",
          finding: "The objective is still unclear.",
          recommendation: "State it precisely.",
        },
      ],
    });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "Still disagree." }],
      plan: sent.envelope, // unchanged — would ordinarily be hollow acceptance too
    });
    await worker.runNow(sent.planningRunId);

    const afterRound2 = await reviewRow(sent.reviewId);
    // Never re-adjudicated: the module was excluded from Gate C entirely, so
    // round 2 (the configured round cap) reaches its ordinary cap_reached
    // terminal instead of pausing on the PM's repeat rebuttal.
    expect(afterRound2.status).toBe("cap_reached");
    expect(afterRound2.paused_checkpoint).not.toBe("adjudication");
    expect(afterRound2.dispositions).toHaveLength(2);
    expect(afterRound2.dispositions[0]?.adjudication).toMatchObject({ ruling: "reviewer" });
    // Honest recording (QC-PAUSE-POINTS.md "Outcomes"): the PM's round-2
    // rebuttal is preserved verbatim rather than rewritten to read as its own
    // acceptance. The standing ruling is still visible on the record — it's
    // attached to this recurrence by module_id, not synthesized as agent text.
    expect(afterRound2.dispositions[1]?.disposition).toBe("rebut");
    expect(afterRound2.dispositions[1]?.rationale).toBe("Still disagree.");
    expect(afterRound2.dispositions[1]?.adjudication).toMatchObject({
      ruling: "reviewer",
      decided_by_user_id: owner.id,
    });
  });

  it("rule-for-pm closes the finding as human-dismissed and it does not re-block", async () => {
    const sent = await sendToQc("rule-pm");
    reviewerV1.enqueue({ findings: [rebuttableMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "The finding is wrong." }],
      plan: sent.envelope,
    });
    await worker.runNow(sent.planningRunId);
    const parked = await reviewRow(sent.reviewId);
    const findingId = parked.findings[0]?.id;
    if (!findingId) throw new Error("expected a pending finding");

    await workflow.adjudicateReview(owner.id, sent.scope, sent.reviewId, {
      rulings: { [findingId]: { ruling: "pm", rationale: "The rebuttal is correct." } },
    });

    reviewerV1.enqueue({ findings: [] }); // round 2 converges cleanly
    await worker.runNow(sent.planningRunId);

    const finalReview = await reviewRow(sent.reviewId);
    expect(finalReview.status).toBe("converged");
    expect(finalReview.dispositions).toHaveLength(1);
    expect(finalReview.dispositions[0]?.adjudication).toMatchObject({ ruling: "pm" });
  });

  it("offers a cap-raise-by-one when rule-for-reviewer lands at the round cap", async () => {
    const sent = await sendToQc("cap-raise", 1);
    reviewerV1.enqueue({ findings: [rebuttableMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "rebut", rationale: "The finding is wrong." }],
      plan: sent.envelope,
    });
    await worker.runNow(sent.planningRunId);
    const parked = await reviewRow(sent.reviewId);
    expect(parked.rounds_completed).toBe(1);
    expect(parked.max_rounds).toBe(1);
    const findingId = parked.findings[0]?.id;
    if (!findingId) throw new Error("expected a pending finding");

    await expect(
      workflow.adjudicateReview(owner.id, sent.scope, sent.reviewId, {
        rulings: { [findingId]: { ruling: "reviewer", rationale: "Stands." } },
      }),
    ).rejects.toMatchObject({ code: "round_cap_requires_raise" });
    expect(dispatchCount).toBe(0);

    await workflow.adjudicateReview(owner.id, sent.scope, sent.reviewId, {
      rulings: { [findingId]: { ruling: "reviewer", rationale: "Stands." } },
      raiseMaxRounds: true,
    });
    expect((await reviewRow(sent.reviewId)).max_rounds).toBe(2);

    reviewerV1.enqueue({ findings: [] });
    await worker.runNow(sent.planningRunId);
    const finalReview = await reviewRow(sent.reviewId);
    expect(finalReview.status).toBe("converged");
    expect(finalReview.rounds_completed).toBeLessThanOrEqual(finalReview.max_rounds);
  });

  it("max_rounds can be raised freely but not lowered to or below rounds_completed", async () => {
    const sent = await sendToQc("mutability", 3);
    await pg.query("UPDATE conversation_plan_reviews SET qc_mode='gated_each_round' WHERE id=$1", [
      sent.reviewId,
    ]);
    reviewerV1.enqueue({ findings: [rebuttableMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Addressed now." }],
      plan: plan(
        "Objective mutability",
        "Deliver the durable workflow, now with the objective clarified.",
      ),
    });
    await worker.runNow(sent.planningRunId);
    const parked = await reviewRow(sent.reviewId);
    expect(parked.status).toBe("awaiting_human");
    expect(parked.rounds_completed).toBe(1);

    await expect(
      workflow.patchReview(owner.id, sent.scope, sent.reviewId, { maxRounds: 1 }),
    ).rejects.toMatchObject({ code: "invalid_plan_state" });

    const raised = await workflow.patchReview(owner.id, sent.scope, sent.reviewId, {
      maxRounds: 2,
    });
    expect(raised.max_rounds).toBe(2);

    const modeChanged = await workflow.patchReview(owner.id, sent.scope, sent.reviewId, {
      qcMode: "automatic",
    });
    expect(modeChanged.qc_mode).toBe("automatic");
    expect(modeChanged.qc_mode_source).toBe("in_run");
  });

  it('"Continue, and stop asking" resumes and sets qc_mode to automatic in one call', async () => {
    const sent = await sendToQc("stop-asking", 3);
    await pg.query("UPDATE conversation_plan_reviews SET qc_mode='gated_each_round' WHERE id=$1", [
      sent.reviewId,
    ]);
    reviewerV1.enqueue({ findings: [rebuttableMustFix] });
    pm.enqueue({
      responses: [{ finding_index: 0, disposition: "accept", rationale: "Addressed now." }],
      plan: plan(
        "Objective stop-asking",
        "Deliver the durable workflow, now with the objective clarified.",
      ),
    });
    await worker.runNow(sent.planningRunId);
    expect((await reviewRow(sent.reviewId)).status).toBe("awaiting_human");

    reviewerV1.enqueue({ findings: [] });
    const resumed = await workflow.resumeReview(owner.id, sent.scope, sent.reviewId, {
      exit: "continue",
      stopAsking: true,
    });
    expect(resumed.qc_mode).toBe("automatic");
    expect(resumed.qc_mode_source).toBe("in_run");
    expect(dispatchCount).toBe(1);

    await worker.runNow(sent.planningRunId);
    const finalReview = await reviewRow(sent.reviewId);
    // Converged straight through round 2 with no further gate stop — proof
    // qc_mode actually took effect rather than just being recorded.
    expect(finalReview.status).toBe("converged");
  });
});
