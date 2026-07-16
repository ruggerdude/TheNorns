import { createHash } from "node:crypto";
import {
  V2CreatePhaseCommand,
  type V2CreatePhaseCommandT,
  V2Phase,
  type V2PhaseT,
} from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

interface PhaseRow {
  id: string;
  project_id: string;
  objective_summary: string;
  priority: number;
  status: V2PhaseT["status"];
  approved_strategy_version_id: string | null;
  approved_budget_usd: string | number;
  aggregate_version: number;
  started_at: Date | string | null;
  closed_at: Date | string | null;
  closure_summary: string | null;
  closure_evidence: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

export class PhaseWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseWorkflowConflictError";
  }
}

function stableId(kind: string, parts: readonly string[]): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function mapPhase(row: PhaseRow): V2PhaseT {
  return V2Phase.parse({
    schema_version: 2,
    id: row.id,
    project_id: row.project_id,
    objective_summary: row.objective_summary,
    priority: row.priority,
    status: row.status,
    approved_strategy_version_id: row.approved_strategy_version_id,
    approved_budget_usd: Number(row.approved_budget_usd),
    aggregate_version: row.aggregate_version,
    started_at: row.started_at === null ? null : iso(row.started_at),
    closed_at: row.closed_at === null ? null : iso(row.closed_at),
    closure_summary: row.closure_summary,
    closure_evidence: row.closure_evidence,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

async function readPhase(tx: V2SqlExecutor, phaseId: string): Promise<V2PhaseT> {
  const result = await tx.query<PhaseRow>("SELECT * FROM phases WHERE id = $1", [phaseId]);
  const row = result.rows[0];
  if (!row) throw new Error(`phase ${phaseId} disappeared after creation`);
  return mapPhase(row);
}

export class PhaseWorkflowService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  create(commandInput: V2CreatePhaseCommandT): Promise<V2PhaseT> {
    const command = V2CreatePhaseCommand.parse(commandInput);
    const phaseId = stableId("phase", [
      command.project_id,
      command.actor.actor_type,
      command.actor.actor_id ?? "",
      command.idempotency_key,
    ]);
    return this.transactions.transaction(async (tx) => {
      const replay = await tx.query<{ id: string }>(
        "SELECT id FROM phases WHERE id = $1 FOR UPDATE",
        [phaseId],
      );
      if (replay.rows.length > 0) return readPhase(tx, phaseId);

      const project = await tx.query<{ aggregate_version: number }>(
        "SELECT aggregate_version FROM projects WHERE id = $1 FOR UPDATE",
        [command.project_id],
      );
      const current = project.rows[0];
      if (!current) throw new PhaseWorkflowConflictError(`project ${command.project_id} not found`);
      if (current.aggregate_version !== command.expected_project_version) {
        throw new PhaseWorkflowConflictError(
          `project version mismatch: expected ${command.expected_project_version}, actual ${current.aggregate_version}`,
        );
      }
      const predecessors = [...new Set(command.predecessor_phase_ids)].sort();
      if (predecessors.length > 0) {
        const found = await tx.query<{ id: string }>(
          "SELECT id FROM phases WHERE project_id = $1 AND id = ANY($2::text[])",
          [command.project_id, predecessors],
        );
        if (found.rows.length !== predecessors.length) {
          throw new PhaseWorkflowConflictError(
            "every predecessor phase must belong to the project",
          );
        }
      }
      await tx.query(
        `INSERT INTO phases (
           id, project_id, objective_summary, priority, status, approved_budget_usd
         ) VALUES ($1,$2,$3,$4,'proposed',0)`,
        [phaseId, command.project_id, command.objective_summary, command.priority],
      );
      for (const predecessorId of predecessors) {
        const dependencyId = stableId("phase-dependency", [
          command.project_id,
          predecessorId,
          phaseId,
        ]);
        await tx.query(
          `INSERT INTO phase_dependencies (
             id, project_id, predecessor_phase_id, successor_phase_id
           ) VALUES ($1,$2,$3,$4)`,
          [dependencyId, command.project_id, predecessorId, phaseId],
        );
      }
      const occurredAt = command.issued_at;
      await tx.query(
        `INSERT INTO domain_events (
           event_id, stream_type, stream_id, stream_version, event_type,
           project_id, phase_id, actor_type, actor_id, correlation_id,
           causation_id, occurred_at, payload
         ) VALUES ($1,'phase',$2,1,'phase.created',$3,$2,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          stableId("event", [phaseId, "created"]),
          phaseId,
          command.project_id,
          command.actor.actor_type,
          command.actor.actor_id,
          command.correlation_id,
          command.causation_id,
          occurredAt,
          JSON.stringify({
            objective_summary: command.objective_summary,
            priority: command.priority,
            predecessor_phase_ids: predecessors,
          }),
        ],
      );
      await tx.query(
        `UPDATE projects SET aggregate_version = aggregate_version + 1, updated_at = now()
         WHERE id = $1`,
        [command.project_id],
      );
      return readPhase(tx, phaseId);
    });
  }
}
