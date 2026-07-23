import type { LlmAdapter, ProviderName, SelectableModelCatalogEntry } from "@norns/adapters";
import type { UsageEventT } from "@norns/contracts";
import { z } from "zod";
import type { PmAssignmentRecommendation } from "../graph/allocation.js";
import type { GraphSnapshot } from "../graph/graph.js";

const Recommendation = z
  .object({
    node_id: z.string().min(1),
    provider: z.enum(["anthropic", "openai"]),
    model: z.string().min(1),
    worker_count: z.number().int().min(1).max(3),
    reviewer_model: z.string().min(1),
    budget_usd: z.number().finite().positive().max(1_000_000),
    rationale: z.string().min(1).max(2_000),
  })
  .strict();

const RecommendationSet = z
  .object({
    summary: z.string().min(1).max(4_000),
    recommendations: z.array(Recommendation).min(1),
  })
  .strict();

export class AllocationRecommendationError extends Error {
  constructor(
    readonly code:
      | "models_unavailable"
      | "node_coverage"
      | "model_unavailable"
      | "review_policy"
      | "parallelism"
      | "provider_constraint",
    message: string,
  ) {
    super(message);
    this.name = "AllocationRecommendationError";
  }
}

export interface AllocationRecommendationResult {
  summary: string;
  recommendations: PmAssignmentRecommendation[];
  usage: UsageEventT;
}

function providerModelKey(provider: ProviderName, model: string): string {
  return `${provider}:${model}`;
}

export async function recommendProjectAllocation(options: {
  pm: LlmAdapter;
  projectId: string;
  projectName: string;
  objective: string;
  graph: GraphSnapshot;
  models: readonly SelectableModelCatalogEntry[];
  /**
   * PHASE TAB P1: when set, every node's IMPLEMENTATION provider must come
   * from this list. Reviewers are exempt — the cross-provider review rule
   * (reviewer from the opposite provider) still applies and would be
   * unsatisfiable if reviewers were constrained to a single-provider list.
   */
  allowedWorkerProviders?: readonly ProviderName[];
}): Promise<AllocationRecommendationResult> {
  const availableModels = options.models.filter((model) => model.available);
  const providers = new Set(availableModels.map((model) => model.provider));
  if (!providers.has("anthropic") || !providers.has("openai")) {
    throw new AllocationRecommendationError(
      "models_unavailable",
      "PM staffing requires at least one approved worker model from each provider for cross-provider review.",
    );
  }
  const allowedProviders = new Set<ProviderName>(
    options.allowedWorkerProviders && options.allowedWorkerProviders.length > 0
      ? options.allowedWorkerProviders
      : (["anthropic", "openai"] as const),
  );

  const modelByKey = new Map(
    availableModels.map((model) => [providerModelKey(model.provider, model.model), model]),
  );
  const modelById = new Map(availableModels.map((model) => [model.model, model]));
  const graphForPrompt = options.graph.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    complexity: node.complexity,
    risk: node.risk,
    parallel_safe: node.parallel_safe,
    dependencies: node.dependencies,
    existing_human_override: node.assignment?.source === "override" ? node.assignment : null,
  }));
  const modelsForPrompt = availableModels.map((model) => ({
    provider: model.provider,
    model: model.model,
    label: model.label,
    input_usd_per_million_tokens: model.pricing.input_per_mtok,
    output_usd_per_million_tokens: model.pricing.output_per_mtok,
  }));
  const constraintLine =
    allowedProviders.size < 2
      ? [
          `Implementation-provider constraint: every node's implementation provider MUST be ${[...allowedProviders].join(" or ")}. Reviewers still come from the opposite provider.`,
        ]
      : [];
  const prompt = [
    `Staff the project "${options.projectName}" for its current workflow graph.`,
    `Objective: ${options.objective}`,
    "Choose the best implementation provider/model, worker count, cross-provider reviewer, and USD budget for every node.",
    "Use only the approved models listed below. Prefer the least expensive model that can reliably handle the work, but spend for capability where complexity or risk warrants it.",
    "Use more than one worker only when parallel_safe is true and the work is genuinely divisible. Never use the implementation provider as the reviewer provider.",
    ...constraintLine,
    "Return exactly one recommendation for every graph node. Human overrides are context and will remain authoritative.",
    `Approved models: ${JSON.stringify(modelsForPrompt)}`,
    `Workflow graph: ${JSON.stringify(graphForPrompt)}`,
  ].join("\n\n");

  const completion = await options.pm.completeStructured(
    {
      projectId: options.projectId,
      system:
        "You are the project's accountable program manager. Build a right-sized, cost-aware, cross-provider implementation team and explain each staffing decision.",
      prompt,
    },
    RecommendationSet,
    "project_allocation_recommendation",
  );

  const expectedNodeIds = new Set(options.graph.nodes.map((node) => node.id));
  const returnedNodeIds = new Set(completion.value.recommendations.map((item) => item.node_id));
  if (
    returnedNodeIds.size !== completion.value.recommendations.length ||
    returnedNodeIds.size !== expectedNodeIds.size ||
    [...expectedNodeIds].some((nodeId) => !returnedNodeIds.has(nodeId))
  ) {
    throw new AllocationRecommendationError(
      "node_coverage",
      "The project manager must return exactly one staffing recommendation for every graph node.",
    );
  }

  const nodesById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const recommendations = completion.value.recommendations.map((recommendation) => {
    if (!expectedNodeIds.has(recommendation.node_id)) {
      throw new AllocationRecommendationError(
        "node_coverage",
        `The project manager recommended an unknown node "${recommendation.node_id}".`,
      );
    }
    // PHASE TAB P1: enforce the run's implementation-provider constraint —
    // a model reply that ignores the prompt's constraint line is refused, not
    // silently accepted.
    if (!allowedProviders.has(recommendation.provider)) {
      throw new AllocationRecommendationError(
        "provider_constraint",
        `Node "${recommendation.node_id}" uses implementation provider ${recommendation.provider}, ` +
          `but this run only allows ${[...allowedProviders].join(", ")}.`,
      );
    }
    if (!modelByKey.has(providerModelKey(recommendation.provider, recommendation.model))) {
      throw new AllocationRecommendationError(
        "model_unavailable",
        `The project manager selected unavailable implementation model ${recommendation.provider}/${recommendation.model}.`,
      );
    }
    const reviewer = modelById.get(recommendation.reviewer_model);
    if (!reviewer) {
      throw new AllocationRecommendationError(
        "model_unavailable",
        `The project manager selected unavailable reviewer model ${recommendation.reviewer_model}.`,
      );
    }
    if (reviewer.provider === recommendation.provider) {
      throw new AllocationRecommendationError(
        "review_policy",
        `Node "${recommendation.node_id}" must use a reviewer from the opposite provider.`,
      );
    }
    const node = nodesById.get(recommendation.node_id);
    if (recommendation.worker_count > 1 && !node?.parallel_safe) {
      throw new AllocationRecommendationError(
        "parallelism",
        `Node "${recommendation.node_id}" is not marked safe for multiple workers.`,
      );
    }
    return {
      ...recommendation,
      budget_usd: Math.round(recommendation.budget_usd * 100) / 100,
    };
  });

  return {
    summary: completion.value.summary,
    recommendations,
    usage: completion.usage,
  };
}
