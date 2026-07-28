import type {
  V2ApprovePlanParametersT,
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2ConversationExecutionActionEffectValueT,
  V2ConversationPlanActionEffectValueT,
  V2RejectPlanParametersT,
  V2RequestPlanChangesParametersT,
  V2SavePlanCandidateParametersT,
  V2SendPlanToQcParametersT,
} from "@norns/contracts";
import { V2_CONVERSATION_ACTION_INTERACTION_CLASS } from "@norns/contracts";
import { ConversationPlanDraftCard } from "./ConversationPlanCard";
import { Badge, Button } from "./ui";

const PLAN_ACTIONS = {
  save_plan_candidate: {
    title: "Save plan candidate",
    button: "Save plan candidate",
    description: "Create an immutable, versioned candidate from this proposed Plan Contract.",
  },
  send_plan_to_qc: {
    title: "Send to QC",
    button: "Send to QC",
    description: "Sends this exact plan version to the cross-provider reviewer.",
  },
  request_plan_changes: {
    title: "Request changes",
    button: "Request changes",
    description: "Return this exact plan version to the PM with the recorded direction below.",
  },
  approve_plan: {
    title: "Approve and begin",
    button: "Approve and begin",
    description: "Approve this exact reviewed plan version and begin the existing kickoff bridge.",
  },
  reject_plan: {
    title: "Reject plan",
    button: "Reject plan",
    description: "Reject this exact plan version. Work will not begin.",
  },
} as const;

type PlanActionType = keyof typeof PLAN_ACTIONS;

const EXECUTION_ACTIONS = {
  record_human_decision: {
    title: "Record human decision",
    button: "Record decision",
    description: "Record this decision and rationale for the execution coordinator.",
  },
  redirect_agent: {
    title: "Send task direction",
    button: "Send task direction",
    description:
      "Deliver exact direction to the live run when possible, or queue it for the next safe checkpoint.",
  },
  propose_plan_change: {
    title: "Propose plan change",
    button: "Propose plan change",
    description: "Record a scoped change proposal without silently rewriting the approved plan.",
  },
  approve_plan_change: {
    title: "Approve plan change",
    button: "Approve plan change",
    description: "Approve this exact plan-change proposal and immutable plan reference.",
  },
  pause_work: {
    title: "Pause work",
    button: "Pause work",
    description: "Record a pause for the whole work item or the named task.",
  },
  resume_work: {
    title: "Resume work",
    button: "Resume work",
    description: "Resume the recorded work scope through the coordinator.",
  },
  create_mockup: {
    title: "Create mockup",
    button: "Create mockup",
    description: "Request a reviewable visual artifact before implementation continues.",
  },
  approve_mockup: {
    title: "Approve mockup",
    button: "Approve exact mockup",
    description: "Approve the exact mockup version and immutable manifest for task implementation.",
  },
  revise_mockup: {
    title: "Revise mockup",
    button: "Request exact revision",
    description: "Request a new version while preserving this exact mockup and immutable manifest.",
  },
  reject_mockup: {
    title: "Reject mockup",
    button: "Reject exact mockup",
    description: "Reject the exact mockup version and immutable manifest with a recorded reason.",
  },
  answer_human_wait: {
    title: "Answer blocking question",
    button: "Submit exact answer",
    description: "Record this exact answer before dispatching one durable continuation.",
  },
} as const;

type ExecutionActionType = keyof typeof EXECUTION_ACTIONS;

const DELIVERY_STEPS = [
  { status: "proposed", label: "Proposed", timestamp: "created_at" },
  { status: "confirmed", label: "Confirmed", timestamp: "confirmed_at" },
  { status: "recorded", label: "Recorded", timestamp: "recorded_at" },
  { status: "sent", label: "Sent", timestamp: "sent_at" },
  { status: "agent_acknowledged", label: "Agent acknowledged", timestamp: "acknowledged_at" },
  { status: "applied", label: "Applied", timestamp: "applied_at" },
] as const;

