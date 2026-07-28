import { PGlite } from "@electric-sql/pglite";
import { FakeAdapter, type LlmAdapter } from "@norns/adapters";
import {
  type V2ConversationActionT,
  V2SavePlanCandidateParameters,
  V2WorkPlanContract,
  type V2WorkPlanContractT,
} from "@norns/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConversationActionCheckpointWorker } from "../src/conversations/actionDelivery.js";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import { ExecutionConversationService } from "../src/conversations/executionConversation.js";
import { ConversationHumanSteeringService } from "../src/conversations/humanSteering.js";
import { ConversationPlanChangeProposalService } from "../src/conversations/planChangeProposal.js";
import { ConversationPlanProposalService } from "../src/conversations/planProposal.js";
import {
  type ConversationPlanReviewModels,
  ConversationPlanWorkflowService,
} from "../src/conversations/planWorkflow.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { PhaseLaunchService } from "../src/coordinator/phaseLaunchService.js";
import { RelationalTaskContextAssembler, TaskContextStore } from "../src/execution/index.js";
import { canonicalJson, canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  Phase6MockupService,
  Phase6MockupWorker,
  Phase6VisualEvidenceService,
  renderDeterministicMockup,
} from "../src/phase6/index.js";
import { ExecutionKickoffService } from "../src/planning/executionKickoff.js";
import type { ReviewOnlyPlanningResult } from "../src/planning/reviewOnlySession.js";
import type { ApprovedPlanExecutionKickoffInput } from "../src/planning/runService.js";
import { PhaseWorkflowService } from "../src/projects/phaseWorkflowService.js";
import { StrategyBridgeService } from "../src/projects/strategyBridgeService.js";
import { StrategyWorkflowService } from "../src/projects/strategyWorkflowService.js";
import { RelayStores } from "../src/stores.js";

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
  let executionConversations: ExecutionConversationService;
  let proposalAdapter: LlmAdapter;
  let idSequence = 0;
  let dispatches: string[];
  let kickoffInputs: ApprovedPlanExecutionKickoffInput[];
  let kickoff: (
    input: ApprovedPlanExecutionKickoffInput,
  ) => Promise<{ started: boolean; detail: string }>;
  let approvalFailureAt: string | null;
  let failKickoffClaim: boolean;
  let failKickoffSettlement: boolean;

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
      approvalTransitionCheckpoint: (checkpoint) => {
        if (checkpoint === approvalFailureAt) {
          throw new Error(`injected approval failure at ${checkpoint}`);
        }
      },
      kickoffDispatchCheckpoint: () => {
        if (failKickoffClaim) throw new Error("injected kickoff claim failure");
      },
      kickoffSettlementCheckpoint: () => {
        if (failKickoffSettlement) throw new Error("injected kickoff settlement failure");
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
    executionConversations = new ExecutionConversationService(transactions, {
      newId,
      now: () => new Date("2026-07-27T16:00:00.000Z"),
    });
  }, 60_000);

  beforeEach(() => {
    dispatches = [];
    kickoffInputs = [];
    kickoff = async () => ({ started: false, detail: "test refused execution" });
    approvalFailureAt = null;
    failKickoffClaim = false;
    failKickoffSettlement = false;
    proposalAdapter = new FakeAdapter("anthropic", "claude-sonnet-5");
  });

  afterAll(async () => {
    await pg.close();
  });

  async function workspace(label: string, withArtifact = false, withAttachment = false) {
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
    const attachmentId = withAttachment ? `attachment-${label}` : null;
    const attachmentHash = "d".repeat(64);
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
    if (attachmentId) {
      await pg.query(
        `INSERT INTO attachment_blobs (sha256, content)
         VALUES ($1,$2)`,
        [attachmentHash, Buffer.from("phase4-image-bytes")],
      );
      await pg.query(
        `INSERT INTO attachments (
           id, project_id, sha256, mime, bytes, width, height, purpose, created_by
         ) VALUES ($1,$2,$3,'image/png',$4,20,20,'conversation',$5)`,
        [attachmentId, projectId, attachmentHash, 18, owner.id],
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
          text: `${["isolated-qc", "production-package"].includes(label) ? "PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD " : ""}BRAINSTORM-${label}: compare several abandoned approaches before planning.`,
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
        ...(attachmentId
          ? [
              {
                type: "attachment" as const,
                attachment_id: attachmentId,
                name: "approved-interface.png",
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
      attachmentId,
      attachmentHash,
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

  async function reviewReady(
    scope: { workItemId: string; conversationId: string },
    candidate: V2WorkPlanContractT,
    key: string,
  ) {
    const saved = await proposeAndSave(scope, candidate, key);
    const qcAction = await proposedAction(scope, "send_plan_to_qc");
    const qc = await workflow.confirm(owner.id, confirmation(scope, qcAction.id, `${key}-qc`));
    if (qc.effect.kind !== "qc_started") throw new Error("expected QC effect");
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
    const approval = await proposedAction(scope, "approve_plan");
    return { saved, qc, seed, approval };
  }

  async function productionExecutionKickoff(): Promise<{
    kickoff: ExecutionKickoffService;
    coordinator: Phase4Coordinator;
    assembler: RelationalTaskContextAssembler;
  }> {
    const bindingId = "conversation-package-binding";
    const runnerId = "conversation-package-runner";
    await pg.query(
      `INSERT INTO repository_bindings (
         id, project_id, binding_type, status, runner_id, workspace_id,
         repository_id, repository_display_name, granted_permissions,
         default_branch, observed_head, verification_policy_ref,
         repository_health, created_by_actor_type, created_by_actor_id
       ) VALUES (
         $1,$2,'local_runner','connected',$3,'conversation-workspace',
         'conversation-repository','Conversation repository','{}'::jsonb,
         'main','conversation-head','verification/strict','healthy','human',$4
       ) ON CONFLICT (id) DO NOTHING`,
      [bindingId, projectId, runnerId, owner.id],
    );
    await pg.query("UPDATE projects SET primary_repository_binding_id=$1 WHERE id=$2", [
      bindingId,
      projectId,
    ]);
    await pg.query(
      `INSERT INTO artifacts (
         id, project_id, kind, label, media_type, storage_ref, content_hash, byte_size,
         provenance_actor_type, provenance_actor_id, redaction_status
       ) VALUES (
         'conversation-package-architecture-artifact',$1,'architecture',
         'Conversation architecture','text/markdown','https://example.com/architecture',
         $2,10,'human',$3,'reviewed'
       ) ON CONFLICT (id) DO NOTHING`,
      [projectId, "e".repeat(64), owner.id],
    );
    await pg.query(
      `INSERT INTO architecture_revisions (
         id, project_id, revision, title, summary, architecture_artifact_id,
         repository_revision, provenance_actor_type, provenance_actor_id
       ) VALUES (
         'conversation-package-architecture',$1,1,'Monorepo',
         'pnpm workspace','conversation-package-architecture-artifact',
         'conversation-head','human',$2
       ) ON CONFLICT (id) DO NOTHING`,
      [projectId, owner.id],
    );
    await pg.query("UPDATE projects SET current_architecture_revision_id=$1 WHERE id=$2", [
      "conversation-package-architecture",
      projectId,
    ]);
    for (const [key, value] of [
      ["build_command", "pnpm build"],
      ["test_command", "pnpm test"],
      ["lint_command", "pnpm biome check ."],
    ] as const) {
      await pg.query(
        `INSERT INTO project_memory_entries (
           id, project_id, category, content, provenance, confidence,
           version, status
         ) VALUES ($1,$2,'repository_fact',$3,'repository_ingestion',1,1,'active')
         ON CONFLICT (id) DO NOTHING`,
        [`conversation-package-${key}`, projectId, `${key}: ${value}`],
      );
    }
    await pg.query(
      `INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, source_ref, confidence,
         version, status, approved_by_human, approved_by, approved_at
       ) VALUES (
         'conversation-package-rule',$1,'directive',
         'PACKAGE_RULE_SENTINEL: verify the immutable package.',
         'project_rules','{"kind":"project_rules_file"}'::jsonb,1,1,'active',
         true,$2,'2026-07-27T15:00:00Z'
       ) ON CONFLICT (id) DO NOTHING`,
      [projectId, owner.id],
    );
    const stores = new RelayStores();
    stores.registerRunner(runnerId, "test-public-key");
    const coordinator = new Phase4Coordinator(transactions);
    const assembler = new RelationalTaskContextAssembler(
      transactions,
      new TaskContextStore(transactions),
      { baseUrl: "https://norns.example.com" },
    );
    const phaseLaunch = new PhaseLaunchService(
      transactions,
      coordinator,
      assembler,
      new DispatchContextScopeRepository(transactions),
      (id) => {
        const runner = stores.runner(id);
        return runner
          ? { runner_id: runner.runner_id, runner_generation: runner.generation }
          : null;
      },
    );
    const bridge = new StrategyBridgeService({
      transactions,
      phases: new PhaseWorkflowService(transactions),
      strategies: new StrategyWorkflowService(transactions),
    });
    return {
      kickoff: new ExecutionKickoffService({ transactions, bridge, phaseLaunch }),
      coordinator,
      assembler,
    };
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

  it("extracts the agreed plan and durably binds the selected handoff", async () => {
    const scope = await workspace("natural-plan-handoff");
    const adapter = proposalAdapter as FakeAdapter;
    adapter.enqueue(plan("Use the agreed conversation as the plan"));
    const handoff = {
      execution_agent: {
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
      review: {
        mode: "qc",
        reviewer: {
          provider: "openai",
          model: "gpt-5.6-terra",
        },
        rounds: 2,
      },
    } as const;
    const request = {
      idempotency_key: "natural-plan-handoff",
      intent_message: "Use this as the plan.",
      handoff,
    };

    const first = await proposals.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      request,
    );
    const replay = await proposals.propose(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
      request,
    );

    expect(replay).toEqual(first);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.system).toContain(
      "Extract the latest agreed direction and explicit human decisions",
    );
    expect(adapter.requests[0]?.prompt).toContain(
      "anthropic:claude-sonnet-5 as the execution agent",
    );
    const proposedParameters = V2SavePlanCandidateParameters.parse(first.action.payload.parameters);
    expect(proposedParameters.plan.staffing).toEqual([
      {
        module_id: "conversation-api",
        agent_role: "implementation",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    ]);
    expect(proposedParameters.handoff).toEqual(handoff);
    const messages = await conversations.listMessages(
      owner,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    const intentMessages = messages.filter(
      (message) =>
        message.role === "user" &&
        message.parts.some((part) => part.type === "text" && part.text === "Use this as the plan."),
    );
    expect(intentMessages).toHaveLength(1);
    const attempt = await pg.query<{ source_message_id: string }>(
      `SELECT source_message_id
         FROM conversation_plan_proposal_attempts
        WHERE conversation_id=$1 AND idempotency_key=$2`,
      [scope.conversationId, request.idempotency_key],
    );
    expect(attempt.rows[0]?.source_message_id).toBe(intentMessages[0]?.id);

    const saved = await workflow.confirm(
      owner.id,
      confirmation(scope, first.action.id, "natural-plan-handoff-save"),
    );
    expect(saved.effect.kind).toBe("plan_saved");
    const sendToQc = await proposedAction(scope, "send_plan_to_qc");
    expect(sendToQc.payload.parameters.review).toEqual(handoff.review);
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
        handoffId:
          approved.effect.kind === "plan_approved" ? approved.effect.handoff_id : "missing-handoff",
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
      transition_status: "created",
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
    if (approved.effect.kind !== "plan_approved") throw new Error("expected approved effect");
    expect(approved.effect.execution_conversation_id).toBeTruthy();
    expect(approved.effect.handoff_id).toBeTruthy();
    expect(approved.effect.kickoff_intent_id).toBeTruthy();
    const transition = await pg.query<{
      planning_status: string;
      planning_archived_at: string | null;
      execution_kind: string;
      execution_status: string;
      seed_parts: unknown;
      handoff_package: unknown;
      kickoff_status: string;
      task_package_count: number | string;
      task_packages: unknown;
      summary_count: number | string;
    }>(
      `SELECT planning.status AS planning_status,
              planning.archived_at AS planning_archived_at,
              execution.kind AS execution_kind,
              execution.status AS execution_status,
              seed.parts AS seed_parts,
              handoff.package AS handoff_package,
              intent.status AS kickoff_status,
              (
                SELECT count(*) FROM conversation_task_packages package
                 WHERE package.handoff_id=handoff.id
              ) AS task_package_count,
              (
                SELECT coalesce(jsonb_agg(package.package ORDER BY package.module_id), '[]'::jsonb)
                  FROM conversation_task_packages package
                 WHERE package.handoff_id=handoff.id
              ) AS task_packages,
              (
                SELECT count(*) FROM conversation_compaction_receipts receipt
                 WHERE receipt.conversation_id=planning.id
              ) AS summary_count
         FROM work_conversations planning
         JOIN conversation_handoffs handoff
           ON handoff.source_conversation_id=planning.id
         JOIN work_conversations execution
           ON execution.id=handoff.target_conversation_id
         JOIN work_messages seed
           ON seed.conversation_id=execution.id AND seed.sequence=1
         JOIN conversation_kickoff_intents intent
           ON intent.handoff_id=handoff.id
        WHERE planning.id=$1`,
      [scope.conversationId],
    );
    expect(transition.rows[0]).toMatchObject({
      planning_status: "archived",
      execution_kind: "execution_pm",
      execution_status: "active",
      kickoff_status: "failed",
      task_package_count: 1,
      summary_count: 1,
    });
    expect(transition.rows[0]?.planning_archived_at).toBeTruthy();
    expect(JSON.stringify(transition.rows[0]?.seed_parts)).not.toContain(
      "PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD",
    );
    expect(JSON.stringify(transition.rows[0]?.handoff_package)).not.toContain(
      "PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD",
    );
    expect(JSON.stringify(transition.rows[0]?.task_packages)).not.toContain(
      "PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD",
    );
    const executionConversationId = approved.effect.execution_conversation_id;
    if (!executionConversationId) throw new Error("missing execution conversation");
    const executionPrompt = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: executionConversationId,
      client_message_id: "execution-context-sentinel-check",
      parts: [{ type: "text", format: "plain", text: "Begin the approved work." }],
    });
    const isolatedContext = await new ConversationContextAssembler(transactions).assemble(
      projectId,
      scope.workItemId,
      executionConversationId,
      executionPrompt.id,
    );
    expect(isolatedContext.manifest.entries[0]?.ref).toBe("execution-pm-v1");
    expect(JSON.stringify(isolatedContext)).not.toContain(
      "PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD",
    );
    const excerpt = await executionConversations.createPlanningExcerpt(
      owner.id,
      projectId,
      scope.workItemId,
      executionConversationId,
      {
        idempotency_key: "explicit-planning-excerpt",
        source_conversation_id: scope.conversationId,
        message_ids: [scope.initialMessageId],
      },
    );
    expect(excerpt.receipt.source_message_ids).toEqual([scope.initialMessageId]);
    const afterExcerpt = await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: executionConversationId,
      client_message_id: "execution-context-with-explicit-excerpt",
      parts: [{ type: "text", format: "plain", text: "Use that requested excerpt." }],
    });
    const explicitContext = await new ConversationContextAssembler(transactions).assemble(
      projectId,
      scope.workItemId,
      executionConversationId,
      afterExcerpt.id,
    );
    expect(JSON.stringify(explicitContext)).toContain(
      "PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD",
    );
    expect(
      explicitContext.manifest.entries.filter((entry) => entry.kind === "planning_excerpt"),
    ).toHaveLength(1);

    const durable = await pg.query<{
      handoff_package: unknown;
      task_package: unknown;
      planning_run_id: string;
      plan_review_id: string;
      approved_plan_version_id: string;
      source_message_ids: unknown;
      source_message_hashes: unknown;
      canonical_source_messages: unknown;
      result_message_id: string;
      summary_id: string;
      summary_source_ids: unknown;
      summary_source_hashes: unknown;
      summary_canonical_sources: unknown;
      canonical_summary: string;
    }>(
      `SELECT handoff.package AS handoff_package,
              task_package.package AS task_package,
              intent.planning_run_id, intent.plan_review_id,
              intent.approved_plan_version_id,
              excerpt.source_message_ids, excerpt.source_message_hashes,
              excerpt.canonical_source_messages, excerpt.result_message_id,
              compaction.summary_id,
              compaction.source_message_ids AS summary_source_ids,
              compaction.source_message_hashes AS summary_source_hashes,
              compaction.canonical_source_messages AS summary_canonical_sources,
              compaction.canonical_summary
         FROM conversation_handoffs handoff
         JOIN conversation_task_packages task_package
           ON task_package.handoff_id=handoff.id
         JOIN conversation_kickoff_intents intent ON intent.handoff_id=handoff.id
         JOIN conversation_planning_excerpt_receipts excerpt
           ON excerpt.handoff_id=handoff.id
         JOIN conversation_compaction_receipts compaction
           ON compaction.conversation_id=handoff.source_conversation_id
        WHERE handoff.id=$1`,
      [approved.effect.handoff_id],
    );
    const evidence = durable.rows[0];
    if (!evidence) throw new Error("missing Phase 4 durable evidence");
    const malformedHandoff = {
      ...(evidence.handoff_package as Record<string, unknown>),
      planning_transcript: "must never be embedded",
    };
    const malformedCanonical = canonicalJson(malformedHandoff);
    await expect(
      pg.query(
        `INSERT INTO conversation_handoffs (
           id, project_id, work_item_id, source_conversation_id,
           target_conversation_id, approved_plan_version_id, created_by_user_id,
           kind, package, canonical_package, content_hash
         ) VALUES (
           'malformed-handoff-phase4',$1,$2,$3,$4,$5,$6,
           'planning_to_execution',$7::jsonb,$8,$9
         )`,
        [
          projectId,
          scope.workItemId,
          scope.conversationId,
          executionConversationId,
          saved.id,
          owner.id,
          malformedCanonical,
          malformedCanonical,
          canonicalSha256(malformedHandoff),
        ],
      ),
    ).rejects.toThrow(/missing required structured transition evidence/);
    const malformedManifestHandoff = {
      ...(evidence.handoff_package as Record<string, unknown>),
      context_manifest: (
        (evidence.handoff_package as { context_manifest: Array<Record<string, unknown>> })
          .context_manifest ?? []
      ).map((reference, index) =>
        index === 0 ? { ...reference, hidden_prompt: "must be rejected" } : reference,
      ),
    };
    const malformedManifestCanonical = canonicalJson(malformedManifestHandoff);
    await expect(
      pg.query(
        `INSERT INTO conversation_handoffs (
           id, project_id, work_item_id, source_conversation_id,
           target_conversation_id, approved_plan_version_id, created_by_user_id,
           kind, package, canonical_package, content_hash
         ) VALUES (
           'malformed-manifest-handoff-phase4',$1,$2,$3,$4,$5,$6,
           'planning_to_execution',$7::jsonb,$8,$9
         )`,
        [
          projectId,
          scope.workItemId,
          scope.conversationId,
          executionConversationId,
          saved.id,
          owner.id,
          malformedManifestCanonical,
          malformedManifestCanonical,
          canonicalSha256(malformedManifestHandoff),
        ],
      ),
    ).rejects.toThrow(/manifest must uniquely bind the exact approved plan/);
    const leakyTaskPackage = {
      ...(evidence.task_package as Record<string, unknown>),
      planning_transcript: "must never reach a worker",
    };
    const leakyTaskCanonical = canonicalJson(leakyTaskPackage);
    await expect(
      pg.query(
        `INSERT INTO conversation_task_packages (
           id, project_id, work_item_id, conversation_id, handoff_id,
           approved_plan_version_id, module_id, package, canonical_package,
           content_hash
         ) VALUES (
           'leaky-task-package-phase4',$1,$2,$3,$4,$5,'conversation-api',
           $6::jsonb,$7,$8
         )`,
        [
          projectId,
          scope.workItemId,
          executionConversationId,
          approved.effect.handoff_id,
          saved.id,
          leakyTaskCanonical,
          leakyTaskCanonical,
          canonicalSha256(leakyTaskPackage),
        ],
      ),
    ).rejects.toThrow(/exact module-scoped handoff projection/);
    const badTaskPackage = {
      ...(evidence.task_package as Record<string, unknown>),
      module: {
        ...((evidence.task_package as { module: Record<string, unknown> }).module ?? {}),
        id: "arbitrary-module",
      },
      staffing: {
        ...((evidence.task_package as { staffing: Record<string, unknown> }).staffing ?? {}),
        module_id: "arbitrary-module",
      },
    };
    const badTaskCanonical = canonicalJson(badTaskPackage);
    await expect(
      pg.query(
        `INSERT INTO conversation_task_packages (
           id, project_id, work_item_id, conversation_id, handoff_id,
           approved_plan_version_id, module_id, package, canonical_package,
           content_hash
         ) VALUES (
           'bad-task-package-phase4',$1,$2,$3,$4,$5,'arbitrary-module',
           $6::jsonb,$7,$8
         )`,
        [
          projectId,
          scope.workItemId,
          executionConversationId,
          approved.effect.handoff_id,
          saved.id,
          badTaskCanonical,
          badTaskCanonical,
          canonicalSha256(badTaskPackage),
        ],
      ),
    ).rejects.toThrow(/exact module-scoped handoff projection/);
    await expect(
      pg.query(
        `INSERT INTO conversation_kickoff_intents (
           id, project_id, work_item_id, source_conversation_id,
           execution_conversation_id, action_id, approved_plan_version_id,
           plan_review_id, planning_run_id, handoff_id, decided_by_user_id
         ) VALUES (
           'bad-kickoff-intent-phase4',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10
         )`,
        [
          projectId,
          scope.workItemId,
          scope.conversationId,
          executionConversationId,
          approval.id,
          evidence.approved_plan_version_id,
          evidence.plan_review_id,
          evidence.planning_run_id,
          approved.effect.handoff_id,
          member.id,
        ],
      ),
    ).rejects.toThrow(/scope must equal its approved action/);
    const duplicateIds = [
      ...(evidence.source_message_ids as string[]),
      (evidence.source_message_ids as string[])[0],
    ];
    const duplicateHashes = [
      ...(evidence.source_message_hashes as string[]),
      (evidence.source_message_hashes as string[])[0],
    ];
    const duplicateCanonical = [
      ...(evidence.canonical_source_messages as string[]),
      (evidence.canonical_source_messages as string[])[0],
    ];
    const badExcerptSequence = await pg.query<{ sequence: number | string }>(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1
        WHERE id=$1
        RETURNING next_message_sequence-1 AS sequence`,
      [executionConversationId],
    );
    await pg.query(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, role, visibility_status, sequence, parts
       ) VALUES (
         'bad-excerpt-result-phase4',$1,$2,$3,$4,'system','system','complete',
         $5,$6::jsonb
       )`,
      [
        projectId,
        scope.workItemId,
        executionConversationId,
        owner.id,
        Number(badExcerptSequence.rows[0]?.sequence),
        JSON.stringify([
          {
            type: "planning_excerpt",
            excerpt_receipt_id: "bad-excerpt-phase4",
          },
        ]),
      ],
    );
    await expect(
      pg.query(
        `INSERT INTO conversation_planning_excerpt_receipts (
           id, project_id, work_item_id, source_conversation_id,
           target_conversation_id, handoff_id, requested_by_user_id,
           idempotency_key, request_fingerprint, source_message_ids,
           source_message_hashes, canonical_source_messages, result_message_id
         ) VALUES (
           'bad-excerpt-phase4',$1,$2,$3,$4,$5,$6,'bad-excerpt-key',$7,
           $8::jsonb,$9::jsonb,$10::jsonb,$11
         )`,
        [
          projectId,
          scope.workItemId,
          scope.conversationId,
          executionConversationId,
          approved.effect.handoff_id,
          owner.id,
          "a".repeat(64),
          JSON.stringify(duplicateIds),
          JSON.stringify(duplicateHashes),
          JSON.stringify(duplicateCanonical),
          "bad-excerpt-result-phase4",
        ],
      ),
    ).rejects.toThrow(/exact linked complete messages/);
    const summaryIds = evidence.summary_source_ids as string[];
    const summaryHashes = evidence.summary_source_hashes as string[];
    const summaryCanonical = evidence.summary_canonical_sources as string[];
    await expect(
      pg.query(
        `INSERT INTO conversation_compaction_receipts (
           id, project_id, work_item_id, conversation_id, summary_id, milestone,
           source_message_ids, source_message_hashes, canonical_source_messages,
           canonical_summary
         ) VALUES (
           'bad-compaction-phase4',$1,$2,$3,$4,'semantic_milestone',
           $5::jsonb,$6::jsonb,$7::jsonb,$8
         )`,
        [
          projectId,
          scope.workItemId,
          scope.conversationId,
          evidence.summary_id,
          JSON.stringify(summaryIds.slice(0, 1)),
          JSON.stringify(summaryHashes.slice(0, 1)),
          JSON.stringify(summaryCanonical.slice(0, 1)),
          evidence.canonical_summary,
        ],
      ),
    ).rejects.toThrow(/exact summary and complete source range/);
    const qcUsageRequestId = `${seed.reviewId}:review:1`;
    await pg.query(
      `INSERT INTO ai_usage_events (
         id, request_id, sequence, event_type, status, occurred_at, provider,
         model, endpoint, request_type, retry_group_id, retry_attempt,
         initiated_by_user_id, project_id, usage_source, confidence,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, cost_classification, adjusts_event_id
       ) VALUES
       (
         'phase4-qc-start',$1,1,'request_started','started',now(),'openai',
         'gpt-5.6-sol','responses','planning_review',$1,0,$2,$3,
         'provider_api',1,NULL,NULL,NULL,NULL,NULL,'unavailable',NULL
       ),
       (
         'phase4-qc-usage-old',$1,2,'usage_observed','in_progress',now(),'openai',
         'gpt-5.6-sol','responses','planning_review',$1,0,$2,$3,
         'provider_api',1,10,5,0,0,0.10,'actual',NULL
       ),
       (
         'phase4-qc-usage-latest',$1,3,'usage_observed','in_progress',now(),'openai',
         'gpt-5.6-sol','responses','planning_review',$1,0,$2,$3,
         'provider_api',1,20,6,0,0,0.20,'actual',NULL
       ),
       (
         'phase4-qc-adjustment',$1,4,'adjustment','adjusted',now(),'openai',
         'gpt-5.6-sol','responses','planning_review',$1,0,$2,$3,
         'manual_adjustment',1,2,1,0,0,0.03,'actual','phase4-qc-usage-latest'
       ),
       (
         'phase4-qc-complete',$1,5,'request_completed','succeeded',now(),'openai',
         'gpt-5.6-sol','responses','planning_review',$1,0,$2,$3,
         'provider_api',1,NULL,NULL,NULL,NULL,NULL,'unavailable',NULL
       )`,
      [qcUsageRequestId, owner.id, projectId],
    );
    const proposalUsage = await pg.query<{
      input_tokens: number | string;
      output_tokens: number | string;
      cost_usd: number | string;
    }>(
      `SELECT input_tokens, output_tokens, cost_usd
         FROM conversation_plan_proposal_attempts
        WHERE conversation_id=$1 AND status='succeeded'`,
      [scope.conversationId],
    );
    const usageDetail = await executionConversations.detail(
      owner.id,
      projectId,
      scope.workItemId,
      scope.conversationId,
    );
    expect(usageDetail.usage).toMatchObject({
      input_tokens: Number(proposalUsage.rows[0]?.input_tokens) + 22,
      output_tokens: Number(proposalUsage.rows[0]?.output_tokens) + 7,
      exact_cost: true,
      usage_status: "exact",
      attempt_count: 2,
    });
    expect(usageDetail.usage.cost_usd).toBeCloseTo(
      Number(proposalUsage.rows[0]?.cost_usd) + 0.23,
      9,
    );
    expect(
      await workflow.confirm(owner.id, confirmation(scope, approval.id, "approve-exact-qc-result")),
    ).toEqual(approved);
    expect(kickoffInputs).toHaveLength(1);
  });

  it("binds the real conversation package through kickoff, worker context, run, and dispatch", async () => {
    const scope = await workspace("production-package", false, true);
    const firstMessage = (
      await pg.query<{
        id: string;
        sequence: number | string;
        role: string;
        parts: unknown;
      }>(
        `SELECT id, sequence, role, parts FROM work_messages
          WHERE conversation_id=$1 ORDER BY sequence LIMIT 1`,
        [scope.conversationId],
      )
    ).rows[0];
    if (!firstMessage) throw new Error("missing planning message");
    const priorSummary = {
      objective: "Early semantic checkpoint",
      constraints: [],
      decisions: [],
      risks: [],
      open_questions: [],
      artifact_ids: scope.attachmentId ? [scope.attachmentId] : [],
    };
    const priorCanonicalMessage = canonicalJson({
      sequence: Number(firstMessage.sequence),
      role: firstMessage.role,
      parts: firstMessage.parts,
    });
    await pg.query(
      `INSERT INTO conversation_summaries (
         id, project_id, work_item_id, conversation_id, created_by_user_id,
         version, from_message_sequence, through_message_sequence,
         summary, content_hash
       ) VALUES (
         'production-prior-summary',$1,$2,$3,$4,1,$5,$5,$6::jsonb,$7
       )`,
      [
        projectId,
        scope.workItemId,
        scope.conversationId,
        owner.id,
        Number(firstMessage.sequence),
        JSON.stringify(priorSummary),
        canonicalSha256(priorSummary),
      ],
    );
    await pg.query(
      `INSERT INTO conversation_compaction_receipts (
         id, project_id, work_item_id, conversation_id, summary_id, milestone,
         source_message_ids, source_message_hashes, canonical_source_messages,
         canonical_summary
       ) VALUES (
         'production-prior-receipt',$1,$2,$3,'production-prior-summary',
         'semantic_milestone',$4::jsonb,$5::jsonb,$6::jsonb,$7
       )`,
      [
        projectId,
        scope.workItemId,
        scope.conversationId,
        JSON.stringify([firstMessage.id]),
        JSON.stringify([canonicalSha256(JSON.parse(priorCanonicalMessage))]),
        JSON.stringify([priorCanonicalMessage]),
        canonicalJson(priorSummary),
      ],
    );
    if (!scope.attachmentId) throw new Error("missing production image attachment");
    await conversations.submitUserMessage(owner, {
      project_id: projectId,
      work_item_id: scope.workItemId,
      conversation_id: scope.conversationId,
      client_message_id: "production-package-image-rereference",
      parts: [
        {
          type: "text",
          format: "markdown",
          text: "Use this approved image as an explicit implementation reference.",
        },
        {
          type: "attachment",
          attachment_id: scope.attachmentId,
          name: "approved-interface.png",
          media_type: "image/png",
        },
      ],
    });

    const real = await productionExecutionKickoff();
    kickoff = (input) => real.kickoff.kickoff(input);
    const ready = await reviewReady(scope, plan(), "production-package");
    if (ready.qc.effect.kind !== "qc_started") throw new Error("expected QC kickoff");
    const productionPlanningRunId = ready.qc.effect.planning_run_id;
    let mockupSequence = 0;
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-production-planning-${++mockupSequence}`,
    });
    const mockups = new Phase6MockupService(transactions);
    const createMockup = await steering.proposeAction(
      owner.id,
      {
        projectId,
        workItemId: scope.workItemId,
        conversationId: scope.conversationId,
      },
      {
        idempotency_key: "production-planning-mockup-create",
        message: "Render the exact conversation API module before implementation.",
        action_type: "create_mockup",
        payload: {
          parameters: {
            plan_version_id: ready.saved.id,
            module_id: "conversation-api",
            brief: "Show the approved conversation API module at both fixed viewports.",
            target: "responsive",
            artifact_refs: [],
          },
        },
      },
    );
    await steering.confirm(
      owner.id,
      confirmation(scope, createMockup.action.id, "production-planning-mockup-create-confirm"),
    );
    await expect(
      new ConversationActionCheckpointWorker(transactions, {
        workerId: "production-planning-mockup-checkpoint",
      }).tick(),
    ).resolves.toEqual({
      action_id: createMockup.action.id,
      state: "phase6_queued",
    });
    const mockupRenderer = new Phase6MockupWorker(transactions, mockups, {
      workerId: "production-planning-mockup-renderer",
    });
    const renderedMockup = await mockupRenderer.tick();
    expect(renderedMockup).toMatchObject({ status: "rendered" });
    if (!renderedMockup?.version_id) throw new Error("planning mockup did not render");
    const planningMockup = await mockups.version(
      projectId,
      scope.conversationId,
      renderedMockup.version_id,
    );
    expect(planningMockup).toMatchObject({
      plan_version_id: ready.saved.id,
      module_id: "conversation-api",
      task_id: null,
      status: "candidate",
    });
    const approveMockup = await steering.proposeAction(
      owner.id,
      {
        projectId,
        workItemId: scope.workItemId,
        conversationId: scope.conversationId,
      },
      {
        idempotency_key: "production-planning-mockup-approve",
        message: "Approve the exact planning mockup for implementation.",
        action_type: "approve_mockup",
        payload: {
          parameters: {
            mockup_version_id: planningMockup.id,
            plan_version_id: ready.saved.id,
            module_id: "conversation-api",
            manifest_artifact_id: planningMockup.manifest.artifact_id,
            manifest_artifact_hash: planningMockup.manifest.content_hash,
          },
        },
      },
    );
    await steering.confirm(
      owner.id,
      confirmation(scope, approveMockup.action.id, "production-planning-mockup-approve-confirm"),
    );
    await expect(
      new ConversationActionCheckpointWorker(transactions, {
        workerId: "production-planning-mockup-approval",
        phase6: mockups,
      }).tick(),
    ).resolves.toEqual({
      action_id: approveMockup.action.id,
      state: "applied",
    });
    failKickoffSettlement = true;
    await expect(
      workflow.confirm(
        owner.id,
        confirmation(scope, ready.approval.id, "production-package-approve"),
      ),
    ).rejects.toThrow("injected kickoff settlement failure");
    failKickoffSettlement = false;

    const pending = (
      await pg.query<{
        id: string;
        status: string;
        handoff_id: string;
        lease_token: string;
      }>(
        `SELECT id, status, handoff_id, lease_token
           FROM conversation_kickoff_intents
          WHERE work_item_id=$1`,
        [scope.workItemId],
      )
    ).rows[0];
    expect(pending).toMatchObject({ status: "leased" });
    if (!pending) throw new Error("missing leased kickoff intent");
    const beforeRecovery = await pg.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM agent_runs run
        JOIN phases phase ON phase.id=run.phase_id
       WHERE phase.planning_run_id=$1`,
      [productionPlanningRunId],
    );
    if (Number(beforeRecovery.rows[0]?.count) !== 1) {
      const diagnostics = await pg.query(
        `SELECT phase.id, phase.status, phase.planning_run_id,
                (SELECT count(*) FROM conversation_task_package_bindings binding
                  WHERE binding.phase_id=phase.id) AS package_bindings
           FROM phases phase WHERE phase.project_id=$1`,
        [projectId],
      );
      throw new Error(`kickoff did not dispatch: ${JSON.stringify(diagnostics.rows)}`);
    }
    await pg.query(
      `UPDATE conversation_kickoff_intents
          SET lease_expires_at='2020-01-01T00:00:00Z'
        WHERE id=$1`,
      [pending.id],
    );
    expect(await workflow.reconcileKickoffIntents()).toBeGreaterThanOrEqual(1);

    const afterRecovery = await pg.query<{
      status: string;
      execution_started: boolean;
      phase_id: string;
      attempt_count: number | string;
    }>(
      `SELECT status, execution_started, phase_id, attempt_count
         FROM conversation_kickoff_intents WHERE id=$1`,
      [pending.id],
    );
    expect(afterRecovery.rows[0]).toMatchObject({
      status: "succeeded",
      execution_started: true,
    });
    expect(Number(afterRecovery.rows[0]?.attempt_count)).toBe(2);
    expect(
      Number(
        (
          await pg.query<{ count: number | string }>(
            `SELECT count(*) AS count FROM agent_runs run
              JOIN phases phase ON phase.id=run.phase_id
             WHERE phase.planning_run_id=$1`,
            [productionPlanningRunId],
          )
        ).rows[0]?.count,
      ),
    ).toBe(1);

    const evidence = (
      await pg.query<{
        package_id: string;
        package: unknown;
        canonical_package: string;
        package_hash: string;
        task_id: string;
        work_item_id: string;
        execution_conversation_id: string;
        context_document_id: string;
        served_bytes: Buffer | Uint8Array;
        run_id: string;
        run_package_hash: string;
        command_id: string;
        dispatch_job_id: string;
        runner_id: string;
        runner_generation: number | string;
        envelope: Record<string, unknown>;
      }>(
        `SELECT package.id AS package_id, package.package,
                package.canonical_package, package.content_hash AS package_hash,
                package.work_item_id,package.conversation_id AS execution_conversation_id,
                binding.task_id, binding.context_document_id,
                blob.content AS served_bytes,
                package_run.run_id, package_run.content_hash AS run_package_hash,
                command.command_id, command.dispatch_job_id,
                command.runner_id, command.runner_generation,
                command.envelope
           FROM conversation_task_packages package
           JOIN conversation_task_package_bindings binding
             ON binding.package_id=package.id
           JOIN task_context_documents document
             ON document.id=binding.context_document_id
           JOIN task_context_blobs blob ON blob.sha256=document.sha256
           JOIN conversation_task_package_runs package_run
             ON package_run.package_id=package.id
           JOIN commands command
             ON command.envelope->>'run_id'=package_run.run_id
          WHERE package.handoff_id=$1`,
        [pending.handoff_id],
      )
    ).rows[0];
    if (!evidence) throw new Error("missing production package execution evidence");
    const taskPackage =
      typeof evidence.package === "string" ? JSON.parse(evidence.package) : evidence.package;
    const packageRecord = taskPackage as {
      approved_plan_version_id: string;
      approved_plan_content_hash: string;
      budget: unknown;
      binding_rules: string[];
      artifact_ids: string[];
      context_manifest: Array<{ kind: string; ref: string; content_hash: string }>;
    };
    expect(evidence.canonical_package).not.toContain("PLANNING_TRANSCRIPT_SENTINEL_DO_NOT_FORWARD");
    expect(Buffer.from(evidence.served_bytes).toString("utf8")).toBe(evidence.canonical_package);
    expect(canonicalSha256(taskPackage)).toBe(evidence.package_hash);
    expect(packageRecord.approved_plan_version_id).toBe(ready.saved.id);
    expect(packageRecord.approved_plan_content_hash).toBe(ready.saved.content_hash);
    expect(packageRecord.budget).toEqual(plan().estimated_budget);
    expect(packageRecord.binding_rules).toContain(
      "PACKAGE_RULE_SENTINEL: verify the immutable package.",
    );
    expect(packageRecord.artifact_ids).toContain(scope.attachmentId);
    expect(packageRecord.context_manifest).toContainEqual({
      kind: "artifact",
      ref: scope.attachmentId,
      content_hash: scope.attachmentHash,
    });
    expect(evidence.run_package_hash).toBe(evidence.package_hash);
    const supplement = (
      await pg.query<{
        source_mockup_version_id: string;
        task_id: string;
        base_package_id: string;
        supplement: unknown;
      }>(
        `SELECT source_mockup_version_id,task_id,base_package_id,supplement
           FROM conversation_task_package_supplements
          WHERE source_mockup_version_id=$1`,
        [planningMockup.id],
      )
    ).rows[0];
    expect(supplement).toMatchObject({
      source_mockup_version_id: planningMockup.id,
      task_id: evidence.task_id,
      base_package_id: evidence.package_id,
      supplement: {
        implementation_visual_evidence_requirement: {
          approved_mockup_version_id: planningMockup.id,
        },
      },
    });
    const envelope = evidence.envelope as {
      context_refs: Array<{
        artifact_id: string;
        content_hash: string;
        byte_size: number;
        storage_ref: string;
      }>;
      task_package_id: string;
      task_package_content_hash: string;
      task_package_context_ref: {
        artifact_id: string;
        content_hash: string;
        byte_size: number;
        storage_ref: string;
      };
    };
    expect(envelope.task_package_id).toBe(evidence.package_id);
    expect(envelope.task_package_content_hash).toBe(evidence.package_hash);
    expect(envelope.task_package_context_ref).toEqual(
      envelope.context_refs.find(
        (reference) => reference.artifact_id === evidence.context_document_id,
      ),
    );

    const implementationCommit = "f".repeat(40);
    const verifiedAt = "2026-07-27T16:10:00.000Z";
    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.query(
        `UPDATE agent_runs
            SET state='succeeded',lifecycle_version=1,verification_status='passed',
                published_commit_sha=$2,publication_outcome='pushed',
                published_at='2026-07-27T16:08:00Z',finished_at='2026-07-27T16:08:00Z'
          WHERE id=$1`,
        [evidence.run_id, implementationCommit],
      );
      await pg.query(
        `INSERT INTO artifacts (
           id,project_id,phase_id,task_id,run_id,kind,label,media_type,storage_ref,
           content_hash,byte_size,provenance_actor_type,provenance_actor_id,redaction_status
         ) VALUES (
           'production-planning-deployment-evidence',$1,$2,$3,$4,
           'deployment_evidence','Production planning deployment receipt',
           'application/json','artifact://production-planning-deployment-evidence',
           encode(sha256(convert_to('{"integrated":true}','UTF8')),'hex'),
           octet_length(convert_to('{"integrated":true}','UTF8')),
           'system','production-planning-test','not_required'
         )`,
        [projectId, afterRecovery.rows[0]?.phase_id, evidence.task_id, evidence.run_id],
      );
      await pg.query(
        `INSERT INTO artifact_blobs (
           artifact_id,project_id,content,content_hash,byte_size
         ) VALUES (
           'production-planning-deployment-evidence',$1,
           convert_to('{"integrated":true}','UTF8'),
           encode(sha256(convert_to('{"integrated":true}','UTF8')),'hex'),
           octet_length(convert_to('{"integrated":true}','UTF8'))
         )`,
        [projectId],
      );
      await pg.query(
        `INSERT INTO verification_results (
           id,project_id,phase_id,task_id,run_id,repository_binding_id,commit_sha,
           verification_policy_ref,passed,command_results,evidence,produced_by_runner_id
         ) VALUES (
           'production-planning-verification',$1,$2,$3,$4,
           'conversation-package-binding',$5,'verification/strict',true,
           '[]'::jsonb,'[]'::jsonb,$6
         )`,
        [
          projectId,
          afterRecovery.rows[0]?.phase_id,
          evidence.task_id,
          evidence.run_id,
          implementationCommit,
          evidence.runner_id,
        ],
      );
      await pg.query(
        `INSERT INTO project_delivery_records (
           id,project_id,phase_id,task_id,run_id,repository_binding_id,
           environment,service,commit_sha,provider_id,provider_deployment_id,
           status,current_observation_sequence,public_url,health_url,
           health_status_code,evidence_artifact_id,evidence_artifact_hash,
           started_at,completed_at
         ) VALUES (
           'production-planning-delivery',$1,$2,$3,$4,'conversation-package-binding',
           'production','web',$5,'railway','production-planning-deployment',
           'succeeded',1,'https://production-planning.example.test',
           'https://production-planning.example.test/health',200,
           'production-planning-deployment-evidence',
           encode(sha256(convert_to('{"integrated":true}','UTF8')),'hex'),
           '2026-07-27T16:08:30Z','2026-07-27T16:09:00Z'
         )`,
        [
          projectId,
          afterRecovery.rows[0]?.phase_id,
          evidence.task_id,
          evidence.run_id,
          implementationCommit,
        ],
      );
      await pg.query(
        `INSERT INTO project_delivery_observations (
           id,delivery_record_id,project_id,sequence,status,source_type,source_id,
           public_url,health_url,health_status_code,evidence_artifact_id,
           evidence_artifact_hash,observed_at
         ) VALUES (
           'production-planning-observation','production-planning-delivery',$1,1,
           'succeeded','system','production-planning-test',
           'https://production-planning.example.test',
           'https://production-planning.example.test/health',200,
           'production-planning-deployment-evidence',
           encode(sha256(convert_to('{"integrated":true}','UTF8')),'hex'),
           '2026-07-27T16:09:00Z'
         )`,
        [projectId],
      );
      await pg.query(
        `INSERT INTO implementation_visual_evidence_collections (
           id,project_id,work_item_id,conversation_id,phase_id,task_id,run_id,
           approved_mockup_version_id,repository_binding_id,verification_result_id,
           deployment_record_id,deployment_observation_id,commit_sha,status,
           command_id,dispatch_job_id,runner_id,runner_generation
         ) VALUES (
           'production-planning-collection',$1,$2,$3,$4,$5,$6,$7,
           'conversation-package-binding','production-planning-verification',
           'production-planning-delivery','production-planning-observation',$8,
           'delivered',$9,$10,$11,$12
         )`,
        [
          projectId,
          evidence.work_item_id,
          evidence.execution_conversation_id,
          afterRecovery.rows[0]?.phase_id,
          evidence.task_id,
          evidence.run_id,
          planningMockup.id,
          implementationCommit,
          evidence.command_id,
          evidence.dispatch_job_id,
          evidence.runner_id,
          Number(evidence.runner_generation),
        ],
      );
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }
    const visibleBefore = await pg.query<{ count: number | string }>(
      `SELECT count(*) AS count FROM work_messages
        WHERE conversation_id=$1
          AND parts @> $2::jsonb`,
      [
        evidence.execution_conversation_id,
        JSON.stringify([{ type: "implementation_visual_evidence" }]),
      ],
    );
    expect(Number(visibleBefore.rows[0]?.count)).toBe(0);
    const implementation = renderDeterministicMockup({
      schema_version: 1,
      title: "Delivered conversation API",
      summary: "The exact approved module is implemented and deployed.",
      target: "responsive",
      sections: [
        {
          heading: "Conversation API",
          body: "Approved plan, implementation, verification, and deployment are aligned.",
          emphasis: "primary",
        },
      ],
      interaction_notes: ["Compare both fixed viewports."],
      source_artifact_ids: [],
    });
    const visual = await new Phase6VisualEvidenceService(transactions).recordWithReplay({
      project_id: projectId,
      work_item_id: evidence.work_item_id,
      conversation_id: evidence.execution_conversation_id,
      phase_id: afterRecovery.rows[0]?.phase_id ?? "",
      task_id: evidence.task_id,
      run_id: evidence.run_id,
      approved_mockup_version_id: planningMockup.id,
      repository_binding_id: "conversation-package-binding",
      verification_result_id: "production-planning-verification",
      deployment_record_id: "production-planning-delivery",
      deployment_observation_id: "production-planning-observation",
      commit_sha: implementationCommit,
      capture_profile: {
        renderer: "playwright",
        browser_name: "chromium",
        browser_version: "130",
        font_revision: "a".repeat(64),
        pixel_ratio: 1,
        network: "application_only",
        locale: "en-US",
        timezone: "UTC",
        fixed_clock: verifiedAt,
      },
      verified_at: verifiedAt,
      runner_id: evidence.runner_id,
      desktop_png: implementation.desktop,
      mobile_png: implementation.mobile,
    });
    expect(visual).toMatchObject({
      replayed: false,
      evidence: {
        approved_mockup_version_id: planningMockup.id,
        commit_sha: implementationCommit,
        comparison_artifact: { media_type: "application/json" },
        screenshots: [{ viewport: "desktop" }, { viewport: "mobile" }],
      },
    });
    const visibleAfter = await pg.query<{
      count: number | string;
      parts: unknown;
    }>(
      `SELECT count(*) OVER () AS count,parts
         FROM work_messages
        WHERE conversation_id=$1
          AND parts @> $2::jsonb`,
      [
        evidence.execution_conversation_id,
        JSON.stringify([
          {
            type: "implementation_visual_evidence",
            visual_evidence_id: visual.evidence.id,
          },
        ]),
      ],
    );
    expect(Number(visibleAfter.rows[0]?.count)).toBe(1);
    expect(visibleAfter.rows[0]?.parts).toEqual(
      expect.arrayContaining([
        {
          type: "implementation_visual_evidence",
          visual_evidence_id: visual.evidence.id,
        },
      ]),
    );

    const summaryVersions = await pg.query<{
      version: number | string;
      from_message_sequence: number | string;
      through_message_sequence: number | string;
    }>(
      `SELECT version, from_message_sequence, through_message_sequence
         FROM conversation_summaries
        WHERE conversation_id=$1 ORDER BY version`,
      [scope.conversationId],
    );
    expect(summaryVersions.rows.map((row) => Number(row.version))).toEqual([1, 2]);
    expect(Number(summaryVersions.rows[1]?.from_message_sequence)).toBe(
      Number(firstMessage.sequence),
    );
    expect(Number(summaryVersions.rows[1]?.through_message_sequence)).toBeGreaterThan(
      Number(firstMessage.sequence),
    );

    const originalBytes = Buffer.from(evidence.served_bytes);
    await pg.query("UPDATE task_context_blobs SET content=$2 WHERE sha256=$1", [
      evidence.package_hash,
      Buffer.from("tampered"),
    ]);
    await expect(real.assembler.assembleForTask(evidence.task_id)).rejects.toMatchObject({
      code: "task_package_mismatch",
    });
    await pg.query("UPDATE task_context_blobs SET content=$2 WHERE sha256=$1", [
      evidence.package_hash,
      originalBytes,
    ]);

    const missingTaskId = `${evidence.task_id}:missing-binding`;
    const missingAssignmentId = "conversation-package-missing-assignment";
    const recoveredPhaseId = afterRecovery.rows[0]?.phase_id;
    if (!recoveredPhaseId) throw new Error("kickoff recovery did not retain its phase");
    await pg.query(
      `INSERT INTO tasks (
         id, project_id, phase_id, objective_id, strategy_version_id, title,
         description, deliverables, acceptance_criteria, complexity, risk,
         required_roles, required_capabilities, required_inputs, expected_outputs,
         environment_policy_ref, verification_policy_ref, state,
         review_evidence, completion_evidence, lifecycle_version, aggregate_version
       )
       SELECT $1, project_id, phase_id, objective_id, strategy_version_id,
              title || ' missing binding', description, deliverables,
              acceptance_criteria, complexity, risk, required_roles,
              required_capabilities, required_inputs, expected_outputs,
              environment_policy_ref, verification_policy_ref, 'pending',
              '[]'::jsonb, '[]'::jsonb, 0, 1
         FROM tasks WHERE id=$2`,
      [missingTaskId, evidence.task_id],
    );
    await pg.query(
      `INSERT INTO agent_assignments (
         id, project_id, phase_id, task_id, agent_profile_id, status,
         rationale, rationale_factors, budget_limit_usd,
         reviewer_agent_profile_id, allocation_policy_ref
       )
       SELECT $1, project_id, phase_id, $2, agent_profile_id, 'active',
              rationale, rationale_factors, budget_limit_usd,
              reviewer_agent_profile_id, allocation_policy_ref
         FROM agent_assignments WHERE task_id=$3 LIMIT 1`,
      [missingAssignmentId, missingTaskId, evidence.task_id],
    );
    const beforeMissingDispatch = await pg.query<{ count: number | string }>(
      "SELECT count(*) AS count FROM agent_runs",
    );
    await expect(
      real.coordinator.schedule({
        project_id: projectId,
        phase_id: recoveredPhaseId,
        task_id: missingTaskId,
        assignment_id: missingAssignmentId,
        runner_id: "conversation-package-runner",
        runner_generation: 1,
        authorized_by: { actor_type: "human", actor_id: owner.id },
        authorized_by_session_id: "production-package-missing-binding",
        correlation_id: "production-package-missing-binding",
        causation_id: null,
        context_refs: envelope.context_refs,
        target_branch: "norns/missing-package",
        worktree_policy_ref: "policy:worktree:default",
        sandbox_policy_ref: "policy:sandbox:default",
        max_input_tokens: 1000,
        max_output_tokens: 1000,
        max_duration_seconds: 60,
        issued_at: "2026-07-27T16:01:00.000Z",
        expires_at: "2026-07-27T16:06:00.000Z",
      }),
    ).rejects.toThrow(/missing its immutable task package binding/);
    expect(
      Number(
        (await pg.query<{ count: number | string }>("SELECT count(*) AS count FROM agent_runs"))
          .rows[0]?.count,
      ),
    ).toBe(Number(beforeMissingDispatch.rows[0]?.count));
  }, 30_000);

  it("rolls back every planning-to-execution boundary before retrying exactly once", async () => {
    const scope = await workspace("approval-rollback");
    const ready = await reviewReady(
      scope,
      plan("Atomically transition only after every durable boundary succeeds"),
      "approval-rollback",
    );
    const input = confirmation(scope, ready.approval.id, "approval-rollback-idempotency");
    const checkpoints = [
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
    for (const checkpoint of checkpoints) {
      approvalFailureAt = checkpoint;
      await expect(workflow.confirm(owner.id, input)).rejects.toThrow(
        `injected approval failure at ${checkpoint}`,
      );
      const state = await pg.query<{
        conversation_status: string;
        plan_status: string;
        handoffs: number | string;
        execution_conversations: number | string;
        kickoff_intents: number | string;
        approval_effects: number | string;
      }>(
        `SELECT conversation.status AS conversation_status,
                plan.status AS plan_status,
                (
                  SELECT count(*) FROM conversation_handoffs
                   WHERE source_conversation_id=conversation.id
                ) AS handoffs,
                (
                  SELECT count(*) FROM work_conversations candidate
                   WHERE candidate.work_item_id=conversation.work_item_id
                     AND candidate.kind='execution_pm'
                ) AS execution_conversations,
                (
                  SELECT count(*) FROM conversation_kickoff_intents intent
                   WHERE intent.source_conversation_id=conversation.id
                ) AS kickoff_intents,
                (
                  SELECT count(*) FROM conversation_plan_action_effects effect
                   WHERE effect.action_id=$3
                ) AS approval_effects
           FROM work_conversations conversation
           JOIN work_plan_versions plan ON plan.id=$2
          WHERE conversation.id=$1`,
        [scope.conversationId, ready.saved.id, ready.approval.id],
      );
      expect(state.rows[0]).toEqual({
        conversation_status: "active",
        plan_status: "in_qc",
        handoffs: 0,
        execution_conversations: 0,
        kickoff_intents: 0,
        approval_effects: 0,
      });
    }
    approvalFailureAt = null;
    const approved = await workflow.confirm(owner.id, input);
    expect(approved.effect).toMatchObject({
      kind: "plan_approved",
      transition_status: "created",
      plan_version: { id: ready.saved.id, status: "approved" },
    });
    expect(kickoffInputs).toHaveLength(1);
    expect(await workflow.confirm(owner.id, input)).toEqual(approved);
    expect(kickoffInputs).toHaveLength(1);
  });

  it("recovers a committed pending kickoff after the immediate claim is lost", async () => {
    const scope = await workspace("kickoff-recovery");
    const ready = await reviewReady(
      scope,
      plan("Recover the durable kickoff intent without a second approval"),
      "kickoff-recovery",
    );
    const input = confirmation(scope, ready.approval.id, "kickoff-recovery-approval");
    failKickoffClaim = true;
    await expect(workflow.confirm(owner.id, input)).rejects.toThrow(
      "injected kickoff claim failure",
    );
    const pending = await pg.query<{
      status: string;
      attempt_count: number | string;
      effect_status: string;
    }>(
      `SELECT intent.status, intent.attempt_count,
              effect.execution_status AS effect_status
         FROM conversation_kickoff_intents intent
         JOIN conversation_plan_action_effects effect
           ON effect.kickoff_intent_id=intent.id
        WHERE intent.action_id=$1`,
      [ready.approval.id],
    );
    expect(pending.rows[0]).toEqual({
      status: "pending",
      attempt_count: 0,
      effect_status: "pending",
    });
    expect(kickoffInputs).toHaveLength(0);
    failKickoffClaim = false;
    expect(await workflow.reconcileKickoffIntents()).toBeGreaterThanOrEqual(1);
    expect(kickoffInputs).toHaveLength(1);
    const recovered = await workflow.confirm(owner.id, input);
    expect(recovered.effect).toMatchObject({
      kind: "plan_approved",
      transition_status: "created",
      execution: { status: "refused", started: false },
    });
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
