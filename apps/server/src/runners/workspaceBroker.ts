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

/**
 * Transient request/response correlation for runner-owned folder discovery.
 * The state intentionally stays in memory: a reconnect invalidates a browse
 * handle and the UI safely begins again, rather than persisting a local path
 * representation in cloud storage.
 */
export class RunnerWorkspaceBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: (
      runnerId: string,
      generation: number,
      request: RunnerWorkspaceRequestT,
    ) => boolean,
    private readonly options: { timeoutMs?: number; maxPerRunner?: number } = {},
  ) {}

  request(
    runnerId: string,
    generation: number,
    input: Omit<RunnerWorkspaceRequestT, "request_id">,
  ): Promise<RunnerWorkspaceResponseT> {
    const max = this.options.maxPerRunner ?? 4;
    if ([...this.pending.values()].filter((entry) => entry.runnerId === runnerId).length >= max) {
      return Promise.reject(new WorkspaceBrokerError("request_limit"));
    }
    const request: RunnerWorkspaceRequestT = {
      request_id: `workspace:${randomUUID().replaceAll("-", "")}`,
      ...input,
    };
    return new Promise<RunnerWorkspaceResponseT>((resolve, reject) => {
      const timeoutMs =
        request.operation === "choose"
          ? (this.options.timeoutMs ?? 5 * 60_000)
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
    if (!pending || pending.runnerId !== runnerId || pending.generation !== generation)
      return false;
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

/** User-bound single-use grants; no browser-provided repository metadata is trusted. */
export class WorkspaceSelectionTokens {
  private readonly tokens = new Map<string, StoredSelection>();

  issue(
    userId: string,
    runnerId: string,
    runnerGeneration: number,
    repository: NonNullable<RunnerWorkspaceResponseT["repository"]>,
  ): { selection_token: string; expires_at: string } {
    this.prune();
    const selection_token = `selection:${randomUUID().replaceAll("-", "")}`;
    const expires_at = new Date(Date.now() + 5 * 60_000).toISOString();
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
    const now = Date.now();
    for (const [token, selection] of this.tokens) {
      if (Date.parse(selection.expires_at) <= now) this.tokens.delete(token);
    }
  }
}
