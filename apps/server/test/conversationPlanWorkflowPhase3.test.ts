import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter } from "@norns/adapters";
import {
  type V2ConversationActionT,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
} from "@norns/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import { ConversationPlanChangeProposalService } from "../src/conversations/planChangeProposal.js";
import { ConversationPlanProposalService } from "../src/conversations/planProposal.js";
import {
  type ConversationPlanReviewModels,
  ConversationPlanWorkflowService,
} from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import type { ReviewOnlyPlanningResult } from "../src/planning/reviewOnlySession.js";
import type { ApprovedPlanExecutionKickoffInput } from "../src/planning/runService.js";

const projectId = "conversation-plan-project";
const owner = { id: "conversation-plan-owner" };
const member = { id: "conversation-plan-member" };

function plan(objective = "Deliver the persistent planning conversation"): V2WorkPlanContractT {
  return V2WorkPlanContract.parse({
    plan: {
      objective,
      assumptions: ["The existing coordinator remains authoritative."],
      modules: [
        {
          id: "conversation-api",
          title: "Conversation planning API",
          description: "Persist plan candidates and explicit workflow actions.",
          deliverables: ["apps/server/src/conversations"],
          acceptance: [
            {
              id: "AC-1",
              statement: "The exact immutable plan passes through QC and approval.",
              verification_type: "test",
              verification: "pnpm --filter @norns/server test",
            },
          ],
          dependencies: [],
          estimated_complexity: "M",
          risk: "medium",
        },
      ],
      risks: [
        {
          description: "A stale action could mutate the wrong plan.",
          mitigation: "Bind every action to the exact plan version and content hash.",
        },
      ],
      out_of_scope: ["Replaying the full planning transcript into execution."],
    },
    staffing: [
      {
        module_id: "conversation-api",
        agent_role: "implementation",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    ],
    verification_requirements: ["pnpm --filter @norns/server test"],
    open_decisions: ["Confirm the deployment window."],
    estimated_budget: { currency: "USD", amount: 24 },
  });
}

describe.sequential("conversation-first Phase 3 plan workflow", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let workflow: ConversationPlanWorkflowService;
  let proposals: ConversationPlanProposalService;
  let changes: ConversationPlanChangeProposalService;
  let proposalAdapter: LlmAdapter;
  let idSequence = 0;
  let dispatches: string[];
  let kickoffInputs: ApprovedPlanExecutionKickoffInput[];
  let kickoff: (
    input: ApprovedPlanExecutionKickoffInput,
  ) => Promise<{ started: boolean; detail: string }>;

  const newId = (prefix: string): string => `${prefix}-phase3-${++idSequence}`;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES
        (
          'conversation-plan-owner', 'conversation-plan-owner@example.com', 'Plan Owner',
          'conversation-plan-owner@example.com', 'Plan Owner', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          'conversation-plan-member', 'conversation-plan-member@example.com', 'Plan Member',
          'conversation-plan-member@example.com', 'Plan Member', 'hash', 'scrypt-v1',
          'member', 'active'
        );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'conversation-plan-project', 'Conversation Plan Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'conversation-plan-owner'
      );

      INSERT INTO project_members (
        project_id, user_id, status, added_by_user_id
      ) VALUES (
        'conversation-plan-project', 'conversation-plan-member', 'active',
        'conversation-plan-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId,
    });
    const reviewModels: ConversationPlanReviewModels = {
      pm: { provider: "anthropic", model: "claude-sonnet-5" },
      reviewer: { provider: "openai", model: "gpt-5.6-sol" },
    };
    workflow = new ConversationPlanWorkflowService(transactions, {
      newId,
      now: () => new Date("2026-07-27T16:00:00.000Z"),
      resolveReviewModels: async () => reviewModels,
      runReviewNow: async (runId) => {
        dispatches.push(runId);
      },
      executionKickoff: {
        kickoff: async (input) => {
          kickoffInputs.push(input);
          return kickoff(input);
        },
      },
    });
    proposals = new ConversationPlanProposalService(
      transactions,
      conversations,
      new ConversationContextAssembler(transactions),
      workflow,
      {
        newId,
        now: () => new Date("2026-07-27T16:00:00.000Z"),
        createAdapter: () => proposalAdapter,
      },
    );
    changes = new ConversationPlanChangeProposalService(transactions, workflow, newId);
  }, 60_000);

  beforeEach(() => {
    dispatches = [];
    kickoffInputs = [];
    kickoff = async () => ({ started: false, detail: "test refused execution" });
    proposalAdapter = new FakeAdapter("anthropic", "claude-sonnet-5");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function workspace(label: string, withArtifact = false) {
    const created = await conversations.createPlanningWorkspace(
      owner,
      {
        project_id: projectId,
        title: `Plan workflow ${label}`,
        objective: `Deliver Phase 3 ${label}`,
      },
      { provider: "anthropic", model: "claude-sonnet-5" },
    );
    const artifactId = withArtifact ? `artifact-${label}` : null;
    const artifactHash = "c".repeat(64);
    if (artifactId) {
      await pg.query(
        `INSERT INTO artifacts (
           id, project_id, kind, label, media_type, storage_ref, content_hash,
           byte_size, provenance_actor_type, provenance_actor_id, redaction_status
         ) VALUES (
           $1,$2,'mockup','Approved checkout mockup','image/png',
           's3://private/mockup.png',$3,120,'human',$4,'reviewed'
         )`,
        [artifactId, projectId, artifactHash, owner.id],
      );
    }
    const initial = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      client_message_id: `initial-${label}`,
      parts: [
        {
          type: "text",
          format: "markdown",
          text: `BRAINSTORM-${label}: compare several abandoned approaches before planning.`,
        },
        ...(artifactId
          ? [
              {
                type: "artifact" as const,
                artifact_id: artifactId,
                label: "Approved checkout mockup",
                media_type: "image/png",
              },
            ]
          : []),
      ],
    });
    return {
      workItemId: created.work_item.id,
      conversationId: created.conversation.id,
      initialMessageId: initial.id,
      artifactId,
      artifactHash,
    };
  }

  function confirmation(
    scope: { workItemId: string; conversationId: string },
    actionId: string,
    idempotencyKey: string,
  ) {
    return {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: scope.conversationId,
      action_id: actionId,
      idempotency_key: idempotencyKey,
    };
  }

  async function proposeAndSave(
    scope: { workItemId: string; conversationId: string },
    candidate: V2WorkPlanContractT,
    key: string,
  ) {
    if (!(proposalAdapter instanceof FakeAdapter)) {
      throw new Error("the test proposal adapter is not queueable");
    }
    proposalAdapter.enqueue(candidate);
    const proposed = await proposals.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      { idempotency_key: `${key}-proposal` },
    );
    const saved = await workflow.confirm(
      owner.id,
      confirmation(scope, proposed.action.id, `${key}-save`),
    );
    if (saved.effect.kind !== "plan_saved") throw new Error("expected a saved plan");
    return saved.effect.plan_version;
  }

  async function proposedAction(
    scope: { workItemId: string; conversationId: string },
    type: V2ConversationActionT["action_type"],
  ) {
    const detail = await workflow.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    const action = detail.actions.find(
      (candidate) => candidate.action_type === type && candidate.status === "proposed",
    );
    if (!action) throw new Error(`missing proposed ${type} action`);
    return action;
  }

  it("keeps generation inert, replays it idempotently, and emits reachable follow-ups on save", async () => {
    const scope = await workspace("proposal");
    const adapter = proposalAdapter as FakeAdapter;
    const candidate = plan();
    adapter.enqueue(candidate);

    const first = await proposals.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      { idempotency_key: "proposal-idempotent" },
    );
    const replay = await proposals.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      { idempotency_key: "proposal-idempotent" },
    );

    expect(replay).toEqual(first);
    expect(adapter.requests).toHaveLength(1);
    expect(first.action.action_type).toBe("save_plan_candidate");
    expect(first.action.status).toBe("proposed");
    expect(
      await workflow.detail(owner.id, projectId, scope.workItemId, scope.conversationId),
    ).toMatchObject({ plan_versions: [] });
    const attempt = await pg.query<{
      status: string;
      usage_status: string;
      input_tokens: number | string;
      output_tokens: number | string;
      output_message_id: string;
      action_id: string;
    }>(
      `SELECT status, usage_status, input_tokens, output_tokens,
              output_message_id, action_id
         FROM conversation_plan_proposal_attempts
        WHERE conversation_id=$1`,
      [scope.conversationId],
    );
    expect(attempt.rows[0]).toMatchObject({
      status: "succeeded",
      usage_status: "exact",
      input_tokens: 100,
      output_tokens: 50,
      output_message_id: first.message.id,
      action_id: first.action.id,
    });

    const confirmationInput = confirmation(scope, first.action.id, "save-confirmation-idempotent");
    const confirmed = await Promise.all([
      workflow.confirm(owner.id, confirmationInput),
      workflow.confirm(owner.id, confirmationInput),
    ]);
    expect(confirmed[0]).toEqual(confirmed[1]);
    expect(confirmed[0]?.effect.kind).toBe("plan_saved");

    const detail = await workflow.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    expect(detail.plan_versions).toHaveLength(1);
    expect(detail.plan_versions[0]).toMatchObject({
      version: 1,
      plan: candidate,
      content_hash: canonicalSha256(candidate),
      supersedes_plan_version_id: null,
      diff_from_previous: null,
    });
    const followUps = detail.actions.filter((action) => action.status === "proposed");
    expect(followUps.map((action) => action.action_type).sort()).toEqual([
      "reject_plan",
      "send_plan_to_qc",
    ]);
    const messages = await conversations.listMessages(
      owner,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    const emittedActionIds = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "action")
      .map((part) => part.action_id);
    expect(followUps.every((action) => emittedActionIds.includes(action.id))).toBe(true);
    expect(new Set(detail.action_effects.map((effect) => effect.action_id))).toEqual(
      new Set([first.action.id]),
    );
  });

  it("settles adapter-construction failure once and replays the terminal failure without spend", async () => {
    const scope = await workspace("proposal-construction-failure");
    let factoryCalls = 0;
    const failing = new ConversationPlanProposalService(
      transactions,
      conversations,
      new ConversationContextAssembler(transactions),
      workflow,
      {
        newId,
        createAdapter: () => {
          factoryCalls += 1;
          throw new Error("adapter construction failed");
        },
      },
    );
    const request = { idempotency_key: "terminal-proposal-failure" };
    await expect(
      failing.propose(owner.id, projectId, scope.workItemId, scope.conversationId, request),
    ).rejects.toMatchObject({ code: "proposal_failed", httpStatus: 502 });
    await expect(
      failing.propose(owner.id, projectId, scope.workItemId, scope.conversationId, request),
    ).rejects.toMatchObject({ code: "proposal_failed", httpStatus: 502 });
    expect(factoryCalls).toBe(1);
    const attempt = await pg.query<{
      status: string;
      usage_status: string;
      failure_code: string;
    }>(
      `SELECT status, usage_status, failure_code
         FROM conversation_plan_proposal_attempts
        WHERE conversation_id=$1`,
      [scope.conversationId],
    );
    expect(attempt.rows[0]).toEqual({
      status: "failed",
      usage_status: "unavailable",
      failure_code: "plan_proposal_failed",
    });
  });

  it("makes a concurrent same-key proposal call inert and blocks overlapping conversation writes", async () => {
    const scope = await workspace("proposal-concurrent");
    const adapter = proposalAdapter as FakeAdapter;
    adapter.enqueue(plan("Generate exactly once under concurrency"));
    const original = adapter.completeStructured.bind(adapter);
    let releaseProvider = (): void => {};
    let markProviderEntered = (): void => {};
    const providerEntered = new Promise<void>((resolve) => {
      markProviderEntered = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    adapter.completeStructured = async (request, schema, schemaName) => {
      markProviderEntered();
      await providerRelease;
      return original(request, schema, schemaName);
    };
    const request = { idempotency_key: "concurrent-proposal-key" };
    const first = proposals.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      request,
    );
    await providerEntered;
    await expect(
      proposals.propose(owner.id, projectId, scope.workItemId, scope.conversationId, request),
    ).rejects.toMatchObject({ code: "proposal_in_progress", httpStatus: 409 });
    await expect(
      conversations.submitUserMessage(owner, {
        project_id: projectId,
        work_item_id: scope.workItemId,
        conversation_id: scope.conversationId,
        client_message_id: "overlapping-conversation-write",
        parts: [{ type: "text", format: "plain", text: "Do not overlap generation." }],
      }),
    ).rejects.toMatchObject({ code: "turn_in_progress" });
    releaseProvider();
    await expect(first).resolves.toMatchObject({
      action: { action_type: "save_plan_candidate", status: "proposed" },
    });
    expect(adapter.requests).toHaveLength(1);
  });

  it("records exact actor-scoped change direction and refuses repeated mutation after recording", async () => {
    const scope = await workspace("changes");
    const saved = await proposeAndSave(scope, plan(), "changes");
    const direction = "Remove the dashboard task; add exact cancellation usage verification.";
    const input = {
      idempotency_key: "shared-change-key",
      plan_version_id: saved.id,
      plan_hash: saved.content_hash,
      direction,
    };

    const first = await changes.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      input,
    );
    expect(
      await changes.propose(owner.id, projectId, scope.workItemId, scope.conversationId, input),
    ).toEqual(first);
    const secondActor = await changes.propose(
      member.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      input,
    );
    expect(secondActor.action.id).not.toBe(first.action.id);
    expect(secondActor.message.actor).toEqual({ actor_type: "human", actor_id: member.id });
    await expect(
      changes.propose(owner.id, projectId, scope.workItemId, scope.conversationId, {
        ...input,
        direction: "A different direction under the same key.",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const rows = await pg.query<{
      initiated_by_user_id: string;
      direction: string;
      direction_hash: string;
    }>(
      `SELECT initiated_by_user_id, direction, direction_hash
         FROM conversation_plan_change_proposals
        WHERE conversation_id=$1
        ORDER BY initiated_by_user_id`,
      [scope.conversationId],
    );
    expect(rows.rows).toEqual([
      {
        initiated_by_user_id: member.id,
        direction,
        direction_hash: canonicalSha256(direction),
      },
      {
        initiated_by_user_id: owner.id,
        direction,
        direction_hash: canonicalSha256(direction),
      },
    ]);
    expect(first.action.actor).toEqual({ actor_type: "human", actor_id: owner.id });
    expect(first.action.payload.parameters).toEqual({
      plan_version_id: saved.id,
      content_hash: saved.content_hash,
      direction,
    });

    const recorded = await workflow.confirm(
      owner.id,
      confirmation(scope, first.action.id, "confirm-exact-direction"),
    );
    expect(recorded.effect).toMatchObject({
      kind: "changes_requested",
      plan_version: { id: saved.id, status: "changes_requested" },
    });
    await expect(
      changes.propose(owner.id, projectId, scope.workItemId, scope.conversationId, {
        ...input,
        idempotency_key: "change-after-recording",
      }),
    ).rejects.toMatchObject({ code: "invalid_plan_state" });
  });

  it("creates immutable hash-bound version lineage and rejects a stale confirmation", async () => {
    const scope = await workspace("lineage");
    const first = await proposeAndSave(scope, plan("Ship immutable Plan v1"), "lineage-v1");
    await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: scope.conversationId,
      client_message_id: "lineage-revision",
      parts: [
        {
          type: "text",
          format: "markdown",
          text: "Revise the objective and retain the exact cancellation test.",
        },
      ],
    });
    const second = await proposeAndSave(
      scope,
      plan("Ship immutable Plan v2 with cancellation accounting"),
      "lineage-v2",
    );
    const detail = await workflow.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    expect(detail.plan_versions).toHaveLength(2);
    expect(detail.plan_versions[0]).toMatchObject({ id: first.id, status: "superseded" });
    expect(detail.plan_versions[1]).toMatchObject({
      id: second.id,
      version: 2,
      supersedes_plan_version_id: first.id,
      content_hash: canonicalSha256(second.plan),
    });
    expect(detail.plan_versions[1]?.diff_from_previous?.changed).toContain("plan.objective");
    await expect(
      pg.query(
        `UPDATE work_plan_versions
            SET plan=jsonb_set(plan, '{plan,objective}', '"tampered"')
          WHERE id=$1`,
        [second.id],
      ),
    ).rejects.toThrow(/immutable/);

    const source = (
      await conversations.listMessages(owner, projectId, scope.workItemId, scope.conversationId)
    ).at(-1);
    if (!source) throw new Error("missing workflow message");
    const stale = await conversations.proposeInternalAction(
      {
        initiatedByUserId: owner.id,
        actor: { actor_type: "system", actor_id: "phase3-test" },
      },
      {
        project_id: projectId,
        work_item_id: scope.workItemId,
        conversation_id: scope.conversationId,
        source_message_id: source.id,
        action_type: "send_plan_to_qc",
        payload: {
          parameters: {
            plan_version_id: first.id,
            content_hash: first.content_hash,
          },
        },
      },
    );
    await expect(
      workflow.confirm(owner.id, confirmation(scope, stale.id, "confirm-stale-version")),
    ).rejects.toMatchObject({ code: "stale_plan_version" });
    const staleRow = await pg.query<{ status: string }>(
      "SELECT status FROM conversation_actions WHERE id=$1",
      [stale.id],
    );
    expect(staleRow.rows[0]?.status).toBe("proposed");
  });

  it("freezes exact-plan transcript-free QC and approves only its exact result through kickoff", async () => {
    const scope = await workspace("isolated-qc", true);
    const candidate = plan("Review the exact artifact-bound plan");
    const saved = await proposeAndSave(scope, candidate, "isolated-qc");
    const qcAction = await proposedAction(scope, "send_plan_to_qc");
    const qcInput = confirmation(scope, qcAction.id, "send-exact-plan-to-qc");
    const qc = await workflow.confirm(owner.id, qcInput);
    expect(qc.effect.kind).toBe("qc_started");
    if (qc.effect.kind !== "qc_started") throw new Error("expected QC effect");
    expect(dispatches).toEqual([qc.effect.planning_run_id]);
    expect(await workflow.confirm(owner.id, qcInput)).toEqual(qc);
    expect(dispatches).toEqual([qc.effect.planning_run_id]);

    const seed = await workflow.loadReviewOnlySeed(qc.effect.planning_run_id);
    expect(seed.seedPlan).toEqual(candidate);
    expect(canonicalSha256(seed.seedPlan)).toBe(saved.content_hash);
    const frozen = JSON.stringify(seed.frozenContext);
    expect(frozen).not.toContain("BRAINSTORM-isolated-qc");
    expect(frozen).not.toContain("compare several abandoned approaches");
    expect(seed.frozenContext).toMatchObject({
      referenced_artifacts: [
        {
          id: scope.artifactId,
          content_hash: scope.artifactHash,
          media_type: "image/png",
          storage_ref: "s3://private/mockup.png",
        },
      ],
    });
    const run = await pg.query<{ transcript: unknown }>(
      "SELECT transcript FROM planning_runs WHERE id=$1",
      [qc.effect.planning_run_id],
    );
    expect(run.rows[0]?.transcript).toEqual([]);

    await workflow.markReviewOnlyStarted(seed.reviewId);
    const result: ReviewOnlyPlanningResult = {
      status: "converged",
      rounds: 2,
      seed_plan: candidate,
      final_plan: candidate,
      result_plan_content_hash: canonicalSha256(candidate),
      review_rounds: [
        {
          round: 1,
          reviewed_plan: candidate,
          findings: [
            {
              severity: "must_fix",
              module_id: "conversation-api",
              finding: "Make cancellation accounting explicit.",
              recommendation: "Retain an exact usage assertion.",
            },
          ],
          responses: [
            {
              finding_index: 0,
              disposition: "accept",
              rationale: "The verification requirement already binds the exact assertion.",
            },
          ],
        },
        {
          round: 2,
          reviewed_plan: candidate,
          findings: [],
          responses: null,
        },
      ],
      usage: [],
    };
    await workflow.completeReviewOnly({
      reviewId: seed.reviewId,
      planningRunId: qc.effect.planning_run_id,
      result,
      totalCostUsd: 1.25,
    });
    const reviewed = await workflow.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    expect(reviewed.plan_reviews[0]).toMatchObject({
      id: seed.reviewId,
      usage_request_group_id: seed.reviewId,
      plan_version_id: saved.id,
      status: "converged",
      result_plan_content_hash: saved.content_hash,
      revised_plan_version_id: null,
      findings: [
        {
          finding: "Make cancellation accounting explicit.",
          recommendation: "Retain an exact usage assertion.",
        },
      ],
      dispositions: [
        {
          finding_index: 0,
          disposition: "accept",
        },
      ],
    });
    const approval = await proposedAction(scope, "approve_plan");
    expect(approval.payload.parameters).toEqual({
      plan_version_id: saved.id,
      content_hash: saved.content_hash,
      plan_review_id: seed.reviewId,
    });

    kickoff = async () => {
      throw new Error("runner unavailable after approval");
    };
    const approved = await workflow.confirm(
      owner.id,
      confirmation(scope, approval.id, "approve-exact-qc-result"),
    );
    expect(kickoffInputs).toEqual([
      {
        projectId,
        planningRunId: qc.effect.planning_run_id,
        staffing: [
          {
            node_id: "conversation-api",
            provider: "openai",
            model: "gpt-5.6-sol",
            reasoning_effort: null,
          },
        ],
        decidedBy: owner.id,
      },
    ]);
    expect(approved.effect).toMatchObject({
      kind: "plan_approved",
      plan_version: {
        id: saved.id,
        status: "approved",
        content_hash: saved.content_hash,
      },
      plan_review_id: seed.reviewId,
      planning_run_id: qc.effect.planning_run_id,
      execution: {
        status: "failed",
        started: false,
        detail: "runner unavailable after approval",
      },
    });
    expect(
      await workflow.confirm(owner.id, confirmation(scope, approval.id, "approve-exact-qc-result")),
    ).toEqual(approved);
    expect(kickoffInputs).toHaveLength(1);
  });

  it("retires seed-version actions when QC materializes a revised exact result", async () => {
    const scope = await workspace("revised-qc");
    const candidate = plan("Review Plan v1 before revision");
    const revised = plan("Approve only the exact QC-revised Plan v2");
    const saved = await proposeAndSave(scope, candidate, "revised-qc");
    const staleReject = await proposedAction(scope, "reject_plan");
    const qcAction = await proposedAction(scope, "send_plan_to_qc");
    const qc = await workflow.confirm(
      owner.id,
      confirmation(scope, qcAction.id, "send-revisable-plan-to-qc"),
    );
    if (qc.effect.kind !== "qc_started") throw new Error("expected QC effect");

    const seed = await workflow.loadReviewOnlySeed(qc.effect.planning_run_id);
    await workflow.markReviewOnlyStarted(seed.reviewId);
    await workflow.completeReviewOnly({
      reviewId: seed.reviewId,
      planningRunId: qc.effect.planning_run_id,
      result: {
        status: "converged",
        rounds: 2,
        seed_plan: candidate,
        final_plan: revised,
        result_plan_content_hash: canonicalSha256(revised),
        review_rounds: [
          {
            round: 1,
            reviewed_plan: candidate,
            findings: [
              {
                severity: "must_fix",
                module_id: "conversation-api",
                finding: "Revise the objective before approval.",
                recommendation: "Bind approval to the revised Plan Contract.",
              },
            ],
            responses: [
              {
                finding_index: 0,
                disposition: "accept",
                rationale: "The PM revised the objective and retained every binding constraint.",
              },
            ],
          },
          {
            round: 2,
            reviewed_plan: revised,
            findings: [],
            responses: null,
          },
        ],
        usage: [],
      },
      totalCostUsd: 0.75,
    });

    const reviewed = await workflow.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    const revisedVersion = reviewed.plan_versions.find(
      (version) => version.supersedes_plan_version_id === saved.id,
    );
    expect(revisedVersion).toMatchObject({
      version: 2,
      status: "candidate",
      plan: revised,
      content_hash: canonicalSha256(revised),
    });
    if (!revisedVersion) throw new Error("expected revised plan version");
    expect(reviewed.plan_versions.find((version) => version.id === saved.id)?.status).toBe(
      "superseded",
    );
    expect(reviewed.actions.find((action) => action.id === staleReject.id)?.status).toBe(
      "rejected",
    );
    expect(reviewed.plan_reviews[0]).toMatchObject({
      id: seed.reviewId,
      plan_version_id: saved.id,
      revised_plan_version_id: revisedVersion.id,
      result_plan_content_hash: revisedVersion.content_hash,
    });

    const approval = reviewed.actions.find(
      (action) => action.action_type === "approve_plan" && action.status === "proposed",
    );
    expect(approval?.payload.parameters).toEqual({
      plan_version_id: revisedVersion.id,
      content_hash: revisedVersion.content_hash,
      plan_review_id: seed.reviewId,
    });
    if (!approval) throw new Error("expected revised plan approval action");

    const approvalInput = confirmation(scope, approval.id, "approve-revised-qc-result");
    const approved = await workflow.confirm(owner.id, approvalInput);
    expect(approved.effect).toMatchObject({
      kind: "plan_approved",
      plan_version: {
        id: revisedVersion.id,
        status: "approved",
        content_hash: revisedVersion.content_hash,
      },
      plan_review_id: seed.reviewId,
    });
    expect(await workflow.confirm(owner.id, approvalInput)).toEqual(approved);
    expect(kickoffInputs).toHaveLength(1);
  });

  it("atomically settles failed QC and reconciles orphaned proposal attempts", async () => {
    const scope = await workspace("failure");
    const saved = await proposeAndSave(scope, plan("Keep failed QC recoverable"), "failure");
    const qcAction = await proposedAction(scope, "send_plan_to_qc");
    const qc = await workflow.confirm(
      owner.id,
      confirmation(scope, qcAction.id, "send-plan-to-failing-qc"),
    );
    if (qc.effect.kind !== "qc_started") throw new Error("expected QC effect");

    await workflow.failReviewOnly(qc.effect.planning_run_id, new Error("review provider down"));
    const detail = await workflow.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    expect(detail.plan_versions.find((version) => version.id === saved.id)?.status).toBe(
      "candidate",
    );
    expect(detail.plan_reviews[0]).toMatchObject({
      status: "failed",
      failure_code: "review_provider_down",
    });
    expect(detail.actions.find((action) => action.id === qcAction.id)).toMatchObject({
      status: "failed",
      failure_code: "review_provider_down",
    });
    expect(
      detail.actions
        .filter((action) => action.status === "proposed")
        .map((action) => action.action_type)
        .sort(),
    ).toEqual(["reject_plan", "send_plan_to_qc"]);
    const settled = await pg.query<{
      work_status: string;
      run_status: string;
      review_status: string;
      action_status: string;
    }>(
      `SELECT item.status AS work_status, run.status AS run_status,
              review.status AS review_status, action.status AS action_status
         FROM work_items item
         JOIN conversation_plan_reviews review ON review.work_item_id=item.id
         JOIN planning_runs run ON run.id=review.planning_run_id
         JOIN conversation_actions action ON action.id=review.action_id
        WHERE item.id=$1 AND review.planning_run_id=$2`,
      [scope.workItemId, qc.effect.planning_run_id],
    );
    expect(settled.rows[0]).toEqual({
      work_status: "planning",
      run_status: "failed",
      review_status: "failed",
      action_status: "failed",
    });

    const source = (
      await conversations.listMessages(owner, projectId, scope.workItemId, scope.conversationId)
    ).at(-1);
    if (!source) throw new Error("missing visible source message");
    await pg.query(
      `INSERT INTO conversation_plan_proposal_attempts (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         idempotency_key, request_fingerprint, source_message_id, provider, model,
         usage_request_id, context_manifest, context_hash, started_at
       ) VALUES (
         'orphaned-proposal',$1,$2,$3,$4,'orphan-key',$5,$6,
         'anthropic','claude-sonnet-5','orphan-usage',
         '{"entries":[],"estimated_tokens":0}'::jsonb,$7,now()
       )`,
      [
        projectId,
        scope.workItemId,
        scope.conversationId,
        owner.id,
        "d".repeat(64),
        source.id,
        canonicalSha256({ entries: [], estimated_tokens: 0 }),
      ],
    );
    expect(await proposals.reconcileOrphans()).toBe(1);
    const orphan = await pg.query<{
      status: string;
      usage_status: string;
      failure_code: string;
      settled_at: Date | string | null;
    }>(
      `SELECT status, usage_status, failure_code, settled_at
         FROM conversation_plan_proposal_attempts
        WHERE id='orphaned-proposal'`,
    );
    expect(orphan.rows[0]).toMatchObject({
      status: "failed",
      usage_status: "unavailable",
      failure_code: "orphaned",
    });
    expect(orphan.rows[0]?.settled_at).not.toBeNull();
  });
});
