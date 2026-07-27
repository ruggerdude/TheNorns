import {
  V2CreateConversationPlanChangeProposalInput,
  V2CreateConversationPlanProposalInput,
  V2CreateExecutionActionProposalInput,
  V2CreateHumanWaitAnswerProposalInput,
} from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConversationHumanSteeringService } from "./humanSteering.js";
import type { ConversationPlanChangeProposalService } from "./planChangeProposal.js";
import type { ConversationPlanProposalService } from "./planProposal.js";
import {
  ConversationPlanWorkflowError,
  type ConversationPlanWorkflowService,
} from "./planWorkflow.js";
import { ConversationPersistenceError } from "./repository.js";

interface PlanRouteUser {
  id: string;
}

export interface ConversationPlanRouteOptions {
  requireUser(request: FastifyRequest, reply: FastifyReply): Promise<PlanRouteUser | null>;
  workflow: ConversationPlanWorkflowService;
  proposals: ConversationPlanProposalService;
  changes: ConversationPlanChangeProposalService;
  steering?: ConversationHumanSteeringService;
}

const ConfirmBody = z
  .object({
    idempotency_key: z.string().min(1),
  })
  .strict();

function routeError(reply: FastifyReply, error: unknown): void {
  if (error instanceof z.ZodError) {
    reply.code(400).send({ error: "bad_request", issues: error.issues });
    return;
  }
  if (
    error instanceof ConversationPlanWorkflowError ||
    error instanceof ConversationPersistenceError
  ) {
    reply.code(error.httpStatus).send({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

export function registerConversationPlanRoutes(
  app: FastifyInstance,
  options: ConversationPlanRouteOptions,
): void {
  const base = "/api/v2/projects/:projectId/work-items/:workItemId/conversations/:conversationId";

  app.post(`${base}/plan-proposals`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const response = await options.proposals.propose(
        user.id,
        projectId,
        workItemId,
        conversationId,
        V2CreateConversationPlanProposalInput.parse(request.body),
      );
      return reply.send(response);
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/plan-change-proposals`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const response = await options.changes.propose(
        user.id,
        projectId,
        workItemId,
        conversationId,
        V2CreateConversationPlanChangeProposalInput.parse(request.body),
      );
      return reply.send(response);
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/actions`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    if (!options.steering) return reply.code(503).send({ error: "steering_unavailable" });
    const { projectId, workItemId, conversationId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
    };
    try {
      const response = await options.steering.proposeAction(
        user.id,
        { projectId, workItemId, conversationId },
        V2CreateExecutionActionProposalInput.parse(request.body),
      );
      return reply.code(201).send(response);
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/human-waits/:waitId/answer-proposals`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    if (!options.steering) return reply.code(503).send({ error: "steering_unavailable" });
    const { projectId, workItemId, conversationId, waitId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      waitId: string;
    };
    try {
      const response = await options.steering.proposeAnswer(
        user.id,
        { projectId, workItemId, conversationId },
        waitId,
        V2CreateHumanWaitAnswerProposalInput.parse(request.body),
      );
      return reply.code(201).send(response);
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/actions/:actionId/confirm`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, actionId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      actionId: string;
    };
    try {
      const body = ConfirmBody.parse(request.body);
      if (options.steering) {
        const executionResponse = await options.steering.confirm(user.id, {
          project_id: projectId,
          work_item_id: workItemId,
          conversation_id: conversationId,
          action_id: actionId,
          idempotency_key: body.idempotency_key,
        });
        if (executionResponse) return reply.send(executionResponse);
      }
      const response = await options.workflow.confirm(user.id, {
        project_id: projectId,
        work_item_id: workItemId,
        conversation_id: conversationId,
        action_id: actionId,
        idempotency_key: body.idempotency_key,
      });
      return reply.send(response);
    } catch (error) {
      routeError(reply, error);
    }
  });
}
