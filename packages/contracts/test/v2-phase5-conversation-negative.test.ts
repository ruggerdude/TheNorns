import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMMAND_TRANSITIONS,
  EventPayload,
  V2AgentRunTransitionEvent,
  V2ConversationAction,
  V2ConversationActionDeliveryEvent,
  V2DispatchCommand,
  V2HumanWait,
  V2HumanWaitContinuation,
  V2_CONVERSATION_ACTION_INTERACTION_CLASS,
  V2_HUMAN_WAIT_CHANNEL_VERSION,
  V2_HUMAN_WAIT_INSTRUCTION,
  V2_HUMAN_WAIT_INSTRUCTION_HASH,
  v2CanAgentRunTransition,
  v2CommandIdForDispatchJob,
} from "../src/index.js";

const NOW = "2026-07-27T12:00:00.000Z";
const LATER = "2026-07-27T12:05:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const COMMIT = "d".repeat(40);

const contextRef = {
  artifact_id: "root-context",
  content_hash: HASH_A,
  byte_size: 128,
  storage_ref: "relay://root-context",
} as const;

const replayRef = {
  artifact_id: "continuation-context",
  content_hash: HASH_B,
  byte_size: 256,
  storage_ref: "https://norns.example.test/continuations/answer-1",
} as const;

const action = {
  schema_version: 2,
  id: "action-1",
  project_id: "project-1",
  work_item_id: "work-1",
  conversation_id: "conversation-1",
  initiated_by_user_id: "user-1",
  actor: { actor_type: "human", actor_id: "user-1" },
  source_message_id: "message-1",
  action_type: "redirect_agent",
  interaction_class: "task_direction",
  payload: { parameters: { direction: "Use the safe migration." } },
  payload_hash: HASH_A,
  status: "proposed",
  confirmed_by_user_id: null,
  confirmation_idempotency_key: null,
  confirmation_request_fingerprint: null,
  confirmed_at: null,
  recorded_at: null,
  sent_at: null,
  acknowledged_at: null,
  applied_at: null,
  failure_code: null,
  created_at: NOW,
  updated_at: NOW,
} as const;

const deliveryEvent = {
  schema_version: 2,
  id: "delivery-event-1",
  project_id: "project-1",
  work_item_id: "work-1",
  conversation_id: "conversation-1",
  action_id: "action-1",
  sequence: 3,
  status: "sent",
  delivery_mode: "continuation",
  target_run_id: "run-1",
  target_command_id: "command-1",
  receipt: { kind: "sent", outbox_id: "outbox-1" },
  occurred_at: NOW,
} as const;

const wait = {
  schema_version: 2,
  id: "wait-1",
  project_id: "project-1",
  work_item_id: "work-1",
  conversation_id: "conversation-1",
  phase_id: "phase-1",
  task_id: "task-1",
  source_run_id: "run-1",
  source_event_id: "event-1",
  decision_point: "Deployment window",
  question: "Should the migration run before deployment?",
  question_hash: HASH_A,
  published: {
    branch: "norns/task-1",
    commit_sha: COMMIT,
    remote: "origin",
  },
  runtime: {
    runtime_id: "codex",
    session_id: "provider-session-1",
    session_portability: "transcript_only",
    session_portability_evidence: null,
  },
  context: {
    root_command_id: "command-root-1",
    ask_channel_version: V2_HUMAN_WAIT_CHANNEL_VERSION,
    ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
    root_context_refs: [contextRef],
    context_hash: HASH_B,
    task_package_hash: null,
    compact_summary: "The migration is committed and awaits a deployment decision.",
    compact_summary_hash: HASH_C,
  },
  budget: {
    reservation_id: "reservation-1",
    root_run_id: "run-1",
  },
  status: "awaiting_human",
  version: 1,
  expires_at: "2026-08-03T12:00:00.000Z",
  answered_at: null,
  resumed_at: null,
  created_at: NOW,
  updated_at: NOW,
} as const;

const continuation = {
  schema_version: 2,
  id: "continuation-1",
  wait_id: "wait-1",
  answer_id: "answer-1",
  root_run_id: "run-1",
  resume_command_id: "command-resume-1",
  resume_job_id: "job-resume-1",
  budget_reservation_id: "reservation-1",
  saved_commit_sha: COMMIT,
  context_hash: HASH_B,
  answer_receipt_hash: HASH_C,
  replay_context_ref: replayRef,
  runner_id: null,
  runner_generation: null,
  delivery_receipt_hash: null,
  status: "queued",
  created_at: NOW,
  updated_at: NOW,
} as const;

