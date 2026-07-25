import { z } from "zod";

/**
 * Shared bounds for repository inspection over the authenticated runner relay.
 * The local helper and the GitHub analyzer intentionally feed the planning
 * model the same-sized sample.
 */
export const MAX_REPOSITORY_TREE_PATHS = 400;
export const MAX_REPOSITORY_KEY_FILES = 12;
export const MAX_REPOSITORY_FILE_CHARS = 16_000;
export const MAX_REPOSITORY_SAMPLE_CHARS = 120_000;

const SafeRepositoryPath = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "repository path must be a safe relative path",
  );

const SafeRepositoryDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
    "repository display name must not contain a path",
  );

export const RepositoryInspectionFile = z
  .object({
    path: SafeRepositoryPath,
    content: z.string().max(MAX_REPOSITORY_FILE_CHARS),
    truncated: z.boolean(),
  })
  .strict();

/**
 * A bounded, committed-revision snapshot. Physical paths never cross the
 * relay; repository_id remains an opaque helper-local handle.
 */
export const RepositoryInspection = z
  .object({
    repository_id: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    repository_display_name: SafeRepositoryDisplayName,
    default_branch: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          ![...value].some((character) => character.charCodeAt(0) < 32),
        "default branch must not contain a physical path",
      ),
    observed_head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    total_files: z.number().int().nonnegative(),
    tree_truncated: z.boolean(),
    tree_paths: z.array(SafeRepositoryPath).max(MAX_REPOSITORY_TREE_PATHS),
    files: z.array(RepositoryInspectionFile).max(MAX_REPOSITORY_KEY_FILES),
  })
  .strict()
  .superRefine((value, context) => {
    const sampleChars =
      value.tree_paths.reduce((total, path) => total + path.length + 1, 0) +
      value.files.reduce((total, file) => total + file.path.length + file.content.length, 0);
    if (sampleChars > MAX_REPOSITORY_SAMPLE_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repository inspection exceeds the sample character budget",
      });
    }
  });

export type RepositoryInspectionT = z.infer<typeof RepositoryInspection>;

/**
 * Fixed key-file priority shared by GitHub and local-helper inspection.
 * Lower scores are fetched first; unmatched files appear only in the tree.
 */
export function repositoryKeyFileScore(path: string): number | null {
  const depth = path.split("/").length - 1;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const depthPenalty = depth * 10;
  if (/^readme(\.(md|rst|txt|adoc))?$/.test(base)) return depthPenalty;
  if (
    [
      "package.json",
      "pyproject.toml",
      "cargo.toml",
      "go.mod",
      "pom.xml",
      "build.gradle",
      "gemfile",
      "composer.json",
      "mix.exs",
    ].includes(base)
  ) {
    return 1 + depthPenalty;
  }
  if (
    [
      "pnpm-workspace.yaml",
      "lerna.json",
      "turbo.json",
      "nx.json",
      "tsconfig.base.json",
      "tsconfig.json",
      "dockerfile",
      "docker-compose.yml",
      "docker-compose.yaml",
      "makefile",
    ].includes(base)
  ) {
    return 2 + depthPenalty;
  }
  if (/^(architecture|design|contributing)\.md$/.test(base)) return 2 + depthPenalty;
  if (/^(main|index|app|server|cli)\.(ts|tsx|js|mjs|py|go|rs|rb|java)$/.test(base)) {
    return 3 + depthPenalty;
  }
  return null;
}

export function selectRepositoryKeyFiles(
  tree: ReadonlyArray<{ path: string; size: number }>,
): Array<{ path: string; size: number }> {
  return tree
    .map((entry) => ({ entry, score: repositoryKeyFileScore(entry.path) }))
    .filter(
      (candidate): candidate is { entry: { path: string; size: number }; score: number } =>
        candidate.score !== null && candidate.entry.size <= 512 * 1024,
    )
    .sort(
      (left, right) => left.score - right.score || left.entry.path.localeCompare(right.entry.path),
    )
    .slice(0, MAX_REPOSITORY_KEY_FILES)
    .map((candidate) => candidate.entry);
}
