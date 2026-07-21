// FRONT DOOR P1 (plan review): renders P3's strategy-bridge DTO — the
// rounds outcome, objectives/tasks, and an editable staffing table — then
// approves the phase for execution. This is a new, separate surface from the
// legacy graph-based PlanReview.tsx (which renders the pre-FRONT-DOOR
// `runPlanning`/`/plan/load` acceptance-criteria flow); that flow stays
// untouched for existing projects mid-way through it.
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Select } from "./ui";

export interface StrategyReviewObjective {
  local_id: string;
  outcome: string;
  success_measures: string[];
}

export interface StrategyReviewTask {
  local_id: string;
  objective_local_id: string;
  title: string;
  description: string;
  deliverables: string[];
  acceptance_criteria: string[];
  complexity: string;
  risk: string;
  required_roles: string[];
  dependency_local_ids: string[];
}

export interface StrategyReviewStaffing {
  assignment_id: string;
  task_local_id: string;
  task_title: string;
  required_roles: string[];
  provider: string | null;
  model: string | null;
  reviewer_provider: string | null;
  reviewer_model: string | null;
  budget_limit_usd: number;
  rationale: string;
  rationale_factors: string[];
}

export interface StrategyReviewFinding {
  severity: "must_fix" | "should_fix" | "suggestion";
  finding: string;
  recommendation: string;
  [key: string]: unknown;
}

export interface StrategyReviewDto {
  phase: {
    id: string;
    status: string;
    objective_summary: string;
    approved_strategy_version_id: string | null;
    approved_budget_usd: number;
    aggregate_version: number;
  };
  rounds: {
    planning_run_id: string;
    status: string;
    round: number;
    max_rounds: number;
    transcript: unknown[];
  } | null;
  strategy: {
    id: string;
    version: number;
    status: string;
    aggregate_version: number;
    content_hash: string;
    objective: string;
    assumptions: string[];
    risks: string[];
    scope_in: string[];
    scope_out: string[];
    architecture_impact: string;
    convergence: string;
    review_rounds: number;
    proposed_concurrency: number;
    proposed_budget_usd: number;
    objectives: StrategyReviewObjective[];
    tasks: StrategyReviewTask[];
    staffing: StrategyReviewStaffing[];
    findings: StrategyReviewFinding[];
  } | null;
  outstanding_findings: StrategyReviewFinding[];
}

export interface StaffingEdit {
  assignment_id: string;
  provider?: string;
  model?: string;
  reviewer_provider?: string;
  reviewer_model?: string;
  budget_limit_usd?: number;
}

/** A short, curated set of models the staffing table lets a human pick from
 *  — deliberately small; the freeform rationale/budget stay editable via the
 *  underlying PATCH regardless of what this list offers. */
