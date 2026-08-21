import { randomUUID } from "node:crypto";
import type { RunnerWorkspaceRequestT, RunnerWorkspaceResponseT } from "@norns/contracts";

export class WorkspaceBrokerError extends Error {
  constructor(
    readonly code:
      | "runner_unavailable"
      | "runner_upgrade_required"
      | "request_limit"
      | "timeout"
      | "invalid_response",
  ) {
    super(code);
    this.name = "WorkspaceBrokerError";
  }
}

interface Pending {
  runnerId: string;
  generation: number;
  operation: RunnerWorkspaceRequestT["operation"];
  resolve: (response: RunnerWorkspaceResponseT) => void;
  reject: (error: WorkspaceBrokerError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A finished request, held briefly so an out-of-band poller can collect it. */
type SettledOutcome =
  | { kind: "ok"; response: RunnerWorkspaceResponseT }
  | { kind: "error"; code: WorkspaceBrokerError["code"] };

export type WorkspacePoll =
  | { state: "pending" }
  | { state: "ok"; response: RunnerWorkspaceResponseT }
  | { state: "error"; code: WorkspaceBrokerError["code"] }
  | { state: "unknown" };

/**
 * Correlates the browser's folder request with the authenticated local helper.
 * Handles are intentionally transient: reconnecting safely forces a fresh pick.
 *
 * A folder pick can take minutes (the human is choosing a directory), which is
 * far longer than an edge proxy will hold one HTTP request open — a synchronous
 * `await` on the result gets killed by the proxy (502 "upstream error") or a
 * mid-flight redeploy, which is exactly the recurring folder-picker failure.
 * So the pick is decoupled from any single request: `initiate` fires it and
 * returns immediately with a request id, and `poll` collects the outcome from a
 * short series of fast requests. `request` (the awaited form) is kept for the
 * short in-process callers that never leave the server.
 */
export class RunnerWorkspaceBroker {
  private readonly pending = new Map<string, Pending>();
  /** Settled outcomes awaiting collection by a poll, with the time they landed. */
  private readonly outcomes = new Map<string, { at: number; outcome: SettledOutcome }>();
  private readonly outcomeTtlMs: number;

  constructor(
    private readonly send: (
      runnerId: string,
      generation: number,
      request: RunnerWorkspaceRequestT,
    ) => boolean,
    private readonly options: {
      timeoutMs?: number;
      maxPerRunner?: number;
      outcomeTtlMs?: number;
    } = {},
  ) {
    this.outcomeTtlMs = options.outcomeTtlMs ?? 5 * 60_000;
  }

  /**
   * Fire a request without holding the caller's connection open. Returns the
   * request id immediately; the result is collected later with `poll`.
   */
  initiate(
    runnerId: string,
    generation: number,
    input: Omit<RunnerWorkspaceRequestT, "request_id">,
  ): { request_id: string } {
    const request: RunnerWorkspaceRequestT = {
      request_id: `workspace:${randomUUID().replaceAll("-", "")}`,
      ...input,
    };
    this.startPending(runnerId, generation, request).then(
      (response) => this.settle(request.request_id, { kind: "ok", response }),
      (error) =>
        this.settle(request.request_id, {
          kind: "error",
          code: error instanceof WorkspaceBrokerError ? error.code : "invalid_response",
        }),
    );
    return { request_id: request.request_id };
  }

  /**
   * Collect an initiated request's outcome. `pending` while the human is still
   * choosing; a settled outcome; `unknown` for an id this broker never held
   * (expected across a multi-replica deployment — the pick's state lives only
   * on the instance that sent the frame, so a poll routed elsewhere is
   * `unknown` and the caller simply retries until it reaches the right one).
   *
   * Reads are idempotent: the outcome is kept until its TTL, not consumed on
   * read, so a retried or duplicated poll keeps returning the same answer
   * rather than flipping to `unknown` after the first read.
   */
  poll(request_id: string): WorkspacePoll {
    this.pruneOutcomes();
    const settled = this.outcomes.get(request_id);
    if (settled) {
      return settled.outcome.kind === "ok"
        ? { state: "ok", response: settled.outcome.response }
        : { state: "error", code: settled.outcome.code };
    }
    return this.pending.has(request_id) ? { state: "pending" } : { state: "unknown" };
  }

  private settle(request_id: string, outcome: SettledOutcome): void {
    this.outcomes.set(request_id, { at: Date.now(), outcome });
  }

  private pruneOutcomes(): void {
    const cutoff = Date.now() - this.outcomeTtlMs;
    for (const [id, entry] of this.outcomes) {
      if (entry.at <= cutoff) this.outcomes.delete(id);
    }
  }

  request(
    runnerId: string,
    generation: number,
    input: Omit<RunnerWorkspaceRequestT, "request_id">,
  ): Promise<RunnerWorkspaceResponseT> {
    const request: RunnerWorkspaceRequestT = {
      request_id: `workspace:${randomUUID().replaceAll("-", "")}`,
      ...input,
    };
    return this.startPending(runnerId, generation, request);
  }

  private startPending(
    runnerId: string,
    generation: number,
    request: RunnerWorkspaceRequestT,
  ): Promise<RunnerWorkspaceResponseT> {
    const max = this.options.maxPerRunner ?? 4;
    if ([...this.pending.values()].filter((entry) => entry.runnerId === runnerId).length >= max) {
      return Promise.reject(new WorkspaceBrokerError("request_limit"));
    }
    return new Promise<RunnerWorkspaceResponseT>((resolve, reject) => {
      const timeoutMs =
        request.operation === "graphify_index"
          ? (this.options.timeoutMs ?? 10 * 60_000)
          : request.operation === "choose" ||
              request.operation === "choose_clone_parent" ||
              request.operation === "clone"
            ? (this.options.timeoutMs ?? 5 * 60_000)
            : request.operation === "inspect" ||
                request.operation === "graphify_status" ||
                request.operation === "graphify_query"
              ? (this.options.timeoutMs ?? 20_000)
              : (this.options.timeoutMs ?? 8_000);
      const timer = setTimeout(() => {
        this.pending.delete(request.request_id);
        reject(new WorkspaceBrokerError("timeout"));
      }, timeoutMs);
      this.pending.set(request.request_id, {
        runnerId,
        generation,
        operation: request.operation,
        resolve,
        reject,
        timer,
      });
      if (!this.send(runnerId, generation, request)) {
        clearTimeout(timer);
        this.pending.delete(request.request_id);
        reject(new WorkspaceBrokerError("runner_unavailable"));
      }
    });
  }

  receive(runnerId: string, generation: number, response: RunnerWorkspaceResponseT): boolean {
    const pending = this.pending.get(response.request_id);
    if (!pending || pending.runnerId !== runnerId || pending.generation !== generation) {
      return false;
    }
    this.pending.delete(response.request_id);
    clearTimeout(pending.timer);
    if (pending.operation !== response.operation) {
      pending.reject(new WorkspaceBrokerError("invalid_response"));
      return false;
    }
    pending.resolve(response);
    return true;
  }

  disconnect(runnerId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.runnerId !== runnerId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new WorkspaceBrokerError("runner_unavailable"));
    }
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WorkspaceBrokerError("runner_unavailable"));
    }
    this.pending.clear();
  }
}

