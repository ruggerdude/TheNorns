import {
  type CommandEnvelopeT,
  EventEnvelope,
  type EventEnvelopeT,
  PROTOCOL_VERSION,
  v2CommandIdForDispatchJob,
} from "@norns/contracts";
import type {
  PostgresDeviceActionAuthorization,
  RunnerAuthorizationIdentity,
} from "../devices/actionAuthorization.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { transitionV2TaskLifecycle } from "../persistence/v2/lifecycleMutation.js";
import { SqlV2ApplicationTransaction } from "../persistence/v2/sqlRepositories.js";

export interface ConversationActionLiveTarget {
  runner_id: string;
  generation: number;
}

export interface ConversationActionLiveTransport {
  resolveTarget(candidate: {
    action_id: string;
    run_id: string;
    runner_id: string;
    runner_generation: number;
  }): Promise<ConversationActionLiveTarget | null>;
  enqueue(command: CommandEnvelopeT): Promise<boolean | undefined> | boolean | undefined;
  notify(runnerId: string): Promise<boolean> | boolean;
  cancel?(commandId: string): Promise<void> | void;
}

export interface ConversationActionDeliveryResult {
  action_id: string;
  intent_id: string;
  status: "sent" | "fallback_queued" | "failed";
  command_id: string | null;
}

interface ClaimedDelivery {
  intent_id: string;
  project_id: string;
  action_id: string;
  action_type: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  phase_id: string | null;
  target_run_id: string | null;
  payload: unknown;
  runner_id: string | null;
  runner_generation: number;
  run_state: string;
  confirmed_at: Date | string;
}

/**
 * Durable delivery for confirmed task direction.
 *
 * The relay outbox is populated with a stable command ID before `sent` is
 * recorded. A disconnected/unsupported target stays on the same action and is
 * marked `fallback_queued`; it is then included in the next checkpoint or
 * human-wait continuation package.
 */
