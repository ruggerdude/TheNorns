import { V2ProjectCodingMetrics, type V2ProjectCodingMetricsT } from "@norns/contracts";
import type { V2TransactionRunner } from "../persistence/v2/database.js";

interface TaskMetricRow {
  task_id: string;
  phase_id: string;
  phase_name: string;
  title: string;
  complexity: "S" | "M" | "L" | "XL";
  risk: "low" | "medium" | "high" | "critical";
  state: V2ProjectCodingMetricsT["task_breakdown"][number]["state"];
  completed_at: string | Date | null;
  updated_at: string | Date;
  first_started_at: string | Date | null;
  run_count: number | string;
  terminal_runs: number | string;
  max_attempt: number | string | null;
  active_seconds: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  rework_tokens: number | string;
  priced_runs: number | string;
  total_cost_usd: number | string;
  verification_passed: boolean;
}

interface AgentMetricRow {
  agent_profile_id: string;
  provider: string;
  model: string;
  run_count: number | string;
  succeeded_runs: number | string;
  failed_runs: number | string;
  active_seconds: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  priced_runs: number | string;
  total_cost_usd: number | string;
}

interface CacheMetricRow {
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
}

interface DeploymentMetricRow {
  terminal_deployments: number | string;
  failed_deployments: number | string;
}

interface NormalizedTaskMetric {
  task_id: string;
  phase_id: string;
  phase_name: string;
  title: string;
  complexity: TaskMetricRow["complexity"];
  risk: TaskMetricRow["risk"];
  state: TaskMetricRow["state"];
  completed_at: Date | null;
  updated_at: Date;
  first_started_at: Date | null;
  run_count: number;
  terminal_runs: number;
  max_attempt: number;
  active_seconds: number;
  input_tokens: number;
  output_tokens: number;
  rework_tokens: number;
  priced_runs: number;
  total_cost_usd: number;
  verification_passed: boolean;
}

function number(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: string | Date | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const start = sorted[lower] ?? 0;
  const end = sorted[upper] ?? start;
  return Math.round(start + (end - start) * (index - lower));
}

function deliverySeconds(task: NormalizedTaskMetric): number | null {
  if (task.state !== "completed" || !task.completed_at || !task.first_started_at) return null;
  return Math.max(0, (task.completed_at.valueOf() - task.first_started_at.valueOf()) / 1_000);
}

function completeCost(runCount: number, pricedRuns: number, totalCost: number): number | null {
  return runCount > 0 && pricedRuns === runCount ? totalCost : null;
}

function normalizeTask(row: TaskMetricRow): NormalizedTaskMetric {
  return {
    task_id: row.task_id,
    phase_id: row.phase_id,
    phase_name: row.phase_name,
    title: row.title,
    complexity: row.complexity,
    risk: row.risk,
    state: row.state,
    completed_at: date(row.completed_at),
    updated_at: date(row.updated_at) ?? new Date(0),
    first_started_at: date(row.first_started_at),
    run_count: number(row.run_count),
    terminal_runs: number(row.terminal_runs),
    max_attempt: number(row.max_attempt),
    active_seconds: number(row.active_seconds),
    input_tokens: number(row.input_tokens),
    output_tokens: number(row.output_tokens),
    rework_tokens: number(row.rework_tokens),
    priced_runs: number(row.priced_runs),
    total_cost_usd: number(row.total_cost_usd),
    verification_passed: row.verification_passed,
  };
}