export interface WorkspaceSelection {
  userId: string;
  runner_id: string;
  runner_generation: number;
  workspace_id: string;
  repository_id: string;
  repository_display_name: string;
  default_branch: string;
  observed_head: string;
  expires_at: string;
}

interface StoredSelection extends WorkspaceSelection {
  reservation_id: string | null;
}

/** User-bound, short-lived, single-use grants. Browser repository claims are never trusted. */
export class WorkspaceSelectionTokens {
  private readonly tokens = new Map<string, StoredSelection>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(
    userId: string,
    runnerId: string,
    runnerGeneration: number,
    repository: NonNullable<RunnerWorkspaceResponseT["repository"]>,
  ): { selection_token: string; expires_at: string } {
    this.prune();
    const selection_token = `selection:${randomUUID().replaceAll("-", "")}`;
    const expires_at = new Date(this.now() + 5 * 60_000).toISOString();
    this.tokens.set(selection_token, {
      userId,
      runner_id: runnerId,
      runner_generation: runnerGeneration,
      ...repository,
      expires_at,
      reservation_id: null,
    });
    return { selection_token, expires_at };
  }

  reserve(
    userId: string,
    token: string,
  ): { reservation_id: string; selection: WorkspaceSelection } | undefined {
    this.prune();
    const selection = this.tokens.get(token);
    if (!selection || selection.userId !== userId || selection.reservation_id) return undefined;
    const reservation_id = randomUUID();
    selection.reservation_id = reservation_id;
    return { reservation_id, selection };
  }

  commit(token: string, reservationId: string): void {
    const selection = this.tokens.get(token);
    if (selection?.reservation_id === reservationId) this.tokens.delete(token);
  }

  release(token: string, reservationId: string): void {
    const selection = this.tokens.get(token);
    if (selection?.reservation_id === reservationId) selection.reservation_id = null;
  }

  private prune(): void {
    const time = this.now();
    for (const [token, selection] of this.tokens) {
      if (Date.parse(selection.expires_at) <= time) this.tokens.delete(token);
    }
  }
}