export class ConversationActionDeliveryWorker {
  private readonly workerId: string;
  private readonly deviceAuthorization: PostgresDeviceActionAuthorization | undefined;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly transport: ConversationActionLiveTransport,
    options: {
      workerId?: string;
      deviceAuthorization?: PostgresDeviceActionAuthorization;
    } = {},
  ) {
    this.workerId = options.workerId ?? `conversation-action:${process.pid}`;
    this.deviceAuthorization = options.deviceAuthorization;
  }

  async tick(): Promise<ConversationActionDeliveryResult | null> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_action_delivery_intents
            SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now(),last_error='recovered_expired_lease',updated_at=now()
          WHERE status='leased' AND lease_expires_at<=now()`,
      );
    });
    const claimed = await this.claim();
    if (!claimed) return null;
    if (
      claimed.run_state !== "running" ||
      claimed.runner_id === null ||
      claimed.target_run_id === null ||
      claimed.target_run_id.length === 0
    ) {
      return this.fallback(claimed, "target_not_live");
    }
    const target = await this.transport.resolveTarget({
      action_id: claimed.action_id,
      run_id: claimed.target_run_id,
      runner_id: claimed.runner_id,
      runner_generation: claimed.runner_generation,
    });
    if (!target) return this.fallback(claimed, "target_unavailable");

    const parameters = (claimed.payload as { parameters?: { direction?: unknown } } | null)
      ?.parameters;
    if (
      claimed.action_type === "redirect_agent" &&
      (typeof parameters?.direction !== "string" || parameters.direction.trim() === "")
    ) {
      return this.fail(claimed, "invalid_direction_payload");
    }
    const commandId = `conversation-action-command:${claimed.action_id}`;
    const issuedAt = new Date(claimed.confirmed_at);
    const envelope: CommandEnvelopeT = {
      protocol: PROTOCOL_VERSION,
      command_id: commandId,
      idempotency_key: commandId,
      correlation_id: claimed.action_id,
      causation_id: claimed.action_id,
      project_id: claimed.project_id,
      runner_id: target.runner_id,
      generation: target.generation,
      issued_by_session: "conversation-steering",
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
      payload:
        claimed.action_type === "pause_work"
          ? { kind: "suspend", run_id: claimed.target_run_id }
          : {
              kind: "send_message",
              run_id: claimed.target_run_id,
              message: parameters?.direction as string,
            },
    };
    const targeted = await this.transactions.transaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET target_command_id=$3,target_runner_generation=$4,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2
          RETURNING id`,
        [claimed.intent_id, this.workerId, commandId, target.generation],
      );
      return Boolean(updated.rows[0]);
    });
    if (!targeted) return null;
    const bufferedAck = await this.hasBufferedAck(commandId);
    try {
      // Relay persistence is the outbox. This is intentionally before the SQL
      // `sent` receipt; replay uses the same command ID and is idempotent.
      if (!bufferedAck) {
        const activeOutbox = await this.transport.enqueue(envelope);
        if (activeOutbox === false) {
          await this.transport.cancel?.(commandId);
          return this.fallback(claimed, "relay_command_not_active");
        }
        const delivered = await this.transport.notify(target.runner_id);
        if (!delivered) {
          await this.transport.cancel?.(commandId);
          return this.fallback(claimed, "runner_disconnected_before_send");
        }
      }
    } catch {
      await this.transport.cancel?.(commandId);
      return this.fallback(claimed, "relay_outbox_unavailable");
    }
    const sent = await this.transactions.transaction(async (tx) => {
      const intent = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='sent',lease_owner=NULL,
                lease_expires_at=NULL,last_error=NULL,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2
          RETURNING id`,
        [claimed.intent_id, this.workerId],
      );
      if (!intent.rows[0]) return false;
      const action = await tx.query<{ id: string }>(
        `UPDATE conversation_actions
            SET status='sent',sent_at=now(),updated_at=now()
          WHERE id=$1 AND status='recorded'
          RETURNING id`,
        [claimed.action_id],
      );
      if (!action.rows[0]) throw new Error("delivery action left recorded state while leased");
      await tx.query(
        `INSERT INTO conversation_action_delivery_events (
           id,project_id,work_item_id,conversation_id,action_id,sequence,status,
           delivery_mode,target_run_id,target_command_id,receipt
         )
         SELECT $2::text,project_id,work_item_id,conversation_id,id,3,'sent','live',
                $3::text,$4::text,
                jsonb_build_object('kind','sent','outbox_id',$4::text)
           FROM conversation_actions WHERE id=$1
         ON CONFLICT(action_id,sequence) DO NOTHING`,
        [
          claimed.action_id,
          `action-delivery-event:${claimed.action_id}:3`,
          claimed.target_run_id,
          commandId,
        ],
      );
      return true;
    });
    if (!sent) return null;
    await this.replayBufferedAck(commandId);
    return {
      action_id: claimed.action_id,
      intent_id: claimed.intent_id,
      status: "sent",
      command_id: commandId,
    };
  }

  async applyCommandAck(
    event: EventEnvelopeT,
    authenticatedIdentity?: RunnerAuthorizationIdentity,
  ): Promise<boolean> {
    if (event.payload.kind !== "command_ack") return false;
    if (this.deviceAuthorization && !authenticatedIdentity) {
      throw new Error("authenticated transport identity is required for action acknowledgement");
    }
    const authorizationIdentity: RunnerAuthorizationIdentity = authenticatedIdentity ?? {
      subject: "legacy_runner",
      runner_id: event.runner_id,
      generation: event.generation,
    };
    if (
      authorizationIdentity.runner_id !== event.runner_id ||
      authorizationIdentity.generation !== event.generation
    ) {
      throw new Error("authenticated transport identity does not match action acknowledgement");
    }
    const ack = event.payload;
    const state = ack.state;
    const eventId = `runner-event:${event.runner_id}:${event.generation}:${event.event_seq}`;
    if (
      ![
        "accepted",
        "executing",
        "succeeded",
        "failed",
        "rejected",
        "expired",
        "cancelled",
      ].includes(state)
    ) {
      return false;
    }
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          action_id: string;
          project_id: string;
          work_item_id: string;
          conversation_id: string;
          target_run_id: string;
          target_command_id: string;
          target_runner_generation: number;
          status: string;
          runner_id: string;
          action_status: string;
          action_type: string;
          initiated_by_user_id: string;
          phase_id: string;
          payload: unknown;
        }>(
          `SELECT intent.id,intent.action_id,intent.project_id,intent.work_item_id,
                  intent.conversation_id,intent.target_run_id,intent.target_command_id,
                  intent.target_runner_generation,intent.status,run.runner_id,
                  action.status AS action_status,action.action_type,
                  action.initiated_by_user_id,item.phase_id,action.payload
             FROM conversation_action_delivery_intents intent
             JOIN agent_runs run ON run.id=intent.target_run_id
             JOIN conversation_actions action ON action.id=intent.action_id
            JOIN work_items item ON item.id=action.work_item_id
            WHERE intent.target_command_id=$1
              AND action.id=$2
              AND (
                intent.status='leased'
                OR EXISTS (
                  SELECT 1
                    FROM conversation_action_delivery_events delivery
                   WHERE delivery.action_id=intent.action_id
                     AND delivery.target_command_id=intent.target_command_id
                     AND delivery.status='sent'
                     AND delivery.delivery_mode='live'
                )
              )
            FOR UPDATE OF intent,action`,
          [ack.command_id, event.correlation_id],
        )
      ).rows[0];
      if (!row) return false;
      if (
        row.runner_id !== event.runner_id ||
        row.target_runner_generation !== event.generation ||
        event.correlation_id !== row.action_id ||
        event.causation_id !== row.target_command_id
      ) {
        throw new Error("conversation action acknowledgement scope mismatch");
      }
      if (this.deviceAuthorization) {
        await this.deviceAuthorization.lockTransportIdentity(tx, authorizationIdentity);
        await this.deviceAuthorization.assertRun(tx, {
          ...authorizationIdentity,
          run_id: row.target_run_id,
          project_id: row.project_id,
        });
      }
      const persistedAck = await tx.query<{ id: string }>(
        `INSERT INTO runner_events (
           id,runner_id,runner_generation,run_id,sequence,event_type,payload,
           correlation_id,causation_id,occurred_at,applied_at
         ) VALUES ($1,$2,$3,$4,$5,'command_ack',$6::jsonb,$7,$8,$9,now())
         ON CONFLICT(runner_id,runner_generation,sequence) DO NOTHING
         RETURNING id`,
        [
          eventId,
          event.runner_id,
          event.generation,
          row.target_run_id,
          event.event_seq,
          JSON.stringify(ack),
          event.correlation_id,
          event.causation_id,
          event.occurred_at,
        ],
      );
      if (!persistedAck.rows[0]) {
        const replay = (
          await tx.query<{
            payload: unknown;
            correlation_id: string;
            causation_id: string | null;
            occurred_at: Date | string;
          }>(
            `SELECT payload,correlation_id,causation_id,occurred_at
               FROM runner_events
              WHERE runner_id=$1 AND runner_generation=$2 AND sequence=$3`,
            [event.runner_id, event.generation, event.event_seq],
          )
        ).rows[0];
        if (
          !replay ||
          canonicalJson(
            typeof replay.payload === "string" ? JSON.parse(replay.payload) : replay.payload,
          ) !== canonicalJson(ack) ||
          replay.correlation_id !== event.correlation_id ||
          replay.causation_id !== event.causation_id ||
          new Date(replay.occurred_at).toISOString() !== event.occurred_at
        ) {
          throw new Error("conversation action acknowledgement sequence replay mismatch");
        }
      }
      if (row.status === "applied" || row.status === "fallback_queued") return true;
      if (row.status === "leased") return true;
      if (!["sent", "acknowledged"].includes(row.status)) return false;
      if (["failed", "rejected", "expired", "cancelled"].includes(state)) {
        const fallback = await tx.query<{ id: string }>(
          `UPDATE conversation_action_delivery_intents
              SET status='fallback_queued',last_error=$2,updated_at=now()
            WHERE id=$1 AND status IN ('sent','acknowledged')
            RETURNING id`,
          [row.id, `live_${state}:${ack.detail || "no detail"}`],
        );
        if (!fallback.rows[0]) return false;
        await tx.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'fallback_queued','checkpoint',$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events
              WHERE action_id=$5`,
          [
            `action-delivery-event:${row.action_id}:fallback:${eventId}`,
            row.project_id,
            row.work_item_id,
            row.conversation_id,
            row.action_id,
            row.target_run_id,
            row.target_command_id,
            JSON.stringify({
              kind: "fallback_queued",
              reason: `live_${state}:${ack.detail || "no detail"}`,
            }),
            event.occurred_at,
          ],
        );
        return true;
      }
      if (row.status === "sent") {
        const acknowledgedAction = await tx.query<{ id: string }>(
          `UPDATE conversation_actions
              SET status='agent_acknowledged',acknowledged_at=$2,updated_at=now()
            WHERE id=$1 AND status='sent'
            RETURNING id`,
          [row.action_id, event.occurred_at],
        );
        const acknowledgedIntent = await tx.query<{ id: string }>(
          `UPDATE conversation_action_delivery_intents
              SET status='acknowledged',updated_at=now()
            WHERE id=$1 AND status='sent'
            RETURNING id`,
          [row.id],
        );
        if (!acknowledgedAction.rows[0] || !acknowledgedIntent.rows[0]) {
          throw new Error("live command acknowledgement lost its fenced action");
        }
        await tx.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'agent_acknowledged','live',$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events
              WHERE action_id=$5`,
          [
            `action-delivery-event:${row.action_id}:ack:${eventId}`,
            row.project_id,
            row.work_item_id,
            row.conversation_id,
            row.action_id,
            row.target_run_id,
            row.target_command_id,
            JSON.stringify({ kind: "agent_ack", ack_event_id: eventId }),
            event.occurred_at,
          ],
        );
      }
      if (state === "accepted" || state === "executing") return true;
      if (row.action_type === "pause_work") {
        const checkpoint = await tx.query<{ id: string }>(
          `UPDATE conversation_action_delivery_intents
              SET status='fallback_queued',
                  last_error='pause_cancelled_awaiting_terminal_checkpoint',
                  updated_at=now()
            WHERE id=$1 AND status='acknowledged'
            RETURNING id`,
          [row.id],
        );
        if (!checkpoint.rows[0]) {
          throw new Error("pause cancellation lost its acknowledged checkpoint intent");
        }
        await tx.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt,occurred_at
           ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                    'fallback_queued','checkpoint',$6,$7,$8::jsonb,$9
               FROM conversation_action_delivery_events WHERE action_id=$5`,
          [
            `action-delivery-event:${row.action_id}:pause-checkpoint:${eventId}`,
            row.project_id,
            row.work_item_id,
            row.conversation_id,
            row.action_id,
            row.target_run_id,
            row.target_command_id,
            JSON.stringify({
              kind: "fallback_queued",
              reason: "pause_cancelled_awaiting_terminal_checkpoint",
            }),
            event.occurred_at,
          ],
        );
        return true;
      }
      const receiptHash = canonicalSha256({
        action_id: row.action_id,
        command_id: row.target_command_id,
        event_id: eventId,
        state,
      });
      const appliedAction = await tx.query<{ id: string }>(
        `UPDATE conversation_actions
            SET status='applied',applied_at=$2,updated_at=now()
          WHERE id=$1 AND status='agent_acknowledged'
          RETURNING id`,
        [row.action_id, event.occurred_at],
      );
      const appliedIntent = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='applied',updated_at=now()
          WHERE id=$1 AND status='acknowledged'
          RETURNING id`,
        [row.id],
      );
      if (!appliedAction.rows[0] || !appliedIntent.rows[0]) {
        throw new Error("live command application lost its acknowledged action");
      }
      await tx.query(
        `INSERT INTO conversation_action_delivery_events (
           id,project_id,work_item_id,conversation_id,action_id,sequence,status,
           delivery_mode,target_run_id,target_command_id,receipt,occurred_at
         ) SELECT $1,$2,$3,$4,$5,COALESCE(max(sequence),0)+1,
                  'applied','live',$6,$7,$8::jsonb,$9
             FROM conversation_action_delivery_events
            WHERE action_id=$5`,
        [
          `action-delivery-event:${row.action_id}:applied:${eventId}`,
          row.project_id,
          row.work_item_id,
          row.conversation_id,
          row.action_id,
          row.target_run_id,
          row.target_command_id,
          JSON.stringify({ kind: "applied", context_receipt_hash: receiptHash }),
          event.occurred_at,
        ],
      );
      return true;
    });
  }

  private async claim(): Promise<ClaimedDelivery | null> {
    return this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<ClaimedDelivery>(
          `SELECT intent.id AS intent_id,intent.project_id,intent.action_id,
                  action.action_type,action.work_item_id,action.conversation_id,
                  action.initiated_by_user_id,item.phase_id,
                  intent.target_run_id,intent.payload,run.runner_id,
                  COALESCE(root_command.runner_generation,0) AS runner_generation,
                  run.state AS run_state,action.confirmed_at
             FROM conversation_action_delivery_intents intent
             JOIN conversation_actions action ON action.id=intent.action_id
             JOIN work_items item ON item.id=action.work_item_id
             LEFT JOIN agent_runs run ON run.id=intent.target_run_id
             LEFT JOIN LATERAL (
               SELECT command.runner_generation
                 FROM commands command
                WHERE command.run_id=run.id AND command.runner_id=run.runner_id
                ORDER BY command.created_at DESC,command.command_id DESC
                LIMIT 1
             ) root_command ON true
            WHERE intent.status='queued' AND intent.available_at<=now()
              AND intent.delivery_mode='live'
              AND action.action_type IN ('redirect_agent','pause_work')
              AND action.status='recorded'
            ORDER BY intent.available_at,intent.id
            FOR UPDATE OF intent SKIP LOCKED
            LIMIT 1`,
        )
      ).rows[0];
      if (!row) return null;
      const leased = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='leased',lease_owner=$2,lease_expires_at=now()+interval '30 seconds',
                attempts=attempts+1,updated_at=now()
          WHERE id=$1 AND status='queued'
          RETURNING id`,
        [row.intent_id, this.workerId],
      );
      return leased.rows[0] ? row : null;
    });
  }

  private async replayBufferedAck(commandId: string): Promise<void> {
    const buffered = await this.transactions.transaction(async (tx) => {
      return (
        await tx.query<{
          runner_id: string;
          runner_generation: number;
          sequence: number;
          correlation_id: string;
          causation_id: string;
          occurred_at: Date | string;
          payload: unknown;
        }>(
          `SELECT runner_id,runner_generation,sequence,correlation_id,causation_id,
                  occurred_at,payload
             FROM runner_events
            WHERE causation_id=$1 AND event_type='command_ack'
            ORDER BY sequence DESC LIMIT 1`,
          [commandId],
        )
      ).rows[0];
    });
    if (!buffered) return;
    await this.applyCommandAck(
      EventEnvelope.parse({
        protocol: 1,
        event_seq: buffered.sequence,
        runner_id: buffered.runner_id,
        generation: buffered.runner_generation,
        correlation_id: buffered.correlation_id,
        causation_id: buffered.causation_id,
        occurred_at: new Date(buffered.occurred_at).toISOString(),
        payload: buffered.payload,
      }),
    );
  }

  private async hasBufferedAck(commandId: string): Promise<boolean> {
    return this.transactions.transaction(async (tx) => {
      const result = await tx.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM runner_events
            WHERE causation_id=$1 AND event_type='command_ack'
              AND payload->>'state' IN (
                'accepted','executing','succeeded','failed','rejected','expired','cancelled'
              )
         ) AS exists`,
        [commandId],
      );
      return Boolean(result.rows[0]?.exists);
    });
  }

  private fallback(
    claimed: ClaimedDelivery,
    reason: string,
  ): Promise<ConversationActionDeliveryResult | null> {
    return this.transactions.transaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='fallback_queued',lease_owner=NULL,lease_expires_at=NULL,
                last_error=$3,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2
          RETURNING id`,
        [claimed.intent_id, this.workerId, reason],
      );
      if (!updated.rows[0]) return null;
      await tx.query(
        `INSERT INTO conversation_action_delivery_events (
           id,project_id,work_item_id,conversation_id,action_id,sequence,status,
           delivery_mode,target_run_id,target_command_id,receipt
         )
         SELECT $2,project_id,work_item_id,conversation_id,id,3,
                'fallback_queued','checkpoint',$3,NULL,$4::jsonb
           FROM conversation_actions WHERE id=$1
         ON CONFLICT(action_id,sequence) DO NOTHING`,
        [
          claimed.action_id,
          `action-delivery-event:${claimed.action_id}:3`,
          claimed.target_run_id,
          JSON.stringify({ kind: "fallback_queued", reason }),
        ],
      );
      return {
        action_id: claimed.action_id,
        intent_id: claimed.intent_id,
        status: "fallback_queued" as const,
        command_id: null,
      };
    });
  }

  private fail(
    claimed: ClaimedDelivery,
    reason: string,
  ): Promise<ConversationActionDeliveryResult | null> {
    return this.transactions.transaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
                last_error=$3,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2
          RETURNING id`,
        [claimed.intent_id, this.workerId, reason],
      );
      if (!updated.rows[0]) return null;
      await tx.query(
        `UPDATE conversation_actions
            SET status='failed',failure_code=$2,updated_at=now()
          WHERE id=$1 AND status='recorded'`,
        [claimed.action_id, reason],
      );
      return {
        action_id: claimed.action_id,
        intent_id: claimed.intent_id,
        status: "failed",
        command_id: null,
      };
    });
  }

  private async release(
    claimed: ClaimedDelivery,
    reason: string,
  ): Promise<ConversationActionDeliveryResult | null> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_action_delivery_intents
            SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now()+interval '5 seconds',last_error=$3,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [claimed.intent_id, this.workerId, reason],
      );
    });
    return null;
  }
}

export interface CheckpointAction {
  intent_id: string;
  action_id: string;
  action_type: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  phase_id: string | null;
  payload: unknown;
  target_run_id: string | null;
}

export interface ConversationPhase6ActionHandler {
  checkpointAction(
    tx: V2SqlExecutor,
    action: CheckpointAction,
    parameters: Record<string, unknown>,
  ): Promise<{
    state: "queued" | "applied";
    resource_type: "project" | "task";
    resource_id: string;
  } | null>;
}

/**
 * Consumes every non-live Phase 5 action. Local state changes advance through
 * the same recorded/sent/acknowledged/applied evidence ladder; mockup creation
 * is handed to Phase 6 as a durable queued request and intentionally remains
 * Recorded until rendering is implemented.
 */
export class ConversationActionCheckpointWorker {
  private readonly workerId: string;
  private readonly contextBaseUrl: string;
  private readonly phase6: ConversationPhase6ActionHandler | undefined;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: {
      workerId?: string;
      contextBaseUrl?: string;
      phase6?: ConversationPhase6ActionHandler;
    } = {},
  ) {
    this.workerId = options.workerId ?? `conversation-checkpoint:${process.pid}`;
    this.contextBaseUrl = (options.contextBaseUrl ?? "http://127.0.0.1").replace(/\/+$/, "");
    this.phase6 = options.phase6;
  }

  async tick(): Promise<{
    action_id: string;
    state: "applied" | "phase6_queued" | "checkpoint_queued" | "failed";
  } | null> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_action_delivery_intents
            SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now(),last_error='recovered_expired_lease',updated_at=now()
          WHERE status='leased' AND delivery_mode='checkpoint' AND lease_expires_at<=now()`,
      );
    });
    const claimed = await this.transactions.transaction(async (tx) => {
      const row = (
        await tx.query<CheckpointAction>(
          `SELECT intent.id AS intent_id,action.id AS action_id,action.action_type,
                  action.project_id,action.work_item_id,action.conversation_id,
                  action.initiated_by_user_id,item.phase_id,action.payload,
                  intent.target_run_id
             FROM conversation_action_delivery_intents intent
             JOIN conversation_actions action ON action.id=intent.action_id
             JOIN work_items item ON item.id=action.work_item_id
            WHERE intent.status='queued' AND intent.delivery_mode='checkpoint'
              AND intent.available_at<=now() AND action.status='recorded'
            ORDER BY intent.available_at,intent.id
            FOR UPDATE OF intent SKIP LOCKED
            LIMIT 1`,
        )
      ).rows[0];
      if (!row) return null;
      const planningSafeMockupAction = [
        "create_mockup",
        "approve_mockup",
        "revise_mockup",
        "reject_mockup",
      ].includes(row.action_type);
      if (!row.phase_id && !planningSafeMockupAction) {
        throw new Error("execution checkpoint action has no phase");
      }
      const leased = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status='leased',lease_owner=$2,lease_expires_at=now()+interval '30 seconds',
                attempts=attempts+1,updated_at=now()
          WHERE id=$1 AND status='queued' RETURNING id`,
        [row.intent_id, this.workerId],
      );
      return leased.rows[0] ? row : null;
    });
    if (!claimed) return null;
    try {
      return await this.transactions.transaction(async (tx) => {
        const locked = await tx.query<{ id: string }>(
          `SELECT id FROM conversation_action_delivery_intents
          WHERE id=$1 AND status='leased' AND lease_owner=$2 FOR UPDATE`,
          [claimed.intent_id, this.workerId],
        );
        if (!locked.rows[0]) return null;
        const parameters = (claimed.payload as { parameters?: Record<string, unknown> } | null)
          ?.parameters;
        if (!parameters) throw new Error("checkpoint action payload is invalid");

        if (claimed.action_type === "pause_work" && claimed.target_run_id) {
          const active = await tx.query<{ id: string }>(
            `SELECT id FROM agent_runs
            WHERE id=$1 AND state IN ('created','dispatched','running','verifying')`,
            [claimed.target_run_id],
          );
          if (active.rows[0]) {
            const queued = await tx.query<{ id: string }>(
              `UPDATE conversation_action_delivery_intents
                SET status='fallback_queued',lease_owner=NULL,lease_expires_at=NULL,
                    last_error='pause_waiting_for_terminal_checkpoint',updated_at=now()
              WHERE id=$1 AND status='leased' AND lease_owner=$2
              RETURNING id`,
              [claimed.intent_id, this.workerId],
            );
            if (!queued.rows[0]) throw new Error("active pause lost its checkpoint lease");
            await tx.query(
              `INSERT INTO conversation_action_delivery_events (
               id,project_id,work_item_id,conversation_id,action_id,sequence,status,
               delivery_mode,target_run_id,target_command_id,receipt
             ) VALUES ($1,$2,$3,$4,$5,3,'fallback_queued','checkpoint',$6,NULL,$7::jsonb)
             ON CONFLICT(action_id,sequence) DO NOTHING`,
              [
                `action-delivery-event:${claimed.action_id}:3`,
                claimed.project_id,
                claimed.work_item_id,
                claimed.conversation_id,
                claimed.action_id,
                claimed.target_run_id,
                JSON.stringify({
                  kind: "fallback_queued",
                  reason: "pause_waiting_for_terminal_checkpoint",
                }),
              ],
            );
            return { action_id: claimed.action_id, state: "checkpoint_queued" as const };
          }
        }

        const phase6Result = this.phase6
          ? await this.phase6.checkpointAction(tx, claimed, parameters)
          : null;
        if (phase6Result?.state === "queued") {
          const queued = await tx.query<{ id: string }>(
            `UPDATE conversation_action_delivery_intents
              SET status='fallback_queued',lease_owner=NULL,lease_expires_at=NULL,
                  last_error='phase6_mockup_render_queued',updated_at=now()
            WHERE id=$1 AND status='leased' AND lease_owner=$2
            RETURNING id`,
            [claimed.intent_id, this.workerId],
          );
          if (!queued.rows[0]) throw new Error("mockup request lost its delivery lease");
          return { action_id: claimed.action_id, state: "phase6_queued" as const };
        }
        if (phase6Result?.state === "applied") {
          await this.finishCheckpoint(
            tx,
            claimed,
            phase6Result.resource_type,
            phase6Result.resource_id,
          );
          return { action_id: claimed.action_id, state: "applied" as const };
        }

        if (!this.phase6 && claimed.action_type === "create_mockup") {
          const requestId = `mockup-request:${claimed.action_id}`;
          await tx.query(
            `INSERT INTO conversation_mockup_requests (
             id,project_id,work_item_id,conversation_id,action_id,task_id,
             brief,target,artifact_refs
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT(action_id) DO NOTHING`,
            [
              requestId,
              claimed.project_id,
              claimed.work_item_id,
              claimed.conversation_id,
              claimed.action_id,
              parameters.task_id ?? null,
              parameters.brief,
              parameters.target,
              JSON.stringify(parameters.artifact_refs ?? []),
            ],
          );
          const queued = await tx.query<{ id: string }>(
            `UPDATE conversation_action_delivery_intents
              SET status='fallback_queued',lease_owner=NULL,lease_expires_at=NULL,
                  last_error='phase6_mockup_generation_pending',updated_at=now()
            WHERE id=$1 AND status='leased' AND lease_owner=$2
            RETURNING id`,
            [claimed.intent_id, this.workerId],
          );
          if (!queued.rows[0]) throw new Error("mockup request lost its delivery lease");
          return { action_id: claimed.action_id, state: "phase6_queued" as const };
        }

        const phaseId = claimed.phase_id;
        if (!phaseId) throw new Error("execution checkpoint action has no phase");
        let resourceType: "project" | "task" | "plan_change" = "project";
        let resourceId = claimed.work_item_id;
        if (claimed.action_type === "record_human_decision") {
          const decisionPointId = `decision-point:${claimed.action_id}`;
          const approvalId = `approval:${claimed.action_id}`;
          const decisionId = `decision:${claimed.action_id}`;
          const decisionHash = canonicalSha256(parameters);
          await tx.query(
            `INSERT INTO decision_points (
             id,project_id,phase_id,task_id,scope_entity_type,scope_entity_id,
             reason_class,source_instance_id,condition_key,condition_fingerprint,
             question,context,options,recommendation_option_id,urgency,status,resolved_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,'human_decision','conversation',$7,$8,$9,$10,
             $11::jsonb,'recorded','normal','resolved',now()
           ) ON CONFLICT(id) DO NOTHING`,
            [
              decisionPointId,
              claimed.project_id,
              phaseId,
              parameters.task_id ?? null,
              parameters.task_id ? "task" : "work_item",
              parameters.task_id ?? claimed.work_item_id,
              `conversation-human-decision:${claimed.action_id}`,
              decisionHash,
              parameters.decision_point,
              parameters.rationale,
              JSON.stringify([{ id: "recorded", label: parameters.decision }]),
            ],
          );
          await tx.query(
            `INSERT INTO approvals (
             id,project_id,phase_id,kind,subject_entity_type,subject_entity_id,
             actor_id,content_hash,status,approved_at
           ) VALUES ($1,$2,$3,'human_decision','decision_point',$4,$5,$6,'active',now())
           ON CONFLICT(id) DO NOTHING`,
            [
              approvalId,
              claimed.project_id,
              phaseId,
              decisionPointId,
              claimed.initiated_by_user_id,
              decisionHash,
            ],
          );
          await tx.query(
            `INSERT INTO decision_records (
             id,project_id,phase_id,decision_point_id,title,rationale,
             selected_option_id,status,decided_by,approval_id,affected_entities
           ) VALUES ($1,$2,$3,$4,$5,$6,'recorded','active',$7,$8,$9::jsonb)
           ON CONFLICT(id) DO NOTHING`,
            [
              decisionId,
              claimed.project_id,
              phaseId,
              decisionPointId,
              parameters.decision_point,
              parameters.rationale,
              claimed.initiated_by_user_id,
              approvalId,
              JSON.stringify([
                {
                  entity_type: parameters.task_id ? "task" : "work_item",
                  entity_id: parameters.task_id ?? claimed.work_item_id,
                },
              ]),
            ],
          );
          resourceType = "project";
          resourceId = decisionId;
        } else if (claimed.action_type === "pause_work") {
          const taskId = typeof parameters.task_id === "string" ? parameters.task_id : null;
          if (taskId) {
            const lifecycle = new SqlV2ApplicationTransaction(tx);
            const task = await lifecycle.lockTaskLifecycle(taskId);
            if (task && task.state !== "blocked") {
              await transitionV2TaskLifecycle(lifecycle, {
                project_id: claimed.project_id,
                phase_id: phaseId,
                task_id: taskId,
                expected_aggregate_version: task.aggregate_version,
                to: "blocked",
                reason: String(parameters.reason),
                actor_type: "human",
                actor_id: claimed.initiated_by_user_id,
                correlation_id: claimed.action_id,
                causation_id: claimed.action_id,
                occurred_at: new Date().toISOString(),
              });
            }
            resourceType = "task";
            resourceId = taskId;
          }
          if (!taskId) {
            await tx.query(
              `UPDATE work_items SET status='blocked',aggregate_version=aggregate_version+1,
                                   updated_at=now()
              WHERE id=$1 AND project_id=$2 AND status='executing'`,
              [claimed.work_item_id, claimed.project_id],
            );
          }
        } else if (claimed.action_type === "resume_work") {
          const taskId = typeof parameters.task_id === "string" ? parameters.task_id : null;
          const workItem = await tx.query<{ id: string; status: string }>(
            `SELECT id,status FROM work_items
            WHERE id=$1 AND project_id=$2 FOR UPDATE`,
            [claimed.work_item_id, claimed.project_id],
          );
          if (!workItem.rows[0] || (!taskId && workItem.rows[0].status !== "blocked")) {
            throw new Error("work is not paused");
          }
          const pausedCheckpoint = (
            await tx.query<{
              pause_action_id: string;
              run_id: string;
            }>(
              `SELECT pause_action_id,run_id
               FROM conversation_pause_checkpoints
              WHERE project_id=$1 AND work_item_id=$2
                AND ($3::text IS NULL OR task_id=$3)
                AND status='paused'
              ORDER BY paused_at DESC,pause_action_id
              LIMIT 1
              FOR UPDATE`,
              [claimed.project_id, claimed.work_item_id, taskId],
            )
          ).rows[0];
          if (pausedCheckpoint) {
            const addendum = canonicalJson({
              schema_version: 1,
              kind: "conversation_pause_resume",
              pause_action_id: pausedCheckpoint.pause_action_id,
              resume_action_id: claimed.action_id,
              run_id: pausedCheckpoint.run_id,
              reason: String(parameters.reason ?? "human resumed work"),
              resumed_by_user_id: claimed.initiated_by_user_id,
            });
            const bytes = Buffer.from(addendum, "utf8");
            const contextHash = canonicalSha256(JSON.parse(addendum));
            const documentId = `taskctx_pause_resume_${contextHash.slice(0, 32)}`;
            const contextRef = {
              artifact_id: documentId,
              content_hash: contextHash,
              byte_size: bytes.byteLength,
              storage_ref: `${this.contextBaseUrl}/api/v2/execution/task-context/${documentId}`,
            };
            const resumeJobId = `pause-resume:${pausedCheckpoint.pause_action_id}`;
            const resumeCommandId = v2CommandIdForDispatchJob(resumeJobId);
            await tx.query(
              `INSERT INTO task_context_blobs(sha256,content) VALUES ($1,$2)
             ON CONFLICT(sha256) DO NOTHING`,
              [contextHash, bytes],
            );
            await tx.query(
              `INSERT INTO task_context_documents(id,project_id,section,sha256,byte_size,media_type)
             VALUES ($1,$2,'conversation_pause_resume',$3,$4,'application/json')
             ON CONFLICT(id) DO NOTHING`,
              [documentId, claimed.project_id, contextHash, bytes.byteLength],
            );
            const queued = await tx.query<{ pause_action_id: string }>(
              `UPDATE conversation_pause_checkpoints
                SET status='resume_queued',resume_action_id=$2,resume_context_ref=$3::jsonb,
                    resume_command_id=$4,resume_job_id=$5,available_at=now(),updated_at=now()
              WHERE pause_action_id=$1 AND status='paused'
              RETURNING pause_action_id`,
              [
                pausedCheckpoint.pause_action_id,
                claimed.action_id,
                JSON.stringify(contextRef),
                resumeCommandId,
                resumeJobId,
              ],
            );
            if (!queued.rows[0]) throw new Error("pause checkpoint changed before resume queued");
            const renewed = await tx.query<{ id: string }>(
              `UPDATE budget_reservations reservation
                SET expires_at=GREATEST(reservation.expires_at,now()+interval '2 hours'),
                    version=version+1,updated_at=now()
               FROM conversation_pause_checkpoints checkpoint
              WHERE checkpoint.pause_action_id=$1
                AND reservation.id=checkpoint.budget_reservation_id
                AND reservation.status='active'
              RETURNING reservation.id`,
              [pausedCheckpoint.pause_action_id],
            );
            if (!renewed.rows[0]) throw new Error("pause reservation is no longer active");
            const fallback = await tx.query<{ id: string }>(
              `UPDATE conversation_action_delivery_intents
                SET status='fallback_queued',lease_owner=NULL,lease_expires_at=NULL,
                    last_error='pause_resume_queued',updated_at=now()
              WHERE id=$1 AND status='leased' AND lease_owner=$2
              RETURNING id`,
              [claimed.intent_id, this.workerId],
            );
            if (!fallback.rows[0]) throw new Error("resume action lost its checkpoint lease");
            await tx.query(
              `INSERT INTO conversation_action_delivery_events (
               id,project_id,work_item_id,conversation_id,action_id,sequence,status,
               delivery_mode,target_run_id,target_command_id,receipt
             ) VALUES ($1,$2,$3,$4,$5,3,'fallback_queued','continuation',$6,NULL,$7::jsonb)
             ON CONFLICT(action_id,sequence) DO NOTHING`,
              [
                `action-delivery-event:${claimed.action_id}:3`,
                claimed.project_id,
                claimed.work_item_id,
                claimed.conversation_id,
                claimed.action_id,
                pausedCheckpoint.run_id,
                JSON.stringify({ kind: "fallback_queued", reason: "pause_resume_queued" }),
              ],
            );
            return { action_id: claimed.action_id, state: "checkpoint_queued" as const };
          }
          if (taskId) {
            const run = (
              await tx.query<{ state: string }>(
                `SELECT state FROM agent_runs WHERE task_id=$1 AND is_designated
                AND superseded_at IS NULL`,
                [taskId],
              )
            ).rows[0];
            if (run?.state === "waiting_for_human") {
              throw new Error("a waiting human question must be answered before resume");
            }
            const lifecycle = new SqlV2ApplicationTransaction(tx);
            const task = await lifecycle.lockTaskLifecycle(taskId);
            if (task?.state === "blocked") {
              const target =
                run?.state === "running"
                  ? "in_progress"
                  : ["created", "dispatched"].includes(run?.state ?? "")
                    ? "assigned"
                    : "ready";
              await transitionV2TaskLifecycle(lifecycle, {
                project_id: claimed.project_id,
                phase_id: phaseId,
                task_id: taskId,
                expected_aggregate_version: task.aggregate_version,
                to: target,
                reason: String(parameters.reason ?? "human resumed work"),
                actor_type: "human",
                actor_id: claimed.initiated_by_user_id,
                correlation_id: claimed.action_id,
                causation_id: claimed.action_id,
                occurred_at: new Date().toISOString(),
              });
            }
            resourceType = "task";
            resourceId = taskId;
          }
          if (!taskId) {
            await tx.query(
              `UPDATE work_items SET status='executing',aggregate_version=aggregate_version+1,
                                   updated_at=now()
              WHERE id=$1 AND project_id=$2 AND status='blocked'`,
              [claimed.work_item_id, claimed.project_id],
            );
          }
        } else if (claimed.action_type === "propose_plan_change") {
          const requestId = `plan-change-request:${claimed.action_id}`;
          await tx.query(
            `INSERT INTO conversation_execution_plan_change_requests (
             id,project_id,work_item_id,conversation_id,action_id,plan_version_id,
             plan_hash,direction,rationale
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(action_id) DO NOTHING`,
            [
              requestId,
              claimed.project_id,
              claimed.work_item_id,
              claimed.conversation_id,
              claimed.action_id,
              parameters.plan_version_id,
              parameters.plan_hash,
              parameters.direction,
              parameters.rationale,
            ],
          );
          resourceType = "plan_change";
          resourceId = requestId;
        } else if (claimed.action_type === "approve_plan_change") {
          const approved = await tx.query<{ id: string }>(
            `UPDATE conversation_execution_plan_change_requests request
              SET status='approved',approved_by_action_id=$2,decided_at=now()
             FROM conversation_actions proposal
            WHERE proposal.id=$1 AND request.action_id=proposal.id
              AND request.status='proposed'
              AND request.plan_version_id=$3 AND request.plan_hash=$4
            RETURNING request.id`,
            [
              parameters.proposal_action_id,
              claimed.action_id,
              parameters.plan_version_id,
              parameters.plan_hash,
            ],
          );
          if (!approved.rows[0]) throw new Error("plan-change request is no longer approvable");
          resourceType = "plan_change";
          resourceId = approved.rows[0].id;
        } else {
          throw new Error(`unsupported checkpoint action ${claimed.action_type}`);
        }
        await this.finishCheckpoint(tx, claimed, resourceType, resourceId);
        return { action_id: claimed.action_id, state: "applied" as const };
      });
    } catch (error) {
      const failureCode =
        error instanceof Error
          ? `checkpoint_action_failed:${error.message}`.slice(0, 500)
          : "checkpoint_action_failed";
      await this.transactions.transaction(async (tx) => {
        const intent = await tx.query<{ id: string }>(
          `UPDATE conversation_action_delivery_intents
              SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
                  last_error=$3,updated_at=now()
            WHERE id=$1 AND status='leased' AND lease_owner=$2
            RETURNING id`,
          [claimed.intent_id, this.workerId, failureCode],
        );
        if (!intent.rows[0]) return;
        const action = await tx.query<{ id: string }>(
          `UPDATE conversation_actions
              SET status='failed',failure_code=$2,updated_at=now()
            WHERE id=$1 AND status='recorded'
            RETURNING id`,
          [claimed.action_id, failureCode],
        );
        if (!action.rows[0]) throw new Error("failed checkpoint action lost its record");
        await tx.query(
          `INSERT INTO conversation_action_delivery_events (
             id,project_id,work_item_id,conversation_id,action_id,sequence,status,
             delivery_mode,target_run_id,target_command_id,receipt
           ) VALUES ($1,$2,$3,$4,$5,3,'failed','checkpoint',NULL,NULL,$6::jsonb)
           ON CONFLICT(action_id,sequence) DO NOTHING`,
          [
            `action-delivery-event:${claimed.action_id}:3`,
            claimed.project_id,
            claimed.work_item_id,
            claimed.conversation_id,
            claimed.action_id,
            JSON.stringify({ kind: "failed", failure_code: failureCode }),
          ],
        );
      });
      return { action_id: claimed.action_id, state: "failed" };
    }
  }

  private async finishCheckpoint(
    tx: V2SqlExecutor,
    claimed: CheckpointAction,
    resourceType: "project" | "task" | "plan_change",
    resourceId: string,
  ): Promise<void> {
    const steps = [
      {
        fromAction: "recorded",
        toAction: "sent",
        actionTime: "sent_at",
        fromIntent: "leased",
        toIntent: "sent",
        status: "sent",
        receipt: { kind: "sent", outbox_id: claimed.intent_id },
      },
      {
        fromAction: "sent",
        toAction: "agent_acknowledged",
        actionTime: "acknowledged_at",
        fromIntent: "sent",
        toIntent: "acknowledged",
        status: "agent_acknowledged",
        receipt: { kind: "agent_ack", ack_event_id: `checkpoint:${claimed.action_id}` },
      },
      {
        fromAction: "agent_acknowledged",
        toAction: "applied",
        actionTime: "applied_at",
        fromIntent: "acknowledged",
        toIntent: "applied",
        status: "applied",
        receipt: {
          kind: "applied",
          context_receipt_hash: canonicalSha256({
            action_id: claimed.action_id,
            resource_type: resourceType,
            resource_id: resourceId,
          }),
        },
      },
    ] as const;
    for (const [index, step] of steps.entries()) {
      const action = await tx.query<{ id: string }>(
        `UPDATE conversation_actions SET status=$2,${step.actionTime}=now(),updated_at=now()
          WHERE id=$1 AND status=$3 RETURNING id`,
        [claimed.action_id, step.toAction, step.fromAction],
      );
      const intent = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status=$2,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND status=$3 RETURNING id`,
        [claimed.intent_id, step.toIntent, step.fromIntent],
      );
      if (!action.rows[0] || !intent.rows[0]) {
        throw new Error("checkpoint delivery lifecycle lost its fenced action");
      }
      await tx.query(
        `INSERT INTO conversation_action_delivery_events (
           id,project_id,work_item_id,conversation_id,action_id,sequence,status,
           delivery_mode,target_run_id,target_command_id,receipt
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'checkpoint',NULL,NULL,$8::jsonb)`,
        [
          `action-delivery-event:${claimed.action_id}:${index + 3}`,
          claimed.project_id,
          claimed.work_item_id,
          claimed.conversation_id,
          claimed.action_id,
          index + 3,
          step.status,
          JSON.stringify(step.receipt),
        ],
      );
    }
  }
}
