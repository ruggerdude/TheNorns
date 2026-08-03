import { PGlite } from "@electric-sql/pglite";
import {
  AdapterError,
  type ConversationLlmAdapter,
  type ConversationRequest,
  type ConversationStreamEvent,
  DEFAULT_MODEL_REGISTRY,
  FakeAdapter,
} from "@norns/adapters";
import type { AiUsageLifecycleEventInputT, UsageEventT } from "@norns/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttachmentService } from "../src/attachments/service.js";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import { SqlConversationInferenceBudget } from "../src/conversations/inferenceBudget.js";
import {
  CONVERSATIONAL_PM_INSTRUCTIONS,
  CONVERSATIONAL_PM_PROMPT_VERSION,
} from "../src/conversations/prompt.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { ConversationTurnRepository } from "../src/conversations/turnRepository.js";
import {
  type ConversationProviderGateway,
  ConversationTurnService,
} from "../src/conversations/turnService.js";
import { ProviderGateway } from "../src/gateway/providerGateway.js";
import { estimateGatewayInputTokens } from "../src/gateway/request.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import {
  type AiUsageTelemetryRepository,
  SqlAiUsageTelemetryRepository,
} from "../src/persistence/v2/aiUsageTelemetry.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AiInvocationTelemetry } from "../src/usage-intelligence/telemetry.js";
import { textPdf } from "./fileAttachmentFixtures.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

function pngBase64(width = 3, height = 2): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.from([0, 0, 0, 13]);
  const ihdr = Buffer.from("IHDR", "ascii");
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  const trailer = Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([signature, ihdrLength, ihdr, dimensions, trailer]).toString("base64");
}

function exactUsage(id: string): UsageEventT {
  return {
    id,
    provider: "openai",
    model: "mock-openai",
    project_id: "stream-project",
    node_id: null,
    run_id: null,
    input_tokens: 21,
    output_tokens: 7,
    estimated_cost_usd: 0.000112,
    actual_cost_usd: 0.000112,
    usage_source: "provider_api",
    pricing_version: "mock-1",
    occurred_at: "2026-07-27T12:00:00.000Z",
  };
}

