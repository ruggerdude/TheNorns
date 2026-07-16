import { createHash } from "node:crypto";
import {
  V2StrategyVersion,
  type V2StrategyVersionT,
  canonicalizeV2StrategyImmutableContent,
  fingerprintV2StrategyImmutableContent,
} from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export class StrategyWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyWorkflowConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class StrategyWorkflowService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async saveAwaitingApproval(input: V2StrategyVersionT): Promise<V2StrategyVersionT> {
    const strategy = V2StrategyVersion.parse(input);
    if (strategy.status !== "awaiting_approval" || strategy.approval !== null) {
      throw new StrategyWorkflowConflictError(
        "a retained approval candidate must be awaiting_approval with no approval evidence",
      );
    }
    const computed = fingerprintV2StrategyImmutableContent(strategy, sha256);
    if (computed !== strategy.content_hash) {
      throw new StrategyWorkflowConflictError(
        "strategy content hash does not match immutable content",
      );
    }
    const content = canonicalizeV2StrategyImmutableContent(strategy);
    return this.transactions.transaction(async (tx) => {
      const replay = await tx.query<{ content_hash: string; content: unknown }>(
        "SELECT content_hash, content FROM strategy_versions WHERE id = $1 FOR UPDATE",
        [strategy.id],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.content_hash !== computed) {
          throw new StrategyWorkflowConflictError(
            `strategy identity ${strategy.id} already contains different immutable content`,
          );
        }
        return strategy;
      }
      const phase = await tx.query<{
        status: string;
        approved_strategy_version_id: string | null;
      }>(
        "SELECT status, approved_strategy_version_id FROM phases WHERE id = $1 AND project_id = $2 FOR UPDATE",
        [strategy.phase_id, strategy.project_id],
      );
      const currentPhase = phase.rows[0];
      if (
        !currentPhase ||
        currentPhase.status === "completed" ||
        currentPhase.status === "cancelled"
      ) {
        throw new StrategyWorkflowConflictError("strategy phase is unavailable for planning");
      }
      const latest = await tx.query<{ id: string; version: number }>(
        `SELECT id, version FROM strategy_versions
         WHERE project_id = $1 AND phase_id = $2 ORDER BY version DESC LIMIT 1`,
        [strategy.project_id, strategy.phase_id],
      );
      const previous = latest.rows[0];
      if (strategy.version !== (previous?.version ?? 0) + 1) {
        throw new StrategyWorkflowConflictError(
          "strategy version must follow the retained phase history",
        );
      }
      if ((strategy.supersedes_strategy_version_id ?? null) !== (previous?.id ?? null)) {
        throw new StrategyWorkflowConflictError(
          "strategy supersession must reference the latest version",
        );
      }
      await tx.query(
        `INSERT INTO strategy_versions (
           id, project_id, phase_id, version, aggregate_version, status,
           objective, content, convergence, review_rounds, content_hash,
           approval_id, supersedes_strategy_version_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,NULL,$12,$13,$14)`,
        [
          strategy.id,
          strategy.project_id,
          strategy.phase_id,
          strategy.version,
          strategy.aggregate_version,
          strategy.status,
          strategy.objective,
          content,
          strategy.convergence,
          strategy.review_rounds,
          computed,
          strategy.supersedes_strategy_version_id,
          strategy.created_at,
          strategy.updated_at,
        ],
      );
      if (previous) {
        await tx.query(
          `UPDATE strategy_versions SET status = 'superseded', updated_at = now()
           WHERE id = $1 AND status <> 'approved'`,
          [previous.id],
        );
      }
      await tx.query(
        `UPDATE phases SET status = 'awaiting_approval', aggregate_version = aggregate_version + 1,
                           updated_at = now()
         WHERE id = $1`,
        [strategy.phase_id],
      );
      return strategy;
    });
  }
}