const MODEL_CHOICES: Array<{ provider: string; model: string; label: string }> = [
  { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { provider: "anthropic", model: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { provider: "anthropic", model: "claude-fable-5", label: "Claude Fable 5" },
  { provider: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];

function modelKey(provider: string | null, model: string | null): string {
  return provider && model ? `${provider}:${model}` : "";
}

export function StrategyReview({
  review,
  approving,
  savingStaffing,
  error,
  onEditStaffing,
  onApprove,
}: {
  review: StrategyReviewDto;
  approving: boolean;
  savingStaffing: boolean;
  error: string | null;
  onEditStaffing: (edits: StaffingEdit[]) => void;
  onApprove: () => void;
}): React.ReactElement {
  const { strategy, rounds, outstanding_findings } = review;
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const capped = rounds?.status === "cap_reached";
  const converged = rounds?.status === "converged";

  const tasksByObjective = useMemo(() => {
    const map = new Map<string, StrategyReviewTask[]>();
    for (const task of strategy?.tasks ?? []) {
      const list = map.get(task.objective_local_id) ?? [];
      list.push(task);
      map.set(task.objective_local_id, list);
    }
    return map;
  }, [strategy]);

  if (!strategy) {
    return (
      <Alert>
        This phase has no proposed strategy yet — draft a planning run and materialize it into a
        phase first.
      </Alert>
    );
  }

  return (
    <div data-testid="strategy-review">
      {rounds ? (
        <div
          className={`plan-status-banner ${capped ? "plan-status-capped" : "plan-status-converged"}`}
          data-testid="strategy-rounds-banner"
        >
          <span aria-hidden="true">{capped ? "⚠" : "✓"}</span>
          <span>
            {converged
              ? `Converged after ${rounds.round} of ${rounds.max_rounds} rounds`
              : capped
                ? `Round cap reached (${rounds.max_rounds} of ${rounds.max_rounds}) — outstanding findings below`
                : `Round ${rounds.round} of ${rounds.max_rounds}`}
          </span>
          <Badge tone={capped ? "danger" : "success"}>{rounds.status}</Badge>
        </div>
      ) : null}

      {outstanding_findings.length > 0 ? (
        <div className="card outstanding-panel" data-testid="strategy-outstanding-findings">
          <strong>Outstanding findings</strong>
          {outstanding_findings.map((finding, index) => (
            <article className="outstanding-item" key={`${finding.finding}-${index}`}>
              <div className="outstanding-item-meta">
                <Badge tone={finding.severity === "must_fix" ? "danger" : "warn"}>
                  {finding.severity.replaceAll("_", " ")}
                </Badge>
              </div>
              <strong>{finding.finding}</strong>
              {finding.recommendation ? (
                <p>
                  <strong>Recommendation:</strong> {finding.recommendation}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      <p className="muted">{strategy.objective}</p>

      <div className="strategy-objectives" data-testid="strategy-objectives">
        {strategy.objectives.map((objective, index) => (
          <article className="card phase-card" key={objective.local_id}>
            <div className="ph-top">
              <span className="phase-num">{index + 1}</span>
              <h4>{objective.outcome}</h4>
            </div>
            <div className="ph-tasks">
              {(tasksByObjective.get(objective.local_id) ?? []).map((task) => (
                <div className="ph-task" key={task.local_id}>
                  <span className="tk" />
                  {task.title}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="section-head">
        <h2>Staffing</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Mix providers per task — every field is editable before launch.
        </span>
      </div>
      <div className="staff-table-wrap">
        <table className="staff" data-testid="staffing-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Agent model</th>
              <th>Reviewer</th>
              <th style={{ textAlign: "right" }}>Budget</th>
            </tr>
          </thead>
          <tbody>
            {strategy.staffing.map((row) => {
              const agentKey = modelKey(row.provider, row.model);
              const reviewerKey = modelKey(row.reviewer_provider, row.reviewer_model);
              const budgetDraft = budgetDrafts[row.assignment_id] ?? String(row.budget_limit_usd);
              return (
                <tr key={row.assignment_id} data-testid="staffing-row">
                  <td>
                    <div className="tg-name">{row.task_title}</div>
                    <div className="tg-role">{row.required_roles.join(", ") || "engineer"}</div>
                  </td>
                  <td>
                    <Select
                      className="mini-select"
                      aria-label={`Agent model for ${row.task_title}`}
                      value={agentKey}
                      disabled={savingStaffing}
                      onChange={(event) => {
                        const choice = MODEL_CHOICES.find(
                          (candidate) =>
                            modelKey(candidate.provider, candidate.model) === event.target.value,
                        );
                        if (!choice) return;
                        onEditStaffing([
                          {
                            assignment_id: row.assignment_id,
                            provider: choice.provider,
                            model: choice.model,
                          },
                        ]);
                      }}
                    >
                      <option value="">
                        {row.provider ?? "unassigned"} · {row.model ?? "—"}
                      </option>
                      {MODEL_CHOICES.map((choice) => (
                        <option
                          key={modelKey(choice.provider, choice.model)}
                          value={modelKey(choice.provider, choice.model)}
                        >
                          {choice.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select
                      className="mini-select"
                      aria-label={`Reviewer model for ${row.task_title}`}
                      value={reviewerKey}
                      disabled={savingStaffing}
                      onChange={(event) => {
                        if (!event.target.value) {
                          onEditStaffing([
                            {
                              assignment_id: row.assignment_id,
                              clear_reviewer: true,
                            } as StaffingEdit,
                          ]);
                          return;
                        }
                        const choice = MODEL_CHOICES.find(
                          (candidate) =>
                            modelKey(candidate.provider, candidate.model) === event.target.value,
                        );
                        if (!choice) return;
                        onEditStaffing([
                          {
                            assignment_id: row.assignment_id,
                            reviewer_provider: choice.provider,
                            reviewer_model: choice.model,
                          },
                        ]);
                      }}
                    >
                      <option value="">
                        {row.reviewer_provider ?? "none"} · {row.reviewer_model ?? "—"}
                      </option>
                      {MODEL_CHOICES.map((choice) => (
                        <option
                          key={modelKey(choice.provider, choice.model)}
                          value={modelKey(choice.provider, choice.model)}
                        >
                          {choice.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="budget-cell" style={{ textAlign: "right" }}>
                    <input
                      className="input mono"
                      style={{ width: 90, textAlign: "right" }}
                      type="number"
                      min="0"
                      step="1"
                      aria-label={`Budget for ${row.task_title}`}
                      value={budgetDraft}
                      disabled={savingStaffing}
                      onChange={(event) =>
                        setBudgetDrafts((current) => ({
                          ...current,
                          [row.assignment_id]: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        const value = Number(budgetDraft);
                        if (
                          Number.isFinite(value) &&
                          value >= 0 &&
                          value !== row.budget_limit_usd
                        ) {
                          onEditStaffing([
                            { assignment_id: row.assignment_id, budget_limit_usd: value },
                          ]);
                        }
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? <Alert testId="strategy-review-error">{error}</Alert> : null}

      <div className="plan-foot">
        <span className="pf-note">
          Estimated total budget{" "}
          <strong className="mono">${strategy.proposed_budget_usd.toFixed(2)}</strong> ·{" "}
          {strategy.tasks.length} task{strategy.tasks.length === 1 ? "" : "s"}
        </span>
        <div className="plan-actions">
          <Button
            variant="primary"
            data-testid="approve-strategy"
            disabled={approving || savingStaffing}
            onClick={onApprove}
          >
            {approving ? "Approving…" : "Approve & launch →"}
          </Button>
        </div>
      </div>
    </div>
  );
}
