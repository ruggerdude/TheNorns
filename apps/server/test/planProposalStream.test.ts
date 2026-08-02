// Streaming plan proposals: the partial-JSON scanner that turns half-written
// output into progress, and the wire contract the web client consumes.
import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationPlanChangeProposalService } from "../src/conversations/planChangeProposal.js";
import {
  type ConversationPlanProposalService,
  type PlanProposalProgressListener,
  planModuleTitles,
} from "../src/conversations/planProposal.js";
import { registerConversationPlanRoutes } from "../src/conversations/planRoutes.js";
import {
  ConversationPlanWorkflowError,
  type ConversationPlanWorkflowService,
} from "../src/conversations/planWorkflow.js";

describe("planModuleTitles", () => {
  it("reports a module title only once its closing quote has arrived", () => {
    const body = '{"plan":{"objective":"x","modules":[{"id":"one","title":"Auth rewri';
    expect(planModuleTitles(body)).toEqual([]);
    expect(planModuleTitles(`${body}te`)).toEqual([]);
    expect(planModuleTitles(`${body}te"`)).toEqual(["Auth rewrite"]);
  });

  it("accumulates titles in order and unescapes them", () => {
    const body =
      '{"modules":[{"title":"First \\"quoted\\" module"},{"title":"Second module"},{"title":"Third';
    expect(planModuleTitles(body)).toEqual(['First "quoted" module', "Second module"]);
  });

  it("returns nothing for output that has no completed module yet", () => {
    expect(planModuleTitles('{"plan":{"objective":"ship the thing","modu')).toEqual([]);
  });
});

describe("plan proposal stream route", () => {
  let app: FastifyInstance;
  let behavior: "success" | "conflict" = "success";
  let observed: PlanProposalProgressListener | undefined;

  const path =
    "/api/v2/projects/proj-1/work-items/work-1/conversations/conv-1/plan-proposals/stream";

  const chunks = async (
    payload: Record<string, string>,
  ): Promise<Array<Record<string, unknown>>> => {
    const response = await app.inject({ method: "POST", url: path, payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const stream = new Response(response.rawPayload).body;
    if (!stream) throw new Error("missing stream body");
    const parsed: Array<Record<string, unknown>> = [];
    for await (const event of parseJsonEventStream({ stream, schema: uiMessageChunkSchema })) {
      if (event.success) parsed.push(event.value as Record<string, unknown>);
    }
    return parsed;
  };

  beforeEach(async () => {
    behavior = "success";
    observed = undefined;
    app = Fastify({ logger: false });
    const proposals = {
      propose: async (
        _userId: string,
        _projectId: string,
        _workItemId: string,
        _conversationId: string,
        _input: unknown,
        onProgress?: PlanProposalProgressListener,
      ) => {
        observed = onProgress;
        if (behavior === "conflict") {
          throw new ConversationPlanWorkflowError(
            "proposal_in_progress",
            "this idempotent plan proposal is still generating",
          );
        }
        onProgress?.({ stage: "generating", modules: [], output_tokens_estimate: 200 });
        onProgress?.({
          stage: "generating",
          modules: ["Auth rewrite"],
          output_tokens_estimate: 900,
        });
        onProgress?.({
          stage: "saving",
          modules: ["Auth rewrite"],
          output_tokens_estimate: 1_100,
        });
        return { message: { id: "message-1" }, action: { id: "action-1" } };
      },
    } as unknown as ConversationPlanProposalService;
    registerConversationPlanRoutes(app, {
      requireUser: async (_request, reply) => {
        if ((_request.headers.authorization ?? "ok") === "none") {
          reply.code(401).send({ error: "unauthorized" });
          return null;
        }
        return { id: "route-user" };
      },
      workflow: {} as unknown as ConversationPlanWorkflowService,
      proposals,
      changes: {} as unknown as ConversationPlanChangeProposalService,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("streams progress then the proposal payload", async () => {
    const parsed = await chunks({ idempotency_key: "key-1" });

    expect(parsed[0]).toEqual({ type: "start", messageId: "plan-proposal:key-1" });
    expect(parsed.filter((chunk) => chunk.type === "data-plan-progress")).toEqual([
      {
        type: "data-plan-progress",
        transient: true,
        data: { stage: "generating", modules: [], output_tokens_estimate: 200 },
      },
      {
        type: "data-plan-progress",
        transient: true,
        data: {
          stage: "generating",
          modules: ["Auth rewrite"],
          output_tokens_estimate: 900,
        },
      },
      {
        type: "data-plan-progress",
        transient: true,
        data: { stage: "saving", modules: ["Auth rewrite"], output_tokens_estimate: 1_100 },
      },
    ]);
    expect(parsed.at(-2)).toEqual({
      type: "data-plan-proposal",
      data: { message: { id: "message-1" }, action: { id: "action-1" } },
    });
    expect(parsed.at(-1)).toEqual({ type: "finish" });
    expect(observed).toBeTypeOf("function");
  });

  it("reports a workflow failure as a terminal data-plan-error part", async () => {
    behavior = "conflict";
    const parsed = await chunks({ idempotency_key: "key-2" });

    expect(parsed.at(-2)).toEqual({
      type: "data-plan-error",
      data: {
        error: "proposal_in_progress",
        message: "this idempotent plan proposal is still generating",
      },
    });
    expect(parsed.at(-1)).toEqual({ type: "finish" });
  });

  it("rejects an invalid body before the stream opens", async () => {
    const response = await app.inject({ method: "POST", url: path, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("bad_request");
  });
});
