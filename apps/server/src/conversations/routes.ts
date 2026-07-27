import type { ProviderName } from "@norns/adapters";
import { V2WorkMessagePart } from "@norns/contracts";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConversationPlanDetail } from "./planWorkflow.js";
import { ConversationPersistenceError } from "./repository.js";
import type { ConversationActor, ConversationService, PlanningConversationPin } from "./service.js";
import type { ConversationTurnRepository } from "./turnRepository.js";
import {
  ConversationTurnError,
  type ConversationTurnService,
  type PreparedConversationTurn,
} from "./turnService.js";

interface ConversationRouteUser {
  id: string;
}

export interface ConversationRouteOptions {
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<ConversationRouteUser | null>;
  conversations: ConversationService;
  turns: ConversationTurnService;
  attempts: ConversationTurnRepository;
  pinForProject(projectId: string): Promise<PlanningConversationPin>;
  planDetail?(
    userId: string,
    projectId: string,
    workItemId: string,
    conversationId: string,
  ): Promise<ConversationPlanDetail>;
}

const WorkItemBody = z
  .object({
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
  })
  .strict();
const MessageBody = z
  .object({
    client_message_id: z.string().min(1),
    parts: z.array(V2WorkMessagePart).min(1),
  })
  .strict();
const RetryBody = z
  .object({
    triggering_message_id: z.string().min(1),
  })
  .strict();
const ResumeBody = z
  .object({
    triggering_message_id: z.string().min(1).optional(),
  })
  .strict();
const StopBody = z
  .object({
    attempt_id: z.string().min(1).optional(),
  })
  .strict();

