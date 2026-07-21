// EXECUTION E10 (E9-9, supersedes E3-11) — naming a runtime the runner can
// actually construct.
//
// THE BUG. `V2DispatchCommand.runtime` is looked up verbatim in the runner's
// runtime map, whose only keys are `claude-code`, `codex` and
// `proxied-completion`. But `StrategyBridgeService.ensureProfiles` wrote
// `agent_profiles.runtime = <provider>` — `anthropic` or `openai` — so a task
// staffed through the normal planning path dispatched a runtime name no runner
// has ever registered, and the executor threw `runtime anthropic is
// unavailable` before doing any work. Nothing caught it because every
// coordinator test seeds its own profile row with a hand-written `codex`.
//
// WHY IT MATTERS NOW. Until EXECUTION E9 the agentic runtimes were
// credential-dependent and could not run inside an ephemeral GitHub Actions
// job, so the only credential-free option was `proxied-completion` — a
// one-shot completion runtime that cannot read a second file and therefore
// cannot meaningfully write code. E9's provider-native gateway removes that
// constraint: `claude-code` and `codex` reach models through
// `ANTHROPIC_BASE_URL` / `baseUrl` pointed at Norns, and no provider key ever
// enters the job. Dispatching a real agentic runtime is the difference between
// an end-to-end run that produces an actual code change and one that produces a
// single text file.

/** Every runtime key the runner CLI registers. Nothing else can be dispatched. */
export const RUNNER_RUNTIMES = ["claude-code", "codex", "proxied-completion"] as const;
export type RunnerRuntimeName = (typeof RUNNER_RUNTIMES)[number];

/**
 * The agentic runtime that speaks a given provider's models.
 *
 * Both are credential-free as of E9, so this is the right answer for a laptop
 * runner and an Actions job alike — there is no longer a reason to downgrade
 * hosted work to a one-shot completion runtime.
 */
export function agenticRuntimeForProvider(provider: string): RunnerRuntimeName | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") return "claude-code";
  if (normalized === "openai") return "codex";
  return null;
}

/**
 * Resolve the runtime to put on a dispatch command.
 *
 * A stored value that is already a real runtime name is authoritative and
 * passes through untouched — an operator who deliberately selected
 * `proxied-completion` keeps it. Otherwise the provider decides. If neither
 * yields a known runtime the stored value is returned UNCHANGED so the runner
 * refuses it loudly with the name it was actually given; guessing a default
 * here would dispatch an agent nobody asked for, which is a worse failure than
 * an explicit one.
 */
export function resolveDispatchRuntime(storedRuntime: string, provider: string): string {
  if ((RUNNER_RUNTIMES as readonly string[]).includes(storedRuntime)) return storedRuntime;
  return agenticRuntimeForProvider(provider) ?? storedRuntime;
}
