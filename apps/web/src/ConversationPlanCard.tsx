import type { V2WorkPlanContractT, V2WorkPlanVersionT } from "@norns/contracts";
import { type ReactNode, useState } from "react";
import { Badge } from "./ui";

const STATUS_LABELS: Record<V2WorkPlanVersionT["status"], string> = {
  candidate: "Candidate",
  in_qc: "In QC",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

function budgetLabel(plan: V2WorkPlanContractT): string {
  const { amount, currency } = plan.estimated_budget;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function badgeTone(
  status: V2WorkPlanVersionT["status"],
): "default" | "success" | "warn" | "danger" | "info" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  if (status === "changes_requested") return "warn";
  if (status === "in_qc") return "info";
  return "default";
}

function List({
  empty,
  items,
}: {
  empty: string;
  items: readonly string[];
}): React.ReactElement {
  return items.length > 0 ? (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <p className="conversation-plan-empty">{empty}</p>
  );
}

/** The added/changed/removed block for a plan version's diff against its
 *  predecessor. Reused by the QC gate card to show the v(n) -> v(n+1) diff
 *  produced at Gate B, so there is exactly one diff renderer in the app. */
export function PlanVersionDiff({
  version,
}: {
  version: V2WorkPlanVersionT;
}): React.ReactElement | null {
  if (!version.diff_from_previous) return null;
  return (
    <details className="conversation-plan-diff" open>
      <summary>Changes from version {version.version - 1}</summary>
      <div>
        <section>
          <h4>Added</h4>
          <List empty="Nothing added." items={version.diff_from_previous.added} />
        </section>
        <section>
          <h4>Changed</h4>
          <List empty="Nothing changed." items={version.diff_from_previous.changed} />
        </section>
        <section>
          <h4>Removed</h4>
          <List empty="Nothing removed." items={version.diff_from_previous.removed} />
        </section>
      </div>
    </details>
  );
}

export function ConversationPlanCard({
  version,
  footer,
  renderStaffing,
}: {
  version: V2WorkPlanVersionT;
  footer?: ReactNode;
  renderStaffing?: PlanStaffingRenderer;
}): React.ReactElement {
  return (
    <PlanCard
      plan={version.plan}
      version={version}
      cardId={version.id}
      footer={footer}
      renderStaffing={renderStaffing}
    />
  );
}

export function ConversationPlanDraftCard({
  actionId,
  plan,
}: {
  actionId: string;
  plan: V2WorkPlanContractT;
}): React.ReactElement {
  return (
    <PlanCard
      plan={plan}
      version={null}
      cardId={`draft-${actionId}`}
      footer={null}
      renderStaffing={undefined}
    />
  );
}

type PlanModule = V2WorkPlanContractT["plan"]["modules"][number];
type PlanStaffing = V2WorkPlanContractT["staffing"][number];

export type PlanStaffingRenderer = (input: {
  module: PlanModule;
  staffing: PlanStaffing | undefined;
  phaseNumber: number;
}) => ReactNode;

function sentenceCase(value: string): string {
  const normalized = value.replaceAll("_", " ").trim();
  return normalized ? `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}` : "Unknown";
}

function complexityLabel(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "s" || normalized === "small" || normalized === "low") {
    return "Low complexity";
  }
  if (normalized === "m" || normalized === "medium") return "Medium complexity";
  if (normalized === "l" || normalized === "large" || normalized === "high") {
    return "High complexity";
  }
  if (normalized === "xl" || normalized === "extra large" || normalized === "critical") {
    return "Very high complexity";
  }
  return value ? `${sentenceCase(value)} complexity` : "Complexity not estimated";
}

