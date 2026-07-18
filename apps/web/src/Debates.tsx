import { useCallback, useEffect, useState } from "react";
import { DebateBuilder, type DebateDraft } from "./DebateBuilder";
import { DebateRun } from "./DebateRun";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Spinner } from "./ui";

export interface AiModelOption {
  id: string;
  label: string;
  provider: "anthropic" | "openai";
  description?: string;
  configured?: boolean;
}

export interface DebateActor {
  id: string;
  kind: "participant" | "judge" | "synthesizer";
  display_name: string;
  role_label: string;
  instructions: string;
  provider: "anthropic" | "openai";
  model: string;
  runtime?: "provider_api" | "codex" | "claude-code";
  enabled: boolean;
  position: number;
  max_turns: number;
  max_input_tokens: number;
  max_output_tokens: number;
  budget_limit_usd: number;
}

export interface DebatePolicy {
  exact_rounds: number | null;
  max_rounds: number;
  max_duration_seconds: number;
  max_total_input_tokens: number;
  max_total_output_tokens: number;
  max_total_cost_usd: number;
  stop_on_consensus: boolean;
  no_material_change_rounds: number | null;
  repeated_disagreement_rounds: number | null;
  provider_failure_threshold: number;
}

export interface DebateDto {
  id: string;
  project_id: string;
  status: string;
  revision: number;
  aggregate_version?: number;
  current_round: number;
  current_turn: number;
  latest_event_sequence?: number;
  reserved_usd: number;
  settled_usd: number;
  retained_ambiguous_usd: number;
  stop_reason: string | null;
  updated_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  active_run_id?: string | null;
  run?: { id: string; status?: string; aggregate_version?: number } | null;
  configuration: {
    title: string;
    question: string;
    actors: DebateActor[];
    schedule: { kind: "round_robin" | "explicit"; participant_ids: string[] };
    policy: DebatePolicy;
  };
}

interface ModelCatalogResponse {
  models?: Array<{
    id: string;
    label?: string;
    provider: "anthropic" | "openai";
    description?: string;
    configured?: boolean;
    available?: boolean;
  }>;
  providers?: Array<{
    id: "anthropic" | "openai";
    configured?: boolean;
    models?: Array<{
      id: string;
      label?: string;
      description?: string;
      configured?: boolean;
      available?: boolean;
    }>;
  }>;
}

export function catalogModels(response: ModelCatalogResponse): AiModelOption[] {
  const direct = response.models ?? [];
  const nested = (response.providers ?? []).flatMap((provider) =>
    (provider.models ?? []).map((model) => ({
      ...model,
      provider: provider.id,
      configured: model.configured ?? model.available ?? provider.configured,
    })),
  );
  const seen = new Set<string>();
  return [...direct, ...nested].flatMap((model) => {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        id: model.id,
        label: model.label ?? model.id,
        provider: model.provider,
        description: model.description,
        configured: model.configured ?? model.available ?? true,
      },
    ];
  });
}

async function debateRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const json = (await response.json().catch(() => ({}))) as T & {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      json.message ?? json.error ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return json;
}

type View = { kind: "list" } | { kind: "builder" } | { kind: "run"; debateId: string };

export function Debates({
  projectId,
  onUnauthorized,
  onBack,
}: {
  projectId: string;
  onUnauthorized: () => void;
  onBack?: () => void;
}): React.ReactElement {
  const [view, setView] = useState<View>({ kind: "list" });
  const [debates, setDebates] = useState<DebateDto[] | null>(null);
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [debateList, catalog] = await Promise.all([
        debateRequest<DebateDto[]>(`/api/v2/projects/${projectId}/debates`),
        debateRequest<ModelCatalogResponse>("/api/v2/capabilities/ai-models"),
      ]);
      setDebates(debateList);
      setModels(catalogModels(catalog));
    } catch (caught) {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [onUnauthorized, projectId]);

  useEffect(() => void load(), [load]);

  const create = useCallback(
    async (draft: DebateDraft): Promise<DebateDto> => {
      try {
        setError(null);
        const debate = await debateRequest<DebateDto>(
          `/api/v2/projects/${projectId}/debates`,
          "POST",
          {
            configuration: draft.configuration,
            idempotency_key: draft.idempotencyKey,
          },
        );
        setDebates((current) => [debate, ...(current ?? [])]);
        return debate;
      } catch (caught) {
        if (caught instanceof UnauthorizedError) onUnauthorized();
        throw caught;
      }
    },
    [onUnauthorized, projectId],
  );

  if (view.kind === "builder") {
    return (
      <DebateBuilder
        projectId={projectId}
        models={models}
        onCancel={() => setView({ kind: "list" })}
        onCreate={create}
        onCreated={(debate) => setView({ kind: "run", debateId: debate.id })}
      />
    );
  }
  if (view.kind === "run") {
    return (
      <DebateRun
        projectId={projectId}
        debateId={view.debateId}
        onUnauthorized={onUnauthorized}
        onBack={() => {
          setView({ kind: "list" });
          void load();
        }}
      />
    );
  }

  return (
    <section className="debates-page" aria-labelledby="debates-heading">
      <div className="debates-head">
        <div>
          <div className="eyebrow">Structured deliberation</div>
          <h2 id="debates-heading">Debates</h2>
          <p className="muted">Run a bounded, auditable discussion across any configured models.</p>
        </div>
        <div className="actions">
          {onBack ? <Button onClick={onBack}>Back to project</Button> : null}
          <Button variant="primary" onClick={() => setView({ kind: "builder" })}>
            New debate
          </Button>
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {!debates ? <Spinner label="Loading debates…" /> : null}
      {debates?.length === 0 ? (
        <div className="debates-empty">
          <strong>No debates yet</strong>
          <p>Configure participants, a stopping policy, and an optional judge or synthesizer.</p>
        </div>
      ) : null}
      <div className="debate-list">
        {debates?.map((debate) => (
          <article className="debate-list-item" key={debate.id}>
            <div>
              <div className="debate-list-meta">
                <Badge
                  tone={
                    debate.status === "completed"
                      ? "success"
                      : debate.status === "failed"
                        ? "danger"
                        : "info"
                  }
                >
                  {debate.status.replaceAll("_", " ")}
                </Badge>
                <span>Round {debate.current_round || 0}</span>
                <span>${debate.settled_usd.toFixed(2)} settled</span>
              </div>
              <h3>{debate.configuration.title}</h3>
              <p>{debate.configuration.question}</p>
              <small className="muted">
                {
                  debate.configuration.actors.filter(
                    (actor) => actor.kind === "participant" && actor.enabled,
                  ).length
                }{" "}
                participants · {debate.configuration.policy.max_rounds} round cap
              </small>
            </div>
            <Button
              className="btn-small"
              variant="primary"
              onClick={() => setView({ kind: "run", debateId: debate.id })}
            >
              {debate.status === "draft" ? "Configure" : "Open"}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
