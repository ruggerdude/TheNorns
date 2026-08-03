import { PM_MODEL_OPTIONS, PmProvider, type PmProviderT } from "@norns/contracts";

export const AI_PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
} as const satisfies Record<PmProviderT, string>;

export const AI_PROVIDERS: readonly PmProviderT[] = PmProvider.options;

export const AI_PROVIDER_OPTIONS = AI_PROVIDERS.map((provider) => ({
  value: provider,
  label: AI_PROVIDER_LABELS[provider],
}));

export const PM_MODEL_GROUPS = AI_PROVIDER_OPTIONS.map(({ value, label }) => ({
  provider: value,
  label,
  models: PM_MODEL_OPTIONS[value],
}));

export function asAiProvider(value: string): PmProviderT | null {
  const parsed = PmProvider.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function aiProviderLabel(provider: string): string {
  const known = asAiProvider(provider);
  return known ? AI_PROVIDER_LABELS[known] : provider;
}

/** Mirrors the server's deterministic automatic cross-provider reviewer choice. */
export function defaultReviewerProviderFor(pmProvider: PmProviderT): PmProviderT {
  return pmProvider === "anthropic" ? "openai" : "anthropic";
}