function PlanPhase({
  module,
  staffing,
  phaseNumber,
  renderStaffing,
}: {
  module: PlanModule;
  staffing: PlanStaffing | undefined;
  phaseNumber: number;
  renderStaffing?: PlanStaffingRenderer;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const risk = `${sentenceCase(module.risk)} risk`;
  return (
    <li className="conversation-plan-task" data-phase-tone={(phaseNumber - 1) % 5}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="conversation-plan-task-heading">
          <span className="conversation-plan-phase-number" aria-hidden="true">
            {phaseNumber}
          </span>
          <span className="conversation-plan-phase-title">
            <small>Phase {phaseNumber}</small>
            <strong>{module.title}</strong>
            <code>{module.id}</code>
          </span>
          <span className="conversation-plan-phase-toggle">
            <Badge tone={module.risk === "critical" || module.risk === "high" ? "warn" : "info"}>
              {risk}
            </Badge>
            <small>{expanded ? "Collapse" : "Expand"}</small>
          </span>
        </summary>
        <div className="conversation-plan-task-body">
          <p className="conversation-plan-task-description">{module.description}</p>
          <dl className="conversation-plan-task-meta">
            <div>
              <dt>Depends on</dt>
              <dd>{module.dependencies.join(", ") || "No dependencies"}</dd>
            </div>
            <div>
              <dt>Effort</dt>
              <dd>{complexityLabel(module.estimated_complexity)}</dd>
            </div>
          </dl>
          <section
            className="conversation-plan-agent"
            aria-label={`Implementation agent for phase ${phaseNumber}`}
          >
            <div>
              <span>Implementation agent</span>
              <small>Choose the agent that will own this phase.</small>
            </div>
            {renderStaffing ? (
              renderStaffing({ module, staffing, phaseNumber })
            ) : (
              <strong>
                {staffing
                  ? `${staffing.agent_role} · ${staffing.provider} · ${staffing.model}`
                  : "Staffing unavailable"}
              </strong>
            )}
          </section>
          <section className="conversation-plan-acceptance-section">
            <header>
              <h5>Acceptance &amp; verification</h5>
              <span>{module.acceptance.length} checks</span>
            </header>
            <ol className="conversation-plan-acceptance">
              {module.acceptance.map((criterion, criterionIndex) => (
                <li key={criterion.id}>
                  <span>
                    {phaseNumber}.{criterionIndex + 1}
                  </span>
                  <div>
                    <strong>{criterion.statement}</strong>
                    <small>
                      {sentenceCase(criterion.verification_type)} · {criterion.verification}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </details>
    </li>
  );
}

function PlanCard({
  cardId,
  plan,
  version,
  footer,
  renderStaffing,
}: {
  cardId: string;
  plan: V2WorkPlanContractT;
  version: V2WorkPlanVersionT | null;
  footer: ReactNode;
  renderStaffing: PlanStaffingRenderer | undefined;
}): React.ReactElement {
  const titleId = `conversation-plan-${cardId}`;
  const staffingByModule = new Map(plan.staffing.map((staffing) => [staffing.module_id, staffing]));
  const moduleDecisions = plan.plan.modules.flatMap((module) =>
    module.open_decisions.map((decision) => `${module.title}: ${decision}`),
  );
  const allOpenDecisions = [...plan.open_decisions, ...moduleDecisions];

  return (
    <article
      className="conversation-plan-card"
      data-testid="conversation-plan-card"
      aria-labelledby={titleId}
    >
      <header className="conversation-plan-card-header">
        <div>
          <div className="eyebrow">
            {version ? `Plan Contract · Version ${version.version}` : "Proposed Plan Contract"}
          </div>
          <h3 id={titleId}>{plan.plan.objective}</h3>
        </div>
        <div className="conversation-plan-status">
          {version ? (
            <Badge tone={badgeTone(version.status)}>{STATUS_LABELS[version.status]}</Badge>
          ) : (
            <Badge tone="warn">Not saved</Badge>
          )}
        </div>
      </header>

      <dl className="conversation-plan-summary" aria-label="Plan summary">
        <div>
          <dt>Tasks</dt>
          <dd>{plan.plan.modules.length}</dd>
        </div>
        <div>
          <dt>Acceptance checks</dt>
          <dd>
            {plan.plan.modules.reduce((total, module) => total + module.acceptance.length, 0)}
          </dd>
        </div>
        <div>
          <dt>Estimated budget</dt>
          <dd>{budgetLabel(plan)}</dd>
        </div>
      </dl>

      <section className="conversation-plan-section" aria-labelledby={`${titleId}-tasks`}>
        <h4 id={`${titleId}-tasks`}>Tasks, dependencies, and staffing</h4>
        <ol className="conversation-plan-tasks" aria-label="Plan task sequence">
          {plan.plan.modules.map((module, moduleIndex) => {
            const staffing = staffingByModule.get(module.id);
            return (
              <PlanPhase
                key={module.id}
                module={module}
                staffing={staffing}
                phaseNumber={moduleIndex + 1}
                renderStaffing={renderStaffing}
              />
            );
          })}
        </ol>
      </section>

      <div className="conversation-plan-wide-requirements">
        <section className="conversation-plan-section" aria-labelledby={`${titleId}-verification`}>
          <h4 id={`${titleId}-verification`}>Required verification</h4>
          <List
            empty="No additional verification requirements."
            items={plan.verification_requirements}
          />
        </section>
        <section className="conversation-plan-section" aria-labelledby={`${titleId}-decisions`}>
          <h4 id={`${titleId}-decisions`}>Open decisions</h4>
          <List empty="No open decisions." items={allOpenDecisions} />
        </section>
        <section className="conversation-plan-section" aria-labelledby={`${titleId}-risks`}>
          <h4 id={`${titleId}-risks`}>Risks</h4>
          {plan.plan.risks.length > 0 ? (
            <ul>
              {plan.plan.risks.map((risk) => (
                <li key={`${risk.description}:${risk.mitigation}`}>
                  <strong>{risk.description}</strong>
                  {risk.mitigation ? <span>Mitigation: {risk.mitigation}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="conversation-plan-empty">No recorded risks.</p>
          )}
        </section>
      </div>

      {version?.diff_from_previous ? (
        <PlanVersionDiff version={version} />
      ) : version ? (
        <p className="conversation-plan-first-version">Initial plan version · no prior diff</p>
      ) : (
        <p className="conversation-plan-first-version">
          Confirm “Save plan candidate” to assign an immutable version, content hash, and diff.
        </p>
      )}
      {footer ? <footer className="conversation-plan-footer">{footer}</footer> : null}
    </article>
  );
}
