import {
  V2ApprovedMockupTaskSupplementContent,
  V2MockupManifest,
  v2MaterializedTaskId,
} from "@norns/contracts";
import {
  PhaseLaunchError,
  type PhaseLaunchResult,
  type PhaseLaunchService,
} from "../coordinator/phaseLaunchService.js";
import { taskContextDocumentId } from "../execution/taskContextStore.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
// PHASE TAB P4 — the real ApprovedPlanExecutionKickoff.
//
// The product decision this implements: approving a plan in the Phase tab IS
// the human strategy-approval gate, so an approve decision auto-starts
// execution. The chain was never a single call, and this service does not
// make it one by reimplementing anything — it drives the EXISTING services in
// order, each with its own invariants intact:
//
//   1. StrategyBridgeService.createPhaseFromPlanningRun — planning_run_id ->
//      phase + proposed StrategyVersion (idempotent saga; profiles ensured;
//      staffing falls back to result.staffing_proposal.recommendations).
//   2. StrategyBridgeService.editStaffing — the human's per-node
//      provider/model overrides recorded with the decision, applied as a
//      superseding strategy version. Nodes without overrides keep the
//      recommendation staffing from step 1.
//   3. StrategyBridgeService.approve — the canonical, transactional strategy
//      approval + materialization (tasks, assignments, budget). The approval
//      originates from the planning-run decision and is attributed
//      accordingly: `approvals.actor_id`/`approved_by` is the deciding human
//      (FK-bound to users), `approved_at` is the decision's decided_at, and
//      the run id rides in the approval command's idempotency key
//      (`planning-run-approve:<runId>`) — on top of the phase's own
//      planning_run_id binding and the strategy's provenance, which both
//      already name the run.
//   4. PhaseLaunchService.startPhase — dispatch through the real coordinator
//      gate. Nothing here bypasses or weakens that gate.
//
// HONESTY CONTRACT (enforced by the decision route, restated here): the
// planning-run approval is recorded BEFORE this service runs and is never
// rolled back by anything below. Every failure path returns
// `{ started: false, detail }` with a human-readable reason — including the
// repo's one-executing-phase-per-project default: if any phase in the project
// is already `active`, the kickoff refuses before mutating anything rather
// than forcing a second executing phase.
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { implementationVisualEvidenceRequirement } from "../phase6/mockups.js";
import {
  type StaffingAssignmentEdit,
  type StrategyBridgeService,
  type StrategyReviewDto,
  assignmentLocalId,
  taskLocalId,
} from "../projects/strategyBridgeService.js";
import type {
  ApprovedPlanExecutionKickoff,
  ApprovedPlanExecutionKickoffInput,
  PlanningRunDecisionDto,
} from "./runService.js";

export interface ExecutionKickoffServiceDeps {
  transactions: V2TransactionRunner;
  bridge: StrategyBridgeService;
  phaseLaunch: PhaseLaunchService;
  now?: () => Date;
}

interface ActivePhaseRow {
  id: string;
  objective_summary: string;
  planning_run_id: string | null;
}

type KickoffReport = { started: boolean; detail: string };

export class ExecutionKickoffService implements ApprovedPlanExecutionKickoff {
  private readonly transactions: V2TransactionRunner;
  private readonly bridge: StrategyBridgeService;
  private readonly phaseLaunch: PhaseLaunchService;
  private readonly now: () => Date;

  constructor(deps: ExecutionKickoffServiceDeps) {
    this.transactions = deps.transactions;
    this.bridge = deps.bridge;
    this.phaseLaunch = deps.phaseLaunch;
    this.now = deps.now ?? (() => new Date());
  }

  async kickoff(input: ApprovedPlanExecutionKickoffInput): Promise<KickoffReport> {
    // Any escape below is converted into a refusal, never a throw: the
    // decision route has already recorded the approval, and a kickoff error
    // must surface as an honest `{ started: false }` report, not a 500.
    try {
      return await this.run(input);
    } catch (error) {
      return {
        started: false,
        detail: describeError(error),
      };
    }
  }

