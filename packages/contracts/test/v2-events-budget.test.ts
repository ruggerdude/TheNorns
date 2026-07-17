import { describe, expect, it } from "vitest";
import {
  V2AuditEvent,
  V2BudgetReservation,
  V2DomainEvent,
  resolveV2BudgetReservation,
} from "../src/v2/index.js";

const NOW = "2026-07-16T12:00:00.000Z";
const HASH = "a".repeat(64);

describe("V2 domain and audit history", () => {
  it("requires event_type to match the versioned domain payload", () => {
    const event = {
      schema_version: 2,
      event_id: "event-1",
      stream_type: "task",
      stream_id: "task-1",
      stream_version: 2,
      event_type: "task_state_transitioned",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      actor_type: "coordinator",
      actor_id: "coordinator-1",
      correlation_id: "correlation-1",
      causation_id: "command-1",
      occurred_at: NOW,
      payload: {
        kind: "task_state_transitioned",
        task_id: "task-1",
        lifecycle_version: 2,
        from: "assigned",
        to: "in_progress",
        reason: "run scheduled",
      },
    } as const;
    expect(V2DomainEvent.safeParse(event).success).toBe(true);
    expect(V2DomainEvent.safeParse({ ...event, event_type: "task_completed" }).success).toBe(false);
    expect(V2DomainEvent.safeParse({ ...event, stream_id: "task-2" }).success).toBe(false);
    expect(
      V2DomainEvent.safeParse({
        ...event,
        payload: { ...event.payload, from: "pending", to: "completed" },
      }).success,
    ).toBe(false);
  });

  it("binds every payload kind to its authoritative stream and entity identities", () => {
    const cases = [
      {
        stream_type: "task",
        stream_id: "task-1",
        phase_id: "phase-1",
        task_id: "task-1",
        payload: {
          kind: "task_state_transitioned",
          task_id: "task-1",
          lifecycle_version: 1,
          from: "assigned",
          to: "in_progress",
          reason: null,
        },
      },
      {
        stream_type: "agent_run",
        stream_id: "run-1",
        phase_id: "phase-1",
        task_id: "task-1",
        payload: {
          kind: "agent_run_state_transitioned",
          run_id: "run-1",
          task_id: "task-1",
          lifecycle_version: 1,
          from: "created",
          to: "dispatched",
          reason: null,
        },
      },
      {
        stream_type: "strategy_version",
        stream_id: "strategy-1",
        phase_id: "phase-1",
        task_id: null,
        payload: {
          kind: "strategy_version_approved",
          strategy_version_id: "strategy-1",
          content_hash: HASH,
          materialized_objective_ids: ["objective-1"],
          materialized_task_ids: ["task-1"],
        },
      },
      {
        stream_type: "agent_assignment",
        stream_id: "assignment-1",
        phase_id: "phase-1",
        task_id: "task-1",
        payload: {
          kind: "agent_assignment_created",
          assignment_id: "assignment-1",
          task_id: "task-1",
          agent_profile_id: "agent-1",
          rationale: "Capability match",
        },
      },
      {
        stream_type: "decision_point",
        stream_id: "decision-point-1",
        phase_id: null,
        task_id: null,
        payload: {
          kind: "decision_point_opened",
          decision_point_id: "decision-point-1",
          condition_key: "condition-1",
          condition_fingerprint: HASH,
        },
      },
      {
        stream_type: "decision_point",
        stream_id: "decision-point-1",
        phase_id: null,
        task_id: null,
        payload: {
          kind: "decision_point_resolved",
          decision_point_id: "decision-point-1",
          decision_record_id: "decision-record-1",
          selected_option_id: "option-1",
        },
      },
      {
        stream_type: "budget_reservation",
        stream_id: "reservation-1",
        phase_id: "phase-1",
        task_id: "task-1",
        payload: {
          kind: "budget_reservation_resolved",
          reservation_id: "reservation-1",
          task_id: "task-1",
          run_id: "run-1",
          outcome: "success",
          settled_usd: 5,
          released_usd: 5,
          retained_usd: 0,
        },
      },
      {
        stream_type: "dispatch_job",
        stream_id: "dispatch-job-1",
        phase_id: "phase-1",
        task_id: "task-1",
        payload: {
          kind: "dispatch_command_created",
          dispatch_job_id: "dispatch-job-1",
          command_id: "command-1",
          task_id: "task-1",
          run_id: "run-1",
          budget_reservation_id: "reservation-1",
        },
      },
    ] as const;

    for (const [index, candidate] of cases.entries()) {
      const event = {
        schema_version: 2,
        event_id: `event-${index}`,
        stream_type: candidate.stream_type,
        stream_id: candidate.stream_id,
        stream_version: 1,
        event_type: candidate.payload.kind,
        project_id: "project-1",
        phase_id: candidate.phase_id,
        task_id: candidate.task_id,
        actor_type: "coordinator",
        actor_id: "coordinator-1",
        correlation_id: "correlation-1",
        causation_id: "command-1",
        occurred_at: NOW,
        payload: candidate.payload,
      };
      expect(V2DomainEvent.safeParse(event).success, candidate.payload.kind).toBe(true);
      expect(
        V2DomainEvent.safeParse({ ...event, stream_id: `wrong-${candidate.stream_id}` }).success,
        `${candidate.payload.kind} mismatched stream`,
      ).toBe(false);
      expect(
        V2DomainEvent.safeParse({ ...event, stream_type: "project" }).success,
        `${candidate.payload.kind} wrong stream type`,
      ).toBe(false);
      if (candidate.task_id !== null) {
        expect(
          V2DomainEvent.safeParse({ ...event, task_id: "wrong-task" }).success,
          `${candidate.payload.kind} wrong task identity`,
        ).toBe(false);
      }
    }
  });

  it("requires attributable human actors and supports separate audit observations", () => {
    const audit = {
      schema_version: 2,
      audit_id: "audit-1",
      audit_type: "strategy_approval_attempted",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: null,
      actor_type: "human",
      actor_id: "user-1",
      outcome: "denied",
      severity: "warning",
      correlation_id: "correlation-1",
      causation_id: "command-1",
      occurred_at: NOW,
      targets: [{ entity_type: "strategy_version", entity_id: "strategy-1" }],
      summary: "Non-converged strategy approval rejected",
      details: { content_hash: HASH },
      redaction_applied: true,
    } as const;
    expect(V2AuditEvent.safeParse(audit).success).toBe(true);
    expect(V2AuditEvent.safeParse({ ...audit, actor_id: null }).success).toBe(false);
  });

  it("records legacy import provenance without fabricating a human actor", () => {
    const event = {
      schema_version: 2,
      event_id: "event-import-1",
      stream_type: "migration",
      stream_id: "migration-batch-1",
      stream_version: 1,
      event_type: "legacy_entity_imported",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      actor_type: "legacy",
      actor_id: null,
      correlation_id: "migration-run-1",
      causation_id: null,
      occurred_at: NOW,
      payload: {
        kind: "legacy_entity_imported",
        migration_run_id: "migration-run-1",
        import_batch_id: "migration-batch-1",
        legacy_entity_type: "graph_node",
        legacy_entity_id: "legacy-task-1",
        v2_entity_type: "task",
        v2_entity_id: "task-1",
        source_hash: HASH,
      },
    } as const;

    expect(V2DomainEvent.safeParse(event).success).toBe(true);
    expect(V2DomainEvent.safeParse({ ...event, actor_type: "system" }).success).toBe(false);
    expect(
      V2DomainEvent.safeParse({
        ...event,
        payload: { ...event.payload, import_batch_id: "other-batch" },
      }).success,
    ).toBe(false);
  });
});

