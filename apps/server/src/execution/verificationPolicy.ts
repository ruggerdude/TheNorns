import type { V2VerificationCommandT } from "@norns/contracts";

export const VERIFICATION_COMMAND_KEYS = ["build_command", "test_command", "lint_command"] as const;
export const VERIFICATION_MANIFEST_KEY = "verification_manifest";
export const VERIFICATION_POLICY_FACT_KEYS = [
  ...VERIFICATION_COMMAND_KEYS,
  VERIFICATION_MANIFEST_KEY,
] as const;

const SHELL_METACHARACTERS = /[|&;<>()$`\\"'*?[\]{}~\n\r]/;

/** Split one approved command into an argv vector without inventing a shell. */
export function tokenizeVerificationCommand(value: string): [string, ...string[]] | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of trimmed) {
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === " " || character === "\t") {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (SHELL_METACHARACTERS.test(character)) return null;
    current += character;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(current);
  const [file, ...args] = tokens;
  if (!file) return null;
  return [file, ...args];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const TEST_EXECUTABLES = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "node",
  "deno",
  "python",
  "python3",
  "pytest",
  "uv",
  "cargo",
  "go",
  "make",
  "cmake",
  "dotnet",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "composer",
  "php",
  "ruby",
  "bundle",
  "rspec",
]);

/**
 * Extracts explicit, shell-free commands from an immutable approved task
 * package. This is only the greenfield fallback when no committed project
 * verification policy exists yet.
 */
export function verificationCommandsFromTaskPackage(value: unknown): V2VerificationCommandT[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const module = record(record(parsed)?.module);
  if (!module) return [];
  const candidates: Array<{ name: string; value: string; trustedAsCommand: boolean }> = [];
  const execution = record(module.execution);
  if (Array.isArray(execution?.test_commands)) {
    execution.test_commands.forEach((command, index) => {
      if (typeof command === "string") {
        candidates.push({
          name: `task-package-test-${index + 1}`,
          value: command,
          trustedAsCommand: true,
        });
      }
    });
  }
  if (Array.isArray(module.acceptance)) {
    module.acceptance.forEach((entry, index) => {
      const criterion = record(entry);
      if (!criterion) return;
      const verification = criterion?.verification;
      const type = criterion?.verification_type;
      if (typeof verification !== "string" || (type !== "command" && type !== "test")) return;
      candidates.push({
        name:
          typeof criterion.id === "string" && criterion.id.trim() !== ""
            ? criterion.id.trim()
            : `acceptance-${index + 1}`,
        value: verification,
        trustedAsCommand: type === "command",
      });
    });
  }

  const commands: V2VerificationCommandT[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const command = tokenizeVerificationCommand(candidate.value);
    if (!command) continue;
    if (!candidate.trustedAsCommand && !TEST_EXECUTABLES.has(command[0])) continue;
    const identity = JSON.stringify(command);
    if (seen.has(identity)) continue;
    seen.add(identity);
    commands.push({ name: candidate.name.slice(0, 200), command });
    if (commands.length === 32) break;
  }
  return commands;
}
