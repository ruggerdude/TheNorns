import type { V2CompletionGateT, V2PhaseKnowledgeStatusT } from "@norns/contracts";
import { useEffect, useMemo, useState } from "react";
import "./KnowledgeStatusPanel.css";
import "./WorkflowSurfaces.css";
import { ApiError, UnauthorizedError } from "./auth";
import {
  type KnowledgePackageHistory,
  getPhaseCompletionGate,
  getPhaseKnowledgeStatus,
  getProjectKnowledgePackages,
} from "./knowledgeStatusApi";
import { Alert, Badge, Spinner } from "./ui";

type KnowledgeSnapshot = {
  status: V2PhaseKnowledgeStatusT | null;
  gate: V2CompletionGateT | null;
  packages: KnowledgePackageHistory[] | null;
};

function unavailableReason(reason: unknown): "missing" | "error" {
  return reason instanceof ApiError && reason.status === 404 ? "missing" : "error";
}

export function KnowledgeStatusPanel({
  projectId,
  phaseId,
  relationalPhase = null,
  onUnauthorized,
}: {
  projectId: string;
  phaseId: string | null;
  relationalPhase?: { name: string; status: string; nextAction: string } | null;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>({
    status: null,
    gate: null,
    packages: null,
  });
  const [loading, setLoading] = useState(Boolean(phaseId));
  const [availability, setAvailability] = useState<"ready" | "missing" | "partial" | "error">(
    phaseId ? "ready" : "missing",
  );

  useEffect(() => {
    let cancelled = false;
    if (!phaseId) {
      setSnapshot({ status: null, gate: null, packages: null });
      setAvailability("missing");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    void Promise.allSettled([
      getPhaseKnowledgeStatus(projectId, phaseId),
      getPhaseCompletionGate(projectId, phaseId),
      getProjectKnowledgePackages(projectId),
    ]).then((results) => {
      if (cancelled) return;
      const unauthorized = results.some(
        (result) => result.status === "rejected" && result.reason instanceof UnauthorizedError,
      );
      if (unauthorized) {
        onUnauthorized();
        setLoading(false);
        return;
      }

      const [statusResult, gateResult, packagesResult] = results;
      const next: KnowledgeSnapshot = {
        status: statusResult.status === "fulfilled" ? statusResult.value : null,
        gate: gateResult.status === "fulfilled" ? gateResult.value : null,
        packages: packagesResult.status === "fulfilled" ? packagesResult.value : null,
      };
      const failures = results.filter((result) => result.status === "rejected");
      const statusMissing =
        statusResult.status === "rejected" && unavailableReason(statusResult.reason) === "missing";
      const gateMissing =
        gateResult.status === "rejected" && unavailableReason(gateResult.reason) === "missing";
      const packagesEmpty =
        (packagesResult.status === "fulfilled" && packagesResult.value.length === 0) ||
        (packagesResult.status === "rejected" &&
          unavailableReason(packagesResult.reason) === "missing");
      const allMissing = statusMissing && gateMissing && packagesEmpty;
      setSnapshot(next);
      setAvailability(
        allMissing
          ? "missing"
          : next.status || next.gate || next.packages
            ? failures.length > 0
              ? "partial"
              : "ready"
            : "error",
      );
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, phaseId, onUnauthorized]);

  const packageCoverage = useMemo(() => {
    const relevant =
      snapshot.packages?.filter(
        (entry) =>
          entry.package.scope_kind === "project" ||
          (entry.package.scope_kind === "phase" && entry.package.scope_id === phaseId),
      ) ?? [];
    const covered = relevant.filter((entry) =>
      entry.versions.some(
        (version) => version.status === "active" || version.status === "approved",
      ),
    );
    return { relevant, covered };
  }, [snapshot.packages, phaseId]);

  const handoffTotal =
    (snapshot.status?.completed.length ?? 0) + (snapshot.status?.in_progress.length ?? 0);
  const conflictCheck = snapshot.gate?.checks.find((check) => check.id === "integration");

  return (
    <details className="card side-section" open data-testid="knowledge-status-panel">
      <summary>Knowledge / QC Status</summary>
      <div className="side-body form-stack">
        {!phaseId && relationalPhase ? (
          <div className="empty" data-testid="knowledge-status-relational">
            <div>
              <div className="empty-icon">◇</div>
              <strong>{relationalPhase.name}</strong>
              <p>
                {relationalPhase.status}. {relationalPhase.nextAction}. Knowledge and
                quality-control evidence will appear after this work has a durable coding phase.
              </p>
            </div>
          </div>
        ) : !phaseId ? (
          <div className="empty" data-testid="knowledge-status-empty">
            <div>
              <div className="empty-icon">◇</div>
              <strong>No phase selected</strong>
              <p>Knowledge and quality-control status will appear after a phase exists.</p>
            </div>
          </div>
        ) : loading ? (
          <output aria-live="polite">
            <Spinner label="Loading knowledge and QC status…" />
          </output>
        ) : availability === "missing" ? (
          <div className="empty" data-testid="knowledge-status-unavailable">
            <div>
              <div className="empty-icon">◇</div>
              <strong>Knowledge status is not available yet</strong>
              <p>
                This phase has not started reporting knowledge packages, heartbeats, handoffs, or
                completion gates.
              </p>
            </div>
          </div>
        ) : availability === "error" ? (
          <Alert testId="knowledge-status-error">
            Knowledge and QC status could not be loaded. The phase itself is unaffected.
          </Alert>
        ) : (
          <>
            <div className="section-head knowledge-status-head">
              <div>
                <div className="eyebrow">Read-only phase evidence</div>
                <h3>{snapshot.status?.next_milestone || "Quality-control readiness"}</h3>
              </div>
              <Badge
                tone={
                  snapshot.status?.overall_status === "red"
                    ? "danger"
                    : snapshot.status?.overall_status === "yellow"
                      ? "warn"
                      : snapshot.gate?.passed
                        ? "success"
                        : "info"
                }
              >
                {snapshot.status?.overall_status
                  ? `${snapshot.status.overall_status} status`
                  : snapshot.gate?.passed
                    ? "Gate passed"
                    : "Status partial"}
              </Badge>
            </div>

            {availability === "partial" ? (
              <Alert testId="knowledge-status-partial">
                Some knowledge evidence is not available yet. The information below is the latest
                confirmed status.
              </Alert>
            ) : null}

            <div className="knowledge-status-summary">
              <div className="knowledge-status-stat" data-testid="knowledge-package-coverage">
                <strong>
                  {packageCoverage.relevant.length
                    ? `${packageCoverage.covered.length}/${packageCoverage.relevant.length}`
                    : "None"}
                </strong>
                <span>
                  {packageCoverage.relevant.length
                    ? "packages approved or active"
                    : "knowledge packages registered"}
                </span>
              </div>
              <div className="knowledge-status-stat" data-testid="knowledge-gate-summary">
                <strong>
                  {snapshot.gate?.passed ? "Passed" : snapshot.gate ? "Blocked" : "—"}
                </strong>
                <span>phase completion gate</span>
              </div>
              <div className="knowledge-status-stat" data-testid="knowledge-handoff-summary">
                <strong>
                  {snapshot.status?.completed.length ?? 0}/{handoffTotal}
                </strong>
                <span>completed task handoffs</span>
              </div>
              <div className="knowledge-status-stat" data-testid="knowledge-heartbeat-summary">
                <strong>{snapshot.status?.missing_heartbeat_run_ids.length ?? 0}</strong>
                <span>missing agent heartbeats</span>
              </div>
            </div>

            <div className="knowledge-status-grid">
              <section className="knowledge-status-group" aria-labelledby="knowledge-gates-title">
                <h4 id="knowledge-gates-title">Completion gates</h4>
                {snapshot.gate?.checks.length ? (
                  <ul className="knowledge-gate-checks">
                    {snapshot.gate.checks.map((check) => (
                      <li key={check.id}>
                        <strong>{check.passed ? "✓" : "!"}</strong>
                        <span>{check.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No completion-gate evaluation is available yet.</p>
                )}
              </section>

              <section
                className="knowledge-status-group"
                aria-labelledby="knowledge-handoffs-title"
              >
                <h4 id="knowledge-handoffs-title">Handoffs and conflicts</h4>
                <ul className="knowledge-status-list">
                  <li>
                    {snapshot.status?.completed.length ?? 0} completed handoff
                    {(snapshot.status?.completed.length ?? 0) === 1 ? "" : "s"}
                  </li>
                  {(snapshot.status?.completed ?? []).map((task) => (
                    <li key={`completed-${task}`}>{task}: handoff completed</li>
                  ))}
                  {(snapshot.status?.in_progress ?? []).map((task) => (
                    <li key={`pending-${task}`}>{task}: handoff pending</li>
                  ))}
                  <li>
                    {conflictCheck
                      ? conflictCheck.passed
                        ? "No unresolved integration conflicts"
                        : "Integration conflicts need attention"
                      : "Conflict evaluation is not available yet"}
                  </li>
                  {(snapshot.status?.missing_heartbeat_run_ids ?? []).map((runId) => (
                    <li key={runId}>Missing heartbeat: {runId}</li>
                  ))}
                </ul>
              </section>

              <section
                className="knowledge-status-group"
                aria-labelledby="knowledge-packages-title"
              >
                <h4 id="knowledge-packages-title">Knowledge packages</h4>
                {packageCoverage.relevant.length ? (
                  <ul className="knowledge-status-list">
                    {packageCoverage.relevant.map((entry) => {
                      const latest = entry.versions.at(-1);
                      return (
                        <li key={entry.package.id}>
                          {entry.package.name}:{" "}
                          {latest?.status.replaceAll("_", " ") ?? "no version"}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted">
                    No project or phase knowledge packages are registered yet.
                  </p>
                )}
              </section>

              <StatusList
                title="Blockers"
                items={snapshot.status?.blockers ?? snapshot.gate?.blockers ?? []}
                empty="No blockers reported."
              />
              <StatusList
                title="Risks and decisions"
                items={[
                  ...(snapshot.status?.risks ?? []),
                  ...(snapshot.status?.decisions_required ?? []).map(
                    (decision) => `Decision: ${decision}`,
                  ),
                ]}
                empty="No risks or decisions reported."
              />
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function StatusList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}): React.ReactElement {
  const id = `knowledge-${title.toLowerCase().replaceAll(" ", "-")}`;
  const uniqueItems = [...new Set(items)];
  return (
    <section className="knowledge-status-group" aria-labelledby={id}>
      <h4 id={id}>{title}</h4>
      {uniqueItems.length ? (
        <ul className="knowledge-status-list">
          {uniqueItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </section>
  );
}
