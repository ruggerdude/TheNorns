import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DebateActor, DebateDto } from "./Debates";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Field, Select, Spinner, TextArea } from "./ui";

interface DebateEvent {
  id: string;
  sequence: number;
  type: string;
  round_number: number | null;
  turn_number: number | null;
  actor_snapshot: DebateActor | null;
  payload: Record<string, unknown>;
  artifact_ids: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    latency_ms?: number;
  } | null;
  occurred_at: string;
}

interface DebateRunDto {
  id: string;
  debate_id?: string;
  status: string;
  aggregate_version?: number;
  version?: number;
  current_round?: number;
  current_turn?: number;
  total_usage?: { input_tokens: number; output_tokens: number; cost_usd: number };
  reserved_usd?: number;
  settled_usd?: number;
  retained_ambiguous_usd?: number;
  judgment?: { summary?: string; confidence?: number; findings?: Finding[] } | null;
  final_output?: { title?: string; content?: string; artifact_id?: string } | null;
}

interface Finding {
  key?: string;
  severity?: "must_fix" | "should_fix" | "suggestion";
  finding: string;
  recommendation?: string;
  disposition?: string;
}

interface EventsResponse {
  events?: DebateEvent[];
  latest_version?: number;
  next_after_version?: number;
}

const terminal = new Set(["completed", "cancelled", "failed"]);

function idempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
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
  if (!response.ok)
    throw new ApiError(
      json.message ?? json.error ?? `request failed: ${response.status}`,
      response.status,
    );
  return json;
}

