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
  /** Runner-owned, hash-verified task inputs the runtime may read but not write. */
  additionalReadDirectories?: string[];
  /** Runner-owned state directory used as HOME/cache instead of the user's home. */
  runtimeStateDirectory?: string;
  timeoutMs?: number;
  /** Execution-loop policy selected by the approved planning path. */
  executionMode?: "quick" | "planned";
  /**
   * The dispatch's already-authorized dollar ceiling. Agentic SDKs that can
   * enforce a local budget should use this in addition to the gateway's
   * reservation check; the two guards fail independently.
   */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  onLog?: (chunk: string) => void;
  /**
   * EXECUTION E11 — published by the runtime once (and only once) it holds a
   * session that can genuinely accept mid-flight control. A runtime whose SDK
   * offers no such channel never calls this, and the control layer answers a
   * human with a refusal that names the runtime instead of pretending.
   */
  onSession?: (session: RuntimeSession) => void;
  /** Outside-checkout typed ask channel prepared by the runner. */
  humanWaitPath?: string;
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

interface RuntimeRunResultBase {
  detail: string;
  usage: RuntimeUsage;
  /**
   * True only when the runtime's containment implementation verified that no
   * managed descendant remains. Omission is deliberately unproven, not true.
   */
  process_tree_reaped?: boolean;
  /** session/thread id when the runtime supports resumption */
  sessionId?: string;
  /** Provider/SDK-native reason the agent loop stopped, when reported. */
  stopReason?: string;
  /**
   * Typed, visible-only ask. It is required exactly for waiting_for_human;
   * logs or prose can never be inferred into a durable human wait.
   */
}

export type RuntimeRunResult =
  | (RuntimeRunResultBase & {
      outcome: "waiting_for_human";
      humanWait: {
        decisionPoint: string;
        question: string;
        questionHash: string;
        compactSummary: string;
        compactSummaryHash: string;
      };
    })
  | (RuntimeRunResultBase & {
      outcome: "completed" | "failed" | "cancelled";
      humanWait?: never;
    });

export interface CodingRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
}
