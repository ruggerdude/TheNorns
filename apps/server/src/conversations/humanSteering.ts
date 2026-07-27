import {
  V2ConfirmConversationActionResponse,
  type V2ConfirmConversationActionResponseT,
  V2ConversationAction,
  V2ConversationActionDeliveryEvent,
  V2CreateExecutionActionProposalInput,
  type V2CreateExecutionActionProposalInputT,
  type V2CreateExecutionActionProposalResponse,
  V2CreateHumanWaitAnswerProposalInput,
  type V2CreateHumanWaitAnswerProposalInputT,
  type V2CreateHumanWaitAnswerProposalResponse,
  V2DispatchCommand,
  V2WorkMessage,
  V2_CONVERSATION_ACTION_INTERACTION_CLASS,
  v2CommandIdForDispatchJob,
} from "@norns/contracts";
import { MAX_TOTAL_CONTEXT_BYTES } from "../execution/taskContextAssembler.js";
import { newId } from "../ids.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  transitionV2AgentRunLifecycle,
  transitionV2TaskLifecycle,
} from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";
import { ConversationPersistenceError } from "./repository.js";

type ExecutionProposalResponse = ReturnType<typeof V2CreateExecutionActionProposalResponse.parse>;
type AnswerProposalResponse = ReturnType<typeof V2CreateHumanWaitAnswerProposalResponse.parse>;

interface Scope {
  projectId: string;
  workItemId: string;
  conversationId: string;
}

function json<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function action(row: Record<string, unknown>) {
  return V2ConversationAction.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    initiated_by_user_id: row.initiated_by_user_id,
    actor: { actor_type: row.actor_type, actor_id: row.actor_id },
    source_message_id: row.source_message_id,
    action_type: row.action_type,
    interaction_class: row.interaction_class,
    payload: json(row.payload),
    payload_hash: row.payload_hash,
    status: row.status,
    confirmed_by_user_id: row.confirmed_by_user_id,
    confirmation_idempotency_key: row.confirmation_idempotency_key,
    confirmation_request_fingerprint: row.confirmation_request_fingerprint,
    confirmed_at: row.confirmed_at ? iso(row.confirmed_at as Date | string) : null,
    recorded_at: row.recorded_at ? iso(row.recorded_at as Date | string) : null,
    sent_at: row.sent_at ? iso(row.sent_at as Date | string) : null,
    acknowledged_at: row.acknowledged_at ? iso(row.acknowledged_at as Date | string) : null,
    applied_at: row.applied_at ? iso(row.applied_at as Date | string) : null,
    failure_code: row.failure_code,
    created_at: iso(row.created_at as Date | string),
    updated_at: iso(row.updated_at as Date | string),
  });
}

function message(row: Record<string, unknown>) {
  return V2WorkMessage.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    initiated_by_user_id: row.initiated_by_user_id,
    actor: { actor_type: row.actor_type, actor_id: row.actor_id },
    role: row.role,
    visibility_status: row.visibility_status,
    sequence: Number(row.sequence),
    parts: json(row.parts),
    client_message_id: row.client_message_id,
    request_fingerprint: row.request_fingerprint,
    created_at: iso(row.created_at as Date | string),
  });
}

const actionColumns = `schema_version,id,project_id,work_item_id,conversation_id,
 initiated_by_user_id,actor_type,actor_id,source_message_id,action_type,payload,
 payload_hash,status,confirmed_by_user_id,confirmation_idempotency_key,
 confirmation_request_fingerprint,confirmed_at,recorded_at,sent_at,
 acknowledged_at,applied_at,failure_code,proposal_idempotency_key,
 proposal_request_fingerprint,interaction_class,created_at,updated_at`;
const messageColumns = `schema_version,id,project_id,work_item_id,conversation_id,
 initiated_by_user_id,actor_type,actor_id,role,visibility_status,sequence,parts,
 client_message_id,request_fingerprint,created_at`;

