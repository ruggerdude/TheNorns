import type {
  V2ApprovePlanParametersT,
  V2ConversationActionT,
  V2ConversationPlanActionEffectValueT,
  V2RejectPlanParametersT,
  V2RequestPlanChangesParametersT,
  V2SavePlanCandidateParametersT,
  V2SendPlanToQcParametersT,
} from "@norns/contracts";
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
    description: "Start a cross-provider review of this exact plan version and content hash.",
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

function DeliveryStatus({ action }: { action: V2ConversationActionT }): React.ReactElement {
  const activeIndex = DELIVERY_STEPS.findIndex((step) => step.status === action.status);
  return (
    <div className="conversation-action-delivery">
      <strong>Delivery status</strong>
      <ol
        aria-label={`${PLAN_ACTIONS[action.action_type as PlanActionType]?.title ?? "Action"} delivery`}
      >
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
    </div>
  );
}

function EffectNotice({
  effect,
  projectId,
}: {
  effect: V2ConversationPlanActionEffectValueT;
  projectId: string;
}): React.ReactElement {
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
      {execution.status === "refused" || execution.status === "failed" ? (
        <a href={`/projects/${encodeURIComponent(projectId)}`}>Open project recovery</a>
      ) : null}
    </output>
  );
}

export function ConversationActionCard({
  action,
  busy,
  effect,
  error,
  onConfirm,
}: {
  action: V2ConversationActionT;
  busy: boolean;
  effect: V2ConversationPlanActionEffectValueT | null;
  error: string | null;
  onConfirm: (action: V2ConversationActionT) => Promise<void>;
}): React.ReactElement {
  if (!isPlanAction(action)) {
    return (
      <article className="conversation-action-card" data-testid="conversation-action-card">
        <strong>Action</strong>
        <p>{action.action_type.replaceAll("_", " ")}</p>
        <DeliveryStatus action={action} />
      </article>
    );
  }

  const copy = PLAN_ACTIONS[action.action_type];
  const reference = targetReference(action);
  const parameters = action.payload.parameters;
  const saveParameters =
    action.action_type === "save_plan_candidate"
      ? (parameters as V2SavePlanCandidateParametersT)
      : null;
  const direction =
    action.action_type === "request_plan_changes"
      ? (parameters as V2RequestPlanChangesParametersT).direction
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
          <div className="eyebrow">Explicit project action</div>
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

      <DeliveryStatus action={action} />
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
