import {
  type V2ActorT,
  V2ConversationAction,
  type V2ConversationActionPayloadT,
  type V2ConversationActionT,
  type V2ConversationActionTypeT,
  type V2CreateWorkConversationInputT,
  type V2CreateWorkItemInputT,
  V2WorkConversation,
  type V2WorkConversationT,
  V2WorkItem,
  type V2WorkItemT,
  V2WorkMessage,
  type V2WorkMessagePartT,
  type V2WorkMessageT,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export type ConversationPersistenceErrorCode =
  | "identity_not_found"
  | "identity_inactive"
  | "project_not_found"
  | "forbidden"
  | "work_item_not_found"
  | "conversation_not_found"
  | "conversation_inactive"
  | "turn_in_progress"
  | "model_ecosystem_mismatch"
  | "historical_retry_forbidden"
  | "conversation_kind_forbidden"
  | "approved_plan_required"
  | "action_not_found"
  | "action_already_confirmed"
  | "idempotency_conflict"
  | "request_fingerprint_mismatch"
  | "conversation_scope_mismatch"
  | "message_not_found"
  | "excerpt_too_large";

export class ConversationPersistenceError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: ConversationPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConversationPersistenceError";
    this.httpStatus =
      code === "forbidden"
        ? 403
        : code === "excerpt_too_large"
          ? 422
          : code.endsWith("_not_found")
            ? 404
            : code === "identity_inactive"
              ? 401
              : 409;
  }
}

interface AccessRow {
  identity_id: string;
  identity_status: string;
  identity_role: string;
  project_id: string | null;
  owner_user_id: string | null;
  active_member: boolean;
}

interface WorkItemRow {
  schema_version: 2;
  id: string;
  project_id: string;
  created_by_user_id: string;
  title: string;
  objective: string;
  status: V2WorkItemT["status"];
  planning_run_id: string | null;
  phase_id: string | null;
  approved_plan_version_id: string | null;
  aggregate_version: number;
  created_at: string | Date;
  updated_at: string | Date;
  execution_started_at: string | Date | null;
  completed_at: string | Date | null;
}

interface ConversationRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  created_by_user_id: string;
  kind: V2WorkConversationT["kind"];
  status: V2WorkConversationT["status"];
  provider: string;
  model: string;
  next_message_sequence: number | string;
  created_at: string | Date;
  updated_at: string | Date;
  archived_at: string | Date | null;
}

interface MessageRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  actor_type: V2ActorT["actor_type"];
  actor_id: string | null;
  role: V2WorkMessageT["role"];
  visibility_status: V2WorkMessageT["visibility_status"];
  sequence: number | string;
  parts: unknown;
  client_message_id: string | null;
  request_fingerprint: string | null;
  created_at: string | Date;
}

interface ActionRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  actor_type: V2ActorT["actor_type"];
  actor_id: string | null;
  source_message_id: string;
  action_type: V2ConversationActionT["action_type"];
  payload: unknown;
  payload_hash: string;
  status: V2ConversationActionT["status"];
  confirmed_by_user_id: string | null;
  confirmation_idempotency_key: string | null;
  confirmation_request_fingerprint: string | null;
  confirmed_at: string | Date | null;
  recorded_at: string | Date | null;
  sent_at: string | Date | null;
  acknowledged_at: string | Date | null;
  applied_at: string | Date | null;
  failure_code: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableIso(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function workItem(row: WorkItemRow): V2WorkItemT {
  return V2WorkItem.parse({
    ...row,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    execution_started_at: nullableIso(row.execution_started_at),
    completed_at: nullableIso(row.completed_at),
  });
}

function conversation(row: ConversationRow): V2WorkConversationT {
  return V2WorkConversation.parse({
    ...row,
    next_message_sequence: Number(row.next_message_sequence),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    archived_at: nullableIso(row.archived_at),
  });
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
    parts: row.parts,
    client_message_id: row.client_message_id,
    request_fingerprint: row.request_fingerprint,
    created_at: iso(row.created_at),
  });
}

