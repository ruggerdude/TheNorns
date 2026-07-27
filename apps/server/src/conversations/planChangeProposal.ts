import {
  V2ConversationAction,
  V2CreateConversationPlanChangeProposalInput,
  type V2CreateConversationPlanChangeProposalInputT,
  type V2CreateConversationPlanChangeProposalResponseT,
  V2WorkMessage,
  type V2WorkMessageT,
} from "@norns/contracts";
import { newId } from "../ids.js";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import {
  ConversationPlanWorkflowError,
  type ConversationPlanWorkflowService,
} from "./planWorkflow.js";

interface ChangeProposalRow {
  message_id: string;
  action_id: string;
  request_fingerprint: string;
}

interface MessageRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  actor_type: V2WorkMessageT["actor"]["actor_type"];
  actor_id: string | null;
  role: V2WorkMessageT["role"];
  visibility_status: V2WorkMessageT["visibility_status"];
  sequence: number | string;
  parts: unknown;
  client_message_id: string | null;
  request_fingerprint: string | null;
  created_at: Date | string;
}

function message(row: MessageRow): V2WorkMessageT {
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
    parts: typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts,
    client_message_id: row.client_message_id,
    request_fingerprint: row.request_fingerprint,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  });
}

export class ConversationPlanChangeProposalService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly workflow: ConversationPlanWorkflowService,
    private readonly makeId: (prefix: string) => string = newId,
  ) {}

  async propose(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
    candidate: V2CreateConversationPlanChangeProposalInputT,
  ): Promise<V2CreateConversationPlanChangeProposalResponseT> {
    const input = V2CreateConversationPlanChangeProposalInput.parse(candidate);
    const fingerprint = canonicalSha256({
      project_id: projectId,
      work_item_id: workItemId,
      conversation_id: conversationId,
      plan_version_id: input.plan_version_id,
      plan_hash: input.plan_hash,
      direction: input.direction,
    });
    const stored = await this.transactions.transaction(async (tx) => {
      const scope = await this.lockScope(tx, userId, projectId, workItemId, conversationId);
      const existing = (
        await tx.query<ChangeProposalRow>(
          `SELECT message_id, action_id, request_fingerprint
             FROM conversation_plan_change_proposals
            WHERE conversation_id=$1 AND initiated_by_user_id=$2
              AND idempotency_key=$3
            FOR UPDATE`,
          [conversationId, userId, input.idempotency_key],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new ConversationPlanWorkflowError(
            "idempotency_conflict",
            "plan-change proposal key was reused with different content",
          );
        }
        return existing;
      }
      if (
        !["planning", "awaiting_approval"].includes(scope.work_status) ||
        scope.conversation_status !== "active" ||
        scope.kind !== "planning"
      ) {
        throw new ConversationPlanWorkflowError(
          "invalid_plan_state",
          "plan changes require an active planning conversation",
        );
      }
      const plan = (
        await tx.query<{ id: string; content_hash: string; status: string }>(
          `SELECT id, content_hash, status
             FROM work_plan_versions
            WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
            ORDER BY version DESC LIMIT 1
            FOR UPDATE`,
          [projectId, workItemId, conversationId],
        )
      ).rows[0];
      if (!plan || plan.id !== input.plan_version_id) {
        throw new ConversationPlanWorkflowError(
          "stale_plan_version",
          "the requested plan version is no longer current",
        );
      }
      if (plan.content_hash !== input.plan_hash) {
        throw new ConversationPlanWorkflowError(
          "stale_plan_hash",
          "the requested plan hash is stale",
        );
      }
      if (!["candidate", "in_qc"].includes(plan.status)) {
        throw new ConversationPlanWorkflowError(
          "invalid_plan_state",
          `plan changes cannot be proposed from ${plan.status}`,
        );
      }
      if (
        (
          await tx.query<{ id: string }>(
            `SELECT id FROM conversation_plan_reviews
              WHERE plan_version_id=$1 AND status IN ('queued','running')
              LIMIT 1`,
            [plan.id],
          )
        ).rows[0]
      ) {
        throw new ConversationPlanWorkflowError(
          "qc_in_progress",
          "wait for the active QC review before proposing plan changes",
        );
      }
      const payload = {
        parameters: {
          plan_version_id: plan.id,
          content_hash: plan.content_hash,
          direction: input.direction,
        },
      };
      const payloadHash = canonicalSha256(payload);
      const open = (
        await tx.query<{ id: string; source_message_id: string }>(
          `SELECT id, source_message_id
             FROM conversation_actions
            WHERE conversation_id=$1 AND initiated_by_user_id=$2
              AND action_type='request_plan_changes'
              AND payload_hash=$3 AND status='proposed'
            FOR UPDATE`,
          [conversationId, userId, payloadHash],
        )
      ).rows[0];
      const messageId = open?.source_message_id ?? this.makeId("message");
      const actionId = open?.id ?? this.makeId("conversation_action");
      if (!open) {
        const sequence = (
          await tx.query<{ sequence: number | string }>(
            `UPDATE work_conversations
                SET next_message_sequence=next_message_sequence+1, updated_at=now()
              WHERE id=$1
              RETURNING next_message_sequence-1 AS sequence`,
            [conversationId],
          )
        ).rows[0]?.sequence;
        if (sequence === undefined) throw new Error("could not allocate change message");
        await tx.query(
          `INSERT INTO work_messages (
             id, project_id, work_item_id, conversation_id, initiated_by_user_id,
             actor_type, actor_id, role, visibility_status, sequence, parts,
             client_message_id, request_fingerprint
           ) VALUES (
             $1,$2,$3,$4,$5,'human',$5,'user','complete',$6,$7::jsonb,$8,$9
           )`,
          [
            messageId,
            projectId,
            workItemId,
            conversationId,
            userId,
            sequence,
            JSON.stringify([
              {
                type: "text",
                format: "markdown",
                text: `Requested plan changes:\n\n${input.direction}`,
              },
              { type: "plan", plan_version_id: plan.id },
              { type: "action", action_id: actionId },
            ]),
            `plan-change:${input.idempotency_key}`,
            fingerprint,
          ],
        );
        await tx.query(
          `INSERT INTO conversation_actions (
             id, project_id, work_item_id, conversation_id, initiated_by_user_id,
             actor_type, actor_id, source_message_id, action_type, payload, payload_hash
           ) VALUES (
             $1,$2,$3,$4,$5,'human',$5,$6,'request_plan_changes',$7::jsonb,$8
           )`,
          [
            actionId,
            projectId,
            workItemId,
            conversationId,
            userId,
            messageId,
            JSON.stringify(payload),
            payloadHash,
          ],
        );
      }
      await tx.query(
        `INSERT INTO conversation_plan_change_proposals (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           idempotency_key, request_fingerprint, plan_version_id,
           plan_content_hash, direction, direction_hash, message_id, action_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          this.makeId("plan_change_proposal"),
          projectId,
          workItemId,
          conversationId,
          userId,
          input.idempotency_key,
          fingerprint,
          plan.id,
          plan.content_hash,
          input.direction,
          canonicalSha256(input.direction),
          messageId,
          actionId,
        ],
      );
      return {
        message_id: messageId,
        action_id: actionId,
        request_fingerprint: fingerprint,
      };
    });
    return this.load(userId, projectId, workItemId, conversationId, stored);
  }

  private async load(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
    stored: ChangeProposalRow,
  ): Promise<V2CreateConversationPlanChangeProposalResponseT> {
    const [visible, detail] = await Promise.all([
      this.transactions.transaction(async (tx) => {
        const row = (
          await tx.query<MessageRow>(
            `SELECT schema_version, id, project_id, work_item_id, conversation_id,
                    initiated_by_user_id, actor_type, actor_id, role,
                    visibility_status, sequence, parts, client_message_id,
                    request_fingerprint, created_at
               FROM work_messages
              WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND id=$4`,
            [projectId, workItemId, conversationId, stored.message_id],
          )
        ).rows[0];
        if (!row) throw new Error("plan-change message is unavailable");
        return message(row);
      }),
      this.workflow.detail(userId, projectId, workItemId, conversationId),
    ]);
    const action = detail.actions.find((candidate) => candidate.id === stored.action_id);
    if (!action) throw new Error("plan-change action is unavailable");
    return { message: visible, action: V2ConversationAction.parse(action) };
  }

  private async lockScope(
    tx: V2SqlExecutor,
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<{
    work_status: string;
    conversation_status: string;
    kind: string;
  }> {
    const row = (
      await tx.query<{
        user_status: string;
        role: string;
        owner_user_id: string;
        member: boolean;
        work_status: string;
        conversation_status: string;
        kind: string;
      }>(
        `SELECT identity.status AS user_status, identity.role,
                project.owner_user_id,
                EXISTS (
                  SELECT 1 FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=identity.id
                     AND membership.status='active'
                ) AS member,
                item.status AS work_status,
                conversation.status AS conversation_status,
                conversation.kind
           FROM users identity
           JOIN projects project ON project.id=$2
           JOIN work_items item ON item.project_id=project.id AND item.id=$3
           JOIN work_conversations conversation
             ON conversation.project_id=project.id
            AND conversation.work_item_id=item.id
            AND conversation.id=$4
          WHERE identity.id=$1
          FOR UPDATE OF item, conversation`,
        [userId, projectId, workItemId, conversationId],
      )
    ).rows[0];
    if (!row) {
      throw new ConversationPlanWorkflowError(
        "conversation_not_found",
        "plan-change proposal scope was not found",
      );
    }
    if (
      row.user_status !== "active" ||
      (row.role !== "admin" && row.owner_user_id !== userId && !row.member)
    ) {
      throw new ConversationPlanWorkflowError(
        "forbidden",
        "plan-change proposal access is forbidden",
      );
    }
    return row;
  }
}
