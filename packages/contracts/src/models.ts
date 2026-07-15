import { z } from "zod";

export const PmProvider = z.enum(["anthropic", "openai"]);
export type PmProviderT = z.infer<typeof PmProvider>;

export const AnthropicPmModel = z.enum([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
]);
export type AnthropicPmModelT = z.infer<typeof AnthropicPmModel>;

export const OpenAiPmModel = z.enum(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
export type OpenAiPmModelT = z.infer<typeof OpenAiPmModel>;

export const PmModel = z.union([AnthropicPmModel, OpenAiPmModel]);
export type PmModelT = z.infer<typeof PmModel>;

export interface PmModelOption {
  id: PmModelT;
  label: string;
  description: string;
}

/**
 * The supported project-manager models. Friendly labels stay separate from
 * canonical provider API IDs so the UI never has to infer one from the other.
 */
export const PM_MODEL_OPTIONS = {
  anthropic: [
    {
      id: "claude-fable-5",
      label: "Claude Fable 5",
      description: "Highest capability for complex plans and long-running agent work.",
    },
    {
      id: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      description: "Deep reasoning for complex coding and enterprise programs.",
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      description: "Balanced speed and intelligence for most projects.",
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      description: "Fast, economical planning for straightforward projects.",
    },
  ],
  openai: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      description: "Flagship reasoning for the most complex professional work.",
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      description: "Balanced intelligence and cost for most projects.",
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      description: "Cost-efficient planning for simpler, high-volume work.",
    },
  ],
} as const satisfies Record<PmProviderT, readonly PmModelOption[]>;

export const DEFAULT_PM_MODEL = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-terra",
} as const satisfies Record<PmProviderT, PmModelT>;

export function isPmModelForProvider(provider: PmProviderT, model: string): model is PmModelT {
  return PM_MODEL_OPTIONS[provider].some((option) => option.id === model);
}

export function providerForPmModel(model: PmModelT): PmProviderT {
  return AnthropicPmModel.safeParse(model).success ? "anthropic" : "openai";
}

export function pmModelOption(model: string): PmModelOption | undefined {
  for (const provider of PmProvider.options) {
    const option = PM_MODEL_OPTIONS[provider].find((candidate) => candidate.id === model);
    if (option) return option;
  }
  return undefined;
}