function action(row: ActionRow): V2ConversationActionT {
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
    payload: row.payload,
    payload_hash: row.payload_hash,
    status: row.status,
    confirmed_by_user_id: row.confirmed_by_user_id,
    confirmation_idempotency_key: row.confirmation_idempotency_key,
    confirmation_request_fingerprint: row.confirmation_request_fingerprint,
    confirmed_at: nullableIso(row.confirmed_at),
    recorded_at: nullableIso(row.recorded_at),
    sent_at: nullableIso(row.sent_at),
    acknowledged_at: nullableIso(row.acknowledged_at),
    applied_at: nullableIso(row.applied_at),
    failure_code: row.failure_code,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

const workItemColumns = `schema_version, id, project_id, created_by_user_id,
  title, objective, status, planning_run_id, phase_id, approved_plan_version_id, aggregate_version,
  created_at, updated_at, execution_started_at, completed_at`;
const conversationColumns = `schema_version, id, project_id, work_item_id,
  created_by_user_id, kind, status, provider, model, next_message_sequence,
  created_at, updated_at, archived_at`;
const messageColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  initiated_by_user_id, actor_type, actor_id, role, visibility_status, sequence,
  parts, client_message_id, request_fingerprint, created_at`;
const actionColumns = `schema_version, id, project_id, work_item_id, conversation_id,
  initiated_by_user_id, actor_type, actor_id, source_message_id, action_type,
  payload, payload_hash, status, confirmed_by_user_id, confirmation_idempotency_key,
  confirmation_request_fingerprint, confirmed_at, recorded_at, sent_at,
  acknowledged_at, applied_at, failure_code, created_at, updated_at`;

export interface InsertWorkItem {
  id: string;
  actorUserId: string;
  input: V2CreateWorkItemInputT;
}

export interface InsertConversation {
  id: string;
  actorUserId: string;
  input: V2CreateWorkConversationInputT;
}

export interface InsertUserMessage {
  id: string;
  actorUserId: string;
  projectId: string;
  workItemId: string;
  conversationId: string;
  clientMessageId: string;
  requestFingerprint: string;
  parts: V2WorkMessagePartT[];
  attachmentIds: string[];
}

export interface InsertConversationAction {
  id: string;
  actorUserId: string;
  actor: V2ActorT;
  projectId: string;
  workItemId: string;
  conversationId: string;
  sourceMessageId: string;
  actionType: V2ConversationActionTypeT;
  payload: V2ConversationActionPayloadT;
  payloadHash: string;
}

export interface ConversationRepository {
  assertProjectAccess(projectId: string, userId: string): Promise<void>;
  insertWorkItem(input: InsertWorkItem): Promise<V2WorkItemT>;
  findWorkItem(projectId: string, workItemId: string): Promise<V2WorkItemT | null>;
  listWorkItems(projectId: string): Promise<V2WorkItemT[]>;
  updateWorkItemTitle(
    projectId: string,
    workItemId: string,
    title: string,
  ): Promise<V2WorkItemT | null>;
  lockWorkItem(projectId: string, workItemId: string): Promise<V2WorkItemT | null>;
  insertConversation(input: InsertConversation): Promise<V2WorkConversationT>;
  findConversation(projectId: string, conversationId: string): Promise<V2WorkConversationT | null>;
  listConversations(projectId: string, workItemId?: string): Promise<V2WorkConversationT[]>;
  lockConversation(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<V2WorkConversationT | null>;
  updateConversationModel(
    projectId: string,
    workItemId: string,
    conversationId: string,
    model: string,
  ): Promise<V2WorkConversationT | null>;
  findUserMessage(
    conversationId: string,
    userId: string,
    clientMessageId: string,
  ): Promise<V2WorkMessageT | null>;
  hasActiveTurnAttempt(conversationId: string): Promise<boolean>;
  hasActivePlanProposal(conversationId: string): Promise<boolean>;
  insertUserMessage(input: InsertUserMessage): Promise<V2WorkMessageT>;
  listMessages(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<V2WorkMessageT[]>;
  insertAction(input: InsertConversationAction): Promise<V2ConversationActionT>;
  findActionByConfirmationKey(
    conversationId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<V2ConversationActionT | null>;
  lockAction(
    projectId: string,
    workItemId: string,
    conversationId: string,
    actionId: string,
  ): Promise<V2ConversationActionT | null>;
  confirmAction(
    actionId: string,
    userId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<V2ConversationActionT>;
}

export interface ConversationRepositoryStore {
  transaction<T>(work: (repository: ConversationRepository) => Promise<T>): Promise<T>;
}

class SqlConversationRepository implements ConversationRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async assertProjectAccess(projectId: string, userId: string): Promise<void> {
    const result = await this.sql.query<AccessRow>(
      `SELECT identity.id AS identity_id,
              identity.status AS identity_status,
              identity.role AS identity_role,
              project.id AS project_id,
              project.owner_user_id,
              EXISTS (
                SELECT 1
                  FROM project_members membership
                 WHERE membership.project_id=project.id
                   AND membership.user_id=identity.id
                   AND membership.status='active'
              ) AS active_member
         FROM users identity
         LEFT JOIN projects project ON project.id=$2
        WHERE identity.id=$1`,
      [userId, projectId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConversationPersistenceError("identity_not_found", `unknown user "${userId}"`);
    }
    if (row.identity_status !== "active") {
      throw new ConversationPersistenceError("identity_inactive", `user "${userId}" is not active`);
    }
    if (row.project_id === null) {
      throw new ConversationPersistenceError("project_not_found", `unknown project "${projectId}"`);
    }
    if (row.identity_role !== "admin" && row.owner_user_id !== userId && !row.active_member) {
      throw new ConversationPersistenceError(
        "forbidden",
        `user "${userId}" cannot access project "${projectId}"`,
      );
    }
  }

  async insertWorkItem({ id, actorUserId, input }: InsertWorkItem): Promise<V2WorkItemT> {
    const result = await this.sql.query<WorkItemRow>(
      `INSERT INTO work_items (
         id, project_id, created_by_user_id, title, objective
       ) VALUES ($1,$2,$3,$4,$5)
       RETURNING ${workItemColumns}`,
      [id, input.project_id, actorUserId, input.title, input.objective],
    );
    const row = result.rows[0];
    if (!row) throw new Error("work item insert returned no row");
    return workItem(row);
  }

  async findWorkItem(projectId: string, workItemId: string): Promise<V2WorkItemT | null> {
    const result = await this.sql.query<WorkItemRow>(
      `SELECT ${workItemColumns}
         FROM work_items
        WHERE project_id=$1 AND id=$2`,
      [projectId, workItemId],
    );
    return result.rows[0] ? workItem(result.rows[0]) : null;
  }

  async listWorkItems(projectId: string): Promise<V2WorkItemT[]> {
    const result = await this.sql.query<WorkItemRow>(
      `SELECT ${workItemColumns}
         FROM work_items
        WHERE project_id=$1
        ORDER BY updated_at DESC, created_at DESC, id DESC`,
      [projectId],
    );
    return result.rows.map(workItem);
  }

  async updateWorkItemTitle(
    projectId: string,
    workItemId: string,
    title: string,
  ): Promise<V2WorkItemT | null> {
    const result = await this.sql.query<WorkItemRow>(
      `UPDATE work_items
          SET title=$3,
              aggregate_version=aggregate_version + 1,
              updated_at=NOW()
        WHERE project_id=$1 AND id=$2
        RETURNING ${workItemColumns}`,
      [projectId, workItemId, title],
    );
    return result.rows[0] ? workItem(result.rows[0]) : null;
  }

  async lockWorkItem(projectId: string, workItemId: string): Promise<V2WorkItemT | null> {
    const result = await this.sql.query<WorkItemRow>(
      `SELECT ${workItemColumns}
         FROM work_items
        WHERE project_id=$1 AND id=$2
        FOR UPDATE`,
      [projectId, workItemId],
    );
    return result.rows[0] ? workItem(result.rows[0]) : null;
  }

  async insertConversation({
    id,
    actorUserId,
    input,
  }: InsertConversation): Promise<V2WorkConversationT> {
    const result = await this.sql.query<ConversationRow>(
      `INSERT INTO work_conversations (
         id, project_id, work_item_id, created_by_user_id, kind, provider, model
       )
       SELECT $1,$2,item.id,$4,$5,$6,$7
         FROM work_items item
        WHERE item.project_id=$2 AND item.id=$3
       RETURNING ${conversationColumns}`,
      [
        id,
        input.project_id,
        input.work_item_id,
        actorUserId,
        input.kind,
        input.provider,
        input.model,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConversationPersistenceError(
        "work_item_not_found",
        `unknown work item "${input.work_item_id}" in project "${input.project_id}"`,
      );
    }
    return conversation(row);
  }

  async findConversation(
    projectId: string,
    conversationId: string,
  ): Promise<V2WorkConversationT | null> {
    const result = await this.sql.query<ConversationRow>(
      `SELECT ${conversationColumns}
         FROM work_conversations
        WHERE project_id=$1 AND id=$2`,
      [projectId, conversationId],
    );
    return result.rows[0] ? conversation(result.rows[0]) : null;
  }

  async listConversations(projectId: string, workItemId?: string): Promise<V2WorkConversationT[]> {
    const result = await this.sql.query<ConversationRow>(
      `SELECT ${conversationColumns}
         FROM work_conversations
        WHERE project_id=$1 AND ($2::text IS NULL OR work_item_id=$2)
        ORDER BY updated_at DESC, created_at DESC, id DESC`,
      [projectId, workItemId ?? null],
    );
    return result.rows.map(conversation);
  }

  async lockConversation(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<V2WorkConversationT | null> {
    const result = await this.sql.query<ConversationRow>(
      `SELECT ${conversationColumns}
         FROM work_conversations
        WHERE project_id=$1 AND work_item_id=$2 AND id=$3
        FOR UPDATE`,
      [projectId, workItemId, conversationId],
    );
    return result.rows[0] ? conversation(result.rows[0]) : null;
  }

  async updateConversationModel(
    projectId: string,
    workItemId: string,
    conversationId: string,
    model: string,
  ): Promise<V2WorkConversationT | null> {
    const result = await this.sql.query<ConversationRow>(
      `UPDATE work_conversations
          SET model=$4,
              updated_at=NOW()
        WHERE project_id=$1
          AND work_item_id=$2
          AND id=$3
          AND status='active'
       RETURNING ${conversationColumns}`,
      [projectId, workItemId, conversationId, model],
    );
    return result.rows[0] ? conversation(result.rows[0]) : null;
  }

  async findUserMessage(
    conversationId: string,
    userId: string,
    clientMessageId: string,
  ): Promise<V2WorkMessageT | null> {
    const result = await this.sql.query<MessageRow>(
      `SELECT ${messageColumns}
         FROM work_messages
        WHERE conversation_id=$1
          AND initiated_by_user_id=$2
          AND client_message_id=$3
          AND role='user'`,
      [conversationId, userId, clientMessageId],
    );
    return result.rows[0] ? message(result.rows[0]) : null;
  }

  async hasActiveTurnAttempt(conversationId: string): Promise<boolean> {
    const result = await this.sql.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM conversation_turn_attempts
          WHERE conversation_id=$1
            AND status IN ('pending','streaming')
       ) AS active`,
      [conversationId],
    );
    return result.rows[0]?.active ?? false;
  }

  async hasActivePlanProposal(conversationId: string): Promise<boolean> {
    const result = await this.sql.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM conversation_plan_proposal_attempts
          WHERE conversation_id=$1 AND status='pending'
       ) AS active`,
      [conversationId],
    );
    return result.rows[0]?.active ?? false;
  }

  async insertUserMessage(input: InsertUserMessage): Promise<V2WorkMessageT> {
    const sequenceResult = await this.sql.query<{ sequence: number | string }>(
      `UPDATE work_conversations
          SET next_message_sequence=next_message_sequence+1,
              updated_at=now()
        WHERE project_id=$1 AND work_item_id=$2 AND id=$3 AND status='active'
       RETURNING next_message_sequence-1 AS sequence`,
      [input.projectId, input.workItemId, input.conversationId],
    );
    const sequence = sequenceResult.rows[0]?.sequence;
    if (sequence === undefined) {
      throw new ConversationPersistenceError(
        "conversation_inactive",
        `conversation "${input.conversationId}" is not active`,
      );
    }
    const result = await this.sql.query<MessageRow>(
      `INSERT INTO work_messages (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, role, visibility_status, sequence, parts,
         client_message_id, request_fingerprint
       ) VALUES (
         $1,$2,$3,$4,$5,'human',$5,'user','complete',$6,$7::jsonb,$8,$9
       )
       RETURNING ${messageColumns}`,
      [
        input.id,
        input.projectId,
        input.workItemId,
        input.conversationId,
        input.actorUserId,
        sequence,
        JSON.stringify(input.parts),
        input.clientMessageId,
        input.requestFingerprint,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("message insert returned no row");
    for (const attachmentId of input.attachmentIds) {
      await this.sql.query(
        `INSERT INTO work_message_attachment_refs (
           project_id, work_item_id, conversation_id, message_id,
           attachment_id, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.projectId,
          input.workItemId,
          input.conversationId,
          input.id,
          attachmentId,
          input.actorUserId,
        ],
      );
    }
    return message(row);
  }

  async listMessages(
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<V2WorkMessageT[]> {
    const result = await this.sql.query<MessageRow>(
      `SELECT ${messageColumns}
         FROM work_messages
        WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3
        ORDER BY sequence ASC`,
      [projectId, workItemId, conversationId],
    );
    return result.rows.map(message);
  }

  async insertAction(input: InsertConversationAction): Promise<V2ConversationActionT> {
    const result = await this.sql.query<ActionRow>(
      `INSERT INTO conversation_actions (
         id, project_id, work_item_id, conversation_id, initiated_by_user_id,
         actor_type, actor_id, source_message_id, action_type, payload,
         payload_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       RETURNING ${actionColumns}`,
      [
        input.id,
        input.projectId,
        input.workItemId,
        input.conversationId,
        input.actorUserId,
        input.actor.actor_type,
        input.actor.actor_id,
        input.sourceMessageId,
        input.actionType,
        JSON.stringify(input.payload),
        input.payloadHash,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("conversation action insert returned no row");
    return action(row);
  }

  async findActionByConfirmationKey(
    conversationId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<V2ConversationActionT | null> {
    const result = await this.sql.query<ActionRow>(
      `SELECT ${actionColumns}
         FROM conversation_actions
        WHERE conversation_id=$1
          AND confirmed_by_user_id=$2
          AND confirmation_idempotency_key=$3`,
      [conversationId, userId, idempotencyKey],
    );
    return result.rows[0] ? action(result.rows[0]) : null;
  }

  async lockAction(
    projectId: string,
    workItemId: string,
    conversationId: string,
    actionId: string,
  ): Promise<V2ConversationActionT | null> {
    const result = await this.sql.query<ActionRow>(
      `SELECT ${actionColumns}
         FROM conversation_actions
        WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND id=$4
        FOR UPDATE`,
      [projectId, workItemId, conversationId, actionId],
    );
    return result.rows[0] ? action(result.rows[0]) : null;
  }

  async confirmAction(
    actionId: string,
    userId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<V2ConversationActionT> {
    const result = await this.sql.query<ActionRow>(
      `UPDATE conversation_actions
          SET status='confirmed',
              confirmed_by_user_id=$2,
              confirmation_idempotency_key=$3,
              confirmation_request_fingerprint=$4,
              confirmed_at=now(),
              updated_at=now()
        WHERE id=$1 AND status='proposed'
       RETURNING ${actionColumns}`,
      [actionId, userId, idempotencyKey, requestFingerprint],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ConversationPersistenceError(
        "action_already_confirmed",
        `action "${actionId}" is no longer proposed`,
      );
    }
    return action(row);
  }
}

export class PostgresConversationRepository implements ConversationRepositoryStore {
  constructor(private readonly transactions: V2TransactionRunner) {}

  transaction<T>(work: (repository: ConversationRepository) => Promise<T>): Promise<T> {
    return this.transactions.transaction((sql) => work(new SqlConversationRepository(sql)));
  }
}
