import {
  type V2AgentRunStateT,
  V2AgentRunTransitionEvent,
  type V2AgentRunTransitionEventT,
  type V2TaskStateT,
  V2TaskTransitionEvent,
  type V2TaskTransitionEventT,
  reduceV2AgentRunLifecycle,
  reduceV2TaskLifecycle,
} from "@norns/contracts";

export type V2LifecycleAggregateKind = "task" | "agent_run";
export type V2LifecycleMismatchCode =
  | "state_without_event"
  | "event_without_state"
  | "state_mismatch"
  | "invalid_event_sequence";

export interface V2TaskLifecycleRow {
  kind: "task";
  id: string;
  project_id: string;
  state: V2TaskStateT;
  lifecycle_version: number;
}

export interface V2AgentRunLifecycleRow {
  kind: "agent_run";
  id: string;
  project_id: string;
  task_id: string;
  state: V2AgentRunStateT;
  lifecycle_version: number;
}

export type V2LifecycleRow = V2TaskLifecycleRow | V2AgentRunLifecycleRow;

export interface V2LifecycleFinding {
  aggregate_kind: V2LifecycleAggregateKind;
  aggregate_id: string;
  project_id: string;
  code: V2LifecycleMismatchCode;
  row_state: string;
  row_lifecycle_version: number;
  folded_state: string;
  folded_lifecycle_version: number;
  rejected_event_ids: string[];
  detected_at: string;
}

export interface V2LifecycleReconciliationRepository {
  listLifecycleRows(): Promise<V2LifecycleRow[]>;
  taskEvents(taskId: string): Promise<V2TaskTransitionEventT[]>;
  agentRunEvents(runId: string): Promise<V2AgentRunTransitionEventT[]>;
  recordFindingAndAudit(finding: V2LifecycleFinding): Promise<void>;
}

export interface V2LifecycleIntegrityGuard {
  hasOpenFinding(aggregateKind: V2LifecycleAggregateKind, aggregateId: string): Promise<boolean>;
}

export class V2AutomationBlockedByIntegrityError extends Error {
  constructor(
    readonly aggregateKind: V2LifecycleAggregateKind,
    readonly aggregateId: string,
  ) {
    super(
      `automated mutation blocked for ${aggregateKind} ${aggregateId}: lifecycle reconciliation finding is open`,
    );
    this.name = "V2AutomationBlockedByIntegrityError";
  }
}

export async function assertV2AutomationAllowed(
  guard: V2LifecycleIntegrityGuard,
  aggregateKind: V2LifecycleAggregateKind,
  aggregateId: string,
): Promise<void> {
  if (await guard.hasOpenFinding(aggregateKind, aggregateId)) {
    throw new V2AutomationBlockedByIntegrityError(aggregateKind, aggregateId);
  }
}

export interface V2LifecycleReconciliationReport {
  checked: number;
  clean: number;
  mismatches: V2LifecycleFinding[];
}

function mismatchCode(input: {
  rowState: string;
  rowVersion: number;
  foldedState: string;
  foldedVersion: number;
  rejected: string[];
}): V2LifecycleMismatchCode | null {
  if (input.rejected.length > 0) return "invalid_event_sequence";
  if (input.rowVersion > input.foldedVersion) return "state_without_event";
  if (input.foldedVersion > input.rowVersion) return "event_without_state";
  if (input.rowState !== input.foldedState) return "state_mismatch";
  return null;
}

/**
 * Fold lifecycle history and compare it with operational rows. A mismatch is
 * persisted through recordFindingAndAudit(), which is also the automation
 * quarantine checked by application commands.
 */
export async function reconcileV2Lifecycles(options: {
  repository: V2LifecycleReconciliationRepository;
  now?: () => Date;
}): Promise<V2LifecycleReconciliationReport> {
  const now = options.now ?? (() => new Date());
  const rows = await options.repository.listLifecycleRows();
  const mismatches: V2LifecycleFinding[] = [];

  for (const row of rows) {
    let foldedState: string;
    let foldedVersion: number;
    let rejectedEventIds: string[];

    if (row.kind === "task") {
      const events = (await options.repository.taskEvents(row.id)).map((event) =>
        V2TaskTransitionEvent.parse(event),
      );
      const folded = reduceV2TaskLifecycle("pending", 0, events);
      foldedState = folded.state;
      foldedVersion = folded.version;
      rejectedEventIds = folded.rejected_event_ids;
    } else {
      const events = (await options.repository.agentRunEvents(row.id)).map((event) =>
        V2AgentRunTransitionEvent.parse(event),
      );
      const folded = reduceV2AgentRunLifecycle("created", 0, events);
      foldedState = folded.state;
      foldedVersion = folded.version;
      rejectedEventIds = folded.rejected_event_ids;
    }

    const code = mismatchCode({
      rowState: row.state,
      rowVersion: row.lifecycle_version,
      foldedState,
      foldedVersion,
      rejected: rejectedEventIds,
    });
    if (code === null) continue;

    const finding: V2LifecycleFinding = {
      aggregate_kind: row.kind,
      aggregate_id: row.id,
      project_id: row.project_id,
      code,
      row_state: row.state,
      row_lifecycle_version: row.lifecycle_version,
      folded_state: foldedState,
      folded_lifecycle_version: foldedVersion,
      rejected_event_ids: rejectedEventIds,
      detected_at: now().toISOString(),
    };
    await options.repository.recordFindingAndAudit(finding);
    mismatches.push(finding);
  }

  return {
    checked: rows.length,
    clean: rows.length - mismatches.length,
    mismatches,
  };
}