export class ConversationHumanSteeringService {
  private readonly makeId: (prefix: string) => string;
  private readonly contextBaseUrl: string;
  private readonly maxContextBytes: number;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: {
      newId?: (prefix: string) => string;
      contextBaseUrl?: string;
      maxContextBytes?: number;
    } = {},
  ) {
    this.makeId = options.newId ?? newId;
    this.contextBaseUrl = new URL(options.contextBaseUrl ?? "http://127.0.0.1:5173").origin;
    this.maxContextBytes = options.maxContextBytes ?? MAX_TOTAL_CONTEXT_BYTES;
  }

  async proposeAction(
    userId: string,
    scope: Scope,
    candidate: V2CreateExecutionActionProposalInputT,
  ): Promise<ExecutionProposalResponse> {
    const input = V2CreateExecutionActionProposalInput.parse(candidate);
    return this.propose(userId, scope, input.idempotency_key, input.message, {
      action_type: input.action_type,
      payload: input.payload,
    });
  }

  async proposeAnswer(
    userId: string,
    scope: Scope,
    waitId: string,
    candidate: V2CreateHumanWaitAnswerProposalInputT,
  ): Promise<AnswerProposalResponse> {
    const input = V2CreateHumanWaitAnswerProposalInput.parse(candidate);
    return this.propose(
      userId,
      scope,
      input.idempotency_key,
      input.answer,
      {
        action_type: "answer_human_wait",
        payload: {
          parameters: {
            wait_id: waitId,
            expected_version: input.expected_version,
            question_hash: input.question_hash,
            answer: input.answer,
            rationale: input.rationale ?? null,
          },
        },
      },
      waitId,
    );
  }

  private async propose(
    userId: string,
    scope: Scope,
    idempotencyKey: string,
    authoredText: string,
    proposal: {
      action_type: keyof typeof V2_CONVERSATION_ACTION_INTERACTION_CLASS;
      payload: { parameters: Record<string, unknown> };
    },
    waitId?: string,
  ): Promise<ExecutionProposalResponse> {
    const fingerprint = canonicalSha256({
      ...scope,
      authored_text: authoredText,
      action_type: proposal.action_type,
      payload: proposal.payload,
    });
    return this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, scope.projectId, userId);
      const existing = await tx.query<Record<string, unknown>>(
        `SELECT ${actionColumns} FROM conversation_actions
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            AND initiated_by_user_id=$4 AND proposal_idempotency_key=$5`,
        [scope.projectId, scope.workItemId, scope.conversationId, userId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].proposal_request_fingerprint !== fingerprint) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            "action proposal idempotency key was reused with different content",
          );
        }
        const source = await tx.query<Record<string, unknown>>(
          `SELECT ${messageColumns} FROM work_messages
            WHERE id=$1 AND project_id=$2 AND work_item_id=$3 AND conversation_id=$4
              AND role='user' AND initiated_by_user_id=$5`,
          [
            existing.rows[0].source_message_id,
            scope.projectId,
            scope.workItemId,
            scope.conversationId,
            userId,
          ],
        );
        const sourceRow = source.rows[0];
        if (!sourceRow) {
          throw new ConversationPersistenceError(
            "request_fingerprint_mismatch",
            "action proposal source message scope is invalid",
          );
        }
        return { message: message(sourceRow), action: action(existing.rows[0]) };
      }
      const conversation = (
        await tx.query<{
          status: string;
          kind: string;
          next_message_sequence: number | string;
        }>(
          `SELECT status,kind,next_message_sequence FROM work_conversations
            WHERE project_id=$1 AND work_item_id=$2 AND id=$3 FOR UPDATE`,
          [scope.projectId, scope.workItemId, scope.conversationId],
        )
      ).rows[0];
      if (
        !conversation ||
        conversation.status !== "active" ||
        conversation.kind !== "execution_pm"
      ) {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          "execution actions require an active execution PM conversation",
        );
      }
      await this.assertActionScope(tx, scope, proposal.action_type, proposal.payload.parameters);
      if (waitId) {
        const parameters = proposal.payload.parameters as {
          expected_version?: number;
          question_hash?: string;
        };
        const wait = await tx.query<{ id: string }>(
          `SELECT id FROM human_waits
            WHERE id=$1 AND project_id=$2 AND work_item_id=$3 AND conversation_id=$4`,
          [waitId, scope.projectId, scope.workItemId, scope.conversationId],
        );
        if (!wait.rows[0]) {
          throw new ConversationPersistenceError("action_not_found", "human wait not found");
        }
        const currentWait = await tx.query<{ id: string }>(
          `SELECT id FROM human_waits
            WHERE id=$1 AND status='awaiting_human' AND version=$2 AND question_hash=$3
              AND expires_at>now()`,
          [waitId, parameters.expected_version, parameters.question_hash],
        );
        if (!currentWait.rows[0]) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            "human wait is stale, expired, or already answered",
          );
        }
      }
      const actionId = this.makeId("conversation_action");
      const messageId = this.makeId("message");
      const parts = [
        { type: "text", format: "markdown", text: authoredText },
        { type: "action", action_id: actionId },
      ];
      await tx.query(
        `INSERT INTO work_messages (
           id,project_id,work_item_id,conversation_id,initiated_by_user_id,
           actor_type,actor_id,role,visibility_status,sequence,parts,
           client_message_id,request_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,'human',$5,'user','complete',$6,$7::jsonb,$8,$9)`,
        [
          messageId,
          scope.projectId,
          scope.workItemId,
          scope.conversationId,
          userId,
          Number(conversation.next_message_sequence),
          JSON.stringify(parts),
          idempotencyKey,
          fingerprint,
        ],
      );
      await tx.query(
        `UPDATE work_conversations
            SET next_message_sequence=next_message_sequence+1,updated_at=now()
          WHERE id=$1`,
        [scope.conversationId],
      );
      const inserted = await tx.query<Record<string, unknown>>(
        `INSERT INTO conversation_actions (
           id,project_id,work_item_id,conversation_id,initiated_by_user_id,
           actor_type,actor_id,source_message_id,action_type,payload,payload_hash,
           proposal_idempotency_key,proposal_request_fingerprint,interaction_class
         ) VALUES ($1,$2,$3,$4,$5,'human',$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
         RETURNING ${actionColumns}`,
        [
          actionId,
          scope.projectId,
          scope.workItemId,
          scope.conversationId,
          userId,
          messageId,
          proposal.action_type,
          JSON.stringify(proposal.payload),
          canonicalSha256(proposal.payload),
          idempotencyKey,
          fingerprint,
          V2_CONVERSATION_ACTION_INTERACTION_CLASS[proposal.action_type],
        ],
      );
      const insertedAction = inserted.rows[0];
      if (!insertedAction) {
        throw new Error("conversation action insertion returned no row");
      }
      return {
        message: message(
          (await tx.query(`SELECT ${messageColumns} FROM work_messages WHERE id=$1`, [messageId]))
            .rows[0] as Record<string, unknown>,
        ),
        action: action(insertedAction),
      };
    });
  }

  async confirm(
    userId: string,
    input: {
      project_id: string;
      work_item_id: string;
      conversation_id: string;
      action_id: string;
      idempotency_key: string;
    },
  ): Promise<V2ConfirmConversationActionResponseT | null> {
    return this.transactions.transaction(async (tx) => {
      await this.assertAccess(tx, input.project_id, userId);
      const row = (
        await tx.query<Record<string, unknown>>(
          `SELECT ${actionColumns} FROM conversation_actions
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND id=$4
            FOR UPDATE`,
          [input.project_id, input.work_item_id, input.conversation_id, input.action_id],
        )
      ).rows[0];
      if (!row) throw new ConversationPersistenceError("action_not_found", "action not found");
      const current = action(row);
      if (
        [
          "save_plan_candidate",
          "send_plan_to_qc",
          "request_plan_changes",
          "approve_plan",
          "reject_plan",
        ].includes(current.action_type)
      ) {
        return null;
      }
      if (current.confirmed_by_user_id !== null) {
        const expectedFingerprint = canonicalSha256({
          action_id: current.id,
          action_type: current.action_type,
          payload_hash: current.payload_hash,
        });
        if (
          current.confirmed_by_user_id !== userId ||
          current.confirmation_idempotency_key !== input.idempotency_key ||
          current.confirmation_request_fingerprint !== expectedFingerprint
        ) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            "action was already confirmed by another request",
          );
        }
        return this.loadEffect(tx, current);
      }
      if (current.status !== "proposed") {
        throw new ConversationPersistenceError(
          "action_already_confirmed",
          "action is no longer proposed",
        );
      }
      await this.assertActionScope(
        tx,
        {
          projectId: current.project_id,
          workItemId: current.work_item_id,
          conversationId: current.conversation_id,
        },
        current.action_type,
        current.payload.parameters,
      );
      const confirmationFingerprint = canonicalSha256({
        action_id: current.id,
        action_type: current.action_type,
        payload_hash: current.payload_hash,
      });
      await tx.query(
        `UPDATE conversation_actions
            SET status='confirmed',confirmed_by_user_id=$2,
                confirmation_idempotency_key=$3,
                confirmation_request_fingerprint=$4,confirmed_at=now(),updated_at=now()
          WHERE id=$1`,
        [current.id, userId, input.idempotency_key, confirmationFingerprint],
      );
      const confirmed = await this.loadAction(tx, current.id);
      const target = confirmed.payload.parameters as { run_id?: string; task_id?: string | null };
      let targetRunId = target.run_id ?? null;
      if (
        (confirmed.action_type === "pause_work" || confirmed.action_type === "resume_work") &&
        target.task_id
      ) {
        targetRunId =
          (
            await tx.query<{ id: string }>(
              `SELECT run.id FROM agent_runs run
                WHERE run.task_id=$1 AND run.is_designated AND run.superseded_at IS NULL
                  AND run.state='running'`,
              [target.task_id],
            )
          ).rows[0]?.id ?? null;
      }
      const mode =
        confirmed.action_type === "redirect_agent" ||
        (confirmed.action_type === "pause_work" && targetRunId !== null)
          ? "live"
          : "checkpoint";
      await this.insertDeliveryEvent(tx, confirmed, 1, "confirmed", mode, {
        kind: "confirmation",
        fingerprint: confirmationFingerprint,
      });
      if (confirmed.action_type === "answer_human_wait") {
        return this.confirmAnswer(tx, userId, confirmed);
      }
      const intentId = `action-delivery:${confirmed.id}`;
      await tx.query(
        `INSERT INTO conversation_action_delivery_intents (
           id,project_id,work_item_id,conversation_id,action_id,delivery_mode,
           target_run_id,status,payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8::jsonb)`,
        [
          intentId,
          confirmed.project_id,
          confirmed.work_item_id,
          confirmed.conversation_id,
          confirmed.id,
          mode,
          targetRunId,
          JSON.stringify(confirmed.payload),
        ],
      );
      await tx.query(
        `UPDATE conversation_actions SET status='recorded',recorded_at=now(),updated_at=now()
          WHERE id=$1`,
        [confirmed.id],
      );
      const delivery = await this.insertDeliveryEvent(tx, confirmed, 2, "recorded", mode, {
        kind: "recorded",
        record_id: intentId,
      });
      const updated = await this.loadAction(tx, confirmed.id);
      return V2ConfirmConversationActionResponse.parse({
        action: updated,
        effect: {
          kind: "delivery_queued",
          delivery_mode: mode,
          delivery_event: delivery,
          target_run_id: targetRunId,
          target_command_id: null,
        },
      });
    });
  }

  private async confirmAnswer(
    tx: V2SqlExecutor,
    userId: string,
    current: ReturnType<typeof action>,
  ): Promise<V2ConfirmConversationActionResponseT> {
    const parameters = current.payload.parameters as {
      wait_id: string;
      expected_version: number;
      question_hash: string;
      answer: string;
      rationale: string | null;
    };
    const wait = (
      await tx.query<Record<string, unknown>>(
        `SELECT * FROM human_waits WHERE id=$1 AND project_id=$2
          AND work_item_id=$3 AND conversation_id=$4 FOR UPDATE`,
        [parameters.wait_id, current.project_id, current.work_item_id, current.conversation_id],
      )
    ).rows[0];
    if (!wait) throw new ConversationPersistenceError("action_not_found", "human wait not found");
    if (
      wait.status !== "awaiting_human" ||
      Number(wait.version) !== parameters.expected_version ||
      wait.question_hash !== parameters.question_hash
    ) {
      throw new ConversationPersistenceError(
        "idempotency_conflict",
        "human wait is stale, expired, or already answered",
      );
    }
    const approvalId = `approval:${parameters.wait_id}`;
    const decisionRecordId = `decision:${parameters.wait_id}`;
    const answerId = `human-wait-answer:${parameters.wait_id}`;
    const answerReceipt = {
      project_id: current.project_id,
      work_item_id: current.work_item_id,
      conversation_id: current.conversation_id,
      wait_id: parameters.wait_id,
      wait_version: parameters.expected_version,
      question_hash: parameters.question_hash,
      action_id: current.id,
      answered_by_user_id: userId,
      answer: parameters.answer,
      rationale: parameters.rationale,
      approval_id: approvalId,
      decision_record_id: decisionRecordId,
    };
    const answerReceiptHash = canonicalSha256(answerReceipt);
    const canonicalAnswerReceipt = canonicalJson(answerReceipt);
    const reservation = (
      await tx.query<{
        id: string;
        status: string;
        project_id: string;
        phase_id: string;
        task_id: string;
        run_id: string;
      }>(
        `SELECT id,status,project_id,phase_id,task_id,run_id
           FROM budget_reservations WHERE id=$1 FOR UPDATE`,
        [wait.budget_reservation_id],
      )
    ).rows[0];
    if (
      !reservation ||
      reservation.status !== "active" ||
      reservation.project_id !== current.project_id ||
      reservation.phase_id !== wait.phase_id ||
      reservation.task_id !== wait.task_id ||
      reservation.run_id !== wait.source_run_id
    ) {
      throw new ConversationPersistenceError(
        "idempotency_conflict",
        "human wait budget is no longer active in the exact source scope",
      );
    }
    await tx.query(
      `INSERT INTO approvals (
         id,project_id,phase_id,kind,subject_entity_type,subject_entity_id,
         actor_id,content_hash,status,approved_at
       ) VALUES ($1,$2,$3,'human_wait_answer','human_wait',$4,$5,$6,'active',now())`,
      [
        approvalId,
        current.project_id,
        wait.phase_id,
        parameters.wait_id,
        userId,
        answerReceiptHash,
      ],
    );
    await tx.query(
      `INSERT INTO decision_records (
         id,project_id,phase_id,decision_point_id,title,rationale,selected_option_id,
         status,decided_by,approval_id,affected_entities
       ) VALUES ($1,$2,$3,$4,$5,$6,'provide_answer','active',$7,$8,$9::jsonb)`,
      [
        decisionRecordId,
        current.project_id,
        wait.phase_id,
        wait.decision_point_id,
        String(wait.decision_point),
        parameters.rationale ?? parameters.answer,
        userId,
        approvalId,
        JSON.stringify([
          { entity_type: "human_wait", entity_id: parameters.wait_id },
          { entity_type: "agent_run", entity_id: wait.source_run_id },
        ]),
      ],
    );
    const resolvedDecision = await tx.query<{ id: string }>(
      `UPDATE decision_points SET status='resolved',resolved_at=now(),updated_at=now()
        WHERE id=$1 AND status='open' RETURNING id`,
      [wait.decision_point_id],
    );
    if (!resolvedDecision.rows[0]) {
      throw new ConversationPersistenceError(
        "idempotency_conflict",
        "human decision point was already resolved",
      );
    }
    await tx.query(
      `INSERT INTO human_wait_answers (
         id,wait_id,project_id,answered_by_user_id,action_id,decision_record_id,
         idempotency_key,request_fingerprint,answer,rationale,answer_receipt_hash
         ,canonical_answer_receipt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        answerId,
        parameters.wait_id,
        current.project_id,
        userId,
        current.id,
        decisionRecordId,
        current.confirmation_idempotency_key ?? current.id,
        current.confirmation_request_fingerprint ?? current.payload_hash,
        parameters.answer,
        parameters.rationale,
        answerReceiptHash,
        canonicalAnswerReceipt,
      ],
    );
    const rootRefs = json<
      Array<{
        artifact_id: string;
        content_hash: string;
        byte_size: number;
        storage_ref: string;
      }>
    >(wait.root_context_refs);
    const queuedDirections = (
      await tx.query<{
        id: string;
        payload: unknown;
        payload_hash: string;
        confirmed_at: Date | string;
      }>(
        `SELECT action.id,action.payload,action.payload_hash,action.confirmed_at
           FROM conversation_actions action
           JOIN conversation_action_delivery_intents intent ON intent.action_id=action.id
          WHERE action.project_id=$1 AND action.work_item_id=$2
            AND action.conversation_id=$3 AND action.action_type='redirect_agent'
            AND action.status IN ('recorded','sent','agent_acknowledged')
            AND action.payload->'parameters'->>'run_id'=$4
            AND intent.status='fallback_queued'
          ORDER BY action.confirmed_at,action.id
          FOR UPDATE OF action,intent`,
        [current.project_id, current.work_item_id, current.conversation_id, wait.source_run_id],
      )
    ).rows.map((row) => ({
      action_id: row.id,
      payload_hash: row.payload_hash,
      direction: json<{ parameters: { direction: string } }>(row.payload).parameters.direction,
      confirmed_at: iso(row.confirmed_at),
    }));
    if (queuedDirections.length > 64) {
      throw new ConversationPersistenceError(
        "excerpt_too_large",
        "more than 64 queued directions cannot be resumed in one continuation; consolidate them first",
      );
    }
    const addendum = canonicalJson({
      schema_version: 1,
      kind: "human_wait_continuation",
      wait_id: parameters.wait_id,
      decision_point: wait.decision_point,
      question: wait.question,
      question_hash: wait.question_hash,
      answer: parameters.answer,
      rationale: parameters.rationale,
      decision_record_id: decisionRecordId,
      approval_id: approvalId,
      answered_by_user_id: userId,
      compact_visible_worker_summary: wait.compact_summary,
      compact_summary_hash: wait.compact_summary_hash,
      root_command_id: wait.source_command_id,
      root_context_refs: rootRefs,
      root_context_hash: wait.context_hash,
      task_package_hash: wait.task_package_hash,
      queued_directions: queuedDirections,
    });
    const bytes = Buffer.from(addendum, "utf8");
    const totalContextBytes =
      rootRefs.reduce((sum, reference) => sum + reference.byte_size, 0) + bytes.byteLength;
    if (totalContextBytes > this.maxContextBytes) {
      throw new ConversationPersistenceError(
        "excerpt_too_large",
        `continuation context is ${totalContextBytes} bytes, over the ${this.maxContextBytes}-byte task context cap`,
      );
    }
    const addendumHash = canonicalSha256(JSON.parse(addendum));
    const documentId = `taskctx_continuation_${addendumHash.slice(0, 32)}`;
    await tx.query(
      `INSERT INTO task_context_blobs(sha256,content) VALUES ($1,$2)
       ON CONFLICT(sha256) DO NOTHING`,
      [addendumHash, bytes],
    );
    await tx.query(
      `INSERT INTO task_context_documents(id,project_id,section,sha256,byte_size,media_type)
       VALUES ($1,$2,'human_wait_continuation',$3,$4,'application/json')
       ON CONFLICT(id) DO NOTHING`,
      [documentId, current.project_id, addendumHash, bytes.byteLength],
    );
    const storedDocument = (
      await tx.query<{
        project_id: string;
        section: string;
        sha256: string;
        byte_size: number | string;
        media_type: string;
      }>(
        `SELECT project_id,section,sha256,byte_size,media_type
           FROM task_context_documents WHERE id=$1`,
        [documentId],
      )
    ).rows[0];
    if (
      !storedDocument ||
      storedDocument.project_id !== current.project_id ||
      storedDocument.section !== "human_wait_continuation" ||
      storedDocument.sha256 !== addendumHash ||
      Number(storedDocument.byte_size) !== bytes.byteLength ||
      storedDocument.media_type !== "application/json"
    ) {
      throw new ConversationPersistenceError(
        "request_fingerprint_mismatch",
        "continuation context document replay does not match exact bytes",
      );
    }
    const replayRef = {
      artifact_id: documentId,
      content_hash: addendumHash,
      byte_size: bytes.byteLength,
      storage_ref: `${this.contextBaseUrl}/api/v2/execution/task-context/${documentId}`,
    };
    for (const direction of queuedDirections) {
      await tx.query(
        `INSERT INTO conversation_action_checkpoint_contexts (
           action_id,project_id,work_item_id,conversation_id,task_id,
           context_document_id,context_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(action_id) DO UPDATE SET
           context_document_id=EXCLUDED.context_document_id,
           context_hash=EXCLUDED.context_hash
         WHERE conversation_action_checkpoint_contexts.status='prepared'`,
        [
          direction.action_id,
          current.project_id,
          current.work_item_id,
          current.conversation_id,
          wait.task_id,
          documentId,
          addendumHash,
        ],
      );
    }
    const continuationId = `human-wait-continuation:${parameters.wait_id}`;
    const resumeJobId = `continuation:${parameters.wait_id}`;
    const resumeCommandId = v2CommandIdForDispatchJob(resumeJobId);
    await tx.query(
      `INSERT INTO human_wait_continuations (
         id,wait_id,answer_id,root_run_id,root_command_id,resume_command_id,
         resume_job_id,budget_reservation_id,saved_commit_sha,context_hash,
         answer_receipt_hash,replay_context_ref,status
         ,canonical_replay_context_ref
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'queued',$13)`,
      [
        continuationId,
        parameters.wait_id,
        answerId,
        wait.root_run_id,
        wait.source_command_id,
        resumeCommandId,
        resumeJobId,
        wait.budget_reservation_id,
        wait.published_commit_sha,
        wait.context_hash,
        answerReceiptHash,
        JSON.stringify(replayRef),
        canonicalJson(replayRef),
      ],
    );
    const updatedWait = await tx.query<{ id: string }>(
      `UPDATE human_waits
          SET status='continuation_queued',version=version+1,answered_at=now(),updated_at=now()
        WHERE id=$1 AND status='awaiting_human' AND version=$2 AND question_hash=$3
          AND expires_at>now()
        RETURNING id`,
      [parameters.wait_id, parameters.expected_version, parameters.question_hash],
    );
    if (!updatedWait.rows[0]) {
      throw new ConversationPersistenceError(
        "idempotency_conflict",
        "human wait changed while the answer was being recorded",
      );
    }
    const renewedReservation = await tx.query<{ id: string }>(
      `UPDATE budget_reservations
          SET expires_at=GREATEST(expires_at,now()+interval '2 hours'),
              version=version+1,updated_at=now()
        WHERE id=$1 AND status='active' RETURNING id`,
      [wait.budget_reservation_id],
    );
    if (!renewedReservation.rows[0]) {
      throw new ConversationPersistenceError(
        "idempotency_conflict",
        "human wait reservation could not be renewed",
      );
    }
    const updateMessageId = `message:answer:${parameters.wait_id}`;
    const conversation = (
      await tx.query<{ next_message_sequence: string | number }>(
        "SELECT next_message_sequence FROM work_conversations WHERE id=$1 FOR UPDATE",
        [current.conversation_id],
      )
    ).rows[0];
    if (!conversation) {
      throw new ConversationPersistenceError(
        "conversation_inactive",
        "human wait conversation no longer exists",
      );
    }
    await tx.query(
      `INSERT INTO work_messages (
         id,project_id,work_item_id,conversation_id,initiated_by_user_id,
         actor_type,actor_id,role,visibility_status,sequence,parts
       ) VALUES ($1,$2,$3,$4,$5,'coordinator',NULL,'assistant','complete',$6,$7::jsonb)`,
      [
        updateMessageId,
        current.project_id,
        current.work_item_id,
        current.conversation_id,
        userId,
        Number(conversation.next_message_sequence),
        JSON.stringify([
          {
            type: "text",
            format: "markdown",
            text: "Decision recorded. Execution is queued to resume from the published checkpoint.",
          },
          {
            type: "human_wait_update",
            human_wait_id: parameters.wait_id,
            status: "continuation_queued",
          },
        ]),
      ],
    );
    await tx.query(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1,updated_at=now()
        WHERE id=$1`,
      [current.conversation_id],
    );
    await tx.query(
      `UPDATE conversation_actions SET status='recorded',recorded_at=now(),updated_at=now()
        WHERE id=$1`,
      [current.id],
    );
    await this.insertDeliveryEvent(tx, current, 2, "recorded", "continuation", {
      kind: "recorded",
      record_id: continuationId,
    });
    return this.loadEffect(tx, await this.loadAction(tx, current.id));
  }

  private async loadEffect(
    tx: V2SqlExecutor,
    current: ReturnType<typeof action>,
  ): Promise<V2ConfirmConversationActionResponseT> {
    if (current.action_type !== "answer_human_wait") {
      const event = (
        await tx.query<Record<string, unknown>>(
          `SELECT * FROM conversation_action_delivery_events
            WHERE action_id=$1 ORDER BY sequence DESC LIMIT 1`,
          [current.id],
        )
      ).rows[0];
      if (!event) {
        throw new Error(`conversation action ${current.id} has no delivery event`);
      }
      return V2ConfirmConversationActionResponse.parse({
        action: current,
        effect: {
          kind: "delivery_queued",
          delivery_mode: event.delivery_mode ?? "checkpoint",
          delivery_event: this.deliveryEvent(event),
          target_run_id: event.target_run_id ?? null,
          target_command_id: event.target_command_id ?? null,
        },
      });
    }
    const parameters = current.payload.parameters as { wait_id: string };
    const wait = (
      await tx.query<Record<string, unknown>>("SELECT * FROM human_waits WHERE id=$1", [
        parameters.wait_id,
      ])
    ).rows[0];
    const answerRow = (
      await tx.query<Record<string, unknown>>("SELECT * FROM human_wait_answers WHERE wait_id=$1", [
        parameters.wait_id,
      ])
    ).rows[0];
    const continuation = (
      await tx.query<Record<string, unknown>>(
        "SELECT * FROM human_wait_continuations WHERE wait_id=$1",
        [parameters.wait_id],
      )
    ).rows[0];
    if (!wait || !answerRow || !continuation) {
      throw new Error(`human wait ${parameters.wait_id} has incomplete confirmation evidence`);
    }
    return V2ConfirmConversationActionResponse.parse({
      action: current,
      effect: {
        kind: "human_wait_answered",
        wait: this.wait(wait),
        answer: {
          schema_version: Number(answerRow.schema_version),
          id: answerRow.id,
          wait_id: answerRow.wait_id,
          project_id: answerRow.project_id,
          answered_by_user_id: answerRow.answered_by_user_id,
          action_id: answerRow.action_id,
          idempotency_key: answerRow.idempotency_key,
          request_fingerprint: answerRow.request_fingerprint,
          answer: answerRow.answer,
          rationale: answerRow.rationale,
          answer_receipt_hash: answerRow.answer_receipt_hash,
          created_at: iso(answerRow.created_at as Date | string),
        },
        continuation: {
          schema_version: Number(continuation.schema_version),
          id: continuation.id,
          wait_id: continuation.wait_id,
          answer_id: continuation.answer_id,
          root_run_id: continuation.root_run_id,
          resume_command_id: continuation.resume_command_id,
          resume_job_id: continuation.resume_job_id,
          budget_reservation_id: continuation.budget_reservation_id,
          saved_commit_sha: continuation.saved_commit_sha,
          context_hash: continuation.context_hash,
          answer_receipt_hash: continuation.answer_receipt_hash,
          replay_context_ref: json(continuation.replay_context_ref),
          runner_id: continuation.runner_id,
          runner_generation:
            continuation.runner_generation === null ? null : Number(continuation.runner_generation),
          delivery_receipt_hash: continuation.delivery_receipt_hash,
          status: continuation.status,
          created_at: iso(continuation.created_at as Date | string),
          updated_at: iso(continuation.updated_at as Date | string),
        },
      },
    });
  }

  private wait(row: Record<string, unknown>) {
    return {
      schema_version: 2 as const,
      id: row.id,
      project_id: row.project_id,
      work_item_id: row.work_item_id,
      conversation_id: row.conversation_id,
      phase_id: row.phase_id,
      task_id: row.task_id,
      source_run_id: row.source_run_id,
      source_event_id: row.source_event_id,
      decision_point: row.decision_point,
      question: row.question,
      question_hash: row.question_hash,
      published: {
        branch: row.published_branch,
        commit_sha: row.published_commit_sha,
        remote: row.published_remote,
      },
      runtime: {
        runtime_id: row.runtime_id,
        session_id: row.runtime_session_id,
        session_portability: row.session_portability,
        session_portability_evidence: row.session_portability_evidence,
      },
      context: {
        root_command_id: row.source_command_id,
        ask_channel_version: Number(row.ask_channel_version),
        ask_instruction_hash: row.ask_instruction_hash,
        root_context_refs: json(row.root_context_refs),
        context_hash: row.context_hash,
        task_package_hash: row.task_package_hash,
        compact_summary: row.compact_summary,
        compact_summary_hash: row.compact_summary_hash,
      },
      budget: { reservation_id: row.budget_reservation_id, root_run_id: row.root_run_id },
      status: row.status,
      version: Number(row.version),
      expires_at: iso(row.expires_at as Date | string),
      answered_at: row.answered_at ? iso(row.answered_at as Date | string) : null,
      resumed_at: row.resumed_at ? iso(row.resumed_at as Date | string) : null,
      created_at: iso(row.created_at as Date | string),
      updated_at: iso(row.updated_at as Date | string),
    };
  }

  private async insertDeliveryEvent(
    tx: V2SqlExecutor,
    current: ReturnType<typeof action>,
    sequence: number,
    status: "confirmed" | "recorded" | "sent" | "agent_acknowledged" | "applied" | "failed",
    mode: "live" | "checkpoint" | "continuation",
    receipt: Record<string, unknown>,
  ) {
    const id = `action-delivery-event:${current.id}:${sequence}`;
    const inserted = await tx.query<Record<string, unknown>>(
      `INSERT INTO conversation_action_delivery_events (
         id,project_id,work_item_id,conversation_id,action_id,sequence,status,
         delivery_mode,target_run_id,target_command_id,receipt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9::jsonb)
       ON CONFLICT(action_id,sequence) DO NOTHING
       RETURNING *`,
      [
        id,
        current.project_id,
        current.work_item_id,
        current.conversation_id,
        current.id,
        sequence,
        status,
        mode,
        JSON.stringify(receipt),
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await tx.query<Record<string, unknown>>(
          `SELECT * FROM conversation_action_delivery_events
            WHERE action_id=$1 AND sequence=$2`,
          [current.id, sequence],
        )
      ).rows[0];
    if (!row) throw new Error("delivery event insert did not persist or replay");
    const replay = this.deliveryEvent(row);
    if (
      replay.status !== status ||
      replay.delivery_mode !== mode ||
      canonicalSha256(replay.receipt) !== canonicalSha256(receipt)
    ) {
      throw new ConversationPersistenceError(
        "request_fingerprint_mismatch",
        "delivery event replay does not match its immutable receipt",
      );
    }
    return replay;
  }

  private deliveryEvent(row: Record<string, unknown>) {
    return V2ConversationActionDeliveryEvent.parse({
      ...row,
      schema_version: Number(row.schema_version),
      sequence: Number(row.sequence),
      receipt: json(row.receipt),
      occurred_at: iso(row.occurred_at as Date | string),
    });
  }

  private async loadAction(tx: V2SqlExecutor, id: string) {
    const row = (
      await tx.query<Record<string, unknown>>(
        `SELECT ${actionColumns} FROM conversation_actions WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) {
      throw new ConversationPersistenceError("action_not_found", "conversation action not found");
    }
    return action(row);
  }

  private async assertAccess(tx: V2SqlExecutor, projectId: string, userId: string) {
    const row = (
      await tx.query<{
        user_id: string | null;
        user_status: string | null;
        identity_role: string | null;
        project_id: string | null;
        owner_user_id: string | null;
        active_member: boolean;
      }>(
        `SELECT identity.id AS user_id,identity.status AS user_status,
                identity.role AS identity_role,project.id AS project_id,
                project.owner_user_id,
                EXISTS (
                  SELECT 1 FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=$1 AND membership.status='active'
                ) AS active_member
           FROM users identity
           LEFT JOIN projects project ON project.id=$2
          WHERE identity.id=$1`,
        [userId, projectId],
      )
    ).rows[0];
    if (!row?.user_id || row.user_status !== "active") {
      throw new ConversationPersistenceError("forbidden", "active user identity is required");
    }
    if (!row.project_id) {
      throw new ConversationPersistenceError("project_not_found", "unknown project");
    }
    if (row.identity_role !== "admin" && row.owner_user_id !== userId && !row.active_member) {
      throw new ConversationPersistenceError("forbidden", "project access is forbidden");
    }
  }

  private async assertActionScope(
    tx: V2SqlExecutor,
    scope: Scope,
    actionType: keyof typeof V2_CONVERSATION_ACTION_INTERACTION_CLASS,
    parameters: Record<string, unknown>,
  ): Promise<void> {
    const requireTask = async (taskId: unknown): Promise<void> => {
      if (taskId === null || taskId === undefined) return;
      const task = await tx.query<{ task_id: string }>(
        `SELECT task_id FROM conversation_task_package_bindings
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND task_id=$4`,
        [scope.projectId, scope.workItemId, scope.conversationId, taskId],
      );
      if (!task.rows[0]) {
        throw new ConversationPersistenceError(
          "action_not_found",
          "action task target is outside the execution conversation",
        );
      }
    };
    if (actionType === "redirect_agent") {
      const target = await tx.query<{ id: string }>(
        `SELECT run.id
           FROM conversation_task_package_bindings binding
           JOIN agent_runs run
             ON run.project_id=binding.project_id
            AND run.phase_id=binding.phase_id
            AND run.task_id=binding.task_id
          WHERE binding.project_id=$1 AND binding.work_item_id=$2
            AND binding.conversation_id=$3 AND binding.task_id=$4 AND run.id=$5`,
        [
          scope.projectId,
          scope.workItemId,
          scope.conversationId,
          parameters.task_id,
          parameters.run_id,
        ],
      );
      if (!target.rows[0]) {
        throw new ConversationPersistenceError(
          "action_not_found",
          "agent direction target is outside the execution conversation",
        );
      }
      return;
    }
    if (
      ["pause_work", "resume_work", "record_human_decision", "create_mockup"].includes(actionType)
    ) {
      await requireTask(parameters.task_id);
    }
    if (actionType === "propose_plan_change" || actionType === "approve_plan_change") {
      const plan = await tx.query<{ id: string }>(
        `SELECT id FROM work_plan_versions
          WHERE project_id=$1 AND work_item_id=$2 AND id=$3 AND content_hash=$4`,
        [scope.projectId, scope.workItemId, parameters.plan_version_id, parameters.plan_hash],
      );
      if (!plan.rows[0]) {
        throw new ConversationPersistenceError(
          "action_not_found",
          "plan change target is outside the work item or its hash is stale",
        );
      }
    }
    if (actionType === "approve_plan_change") {
      const proposal = await tx.query<{ id: string }>(
        `SELECT id FROM conversation_actions
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND id=$4
            AND action_type='propose_plan_change'
            AND payload->'parameters'->>'plan_version_id'=$5
            AND payload->'parameters'->>'plan_hash'=$6
            AND status IN ('confirmed','recorded','sent','agent_acknowledged','applied')`,
        [
          scope.projectId,
          scope.workItemId,
          scope.conversationId,
          parameters.proposal_action_id,
          parameters.plan_version_id,
          parameters.plan_hash,
        ],
      );
      if (!proposal.rows[0]) {
        throw new ConversationPersistenceError(
          "action_not_found",
          "plan-change proposal is not confirmable in this conversation",
        );
      }
    }
    if (actionType === "create_mockup") {
      const refs = parameters.artifact_refs;
      if (Array.isArray(refs) && refs.length > 0) {
        const artifacts = await tx.query<{ count: string | number }>(
          `SELECT count(*) AS count FROM artifacts
            WHERE project_id=$1 AND id=ANY($2::text[])`,
          [scope.projectId, refs],
        );
        if (Number(artifacts.rows[0]?.count ?? 0) !== refs.length) {
          throw new ConversationPersistenceError(
            "action_not_found",
            "mockup request references an artifact outside the project",
          );
        }
      }
    }
  }
}
