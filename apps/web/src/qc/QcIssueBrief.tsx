import type { V2ConversationPlanReviewFindingT, V2ConversationPlanReviewT } from "@norns/contracts";
import { Badge, Button } from "../ui";
import { visibleReviewFindings } from "./qcPresentation";

export function QcIssueBrief({
  review,
  onDiscussFinding,
}: {
  review: V2ConversationPlanReviewT;
  onDiscussFinding?: (finding: V2ConversationPlanReviewFindingT) => void;
}): React.ReactElement {
  const findings = visibleReviewFindings(review);
  const substantive = findings.filter((finding) => finding.severity !== "suggestion");
  const suggestions = findings.length - substantive.length;
  const resolved = review.dispositions.filter(
    (disposition) => disposition.disposition === "accept" || disposition.adjudication !== null,
  ).length;

  return (
    <section className="conversation-qc-brief" aria-label="Decision brief">
      <header>
        <div>
          <span className="eyebrow">Decision brief</span>
          <h4>
            {findings.length === 0
              ? "No changes requested"
              : `${substantive.length} substantive issue${substantive.length === 1 ? "" : "s"}`}
          </h4>
          <p>
            {findings.length === 0
              ? "The independent reviewer did not identify a revision that blocks this plan."
              : "Open an issue for the reviewer’s recommendation and the planning manager’s response."}
          </p>
        </div>
        {findings.length > 0 ? (
          <dl>
            <div>
              <dt>Resolved</dt>
              <dd>{resolved}</dd>
            </div>
            <div>
              <dt>Suggestions</dt>
              <dd>{suggestions}</dd>
            </div>
          </dl>
        ) : (
          <Badge tone="success">Clear</Badge>
        )}
      </header>
      {findings.length > 0 ? (
        <ol>
          {findings.map((finding) => {
            const disposition = review.dispositions.find(
              (candidate) =>
                candidate.finding_id === finding.id && candidate.finding_index === finding.index,
            );
            return (
              <li key={finding.id}>
                <details>
                  <summary>
                    <Badge
                      tone={
                        finding.severity === "must_fix"
                          ? "danger"
                          : finding.severity === "should_fix"
                            ? "warn"
                            : "info"
                      }
                    >
                      {finding.severity.replaceAll("_", " ")}
                    </Badge>
                    <span>
                      <strong>{finding.finding}</strong>
                      <small>
                        {finding.module_id ? `Task · ${finding.module_id}` : "Plan level"}
                      </small>
                    </span>
                    <span className="conversation-qc-brief-disposition">
                      {disposition
                        ? `PM ${disposition.disposition}`
                        : review.status === "running"
                          ? "Awaiting PM"
                          : "No response"}
                    </span>
                  </summary>
                  <div className="conversation-qc-brief-comparison">
                    <section>
                      <span>Reviewer recommends</span>
                      <p>{finding.recommendation}</p>
                    </section>
                    <section>
                      <span>Planning manager response</span>
                      <p>
                        {disposition?.rationale ?? "No planning manager response was recorded."}
                      </p>
                    </section>
                  </div>
                  {onDiscussFinding ? (
                    <Button className="btn-small" onClick={() => onDiscussFinding(finding)}>
                      Discuss in Plan
                    </Button>
                  ) : null}
                </details>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
