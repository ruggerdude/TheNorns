import { z } from "zod";
import {
  V2EntityId,
  V2EvidenceRef,
  V2GitCommitSha,
  V2IsoDateTime,
  V2NonEmptyString,
  V2Sha256Hex,
} from "./common.js";
import { V2ConversationMockupVersion, V2WorkConversation, V2WorkItem } from "./conversation.js";
import { V2ArtifactKind } from "./evidence.js";

const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeMoney = z.number().nonnegative();
const nonNegativeNumber = z.number().nonnegative().finite();
const nullableRate = z.number().min(0).max(1).finite().nullable();

function parseIpv6(value: string): bigint | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }
  return groups.reduce((address, group) => (address << 16n) | BigInt(`0x${group}`), 0n);
}

function isPublicHttpsUrl(value: string): boolean {
  const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  const authority = match?.[1];
  if (!authority || authority.includes("@")) return false;
  let host: string;
  let ipv6Literal = false;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 0 || closing !== authority.length - 1) return false;
    host = authority.slice(1, closing);
    ipv6Literal = true;
  } else {
    if (authority.includes(":")) return false;
    host = authority;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (ipv6Literal) {
    const address = parseIpv6(host);
    if (address === null) return false;
    // Only globally routable unicast literals are valid probe targets.
    // Exclude the documentation block even though it shares 2000::/3.
    return address >> 125n === 1n && address >> 96n !== 0x20010db8n;
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === ""
  ) {
    return false;
  }
  const parts = host.split(".");
  const octets = parts.map(Number);
  const canonicalIpv4 =
    /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(host) &&
    parts.every((octet) => octet === "0" || !octet.startsWith("0")) &&
    octets.every((octet) => octet <= 255);
  if (canonicalIpv4) {
    const a = octets[0] as number;
    const b = octets[1] as number;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    ) {
      return false;
    }
  } else if (parts.every((part) => /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(part))) {
    // WHATWG clients normalize integer, short, octal, and hex forms into IP
    // literals (for example 127.1 -> 127.0.0.1). Reject the ambiguous forms.
    return false;
  }
  return host.length > 0;
}

/**
 * This is the durable syntactic boundary. A component that initiates a probe
 * must additionally resolve immediately before connecting, reject every
 * non-public A/AAAA answer, pin the accepted address, and repeat the check
 * after redirects so DNS rebinding cannot bypass this contract.
 */
export const V2PublicHttpsUrl = z
  .string()
  .url()
  .refine(isPublicHttpsUrl, "must be a credential-free public HTTPS URL");

export const V2ProjectDeploymentStatus = z.enum(["pending", "deploying", "succeeded", "failed"]);
export type V2ProjectDeploymentStatusT = z.infer<typeof V2ProjectDeploymentStatus>;

export const V2ProjectDeploymentObservationSource = z.enum([
  "provider",
  "runner",
  "system",
  "human",
]);
export type V2ProjectDeploymentObservationSourceT = z.infer<
  typeof V2ProjectDeploymentObservationSource
>;

const deploymentObservationFields = {
  status: V2ProjectDeploymentStatus,
  public_url: V2PublicHttpsUrl.nullable(),
  health_url: V2PublicHttpsUrl.nullable(),
  health_status_code: z.number().int().min(100).max(599).nullable(),
  evidence: V2EvidenceRef.nullable(),
} as const;

function requireSuccessfulDeploymentEvidence(
  value: {
    status: V2ProjectDeploymentStatusT;
    public_url: string | null;
    health_url: string | null;
    health_status_code: number | null;
    evidence: z.infer<typeof V2EvidenceRef> | null;
  },
  ctx: z.RefinementCtx,
) {
  if (value.evidence !== null && value.evidence.media_type !== "application/json") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "media_type"],
      message: "deployment evidence must be an immutable JSON receipt",
    });
  }
  if (
    value.status === "succeeded" &&
    (value.public_url === null ||
      value.health_url === null ||
      value.health_status_code === null ||
      value.health_status_code < 200 ||
      value.health_status_code >= 400 ||
      value.evidence === null ||
      value.evidence.media_type !== "application/json")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "a successful deployment requires a healthy public endpoint and JSON evidence",
    });
  }
}

