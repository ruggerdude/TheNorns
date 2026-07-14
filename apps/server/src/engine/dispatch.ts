// Durable dispatch jobs with lease semantics (ADR-001): the in-memory model
// of the Postgres `dispatch_jobs` table. claim() is the FOR UPDATE SKIP LOCKED
// equivalent — atomic per call, so two dispatchers never hold the same job;
// expired leases are reclaimed. LISTEN/NOTIFY is only ever a wake-up hint;
// polling this store is the guarantee.
export interface DispatchJob {
  id: string;
  node_id: string;
  command_id: string | null;
  runner_id: string;
  status: "queued" | "leased" | "done" | "failed";
  attempts: number;
  available_at: number; // epoch ms
  lease_owner: string | null;
  lease_expires_at: number | null;
  payload: Record<string, unknown>;
}

export class DispatchStore {
  private readonly jobs = new Map<string, DispatchJob>();
  private counter = 0;

  enqueue(input: {
    node_id: string;
    runner_id: string;
    payload: Record<string, unknown>;
    available_at?: number;
  }): DispatchJob {
    this.counter += 1;
    const job: DispatchJob = {
      id: `job_${this.counter}`,
      node_id: input.node_id,
      command_id: null,
      runner_id: input.runner_id,
      status: "queued",
      attempts: 0,
      available_at: input.available_at ?? 0,
      lease_owner: null,
      lease_expires_at: null,
      payload: input.payload,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /**
   * Atomically claim the oldest eligible job: queued (or lease-expired),
   * available, unleased. Returns null when nothing is claimable — the
   * SKIP LOCKED behavior.
   */
  claim(owner: string, nowMs: number, leaseMs: number): DispatchJob | null {
    for (const job of this.jobs.values()) {
      const leaseExpired =
        job.status === "leased" && job.lease_expires_at !== null && job.lease_expires_at <= nowMs;
      const eligible = (job.status === "queued" || leaseExpired) && job.available_at <= nowMs;
      if (!eligible) continue;
      job.status = "leased";
      job.attempts += 1;
      job.lease_owner = owner;
      job.lease_expires_at = nowMs + leaseMs;
      return job;
    }
    return null;
  }

  complete(jobId: string, commandId?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "done";
    job.command_id = commandId ?? job.command_id;
    job.lease_owner = null;
    job.lease_expires_at = null;
  }

  fail(jobId: string, nowMs: number, retryDelayMs = 0): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "queued";
    job.lease_owner = null;
    job.lease_expires_at = null;
    job.available_at = nowMs + retryDelayMs;
  }

  get(jobId: string): DispatchJob | undefined {
    return this.jobs.get(jobId);
  }
}
