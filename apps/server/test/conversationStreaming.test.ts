import { PGlite } from "@electric-sql/pglite";
import {
  AdapterError,
  type ConversationLlmAdapter,
  type ConversationRequest,
  type ConversationStreamEvent,
  FakeAdapter,
} from "@norns/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttachmentService } from "../src/attachments/service.js";
import { ConversationContextAssembler } from "../src/conversations/contextAssembler.js";
import {
  CONVERSATIONAL_PM_INSTRUCTIONS,
  CONVERSATIONAL_PM_PROMPT_VERSION,
} from "../src/conversations/prompt.js";
import { PostgresConversationRepository } from "../src/conversations/repository.js";
import { ConversationService } from "../src/conversations/service.js";
import { ConversationTurnRepository } from "../src/conversations/turnRepository.js";
import { ConversationTurnService } from "../src/conversations/turnService.js";
import { canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { SqlAiUsageTelemetryRepository } from "../src/persistence/v2/aiUsageTelemetry.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { AiInvocationTelemetry } from "../src/usage-intelligence/telemetry.js";

const asMigrationDatabase = (database: PGlite): V2MigrationDatabase =>
  database as unknown as V2MigrationDatabase;

describe.sequential("persistent planning conversation streaming", () => {
  let pg: PGlite;
  let conversations: ConversationService;
  let attempts: ConversationTurnRepository;
  let turnService: ConversationTurnService;
  let transactions: PGliteTransactionRunner;
  let contexts: ConversationContextAssembler;
  let attachments: AttachmentService;
  let telemetry: AiInvocationTelemetry;
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
    fake = new FakeAdapter("openai", "mock-openai");
    currentAdapter = fake as ConversationLlmAdapter;
    turnService = new ConversationTurnService(
      conversations,
      contexts,
      attempts,
      attachments,
      telemetry,
      () => currentAdapter,
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
    await expect(attempts.reconcileOrphans()).resolves.toBe(1);
    prepared.cancel();
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
  });
});
