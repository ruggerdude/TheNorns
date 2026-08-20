/**
 * Verification commands are execution policy, so repository analysis must not
 * depend on an LLM choosing exactly the right fact keys. This module derives
 * supported command facts, or a full-manifest policy fact, only from committed
 * files in the bounded repository inspection.
 */

export const REPOSITORY_VERIFICATION_FACT_KEYS = [
  "build_command",
  "test_command",
  "lint_command",
  "verification_manifest",
] as const;

/**
 * Deterministic marker recorded when the repository has no committed build
 * system yet (no root package.json and no committed verification manifest) — a
 * greenfield repo whose first task must be allowed to run to CREATE the very
 * files verification later keys off. It is authoritative and reconciled like a
 * verification fact, so it appears while the repo is greenfield and disappears
 * once a build system is committed.
 */
export const REPOSITORY_BOOTSTRAP_FACT_KEY = "verification_bootstrap";
export const REPOSITORY_BOOTSTRAP_GREENFIELD = "greenfield";

/** Authoritative fact keys derived only from committed files, never a model. */
export const REPOSITORY_AUTHORITATIVE_FACT_KEYS = [
  ...REPOSITORY_VERIFICATION_FACT_KEYS,
  REPOSITORY_BOOTSTRAP_FACT_KEY,
] as const;

export type RepositoryAuthoritativeFactKey = (typeof REPOSITORY_AUTHORITATIVE_FACT_KEYS)[number];

export interface RepositoryVerificationFact {
  key: RepositoryAuthoritativeFactKey;
  value: string;
  confidence: number;
}

export interface InspectedRepositoryFile {
  path: string;
  content: string;
  truncated: boolean;
}

const PACKAGE_SCRIPT_FACT_KEYS = {
  build: "build_command",
  test: "test_command",
  lint: "lint_command",
} as const;

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Validate the same committed manifest shape as the runner. Command names are
 * deliberately unrestricted: the runner supports project-specific checks, and
 * collapsing those into only build/test/lint would silently weaken QC.
 */
function isValidManifest(file: InspectedRepositoryFile): boolean {
  if (file.truncated) return false;
  const parsed = objectRecord(parseJson(file.content));
  if (!parsed || !Array.isArray(parsed.commands) || parsed.commands.length === 0) return false;
  for (const value of parsed.commands) {
    const command = objectRecord(value);
    const argv = command?.command;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part) => typeof part === "string")
    ) {
      return false;
    }
  }
  return true;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function packageManager(
  packageJson: Record<string, unknown>,
  treePaths: ReadonlySet<string>,
): PackageManager | null {
  if (typeof packageJson.packageManager === "string") {
    const declared = packageJson.packageManager.trim().split("@", 1)[0]?.toLowerCase();
    return declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun"
      ? declared
      : null;
  }
  const detected = new Set<PackageManager>();
  if (treePaths.has("package-lock.json") || treePaths.has("npm-shrinkwrap.json")) {
    detected.add("npm");
  }
  if (treePaths.has("pnpm-lock.yaml")) detected.add("pnpm");
  if (treePaths.has("yarn.lock")) detected.add("yarn");
  if (treePaths.has("bun.lock") || treePaths.has("bun.lockb")) detected.add("bun");
  if (detected.size > 1) return null;
  return detected.values().next().value ?? "npm";
}

function packageScriptFacts(
  file: InspectedRepositoryFile,
  treePaths: ReadonlySet<string>,
): RepositoryVerificationFact[] {
  if (file.truncated) return [];
  const packageJson = objectRecord(parseJson(file.content));
  const scripts = objectRecord(packageJson?.scripts);
  if (!packageJson || !scripts) return [];
  const manager = packageManager(packageJson, treePaths);
  if (!manager) return [];
  const facts: RepositoryVerificationFact[] = [];
  for (const name of ["build", "test", "lint"] as const) {
    if (typeof scripts[name] === "string" && scripts[name].trim().length > 0) {
      facts.push({
        key: PACKAGE_SCRIPT_FACT_KEYS[name],
        value: `${manager} run ${name}`,
        confidence: 1,
      });
    }
  }
  return facts;
}

export function deriveRepositoryVerificationFacts(
  files: readonly InspectedRepositoryFile[],
  treePaths: readonly string[],
): RepositoryVerificationFact[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const paths = new Set(treePaths);
  const manifestPath = ".norns/verification.json";
  if (paths.has(manifestPath)) {
    const manifest = byPath.get(manifestPath);
    return manifest && isValidManifest(manifest)
      ? [{ key: "verification_manifest", value: manifestPath, confidence: 1 }]
      : [];
  }

  const rootPackage = byPath.get("package.json");
  return rootPackage ? packageScriptFacts(rootPackage, paths) : [];
}

/**
 * A repo with no committed build system our tooling recognizes — no root
 * package.json and no committed verification manifest. Its first task is a
 * bootstrap that must run to create those files, so dispatch is allowed and the
 * runner's own verification chain (auto-detect once package.json exists →
 * git-hygiene → fail-closed) becomes the guard.
 *
 * ponytail: recognizes only the package.json / manifest ecosystems the runner
 * can auto-verify. A non-Node greenfield repo (a lone Makefile, say) is also
 * flagged greenfield and would dispatch, then fail closed at the runner if it
 * produces nothing verifiable — safe, just some wasted compute. Widen this
 * predicate if/when the runner learns to bootstrap-verify other ecosystems.
 */
function repositoryIsGreenfield(treePaths: readonly string[]): boolean {
  const paths = new Set(treePaths);
  return !paths.has("package.json") && !paths.has(".norns/verification.json");
}

/**
 * All authoritative (committed-file-derived, never model-authored) facts: the
 * verification commands/manifest plus the greenfield bootstrap marker. Recorded
 * under REPOSITORY_AUTHORITATIVE_FACT_KEYS so re-ingestion reconciles them —
 * the marker appears while greenfield and vanishes once a build system lands.
 */
export function deriveAuthoritativeRepositoryFacts(
  files: readonly InspectedRepositoryFile[],
  treePaths: readonly string[],
): RepositoryVerificationFact[] {
  const verification = deriveRepositoryVerificationFacts(files, treePaths);
  if (verification.length > 0) return verification;
  return repositoryIsGreenfield(treePaths)
    ? [
        {
          key: REPOSITORY_BOOTSTRAP_FACT_KEY,
          value: REPOSITORY_BOOTSTRAP_GREENFIELD,
          confidence: 1,
        },
      ]
    : [];
}

/**
 * Model output remains useful for descriptive facts, but it is never trusted
 * for executable policy keys. Exact command/manifest keys are removed first
 * and replaced only with facts deterministically supported by inspected files.
 */
export function mergeRepositoryVerificationFacts<
  T extends { key: string; value: string; confidence: number },
>(modelFacts: readonly T[], derivedFacts: readonly RepositoryVerificationFact[]) {
  const authoritativeKeys = new Set<string>(REPOSITORY_AUTHORITATIVE_FACT_KEYS);
  return [...modelFacts.filter((fact) => !authoritativeKeys.has(fact.key.trim())), ...derivedFacts];
}
