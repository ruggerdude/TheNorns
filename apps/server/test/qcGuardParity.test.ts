// QCP-R10: parity test between the contract invariants (superRefine rules on
// V2ConversationPlanReview in packages/contracts/src/v2/conversation.ts) and
// the database guards (CHECK constraints + trigger functions on
// conversation_plan_reviews across migrations 0037, 0049, 0064, 0065, 0066,
// 0068, 0074). The two express the same rules independently as defence-in-depth;
// nothing else enforces that they stay in lockstep. For every case below we
// assert the contract and the database AGREE — both accept, or both reject.
//
// Harness copied from qcPauseResume.test.ts's PGlite setup. Unlike that file,
// this one drives status transitions with direct SQL UPDATEs rather than
// through the worker: the target here is the database guards themselves
// (lifecycle-trigger + CHECK), not the application code path that
// qcPauseResume.test.ts already covers. Every transition below still goes
// through a real UPDATE that the `conversation_plan_reviews_lifecycle_guard`
// trigger inspects — a seeded INSERT at a target status would bypass that
// trigger entirely, which is exactly the blind spot this file exists to close.
import { PGlite } from "@electric-sql/pglite";
import {
  V2ConversationPlanReview,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationPlanWorkflowService } from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

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

/** A minimal, otherwise-fully-valid V2ConversationPlanReview object. Used only
 *  for the negative half of a case: when the DB rejects a mutation outright,
 *  there is no persisted row to hand to the app's own row->contract mapper
 *  (`toReview` in planWorkflow.ts), so we build the equivalent shape by hand
 *  and feed it straight to the schema. Positive cases don't need this — they
 *  go through `workflow.detail()`, which calls that exact same mapper on a
 *  real row, so "the contract accepts this" is proven with the app's own
 *  parsing code, not a reimplementation of it. */
const SHA = "a".repeat(64);
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:05:00.000Z";

function baseReviewFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 2,
    id: "review-fixture",
    project_id: "project-fixture",
    work_item_id: "work-fixture",
    conversation_id: "conversation-fixture",
    action_id: "action-fixture",
    plan_version_id: "plan-fixture",
    planning_run_id: "run-fixture",
    initiated_by_user_id: "user-fixture",
    attempt_number: 1,
    pm_provider: "anthropic",
    pm_model: "claude-x",
    reviewer_provider: "openai",
    reviewer_model: "gpt-x",
    usage_request_group_id: "usage-fixture",
    status: "queued",
    qc_mode: "automatic",
    qc_mode_source: "project_default",
    allow_unadjudicated_rebuttals: false,
    human_steered_rounds: [],
    rounds_completed: 0,
    max_rounds: 3,
    round_exchanges: [],
    chat_messages: [],
    markdown_artifacts: [],
    plan_content_hash: SHA,
    result_plan_content_hash: SHA,
    context_manifest: { entries: [], context_hash: SHA },
    findings: [],
    dispositions: [],
    revised_plan_version_id: null,
    paused_checkpoint: null,
    paused_at_round: null,
    started_at: null,
    completed_at: null,
    failure_code: null,
    cancelled_by_user_id: null,
    cancellation_reason: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

/** Fails with a message naming which side accepted and which rejected,
 *  instead of a bare "expected true to be false". */
function expectParity(label: string, dbAccepted: boolean, contractAccepted: boolean): void {
  if (dbAccepted === contractAccepted) return;
  throw new Error(
    `${label}: database ${dbAccepted ? "ACCEPTED" : "REJECTED"} but contract ${contractAccepted ? "ACCEPTED" : "REJECTED"} — the QC guard and the contract invariant have diverged`,
  );
}

async function rejects(action: Promise<unknown>): Promise<boolean> {
  try {
    await action;
    return false;
  } catch {
    return true;
  }
}