export const V2ProjectDeploymentObservation = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    deployment_record_id: V2EntityId,
    project_id: V2EntityId,
    sequence: z.number().int().positive(),
    ...deploymentObservationFields,
    source_type: V2ProjectDeploymentObservationSource,
    source_id: V2EntityId,
    provider_event_id: V2EntityId.nullable(),
    observed_at: V2IsoDateTime,
    created_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((observation, ctx) => {
    requireSuccessfulDeploymentEvidence(observation, ctx);
    if ((observation.source_type === "provider") !== (observation.provider_event_id !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider_event_id"],
        message: "only provider observations require an immutable provider event ID",
      });
    }
  });
export type V2ProjectDeploymentObservationT = z.infer<typeof V2ProjectDeploymentObservation>;

export const V2DeploymentObservationEvidenceReceipt = z
  .object({
    schema_version: z.literal(2),
    kind: z.literal("deployment_observation"),
    delivery_record_id: V2EntityId,
    project_id: V2EntityId,
    provider_id: V2EntityId,
    provider_deployment_id: V2NonEmptyString,
    commit_sha: V2GitCommitSha,
    environment: V2NonEmptyString,
    service: V2NonEmptyString,
    sequence: z.number().int().positive(),
    status: V2ProjectDeploymentStatus,
    source_type: V2ProjectDeploymentObservationSource,
    source_id: V2NonEmptyString,
    provider_event_id: V2EntityId.nullable(),
    public_url: V2PublicHttpsUrl.nullable(),
    health_url: V2PublicHttpsUrl.nullable(),
    health_status_code: z.number().int().min(100).max(599).nullable(),
    observed_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if ((receipt.source_type === "provider") !== (receipt.provider_event_id !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider_event_id"],
        message: "only provider observations require an immutable provider event ID",
      });
    }
    if (receipt.source_type === "provider" && receipt.source_id !== receipt.provider_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_id"],
        message: "provider evidence must use the deployment record's exact provider identity",
      });
    }
    if (
      receipt.status === "succeeded" &&
      (receipt.public_url === null ||
        receipt.health_url === null ||
        receipt.health_status_code === null ||
        receipt.health_status_code < 200 ||
        receipt.health_status_code >= 400)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["health_status_code"],
        message: "successful deployment evidence requires a healthy public endpoint",
      });
    }
  });
export type V2DeploymentObservationEvidenceReceiptT = z.infer<
  typeof V2DeploymentObservationEvidenceReceipt
>;

export const V2RecordProjectDeploymentObservationInput = z
  .object({
    project_id: V2EntityId,
    delivery_record_id: V2EntityId,
    expected_sequence: z.number().int().positive(),
    status: V2ProjectDeploymentStatus,
    provider_id: V2EntityId,
    provider_event_id: V2EntityId,
    public_url: V2PublicHttpsUrl.nullable(),
    health_url: V2PublicHttpsUrl.nullable(),
    health_status_code: z.number().int().min(100).max(599).nullable(),
    evidence: V2EvidenceRef.nullable(),
    observed_at: V2IsoDateTime,
    idempotency_key: V2EntityId,
  })
  .strict()
  .superRefine((input, ctx) => requireSuccessfulDeploymentEvidence(input, ctx));
export type V2RecordProjectDeploymentObservationInputT = z.infer<
  typeof V2RecordProjectDeploymentObservationInput
>;

