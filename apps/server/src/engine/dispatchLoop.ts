// Dispatch loop (ADR-001, closes GATE-1 deviation #3): bridges the engine to
// the relay's command outbox through the durable dispatch_jobs store. The
// loop POLLS claim() — that is the recovery guarantee; any notify mechanism
// is only ever a wake-up hint. Kill switch is checked on every tick, so it
// works even when the runner is wedged.
import type { DispatchJob, DispatchStore } from "./dispatch.js";

export interface Deliverer {
  /** Issue the job's command toward the runner; returns the command id. */
  deliver(job: DispatchJob): Promise<string>;
}

export interface DispatchLoopOptions {
  store: DispatchStore;
  deliverer: Deliverer;
  killSwitchEngaged: () => boolean;
  owner?: string;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => number;
}

export class DispatchLoop {
  private readonly opts: Required<DispatchLoopOptions>;

  constructor(options: DispatchLoopOptions) {
    this.opts = {
      owner: "dispatcher-1",
      leaseMs: 30_000,
      retryDelayMs: 1_000,
      now: () => Date.now(),
      ...options,
    };
  }

  /**
   * One poll tick: claim eligible jobs and deliver them. Returns the number
   * of jobs delivered. Callers run this on an interval; a NOTIFY-style hint
   * may call it early, but polling alone must be sufficient.
   */
  async tick(): Promise<number> {
    if (this.opts.killSwitchEngaged()) return 0; // dispatch refuses, always
    let delivered = 0;
    for (;;) {
      const job = this.opts.store.claim(this.opts.owner, this.opts.now(), this.opts.leaseMs);
      if (!job) break;
      try {
        const commandId = await this.opts.deliverer.deliver(job);
        this.opts.store.complete(job.id, commandId);
        delivered += 1;
      } catch {
        this.opts.store.fail(job.id, this.opts.now(), this.opts.retryDelayMs);
      }
    }
    return delivered;
  }
}
