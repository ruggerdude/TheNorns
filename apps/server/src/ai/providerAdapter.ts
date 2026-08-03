import {
  AnthropicAdapter,
  DeepSeekAdapter,
  type LlmAdapter,
  OpenAiAdapter,
  type ProviderName,
} from "@norns/adapters";
import type { CodexReasoningEffortT } from "@norns/contracts";

export function providerApiKey(
  environment: Readonly<Record<string, string | undefined>>,
  provider: ProviderName,
): string | undefined {
  if (provider === "anthropic") return environment.ANTHROPIC_API_KEY;
  if (provider === "openai") return environment.OPENAI_API_KEY;
  return environment.DEEPSEEK_API_KEY;
}

export function providerApiKeyEnvironmentName(provider: ProviderName): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  return "DEEPSEEK_API_KEY";
}

export function configuredProviderModel(
  environment: Readonly<Record<string, string | undefined>>,
  provider: ProviderName,
): string | undefined {
  if (provider === "anthropic") return environment.NORNS_PM_MODEL;
  if (provider === "openai") return environment.NORNS_OPENAI_MODEL;
  return environment.NORNS_DEEPSEEK_MODEL;
}

export function createProviderAdapter(options: {
  provider: ProviderName;
  model: string;
  apiKey: string;
  reasoningEffort?: CodexReasoningEffortT;
}): LlmAdapter {
  if (options.provider === "anthropic") {
    return new AnthropicAdapter({ apiKey: options.apiKey, model: options.model });
  }
  if (options.provider === "openai") {
    return new OpenAiAdapter({
      apiKey: options.apiKey,
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    });
  }
  return new DeepSeekAdapter({ apiKey: options.apiKey, model: options.model });
}
