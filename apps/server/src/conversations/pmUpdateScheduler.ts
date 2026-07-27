import { canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

export interface ConversationPmUpdateEvaluation {
  conversation_id: string;
  state_hash: string;
  emitted: boolean;
  transition_sequence: number | null;
  message_id: string | null;
  next_due_at: string;
}

interface DueConversation {
  conversation_id: string;
  project_id: string;
  work_item_id: string;
  initiated_by_user_id: string;
  next_message_sequence: string | number;
  work_status: string;
  update_interval_seconds: string | number;
  content_level: "concise" | "standard" | "detailed";
  db_now: Date | string;
}

/**
 * Periodic PM updates are a projection of durable project state. This worker
 * deliberately has no model/gateway dependency. The cursor advances on both
 * emitted and suppressed evaluations, preventing unchanged state from
 * spinning every scheduler tick.
 */
export class ConversationPmUpdateScheduler {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async scan(limit = 100, asOf?: string): Promise<ConversationPmUpdateEvaluation[]> {
    const evaluations: ConversationPmUpdateEvaluation[] = [];
    for (let index = 0; index < limit; index += 1) {
      const evaluation = await this.tick(asOf);
      if (!evaluation) break;
      evaluations.push(evaluation);
    }
    return evaluations;
  }

  async tick(asOf?: string): Promise<ConversationPmUpdateEvaluation | null> {
    return this.transactions.transaction(async (tx) => {
      const due = (
        await tx.query<DueConversation>(
          `SELECT conversation.id AS conversation_id,conversation.project_id,
                  conversation.work_item_id,conversation.created_by_user_id
                    AS initiated_by_user_id,
                  conversation.next_message_sequence,item.status AS work_status,
                  COALESCE(project_setting.update_interval_seconds,
                           global_setting.update_interval_seconds)
                    AS update_interval_seconds,
                  COALESCE(project_setting.content_level,global_setting.content_level)
                    AS content_level,
                  COALESCE($1::timestamptz,statement_timestamp()) AS db_now
             FROM work_conversations conversation
             JOIN work_items item
               ON item.project_id=conversation.project_id
              AND item.id=conversation.work_item_id
             JOIN conversation_pm_update_global_settings global_setting
               ON global_setting.singleton=true
             LEFT JOIN conversation_pm_update_project_settings project_setting
               ON project_setting.project_id=conversation.project_id
             LEFT JOIN conversation_pm_update_cursors cursor
               ON cursor.conversation_id=conversation.id
            WHERE conversation.kind='execution_pm' AND conversation.status='active'
              AND item.status IN ('executing','blocked','completed')
              AND COALESCE(
                    cursor.next_due_at,
                    conversation.created_at
                      + (COALESCE(project_setting.update_interval_seconds,
                                  global_setting.update_interval_seconds)::text
                         || ' seconds')::interval
                  )<=COALESCE($1::timestamptz,statement_timestamp())
            ORDER BY COALESCE(cursor.next_due_at,conversation.created_at),conversation.id
            FOR UPDATE OF conversation SKIP LOCKED
            LIMIT 1`,
          [asOf ?? null],
        )
      ).rows[0];
      if (!due) return null;
      const now = new Date(due.db_now);
      const interval = Number(due.update_interval_seconds);
      const nextDueAt = new Date(now.getTime() + interval * 1_000).toISOString();
      await tx.query(
        `INSERT INTO conversation_pm_update_cursors (
           conversation_id,project_id,work_item_id,next_due_at
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT(conversation_id) DO NOTHING`,
        [due.conversation_id, due.project_id, due.work_item_id, now.toISOString()],
      );
      const cursor = (
        await tx.query<{
          next_due_at: Date | string;
          last_state_hash: string | null;
          evaluation_count: string | number;
          transition_count: string | number;
        }>(
          `SELECT next_due_at,last_state_hash,evaluation_count,transition_count
             FROM conversation_pm_update_cursors
            WHERE conversation_id=$1 FOR UPDATE`,
          [due.conversation_id],
        )
      ).rows[0];
      if (!cursor || new Date(cursor.next_due_at).getTime() > now.getTime()) return null;

      const state = (
        await tx.query<{
          total_tasks: string | number;
          completed_tasks: string | number;
          active_tasks: string | number;
          blocked_tasks: string | number;
          open_waits: string | number;
        }>(
          `SELECT
             count(DISTINCT binding.task_id) AS total_tasks,
             count(DISTINCT binding.task_id) FILTER (WHERE task.state='completed')
               AS completed_tasks,
             count(DISTINCT binding.task_id) FILTER (
               WHERE task.state IN ('assigned','in_progress','verifying','in_review')
             ) AS active_tasks,
             count(DISTINCT binding.task_id) FILTER (WHERE task.state='blocked')
               AS blocked_tasks,
             count(DISTINCT wait.id) FILTER (WHERE wait.status='awaiting_human')
               AS open_waits
           FROM (SELECT 1) singleton
           LEFT JOIN conversation_task_package_bindings binding
             ON binding.conversation_id=$1
           LEFT JOIN tasks task ON task.id=binding.task_id
           LEFT JOIN human_waits wait ON wait.conversation_id=$1`,
          [due.conversation_id],
        )
      ).rows[0];
      if (!state) throw new Error(`PM update state projection failed for ${due.conversation_id}`);
      const snapshot = {
        work_status: due.work_status,
        content_level: due.content_level,
        total_tasks: Number(state.total_tasks),
        completed_tasks: Number(state.completed_tasks),
        active_tasks: Number(state.active_tasks),
        blocked_tasks: Number(state.blocked_tasks),
        open_waits: Number(state.open_waits),
      };
      const stateHash = canonicalSha256(snapshot);
      const suppressed = cursor.last_state_hash === stateHash;
      const previousEvaluationCount = Number(cursor.evaluation_count);
      const previousTransitionCount = Number(cursor.transition_count);
      const evaluationCount = previousEvaluationCount + 1;
      const transitionSequence = suppressed ? null : previousTransitionCount + 1;
      const transitionCount = transitionSequence ?? previousTransitionCount;
      const advanceCursor = async () => {
        const advanced = await tx.query<{ conversation_id: string }>(
          `UPDATE conversation_pm_update_cursors
            SET last_evaluated_at=$2,next_due_at=$3,last_state_hash=$4,
                evaluation_count=$5,transition_count=$6,updated_at=now()
          WHERE conversation_id=$1
            AND evaluation_count=$7 AND transition_count=$8
        RETURNING conversation_id`,
          [
            due.conversation_id,
            now.toISOString(),
            nextDueAt,
            stateHash,
            evaluationCount,
            transitionCount,
            previousEvaluationCount,
            previousTransitionCount,
          ],
        );
        if (!advanced.rows[0]) {
          throw new Error(`PM update cursor changed concurrently for ${due.conversation_id}`);
        }
      };
      if (suppressed) {
        await advanceCursor();
        return {
          conversation_id: due.conversation_id,
          state_hash: stateHash,
          emitted: false,
          transition_sequence: null,
          message_id: null,
          next_due_at: nextDueAt,
        };
      }
      const status =
        due.work_status === "completed"
          ? "completed"
          : snapshot.open_waits > 0
            ? "waiting_for_human"
            : due.work_status === "blocked" || snapshot.blocked_tasks > 0
              ? "blocked"
              : "working";
      const content = this.render(status, snapshot, due.content_level);
      if (transitionSequence === null) {
        throw new Error(
          `PM update transition sequence was not assigned for ${due.conversation_id}`,
        );
      }
      const updateId = `conversation-pm-update:${due.conversation_id}:${transitionSequence}`;
      const messageId = `message:${updateId}`;
      await tx.query(
        `INSERT INTO work_messages (
           id,project_id,work_item_id,conversation_id,initiated_by_user_id,
           actor_type,actor_id,role,visibility_status,sequence,parts
         ) VALUES (
           $1,$2,$3,$4,$5,'coordinator','deterministic-pm-update','assistant',
           'complete',$6,$7::jsonb
         )`,
        [
          messageId,
          due.project_id,
          due.work_item_id,
          due.conversation_id,
          due.initiated_by_user_id,
          Number(due.next_message_sequence),
          JSON.stringify([{ type: "text", format: "markdown", text: content }]),
        ],
      );
      await tx.query(
        `INSERT INTO conversation_pm_updates (
           id,project_id,work_item_id,conversation_id,message_id,transition_sequence,
           state_hash,status,content
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          updateId,
          due.project_id,
          due.work_item_id,
          due.conversation_id,
          messageId,
          transitionSequence,
          stateHash,
          status,
          content,
        ],
      );
      await tx.query(
        `UPDATE work_conversations
            SET next_message_sequence=next_message_sequence+1,updated_at=now()
          WHERE id=$1`,
        [due.conversation_id],
      );
      await advanceCursor();
      return {
        conversation_id: due.conversation_id,
        state_hash: stateHash,
        emitted: true,
        transition_sequence: transitionSequence,
        message_id: messageId,
        next_due_at: nextDueAt,
      };
    });
  }

  private render(
    status: "working" | "waiting_for_human" | "blocked" | "completed",
    state: {
      total_tasks: number;
      completed_tasks: number;
      active_tasks: number;
      blocked_tasks: number;
      open_waits: number;
    },
    level: "concise" | "standard" | "detailed",
  ): string {
    const lead = {
      working: "Work is in progress.",
      waiting_for_human: "Work is waiting for your decision.",
      blocked: "Work is currently blocked.",
      completed: "Work is complete.",
    }[status];
    const progress = `${state.completed_tasks} of ${state.total_tasks} tasks are complete.`;
    if (level === "concise") return `${lead} ${progress}`;
    const attention =
      state.open_waits > 0
        ? ` ${state.open_waits} decision${state.open_waits === 1 ? "" : "s"} need your attention.`
        : state.blocked_tasks > 0
          ? ` ${state.blocked_tasks} task${state.blocked_tasks === 1 ? " is" : "s are"} blocked.`
          : "";
    if (level === "standard") return `${lead} ${progress}${attention}`;
    return `${lead} ${progress} ${state.active_tasks} active, ${state.blocked_tasks} blocked, and ${state.open_waits} waiting for a human decision.`;
  }
}
