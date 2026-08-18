// EXECUTION E13 — live activity: the run's streamed `run_log` output, tailed
// from `GET .../tasks/:taskId/run-log` (see `AttentionService.runLog` for the
// tail/`after`-cursor server contract).
//
// POLLING CADENCE: fast (POLL_MS) and FIXED while the run is active — a
// running agent needs faster feedback than the human's configured idle poll
// interval, which is the same call App.tsx makes for phase-execution polling
// (see the comment there). The moment `active` flips false this component
// does exactly ONE more fetch (to catch the run's last lines) and then stops
// polling entirely — a finished run's log does not change again.
//
// BOUNDING: the server already bounds what one response can contain
// (RUN_LOG_PAGE_LIMIT). This component ALSO bounds what it keeps in memory
// and renders (MAX_CLIENT_ENTRIES / MAX_CLIENT_CHARS), independently, so a
// long-lived session watching a chatty agent cannot accumulate an unbounded
// DOM even if the server-side bound were ever relaxed. Whenever either bound
// drops something the human hasn't seen, that is disclosed, never silent.
import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders } from "./auth";
import { useSingleFlightPolling } from "./useSingleFlightPolling";

export interface RunLogEntryDto {
  sequence: number;
  occurred_at: string;
  chunk: string;
}

export interface RunLogTailDto {
  run_id: string | null;
  entries: RunLogEntryDto[];
  truncated: boolean;
  total_entries: number | null;
}

const POLL_MS = 3_000;
const MAX_CLIENT_ENTRIES = 500;
const MAX_CLIENT_CHARS = 100_000;
const MAX_VISIBLE_ACTIVITIES = 60;

type RunActivity = {
  sequence: number;
  occurredAt: string;
  kind: "session" | "reasoning" | "tool" | "message" | "result";
  text: string;
};

const LEGACY_TOOL_ACTIVITY: Record<string, string> = {
  Read: "Inspecting project files",
  Glob: "Inspecting project files",
  Grep: "Inspecting project files",
  Edit: "Editing project files",
  Write: "Editing project files",
  Bash: "Running a development command",
};

function legacyToolActivity(value: unknown, raw: string): string | null {
  const names: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const message = record.message;
    if (record.type === "assistant" && message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const block = item as Record<string, unknown>;
          if (block.type === "tool_use" && typeof block.name === "string") {
            names.push(block.name);
          }
        }
      }
    }
  }
  // Older runners can truncate a large assistant SDK event before the JSON
  // closes. Recover only a fixed allowlist of tool names from that envelope;
  // never expose its free-form input, command, path, prompt, or reasoning.
  if (names.length === 0 && /"type"\s*:\s*"assistant"/.test(raw)) {
    for (const match of raw.matchAll(/"name"\s*:\s*"(Read|Glob|Grep|Edit|Write|Bash)"/g)) {
      if (match[1]) names.push(match[1]);
    }
  }
  const priority = ["Edit", "Write", "Bash", "Read", "Glob", "Grep"];
  const name = priority.find((candidate) => names.includes(candidate));
  return name ? (LEGACY_TOOL_ACTIVITY[name] ?? null) : null;
}

