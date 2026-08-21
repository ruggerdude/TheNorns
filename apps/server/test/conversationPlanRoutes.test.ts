import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationPlanChangeProposalService } from "../src/conversations/planChangeProposal.js";
import type { ConversationPlanProposalService } from "../src/conversations/planProposal.js";
import { registerConversationPlanRoutes } from "../src/conversations/planRoutes.js";
import {
  ConversationPlanWorkflowError,
  type ConversationPlanWorkflowService,
} from "../src/conversations/planWorkflow.js";

describe("conversation plan routes", () => {
  let app: FastifyInstance;
  let authenticated = true;
  const calls: Array<{ kind: string; arguments: unknown[] }> = [];

  beforeEach(async () => {
    calls.length = 0;
    authenticated = true;
    app = Fastify({ logger: false });
    const workflow = {
      confirm: async (...args: unknown[]) => {
        calls.push({ kind: "confirm", arguments: args });
        return { action: { id: "action-1" }, effect: { kind: "plan_saved" } };
      },
      startDevelopment: async (...args: unknown[]) => {
        calls.push({ kind: "start-development", arguments: args });
        return { status: "succeeded", execution_started: true, execution_detail: "Started." };
      },
      adjudicateReview: async (...args: unknown[]) => {
        calls.push({ kind: "adjudicate", arguments: args });
        return { id: "review-1", status: "awaiting_human" };
      },
      patchReview: async (...args: unknown[]) => {
        calls.push({ kind: "patch", arguments: args });
        return { id: "review-1", status: "running" };
      },
    } as unknown as ConversationPlanWorkflowService;
    const proposals = {
      propose: async (...args: unknown[]) => {
        calls.push({ kind: "proposal", arguments: args });
        return { message: { id: "message-1" }, action: { id: "action-1" } };
      },
    } as unknown as ConversationPlanProposalService;
    const changes = {
      propose: async (...args: unknown[]) => {
        calls.push({ kind: "change", arguments: args });
        if ((args[4] as { plan_hash?: string }).plan_hash === "b".repeat(64)) {
          throw new ConversationPlanWorkflowError(
            "stale_plan_hash",
            "the requested plan hash is stale",
          );
        }
        return { message: { id: "message-2" }, action: { id: "action-2" } };
      },
    } as unknown as ConversationPlanChangeProposalService;
    registerConversationPlanRoutes(app, {
      requireUser: async (_request, reply) => {
        if (authenticated) return { id: "route-user" };
        reply.code(401).send({ error: "unauthorized" });
        return null;
      },
      workflow,
      proposals,
      changes,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("authenticates and scopes a plan proposal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-proposals",
      payload: {
        idempotency_key: "proposal-key",
        intent_message: "Use this as the plan.",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      message: { id: "message-1" },
      action: { id: "action-1" },
    });
    expect(calls).toEqual([
      {
        kind: "proposal",
        arguments: [
          "route-user",
          "project-1",
          "work-1",
          "conversation-1",
          {
            idempotency_key: "proposal-key",
            intent_message: "Use this as the plan.",
          },
        ],
      },
    ]);
  });

  it("maps a stale exact-hash change proposal to a truthful conflict", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-change-proposals",
      payload: {
        idempotency_key: "change-key",
        plan_version_id: "plan-1",
        plan_hash: "b".repeat(64),
        direction: "Revise the verification evidence.",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "stale_plan_hash",
      message: "the requested plan hash is stale",
    });
  });

  it("constructs confirmation scope exclusively from authenticated route state", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/actions/action-1/confirm",
      payload: { idempotency_key: "confirmation-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        kind: "confirm",
        arguments: [
          "route-user",
          {
            project_id: "project-1",
            work_item_id: "work-1",
            conversation_id: "conversation-1",
            action_id: "action-1",
            idempotency_key: "confirmation-key",
          },
        ],
      },
    ]);
  });

  it("starts development only from authenticated route scope", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/execution-1/start-development",
      payload: { ponytail_mode: "ultra" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "succeeded",
      execution_started: true,
      execution_detail: "Started.",
    });
    expect(calls).toEqual([
      {
        kind: "start-development",
        arguments: [
          "route-user",
          { projectId: "project-1", workItemId: "work-1", conversationId: "execution-1" },
          "ultra",
        ],
      },
    ]);
  });

  it("does not call a plan service when authentication fails", async () => {
    authenticated = false;
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-proposals",
      payload: { idempotency_key: "proposal-key" },
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("adjudicates a Gate C finding with a ruling per finding", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-reviews/review-1/adjudicate",
      payload: {
        rulings: {
          "review-1:finding:0": { ruling: "reviewer", rationale: "The code does say that." },
        },
        note: { channel: "pm", message: "See src/foo.ts line 12." },
        raise_max_rounds: true,
        idempotency_key: "adjudicate-key",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        kind: "adjudicate",
        arguments: [
          "route-user",
          { projectId: "project-1", workItemId: "work-1", conversationId: "conversation-1" },
          "review-1",
          {
            rulings: {
              "review-1:finding:0": { ruling: "reviewer", rationale: "The code does say that." },
            },
            note: { channel: "pm", message: "See src/foo.ts line 12." },
            raiseMaxRounds: true,
            idempotencyKey: "adjudicate-key",
          },
        ],
      },
    ]);
  });

  it("rejects an adjudication with no rulings", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-reviews/review-1/adjudicate",
      payload: { rulings: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("patches qc_mode and max_rounds mid-flight", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-reviews/review-1",
      payload: { qc_mode: "gated_each_step", max_rounds: 4 },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        kind: "patch",
        arguments: [
          "route-user",
          { projectId: "project-1", workItemId: "work-1", conversationId: "conversation-1" },
          "review-1",
          { qcMode: "gated_each_step", maxRounds: 4 },
        ],
      },
    ]);
  });

  // Mid-flight mutability: reviewer/PM identity has no field on this route at
  // all, so submitting one is a schema violation, not a silently-ignored key
  // (QC-PAUSE-POINTS.md "Mutability mid-flight": "Reviewer provider / model:
  // No — new attempt").
  it("rejects reviewer identity as mid-flight mutable", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v2/projects/project-1/work-items/work-1/conversations/conversation-1/plan-reviews/review-1",
      payload: { reviewer_provider: "anthropic", reviewer_model: "claude-sonnet-5" },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
