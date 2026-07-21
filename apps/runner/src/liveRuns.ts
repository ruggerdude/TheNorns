// EXECUTION E11 — the registry that makes a running coding agent controllable.
//
// THE BUG THIS FIXES
// ------------------
// `RunnerDaemon` held ONE `FixtureExecutor` and routed every control command to
// it. `interrupt`, `suspend`, `resume_session`, `stop_after_current` and
// `cancel` all reached the Phase 1A demo fixture and nothing else, so a live V2
// coding run could not be stopped by any means: a misbehaving agent burned its
// whole budget and the only lever a human had was the project kill switch or
// the Actions job timeout. `send_message` was not handled at all — it fell to
// `default:` and was rejected. Meanwhile `V2RunnerExecutor` could *report* a
// `cancelled` outcome but nothing could *cause* one, because it never passed an
// `AbortSignal` to `runtime.run()` even though every adapter accepts one.
//
// THE SHAPE
// ---------
// A live run registers itself here for exactly as long as its runtime is
// executing. The registry owns two things and no more:
//
//   * the run's `AbortController`, which is how cancellation actually reaches
//     the model call (every adapter already honours `request.signal`); and
//   * the run's `LiveRunSession`, the optional mid-flight channel a runtime
//     publishes when its SDK genuinely supports one.
//
// Everything else — worktrees, publication, verification — stays in the
// executor. This object decides only "can this control be applied to this run,
// right now, and what is the honest answer if not".
//
// HONESTY RULES
// -------------
// Every refusal names the runtime and says why. A control is NEVER silently
// dropped, NEVER quietly mapped onto a different control (`suspend` is not
// `cancel`; the old daemon mapped it to the fixture's pause and would have
// destroyed a live run's work had it ever reached one), and a control aimed at
// a run that has already ended reports that the run has ended rather than
// returning a bare success. `null` from `control()` means "this registry has
// never heard of that run id" — the caller may then try the fixture path — and
// is the only case where this object declines to have an opinion.
import type { RuntimeCapabilities } from "./runtimes/types.js";

/** The controls a human can aim at a run in flight. */
export type LiveControlKind =
  | "cancel"
  | "interrupt"
  | "suspend"
  | "resume_session"
  | "stop_after_current"
  | "send_message";

/**
 * A mid-flight channel into a runtime's session.
 *
 * Published by the runtime through `RuntimeRunRequest.onSession` only when its
 * SDK really supports the operation. A runtime that cannot accept input while a
 * turn is running simply never publishes `sendMessage`, and the refusal a human
 * sees names that runtime — which is the honest outcome, not a bug.
 */
export interface LiveRunSession {
  /** Deliver a human's message into the running session. */
  sendMessage?(message: string): Promise<void>;
  /** Stop the current turn without ending the run. */
  interrupt?(): Promise<void>;
}

export interface LiveRunRegistration {
  runId: string;
  runtimeName: string;
  capabilities: RuntimeCapabilities;
  /** Abort the run. Must be idempotent: at-least-once delivery is the norm. */
  cancel(reason: string): void;
  /** The live session, once the runtime has published one. Null before that. */
  session(): LiveRunSession | null;
}

export interface LiveControlOutcome {
  /** True only when the control actually reached the running agent. */
  applied: boolean;
  /** The command state the daemon should ack. */
  state: "succeeded" | "rejected";
  /** Why, in words a human can act on. Never empty. */
  detail: string;
}

/** Terminal facts kept about a run after it stops, so a late control is honest. */
interface FinishedRun {
  outcome: string;
  at: number;
}

/** How many ended runs stay explainable. Bounded so a long-lived laptop runner
 *  cannot grow this without limit; older entries fall back to "unknown run". */
const FINISHED_RUN_MEMORY = 200;

export class LiveRunRegistry {
  private readonly live = new Map<string, LiveRunRegistration>();
  private readonly finished = new Map<string, FinishedRun>();

