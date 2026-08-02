import {
  PmModel,
  V2Actor,
  type V2ActorT,
  V2ConfirmConversationActionInput,
  type V2ConfirmConversationActionInputT,
  type V2ConversationActionT,
  type V2ConversationFolderT,
  type V2ConversationMessageBranchT,
  V2ConversationNavigationPage,
  type V2ConversationNavigationPageT,
  V2CreateConversationFolderInput,
  type V2CreateConversationFolderInputT,
  V2CreateConversationMessageBranchInput,
  type V2CreateConversationMessageBranchInputT,
  V2CreateWorkConversationInput,
  type V2CreateWorkConversationInputT,
  V2CreateWorkItemInput,
  type V2CreateWorkItemInputT,
  V2ProposeConversationActionInput,
  type V2ProposeConversationActionInputT,
  V2ReorderConversationFoldersInput,
  type V2ReorderConversationFoldersInputT,
  V2SubmitWorkMessageInput,
  type V2SubmitWorkMessageInputT,
  V2UpdateConversationFolderInput,
  type V2UpdateConversationFolderInputT,
  V2UpdateWorkItemOrganizationInput,
  type V2UpdateWorkItemOrganizationInputT,
  type V2WorkConversationT,
  type V2WorkItemOrganizationT,
  type V2WorkItemT,
  type V2WorkMessageT,
  isPmModelForProvider,
} from "@norns/contracts";
import { z } from "zod";
import { newId } from "../ids.js";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import { ConversationPersistenceError, type ConversationRepositoryStore } from "./repository.js";

const ConversationNavigationCursorPayload = z
  .object({
    version: z.literal(1),
    pinned: z.boolean(),
    latest_activity_at: z.string().datetime(),
    work_item_id: z.string().trim().min(1),
    project_id: z.string().trim().min(1),
    user_id: z.string().trim().min(1),
  })
  .strict();

function decodeNavigationCursor(cursor: string | undefined, projectId: string, userId: string) {
  if (cursor === undefined) return null;
  try {
    const parsed = ConversationNavigationCursorPayload.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.project_id !== projectId || parsed.user_id !== userId) {
      throw new Error("cursor scope mismatch");
    }
    return {
      pinned: parsed.pinned,
      latestActivityAt: parsed.latest_activity_at,
      workItemId: parsed.work_item_id,
    };
  } catch {
    throw new ConversationPersistenceError(
      "invalid_navigation_cursor",
      "conversation navigation cursor is invalid or expired",
    );
  }
}

function encodeNavigationCursor(
  item: {
    pinned_at: string | null;
    latest_activity_at: string;
    id: string;
  },
  projectId: string,
  userId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      pinned: item.pinned_at !== null,
      latest_activity_at: item.latest_activity_at,
      work_item_id: item.id,
      project_id: projectId,
      user_id: userId,
    }),
  ).toString("base64url");
}

export interface ConversationActor {
  id: string;
}

export interface InternalConversationActor {
  initiatedByUserId: string;
  actor: V2ActorT & {
    actor_type: Exclude<V2ActorT["actor_type"], "human">;
  };
}

export interface ConversationServiceOptions {
  newId?: (prefix: string) => string;
}

export interface PlanningConversationPin {
  provider: string;
  model: string;
}

export interface WorkItemWithConversations {
  work_item: V2WorkItemT;
  conversations: V2WorkConversationT[];
}

export type WorkConversationWithBranchLineage = V2WorkConversationT & {
  branch_lineage: V2ConversationMessageBranchT | null;
};

const branchSafePartTypes = new Set<V2WorkMessageT["parts"][number]["type"]>([
  "text",
  "code",
  "attachment",
]);

export class ConversationService {
  private readonly makeId: (prefix: string) => string;

  constructor(
    private readonly store: ConversationRepositoryStore,
    options: ConversationServiceOptions = {},
  ) {
    this.makeId = options.newId ?? newId;
  }