describe.sequential("persistent planning conversation streaming", () => {
  let pg: PGlite;
  let conversations: ConversationService;
  let attempts: ConversationTurnRepository;
  let turnService: ConversationTurnService;
  let transactions: PGliteTransactionRunner;
  let contexts: ConversationContextAssembler;
  let attachments: AttachmentService;
  let telemetry: AiInvocationTelemetry;
  let gateway: ProviderGateway;
  let fake: FakeAdapter;
  let currentAdapter: ConversationLlmAdapter;
  let workItemId: string;
  let conversationId: string;
  let triggerId: string;
  let latestTriggerId: string;
  let idSequence = 0;
  const owner = { id: "stream-owner" };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(asMigrationDatabase(pg));
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES (
        'stream-owner', 'stream-owner@example.com', 'Stream Owner',
        'stream-owner@example.com', 'Stream Owner', 'hash', 'scrypt-v1',
        'member', 'active'
      ), (
        'stream-member', 'stream-member@example.com', 'Stream Member',
        'stream-member@example.com', 'Stream Member', 'hash', 'scrypt-v1',
        'member', 'active'
      );
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref,
        budget_policy_ref, owner_user_id
      ) VALUES (
        'stream-project', 'Stream Project', 'active',
        'assignment/default', 'verification/default', 'budget/default',
        'stream-owner'
      );
      INSERT INTO project_members (
        project_id, user_id, status, added_by_user_id
      ) VALUES (
        'stream-project', 'stream-member', 'active', 'stream-owner'
      );
    `);
    transactions = new PGliteTransactionRunner(pg);
    conversations = new ConversationService(new PostgresConversationRepository(transactions), {
      newId: (prefix) => `${prefix}-stream-${++idSequence}`,
    });
    attempts = new ConversationTurnRepository(transactions);
    contexts = new ConversationContextAssembler(transactions);
    attachments = new AttachmentService(transactions);
    telemetry = new AiInvocationTelemetry(
      new SqlAiUsageTelemetryRepository(transactions),
      () => new Date("2026-07-27T12:00:00.000Z"),
    );
    gateway = new ProviderGateway({
      runs: { lookup: async () => null },
      credentials: {} as never,
      apiKey: () => "test-provider-key",
      allowedModels: [],
      conversationAllowedModels: ["openai/mock-openai"],
      conversationBudget: new SqlConversationInferenceBudget(
        transactions,
        () => new Date("2026-07-27T12:00:00.000Z"),
      ),
      registry: {
        ...DEFAULT_MODEL_REGISTRY,
        "mock-openai": {
          provider: "openai",
          label: "Mock OpenAI",
          selectable: true,
          supports_structured_output: true,
          input_per_mtok: 2,
          output_per_mtok: 10,
          pricing_version: "mock-1",
          pricing_is_estimate: true,
        },
      },
    });
    fake = new FakeAdapter("openai", "mock-openai");
    currentAdapter = fake as ConversationLlmAdapter;
    turnService = new ConversationTurnService(
      conversations,
      contexts,
      attempts,
      attachments,
      telemetry,
      () => currentAdapter,
      gateway,
      {
        newId: (prefix) => `${prefix}-turn-${++idSequence}`,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      },
    );
    const created = await conversations.createPlanningWorkspace(
      owner,
      {
        project_id: "stream-project",
        title: "Persistent planning",
        objective: "Develop and approve an implementation plan.",
      },
      { provider: "openai", model: "mock-openai" },
    );
    workItemId = created.work_item.id;
    conversationId = created.conversation.id;
    const planWithRisk = { plan: { risks: ["Provider failover needs verification."] } };
    await pg.exec(
      `INSERT INTO global_rule_settings (id, filename, content, version, updated_by)
       VALUES ('global','NORN.md','Global rule.',1,'stream-owner');
       INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, source_ref, confidence,
         version, status, approved_by_human, approved_by, approved_at
       ) VALUES
         (
           'stream-project-rules','stream-project','directive','Project rule.',
           'human','{"kind":"project_rules_file"}'::jsonb,1,1,'active',true,
           'stream-owner',now()
         ),
         (
           'stream-project-knowledge','stream-project','constraint','Approved constraint.',
           'human','{"kind":"conversation_test"}'::jsonb,1,1,'active',true,
           'stream-owner',now()
         );
       INSERT INTO decision_points (
         id, project_id, scope_entity_type, scope_entity_id, reason_class,
         source_instance_id, condition_key, condition_fingerprint, question,
         context, options, recommendation_option_id, urgency, status
       ) VALUES (
         'stream-decision','stream-project','project','stream-project','planning',
         'conversation-test','stream-decision-key','${"d".repeat(64)}','Choose a rollout?',
         'The rollout mode is unresolved.','[]'::jsonb,'decide','high','open'
       );`,
    );
    await pg.query(
      `INSERT INTO work_plan_versions (
         id, project_id, work_item_id, conversation_id, created_by_user_id,
         version, status, plan, content_hash
       ) VALUES (
         'stream-plan','stream-project',$1,$2,'stream-owner',1,'candidate',$3::jsonb,$4
       )`,
      [workItemId, conversationId, JSON.stringify(planWithRisk), canonicalSha256(planWithRisk)],
    );
    triggerId = (
      await conversations.submitUserMessage(owner, {
        project_id: "stream-project",
        work_item_id: workItemId,
        conversation_id: conversationId,
        client_message_id: "stream-client-1",
        parts: [
          {
            type: "text",
            format: "markdown",
            text: "Please turn this objective into a concrete plan.",
          },
        ],
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  it("persists a visible response, exact context receipt, pin, usage, and ordering", async () => {
    fake.enqueue("  Visible PM response.");
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: triggerId,
    });
    const emitted: string[] = [];
    await prepared.run({
      started: () => undefined,
      text: (delta) => emitted.push(delta),
      finished: () => undefined,
    });
    expect(emitted).toEqual(["  Visible PM response."]);

    const messages = await conversations.listMessages(
      owner,
      "stream-project",
      workItemId,
      conversationId,
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: prepared.outputMessageId,
      role: "assistant",
      visibility_status: "complete",
      sequence: 2,
      parts: [{ type: "text", format: "markdown", text: "  Visible PM response." }],
    });
    const storedAttempt = await attempts.latestForTrigger(
      "stream-project",
      workItemId,
      conversationId,
      triggerId,
    );
    expect(storedAttempt).toMatchObject({
      status: "succeeded",
      provider: "openai",
      model: "mock-openai",
      provider_request_id: expect.stringMatching(/^fake-openai-response-\d+$/),
      provider_finish_reason: "completed",
      usage_status: "exact",
      output_message_id: prepared.outputMessageId,
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(storedAttempt?.context_manifest.entries.map((entry) => entry.kind)).toEqual([
      "prompt",
      "global_rules",
      "project_rules",
      "project_knowledge",
      "work_objective",
      "decision",
      "risk",
      "message",
    ]);
    expect(storedAttempt?.context_manifest.entries[0]).toEqual({
      kind: "prompt",
      ref: CONVERSATIONAL_PM_PROMPT_VERSION,
      content_hash: canonicalSha256(CONVERSATIONAL_PM_INSTRUCTIONS),
      estimated_tokens: Math.ceil(CONVERSATIONAL_PM_INSTRUCTIONS.length / 4),
    });
    expect(storedAttempt?.context_hash).toBe(canonicalSha256(storedAttempt?.context_manifest));
    expect(storedAttempt?.context_manifest.estimated_tokens).toBeGreaterThan(0);
    expect(fake.requests[0]?.system).toContain("project manager for this specific Norns project");
    expect(fake.requests[0]?.messages).toEqual([
      {
        role: "user",
        content: "Please turn this objective into a concrete plan.",
      },
    ]);

    const usage = await pg.query<{ event_type: string }>(
      `SELECT event_type FROM ai_usage_events
        WHERE request_id=$1 ORDER BY sequence`,
      [storedAttempt?.usage_request_id],
    );
    expect(usage.rows.map((row) => row.event_type)).toEqual([
      "request_started",
      "usage_observed",
      "request_completed",
    ]);
  });

  it("does not dispatch an idempotent replay or retry a succeeded/latest historical turn", async () => {
    await expect(
      turnService.prepare({
        actor: owner,
        projectId: "stream-project",
        workItemId,
        conversationId,
        triggeringMessageId: triggerId,
      }),
    ).rejects.toMatchObject({ code: "message_already_processed" });
    await expect(
      turnService.prepare({
        actor: owner,
        projectId: "stream-project",
        workItemId,
        conversationId,
        triggeringMessageId: triggerId,
        allowRetry: true,
      }),
    ).rejects.toMatchObject({ code: "turn_not_retryable" });
    expect(fake.requests).toHaveLength(1);
    const chargedOnce = await pg.query<{ reservations: number; usage_events: number }>(
      `SELECT
         (SELECT count(*)::int
            FROM conversation_inference_reservations reservation
            JOIN conversation_turn_attempts attempt
              ON attempt.id=reservation.reservation_key
           WHERE attempt.triggering_message_id=$1) AS reservations,
         (SELECT count(*)::int
            FROM ai_usage_events usage
            JOIN conversation_turn_attempts attempt
              ON attempt.usage_request_id=usage.request_id
           WHERE attempt.triggering_message_id=$1
             AND usage.event_type='usage_observed') AS usage_events`,
      [triggerId],
    );
    expect(chargedOnce.rows).toEqual([{ reservations: 1, usage_events: 1 }]);

    latestTriggerId = (
      await conversations.submitUserMessage(owner, {
        project_id: "stream-project",
        work_item_id: workItemId,
        conversation_id: conversationId,
        client_message_id: "stream-client-2",
        parts: [{ type: "text", format: "plain", text: "A newer direction." }],
      })
    ).id;
    await expect(
      turnService.prepare({
        actor: owner,
        projectId: "stream-project",
        workItemId,
        conversationId,
        triggeringMessageId: triggerId,
        allowRetry: true,
      }),
    ).rejects.toMatchObject({ code: "historical_retry_forbidden" });
    expect(fake.requests).toHaveLength(1);
  });

  it("makes the gateway lease the only dispatch boundary and rechecks the immutable pin", async () => {
    const workspace = await conversations.createPlanningWorkspace(
      owner,
      {
        project_id: "stream-project",
        title: "Gateway dispatch boundary",
        objective: "Prove the adapter cannot bypass its admitted provider/model pin.",
      },
      { provider: "openai", model: "mock-openai" },
    );
    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workspace.work_item.id,
      conversation_id: workspace.conversation.id,
      client_message_id: "stream-gateway-pin",
      parts: [{ type: "text", format: "plain", text: "Use the pinned model." }],
    });
    const wrongAdapter = new FakeAdapter("anthropic", "mock-anthropic");
    currentAdapter = wrongAdapter as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId: workspace.work_item.id,
      conversationId: workspace.conversation.id,
      triggeringMessageId: trigger.id,
    });

    await expect(
      prepared.run({
        started: () => undefined,
        text: () => undefined,
        finished: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(wrongAdapter.requests).toHaveLength(0);
    await expect(
      pg.query<{ status: string }>(
        "SELECT status FROM conversation_inference_reservations WHERE reservation_key=$1",
        [prepared.attempt.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "released" }] });
  });

  it("retries only the latest user turn without replaying interrupted assistant output", async () => {
    class FailingVisibleAdapter extends FakeAdapter {
      override async streamConversation(
        request: ConversationRequest,
      ): Promise<AsyncIterable<ConversationStreamEvent>> {
        this.requests.push({
          system: request.system,
          prompt: "",
          schemaName: null,
          initiatedByUserId: request.initiatedByUserId,
          projectId: request.projectId,
          images: undefined,
          messages: request.messages,
        });
        return (async function* failAfterVisibleOutput() {
          yield {
            type: "response_started" as const,
            provider_execution_id: "failed-provider-request",
          };
          yield { type: "text_delta" as const, delta: "Interrupted partial" };
          throw new AdapterError("network", "socket closed", {
            metadata: {
              provider_execution_id: "failed-provider-request",
              request_dispatched: true,
            },
          });
        })();
      }
    }
    const failing = new FailingVisibleAdapter("openai", "mock-openai");
    currentAdapter = failing as ConversationLlmAdapter;
    const failed = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: latestTriggerId,
    });
    await expect(
      failed.run({
        started: () => undefined,
        text: () => undefined,
        finished: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "network" });
    const interrupted = (
      await conversations.listMessages(owner, "stream-project", workItemId, conversationId)
    ).at(-1);
    expect(interrupted).toMatchObject({
      role: "assistant",
      visibility_status: "interrupted",
      parts: [{ type: "text", text: "Interrupted partial" }],
    });

    const retry = new FakeAdapter("openai", "mock-openai");
    retry.enqueue("Clean retry");
    currentAdapter = retry as ConversationLlmAdapter;
    const preparedRetry = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: latestTriggerId,
      allowRetry: true,
    });
    await preparedRetry.run({
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    });
    await expect(
      attempts.latestRetryableAttempt("stream-project", workItemId, conversationId),
    ).resolves.toBeNull();
    expect(retry.requests[0]?.messages).toEqual([
      {
        role: "user",
        content: "Please turn this objective into a concrete plan.",
      },
      {
        role: "assistant",
        content: "  Visible PM response.",
      },
      { role: "user", content: "A newer direction." },
    ]);
    expect(JSON.stringify(retry.requests[0]?.messages)).not.toContain("Interrupted partial");
  });

  it("stops a live pre-visible stream without fabricating a message or exact usage", async () => {
    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-3",
      parts: [{ type: "text", format: "plain", text: "Stop this response." }],
    });
    const waiting = new FakeAdapter("openai", "mock-openai");
    waiting.streamConversation = async (request) =>
      (async function* waitForAbort() {
        yield {
          type: "response_started" as const,
          provider_execution_id: "waiting-provider-request",
        };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AdapterError("cancelled", "request aborted", {
          metadata: {
            provider_execution_id: "waiting-provider-request",
            request_dispatched: true,
          },
        });
      })();
    currentAdapter = waiting as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: trigger.id,
    });
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = prepared.run({
      started: () => started?.(),
      text: () => undefined,
      finished: () => undefined,
    });
    await didStart;
    const messagesBeforeBlockedSubmission = await conversations.listMessages(
      owner,
      "stream-project",
      workItemId,
      conversationId,
    );
    await expect(
      conversations.submitUserMessage(
        { id: "stream-member" },
        {
          project_id: "stream-project",
          work_item_id: workItemId,
          conversation_id: conversationId,
          client_message_id: "stream-client-blocked-behind-active",
          parts: [{ type: "text", format: "plain", text: "Do not strand this message." }],
        },
      ),
    ).rejects.toMatchObject({ code: "turn_in_progress" });
    await expect(
      conversations.submitUserMessage(owner, {
        project_id: "stream-project",
        work_item_id: workItemId,
        conversation_id: conversationId,
        client_message_id: "stream-client-3",
        parts: [{ type: "text", format: "plain", text: "Stop this response." }],
      }),
    ).resolves.toEqual(trigger);
    await expect(
      conversations.listMessages(owner, "stream-project", workItemId, conversationId),
    ).resolves.toHaveLength(messagesBeforeBlockedSubmission.length);
    await expect(
      turnService.stop(owner, "stream-project", conversationId, prepared.attempt.id),
    ).resolves.toBe(true);
    await expect(run).rejects.toMatchObject({ code: "cancelled" });

    const stored = await attempts.latestForTrigger(
      "stream-project",
      workItemId,
      conversationId,
      trigger.id,
    );
    expect(stored).toMatchObject({
      status: "cancelled",
      usage_status: "unavailable",
      output_message_id: null,
    });
    await expect(
      attempts.latestRetryableAttempt("stream-project", workItemId, conversationId),
    ).resolves.toMatchObject({
      id: prepared.attempt.id,
      triggering_message_id: trigger.id,
      status: "cancelled",
      output_message_id: null,
    });
    const messages = await conversations.listMessages(
      owner,
      "stream-project",
      workItemId,
      conversationId,
    );
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(3);
  });

  it("retains a stopped mid-stream response as interrupted with truthful unavailable usage", async () => {
    const latest = await attempts.latestRetryableTrigger(
      "stream-project",
      workItemId,
      conversationId,
    );
    if (!latest) throw new Error("pre-visible cancellation must be retryable");
    const waiting = new FakeAdapter("openai", "mock-openai");
    waiting.streamConversation = async (request) =>
      (async function* emitThenWaitForAbort() {
        yield {
          type: "response_started" as const,
          provider_execution_id: "visible-waiting-provider-request",
        };
        yield { type: "text_delta" as const, delta: "Partial before stop" };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AdapterError("cancelled", "request aborted", {
          metadata: {
            provider_execution_id: "visible-waiting-provider-request",
            request_dispatched: true,
          },
        });
      })();
    currentAdapter = waiting as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: latest,
      allowRetry: true,
    });
    let visible: (() => void) | undefined;
    const didBecomeVisible = new Promise<void>((resolve) => {
      visible = resolve;
    });
    const run = prepared.run({
      started: () => undefined,
      text: () => visible?.(),
      finished: () => undefined,
    });
    await didBecomeVisible;
    await turnService.stop(owner, "stream-project", conversationId, prepared.attempt.id);
    await expect(run).rejects.toMatchObject({ code: "cancelled" });

    const stored = await attempts.latestForTrigger(
      "stream-project",
      workItemId,
      conversationId,
      latest,
    );
    expect(stored).toMatchObject({
      id: prepared.attempt.id,
      status: "cancelled",
      usage_status: "unavailable",
      output_message_id: prepared.outputMessageId,
    });
    const output = (
      await conversations.listMessages(owner, "stream-project", workItemId, conversationId)
    ).find((message) => message.id === prepared.outputMessageId);
    expect(output).toMatchObject({
      role: "assistant",
      visibility_status: "interrupted",
      parts: [{ type: "text", text: "Partial before stop" }],
    });
  });

  it("lets an authorized collaborator retry another member's latest failed turn with their own attribution", async () => {
    const member = { id: "stream-member" };
    const latest = await attempts.latestRetryableTrigger(
      "stream-project",
      workItemId,
      conversationId,
    );
    if (!latest) throw new Error("the latest interrupted response must be retryable");
    const triggeringMessage = (
      await conversations.listMessages(owner, "stream-project", workItemId, conversationId)
    ).find((message) => message.id === latest);
    expect(triggeringMessage).toMatchObject({
      id: latest,
      role: "user",
      initiated_by_user_id: owner.id,
    });

    const retry = new FakeAdapter("openai", "mock-openai");
    retry.enqueue("Collaborator retry");
    currentAdapter = retry as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: member,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: latest,
      allowRetry: true,
    });
    await prepared.run({
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    });

    expect(prepared.attempt).toMatchObject({
      initiated_by_user_id: member.id,
      triggering_message_id: latest,
      attempt_number: 3,
    });
    const telemetry = await pg.query<{ initiated_by_user_id: string | null }>(
      `SELECT DISTINCT initiated_by_user_id
         FROM ai_usage_events
        WHERE request_id=$1`,
      [prepared.attempt.usage_request_id],
    );
    expect(telemetry.rows).toEqual([{ initiated_by_user_id: member.id }]);
  });

  it("refuses a trigger superseded before its locked begin without creating an attempt", async () => {
    const stale = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-stale-race",
      parts: [{ type: "text", format: "plain", text: "This will be superseded." }],
    });
    const blockingContexts = new ConversationContextAssembler(transactions);
    const assemble = blockingContexts.assemble.bind(blockingContexts);
    let enterAssembler: (() => void) | undefined;
    const enteredAssembler = new Promise<void>((resolve) => {
      enterAssembler = resolve;
    });
    let releaseAssembler: (() => void) | undefined;
    const assemblerRelease = new Promise<void>((resolve) => {
      releaseAssembler = resolve;
    });
    blockingContexts.assemble = async (...args) => {
      enterAssembler?.();
      await assemblerRelease;
      return assemble(...args);
    };
    const racingTurnService = new ConversationTurnService(
      conversations,
      blockingContexts,
      attempts,
      attachments,
      telemetry,
      () => new FakeAdapter("openai", "mock-openai"),
      gateway,
      {
        newId: (prefix) => `${prefix}-race-${++idSequence}`,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      },
    );
    const stalePrepare = racingTurnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: stale.id,
    });
    await enteredAssembler;
    const newer = await conversations.submitUserMessage(
      { id: "stream-member" },
      {
        project_id: "stream-project",
        work_item_id: workItemId,
        conversation_id: conversationId,
        client_message_id: "stream-client-newer-race",
        parts: [{ type: "text", format: "plain", text: "Use this newer direction." }],
      },
    );
    releaseAssembler?.();

    await expect(stalePrepare).rejects.toMatchObject({
      code: "historical_retry_forbidden",
    });
    await expect(
      attempts.latestForTrigger("stream-project", workItemId, conversationId, stale.id),
    ).resolves.toBeNull();
    const messages = await conversations.listMessages(
      owner,
      "stream-project",
      workItemId,
      conversationId,
    );
    expect(messages.at(-1)).toMatchObject({
      id: newer.id,
      sequence: stale.sequence + 1,
      initiated_by_user_id: "stream-member",
    });
  });

  it("reconciles a restart orphan in both the attempt and canonical usage lifecycle", async () => {
    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-restart",
      parts: [{ type: "text", format: "plain", text: "Survive a server restart." }],
    });
    currentAdapter = new FakeAdapter("openai", "mock-openai") as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: trigger.id,
    });
    prepared.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      pg.query<{ status: string }>(
        `SELECT status FROM conversation_inference_reservations
          WHERE reservation_key=$1`,
        [prepared.attempt.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "released" }] });
    await pg.query(
      `UPDATE conversation_inference_reservations
          SET status='active',resolved_at=NULL,updated_at=now()
        WHERE reservation_key=$1`,
      [prepared.attempt.id],
    );
    await expect(attempts.reconcileOrphans()).resolves.toBe(1);
    await expect(gateway.reconcileConversationReservations()).resolves.toBe(1);
    const stored = await attempts.latestForTrigger(
      "stream-project",
      workItemId,
      conversationId,
      trigger.id,
    );
    expect(stored).toMatchObject({
      id: prepared.attempt.id,
      status: "cancelled",
      usage_status: "unavailable",
      output_message_id: null,
    });
    const usage = await pg.query<{ event_type: string; error_category: string | null }>(
      `SELECT event_type, error_category FROM ai_usage_events
        WHERE request_id=$1 ORDER BY sequence`,
      [stored?.usage_request_id],
    );
    expect(usage.rows).toEqual([
      { event_type: "request_started", error_category: null },
      { event_type: "request_failed", error_category: "conversation_recovery" },
    ]);
    await expect(
      pg.query<{ status: string }>(
        `SELECT status FROM conversation_inference_reservations
          WHERE reservation_key=$1`,
        [prepared.attempt.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "released" }] });
  });

  it("streams uploaded attachment bytes through the durable message reference", async () => {
    const base64 = pngBase64();
    const uploaded = await attachments.create("stream-project", {
      mime: "image/png",
      base64,
      purpose: "conversation",
      createdBy: owner.id,
    });
    const stored = await attachments.content("stream-project", uploaded.id);
    expect(stored.mime).toBe("image/png");
    expect(stored.bytes.equals(Buffer.from(base64, "base64"))).toBe(true);

    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-image-integration",
      parts: [
        { type: "text", format: "plain", text: "Review this uploaded mockup." },
        {
          type: "attachment",
          attachment_id: uploaded.id,
          name: "mockup.png",
          media_type: "image/png",
        },
      ],
    });
    const captured = new FakeAdapter("openai", "mock-openai");
    captured.enqueue("The uploaded mockup is visible.");
    currentAdapter = captured as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: trigger.id,
    });
    await prepared.run({
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    });

    expect(captured.requests).toHaveLength(1);
    expect(captured.requests[0]?.images).toEqual([{ type: "image", mime: "image/png", base64 }]);
    expect(captured.requests[0]?.messages?.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Review this uploaded mockup.",
            `[Attachment: mockup.png (image/png), id=${uploaded.id}]`,
          ].join("\n\n"),
        },
        { type: "image", mime: "image/png", base64 },
      ],
    });
    const refs = await pg.query<{
      message_id: string;
      attachment_id: string;
      created_by_user_id: string;
    }>(
      `SELECT message_id, attachment_id, created_by_user_id
         FROM work_message_attachment_refs
        WHERE message_id=$1`,
      [trigger.id],
    );
    expect(refs.rows).toEqual([
      {
        message_id: trigger.id,
        attachment_id: uploaded.id,
        created_by_user_id: owner.id,
      },
    ]);
  });

  it("keeps arbitrary binary files as named project evidence for the PM", async () => {
    const uploaded = await attachments.create("stream-project", {
      mime: "application/octet-stream",
      content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]),
      filename: "design-assets.zip",
      purpose: "conversation",
      createdBy: owner.id,
    });
    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-binary-integration",
      parts: [
        { type: "text", format: "plain", text: "Keep these design assets with the project." },
        {
          type: "attachment",
          attachment_id: uploaded.id,
          name: uploaded.original_filename,
          media_type: uploaded.mime,
        },
      ],
    });
    const captured = new FakeAdapter("openai", "mock-openai");
    captured.enqueue("The design archive is attached as project evidence.");
    currentAdapter = captured as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: trigger.id,
    });
    await prepared.run({
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    });

    expect(captured.requests[0]?.images).toEqual([]);
    expect(captured.requests[0]?.system).toContain(
      `Binary attachment: design-assets.zip (application/octet-stream), id=${uploaded.id}`,
    );
    expect(captured.requests[0]?.messages?.at(-1)?.content).toContain(
      `[Attachment: design-assets.zip (application/octet-stream), id=${uploaded.id}]`,
    );
  });

  it("injects durable file extraction exactly once while preserving image-only provider parts", async () => {
    const extractedPhrase = "The launch constraint is a reversible staged rollout.";
    const uploaded = await attachments.create("stream-project", {
      mime: "application/pdf",
      content: textPdf(extractedPhrase),
      filename: "launch-constraints.pdf",
      purpose: "conversation",
      createdBy: owner.id,
    });
    expect(uploaded).toMatchObject({
      mime: "application/pdf",
      original_filename: "launch-constraints.pdf",
      extraction_truncated: false,
    });
    expect(uploaded.extracted_text_sha256).toMatch(/^[0-9a-f]{64}$/u);

    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-file-integration",
      parts: [
        { type: "text", format: "plain", text: "Use the attached launch constraints." },
        {
          type: "attachment",
          attachment_id: uploaded.id,
          name: "launch-constraints.pdf",
          media_type: "application/pdf",
        },
      ],
    });
    const captured = new FakeAdapter("openai", "mock-openai");
    captured.enqueue("The durable file context is available.");
    currentAdapter = captured as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: trigger.id,
    });
    await prepared.run({
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    });

    expect(captured.requests).toHaveLength(1);
    expect(captured.requests[0]?.images).toEqual([]);
    const currentMessage = captured.requests[0]?.messages?.at(-1);
    expect(currentMessage?.role).toBe("user");
    expect(typeof currentMessage?.content).toBe("string");
    const currentContent =
      typeof currentMessage?.content === "string" ? currentMessage.content : "";
    expect(currentContent).toContain(
      [
        "Use the attached launch constraints.",
        `[Attachment: launch-constraints.pdf (application/pdf), id=${uploaded.id}]`,
      ].join("\n\n"),
    );
    expect(currentContent).toContain("### File: launch-constraints.pdf");
    expect(currentContent).toContain(extractedPhrase);
    const system = captured.requests[0]?.system ?? "";
    expect(system).not.toContain(extractedPhrase);
    expect(`${system}\n${currentContent}`.split(extractedPhrase)).toHaveLength(2);
    const renderedBlock = currentContent.slice(
      currentContent.indexOf("### File: launch-constraints.pdf"),
    );
    const artifactEntry = prepared.attempt.context_manifest.entries.find(
      (candidate) => candidate.kind === "artifact" && candidate.ref === uploaded.id,
    );
    expect(artifactEntry).toMatchObject({
      content_hash: canonicalSha256(renderedBlock),
      estimated_tokens: Math.ceil(renderedBlock.length / 4),
    });
    expect(artifactEntry?.estimated_tokens).toBeGreaterThan(0);
  });

  it("deterministically caps multi-file conversation context without omitting file labels", async () => {
    const uploads = await Promise.all(
      ["alpha", "beta", "gamma"].map((name, index) =>
        attachments.create("stream-project", {
          mime: "text/plain",
          content: Buffer.from(`${name}:${String(index).repeat(60_000)}`, "utf8"),
          filename: `${name}.txt`,
          purpose: "conversation",
          createdBy: owner.id,
        }),
      ),
    );
    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-multi-file-cap",
      parts: [
        { type: "text", format: "plain", text: "Compare every attached file." },
        ...uploads.map((upload) => ({
          type: "attachment" as const,
          attachment_id: upload.id,
          name: upload.original_filename,
          media_type: upload.mime,
        })),
      ],
    });
    const captured = new FakeAdapter("openai", "mock-openai");
    captured.enqueue("All attachment labels remained available.");
    currentAdapter = captured as ConversationLlmAdapter;
    const prepared = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: trigger.id,
    });
    await prepared.run({
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    });

    const currentMessage = captured.requests[0]?.messages?.at(-1);
    expect(typeof currentMessage?.content).toBe("string");
    const currentContent =
      typeof currentMessage?.content === "string" ? currentMessage.content : "";
    for (const upload of uploads) {
      expect(currentContent).toContain(`### File: ${upload.original_filename}`);
    }
    expect(
      currentContent.match(/\[File context truncated to the conversation limit\]/gu)?.length,
    ).toBe(3);
    const entries = prepared.attempt.context_manifest.entries.filter(
      (candidate) =>
        candidate.kind === "artifact" && uploads.some((upload) => upload.id === candidate.ref),
    );
    expect(entries).toHaveLength(3);
    expect(entries.every((candidate) => candidate.estimated_tokens <= 12_500)).toBe(true);
    expect(
      entries.reduce((total, candidate) => total + candidate.estimated_tokens, 0),
    ).toBeLessThan(30_000);
    for (const [index, upload] of uploads.entries()) {
      const start = currentContent.indexOf(`### File: ${upload.original_filename}`);
      const nextUpload = uploads[index + 1];
      const end = nextUpload
        ? currentContent.indexOf(`\n### File: ${nextUpload.original_filename}`, start)
        : currentContent.length;
      const rendered = currentContent.slice(start, end);
      const entry = entries.find((candidate) => candidate.ref === upload.id);
      expect(entry?.content_hash).toBe(canonicalSha256(rendered));
      expect(entry?.estimated_tokens).toBe(Math.ceil(rendered.length / 4));
    }
  });

  it("settles exact provider usage on failure and cancellation while retaining ambiguous spend", async () => {
    const failedTrigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-exact-failure",
      parts: [{ type: "text", format: "plain", text: "Fail after exact usage." }],
    });
    const failedUsage = exactUsage("usage-exact-failure");
    const exactFailure = new FakeAdapter("openai", "mock-openai");
    exactFailure.streamConversation = async () =>
      (async function* failWithUsage() {
        yield { type: "response_started" as const, provider_execution_id: "exact-failure" };
        throw new AdapterError("invalid_response", "bad terminal payload", {
          metadata: {
            provider_execution_id: "exact-failure",
            request_dispatched: true,
            usage: failedUsage,
          },
        });
      })();
    currentAdapter = exactFailure as ConversationLlmAdapter;
    const failed = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: failedTrigger.id,
    });
    await expect(
      failed.run({
        started: () => undefined,
        text: () => undefined,
        finished: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });

    const cancelledTrigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-exact-cancel",
      parts: [{ type: "text", format: "plain", text: "Cancel after exact usage." }],
    });
    const cancelledUsage = exactUsage("usage-exact-cancel");
    const exactCancellation = new FakeAdapter("openai", "mock-openai");
    let capturedMaxTokens: number | undefined;
    exactCancellation.streamConversation = async (request) =>
      (async function* cancelWithUsage() {
        capturedMaxTokens = request.maxTokens;
        yield { type: "response_started" as const, provider_execution_id: "exact-cancel" };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AdapterError("cancelled", "cancelled", {
          metadata: {
            provider_execution_id: "exact-cancel",
            request_dispatched: true,
            usage: cancelledUsage,
          },
        });
      })();
    currentAdapter = exactCancellation as ConversationLlmAdapter;
    const cancelled = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: cancelledTrigger.id,
    });
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancellation = cancelled.run({
      started: () => started?.(),
      text: () => undefined,
      finished: () => undefined,
    });
    await didStart;
    expect(capturedMaxTokens).toBe(16_000);
    await turnService.stop(owner, "stream-project", conversationId, cancelled.attempt.id);
    await expect(cancellation).rejects.toMatchObject({ code: "cancelled" });

    const undispatchedTrigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-undispatched-failure",
      parts: [{ type: "text", format: "plain", text: "Fail before dispatch." }],
    });
    const undispatched = new FakeAdapter("openai", "mock-openai");
    undispatched.streamConversation = async () => {
      throw new AdapterError("network", "connection refused", {
        metadata: { request_dispatched: false },
      });
    };
    currentAdapter = undispatched as ConversationLlmAdapter;
    const notSent = await turnService.prepare({
      actor: owner,
      projectId: "stream-project",
      workItemId,
      conversationId,
      triggeringMessageId: undispatchedTrigger.id,
    });
    await expect(
      notSent.run({
        started: () => undefined,
        text: () => undefined,
        finished: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "network" });

    const rows = await pg.query<{
      reservation_key: string;
      status: string;
      actual_charge_usd: string;
    }>(
      `SELECT reservation_key,status,actual_charge_usd
         FROM conversation_inference_reservations
        WHERE reservation_key=ANY($1::text[])
        ORDER BY reservation_key`,
      [[failed.attempt.id, cancelled.attempt.id]],
    );
    expect(rows.rows).toEqual([
      {
        reservation_key: failed.attempt.id,
        status: "settled",
        actual_charge_usd: "0.000112000",
      },
      {
        reservation_key: cancelled.attempt.id,
        status: "settled",
        actual_charge_usd: "0.000112000",
      },
    ]);
    const ambiguous = await pg.query<{ status: string }>(
      `SELECT reservation.status FROM conversation_inference_reservations reservation
        JOIN conversation_turn_attempts attempt
          ON attempt.id=reservation.reservation_key
       WHERE attempt.provider_request_id='waiting-provider-request'`,
    );
    expect(ambiguous.rows).toEqual([{ status: "retained_ambiguous" }]);
    await expect(
      pg.query<{ status: string }>(
        "SELECT status FROM conversation_inference_reservations WHERE reservation_key=$1",
        [notSent.attempt.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "released" }] });

    await pg.query(
      `UPDATE conversation_inference_reservations
          SET status='active',actual_charge_usd=0,actual_tokens=0,resolved_at=NULL
        WHERE reservation_key=$1`,
      [failed.attempt.id],
    );
    await expect(gateway.reconcileConversationReservations()).resolves.toBe(1);
    await expect(
      pg.query<{ status: string; actual_charge_usd: string }>(
        `SELECT status,actual_charge_usd
           FROM conversation_inference_reservations WHERE reservation_key=$1`,
        [failed.attempt.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "settled", actual_charge_usd: "0.000112000" }],
    });
  });

  it("uses settled reservations until queued canonical telemetry recovers without double charging", async () => {
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES (
        'telemetry-owner','telemetry-owner@example.com','Telemetry Owner',
        'telemetry-owner@example.com','Telemetry Owner','hash','scrypt-v1','member','active'
      );
      INSERT INTO projects (
        id,name,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref,owner_user_id
      ) VALUES (
        'telemetry-project','Telemetry Project','active','assignment/default',
        'verification/default','budget/default','telemetry-owner'
      );
    `);
    const durableRepository = new SqlAiUsageTelemetryRepository(transactions);
    let rejectUsagePersistence = true;
    const flakyRepository: AiUsageTelemetryRepository = {
      createPricingProfile: (input) => durableRepository.createPricingProfile(input),
      findEffectivePricingProfile: (provider, model, occurredAt, pricingVersion) =>
        durableRepository.findEffectivePricingProfile(provider, model, occurredAt, pricingVersion),
      appendEvent: (input: AiUsageLifecycleEventInputT, stableEventId?: string) => {
        if (rejectUsagePersistence && input.event_type === "usage_observed") {
          return Promise.reject(new Error("fault-injected canonical telemetry outage"));
        }
        return durableRepository.appendEvent(input, stableEventId);
      },
      requestEvents: (requestId) => durableRepository.requestEvents(requestId),
    };
    const flakyTelemetries: AiInvocationTelemetry[] = [];
    let faultAdapter: ConversationLlmAdapter = new FakeAdapter(
      "openai",
      "mock-openai",
    ) as ConversationLlmAdapter;
    let gatewayStreams = 0;
    const dispatchingGateway: ConversationProviderGateway = {
      reserveConversation: async (scope, caps) => {
        const admission = await gateway.reserveConversation(scope, caps);
        if (admission.kind === "refused") return admission;
        const lease = admission.lease;
        return {
          ...admission,
          lease: {
            stream: async (adapter, request) => {
              gatewayStreams += 1;
              return lease.stream(adapter, request);
            },
            settle: (usage) => lease.settle(usage),
            release: () => lease.release(),
            retainAmbiguous: () => lease.retainAmbiguous(),
          },
        };
      },
    };
    const faultService = () => {
      const invocationTelemetry = new AiInvocationTelemetry(
        flakyRepository,
        () => new Date("2026-07-27T12:00:00.000Z"),
        {
          maxRetryAttempts: 100,
          retryBaseDelayMs: 10_000,
          onHealthChange: () => undefined,
        },
      );
      flakyTelemetries.push(invocationTelemetry);
      return new ConversationTurnService(
        conversations,
        contexts,
        attempts,
        attachments,
        invocationTelemetry,
        () => faultAdapter,
        dispatchingGateway,
        {
          newId: (prefix) => `${prefix}-telemetry-${++idSequence}`,
          now: () => new Date("2026-07-27T12:00:00.000Z"),
        },
      );
    };
    let faultTurnService = faultService();
    const telemetryOwner = { id: "telemetry-owner" };
    const workspace = (title: string) =>
      conversations.createPlanningWorkspace(
        telemetryOwner,
        {
          project_id: "telemetry-project",
          title,
          objective: `${title} with bounded canonical usage.`,
        },
        { provider: "openai", model: "mock-openai" },
      );
    const runCallbacks = {
      started: () => undefined,
      text: () => undefined,
      finished: () => undefined,
    };

    const succeededWorkspace = await workspace("Queued success");
    const succeededTrigger = await conversations.submitUserMessage(telemetryOwner, {
      project_id: "telemetry-project",
      work_item_id: succeededWorkspace.work_item.id,
      conversation_id: succeededWorkspace.conversation.id,
      client_message_id: "telemetry-success",
      parts: [{ type: "text", format: "plain", text: "Succeed with queued telemetry." }],
    });
    const succeededAdapter = new FakeAdapter("openai", "mock-openai");
    succeededAdapter.enqueue("Exact success");
    faultAdapter = succeededAdapter as ConversationLlmAdapter;
    const succeeded = await faultTurnService.prepare({
      actor: telemetryOwner,
      projectId: "telemetry-project",
      workItemId: succeededWorkspace.work_item.id,
      conversationId: succeededWorkspace.conversation.id,
      triggeringMessageId: succeededTrigger.id,
    });
    await succeeded.run(runCallbacks);

    const failedWorkspace = await workspace("Queued exact failure");
    const failedTrigger = await conversations.submitUserMessage(telemetryOwner, {
      project_id: "telemetry-project",
      work_item_id: failedWorkspace.work_item.id,
      conversation_id: failedWorkspace.conversation.id,
      client_message_id: "telemetry-failure",
      parts: [{ type: "text", format: "plain", text: "Fail with exact usage." }],
    });
    const failedUsage = exactUsage("telemetry-failed-usage");
    const failedAdapter = new FakeAdapter("openai", "mock-openai");
    failedAdapter.streamConversation = async () =>
      (async function* exactFailure() {
        yield {
          type: "response_started" as const,
          provider_execution_id: "telemetry-failed-provider",
        };
        throw new AdapterError("invalid_response", "fault-injected exact failure", {
          metadata: {
            provider_execution_id: "telemetry-failed-provider",
            request_dispatched: true,
            usage: failedUsage,
          },
        });
      })();
    faultAdapter = failedAdapter as ConversationLlmAdapter;
    faultTurnService = faultService();
    const failed = await faultTurnService.prepare({
      actor: telemetryOwner,
      projectId: "telemetry-project",
      workItemId: failedWorkspace.work_item.id,
      conversationId: failedWorkspace.conversation.id,
      triggeringMessageId: failedTrigger.id,
    });
    await expect(failed.run(runCallbacks)).rejects.toMatchObject({ code: "invalid_response" });

    const cancelledWorkspace = await workspace("Queued exact cancellation");
    const cancelledTrigger = await conversations.submitUserMessage(telemetryOwner, {
      project_id: "telemetry-project",
      work_item_id: cancelledWorkspace.work_item.id,
      conversation_id: cancelledWorkspace.conversation.id,
      client_message_id: "telemetry-cancel",
      parts: [{ type: "text", format: "plain", text: "Cancel with exact usage." }],
    });
    const cancelledUsage = exactUsage("telemetry-cancelled-usage");
    const cancelledAdapter = new FakeAdapter("openai", "mock-openai");
    cancelledAdapter.streamConversation = async (request) =>
      (async function* exactCancellation() {
        yield {
          type: "response_started" as const,
          provider_execution_id: "telemetry-cancelled-provider",
        };
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new AdapterError("cancelled", "fault-injected exact cancellation", {
          metadata: {
            provider_execution_id: "telemetry-cancelled-provider",
            request_dispatched: true,
            usage: cancelledUsage,
          },
        });
      })();
    faultAdapter = cancelledAdapter as ConversationLlmAdapter;
    faultTurnService = faultService();
    const cancelled = await faultTurnService.prepare({
      actor: telemetryOwner,
      projectId: "telemetry-project",
      workItemId: cancelledWorkspace.work_item.id,
      conversationId: cancelledWorkspace.conversation.id,
      triggeringMessageId: cancelledTrigger.id,
    });
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancellation = cancelled.run({
      ...runCallbacks,
      started: () => started?.(),
    });
    await didStart;
    await faultTurnService.stop(
      telemetryOwner,
      "telemetry-project",
      cancelledWorkspace.conversation.id,
      cancelled.attempt.id,
    );
    await expect(cancellation).rejects.toMatchObject({ code: "cancelled" });
    expect(gatewayStreams).toBe(3);

    await pg.query(
      `UPDATE conversation_inference_reservations
          SET status='active',actual_charge_usd=0,actual_tokens=0,resolved_at=NULL
        WHERE reservation_key=$1`,
      [failed.attempt.id],
    );
    await gateway.reconcileConversationReservations();
    await expect(
      pg.query<{ status: string; actual_tokens: number }>(
        `SELECT status,actual_tokens::int AS actual_tokens
           FROM conversation_inference_reservations WHERE reservation_key=$1`,
        [failed.attempt.id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "settled", actual_tokens: 28 }] });

    const fallback = await pg.query<{ actual_tokens: number; canonical_usage: number }>(
      `SELECT
         COALESCE(sum(reservation.actual_tokens),0)::int AS actual_tokens,
         (
           SELECT count(*)::int
             FROM ai_usage_events usage
            WHERE usage.project_id='telemetry-project'
              AND usage.event_type='usage_observed'
         ) AS canonical_usage
         FROM conversation_inference_reservations reservation
        WHERE reservation.project_id='telemetry-project'
          AND reservation.status='settled'`,
    );
    expect(fallback.rows).toEqual([{ actual_tokens: 206, canonical_usage: 0 }]);

    const boundedWorkspace = await workspace("Fallback bounded admission");
    const boundedTrigger = await conversations.submitUserMessage(telemetryOwner, {
      project_id: "telemetry-project",
      work_item_id: boundedWorkspace.work_item.id,
      conversation_id: boundedWorkspace.conversation.id,
      client_message_id: "telemetry-bounded",
      parts: [{ type: "text", format: "plain", text: "Respect recovered usage exactly once." }],
    });
    const assembled = await contexts.assemble(
      "telemetry-project",
      boundedWorkspace.work_item.id,
      boundedWorkspace.conversation.id,
      boundedTrigger.id,
    );
    const quotedTokens =
      estimateGatewayInputTokens(
        new TextEncoder().encode(
          JSON.stringify({
            system: assembled.system,
            messages: assembled.messages,
            maxTokens: 16_000,
          }),
        ).byteLength,
      ) + 16_000;
    await pg.query(
      `INSERT INTO usage_budget_policies (
         id,scope_type,scope_project_id,period,provider,model,limit_tokens,
         threshold_percentages,status,created_by_user_id
       ) VALUES (
         'telemetry-fallback-cap','project','telemetry-project','daily',
         'openai','mock-openai',$1,ARRAY[100]::smallint[],'active','telemetry-owner'
       )`,
      [quotedTokens + 205],
    );
    const boundedAdapter = new FakeAdapter("openai", "mock-openai");
    boundedAdapter.enqueue("Must stay behind the cap");
    faultAdapter = boundedAdapter as ConversationLlmAdapter;
    faultTurnService = faultService();
    await expect(
      faultTurnService.prepare({
        actor: telemetryOwner,
        projectId: "telemetry-project",
        workItemId: boundedWorkspace.work_item.id,
        conversationId: boundedWorkspace.conversation.id,
        triggeringMessageId: boundedTrigger.id,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(boundedAdapter.requests).toHaveLength(0);

    rejectUsagePersistence = false;
    const recoveredEvents = await Promise.all(
      flakyTelemetries.map((invocationTelemetry) => invocationTelemetry.reconcile()),
    );
    expect(recoveredEvents.reduce((total, count) => total + count, 0)).toBeGreaterThanOrEqual(1);
    await expect(
      pg.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM ai_usage_events
          WHERE project_id='telemetry-project' AND event_type='usage_observed'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 3 }] });
    await expect(
      faultTurnService.prepare({
        actor: telemetryOwner,
        projectId: "telemetry-project",
        workItemId: boundedWorkspace.work_item.id,
        conversationId: boundedWorkspace.conversation.id,
        triggeringMessageId: boundedTrigger.id,
        allowRetry: true,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    await pg.query("UPDATE usage_budget_policies SET limit_tokens=$2 WHERE id=$1", [
      "telemetry-fallback-cap",
      quotedTokens + 206,
    ]);

    const recovered = await faultTurnService.prepare({
      actor: telemetryOwner,
      projectId: "telemetry-project",
      workItemId: boundedWorkspace.work_item.id,
      conversationId: boundedWorkspace.conversation.id,
      triggeringMessageId: boundedTrigger.id,
      allowRetry: true,
    });
    expect(boundedAdapter.requests).toHaveLength(0);
    recovered.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      pg.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM conversation_inference_reservations reservation
          WHERE reservation.project_id='telemetry-project'
            AND reservation.status='settled'
            AND NOT EXISTS (
              SELECT 1
                FROM ai_usage_events usage
               WHERE usage.request_id=reservation.usage_request_id
                 AND usage.event_type='usage_observed'
            )`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("denies an applicable policy cap before the provider and keeps gateway allowlisting fail-closed", async () => {
    const unpriced = await telemetry.start({
      requestId: "stream-unpriced-history",
      provider: "openai",
      model: "mock-openai",
      endpoint: "/v1/responses",
      requestType: "conversation_turn",
      initiatedByUserId: owner.id,
      projectId: "stream-project",
    });
    await unpriced.observe({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      costClassification: "unavailable",
      usageSource: "provider_api",
      confidence: 1,
      providerRequestId: "stream-unpriced-provider",
    });
    await unpriced.complete({ providerRequestId: "stream-unpriced-provider" });
    await pg.exec(`
      INSERT INTO usage_budget_policies (
        id,scope_type,scope_project_id,period,provider,model,limit_usd,
        threshold_percentages,status,created_by_user_id
      ) VALUES (
        'stream-hard-cap','project','stream-project','daily','openai','mock-openai',
        100,ARRAY[100]::smallint[],'active','stream-owner'
      )
    `);
    const trigger = await conversations.submitUserMessage(owner, {
      project_id: "stream-project",
      work_item_id: workItemId,
      conversation_id: conversationId,
      client_message_id: "stream-client-budget-denied",
      parts: [{ type: "text", format: "plain", text: "This must not reach the provider." }],
    });
    const deniedAdapter = new FakeAdapter("openai", "mock-openai");
    currentAdapter = deniedAdapter as ConversationLlmAdapter;
    await expect(
      turnService.prepare({
        actor: owner,
        projectId: "stream-project",
        workItemId,
        conversationId,
        triggeringMessageId: trigger.id,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted", httpStatus: 402 });
    expect(deniedAdapter.requests).toHaveLength(0);
    await pg.exec("UPDATE usage_budget_policies SET status='disabled' WHERE id='stream-hard-cap'");

    const noAllowlist = new ProviderGateway({
      runs: { lookup: async () => null },
      credentials: {} as never,
      apiKey: () => "test-provider-key",
      conversationAllowedModels: [],
      conversationBudget: new SqlConversationInferenceBudget(transactions),
      registry: {
        "mock-openai": {
          provider: "openai",
          label: "Mock OpenAI",
          selectable: true,
          supports_structured_output: true,
          input_per_mtok: 2,
          output_per_mtok: 10,
          pricing_version: "mock-1",
          pricing_is_estimate: true,
        },
      },
    });
    await expect(
      noAllowlist.reserveConversation(
        {
          reservationKey: "never-reserved",
          usageRequestId: "never-reserved",
          projectId: "stream-project",
          workItemId,
          conversationId,
          initiatedByUserId: owner.id,
          provider: "openai",
          model: "mock-openai",
        },
        { maxInputTokens: 1_000, maxOutputTokens: 16_000 },
      ),
    ).resolves.toMatchObject({ kind: "refused", code: "model_unavailable" });
  });

  it("atomically enforces every applicable user and project policy without duplicate holds", async () => {
    await pg.exec(`
      INSERT INTO users (
        id,username,display_name,email,name,password_hash,password_hash_scheme,role,status
      ) VALUES (
        'budget-owner','budget-owner@example.com','Budget Owner',
        'budget-owner@example.com','Budget Owner','hash','scrypt-v1','member','active'
      );
      INSERT INTO projects (
        id,name,status,assignment_policy_ref,verification_policy_ref,budget_policy_ref,owner_user_id
      ) VALUES (
        'budget-project','Budget Project','active','assignment/default',
        'verification/default','budget/default','budget-owner'
      );
      INSERT INTO usage_budget_policies (
        id,scope_type,scope_user_id,scope_project_id,period,provider,model,limit_usd,
        threshold_percentages,status,created_by_user_id
      ) VALUES
        (
          'budget-user-cap','user','budget-owner',NULL,'daily','openai','mock-openai',
          0.20,ARRAY[100]::smallint[],'active','budget-owner'
        ),
        (
          'budget-project-cap','project',NULL,'budget-project','daily','openai','mock-openai',
          0.20,ARRAY[100]::smallint[],'active','budget-owner'
        )
    `);
    const budgetOwner = { id: "budget-owner" };
    const first = await conversations.createPlanningWorkspace(
      budgetOwner,
      { project_id: "budget-project", title: "First", objective: "First bounded call." },
      { provider: "openai", model: "mock-openai" },
    );
    const second = await conversations.createPlanningWorkspace(
      budgetOwner,
      { project_id: "budget-project", title: "Second", objective: "Second bounded call." },
      { provider: "openai", model: "mock-openai" },
    );
    const firstTrigger = await conversations.submitUserMessage(budgetOwner, {
      project_id: "budget-project",
      work_item_id: first.work_item.id,
      conversation_id: first.conversation.id,
      client_message_id: "budget-first",
      parts: [{ type: "text", format: "plain", text: "Reserve one." }],
    });
    const secondTrigger = await conversations.submitUserMessage(budgetOwner, {
      project_id: "budget-project",
      work_item_id: second.work_item.id,
      conversation_id: second.conversation.id,
      client_message_id: "budget-second",
      parts: [{ type: "text", format: "plain", text: "Reserve two." }],
    });
    currentAdapter = new FakeAdapter("openai", "mock-openai") as ConversationLlmAdapter;
    const results = await Promise.allSettled([
      turnService.prepare({
        actor: budgetOwner,
        projectId: "budget-project",
        workItemId: first.work_item.id,
        conversationId: first.conversation.id,
        triggeringMessageId: firstTrigger.id,
      }),
      turnService.prepare({
        actor: budgetOwner,
        projectId: "budget-project",
        workItemId: second.work_item.id,
        conversationId: second.conversation.id,
        triggeringMessageId: secondTrigger.id,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const prepared = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof turnService.prepare>>> =>
        result.status === "fulfilled",
    )?.value;
    if (!prepared) throw new Error("one bounded preparation must succeed");
    const active = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM conversation_inference_reservations
        WHERE project_id='budget-project' AND status='active'`,
    );
    expect(active.rows[0]?.count).toBe(1);
    await expect(
      turnService.prepare({
        actor: budgetOwner,
        projectId: "budget-project",
        workItemId: prepared.attempt.work_item_id,
        conversationId: prepared.attempt.conversation_id,
        triggeringMessageId: prepared.attempt.triggering_message_id,
      }),
    ).rejects.toMatchObject({ code: "message_already_processed" });
    await expect(
      pg.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM conversation_inference_reservations
          WHERE project_id='budget-project'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await attempts.reconcileOrphans();
    await gateway.reconcileConversationReservations();
  });
});
