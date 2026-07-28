import { V2ProjectDashboard, type V2ProjectDashboardT } from "@norns/contracts";
import { useCallback, useEffect, useState } from "react";
import { ArtifactImage, openAuthenticatedArtifact } from "./ArtifactImage";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Spinner } from "./ui";
import "./ProjectOperationsDashboard.css";

type DashboardSection = V2ProjectDashboardT[keyof Omit<
  V2ProjectDashboardT,
  "schema_version" | "project_id" | "generated_at"
>];

function formatMoney(value: number | null): string {
  return value === null
    ? "Unavailable"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function SectionUnavailable({
  title,
  section,
}: {
  title: string;
  section: Extract<DashboardSection, { availability: "unavailable" }>;
}): React.ReactElement {
  return (
    <section className="operations-section operations-unavailable" aria-label={title}>
      <div className="operations-section-heading">
        <h3>{title}</h3>
        <Badge tone="warn">Unavailable</Badge>
      </div>
      <p>{section.detail ?? "The authoritative source could not be read."}</p>
      <small>
        Source: {section.source} · {section.retryable ? "Retryable" : "Not currently retryable"} ·{" "}
        {section.reason_code}
      </small>
    </section>
  );
}

function EmptyState({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="operations-empty">{children}</p>;
}

export function ProjectOperationsDashboard({
  projectId,
  onUnauthorized,
  onOpenLegacyPlanningRun,
}: {
  projectId: string;
  onUnauthorized: () => void;
  onOpenLegacyPlanningRun: (planningRunId: string) => void;
}): React.ReactElement | null {
  const [dashboard, setDashboard] = useState<V2ProjectDashboardT | null>(null);
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v2/projects/${encodeURIComponent(projectId)}/dashboard`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (response.status === 401) throw new UnauthorizedError();
      if (response.status === 404) {
        setUnsupported(true);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new ApiError(
          body.message ?? body.error ?? `Dashboard request failed: ${response.status}`,
          response.status,
          body.error ?? null,
        );
      }
      setDashboard(V2ProjectDashboard.parse(body));
      setUnsupported(false);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (unsupported) return null;
  if (loading && dashboard === null) {
    return (
      <section className="card project-operations-dashboard" aria-label="Project operations">
        <Spinner label="Loading project operations…" />
      </section>
    );
  }
  if (error && dashboard === null) {
    return (
      <section className="card project-operations-dashboard" aria-label="Project operations">
        <Alert testId="project-operations-error">{error}</Alert>
        <Button onClick={() => void load()}>Retry project operations</Button>
      </section>
    );
  }
  if (!dashboard) return null;

  const planningConversations =
    dashboard.conversations.availability === "available"
      ? dashboard.conversations.data.filter((conversation) => conversation.kind === "planning")
      : [];
  const executionConversations =
    dashboard.conversations.availability === "available"
      ? dashboard.conversations.data.filter((conversation) => conversation.kind !== "planning")
      : [];

  return (
    <section
      className="card project-operations-dashboard"
      aria-labelledby="project-operations-title"
      data-testid="project-operations-dashboard"
    >
      <header className="operations-header">
        <div>
          <span className="eyebrow">Authoritative project read model</span>
          <h2 id="project-operations-title">Project operations</h2>
          <p>Generated {formatTime(dashboard.generated_at)}</p>
        </div>
        <Button className="btn-small" disabled={loading} onClick={() => void load()}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>
      {error ? <Alert testId="project-operations-refresh-error">{error}</Alert> : null}

      <div className="operations-grid">
        {dashboard.active_work.availability === "unavailable" ? (
          <SectionUnavailable title="Active work and progress" section={dashboard.active_work} />
        ) : (
          <section className="operations-section" aria-labelledby="operations-active-work">
            <div className="operations-section-heading">
              <h3 id="operations-active-work">Active work and progress</h3>
              <Badge tone="info">{dashboard.active_work.data.length}</Badge>
            </div>
            {dashboard.active_work.data.length === 0 ? (
              <EmptyState>No active work is recorded.</EmptyState>
            ) : (
              <ul className="operations-list">
                {dashboard.active_work.data.map(
                  ({ work_item: workItem, phase_progress: progress, deep_link: deepLink }) => (
                    <li key={workItem.id}>
                      {deepLink ? (
                        <a href={deepLink} aria-label={`Open work item ${workItem.title}`}>
                          <strong>{workItem.title}</strong>
                        </a>
                      ) : (
                        <strong>{workItem.title}</strong>
                      )}
                      <span>{workItem.status.replaceAll("_", " ")}</span>
                      {progress ? (
                        <>
                          <div
                            className="operations-progress"
                            role="progressbar"
                            aria-label={`${workItem.title} progress`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={progress.percent_complete}
                            tabIndex={0}
                          >
                            <span style={{ width: `${progress.percent_complete}%` }} />
                          </div>
                          <small>
                            {progress.percent_complete}% · {progress.tasks_completed}/
                            {progress.tasks_total} tasks
                          </small>
                        </>
                      ) : (
                        <small>Task progress is not available yet.</small>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
            <small>Source: {dashboard.active_work.source}</small>
          </section>
        )}

        {dashboard.needs_attention.availability === "unavailable" ? (
          <SectionUnavailable title="Status" section={dashboard.needs_attention} />
        ) : (
          <section
            className="operations-section is-attention"
            aria-labelledby="operations-attention"
          >
            <div className="operations-section-heading">
              <h3 id="operations-attention">Status</h3>
              <Badge tone={dashboard.needs_attention.data.length > 0 ? "danger" : "success"}>
                {dashboard.needs_attention.data.length}
              </Badge>
            </div>
            {dashboard.needs_attention.data.length === 0 ? (
              <EmptyState>
                No human waits, mockup reviews, or failed collections need you.
              </EmptyState>
            ) : (
              <ul className="operations-list">
                {dashboard.needs_attention.data.map((item) => (
                  <li key={item.key}>
                    <div>
                      {item.deep_link ? (
                        <a href={item.deep_link}>
                          <strong>{item.title}</strong>
                        </a>
                      ) : (
                        <strong>{item.title}</strong>
                      )}
                      <Badge tone={item.severity === "critical" ? "danger" : "warn"}>
                        {item.source_type.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <p>{item.summary}</p>
                    <small>{formatTime(item.occurred_at)}</small>
                  </li>
                ))}
              </ul>
            )}
            <small>Source: {dashboard.needs_attention.source}</small>
          </section>
        )}

        {dashboard.open_decisions.availability === "unavailable" ? (
          <SectionUnavailable
            title="Open decisions and blockers"
            section={dashboard.open_decisions}
          />
        ) : (
          <section className="operations-section" aria-labelledby="operations-decisions">
            <div className="operations-section-heading">
              <h3 id="operations-decisions">Open decisions and blockers</h3>
              <Badge tone={dashboard.open_decisions.data.length > 0 ? "warn" : "success"}>
                {dashboard.open_decisions.data.length}
              </Badge>
            </div>
            {dashboard.open_decisions.data.length === 0 ? (
              <EmptyState>No open decisions or blockers are recorded.</EmptyState>
            ) : (
              <ul className="operations-list">
                {dashboard.open_decisions.data.map((decision) => (
                  <li key={decision.id}>
                    {decision.deep_link ? (
                      <a href={decision.deep_link}>
                        <strong>{decision.title}</strong>
                      </a>
                    ) : (
                      <strong>{decision.title}</strong>
                    )}
                    <p>{decision.detail}</p>
                    <small>
                      {decision.source_type.replaceAll("_", " ")} ·{" "}
                      {decision.status.replaceAll("_", " ")}
                    </small>
                  </li>
                ))}
              </ul>
            )}
            <small>Source: {dashboard.open_decisions.source}</small>
          </section>
        )}

        {dashboard.budget.availability === "unavailable" ? (
          <SectionUnavailable title="Spend and projected budget" section={dashboard.budget} />
        ) : (
          <section className="operations-section" aria-labelledby="operations-budget">
            <div className="operations-section-heading">
              <h3 id="operations-budget">Spend and projected budget</h3>
            </div>
            <dl className="operations-metrics">
              <div>
                <dt>Current spend</dt>
                <dd>{formatMoney(dashboard.budget.data.current_spend_usd)}</dd>
              </div>
              <div>
                <dt>Projected budget</dt>
                <dd>{formatMoney(dashboard.budget.data.projected_budget_usd)}</dd>
              </div>
            </dl>
            <small>
              Source: {dashboard.budget.source} ·{" "}
              {dashboard.budget.data.projection_source.replaceAll("_", " ")}
            </small>
          </section>
        )}

        <section className="operations-section" aria-labelledby="operations-deliveries">
          <div className="operations-section-heading">
            <h3 id="operations-deliveries">Deployments and verification</h3>
          </div>
          {dashboard.recent_deployments.availability === "unavailable" ? (
            <p className="operations-inline-unavailable">
              Deployments unavailable · {dashboard.recent_deployments.reason_code}
            </p>
          ) : dashboard.recent_deployments.data.length === 0 ? (
            <EmptyState>No deployment observations are recorded.</EmptyState>
          ) : (
            <ul className="operations-list">
              {dashboard.recent_deployments.data.map((deploymentEntry) => {
                const deployment = deploymentEntry.deployment;
                return (
                  <li key={deployment.id}>
                    <div>
                      {deploymentEntry.deep_link ? (
                        <a href={deploymentEntry.deep_link}>
                          <strong>{deployment.service}</strong>
                        </a>
                      ) : (
                        <strong>{deployment.service}</strong>
                      )}
                      <Badge tone={deployment.status === "succeeded" ? "success" : "info"}>
                        {deployment.status}
                      </Badge>
                    </div>
                    <code title={deployment.commit_sha}>{deployment.commit_sha.slice(0, 12)}</code>
                    {deployment.public_url ? (
                      <a href={deployment.public_url} target="_blank" rel="noreferrer">
                        Open live application
                      </a>
                    ) : (
                      <small>No public URL is recorded.</small>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {dashboard.recent_verification.availability === "unavailable" ? (
            <p className="operations-inline-unavailable">
              Verification unavailable · {dashboard.recent_verification.reason_code}
            </p>
          ) : dashboard.recent_verification.data.length === 0 ? (
            <EmptyState>No verification results are recorded.</EmptyState>
          ) : (
            <ul className="operations-list operations-verification">
              {dashboard.recent_verification.data.map((verification) => (
                <li key={verification.id}>
                  <div>
                    {verification.deep_link ? (
                      <a href={verification.deep_link}>
                        <strong>Task {verification.task_id}</strong>
                      </a>
                    ) : (
                      <strong>Task {verification.task_id}</strong>
                    )}
                    <Badge tone={verification.passed ? "success" : "danger"}>
                      {verification.passed ? "Passed" : "Failed"}
                    </Badge>
                  </div>
                  <code title={verification.commit_sha}>
                    {verification.commit_sha.slice(0, 12)}
                  </code>
                  <small>{verification.evidence.length} evidence artifact(s)</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        {dashboard.conversations.availability === "unavailable" ? (
          <SectionUnavailable
            title="Planning and execution conversations"
            section={dashboard.conversations}
          />
        ) : (
          <section className="operations-section" aria-labelledby="operations-conversations">
            <div className="operations-section-heading">
              <h3 id="operations-conversations">Planning and execution conversations</h3>
            </div>
            {dashboard.conversations.data.length === 0 ? (
              <EmptyState>No work conversations are recorded.</EmptyState>
            ) : (
              <div className="operations-conversation-groups">
                <div>
                  <strong>Planning</strong>
                  {planningConversations.length === 0 ? (
                    <small>No planning conversations.</small>
                  ) : (
                    planningConversations.map((conversation) => (
                      <a
                        key={conversation.id}
                        href={`/projects/${encodeURIComponent(projectId)}/work/${encodeURIComponent(
                          conversation.id,
                        )}`}
                      >
                        Open planning · {conversation.status}
                      </a>
                    ))
                  )}
                </div>
                <div>
                  <strong>Execution</strong>
                  {executionConversations.length === 0 ? (
                    <small>No execution conversations.</small>
                  ) : (
                    executionConversations.map((conversation) => (
                      <a
                        key={conversation.id}
                        href={`/projects/${encodeURIComponent(projectId)}/work/${encodeURIComponent(
                          conversation.id,
                        )}`}
                      >
                        Open {conversation.kind === "task" ? "task" : "execution PM"} ·{" "}
                        {conversation.status}
                      </a>
                    ))
                  )}
                </div>
              </div>
            )}
            <small>Source: {dashboard.conversations.source}</small>
          </section>
        )}

        <section
          className="operations-section operations-artifacts"
          aria-labelledby="operations-artifacts"
        >
          <div className="operations-section-heading">
            <h3 id="operations-artifacts">Approved mockups and recent artifacts</h3>
          </div>
          {dashboard.approved_mockups.availability === "unavailable" ? (
            <p className="operations-inline-unavailable">
              Approved mockups unavailable · {dashboard.approved_mockups.reason_code}
            </p>
          ) : dashboard.approved_mockups.data.length === 0 ? (
            <EmptyState>No approved mockups are recorded.</EmptyState>
          ) : (
            <div className="operations-mockup-strip">
              {dashboard.approved_mockups.data.map((mockup) => (
                <article key={mockup.id}>
                  <ArtifactImage
                    projectId={projectId}
                    artifactId={mockup.screenshots[0].artifact.artifact_id}
                    alt={`Approved mockup version ${mockup.version} desktop`}
                    onUnauthorized={onUnauthorized}
                  />
                  <a
                    href={`/projects/${encodeURIComponent(projectId)}/work/${encodeURIComponent(
                      mockup.conversation_id,
                    )}`}
                  >
                    <strong>Mockup v{mockup.version}</strong>
                  </a>
                  <code title={mockup.manifest.content_hash}>
                    {mockup.manifest.content_hash.slice(0, 12)}
                  </code>
                </article>
              ))}
            </div>
          )}
          {dashboard.recent_artifacts.availability === "unavailable" ? (
            <p className="operations-inline-unavailable">
              Recent artifacts unavailable · {dashboard.recent_artifacts.reason_code}
            </p>
          ) : dashboard.recent_artifacts.data.length === 0 ? (
            <EmptyState>No recent artifacts are recorded.</EmptyState>
          ) : (
            <ul className="operations-list">
              {dashboard.recent_artifacts.data.map((summary) => (
                <li key={summary.artifact.artifact_id}>
                  <button
                    type="button"
                    className="operations-artifact-link"
                    onClick={() => {
                      setError(null);
                      void openAuthenticatedArtifact(
                        projectId,
                        summary.artifact.artifact_id,
                        onUnauthorized,
                      ).catch((caught: unknown) =>
                        setError(caught instanceof Error ? caught.message : String(caught)),
                      );
                    }}
                  >
                    <strong>{summary.artifact.label}</strong>
                  </button>
                  <span>{summary.kind.replaceAll("_", " ")}</span>
                  <code title={summary.artifact.content_hash}>
                    {summary.artifact.content_hash.slice(0, 12)}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </section>

        {dashboard.legacy_planning_runs.availability === "unavailable" ? (
          <SectionUnavailable
            title="Legacy planning runs"
            section={dashboard.legacy_planning_runs}
          />
        ) : (
          <section className="operations-section" aria-labelledby="operations-legacy">
            <div className="operations-section-heading">
              <h3 id="operations-legacy">Legacy planning runs</h3>
              <Badge tone="info">Legacy</Badge>
            </div>
            {dashboard.legacy_planning_runs.data.length === 0 ? (
              <EmptyState>No legacy planning runs are recorded.</EmptyState>
            ) : (
              <ul className="operations-list">
                {dashboard.legacy_planning_runs.data.map((run) => (
                  <li key={run.id}>
                    <strong>{run.label}</strong>
                    <span>{run.status}</span>
                    {run.content_hash ? (
                      <code title={run.content_hash}>{run.content_hash.slice(0, 12)}</code>
                    ) : (
                      <small>No content hash is recorded.</small>
                    )}
                    <Button className="btn-small" onClick={() => onOpenLegacyPlanningRun(run.id)}>
                      Open legacy run
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <small>Source: {dashboard.legacy_planning_runs.source}</small>
          </section>
        )}
      </div>
    </section>
  );
}