export class ProjectCodingMetricsService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(projectId: string): Promise<V2ProjectCodingMetricsT> {
    const [taskRows, agentRows, cacheRows, deploymentRows] = await this.transactions.transaction(
      async (sql) =>
        Promise.all([
          sql.query<TaskMetricRow>(
            `SELECT task.id AS task_id,task.phase_id,
                    phase.objective_summary AS phase_name,task.title,
                    task.complexity,task.risk,task.state,task.completed_at,task.updated_at,
                    min(run.started_at) AS first_started_at,
                    count(run.id)::int AS run_count,
                    count(run.id) FILTER (
                      WHERE run.state IN ('succeeded','failed','cancelled','expired')
                    )::int AS terminal_runs,
                    max(run.attempt)::int AS max_attempt,
                    COALESCE(sum(
                      CASE WHEN run.started_at IS NOT NULL AND run.finished_at IS NOT NULL
                        THEN GREATEST(
                          EXTRACT(EPOCH FROM (run.finished_at-run.started_at)),0
                        ) ELSE 0 END
                    ),0) AS active_seconds,
                    COALESCE(sum(run.usage_input_tokens),0) AS input_tokens,
                    COALESCE(sum(run.usage_output_tokens),0) AS output_tokens,
                    COALESCE(sum(
                      CASE WHEN run.attempt>1
                        THEN run.usage_input_tokens+run.usage_output_tokens ELSE 0 END
                    ),0) AS rework_tokens,
                    count(run.usage_cost_usd)::int AS priced_runs,
                    COALESCE(sum(run.usage_cost_usd),0) AS total_cost_usd,
                    COALESCE(bool_or(run.verification_status='passed'),false)
                      AS verification_passed
               FROM tasks task
               JOIN phases phase
                 ON phase.project_id=task.project_id AND phase.id=task.phase_id
               LEFT JOIN agent_runs run
                 ON run.project_id=task.project_id
                AND run.phase_id=task.phase_id
                AND run.task_id=task.id
              WHERE task.project_id=$1
              GROUP BY task.id,task.phase_id,phase.objective_summary,task.title,
                       task.complexity,task.risk,task.state,task.completed_at,task.updated_at
              ORDER BY task.updated_at DESC,task.id`,
            [projectId],
          ),
          sql.query<AgentMetricRow>(
            `SELECT profile.id AS agent_profile_id,profile.provider,profile.model,
                    count(run.id)::int AS run_count,
                    count(run.id) FILTER (WHERE run.state='succeeded')::int AS succeeded_runs,
                    count(run.id) FILTER (WHERE run.state='failed')::int AS failed_runs,
                    COALESCE(sum(
                      CASE WHEN run.started_at IS NOT NULL AND run.finished_at IS NOT NULL
                        THEN GREATEST(
                          EXTRACT(EPOCH FROM (run.finished_at-run.started_at)),0
                        ) ELSE 0 END
                    ),0) AS active_seconds,
                    COALESCE(sum(run.usage_input_tokens),0) AS input_tokens,
                    COALESCE(sum(run.usage_output_tokens),0) AS output_tokens,
                    count(run.usage_cost_usd)::int AS priced_runs,
                    COALESCE(sum(run.usage_cost_usd),0) AS total_cost_usd
               FROM agent_runs run
               JOIN agent_assignments assignment ON assignment.id=run.assignment_id
               JOIN agent_profiles profile ON profile.id=assignment.agent_profile_id
              WHERE run.project_id=$1
              GROUP BY profile.id,profile.provider,profile.model
              ORDER BY count(run.id) DESC,profile.provider,profile.model,profile.id`,
            [projectId],
          ),
          sql.query<CacheMetricRow>(
            `SELECT COALESCE(sum(cache_read_tokens),0) AS cache_read_tokens,
                    COALESCE(sum(cache_write_tokens),0) AS cache_write_tokens
               FROM ai_usage_events
              WHERE project_id=$1 AND run_id IS NOT NULL
                AND event_type IN ('usage_observed','adjustment')`,
            [projectId],
          ),
          sql.query<DeploymentMetricRow>(
            `SELECT count(*) FILTER (
                      WHERE status IN ('succeeded','failed')
                    )::int AS terminal_deployments,
                    count(*) FILTER (WHERE status='failed')::int AS failed_deployments
               FROM project_delivery_records
              WHERE project_id=$1`,
            [projectId],
          ),
        ]),
    );

