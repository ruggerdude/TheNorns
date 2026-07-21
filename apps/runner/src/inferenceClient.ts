// EXECUTION E3 — the runner half of proxied model inference.
//
// The runner holds no provider credentials and must not: an Actions job's
// environment is visible to every workflow in the repository and to its logs.
// Instead it asks the relay, which already knows who this runner is, which run
// it was dispatched for, and what that run is allowed to spend.
//
// This is a request/response side channel over the SAME authenticated socket as
// commands and events. It carries no credential of its own — the socket's
// Ed25519 handshake is the authentication, and the generation stamped on each
// frame is the fencing token, exactly as for every other frame.
import {
  type InferenceErrorCodeT,
  RETRYABLE_INFERENCE_ERRORS,
  type RunnerInferenceRequestT,
  type RunnerInferenceResponseT,
} from "@norns/contracts";

/** A typed refusal or failure from the proxy, preserving the server's code. */
export class InferenceProxyError extends Error {
  readonly code: InferenceErrorCodeT | "runner_unavailable" | "timeout";
  readonly retryable: boolean;

  constructor(code: InferenceErrorCodeT | "runner_unavailable" | "timeout", message: string) {
    super(message);
    this.name = "InferenceProxyError";
    this.code = code;
    this.retryable =
      code === "timeout" || RETRYABLE_INFERENCE_ERRORS.has(code as InferenceErrorCodeT);
  }
}

export interface InferenceCompletion {
  text: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason?: string | undefined;
}

/** What the client needs from the transport. Injected so this is testable. */
export interface InferenceTransport {
  /** Returns false when the socket is not usable; the call then fails fast. */
  send(request: RunnerInferenceRequestT): boolean;
}

interface Pending {
  resolve: (completion: InferenceCompletion) => void;
  reject: (error: InferenceProxyError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Correlates in-flight proxied calls by request_id.
 *
 * The correlation map lives HERE rather than on the server, because the flow is
 * runner-initiated: the server can answer each request inline and hold no
 * per-request state at all. That is one fewer place for a leak or an unbounded
 * map, and it means a server restart cannot strand a pending completion — the
 * socket drops, `abortAll` fires, and the runtime sees a clean failure.
 */
export class RelayInferenceClient {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(
    private readonly transport: InferenceTransport,
    /**
     * Bounded in-flight calls. A runtime that spins would otherwise queue
     * unboundedly against a budget check that has not happened yet.
     */
    private readonly maxInFlight = 4,
    private readonly timeoutMs = 180_000,
  ) {}

  get inFlight(): number {
    return this.pending.size;
  }

  nextRequestId(): string {
    this.counter += 1;
    return `inf:${Date.now().toString(36)}:${this.counter}`;
  }

  async complete(
    request: Omit<RunnerInferenceRequestT, "request_id">,
  ): Promise<InferenceCompletion> {
    if (this.pending.size >= this.maxInFlight) {
      throw new InferenceProxyError("rate_limited", "too many in-flight inference requests");
    }
    const requestId = this.nextRequestId();
    const full: RunnerInferenceRequestT = { ...request, request_id: requestId };
    return new Promise<InferenceCompletion>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new InferenceProxyError("timeout", "inference request timed out"));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.transport.send(full)) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new InferenceProxyError("runner_unavailable", "relay socket is not connected"));
      }
    });
  }

  /** Route a server response to its caller. Unknown ids are dropped. */
  receive(response: RunnerInferenceResponseT): boolean {
    const pending = this.pending.get(response.request_id);
    if (!pending) return false;
    this.pending.delete(response.request_id);
    clearTimeout(pending.timer);
    if (response.status === "error") {
      pending.reject(new InferenceProxyError(response.code, response.message));
      return true;
    }
    pending.resolve({
      text: response.text,
      provider: response.provider,
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      finish_reason: response.finish_reason,
    });
    return true;
  }

  /** Fail every in-flight call — the socket dropped or the runner was fenced. */
  abortAll(reason = "relay disconnected"): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new InferenceProxyError("runner_unavailable", reason));
    }
    this.pending.clear();
  }
}
