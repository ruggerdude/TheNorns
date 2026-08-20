import { describe, expect, it } from "vitest";
import {
  REPOSITORY_BOOTSTRAP_FACT_KEY,
  REPOSITORY_BOOTSTRAP_GREENFIELD,
  deriveAuthoritativeRepositoryFacts,
  deriveRepositoryVerificationFacts,
  mergeRepositoryVerificationFacts,
} from "../src/projects/repositoryVerificationFacts.js";

describe("repository verification fact derivation", () => {
  it("derives exact npm command facts from root package scripts and replaces model policy wording", () => {
    const derived = deriveRepositoryVerificationFacts(
      [
        {
          path: "package.json",
          content: JSON.stringify({
            name: "app",
            scripts: { build: "tsc", test: "vitest run", lint: "biome check ." },
          }),
          truncated: false,
        },
      ],
      ["README.md", "package.json"],
    );

    expect(derived).toEqual([
      { key: "build_command", value: "npm run build", confidence: 1 },
      { key: "test_command", value: "npm run test", confidence: 1 },
      { key: "lint_command", value: "npm run lint", confidence: 1 },
    ]);
    expect(
      mergeRepositoryVerificationFacts(
        [
          { key: "language", value: "TypeScript", confidence: 0.9 },
          { key: "test_command", value: "vitest run", confidence: 0.4 },
          { key: "test command", value: "generic model wording", confidence: 0.5 },
        ],
        derived,
      ),
    ).toEqual([
      { key: "language", value: "TypeScript", confidence: 0.9 },
      { key: "test command", value: "generic model wording", confidence: 0.5 },
      ...derived,
    ]);
  });

  it("uses an explicitly declared package manager and fails closed on ambiguous lockfiles", () => {
    const file = {
      path: "package.json",
      content: JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "vitest run" },
      }),
      truncated: false,
    };
    expect(
      deriveRepositoryVerificationFacts([file], ["package.json", "package-lock.json"]),
    ).toEqual([{ key: "test_command", value: "pnpm run test", confidence: 1 }]);

    const undeclared = {
      ...file,
      content: JSON.stringify({ scripts: { test: "vitest run" } }),
    };
    expect(
      deriveRepositoryVerificationFacts(
        [undeclared],
        ["package.json", "package-lock.json", "yarn.lock"],
      ),
    ).toEqual([]);
  });

  it("records a valid committed manifest as one policy without dropping custom commands", () => {
    expect(
      deriveRepositoryVerificationFacts(
        [
          {
            path: ".norns/verification.json",
            content: JSON.stringify({
              commands: [
                { name: "build", command: ["pnpm", "build"] },
                { name: "test", command: ["node", "-e", "process.exit(0)"] },
                { name: "git-hygiene", command: ["git", "diff-tree", "--check", "HEAD"] },
              ],
            }),
            truncated: false,
          },
          {
            path: "package.json",
            content: JSON.stringify({ scripts: { lint: "biome check ." } }),
            truncated: false,
          },
        ],
        [".norns/verification.json", "package.json"],
      ),
    ).toEqual([
      {
        key: "verification_manifest",
        value: ".norns/verification.json",
        confidence: 1,
      },
    ]);
  });

  it("fails closed for malformed or truncated committed policy", () => {
    const packageFile = {
      path: "package.json",
      content: JSON.stringify({ scripts: { test: "vitest run" } }),
      truncated: false,
    };
    expect(
      deriveRepositoryVerificationFacts(
        [
          {
            path: ".norns/verification.json",
            content: JSON.stringify({
              commands: [{ name: "security-scan", command: "scan ." }],
            }),
            truncated: false,
          },
          packageFile,
        ],
        [".norns/verification.json", "package.json"],
      ),
    ).toEqual([]);
    expect(
      deriveRepositoryVerificationFacts([{ ...packageFile, truncated: true }], ["package.json"]),
    ).toEqual([]);
    expect(
      mergeRepositoryVerificationFacts(
        [{ key: "test_command", value: "model-invented-test", confidence: 0.99 }],
        [],
      ),
    ).toEqual([]);
  });
});

describe("authoritative fact derivation (greenfield bootstrap marker)", () => {
  const greenfield = {
    key: REPOSITORY_BOOTSTRAP_FACT_KEY,
    value: REPOSITORY_BOOTSTRAP_GREENFIELD,
    confidence: 1,
  };

  it("marks a repo with no committed build system as greenfield", () => {
    expect(deriveAuthoritativeRepositoryFacts([], ["README.md"])).toEqual([greenfield]);
  });

  it("prefers real verification facts over the greenfield marker when a build system exists", () => {
    const files = [
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "vitest run" } }),
        truncated: false,
      },
    ];
    expect(deriveAuthoritativeRepositoryFacts(files, ["package.json"])).toEqual([
      { key: "test_command", value: "npm run test", confidence: 1 },
    ]);
  });

  it("does NOT mark greenfield when a package.json exists but declares no verification script", () => {
    // Populated-but-undeclared: still fails closed downstream, never bootstrapped.
    const files = [
      { path: "package.json", content: JSON.stringify({ name: "app" }), truncated: false },
    ];
    expect(deriveAuthoritativeRepositoryFacts(files, ["package.json", "src/index.js"])).toEqual([]);
  });

  it("does NOT mark greenfield when a committed verification manifest is present", () => {
    const files = [
      {
        path: ".norns/verification.json",
        content: JSON.stringify({ commands: [{ name: "test", command: ["npm", "test"] }] }),
        truncated: false,
      },
    ];
    expect(deriveAuthoritativeRepositoryFacts(files, [".norns/verification.json"])).toEqual([
      { key: "verification_manifest", value: ".norns/verification.json", confidence: 1 },
    ]);
  });

  it("re-ingestion reconciles the marker away: merge drops a stale bootstrap fact", () => {
    // A previously-greenfield repo that now has real commands must not keep the marker.
    expect(
      mergeRepositoryVerificationFacts(
        [{ ...greenfield }],
        [{ key: "test_command", value: "npm run test", confidence: 1 }],
      ),
    ).toEqual([{ key: "test_command", value: "npm run test", confidence: 1 }]);
  });
});
