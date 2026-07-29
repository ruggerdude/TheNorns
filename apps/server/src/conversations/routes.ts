import type { ProviderName } from "@norns/adapters";
import { V2CreateConversationPlanningExcerptInput, V2WorkMessagePart } from "@norns/contracts";
import { createUIMessageStream, pipeUIMessageStreamToResponse } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  ExecutionConversationDetail,
  ExecutionConversationService,
} from "./executionConversation.js";
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
  execution?: ExecutionConversationService;
}

const WorkItemBody = z
  .object({
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
  })
  .strict();
const WorkItemTitleBody = z.object({ title: z.string().trim().min(1).max(120) }).strict();
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
const PmUpdateSettingsBody = z
  .object({
    update_interval_seconds: z.number().int().min(60).max(86_400).nullable().optional(),
    content_level: z.enum(["concise", "standard", "detailed"]).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.update_interval_seconds !== undefined || value.content_level !== undefined,
    "at least one PM update setting is required",
  );

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
      const conversationIds = work_items.flatMap((group) =>
        group.conversations.map((conversation) => conversation.id),
      );
      const usage =
        options.execution && conversationIds.length > 0
          ? await options.execution.usageByWorkItem(user.id, projectId, conversationIds)
          : {};
      return reply.send({
        work_items: work_items.map((group) => ({
          ...group,
          conversation_usage: Object.fromEntries(
            group.conversations.flatMap((conversation) =>
              usage[conversation.id] ? [[conversation.id, usage[conversation.id]]] : [],
            ),
          ),
        })),
      });
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

  app.patch(`${workBase}/:workItemId`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId } = request.params as {
      projectId: string;
      workItemId: string;
    };
    try {
      const { title } = WorkItemTitleBody.parse(request.body);
      const work_item = await options.conversations.renameWorkItem(
        user,
        projectId,
        workItemId,
        title,
      );
      return reply.send({ work_item });
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
      const execution = options.execution;
      const projected = execution
        ? await Promise.all(
            conversations.map(async (conversation) => ({
              ...conversation,
              ...(await execution.detail(user.id, projectId, workItemId, conversation.id)),
            })),
          )
        : conversations;
      return reply.send({ conversations: projected });
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
      const [planDetail, messages, active_attempt, retryable_attempt, executionDetail] =
        await Promise.all([
          options.planDetail?.(user.id, projectId, found.work_item.id, conversationId) ??
            Promise.resolve({
              plan_versions: [],
              actions: [],
              plan_reviews: [],
              action_effects: [],
            }),
          options.conversations.listMessages(user, projectId, found.work_item.id, conversationId),
          options.attempts.active(projectId, conversationId),
          options.attempts.latestRetryableAttempt(projectId, found.work_item.id, conversationId),
          options.execution
            ? options.execution.detail(user.id, projectId, found.work_item.id, conversationId)
            : Promise.resolve(null),
        ]);
      return reply.send({
        ...found,
        messages,
        active_attempt,
        retryable_attempt,
        ...(executionDetail ?? {
          handoff: null,
          latest_summary: null,
          planning_excerpt_receipts: [],
          usage: null,
          human_waits: [],
          action_delivery_events: [],
          pm_updates: [],
          pm_update_settings: null,
        }),
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
      const [planDetail, messages, active_attempt, retryable_attempt, executionDetail] =
        await Promise.all([
          options.planDetail?.(user.id, projectId, workItemId, conversationId) ??
            Promise.resolve({
              plan_versions: [],
              actions: [],
              plan_reviews: [],
              action_effects: [],
            }),
          options.conversations.listMessages(user, projectId, workItemId, conversationId),
          options.attempts.active(projectId, conversationId),
          options.attempts.latestRetryableAttempt(projectId, workItemId, conversationId),
          options.execution
            ? options.execution.detail(user.id, projectId, workItemId, conversationId)
            : Promise.resolve(null),
        ]);
      return reply.send({
        ...found,
        messages,
        active_attempt,
        retryable_attempt,
        ...(executionDetail ?? {
          handoff: null,
          latest_summary: null,
          planning_excerpt_receipts: [],
          usage: null,
          human_waits: [],
          action_delivery_events: [],
          pm_updates: [],
          pm_update_settings: null,
        }),
        ...planDetail,
      });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.get("/api/v2/projects/:projectId/conversation-pm-settings", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    if (!options.execution) {
      return reply.code(503).send({ error: "conversation_execution_unavailable" });
    }
    const { projectId } = request.params as { projectId: string };
    try {
      return reply.send(await options.execution.pmSettings(user.id, projectId));
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.patch("/api/v2/projects/:projectId/conversation-pm-settings", async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    if (!options.execution) {
      return reply.code(503).send({ error: "conversation_execution_unavailable" });
    }
    const { projectId } = request.params as { projectId: string };
    try {
      const input = PmUpdateSettingsBody.parse(request.body);
      return reply.send(
        await options.execution.updatePmSettings(user.id, projectId, {
          ...(input.update_interval_seconds !== undefined
            ? { update_interval_seconds: input.update_interval_seconds }
            : {}),
          ...(input.content_level !== undefined ? { content_level: input.content_level } : {}),
        }),
      );
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

  app.post(`${conversationBase}/:conversationId/planning-excerpts`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      if (!options.execution) {
        throw new ConversationTurnError(
          "execution_conversation_unavailable",
          "execution conversation support is unavailable",
          503,
        );
      }
      const result = await options.execution.createPlanningExcerpt(
        user.id,
        projectId,
        workItemId,
        conversationId,
        V2CreateConversationPlanningExcerptInput.parse(request.body),
      );
      return reply.send(result);
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
