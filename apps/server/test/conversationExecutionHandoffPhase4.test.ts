import { PGlite } from "@electric-sql/pglite";
import { V2WorkPlanContract, type V2WorkPlanContractT } from "@norns/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import { ExecutionConversationService } from "../src/conversations/executionConversation.js";
import {
  type ConversationPlanWorkflowOptions,
  ConversationPlanWorkflowService,
} from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { ConversationTurnRepository } from "../src/conversations/turnRepository.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

const projectId = "phase4-conversation-project";
const otherProjectId = "phase4-other-project";
const owner = { id: "phase4-conversation-owner" };
const outsider = { id: "phase4-conversation-outsider" };
const sentinel = "PHASE4_PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD";
const now = "2026-07-27T18:00:00.000Z";

const approvalCheckpoints = [
  "plan_frozen",
  "planning_message_appended",
  "summary_created",
  "planning_archived",
  "execution_conversation_created",
  "handoff_created",
  "task_packages_created",
  "execution_seeded",
  "kickoff_intent_created",
  "effect_created",
] as const;

function plan(objective: string): V2WorkPlanContractT {
  return V2WorkPlanContract.parse({
    plan: {
      objective,
      assumptions: ["The existing coordinator remains authoritative."],
      modules: [
        {
          id: "api",
          title: "Conversation API",
          description: "Deliver the durable conversation transition.",
          deliverables: ["Durable transition"],
          acceptance: [
            {
              id: "api-test",
              statement: "The approval transition is restart-safe.",
              verification_type: "test",
              verification: "Run the Phase 4 focused suite.",
            },
          ],
          dependencies: [],
          estimated_complexity: "M",
          risk: "medium",
        },
        {
          id: "worker",
          title: "Scoped worker package",
          description: "Give workers only the approved task package.",
          deliverables: ["Scoped package"],
          acceptance: [
            {
              id: "worker-test",
              statement: "Planning filler is absent from worker context.",
              verification_type: "test",
              verification: "Inspect the immutable package.",
            },
          ],
          dependencies: ["api"],
          estimated_complexity: "S",
          risk: "low",
        },
      ],
      risks: [
        {
          description: "The approval response can be lost.",
          mitigation: "Replay the exact durable transition.",
        },
      ],
      out_of_scope: ["Automatic planning transcript replay"],
    },
    staffing: [
      {
        module_id: "api",
        agent_role: "implementation",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
      {
        module_id: "worker",
        agent_role: "implementation",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ],
    verification_requirements: ["Focused and whole-repository tests pass."],
    open_decisions: ["Confirm the rollout window."],
    estimated_budget: { currency: "USD", amount: 32 },
  });
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

describe.sequential("conversation-first Phase 4 execution handoff", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let conversations: ConversationService;
  let execution: ExecutionConversationService;
  let workflow: ConversationPlanWorkflowService;
  let id = 0;
  let failureAt: (typeof approvalCheckpoints)[number] | null;
  let kickoff: NonNullable<ConversationPlanWorkflowOptions["executionKickoff"]>["kickoff"];

  const newId = (prefix: string): string => `${prefix}-phase4-test-${++id}`;

  function makeWorkflow(): ConversationPlanWorkflowService {
    return new ConversationPlanWorkflowService(transactions, {
      newId,
      now: () => new Date(now),
      resolveReviewModels: async () => ({
        pm: { provider: "anthropic", model: "claude-sonnet-5" },
        reviewer: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      runReviewNow: async () => undefined,
      executionKickoff: {
        kickoff: (input) => kickoff(input),
      },
      approvalTransitionCheckpoint: (checkpoint) => {
        if (checkpoint === failureAt) {
          throw new Error(`injected Phase 4 approval failure at ${checkpoint}`);
        }
      },
    });
  }

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
          '${owner.id}', 'phase4-owner@example.com', 'Phase 4 Owner',
          'phase4-owner@example.com', 'Phase 4 Owner', 'hash', 'scrypt-v1',
          'member', 'active'
        ),
        (
          '${outsider.id}', 'phase4-outsider@example.com', 'Phase 4 Outsider',
          'phase4-outsider@example.com', 'Phase 4 Outsider', 'hash', 'scrypt-v1',
          'member', 'active'
        );

      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES
        (
          '${projectId}', 'Phase 4 Conversations', 'active',
          'assignment/default', 'verification/default', 'budget/default',
          '${owner.id}'
        ),
        (
          '${otherProjectId}', 'Other Phase 4 Project', 'active',
          'assignment/default', 'verification/default', 'budget/default',
          '${owner.id}'
        );
    `);
    transactions = new PGliteTransactionRunner(pg);
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId,
    });
    execution = new ExecutionConversationService(transactions, {
      newId,
      now: () => new Date(now),
    });
    workflow = makeWorkflow();
  }, 60_000);

  beforeEach(() => {
    failureAt = null;
    kickoff = async () => ({ started: false, detail: "Test kickoff refused." });
  });

  afterAll(async () => {
    await pg.close();
  });

  async function approvalReady(label: string, messageCount = 1) {
    const created = await conversations.createPlanningWorkspace(
      owner,
      {
        project_id: projectId,
        title: `Phase 4 ${label}`,
        objective: `Deliver Phase 4 ${label}`,
      },
      { provider: "anthropic", model: "claude-sonnet-5" },
    );
    const artifactId = `phase4-image-${label}`;
    const artifactHash = canonicalSha256({ label, kind: "image/png" });
    await pg.query(
      `INSERT INTO artifacts (
         id, project_id, kind, label, media_type, storage_ref, content_hash,
         byte_size, provenance_actor_type, provenance_actor_id, redaction_status
       ) VALUES (
         $1,$2,'mockup','Approved Phase 4 mockup','image/png',
         $3,$4,128,'human',$5,'reviewed'
       )`,
      [artifactId, projectId, `s3://private/${artifactId}.png`, artifactHash, owner.id],
    );
    const messages = [];
    for (let index = 0; index < messageCount; index += 1) {
      messages.push(
        await conversations.submitUserMessage(owner, {
          project_id: projectId,
          work_item_id: created.work_item.id,
          conversation_id: created.conversation.id,
          client_message_id: `phase4-${label}-message-${index + 1}`,
          parts: [
            {
              type: "text",
              format: "markdown",
              text:
                index === 0
                  ? `${sentinel}: compare abandoned approaches for ${label}.`
                  : `Planning filler ${index + 1} for ${label}.`,
            },
            ...(index === 0
              ? [
                  {
                    type: "artifact" as const,
                    artifact_id: artifactId,
                    label: "Approved Phase 4 mockup",
                    media_type: "image/png",
                  },
                ]
              : []),
          ],
        }),
      );
    }
    const candidate = plan(`Deliver Phase 4 ${label}`);
    const saveAction = await conversations.proposeAction(owner, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      source_message_id: required(messages.at(-1), "missing planning source message").id,
      action_type: "save_plan_candidate",
      payload: {
        parameters: {
          plan: candidate,
          predecessor_plan_version_id: null,
          predecessor_content_hash: null,
          referenced_artifacts: [{ id: artifactId, content_hash: artifactHash }],
        },
      },
    });
    const saved = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: saveAction.id,
      idempotency_key: `phase4-save-${label}`,
    });
    if (saved.effect.kind !== "plan_saved") throw new Error("expected saved plan");
    let detail = await workflow.detail(
      owner.id,
      projectId,
      created.work_item.id,
      created.conversation.id,
    );
    const qcAction = detail.actions.find(
      (action) => action.action_type === "send_plan_to_qc" && action.status === "proposed",
    );
    if (!qcAction) throw new Error("missing QC action");
    const qc = await workflow.confirm(owner.id, {
      project_id: projectId,
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: qcAction.id,
      idempotency_key: `phase4-qc-${label}`,
    });
    if (qc.effect.kind !== "qc_started") throw new Error("expected QC start");
    const seed = await workflow.loadReviewOnlySeed(qc.effect.planning_run_id);
    await workflow.markReviewOnlyStarted(seed.reviewId);
    await workflow.completeReviewOnly({
      reviewId: seed.reviewId,
      planningRunId: qc.effect.planning_run_id,
      result: {
        status: "converged",
        rounds: 1,
        seed_plan: candidate,
        final_plan: candidate,
        result_plan_content_hash: canonicalSha256(candidate),
        review_rounds: [
          {
            round: 1,
            reviewed_plan: candidate,
            findings: [],
            responses: null,
          },
        ],
        usage: [],
      },
      totalCostUsd: 0,
    });
    detail = await workflow.detail(
      owner.id,
      projectId,
      created.work_item.id,
      created.conversation.id,
    );
    const approval = detail.actions.find(
      (action) => action.action_type === "approve_plan" && action.status === "proposed",
    );
    if (!approval) throw new Error("missing approval action");
    return {
      workItemId: created.work_item.id,
      planningConversationId: created.conversation.id,
      sourceMessageIds: messages.map((message) => message.id),
      candidate,
      planVersionId: saved.effect.plan_version.id,
      reviewId: seed.reviewId,
      planningRunId: qc.effect.planning_run_id,
      frozenQcContext: seed.frozenContext,
      approval,
      confirmation: {
        project_id: projectId,
        work_item_id: created.work_item.id,
        conversation_id: created.conversation.id,
        action_id: approval.id,
        idempotency_key: `phase4-approve-${label}`,
      },
      artifactId,
    };
  }

  async function transitionSnapshot(scope: {
    workItemId: string;
    planningConversationId: string;
    planVersionId: string;
    approval: { id: string };
  }) {
    const result = await pg.query<{
      plan_status: string;
      planning_status: string;
      work_status: string;
      action_status: string;
      execution_count: number | string;
      handoff_count: number | string;
      package_count: number | string;
      summary_count: number | string;
      receipt_count: number | string;
      intent_count: number | string;
      effect_count: number | string;
      approval_message_count: number | string;
    }>(
      `SELECT
         (SELECT status FROM work_plan_versions WHERE id=$3) AS plan_status,
         (SELECT status FROM work_conversations WHERE id=$2) AS planning_status,
         (SELECT status FROM work_items WHERE id=$1) AS work_status,
         (SELECT status FROM conversation_actions WHERE id=$4) AS action_status,
         (SELECT count(*) FROM work_conversations
           WHERE work_item_id=$1 AND kind='execution_pm') AS execution_count,
         (SELECT count(*) FROM conversation_handoffs WHERE work_item_id=$1) AS handoff_count,
         (SELECT count(*) FROM conversation_task_packages WHERE work_item_id=$1) AS package_count,
         (SELECT count(*) FROM conversation_summaries WHERE work_item_id=$1) AS summary_count,
         (SELECT count(*) FROM conversation_compaction_receipts WHERE work_item_id=$1)
           AS receipt_count,
         (SELECT count(*) FROM conversation_kickoff_intents WHERE work_item_id=$1)
           AS intent_count,
         (SELECT count(*) FROM conversation_plan_action_effects
           WHERE action_id=$4 AND effect_kind='plan_approved') AS effect_count,
         (SELECT count(*) FROM work_messages
           WHERE conversation_id=$2 AND parts::text LIKE '%Execution kickoff is pending%')
           AS approval_message_count`,
      [scope.workItemId, scope.planningConversationId, scope.planVersionId, scope.approval.id],
    );
    return result.rows[0];
  }

  it("rolls the complete approval transaction back at every checkpoint", async () => {
    for (const checkpoint of approvalCheckpoints) {
      const scope = await approvalReady(`rollback-${checkpoint}`);
      const before = await transitionSnapshot(scope);
      failureAt = checkpoint;
      await expect(workflow.confirm(owner.id, scope.confirmation)).rejects.toThrow(
        `injected Phase 4 approval failure at ${checkpoint}`,
      );
      failureAt = null;
      expect(await transitionSnapshot(scope)).toEqual(before);
      expect(before).toMatchObject({
        plan_status: "in_qc",
        planning_status: "active",
        work_status: "awaiting_approval",
        action_status: "proposed",
        execution_count: 0,
        handoff_count: 0,
        package_count: 0,
        summary_count: 0,
        receipt_count: 0,
        intent_count: 0,
        effect_count: 0,
        approval_message_count: 0,
      });
    }
  }, 60_000);

  it("replays one archived transition and reconciles an expired kickoff lease after restart", async () => {
    const scope = await approvalReady("restart");
    let enterFirstKickoff!: () => void;
    let releaseFirstKickoff!: () => void;
    const firstKickoffEntered = new Promise<void>((resolve) => {
      enterFirstKickoff = resolve;
    });
    const firstKickoffRelease = new Promise<void>((resolve) => {
      releaseFirstKickoff = resolve;
    });
    let kickoffCalls = 0;
    kickoff = async () => {
      kickoffCalls += 1;
      enterFirstKickoff();
      await firstKickoffRelease;
      return { started: false, detail: "Stale leased worker result." };
    };
    const approvalPromise = workflow.confirm(owner.id, scope.confirmation);
    await firstKickoffEntered;

    const pendingReplay = await workflow.confirm(owner.id, scope.confirmation);
    expect(pendingReplay.effect).toMatchObject({
      kind: "plan_approved",
      transition_status: "created",
      execution: { status: "pending", started: null },
    });
    if (pendingReplay.effect.kind !== "plan_approved") {
      throw new Error("expected approval effect");
    }
    const transitionIds = {
      executionConversationId: required(
        pendingReplay.effect.execution_conversation_id,
        "missing execution conversation ID",
      ),
      handoffId: required(pendingReplay.effect.handoff_id, "missing handoff ID"),
      kickoffIntentId: required(
        pendingReplay.effect.kickoff_intent_id,
        "missing kickoff intent ID",
      ),
    };
    expect(kickoffCalls).toBe(1);
    const leased = await pg.query<{
      status: string;
      attempt_count: number | string;
    }>("SELECT status, attempt_count FROM conversation_kickoff_intents WHERE id=$1", [
      transitionIds.kickoffIntentId,
    ]);
    expect(leased.rows[0]).toEqual({ status: "leased", attempt_count: 1 });

    await pg.query(
      `UPDATE conversation_kickoff_intents
          SET lease_expires_at=now()-interval '1 second'
        WHERE id=$1`,
      [transitionIds.kickoffIntentId],
    );
    const restarted = new ConversationPlanWorkflowService(transactions, {
      newId,
      now: () => new Date(now),
      resolveReviewModels: async () => ({
        pm: { provider: "anthropic", model: "claude-sonnet-5" },
        reviewer: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      runReviewNow: async () => undefined,
      executionKickoff: {
        kickoff: async () => {
          kickoffCalls += 1;
          return { started: false, detail: "Restart reconciliation refused safely." };
        },
      },
    });
    expect(await restarted.reconcileKickoffIntents()).toBe(1);
    releaseFirstKickoff();
    const approved = await approvalPromise;
    expect(approved.effect).toMatchObject({
      kind: "plan_approved",
      execution: {
        status: "refused",
        started: false,
        detail: "Restart reconciliation refused safely.",
      },
    });
    expect(kickoffCalls).toBe(2);

    const durable = await pg.query<{
      planning_status: string;
      execution_count: number | string;
      handoff_count: number | string;
      seed_count: number | string;
      intent_count: number | string;
      intent_status: string;
      attempt_count: number | string;
      package_count: number | string;
    }>(
      `SELECT
         (SELECT status FROM work_conversations WHERE id=$1) AS planning_status,
         (SELECT count(*) FROM work_conversations
           WHERE work_item_id=$2 AND kind='execution_pm') AS execution_count,
         (SELECT count(*) FROM conversation_handoffs WHERE work_item_id=$2) AS handoff_count,
         (SELECT count(*) FROM work_messages
           WHERE conversation_id=$3 AND sequence=1) AS seed_count,
         (SELECT count(*) FROM conversation_kickoff_intents WHERE work_item_id=$2)
           AS intent_count,
         (SELECT status FROM conversation_kickoff_intents WHERE id=$4) AS intent_status,
         (SELECT attempt_count FROM conversation_kickoff_intents WHERE id=$4) AS attempt_count,
         (SELECT count(*) FROM conversation_task_packages WHERE handoff_id=$5) AS package_count`,
      [
        scope.planningConversationId,
        scope.workItemId,
        transitionIds.executionConversationId,
        transitionIds.kickoffIntentId,
        transitionIds.handoffId,
      ],
    );
    expect(durable.rows[0]).toEqual({
      planning_status: "archived",
      execution_count: 1,
      handoff_count: 1,
      seed_count: 1,
      intent_count: 1,
      intent_status: "refused",
      attempt_count: 2,
      package_count: 2,
    });

    expect(JSON.stringify(scope.frozenQcContext)).not.toContain(sentinel);
    const handoff = await pg.query<{
      package: unknown;
      canonical_package: string;
      content_hash: string;
    }>("SELECT package, canonical_package, content_hash FROM conversation_handoffs WHERE id=$1", [
      transitionIds.handoffId,
    ]);
    const handoffPackage =
      typeof handoff.rows[0]?.package === "string"
        ? JSON.parse(handoff.rows[0].package)
        : handoff.rows[0]?.package;
    expect(JSON.stringify(handoffPackage)).not.toContain(sentinel);
    expect(handoffPackage).toMatchObject({
      approved_plan_version_id: scope.planVersionId,
      objective: scope.candidate.plan.objective,
      task_sequence: ["api", "worker"],
      required_mockup_artifact_ids: [scope.artifactId],
      artifact_ids: [scope.artifactId],
    });
    expect(handoff.rows[0]?.content_hash).toBe(canonicalSha256(handoffPackage));
    expect(
      JSON.parse(required(handoff.rows[0], "missing durable handoff").canonical_package),
    ).toEqual(handoffPackage);

    const packages = await pg.query<{
      package: unknown;
      content_hash: string;
    }>(
      `SELECT package, content_hash FROM conversation_task_packages
        WHERE handoff_id=$1 ORDER BY module_id`,
      [transitionIds.handoffId],
    );
    expect(JSON.stringify(packages.rows)).not.toContain(sentinel);
    expect(packages.rows.map((row) => canonicalSha256(row.package))).toEqual(
      packages.rows.map((row) => row.content_hash),
    );
    await expect(
      pg.query("UPDATE conversation_handoffs SET package='{}'::jsonb WHERE id=$1", [
        transitionIds.handoffId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pg.query("DELETE FROM conversation_task_packages WHERE handoff_id=$1", [
        transitionIds.handoffId,
      ]),
    ).rejects.toThrow(/immutable/);

    const compacted = await pg.query<{
      version: number | string;
      summary: unknown;
      content_hash: string;
      source_message_ids: unknown;
      canonical_source_messages: unknown;
      canonical_summary: string;
    }>(
      `SELECT summary.version, summary.summary, summary.content_hash,
              receipt.source_message_ids, receipt.canonical_source_messages,
              receipt.canonical_summary
         FROM conversation_summaries summary
         JOIN conversation_compaction_receipts receipt ON receipt.summary_id=summary.id
        WHERE summary.conversation_id=$1`,
      [scope.planningConversationId],
    );
    expect(compacted.rows[0]).toMatchObject({ version: 1 });
    expect(compacted.rows[0]?.summary).toMatchObject({
      objective: scope.candidate.plan.objective,
      artifact_ids: [scope.artifactId],
    });
    expect(JSON.stringify(compacted.rows[0]?.canonical_source_messages)).toContain(
      scope.artifactId,
    );
    expect(JSON.stringify(compacted.rows[0]?.canonical_source_messages)).toContain("image/png");
    expect(
      JSON.parse(required(compacted.rows[0], "missing compaction receipt").canonical_summary),
    ).toEqual(compacted.rows[0]?.summary);
    expect(compacted.rows[0]?.content_hash).toBe(canonicalSha256(compacted.rows[0]?.summary));

    const trigger = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: transitionIds.executionConversationId,
      client_message_id: "phase4-restart-context-trigger",
      parts: [{ type: "text", format: "plain", text: "Begin execution." }],
    });
    const assembled = await new ConversationContextAssembler(transactions).assemble(
      projectId,
      scope.workItemId,
      transitionIds.executionConversationId,
      trigger.id,
    );
    expect(JSON.stringify(assembled)).not.toContain(sentinel);
    expect(assembled.manifest.entries.filter((entry) => entry.kind === "handoff")).toHaveLength(1);
    expect(assembled.manifest.estimated_tokens).toBeGreaterThan(0);
    expect(assembled.context_hash).toBe(canonicalSha256(assembled.manifest));
  });

  it("authorizes, bounds, audits, and idempotently projects explicit planning excerpts", async () => {
    const scope = await approvalReady("excerpt", 21);
    const approved = await workflow.confirm(owner.id, scope.confirmation);
    if (approved.effect.kind !== "plan_approved") throw new Error("expected approval effect");
    const approvedHandoffId = approved.effect.handoff_id;
    const executionConversationId = required(
      approved.effect.execution_conversation_id,
      "missing excerpt execution conversation",
    );
    const firstSourceMessageId = required(
      scope.sourceMessageIds[0],
      "missing first planning message",
    );
    const secondSourceMessageId = required(
      scope.sourceMessageIds[1],
      "missing second planning message",
    );

    await expect(
      execution.createPlanningExcerpt(
        outsider.id,
        projectId,
        scope.workItemId,
        executionConversationId,
        {
          idempotency_key: "phase4-outsider-excerpt",
          source_conversation_id: scope.planningConversationId,
          message_ids: [firstSourceMessageId],
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      execution.createPlanningExcerpt(
        owner.id,
        otherProjectId,
        scope.workItemId,
        executionConversationId,
        {
          idempotency_key: "phase4-cross-project-excerpt",
          source_conversation_id: scope.planningConversationId,
          message_ids: [firstSourceMessageId],
        },
      ),
    ).rejects.toMatchObject({ code: "conversation_not_found" });
    await expect(
      execution.createPlanningExcerpt(
        owner.id,
        projectId,
        scope.workItemId,
        executionConversationId,
        {
          idempotency_key: "phase4-too-many-excerpts",
          source_conversation_id: scope.planningConversationId,
          message_ids: scope.sourceMessageIds,
        },
      ),
    ).rejects.toThrow();

    const excerptInput = {
      idempotency_key: "phase4-explicit-excerpt",
      source_conversation_id: scope.planningConversationId,
      message_ids: [firstSourceMessageId, secondSourceMessageId],
    };
    const excerpt = await execution.createPlanningExcerpt(
      owner.id,
      projectId,
      scope.workItemId,
      executionConversationId,
      excerptInput,
    );
    expect(
      await execution.createPlanningExcerpt(
        owner.id,
        projectId,
        scope.workItemId,
        executionConversationId,
        excerptInput,
      ),
    ).toEqual(excerpt);
    const receiptCount = await pg.query<{ receipts: number | string; messages: number | string }>(
      `SELECT
         (SELECT count(*) FROM conversation_planning_excerpt_receipts
           WHERE target_conversation_id=$1) AS receipts,
         (SELECT count(*) FROM work_messages
           WHERE conversation_id=$1
             AND parts::text LIKE '%planning_excerpt%') AS messages`,
      [executionConversationId],
    );
    expect(receiptCount.rows[0]).toEqual({ receipts: 1, messages: 1 });

    const afterExcerpt = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: executionConversationId,
      client_message_id: "phase4-excerpt-context-trigger",
      parts: [{ type: "text", format: "plain", text: "Use the requested excerpt." }],
    });
    const context = await new ConversationContextAssembler(transactions).assemble(
      projectId,
      scope.workItemId,
      executionConversationId,
      afterExcerpt.id,
    );
    expect(
      context.manifest.entries.filter((entry) => entry.kind === "planning_excerpt"),
    ).toHaveLength(1);
    expect(context.system.split(sentinel)).toHaveLength(2);

    const source = await pg.query<{
      sequence: number | string;
      role: string;
      parts: unknown;
    }>("SELECT sequence, role, parts FROM work_messages WHERE id=$1", [firstSourceMessageId]);
    await expect(
      transactions.transaction(async (tx) => {
        const forgedReceiptId = newId("forged_excerpt");
        const forgedMessageId = newId("message");
        const sequence = required(
          (
            await tx.query<{ sequence: number | string }>(
              `UPDATE work_conversations
                  SET next_message_sequence=next_message_sequence+1
                WHERE id=$1 RETURNING next_message_sequence-1 AS sequence`,
              [executionConversationId],
            )
          ).rows[0],
          "missing forged message sequence",
        ).sequence;
        await tx.query(
          `INSERT INTO work_messages (
             id, project_id, work_item_id, conversation_id, initiated_by_user_id,
             actor_type, actor_id, role, visibility_status, sequence, parts
           ) VALUES (
             $1,$2,$3,$4,$5,'system',NULL,'system','complete',$6,$7::jsonb
           )`,
          [
            forgedMessageId,
            projectId,
            scope.workItemId,
            executionConversationId,
            owner.id,
            Number(sequence),
            JSON.stringify([{ type: "planning_excerpt", excerpt_receipt_id: forgedReceiptId }]),
          ],
        );
        const sourceMessage = required(source.rows[0], "missing excerpt source message");
        const canonical = {
          sequence: Number(sourceMessage.sequence),
          role: sourceMessage.role,
          parts: sourceMessage.parts,
        };
        await tx.query(
          `INSERT INTO conversation_planning_excerpt_receipts (
             id, project_id, work_item_id, source_conversation_id,
             target_conversation_id, handoff_id, requested_by_user_id,
             idempotency_key, request_fingerprint, source_message_ids,
             source_message_hashes, canonical_source_messages,
             result_message_id
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13
           )`,
          [
            forgedReceiptId,
            projectId,
            scope.workItemId,
            scope.planningConversationId,
            executionConversationId,
            approvedHandoffId,
            owner.id,
            "phase4-forged-excerpt",
            canonicalSha256({ forged: true }),
            JSON.stringify([firstSourceMessageId]),
            JSON.stringify(["f".repeat(64)]),
            JSON.stringify([JSON.stringify(canonical)]),
            forgedMessageId,
          ],
        );
      }),
    ).rejects.toThrow(/planning excerpt receipt must bind exact linked complete messages/);
    expect(
      (
        await pg.query<{ count: number | string }>(
          "SELECT count(*) AS count FROM conversation_planning_excerpt_receipts WHERE id LIKE 'forged_excerpt-%'",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("reports exact, pending, and unavailable conversation usage from the same durable attempts", async () => {
    const scope = await approvalReady("usage");
    const approved = await workflow.confirm(owner.id, scope.confirmation);
    if (approved.effect.kind !== "plan_approved") throw new Error("expected approval effect");
    const executionConversationId = required(
      approved.effect.execution_conversation_id,
      "missing usage execution conversation",
    );
    expect(
      await execution.detail(owner.id, projectId, scope.workItemId, executionConversationId),
    ).toMatchObject({
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        exact_cost: true,
        usage_status: "exact",
        attempt_count: 0,
      },
    });

    const turns = new ConversationTurnRepository(transactions);
    const firstTrigger = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: executionConversationId,
      client_message_id: "phase4-usage-first",
      parts: [{ type: "text", format: "plain", text: "Measure this turn." }],
    });
    const manifest = { entries: [], estimated_tokens: 0 };
    const firstUsageRequestId = "phase4-usage-request-exact";
    await pg.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, usage_source, confidence,
         cost_classification
       ) VALUES (
         'phase4-usage-start-exact',$1,1,'request_started','started',now(),
         'anthropic','claude-sonnet-5','messages','conversation_turn',0,
         $2,$3,'provider_api',1,'unavailable'
       )`,
      [firstUsageRequestId, owner.id, projectId],
    );
    await turns.begin({
      attemptId: "phase4-attempt-exact",
      usageRequestId: firstUsageRequestId,
      projectId,
      workItemId: scope.workItemId,
      conversationId: executionConversationId,
      initiatedByUserId: owner.id,
      triggeringMessageId: firstTrigger.id,
      provider: "anthropic",
      model: "claude-sonnet-5",
      manifest,
      contextHash: canonicalSha256(manifest),
      startedAt: now,
    });
    await turns.markDispatched("phase4-attempt-exact", "provider-phase4-exact");
    await turns.startVisibleOutput(
      "phase4-attempt-exact",
      "phase4-output-exact",
      "Visible exact result.",
    );
    await turns.succeed(
      "phase4-attempt-exact",
      "phase4-output-exact",
      "Visible exact result.",
      "provider-phase4-exact",
      "stop",
      {
        id: "phase4-usage-event-exact",
        provider: "anthropic",
        model: "claude-sonnet-5",
        project_id: projectId,
        node_id: null,
        run_id: null,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        estimated_cost_usd: 0.0125,
        actual_cost_usd: 0.0125,
        usage_source: "provider_api",
        pricing_version: "test-v1",
        occurred_at: now,
      },
    );
    expect(await execution.usageByWorkItem(owner.id, projectId, [executionConversationId])).toEqual(
      {
        [executionConversationId]: {
          input_tokens: 120,
          output_tokens: 30,
          cost_usd: 0.0125,
          exact_cost: true,
          usage_status: "exact",
          attempt_count: 1,
        },
      },
    );

    const secondTrigger = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: executionConversationId,
      client_message_id: "phase4-usage-second",
      parts: [{ type: "text", format: "plain", text: "Leave this turn pending." }],
    });
    await pg.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at,
         provider, model, endpoint, request_type, retry_attempt,
         initiated_by_user_id, project_id, usage_source, confidence,
         cost_classification
       ) VALUES (
         'phase4-usage-start-pending','phase4-usage-request-pending',1,
         'request_started','started',now(),'anthropic','claude-sonnet-5',
         'messages','conversation_turn',0,$1,$2,'provider_api',1,'unavailable'
       )`,
      [owner.id, projectId],
    );
    await turns.begin({
      attemptId: "phase4-attempt-pending",
      usageRequestId: "phase4-usage-request-pending",
      projectId,
      workItemId: scope.workItemId,
      conversationId: executionConversationId,
      initiatedByUserId: owner.id,
      triggeringMessageId: secondTrigger.id,
      provider: "anthropic",
      model: "claude-sonnet-5",
      manifest,
      contextHash: canonicalSha256(manifest),
      startedAt: now,
    });
    expect(
      (await execution.detail(owner.id, projectId, scope.workItemId, executionConversationId))
        .usage,
    ).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cost_usd: null,
      exact_cost: false,
      usage_status: "pending",
      attempt_count: 2,
    });
    expect(await execution.usageByWorkItem(owner.id, projectId, [executionConversationId])).toEqual(
      {
        [executionConversationId]: {
          input_tokens: 120,
          output_tokens: 30,
          cost_usd: null,
          exact_cost: false,
          usage_status: "pending",
          attempt_count: 2,
        },
      },
    );
    await turns.fail("phase4-attempt-pending", null, "", {
      usageStatus: "unavailable",
      code: "provider_failed",
      messageRedacted: "Provider failed.",
      sanitized: null,
    });
    expect(
      (await execution.detail(owner.id, projectId, scope.workItemId, executionConversationId))
        .usage,
    ).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cost_usd: null,
      exact_cost: false,
      usage_status: "unavailable",
      attempt_count: 2,
    });
    expect(await execution.usageByWorkItem(owner.id, projectId, [executionConversationId])).toEqual(
      {
        [executionConversationId]: {
          input_tokens: 120,
          output_tokens: 30,
          cost_usd: null,
          exact_cost: false,
          usage_status: "unavailable",
          attempt_count: 2,
        },
      },
    );
  });
});