function activityFromEntry(entry: RunLogEntryDto): RunActivity | null {
  const chunk = entry.chunk.trim();
  if (!chunk) return null;
  let value: unknown;
  try {
    value = JSON.parse(chunk);
  } catch {
    const legacyActivity = legacyToolActivity(null, chunk);
    if (legacyActivity) {
      return {
        sequence: entry.sequence,
        occurredAt: entry.occurred_at,
        kind: "tool",
        text: legacyActivity,
      };
    }
    if (chunk.startsWith("{")) return null;
    return {
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      kind: "message",
      text: chunk,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "norns_activity" && typeof record.text === "string") {
    return {
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      kind: "tool",
      text: record.text,
    };
  }
  const legacyActivity = legacyToolActivity(record, chunk);
  if (legacyActivity) {
    return {
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      kind: "tool",
      text: legacyActivity,
    };
  }
  if (record.type === "result") {
    return {
      sequence: entry.sequence,
      occurredAt: entry.occurred_at,
      kind: "result",
      text: record.is_error ? "Agent run ended with an error" : "Agent finished its implementation",
    };
  }
  return null;
}

export function readableRunActivities(entries: RunLogEntryDto[]): RunActivity[] {
  const activities: RunActivity[] = [];
  for (const entry of entries) {
    const activity = activityFromEntry(entry);
    if (!activity) continue;
    const previous = activities.at(-1);
    if (previous?.kind === "reasoning" && activity.kind === "reasoning") {
      activities[activities.length - 1] = activity;
      continue;
    }
    if (previous?.kind === activity.kind && previous.text === activity.text) continue;
    activities.push(activity);
  }
  if (activities.length === 0 && entries.length > 0) {
    const latest = entries.at(-1);
    if (latest) {
      activities.push({
        sequence: latest.sequence,
        occurredAt: latest.occurred_at,
        kind: "session",
        text: "Agent session is active",
      });
    }
  }
  return activities.slice(-MAX_VISIBLE_ACTIVITIES);
}

function trimToBudget(entries: RunLogEntryDto[]): {
  entries: RunLogEntryDto[];
  dropped: boolean;
} {
  let sliced = entries;
  let dropped = false;
  if (sliced.length > MAX_CLIENT_ENTRIES) {
    sliced = sliced.slice(sliced.length - MAX_CLIENT_ENTRIES);
    dropped = true;
  }
  let chars = sliced.reduce((sum, entry) => sum + entry.chunk.length, 0);
  let start = 0;
  while (chars > MAX_CLIENT_CHARS && start < sliced.length - 1) {
    chars -= sliced[start]?.chunk.length ?? 0;
    start += 1;
    dropped = true;
  }
  return { entries: start > 0 ? sliced.slice(start) : sliced, dropped };
}

export function RunLog({
  projectId,
  phaseId,
  taskId,
  active,
  onUnauthorized,
}: {
  projectId: string;
  phaseId: string;
  taskId: string;
  /** Whether the run is CURRENTLY in a state that can still produce output.
   *  Polling runs fast and fixed while true; the moment it flips false this
   *  component does one final fetch and then stops. */
  active: boolean;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [entries, setEntries] = useState<RunLogEntryDto[]>([]);
  const [droppedLocally, setDroppedLocally] = useState(false);
  const [serverTruncated, setServerTruncated] = useState(false);
  const [totalEntries, setTotalEntries] = useState<number | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const cursorRef = useRef<number | undefined>(undefined);
  const currentRunIdRef = useRef<string | null>(null);
  const logResourceKey = `${projectId}:${phaseId}:${taskId}`;

  useEffect(() => {
    if (!logResourceKey) return;
    cursorRef.current = undefined;
    currentRunIdRef.current = null;
    setEntries([]);
    setDroppedLocally(false);
    setServerTruncated(false);
    setTotalEntries(null);
    setRunId(null);
  }, [logResourceKey]);

  const polling = useSingleFlightPolling({
    intervalMs: active ? POLL_MS : null,
    maxBackoffMs: 30_000,
    resourceKey: logResourceKey,
    load: async (signal) => {
      const requestedCursor = cursorRef.current;
      const fetchTail = async (after: number | undefined): Promise<RunLogTailDto> => {
        const query = after !== undefined ? `?after=${after}` : "";
        const res = await fetch(
          `/api/v2/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}/tasks/${encodeURIComponent(taskId)}/run-log${query}`,
          { headers: authHeaders(false), signal },
        );
        if (res.status === 401) {
          onUnauthorized();
          throw new Error("Session expired");
        }
        if (!res.ok) {
          throw new Error(`request failed: ${res.status}`);
        }
        return (await res.json()) as RunLogTailDto;
      };

      let body = await fetchTail(requestedCursor);
      if (
        requestedCursor !== undefined &&
        currentRunIdRef.current !== null &&
        body.run_id !== currentRunIdRef.current
      ) {
        body = await fetchTail(undefined);
        return { body, appending: false };
      }
      return { body, appending: requestedCursor !== undefined };
    },
    onSuccess: ({ body, appending }) => {
      const runChanged = body.run_id !== currentRunIdRef.current;
      currentRunIdRef.current = body.run_id;
      setRunId(body.run_id);
      setTotalEntries(body.total_entries);
      setServerTruncated((current) => (runChanged ? body.truncated : current || body.truncated));
      if (runChanged) setDroppedLocally(false);
      const last = body.entries.at(-1);
      if (last) cursorRef.current = last.sequence;
      else if (runChanged || cursorRef.current === undefined) {
        cursorRef.current = body.run_id ? 0 : undefined;
      }
      setEntries((prev) => {
        const merged = appending && !runChanged ? [...prev, ...body.entries] : body.entries;
        const { entries: bounded, dropped } = trimToBudget(merged);
        if (dropped) setDroppedLocally(true);
        return bounded;
      });
    },
  });

  const activities = useMemo(() => readableRunActivities(entries), [entries]);

  return (
    <details className="run-log" data-testid={`task-run-log-${taskId}`} open={active}>
      <summary>
        Development activity
        {totalEntries !== null
          ? ` · ${activities.length} useful update${activities.length === 1 ? "" : "s"}`
          : runId
            ? ""
            : " · not available"}
      </summary>
      <div className="run-log-body">
        {runId === null ? (
          <span className="muted">Connecting this task to its live activity…</span>
        ) : entries.length === 0 ? (
          <span className="muted">
            The agent is connected. Waiting for its first visible update.
          </span>
        ) : activities.length === 0 ? (
          <span className="muted">
            Waiting for a file change, verification result, commit, or blocker.
          </span>
        ) : (
          <ol className="run-activity-list" data-testid={`task-run-log-output-${taskId}`}>
            {activities.map((activity) => (
              <li key={activity.sequence} data-kind={activity.kind}>
                <span aria-hidden="true" />
                <p>{activity.text}</p>
                <time dateTime={activity.occurredAt}>
                  {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
                    new Date(activity.occurredAt),
                  )}
                </time>
              </li>
            ))}
          </ol>
        )}
        {serverTruncated || droppedLocally ? (
          <p className="muted" data-testid={`task-run-log-truncated-${taskId}`}>
            Older output is not shown
            {totalEntries !== null ? ` — showing the most recent of ${totalEntries} lines` : ""}.
          </p>
        ) : null}
        {polling.error ? (
          <span className="muted">
            Refresh failed · showing last known output ({polling.error.message})
          </span>
        ) : null}
        <div className="run-log-meta">
          <span>{active ? "Live" : "Final"}</span>
          <span>
            {polling.lastSuccessAt
              ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(polling.lastSuccessAt)}`
              : "Not yet loaded"}
          </span>
        </div>
      </div>
    </details>
  );
}
