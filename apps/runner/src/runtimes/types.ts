// Coding runtime adapters (PRD R4 §Provider Architecture). Every adapter
// publishes a capability matrix — UI controls map to declared capabilities,
// never to assumptions (§Runner Protocol).
export interface RuntimeCapabilities {
  interrupt: boolean;
  suspend: boolean;
  resume_session: boolean;
  cancel: boolean;
  stop_after_current: boolean;
  /**
   * EXECUTION E11 — can a human's answer reach this runtime WHILE a turn is
   * running? This is a narrower question than "is the runtime conversational",
   * and the two are routinely confused. Codex can hold a multi-turn thread but
   * cannot accept input during a turn, so it declares `false`; declaring `true`
   * there would make the UI offer a control that silently does nothing.
   */
  send_message: boolean;
}

export interface RuntimeUsage {
  input_tokens: number;
  output_tokens: number;
  usage_source:
    | "provider_api"
    | "runtime_report"
    | "subscription_credit"
    | "estimate"
    | "unavailable";
}

export interface RuntimeRunRequest {
  runId: string;
  /** the isolated worktree the runtime may write to (Sandbox Contract) */
  worktreePath: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (chunk: string) => void;
  /**
   * EXECUTION E11 — published by the runtime once (and only once) it holds a
   * session that can genuinely accept mid-flight control. A runtime whose SDK
   * offers no such channel never calls this, and the control layer answers a
   * human with a refusal that names the runtime instead of pretending.
   */
  onSession?: (session: RuntimeSession) => void;
}

/**
 * EXECUTION E11 — mid-flight control over a runtime's live session.
 *
 * Both members are optional and are present ONLY when the underlying SDK
 * supports them. Cancellation is deliberately absent: it is served by
 * `RuntimeRunRequest.signal`, which every adapter already honours, so there is
 * exactly one cancellation mechanism rather than two that can disagree.
 */
export interface RuntimeSession {
  sendMessage?(message: string): Promise<void>;
  interrupt?(): Promise<void>;
}

export interface RuntimeRunResult {
  outcome: "completed" | "failed" | "cancelled";
  detail: string;
  usage: RuntimeUsage;
  /** session/thread id when the runtime supports resumption */
  sessionId?: string;
}

export interface CodingRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
}
