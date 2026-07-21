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
import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "./auth";

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
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<number | undefined>(undefined);

  const poll = useCallback(async () => {
    try {
      const query = cursorRef.current !== undefined ? `?after=${cursorRef.current}` : "";
      const res = await fetch(
        `/api/v2/projects/${projectId}/phases/${phaseId}/tasks/${taskId}/run-log${query}`,
        { headers: authHeaders(false) },
      );
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      if (!res.ok) {
        setError(`request failed: ${res.status}`);
        return;
      }
      const body = (await res.json()) as RunLogTailDto;
      setError(null);
      setRunId(body.run_id);
      setTotalEntries(body.total_entries);
      if (body.truncated) setServerTruncated(true);
      const appending = cursorRef.current !== undefined;
      const last = body.entries.at(-1);
      if (last) cursorRef.current = last.sequence;
      else if (cursorRef.current === undefined && body.run_id) cursorRef.current = 0;
      setEntries((prev) => {
        const merged = appending ? [...prev, ...body.entries] : body.entries;
        const { entries: bounded, dropped } = trimToBudget(merged);
        if (dropped) setDroppedLocally(true);
        return bounded;
      });
      setLastFetchedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, phaseId, taskId, onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    void poll();
    if (!active) return () => {};
    const timer = window.setInterval(() => {
      if (!cancelled) void poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, poll]);

  return (
    <details className="run-log" data-testid={`task-run-log-${taskId}`} open={active}>
      <summary>
        Run log
        {totalEntries !== null
          ? ` · ${totalEntries} line${totalEntries === 1 ? "" : "s"}`
          : runId
            ? ""
            : " · not available"}
      </summary>
      <div className="run-log-body">
        {runId === null ? (
          <span className="muted">No run to tail yet.</span>
        ) : entries.length === 0 ? (
          <span className="muted">No output recorded yet.</span>
        ) : (
          <pre className="run-log-output" data-testid={`task-run-log-output-${taskId}`}>
            {entries.map((entry) => entry.chunk).join("")}
          </pre>
        )}
        {serverTruncated || droppedLocally ? (
          <p className="muted" data-testid={`task-run-log-truncated-${taskId}`}>
            Older output is not shown
            {totalEntries !== null ? ` — showing the most recent of ${totalEntries} lines` : ""}.
          </p>
        ) : null}
        {error ? <span className="muted">{error}</span> : null}
        <div className="run-log-meta">
          <span>{active ? "Live" : "Final"}</span>
          <span>
            {lastFetchedAt
              ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(lastFetchedAt)}`
              : "Not yet loaded"}
          </span>
        </div>
      </div>
    </details>
  );
}
