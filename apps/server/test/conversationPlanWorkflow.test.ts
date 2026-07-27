import { PGlite } from "@electric-sql/pglite";
import { V2WorkPlanContract } from "@norns/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationPlanChangeProposalService } from "../src/conversations/planChangeProposal.js";
import { ConversationPlanWorkflowService } from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

function plan(objective = "Ship the conversation plan workflow") {
  return V2WorkPlanContract.parse({
    plan: {
      objective,
      assumptions: ["The existing execution bridge remains authoritative."],
      modules: [
        {
          id: "workflow",
          title: "Workflow",
          description: "Deliver the explicit planning action workflow.",
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

describe.sequential("conversation plan workflow", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workflow: ConversationPlanWorkflowService;
  let changes: ConversationPlanChangeProposalService;
  let id = 0;

  const owner = { id: "plan-workflow-owner" };
  const projectId = "plan-workflow-project";

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(asMigrationDatabase(pg));
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'plan-workflow-owner', 'plan-workflow-owner@example.com', 'Owner',
        'plan-workflow-owner@example.com', 'Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'plan-workflow-project', 'Plan Workflow', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'plan-workflow-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    const makeId = (prefix: string) => `${prefix}-plan-workflow-${++id}`;
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: makeId,
    });
    workflow = new ConversationPlanWorkflowService(transactions, {
      newId: makeId,
      resolveReviewModels: async (_projectId, pm) => ({
        pm,
        reviewer: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      runReviewNow: async () => "processed",
    });
    changes = new ConversationPlanChangeProposalService(transactions, workflow, makeId);
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  async function workspace(label: string) {
    const created = await conversations.createPlanningWorkspace(
      owner,
      {
        project_id: projectId,
        title: `Work ${label}`,
        objective: `Objective ${label}`,
      },
      { provider: "anthropic", model: "claude-fable-5" },
    );
    const message = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      client_message_id: `client-${label}`,
      parts: [
        {
          type: "text",
          format: "markdown",
          text: `brainstorm filler ${label} must not enter isolated QC`,
        },
      ],
    });
    return { ...created, message };
  }

  async function saveCandidate(label: string) {
    const created = await workspace(label);
    const envelope = plan();
    const action = await conversations.proposeAction(owner, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      source_message_id: created.message.id,
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: envelope,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
          referenced_artifacts: [],
        },
      },
    });
    const response = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: action.id,
      idempotency_key: `save-${label}`,
    });
    if (response.effect.kind !== "plan_saved") {
      throw new Error("expected plan_saved effect");
    }
    return {
      ...created,
      envelope,
      version: response.effect.plan_version,
    };
  }

  it("saves, isolates QC, exposes reviewed actions, and approves exactly once", async () => {
    const saved = await saveCandidate("happy");
    let detail = await workflow.detail(
      owner.id,
      projectId,
      saved.work_item.id,
      saved.conversation.id,
    );
    expect(detail.actions.some((action) => action.action_type === "request_plan_changes")).toBe(
      false,
    );
    const send = detail.actions.find(
      (action) => action.action_type === "send_plan_to_qc" && action.status === "proposed",
    );
    if (!send) throw new Error("save must emit a send-to-QC action");
    const sent = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: saved.work_item.id,
      conversation_id: saved.conversation.id,
      action_id: send.id,
      idempotency_key: "send-happy",
    });
    expect(sent.effect.kind).toBe("qc_started");
    if (sent.effect.kind !== "qc_started") throw new Error("expected QC effect");
    const seed = await workflow.loadReviewOnlySeed(sent.effect.planning_run_id);
    expect(seed.seedPlan).toEqual(saved.envelope);
    expect(JSON.stringify(seed.frozenContext)).not.toContain("brainstorm filler happy");
    await workflow.markReviewOnlyStarted(seed.reviewId);
    await workflow.completeReviewOnly({
      reviewId: seed.reviewId,
      planningRunId: sent.effect.planning_run_id,
      totalCostUsd: 0.25,
      result: {
        status: "converged",
        rounds: 1,
        seed_plan: saved.envelope,
        final_plan: saved.envelope,
        result_plan_content_hash: canonicalSha256(saved.envelope),
        review_rounds: [
          {
            round: 1,
            reviewed_plan: saved.envelope,
            findings: [],
            responses: null,
          },
        ],
        usage: [],
      },
    });
    detail = await workflow.detail(owner.id, projectId, saved.work_item.id, saved.conversation.id);
    const approve = detail.actions.find(
      (action) => action.action_type === "approve_plan" && action.status === "proposed",
    );
    if (!approve) throw new Error("successful QC must emit approval");
    const confirmation = {
      project_id: projectId,
      work_item_id: saved.work_item.id,
      conversation_id: saved.conversation.id,
      action_id: approve.id,
      idempotency_key: "approve-happy",
    };
    const approved = await workflow.confirm(owner.id, confirmation);
    const replay = await workflow.confirm(owner.id, confirmation);
    expect(approved).toEqual(replay);
    expect(approved.effect.kind).toBe("plan_approved");
    if (approved.effect.kind === "plan_approved") {
      expect(approved.effect.execution.status).toBe("refused");
      expect(approved.effect.execution.started).toBe(false);
    }
    const work = await pg.query<{
      status: string;
      approved_plan_version_id: string | null;
    }>("SELECT status, approved_plan_version_id FROM work_items WHERE id=$1", [saved.work_item.id]);
    expect(work.rows[0]).toEqual({
      status: "awaiting_approval",
      approved_plan_version_id: saved.version.id,
    });
  });

  it("persists an exact human change intent idempotently and mutates only on confirmation", async () => {
    const saved = await saveCandidate("changes");
    const request = {
      idempotency_key: "change-intent-1",
      plan_version_id: saved.version.id,
      plan_hash: saved.version.content_hash,
      direction: "Split verification into migration and authorization evidence.",
    };
    const proposed = await changes.propose(
      owner.id,
      projectId,
      saved.work_item.id,
      saved.conversation.id,
      request,
    );
    const replay = await changes.propose(
      owner.id,
      projectId,
      saved.work_item.id,
      saved.conversation.id,
      request,
    );
    expect(replay).toEqual(proposed);
    expect(proposed.message.actor).toEqual({ actor_type: "human", actor_id: owner.id });
    expect(proposed.action.payload.parameters.direction).toBe(request.direction);
    expect(proposed.action.status).toBe("proposed");
    const before = await workflow.detail(
      owner.id,
      projectId,
      saved.work_item.id,
      saved.conversation.id,
    );
    expect(before.plan_versions.at(-1)?.status).toBe("candidate");

    const confirmed = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: saved.work_item.id,
      conversation_id: saved.conversation.id,
      action_id: proposed.action.id,
      idempotency_key: "confirm-change-intent-1",
    });
    expect(confirmed.effect.kind).toBe("changes_requested");
    const after = await workflow.detail(
      owner.id,
      projectId,
      saved.work_item.id,
      saved.conversation.id,
    );
    expect(after.plan_versions.at(-1)?.status).toBe("changes_requested");
  });

  it("settles review failure, action failure, plan state, and work state atomically", async () => {
    const saved = await saveCandidate("failure");
    const detail = await workflow.detail(
      owner.id,
      projectId,
      saved.work_item.id,
      saved.conversation.id,
    );
    const send = detail.actions.find(
      (action) => action.action_type === "send_plan_to_qc" && action.status === "proposed",
    );
    if (!send) throw new Error("save must emit a send-to-QC action");
    const sent = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: saved.work_item.id,
      conversation_id: saved.conversation.id,
      action_id: send.id,
      idempotency_key: "send-failure",
    });
    if (sent.effect.kind !== "qc_started") throw new Error("expected QC effect");
    await workflow.markReviewOnlyStarted(sent.effect.plan_review.id);
    await workflow.failReviewOnly(sent.effect.planning_run_id, new Error("provider unavailable"));

    const rows = await pg.query<{
      run_status: string;
      review_status: string;
      action_status: string;
      plan_status: string;
      work_status: string;
    }>(
      `SELECT run.status AS run_status, review.status AS review_status,
              action.status AS action_status, version.status AS plan_status,
              item.status AS work_status
         FROM conversation_plan_reviews review
         JOIN planning_runs run ON run.id=review.planning_run_id
         JOIN conversation_actions action ON action.id=review.action_id
         JOIN work_plan_versions version ON version.id=review.plan_version_id
         JOIN work_items item ON item.id=review.work_item_id
        WHERE review.id=$1`,
      [sent.effect.plan_review.id],
    );
    expect(rows.rows[0]).toEqual({
      run_status: "failed",
      review_status: "failed",
      action_status: "failed",
      plan_status: "candidate",
      work_status: "planning",
    });
  });
});