function textOf(payload: Record<string, unknown>): string | null {
  for (const key of ["content", "summary", "message", "output", "detail"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function findingsOf(payload: Record<string, unknown>): Finding[] {
  const findings = payload.findings;
  return Array.isArray(findings)
    ? findings.filter((finding): finding is Finding =>
        Boolean(
          finding &&
            typeof finding === "object" &&
            typeof (finding as Finding).finding === "string",
        ),
      )
    : [];
}

function BudgetMeter({
  label,
  amount,
  limit,
  tone = "info",
}: {
  label: string;
  amount: number;
  limit: number;
  tone?: "info" | "warn" | "danger";
}): React.ReactElement {
  const percent = limit > 0 ? Math.min(100, (amount / limit) * 100) : 0;
  return (
    <div className="debate-budget-meter">
      <div>
        <span>{label}</span>
        <strong>
          ${amount.toFixed(2)} / ${limit.toFixed(2)}
        </strong>
      </div>
      <div className={`debate-meter-track tone-${tone}`}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function actorName(actor: DebateActor | null): string {
  return actor ? `${actor.display_name} · ${actor.role_label}` : "Debate system";
}

export function DebateRun({
  projectId,
  debateId,
  onUnauthorized,
  onBack,
}: {
  projectId: string;
  debateId: string;
  onUnauthorized: () => void;
  onBack: () => void;
}): React.ReactElement {
  const base = `/api/v2/projects/${projectId}/debates/${debateId}`;
  const [debate, setDebate] = useState<DebateDto | null>(null);
  const [run, setRun] = useState<DebateRunDto | null>(null);
  const [events, setEvents] = useState<DebateEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [directionTarget, setDirectionTarget] = useState("all");
  const [directionText, setDirectionText] = useState("");
  const [interventionKind, setInterventionKind] = useState<"direction" | "statement">("direction");
  const cursor = useRef(0);
  const eventIds = useRef(new Set<string>());

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    },
    [onUnauthorized],
  );

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await request<DebateDto>(base);
      setDebate(next);
      const candidateId = next.run?.id ?? next.active_run_id;
      if (candidateId) {
        const nextRun = await request<DebateRunDto>(`${base}/runs/${candidateId}`);
        setRun(nextRun);
      }
    } catch (caught) {
      handleError(caught);
    }
  }, [base, handleError]);

  const loadEvents = useCallback(async () => {
    try {
      const runId = run?.id ?? debate?.run?.id ?? debate?.active_run_id;
      if (!runId) return;
      const response = await request<EventsResponse | DebateEvent[]>(
        `${base}/runs/${runId}/events?after_version=${cursor.current}`,
      );
      const page = Array.isArray(response) ? response : (response.events ?? []);
      const nextCursor = Array.isArray(response)
        ? undefined
        : (response.next_after_version ?? response.latest_version);
      if (page.length) {
        setEvents((current) => {
          const additions = page.filter((event) => !eventIds.current.has(event.id));
          for (const event of additions) eventIds.current.add(event.id);
          return [...current, ...additions].sort((left, right) => left.sequence - right.sequence);
        });
        cursor.current = Math.max(cursor.current, ...page.map((event) => event.sequence));
      }
      if (nextCursor !== undefined) cursor.current = Math.max(cursor.current, nextCursor);
    } catch (caught) {
      handleError(caught);
    }
  }, [base, debate?.active_run_id, debate?.run?.id, handleError, run?.id]);

  useEffect(() => void loadSnapshot(), [loadSnapshot]);
  useEffect(() => {
    if (!run?.id && !debate?.active_run_id && !debate?.run?.id) return;
    void loadEvents();
    if (terminal.has(run?.status ?? debate?.status ?? "")) return;
    const timer = window.setInterval(() => {
      void loadSnapshot();
      void loadEvents();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [
    debate?.active_run_id,
    debate?.run?.id,
    debate?.status,
    loadEvents,
    loadSnapshot,
    run?.id,
    run?.status,
  ]);

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      const created = await request<DebateRunDto>(`${base}/runs`, "POST", {
        idempotency_key: idempotencyKey("start-debate"),
      });
      setRun(created);
      cursor.current = 0;
      eventIds.current.clear();
      setEvents([]);
      await loadSnapshot();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  };

  const control = async (
    action: "pause" | "resume" | "stop_after_turn" | "stop_after_round" | "cancel",
  ) => {
    const runId = run?.id ?? debate?.run?.id ?? debate?.active_run_id;
    if (!runId) return;
    setBusy(action);
    setError(null);
    try {
      const response = await request<DebateRunDto>(`${base}/runs/${runId}/control`, "POST", {
        action,
        expected_version:
          run?.aggregate_version ??
          run?.version ??
          debate?.aggregate_version ??
          debate?.revision ??
          1,
        idempotency_key: idempotencyKey(`debate-${action}`),
      });
      setRun(response);
      await loadSnapshot();
      await loadEvents();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  };

  const intervene = async () => {
    const runId = run?.id ?? debate?.run?.id ?? debate?.active_run_id;
    if (!runId || !directionText.trim()) return;
    setBusy("intervention");
    setError(null);
    try {
      await request(`${base}/runs/${runId}/interventions`, "POST", {
        kind: interventionKind,
        target: directionTarget,
        text: directionText.trim(),
        apply_at: "next_turn",
        idempotency_key: idempotencyKey("debate-intervention"),
      });
      setDirectionText("");
      await loadEvents();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  };

  const actors = debate?.configuration.actors ?? [];
  const budgetLimit = debate?.configuration.policy.max_total_cost_usd ?? 0;
  const settled = run?.settled_usd ?? debate?.settled_usd ?? 0;
  const reserved = run?.reserved_usd ?? debate?.reserved_usd ?? 0;
  const retained = run?.retained_ambiguous_usd ?? debate?.retained_ambiguous_usd ?? 0;
  const findings = useMemo(() => events.flatMap((event) => findingsOf(event.payload)), [events]);
  const judgment = run?.judgment;
  const finalOutput = run?.final_output;
  const state = run?.status ?? debate?.status;

  if (!debate)
    return (
      <section className="debates-page">
        <Button onClick={onBack}>Back to debates</Button>
        {error ? <Alert>{error}</Alert> : <Spinner label="Loading debate…" />}
      </section>
    );

  return (
    <section className="debates-page debate-run" aria-labelledby="debate-run-heading">
      <div className="debates-head">
        <div>
          <div className="eyebrow">Live debate</div>
          <h2 id="debate-run-heading">{debate.configuration.title}</h2>
          <p className="muted">{debate.configuration.question}</p>
        </div>
        <div className="actions">
          <Button onClick={onBack}>Back to debates</Button>
          {state === "draft" ? (
            <Button variant="primary" disabled={busy === "start"} onClick={() => void start()}>
              {busy === "start" ? "Starting…" : "Start debate"}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="debate-run-stats">
        <div>
          <strong>{state?.replaceAll("_", " ")}</strong>
          <span>Status</span>
        </div>
        <div>
          <strong>{run?.current_round ?? debate.current_round}</strong>
          <span>Round</span>
        </div>
        <div>
          <strong>{run?.current_turn ?? debate.current_turn}</strong>
          <span>Turn</span>
        </div>
        <div>
          <strong>{events.length}</strong>
          <span>Replay events</span>
        </div>
      </div>
      <div className="debate-run-layout">
        <main className="debate-transcript">
          <section className="card">
            <div className="section-head">
              <div>
                <div className="eyebrow">Transcript</div>
                <h3>Rounds and turns</h3>
              </div>
              <span className="muted">Cursor {cursor.current}</span>
            </div>
            {events.length === 0 ? (
              <p className="muted">
                No transcript events yet. The durable replay cursor will advance as turns complete.
              </p>
            ) : null}
            <div className="debate-event-list">
              {events.map((event) => {
                const content = textOf(event.payload);
                const eventFindings = findingsOf(event.payload);
                return (
                  <article className={`debate-event event-${event.type}`} key={event.id}>
                    <div className="debate-event-head">
                      <div>
                        <Badge
                          tone={
                            event.type.includes("failed")
                              ? "danger"
                              : event.type.includes("completed")
                                ? "success"
                                : "info"
                          }
                        >
                          {event.type.replaceAll("_", " ")}
                        </Badge>
                        <strong>{actorName(event.actor_snapshot)}</strong>
                      </div>
                      <time dateTime={event.occurred_at}>
                        R{event.round_number ?? "–"} · T{event.turn_number ?? "–"}
                      </time>
                    </div>
                    {event.actor_snapshot ? (
                      <p className="debate-event-attribution">
                        {event.actor_snapshot.provider} · {event.actor_snapshot.model} ·{" "}
                        {event.actor_snapshot.role_label}
                      </p>
                    ) : null}
                    {content ? <p className="debate-event-content">{content}</p> : null}
                    {event.usage ? (
                      <p className="muted">
                        {event.usage.input_tokens.toLocaleString()} input ·{" "}
                        {event.usage.output_tokens.toLocaleString()} output · $
                        {event.usage.cost_usd.toFixed(4)}
                      </p>
                    ) : null}
                    {event.artifact_ids.length ? (
                      <div className="debate-artifact-row">
                        <strong>Artifacts</strong>
                        {event.artifact_ids.map((id) => (
                          <code key={id}>{id}</code>
                        ))}
                      </div>
                    ) : null}
                    {eventFindings.length ? (
                      <div className="debate-finding-list">
                        {eventFindings.map((finding, index) => (
                          <div key={`${event.id}-${index}`}>
                            <Badge tone={finding.severity === "must_fix" ? "danger" : "warn"}>
                              {finding.severity ?? "finding"}
                            </Badge>
                            <strong>{finding.finding}</strong>
                            {finding.recommendation ? <span>{finding.recommendation}</span> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
          {finalOutput ? (
            <section className="card debate-final-output">
              <div className="eyebrow">Final output</div>
              <h3>{finalOutput.title ?? "Synthesis"}</h3>
              <p>{finalOutput.content ?? "A final output artifact is available."}</p>
              {finalOutput.artifact_id ? <code>{finalOutput.artifact_id}</code> : null}
            </section>
          ) : null}
        </main>
        <aside className="debate-run-rail">
          <section className="card">
            <div className="eyebrow">Budget</div>
            <h3>Hard-cap accounting</h3>
            <BudgetMeter
              label="Settled"
              amount={settled}
              limit={budgetLimit}
              tone={settled >= budgetLimit ? "danger" : "info"}
            />
            <BudgetMeter label="Reserved" amount={reserved} limit={budgetLimit} tone="warn" />
            {retained > 0 ? (
              <BudgetMeter
                label="Retained pending reconciliation"
                amount={retained}
                limit={budgetLimit}
                tone="danger"
              />
            ) : null}
            <p className="muted">
              ${Math.max(0, budgetLimit - settled - reserved - retained).toFixed(2)} available after
              active reservations.
            </p>
          </section>
          <section className="card">
            <div className="eyebrow">Participants</div>
            <h3>Attribution</h3>
            <div className="debate-participant-list">
              {actors.map((actor) => (
                <article key={actor.id}>
                  <strong>{actor.display_name}</strong>
                  <span>
                    {actor.kind} · {actor.role_label}
                  </span>
                  <span>
                    {actor.provider} · {actor.model}
                  </span>
                  <small>
                    ${actor.budget_limit_usd.toFixed(2)} cap · {actor.max_turns} turns
                  </small>
                </article>
              ))}
            </div>
          </section>
          {judgment ? (
            <section className="card">
              <div className="eyebrow">Judgment</div>
              <h3>
                {judgment.confidence === undefined
                  ? "Judge report"
                  : `${Math.round(judgment.confidence * 100)}% confidence`}
              </h3>
              <p>{judgment.summary ?? "Judge output recorded."}</p>
            </section>
          ) : null}
          {findings.length ? (
            <section className="card">
              <div className="eyebrow">Findings</div>
              <h3>{findings.length} recorded</h3>
              <ul className="debate-findings">
                {findings.map((finding, index) => (
                  <li key={`${finding.key ?? finding.finding}-${index}`}>{finding.finding}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {!terminal.has(state ?? "") && state !== "draft" ? (
            <section className="card debate-controls">
              <div className="eyebrow">Controls</div>
              <h3>Human control</h3>
              <div className="actions">
                <Button
                  className="btn-small"
                  disabled={busy !== null}
                  onClick={() => void control(state === "paused" ? "resume" : "pause")}
                >
                  {state === "paused" ? "Resume" : "Pause"}
                </Button>
                <Button
                  className="btn-small"
                  disabled={busy !== null}
                  onClick={() => void control("stop_after_turn")}
                >
                  Stop after turn
                </Button>
                <Button
                  className="btn-small"
                  disabled={busy !== null}
                  onClick={() => void control("stop_after_round")}
                >
                  Stop after round
                </Button>
                <Button
                  className="btn-small"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void control("cancel")}
                >
                  Cancel
                </Button>
              </div>
            </section>
          ) : null}
          {!terminal.has(state ?? "") && state !== "draft" ? (
            <section className="card debate-intervention">
              <div className="eyebrow">Human intervention</div>
              <h3>Queue guidance</h3>
              <Field label="Kind">
                <Select
                  value={interventionKind}
                  onChange={(event) =>
                    setInterventionKind(event.target.value as "direction" | "statement")
                  }
                >
                  <option value="direction">Direction for next turn</option>
                  <option value="statement">Human statement</option>
                </Select>
              </Field>
              <Field label="Target">
                <Select
                  value={directionTarget}
                  onChange={(event) => setDirectionTarget(event.target.value)}
                >
                  <option value="all">All actors</option>
                  {actors
                    .filter((actor) => actor.enabled)
                    .map((actor) => (
                      <option key={actor.id} value={actor.id}>
                        {actor.display_name || actor.role_label || actor.id}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Message">
                <TextArea
                  value={directionText}
                  placeholder="Add constraints, evidence, or a question for the next turn…"
                  onChange={(event) => setDirectionText(event.target.value)}
                />
              </Field>
              <Button
                variant="primary"
                disabled={busy !== null || !directionText.trim()}
                onClick={() => void intervene()}
              >
                {busy === "intervention" ? "Recording…" : "Record intervention"}
              </Button>
            </section>
          ) : null}
        </aside>
      </div>
      {debate.stop_reason ? <Alert>Stopped: {debate.stop_reason}</Alert> : null}
    </section>
  );
}
