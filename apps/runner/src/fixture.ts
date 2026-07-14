// Phase 1A fixture task: a scripted long-running job ("count:<ticks>:<ms>")
// that emits logs and honors the full control set, so remote control is
// validated before any LLM runtime exists.
export interface RunMeta {
  correlation?: string;
  causation?: string;
}

export type FixtureEmit = (
  payload:
    | { kind: "run_log"; run_id: string; chunk: string }
    | {
        kind: "run_status";
        run_id: string;
        status: "started" | "paused" | "resumed" | "completed" | "failed" | "cancelled";
      },
  meta: RunMeta,
) => void;

interface ActiveRun {
  timer: ReturnType<typeof setInterval> | null;
  tick: number;
  ticks: number;
  intervalMs: number;
  paused: boolean;
  stopAfterCurrent: boolean;
  meta: RunMeta; // the launching command's correlation chain
}

export class FixtureExecutor {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly emit: FixtureEmit) {}

  launch(runId: string, fixture: string, meta: RunMeta = {}): void {
    if (this.runs.has(runId)) return; // dedup safety net; daemon also guards
    const [, ticksRaw, intervalRaw] = fixture.split(":");
    const run: ActiveRun = {
      timer: null,
      tick: 0,
      ticks: Number(ticksRaw ?? 10),
      intervalMs: Number(intervalRaw ?? 100),
      paused: false,
      stopAfterCurrent: false,
      meta,
    };
    this.runs.set(runId, run);
    this.emit({ kind: "run_status", run_id: runId, status: "started" }, meta);
    run.timer = setInterval(() => {
      if (run.paused) return;
      run.tick += 1;
      this.emit({ kind: "run_log", run_id: runId, chunk: `tick ${run.tick}/${run.ticks}` }, meta);
      if (run.tick >= run.ticks || run.stopAfterCurrent) {
        this.finish(runId, "completed");
      }
    }, run.intervalMs);
  }

  interrupt(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.paused) return;
    run.paused = true;
    this.emit({ kind: "run_status", run_id: runId, status: "paused" }, run.meta);
  }

  resume(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || !run.paused) return;
    run.paused = false;
    this.emit({ kind: "run_status", run_id: runId, status: "resumed" }, run.meta);
  }

  stopAfterCurrent(runId: string): void {
    const run = this.runs.get(runId);
    if (run) run.stopAfterCurrent = true;
  }

  cancel(runId: string): void {
    if (this.runs.has(runId)) this.finish(runId, "cancelled");
  }

  cancelAll(): void {
    for (const runId of [...this.runs.keys()]) this.cancel(runId);
  }

  isActive(runId: string): boolean {
    return this.runs.has(runId);
  }

  private finish(runId: string, status: "completed" | "cancelled"): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.timer) clearInterval(run.timer);
    this.runs.delete(runId);
    this.emit({ kind: "run_status", run_id: runId, status }, run.meta);
  }
}
