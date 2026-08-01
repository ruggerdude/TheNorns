import {
  V2CreateConversationPlanChangeProposalInput,
  V2CreateConversationPlanProposalInput,
  V2CreateExecutionActionProposalInput,
  V2CreateHumanWaitAnswerProposalInput,
  V2QcMode,
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
    /** Only meaningful for a proposed `send_plan_to_qc` action; see
     * V2ConfirmConversationActionInput. */
    qc_mode: V2QcMode.optional(),
  })
  .strict();

const CancelReviewBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const ContinueReviewChatBody = z
  .object({
    channel: z.enum(["reviewer", "pm"]),
    message: z.string().trim().min(1).max(4_000),
  })
  .strict();

const ContinueWithoutQcBody = z
  .object({
    idempotency_key: z.string().min(1),
  })
  .strict();

const ResumeReviewBody = z
  .object({
    exit: z.enum(["continue", "note"]),
    note: z
      .object({
        channel: z.enum(["reviewer", "pm"]),
        message: z.string().trim().min(1).max(4_000),
      })
      .strict()
      .optional(),
    idempotency_key: z.string().min(1).optional(),
    // Compound exit "Continue, and stop asking" (QC-PAUSE-POINTS.md "Gate
    // exits"): sets qc_mode to automatic for the rest of this run.
    stop_asking: z.boolean().optional(),
  })
  .strict();

const AdjudicateReviewBody = z
  .object({
    // Gate C batches several findings into one card; one ruling each.
    rulings: z
      .record(
        z.string().min(1),
        z
          .object({
            ruling: z.enum(["reviewer", "pm", "supplied_fact"]),
            rationale: z.string().trim().min(1).max(2_000),
          })
          .strict(),
      )
      .refine((value) => Object.keys(value).length > 0, {
        message: "at least one ruling is required",
      }),
    note: z
      .object({
        channel: z.enum(["reviewer", "pm"]),
        message: z.string().trim().min(1).max(4_000),
      })
      .strict()
      .optional(),
    raise_max_rounds: z.boolean().optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  .strict();

// Mid-flight mutability (QC-PAUSE-POINTS.md "Mutability mid-flight"): only
// cadence settings are exposed here. Reviewer/PM identity has no field at
// all, so submitting one is a 400 (unknown key, `.strict()`) rather than a
// runtime guard — that's the intended "rejected as mid-flight mutable".
const PatchReviewBody = z
  .object({
    qc_mode: V2QcMode.optional(),
    max_rounds: z.number().int().min(1).max(5).optional(),
  })
  .strict()
  .refine((value) => value.qc_mode !== undefined || value.max_rounds !== undefined, {
    message: "at least one of qc_mode or max_rounds is required",
  });

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
        ...(body.qc_mode ? { qc_mode: body.qc_mode } : {}),
      });
      return reply.send(response);
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/plan-reviews/:reviewId/cancel`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, reviewId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      reviewId: string;
    };
    try {
      const body = CancelReviewBody.parse(request.body);
      const review = await options.workflow.cancelReview(
        user.id,
        { projectId, workItemId, conversationId },
        reviewId,
        body.reason,
      );
      return reply.send({ review });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/plan-reviews/:reviewId/chat`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, reviewId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      reviewId: string;
    };
    try {
      const body = ContinueReviewChatBody.parse(request.body);
      const review = await options.workflow.continueReviewChat(
        user.id,
        { projectId, workItemId, conversationId },
        reviewId,
        body.channel,
        body.message,
      );
      return reply.send({ review });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/plan-reviews/:reviewId/resume`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, reviewId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      reviewId: string;
    };
    try {
      const body = ResumeReviewBody.parse(request.body);
      const review = await options.workflow.resumeReview(
        user.id,
        { projectId, workItemId, conversationId },
        reviewId,
        {
          exit: body.exit,
          ...(body.note ? { note: body.note } : {}),
          ...(body.idempotency_key ? { idempotencyKey: body.idempotency_key } : {}),
          ...(body.stop_asking !== undefined ? { stopAsking: body.stop_asking } : {}),
        },
      );
      return reply.send({ review });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/plan-reviews/:reviewId/adjudicate`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, reviewId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      reviewId: string;
    };
    try {
      const body = AdjudicateReviewBody.parse(request.body);
      const review = await options.workflow.adjudicateReview(
        user.id,
        { projectId, workItemId, conversationId },
        reviewId,
        {
          rulings: body.rulings,
          ...(body.note ? { note: body.note } : {}),
          ...(body.raise_max_rounds !== undefined ? { raiseMaxRounds: body.raise_max_rounds } : {}),
          ...(body.idempotency_key ? { idempotencyKey: body.idempotency_key } : {}),
        },
      );
      return reply.send({ review });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.patch(`${base}/plan-reviews/:reviewId`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, reviewId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      reviewId: string;
    };
    try {
      const body = PatchReviewBody.parse(request.body);
      const review = await options.workflow.patchReview(
        user.id,
        { projectId, workItemId, conversationId },
        reviewId,
        {
          ...(body.qc_mode ? { qcMode: body.qc_mode } : {}),
          ...(body.max_rounds !== undefined ? { maxRounds: body.max_rounds } : {}),
        },
      );
      return reply.send({ review });
    } catch (error) {
      routeError(reply, error);
    }
  });

  app.post(`${base}/plan-reviews/:reviewId/continue-without-qc`, async (request, reply) => {
    const user = await options.requireUser(request, reply);
    if (!user) return;
    const { projectId, workItemId, conversationId, reviewId } = request.params as {
      projectId: string;
      workItemId: string;
      conversationId: string;
      reviewId: string;
    };
    try {
      const body = ContinueWithoutQcBody.parse(request.body);
      return reply.send(
        await options.workflow.continueWithoutQc(
          user.id,
          { projectId, workItemId, conversationId },
          reviewId,
          body.idempotency_key,
        ),
      );
    } catch (error) {
      routeError(reply, error);
    }
  });
}
