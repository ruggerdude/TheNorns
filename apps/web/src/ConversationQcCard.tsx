import type {
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { Badge } from "./ui";

const SEVERITIES = [
  { value: "must_fix", label: "Must fix", tone: "danger" },
  { value: "should_fix", label: "Should fix", tone: "warn" },
  { value: "suggestion", label: "Suggestions", tone: "info" },
] as const;

function statusTone(
  status: V2ConversationPlanReviewT["status"],
): "default" | "success" | "warn" | "danger" | "info" {
  if (status === "converged") return "success";
  if (status === "failed") return "danger";
  if (status === "cap_reached") return "warn";
  return "info";
}

function Finding({
  finding,
  review,
}: {
  finding: V2ConversationPlanReviewFindingT;
  review: V2ConversationPlanReviewT;
}): React.ReactElement {
  const disposition = review.dispositions.find(
    (candidate) => candidate.finding_id === finding.id && candidate.finding_index === finding.index,
  );
  return (
    <li className="conversation-qc-finding">
      <div>
        <strong>{finding.finding}</strong>
        {finding.module_id ? <code>Task · {finding.module_id}</code> : <code>Plan level</code>}
      </div>
      <p>
        <strong>Reviewer recommendation:</strong> {finding.recommendation}
      </p>
      {disposition ? (
        <div className="conversation-qc-disposition">
          <Badge tone={disposition.disposition === "accept" ? "success" : "warn"}>
            PM {disposition.disposition}
          </Badge>
          <p>{disposition.rationale}</p>
        </div>
      ) : (
        <p className="conversation-qc-pending-disposition">Awaiting PM disposition.</p>
      )}
    </li>
  );
}

export function ConversationQcCard({
  planVersion,
  review,
}: {
  planVersion: V2WorkPlanVersionT | null;
  review: V2ConversationPlanReviewT;
}): React.ReactElement {
  const titleId = `conversation-qc-${review.id}`;
  const terminal = ["converged", "cap_reached", "failed"].includes(review.status);

  return (
    <article
      className="conversation-qc-card"
      data-testid="conversation-qc-card"
      aria-labelledby={titleId}
    >
      <header>
        <div>
          <div className="eyebrow">Cross-provider QC · Attempt {review.attempt_number}</div>
          <h3 id={titleId}>
            Plan {planVersion ? `version ${planVersion.version}` : review.plan_version_id}
          </h3>
        </div>
        <Badge tone={statusTone(review.status)}>{review.status.replaceAll("_", " ")}</Badge>
      </header>

      <dl className="conversation-qc-summary">
        <div>
          <dt>Exact reviewed hash</dt>
          <dd>
            <code title={review.plan_content_hash}>{review.plan_content_hash.slice(0, 10)}</code>
          </dd>
        </div>
        <div>
          <dt>PM</dt>
          <dd>
            {review.pm_provider} · {review.pm_model}
          </dd>
        </div>
        <div>
          <dt>Reviewer</dt>
          <dd>
            {review.reviewer_provider} · {review.reviewer_model}
          </dd>
        </div>
        <div>
          <dt>Context receipt</dt>
          <dd>
            <code title={review.context_manifest.context_hash}>
              {review.context_manifest.context_hash.slice(0, 10)}
            </code>
          </dd>
        </div>
      </dl>

      {!terminal ? (
        <output className="conversation-qc-progress" aria-live="polite">
          QC is {review.status}. Findings and PM dispositions will appear here after the review
          settles.
        </output>
      ) : null}
      {review.status === "failed" ? (
        <output className="conversation-qc-failure" role="alert">
          QC failed · {review.failure_code}. The unchanged plan remains a candidate and can be sent
          to QC again.
        </output>
      ) : null}

      {SEVERITIES.map((severity) => {
        const findings = review.findings.filter((finding) => finding.severity === severity.value);
        if (findings.length === 0) return null;
        return (
          <section
            className={`conversation-qc-group is-${severity.value}`}
            key={severity.value}
            aria-labelledby={`${titleId}-${severity.value}`}
          >
            <div>
              <h4 id={`${titleId}-${severity.value}`}>{severity.label}</h4>
              <Badge tone={severity.tone}>{findings.length}</Badge>
            </div>
            <ol>
              {findings.map((finding) => (
                <Finding key={finding.id} finding={finding} review={review} />
              ))}
            </ol>
          </section>
        );
      })}

      {terminal && review.findings.length === 0 && review.status !== "failed" ? (
        <p className="conversation-qc-clear">
          QC returned no findings for this exact plan version.
        </p>
      ) : null}
      {review.revised_plan_version_id ? (
        <p className="conversation-qc-revision">
          PM revision saved as plan reference <code>{review.revised_plan_version_id}</code>.
        </p>
      ) : null}
    </article>
  );
}