export const V2ProjectDeployment = z
  .object({
    schema_version: z.literal(2),
    id: V2EntityId,
    project_id: V2EntityId,
    phase_id: V2EntityId.nullable(),
    task_id: V2EntityId.nullable(),
    run_id: V2EntityId.nullable(),
    repository_binding_id: V2EntityId,
    environment: V2NonEmptyString,
    service: V2NonEmptyString,
    commit_sha: V2GitCommitSha,
    provider_id: V2EntityId,
    provider_deployment_id: V2NonEmptyString,
    current_observation_sequence: z.number().int().positive(),
    ...deploymentObservationFields,
    started_at: V2IsoDateTime,
    completed_at: V2IsoDateTime.nullable(),
    created_at: V2IsoDateTime,
    updated_at: V2IsoDateTime,
  })
  .strict()
  .superRefine((deployment, ctx) => {
    const terminal = ["succeeded", "failed"].includes(deployment.status);
    if (terminal !== (deployment.completed_at !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_at"],
        message: "terminal deployments require their completion timestamp",
      });
    }
    if (
      (deployment.phase_id === null &&
        (deployment.task_id !== null || deployment.run_id !== null)) ||
      (deployment.task_id === null && deployment.run_id !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_id"],
        message: "deployment phase, task, and run scope must be complete and ordered",
      });
    }
    requireSuccessfulDeploymentEvidence(deployment, ctx);
  });
export type V2ProjectDeploymentT = z.infer<typeof V2ProjectDeployment>;

export const V2DashboardAvailability = z.enum(["available", "unavailable"]);
export type V2DashboardAvailabilityT = z.infer<typeof V2DashboardAvailability>;

/**
 * An available empty collection means the authoritative source was read and
 * there are no rows. An unavailable section has no data, carries a stable
 * reason, and can never be mistaken for an empty result.
 */
function dashboardSection<T extends z.ZodTypeAny, S extends string>(source: S, data: T) {
  return z.discriminatedUnion("availability", [
    z
      .object({
        availability: z.literal("available"),
        source: z.literal(source),
        observed_at: V2IsoDateTime,
        data,
      })
      .strict(),
    z
      .object({
        availability: z.literal("unavailable"),
        source: z.literal(source),
        observed_at: z.null(),
        data: z.null(),
        reason_code: V2NonEmptyString,
        detail: V2NonEmptyString.nullable(),
        retryable: z.boolean(),
      })
      .strict(),
  ]);
}

const activeWork = z.array(
  z
    .object({
      work_item: V2WorkItem,
      conversation_id: V2EntityId.nullable(),
      deep_link: V2NonEmptyString.nullable(),
      phase_progress: z
        .object({
          phase_id: V2EntityId,
          percent_complete: z.number().int().min(0).max(100),
          tasks_completed: nonNegativeInteger,
          tasks_total: nonNegativeInteger,
        })
        .strict()
        .superRefine((progress, ctx) => {
          if (progress.tasks_completed > progress.tasks_total) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["tasks_completed"],
              message: "completed task count cannot exceed total task count",
            });
          }
        })
        .nullable(),
    })
    .strict(),
);

const dashboardDeployment = z
  .object({
    deployment: V2ProjectDeployment,
    work_item_id: V2EntityId.nullable(),
    conversation_id: V2EntityId.nullable(),
    deep_link: V2NonEmptyString.nullable(),
  })
  .strict();

const needsAttention = z.array(
  z
    .object({
      project_id: V2EntityId,
      key: V2NonEmptyString,
      source_type: z.enum([
        "human_wait",
        "decision",
        "blocker",
        "mockup",
        "deployment",
        "visual_evidence",
      ]),
      source_id: V2EntityId,
      work_item_id: V2EntityId.nullable(),
      conversation_id: V2EntityId.nullable(),
      phase_id: V2EntityId.nullable(),
      task_id: V2EntityId.nullable(),
      title: V2NonEmptyString,
      summary: V2NonEmptyString,
      severity: z.enum(["critical", "high", "normal", "low"]),
      deep_link: V2NonEmptyString.nullable(),
      occurred_at: V2IsoDateTime,
    })
    .strict(),
);

const openDecisions = z.array(
  z
    .object({
      id: V2NonEmptyString,
      project_id: V2EntityId,
      work_item_id: V2EntityId.nullable(),
      phase_id: V2EntityId.nullable(),
      conversation_id: V2EntityId.nullable(),
      source_type: z.enum(["human_wait", "decision_point", "blocked_work_item", "blocked_task"]),
      source_id: V2EntityId,
      title: V2NonEmptyString,
      detail: V2NonEmptyString,
      status: z.enum(["awaiting_human", "open", "blocked"]),
      deep_link: V2NonEmptyString.nullable(),
      created_at: V2IsoDateTime,
    })
    .strict(),
);

