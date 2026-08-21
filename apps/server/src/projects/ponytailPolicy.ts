import {
  DEFAULT_PONYTAIL_MODE,
  type PonytailModeT,
  type ProjectPonytailModeT,
} from "@norns/contracts";

export function resolvePonytailMode(
  globalMode: PonytailModeT | null | undefined,
  projectMode: ProjectPonytailModeT | PonytailModeT | null | undefined,
): PonytailModeT {
  return projectMode && projectMode !== "inherit"
    ? projectMode
    : (globalMode ?? DEFAULT_PONYTAIL_MODE);
}

/** Provider-neutral instructions used by planning, QC, and implementation agents. */
export function ponytailPolicy(mode: PonytailModeT): string | null {
  if (mode === "off") return null;
  const intensity =
    mode === "lite"
      ? "Build the approved scope, but identify a materially simpler alternative when one exists. Do not reduce scope without human approval."
      : mode === "ultra"
        ? "Aggressively remove speculative work and unnecessary layers. Challenge non-mandatory complexity, but never omit an approved requirement or acceptance criterion."
        : "Enforce the simplicity ladder. Choose the shortest complete implementation that satisfies the approved scope.";
  return [
    `# Ponytail development policy · ${mode}`,
    "",
    intensity,
    "",
    "After tracing the task's real flow, stop at the first option that works:",
    "",
    "1. Reuse an existing helper, component, type, or pattern.",
    "2. Use the standard library or a native platform capability.",
    "3. Use an already-installed dependency.",
    "4. Only then write the minimum new code required.",
    "",
    "Fix shared root causes instead of patching individual symptoms. Add no speculative abstraction, dependency, configuration, or scaffolding. Prefer boring code and the fewest appropriate files.",
    "",
    "Approved requirements, acceptance criteria, verification policy, trust-boundary validation, security, data-loss prevention, accessibility, and required error handling are mandatory and must never be simplified away.",
  ].join("\n");
}
