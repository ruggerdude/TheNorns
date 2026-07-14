// Coding runtime adapters (PRD R4 §Provider Architecture). Every adapter
// publishes a capability matrix — UI controls map to declared capabilities,
// never to assumptions (§Runner Protocol).
export interface RuntimeCapabilities {
  interrupt: boolean;
  suspend: boolean;
  resume_session: boolean;
  cancel: boolean;
  stop_after_current: boolean;
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