function isPlanAction(action: V2ConversationActionT): action is V2ConversationActionT & {
  action_type: PlanActionType;
} {
  return action.action_type in PLAN_ACTIONS;
}

function isExecutionAction(action: V2ConversationActionT): action is V2ConversationActionT & {
  action_type: ExecutionActionType;
} {
  return action.action_type in EXECUTION_ACTIONS;
}

function targetReference(action: V2ConversationActionT): {
  planVersionId: string;
  contentHash: string;
} | null {
  if (action.action_type === "save_plan_candidate") return null;
  const parameters = action.payload.parameters as
    | V2SendPlanToQcParametersT
    | V2RequestPlanChangesParametersT
    | V2ApprovePlanParametersT
    | V2RejectPlanParametersT;
  return {
    planVersionId: parameters.plan_version_id,
    contentHash: parameters.content_hash,
  };
}

function deliveryModeNotice(event: V2ConversationActionDeliveryEventT): {
  tone: "is-info" | "is-success" | "is-failed";
  text: string;
} {
  if (event.status === "failed") {
    return {
      tone: "is-failed",
      text: "Delivery failed. The direction was not applied; review the recorded receipt before retrying.",
    };
  }
  if (event.delivery_mode === "checkpoint") {
    if (event.status === "applied") {
      return { tone: "is-success", text: "Direction was applied at a safe checkpoint." };
    }
    if (event.status === "agent_acknowledged") {
      return { tone: "is-info", text: "The checkpoint agent acknowledged this direction." };
    }
    if (event.status === "sent") {
      return {
        tone: "is-info",
        text: "Sent at a safe checkpoint; agent acknowledgement is pending.",
      };
    }
    return {
      tone: "is-info",
      text: "Queued for the next safe checkpoint. It has not been sent to an agent yet.",
    };
  }
  if (event.delivery_mode === "continuation") {
    if (event.status === "applied") {
      return { tone: "is-success", text: "The continuation applied this action." };
    }
    if (event.status === "agent_acknowledged") {
      return { tone: "is-info", text: "The continuation acknowledged this action." };
    }
    if (event.status === "sent") {
      return { tone: "is-info", text: "Sent to the durable continuation." };
    }
    return {
      tone: "is-info",
      text: "Queued for a durable continuation. No runner is waiting for this answer.",
    };
  }
  if (event.status === "applied") {
    return { tone: "is-success", text: "The live runtime applied this action." };
  }
  if (event.status === "agent_acknowledged") {
    return { tone: "is-info", text: "The live runtime acknowledged this action." };
  }
  if (event.status === "sent") {
    return { tone: "is-info", text: "Sent to the live runtime; acknowledgement is pending." };
  }
  return {
    tone: "is-info",
    text: "Live delivery is being recorded. It has not been sent yet.",
  };
}

