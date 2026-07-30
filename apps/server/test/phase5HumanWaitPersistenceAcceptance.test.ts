import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  type CommandEnvelopeT,
  type V2DispatchCommandT,
  V2_HUMAN_WAIT_CHANNEL_VERSION,
  V2_HUMAN_WAIT_INSTRUCTION_HASH,
} from "@norns/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationActionCheckpointWorker,
  ConversationActionDeliveryWorker,
} from "../src/conversations/actionDelivery.js";
import { ExecutionConversationService } from "../src/conversations/executionConversation.js";
import { ConversationHumanSteeringService } from "../src/conversations/humanSteering.js";
import { ConversationPmUpdateScheduler } from "../src/conversations/pmUpdateScheduler.js";
import {
  HumanWaitContinuationWorker,
  HumanWaitRecoveryWorker,
} from "../src/coordinator/humanWaitContinuation.js";
import { PauseResumeContinuationWorker } from "../src/coordinator/pauseResumeContinuation.js";
import { Phase4Coordinator } from "../src/coordinator/phase4Coordinator.js";
import { Phase4DispatchRepository, Phase4Dispatcher } from "../src/coordinator/phase4Dispatcher.js";
import {
  Phase4EventProcessor,
  Phase4RunnerEventRejectedError,
} from "../src/coordinator/phase4EventProcessor.js";
import { PostgresDeviceActionAuthorization } from "../src/devices/actionAuthorization.js";
import {
  RelationalTaskContextAssembler,
  TaskContextAssemblyError,
  TaskContextStore,
} from "../src/execution/index.js";
import { sweepV2OrphanReservations } from "../src/persistence/v2/budget.js";
import { PGliteTransactionRunner, type V2SqlExecutor } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import {
  sqlV2BudgetSweepRepositoryFactory,
  sqlV2BudgetTransactionFactory,
} from "../src/persistence/v2/sqlRepositories.js";
import { Phase6MockupService, Phase6MockupWorker } from "../src/phase6/index.js";

const projectId = "project-phase5-wait";
const phaseId = "phase-phase5-wait";
const taskId = "task-phase5-wait";
const workItemId = "work-phase5-wait";
const conversationId = "conversation-phase5-execution";
const ownerId = "phase5-owner";
const outsiderId = "phase5-outsider";
const question = "Should the migration run before deployment?";
const summary = "The migration is committed and awaits its deployment-window decision.";
const questionHash = createHash("sha256").update(question).digest("hex");
const summaryHash = createHash("sha256").update(summary).digest("hex");
const publishedCommit = "c".repeat(40);

interface Scheduled {
  run_id: string;
  dispatch_job_id: string;
  command_id: string;
  budget_reservation_id: string;
  command: V2DispatchCommandT;
}