const budget = z
  .object({
    project_id: V2EntityId,
    current_spend_usd: nonNegativeMoney.nullable(),
    projected_budget_usd: nonNegativeMoney.nullable(),
    projection_source: z.enum(["usage_and_plan", "usage_only", "plan_only"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const valid =
      (value.projection_source === "usage_and_plan" &&
        value.current_spend_usd !== null &&
        value.projected_budget_usd !== null) ||
      (value.projection_source === "usage_only" &&
        value.current_spend_usd !== null &&
        value.projected_budget_usd === null) ||
      (value.projection_source === "plan_only" &&
        value.current_spend_usd === null &&
        value.projected_budget_usd !== null);
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projection_source"],
        message: "budget values must truthfully match their authoritative source",
      });
    }
  });

const deliveryTimeMetric = z
  .object({
    sample_size: nonNegativeInteger,
    median_seconds: nonNegativeNumber.nullable(),
    p75_seconds: nonNegativeNumber.nullable(),
  })
  .strict();

const firstPassYieldMetric = z
  .object({
    completed_tasks: nonNegativeInteger,
    first_pass_tasks: nonNegativeInteger,
    rate: nullableRate,
  })
  .strict();

const tokenEfficiencyMetric = z
  .object({
    accepted_tasks: nonNegativeInteger,
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
    cache_read_tokens: nonNegativeInteger,
    cache_write_tokens: nonNegativeInteger,
    reasoning_tokens: z.null(),
    total_tokens: nonNegativeInteger,
    per_accepted_task: nonNegativeNumber.nullable(),
  })
  .strict();

const costEfficiencyMetric = z
  .object({
    accepted_tasks: nonNegativeInteger,
    priced_runs: nonNegativeInteger,
    total_runs: nonNegativeInteger,
    coverage_rate: z.number().min(0).max(1).finite(),
    total_cost_usd: nonNegativeMoney.nullable(),
    per_accepted_task_usd: nonNegativeMoney.nullable(),
  })
  .strict();

const reworkMetric = z
  .object({
    total_tokens: nonNegativeInteger,
    rework_tokens: nonNegativeInteger,
    rate: nullableRate,
  })
  .strict();

const changeFailureMetric = z
  .object({
    terminal_deployments: nonNegativeInteger,
    failed_deployments: nonNegativeInteger,
    rate: nullableRate,
  })
  .strict();

const phaseMetricBreakdown = z
  .object({
    phase_id: V2EntityId,
    phase_name: V2NonEmptyString,
    total_tasks: nonNegativeInteger,
    completed_tasks: nonNegativeInteger,
    run_count: nonNegativeInteger,
    active_coding_seconds: nonNegativeNumber,
    median_delivery_seconds: nonNegativeNumber.nullable(),
    first_pass_yield: nullableRate,
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
    total_tokens: nonNegativeInteger,
    total_cost_usd: nonNegativeMoney.nullable(),
    cost_coverage_rate: z.number().min(0).max(1).finite(),
  })
  .strict();

const agentMetricBreakdown = z
  .object({
    agent_profile_id: V2EntityId,
    provider: V2NonEmptyString,
    model: V2NonEmptyString,
    run_count: nonNegativeInteger,
    succeeded_runs: nonNegativeInteger,
    failed_runs: nonNegativeInteger,
    active_coding_seconds: nonNegativeNumber,
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
    total_tokens: nonNegativeInteger,
    total_cost_usd: nonNegativeMoney.nullable(),
    cost_coverage_rate: z.number().min(0).max(1).finite(),
  })
  .strict();

