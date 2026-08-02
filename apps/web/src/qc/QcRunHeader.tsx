import type { V2ConversationPlanReviewT } from "@norns/contracts";

export function QcRunHeader({
  titleId,
  planLabel,
  attempt,
  roundEyebrow,
  roundHeading,
  status,
  stageTitle,
  description,
  waived,
  ownerLabel,
  owner,
  remainingLabel,
  remaining,
}: {
  titleId: string;
  planLabel: string;
  attempt: number;
  roundEyebrow: string;
  roundHeading: string;
  status: V2ConversationPlanReviewT["status"];
  stageTitle: string;
  description: string;
  waived: boolean;
  ownerLabel: string;
  owner: string;
  remainingLabel: string;
  remaining: string;
}): React.ReactElement {
  return (
    <>
      <header className="conversation-qc-identity">
        <span>
          {planLabel} · QC attempt {attempt}
        </span>
      </header>
      <section className="conversation-qc-round-focus" aria-labelledby={titleId}>
        <header>
          <div>
            <span className="eyebrow">{roundEyebrow}</span>
            <h3 id={titleId}>{roundHeading}</h3>
          </div>
        </header>
        <div className="conversation-qc-round-stage">
          <span className={`conversation-qc-truth-marker is-${status}`} aria-hidden="true" />
          <div>
            <strong>{stageTitle}</strong>
            <p>{description}</p>
          </div>
        </div>
        {!waived ? (
          <footer className="conversation-qc-round-summary" aria-live="polite">
            <span>
              <small>{ownerLabel}</small>
              <strong>{owner}</strong>
            </span>
            <span>
              <small>{remainingLabel}</small>
              <strong>{remaining}</strong>
            </span>
          </footer>
        ) : null}
      </section>
    </>
  );
}