    const tasks = taskRows.rows.map(normalizeTask);
    const completed = tasks.filter((task) => task.state === "completed");
    const deliverySamples = completed.flatMap((task) => {
      const seconds = deliverySeconds(task);
      return seconds === null ? [] : [seconds];
    });
    const firstPassTasks = completed.filter(
      (task) => task.run_count === 1 && task.max_attempt === 1 && task.verification_passed,
    ).length;
    const totalRuns = tasks.reduce((sum, task) => sum + task.run_count, 0);
    const terminalRuns = tasks.reduce((sum, task) => sum + task.terminal_runs, 0);
    const activeSeconds = tasks.reduce((sum, task) => sum + task.active_seconds, 0);
    const inputTokens = tasks.reduce((sum, task) => sum + task.input_tokens, 0);
    const outputTokens = tasks.reduce((sum, task) => sum + task.output_tokens, 0);
    const totalTokens = inputTokens + outputTokens;
    const reworkTokens = tasks.reduce((sum, task) => sum + task.rework_tokens, 0);
    const pricedRuns = tasks.reduce((sum, task) => sum + task.priced_runs, 0);
    const totalCost = tasks.reduce((sum, task) => sum + task.total_cost_usd, 0);
    const completeTotalCost = completeCost(totalRuns, pricedRuns, totalCost);
    const thirtyDaysAgo = this.now().valueOf() - 30 * 24 * 60 * 60 * 1_000;
    const cache = cacheRows.rows[0];
    const deployment = deploymentRows.rows[0];
    const terminalDeployments = number(deployment?.terminal_deployments);
    const failedDeployments = number(deployment?.failed_deployments);

    const phases = new Map<string, NormalizedTaskMetric[]>();
    for (const task of tasks) {
      const group = phases.get(task.phase_id) ?? [];
      group.push(task);
      phases.set(task.phase_id, group);
    }