  /**
   * Register a run as live. Returns the release function; the caller MUST call
   * it in a `finally` so a crashed run cannot leave a permanently "live" entry
   * that swallows later controls.
   */
  register(registration: LiveRunRegistration): (outcome: string) => void {
    this.live.set(registration.runId, registration);
    return (outcome: string) => {
      if (this.live.get(registration.runId) === registration) {
        this.live.delete(registration.runId);
      }
      this.finished.set(registration.runId, { outcome, at: Date.now() });
      while (this.finished.size > FINISHED_RUN_MEMORY) {
        const oldest = this.finished.keys().next();
        if (oldest.done) break;
        this.finished.delete(oldest.value);
      }
    };
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  /** Cancel every live run. Used when the daemon is fenced or stopped. */
  cancelAll(reason: string): void {
    for (const registration of [...this.live.values()]) {
      registration.cancel(reason);
    }
  }

  /**
   * Apply a control to a live run.
   *
   * Returns `null` — and only `null` — when this registry has never seen the
   * run id, so the caller can try another executor. Every other answer is a
   * decision this registry stands behind.
   */
  async control(
    runId: string,
    kind: LiveControlKind,
    input: { message?: string } = {},
  ): Promise<LiveControlOutcome | null> {
    const registration = this.live.get(runId);
    if (!registration) {
      const ended = this.finished.get(runId);
      if (!ended) return null;
      return {
        applied: false,
        state: "rejected",
        // The single most important line in this file. A human who answers an
        // agent's question thirty seconds after the job died must be told the
        // answer went nowhere; a silent drop looks exactly like success.
        detail: `run ${runId} has already ended (${ended.outcome}); the ${kind} was not delivered`,
      };
    }
    const runtime = registration.runtimeName;
    switch (kind) {
      case "cancel": {
        // Cancellation is the one control every runtime must honour, because it
        // is the only lever between a misbehaving agent and its whole budget.
        // It is applied even when the matrix says otherwise: aborting the
        // signal at worst stops the runtime the hard way.
        registration.cancel("cancelled by operator");
        return {
          applied: true,
          state: "succeeded",
          detail: `run ${runId} cancelled; work already committed will still be published`,
        };
      }
      case "interrupt": {
        const interrupt = registration.session()?.interrupt;
        if (!interrupt) {
          return {
            applied: false,
            state: "rejected",
            detail: registration.capabilities.interrupt
              ? `runtime ${runtime} supports interrupt but this run has no live session yet`
              : `runtime ${runtime} cannot interrupt a turn in flight; use cancel to stop the run`,
          };
        }
        await interrupt.call(registration.session());
        return { applied: true, state: "succeeded", detail: `run ${runId} interrupted` };
      }
      case "send_message": {
        const message = input.message ?? "";
        if (!message) {
          return { applied: false, state: "rejected", detail: "send_message carried no message" };
        }
        const session = registration.session();
        const send = session?.sendMessage;
        if (!send) {
          return {
            applied: false,
            state: "rejected",
            detail: registration.capabilities.send_message
              ? `runtime ${runtime} accepts mid-session input but this run has no live session yet`
              : `runtime ${runtime} cannot accept input while a turn is running; the message was not delivered`,
          };
        }
        await send.call(session, message);
        return {
          applied: true,
          state: "succeeded",
          detail: `message delivered to run ${runId}`,
        };
      }
      case "suspend": {
        // Deliberately NOT mapped onto cancel or interrupt. Suspending means
        // "stop spending but keep the session so it can continue later", and no
        // runtime we ship can do that inside a job. Faking it by cancelling
        // would throw away the session a human expected to keep.
        return {
          applied: false,
          state: "rejected",
          detail: `runtime ${runtime} cannot suspend a run in place; cancel the run and start a follow-up run instead`,
        };
      }
      case "resume_session": {
        return {
          applied: false,
          state: "rejected",
          detail: `run ${runId} is already executing; resume_session applies to a run that ended with a resumable session`,
        };
      }
      case "stop_after_current": {
        return {
          applied: false,
          state: "rejected",
          detail: registration.capabilities.stop_after_current
            ? `runtime ${runtime} declares stop_after_current but exposes no control for it`
            : `runtime ${runtime} cannot stop after the current step; use cancel to stop the run`,
        };
      }
    }
  }
}
