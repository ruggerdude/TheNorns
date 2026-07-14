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
  complexity?: string;
  risk?: string;
  [key: string]: unknown;
}
export interface PlanLike {
  objective: string;
  modules: PlanModule[];
  [key: string]: unknown;
}
export function PlanReview({
  plan,
  onCommit,
  onCancel,
  committing,
}: {
  plan: PlanLike;
  onCommit: (p: PlanLike) => void;
  onCancel: () => void;
  committing: boolean;
}): React.ReactElement {
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
  return (
    <div data-testid="plan-review">
      <p className="muted">
        Review every acceptance criterion. Nothing enters the graph until you approve this QC pass.
      </p>
      {modules.map((m, mi) => (
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
                <Badge tone={m.risk === "critical" || m.risk === "high" ? "danger" : "info"}>
                  {m.risk ?? "risk n/a"}
                </Badge>
                <Badge>{m.complexity ?? "complexity n/a"}</Badge>
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
      ))}
      <div className="actions">
        <Button onClick={onCancel} disabled={committing}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="load-into-graph"
          onClick={() => onCommit({ ...plan, modules })}
          disabled={
            committing ||
            modules.some((m) =>
              m.acceptance.some((c) => !c.statement.trim() || !c.verification.trim()),
            )
          }
        >
          {committing ? "Loading…" : "Load into graph →"}
        </Button>
      </div>
    </div>
  );
}
