// Resolves which provider/model pair the PM and reviewer use for a durable
// planning run (FRONT DOOR P2 §D1). The PM side is unchanged: it comes from
// the project's existing pmSelectionOf(). The reviewer side is new: a
// project may persist an explicit reviewer provider+model
// (planning_reviewer_settings); when absent, behavior falls back exactly to
// what the existing live-planning route already does (opposite-provider
// default, env-configured model). Cross-provider enforcement itself still
// lives entirely in runPlanning() — this module only picks the pairing.
import type { ProviderName } from "@norns/adapters";
import { PlanningModelProfile, type PlanningModelProfileT, type PmModelT } from "@norns/contracts";
import { reviewerFor as defaultReviewerProviderFor } from "../projects/store.js";

export { defaultReviewerProviderFor };

// ---------------------------------------------------------------------------
// PHASE TAB P1 legacy defaults remain exported for compatibility. New durable
// planning composition supplies a validated profile (balanced by default),
// while exact project selections, persisted reviewer settings, and the legacy
// exact-model environment variables continue to win. Cross-provider review
// enforcement is unchanged (runPlanning() refuses same-provider pairs).
// ---------------------------------------------------------------------------
export const PLANNING_RUN_DEFAULT_PM_MODEL = "claude-fable-5";
export const PLANNING_RUN_DEFAULT_REVIEWER_MODEL = "gpt-5.6-sol";
export const PLANNING_MODEL_PROFILE_ENV = "NORNS_PLANNING_MODEL_PROFILE";
export const DEFAULT_PLANNING_MODEL_PROFILE: PlanningModelProfileT = "balanced";

const PLANNING_PROFILE_MODELS = {
  quality: {
    anthropic: "claude-fable-5",
    openai: "gpt-5.6-sol",
    deepseek: "deepseek-v4-pro",
  },
  balanced: {
    anthropic: "claude-sonnet-5",
    openai: "gpt-5.6-terra",
    deepseek: "deepseek-v4-pro",
  },
  fast: {
    anthropic: "claude-haiku-4-5-20251001",
    openai: "gpt-5.6-luna",
    deepseek: "deepseek-v4-flash",
  },
} as const satisfies Record<PlanningModelProfileT, Record<ProviderName, PmModelT>>;

export interface PlanningModelEnvironment {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  NORNS_PM_MODEL?: string;
  NORNS_OPENAI_MODEL?: string;
  NORNS_DEEPSEEK_MODEL?: string;
  NORNS_REVIEWER_ANTHROPIC_MODEL?: string;
  NORNS_PLANNING_MODEL_PROFILE?: string;
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

export class PlanningModelProfileConfigurationError extends Error {
  constructor(readonly value: string) {
    super(
      `${PLANNING_MODEL_PROFILE_ENV} must be one of ${PlanningModelProfile.options.join(", ")}; received ${JSON.stringify(value)}`,
    );
    this.name = "PlanningModelProfileConfigurationError";
  }
}

export function planningModelProfileFromEnvironment(
  env: Pick<PlanningModelEnvironment, "NORNS_PLANNING_MODEL_PROFILE">,
): PlanningModelProfileT {
  const value = env.NORNS_PLANNING_MODEL_PROFILE?.trim() || DEFAULT_PLANNING_MODEL_PROFILE;
  const parsed = PlanningModelProfile.safeParse(value);
  if (!parsed.success) throw new PlanningModelProfileConfigurationError(value);
  return parsed.data;
}

export function planningModelForProvider(
  profile: PlanningModelProfileT,
  provider: ProviderName,
): PmModelT {
  return PLANNING_PROFILE_MODELS[profile][provider];
}

export function resolvePlanningParticipants(input: {
  pmSelection: { provider: ProviderName; model: string | null };
  /** From planning_reviewer_settings; null when the project has no override. */
  persistedReviewer: PersistedReviewerSelection | null;
  env: PlanningModelEnvironment;
  /** Deployment default PM model per provider (mirrors DEFAULT_PM_MODEL). */
  defaultPmModel: Record<ProviderName, string | undefined>;
  /** Validated deployment fallback. Exact project and environment selections
   * continue to win over this profile. */
  profile?: PlanningModelProfileT;
  /**
   * PHASE TAB P1: last-resort reviewer model default per provider, consulted
   * only after the persisted override and env vars. Callers that omit it keep
   * the exact pre-existing behavior (missing env surfaces as a
   * PlanningConfigurationError).
   */
  defaultReviewerModel?: Partial<Record<ProviderName, string>>;
}): ResolvedPlanningParticipants {
  const { pmSelection, persistedReviewer, env, defaultPmModel, defaultReviewerModel } = input;
  const profile = input.profile;
  const reviewerProvider =
    persistedReviewer?.provider ?? defaultReviewerProviderFor(pmSelection.provider);
  const configuredModel = (provider: ProviderName): string | undefined => {
    if (provider === "anthropic") return env.NORNS_PM_MODEL;
    if (provider === "openai") return env.NORNS_OPENAI_MODEL;
    return env.NORNS_DEEPSEEK_MODEL;
  };
  const configuredKey = (provider: ProviderName): string | undefined => {
    if (provider === "anthropic") return env.ANTHROPIC_API_KEY;
    if (provider === "openai") return env.OPENAI_API_KEY;
    return env.DEEPSEEK_API_KEY;
  };
  const keyName = (provider: ProviderName): string => {
    if (provider === "anthropic") return "ANTHROPIC_API_KEY";
    if (provider === "openai") return "OPENAI_API_KEY";
    return "DEEPSEEK_API_KEY";
  };
  const pmModel =
    pmSelection.model ??
    configuredModel(pmSelection.provider) ??
    (profile ? planningModelForProvider(profile, pmSelection.provider) : undefined) ??
    defaultPmModel[pmSelection.provider];
  const reviewerModel =
    persistedReviewer?.model ??
    (reviewerProvider === "anthropic" ? env.NORNS_REVIEWER_ANTHROPIC_MODEL : undefined) ??
    configuredModel(reviewerProvider) ??
    (profile ? planningModelForProvider(profile, reviewerProvider) : undefined) ??
    defaultReviewerModel?.[reviewerProvider] ??
    defaultPmModel[reviewerProvider];

  const missing = [
    !configuredKey(pmSelection.provider) && keyName(pmSelection.provider),
    !configuredKey(reviewerProvider) && keyName(reviewerProvider),
    !pmModel && `${pmSelection.provider} model`,
    !reviewerModel && `${reviewerProvider} reviewer model`,
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