const taskMetricBreakdown = z
  .object({
    task_id: V2EntityId,
    phase_id: V2EntityId,
    title: V2NonEmptyString,
    complexity: z.enum(["S", "M", "L", "XL"]),
    risk: z.enum(["low", "medium", "high", "critical"]),
    state: z.enum([
      "pending",
      "ready",
      "assigned",
      "in_progress",
      "verifying",
      "in_review",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ]),
    attempt_count: nonNegativeInteger,
    active_coding_seconds: nonNegativeNumber,
    delivery_seconds: nonNegativeNumber.nullable(),
    input_tokens: nonNegativeInteger,
    output_tokens: nonNegativeInteger,
    total_tokens: nonNegativeInteger,
    total_cost_usd: nonNegativeMoney.nullable(),
    cost_coverage_rate: z.number().min(0).max(1).finite(),
    verification_passed: z.boolean(),
  })
  .strict();

export const V2ProjectCodingMetrics = z
  .object({
    project_id: V2EntityId,
    total_tasks: nonNegativeInteger,
    completed_tasks: nonNegativeInteger,
    completed_tasks_last_30_days: nonNegativeInteger,
    terminal_runs: nonNegativeInteger,
    active_coding_seconds: nonNegativeNumber,
    time_to_verified_delivery: deliveryTimeMetric,
    first_pass_yield: firstPassYieldMetric,
    tokens_per_accepted_task: tokenEfficiencyMetric,
    cost_per_accepted_task: costEfficiencyMetric,
    rework_ratio: reworkMetric,
    change_failure_rate: changeFailureMetric,
    phase_breakdown: z.array(phaseMetricBreakdown),
    agent_breakdown: z.array(agentMetricBreakdown),
    task_breakdown: z.array(taskMetricBreakdown).max(50),
  })
  .strict()
  .superRefine((metrics, ctx) => {
    if (
      metrics.completed_tasks > metrics.total_tasks ||
      metrics.completed_tasks_last_30_days > metrics.completed_tasks
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completed_tasks"],
        message: "completed task counts cannot exceed their enclosing totals",
      });
    }
    if (metrics.first_pass_yield.first_pass_tasks > metrics.first_pass_yield.completed_tasks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["first_pass_yield", "first_pass_tasks"],
        message: "first-pass tasks cannot exceed completed tasks",
      });
    }
    if (metrics.rework_ratio.rework_tokens > metrics.rework_ratio.total_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rework_ratio", "rework_tokens"],
        message: "rework tokens cannot exceed total tokens",
      });
    }
    if (
      metrics.change_failure_rate.failed_deployments >
      metrics.change_failure_rate.terminal_deployments
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["change_failure_rate", "failed_deployments"],
        message: "failed deployments cannot exceed terminal deployments",
      });
    }
  });
export type V2ProjectCodingMetricsT = z.infer<typeof V2ProjectCodingMetrics>;

const recentVerification = z.array(
  z
    .object({
      id: V2EntityId,
      project_id: V2EntityId,
      phase_id: V2EntityId,
      task_id: V2EntityId,
      run_id: V2EntityId,
      work_item_id: V2EntityId.nullable(),
      conversation_id: V2EntityId.nullable(),
      commit_sha: V2GitCommitSha,
      passed: z.boolean(),
      evidence: z.array(V2EvidenceRef),
      deep_link: V2NonEmptyString.nullable(),
      created_at: V2IsoDateTime,
    })
    .strict(),
);

const legacyPlanningRuns = z.array(
  z
    .object({
      id: V2EntityId,
      project_id: V2EntityId,
      label: V2NonEmptyString,
      status: V2NonEmptyString,
      content_hash: V2Sha256Hex.nullable(),
      created_at: V2IsoDateTime,
      legacy: z.literal(true),
    })
    .strict(),
);

export const V2ProjectArtifactSummary = z
  .object({
    project_id: V2EntityId,
    kind: V2ArtifactKind,
    artifact: V2EvidenceRef,
    created_at: V2IsoDateTime,
  })
  .strict();
export type V2ProjectArtifactSummaryT = z.infer<typeof V2ProjectArtifactSummary>;

