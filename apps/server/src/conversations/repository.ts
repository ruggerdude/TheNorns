import {
  type V2ActorT,
  V2ConversationAction,
  type V2ConversationActionPayloadT,
  type V2ConversationActionT,
  type V2ConversationActionTypeT,
  V2ConversationFolder,
  type V2ConversationFolderT,
  V2ConversationMessageBranch,
  type V2ConversationMessageBranchT,
  V2ConversationNavigationItem,
  type V2ConversationNavigationItemT,
  type V2CreateWorkConversationInputT,
  type V2CreateWorkItemInputT,
  V2WorkConversation,
  type V2WorkConversationT,
  V2WorkItem,
  V2WorkItemOrganization,
  type V2WorkItemOrganizationT,
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
  | "work_item_active"
  | "conversation_folder_not_found"
  | "conversation_folder_name_conflict"
  | "conversation_folder_order_invalid"
  | "invalid_navigation_cursor"
  | "conversation_not_found"
  | "conversation_inactive"
  | "turn_in_progress"
  | "model_ecosystem_mismatch"
  | "historical_retry_forbidden"
  | "conversation_kind_forbidden"
  | "conversation_branch_unsafe"
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
      code === "invalid_navigation_cursor"
        ? 400
        : code === "forbidden"
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
  workflow: V2WorkItemT["workflow"];
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

interface ConversationFolderRow {
  schema_version: 2;
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  sort_order: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ConversationMessageBranchRow {
  schema_version: 2;
  id: string;
  project_id: string;
  work_item_id: string;
  child_conversation_id: string;
  parent_conversation_id: string;
  source_message_id: string;
  created_by_user_id: string;
  created_at: string | Date;
}

interface WorkItemOrganizationRow {
  schema_version: 2;
  project_id: string;
  user_id: string;
  work_item_id: string;
  folder_id: string | null;
  pinned_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ConversationNavigationRow {
  schema_version: 2;
  id: string;
  project_id: string;
  title: string;
  status: V2WorkItemT["status"];
  folder_id: string | null;
  pinned_at: string | Date | null;
  latest_activity_at: string | Date;
  conversation_count: number | string;
  latest_conversation_id: string | null;
  latest_conversation_kind: V2WorkConversationT["kind"] | null;
  latest_conversation_status: V2WorkConversationT["status"] | null;
  latest_conversation_provider: string | null;
  latest_conversation_model: string | null;
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

function conversationFolder(row: ConversationFolderRow): V2ConversationFolderT {
  return V2ConversationFolder.parse({
    ...row,
    sort_order: Number(row.sort_order),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function conversationMessageBranch(
  row: ConversationMessageBranchRow,
): V2ConversationMessageBranchT {
  return V2ConversationMessageBranch.parse({
    ...row,
    created_at: iso(row.created_at),
  });
}

function workItemOrganization(row: WorkItemOrganizationRow): V2WorkItemOrganizationT {
  return V2WorkItemOrganization.parse({
    ...row,
    pinned_at: nullableIso(row.pinned_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function conversationNavigationItem(row: ConversationNavigationRow): V2ConversationNavigationItemT {
  const latestConversation =
    row.latest_conversation_id === null
      ? null
      : {
          id: row.latest_conversation_id,
          kind: row.latest_conversation_kind,
          status: row.latest_conversation_status,
          provider: row.latest_conversation_provider,
          model: row.latest_conversation_model,
        };
  return V2ConversationNavigationItem.parse({
    schema_version: row.schema_version,
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    folder_id: row.folder_id,
    pinned_at: nullableIso(row.pinned_at),
    latest_activity_at: iso(row.latest_activity_at),
    conversation_count: Number(row.conversation_count),
    latest_conversation: latestConversation,
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
  title, objective, status, workflow, planning_run_id, phase_id, approved_plan_version_id,
  aggregate_version, created_at, updated_at, execution_started_at, completed_at`;
const conversationColumns = `schema_version, id, project_id, work_item_id,
  created_by_user_id, kind, status, provider, model, next_message_sequence,
  created_at, updated_at, archived_at`;
const conversationFolderColumns = `schema_version, id, project_id, user_id,
  name, sort_order, created_at, updated_at`;
const conversationMessageBranchColumns = `schema_version, id, project_id, work_item_id,
  child_conversation_id, parent_conversation_id, source_message_id,
  created_by_user_id, created_at`;
const workItemOrganizationColumns = `schema_version, project_id, user_id, work_item_id,
  folder_id, pinned_at, created_at, updated_at`;
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

export interface BranchPrefixMessage {
  source: V2WorkMessageT;
  id: string;
  clientMessageId: string | null;
}

export interface InsertConversationMessageBranch {
  id: string;
  childConversationId: string;
  actorUserId: string;
  projectId: string;
  workItemId: string;
  parentConversation: V2WorkConversationT;
  sourceMessageId: string;
  prefix: BranchPrefixMessage[];
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

export interface ConversationNavigationCursor {
  pinned: boolean;
  latestActivityAt: string;
  workItemId: string;
}

export interface ConversationNavigationResult {
  items: V2ConversationNavigationItemT[];
  hasMore: boolean;
}

export interface ConversationRepository {
  assertProjectAccess(projectId: string, userId: string): Promise<void>;
  insertConversationFolder(
    id: string,
    projectId: string,
    userId: string,
    name: string,
  ): Promise<V2ConversationFolderT | null>;
  findConversationFolder(
    projectId: string,
    userId: string,
    folderId: string,
  ): Promise<V2ConversationFolderT | null>;
  listConversationFolders(projectId: string, userId: string): Promise<V2ConversationFolderT[]>;
  updateConversationFolder(
    projectId: string,
    userId: string,
    folderId: string,
    name: string,
  ): Promise<V2ConversationFolderT | null>;
  reorderConversationFolders(
    projectId: string,
    userId: string,
    folderIds: string[],
  ): Promise<V2ConversationFolderT[]>;
  unfileAndDeleteConversationFolder(
    projectId: string,
    userId: string,
    folderId: string,
  ): Promise<{ deleted: boolean; unfiledWorkItemCount: number }>;
  upsertWorkItemOrganization(
    projectId: string,
    userId: string,
    workItemId: string,
    folderId: string | null | undefined,
    pinned: boolean | undefined,
  ): Promise<V2WorkItemOrganizationT>;
  listConversationNavigation(
    projectId: string,
    userId: string,
    limit: number,
    cursor: ConversationNavigationCursor | null,
  ): Promise<ConversationNavigationResult>;
  insertWorkItem(input: InsertWorkItem): Promise<V2WorkItemT>;
  findWorkItem(projectId: string, workItemId: string): Promise<V2WorkItemT | null>;
  listWorkItems(projectId: string): Promise<V2WorkItemT[]>;
  updateWorkItemTitle(
    projectId: string,
    workItemId: string,
    title: string,
  ): Promise<V2WorkItemT | null>;
  archiveWorkItemConversations(projectId: string, workItemId: string): Promise<number>;
  lockWorkItem(projectId: string, workItemId: string): Promise<V2WorkItemT | null>;
  insertConversation(input: InsertConversation): Promise<V2WorkConversationT>;
  findConversation(projectId: string, conversationId: string): Promise<V2WorkConversationT | null>;
  listConversations(projectId: string, workItemId?: string): Promise<V2WorkConversationT[]>;
  findConversationMessageBranch(
    projectId: string,
    workItemId: string,
    childConversationId: string,
  ): Promise<V2ConversationMessageBranchT | null>;
  listConversationMessageBranches(
    projectId: string,
    workItemId: string,
  ): Promise<V2ConversationMessageBranchT[]>;
  insertConversationMessageBranch(input: InsertConversationMessageBranch): Promise<{
    conversation: V2WorkConversationT;
    branchLineage: V2ConversationMessageBranchT;
  }>;
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
  findMessage(
    projectId: string,
    workItemId: string,
    conversationId: string,
    messageId: string,
  ): Promise<V2WorkMessageT | null>;
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

  async insertConversationFolder(
    id: string,
    projectId: string,
    userId: string,
    name: string,
  ): Promise<V2ConversationFolderT | null> {
    const result = await this.sql.query<ConversationFolderRow>(
      `INSERT INTO conversation_folders (
         id, project_id, user_id, name, sort_order
       )
       SELECT $1,$2,$3,$4,COALESCE(MAX(sort_order) + 1, 0)
         FROM conversation_folders
        WHERE project_id=$2 AND user_id=$3
       ON CONFLICT (project_id, user_id, (lower(name))) DO NOTHING
       RETURNING ${conversationFolderColumns}`,
      [id, projectId, userId, name],
    );
    return result.rows[0] ? conversationFolder(result.rows[0]) : null;
  }

  async findConversationFolder(
    projectId: string,
    userId: string,
    folderId: string,
  ): Promise<V2ConversationFolderT | null> {
    const result = await this.sql.query<ConversationFolderRow>(
      `SELECT ${conversationFolderColumns}
         FROM conversation_folders
        WHERE project_id=$1 AND user_id=$2 AND id=$3`,
      [projectId, userId, folderId],
    );
    return result.rows[0] ? conversationFolder(result.rows[0]) : null;
  }

  async listConversationFolders(
    projectId: string,
    userId: string,
  ): Promise<V2ConversationFolderT[]> {
    const result = await this.sql.query<ConversationFolderRow>(
      `SELECT ${conversationFolderColumns}
         FROM conversation_folders
        WHERE project_id=$1 AND user_id=$2
        ORDER BY sort_order ASC, lower(name) ASC, id ASC`,
      [projectId, userId],
    );
    return result.rows.map(conversationFolder);
  }

  async updateConversationFolder(
    projectId: string,
    userId: string,
    folderId: string,
    name: string,
  ): Promise<V2ConversationFolderT | null> {
    const result = await this.sql.query<ConversationFolderRow>(
      `UPDATE conversation_folders folder
          SET name=$4,
              updated_at=now()
        WHERE folder.project_id=$1
          AND folder.user_id=$2
          AND folder.id=$3
          AND NOT EXISTS (
            SELECT 1
              FROM conversation_folders conflict
             WHERE conflict.project_id=folder.project_id
               AND conflict.user_id=folder.user_id
               AND conflict.id<>folder.id
               AND lower(conflict.name)=lower($4)
          )
       RETURNING ${conversationFolderColumns}`,
      [projectId, userId, folderId, name],
    );
    return result.rows[0] ? conversationFolder(result.rows[0]) : null;
  }

  async reorderConversationFolders(
    projectId: string,
    userId: string,
    folderIds: string[],
  ): Promise<V2ConversationFolderT[]> {
    await this.sql.query(
      `UPDATE conversation_folders folder
          SET sort_order=ordered.ordinality - 1,
              updated_at=now()
         FROM unnest($3::text[]) WITH ORDINALITY AS ordered(id, ordinality)
        WHERE folder.project_id=$1
          AND folder.user_id=$2
          AND folder.id=ordered.id`,
      [projectId, userId, folderIds],
    );
    return this.listConversationFolders(projectId, userId);
  }

  async unfileAndDeleteConversationFolder(
    projectId: string,
    userId: string,
    folderId: string,
  ): Promise<{ deleted: boolean; unfiledWorkItemCount: number }> {
    const unfiled = await this.sql.query<{ work_item_id: string }>(
      `UPDATE work_item_organization_preferences
          SET folder_id=NULL,
              updated_at=now()
        WHERE project_id=$1 AND user_id=$2 AND folder_id=$3
       RETURNING work_item_id`,
      [projectId, userId, folderId],
    );
    const deleted = await this.sql.query<{ id: string }>(
      `DELETE FROM conversation_folders
        WHERE project_id=$1 AND user_id=$2 AND id=$3
       RETURNING id`,
      [projectId, userId, folderId],
    );
    return {
      deleted: deleted.rows.length === 1,
      unfiledWorkItemCount: unfiled.rows.length,
    };
  }

  async upsertWorkItemOrganization(
    projectId: string,
    userId: string,
    workItemId: string,
    folderId: string | null | undefined,
    pinned: boolean | undefined,
  ): Promise<V2WorkItemOrganizationT> {
    const result = await this.sql.query<WorkItemOrganizationRow>(
      `INSERT INTO work_item_organization_preferences (
         project_id, user_id, work_item_id, folder_id, pinned_at
       ) VALUES (
         $1,$2,$3,
         CASE WHEN $5::boolean THEN $4::text ELSE NULL END,
         CASE WHEN $6::boolean AND $7::boolean THEN now() ELSE NULL END
       )
       ON CONFLICT (project_id, user_id, work_item_id) DO UPDATE
         SET folder_id=CASE
               WHEN $5::boolean THEN EXCLUDED.folder_id
               ELSE work_item_organization_preferences.folder_id
             END,
             pinned_at=CASE
               WHEN NOT $6::boolean THEN work_item_organization_preferences.pinned_at
               WHEN $7::boolean THEN COALESCE(
                 work_item_organization_preferences.pinned_at,
                 now()
               )
               ELSE NULL
             END,
             updated_at=now()
       RETURNING ${workItemOrganizationColumns}`,
      [
        projectId,
        userId,
        workItemId,
        folderId ?? null,
        folderId !== undefined,
        pinned !== undefined,
        pinned ?? false,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("work-item organization upsert returned no row");
    return workItemOrganization(row);
  }

  async listConversationNavigation(
    projectId: string,
    userId: string,
    limit: number,
    cursor: ConversationNavigationCursor | null,
  ): Promise<ConversationNavigationResult> {
    const result = await this.sql.query<ConversationNavigationRow>(
      `WITH work_activity AS (
         SELECT item.id,
                item.project_id,
                item.title,
                item.status,
                COALESCE(MAX(message.created_at), item.created_at) AS latest_activity_at
           FROM work_items item
           LEFT JOIN work_messages message
             ON message.project_id=item.project_id
            AND message.work_item_id=item.id
          WHERE item.project_id=$1
            AND NOT (
              EXISTS (
                SELECT 1 FROM work_conversations existing
                 WHERE existing.project_id=item.project_id
                   AND existing.work_item_id=item.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM work_conversations visible
                 WHERE visible.project_id=item.project_id
                   AND visible.work_item_id=item.id
                   AND visible.status <> 'archived'
              )
            )
          GROUP BY item.id, item.project_id, item.title, item.status, item.created_at
       ),
       conversation_activity AS (
         SELECT conversation.id,
                conversation.work_item_id,
                conversation.kind,
                conversation.status,
                conversation.provider,
                conversation.model,
                ROW_NUMBER() OVER (
                  PARTITION BY conversation.work_item_id
                  ORDER BY COALESCE(MAX(message.created_at), conversation.created_at) DESC,
                           conversation.created_at DESC,
                           conversation.id DESC
                ) AS activity_rank,
                COUNT(*) OVER (
                  PARTITION BY conversation.work_item_id
                ) AS conversation_count
           FROM work_conversations conversation
           LEFT JOIN work_messages message
             ON message.project_id=conversation.project_id
            AND message.work_item_id=conversation.work_item_id
            AND message.conversation_id=conversation.id
          WHERE conversation.project_id=$1
            AND conversation.status <> 'archived'
          GROUP BY conversation.id,
                   conversation.work_item_id,
                   conversation.kind,
                   conversation.status,
                   conversation.provider,
                   conversation.model,
                   conversation.created_at
       )
       SELECT 2::smallint AS schema_version,
              item.id,
              item.project_id,
              item.title,
              item.status,
              preference.folder_id,
              preference.pinned_at,
              item.latest_activity_at,
              COALESCE(conversation.conversation_count, 0) AS conversation_count,
              conversation.id AS latest_conversation_id,
              conversation.kind AS latest_conversation_kind,
              conversation.status AS latest_conversation_status,
              conversation.provider AS latest_conversation_provider,
              conversation.model AS latest_conversation_model
         FROM work_activity item
         LEFT JOIN work_item_organization_preferences preference
           ON preference.project_id=item.project_id
          AND preference.user_id=$2
          AND preference.work_item_id=item.id
         LEFT JOIN conversation_activity conversation
           ON conversation.work_item_id=item.id
          AND conversation.activity_rank=1
        WHERE $3::integer IS NULL
           OR CASE WHEN preference.pinned_at IS NULL THEN 0 ELSE 1 END < $3
           OR (
             CASE WHEN preference.pinned_at IS NULL THEN 0 ELSE 1 END = $3
             AND item.latest_activity_at < $4::timestamptz
           )
           OR (
             CASE WHEN preference.pinned_at IS NULL THEN 0 ELSE 1 END = $3
             AND item.latest_activity_at = $4::timestamptz
             AND item.id < $5
           )
        ORDER BY CASE WHEN preference.pinned_at IS NULL THEN 0 ELSE 1 END DESC,
                 item.latest_activity_at DESC,
                 item.id DESC
        LIMIT $6`,
      [
        projectId,
        userId,
        cursor === null ? null : cursor.pinned ? 1 : 0,
        cursor?.latestActivityAt ?? null,
        cursor?.workItemId ?? null,
        limit + 1,
      ],
    );
    return {
      items: result.rows.slice(0, limit).map(conversationNavigationItem),
      hasMore: result.rows.length > limit,
    };
  }

  async insertWorkItem({ id, actorUserId, input }: InsertWorkItem): Promise<V2WorkItemT> {
    const result = await this.sql.query<WorkItemRow>(
      `INSERT INTO work_items (
         id, project_id, created_by_user_id, title, objective, workflow
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${workItemColumns}`,
      [id, input.project_id, actorUserId, input.title, input.objective, input.workflow],
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

  async archiveWorkItemConversations(projectId: string, workItemId: string): Promise<number> {
    const result = await this.sql.query(
      `UPDATE work_conversations
          SET status='archived', archived_at=NOW(), updated_at=NOW()
        WHERE project_id=$1 AND work_item_id=$2 AND status <> 'archived'
        RETURNING id`,
      [projectId, workItemId],
    );
    return result.rows.length;
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

  async findConversationMessageBranch(
    projectId: string,
    workItemId: string,
    childConversationId: string,
  ): Promise<V2ConversationMessageBranchT | null> {
    const result = await this.sql.query<ConversationMessageBranchRow>(
      `SELECT ${conversationMessageBranchColumns}
         FROM conversation_message_branches
        WHERE project_id=$1
          AND work_item_id=$2
          AND child_conversation_id=$3`,
      [projectId, workItemId, childConversationId],
    );
    return result.rows[0] ? conversationMessageBranch(result.rows[0]) : null;
  }

  async listConversationMessageBranches(
    projectId: string,
    workItemId: string,
  ): Promise<V2ConversationMessageBranchT[]> {
    const result = await this.sql.query<ConversationMessageBranchRow>(
      `SELECT ${conversationMessageBranchColumns}
         FROM conversation_message_branches
        WHERE project_id=$1 AND work_item_id=$2
        ORDER BY created_at ASC, id ASC`,
      [projectId, workItemId],
    );
    return result.rows.map(conversationMessageBranch);
  }

  async insertConversationMessageBranch(input: InsertConversationMessageBranch): Promise<{
    conversation: V2WorkConversationT;
    branchLineage: V2ConversationMessageBranchT;
  }> {
    const childResult = await this.sql.query<ConversationRow>(
      `INSERT INTO work_conversations (
         id, project_id, work_item_id, created_by_user_id, kind,
         provider, model, next_message_sequence, message_branch
       )
       SELECT $1, parent.project_id, parent.work_item_id, $2, 'planning',
              parent.provider, parent.model, $6, true
         FROM work_conversations parent
        WHERE parent.project_id=$3
          AND parent.work_item_id=$4
          AND parent.id=$5
          AND parent.kind='planning'
          AND parent.status='active'
       RETURNING ${conversationColumns}`,
      [
        input.childConversationId,
        input.actorUserId,
        input.projectId,
        input.workItemId,
        input.parentConversation.id,
        input.prefix.length + 1,
      ],
    );
    const childRow = childResult.rows[0];
    if (!childRow) {
      throw new ConversationPersistenceError(
        "conversation_inactive",
        `conversation "${input.parentConversation.id}" is no longer an active planning conversation`,
      );
    }

    for (const [index, copied] of input.prefix.entries()) {
      const source = copied.source;
      await this.sql.query<MessageRow>(
        `INSERT INTO work_messages (
           id, project_id, work_item_id, conversation_id, initiated_by_user_id,
           actor_type, actor_id, role, visibility_status, sequence, parts,
           client_message_id, request_fingerprint, created_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14
         )`,
        [
          copied.id,
          input.projectId,
          input.workItemId,
          input.childConversationId,
          source.initiated_by_user_id,
          source.actor.actor_type,
          source.actor.actor_id,
          source.role,
          source.visibility_status,
          index + 1,
          JSON.stringify(source.parts),
          copied.clientMessageId,
          source.request_fingerprint,
          source.created_at,
        ],
      );
      await this.sql.query(
        `INSERT INTO work_message_attachment_refs (
           project_id, work_item_id, conversation_id, message_id,
           attachment_id, created_by_user_id
         )
         SELECT project_id, work_item_id, $1, $2, attachment_id, $3
           FROM work_message_attachment_refs
          WHERE project_id=$4
            AND work_item_id=$5
            AND conversation_id=$6
            AND message_id=$7`,
        [
          input.childConversationId,
          copied.id,
          input.actorUserId,
          input.projectId,
          input.workItemId,
          input.parentConversation.id,
          source.id,
        ],
      );
    }

    const lineageResult = await this.sql.query<ConversationMessageBranchRow>(
      `INSERT INTO conversation_message_branches (
         id, project_id, work_item_id, child_conversation_id,
         parent_conversation_id, source_message_id, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${conversationMessageBranchColumns}`,
      [
        input.id,
        input.projectId,
        input.workItemId,
        input.childConversationId,
        input.parentConversation.id,
        input.sourceMessageId,
        input.actorUserId,
      ],
    );
    const lineageRow = lineageResult.rows[0];
    if (!lineageRow) throw new Error("conversation message branch insert returned no row");
    return {
      conversation: conversation(childRow),
      branchLineage: conversationMessageBranch(lineageRow),
    };
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

  async findMessage(
    projectId: string,
    workItemId: string,
    conversationId: string,
    messageId: string,
  ): Promise<V2WorkMessageT | null> {
    const result = await this.sql.query<MessageRow>(
      `SELECT ${messageColumns}
         FROM work_messages
        WHERE project_id=$1
          AND work_item_id=$2
          AND conversation_id=$3
          AND id=$4`,
      [projectId, workItemId, conversationId, messageId],
    );
    return result.rows[0] ? message(result.rows[0]) : null;
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