describe.sequential("QC guard parity: contract invariants vs. database guards (QCP-R10)", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workflow: ConversationPlanWorkflowService;
  let id = 0;

  const owner = { id: "qc-parity-owner" };
  const projectId = "qc-parity-project";

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'qc-parity-owner', 'qc-parity-owner@example.com', 'Owner',
        'qc-parity-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'qc-parity-project', 'QC Parity', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'qc-parity-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    const makeId = (prefix: string) => `${prefix}-qc-parity-${++id}`;
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: makeId,
    });
    // No worker/adapter wiring: every review below is driven to its target
    // status with a direct UPDATE against conversation_plan_reviews, so the
    // real lifecycle-guard trigger sees it. resolveReviewModels/runReviewNow
    // are never exercised because sendToQc always pins an explicit reviewer.
    workflow = new ConversationPlanWorkflowService(transactions, {
      newId: makeId,
      resolveReviewModels: async () => {
        throw new Error("resolveReviewModels must not be used by an explicit reviewer pin");
      },
      runReviewNow: async () => {},
    });
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

  /** Creates one real conversation_plan_reviews row, at its natural initial
   *  status ('queued') — an INSERT that does not target any later-lifecycle
   *  status, so it does not bypass the lifecycle-guard trigger (that trigger
   *  only fires BEFORE UPDATE; INSERT only ever lands on 'queued' here). */
  async function sendToQc(label: string) {
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
              rounds: 3,
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
      qc_mode: "gated_each_round",
    });
    if (sent.effect.kind !== "qc_started") throw new Error("expected QC effect");
    return {
      ...created,
      scope: {
        projectId,
        workItemId: created.work_item.id,
        conversationId: created.conversation.id,
      },
      reviewId: sent.effect.plan_review.id,
    };
  }

  /** The real row->contract mapper (planWorkflow.ts's `toReview`) runs inside
   *  `detail()` and calls `.parse` (not `.safeParse`) on every review row for
   *  the conversation — so a contract-invalid row makes this reject, and a
   *  contract-valid row comes back parsed for direct assertion. This reuses
   *  the app's exact mapping code instead of a reimplementation of it. */
  async function contractView(scope: {
    projectId: string;
    workItemId: string;
    conversationId: string;
  }) {
    const detail = await workflow.detail(
      owner.id,
      scope.projectId,
      scope.workItemId,
      scope.conversationId,
    );
    return detail.plan_reviews;
  }

  describe("rule 1: timing (conversation_plan_reviews_timing_check)", () => {
    it("queued, running, awaiting_human, and a terminal status: both sides accept", async () => {
      const sent = await sendToQc("timing-ok");

      // queued (the row's natural post-INSERT state).
      let reviews = await contractView(sent.scope);
      let review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.status).toBe("queued");
      expect(review?.started_at).toBeNull();
      expect(review?.completed_at).toBeNull();

      // queued -> running: a real UPDATE the lifecycle trigger governs.
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='running', started_at=$2, updated_at=$2
          WHERE id=$1`,
        [sent.reviewId, T0],
      );
      reviews = await contractView(sent.scope);
      review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.status).toBe("running");
      expect(review?.started_at).not.toBeNull();
      expect(review?.completed_at).toBeNull();

      // running -> awaiting_human: requires started_at set, completed_at null.
      await pg.query(
        `UPDATE conversation_plan_reviews
            SET status='awaiting_human', paused_checkpoint='after_review', paused_at_round=1
          WHERE id=$1`,
        [sent.reviewId],
      );
      reviews = await contractView(sent.scope);
      review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.status).toBe("awaiting_human");
      expect(review?.started_at).not.toBeNull();
      expect(review?.completed_at).toBeNull();

      // awaiting_human -> running (resume) -> converged (a terminal status):
      // started_at and completed_at both set. Resume also clears the paused
      // fields — required by the paused-coupling CHECK (rule 2), not timing.
      await pg.query(
        `UPDATE conversation_plan_reviews
            SET status='running', paused_checkpoint=NULL, paused_at_round=NULL
          WHERE id=$1`,
        [sent.reviewId],
      );
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='converged', completed_at=$2 WHERE id=$1`,
        [sent.reviewId, T1],
      );
      reviews = await contractView(sent.scope);
      review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.status).toBe("converged");
      expect(review?.started_at).not.toBeNull();
      expect(review?.completed_at).not.toBeNull();
    });

    it("queued cannot carry started_at: both sides reject", async () => {
      const sent = await sendToQc("timing-bad-queued");
      const dbAccepted = !(await rejects(
        pg.query("UPDATE conversation_plan_reviews SET started_at=$2 WHERE id=$1", [
          sent.reviewId,
          T0,
        ]),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({ status: "queued", started_at: T0 }),
      ).success;
      expectParity("queued + started_at set", dbAccepted, contractAccepted);
    });

    it("running requires completed_at null: both sides reject when it is set", async () => {
      const sent = await sendToQc("timing-bad-running");
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET status='running', started_at=$2, completed_at=$2
            WHERE id=$1`,
          [sent.reviewId, T0],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({ status: "running", started_at: T0, completed_at: T0 }),
      ).success;
      expectParity("running + completed_at set", dbAccepted, contractAccepted);
    });

    it("awaiting_human requires completed_at null: both sides reject when it is set", async () => {
      const sent = await sendToQc("timing-bad-awaiting");
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
        [sent.reviewId, T0],
      );
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET status='awaiting_human', paused_checkpoint='after_review',
                  paused_at_round=1, completed_at=$2
            WHERE id=$1`,
          [sent.reviewId, T1],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "awaiting_human",
          started_at: T0,
          completed_at: T1,
          paused_checkpoint: "after_review",
          paused_at_round: 1,
        }),
      ).success;
      expectParity("awaiting_human + completed_at set", dbAccepted, contractAccepted);
    });

    it("a terminal status (cancelled) requires completed_at set: both sides reject when missing", async () => {
      const sent = await sendToQc("timing-bad-terminal");
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET status='cancelled', cancelled_by_user_id=$2, cancellation_reason='stopped'
            WHERE id=$1`,
          [sent.reviewId, owner.id],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "cancelled",
          completed_at: null,
          cancelled_by_user_id: owner.id,
          cancellation_reason: "stopped",
        }),
      ).success;
      expectParity("cancelled without completed_at", dbAccepted, contractAccepted);
    });
  });

  describe("rule 2: pause coupling (conversation_plan_reviews_paused_coupling_check)", () => {
    it("awaiting_human with paused_checkpoint and paused_at_round set: both sides accept", async () => {
      const sent = await sendToQc("pause-ok");
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
        [sent.reviewId, T0],
      );
      await pg.query(
        `UPDATE conversation_plan_reviews
            SET status='awaiting_human', paused_checkpoint='after_review', paused_at_round=2
          WHERE id=$1`,
        [sent.reviewId],
      );
      const reviews = await contractView(sent.scope);
      const review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.status).toBe("awaiting_human");
      expect(review?.paused_checkpoint).toBe("after_review");
      expect(review?.paused_at_round).toBe(2);
    });

    it("awaiting_human without paused_checkpoint/paused_at_round: both sides reject", async () => {
      const sent = await sendToQc("pause-bad-missing");
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
        [sent.reviewId, T0],
      );
      const dbAccepted = !(await rejects(
        pg.query(`UPDATE conversation_plan_reviews SET status='awaiting_human' WHERE id=$1`, [
          sent.reviewId,
        ]),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "awaiting_human",
          started_at: T0,
          paused_checkpoint: null,
          paused_at_round: null,
        }),
      ).success;
      expectParity(
        "awaiting_human missing paused_checkpoint/paused_at_round",
        dbAccepted,
        contractAccepted,
      );
    });

    it("paused_checkpoint set while not awaiting_human: both sides reject", async () => {
      const sent = await sendToQc("pause-bad-extra");
      // queued row, status unchanged — only the paused_checkpoint is added.
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET paused_checkpoint='after_review', paused_at_round=1
            WHERE id=$1`,
          [sent.reviewId],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "queued",
          paused_checkpoint: "after_review",
          paused_at_round: 1,
        }),
      ).success;
      expectParity("queued carrying paused_checkpoint", dbAccepted, contractAccepted);
    });

    // QCP-15: paused_at_round <= max_rounds used to be a contract-only rule.
    // max_rounds lives on a different table (planning_runs), so it can't be a
    // CHECK on conversation_plan_reviews — Postgres CHECK constraints can't
    // reference another table's row. 0074_qc_paused_round_bound closes the
    // gap with a constraint trigger that looks up the linked run's max_rounds
    // instead. Both sides now agree.
    it("paused_at_round beyond max_rounds: both sides reject", async () => {
      const sent = await sendToQc("pause-beyond-cap"); // max_rounds=3 (sendToQc default)
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
        [sent.reviewId, T0],
      );
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET status='awaiting_human', paused_checkpoint='after_review', paused_at_round=4
            WHERE id=$1`,
          [sent.reviewId],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "awaiting_human",
          started_at: T0,
          paused_checkpoint: "after_review",
          paused_at_round: 4,
          max_rounds: 3,
        }),
      ).success;
      expectParity("paused_at_round beyond max_rounds", dbAccepted, contractAccepted);
    });
  });

  describe("rule 3: evidence visibility (conversation_plan_reviews_nonterminal_evidence_check)", () => {
    const oneFinding = JSON.stringify([
      {
        id: "finding-1",
        index: 0,
        severity: "must_fix",
        module_id: null,
        finding: "Clarify the objective.",
        recommendation: "State the objective precisely.",
      },
    ]);
    const oneDisposition = JSON.stringify([
      {
        finding_id: "finding-1",
        finding_index: 0,
        disposition: "accept",
        rationale: "Addressed now.",
        adjudication: null,
      },
    ]);

    it("awaiting_human may expose findings and dispositions: both sides accept", async () => {
      const sent = await sendToQc("evidence-paused-ok");
      await pg.query(
        `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
        [sent.reviewId, T0],
      );
      await pg.query(
        `UPDATE conversation_plan_reviews
            SET status='awaiting_human', paused_checkpoint='after_review', paused_at_round=1,
                findings=$2::jsonb, dispositions=$3::jsonb
          WHERE id=$1`,
        [sent.reviewId, oneFinding, oneDisposition],
      );
      const reviews = await contractView(sent.scope);
      const review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.status).toBe("awaiting_human");
      expect(review?.findings).toHaveLength(1);
      expect(review?.dispositions).toHaveLength(1);
    });

    it("running may not expose findings/dispositions: both sides reject", async () => {
      const sent = await sendToQc("evidence-running-bad");
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET status='running', started_at=$2, findings=$3::jsonb, dispositions=$4::jsonb
            WHERE id=$1`,
          [sent.reviewId, T0, oneFinding, oneDisposition],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "running",
          started_at: T0,
          findings: JSON.parse(oneFinding),
          dispositions: JSON.parse(oneDisposition),
        }),
      ).success;
      expectParity("running exposing findings/dispositions", dbAccepted, contractAccepted);
    });

    it("cancelled may not expose findings/dispositions: both sides reject", async () => {
      const sent = await sendToQc("evidence-cancelled-bad");
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET status='cancelled', completed_at=$2, cancelled_by_user_id=$3,
                  cancellation_reason='stopped', findings=$4::jsonb, dispositions=$5::jsonb
            WHERE id=$1`,
          [sent.reviewId, T0, owner.id, oneFinding, oneDisposition],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          status: "cancelled",
          completed_at: T0,
          cancelled_by_user_id: owner.id,
          cancellation_reason: "stopped",
          findings: JSON.parse(oneFinding),
          dispositions: JSON.parse(oneDisposition),
        }),
      ).success;
      expectParity("cancelled exposing findings/dispositions", dbAccepted, contractAccepted);
    });
  });

  describe("rule 4: status domain (conversation_plan_reviews_status_check)", () => {
    it("every contract status value is a legal DB status: both sides accept", async () => {
      // cap_reached needs a disposed must-fix finding to satisfy the
      // contract's separate (not-under-test) "cap_reached retains its
      // must-fix evidence" rule, so it gets one; every other status is
      // reachable from queued with just a status transition.
      const mustFix = JSON.stringify([
        {
          id: "finding-1",
          index: 0,
          severity: "must_fix",
          module_id: null,
          finding: "Clarify the objective.",
          recommendation: "State the objective precisely.",
        },
      ]);
      const disposition = JSON.stringify([
        {
          finding_id: "finding-1",
          finding_index: 0,
          disposition: "accept",
          rationale: "Addressed now.",
          adjudication: null,
        },
      ]);

      const cases: Array<{
        status: string;
        toRunningFirst: boolean;
        sql: string;
        params: unknown[];
      }> = [
        { status: "queued", toRunningFirst: false, sql: "", params: [] },
        {
          status: "running",
          toRunningFirst: false,
          sql: `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
          params: [T0],
        },
        {
          status: "awaiting_human",
          toRunningFirst: true,
          sql: `UPDATE conversation_plan_reviews
                  SET status='awaiting_human', paused_checkpoint='after_review', paused_at_round=1
                WHERE id=$1`,
          params: [],
        },
        {
          status: "converged",
          toRunningFirst: true,
          sql: `UPDATE conversation_plan_reviews SET status='converged', completed_at=$2 WHERE id=$1`,
          params: [T1],
        },
        {
          status: "cap_reached",
          toRunningFirst: true,
          sql: `UPDATE conversation_plan_reviews
                  SET status='cap_reached', completed_at=$2, findings=$3::jsonb, dispositions=$4::jsonb
                WHERE id=$1`,
          params: [T1, mustFix, disposition],
        },
        {
          status: "failed",
          toRunningFirst: false,
          sql: `UPDATE conversation_plan_reviews
                  SET status='failed', completed_at=$2, failure_code='boom'
                WHERE id=$1`,
          params: [T0],
        },
        {
          status: "cancelled",
          toRunningFirst: false,
          sql: `UPDATE conversation_plan_reviews
                  SET status='cancelled', completed_at=$2, cancelled_by_user_id=$3,
                      cancellation_reason='stopped'
                WHERE id=$1`,
          params: [T0, owner.id],
        },
      ];

      for (const testCase of cases) {
        const sent = await sendToQc(`domain-${testCase.status}`);
        if (testCase.toRunningFirst) {
          await pg.query(
            `UPDATE conversation_plan_reviews SET status='running', started_at=$2 WHERE id=$1`,
            [sent.reviewId, T0],
          );
        }
        if (testCase.sql) {
          await pg.query(testCase.sql, [sent.reviewId, ...testCase.params]);
        }
        const reviews = await contractView(sent.scope);
        const review = reviews.find((entry) => entry.id === sent.reviewId);
        expect(
          review?.status,
          `status "${testCase.status}" should round-trip through the contract`,
        ).toBe(testCase.status);
      }
    });

    it("a bogus status is rejected by both sides", async () => {
      const sent = await sendToQc("domain-bogus");
      const dbAccepted = !(await rejects(
        pg.query(`UPDATE conversation_plan_reviews SET status='not_a_real_status' WHERE id=$1`, [
          sent.reviewId,
        ]),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({ status: "not_a_real_status" }),
      ).success;
      expectParity("bogus status value", dbAccepted, contractAccepted);
    });
  });

  // QCP-9: qc_mode_changed_at_round/qc_mode_changed_by_user_id are coupled to
  // qc_mode_source='in_run' the same way paused_checkpoint/paused_at_round are
  // coupled to status='awaiting_human' (rule 2 above) — same-table columns,
  // so (unlike paused_at_round <= max_rounds) this one CAN be a database
  // CHECK (conversation_plan_reviews_qc_mode_provenance_check), not just a
  // contract-only rule.
  describe("rule 5: qc_mode provenance coupling (conversation_plan_reviews_qc_mode_provenance_check)", () => {
    it("in_run with both provenance fields set: both sides accept", async () => {
      const sent = await sendToQc("provenance-ok");
      await pg.query(
        `UPDATE conversation_plan_reviews
            SET qc_mode_source='in_run', qc_mode_changed_at_round=1,
                qc_mode_changed_by_user_id=$2
          WHERE id=$1`,
        [sent.reviewId, owner.id],
      );
      const reviews = await contractView(sent.scope);
      const review = reviews.find((entry) => entry.id === sent.reviewId);
      expect(review?.qc_mode_source).toBe("in_run");
      expect(review?.qc_mode_changed_at_round).toBe(1);
      expect(review?.qc_mode_changed_by_user_id).toBe(owner.id);
    });

    it("in_run without provenance fields: both sides reject", async () => {
      const sent = await sendToQc("provenance-bad-missing");
      const dbAccepted = !(await rejects(
        pg.query(`UPDATE conversation_plan_reviews SET qc_mode_source='in_run' WHERE id=$1`, [
          sent.reviewId,
        ]),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          qc_mode_source: "in_run",
          qc_mode_changed_at_round: null,
          qc_mode_changed_by_user_id: null,
        }),
      ).success;
      expectParity("in_run missing provenance", dbAccepted, contractAccepted);
    });

    it("provenance fields set while not in_run: both sides reject", async () => {
      const sent = await sendToQc("provenance-bad-extra");
      // sendToQc pins qc_mode explicitly, so qc_mode_source is 'work_item'
      // here, not 'in_run' — only the provenance columns are added.
      const dbAccepted = !(await rejects(
        pg.query(
          `UPDATE conversation_plan_reviews
              SET qc_mode_changed_at_round=1, qc_mode_changed_by_user_id=$2
            WHERE id=$1`,
          [sent.reviewId, owner.id],
        ),
      ));
      const contractAccepted = V2ConversationPlanReview.safeParse(
        baseReviewFixture({
          qc_mode_source: "work_item",
          qc_mode_changed_at_round: 1,
          qc_mode_changed_by_user_id: owner.id,
        }),
      ).success;
      expectParity("provenance set without in_run", dbAccepted, contractAccepted);
    });
  });
});
