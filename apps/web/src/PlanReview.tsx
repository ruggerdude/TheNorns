// QC review: before a live-planned result becomes the project's live graph,
// show every module's acceptance criteria (the verification the planner
// proposed) and let the human edit them. Nothing is committed until "Load
// into graph" is pressed.
import { useState } from "react";

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
  onCommit: (plan: PlanLike) => void;
  onCancel: () => void;
  committing: boolean;
}): React.ReactElement {
  const [modules, setModules] = useState<PlanModule[]>(plan.modules);

  const updateCriterion = (
    moduleIndex: number,
    critIndex: number,
    patch: Partial<AcceptanceCriterion>,
  ): void => {
    setModules((prev) =>
      prev.map((m, mi) =>
        mi !== moduleIndex
          ? m
          : {
              ...m,
              acceptance: m.acceptance.map((c, ci) => (ci !== critIndex ? c : { ...c, ...patch })),
            },
      ),
    );
  };

  return (
    <div data-testid="plan-review" style={{ fontSize: 12 }}>
      <p style={{ color: "#666" }}>
        QC: review each module's acceptance criteria before this becomes your live graph. Edit
        anything, then load it.
      </p>
      {modules.map((mod, mi) => (
        <div
          key={mod.id}
          style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, marginBottom: 8 }}
        >
          <strong>{mod.id}</strong> — {mod.title}
          {mod.acceptance.map((crit, ci) => (
            <div
              key={crit.id}
              style={{ marginTop: 6, paddingLeft: 8, borderLeft: "2px solid #eee" }}
            >
              <input
                data-testid={`ac-statement-${mod.id}-${ci}`}
                value={crit.statement}
                onChange={(e) => updateCriterion(mi, ci, { statement: e.target.value })}
                style={{ width: "100%", marginBottom: 2, fontFamily: "inherit" }}
              />
              <select
                value={crit.verification_type}
                onChange={(e) =>
                  updateCriterion(mi, ci, {
                    verification_type: e.target.value as AcceptanceCriterion["verification_type"],
                  })
                }
              >
                <option value="test">test</option>
                <option value="command">command</option>
                <option value="inspection">inspection</option>
                <option value="human">human</option>
              </select>{" "}
              <input
                data-testid={`ac-verification-${mod.id}-${ci}`}
                value={crit.verification}
                onChange={(e) => updateCriterion(mi, ci, { verification: e.target.value })}
                style={{ width: "55%", fontFamily: "inherit" }}
              />
            </div>
          ))}
        </div>
      ))}
      <button type="button" onClick={onCancel} disabled={committing}>
        Cancel
      </button>{" "}
      <button
        type="button"
        data-testid="load-into-graph"
        onClick={() => onCommit({ ...plan, modules })}
        disabled={committing}
      >
        {committing ? "Loading…" : "Load into graph"}
      </button>
    </div>
  );
}
