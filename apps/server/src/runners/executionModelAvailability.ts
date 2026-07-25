import {
  DEFAULT_MODEL_REGISTRY,
  type ModelEntry,
  type ProviderName,
  type SelectableModelCatalogEntry,
  buildSelectableModelCatalog,
} from "@norns/adapters";
import { RUNNER_ALLOWED_MODELS_ENV, parseRunnerAllowedModels } from "./inferenceProxy.js";

type ExecutionEnvironment = Readonly<Record<string, string | undefined>>;

function credentialPresent(provider: ProviderName, environment: ExecutionEnvironment): boolean {
  return Boolean(
    (provider === "anthropic" ? environment.ANTHROPIC_API_KEY : environment.OPENAI_API_KEY)?.trim(),
  );
}

/**
 * The execution catalog is deliberately derived from the same allowlist the
 * runner inference gateway enforces. Debate/PM availability is a separate
 * concern and must never make an execution model appear runnable.
 */
export function executionModelCatalogFromEnvironment(
  environment: ExecutionEnvironment,
  registry: Readonly<Record<string, ModelEntry>> = DEFAULT_MODEL_REGISTRY,
): SelectableModelCatalogEntry[] {
  const allowedModels = new Set(parseRunnerAllowedModels(environment[RUNNER_ALLOWED_MODELS_ENV]));
  return buildSelectableModelCatalog(
    Object.entries(registry)
      .filter(([, entry]) => entry.selectable)
      .map(([model, entry]) => {
        const selection = `${entry.provider}/${model}`;
        const allowed = allowedModels.has(selection);
        const hasCredential = credentialPresent(entry.provider, environment);
        const reason =
          allowedModels.size === 0
            ? "runner_model_allowlist_not_configured"
            : !allowed
              ? "model_not_in_runner_allowlist"
              : !hasCredential
                ? "provider_api_key_not_configured"
                : undefined;
        return {
          provider: entry.provider,
          model,
          available: allowed && hasCredential,
          ...(reason ? { reason } : {}),
        };
      }),
    registry,
  );
}

export function executionModelUnavailableMessage(
  provider: ProviderName,
  model: string,
  catalog: readonly SelectableModelCatalogEntry[],
): string | null {
  const entry = catalog.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (entry?.available) return null;
  if (!entry) {
    return `Execution agent ${provider}/${model} is not a selectable registered model.`;
  }
  if (entry.unavailable_reason === "provider_api_key_not_configured") {
    const key = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return `Execution agent ${provider}/${model} is allowlisted, but ${key} is not configured.`;
  }
  if (entry.unavailable_reason === "runner_model_allowlist_not_configured") {
    return `No execution agents are enabled. Configure ${RUNNER_ALLOWED_MODELS_ENV} with exact provider/model entries before starting work.`;
  }
  return `Execution agent ${provider}/${model} is not enabled by ${RUNNER_ALLOWED_MODELS_ENV}. Choose an available agent or add that exact provider/model entry.`;
}
