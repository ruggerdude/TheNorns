// FRONT DOOR P1b (tracking): the phase Gantt from the approved mockup, pure
// CSS/percentage-positioned divs — no charting library, no fabricated dates.
//
// The resume DTO does not currently carry per-phase start/created
// timestamps (only `eta_at`, a projection). Real timestamps would let this
// component place bars on a true calendar axis; lacking them, it degrades
// to *proportional ordinal placement* — each phase gets an equal-width slot
// in priority order, and the "Today" marker sits at the point that reflects
// overall progress across those slots. This is honest given the data
// available: no invented dates, just relative sequence + real percentages.
// If the resume DTO ever adds real timestamps, `phase.startedAt`/`etaAt`
// here already accept them and a future pass can switch the axis to dates
// without changing this component's public shape.
export interface GanttPhase {
  id: string;
  name: string;
  /** Raw phase status from the resume/strategy DTOs (e.g. "proposed",
   *  "awaiting_approval", "active", "completed", "blocked", "cancelled"). */
  status: string;
  percentComplete: number;
  etaAt: string | null;
  /** Distinct agents (implementation + reviewer) currently staffed on this
   *  phase, when known. Omitted (not zero) when we have no signal — the
   *  chip shows "—" rather than a fabricated 0. */
  agentCount?: number;
  /** A phase-scoped blocking decision, if one exists — drives the red gate
   *  diamond + label (independent of `status`, since a phase can be
   *  "active" with tasks blocked on a human decision). */
  blockedLabel?: string | null;
}

function isDone(status: string): boolean {
  return status === "completed" || status === "cancelled";
}

function isUpcomingGate(status: string): boolean {
  return status === "proposed" || status === "awaiting_approval";
}

/** Fill fraction (0–1) for a phase's bar. Cancelled phases render as fully
 *  hatched (nothing to claim as "done" there); everything else is its own
 *  percent_complete. */
function fillFraction(phase: GanttPhase): number {
  if (phase.status === "cancelled") return 0;
  return Math.max(0, Math.min(100, phase.percentComplete)) / 100;
}

function barClass(phase: GanttPhase): string {
  if (phase.blockedLabel) return "gantt-bar blocked";
  if (phase.status === "proposed" || phase.status === "awaiting_approval") return "gantt-bar q";
  return "gantt-bar g";
}

function gateState(phase: GanttPhase): "passed" | "blocked" | "upcoming" {
  if (phase.blockedLabel) return "blocked";
  if (isDone(phase.status) || phase.status === "active") return "passed";
  return "upcoming";
}

function gateLabel(phase: GanttPhase): string {
  if (phase.blockedLabel) return phase.blockedLabel;
  if (isUpcomingGate(phase.status)) return "Plan approval";
  if (isDone(phase.status)) return "Complete";
  return "In progress";
}

/** Ordinal "today" position (0–1) across the phase slots: fully past every
 *  completed phase, partway through the first non-done one, at the start of
 *  everything after that. Never past 1 or before 0. */
function todayPosition(phases: readonly GanttPhase[]): number {
  if (phases.length === 0) return 0;
  const slot = 1 / phases.length;
  let position = 0;
  for (const phase of phases) {
    if (isDone(phase.status)) {
      position += slot;
      continue;
    }
    position += slot * fillFraction(phase);
    break;
  }
  return Math.max(0, Math.min(1, position));
}

export function Gantt({
  phases,
  mini = false,
}: {
  phases: GanttPhase[];
  mini?: boolean;
}): React.ReactElement {
  if (phases.length === 0) {
    return (
      <div className="gantt-empty muted" data-testid="gantt-empty">
        No phases yet — the Gantt fills in once the first phase is planned.
      </div>
    );
  }
  const slot = 100 / phases.length;
  const today = todayPosition(phases) * 100;

  return (
    <div className={`gantt${mini ? " gantt-mini" : ""}`} data-testid="gantt" data-mini={mini}>
      <div className="gantt-axis-row">
        <div className="gantt-corner">{mini ? "" : "Phase"}</div>
        <div className="gantt-axis">
          {phases.map((phase, index) => {
            const left = slot * index;
            const state = gateState(phase);
            return (
              <div
                className={`gantt-gate ${state}`}
                style={{ left: `${left}%` }}
                key={`gate-${phase.id}`}
                data-testid="gantt-gate"
                data-state={state}
              >
                <span className="dia" />
                {!mini ? <span className="glbl">{gateLabel(phase)}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="gantt-rows">
        <div
          className="gantt-today"
          style={{ ["--today" as string]: (today / 100).toFixed(3) }}
          data-testid="gantt-today"
        />
        {phases.map((phase, index) => {
          const left = slot * index;
          const fraction = fillFraction(phase);
          return (
            <div className="gantt-row" key={phase.id} data-testid="gantt-row">
              <div className="gantt-lbl">
                <span className={`pnum${isUpcomingGate(phase.status) ? " q" : ""}`}>
                  {index + 1}
                </span>
                {!mini ? <span className="pname">{phase.name}</span> : null}
                {!mini ? (
                  <span className="acount">
                    {isDone(phase.status) ? "✓" : (phase.agentCount ?? "—")}
                  </span>
                ) : null}
              </div>
              <div className="gantt-plot">
                <div
                  className={barClass(phase)}
                  style={{ left: `${left}%`, width: `${slot}%` }}
                  data-testid="gantt-bar"
                  data-status={phase.status}
                  data-blocked={Boolean(phase.blockedLabel)}
                >
                  {!phase.blockedLabel ? (
                    <span className="fill" style={{ width: `${fraction * 100}%` }} />
                  ) : null}
                </div>
                {!mini ? (
                  <span
                    className="gbar-pct"
                    style={{
                      left: `${left + slot * 0.5}%`,
                      color: phase.blockedLabel ? "var(--danger)" : undefined,
                    }}
                  >
                    {phase.blockedLabel
                      ? "Blocked"
                      : isDone(phase.status)
                        ? "✓ Done"
                        : `${phase.percentComplete}%`}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {!mini ? (
        <div className="gantt-legend">
          <span>
            <span className="sw solid" /> Complete
          </span>
          <span>
            <span className="sw hatch" /> Remaining
          </span>
          <span>
            <span className="dia passed" /> Gate passed
          </span>
          <span>
            <span className="dia blocked" /> Gate blocked
          </span>
          <span>
            <span className="dia upcoming" /> Gate upcoming
          </span>
        </div>
      ) : null}
    </div>
  );
}