describe.sequential("Phase 5 durable human-wait persistence acceptance", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;
  let coordinator: Phase4Coordinator;

  beforeEach(async ({ task }) => {
    const githubBound = task.name.includes("Actions continuation");
    const bindingType = githubBound ? "github" : "local_runner";
    const bindingRunnerId = githubBound ? `actions:${projectId}` : "runner-phase5";
    const bindingWorkspaceId = githubBound ? "NULL" : "'workspace-phase5'";
    const githubInstallationId = githubBound ? "'5001'" : "NULL";
    const githubOwner = githubBound ? "'octo'" : "NULL";
    const githubName = githubBound ? "'widgets'" : "NULL";
    pg = new PGlite();
    await pg.exec(`
      CREATE ROLE norns_app NOLOGIN;
      CREATE TABLE norns_state (
        key TEXT PRIMARY KEY,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES
        (
          '${ownerId}','phase5-owner@example.test','Phase 5 Owner',
          'phase5-owner@example.test','Phase 5 Owner','hash','scrypt-v1','member','active'
        ),
        (
          '${outsiderId}','phase5-outsider@example.test','Phase 5 Outsider',
          'phase5-outsider@example.test','Phase 5 Outsider','hash','scrypt-v1','member','active'
        );
      INSERT INTO projects (
        id,name,description,status,assignment_policy_ref,verification_policy_ref,
        budget_policy_ref,owner_user_id
      ) VALUES (
        '${projectId}','Phase 5 Waits','','active','assignment','verification','budget','${ownerId}'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,observed_head,
        verification_policy_ref,repository_health,created_by_actor_type,created_by_actor_id,
        github_installation_id,github_owner,github_name
      ) VALUES (
        'binding-phase5','${projectId}','${bindingType}','connected','${bindingRunnerId}',
        ${bindingWorkspaceId},'repository-phase5','Phase 5 Waits','{}'::jsonb,'main',
        '${"a".repeat(40)}','verification','healthy','human','${ownerId}',
        ${githubInstallationId},${githubOwner},${githubName}
      );
      UPDATE projects SET primary_repository_binding_id='binding-phase5'
       WHERE id='${projectId}';
      INSERT INTO phases (
        id,project_id,objective_summary,priority,status,approved_budget_usd,initiated_by_user_id
      ) VALUES (
        '${phaseId}','${projectId}','Exercise durable human waits',1,
        'awaiting_approval',20,'${ownerId}'
      );
      INSERT INTO strategy_versions (
        id,project_id,phase_id,version,status,objective,content,convergence,
        review_rounds,content_hash
      ) VALUES (
        'strategy-phase5','${projectId}','${phaseId}',1,'approved','Human waits',
        '{}'::jsonb,'converged',1,'${"b".repeat(64)}'
      );
      UPDATE phases SET status='approved',approved_strategy_version_id='strategy-phase5'
       WHERE id='${phaseId}';
      INSERT INTO objectives (
        id,project_id,phase_id,outcome,success_measures,status,"order"
      ) VALUES (
        'objective-phase5','${projectId}','${phaseId}','Resume exactly once',
        '["durable wait"]'::jsonb,'active',0
      );
      INSERT INTO tasks (
        id,project_id,phase_id,objective_id,strategy_version_id,title,description,
        deliverables,acceptance_criteria,complexity,risk,required_roles,
        required_capabilities,required_inputs,expected_outputs,environment_policy_ref,
        verification_policy_ref,state,lifecycle_version
      ) VALUES (
        '${taskId}','${projectId}','${phaseId}','objective-phase5','strategy-phase5',
        'Wait safely','Create a durable human wait','["wait"]'::jsonb,
        '["resumes once"]'::jsonb,'M','medium','["implementation"]'::jsonb,
        '[]'::jsonb,'[]'::jsonb,'["checkpoint"]'::jsonb,'environment',
        'verification','pending',0
      );
      INSERT INTO agent_profiles (
        id,provider,runtime,model,reasoning_effort,roles,capabilities,
        context_limit_tokens,security_restrictions,status,active_workload,cost_metadata
      ) VALUES (
        'agent-phase5','openai','codex','gpt-5.6-sol','high',
        '["implementation"]'::jsonb,'["typescript"]'::jsonb,200000,
        '[]'::jsonb,'available',0,'{"billing_mode":"subscription"}'::jsonb
      );
      INSERT INTO agent_assignments (
        id,project_id,phase_id,task_id,agent_profile_id,status,rationale,
        rationale_factors,budget_limit_usd,allocation_policy_ref
      ) VALUES (
        'assignment-phase5','${projectId}','${phaseId}','${taskId}','agent-phase5',
        'proposed','Phase 5 acceptance','["capability"]'::jsonb,10,'allocation'
      );
      INSERT INTO work_items (
        id,project_id,created_by_user_id,title,objective,status,phase_id,execution_started_at
      ) VALUES (
        '${workItemId}','${projectId}','${ownerId}','Durable wait work',
        'Resume the same work safely','executing','${phaseId}',now()
      );
      INSERT INTO work_conversations (
        id,project_id,work_item_id,created_by_user_id,kind,status,provider,model
      ) VALUES (
        '${conversationId}','${projectId}','${workItemId}','${ownerId}',
        'execution_pm','active','openai','gpt-5.6-sol'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    coordinator = new Phase4Coordinator(transactions);
  }, 60_000);

  afterEach(async () => {
    await pg.close();
  });

  async function schedule(
    limits: {
      max_input_tokens?: number;
      max_output_tokens?: number;
      max_duration_seconds?: number;
      context_refs?: Array<{
        artifact_id: string;
        content_hash: string;
        byte_size: number;
        storage_ref: string;
      }>;
      supersedes_run_id?: string;
    } = {},
  ): Promise<Scheduled> {
    return coordinator.schedule({
      project_id: projectId,
      phase_id: phaseId,
      task_id: taskId,
      assignment_id: "assignment-phase5",
      runner_id: "runner-phase5",
      runner_generation: 7,
      authorized_by: { actor_type: "human", actor_id: ownerId },
      authorized_by_session_id: "phase5-session",
      correlation_id: "phase5-root-correlation",
      causation_id: null,
      context_refs: limits.context_refs ?? [
        {
          artifact_id: "phase5-root-context",
          content_hash: "d".repeat(64),
          byte_size: 128,
          storage_ref: "relay://phase5-root-context",
        },
      ],
      target_branch: "norns/phase5-wait",
      worktree_policy_ref: "worktree-default",
      sandbox_policy_ref: "sandbox-default",
      max_input_tokens: limits.max_input_tokens ?? 10_000,
      max_output_tokens: limits.max_output_tokens ?? 4_000,
      max_duration_seconds: limits.max_duration_seconds ?? 900,
      issued_at: "2026-07-27T12:00:00.000Z",
      expires_at: "2099-07-27T12:15:00.000Z",
      ...(limits.supersedes_run_id ? { supersedes_run_id: limits.supersedes_run_id } : {}),
    });
  }

  async function poisonLocalBindingWithMismatchedDeviceGrant(): Promise<void> {
    await pg.exec(`
      INSERT INTO devices (
        id,owner_user_id,display_name,os_family,architecture,lifecycle,current_generation
      ) VALUES (
        'device-phase5-actual','${ownerId}','Actual Phase 5 device',
        'linux','x64','active',0
      );
      INSERT INTO device_credentials (
        id,device_id,generation,public_key_spki_der,public_key_fingerprint,state
      ) VALUES (
        'credential-phase5-actual','device-phase5-actual',1,'\\x01',
        repeat('e',64),'active'
      );
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,repository_display_name,
        state,approved_by_user_id,approved_at,approved_credential_id,
        approved_generation
      ) VALUES (
        'registration-phase5-actual','device-phase5-actual','workspace-phase5',
        'repository-phase5','Phase 5 Waits','active','${ownerId}',now(),
        'credential-phase5-actual',1
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state,granted_by_user_id
      ) VALUES (
        'grant-phase5-actual','${projectId}','registration-phase5-actual',
        'active','${ownerId}'
      );
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        repository_display_name,granted_permissions,default_branch,observed_head,
        verification_policy_ref,repository_health,created_by_actor_type,
        created_by_actor_id,project_device_repository_grant_id
      ) VALUES (
        'binding-phase5-poisoned','${projectId}','local_runner','connected',NULL,
        'workspace-phase5','repository-phase5','Phase 5 Waits','{}'::jsonb,'main',
        '${"a".repeat(40)}','verification','healthy','human','${ownerId}',
        'grant-phase5-actual'
      );
      UPDATE agent_runs
         SET repository_binding_id='binding-phase5-poisoned'
       WHERE project_id='${projectId}'
         AND repository_binding_id='binding-phase5';
    `);
  }

  async function deliver(scheduled: Scheduled): Promise<void> {
    const dispatch = new Phase4DispatchRepository(transactions);
    const claim = await dispatch.claim("phase5-dispatcher", 30_000);
    expect(claim?.command.command_id).toBe(scheduled.command_id);
    await dispatch.markDelivered(
      scheduled.dispatch_job_id,
      "phase5-dispatcher",
      "2026-07-27T12:00:30.000Z",
    );
  }

  function envelope(
    scheduled: Scheduled,
    eventSeq: number,
    payload: Record<string, unknown>,
    causationId: string | null = scheduled.command_id,
  ) {
    return {
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: "phase5-root-correlation",
      causation_id: causationId,
      occurred_at: `2026-07-27T12:0${eventSeq}:00.000Z`,
      payload,
    };
  }

  async function runningEvidence(scheduled: Scheduled, processor: Phase4EventProcessor) {
    await processor.apply(
      envelope(scheduled, 1, {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "started",
      }) as never,
    );
    await processor.apply(
      envelope(scheduled, 2, {
        kind: "runtime_result",
        run_id: scheduled.run_id,
        runtime: scheduled.command.runtime,
        outcome: "waiting_for_human",
        session_id: "provider-session-phase5",
        stop_reason: "waiting_for_human",
        detail: summary,
      }) as never,
    );
  }

  async function publish(scheduled: Scheduled, processor: Phase4EventProcessor) {
    await processor.apply(
      envelope(scheduled, 3, {
        kind: "run_published",
        run_id: scheduled.run_id,
        outcome: "pushed",
        branch: scheduled.command.target_branch,
        commit_sha: publishedCommit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "Checkpoint only.",
      }) as never,
    );
  }

  function waitRequest(scheduled: Scheduled) {
    return {
      kind: "human_wait_requested",
      run_id: scheduled.run_id,
      decision_point: "Deployment window",
      question,
      question_hash: questionHash,
      compact_summary: summary,
      compact_summary_hash: summaryHash,
      runtime: scheduled.command.runtime,
      session_id: "provider-session-phase5",
      ask_channel_version: V2_HUMAN_WAIT_CHANNEL_VERSION,
      ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
    };
  }

  async function openWait() {
    const scheduled = await schedule();
    await deliver(scheduled);
    const processor = new Phase4EventProcessor(transactions);
    await runningEvidence(scheduled, processor);
    await publish(scheduled, processor);
    await processor.apply(envelope(scheduled, 4, waitRequest(scheduled)) as never);
    const waitId = "human-wait:runner-event:runner-phase5:7:4";
    return { scheduled, waitId, processor };
  }

  async function seedTaskBinding(): Promise<void> {
    // Action-scope authorization consumes the immutable execution task binding.
    // The full handoff/package creation path is covered by Phase 4 acceptance;
    // seed only that already-verified dependency here so this suite remains
    // focused on Phase 5 delivery semantics.
    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.query(
        `INSERT INTO conversation_task_package_bindings (
           package_id,project_id,work_item_id,conversation_id,handoff_id,
           phase_id,task_id,content_hash,context_document_id
         ) VALUES (
           'package-phase5',$1,$2,$3,'handoff-phase5',$4,$5,$6,'document-phase5'
         )
         ON CONFLICT(task_id) DO NOTHING`,
        [projectId, workItemId, conversationId, phaseId, taskId, "e".repeat(64)],
      );
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }
  }

  async function seedApprovedMockupSupplementDispatchScope() {
    const contentHash = createHash("sha256").update("{}").digest("hex");
    const packageRef = {
      artifact_id: "document-phase5-package",
      content_hash: contentHash,
      byte_size: 2,
      storage_ref:
        "https://norns.example.test/api/v2/execution/task-context/document-phase5-package",
    };
    const supplementRef = {
      artifact_id: "document-phase5-approved-mockup",
      content_hash: contentHash,
      byte_size: 2,
      storage_ref:
        "https://norns.example.test/api/v2/execution/task-context/document-phase5-approved-mockup",
    };
    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.query(
        `INSERT INTO task_context_blobs (sha256,content)
         VALUES ($1,convert_to('{}','UTF8'))`,
        [contentHash],
      );
      await pg.query(
        `INSERT INTO task_context_documents (
           id,project_id,section,sha256,byte_size,media_type
         ) VALUES
           ($1,$3,'task_package',$4,2,'application/json'),
           ($2,$3,'approved_mockup',$4,2,'application/json')`,
        [packageRef.artifact_id, supplementRef.artifact_id, projectId, contentHash],
      );
      await pg.query(
        `INSERT INTO conversation_task_packages (
           id,project_id,work_item_id,conversation_id,handoff_id,
           approved_plan_version_id,module_id,package,canonical_package,content_hash
         ) VALUES (
           'package-phase5-supplement',$1,$2,$3,'handoff-phase5-supplement',
           'plan-phase5-supplement','module-phase5-supplement','{}'::jsonb,'{}',$4
         )`,
        [projectId, workItemId, conversationId, contentHash],
      );
      await pg.query(
        `INSERT INTO conversation_task_package_bindings (
           package_id,project_id,work_item_id,conversation_id,handoff_id,
           phase_id,task_id,content_hash,context_document_id
         ) VALUES (
           'package-phase5-supplement',$1,$2,$3,'handoff-phase5-supplement',
           $4,$5,$6,$7
         )`,
        [
          projectId,
          workItemId,
          conversationId,
          phaseId,
          taskId,
          contentHash,
          packageRef.artifact_id,
        ],
      );
      await pg.query(
        `INSERT INTO conversation_task_package_supplements (
           id,project_id,work_item_id,conversation_id,task_id,base_package_id,ordinal,
           source_mockup_version_id,approval_decision_id,manifest_artifact_id,
           manifest_artifact_hash,supplement,canonical_supplement,content_hash,
           context_document_id,context_byte_size,context_media_type
         ) VALUES (
           'supplement-phase5-approved-mockup',$1,$2,$3,$4,
           'package-phase5-supplement',1,'mockup-version-phase5-supplement',
           'mockup-decision-phase5-supplement','mockup-manifest-phase5-supplement',
           $5,'{}'::jsonb,'{}',$5,$6,2,'application/json'
         )`,
        [projectId, workItemId, conversationId, taskId, contentHash, supplementRef.artifact_id],
      );
      await pg.query(
        `UPDATE phases SET planning_run_id='planning-phase5-supplement'
          WHERE id=$1`,
        [phaseId],
      );
      await pg.query(
        `INSERT INTO conversation_kickoff_intents (
           id,project_id,work_item_id,source_conversation_id,
           execution_conversation_id,action_id,approved_plan_version_id,
           plan_review_id,planning_run_id,handoff_id,decided_by_user_id,status
         ) VALUES (
           'kickoff-phase5-supplement',$1,$2,$3,$3,
           'action-phase5-supplement','plan-phase5-supplement',
           'review-phase5-supplement','planning-phase5-supplement',
           'handoff-phase5-supplement',$4,'pending'
         )`,
        [projectId, workItemId, conversationId, ownerId],
      );
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }
    return { contentHash, packageRef, supplementRef };
  }

  async function confirmCheckpointAction(
    suffix: string,
    candidate: Parameters<ConversationHumanSteeringService["proposeAction"]>[2],
  ) {
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-${suffix}`,
    });
    const proposal = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      candidate,
    );
    const confirmation = await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: proposal.action.id,
      idempotency_key: `confirmation-${suffix}`,
    });
    expect(confirmation).toMatchObject({
      action: {
        id: proposal.action.id,
        action_type: candidate.action_type,
        status: "recorded",
      },
      effect: {
        kind: "delivery_queued",
        delivery_mode: "checkpoint",
      },
    });
    return { proposal, confirmation };
  }

  async function seedApprovedPlanVersion() {
    const planHash = "f".repeat(64);
    await pg.query(
      `INSERT INTO work_plan_versions (
         id,project_id,work_item_id,conversation_id,created_by_user_id,
         version,status,plan,content_hash,approved_by_user_id,approved_at
       ) VALUES (
         'plan-phase5',$1,$2,$3,$4,1,'approved',$5::jsonb,$6,$4,now()
       )`,
      [
        projectId,
        workItemId,
        conversationId,
        ownerId,
        JSON.stringify({ plan: { objective: "Deliver Phase 5", modules: [] } }),
        planHash,
      ],
    );
    return { id: "plan-phase5", hash: planHash };
  }

  async function openRunningDirection(suffix: string) {
    const scheduled = await schedule();
    await deliver(scheduled);
    await new Phase4EventProcessor(transactions).apply(
      envelope(scheduled, 1, {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "started",
      }) as never,
    );
    await seedTaskBinding();
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-${suffix}`,
    });
    const proposal = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      {
        idempotency_key: `direction-proposal-${suffix}`,
        message: "Use the second migration strategy.",
        action_type: "redirect_agent",
        payload: {
          parameters: {
            task_id: taskId,
            run_id: scheduled.run_id,
            direction: "Use the second migration strategy.",
            delivery_preference: "live_or_checkpoint",
          },
        },
      },
    );
    const confirmation = await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: proposal.action.id,
      idempotency_key: `direction-confirmation-${suffix}`,
    });
    expect(confirmation).toMatchObject({
      action: { id: proposal.action.id, status: "recorded" },
      effect: {
        kind: "delivery_queued",
        delivery_mode: "live",
        target_run_id: scheduled.run_id,
      },
    });
    return { scheduled, proposal };
  }

  async function answerWait(waitId: string, suffix: string) {
    let sequence = 0;
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-${suffix}-${++sequence}`,
      contextBaseUrl: "https://norns.example.test",
    });
    const proposal = await steering.proposeAnswer(
      ownerId,
      { projectId, workItemId, conversationId },
      waitId,
      {
        idempotency_key: `answer-proposal-${suffix}`,
        expected_version: 1,
        question_hash: questionHash,
        answer: "Run it before deployment.",
        rationale: "Rollback is simpler before traffic moves.",
      },
    );
    const confirmation = await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: proposal.action.id,
      idempotency_key: `answer-confirmation-${suffix}`,
    });
    if (!confirmation || confirmation.effect.kind !== "human_wait_answered") {
      throw new Error("expected durable human wait answer");
    }
    return { proposal, confirmation, answerEffect: confirmation.effect };
  }

  it("allows only Phase 6 mockup actions to be proposed from an active planning conversation", async () => {
    const planningConversationId = "conversation-phase6-planning";
    await pg.query(
      `INSERT INTO work_conversations (
         id,project_id,work_item_id,created_by_user_id,kind,status,provider,model
       ) VALUES ($1,$2,$3,$4,'planning','active','anthropic','claude-sonnet-5')`,
      [planningConversationId, projectId, workItemId, ownerId],
    );
    await pg.query(
      `INSERT INTO work_plan_versions (
         id,project_id,work_item_id,conversation_id,created_by_user_id,
         version,status,plan,content_hash
       ) VALUES (
         'plan-phase6-planning',$1,$2,$3,$4,1,'candidate',$5::jsonb,$6
       )`,
      [
        projectId,
        workItemId,
        planningConversationId,
        ownerId,
        JSON.stringify({
          plan: {
            objective: "Review the responsive project overview",
            assumptions: ["The planning conversation is the source of truth."],
            modules: [
              {
                id: "overview-module",
                title: "Project overview",
                description: "Implement the approved responsive overview.",
                deliverables: ["Responsive overview"],
                acceptance: [
                  {
                    id: "overview-acceptance",
                    statement: "The overview matches the approved mockup.",
                    verification_type: "test",
                    verification: "pnpm test",
                  },
                ],
                dependencies: [],
                estimated_complexity: "M",
                risk: "medium",
              },
            ],
            risks: [
              {
                description: "Responsive behavior may drift.",
                mitigation: "Review both fixed viewports.",
              },
            ],
            out_of_scope: ["Unrelated pages"],
          },
          staffing: [
            {
              module_id: "overview-module",
              agent_role: "implementation",
              provider: "openai",
              model: "gpt-5.6-sol",
            },
          ],
          verification_requirements: ["pnpm test"],
          open_decisions: [],
          estimated_budget: { currency: "USD", amount: 10 },
        }),
        "e".repeat(64),
      ],
    );
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-planning-mockup`,
    });
    const proposal = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId: planningConversationId },
      {
        idempotency_key: "planning-mockup-proposal",
        message: "Show the responsive project overview before implementation.",
        action_type: "create_mockup",
        payload: {
          parameters: {
            plan_version_id: "plan-phase6-planning",
            module_id: "overview-module",
            brief: "Show the responsive project overview before implementation.",
            target: "responsive",
            artifact_refs: [],
          },
        },
      },
    );
    expect(proposal.action).toMatchObject({
      action_type: "create_mockup",
      interaction_class: "mockup_request",
      status: "proposed",
    });
    await expect(
      steering.proposeAction(
        ownerId,
        { projectId, workItemId, conversationId: planningConversationId },
        {
          idempotency_key: "planning-pause-proposal",
          message: "Pause this work.",
          action_type: "pause_work",
          payload: { parameters: { reason: "Review the plan first." } },
        },
      ),
    ).rejects.toMatchObject({ code: "conversation_inactive" });
  });

  it("requires publish-before-wait with exact causation, then survives restart without holding a runner", async () => {
    const scheduled = await schedule();
    await deliver(scheduled);
    const processor = new Phase4EventProcessor(transactions);
    await runningEvidence(scheduled, processor);

    await expect(
      processor.apply(envelope(scheduled, 3, waitRequest(scheduled)) as never),
    ).rejects.toBeInstanceOf(Phase4RunnerEventRejectedError);
    await publish(scheduled, processor);
    await expect(
      processor.apply(envelope(scheduled, 4, waitRequest(scheduled), "wrong-command") as never),
    ).rejects.toBeInstanceOf(Phase4RunnerEventRejectedError);
    await processor.apply(envelope(scheduled, 4, waitRequest(scheduled)) as never);

    const restarted = new Phase4EventProcessor(new PGliteTransactionRunner(pg));
    await expect(
      restarted.apply(envelope(scheduled, 4, waitRequest(scheduled)) as never),
    ).resolves.toEqual({ duplicate: true });
    const terminalAck = envelope(scheduled, 5, {
      kind: "command_ack",
      command_id: scheduled.command_id,
      state: "waiting_for_human",
      detail: question,
    });
    await expect(
      restarted.apply({ ...terminalAck, runner_id: "runner-attacker" } as never),
    ).rejects.toThrow(/fenced or unknown/i);
    await expect(
      restarted.apply({ ...terminalAck, causation_id: "wrong-command" } as never),
    ).rejects.toThrow(/fenced or unknown/i);
    await restarted.apply(terminalAck as never);

    const durable = await pg.query<{
      wait_status: string;
      session_id: string | null;
      portability: string;
      portability_evidence: string | null;
      run_state: string;
      task_state: string;
      job_status: string;
      command_status: string;
      reservation_status: string;
      reservation_expiry: Date;
      wait_expiry: Date;
      waits: number;
      messages: number;
    }>(
      `SELECT
         wait.status AS wait_status,
         wait.runtime_session_id AS session_id,
         wait.session_portability AS portability,
         wait.session_portability_evidence AS portability_evidence,
         run.state AS run_state,
         task.state AS task_state,
         job.status AS job_status,
         command.status AS command_status,
         reservation.status AS reservation_status,
         reservation.expires_at AS reservation_expiry,
         wait.expires_at AS wait_expiry,
         (SELECT count(*)::int FROM human_waits WHERE source_run_id=run.id) AS waits,
         (SELECT count(*)::int FROM work_messages
           WHERE conversation_id='${conversationId}'
             AND parts::text LIKE '%human_wait%') AS messages
       FROM human_waits wait
       JOIN agent_runs run ON run.id=wait.source_run_id
       JOIN tasks task ON task.id=wait.task_id
       JOIN budget_reservations reservation ON reservation.id=wait.budget_reservation_id
       JOIN dispatch_jobs job ON job.run_id=run.id
       JOIN commands command ON command.command_id=wait.source_command_id`,
    );
    expect(durable.rows[0]).toMatchObject({
      wait_status: "awaiting_human",
      session_id: "provider-session-phase5",
      portability: "transcript_only",
      portability_evidence: null,
      run_state: "waiting_for_human",
      task_state: "blocked",
      job_status: "completed",
      command_status: "waiting_for_human",
      reservation_status: "active",
      waits: 1,
      messages: 1,
    });
    const row = durable.rows[0];
    if (!row) throw new Error("missing durable wait state");
    expect(new Date(row.reservation_expiry).getTime()).toBeGreaterThanOrEqual(
      new Date(row.wait_expiry).getTime(),
    );
  });

  it("protects an active wait from generic budget sweeping even after its reservation clock expires", async () => {
    const { scheduled } = await openWait();
    await pg.query(
      "UPDATE budget_reservations SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [scheduled.budget_reservation_id],
    );
    const options = {
      transactionRunner: transactions,
      transactionFactory: sqlV2BudgetTransactionFactory,
      sweepRepositoryFactory: sqlV2BudgetSweepRepositoryFactory,
      now: () => new Date(),
    };
    await expect(sweepV2OrphanReservations(options)).resolves.toEqual({
      repaired: [],
      raced: [],
    });
    const reservation = await pg.query<{ status: string; resolution_outcome: string | null }>(
      "SELECT status,resolution_outcome FROM budget_reservations WHERE id=$1",
      [scheduled.budget_reservation_id],
    );
    expect(reservation.rows[0]).toEqual({
      status: "active",
      resolution_outcome: null,
    });
  });

  it("expires an unanswered wait once and settles attributable usage without reviving a runner", async () => {
    const { scheduled, waitId } = await openWait();
    await pg.query("UPDATE agent_runs SET usage_cost_usd=2.5 WHERE id=$1", [scheduled.run_id]);
    const recovery = new HumanWaitRecoveryWorker(transactions);
    await expect(recovery.scan(100, "2100-01-01T00:00:00.000Z")).resolves.toBe(1);
    await expect(recovery.scan(100, "2100-01-01T00:00:00.000Z")).resolves.toBe(0);
    const state = await pg.query<{
      wait_status: string;
      run_state: string;
      reservation_status: string;
      outcome: string;
      settled: number;
      released: number;
      decision_status: string;
      messages: number;
    }>(
      `SELECT wait.status AS wait_status,
              run.state AS run_state,
              reservation.status AS reservation_status,
              reservation.resolution_outcome AS outcome,
              reservation.settled_usd::float8 AS settled,
              reservation.released_usd::float8 AS released,
              decision.status AS decision_status,
              (SELECT count(*)::int FROM work_messages
                WHERE conversation_id='${conversationId}'
                  AND parts::text LIKE '%"status": "expired"%') AS messages
         FROM human_waits wait
         JOIN agent_runs run ON run.id=wait.source_run_id
         JOIN budget_reservations reservation ON reservation.id=wait.budget_reservation_id
         JOIN decision_points decision ON decision.id=wait.decision_point_id
        WHERE wait.id=$1`,
      [waitId],
    );
    expect(state.rows[0]).toEqual({
      wait_status: "expired",
      run_state: "expired",
      reservation_status: "settled",
      outcome: "partial_usage",
      settled: 2.5,
      released: 7.5,
      decision_status: "dismissed",
      messages: 1,
    });
  });

  it("replays an answer across service restarts and creates one same-run, same-budget continuation", async () => {
    const { scheduled, waitId } = await openWait();
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-phase5-acceptance`,
      contextBaseUrl: "https://norns.example.test",
    });
    const scope = { projectId, workItemId, conversationId };
    const candidate = {
      idempotency_key: "answer-proposal-phase5",
      expected_version: 1,
      question_hash: questionHash,
      answer: "Run it before deployment.",
      rationale: "Rollback is simpler before traffic moves.",
    };
    const first = await steering.proposeAnswer(ownerId, scope, waitId, candidate);
    const replay = await steering.proposeAnswer(ownerId, scope, waitId, candidate);
    expect(replay).toEqual(first);
    expect(first.message.client_message_id).toBe(candidate.idempotency_key);
    expect(first.action.source_message_id).toBe(first.message.id);
    await expect(
      steering.proposeAnswer(ownerId, scope, waitId, {
        ...candidate,
        answer: "Run it after deployment.",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      steering.proposeAnswer(outsiderId, scope, waitId, {
        ...candidate,
        idempotency_key: "outsider-answer",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const before = await pg.query<{ version: number }>(
      "SELECT version FROM budget_reservations WHERE id=$1",
      [scheduled.budget_reservation_id],
    );
    const confirmation = {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: first.action.id,
      idempotency_key: "confirm-answer-phase5",
    };
    const confirmed = await steering.confirm(ownerId, confirmation);
    const concurrentReplay = await new ConversationHumanSteeringService(transactions, {
      contextBaseUrl: "https://norns.example.test",
    }).confirm(ownerId, confirmation);
    expect(confirmed).toEqual(concurrentReplay);
    expect(confirmed?.effect.kind).toBe("human_wait_answered");
    const counts = await pg.query<{
      answers: number;
      continuations: number;
      decisions: number;
      approvals: number;
      messages: number;
      root_run_id: string;
      budget_reservation_id: string;
      wait_status: string;
      reservation_version: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM human_wait_answers WHERE wait_id=$1) AS answers,
         (SELECT count(*)::int FROM human_wait_continuations WHERE wait_id=$1) AS continuations,
         (SELECT count(*)::int FROM decision_records
           WHERE decision_point_id=(SELECT decision_point_id FROM human_waits WHERE id=$1))
           AS decisions,
         (SELECT count(*)::int FROM approvals
           WHERE subject_entity_type='human_wait' AND subject_entity_id=$1) AS approvals,
         (SELECT count(*)::int FROM work_messages
           WHERE conversation_id='${conversationId}' AND parts::text LIKE '%continuation_queued%')
           AS messages,
         continuation.root_run_id,
         continuation.budget_reservation_id,
         wait.status AS wait_status,
         reservation.version AS reservation_version
       FROM human_wait_continuations continuation
       JOIN human_waits wait ON wait.id=continuation.wait_id
       JOIN budget_reservations reservation ON reservation.id=continuation.budget_reservation_id
       WHERE continuation.wait_id=$1`,
      [waitId],
    );
    expect(counts.rows[0]).toMatchObject({
      answers: 1,
      continuations: 1,
      decisions: 1,
      approvals: 1,
      messages: 1,
      root_run_id: scheduled.run_id,
      budget_reservation_id: scheduled.budget_reservation_id,
      wait_status: "continuation_queued",
    });
    expect(counts.rows[0]?.reservation_version).toBeGreaterThan(before.rows[0]?.version ?? 0);
    await expect(
      steering.confirm(ownerId, { ...confirmation, idempotency_key: "different-confirmation" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("provisions one local continuation on the same run and reservation, then applies its receipt exactly once", async () => {
    const { scheduled, waitId } = await openWait();
    const { proposal, answerEffect } = await answerWait(waitId, "local-continuation");
    await pg.query(
      `UPDATE agent_runs
          SET usage_cost_usd=2,usage_input_tokens=100,usage_output_tokens=20
        WHERE id=$1`,
      [scheduled.run_id],
    );
    const worker = new HumanWaitContinuationWorker(
      transactions,
      async () => ({
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 8,
      }),
      { owner: "phase5-local-continuation-worker" },
    );
    const provisioned = await worker.tick();
    expect(provisioned).not.toBeNull();
    if (!provisioned) throw new Error("missing provisioned continuation");
    expect(provisioned).toMatchObject({
      continuation_id: answerEffect.continuation.id,
      wait_id: waitId,
      action_id: proposal.action.id,
      target: {
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 8,
      },
      command: {
        run_id: scheduled.run_id,
        budget_reservation_id: scheduled.budget_reservation_id,
        expected_revision: publishedCommit,
        target_branch: scheduled.command.target_branch,
      },
    });
    const continuation = provisioned.command.continuation;
    if (!continuation) throw new Error("missing continuation receipt");
    expect(continuation).toMatchObject({
      wait_id: waitId,
      root_command_id: scheduled.command_id,
      resume_commit_sha: publishedCommit,
      session_portability: "transcript_only",
      session_portability_evidence: null,
    });
    expect(continuation).not.toHaveProperty("resume_session_id");
    expect(provisioned.command.context_refs.at(-1)).toEqual(continuation.replay_context_ref);
    expect(provisioned.command.max_charge_usd).toBe(8);
    expect(provisioned.command.max_input_tokens).toBe(9_900);
    expect(provisioned.command.max_output_tokens).toBe(3_980);
    await expect(worker.tick()).resolves.toBeNull();

    const dispatch = new Phase4DispatchRepository(transactions);
    const claimed = await dispatch.claim("phase5-continuation-dispatcher", 30_000);
    expect(claimed?.job_id).toBe(provisioned.command.dispatch_job_id);
    await dispatch.markDelivered(
      provisioned.command.dispatch_job_id,
      "phase5-continuation-dispatcher",
      "2026-07-27T13:00:00.000Z",
    );
    const processor = new Phase4EventProcessor(transactions);
    const resumedEnvelope = (eventSeq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 8,
      correlation_id: provisioned.command.correlation_id,
      causation_id: provisioned.command.command_id,
      occurred_at: `2026-07-27T13:0${eventSeq}:00.000Z`,
      payload,
    });
    const receipt = {
      kind: "continuation_context_applied",
      run_id: scheduled.run_id,
      wait_id: waitId,
      root_command_id: scheduled.command_id,
      context_hash: continuation.context_hash,
      replay_context_hash: continuation.replay_context_ref.content_hash,
    };

    await expect(processor.apply(resumedEnvelope(1, receipt) as never)).rejects.toThrow(
      /only after the resumed run starts/i,
    );
    let beforeStart = await pg.query<{
      action_status: string;
      continuation_status: string;
      wait_status: string;
    }>(
      `SELECT action.status AS action_status,
              continuation.status AS continuation_status,
              wait.status AS wait_status
         FROM human_wait_continuations continuation
         JOIN human_waits wait ON wait.id=continuation.wait_id
         JOIN human_wait_answers answer ON answer.id=continuation.answer_id
         JOIN conversation_actions action ON action.id=answer.action_id
        WHERE continuation.id=$1`,
      [provisioned.continuation_id],
    );
    expect(beforeStart.rows[0]).toEqual({
      action_status: "sent",
      continuation_status: "dispatched",
      wait_status: "continuation_queued",
    });
    await processor.apply(
      resumedEnvelope(1, {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "started",
      }) as never,
    );
    await expect(
      processor.apply(
        resumedEnvelope(2, {
          ...receipt,
          replay_context_hash: "f".repeat(64),
        }) as never,
      ),
    ).rejects.toThrow(/does not match the immutable replay command/i);
    await expect(processor.apply(resumedEnvelope(2, receipt) as never)).resolves.toEqual({
      duplicate: false,
    });
    await expect(processor.apply(resumedEnvelope(2, receipt) as never)).resolves.toEqual({
      duplicate: true,
    });

    beforeStart = await pg.query(
      `SELECT action.status AS action_status,
              continuation.status AS continuation_status,
              wait.status AS wait_status
         FROM human_wait_continuations continuation
         JOIN human_waits wait ON wait.id=continuation.wait_id
         JOIN human_wait_answers answer ON answer.id=continuation.answer_id
         JOIN conversation_actions action ON action.id=answer.action_id
        WHERE continuation.id=$1`,
      [provisioned.continuation_id],
    );
    expect(beforeStart.rows[0]).toEqual({
      action_status: "applied",
      continuation_status: "applied",
      wait_status: "resumed",
    });
    const evidence = await pg.query<{ statuses: string[]; commands: number; jobs: number }>(
      `SELECT
         array_agg(event.status ORDER BY event.sequence) AS statuses,
         (SELECT count(*)::int FROM commands WHERE run_id=$2) AS commands,
         (SELECT count(*)::int FROM dispatch_jobs WHERE run_id=$2) AS jobs
       FROM conversation_action_delivery_events event
       WHERE event.action_id=$1`,
      [proposal.action.id, scheduled.run_id],
    );
    expect(evidence.rows[0]).toEqual({
      statuses: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
      commands: 2,
      jobs: 2,
    });
  });

  it("fails a provisioned continuation instead of dispatching through a poisoned grant binding", async () => {
    const { waitId } = await openWait();
    await answerWait(waitId, "poisoned-local-continuation");
    const worker = new HumanWaitContinuationWorker(
      transactions,
      async () => ({
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 8,
      }),
      { owner: "phase5-poisoned-continuation-worker" },
    );
    const provisioned = await worker.tick();
    if (!provisioned) throw new Error("missing provisioned continuation");

    await poisonLocalBindingWithMismatchedDeviceGrant();
    const dispatch = new Phase4DispatchRepository(
      transactions,
      new PostgresDeviceActionAuthorization(),
    );
    await expect(dispatch.claim("phase5-poisoned-dispatcher", 30_000)).resolves.toBeNull();
    const state = await pg.query<{
      job_status: string;
      command_status: string;
      continuation_status: string;
      last_error: string | null;
    }>(
      `SELECT
         job.status AS job_status,
         command.status AS command_status,
         continuation.status AS continuation_status,
         continuation.last_error
       FROM dispatch_jobs job
       JOIN commands command ON command.command_id=job.command_id
       JOIN human_wait_continuations continuation
         ON continuation.resume_command_id=command.command_id
       WHERE job.id=$1`,
      [provisioned.command.dispatch_job_id],
    );
    expect(state.rows[0]).toEqual({
      job_status: "cancelled",
      command_status: "cancelled",
      continuation_status: "failed",
      last_error: "device authorization changed before continuation dispatch",
    });
  });

  it("binds the exact approved mockup supplement to ordinary and continuation dispatch receipts", async () => {
    const { contentHash, packageRef, supplementRef } =
      await seedApprovedMockupSupplementDispatchScope();
    const scheduled = await schedule({
      context_refs: [
        {
          artifact_id: "phase5-root-context",
          content_hash: "d".repeat(64),
          byte_size: 128,
          storage_ref: "relay://phase5-root-context",
        },
        packageRef,
        supplementRef,
      ],
    });
    expect(scheduled.command).toMatchObject({
      task_package_id: "package-phase5-supplement",
      task_package_content_hash: contentHash,
      task_package_context_ref: packageRef,
      task_package_supplements: [
        {
          supplement_id: "supplement-phase5-approved-mockup",
          task_id: taskId,
          base_package_id: "package-phase5-supplement",
          ordinal: 1,
          content_hash: contentHash,
          context_ref: supplementRef,
        },
      ],
    });
    const originalReceipt = await pg.query<{
      command_id: string;
      supplement_id: string;
      context_ref: unknown;
    }>(
      `SELECT command_id,supplement_id,context_ref
         FROM conversation_task_package_supplement_dispatch_receipts
        WHERE command_id=$1`,
      [scheduled.command_id],
    );
    expect(originalReceipt.rows).toEqual([
      {
        command_id: scheduled.command_id,
        supplement_id: "supplement-phase5-approved-mockup",
        context_ref: supplementRef,
      },
    ]);

    await deliver(scheduled);
    const processor = new Phase4EventProcessor(transactions);
    await runningEvidence(scheduled, processor);
    await publish(scheduled, processor);
    await processor.apply(envelope(scheduled, 4, waitRequest(scheduled)) as never);
    const waitId = "human-wait:runner-event:runner-phase5:7:4";
    await answerWait(waitId, "supplement-continuation");
    const continuation = await new HumanWaitContinuationWorker(
      new PGliteTransactionRunner(pg),
      async () => ({
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 8,
      }),
      { owner: "phase5-supplement-continuation-worker" },
    ).tick();
    expect(continuation?.command.task_package_supplements).toEqual(
      scheduled.command.task_package_supplements,
    );
    if (!continuation) throw new Error("missing supplement-bearing continuation");
    const receipts = await pg.query<{
      command_id: string;
      run_id: string;
      supplement_id: string;
      content_hash: string;
      context_ref: unknown;
    }>(
      `SELECT command_id,run_id,supplement_id,content_hash,context_ref
         FROM conversation_task_package_supplement_dispatch_receipts
        WHERE run_id=$1
        ORDER BY command_id`,
      [scheduled.run_id],
    );
    expect(receipts.rows).toEqual([
      {
        command_id: continuation.command.command_id,
        run_id: scheduled.run_id,
        supplement_id: "supplement-phase5-approved-mockup",
        content_hash: contentHash,
        context_ref: supplementRef,
      },
      {
        command_id: scheduled.command_id,
        run_id: scheduled.run_id,
        supplement_id: "supplement-phase5-approved-mockup",
        content_hash: contentHash,
        context_ref: supplementRef,
      },
    ]);
  });

  it("binds a fallback direction into a human-wait continuation and applies its exact context receipt", async () => {
    const { scheduled, waitId } = await openWait();
    await seedTaskBinding();
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-wait-direction`,
    });
    const direction = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      {
        idempotency_key: "wait-direction-proposal",
        message: "Preserve the rollback marker.",
        action_type: "redirect_agent",
        payload: {
          parameters: {
            task_id: taskId,
            run_id: scheduled.run_id,
            direction: "Preserve the rollback marker.",
            delivery_preference: "live_or_checkpoint",
          },
        },
      },
    );
    await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: direction.action.id,
      idempotency_key: "wait-direction-confirmation",
    });
    const fallback = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => null,
        enqueue: () => {
          throw new Error("waiting direction must not enqueue live control");
        },
        notify: () => false,
      },
      { workerId: "wait-direction-fallback" },
    );
    await expect(fallback.tick()).resolves.toMatchObject({
      action_id: direction.action.id,
      status: "fallback_queued",
    });
    const { answerEffect } = await answerWait(waitId, "direction-continuation");
    const worker = new HumanWaitContinuationWorker(
      transactions,
      async () => ({
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 8,
      }),
      { owner: "direction-continuation-worker" },
    );
    const provisioned = await worker.tick();
    if (!provisioned?.command.continuation) {
      throw new Error("missing direction continuation");
    }
    expect(provisioned.continuation_id).toBe(answerEffect.continuation.id);
    const sent = await pg.query<{
      action_status: string;
      intent_status: string;
      checkpoint_status: string;
      checkpoint_command_id: string;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              checkpoint.status AS checkpoint_status,
              checkpoint.command_id AS checkpoint_command_id
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_checkpoint_contexts checkpoint
           ON checkpoint.action_id=action.id
        WHERE action.id=$1`,
      [direction.action.id],
    );
    expect(sent.rows[0]).toEqual({
      action_status: "sent",
      intent_status: "sent",
      checkpoint_status: "sent",
      checkpoint_command_id: provisioned.command.command_id,
    });
    const dispatch = new Phase4DispatchRepository(transactions);
    await dispatch.claim("direction-continuation-dispatcher", 30_000);
    await dispatch.markDelivered(
      provisioned.command.dispatch_job_id,
      "direction-continuation-dispatcher",
      "2026-07-27T13:00:00.000Z",
    );
    const processor = new Phase4EventProcessor(transactions);
    const event = (eventSeq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 8,
      correlation_id: provisioned.command.correlation_id,
      causation_id: provisioned.command.command_id,
      occurred_at: `2026-07-27T13:0${eventSeq}:00.000Z`,
      payload,
    });
    await processor.apply(
      event(1, { kind: "run_status", run_id: scheduled.run_id, status: "started" }) as never,
    );
    await processor.apply(
      event(2, {
        kind: "continuation_context_applied",
        run_id: scheduled.run_id,
        wait_id: waitId,
        root_command_id: scheduled.command_id,
        context_hash: provisioned.command.continuation.context_hash,
        replay_context_hash: provisioned.command.continuation.replay_context_ref.content_hash,
      }) as never,
    );
    const applied = await pg.query<{
      action_status: string;
      intent_status: string;
      checkpoint_status: string;
      events: string[];
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              checkpoint.status AS checkpoint_status,
              array_agg(event.status ORDER BY event.sequence) AS events
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_checkpoint_contexts checkpoint
           ON checkpoint.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
        WHERE action.id=$1
        GROUP BY action.status,intent.status,checkpoint.status`,
      [direction.action.id],
    );
    expect(applied.rows[0]).toEqual({
      action_status: "applied",
      intent_status: "applied",
      checkpoint_status: "applied",
      events: ["confirmed", "recorded", "fallback_queued", "sent", "agent_acknowledged", "applied"],
    });
  });

  it("decrements one original token, cost, and active-time budget across two sequential human waits", async () => {
    const scheduled = await schedule({
      max_input_tokens: 700,
      max_output_tokens: 300,
      max_duration_seconds: 1_000,
    });
    await deliver(scheduled);
    const processor = new Phase4EventProcessor(transactions);
    const rootEvent = (eventSeq: number, occurredAt: string, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: "phase5-root-correlation",
      causation_id: scheduled.command_id,
      occurred_at: occurredAt,
      payload,
    });
    await processor.apply(
      rootEvent(1, "2026-07-27T12:01:00.000Z", {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "started",
      }) as never,
    );
    await pg.query(
      `INSERT INTO usage_events (
         id,project_id,phase_id,task_id,run_id,provider,model,
         input_tokens,output_tokens,cost_usd,occurred_at
       ) VALUES (
         'usage-phase5-command-1',$1,$2,$3,$4,'openai','gpt-5.6-sol',
         60,40,1,'2026-07-27T12:01:30.000Z'
       )`,
      [projectId, phaseId, taskId, scheduled.run_id],
    );
    await processor.apply(
      rootEvent(2, "2026-07-27T12:01:40.000Z", {
        kind: "usage_report",
        run_id: scheduled.run_id,
        input_tokens: 60,
        output_tokens: 40,
      }) as never,
    );
    await processor.apply(
      rootEvent(3, "2026-07-27T12:02:00.000Z", {
        kind: "runtime_result",
        run_id: scheduled.run_id,
        runtime: scheduled.command.runtime,
        outcome: "waiting_for_human",
        session_id: "provider-session-phase5",
        stop_reason: "waiting_for_human",
        detail: summary,
      }) as never,
    );
    await processor.apply(
      rootEvent(4, "2026-07-27T12:03:00.000Z", {
        kind: "run_published",
        run_id: scheduled.run_id,
        outcome: "pushed",
        branch: scheduled.command.target_branch,
        commit_sha: publishedCommit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "First checkpoint.",
      }) as never,
    );
    const firstCheckpointEvidence = await pg.query<{
      run_state: string;
      task_state: string;
      published_branch: string;
      published_commit_sha: string;
      published_remote: string;
      runtime_session_id: string;
      reservation_status: string;
      conversation_status: string;
      publication_events: number;
      runtime_events: number;
    }>(
      `SELECT run.state AS run_state,task.state AS task_state,
              run.published_branch,run.published_commit_sha,run.published_remote,
              run.runtime_session_id,reservation.status AS reservation_status,
              conversation.status AS conversation_status,
              (SELECT count(*)::int FROM runner_events event
                WHERE event.run_id=run.id AND event.runner_generation=7
                  AND event.event_type='run_published'
                  AND event.causation_id=$2) AS publication_events,
              (SELECT count(*)::int FROM runner_events event
                WHERE event.run_id=run.id AND event.runner_generation=7
                  AND event.event_type='runtime_result'
                  AND event.causation_id=$2
                  AND event.payload->>'outcome'='waiting_for_human') AS runtime_events
         FROM agent_runs run
         JOIN tasks task ON task.id=run.task_id
         JOIN budget_reservations reservation ON reservation.run_id=run.id
         JOIN work_items item ON item.project_id=run.project_id AND item.phase_id=run.phase_id
         JOIN work_conversations conversation
           ON conversation.work_item_id=item.id AND conversation.kind='execution_pm'
        WHERE run.id=$1`,
      [scheduled.run_id, scheduled.command_id],
    );
    expect(firstCheckpointEvidence.rows[0]).toEqual({
      run_state: "running",
      task_state: "in_progress",
      published_branch: scheduled.command.target_branch,
      published_commit_sha: publishedCommit,
      published_remote: "origin",
      runtime_session_id: "provider-session-phase5",
      reservation_status: "active",
      conversation_status: "active",
      publication_events: 1,
      runtime_events: 1,
    });
    await processor.apply(
      rootEvent(5, "2026-07-27T12:04:00.000Z", waitRequest(scheduled)) as never,
    );
    const firstWaitId = "human-wait:runner-event:runner-phase5:7:5";
    await answerWait(firstWaitId, "budget-wait-one");
    const firstWorker = new HumanWaitContinuationWorker(
      transactions,
      async () => ({
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 8,
      }),
      { owner: "phase5-budget-continuation-one" },
    );
    const firstContinuation = await firstWorker.tick();
    if (!firstContinuation?.command.continuation) {
      throw new Error("missing first budget continuation");
    }
    expect({
      total_tokens:
        firstContinuation.command.max_input_tokens + firstContinuation.command.max_output_tokens,
      max_charge_usd: firstContinuation.command.max_charge_usd,
      max_duration_seconds: firstContinuation.command.max_duration_seconds,
    }).toEqual({
      total_tokens: 900,
      max_charge_usd: 9,
      max_duration_seconds: 940,
    });

    const continuationDispatch = new Phase4DispatchRepository(transactions);
    const firstClaim = await continuationDispatch.claim(
      "phase5-budget-continuation-dispatcher",
      30_000,
    );
    expect(firstClaim?.command.command_id).toBe(firstContinuation.command.command_id);
    await continuationDispatch.markDelivered(
      firstContinuation.command.dispatch_job_id,
      "phase5-budget-continuation-dispatcher",
      "2026-07-30T12:00:00.000Z",
    );
    const continuedEvent = (
      eventSeq: number,
      occurredAt: string,
      payload: Record<string, unknown>,
    ) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 8,
      correlation_id: firstContinuation.command.correlation_id,
      causation_id: firstContinuation.command.command_id,
      occurred_at: occurredAt,
      payload,
    });
    await processor.apply(
      continuedEvent(1, "2026-07-30T12:00:00.000Z", {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "started",
      }) as never,
    );
    await processor.apply(
      continuedEvent(2, "2026-07-30T12:00:01.000Z", {
        kind: "continuation_context_applied",
        run_id: scheduled.run_id,
        wait_id: firstWaitId,
        root_command_id: scheduled.command_id,
        context_hash: firstContinuation.command.continuation.context_hash,
        replay_context_hash: firstContinuation.command.continuation.replay_context_ref.content_hash,
      }) as never,
    );
    await pg.query(
      `INSERT INTO usage_events (
         id,project_id,phase_id,task_id,run_id,provider,model,
         input_tokens,output_tokens,cost_usd,occurred_at
       ) VALUES (
         'usage-phase5-command-2',$1,$2,$3,$4,'openai','gpt-5.6-sol',
         60,40,1,'2026-07-30T12:01:00.000Z'
       )`,
      [projectId, phaseId, taskId, scheduled.run_id],
    );
    await processor.apply(
      continuedEvent(3, "2026-07-30T12:01:30.000Z", {
        kind: "usage_report",
        run_id: scheduled.run_id,
        input_tokens: 60,
        output_tokens: 40,
      }) as never,
    );
    await processor.apply(
      continuedEvent(4, "2026-07-30T12:02:00.000Z", {
        kind: "runtime_result",
        run_id: scheduled.run_id,
        runtime: scheduled.command.runtime,
        outcome: "waiting_for_human",
        session_id: "provider-session-phase5-second",
        stop_reason: "waiting_for_human",
        detail: summary,
      }) as never,
    );
    const secondCommit = "9".repeat(40);
    await processor.apply(
      continuedEvent(5, "2026-07-30T12:02:10.000Z", {
        kind: "run_published",
        run_id: scheduled.run_id,
        outcome: "pushed",
        branch: scheduled.command.target_branch,
        commit_sha: secondCommit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "Second checkpoint.",
      }) as never,
    );
    await processor.apply(
      continuedEvent(6, "2026-07-30T12:02:20.000Z", {
        ...waitRequest(scheduled),
        session_id: "provider-session-phase5-second",
      }) as never,
    );
    const secondWaitId = "human-wait:runner-event:runner-phase5:8:6";
    await answerWait(secondWaitId, "budget-wait-two");
    const secondWorker = new HumanWaitContinuationWorker(
      new PGliteTransactionRunner(pg),
      async () => ({
        kind: "local",
        runner_id: "runner-phase5",
        runner_generation: 9,
      }),
      { owner: "phase5-budget-continuation-two" },
    );
    const secondContinuation = await secondWorker.tick();
    expect(secondContinuation?.command.continuation).toMatchObject({
      wait_id: secondWaitId,
      resume_commit_sha: secondCommit,
    });
    expect({
      total_tokens:
        (secondContinuation?.command.max_input_tokens ?? 0) +
        (secondContinuation?.command.max_output_tokens ?? 0),
      max_charge_usd: secondContinuation?.command.max_charge_usd,
      max_duration_seconds: secondContinuation?.command.max_duration_seconds,
    }).toEqual({
      total_tokens: 800,
      max_charge_usd: 8,
      max_duration_seconds: 820,
    });
    const receipts = await pg.query<{
      command_id: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      active_ms: number;
      status: string;
    }>(
      `SELECT command_id,input_tokens::int,output_tokens::int,
              cost_usd::float8,active_ms::int,status
         FROM run_command_usage_receipts
        WHERE run_id=$1 ORDER BY started_at,command_id`,
      [scheduled.run_id],
    );
    expect(receipts.rows).toEqual([
      {
        command_id: scheduled.command_id,
        input_tokens: 60,
        output_tokens: 40,
        cost_usd: 1,
        active_ms: 60_000,
        status: "final",
      },
      {
        command_id: firstContinuation.command.command_id,
        input_tokens: 60,
        output_tokens: 40,
        cost_usd: 1,
        active_ms: 120_000,
        status: "final",
      },
    ]);
    const cumulative = await pg.query<{
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      receipt_cost: number;
      active_ms: number;
    }>(
      `SELECT run.usage_input_tokens::int AS input_tokens,
              run.usage_output_tokens::int AS output_tokens,
              run.usage_cost_usd::float8 AS cost_usd,
              (SELECT sum(cost_usd)::float8 FROM run_command_usage_receipts
                WHERE run_id=run.id) AS receipt_cost,
              (SELECT sum(active_ms)::int FROM run_command_usage_receipts
                WHERE run_id=run.id) AS active_ms
         FROM agent_runs run WHERE run.id=$1`,
      [scheduled.run_id],
    );
    expect(cumulative.rows[0]).toEqual({
      input_tokens: 120,
      output_tokens: 80,
      cost_usd: 2,
      receipt_cost: 2,
      active_ms: 180_000,
    });
  });

  it("recovers an Actions continuation after a post-provision crash without creating a second command", async () => {
    const { scheduled, waitId } = await openWait();
    const { proposal, answerEffect } = await answerWait(waitId, "actions-continuation");
    await pg.query(
      `INSERT INTO github_actions_runs (
         id,project_id,repository_binding_id,dispatch_job_id,run_id,runner_id,
         runner_generation,status,completed_at
       ) VALUES (
         'actions-source-phase5',$1,'binding-phase5',$2,$3,'runner-phase5',7,
         'completed',now()
       )`,
      [projectId, scheduled.dispatch_job_id, scheduled.run_id],
    );
    let firstLaunchAttempts = 0;
    const crashing = new HumanWaitContinuationWorker(
      transactions,
      async () => ({
        kind: "actions",
        runner_id: "actions:phase5:continuation",
        runner_generation: 11,
      }),
      {
        owner: "phase5-actions-crashing-worker",
        afterProvision: async () => {
          firstLaunchAttempts += 1;
          throw new Error("simulated process crash after durable provisioning");
        },
      },
    );
    await expect(crashing.tick()).rejects.toThrow(/simulated process crash/i);
    expect(firstLaunchAttempts).toBe(1);
    const afterCrash = await pg.query<{
      status: string;
      commands: number;
      jobs: number;
    }>(
      `SELECT continuation.status,
              (SELECT count(*)::int FROM commands WHERE run_id=$2) AS commands,
              (SELECT count(*)::int FROM dispatch_jobs WHERE run_id=$2) AS jobs
         FROM human_wait_continuations continuation
        WHERE continuation.id=$1`,
      [answerEffect.continuation.id, scheduled.run_id],
    );
    expect(afterCrash.rows[0]).toEqual({ status: "provisioned", commands: 2, jobs: 2 });

    let recoveredLaunches = 0;
    const restarted = new HumanWaitContinuationWorker(
      new PGliteTransactionRunner(pg),
      async () => {
        throw new Error("recovery must use the already provisioned target");
      },
      {
        owner: "phase5-actions-restarted-worker",
        afterProvision: async (provisioned) => {
          recoveredLaunches += 1;
          await pg.query(
            `INSERT INTO github_actions_runs (
               id,project_id,repository_binding_id,dispatch_job_id,run_id,runner_id,
               runner_generation,status
             ) VALUES (
               'actions-continuation-phase5',$1,'binding-phase5',$2,$3,$4,$5,'requested'
             )`,
            [
              projectId,
              provisioned.command.dispatch_job_id,
              provisioned.command.run_id,
              provisioned.target.runner_id,
              provisioned.target.runner_generation,
            ],
          );
        },
      },
    );
    const recovered = await restarted.tick();
    expect(recovered).toMatchObject({
      continuation_id: answerEffect.continuation.id,
      command: {
        run_id: scheduled.run_id,
        budget_reservation_id: scheduled.budget_reservation_id,
      },
      target: {
        kind: "actions",
        runner_id: "actions:phase5:continuation",
        runner_generation: 11,
      },
    });
    expect(recovered?.command.continuation).toMatchObject({
      session_portability: "transcript_only",
      session_portability_evidence: null,
    });
    expect(recovered?.command.continuation).not.toHaveProperty("resume_session_id");
    expect(recoveredLaunches).toBe(1);
    await expect(restarted.tick()).resolves.toBeNull();
    const exactlyOnce = await pg.query<{
      commands: number;
      jobs: number;
      actions_runs: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM commands WHERE run_id=$1) AS commands,
         (SELECT count(*)::int FROM dispatch_jobs WHERE run_id=$1) AS jobs,
         (SELECT count(*)::int FROM github_actions_runs WHERE run_id=$1) AS actions_runs`,
      [scheduled.run_id],
    );
    expect(exactlyOnce.rows[0]).toEqual({ commands: 2, jobs: 2, actions_runs: 2 });

    if (!recovered) throw new Error("missing recovered Actions continuation");
    await pg.query(
      `INSERT INTO usage_events (
         id,project_id,phase_id,task_id,run_id,provider,model,
         input_tokens,output_tokens,cost_usd,occurred_at
       ) VALUES (
         'usage-actions-never-enrolled',$1,$2,$3,$4,'openai','gpt-5.6-sol',
         125,25,2.5,now()
       )`,
      [projectId, phaseId, taskId, scheduled.run_id],
    );
    await pg.query(
      `UPDATE conversation_actions
          SET status='sent',sent_at=now(),updated_at=now()
        WHERE id=$1 AND status='recorded'`,
      [proposal.action.id],
    );
    await pg.query(
      `INSERT INTO conversation_action_delivery_intents (
         id,project_id,work_item_id,conversation_id,action_id,delivery_mode,
         target_run_id,target_command_id,target_runner_generation,status,payload
       ) VALUES (
         'intent-actions-never-enrolled',$1,$2,$3,$4,'continuation',
         $5,$6,11,'sent','{"kind":"human_wait_answer"}'::jsonb
       )`,
      [
        projectId,
        workItemId,
        conversationId,
        proposal.action.id,
        scheduled.run_id,
        recovered.command.command_id,
      ],
    );
    await pg.query(
      `UPDATE github_actions_runs
          SET status='failed',last_error='workflow_failed_before_enrollment',
              completed_at=now(),updated_at=now()
        WHERE dispatch_job_id=$1`,
      [recovered.command.dispatch_job_id],
    );
    const dispatcher = new Phase4Dispatcher(
      new Phase4DispatchRepository(transactions),
      "phase5-actions-terminal-dispatcher",
      async () => {
        throw new Error("terminal Actions reconciliation must not deliver");
      },
    );
    await expect(dispatcher.tick()).resolves.toBe(true);
    const terminal = await pg.query<{
      continuation_status: string;
      wait_status: string;
      action_status: string;
      intent_status: string;
      job_status: string;
      command_status: string;
      reservation_status: string;
      resolution_outcome: string;
      settled_usd: number;
      released_usd: number;
      reservation_version: number;
    }>(
      `SELECT continuation.status AS continuation_status,
              wait.status AS wait_status,action.status AS action_status,
              intent.status AS intent_status,job.status AS job_status,
              command.status AS command_status,
              reservation.status AS reservation_status,
              reservation.resolution_outcome,
              reservation.settled_usd::float8 AS settled_usd,
              reservation.released_usd::float8 AS released_usd,
              reservation.version AS reservation_version
         FROM human_wait_continuations continuation
         JOIN human_waits wait ON wait.id=continuation.wait_id
         JOIN human_wait_answers answer ON answer.id=continuation.answer_id
         JOIN conversation_actions action ON action.id=answer.action_id
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN dispatch_jobs job ON job.id=continuation.resume_job_id
         JOIN commands command ON command.command_id=job.command_id
         JOIN budget_reservations reservation
           ON reservation.id=continuation.budget_reservation_id
        WHERE continuation.id=$1`,
      [answerEffect.continuation.id],
    );
    expect(terminal.rows[0]).toEqual({
      continuation_status: "failed",
      wait_status: "failed",
      action_status: "failed",
      intent_status: "failed",
      job_status: "dead_letter",
      command_status: "failed",
      reservation_status: "settled",
      resolution_outcome: "partial_usage",
      settled_usd: 2.5,
      released_usd: 7.5,
      reservation_version: expect.any(Number),
    });
    const settledVersion = terminal.rows[0]?.reservation_version;
    await expect(dispatcher.tick()).resolves.toBe(false);
    const replay = await pg.query<{ version: number; status: string }>(
      `SELECT reservation.version,reservation.status
         FROM budget_reservations reservation WHERE reservation.id=$1`,
      [scheduled.budget_reservation_id],
    );
    expect(replay.rows[0]).toEqual({ version: settledVersion, status: "settled" });
  });

  it("rejects stale, expired, and unauthorized answer proposals without records", async () => {
    const { waitId } = await openWait();
    const steering = new ConversationHumanSteeringService(transactions);
    const scope = { projectId, workItemId, conversationId };
    await expect(
      steering.proposeAnswer(ownerId, scope, waitId, {
        idempotency_key: "stale-version",
        expected_version: 2,
        question_hash: questionHash,
        answer: "Stale answer",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      new HumanWaitRecoveryWorker(transactions).scan(100, "2100-01-01T00:00:00.000Z"),
    ).resolves.toBe(1);
    await expect(
      steering.proposeAnswer(ownerId, scope, waitId, {
        idempotency_key: "expired-answer",
        expected_version: 1,
        question_hash: questionHash,
        answer: "Expired answer",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      steering.proposeAnswer(outsiderId, scope, waitId, {
        idempotency_key: "unauthorized-answer",
        expected_version: 1,
        question_hash: questionHash,
        answer: "Unauthorized answer",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const records = await pg.query<{ actions: number; answers: number }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_actions
           WHERE action_type='answer_human_wait') AS actions,
         (SELECT count(*)::int FROM human_wait_answers) AS answers`,
    );
    expect(records.rows[0]).toEqual({ actions: 0, answers: 0 });
  });

  it("falls back a direction for a waiting run without fabricating live delivery", async () => {
    const { scheduled } = await openWait();
    await seedTaskBinding();
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-direction-acceptance`,
    });
    const proposal = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      {
        idempotency_key: "direction-proposal-phase5",
        message: "Use the second migration strategy.",
        action_type: "redirect_agent",
        payload: {
          parameters: {
            task_id: taskId,
            run_id: scheduled.run_id,
            direction: "Use the second migration strategy.",
            delivery_preference: "live_or_checkpoint",
          },
        },
      },
    );
    const result = await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: proposal.action.id,
      idempotency_key: "direction-confirm-phase5",
    });
    expect(result).toMatchObject({
      action: { status: "recorded", sent_at: null, acknowledged_at: null, applied_at: null },
      effect: {
        kind: "delivery_queued",
        delivery_mode: "live",
        target_run_id: scheduled.run_id,
        target_command_id: null,
      },
    });
    const delivery = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => {
          throw new Error("a waiting run must not resolve as a live target");
        },
        enqueue: () => {
          throw new Error("a waiting run must not receive a live command");
        },
        notify: () => {
          throw new Error("a waiting run must not be notified");
        },
      },
      { workerId: "waiting-run-fallback" },
    );
    await expect(delivery.tick()).resolves.toMatchObject({
      action_id: proposal.action.id,
      status: "fallback_queued",
      command_id: null,
    });
    const state = await pg.query<{
      intent_status: string;
      intent_mode: string;
      action_status: string;
      event_statuses: string[];
    }>(
      `SELECT
         intent.status AS intent_status,
         intent.delivery_mode AS intent_mode,
         action.status AS action_status,
         array_agg(event.status ORDER BY event.sequence) AS event_statuses
       FROM conversation_action_delivery_intents intent
       JOIN conversation_actions action ON action.id=intent.action_id
       JOIN conversation_action_delivery_events event ON event.action_id=action.id
       WHERE action.id=$1
       GROUP BY intent.status,intent.delivery_mode,action.status`,
      [proposal.action.id],
    );
    expect(state.rows[0]).toEqual({
      intent_status: "fallback_queued",
      intent_mode: "live",
      action_status: "recorded",
      event_statuses: ["confirmed", "recorded", "fallback_queued"],
    });
  });

  it("delivers one live direction concurrently and records sent, acknowledged, and applied exactly once", async () => {
    const { scheduled, proposal } = await openRunningDirection("live-success");
    const enqueued: CommandEnvelopeT[] = [];
    const notified: string[] = [];
    const transport = {
      resolveTarget: async () => ({
        runner_id: "runner-phase5",
        generation: 7,
      }),
      enqueue: (command: CommandEnvelopeT) => {
        enqueued.push(command);
        return undefined;
      },
      notify: (runnerId: string) => {
        notified.push(runnerId);
        return true;
      },
    };
    const first = new ConversationActionDeliveryWorker(transactions, transport, {
      workerId: "live-delivery-a",
    });
    const second = new ConversationActionDeliveryWorker(
      new PGliteTransactionRunner(pg),
      transport,
      {
        workerId: "live-delivery-b",
      },
    );
    const results = await Promise.all([first.tick(), second.tick()]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)).toMatchObject({
      action_id: proposal.action.id,
      status: "sent",
      command_id: `conversation-action-command:${proposal.action.id}`,
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      command_id: `conversation-action-command:${proposal.action.id}`,
      idempotency_key: `conversation-action-command:${proposal.action.id}`,
      correlation_id: proposal.action.id,
      causation_id: proposal.action.id,
      runner_id: "runner-phase5",
      generation: 7,
      payload: {
        kind: "send_message",
        run_id: scheduled.run_id,
        message: "Use the second migration strategy.",
      },
    });
    expect(notified).toEqual(["runner-phase5"]);
    const ack = {
      protocol: 1 as const,
      event_seq: 20,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: proposal.action.id,
      causation_id: `conversation-action-command:${proposal.action.id}`,
      occurred_at: "2026-07-27T13:01:00.000Z",
      payload: {
        kind: "command_ack" as const,
        command_id: `conversation-action-command:${proposal.action.id}`,
        state: "succeeded" as const,
        detail: "Direction applied.",
      },
    };
    await expect(first.applyCommandAck({ ...ack, runner_id: "runner-attacker" })).rejects.toThrow(
      /scope mismatch/i,
    );
    await expect(first.applyCommandAck({ ...ack, causation_id: "wrong-command" })).rejects.toThrow(
      /scope mismatch/i,
    );
    await expect(
      Promise.all([first.applyCommandAck(ack), second.applyCommandAck(ack)]),
    ).resolves.toEqual([true, true]);
    await expect(
      first.applyCommandAck({
        ...ack,
        payload: {
          ...ack.payload,
          state: "rejected",
          detail: "forged same-sequence state change",
        },
      }),
    ).rejects.toThrow(/sequence replay mismatch/i);

    const evidence = await pg.query<{
      action_status: string;
      intent_status: string;
      events: string[];
      actions: number;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              array_agg(event.status ORDER BY event.sequence) AS events,
              (SELECT count(*)::int FROM conversation_actions
                WHERE id=$1) AS actions
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
        WHERE action.id=$1
        GROUP BY action.status,intent.status`,
      [proposal.action.id],
    );
    expect(evidence.rows[0]).toEqual({
      action_status: "applied",
      intent_status: "applied",
      events: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
      actions: 1,
    });
  });

  it("rejects a conversation action acknowledgement after its run binding becomes poisoned", async () => {
    const { proposal } = await openRunningDirection("poisoned-action-ack");
    const delivery = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => ({
          runner_id: "runner-phase5",
          generation: 7,
        }),
        enqueue: () => undefined,
        notify: () => true,
      },
      {
        workerId: "poisoned-action-ack-delivery",
        deviceAuthorization: new PostgresDeviceActionAuthorization(),
      },
    );
    await expect(delivery.tick()).resolves.toMatchObject({
      action_id: proposal.action.id,
      status: "sent",
    });
    await poisonLocalBindingWithMismatchedDeviceGrant();
    await expect(
      delivery.applyCommandAck(
        {
          protocol: 1,
          event_seq: 20,
          runner_id: "runner-phase5",
          generation: 7,
          correlation_id: proposal.action.id,
          causation_id: `conversation-action-command:${proposal.action.id}`,
          occurred_at: "2026-07-27T13:01:00.000Z",
          payload: {
            kind: "command_ack",
            command_id: `conversation-action-command:${proposal.action.id}`,
            state: "succeeded",
            detail: "forged through a poisoned binding",
          },
        },
        {
          subject: "legacy_runner",
          runner_id: "runner-phase5",
          generation: 7,
        },
      ),
    ).rejects.toMatchObject({ code: "device_run_unauthorized" });
    const state = await pg.query<{
      action_status: string;
      intent_status: string;
      runner_events: number;
    }>(
      `SELECT
         action.status AS action_status,
         intent.status AS intent_status,
         (SELECT count(*)::int FROM runner_events
           WHERE runner_id='runner-phase5'
             AND runner_generation=7
             AND causation_id=$2) AS runner_events
       FROM conversation_actions action
       JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
       WHERE action.id=$1`,
      [proposal.action.id, `conversation-action-command:${proposal.action.id}`],
    );
    expect(state.rows[0]).toEqual({
      action_status: "sent",
      intent_status: "sent",
      runner_events: 0,
    });
  });

  it("queues the same recorded action for checkpoint fallback when a live target is offline", async () => {
    const { proposal } = await openRunningDirection("live-offline");
    let enqueued = 0;
    const worker = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => null,
        enqueue: () => {
          enqueued += 1;
          return undefined;
        },
        notify: () => {
          throw new Error("offline delivery must not notify");
        },
      },
      { workerId: "live-offline-worker" },
    );
    await expect(worker.tick()).resolves.toMatchObject({
      action_id: proposal.action.id,
      status: "fallback_queued",
      command_id: null,
    });
    expect(enqueued).toBe(0);
    await expect(worker.tick()).resolves.toBeNull();
    const evidence = await pg.query<{
      action_status: string;
      intent_status: string;
      events: string[];
      actions: number;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              array_agg(event.status ORDER BY event.sequence) AS events,
              (SELECT count(*)::int FROM conversation_actions
                WHERE id=$1) AS actions
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
        WHERE action.id=$1
        GROUP BY action.status,intent.status`,
      [proposal.action.id],
    );
    expect(evidence.rows[0]).toEqual({
      action_status: "recorded",
      intent_status: "fallback_queued",
      events: ["confirmed", "recorded", "fallback_queued"],
      actions: 1,
    });
  });

  it("atomically rebinds staggered fallback directions to one latest bounded checkpoint document", async () => {
    const { scheduled } = await openRunningDirection("coalesce-seed");
    // The helper already created one confirmed direction; drive it offline.
    const fallback = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => null,
        enqueue: () => {
          throw new Error("offline directions must not enqueue");
        },
        notify: () => false,
      },
      { workerId: "coalesce-fallback" },
    );
    await fallback.tick();
    const assembler = new RelationalTaskContextAssembler(
      transactions,
      new TaskContextStore(transactions),
      { baseUrl: "https://norns.example.test" },
    );
    type SteeringAssembler = {
      pendingSteeringContext(
        tx: V2SqlExecutor,
        task: string,
        project: string,
        maxBytes?: number,
      ): Promise<{ artifact_id: string; content_hash: string; byte_size: number } | null>;
    };
    const steeringAssembler = assembler as unknown as SteeringAssembler;
    const firstRef = await transactions.transaction((tx) =>
      steeringAssembler.pendingSteeringContext(tx, taskId, projectId),
    );
    expect(firstRef).not.toBeNull();

    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-coalesce-second`,
    });
    const second = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      {
        idempotency_key: "coalesce-second-proposal",
        message: "Also preserve the audit receipt.",
        action_type: "redirect_agent",
        payload: {
          parameters: {
            task_id: taskId,
            run_id: scheduled.run_id,
            direction: "Also preserve the audit receipt.",
            delivery_preference: "live_or_checkpoint",
          },
        },
      },
    );
    await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: second.action.id,
      idempotency_key: "coalesce-second-confirmation",
    });
    await fallback.tick();
    const secondRef = await transactions.transaction((tx) =>
      steeringAssembler.pendingSteeringContext(tx, taskId, projectId),
    );
    expect(secondRef?.content_hash).not.toBe(firstRef?.content_hash);
    const bindings = await pg.query<{
      action_id: string;
      context_document_id: string;
      context_hash: string;
      status: string;
    }>(
      `SELECT action_id,context_document_id,context_hash,status
         FROM conversation_action_checkpoint_contexts
        ORDER BY action_id`,
    );
    expect(bindings.rows).toHaveLength(2);
    expect(
      bindings.rows.every(
        (binding) =>
          binding.context_document_id === secondRef?.artifact_id &&
          binding.context_hash === secondRef?.content_hash &&
          binding.status === "prepared",
      ),
    ).toBe(true);
    await expect(
      transactions.transaction((tx) =>
        steeringAssembler.pendingSteeringContext(tx, taskId, projectId, 64),
      ),
    ).rejects.toBeInstanceOf(TaskContextAssemblyError);
  });

  it("delivers a fallback direction in the next ordinary dispatch and lets the real task acknowledgement continue through Phase 4", async () => {
    const { scheduled: firstRun, proposal } = await openRunningDirection("ordinary-checkpoint");
    const delivery = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => null,
        enqueue: () => {
          throw new Error("offline direction must not enqueue");
        },
        notify: () => false,
      },
      { workerId: "ordinary-checkpoint-fallback" },
    );
    await delivery.tick();
    const assembler = new RelationalTaskContextAssembler(
      transactions,
      new TaskContextStore(transactions),
      { baseUrl: "https://norns.example.test" },
    );
    const steeringAssembler = assembler as unknown as {
      pendingSteeringContext(
        tx: V2SqlExecutor,
        task: string,
        project: string,
        maxBytes?: number,
      ): Promise<{
        artifact_id: string;
        content_hash: string;
        byte_size: number;
        storage_ref: string;
      } | null>;
    };
    const directionRef = await transactions.transaction((tx) =>
      steeringAssembler.pendingSteeringContext(tx, taskId, projectId),
    );
    if (!directionRef) throw new Error("missing ordinary checkpoint direction");
    const firstProcessor = new Phase4EventProcessor(transactions);
    const firstEvent = (eventSeq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: "phase5-root-correlation",
      causation_id: firstRun.command_id,
      occurred_at: `2026-07-27T12:0${eventSeq}:00.000Z`,
      payload,
    });
    await firstProcessor.apply(
      firstEvent(2, {
        kind: "runtime_result",
        run_id: firstRun.run_id,
        runtime: firstRun.command.runtime,
        outcome: "completed",
        session_id: null,
        stop_reason: "completed",
        detail: "Initial attempt is ready for review.",
      }) as never,
    );
    await firstProcessor.apply(
      firstEvent(3, {
        kind: "verification_result",
        node_id: taskId,
        commit_sha: publishedCommit,
        passed: true,
        output_digest: "first-run-verification",
      }) as never,
    );
    await firstProcessor.apply(
      firstEvent(4, {
        kind: "run_published",
        run_id: firstRun.run_id,
        outcome: "pushed",
        branch: firstRun.command.target_branch,
        commit_sha: publishedCommit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "Initial review branch.",
      }) as never,
    );
    await firstProcessor.apply(
      firstEvent(5, {
        kind: "run_status",
        run_id: firstRun.run_id,
        status: "completed",
      }) as never,
    );
    await firstProcessor.apply(
      firstEvent(6, {
        kind: "command_ack",
        command_id: firstRun.command_id,
        state: "succeeded",
        detail: "Ready for review rework.",
      }) as never,
    );
    const replacement = await schedule({
      supersedes_run_id: firstRun.run_id,
      context_refs: [
        {
          artifact_id: "phase5-root-context",
          content_hash: "d".repeat(64),
          byte_size: 128,
          storage_ref: "relay://phase5-root-context",
        },
        directionRef,
      ],
    });
    const sent = await pg.query<{
      action_status: string;
      intent_status: string;
      checkpoint_status: string;
      target_command_id: string;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              checkpoint.status AS checkpoint_status,intent.target_command_id
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_checkpoint_contexts checkpoint
           ON checkpoint.action_id=action.id
        WHERE action.id=$1`,
      [proposal.action.id],
    );
    expect(sent.rows[0]).toEqual({
      action_status: "sent",
      intent_status: "sent",
      checkpoint_status: "sent",
      target_command_id: replacement.command_id,
    });
    await deliver(replacement);
    const replacementProcessor = new Phase4EventProcessor(transactions);
    const replacementEvent = (eventSeq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: "phase5-root-correlation",
      causation_id: replacement.command_id,
      occurred_at: `2026-07-27T12:${eventSeq.toString().padStart(2, "0")}:30.000Z`,
      payload,
    });
    await replacementProcessor.apply(
      replacementEvent(7, {
        kind: "run_status",
        run_id: replacement.run_id,
        status: "started",
      }) as never,
    );
    await replacementProcessor.apply(
      replacementEvent(8, {
        kind: "runtime_result",
        run_id: replacement.run_id,
        runtime: replacement.command.runtime,
        outcome: "completed",
        session_id: null,
        stop_reason: "completed",
        detail: "Direction delivered.",
      }) as never,
    );
    await replacementProcessor.apply(
      replacementEvent(9, {
        kind: "verification_result",
        node_id: taskId,
        commit_sha: publishedCommit,
        passed: true,
        output_digest: "ordinary-checkpoint-verification",
      }) as never,
    );
    await replacementProcessor.apply(
      replacementEvent(10, {
        kind: "run_published",
        run_id: replacement.run_id,
        outcome: "pushed",
        branch: replacement.command.target_branch,
        commit_sha: publishedCommit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "Replacement checkpoint.",
      }) as never,
    );
    await replacementProcessor.apply(
      replacementEvent(11, {
        kind: "run_status",
        run_id: replacement.run_id,
        status: "completed",
      }) as never,
    );
    const finalAck = replacementEvent(12, {
      kind: "command_ack",
      command_id: replacement.command_id,
      state: "succeeded",
      detail: "Complete.",
    });
    await expect(delivery.applyCommandAck(finalAck as never)).resolves.toBe(false);
    await expect(replacementProcessor.apply(finalAck as never)).resolves.toEqual({
      duplicate: false,
    });
    const applied = await pg.query<{
      action_status: string;
      intent_status: string;
      checkpoint_status: string;
      command_status: string;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              checkpoint.status AS checkpoint_status,command.status AS command_status
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_checkpoint_contexts checkpoint
           ON checkpoint.action_id=action.id
         JOIN commands command ON command.command_id=$2
        WHERE action.id=$1`,
      [proposal.action.id, replacement.command_id],
    );
    expect(applied.rows[0]).toEqual({
      action_status: "applied",
      intent_status: "applied",
      checkpoint_status: "applied",
      command_status: "succeeded",
    });
  });

  it("buffers an early runner acknowledgement during notify and applies it after the sent receipt", async () => {
    const { scheduled, proposal } = await openRunningDirection("live-early-ack");
    let command: CommandEnvelopeT | null = null;
    const transport = {
      resolveTarget: async () => ({ runner_id: "runner-phase5", generation: 7 }),
      enqueue: (value: CommandEnvelopeT) => {
        command = value;
        return true;
      },
      notify: async () => {
        if (!command) throw new Error("notify ran before relay persistence");
        await worker.applyCommandAck({
          protocol: 1,
          event_seq: 22,
          runner_id: "runner-phase5",
          generation: 7,
          correlation_id: proposal.action.id,
          causation_id: command.command_id,
          occurred_at: "2026-07-27T13:03:00.000Z",
          payload: {
            kind: "command_ack",
            command_id: command.command_id,
            state: "succeeded",
            detail: "Applied before notify returned.",
          },
        });
        return true;
      },
    };
    const worker = new ConversationActionDeliveryWorker(transactions, transport, {
      workerId: "live-early-ack-worker",
    });
    await expect(worker.tick()).resolves.toMatchObject({
      action_id: proposal.action.id,
      status: "sent",
    });
    const evidence = await pg.query<{
      action_status: string;
      intent_status: string;
      events: string[];
      buffered_events: number;
      run_id: string;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              array_agg(event.status ORDER BY event.sequence) AS events,
              (SELECT count(*)::int FROM runner_events
                WHERE causation_id=intent.target_command_id
                  AND event_type='command_ack') AS buffered_events,
              intent.target_run_id AS run_id
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
        WHERE action.id=$1
        GROUP BY action.status,intent.status,intent.target_command_id,
                 intent.target_run_id`,
      [proposal.action.id],
    );
    expect(evidence.rows[0]).toEqual({
      action_status: "applied",
      intent_status: "applied",
      events: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
      buffered_events: 1,
      run_id: scheduled.run_id,
    });
  });

  it("falls back the same action when relay replay reports an inactive command", async () => {
    const { proposal } = await openRunningDirection("live-inactive-relay");
    const cancelled: string[] = [];
    const worker = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => ({ runner_id: "runner-phase5", generation: 7 }),
        enqueue: () => false,
        notify: () => {
          throw new Error("an inactive relay command must not be notified");
        },
        cancel: (commandId) => {
          cancelled.push(commandId);
        },
      },
      { workerId: "live-inactive-relay-worker" },
    );
    await expect(worker.tick()).resolves.toMatchObject({
      action_id: proposal.action.id,
      status: "fallback_queued",
      command_id: null,
    });
    expect(cancelled).toEqual([`conversation-action-command:${proposal.action.id}`]);
    const evidence = await pg.query<{
      action_status: string;
      intent_status: string;
      last_error: string;
      events: string[];
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              intent.last_error,array_agg(event.status ORDER BY event.sequence) AS events
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
        WHERE action.id=$1
        GROUP BY action.status,intent.status,intent.last_error`,
      [proposal.action.id],
    );
    expect(evidence.rows[0]).toEqual({
      action_status: "recorded",
      intent_status: "fallback_queued",
      last_error: "relay_command_not_active",
      events: ["confirmed", "recorded", "fallback_queued"],
    });
  });

  it("falls back the same truthfully sent action after runner rejection without fabricating ack or applied", async () => {
    const { proposal } = await openRunningDirection("live-rejected");
    const worker = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => ({ runner_id: "runner-phase5", generation: 7 }),
        enqueue: () => undefined,
        notify: () => true,
      },
      { workerId: "live-rejected-worker" },
    );
    const sent = await worker.tick();
    expect(sent).toMatchObject({
      action_id: proposal.action.id,
      status: "sent",
    });
    if (!sent?.command_id) throw new Error("missing live direction command");
    const restarted = new ConversationActionDeliveryWorker(
      new PGliteTransactionRunner(pg),
      {
        resolveTarget: async () => {
          throw new Error("ack recovery must not resolve a new target");
        },
        enqueue: () => {
          throw new Error("ack recovery must not enqueue a second command");
        },
        notify: () => {
          throw new Error("ack recovery must not notify again");
        },
      },
      { workerId: "live-rejected-restarted-worker" },
    );
    await expect(
      restarted.applyCommandAck({
        protocol: 1,
        event_seq: 21,
        runner_id: "runner-phase5",
        generation: 7,
        correlation_id: proposal.action.id,
        causation_id: sent.command_id,
        occurred_at: "2026-07-27T13:02:00.000Z",
        payload: {
          kind: "command_ack",
          command_id: sent.command_id,
          state: "rejected",
          detail: "Runtime does not support live message injection.",
        },
      }),
    ).resolves.toBe(true);
    const evidence = await pg.query<{
      action_status: string;
      intent_status: string;
      last_error: string;
      events: string[];
      actions: number;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              intent.last_error,array_agg(event.status ORDER BY event.sequence) AS events,
              (SELECT count(*)::int FROM conversation_actions
                WHERE id=$1) AS actions
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
        WHERE action.id=$1
        GROUP BY action.status,intent.status,intent.last_error`,
      [proposal.action.id],
    );
    expect(evidence.rows[0]).toEqual({
      action_status: "sent",
      intent_status: "fallback_queued",
      last_error: "live_rejected:Runtime does not support live message injection.",
      events: ["confirmed", "recorded", "sent", "fallback_queued"],
      actions: 1,
    });
  });

  it("records an attributable human decision once with approval and immutable delivery evidence", async () => {
    await seedTaskBinding();
    const { proposal } = await confirmCheckpointAction("human-decision", {
      idempotency_key: "proposal-human-decision",
      message: "Use the blue/green migration window.",
      action_type: "record_human_decision",
      payload: {
        parameters: {
          decision_point: "Migration deployment strategy",
          decision: "Use the blue/green migration window.",
          rationale: "It preserves the fastest rollback.",
          task_id: taskId,
        },
      },
    });
    const first = new ConversationActionCheckpointWorker(transactions, {
      workerId: "decision-checkpoint-a",
    });
    const restarted = new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg), {
      workerId: "decision-checkpoint-b",
    });
    const results = await Promise.all([first.tick(), restarted.tick()]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)).toEqual({
      action_id: proposal.action.id,
      state: "applied",
    });
    await expect(restarted.tick()).resolves.toBeNull();
    const evidence = await pg.query<{
      action_status: string;
      intent_status: string;
      events: string[];
      decisions: number;
      approvals: number;
      decision_points: number;
      decided_by: string;
      task_id: string;
    }>(
      `SELECT action.status AS action_status,intent.status AS intent_status,
              array_agg(event.status ORDER BY event.sequence) AS events,
              (SELECT count(*)::int FROM decision_records
                WHERE id=$2) AS decisions,
              (SELECT count(*)::int FROM approvals
                WHERE id=$3) AS approvals,
              (SELECT count(*)::int FROM decision_points
                WHERE id=$4 AND status='resolved') AS decision_points,
              decision.decided_by,
              decision.affected_entities->0->>'entity_id' AS task_id
         FROM conversation_actions action
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
         JOIN conversation_action_delivery_events event ON event.action_id=action.id
         JOIN decision_records decision ON decision.id=$2
        WHERE action.id=$1
        GROUP BY action.status,intent.status,decision.decided_by,
                 decision.affected_entities`,
      [
        proposal.action.id,
        `decision:${proposal.action.id}`,
        `approval:${proposal.action.id}`,
        `decision-point:${proposal.action.id}`,
      ],
    );
    expect(evidence.rows[0]).toEqual({
      action_status: "applied",
      intent_status: "applied",
      events: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
      decisions: 1,
      approvals: 1,
      decision_points: 1,
      decided_by: ownerId,
      task_id: taskId,
    });
  });

  it("pauses and resumes the scoped work and task through explicit action lifecycles", async () => {
    await seedTaskBinding();
    const paused = await confirmCheckpointAction("pause-work", {
      idempotency_key: "proposal-pause-work",
      message: "Pause while the migration window is confirmed.",
      action_type: "pause_work",
      payload: {
        parameters: {
          reason: "The migration window is not yet confirmed.",
          task_id: taskId,
        },
      },
    });
    const pauseWorker = new ConversationActionCheckpointWorker(transactions, {
      workerId: "pause-checkpoint",
    });
    await expect(pauseWorker.tick()).resolves.toEqual({
      action_id: paused.proposal.action.id,
      state: "applied",
    });
    const pausedState = await pg.query<{
      work_status: string;
      task_state: string;
      action_status: string;
    }>(
      `SELECT item.status AS work_status,task.state AS task_state,
              action.status AS action_status
         FROM work_items item
         JOIN tasks task ON task.id=$2
         JOIN conversation_actions action ON action.id=$3
        WHERE item.id=$1`,
      [workItemId, taskId, paused.proposal.action.id],
    );
    expect(pausedState.rows[0]).toEqual({
      work_status: "executing",
      task_state: "blocked",
      action_status: "applied",
    });

    const resumed = await confirmCheckpointAction("resume-work", {
      idempotency_key: "proposal-resume-work",
      message: "Resume now that the migration window is confirmed.",
      action_type: "resume_work",
      payload: {
        parameters: {
          reason: "The migration window is confirmed.",
          task_id: taskId,
        },
      },
    });
    const restarted = new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg), {
      workerId: "resume-checkpoint",
    });
    await expect(restarted.tick()).resolves.toEqual({
      action_id: resumed.proposal.action.id,
      state: "applied",
    });
    const resumedState = await pg.query<{
      work_status: string;
      task_state: string;
      action_status: string;
      pause_events: string[];
      resume_events: string[];
    }>(
      `SELECT item.status AS work_status,task.state AS task_state,
              resume.status AS action_status,
              (SELECT array_agg(status ORDER BY sequence)
                 FROM conversation_action_delivery_events
                WHERE action_id=$3) AS pause_events,
              (SELECT array_agg(status ORDER BY sequence)
                 FROM conversation_action_delivery_events
                WHERE action_id=$4) AS resume_events
         FROM work_items item
         JOIN tasks task ON task.id=$2
         JOIN conversation_actions resume ON resume.id=$4
        WHERE item.id=$1`,
      [workItemId, taskId, paused.proposal.action.id, resumed.proposal.action.id],
    );
    expect(resumedState.rows[0]).toEqual({
      work_status: "executing",
      task_state: "ready",
      action_status: "applied",
      pause_events: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
      resume_events: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
    });
  });

  it("falls back from unsupported suspend, pauses at the natural published terminal checkpoint, and resumes the same run and reservation", async () => {
    const scheduled = await schedule();
    await deliver(scheduled);
    const processor = new Phase4EventProcessor(transactions);
    await processor.apply(
      envelope(scheduled, 1, {
        kind: "run_status",
        run_id: scheduled.run_id,
        status: "started",
      }) as never,
    );
    await seedTaskBinding();
    let id = 0;
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-active-pause-${++id}`,
      contextBaseUrl: "https://norns.example.test",
    });
    const pauseProposal = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      {
        idempotency_key: "active-pause-proposal",
        message: "Pause this task after its next safe checkpoint.",
        action_type: "pause_work",
        payload: { parameters: { reason: "Review the migration output.", task_id: taskId } },
      },
    );
    const pauseConfirmation = await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: pauseProposal.action.id,
      idempotency_key: "active-pause-confirmation",
    });
    expect(pauseConfirmation).toMatchObject({
      action: { status: "recorded" },
      effect: { kind: "delivery_queued", delivery_mode: "live" },
    });
    const controlCommands: CommandEnvelopeT[] = [];
    const pauseDelivery = new ConversationActionDeliveryWorker(
      transactions,
      {
        resolveTarget: async () => ({ runner_id: "runner-phase5", generation: 7 }),
        enqueue: (command) => {
          controlCommands.push(command);
          return true;
        },
        notify: () => true,
      },
      { workerId: "active-pause-delivery" },
    );
    const sentPause = await pauseDelivery.tick();
    expect(sentPause).toMatchObject({ action_id: pauseProposal.action.id, status: "sent" });
    if (!sentPause?.command_id) throw new Error("pause delivery did not produce a command");
    const sentPauseCommandId = sentPause.command_id;
    expect(controlCommands[0]?.payload).toEqual({
      kind: "suspend",
      run_id: scheduled.run_id,
    });
    await pauseDelivery.applyCommandAck({
      protocol: 1,
      event_seq: 20,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: pauseProposal.action.id,
      causation_id: sentPauseCommandId,
      occurred_at: "2026-07-27T12:01:30.000Z",
      payload: {
        kind: "command_ack",
        command_id: sentPauseCommandId,
        state: "rejected",
        detail: "Runtime cannot suspend in place.",
      },
    });
    const taskEvent = (eventSeq: number, payload: Record<string, unknown>) => ({
      protocol: 1 as const,
      event_seq: eventSeq,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: "phase5-root-correlation",
      causation_id: scheduled.command_id,
      occurred_at: `2026-07-27T12:0${eventSeq - 19}:00.000Z`,
      payload,
    });
    await processor.apply(
      taskEvent(21, {
        kind: "runtime_result",
        run_id: scheduled.run_id,
        runtime: scheduled.command.runtime,
        outcome: "completed",
        session_id: "pause-session",
        stop_reason: "completed",
        detail: "Completed naturally after the pause checkpoint was queued.",
      }) as never,
    );
    await processor.apply(
      taskEvent(22, {
        kind: "verification_result",
        node_id: taskId,
        commit_sha: publishedCommit,
        passed: true,
        output_digest: "pause-verification",
      }) as never,
    );
    await processor.apply(
      taskEvent(23, {
        kind: "run_published",
        run_id: scheduled.run_id,
        outcome: "pushed",
        branch: scheduled.command.target_branch,
        commit_sha: publishedCommit,
        remote: "origin",
        pull_request_url: null,
        pull_request_note: "Pause checkpoint.",
      }) as never,
    );
    await processor.apply(
      taskEvent(24, { kind: "run_status", run_id: scheduled.run_id, status: "completed" }) as never,
    );
    const deferred = await pg.query<{
      run_state: string;
      task_state: string;
      reservation_status: string;
      action_status: string;
      intent_status: string;
    }>(
      `SELECT run.state AS run_state,task.state AS task_state,
              reservation.status AS reservation_status,action.status AS action_status,
              intent.status AS intent_status
         FROM agent_runs run
         JOIN tasks task ON task.id=run.task_id
         JOIN budget_reservations reservation ON reservation.run_id=run.id
         JOIN conversation_actions action ON action.id=$2
         JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
        WHERE run.id=$1`,
      [scheduled.run_id, pauseProposal.action.id],
    );
    expect(deferred.rows[0]).toEqual({
      run_state: "verifying",
      task_state: "verifying",
      reservation_status: "active",
      action_status: "sent",
      intent_status: "fallback_queued",
    });
    await processor.apply(
      taskEvent(25, {
        kind: "command_ack",
        command_id: scheduled.command_id,
        state: "succeeded",
        detail: "Published and stopped.",
      }) as never,
    );
    const paused = await pg.query<{
      run_state: string;
      task_state: string;
      work_status: string;
      reservation_status: string;
      pause_status: string;
      checkpoint_status: string;
      checkpoint_run_id: string;
      checkpoint_reservation_id: string;
    }>(
      `SELECT run.state AS run_state,task.state AS task_state,item.status AS work_status,
              reservation.status AS reservation_status,action.status AS pause_status,
              checkpoint.status AS checkpoint_status,checkpoint.run_id AS checkpoint_run_id,
              checkpoint.budget_reservation_id AS checkpoint_reservation_id
         FROM agent_runs run
         JOIN tasks task ON task.id=run.task_id
         JOIN work_items item ON item.id=$3
         JOIN budget_reservations reservation ON reservation.run_id=run.id
         JOIN conversation_actions action ON action.id=$2
         JOIN conversation_pause_checkpoints checkpoint
           ON checkpoint.pause_action_id=action.id
        WHERE run.id=$1`,
      [scheduled.run_id, pauseProposal.action.id, workItemId],
    );
    expect(paused.rows[0]).toEqual({
      run_state: "waiting_for_human",
      task_state: "blocked",
      work_status: "executing",
      reservation_status: "active",
      pause_status: "applied",
      checkpoint_status: "paused",
      checkpoint_run_id: scheduled.run_id,
      checkpoint_reservation_id: scheduled.budget_reservation_id,
    });
    await expect(
      pg.query(
        `UPDATE conversation_pause_checkpoints
            SET status='leased',lease_owner='forged',lease_expires_at=now()+interval '1 minute'
          WHERE pause_action_id=$1`,
        [pauseProposal.action.id],
      ),
    ).rejects.toThrow(/illegal pause checkpoint lifecycle/i);

    const resumeProposal = await steering.proposeAction(
      ownerId,
      { projectId, workItemId, conversationId },
      {
        idempotency_key: "active-resume-proposal",
        message: "Resume from the reviewed checkpoint.",
        action_type: "resume_work",
        payload: { parameters: { reason: "Review is complete.", task_id: taskId } },
      },
    );
    await steering.confirm(ownerId, {
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      action_id: resumeProposal.action.id,
      idempotency_key: "active-resume-confirmation",
    });
    const checkpointWorker = new ConversationActionCheckpointWorker(transactions, {
      workerId: "active-resume-checkpoint",
      contextBaseUrl: "https://norns.example.test",
    });
    const checkpointResult = await checkpointWorker.tick();
    if (checkpointResult?.state === "failed") {
      const failure = await pg.query<{ failure_code: string | null }>(
        "SELECT failure_code FROM conversation_actions WHERE id=$1",
        [resumeProposal.action.id],
      );
      throw new Error(failure.rows[0]?.failure_code ?? "resume checkpoint failed");
    }
    expect(checkpointResult).toEqual({
      action_id: resumeProposal.action.id,
      state: "checkpoint_queued",
    });
    const exactPauseHashRow = (
      await pg.query<{ context_hash: string }>(
        "SELECT context_hash FROM conversation_pause_checkpoints WHERE pause_action_id=$1",
        [pauseProposal.action.id],
      )
    ).rows[0];
    if (!exactPauseHashRow) throw new Error("pause checkpoint hash was not persisted");
    const exactPauseHash = exactPauseHashRow.context_hash;
    await pg.exec("SET session_replication_role='replica'");
    await pg.query(
      `UPDATE conversation_pause_checkpoints
          SET context_hash=$2,available_at=now()
        WHERE pause_action_id=$1`,
      [pauseProposal.action.id, "f".repeat(64)],
    );
    await pg.exec("SET session_replication_role='origin'");
    const forgedWorker = new PauseResumeContinuationWorker(
      transactions,
      async () => ({ kind: "local", runner_id: "runner-phase5", runner_generation: 7 }),
      undefined,
      "forged-pause-resume",
    );
    await expect(forgedWorker.tick()).rejects.toThrow(
      /pause checkpoint immutable command scope changed/i,
    );
    await pg.exec("SET session_replication_role='replica'");
    await pg.query(
      `UPDATE conversation_pause_checkpoints
          SET context_hash=$2,available_at=now()
        WHERE pause_action_id=$1`,
      [pauseProposal.action.id, exactPauseHash],
    );
    await pg.exec("SET session_replication_role='origin'");
    const resumeWorker = new PauseResumeContinuationWorker(transactions, async () => ({
      kind: "local",
      runner_id: "runner-phase5",
      runner_generation: 7,
    }));
    const provisioned = await resumeWorker.tick();
    expect(provisioned).toMatchObject({
      pause_action_id: pauseProposal.action.id,
      resume_action_id: resumeProposal.action.id,
      command: {
        run_id: scheduled.run_id,
        budget_reservation_id: scheduled.budget_reservation_id,
        expected_revision: publishedCommit,
      },
    });
    if (!provisioned) throw new Error("pause resume continuation was not provisioned");
    const dispatch = new Phase4DispatchRepository(transactions);
    const claim = await dispatch.claim("pause-resume-dispatcher", 30_000);
    expect(claim?.command.command_id).toBe(provisioned?.command.command_id);
    await dispatch.markDelivered(
      provisioned.command.dispatch_job_id,
      "pause-resume-dispatcher",
      "2026-07-27T13:26:00.000Z",
    );
    await processor.apply({
      protocol: 1,
      event_seq: 26,
      runner_id: "runner-phase5",
      generation: 7,
      correlation_id: resumeProposal.action.id,
      causation_id: provisioned.command.command_id,
      occurred_at: "2026-07-27T13:27:00.000Z",
      payload: { kind: "run_status", run_id: scheduled.run_id, status: "started" },
    } as never);
    const resumed = await pg.query<{
      run_state: string;
      task_state: string;
      checkpoint_status: string;
      resume_status: string;
      intent_status: string;
      reservation_status: string;
    }>(
      `SELECT run.state AS run_state,task.state AS task_state,
              checkpoint.status AS checkpoint_status,resume.status AS resume_status,
              intent.status AS intent_status,reservation.status AS reservation_status
         FROM agent_runs run
         JOIN tasks task ON task.id=run.task_id
         JOIN budget_reservations reservation ON reservation.run_id=run.id
         JOIN conversation_pause_checkpoints checkpoint ON checkpoint.run_id=run.id
         JOIN conversation_actions resume ON resume.id=checkpoint.resume_action_id
         JOIN conversation_action_delivery_intents intent ON intent.action_id=resume.id
        WHERE run.id=$1`,
      [scheduled.run_id],
    );
    expect(resumed.rows[0]).toEqual({
      run_state: "running",
      task_state: "in_progress",
      checkpoint_status: "resumed",
      resume_status: "applied",
      intent_status: "applied",
      reservation_status: "active",
    });
  });

  it("records and explicitly approves one immutable execution plan-change request", async () => {
    const plan = await seedApprovedPlanVersion();
    const proposed = await confirmCheckpointAction("plan-change-proposal", {
      idempotency_key: "proposal-plan-change",
      message: "Add a canary verification step.",
      action_type: "propose_plan_change",
      payload: {
        parameters: {
          plan_version_id: plan.id,
          plan_hash: plan.hash,
          direction: "Add a canary verification step.",
          rationale: "The deployment risk increased.",
        },
      },
    });
    const proposalWorker = new ConversationActionCheckpointWorker(transactions, {
      workerId: "plan-change-proposal-worker",
    });
    await expect(proposalWorker.tick()).resolves.toEqual({
      action_id: proposed.proposal.action.id,
      state: "applied",
    });
    const approval = await confirmCheckpointAction("plan-change-approval", {
      idempotency_key: "approval-plan-change",
      message: "Approve the canary verification change.",
      action_type: "approve_plan_change",
      payload: {
        parameters: {
          proposal_action_id: proposed.proposal.action.id,
          plan_version_id: plan.id,
          plan_hash: plan.hash,
        },
      },
    });
    const approvalWorker = new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg), {
      workerId: "plan-change-approval-worker",
    });
    await expect(approvalWorker.tick()).resolves.toEqual({
      action_id: approval.proposal.action.id,
      state: "applied",
    });
    const request = await pg.query<{
      requests: number;
      status: string;
      action_id: string;
      approved_by_action_id: string;
      plan_version_id: string;
      plan_hash: string;
      proposal_status: string;
      approval_status: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_execution_plan_change_requests
           WHERE action_id=$1) AS requests,
         request.status,request.action_id,request.approved_by_action_id,
         request.plan_version_id,request.plan_hash,
         proposal.status AS proposal_status,approval.status AS approval_status
       FROM conversation_execution_plan_change_requests request
       JOIN conversation_actions proposal ON proposal.id=request.action_id
       JOIN conversation_actions approval ON approval.id=request.approved_by_action_id
       WHERE request.action_id=$1`,
      [proposed.proposal.action.id],
    );
    expect(request.rows[0]).toEqual({
      requests: 1,
      status: "approved",
      action_id: proposed.proposal.action.id,
      approved_by_action_id: approval.proposal.action.id,
      plan_version_id: plan.id,
      plan_hash: plan.hash,
      proposal_status: "applied",
      approval_status: "applied",
    });
  });

  it("queues then restart-safely renders one immutable mockup with visible dual-viewport evidence", async () => {
    await seedTaskBinding();
    const { proposal } = await confirmCheckpointAction("mockup-request", {
      idempotency_key: "proposal-mockup-request",
      message: "Create a responsive deployment-status mockup.",
      action_type: "create_mockup",
      payload: {
        parameters: {
          brief: "Show deployment status, open decisions, and budget.",
          target: "responsive",
          task_id: taskId,
          artifact_refs: [],
        },
      },
    });
    const worker = new ConversationActionCheckpointWorker(transactions, {
      workerId: "mockup-checkpoint-worker",
    });
    await expect(worker.tick()).resolves.toEqual({
      action_id: proposal.action.id,
      state: "phase6_queued",
    });
    await expect(
      new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg)).tick(),
    ).resolves.toBeNull();
    const request = await pg.query<{
      requests: number;
      request_status: string;
      action_status: string;
      intent_status: string;
      events: string[];
    }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_mockup_requests
           WHERE action_id=$1) AS requests,
         request.status AS request_status,action.status AS action_status,
         intent.status AS intent_status,
         array_agg(event.status ORDER BY event.sequence) AS events
       FROM conversation_mockup_requests request
       JOIN conversation_actions action ON action.id=request.action_id
       JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
       JOIN conversation_action_delivery_events event ON event.action_id=action.id
       WHERE request.action_id=$1
       GROUP BY request.status,action.status,intent.status`,
      [proposal.action.id],
    );
    expect(request.rows[0]).toEqual({
      requests: 1,
      request_status: "queued",
      action_status: "recorded",
      intent_status: "fallback_queued",
      events: ["confirmed", "recorded"],
    });

    const restartedTransactions = new PGliteTransactionRunner(pg);
    const mockups = new Phase6MockupService(restartedTransactions);
    const renderer = new Phase6MockupWorker(restartedTransactions, mockups, {
      workerId: "restarted-mockup-renderer",
    });
    const rendered = await renderer.tick();
    if (rendered?.status !== "rendered") {
      const failure = await pg.query<{ last_error: string | null }>(
        "SELECT last_error FROM conversation_mockup_requests WHERE id=$1",
        [`mockup-request:${proposal.action.id}`],
      );
      throw new Error(failure.rows[0]?.last_error ?? "mockup render did not expose an error");
    }
    expect(rendered).toEqual({
      request_id: `mockup-request:${proposal.action.id}`,
      version_id: `mockup-version:mockup-request:${proposal.action.id}`,
      status: "rendered",
    });
    if (!rendered?.version_id) throw new Error("mockup render did not return its exact version");

    const version = await mockups.version(projectId, conversationId, rendered.version_id);
    expect(version).toMatchObject({
      id: rendered.version_id,
      task_id: taskId,
      version: 1,
      status: "candidate",
      brief: "Show deployment status, open decisions, and budget.",
      target: "responsive",
    });
    expect(version.screenshots.map((screenshot) => screenshot.viewport)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(version.interaction_notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("responsive"),
        expect.stringContaining("Show deployment status, open decisions, and budget."),
      ]),
    );

    const durable = await pg.query<{
      artifacts: number;
      messages: number;
      message_parts: unknown;
      action_status: string;
      intent_status: string;
      events: string[];
    }>(
      `SELECT
         (SELECT count(*)::int
            FROM conversation_mockup_version_artifacts artifact
           WHERE artifact.mockup_version_id=$2) AS artifacts,
         (SELECT count(*)::int FROM work_messages message
           WHERE message.conversation_id=$3
             AND message.parts @> $4::jsonb) AS messages,
         (SELECT parts FROM work_messages message
           WHERE message.conversation_id=$3
             AND message.parts @> $4::jsonb LIMIT 1) AS message_parts,
         action.status AS action_status,intent.status AS intent_status,
         array_agg(event.status ORDER BY event.sequence) AS events
       FROM conversation_actions action
       JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
       JOIN conversation_action_delivery_events event ON event.action_id=action.id
       WHERE action.id=$1
       GROUP BY action.status,intent.status`,
      [
        proposal.action.id,
        rendered.version_id,
        conversationId,
        JSON.stringify([{ type: "mockup", mockup_version_id: rendered.version_id }]),
      ],
    );
    expect(durable.rows[0]).toMatchObject({
      artifacts: 2,
      messages: 1,
      action_status: "applied",
      intent_status: "applied",
      events: ["confirmed", "recorded", "sent", "agent_acknowledged", "applied"],
    });
    expect(durable.rows[0]?.message_parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "Mockup version 1 is ready for explicit review.",
        }),
        { type: "mockup", mockup_version_id: rendered.version_id },
      ]),
    );
    await expect(
      new Phase6MockupWorker(new PGliteTransactionRunner(pg), mockups).tick(),
    ).resolves.toBeNull();

    await pg.exec("SET session_replication_role='replica'");
    try {
      await pg.query(
        `INSERT INTO conversation_task_packages (
           id,project_id,work_item_id,conversation_id,handoff_id,
           approved_plan_version_id,module_id,package,canonical_package,content_hash
         ) VALUES (
           'package-phase5',$1,$2,$3,'handoff-phase5',
           'plan-phase5-seeded','module-phase5','{}'::jsonb,'{}',
           encode(sha256(convert_to('{}','UTF8')),'hex')
         )
         ON CONFLICT(id) DO NOTHING`,
        [projectId, workItemId, conversationId],
      );
    } finally {
      await pg.exec("SET session_replication_role='origin'");
    }

    const staleApproval = await confirmCheckpointAction("mockup-stale-approval", {
      idempotency_key: "proposal-mockup-stale-approval",
      message: "Approve the stale mockup manifest.",
      action_type: "approve_mockup",
      payload: {
        parameters: {
          mockup_version_id: version.id,
          task_id: taskId,
          manifest_artifact_id: version.manifest.artifact_id,
          manifest_artifact_hash: "f".repeat(64),
        },
      },
    });
    await expect(
      new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg), {
        workerId: "stale-mockup-approval-worker",
        phase6: mockups,
      }).tick(),
    ).resolves.toEqual({
      action_id: staleApproval.proposal.action.id,
      state: "failed",
    });

    const approval = await confirmCheckpointAction("mockup-approval", {
      idempotency_key: "proposal-mockup-approval",
      message: "Approve the exact rendered mockup.",
      action_type: "approve_mockup",
      payload: {
        parameters: {
          mockup_version_id: version.id,
          task_id: taskId,
          manifest_artifact_id: version.manifest.artifact_id,
          manifest_artifact_hash: version.manifest.content_hash,
        },
      },
    });
    const revision = await confirmCheckpointAction("mockup-revision-race", {
      idempotency_key: "proposal-mockup-revision-race",
      message: "Revise the same exact rendered mockup.",
      action_type: "revise_mockup",
      payload: {
        parameters: {
          mockup_version_id: version.id,
          manifest_artifact_id: version.manifest.artifact_id,
          manifest_artifact_hash: version.manifest.content_hash,
          direction: "Emphasize the failed deployment state.",
        },
      },
    });
    const [approvalResult, revisionResult] = await Promise.all([
      new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg), {
        workerId: "mockup-approval-race-a",
        phase6: mockups,
      }).tick(),
      new ConversationActionCheckpointWorker(new PGliteTransactionRunner(pg), {
        workerId: "mockup-approval-race-b",
        phase6: mockups,
      }).tick(),
    ]);
    const raceStates = [approvalResult?.state, revisionResult?.state];
    expect(raceStates.filter((state) => state === "failed")).toHaveLength(1);
    expect(
      raceStates.filter((state) => state === "applied" || state === "phase6_queued"),
    ).toHaveLength(1);
    const racedDecision = await pg.query<{
      decisions: number;
      decision: string;
      stale_status: string;
      stale_failure: string | null;
      approval_status: string;
      revision_status: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_mockup_decisions
           WHERE mockup_version_id=$1) AS decisions,
         (SELECT decision FROM conversation_mockup_decisions
           WHERE mockup_version_id=$1) AS decision,
         stale.status AS stale_status,stale.failure_code AS stale_failure,
         approval.status AS approval_status,revision.status AS revision_status
       FROM conversation_actions stale
       CROSS JOIN conversation_actions approval
       CROSS JOIN conversation_actions revision
       WHERE stale.id=$2 AND approval.id=$3 AND revision.id=$4`,
      [
        version.id,
        staleApproval.proposal.action.id,
        approval.proposal.action.id,
        revision.proposal.action.id,
      ],
    );
    expect(racedDecision.rows[0]).toMatchObject({
      decisions: 1,
      stale_status: "failed",
    });
    expect(racedDecision.rows[0]?.stale_failure).toContain("manifest race");

    let approvedVersionId = version.id;
    if (racedDecision.rows[0]?.decision === "revision_requested") {
      expect(racedDecision.rows[0]).toMatchObject({
        approval_status: "failed",
        revision_status: "recorded",
      });
      const revised = await renderer.tick();
      expect(revised).toMatchObject({ status: "rendered" });
      if (!revised?.version_id) throw new Error("revision race winner did not render a successor");
      approvedVersionId = revised.version_id;
      const revisedVersion = await mockups.version(projectId, conversationId, revised.version_id);
      expect(revisedVersion).toMatchObject({
        version: 2,
        supersedes_mockup_version_id: version.id,
      });
      expect(revisedVersion.interaction_notes).toEqual(
        expect.arrayContaining([expect.stringContaining("Emphasize the failed deployment state.")]),
      );
      const revisedApproval = await confirmCheckpointAction("revised-mockup-approval", {
        idempotency_key: "proposal-revised-mockup-approval",
        message: "Approve the exact revised mockup.",
        action_type: "approve_mockup",
        payload: {
          parameters: {
            mockup_version_id: revisedVersion.id,
            task_id: taskId,
            manifest_artifact_id: revisedVersion.manifest.artifact_id,
            manifest_artifact_hash: revisedVersion.manifest.content_hash,
          },
        },
      });
      const revisedApprovalResult = await new ConversationActionCheckpointWorker(
        new PGliteTransactionRunner(pg),
        {
          workerId: "revised-mockup-approval-worker",
          phase6: mockups,
        },
      ).tick();
      if (revisedApprovalResult?.state !== "applied") {
        const failure = await pg.query<{ failure_code: string | null }>(
          "SELECT failure_code FROM conversation_actions WHERE id=$1",
          [revisedApproval.proposal.action.id],
        );
        throw new Error(failure.rows[0]?.failure_code ?? "revised mockup approval failed");
      }
      expect(revisedApprovalResult).toEqual({
        action_id: revisedApproval.proposal.action.id,
        state: "applied",
      });
    } else {
      expect(racedDecision.rows[0]).toMatchObject({
        decision: "approved",
        approval_status: "applied",
        revision_status: "failed",
      });
    }
    const supplements = await pg.query<{ supplements: number; decisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_task_package_supplements
           WHERE source_mockup_version_id=$1) AS supplements,
         (SELECT count(*)::int FROM conversation_mockup_decisions
           WHERE mockup_version_id=$1 AND decision='approved') AS decisions`,
      [approvedVersionId],
    );
    expect(supplements.rows[0]).toEqual({ supplements: 1, decisions: 1 });
  });

  it("inherits deterministic PM update defaults and persists project overrides across restart", async () => {
    const service = new ExecutionConversationService(transactions);
    await expect(service.pmSettings(ownerId, projectId)).resolves.toEqual({
      project_id: projectId,
      update_interval_seconds: 300,
      content_level: "standard",
      interval_inherited: true,
      content_level_inherited: true,
      updated_at: null,
    });
    await expect(service.pmSettings(outsiderId, projectId)).rejects.toMatchObject({
      code: "forbidden",
    });
    const overridden = await service.updatePmSettings(ownerId, projectId, {
      update_interval_seconds: 600,
      content_level: "detailed",
    });
    expect(overridden).toMatchObject({
      project_id: projectId,
      update_interval_seconds: 600,
      content_level: "detailed",
      interval_inherited: false,
      content_level_inherited: false,
    });
    expect(overridden.updated_at).not.toBeNull();

    const restarted = new ExecutionConversationService(new PGliteTransactionRunner(pg));
    await expect(restarted.pmSettings(ownerId, projectId)).resolves.toEqual(overridden);
    await expect(
      restarted.updatePmSettings(ownerId, projectId, {
        update_interval_seconds: null,
        content_level: null,
      }),
    ).resolves.toMatchObject({
      project_id: projectId,
      update_interval_seconds: 300,
      content_level: "standard",
      interval_inherited: true,
      content_level_inherited: true,
    });
  });

  it("emits A-B-A PM transitions once, suppresses unchanged state across restart, and never calls a model", async () => {
    const scheduler = new ConversationPmUpdateScheduler(transactions);
    const concurrentFirstAttempts = await Promise.all([
      scheduler.tick("2100-01-01T00:00:00.000Z"),
      new ConversationPmUpdateScheduler(new PGliteTransactionRunner(pg)).tick(
        "2100-01-01T00:00:00.000Z",
      ),
    ]);
    const first = concurrentFirstAttempts.find((evaluation) => evaluation?.emitted);
    expect(concurrentFirstAttempts.filter((evaluation) => evaluation?.emitted)).toHaveLength(1);
    expect(concurrentFirstAttempts.filter((evaluation) => evaluation === null)).toHaveLength(1);
    expect(first).toMatchObject({
      conversation_id: conversationId,
      emitted: true,
      transition_sequence: 1,
      message_id: expect.stringMatching(/^message:conversation-pm-update:/),
      next_due_at: "2100-01-01T00:05:00.000Z",
    });
    const update = await pg.query<{ status: string; content: string }>(
      `SELECT status,content FROM conversation_pm_updates
        WHERE conversation_id=$1`,
      [conversationId],
    );
    expect(update.rows[0]).toEqual({
      status: "working",
      content: "Work is in progress. 0 of 0 tasks are complete.",
    });
    await expect(scheduler.tick("2100-01-01T00:04:59.000Z")).resolves.toBeNull();

    const restarted = new ConversationPmUpdateScheduler(new PGliteTransactionRunner(pg));
    const suppressed = await restarted.tick("2100-01-01T00:05:00.000Z");
    expect(suppressed).toEqual({
      conversation_id: conversationId,
      state_hash: first?.state_hash,
      emitted: false,
      transition_sequence: null,
      message_id: null,
      next_due_at: "2100-01-01T00:10:00.000Z",
    });
    await pg.query("UPDATE work_items SET status='blocked',updated_at=now() WHERE id=$1", [
      workItemId,
    ]);
    const changed = await restarted.tick("2100-01-01T00:10:00.000Z");
    expect(changed).toMatchObject({
      conversation_id: conversationId,
      emitted: true,
      transition_sequence: 2,
      next_due_at: "2100-01-01T00:15:00.000Z",
    });
    expect(changed?.state_hash).not.toBe(first?.state_hash);
    await expect(restarted.tick("2100-01-01T00:10:00.000Z")).resolves.toBeNull();

    await pg.query("UPDATE work_items SET status='executing',updated_at=now() WHERE id=$1", [
      workItemId,
    ]);
    const returnedToFirstState = await new ConversationPmUpdateScheduler(
      new PGliteTransactionRunner(pg),
    ).tick("2100-01-01T00:15:00.000Z");
    expect(returnedToFirstState).toMatchObject({
      conversation_id: conversationId,
      state_hash: first?.state_hash,
      emitted: true,
      transition_sequence: 3,
      next_due_at: "2100-01-01T00:20:00.000Z",
    });
    await expect(
      new ConversationPmUpdateScheduler(new PGliteTransactionRunner(pg)).tick(
        "2100-01-01T00:15:00.000Z",
      ),
    ).resolves.toBeNull();
    const transitions = await pg.query<{
      transition_sequence: number;
      state_hash: string;
      message_sequence: number;
    }>(
      `SELECT update.transition_sequence::int,update.state_hash,
              message.sequence::int AS message_sequence
         FROM conversation_pm_updates update
         JOIN work_messages message ON message.id=update.message_id
        WHERE update.conversation_id=$1
        ORDER BY update.transition_sequence`,
      [conversationId],
    );
    expect(transitions.rows).toEqual([
      {
        transition_sequence: 1,
        state_hash: first?.state_hash,
        message_sequence: 1,
      },
      {
        transition_sequence: 2,
        state_hash: changed?.state_hash,
        message_sequence: 2,
      },
      {
        transition_sequence: 3,
        state_hash: first?.state_hash,
        message_sequence: 3,
      },
    ]);
    const evidence = await pg.query<{
      updates: number;
      messages: number;
      turn_attempts: number;
      usage_events: number;
      evaluation_count: number;
      transition_count: number;
      last_evaluated_at: Date;
      next_due_at: Date;
    }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_pm_updates
           WHERE conversation_id=$1) AS updates,
         (SELECT count(*)::int FROM work_messages
           WHERE conversation_id=$1 AND actor_id='deterministic-pm-update') AS messages,
         (SELECT count(*)::int FROM conversation_turn_attempts
           WHERE conversation_id=$1) AS turn_attempts,
         (SELECT count(*)::int FROM usage_events
           WHERE project_id=$2) AS usage_events,
         cursor.evaluation_count::int,
         cursor.transition_count::int,
         cursor.last_evaluated_at,
         cursor.next_due_at
       FROM conversation_pm_update_cursors cursor
       WHERE cursor.conversation_id=$1`,
      [conversationId, projectId],
    );
    expect(evidence.rows[0]).toMatchObject({
      updates: 3,
      messages: 3,
      turn_attempts: 0,
      usage_events: 0,
      evaluation_count: 4,
      transition_count: 3,
    });
    const schedulerEvidence = evidence.rows[0];
    if (!schedulerEvidence) throw new Error("missing durable PM scheduler evidence");
    expect(new Date(schedulerEvidence.last_evaluated_at).toISOString()).toBe(
      "2100-01-01T00:15:00.000Z",
    );
    expect(new Date(schedulerEvidence.next_due_at).toISOString()).toBe("2100-01-01T00:20:00.000Z");
  });

  it("rejects forged cross-scope and impossible wait transitions at the database boundary", async () => {
    const { waitId } = await openWait();
    await expect(
      pg.query(
        `UPDATE human_waits
            SET session_portability='same_runner',session_portability_evidence=NULL
          WHERE id=$1`,
        [waitId],
      ),
    ).rejects.toBeTruthy();
    await expect(
      pg.query(
        `UPDATE human_waits
            SET status='resumed',answered_at=NULL,resumed_at=NULL
          WHERE id=$1`,
        [waitId],
      ),
    ).rejects.toBeTruthy();
    await expect(
      pg.query("UPDATE human_waits SET work_item_id='forged-work-item' WHERE id=$1", [waitId]),
    ).rejects.toBeTruthy();
    const wait = await pg.query<{
      work_item_id: string;
      status: string;
      session_portability: string;
    }>("SELECT work_item_id,status,session_portability FROM human_waits WHERE id=$1", [waitId]);
    expect(wait.rows[0]).toEqual({
      work_item_id: workItemId,
      status: "awaiting_human",
      session_portability: "transcript_only",
    });
  });
});