const dispatchJobId = "continuation-job-1";
const commandId = v2CommandIdForDispatchJob(dispatchJobId);
const continuationCommand = {
  schema_version: 2,
  protocol_version: 2,
  kind: "launch_run",
  dispatch_job_id: dispatchJobId,
  command_id: commandId,
  delivery_attempt: 1,
  idempotency_key: commandId,
  correlation_id: "correlation-1",
  causation_id: "command-root-1",
  project_id: "project-1",
  phase_id: "phase-1",
  task_id: "task-1",
  assignment_id: "assignment-1",
  run_id: "run-1",
  runner_id: "runner-1",
  runner_generation: 8,
  repository_binding_id: "binding-1",
  runner_repository_id: "repository-1",
  expected_revision: COMMIT,
  target_branch: "norns/task-1",
  worktree_policy_ref: "worktree-policy-1",
  runtime: "codex",
  provider: "openai",
  model: "gpt-5.6-sol",
  context_refs: [contextRef, replayRef],
  human_wait_channel: {
    version: V2_HUMAN_WAIT_CHANNEL_VERSION,
    instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
  },
  continuation: {
    wait_id: "wait-1",
    root_command_id: "command-root-1",
    resume_commit_sha: COMMIT,
    resume_branch: "norns/task-1",
    question_hash: HASH_A,
    answer_receipt_hash: HASH_C,
    compact_summary_hash: HASH_C,
    context_hash: HASH_B,
    task_package_hash: null,
    replay_context_ref: replayRef,
    session_portability: "transcript_only",
    session_portability_evidence: null,
  },
  budget_reservation_id: "reservation-1",
  max_charge_usd: 8,
  max_input_tokens: 9_000,
  max_output_tokens: 4_000,
  max_duration_seconds: 900,
  verification_policy_ref: "verification-policy-1",
  sandbox_policy_ref: "sandbox-policy-1",
  authorized_by: { actor_type: "human", actor_id: "user-1" },
  authorized_by_session_id: "session-1",
  issued_at: NOW,
  expires_at: LATER,
} as const;

