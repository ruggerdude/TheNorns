import {
  V2Actor,
  type V2ActorT,
  V2ConfirmConversationActionInput,
  type V2ConfirmConversationActionInputT,
  type V2ConversationActionT,
  V2CreateWorkConversationInput,
  type V2CreateWorkConversationInputT,
  V2CreateWorkItemInput,
  type V2CreateWorkItemInputT,
  V2ProposeConversationActionInput,
  type V2ProposeConversationActionInputT,
  V2SubmitWorkMessageInput,
  type V2SubmitWorkMessageInputT,
  type V2WorkConversationT,
  type V2WorkItemT,
  type V2WorkMessageT,
} from "@norns/contracts";
import { newId } from "../ids.js";
import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import { ConversationPersistenceError, type ConversationRepositoryStore } from "./repository.js";

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

export class ConversationService {
  private readonly makeId: (prefix: string) => string;

  constructor(
    private readonly store: ConversationRepositoryStore,
    options: ConversationServiceOptions = {},
  ) {
    this.makeId = options.newId ?? newId;
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
  ): Promise<V2WorkConversationT[]> {
    return this.store.transaction(async (repository) => {
      await repository.assertProjectAccess(projectId, actor.id);
      const workItem = await repository.findWorkItem(projectId, workItemId);
      if (!workItem) {
        throw new ConversationPersistenceError(
          "work_item_not_found",
          `unknown work item "${workItemId}" in project "${projectId}"`,
        );
      }
      return repository.listConversations(projectId, workItemId);
    });
  }

  getConversation(
    actor: ConversationActor,
    projectId: string,
    conversationId: string,
  ): Promise<{ work_item: V2WorkItemT; conversation: V2WorkConversationT }> {
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
      return { work_item, conversation };
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
