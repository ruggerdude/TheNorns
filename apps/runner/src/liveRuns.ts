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
  cancel(reason: string, options: { publication: "allow_committed" | "fenced" }): void;
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

export interface LiveRunTerminalFacts {
  outcome: string;
  process_tree_reaped: boolean;
}

export interface LiveRunStopOutcome extends LiveRunTerminalFacts {
  found: boolean;
  confirmation_timed_out: boolean;
  eventual_terminal: Promise<LiveRunTerminalFacts> | null;
}

/** Terminal facts kept about a run after it stops, so a late control is honest. */
interface FinishedRun extends LiveRunTerminalFacts {
  at: number;
}

interface LiveEntry {
  registration: LiveRunRegistration;
  terminal: Promise<LiveRunTerminalFacts>;
  resolveTerminal(facts: LiveRunTerminalFacts): void;
}

/** How many ended runs stay explainable. Bounded so a long-lived laptop runner
 *  cannot grow this without limit; older entries fall back to "unknown run". */
const FINISHED_RUN_MEMORY = 200;
const DEFAULT_TERMINAL_CONFIRMATION_TIMEOUT_MS = 10_000;

export class LiveRunRegistry {
  private readonly live = new Map<string, LiveEntry>();
  private readonly finished = new Map<string, FinishedRun>();

  constructor(
    private readonly terminalConfirmationTimeoutMs = DEFAULT_TERMINAL_CONFIRMATION_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(terminalConfirmationTimeoutMs) ||
      terminalConfirmationTimeoutMs <= 0
    ) {
      throw new Error("live-run terminal confirmation timeout must be a positive integer");
    }
  }

  /**
   * Register a run as live. Returns the release function; the caller MUST call
   * it in a `finally` so a crashed run cannot leave a permanently "live" entry
   * that swallows later controls.
   */
  register(
    registration: LiveRunRegistration,
  ): (outcome: string, facts?: { process_tree_reaped?: boolean }) => void {
    let resolveTerminal: (facts: LiveRunTerminalFacts) => void = () => undefined;
    const terminal = new Promise<LiveRunTerminalFacts>((resolve) => {
      resolveTerminal = resolve;
    });
    const entry: LiveEntry = { registration, terminal, resolveTerminal };
    this.live.set(registration.runId, entry);
    return (outcome: string, facts: { process_tree_reaped?: boolean } = {}) => {
      if (this.live.get(registration.runId) === entry) {
        this.live.delete(registration.runId);
      }
      const terminalFacts = {
        outcome,
        process_tree_reaped: facts.process_tree_reaped === true,
      };
      entry.resolveTerminal(terminalFacts);
      this.finished.set(registration.runId, { ...terminalFacts, at: Date.now() });
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
    for (const { registration } of [...this.live.values()]) {
      // A daemon-wide stop is used for generation fencing and process
      // shutdown. Local work remains recoverable, but a fenced installation
      // must not publish it later through Norns. Registrations therefore treat
      // this as a monotonic escalation even if a project-level cancellation
      // already fired the underlying AbortSignal.
      registration.cancel(reason, { publication: "fenced" });
    }
  }

  /**
   * Cancel one exact run and wait until its executor has left the live
   * registry. A remembered terminal result is returned for response-loss
   * retries; an unknown run is never treated as proof that its process exited.
   */
  async cancelAndWait(
    runId: string,
    reason: string,
    options: { publication: "allow_committed" | "fenced" },
  ): Promise<LiveRunStopOutcome> {
    const entry = this.live.get(runId);
    if (entry) {
      entry.registration.cancel(reason, options);
      const terminal = await this.boundedTerminal(entry.terminal);
      if (!terminal) {
        return {
          found: true,
          outcome: "cancellation_requested",
          process_tree_reaped: false,
          confirmation_timed_out: true,
          eventual_terminal: entry.terminal,
        };
      }
      return {
        found: true,
        ...terminal,
        confirmation_timed_out: false,
        eventual_terminal: null,
      };
    }
    const finished = this.finished.get(runId);
    if (finished) {
      if (options.publication === "fenced") {
        // Publication cannot still be in flight after the registration's
        // terminal release. The durable server-side publication fence remains
        // authoritative for future attempts.
      }
      return {
        found: true,
        outcome: finished.outcome,
        process_tree_reaped: finished.process_tree_reaped,
        confirmation_timed_out: false,
        eventual_terminal: null,
      };
    }
    return {
      found: false,
      outcome: "unknown",
      process_tree_reaped: false,
      confirmation_timed_out: false,
      eventual_terminal: null,
    };
  }

  /**
   * Fence every run that is live at the time of the call and await their
   * terminal containment facts. New dispatch remains a server/daemon gate;
   * this method does not pretend an empty registry proves an old unknown run
   * exited.
   */
  async cancelAllAndWait(reason: string): Promise<{
    stop_requested: number;
    process_trees_reaped: number;
    unconfirmed: number;
    eventual: Promise<{
      stop_requested: number;
      process_trees_reaped: number;
      unconfirmed: number;
    }> | null;
  }> {
    const entries = [...this.live.values()];
    for (const entry of entries) {
      entry.registration.cancel(reason, { publication: "fenced" });
    }
    const terminal = await Promise.all(
      entries.map((entry) => this.boundedTerminal(entry.terminal)),
    );
    const processTreesReaped = terminal.filter(
      (facts) => facts?.process_tree_reaped === true,
    ).length;
    const timedOut = terminal.some((facts) => facts === null);
    const summarize = (
      facts: readonly LiveRunTerminalFacts[],
    ): {
      stop_requested: number;
      process_trees_reaped: number;
      unconfirmed: number;
    } => {
      const reaped = facts.filter((item) => item.process_tree_reaped).length;
      return {
        stop_requested: facts.length,
        process_trees_reaped: reaped,
        unconfirmed: facts.length - reaped,
      };
    };
    return {
      stop_requested: terminal.length,
      process_trees_reaped: processTreesReaped,
      unconfirmed: terminal.length - processTreesReaped,
      eventual: timedOut
        ? Promise.all(entries.map((entry) => entry.terminal)).then(summarize)
        : null,
    };
  }

  terminalFacts(runId: string): LiveRunTerminalFacts | null {
    const finished = this.finished.get(runId);
    return finished
      ? {
          outcome: finished.outcome,
          process_tree_reaped: finished.process_tree_reaped,
        }
      : null;
  }

  liveCount(): number {
    return this.live.size;
  }

  waitForTerminal(runId: string): Promise<LiveRunTerminalFacts> | null {
    const live = this.live.get(runId);
    if (live) return live.terminal;
    const finished = this.terminalFacts(runId);
    return finished ? Promise.resolve(finished) : null;
  }

  private boundedTerminal(
    terminal: Promise<LiveRunTerminalFacts>,
  ): Promise<LiveRunTerminalFacts | null> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, this.terminalConfirmationTimeoutMs);
      void terminal.then((facts) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(facts);
      });
    });
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
    const entry = this.live.get(runId);
    if (!entry) {
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
    const registration = entry.registration;
    const runtime = registration.runtimeName;
    switch (kind) {
      case "cancel": {
        // Cancellation is the one control every runtime must honour, because it
        // is the only lever between a misbehaving agent and its whole budget.
        // It is applied even when the matrix says otherwise: aborting the
        // signal at worst stops the runtime the hard way.
        registration.cancel("cancelled by operator", { publication: "allow_committed" });
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