function routeError(reply: FastifyReply, error: unknown): void {
  if (error instanceof z.ZodError) {
    reply.code(400).send({ error: "bad_request", issues: error.issues });
    return;
  }
  if (error instanceof ConversationPersistenceError) {
    reply.code(error.httpStatus).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof ConversationTurnError) {
    reply.code(error.httpStatus).send({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

function publicStreamError(error: unknown): string {
  if (error instanceof ConversationTurnError) return error.message;
  return "The PM response could not be completed.";
}

function uiFinishReason(
  providerReason: string | null,
): "stop" | "length" | "content-filter" | "other" {
  const normalized = providerReason?.toLowerCase() ?? "";
  if (
    ["stop", "end_turn", "stop_sequence", "completed", "complete", "success"].includes(normalized)
  ) {
    return "stop";
  }
  if (
    normalized.includes("max_token") ||
    normalized.includes("max_output") ||
    normalized.includes("length")
  ) {
    return "length";
  }
  if (normalized.includes("content_filter") || normalized.includes("content-filter")) {
    return "content-filter";
  }
  return "other";
}

export async function streamPrepared(
  request: FastifyRequest,
  reply: FastifyReply,
  prepared: PreparedConversationTurn,
): Promise<void> {
  const textId = `${prepared.outputMessageId}:text`;
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: "start", messageId: prepared.outputMessageId });
      writer.write({ type: "text-start", id: textId });
      let providerFinishReason: string | null = null;
      try {
        await prepared.run({
          started: () => undefined,
          text: (delta) => writer.write({ type: "text-delta", id: textId, delta }),
          finished: (attempt) => {
            providerFinishReason = attempt.provider_finish_reason;
          },
        });
        writer.write({ type: "text-end", id: textId });
        writer.write({ type: "finish", finishReason: uiFinishReason(providerFinishReason) });
      } catch (error) {
        if (error instanceof ConversationTurnError && error.code === "cancelled") {
          writer.write({ type: "abort", reason: "stopped" });
          return;
        }
        throw error;
      }
    },
    onError: publicStreamError,
    generateId: () => prepared.outputMessageId,
  });

  let finished = false;
  const cancelPrematurely = (): void => {
    if (!finished && !reply.raw.writableEnded) prepared.cancel();
  };
  request.raw.once("aborted", cancelPrematurely);
  reply.raw.once("close", cancelPrematurely);
  reply.hijack();
  try {
    await pipeUIMessageStreamToResponse({
      response: reply.raw,
      stream,
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
    finished = true;
  } finally {
    request.raw.off("aborted", cancelPrematurely);
    reply.raw.off("close", cancelPrematurely);
  }
}

export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRouteOptions,
): void {
  const workBase = "/api/v2/projects/:projectId/work-items";
  const conversationBase = `${workBase}/:workItemId/conversations`;

  app.get(workBase, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId } = request.params as { projectId: string };
    try {
      const work_items = await options.conversations.listWorkItems(user, projectId);
      return reply.send({ work_items });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(workBase, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId } = request.params as { projectId: string };
    try {
      const body = WorkItemBody.parse(request.body);
      const pin = await options.pinForProject(projectId);
      const created = await options.conversations.createPlanningWorkspace(
        user,
        { project_id: projectId, ...body },
        pin,
      );
      return reply.code(201).send(created);
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.get(conversationBase, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId } = request.params as {
      projectId: string;
      workItemId: string;
    };
    try {
      const conversations = await options.conversations.listConversations(
        user,
        projectId,
        workItemId,
      );
      return reply.send({ conversations });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(conversationBase, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId } = request.params as {
      projectId: string;
      workItemId: string;
    };
    try {
      const pin = await options.pinForProject(projectId);
      const conversation = await options.conversations.createPinnedPlanningConversation(
        user,
        projectId,
        workItemId,
        pin,
      );
      return reply.code(201).send({ conversation });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.get("/api/v2/projects/:projectId/conversations/:conversationId", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, conversationId } = request.params as {
      projectId: string;
      conversationId: string;
    };
    try {
      const found = await options.conversations.getConversation(user, projectId, conversationId);
      const planDetail = (await options.planDetail?.(
        user.id,
        projectId,
        found.work_item.id,
        conversationId,
      )) ?? {
        plan_versions: [],
        actions: [],
        plan_reviews: [],
        action_effects: [],
      };
      const [messages, active_attempt, retryable_attempt] = await Promise.all([
        options.conversations.listMessages(user, projectId, found.work_item.id, conversationId),
        options.attempts.active(projectId, conversationId),
        options.attempts.latestRetryableAttempt(projectId, found.work_item.id, conversationId),
      ]);
      return reply.send({
        ...found,
        messages,
        active_attempt,
        retryable_attempt,
        ...planDetail,
      });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.get(`${conversationBase}/:conversationId`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const found = await options.conversations.getConversation(user, projectId, conversationId);
      if (found.work_item.id !== workItemId) {
        throw new ConversationTurnError(
          "conversation_scope_mismatch",
          "conversation scope mismatch",
        );
      }
      const planDetail = (await options.planDetail?.(
        user.id,
        projectId,
        workItemId,
        conversationId,
      )) ?? {
        plan_versions: [],
        actions: [],
        plan_reviews: [],
        action_effects: [],
      };
      const [messages, active_attempt, retryable_attempt] = await Promise.all([
        options.conversations.listMessages(user, projectId, workItemId, conversationId),
        options.attempts.active(projectId, conversationId),
        options.attempts.latestRetryableAttempt(projectId, workItemId, conversationId),
      ]);
      return reply.send({
        ...found,
        messages,
        active_attempt,
        retryable_attempt,
        ...planDetail,
      });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.get(`${conversationBase}/:conversationId/messages`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const messages = await options.conversations.listMessages(
        user,
        projectId,
        workItemId,
        conversationId,
      );
      return reply.send({ messages });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${conversationBase}/:conversationId/messages`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const body = MessageBody.parse(request.body);
      const found = await options.conversations.getConversation(user, projectId, conversationId);
      if (found.work_item.id !== workItemId) {
        throw new ConversationTurnError(
          "conversation_scope_mismatch",
          "conversation scope mismatch",
        );
      }
      const active = await options.attempts.active(projectId, conversationId);
      if (active) {
        throw new ConversationTurnError(
          "turn_in_progress",
          "wait for or stop the active response before sending another message",
        );
      }
      if (await options.attempts.hasActivePlanProposal(conversationId)) {
        throw new ConversationTurnError(
          "turn_in_progress",
          "wait for the active plan proposal before sending another message",
        );
      }
      const message = await options.conversations.submitUserMessage(user, {
        project_id: projectId,
        work_item_id: workItemId,
        conversation_id: conversationId,
        ...body,
      });
      const prepared = await options.turns.prepare({
        actor: user,
        projectId,
        workItemId,
        conversationId,
        triggeringMessageId: message.id,
      });
      await streamPrepared(request, reply, prepared);
    } catch (error) {
      if (!reply.sent) routeError(reply, error);
    }
  });

  app.post(`${conversationBase}/:conversationId/retry`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const body = RetryBody.parse(request.body);
      const prepared = await options.turns.prepare({
        actor: user,
        projectId,
        workItemId,
        conversationId,
        triggeringMessageId: body.triggering_message_id,
        allowRetry: true,
      });
      await streamPrepared(request, reply, prepared);
    } catch (error) {
      if (!reply.sent) routeError(reply, error);
    }
  });

  app.post(`${conversationBase}/:conversationId/resume`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const body = ResumeBody.parse(request.body ?? {});
      const found = await options.conversations.getConversation(user, projectId, conversationId);
      if (found.work_item.id !== workItemId) {
        throw new ConversationTurnError(
          "conversation_scope_mismatch",
          "conversation scope mismatch",
        );
      }
      const triggeringMessageId =
        body.triggering_message_id ??
        (await options.attempts.latestRetryableTrigger(projectId, workItemId, conversationId));
      if (!triggeringMessageId) {
        throw new ConversationTurnError(
          "nothing_to_resume",
          "this conversation has no interrupted or failed turn to resume",
        );
      }
      const prepared = await options.turns.prepare({
        actor: user,
        projectId,
        workItemId,
        conversationId,
        triggeringMessageId,
        allowRetry: true,
      });
      await streamPrepared(request, reply, prepared);
    } catch (error) {
      if (!reply.sent) routeError(reply, error);
    }
  });

  app.post(`${conversationBase}/:conversationId/stop`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const body = StopBody.parse(request.body ?? {});
      const stopped = await options.turns.stop(user, projectId, conversationId, body.attempt_id);
      return reply.send({ stopped });
    } catch (error) {
      routeError(reply, error);
    }
  });
}