function DeliveryStatus({
  action,
  events,
}: {
  action: V2ConversationActionT;
  events: V2ConversationActionDeliveryEventT[];
}): React.ReactElement {
  const activeIndex = DELIVERY_STEPS.findIndex((step) => step.status === action.status);
  const latestEvent = [...events].sort((left, right) => left.sequence - right.sequence).at(-1);
  const notice = latestEvent ? deliveryModeNotice(latestEvent) : null;
  const copy = isPlanAction(action)
    ? PLAN_ACTIONS[action.action_type]
    : isExecutionAction(action)
      ? EXECUTION_ACTIONS[action.action_type]
      : null;
  return (
    <div className="conversation-action-delivery">
      <strong>Delivery status</strong>
      <ol aria-label={`${copy?.title ?? "Action"} delivery`}>
        {DELIVERY_STEPS.map((step, index) => {
          const timestamp = action[step.timestamp];
          const state =
            index === activeIndex
              ? "current"
              : timestamp !== null
                ? "complete"
                : activeIndex >= 0 && index < activeIndex
                  ? "complete"
                  : "pending";
          return (
            <li
              key={step.status}
              className={`is-${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span aria-hidden="true" />
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>
      {action.status === "failed" ? (
        <output className="conversation-action-outcome is-failed" aria-live="polite">
          Delivery failed · {action.failure_code}
        </output>
      ) : null}
      {action.status === "rejected" ? (
        <output className="conversation-action-outcome" aria-live="polite">
          Action rejected
        </output>
      ) : null}
      {notice ? (
        <output
          className={`conversation-action-effect ${notice.tone}`}
          data-testid="conversation-delivery-mode"
          aria-live="polite"
        >
          <span>{notice.text}</span>
          {latestEvent?.target_run_id ? <code>Run {latestEvent.target_run_id}</code> : null}
        </output>
      ) : null}
    </div>
  );
}

function EffectNotice({
  effect,
  projectId,
}: {
  effect: V2ConversationPlanActionEffectValueT | V2ConversationExecutionActionEffectValueT;
  projectId: string;
}): React.ReactElement {
  if (effect.kind === "delivery_queued") {
    const notice = deliveryModeNotice(effect.delivery_event);
    return (
      <output className={`conversation-action-effect ${notice.tone}`} aria-live="polite">
        <span>{notice.text}</span>
      </output>
    );
  }
  if (effect.kind === "human_wait_answered") {
    return (
      <output className="conversation-action-effect is-info" aria-live="polite">
        <span>
          Answer recorded. Continuation {effect.continuation.status.replaceAll("_", " ")}; no runner
          remained idle while waiting.
        </span>
      </output>
    );
  }
  if (effect.kind === "state_mutation_recorded") {
    return (
      <output className="conversation-action-effect is-success" aria-live="polite">
        {effect.resource_type.replaceAll("_", " ")} state recorded as {effect.state}.
      </output>
    );
  }
  if (effect.kind === "plan_saved") {
    return (
      <output className="conversation-action-effect is-success" aria-live="polite">
        Plan version {effect.plan_version.version} was saved with hash{" "}
        <code>{effect.plan_version.content_hash.slice(0, 10)}</code>.
      </output>
    );
  }
  if (effect.kind === "qc_started") {
    return (
      <output className="conversation-action-effect is-info" aria-live="polite">
        QC attempt {effect.plan_review.attempt_number} is{" "}
        {effect.plan_review.status.replaceAll("_", " ")}.
      </output>
    );
  }
  if (effect.kind === "changes_requested") {
    return (
      <output className="conversation-action-effect is-info" aria-live="polite">
        Changes were requested for plan version {effect.plan_version.version}.
      </output>
    );
  }
  if (effect.kind === "plan_rejected") {
    return (
      <output className="conversation-action-effect is-failed" aria-live="polite">
        Plan version {effect.plan_version.version} was rejected. Work did not begin.
      </output>
    );
  }

  if (effect.transition_status !== "created" || effect.execution_conversation_id === null) {
    return (
      <output className="conversation-action-effect is-info" aria-live="polite">
        This plan was approved before execution conversation handoffs were recorded. No linked
        execution PM conversation is available for this historical approval.
      </output>
    );
  }

  const { execution } = effect;
  const message =
    execution.status === "pending"
      ? "The plan is approved. Coding kickoff is still pending."
      : execution.status === "started"
        ? `The plan is approved and coding started. ${execution.detail ?? ""}`.trim()
        : execution.status === "refused"
          ? `The plan is approved, but coding did not start. ${execution.detail ?? ""}`.trim()
          : `The plan is approved, but coding kickoff failed. ${execution.detail ?? ""}`.trim();
  return (
    <output
      className={`conversation-action-effect ${
        execution.status === "started"
          ? "is-success"
          : execution.status === "pending"
            ? "is-info"
            : "is-failed"
      }`}
      aria-live="polite"
    >
      <span>{message}</span>
      <a
        data-testid="conversation-execution-link"
        href={`/projects/${encodeURIComponent(projectId)}/work/${encodeURIComponent(
          effect.execution_conversation_id,
        )}`}
      >
        Open execution PM conversation
      </a>
      {execution.status === "refused" || execution.status === "failed" ? (
        <a href={`/projects/${encodeURIComponent(projectId)}`}>Open project recovery</a>
      ) : null}
    </output>
  );
}

function parameterText(parameters: Record<string, unknown>, key: string): string | null {
  const value = parameters[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ExecutionActionDetails({
  action,
}: {
  action: V2ConversationActionT & { action_type: ExecutionActionType };
}): React.ReactElement {
  const parameters = action.payload.parameters;
  const primary =
    parameterText(parameters, "decision") ??
    parameterText(parameters, "direction") ??
    parameterText(parameters, "brief") ??
    parameterText(parameters, "answer") ??
    parameterText(parameters, "reason");
  const rationale = parameterText(parameters, "rationale");
  const taskId = parameterText(parameters, "task_id");
  const runId = parameterText(parameters, "run_id");
  const target = parameterText(parameters, "target");
  const decisionPoint = parameterText(parameters, "decision_point");
  const mockupVersionId = parameterText(parameters, "mockup_version_id");
  const manifestArtifactId = parameterText(parameters, "manifest_artifact_id");
  const manifestArtifactHash = parameterText(parameters, "manifest_artifact_hash");

  return (
    <>
      {primary ? (
        <blockquote>
          <strong>
            {action.action_type === "answer_human_wait"
              ? "Exact answer"
              : action.action_type === "create_mockup"
                ? "Mockup brief"
                : action.action_type === "revise_mockup"
                  ? "Revision direction"
                  : action.action_type === "reject_mockup"
                    ? "Rejection reason"
                    : action.action_type === "record_human_decision"
                      ? "Decision"
                      : action.action_type === "pause_work" || action.action_type === "resume_work"
                        ? "Reason"
                        : "Direction"}
          </strong>
          <p>{primary}</p>
          {rationale ? <small>Rationale · {rationale}</small> : null}
        </blockquote>
      ) : null}
      <dl className="conversation-action-target">
        <div>
          <dt>Visible source message</dt>
          <dd>{action.source_message_id}</dd>
        </div>
        {decisionPoint ? (
          <div>
            <dt>Decision point</dt>
            <dd>{decisionPoint}</dd>
          </div>
        ) : null}
        {taskId ? (
          <div>
            <dt>Task</dt>
            <dd>{taskId}</dd>
          </div>
        ) : null}
        {runId ? (
          <div>
            <dt>Run</dt>
            <dd>{runId}</dd>
          </div>
        ) : null}
        {target ? (
          <div>
            <dt>Target</dt>
            <dd>{target}</dd>
          </div>
        ) : null}
        {mockupVersionId ? (
          <div>
            <dt>Exact mockup version</dt>
            <dd>{mockupVersionId}</dd>
          </div>
        ) : null}
        {manifestArtifactId ? (
          <div>
            <dt>Manifest artifact</dt>
            <dd>{manifestArtifactId}</dd>
          </div>
        ) : null}
        {manifestArtifactHash ? (
          <div>
            <dt>Manifest hash</dt>
            <dd>
              <code title={manifestArtifactHash}>{manifestArtifactHash.slice(0, 12)}</code>
            </dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

export function ConversationActionCard({
  action,
  busy,
  effect,
  deliveryEvents = [],
  error,
  onConfirm,
}: {
  action: V2ConversationActionT;
  busy: boolean;
  effect: V2ConversationPlanActionEffectValueT | V2ConversationExecutionActionEffectValueT | null;
  deliveryEvents?: V2ConversationActionDeliveryEventT[];
  error: string | null;
  onConfirm: (action: V2ConversationActionT) => Promise<void>;
}): React.ReactElement {
  if (!isPlanAction(action) && !isExecutionAction(action)) {
    return (
      <article className="conversation-action-card" data-testid="conversation-action-card">
        <strong>Action</strong>
        <p>{action.action_type.replaceAll("_", " ")}</p>
        <DeliveryStatus action={action} events={deliveryEvents} />
      </article>
    );
  }

  const planAction = isPlanAction(action);
  const executionAction = isExecutionAction(action);
  const copy = planAction
    ? PLAN_ACTIONS[action.action_type]
    : EXECUTION_ACTIONS[action.action_type];
  const reference = planAction ? targetReference(action) : null;
  const parameters = action.payload.parameters;
  const saveParameters =
    action.action_type === "save_plan_candidate"
      ? (parameters as V2SavePlanCandidateParametersT)
      : null;
  const direction = planAction
    ? action.action_type === "request_plan_changes"
      ? (parameters as V2RequestPlanChangesParametersT).direction
      : null
    : null;
  const reason =
    action.action_type === "reject_plan" ? (parameters as V2RejectPlanParametersT).reason : null;
  const recoverable =
    effect === null &&
    ["confirmed", "recorded", "sent", "agent_acknowledged"].includes(action.status);
  const titleId = `conversation-action-${action.id}`;

  return (
    <article
      className="conversation-action-card"
      data-testid={`conversation-action-${action.action_type}`}
      aria-labelledby={titleId}
    >
      <header>
        <div>
          <div className="eyebrow">
            Explicit{" "}
            {V2_CONVERSATION_ACTION_INTERACTION_CLASS[action.action_type].replaceAll("_", " ")}
          </div>
          <h3 id={titleId}>{copy.title}</h3>
        </div>
        <Badge
          tone={
            action.status === "failed"
              ? "danger"
              : action.status === "applied"
                ? "success"
                : action.status === "proposed"
                  ? "warn"
                  : "info"
          }
        >
          {action.status.replaceAll("_", " ")}
        </Badge>
      </header>
      <p>{copy.description}</p>

      {saveParameters ? (
        <ConversationPlanDraftCard actionId={action.id} plan={saveParameters.plan} />
      ) : null}
      {reference ? (
        <dl className="conversation-action-target">
          <div>
            <dt>Plan version</dt>
            <dd>{reference.planVersionId}</dd>
          </div>
          <div>
            <dt>Exact content hash</dt>
            <dd>
              <code title={reference.contentHash}>{reference.contentHash.slice(0, 10)}</code>
            </dd>
          </div>
        </dl>
      ) : null}
      {direction ? (
        <blockquote>
          <strong>Requested direction</strong>
          <p>{direction}</p>
        </blockquote>
      ) : null}
      {action.action_type === "reject_plan" ? (
        <blockquote>
          <strong>Reason</strong>
          <p>{reason ?? "No reason provided."}</p>
        </blockquote>
      ) : null}
      {executionAction ? <ExecutionActionDetails action={action} /> : null}

      <DeliveryStatus action={action} events={deliveryEvents} />
      {effect ? <EffectNotice effect={effect} projectId={action.project_id} /> : null}
      {error ? (
        <output className="conversation-action-error" role="alert">
          {error}
        </output>
      ) : null}
      {action.status === "proposed" ? (
        <div className="conversation-action-confirm">
          <p>This project change happens only when you confirm this card.</p>
          <Button
            variant="primary"
            disabled={busy}
            aria-label={`Confirm action: ${copy.button}`}
            onClick={() => void onConfirm(action)}
          >
            {busy ? "Confirming…" : `Confirm · ${copy.button}`}
          </Button>
        </div>
      ) : null}
      {recoverable ? (
        <div className="conversation-action-confirm">
          <p>
            This action was confirmed, but its durable outcome is not available yet. Continue with
            the original confirmation receipt; this will not create a second action.
          </p>
          <Button
            variant="primary"
            disabled={busy}
            aria-label={`Continue action: ${copy.button}`}
            onClick={() => void onConfirm(action)}
          >
            {busy ? "Checking…" : "Continue action"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
