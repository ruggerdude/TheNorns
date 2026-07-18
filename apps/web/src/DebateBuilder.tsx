import { useMemo, useState } from "react";
import type { AiModelOption, DebateActor, DebateDto, DebatePolicy } from "./Debates";
import { Alert, Badge, Button, Field, Input, Select, Spinner, TextArea } from "./ui";

type ActorKind = DebateActor["kind"];

interface ActorDraft
  extends Omit<
    DebateActor,
    "budget_limit_usd" | "max_turns" | "max_input_tokens" | "max_output_tokens"
  > {
  budget_limit_usd: string;
  max_turns: string;
  max_input_tokens: string;
  max_output_tokens: string;
}

export interface DebateDraft {
  idempotencyKey: string;
  configuration: {
    title: string;
    question: string;
    context_artifact_ids: string[];
    actors: DebateActor[];
    schedule: { kind: "round_robin"; participant_ids: string[] };
    policy: DebatePolicy;
  };
}

function key(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function blankActor(kind: ActorKind, position: number): ActorDraft {
  return {
    id: key(kind),
    kind,
    display_name: "",
    role_label: "",
    instructions: "",
    provider: "anthropic",
    model: "",
    runtime: "provider_api",
    enabled: kind === "participant",
    position,
    max_turns: "4",
    max_input_tokens: "12000",
    max_output_tokens: "4000",
    budget_limit_usd: "10",
  };
}

const defaultPolicy = (): DebatePolicy => ({
  exact_rounds: null,
  max_rounds: 3,
  max_duration_seconds: 1800,
  max_total_input_tokens: 120000,
  max_total_output_tokens: 40000,
  max_total_cost_usd: 50,
  stop_on_consensus: true,
  no_material_change_rounds: 2,
  repeated_disagreement_rounds: 2,
  provider_failure_threshold: 2,
});

function modelFor(provider: ActorDraft["provider"], models: AiModelOption[]): string {
  return (
    models.find((model) => model.provider === provider && model.configured !== false)?.id ?? ""
  );
}

function numeric(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ActorEditor({
  actor,
  models,
  onChange,
  onRemove,
  removable,
}: {
  actor: ActorDraft;
  models: AiModelOption[];
  onChange: (patch: Partial<ActorDraft>) => void;
  onRemove?: () => void;
  removable: boolean;
}): React.ReactElement {
  const available = models.filter(
    (model) => model.provider === actor.provider && model.configured !== false,
  );
  return (
    <article className="debate-actor-editor">
      <div className="section-head">
        <div>
          <div className="eyebrow">{actor.kind}</div>
          <strong>{actor.display_name || "Unnamed actor"}</strong>
        </div>
        <div className="actions">
          {actor.kind !== "participant" ? (
            <label className="debate-toggle">
              <input
                type="checkbox"
                checked={actor.enabled}
                onChange={(event) => onChange({ enabled: event.target.checked })}
              />
              Enabled
            </label>
          ) : null}
          {removable ? (
            <Button className="btn-small" variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      <div className="debate-builder-grid">
        <Field label="Display name">
          <Input
            value={actor.display_name}
            placeholder="e.g. Systems skeptic"
            onChange={(event) => onChange({ display_name: event.target.value })}
          />
        </Field>
        <Field label="Role label">
          <Input
            value={actor.role_label}
            placeholder="Any role you need"
            onChange={(event) => onChange({ role_label: event.target.value })}
          />
        </Field>
        <Field label="Provider">
          <Select
            value={actor.provider}
            onChange={(event) => {
              const provider = event.target.value as ActorDraft["provider"];
              onChange({ provider, model: modelFor(provider, models) });
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </Select>
        </Field>
        <Field label="Exact model">
          <Select value={actor.model} onChange={(event) => onChange({ model: event.target.value })}>
            <option value="">Select a configured model</option>
            {available.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Maximum turns">
          <Input
            type="number"
            min="1"
            value={actor.max_turns}
            onChange={(event) => onChange({ max_turns: event.target.value })}
          />
        </Field>
        <Field label="Budget cap (USD)">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={actor.budget_limit_usd}
            onChange={(event) => onChange({ budget_limit_usd: event.target.value })}
          />
        </Field>
        <Field label="Maximum input tokens">
          <Input
            type="number"
            min="1"
            value={actor.max_input_tokens}
            onChange={(event) => onChange({ max_input_tokens: event.target.value })}
          />
        </Field>
        <Field label="Maximum output tokens">
          <Input
            type="number"
            min="1"
            value={actor.max_output_tokens}
            onChange={(event) => onChange({ max_output_tokens: event.target.value })}
          />
        </Field>
      </div>
      <Field label="Instructions">
        <TextArea
          value={actor.instructions}
          placeholder="What perspective, evidence standard, and response style should this actor use?"
          onChange={(event) => onChange({ instructions: event.target.value })}
        />
      </Field>
    </article>
  );
}

export function DebateBuilder({
  projectId: _projectId,
  models,
  onCancel,
  onCreate,
  onCreated,
}: {
  projectId: string;
  models: AiModelOption[];
  onCancel: () => void;
  onCreate: (draft: DebateDraft) => Promise<DebateDto>;
  onCreated: (debate: DebateDto) => void;
}): React.ReactElement {
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [actors, setActors] = useState<ActorDraft[]>([
    blankActor("participant", 0),
    blankActor("participant", 1),
  ]);
  const [policy, setPolicy] = useState(defaultPolicy);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const participants = actors.filter((actor) => actor.kind === "participant" && actor.enabled);
  const maxExposure = actors
    .filter((actor) => actor.enabled)
    .reduce((total, actor) => total + (Number(actor.budget_limit_usd) || 0), 0);
  const validation = useMemo(() => {
    if (!title.trim() || !question.trim()) return "Add a title and a question.";
    if (participants.length < 2) return "A debate needs at least two enabled participants.";
    if (models.length === 0) return "No configured models are available.";
    for (const actor of actors.filter((entry) => entry.enabled)) {
      if (!actor.display_name.trim() || !actor.role_label.trim() || !actor.instructions.trim())
        return "Every enabled actor needs a name, role label, and instructions.";
      if (!actor.model) return "Choose an exact configured model for every enabled actor.";
      if (
        ![
          actor.max_turns,
          actor.max_input_tokens,
          actor.max_output_tokens,
          actor.budget_limit_usd,
        ].every((value) => numeric(value) !== null)
      )
        return "Actor turn, token, and budget caps must be positive.";
    }
    if (policy.exact_rounds !== null && policy.exact_rounds > policy.max_rounds)
      return "Fixed rounds cannot exceed the maximum round cap.";
    if (
      [
        policy.max_rounds,
        policy.max_duration_seconds,
        policy.max_total_input_tokens,
        policy.max_total_output_tokens,
        policy.max_total_cost_usd,
        policy.provider_failure_threshold,
      ].some((value) => !Number.isFinite(value) || value <= 0)
    )
      return "Stopping and budget controls must be positive.";
    return null;
  }, [actors, models.length, participants.length, policy, question, title]);

  const updateActor = (id: string, patch: Partial<ActorDraft>) =>
    setActors((current) =>
      current.map((actor) => (actor.id === id ? { ...actor, ...patch } : actor)),
    );
  const addActor = (kind: ActorKind) =>
    setActors((current) => [
      ...current,
      { ...blankActor(kind, current.length), enabled: kind === "participant" },
    ]);
  const optionalActor = (kind: "judge" | "synthesizer") =>
    actors.find((actor) => actor.kind === kind);

  const submit = async () => {
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const finalActors: DebateActor[] = actors.map((actor, position) => ({
        ...actor,
        position,
        max_turns: numeric(actor.max_turns) ?? 1,
        max_input_tokens: numeric(actor.max_input_tokens) ?? 1,
        max_output_tokens: numeric(actor.max_output_tokens) ?? 1,
        budget_limit_usd: numeric(actor.budget_limit_usd) ?? 0.01,
      }));
      const debate = await onCreate({
        idempotencyKey: key("create-debate"),
        configuration: {
          title: title.trim(),
          question: question.trim(),
          context_artifact_ids: [],
          actors: finalActors,
          schedule: { kind: "round_robin", participant_ids: participants.map((actor) => actor.id) },
          policy,
        },
      });
      onCreated(debate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="debates-page debate-builder" aria-labelledby="debate-builder-heading">
      <div className="debates-head">
        <div>
          <div className="eyebrow">New deliberation</div>
          <h2 id="debate-builder-heading">Build a debate</h2>
          <p className="muted">
            Roles are yours to define; model selections come only from configured capabilities.
          </p>
        </div>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="debate-builder-layout">
        <section className="card debate-setup-card">
          <Field label="Debate title">
            <Input
              value={title}
              placeholder="e.g. Select the migration strategy"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Question">
            <TextArea
              value={question}
              placeholder="What decision or claim should the participants examine?"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </Field>
          <div className="debate-policy-summary">
            <Badge tone={maxExposure > policy.max_total_cost_usd ? "warn" : "info"}>
              ${maxExposure.toFixed(2)} actor cap
            </Badge>
            <span>Global hard cap: ${policy.max_total_cost_usd.toFixed(2)}</span>
          </div>
        </section>
        <section className="card debate-policy-card">
          <div className="section-head">
            <div>
              <div className="eyebrow">Stopping policy</div>
              <h3>Bound the run</h3>
            </div>
          </div>
          <div className="debate-builder-grid">
            <Field label="Rounds">
              <Select
                value={policy.exact_rounds === null ? "max" : "fixed"}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    exact_rounds:
                      event.target.value === "fixed" ? Math.min(current.max_rounds, 1) : null,
                  }))
                }
              >
                <option value="max">Up to a maximum</option>
                <option value="fixed">Exactly this many</option>
              </Select>
            </Field>
            <Field label={policy.exact_rounds === null ? "Maximum rounds" : "Fixed rounds"}>
              <Input
                type="number"
                min="1"
                max="50"
                value={policy.exact_rounds ?? policy.max_rounds}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setPolicy((current) =>
                    current.exact_rounds === null
                      ? { ...current, max_rounds: value }
                      : {
                          ...current,
                          exact_rounds: value,
                          max_rounds: Math.max(value, current.max_rounds),
                        },
                  );
                }}
              />
            </Field>
            <Field label="Duration cap (seconds)">
              <Input
                type="number"
                min="1"
                value={policy.max_duration_seconds}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    max_duration_seconds: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <Field label="Global budget cap (USD)">
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={policy.max_total_cost_usd}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    max_total_cost_usd: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <Field label="Input token cap">
              <Input
                type="number"
                min="1"
                value={policy.max_total_input_tokens}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    max_total_input_tokens: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <Field label="Output token cap">
              <Input
                type="number"
                min="1"
                value={policy.max_total_output_tokens}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    max_total_output_tokens: Number(event.target.value),
                  }))
                }
              />
            </Field>
          </div>
          <label className="debate-toggle">
            <input
              type="checkbox"
              checked={policy.stop_on_consensus}
              onChange={(event) =>
                setPolicy((current) => ({ ...current, stop_on_consensus: event.target.checked }))
              }
            />{" "}
            Stop when the judge reports consensus
          </label>
          <div className="debate-builder-grid">
            <Field label="No-change rounds">
              <Input
                type="number"
                min="1"
                value={policy.no_material_change_rounds ?? ""}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    no_material_change_rounds: event.target.value
                      ? Number(event.target.value)
                      : null,
                  }))
                }
              />
            </Field>
            <Field label="Repeated-disagreement rounds">
              <Input
                type="number"
                min="1"
                value={policy.repeated_disagreement_rounds ?? ""}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    repeated_disagreement_rounds: event.target.value
                      ? Number(event.target.value)
                      : null,
                  }))
                }
              />
            </Field>
          </div>
        </section>
      </div>
      <section className="debate-actors-section">
        <div className="section-head">
          <div>
            <div className="eyebrow">Participants</div>
            <h3>Arguments and rebuttals</h3>
          </div>
          <Button className="btn-small" onClick={() => addActor("participant")}>
            Add participant
          </Button>
        </div>
        <Field label="Turn schedule">
          <Select value="round_robin" disabled>
            <option value="round_robin">Round robin in row order (MVP)</option>
          </Select>
        </Field>
        <div className="debate-actor-list">
          {actors
            .filter((actor) => actor.kind === "participant")
            .map((actor) => (
              <ActorEditor
                key={actor.id}
                actor={actor}
                models={models}
                onChange={(patch) => updateActor(actor.id, patch)}
                removable={participants.length > 2}
                onRemove={() =>
                  setActors((current) => current.filter((entry) => entry.id !== actor.id))
                }
              />
            ))}
        </div>
      </section>
      <section className="debate-specialists">
        {(["judge", "synthesizer"] as const).map((kind) => {
          const actor = optionalActor(kind);
          return (
            <div key={kind}>
              {actor ? (
                <ActorEditor
                  actor={actor}
                  models={models}
                  onChange={(patch) => updateActor(actor.id, patch)}
                  removable
                  onRemove={() =>
                    setActors((current) => current.filter((entry) => entry.id !== actor.id))
                  }
                />
              ) : (
                <Button onClick={() => addActor(kind)}>Add optional {kind}</Button>
              )}
            </div>
          );
        })}
      </section>
      <div className="debate-builder-actions">
        <Button onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={submitting || Boolean(validation)}
          onClick={() => void submit()}
        >
          {submitting ? "Creating debate…" : "Create debate"}
        </Button>
      </div>
      {submitting ? <Spinner label="Creating debate…" /> : null}
    </section>
  );
}