    return V2ProjectCodingMetrics.parse({
      project_id: projectId,
      total_tasks: tasks.length,
      completed_tasks: completed.length,
      completed_tasks_last_30_days: completed.filter(
        (task) => task.completed_at !== null && task.completed_at.valueOf() >= thirtyDaysAgo,
      ).length,
      terminal_runs: terminalRuns,
      active_coding_seconds: activeSeconds,
      time_to_verified_delivery: {
        sample_size: deliverySamples.length,
        median_seconds: percentile(deliverySamples, 0.5),
        p75_seconds: percentile(deliverySamples, 0.75),
      },
      first_pass_yield: {
        completed_tasks: completed.length,
        first_pass_tasks: firstPassTasks,
        rate: rate(firstPassTasks, completed.length),
      },
      tokens_per_accepted_task: {
        accepted_tasks: completed.length,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: Math.max(0, number(cache?.cache_read_tokens)),
        cache_write_tokens: Math.max(0, number(cache?.cache_write_tokens)),
        reasoning_tokens: null,
        total_tokens: totalTokens,
        per_accepted_task: rate(totalTokens, completed.length),
      },
      cost_per_accepted_task: {
        accepted_tasks: completed.length,
        priced_runs: pricedRuns,
        total_runs: totalRuns,
        coverage_rate: totalRuns === 0 ? 0 : pricedRuns / totalRuns,
        total_cost_usd: completeTotalCost,
        per_accepted_task_usd:
          completeTotalCost === null ? null : rate(completeTotalCost, completed.length),
      },
      rework_ratio: {
        total_tokens: totalTokens,
        rework_tokens: reworkTokens,
        rate: rate(reworkTokens, totalTokens),
      },
      change_failure_rate: {
        terminal_deployments: terminalDeployments,
        failed_deployments: failedDeployments,
        rate: rate(failedDeployments, terminalDeployments),
      },
      phase_breakdown: [...phases.entries()].map(([phaseId, phaseTasks]) => {
        const completedPhaseTasks = phaseTasks.filter((task) => task.state === "completed");
        const phaseRuns = phaseTasks.reduce((sum, task) => sum + task.run_count, 0);
        const phasePricedRuns = phaseTasks.reduce((sum, task) => sum + task.priced_runs, 0);
        const phaseCost = phaseTasks.reduce((sum, task) => sum + task.total_cost_usd, 0);
        const phaseInputTokens = phaseTasks.reduce((sum, task) => sum + task.input_tokens, 0);
        const phaseOutputTokens = phaseTasks.reduce((sum, task) => sum + task.output_tokens, 0);
        const phaseFirstPass = completedPhaseTasks.filter(
          (task) => task.run_count === 1 && task.max_attempt === 1 && task.verification_passed,
        ).length;
        const phaseDeliverySamples = completedPhaseTasks.flatMap((task) => {
          const seconds = deliverySeconds(task);
          return seconds === null ? [] : [seconds];
        });
        return {
          phase_id: phaseId,
          phase_name: phaseTasks[0]?.phase_name ?? phaseId,
          total_tasks: phaseTasks.length,
          completed_tasks: completedPhaseTasks.length,
          run_count: phaseRuns,
          active_coding_seconds: phaseTasks.reduce((sum, task) => sum + task.active_seconds, 0),
          median_delivery_seconds: percentile(phaseDeliverySamples, 0.5),
          first_pass_yield: rate(phaseFirstPass, completedPhaseTasks.length),
          input_tokens: phaseInputTokens,
          output_tokens: phaseOutputTokens,
          total_tokens: phaseInputTokens + phaseOutputTokens,
          total_cost_usd: completeCost(phaseRuns, phasePricedRuns, phaseCost),
          cost_coverage_rate: phaseRuns === 0 ? 0 : phasePricedRuns / phaseRuns,
        };
      }),
      agent_breakdown: agentRows.rows.map((agent) => {
        const runCount = number(agent.run_count);
        const agentPricedRuns = number(agent.priced_runs);
        const agentInputTokens = number(agent.input_tokens);
        const agentOutputTokens = number(agent.output_tokens);
        return {
          agent_profile_id: agent.agent_profile_id,
          provider: agent.provider,
          model: agent.model,
          run_count: runCount,
          succeeded_runs: number(agent.succeeded_runs),
          failed_runs: number(agent.failed_runs),
          active_coding_seconds: number(agent.active_seconds),
          input_tokens: agentInputTokens,
          output_tokens: agentOutputTokens,
          total_tokens: agentInputTokens + agentOutputTokens,
          total_cost_usd: completeCost(runCount, agentPricedRuns, number(agent.total_cost_usd)),
          cost_coverage_rate: runCount === 0 ? 0 : agentPricedRuns / runCount,
        };
      }),
      task_breakdown: tasks
        .sort(
          (left, right) =>
            (right.completed_at ?? right.updated_at).valueOf() -
              (left.completed_at ?? left.updated_at).valueOf() ||
            left.task_id.localeCompare(right.task_id),
        )
        .slice(0, 50)
        .map((task) => ({
          task_id: task.task_id,
          phase_id: task.phase_id,
          title: task.title,
          complexity: task.complexity,
          risk: task.risk,
          state: task.state,
          attempt_count: task.run_count,
          active_coding_seconds: task.active_seconds,
          delivery_seconds: deliverySeconds(task),
          input_tokens: task.input_tokens,
          output_tokens: task.output_tokens,
          total_tokens: task.input_tokens + task.output_tokens,
          total_cost_usd: completeCost(task.run_count, task.priced_runs, task.total_cost_usd),
          cost_coverage_rate: task.run_count === 0 ? 0 : task.priced_runs / task.run_count,
          verification_passed: task.verification_passed,
        })),
    });
  }
}