export const V2ProjectDashboard = z
  .object({
    schema_version: z.literal(2),
    project_id: V2EntityId,
    generated_at: V2IsoDateTime,
    active_work: dashboardSection("workflow_state", activeWork),
    needs_attention: dashboardSection("attention_projection", needsAttention),
    open_decisions: dashboardSection("human_waits_and_decisions", openDecisions),
    budget: dashboardSection("usage_ledger_and_approved_plan", budget),
    coding_metrics: dashboardSection("coding_metrics", V2ProjectCodingMetrics),
    recent_deployments: dashboardSection("deployment_observations", z.array(dashboardDeployment)),
    recent_verification: dashboardSection("verification_results", recentVerification),
    conversations: dashboardSection("work_conversations", z.array(V2WorkConversation)),
    approved_mockups: dashboardSection("mockup_decisions", z.array(V2ConversationMockupVersion)),
    recent_artifacts: dashboardSection("artifact_metadata", z.array(V2ProjectArtifactSummary)),
    legacy_planning_runs: dashboardSection("legacy_planning_runs", legacyPlanningRuns),
  })
  .strict()
  .superRefine((dashboard, ctx) => {
    if (dashboard.active_work.availability === "available") {
      for (const [index, item] of dashboard.active_work.data.entries()) {
        if (item.work_item.project_id !== dashboard.project_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["active_work", "data", index, "work_item", "project_id"],
            message: "dashboard work must belong to the requested project",
          });
        }
        if (["completed", "cancelled"].includes(item.work_item.status)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["active_work", "data", index, "work_item", "status"],
            message: "terminal work cannot appear in the active-work section",
          });
        }
        if (
          item.phase_progress !== null &&
          item.phase_progress.phase_id !== item.work_item.phase_id
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["active_work", "data", index, "phase_progress", "phase_id"],
            message: "phase progress must describe the work item's exact phase",
          });
        }
      }
    }
    if (dashboard.recent_deployments.availability === "available") {
      for (const [index, deployment] of dashboard.recent_deployments.data.entries()) {
        if (deployment.deployment.project_id !== dashboard.project_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["recent_deployments", "data", index, "deployment", "project_id"],
            message: "dashboard deployments must belong to the requested project",
          });
        }
      }
    }
    const scopedSections = [
      ["needs_attention", dashboard.needs_attention],
      ["open_decisions", dashboard.open_decisions],
      ["recent_verification", dashboard.recent_verification],
      ["recent_artifacts", dashboard.recent_artifacts],
      ["legacy_planning_runs", dashboard.legacy_planning_runs],
    ] as const;
    for (const [sectionName, section] of scopedSections) {
      if (section.availability !== "available") continue;
      for (const [index, row] of section.data.entries()) {
        if (row.project_id !== dashboard.project_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [sectionName, "data", index, "project_id"],
            message: "dashboard section rows must belong to the requested project",
          });
        }
      }
    }
    if (
      dashboard.budget.availability === "available" &&
      dashboard.budget.data.project_id !== dashboard.project_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget", "data", "project_id"],
        message: "dashboard budget must belong to the requested project",
      });
    }
    if (
      dashboard.coding_metrics.availability === "available" &&
      dashboard.coding_metrics.data.project_id !== dashboard.project_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coding_metrics", "data", "project_id"],
        message: "dashboard coding metrics must belong to the requested project",
      });
    }
    if (dashboard.conversations.availability === "available") {
      for (const [index, conversation] of dashboard.conversations.data.entries()) {
        if (conversation.project_id !== dashboard.project_id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["conversations", "data", index, "project_id"],
            message: "dashboard conversations must belong to the requested project",
          });
        }
      }
    }
    if (dashboard.approved_mockups.availability === "available") {
      for (const [index, mockup] of dashboard.approved_mockups.data.entries()) {
        if (mockup.project_id !== dashboard.project_id || mockup.status !== "approved") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["approved_mockups", "data", index],
            message: "approved mockups must be approved versions from the requested project",
          });
        }
      }
    }
  });
export type V2ProjectDashboardT = z.infer<typeof V2ProjectDashboard>;