  private async run(input: ApprovedPlanExecutionKickoffInput): Promise<KickoffReport> {
    // ---- 0. one executing phase per project (repo default) -----------------
    // Checked before ANY mutation so a refusal leaves no half-materialized
    // state behind. The plan itself stays approved and recorded; it can be
    // started through the existing strategy/phase flow once the active phase
    // completes.
    const active = await this.transactions.transaction(async (tx) =>
      this.loadActivePhase(tx, input.projectId),
    );
    if (active) {
      if (active.planning_run_id === input.planningRunId) {
        if (input.handoffId) {
          await this.bindConversationTaskPackages(input.projectId, input.handoffId, active.id);
        }
        return {
          started: true,
          detail: `The phase for this plan ("${active.objective_summary}", ${active.id}) is already executing; kickoff replay converged without a second dispatch.`,
        };
      }
      return {
        started: false,
        detail: `Phase "${active.objective_summary}" (${active.id}) is already executing; this project runs one phase at a time. The approved plan is recorded and can be started once the active phase completes.`,
      };
    }

    // The decision's decided_at is the approval's timestamp of record, and
    // the deciding human is its actor of record.
    const decidedAt = (await this.loadDecision(input)) ?? this.now().toISOString();
    const actor = { actor_id: input.decidedBy };

    // ---- 1. materialize the plan (idempotent) ------------------------------
    let review = await this.bridge.createPhaseFromPlanningRun({
      projectId: input.projectId,
      planningRunId: input.planningRunId,
      actor,
    });
    const phaseId = review.phase.id;
    const phaseName = review.phase.objective_summary;

    if (review.strategy?.status === "awaiting_approval") {
      // ---- 2. apply the decision's staffing overrides ----------------------
      const edits = this.overrideEdits(input, review);
      if (edits.length > 0) {
        review = await this.bridge.editStaffing({
          projectId: input.projectId,
          phaseId,
          edits,
          actor,
        });
      }

      // ---- 3. approve + materialize, attributed to the decision ------------
      await this.bridge.approve({
        projectId: input.projectId,
        phaseId,
        actor,
        idempotencyKey: `planning-run-approve:${input.planningRunId}`,
        issuedAt: decidedAt,
      });
    }
    // A strategy already `approved` (a re-entered kickoff after a partial
    // earlier attempt) skips straight to launch; anything else — e.g. blocked
    // by open must-fix findings — surfaces as the bridge's own refusal above.

    // Conversation-first approval freezes one package per plan module before
    // this legacy bridge materializes relational tasks. Bind those exact bytes
    // to the deterministic materialized task ids before any dispatch can see
    // the phase. A missing/tampered/misaligned package refuses kickoff.
    if (input.handoffId) {
      await this.bindConversationTaskPackages(input.projectId, input.handoffId, phaseId);
    }

    // ---- 4. start the phase through the real gate --------------------------
    const result = await this.phaseLaunch.startPhase({
      project_id: input.projectId,
      phase_id: phaseId,
      authorized_by: { actor_type: "human", actor_id: actor.actor_id },
      authorized_by_session_id: `planning-run-decision:${input.planningRunId}`,
      issued_at: this.now().toISOString(),
    });
    return describeLaunch(phaseId, phaseName, result);
  }

