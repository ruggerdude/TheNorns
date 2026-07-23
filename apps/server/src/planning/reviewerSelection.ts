// Resolves which provider/model pair the PM and reviewer use for a durable
// planning run (FRONT DOOR P2 §D1). The PM side is unchanged: it comes from
// the project's existing pmSelectionOf(). The reviewer side is new: a
// project may persist an explicit reviewer provider+model
// (planning_reviewer_settings); when absent, behavior falls back exactly to
// what the existing live-planning route already does (opposite-provider
// default, env-configured model). Cross-provider enforcement itself still
// lives entirely in runPlanning() — this module only picks the pairing.
import type { ProviderName } from "@norns/adapters";
import { reviewerFor as defaultReviewerProviderFor } from "../projects/store.js";

export { defaultReviewerProviderFor };

// ---------------------------------------------------------------------------
// PHASE TAB P1: pinned defaults for durable planning runs. The PM defaults to
// anthropic/claude-fable-5 and the reviewer to openai/gpt-5.6-sol (production
// allowlist), while every existing override still wins: the project's PM
// selection, the persisted per-project reviewer settings, and the
// NORNS_PM_MODEL / NORNS_OPENAI_MODEL / NORNS_REVIEWER_ANTHROPIC_MODEL env
// vars all take precedence over these constants. Cross-provider review
// enforcement is unchanged (runPlanning() refuses same-provider pairs).
// ---------------------------------------------------------------------------
export const PLANNING_RUN_DEFAULT_PM_MODEL = "claude-fable-5";
export const PLANNING_RUN_DEFAULT_REVIEWER_MODEL = "gpt-5.6-sol";

export interface PlanningModelEnvironment {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  NORNS_PM_MODEL?: string;
  NORNS_OPENAI_MODEL?: string;
  NORNS_REVIEWER_ANTHROPIC_MODEL?: string;
}

export interface PersistedReviewerSelection {
  provider: ProviderName;
  model: string;
}

export interface ResolvedPlanningParticipant {
  provider: ProviderName;
  model: string;
}

export interface ResolvedPlanningParticipants {
  pm: ResolvedPlanningParticipant;
  reviewer: ResolvedPlanningParticipant;
}

/** Thrown when the deployment lacks what's needed to run live planning. */
export class PlanningConfigurationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`live planning requires ${missing.join(", ")} to be set as environment variables`);
    this.name = "PlanningConfigurationError";
  }
}

export function resolvePlanningParticipants(input: {
  pmSelection: { provider: ProviderName; model: string | null };
  /** From planning_reviewer_settings; null when the project has no override. */
  persistedReviewer: PersistedReviewerSelection | null;
  env: PlanningModelEnvironment;
  /** Deployment default PM model per provider (mirrors DEFAULT_PM_MODEL). */
  defaultPmModel: Record<"anthropic" | "openai", string | undefined>;
  /**
   * PHASE TAB P1: last-resort reviewer model default per provider, consulted
   * only after the persisted override and env vars. Callers that omit it keep
   * the exact pre-existing behavior (missing env surfaces as a
   * PlanningConfigurationError).
   */
  defaultReviewerModel?: Partial<Record<"anthropic" | "openai", string>>;
}): ResolvedPlanningParticipants {
  const { pmSelection, persistedReviewer, env, defaultPmModel, defaultReviewerModel } = input;
  const reviewerProvider =
    persistedReviewer?.provider ?? defaultReviewerProviderFor(pmSelection.provider);
  const pmModel =
    pmSelection.model ??
    (pmSelection.provider === "anthropic"
      ? (env.NORNS_PM_MODEL ?? defaultPmModel.anthropic)
      : env.NORNS_OPENAI_MODEL);
  const reviewerModel =
    persistedReviewer?.model ??
    (reviewerProvider === "openai"
      ? (env.NORNS_OPENAI_MODEL ?? defaultReviewerModel?.openai)
      : (env.NORNS_REVIEWER_ANTHROPIC_MODEL ??
        env.NORNS_PM_MODEL ??
        defaultReviewerModel?.anthropic ??
        defaultPmModel.anthropic));

  const missing = [
    !env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
    !env.OPENAI_API_KEY && "OPENAI_API_KEY",
    !pmModel && "NORNS_OPENAI_MODEL",
    reviewerProvider === "openai" && !reviewerModel && "NORNS_OPENAI_MODEL",
  ].filter(
    (value, index, values): value is string =>
      typeof value === "string" && values.indexOf(value) === index,
  );
  if (missing.length > 0) throw new PlanningConfigurationError(missing);

  return {
    pm: { provider: pmSelection.provider, model: pmModel as string },
    reviewer: { provider: reviewerProvider, model: reviewerModel as string },
  };
}