describe("V2 budget reservation terminal outcomes", () => {
  it("accepts a newly active reservation with zero terminal accounting", () => {
    const active = {
      schema_version: 2,
      id: "reservation-active",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      amount_usd: 100,
      settled_usd: 0,
      released_usd: 0,
      retained_usd: 0,
      status: "active",
      version: 1,
      created_at: NOW,
      updated_at: NOW,
      expires_at: "2026-07-16T13:00:00.000Z",
    } as const;
    expect(V2BudgetReservation.safeParse(active).success).toBe(true);
    expect(V2BudgetReservation.safeParse({ ...active, retained_usd: 100 }).success).toBe(false);
  });

  it("requires terminal and ambiguous reservation rows to account for the full amount", () => {
    const base = {
      schema_version: 2,
      id: "reservation-terminal",
      project_id: "project-1",
      phase_id: "phase-1",
      task_id: "task-1",
      run_id: "run-1",
      amount_usd: 100,
      version: 2,
      created_at: NOW,
      updated_at: NOW,
      expires_at: "2026-07-16T13:00:00.000Z",
    } as const;
    expect(
      V2BudgetReservation.safeParse({
        ...base,
        status: "settled",
        settled_usd: 40,
        released_usd: 60,
        retained_usd: 0,
      }).success,
    ).toBe(true);
    expect(
      V2BudgetReservation.safeParse({
        ...base,
        status: "released",
        settled_usd: 0,
        released_usd: 100,
        retained_usd: 0,
      }).success,
    ).toBe(true);
    expect(
      V2BudgetReservation.safeParse({
        ...base,
        status: "retained_ambiguous",
        settled_usd: 0,
        released_usd: 0,
        retained_usd: 100,
      }).success,
    ).toBe(true);
    expect(
      V2BudgetReservation.safeParse({
        ...base,
        status: "retained_ambiguous",
        settled_usd: 0,
        released_usd: 0,
        retained_usd: 90,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["success", 60, "settled", 60, 40, 0],
    ["partial_usage", 25, "settled", 25, 75, 0],
    ["cancelled", 0, "released", 0, 100, 0],
    ["expired", 0, "released", 0, 100, 0],
    ["rejected", 0, "released", 0, 100, 0],
    ["dead_letter", 0, "released", 0, 100, 0],
    ["ambiguous_execution", 0, "retained_ambiguous", 0, 0, 100],
  ] as const)(
    "resolves %s without leaking reservation value",
    (outcome, usage, status, settled, released, retained) => {
      const result = resolveV2BudgetReservation(100, {
        outcome,
        attributable_usage_usd: usage,
        reason: "terminal outcome",
      });
      expect(result).toEqual({
        status,
        settled_usd: settled,
        released_usd: released,
        retained_usd: retained,
      });
      expect(result.settled_usd + result.released_usd + result.retained_usd).toBe(100);
    },
  );

  it("rejects impossible usage and validates accounting in the persisted record", () => {
    expect(() =>
      resolveV2BudgetReservation(10, {
        outcome: "success",
        attributable_usage_usd: 11,
        reason: "too much",
      }),
    ).toThrow("cannot exceed");
    expect(() =>
      resolveV2BudgetReservation(10, {
        outcome: "dead_letter",
        attributable_usage_usd: 1,
        reason: "should not settle",
      }),
    ).toThrow("cannot settle usage");
    expect(() =>
      resolveV2BudgetReservation(10, {
        outcome: "ambiguous_execution",
        attributable_usage_usd: 1,
        reason: "unknown",
      }),
    ).toThrow("retains the full reservation");

    expect(
      V2BudgetReservation.safeParse({
        schema_version: 2,
        id: "reservation-1",
        project_id: "project-1",
        phase_id: "phase-1",
        task_id: "task-1",
        run_id: "run-1",
        amount_usd: 100,
        settled_usd: 10,
        released_usd: 20,
        retained_usd: 0,
        status: "settled",
        version: 1,
        created_at: NOW,
        updated_at: NOW,
        expires_at: "2026-07-16T13:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