describe.sequential("conversation-first Phase 4 legacy compatibility", () => {
  let legacy: PGlite;

  beforeAll(async () => {
    legacy = new PGlite();
    await legacy.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(legacy as unknown as V2MigrationDatabase);
    await legacy.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'phase4-legacy-owner','phase4-legacy@example.com','Legacy Owner',
        'phase4-legacy@example.com','Legacy Owner','hash','scrypt-v1',
        'member','active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'phase4-legacy-project','Legacy Project','active',
        'assignment/default','verification/default','budget/default',
        'phase4-legacy-owner'
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await legacy.close();
  });

  it("keeps a pre-0038 approval effect readable without fabricating transition IDs", async () => {
    let legacyId = 0;
    const transactions = new PGliteTransactionRunner(legacy);
    const conversations = new ConversationService(
      new PostgresConversationRepository(transactions),
      { newId: (prefix) => `${prefix}-phase4-legacy-${++legacyId}` },
    );
    const workflow = new ConversationPlanWorkflowService(transactions, {
      newId: (prefix) => `${prefix}-phase4-legacy-${++legacyId}`,
      now: () => new Date(now),
      resolveReviewModels: async () => ({
        pm: { provider: "anthropic", model: "claude-sonnet-5" },
        reviewer: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      runReviewNow: async () => undefined,
    });
    const created = await conversations.createPlanningWorkspace(
      { id: "phase4-legacy-owner" },
      {
        project_id: "phase4-legacy-project",
        title: "Legacy approved work",
        objective: "Remain readable after 0038.",
      },
      { provider: "anthropic", model: "claude-sonnet-5" },
    );
    const source = await conversations.submitUserMessage(
      { id: "phase4-legacy-owner" },
      {
        project_id: "phase4-legacy-project",
        work_item_id: created.work_item.id,
        conversation_id: created.conversation.id,
        client_message_id: "phase4-legacy-message",
        parts: [{ type: "text", format: "plain", text: "Approve this legacy work." }],
      },
    );
    const candidate = plan("Remain readable after 0038.");
    const save = await conversations.proposeAction(
      { id: "phase4-legacy-owner" },
      {
        project_id: "phase4-legacy-project",
        work_item_id: created.work_item.id,
        conversation_id: created.conversation.id,
        source_message_id: source.id,
        action_type: "save_plan_candidate",
        payload: {
          parameters: {
            plan: candidate,
            predecessor_plan_version_id: null,
            predecessor_content_hash: null,
            referenced_artifacts: [],
          },
        },
      },
    );
    const saved = await workflow.confirm("phase4-legacy-owner", {
      project_id: "phase4-legacy-project",
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: save.id,
      idempotency_key: "phase4-legacy-save",
    });
    if (saved.effect.kind !== "plan_saved") throw new Error("expected legacy saved plan");
    const detail = await workflow.detail(
      "phase4-legacy-owner",
      "phase4-legacy-project",
      created.work_item.id,
      created.conversation.id,
    );
    const qcAction = required(
      detail.actions.find(
        (action) => action.action_type === "send_plan_to_qc" && action.status === "proposed",
      ),
      "missing legacy QC action",
    );
    const qc = await workflow.confirm("phase4-legacy-owner", {
      project_id: "phase4-legacy-project",
      work_item_id: created.work_item.id,
      conversation_id: created.conversation.id,
      action_id: qcAction.id,
      idempotency_key: "phase4-legacy-qc",
    });
    if (qc.effect.kind !== "qc_started") throw new Error("expected legacy QC");
    const seed = await workflow.loadReviewOnlySeed(qc.effect.planning_run_id);
    await workflow.markReviewOnlyStarted(seed.reviewId);
    await workflow.completeReviewOnly({
      reviewId: seed.reviewId,
      planningRunId: qc.effect.planning_run_id,
      result: {
        status: "converged",
        rounds: 1,
        seed_plan: candidate,
        final_plan: candidate,
        result_plan_content_hash: canonicalSha256(candidate),
        review_rounds: [
          {
            round: 1,
            reviewed_plan: candidate,
            findings: [],
            responses: null,
          },
        ],
        usage: [],
      },
      totalCostUsd: 0,
    });
    const ready = await workflow.detail(
      "phase4-legacy-owner",
      "phase4-legacy-project",
      created.work_item.id,
      created.conversation.id,
    );
    const approval = required(
      ready.actions.find(
        (action) => action.action_type === "approve_plan" && action.status === "proposed",
      ),
      "missing legacy approval action",
    );
    // Migration 0038 retains approval effects created before transition IDs
    // existed. Recreate that retained shape so the current reader must project it.
    await legacy.exec(`
      ALTER TABLE conversation_plan_action_effects
        DROP CONSTRAINT conversation_plan_action_effects_transition_shape_check;
      DROP TRIGGER conversation_plan_action_effects_transition_guard
        ON conversation_plan_action_effects;
    `);
    await legacy.query(
      `UPDATE work_plan_versions
          SET status='approved', approved_by_user_id=$2, approved_at=$3, updated_at=$3
        WHERE id=$1`,
      [saved.effect.plan_version.id, "phase4-legacy-owner", now],
    );
    await legacy.query(
      `UPDATE planning_runs
          SET status='approved', decision=$2::jsonb, updated_at=$3
        WHERE id=$1`,
      [
        qc.effect.planning_run_id,
        JSON.stringify({
          decision: "approve",
          direction: null,
          staffing: [
            {
              node_id: "api",
              provider: "openai",
              model: "gpt-5.6-sol",
              reasoning_effort: null,
            },
            {
              node_id: "worker",
              provider: "anthropic",
              model: "claude-sonnet-5",
              reasoning_effort: null,
            },
          ],
          decided_at: now,
        }),
        now,
      ],
    );
    await legacy.query(
      `UPDATE conversation_actions
          SET status='confirmed', confirmed_by_user_id=$2,
              confirmation_idempotency_key='phase4-legacy-approval',
              confirmation_request_fingerprint=$3,
              confirmed_at=$4, updated_at=$4
        WHERE id=$1`,
      [approval.id, "phase4-legacy-owner", canonicalSha256({ legacy: true }), now],
    );
    await legacy.query(
      "UPDATE conversation_actions SET status='recorded', recorded_at=$2, updated_at=$2 WHERE id=$1",
      [approval.id, now],
    );
    await legacy.query(
      "UPDATE conversation_actions SET status='sent', sent_at=$2, updated_at=$2 WHERE id=$1",
      [approval.id, now],
    );
    await legacy.query(
      "UPDATE conversation_actions SET status='agent_acknowledged', acknowledged_at=$2, updated_at=$2 WHERE id=$1",
      [approval.id, now],
    );
    await legacy.query(
      "UPDATE conversation_actions SET status='applied', applied_at=$2, updated_at=$2 WHERE id=$1",
      [approval.id, now],
    );
    await legacy.query(
      `INSERT INTO conversation_plan_action_effects (
         id, project_id, work_item_id, conversation_id, action_id, effect_kind,
         plan_version_id, plan_review_id, planning_run_id, execution_status,
         execution_started, execution_detail, created_at, updated_at
       ) VALUES (
         'phase4-legacy-effect','phase4-legacy-project',$1,$2,$3,
         'plan_approved',$4,$5,$6,'refused',FALSE,
         'Legacy execution had no conversation handoff.',$7,$7
       )`,
      [
        created.work_item.id,
        created.conversation.id,
        approval.id,
        saved.effect.plan_version.id,
        seed.reviewId,
        qc.effect.planning_run_id,
        now,
      ],
    );

    const upgraded = new ConversationPlanWorkflowService(transactions, {
      newId: (prefix) => `${prefix}-phase4-upgraded-${++legacyId}`,
      now: () => new Date(now),
      resolveReviewModels: async () => ({
        pm: { provider: "anthropic", model: "claude-sonnet-5" },
        reviewer: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      runReviewNow: async () => undefined,
    });
    const upgradedDetail = await upgraded.detail(
      "phase4-legacy-owner",
      "phase4-legacy-project",
      created.work_item.id,
      created.conversation.id,
    );
    const legacyApprovalEffect = upgradedDetail.action_effects.find(
      (candidate) => candidate.action_id === approval.id,
    );
    expect(legacyApprovalEffect?.effect).toMatchObject({
      kind: "plan_approved",
      transition_status: "legacy_unavailable",
      execution_conversation_id: null,
      handoff_id: null,
      kickoff_intent_id: null,
      execution: {
        status: "refused",
        started: false,
        detail: "Legacy execution had no conversation handoff.",
      },
    });
  }, 60_000);
});