  private async bindConversationTaskPackages(
    projectId: string,
    handoffId: string,
    phaseId: string,
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      const packages = await tx.query<{
        id: string;
        work_item_id: string;
        conversation_id: string;
        module_id: string;
        approved_plan_version_id: string;
        package: unknown;
        canonical_package: string;
        content_hash: string;
      }>(
        `SELECT id, work_item_id, conversation_id, module_id, approved_plan_version_id, package,
                canonical_package, content_hash
           FROM conversation_task_packages
          WHERE project_id=$1 AND handoff_id=$2
          ORDER BY module_id, id
          FOR SHARE`,
        [projectId, handoffId],
      );
      if (packages.rows.length === 0) {
        throw new Error(`handoff ${handoffId} has no immutable task packages`);
      }
      for (const taskPackage of packages.rows) {
        const payload =
          typeof taskPackage.package === "string"
            ? JSON.parse(taskPackage.package)
            : taskPackage.package;
        if (
          canonicalJson(payload) !== taskPackage.canonical_package ||
          canonicalSha256(payload) !== taskPackage.content_hash
        ) {
          throw new Error(`task package ${taskPackage.id} failed canonical hash verification`);
        }
        const taskId = v2MaterializedTaskId(phaseId, taskLocalId(taskPackage.module_id));
        const contextDocumentId = taskContextDocumentId(
          projectId,
          "approved_task_package",
          taskPackage.content_hash,
        );
        const canonicalBytes = Buffer.from(taskPackage.canonical_package, "utf8");
        await tx.query(
          `INSERT INTO task_context_blobs (sha256, content)
           VALUES ($1,$2) ON CONFLICT (sha256) DO NOTHING`,
          [taskPackage.content_hash, canonicalBytes],
        );
        await tx.query(
          `INSERT INTO task_context_documents (
             id, project_id, section, sha256, byte_size, media_type
           ) VALUES ($1,$2,'approved_task_package',$3,$4,'application/json')
           ON CONFLICT (id) DO NOTHING`,
          [contextDocumentId, projectId, taskPackage.content_hash, canonicalBytes.byteLength],
        );
        await tx.query(
          `INSERT INTO conversation_task_package_bindings (
             package_id, project_id, work_item_id, conversation_id, handoff_id,
             phase_id, task_id, content_hash, context_document_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (package_id) DO NOTHING`,
          [
            taskPackage.id,
            projectId,
            taskPackage.work_item_id,
            taskPackage.conversation_id,
            handoffId,
            phaseId,
            taskId,
            taskPackage.content_hash,
            contextDocumentId,
          ],
        );
        const bound = (
          await tx.query<{
            project_id: string;
            phase_id: string;
            task_id: string;
            content_hash: string;
            context_document_id: string;
          }>(
            `SELECT project_id, phase_id, task_id, content_hash, context_document_id
               FROM conversation_task_package_bindings
              WHERE package_id=$1`,
            [taskPackage.id],
          )
        ).rows[0];
        if (
          !bound ||
          bound.project_id !== projectId ||
          bound.phase_id !== phaseId ||
          bound.task_id !== taskId ||
          bound.content_hash !== taskPackage.content_hash ||
          bound.context_document_id !== contextDocumentId
        ) {
          throw new Error(`task package ${taskPackage.id} has a conflicting task binding`);
        }
        const lockedTask = await tx.query<{ id: string }>(
          `SELECT id FROM tasks
            WHERE id=$1 AND project_id=$2 AND phase_id=$3
            FOR UPDATE`,
          [taskId, projectId, phaseId],
        );
        if (!lockedTask.rows[0]) {
          throw new Error(`task package ${taskPackage.id} has no materialized task fence`);
        }
        const planningMockups = await tx.query<{
          version_id: string;
          canonical_manifest: string;
          manifest_artifact_id: string;
          manifest_artifact_hash: string;
          decision_id: string;
          action_id: string;
          decided_by_user_id: string;
          decided_at: string | Date;
        }>(
          `SELECT version.id AS version_id,version.canonical_manifest,
                  version.manifest_artifact_id,version.manifest_artifact_hash,
                  decision.id AS decision_id,decision.action_id,
                  decision.decided_by_user_id,decision.created_at AS decided_at
             FROM conversation_handoffs handoff
             JOIN conversation_mockup_versions version
               ON version.project_id=handoff.project_id
              AND version.work_item_id=handoff.work_item_id
              AND version.conversation_id=handoff.source_conversation_id
             JOIN conversation_mockup_requests root_request
               ON root_request.id=version.root_request_id
             JOIN conversation_actions root_action ON root_action.id=root_request.action_id
             JOIN conversation_mockup_decisions decision
               ON decision.mockup_version_id=version.id AND decision.decision='approved'
            WHERE handoff.id=$1 AND handoff.project_id=$2
              AND root_action.payload->'parameters'->>'plan_version_id'
                    =$3
              AND root_action.payload->'parameters'->>'module_id'=$4
            ORDER BY decision.created_at,version.id`,
          [handoffId, projectId, taskPackage.approved_plan_version_id, taskPackage.module_id],
        );
        for (const [mockupIndex, mockup] of planningMockups.rows.entries()) {
          const manifest = V2MockupManifest.parse(JSON.parse(mockup.canonical_manifest));
          const decidedAt =
            mockup.decided_at instanceof Date ? mockup.decided_at.toISOString() : mockup.decided_at;
          const supplement = V2ApprovedMockupTaskSupplementContent.parse({
            schema_version: 2,
            kind: "approved_mockup",
            mockup_version_id: mockup.version_id,
            manifest_artifact_id: mockup.manifest_artifact_id,
            manifest_artifact_hash: mockup.manifest_artifact_hash,
            approval: {
              decision_id: mockup.decision_id,
              action_id: mockup.action_id,
              decided_by_user_id: mockup.decided_by_user_id,
              decided_at: decidedAt,
            },
            brief: manifest.brief,
            target: manifest.target,
            interaction_notes: manifest.interaction_notes,
            renderer_profile: manifest.renderer_profile,
            screenshots: manifest.screenshots,
            implementation_visual_evidence_requirement: implementationVisualEvidenceRequirement(
              mockup.version_id,
            ),
          });
          const canonicalSupplement = canonicalJson(supplement);
          const supplementHash = canonicalSha256(supplement);
          const supplementBytes = Buffer.from(canonicalSupplement, "utf8");
          const contextDocumentId = taskContextDocumentId(
            projectId,
            "approved_mockup",
            supplementHash,
          );
          const existingSupplement = (
            await tx.query<{
              project_id: string;
              work_item_id: string;
              conversation_id: string;
              task_id: string;
              base_package_id: string;
              ordinal: number | string;
              source_mockup_version_id: string;
              content_hash: string;
              context_document_id: string;
            }>(
              `SELECT project_id,work_item_id,conversation_id,task_id,base_package_id,
                      ordinal,source_mockup_version_id,content_hash,context_document_id
                 FROM conversation_task_package_supplements
                WHERE approval_decision_id=$1
                FOR SHARE`,
              [mockup.decision_id],
            )
          ).rows[0];
          const exactStoredSupplement = (stored: typeof existingSupplement): boolean =>
            Boolean(
              stored &&
                stored.project_id === projectId &&
                stored.work_item_id === taskPackage.work_item_id &&
                stored.conversation_id === taskPackage.conversation_id &&
                stored.task_id === taskId &&
                stored.base_package_id === taskPackage.id &&
                Number(stored.ordinal) === mockupIndex + 1 &&
                stored.source_mockup_version_id === mockup.version_id &&
                stored.content_hash === supplementHash &&
                stored.context_document_id === contextDocumentId,
            );
          if (existingSupplement) {
            if (!exactStoredSupplement(existingSupplement)) {
              throw new Error(
                `approved mockup ${mockup.version_id} has a conflicting task supplement`,
              );
            }
            continue;
          }
          await tx.query(
            `INSERT INTO task_context_blobs (sha256,content)
             VALUES ($1,$2) ON CONFLICT (sha256) DO NOTHING`,
            [supplementHash, supplementBytes],
          );
          await tx.query(
            `INSERT INTO task_context_documents (
               id,project_id,section,sha256,byte_size,media_type
             ) VALUES ($1,$2,'approved_mockup',$3,$4,'application/json')
             ON CONFLICT (id) DO NOTHING`,
            [contextDocumentId, projectId, supplementHash, supplementBytes.byteLength],
          );
          await tx.query(
            `INSERT INTO conversation_task_package_supplements (
               id,project_id,work_item_id,conversation_id,task_id,base_package_id,
               ordinal,source_mockup_version_id,approval_decision_id,
               manifest_artifact_id,manifest_artifact_hash,supplement,
               canonical_supplement,content_hash,context_document_id,
               context_byte_size,context_media_type,created_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,
               'application/json',$17
             )`,
            [
              `mockup-supplement:${mockup.decision_id}`,
              projectId,
              taskPackage.work_item_id,
              taskPackage.conversation_id,
              taskId,
              taskPackage.id,
              mockupIndex + 1,
              mockup.version_id,
              mockup.decision_id,
              mockup.manifest_artifact_id,
              mockup.manifest_artifact_hash,
              JSON.stringify(supplement),
              canonicalSupplement,
              supplementHash,
              contextDocumentId,
              supplementBytes.byteLength,
              decidedAt,
            ],
          );
          const storedSupplement = (
            await tx.query<{
              project_id: string;
              work_item_id: string;
              conversation_id: string;
              task_id: string;
              base_package_id: string;
              ordinal: number | string;
              source_mockup_version_id: string;
              content_hash: string;
              context_document_id: string;
            }>(
              `SELECT project_id,work_item_id,conversation_id,task_id,base_package_id,
                      ordinal,source_mockup_version_id,content_hash,context_document_id
                 FROM conversation_task_package_supplements
                WHERE approval_decision_id=$1`,
              [mockup.decision_id],
            )
          ).rows[0];
          if (!exactStoredSupplement(storedSupplement)) {
            throw new Error(
              `approved mockup ${mockup.version_id} has a conflicting task supplement`,
            );
          }
        }
      }
      const taskCount = Number(
        (
          await tx.query<{ count: number | string }>(
            `SELECT count(*) AS count
               FROM tasks
              WHERE project_id=$1 AND phase_id=$2`,
            [projectId, phaseId],
          )
        ).rows[0]?.count ?? 0,
      );
      if (taskCount !== packages.rows.length) {
        throw new Error(
          `handoff ${handoffId} has ${packages.rows.length} task packages for ${taskCount} materialized tasks`,
        );
      }
    });
  }

  /** Maps decision.staffing (node_id -> provider/model) onto the bridge's
   *  assignment local ids, skipping overrides that already match the
   *  recommendation staffing (no pointless superseding version). An override
   *  for a node the plan does not contain is a refusal, not a silent skip. */
  private overrideEdits(
    input: ApprovedPlanExecutionKickoffInput,
    review: StrategyReviewDto,
  ): StaffingAssignmentEdit[] {
    const staffing = input.staffing ?? [];
    if (staffing.length === 0) return [];
    const byAssignment = new Map(
      (review.strategy?.staffing ?? []).map((entry) => [entry.assignment_id, entry]),
    );
    const edits: StaffingAssignmentEdit[] = [];
    for (const entry of staffing) {
      // Shared with the bridge (PHASE TAB P5b): one derivation of the
      // per-node assignment local id, not a re-derived format.
      const assignmentId = assignmentLocalId(entry.node_id);
      const current = byAssignment.get(assignmentId);
      if (!current) {
        throw new Error(
          `staffing override references unknown plan node "${entry.node_id}" — the approved plan has no task for it`,
        );
      }
      if (
        current.provider === entry.provider &&
        current.model === entry.model &&
        current.reasoning_effort === (entry.reasoning_effort ?? null)
      ) {
        continue;
      }
      edits.push({
        assignment_id: assignmentId,
        provider: entry.provider,
        model: entry.model,
        reasoning_effort: entry.reasoning_effort ?? null,
      });
    }
    return edits;
  }

  private async loadActivePhase(
    tx: V2SqlExecutor,
    projectId: string,
  ): Promise<ActivePhaseRow | null> {
    const result = await tx.query<ActivePhaseRow>(
      `SELECT id, objective_summary, planning_run_id
         FROM phases WHERE project_id = $1 AND status = 'active'
        ORDER BY id LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ?? null;
  }

  private async loadDecision(input: ApprovedPlanExecutionKickoffInput): Promise<string | null> {
    const row = await this.transactions.transaction(async (tx) =>
      tx.query<{ decision: PlanningRunDecisionDto | string | null }>(
        "SELECT decision FROM planning_runs WHERE id = $1 AND project_id = $2",
        [input.planningRunId, input.projectId],
      ),
    );
    const raw = row.rows[0]?.decision ?? null;
    if (raw === null) return null;
    const decision = (typeof raw === "string" ? JSON.parse(raw) : raw) as PlanningRunDecisionDto;
    return typeof decision.decided_at === "string" ? decision.decided_at : null;
  }
}

function describeLaunch(
  phaseId: string,
  phaseName: string,
  result: PhaseLaunchResult,
): KickoffReport {
  const name = `"${phaseName}" (${phaseId})`;
  if (result.scheduled.length > 0) {
    const extras: string[] = [];
    if (result.deferred.length > 0) extras.push(`${result.deferred.length} queued`);
    if (result.blocked.length > 0) extras.push(`${result.blocked.length} blocked`);
    const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
    return {
      started: true,
      detail: `Started phase ${name}: ${result.scheduled.length} task(s) dispatched${suffix}.`,
    };
  }
  // Nothing dispatched: the phase never flipped to active (activation happens
  // inside the coordinator gate on a successful schedule), so report the
  // first concrete reason the launcher recorded.
  const reason =
    result.blocked[0]?.blocked_reason ??
    result.deferred[0]?.blocked_reason ??
    "no dependency-ready tasks were schedulable";
  return {
    started: false,
    detail: `Phase ${name} was approved but no tasks could be dispatched: ${reason}`,
  };
}

function describeError(error: unknown): string {
  if (error instanceof PhaseLaunchError) {
    return error.action_required ? `${error.message} ${error.action_required}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