  createConversationFolder(
    actor: ConversationActor,
    projectId: string,
    candidate: V2CreateConversationFolderInputT,
  ): Promise<V2ConversationFolderT> {
    const input = V2CreateConversationFolderInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const folder = await repository.insertConversationFolder(
        this.makeId("folder"),
        projectId,
        actor.id,
        input.name,
      );
      if (!folder) {
        throw new ConversationPersistenceError(
          "conversation_folder_name_conflict",
          `a conversation folder named "${input.name}" already exists`,
        );
      }
      return folder;
    });
  }

  updateConversationFolder(
    actor: ConversationActor,
    projectId: string,
    folderId: string,
    candidate: V2UpdateConversationFolderInputT,
  ): Promise<V2ConversationFolderT> {
    const input = V2UpdateConversationFolderInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const existing = await repository.findConversationFolder(projectId, actor.id, folderId);
      if (!existing) {
        throw new ConversationPersistenceError(
          "conversation_folder_not_found",
          `unknown conversation folder "${folderId}"`,
        );
      }
      const updated = await repository.updateConversationFolder(
        projectId,
        actor.id,
        folderId,
        input.name,
      );
      if (!updated) {
        throw new ConversationPersistenceError(
          "conversation_folder_name_conflict",
          `a conversation folder named "${input.name}" already exists`,
        );
      }
      return updated;
    });
  }

  reorderConversationFolders(
    actor: ConversationActor,
    projectId: string,
    candidate: V2ReorderConversationFoldersInputT,
  ): Promise<V2ConversationFolderT[]> {
    const input = V2ReorderConversationFoldersInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const existing = await repository.listConversationFolders(projectId, actor.id);
      const existingIds = new Set(existing.map((folder) => folder.id));
      if (
        existingIds.size !== input.folder_ids.length ||
        input.folder_ids.some((id) => !existingIds.has(id))
      ) {
        throw new ConversationPersistenceError(
          "conversation_folder_order_invalid",
          "folder_ids must contain every conversation folder exactly once",
        );
      }
      return repository.reorderConversationFolders(projectId, actor.id, input.folder_ids);
    });
  }

  deleteConversationFolder(
    actor: ConversationActor,
    projectId: string,
    folderId: string,
  ): Promise<{ deleted_folder_id: string; unfiled_work_item_count: number }> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const folder = await repository.findConversationFolder(projectId, actor.id, folderId);
      if (!folder) {
        throw new ConversationPersistenceError(
          "conversation_folder_not_found",
          `unknown conversation folder "${folderId}"`,
        );
      }
      const result = await repository.unfileAndDeleteConversationFolder(
        projectId,
        actor.id,
        folderId,
      );
      if (!result.deleted) {
        throw new ConversationPersistenceError(
          "conversation_folder_not_found",
          `conversation folder "${folderId}" is no longer available`,
        );
      }
      return {
        deleted_folder_id: folderId,
        unfiled_work_item_count: result.unfiledWorkItemCount,
      };
    });
  }

  updateWorkItemOrganization(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
    candidate: V2UpdateWorkItemOrganizationInputT,
  ): Promise<V2WorkItemOrganizationT> {
    const input = V2UpdateWorkItemOrganizationInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const workItem = await repository.findWorkItem(projectId, workItemId);
      if (!workItem) {
        throw new ConversationPersistenceError(
          "work_item_not_found",
          `unknown work item "${workItemId}" in project "${projectId}"`,
        );
      }
      if (input.folder_id) {
        const folder = await repository.findConversationFolder(
          projectId,
          actor.id,
          input.folder_id,
        );
        if (!folder) {
          throw new ConversationPersistenceError(
            "conversation_folder_not_found",
            `unknown conversation folder "${input.folder_id}"`,
          );
        }
      }
      return repository.upsertWorkItemOrganization(
        projectId,
        actor.id,
        workItemId,
        input.folder_id,
        input.pinned,
      );
    });
  }

  async conversationNavigation(
    actor: ConversationActor,
    projectId: string,
    limit: number,
    cursor?: string,
  ): Promise<V2ConversationNavigationPageT> {
    const decodedCursor = decodeNavigationCursor(cursor, projectId, actor.id);
    const pageSize = z.number().int().min(1).max(100).parse(limit);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const folders = await repository.listConversationFolders(projectId, actor.id);
      const navigation = await repository.listConversationNavigation(
        projectId,
        actor.id,
        pageSize,
        decodedCursor,
      );
      const last = navigation.items.at(-1);
      return V2ConversationNavigationPage.parse({
        folders,
        items: navigation.items,
        next_cursor:
          navigation.hasMore && last ? encodeNavigationCursor(last, projectId, actor.id) : null,
      });
    });
  }

  createWorkItem(
    actor: ConversationActor,
    candidate: V2CreateWorkItemInputT,
  ): Promise<V2WorkItemT> {
    const input = V2CreateWorkItemInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, actor.id);
      return repository.insertWorkItem({
        id: this.makeId("work"),
        actorUserId: actor.id,
        input,
      });
    });
  }

  createPlanningWorkspace(
    actor: ConversationActor,
    candidate: V2CreateWorkItemInputT,
    pin: PlanningConversationPin,
  ): Promise<{ work_item: V2WorkItemT; conversation: V2WorkConversationT }> {
    const input = V2CreateWorkItemInput.parse(candidate);
    const workItemId = this.makeId("work");
    const conversationInput = V2CreateWorkConversationInput.parse({
      project_id: input.project_id,
      work_item_id: workItemId,
      kind: "planning",
      provider: pin.provider,
      model: pin.model,
    });
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, actor.id);
      const work_item = await repository.insertWorkItem({
        id: workItemId,
        actorUserId: actor.id,
        input,
      });
      const conversation = await repository.insertConversation({
        id: this.makeId("conversation"),
        actorUserId: actor.id,
        input: conversationInput,
      });
      return { work_item, conversation };
    });
  }

  createQuickWorkspace(
    actor: ConversationActor,
    candidate: V2CreateWorkItemInputT,
    pin: PlanningConversationPin,
  ): Promise<{ work_item: V2WorkItemT; conversation: V2WorkConversationT }> {
    const input = V2CreateWorkItemInput.parse(candidate);
    const workItemId = this.makeId("work");
    const conversationInput = V2CreateWorkConversationInput.parse({
      project_id: input.project_id,
      work_item_id: workItemId,
      kind: "execution_pm",
      provider: pin.provider,
      model: pin.model,
    });
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, actor.id);
      const work_item = await repository.insertQuickWorkItem({
        id: workItemId,
        phaseId: this.makeId("phase"),
        actorUserId: actor.id,
        input,
      });
      const conversation = await repository.insertConversation({
        id: this.makeId("conversation"),
        actorUserId: actor.id,
        input: conversationInput,
      });
      return { work_item, conversation };
    });
  }

  createConversation(
    actor: ConversationActor,
    candidate: V2CreateWorkConversationInputT,
  ): Promise<V2WorkConversationT> {
    const input = V2CreateWorkConversationInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, actor.id);
      if (input.kind !== "planning") {
        throw new ConversationPersistenceError(
          "conversation_kind_forbidden",
          "execution and task conversations are created only by the approved-plan transition",
        );
      }
      return repository.insertConversation({
        id: this.makeId("conversation"),
        actorUserId: actor.id,
        input,
      });
    });
  }

  createPinnedPlanningConversation(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
    pin: PlanningConversationPin,
  ): Promise<V2WorkConversationT> {
    return this.createConversation(actor, {
      project_id: projectId,
      work_item_id: workItemId,
      kind: "planning",
      provider: pin.provider,
      model: pin.model,
    });
  }

  renameWorkItem(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
    candidateTitle: string,
  ): Promise<V2WorkItemT> {
    const title = V2CreateWorkItemInput.shape.title.parse(candidateTitle);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const updated = await repository.updateWorkItemTitle(projectId, workItemId, title);
      if (!updated) {
        throw new ConversationPersistenceError(
          "work_item_not_found",
          `unknown work item "${workItemId}" in project "${projectId}"`,
        );
      }
      return updated;
    });
  }

  switchConversationModel(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    candidateModel: string,
  ): Promise<V2WorkConversationT> {
    const model = PmModel.parse(candidateModel);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const conversation = await repository.lockConversation(projectId, workItemId, conversationId);
      if (!conversation) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${conversationId}" in work item "${workItemId}"`,
        );
      }
      if (conversation.status !== "active") {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${conversationId}" is ${conversation.status}`,
        );
      }
      if (conversation.provider !== "anthropic" && conversation.provider !== "openai") {
        throw new ConversationPersistenceError(
          "model_ecosystem_mismatch",
          `conversation provider "${conversation.provider}" does not support model switching`,
        );
      }
      if (!isPmModelForProvider(conversation.provider, model)) {
        throw new ConversationPersistenceError(
          "model_ecosystem_mismatch",
          `choose a ${conversation.provider} model for this conversation`,
        );
      }
      if (conversation.model === model) return conversation;
      if (
        (await repository.hasActiveTurnAttempt(conversation.id)) ||
        (await repository.hasActivePlanProposal(conversation.id))
      ) {
        throw new ConversationPersistenceError(
          "turn_in_progress",
          "wait for the current PM response or plan generation to finish before changing models",
        );
      }
      const updated = await repository.updateConversationModel(
        projectId,
        workItemId,
        conversationId,
        model,
      );
      if (!updated) {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${conversationId}" is no longer active`,
        );
      }
      return updated;
    });
  }

  listWorkItems(actor: ConversationActor, projectId: string): Promise<WorkItemWithConversations[]> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const [items, conversations] = await Promise.all([
        repository.listWorkItems(projectId),
        repository.listConversations(projectId),
      ]);
      const byWorkItem = new Map<string, V2WorkConversationT[]>();
      for (const conversation of conversations) {
        const listed = byWorkItem.get(conversation.work_item_id) ?? [];
        listed.push(conversation);
        byWorkItem.set(conversation.work_item_id, listed);
      }
      return items.map((work_item) => ({
        work_item,
        conversations: byWorkItem.get(work_item.id) ?? [],
      }));
    });
  }

  listConversations(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
  ): Promise<WorkConversationWithBranchLineage[]> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const workItem = await repository.findWorkItem(projectId, workItemId);
      if (!workItem) {
        throw new ConversationPersistenceError(
          "work_item_not_found",
          `unknown work item "${workItemId}" in project "${projectId}"`,
        );
      }
      const conversations = await repository.listConversations(projectId, workItemId);
      const lineages = await repository.listConversationMessageBranches(projectId, workItemId);
      const byChild = new Map(lineages.map((lineage) => [lineage.child_conversation_id, lineage]));
      return conversations.map((conversation) => ({
        ...conversation,
        branch_lineage: byChild.get(conversation.id) ?? null,
      }));
    });
  }

  getConversation(
    actor: ConversationActor,
    projectId: string,
    conversationId: string,
  ): Promise<{
    work_item: V2WorkItemT;
    conversation: V2WorkConversationT;
    branch_lineage: V2ConversationMessageBranchT | null;
  }> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const conversation = await repository.findConversation(projectId, conversationId);
      if (!conversation) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${conversationId}" in project "${projectId}"`,
        );
      }
      const work_item = await repository.findWorkItem(projectId, conversation.work_item_id);
      if (!work_item) {
        throw new ConversationPersistenceError(
          "work_item_not_found",
          `conversation "${conversationId}" has no work item in project "${projectId}"`,
        );
      }
      const branch_lineage = await repository.findConversationMessageBranch(
        projectId,
        work_item.id,
        conversation.id,
      );
      return { work_item, conversation, branch_lineage };
    });
  }

  createConversationMessageBranch(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
    conversationId: string,
    candidate: V2CreateConversationMessageBranchInputT,
  ): Promise<{
    conversation: V2WorkConversationT;
    branch_lineage: V2ConversationMessageBranchT;
  }> {
    const input = V2CreateConversationMessageBranchInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const parent = await repository.lockConversation(projectId, workItemId, conversationId);
      if (!parent) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${conversationId}" in the requested scope`,
        );
      }
      if (parent.kind !== "planning") {
        throw new ConversationPersistenceError(
          "conversation_kind_forbidden",
          "only planning conversations can be branched from an edited message",
        );
      }
      if (parent.status !== "active") {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${conversationId}" is ${parent.status}`,
        );
      }
      if (
        (await repository.hasActiveTurnAttempt(conversationId)) ||
        (await repository.hasActivePlanProposal(conversationId))
      ) {
        throw new ConversationPersistenceError(
          "turn_in_progress",
          "wait for or stop active conversation work before creating a message branch",
        );
      }

      const source = await repository.findMessage(
        projectId,
        workItemId,
        conversationId,
        input.source_message_id,
      );
      if (!source) {
        throw new ConversationPersistenceError(
          "message_not_found",
          `unknown source message "${input.source_message_id}" in this conversation`,
        );
      }
      if (
        source.role !== "user" ||
        source.actor.actor_type !== "human" ||
        source.visibility_status !== "complete"
      ) {
        throw new ConversationPersistenceError(
          "conversation_branch_unsafe",
          "a message branch must start from a complete human user message",
        );
      }

      const prefix = (await repository.listMessages(projectId, workItemId, conversationId)).filter(
        (message) => message.sequence < source.sequence,
      );
      const unsafe = prefix.find(
        (message) =>
          message.visibility_status === "streaming" ||
          message.parts.some((part) => !branchSafePartTypes.has(part.type)),
      );
      if (unsafe) {
        throw new ConversationPersistenceError(
          "conversation_branch_unsafe",
          `message "${unsafe.id}" contains workflow state that cannot be copied safely`,
        );
      }

      const created = await repository.insertConversationMessageBranch({
        id: this.makeId("branch"),
        childConversationId: this.makeId("conversation"),
        actorUserId: actor.id,
        projectId,
        workItemId,
        parentConversation: parent,
        sourceMessageId: source.id,
        prefix: prefix.map((message) => ({
          source: message,
          id: this.makeId("message"),
          clientMessageId: message.role === "user" ? this.makeId("branch-client") : null,
        })),
      });
      return {
        conversation: created.conversation,
        branch_lineage: created.branchLineage,
      };
    });
  }

  createInternalConversation(
    initiator: InternalConversationActor,
    candidate: V2CreateWorkConversationInputT,
  ): Promise<V2WorkConversationT> {
    this.internalActor(initiator);
    const input = V2CreateWorkConversationInput.parse(candidate);
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, initiator.initiatedByUserId);
      const workItem = await repository.lockWorkItem(input.project_id, input.work_item_id);
      if (!workItem) {
        throw new ConversationPersistenceError(
          "work_item_not_found",
          `unknown work item "${input.work_item_id}" in project "${input.project_id}"`,
        );
      }
      if (input.kind !== "planning" && workItem.approved_plan_version_id === null) {
        throw new ConversationPersistenceError(
          "approved_plan_required",
          "execution and task conversations require the work item's selected approved plan",
        );
      }
      return repository.insertConversation({
        id: this.makeId("conversation"),
        actorUserId: initiator.initiatedByUserId,
        input,
      });
    });
  }

  submitUserMessage(
    actor: ConversationActor,
    candidate: V2SubmitWorkMessageInputT,
  ): Promise<V2WorkMessageT> {
    const input = V2SubmitWorkMessageInput.parse(candidate);
    const requestFingerprint = canonicalSha256({ parts: input.parts });

    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, actor.id);
      const locked = await repository.lockConversation(
        input.project_id,
        input.work_item_id,
        input.conversation_id,
      );
      if (!locked) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${input.conversation_id}" in the requested scope`,
        );
      }

      const existing = await repository.findUserMessage(
        input.conversation_id,
        actor.id,
        input.client_message_id,
      );
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            `client message ID "${input.client_message_id}" was reused with different content`,
          );
        }
        return existing;
      }
      if (locked.status !== "active") {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${input.conversation_id}" is ${locked.status}`,
        );
      }
      if (await repository.hasActiveTurnAttempt(input.conversation_id)) {
        throw new ConversationPersistenceError(
          "turn_in_progress",
          "wait for or stop the active response before sending another message",
        );
      }
      if (await repository.hasActivePlanProposal(input.conversation_id)) {
        throw new ConversationPersistenceError(
          "turn_in_progress",
          "wait for the active plan proposal before sending another message",
        );
      }

      const attachmentIds = [
        ...new Set(
          input.parts.flatMap((part) => (part.type === "attachment" ? [part.attachment_id] : [])),
        ),
      ];
      return repository.insertUserMessage({
        id: this.makeId("message"),
        actorUserId: actor.id,
        projectId: input.project_id,
        workItemId: input.work_item_id,
        conversationId: input.conversation_id,
        clientMessageId: input.client_message_id,
        requestFingerprint,
        parts: input.parts,
        attachmentIds,
      });
    });
  }

  listMessages(
    actor: ConversationActor,
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<V2WorkMessageT[]> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const conversation = await repository.lockConversation(projectId, workItemId, conversationId);
      if (!conversation) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${conversationId}" in the requested scope`,
        );
      }
      return repository.listMessages(projectId, workItemId, conversationId);
    });
  }

  proposeAction(
    actor: ConversationActor,
    candidate: V2ProposeConversationActionInputT,
  ): Promise<V2ConversationActionT> {
    const input = V2ProposeConversationActionInput.parse(candidate);
    return this.proposeActionAs(actor.id, { actor_type: "human", actor_id: actor.id }, input);
  }

  proposeInternalAction(
    initiator: InternalConversationActor,
    candidate: V2ProposeConversationActionInputT,
  ): Promise<V2ConversationActionT> {
    const input = V2ProposeConversationActionInput.parse(candidate);
    return this.proposeActionAs(initiator.initiatedByUserId, this.internalActor(initiator), input);
  }

  private proposeActionAs(
    initiatedByUserId: string,
    provenance: V2ActorT,
    input: V2ProposeConversationActionInputT,
  ): Promise<V2ConversationActionT> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, initiatedByUserId);
      const conversation = await repository.lockConversation(
        input.project_id,
        input.work_item_id,
        input.conversation_id,
      );
      if (!conversation) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${input.conversation_id}" in the requested scope`,
        );
      }
      if (conversation.status !== "active") {
        throw new ConversationPersistenceError(
          "conversation_inactive",
          `conversation "${input.conversation_id}" is ${conversation.status}`,
        );
      }
      return repository.insertAction({
        id: this.makeId("conversation_action"),
        actorUserId: initiatedByUserId,
        actor: provenance,
        projectId: input.project_id,
        workItemId: input.work_item_id,
        conversationId: input.conversation_id,
        sourceMessageId: input.source_message_id,
        actionType: input.action_type,
        payload: input.payload,
        payloadHash: canonicalSha256(input.payload),
      });
    });
  }

  confirmAction(
    actor: ConversationActor,
    candidate: V2ConfirmConversationActionInputT,
  ): Promise<V2ConversationActionT> {
    const input = V2ConfirmConversationActionInput.parse(candidate);

    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(input.project_id, actor.id);
      const conversation = await repository.lockConversation(
        input.project_id,
        input.work_item_id,
        input.conversation_id,
      );
      if (!conversation) {
        throw new ConversationPersistenceError(
          "conversation_not_found",
          `unknown conversation "${input.conversation_id}" in the requested scope`,
        );
      }
      const existingForKey = await repository.findActionByConfirmationKey(
        input.conversation_id,
        actor.id,
        input.idempotency_key,
      );
      if (existingForKey) {
        const expectedFingerprint = this.actionConfirmationFingerprint(existingForKey);
        if (existingForKey.id !== input.action_id) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            `confirmation key "${input.idempotency_key}" was reused for a different request`,
          );
        }
        if (existingForKey.confirmation_request_fingerprint !== expectedFingerprint) {
          throw new ConversationPersistenceError(
            "request_fingerprint_mismatch",
            "stored action confirmation fingerprint does not match its immutable proposal",
          );
        }
        return existingForKey;
      }

      const action = await repository.lockAction(
        input.project_id,
        input.work_item_id,
        input.conversation_id,
        input.action_id,
      );
      if (!action) {
        throw new ConversationPersistenceError(
          "action_not_found",
          `unknown action "${input.action_id}" in the requested scope`,
        );
      }
      const replayAfterLock = await repository.findActionByConfirmationKey(
        input.conversation_id,
        actor.id,
        input.idempotency_key,
      );
      if (replayAfterLock) {
        const expectedFingerprint = this.actionConfirmationFingerprint(replayAfterLock);
        if (replayAfterLock.id !== input.action_id) {
          throw new ConversationPersistenceError(
            "idempotency_conflict",
            `confirmation key "${input.idempotency_key}" was reused for a different request`,
          );
        }
        if (replayAfterLock.confirmation_request_fingerprint !== expectedFingerprint) {
          throw new ConversationPersistenceError(
            "request_fingerprint_mismatch",
            "stored action confirmation fingerprint does not match its immutable proposal",
          );
        }
        return replayAfterLock;
      }
      if (action.status !== "proposed") {
        throw new ConversationPersistenceError(
          "action_already_confirmed",
          `action "${input.action_id}" has already left proposed state`,
        );
      }
      return repository.confirmAction(
        input.action_id,
        actor.id,
        input.idempotency_key,
        this.actionConfirmationFingerprint(action),
      );
    });
  }

  private actionConfirmationFingerprint(action: V2ConversationActionT): string {
    return canonicalSha256({
      action_id: action.id,
      action_type: action.action_type,
      payload_hash: action.payload_hash,
    });
  }

  private internalActor(initiator: InternalConversationActor): V2ActorT {
    const provenance = V2Actor.parse(initiator.actor);
    if (provenance.actor_type === "human") {
      throw new ConversationPersistenceError(
        "forbidden",
        "trusted internal conversation operations cannot claim human provenance",
      );
    }
    return provenance;
  }
}
