import type { V2WorkPlanContractT, V2WorkPlanVersionT } from "@norns/contracts";
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
}: {
  version: V2WorkPlanVersionT;
}): React.ReactElement {
  return <PlanCard plan={version.plan} version={version} cardId={version.id} />;
}

export function ConversationPlanDraftCard({
  actionId,
  plan,
}: {
  actionId: string;
  plan: V2WorkPlanContractT;
}): React.ReactElement {
  return <PlanCard plan={plan} version={null} cardId={`draft-${actionId}`} />;
}

function PlanCard({
  cardId,
  plan,
  version,
}: {
  cardId: string;
  plan: V2WorkPlanContractT;
  version: V2WorkPlanVersionT | null;
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
            <>
              <Badge tone={badgeTone(version.status)}>{STATUS_LABELS[version.status]}</Badge>
              <code title={version.content_hash}>{version.content_hash.slice(0, 10)}</code>
            </>
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
          {plan.plan.modules.map((module) => {
            const staffing = staffingByModule.get(module.id);
            return (
              <li key={module.id} className="conversation-plan-task">
                <div className="conversation-plan-task-heading">
                  <div>
                    <strong>{module.title}</strong>
                    <code>{module.id}</code>
                  </div>
                  <Badge
                    tone={module.risk === "critical" || module.risk === "high" ? "warn" : "info"}
                  >
                    {module.estimated_complexity} · {module.risk} risk
                  </Badge>
                </div>
                <p>{module.description}</p>
                <dl className="conversation-plan-task-meta">
                  <div>
                    <dt>Depends on</dt>
                    <dd>{module.dependencies.join(", ") || "No dependencies"}</dd>
                  </div>
                  <div>
                    <dt>Assigned to</dt>
                    <dd>
                      {staffing
                        ? `${staffing.agent_role} · ${staffing.provider} · ${staffing.model}`
                        : "Staffing unavailable"}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>Acceptance and verification ({module.acceptance.length})</summary>
                  <ul className="conversation-plan-acceptance">
                    {module.acceptance.map((criterion) => (
                      <li key={criterion.id}>
                        <strong>{criterion.statement}</strong>
                        <span>
                          {criterion.verification_type} · {criterion.verification}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="conversation-plan-columns">
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
    </article>
  );
}
