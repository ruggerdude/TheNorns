import { useState } from "react";
import { Badge, Button, Field, Input, Select } from "./ui";

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  verification_type: "test" | "command" | "inspection" | "human";
  verification: string;
}
export interface PlanModule {
  id: string;
  title: string;
  acceptance: AcceptanceCriterion[];
  dependencies: string[];
  estimated_complexity?: string;
  risk?: string;
  [key: string]: unknown;
}
export interface PlanLike {
  objective: string;
  modules: PlanModule[];
  [key: string]: unknown;
}

/** What App.tsx gets back from a live-planning round: the plan itself plus
 * the QC loop's outcome (did it converge, how many rounds, what it cost, and
 * — if it hit the round cap — the must-fix findings the reviewer still had).
 * `outstanding` is already pre-filtered server-side to must-fix items only. */
export interface PlanReviewResult {
  status: "converged" | "cap_reached";
  rounds: number;
  plan: PlanLike;
  content_hash: string;
  total_cost_usd: number;
  outstanding: { statement: string }[];
}

/** A module blocks commit if it has zero criteria, or any criterion has a
 * blank statement/verification. `.length === 0` is checked explicitly
 * because `.some()` on an empty array is vacuously false and would silently
 * let a zero-criteria module through (UI-4). */
function blockingIssueCount(m: PlanModule): number {
  if (m.acceptance.length === 0) return 1;
  return m.acceptance.filter((c) => !c.statement.trim() || !c.verification.trim()).length;
}

export function PlanReview({
  result,
  onCommit,
  onCancel,
  committing,
}: {
  result: PlanReviewResult;
  onCommit: (p: PlanLike) => void;
  onCancel: () => void;
  committing: boolean;
}): React.ReactElement {
  const { plan, status, rounds, total_cost_usd, content_hash, outstanding } = result;
  const capped = status === "cap_reached";
  const [modules, setModules] = useState(plan.modules);
  const update = (mi: number, ci: number, patch: Partial<AcceptanceCriterion>) =>
    setModules((p) =>
      p.map((m, i) =>
        i !== mi
          ? m
          : { ...m, acceptance: m.acceptance.map((c, j) => (j !== ci ? c : { ...c, ...patch })) },
      ),
    );
  const remove = (mi: number, ci: number) =>
    setModules((p) =>
      p.map((m, i) =>
        i !== mi ? m : { ...m, acceptance: m.acceptance.filter((_, j) => j !== ci) },
      ),
    );
  const add = (mi: number) =>
    setModules((p) =>
      p.map((m, i) =>
        i !== mi
          ? m
          : {
              ...m,
              acceptance: [
                ...m.acceptance,
                {
                  id: `ac-${Date.now()}`,
                  statement: "",
                  verification_type: "test",
                  verification: "",
                },
              ],
            },
      ),
    );
  const anyBlockingIssues = modules.some((m) => blockingIssueCount(m) > 0);

  return (
    <div data-testid="plan-review">
      <div
        className={`plan-status-banner ${capped ? "plan-status-capped" : "plan-status-converged"}`}
        data-testid="plan-status"
      >
        <span aria-hidden="true">{capped ? "⚠" : "✓"}</span>
        <span>{capped ? "Round cap reached — plan did not converge" : "Converged"}</span>
        <Badge tone={capped ? "danger" : "success"}>{status}</Badge>
      </div>
      <div className="plan-meta-strip">
        <span>
          Rounds: <strong className="mono">{rounds}</strong>
        </span>
        <span>
          Review cost: <strong className="mono">${total_cost_usd.toFixed(2)}</strong>
        </span>
      </div>
      <div className="meta mono" data-testid="plan-content-hash">
        plan hash: {content_hash}
      </div>

      {outstanding.length > 0 ? (
        <div className="card outstanding-panel" data-testid="outstanding-findings">
          <strong>
            {capped
              ? "Outstanding findings — why this plan didn't converge"
              : "Outstanding findings"}
          </strong>
          {outstanding.map((f) => (
            <div className="outstanding-item" key={f.statement}>
              {f.statement}
            </div>
          ))}
        </div>
      ) : null}

      {capped ? (
        <div className="actions">
          <Button onClick={onCancel} disabled={committing}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <p className="muted">
            Review every acceptance criterion. Nothing enters the graph until you approve this QC
            pass.
          </p>
          {modules.map((m, mi) => {
            const issues = blockingIssueCount(m);
            return (
              <details className="card review-module" key={m.id} open={mi === 0}>
                <summary>
                  <div className="review-title">
                    <div>
                      <strong>{m.title}</strong>
                      <div className="meta">
                        {m.id} · {m.acceptance.length} criteria
                      </div>
                    </div>
                    <div className="actions">
                      {issues > 0 ? (
                        <Badge tone="danger">
                          {issues} issue{issues > 1 ? "s" : ""}
                        </Badge>
                      ) : null}
                      <Badge tone={m.risk === "critical" || m.risk === "high" ? "danger" : "info"}>
                        {m.risk ?? "risk n/a"}
                      </Badge>
                      <Badge>{m.estimated_complexity ?? "complexity n/a"}</Badge>
                    </div>
                  </div>
                  <div className="dependency-list">
                    {m.dependencies.length ? (
                      m.dependencies.map((d) => (
                        <span className="badge" key={d}>
                          ← {d}
                        </span>
                      ))
                    ) : (
                      <span className="meta">No dependencies</span>
                    )}
                  </div>
                </summary>
                <div className="review-body">
                  {m.acceptance.length === 0 ? (
                    <div className="alert" data-testid={`module-empty-${m.id}`}>
                      This module has no acceptance criteria left — add at least one before it can
                      be committed.
                    </div>
                  ) : null}
                  {m.acceptance.map((c, ci) => (
                    <div className="criterion" key={c.id}>
                      <Field label={`Criterion ${ci + 1}`}>
                        <Input
                          data-testid={`ac-statement-${m.id}-${ci}`}
                          value={c.statement}
                          onChange={(e) => update(mi, ci, { statement: e.target.value })}
                        />
                      </Field>
                      <div className="criterion-grid">
                        <Field label="Verification">
                          <Select
                            value={c.verification_type}
                            onChange={(e) =>
                              update(mi, ci, {
                                verification_type: e.target
                                  .value as AcceptanceCriterion["verification_type"],
                              })
                            }
                          >
                            <option value="test">Automated test</option>
                            <option value="command">Command</option>
                            <option value="inspection">Inspection</option>
                            <option value="human">Human review</option>
                          </Select>
                        </Field>
                        <Field label="Evidence or command">
                          <Input
                            className="mono"
                            data-testid={`ac-verification-${m.id}-${ci}`}
                            value={c.verification}
                            onChange={(e) => update(mi, ci, { verification: e.target.value })}
                          />
                        </Field>
                      </div>
                      <Button variant="ghost" className="btn-small" onClick={() => remove(mi, ci)}>
                        Remove criterion
                      </Button>
                    </div>
                  ))}
                  <Button className="btn-small" onClick={() => add(mi)}>
                    + Add criterion
                  </Button>
                </div>
              </details>
            );
          })}
          <div className="actions">
            <Button onClick={onCancel} disabled={committing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-testid="load-into-graph"
              onClick={() => onCommit({ ...plan, modules })}
              disabled={committing || anyBlockingIssues}
            >
              {committing ? "Loading…" : "Load into graph →"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