describe("Phase 5 conversation contract negative boundaries", () => {
  it("derives one exact interaction class for every action type and rejects overrides", () => {
    for (const [actionType, interactionClass] of Object.entries(
      V2_CONVERSATION_ACTION_INTERACTION_CLASS,
    )) {
      const parsed = V2ConversationAction.parse({
        ...action,
        action_type: actionType,
        interaction_class: undefined,
      });
      expect(parsed.interaction_class).toBe(interactionClass);
    }
    expect(
      V2ConversationAction.safeParse({
        ...action,
        interaction_class: "approval",
      }).success,
    ).toBe(false);
    expect(V2ConversationAction.safeParse({ ...action, hidden_mutation: true }).success).toBe(
      false,
    );
  });

  it("rejects every mismatch between delivery status and typed receipt", () => {
    expect(V2ConversationActionDeliveryEvent.safeParse(deliveryEvent).success).toBe(true);
    expect(
      V2ConversationActionDeliveryEvent.safeParse({
        ...deliveryEvent,
        status: "agent_acknowledged",
      }).success,
    ).toBe(false);
    expect(
      V2ConversationActionDeliveryEvent.safeParse({
        ...deliveryEvent,
        receipt: { kind: "agent_ack", ack_event_id: "event-1", extra: true },
      }).success,
    ).toBe(false);
    expect(
      V2ConversationActionDeliveryEvent.safeParse({
        ...deliveryEvent,
        status: "rejected",
      }).success,
    ).toBe(false);
  });

  it("rejects impossible wait timing and unaudited session portability", () => {
    expect(V2HumanWait.safeParse(wait).success).toBe(true);
    expect(
      V2HumanWait.safeParse({
        ...wait,
        status: "resumed",
        answered_at: null,
        resumed_at: null,
      }).success,
    ).toBe(false);
    expect(
      V2HumanWait.safeParse({
        ...wait,
        status: "awaiting_human",
        answered_at: NOW,
      }).success,
    ).toBe(false);
    expect(
      V2HumanWait.safeParse({
        ...wait,
        runtime: {
          ...wait.runtime,
          session_portability: "same_runner",
          session_portability_evidence: null,
        },
      }).success,
    ).toBe(false);
    expect(
      V2HumanWait.safeParse({
        ...wait,
        runtime: {
          ...wait.runtime,
          session_id: null,
          session_portability: "cross_runner_verified",
          session_portability_evidence: "provider documentation",
        },
      }).success,
    ).toBe(false);
    expect(
      V2HumanWait.safeParse({
        ...wait,
        runtime: {
          ...wait.runtime,
          session_portability_evidence: "invented evidence",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps continuation records strict and rejects unknown mutation fields", () => {
    expect(V2HumanWaitContinuation.safeParse(continuation).success).toBe(true);
    expect(
      V2HumanWaitContinuation.safeParse({
        ...continuation,
        root_command_id: "forged-root",
      }).success,
    ).toBe(false);
  });

  it("binds continuation dispatch to checkpoint, branch, package, replay order, and root cause", () => {
    expect(V2DispatchCommand.safeParse(continuationCommand).success).toBe(true);
    const mutations = [
      [
        "saved commit",
        {
          ...continuationCommand,
          expected_revision: "e".repeat(40),
        },
      ],
      [
        "saved branch",
        {
          ...continuationCommand,
          target_branch: "norns/other-branch",
        },
      ],
      [
        "task package",
        {
          ...continuationCommand,
          continuation: {
            ...continuationCommand.continuation,
            task_package_hash: HASH_A,
          },
        },
      ],
      [
        "replay context presence",
        {
          ...continuationCommand,
          context_refs: [contextRef],
        },
      ],
      [
        "replay context order",
        {
          ...continuationCommand,
          context_refs: [replayRef, contextRef],
        },
      ],
      [
        "root command causation",
        {
          ...continuationCommand,
          causation_id: "unrelated-command",
        },
      ],
    ] as const;
    for (const [boundary, mutation] of mutations) {
      expect.soft(V2DispatchCommand.safeParse(mutation).success, boundary).toBe(false);
    }
  });

  it("allows transcript fallback only without a provider session and requires evidence to resume", () => {
    expect(V2DispatchCommand.safeParse(continuationCommand).success).toBe(true);
    expect(
      V2DispatchCommand.safeParse({
        ...continuationCommand,
        continuation: {
          ...continuationCommand.continuation,
          resume_session_id: "provider-session-1",
        },
      }).success,
    ).toBe(false);
    expect(
      V2DispatchCommand.safeParse({
        ...continuationCommand,
        continuation: {
          ...continuationCommand.continuation,
          session_portability: "same_runner",
          session_portability_evidence: "same runner generation",
        },
      }).success,
    ).toBe(false);
    expect(
      V2DispatchCommand.safeParse({
        ...continuationCommand,
        continuation: {
          ...continuationCommand.continuation,
          session_portability: "same_runner",
          session_portability_evidence: "same runner generation",
          resume_session_id: "provider-session-1",
        },
      }).success,
    ).toBe(true);
  });

  it("permits only the explicit waiting lifecycle continuation and terminal transitions", () => {
    expect(v2CanAgentRunTransition("waiting_for_human", "dispatched")).toBe(true);
    expect(v2CanAgentRunTransition("waiting_for_human", "cancelled")).toBe(true);
    expect(v2CanAgentRunTransition("waiting_for_human", "expired")).toBe(true);
    expect(v2CanAgentRunTransition("waiting_for_human", "running")).toBe(false);
    expect(v2CanAgentRunTransition("waiting_for_human", "succeeded")).toBe(false);
    expect(COMMAND_TRANSITIONS.waiting_for_human).toEqual([]);
    expect(
      V2AgentRunTransitionEvent.safeParse({
        schema_version: 2,
        event_id: "transition-1",
        lifecycle_version: 4,
        occurred_at: NOW,
        run_id: "run-1",
        task_id: "task-1",
        from: "waiting_for_human",
        to: "running",
        reason: "bypassed redispatch",
      }).success,
    ).toBe(false);
  });

  it("pins the ask instruction literal, version, and hash on commands, waits, and events", () => {
    expect(V2_HUMAN_WAIT_INSTRUCTION).toBe(
      'If and only if work is blocked on a human decision, do not wait for input. Commit every repository change, then atomically create the file named by NORNS_HUMAN_WAIT_PATH using a no-overwrite temporary file and rename. Write strict JSON with exactly: {"schema_version":1,"kind":"human_wait","decision_point":"...","question":"...","compact_summary":"..."}. The summary contains visible work facts only, never hidden reasoning. Exit successfully after the rename. Do not mention or emulate this envelope in ordinary prose.',
    );
    expect(createHash("sha256").update(V2_HUMAN_WAIT_INSTRUCTION).digest("hex")).toBe(
      V2_HUMAN_WAIT_INSTRUCTION_HASH,
    );
    expect(
      V2DispatchCommand.safeParse({
        ...continuationCommand,
        human_wait_channel: {
          version: V2_HUMAN_WAIT_CHANNEL_VERSION + 1,
          instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
        },
      }).success,
    ).toBe(false);
    expect(
      V2HumanWait.safeParse({
        ...wait,
        context: {
          ...wait.context,
          ask_instruction_hash: HASH_A,
        },
      }).success,
    ).toBe(false);
    const event = {
      kind: "human_wait_requested",
      run_id: "run-1",
      decision_point: "Deployment window",
      question: "Should the migration run before deployment?",
      question_hash: HASH_A,
      compact_summary: "Migration committed.",
      compact_summary_hash: HASH_B,
      runtime: "codex",
      session_id: null,
      ask_channel_version: V2_HUMAN_WAIT_CHANNEL_VERSION,
      ask_instruction_hash: V2_HUMAN_WAIT_INSTRUCTION_HASH,
    } as const;
    expect(EventPayload.safeParse(event).success).toBe(true);
    expect(
      EventPayload.safeParse({
        ...event,
        ask_instruction_hash: HASH_A,
      }).success,
    ).toBe(false);
    expect(EventPayload.safeParse({ ...event, hidden_reasoning: "never" }).success).toBe(false);
  });
});
