import {
  type V2ActorTypeT,
  V2AgentRunState,
  type V2AgentRunStateT,
  V2AgentRunTransitionEvent,
  type V2AgentRunTransitionEventT,
  V2TaskState,
  type V2TaskStateT,
  V2TaskTransitionEvent,
  type V2TaskTransitionEventT,
} from "@norns/contracts";
import { newId } from "../../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "./database.js";
import { type V2LifecycleIntegrityGuard, assertV2AutomationAllowed } from "./reconciliation.js";

export interface V2LifecycleActorContext {
  actor_type: V2ActorTypeT;
  actor_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: string;
}

export interface V2LockedTaskLifecycle {
  id: string;
  project_id: string;
  phase_id: string;
  state: V2TaskStateT;
  lifecycle_version: number;
  aggregate_version: number;
}

export interface V2LockedAgentRunLifecycle {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  state: V2AgentRunStateT;
  lifecycle_version: number;
  aggregate_version: number;
}

export interface V2TaskLifecycleCommitInput {
  row: V2LockedTaskLifecycle;
  event: V2TaskTransitionEventT;
  actor: V2LifecycleActorContext;
}

export interface V2AgentRunLifecycleCommitInput {
  row: V2LockedAgentRunLifecycle;
  event: V2AgentRunTransitionEventT;
  actor: V2LifecycleActorContext;
}

/**
 * The only persistence port permitted to change Task or AgentRun lifecycle
 * columns. Its SQL implementation updates the row and appends domain/audit
 * history on the same pinned transaction.
 */
export interface V2LifecycleMutationTransaction extends V2LifecycleIntegrityGuard {
  lockTaskLifecycle(taskId: string): Promise<V2LockedTaskLifecycle | null>;
  lockAgentRunLifecycle(runId: string): Promise<V2LockedAgentRunLifecycle | null>;
  commitTaskLifecycleTransition(input: V2TaskLifecycleCommitInput): Promise<V2LockedTaskLifecycle>;
  commitAgentRunLifecycleTransition(
    input: V2AgentRunLifecycleCommitInput,
  ): Promise<V2LockedAgentRunLifecycle>;
}

export interface V2LifecycleMutationTransactionFactory<TTx extends V2LifecycleMutationTransaction> {
  bind(tx: V2SqlExecutor): TTx;
}

export class V2LifecycleNotFoundError extends Error {
  constructor(
    readonly aggregateKind: "task" | "agent_run",
    readonly aggregateId: string,
  ) {
    super(`${aggregateKind} ${aggregateId} was not found`);
    this.name = "V2LifecycleNotFoundError";
  }
}

export class V2LifecycleScopeMismatchError extends Error {
  constructor(
    readonly aggregateKind: "task" | "agent_run",
    readonly aggregateId: string,
  ) {
    super(`${aggregateKind} ${aggregateId} does not belong to the requested scope`);
    this.name = "V2LifecycleScopeMismatchError";
  }
}

