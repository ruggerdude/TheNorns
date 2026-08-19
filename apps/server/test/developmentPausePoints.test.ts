import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { ConversationHumanSteeringService } from "../src/conversations/humanSteering.js";
import { SCHEDULABLE_TASKS_SQL } from "../src/coordinator/phaseConcurrency.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../src/persistence/v2/database.js";

describe("development pause points", () => {
  it("persists an attributed set of conversation-scoped pause points", async () => {
    const updates: unknown[][] = [];
    const query = vi.fn(async <TRow>(sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users identity")) {
        return {
          rows: [
            {
              user_id: "user-1",
              user_status: "active",
              identity_role: "member",
              project_id: "project-1",
              owner_user_id: "user-1",
              active_member: false,
            },
          ] as TRow[],
        };
      }
      if (sql.includes("FROM work_conversations conversation")) {
        return { rows: [{ phase_id: "phase-1" }] as TRow[] };
      }
      if (sql.includes("JOIN tasks task ON task.id=pause_point.task_id")) {
        return {
          rows: [
            {
              task_id: "task-2",
              state: "in_progress",
              pause_after_completion: false,
            },
          ] as TRow[],
        };
      }
      if (sql.includes("UPDATE conversation_development_pause_points")) {
        updates.push(params ?? []);
        return { rows: [] as TRow[] };
      }
      if (sql.includes("INSERT INTO audit_events")) return { rows: [] as TRow[] };
      if (sql.includes("SELECT task_id,phase_position,pause_after_completion")) {
        return {
          rows: [
            { task_id: "task-1", phase_position: 1, pause_after_completion: false },
            { task_id: "task-2", phase_position: 2, pause_after_completion: true },
          ] as TRow[],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const executor = { query } as V2SqlExecutor;
    const transactions: V2TransactionRunner = {
      transaction: (work) => work(executor),
    };
    const steering = new ConversationHumanSteeringService(transactions, {
      newId: (prefix) => `${prefix}-pause-points`,
    });

    await expect(
      steering.configureDevelopmentPausePoints(
        "user-1",
        { projectId: "project-1", workItemId: "work-1", conversationId: "conversation-1" },
        { task_ids: ["task-2", "task-2"], pause_after_completion: true },
      ),
    ).resolves.toEqual({
      phase_id: "phase-1",
      pause_points: [
        { task_id: "task-1", phase_position: 1, pause_after_completion: false },
        { task_id: "task-2", phase_position: 2, pause_after_completion: true },
      ],
    });
    expect(updates).toEqual([
      ["project-1", "work-1", "conversation-1", "phase-1", true, "user-1", ["task-2"]],
    ]);
  });

  it("never dispatches beyond the earliest selected phase boundary", async () => {
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,project_id TEXT,phase_id TEXT,title TEXT,state TEXT,
        designated_assignment_id TEXT,created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE agent_assignments (id TEXT PRIMARY KEY,budget_limit_usd NUMERIC);
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,task_id TEXT,is_designated BOOLEAN,superseded_at TIMESTAMPTZ,state TEXT
      );
      CREATE TABLE task_dependencies (predecessor_task_id TEXT,successor_task_id TEXT);
      CREATE TABLE conversation_development_pause_points (
        task_id TEXT PRIMARY KEY,phase_id TEXT,phase_position INTEGER,pause_after_completion BOOLEAN
      );
      INSERT INTO agent_assignments VALUES ('a1',1),('a2',1),('a3',1);
      INSERT INTO tasks (id,project_id,phase_id,title,state,designated_assignment_id,created_at)
      VALUES
        ('t1','p','phase','One','ready','a1','2026-01-01T00:00:01Z'),
        ('t2','p','phase','Two','ready','a2','2026-01-01T00:00:02Z'),
        ('t3','p','phase','Three','ready','a3','2026-01-01T00:00:03Z');
      INSERT INTO conversation_development_pause_points
      VALUES ('t1','phase',1,false),('t2','phase',2,true),('t3','phase',3,false);
    `);

    const beforePause = await pg.query<{ task_id: string }>(SCHEDULABLE_TASKS_SQL, ["p", "phase"]);
    expect(beforePause.rows.map((row) => row.task_id)).toEqual(["t1", "t2"]);

    await pg.exec("UPDATE tasks SET state='completed' WHERE id IN ('t1','t2')");
    const paused = await pg.query<{ task_id: string }>(SCHEDULABLE_TASKS_SQL, ["p", "phase"]);
    expect(paused.rows).toEqual([]);

    await pg.exec(
      "UPDATE conversation_development_pause_points SET pause_after_completion=false WHERE task_id='t2'",
    );
    const resumed = await pg.query<{ task_id: string }>(SCHEDULABLE_TASKS_SQL, ["p", "phase"]);
    expect(resumed.rows.map((row) => row.task_id)).toEqual(["t3"]);
  });
});