export class V2LifecycleVersionConflictError extends Error {
  constructor(
    readonly aggregateKind: "task" | "agent_run",
    readonly aggregateId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `${aggregateKind} ${aggregateId} version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "V2LifecycleVersionConflictError";
  }
}

export interface V2TaskLifecycleTransitionInput extends V2LifecycleActorContext {
  project_id: string;
  phase_id: string;
  task_id: string;
  expected_aggregate_version: number;
  to: V2TaskStateT;
  reason: string | null;
}

export interface V2AgentRunLifecycleTransitionInput extends V2LifecycleActorContext {
  project_id: string;
  phase_id: string;
  task_id: string;
  run_id: string;
  expected_aggregate_version: number;
  to: V2AgentRunStateT;
  reason: string | null;
}

function assertActorAttribution(actor: V2LifecycleActorContext): void {
  if (actor.actor_type === "human" && actor.actor_id === null) {
    throw new Error("human lifecycle transitions require an attributable actor");
  }
}

/**
 * Guarded application-service chokepoint for one Task lifecycle transition.
 * Callers may compose this inside a larger command/outbox transaction.
 */
export async function transitionV2TaskLifecycle(
  tx: V2LifecycleMutationTransaction,
  input: V2TaskLifecycleTransitionInput,
): Promise<V2LockedTaskLifecycle> {
  assertActorAttribution(input);
  const row = await tx.lockTaskLifecycle(input.task_id);
  if (!row) throw new V2LifecycleNotFoundError("task", input.task_id);
  if (row.project_id !== input.project_id || row.phase_id !== input.phase_id) {
    throw new V2LifecycleScopeMismatchError("task", input.task_id);
  }
  await assertV2AutomationAllowed(tx, "task", input.task_id);
  if (row.aggregate_version !== input.expected_aggregate_version) {
    throw new V2LifecycleVersionConflictError(
      "task",
      input.task_id,
      input.expected_aggregate_version,
      row.aggregate_version,
    );
  }

  const event = V2TaskTransitionEvent.parse({
    schema_version: 2,
    event_id: newId("event"),
    task_id: input.task_id,
    lifecycle_version: row.lifecycle_version + 1,
    occurred_at: input.occurred_at,
    from: V2TaskState.parse(row.state),
    to: V2TaskState.parse(input.to),
    reason: input.reason,
  });
  return tx.commitTaskLifecycleTransition({ row, event, actor: input });
}

/**
 * Guarded application-service chokepoint for one AgentRun lifecycle
 * transition. The owning Task identity is part of the scope check.
 */
export async function transitionV2AgentRunLifecycle(
  tx: V2LifecycleMutationTransaction,
  input: V2AgentRunLifecycleTransitionInput,
): Promise<V2LockedAgentRunLifecycle> {
  assertActorAttribution(input);
  const row = await tx.lockAgentRunLifecycle(input.run_id);
  if (!row) throw new V2LifecycleNotFoundError("agent_run", input.run_id);
  if (
    row.project_id !== input.project_id ||
    row.phase_id !== input.phase_id ||
    row.task_id !== input.task_id
  ) {
    throw new V2LifecycleScopeMismatchError("agent_run", input.run_id);
  }
  await assertV2AutomationAllowed(tx, "agent_run", input.run_id);
  if (row.aggregate_version !== input.expected_aggregate_version) {
    throw new V2LifecycleVersionConflictError(
      "agent_run",
      input.run_id,
      input.expected_aggregate_version,
      row.aggregate_version,
    );
  }

  const event = V2AgentRunTransitionEvent.parse({
    schema_version: 2,
    event_id: newId("event"),
    run_id: input.run_id,
    task_id: input.task_id,
    lifecycle_version: row.lifecycle_version + 1,
    occurred_at: input.occurred_at,
    from: V2AgentRunState.parse(row.state),
    to: V2AgentRunState.parse(input.to),
    reason: input.reason,
  });
  return tx.commitAgentRunLifecycleTransition({ row, event, actor: input });
}

export async function executeV2TaskLifecycleTransition<
  TTx extends V2LifecycleMutationTransaction,
>(options: {
  transactionRunner: V2TransactionRunner;
  transactionFactory: V2LifecycleMutationTransactionFactory<TTx>;
  input: V2TaskLifecycleTransitionInput;
}): Promise<V2LockedTaskLifecycle> {
  return options.transactionRunner.transaction((executor) =>
    transitionV2TaskLifecycle(options.transactionFactory.bind(executor), options.input),
  );
}

export async function executeV2AgentRunLifecycleTransition<
  TTx extends V2LifecycleMutationTransaction,
>(options: {
  transactionRunner: V2TransactionRunner;
  transactionFactory: V2LifecycleMutationTransactionFactory<TTx>;
  input: V2AgentRunLifecycleTransitionInput;
}): Promise<V2LockedAgentRunLifecycle> {
  return options.transactionRunner.transaction((executor) =>
    transitionV2AgentRunLifecycle(options.transactionFactory.bind(executor), options.input),
  );
}
