// ---------------------------------------------------------------------------
// The four onboarding scenarios (O1's brief), and how each maps onto
// POST /api/projects today:
//
//   (a) new + local only        -> real, working shape: { source_type:
//                                  "local", source_location }.
//   (b) new + local, push to GH -> DUAL binding (local + GitHub together).
//   (c) existing on GitHub,
//       staged into a folder    -> DUAL binding.
//   (d) existing local,
//       push to GitHub          -> DUAL binding.
//
// Only (a) is backed by a request shape the server already accepts. (b),
// (c), and (d) all need a project that is simultaneously bound to a local
// folder AND a GitHub repository — phase O2 (running in parallel) is
// building those creation commands and the dual local+GitHub binding
// contract. This module isolates every assumption about that not-yet-final
// shape in one place — see buildSourceFields' TODO(O2) below — so the PM can
// rewire just this file at integration instead of hunting through the
// wizard's JSX.
//
// Confirmed against today's server (apps/server/src/server.ts): the
// CreateProjectBody schema's superRefine actively REJECTS a request that
// sets both a local `source_location` and the `github_*` fields — they're
// mutually exclusive today, by design. buildSourceFields' dual-binding
// branch below will therefore be rejected by the real server until O2
// lands; that's expected for this phase (see this file's report to the
// PM). Also worth O2 knowing: a sibling endpoint,
// POST /api/v2/projects/:id/source-bindings/github, already exists
// server-side (schema + service method), but its body needs
// runner-reported fields no web-only wizard can honestly supply yet
// (github_installation_id, observed_head, granted_permissions) — it isn't
// a drop-in fix, just a lead for whoever designs the real dual-binding
// contract.
// ---------------------------------------------------------------------------

export type ProjectSourceScenario =
  | "new_local"
  | "new_local_github"
  | "existing_github"
  | "existing_local";

/** A folder the wizard has settled on, from either the runner's native
 *  dialog (a display name + selection token, never a raw path) or the
 *  de-emphasized typed-path fallback (a raw path the human typed themselves,
 *  which is fine to send since they, not The Norns, produced it as text). */
export type ResolvedLocalFolder =
  | { kind: "runner"; selectionToken: string; displayName: string }
  | { kind: "path"; path: string };

/** A GitHub repository the wizard has settled on, from either picking one of
 *  the connected installation's existing repositories or having just created
 *  one (POST /api/integrations/github/repositories, a real, working endpoint
 *  today — see GitHubIntegrationService.createRepository). */
export interface ResolvedGitHubRepository {
  connectionId: string;
  repositoryId: string;
  fullName: string;
}

export interface BuildSourceFieldsInput {
  scenario: ProjectSourceScenario;
  local: ResolvedLocalFolder | null;
  github: ResolvedGitHubRepository | null;
}

export interface SourceFieldsResult {
  /** Fields to merge into the POST /api/projects body. */
  fields: Record<string, unknown>;
  /** True for (b)/(c)/(d) — a shape O2 hasn't finalized yet. */
  isAssumedDualBinding: boolean;
}

function localSourceLocation(local: ResolvedLocalFolder): string {
  // A runner-validated folder never surfaces its real path to the browser
  // (see localHelper.ts) — the display name is the only safe stand-in until
  // O2 defines how a dual-bound project should refer to it server-side.
  return local.kind === "path" ? local.path : local.displayName;
}

/**
 * Shape the POST /api/projects body for one of the four scenarios.
 *
 * (a) new_local: today's real, working shape — unchanged from what
 * Projects.tsx already sent for a typed local path.
 *
 * (b)/(c)/(d): TODO(O2) — no server contract for a dual local+GitHub binding
 * exists yet, so this is a best-effort guess: send the same `source_location`
 * the local-only path uses, *plus* `github_connection_id`/
 * `github_repository_id` alongside it (rather than the old mutually-
 * exclusive `source_type: "local" | "github"` switch). The PM/O2 should
 * replace this branch with whatever the real dual-binding creation command
 * turns out to need — every other caller in the wizard goes through this
 * function, so that's a one-file change.
 */
export function buildSourceFields(input: BuildSourceFieldsInput): SourceFieldsResult {
  const { scenario, local, github } = input;

  if (scenario === "new_local") {
    if (!local) return { fields: {}, isAssumedDualBinding: false };
    return {
      fields: { source_type: "local", source_location: localSourceLocation(local) },
      isAssumedDualBinding: false,
    };
  }

  // (b) new_local_github, (c) existing_github, (d) existing_local all bind a
  // local folder and a GitHub repository to the same project.
  // TODO(O2): assumed shape — reconcile with the real dual-binding contract.
  const fields: Record<string, unknown> = {};
  if (local) {
    fields.source_type = "local";
    fields.source_location = localSourceLocation(local);
  }
  if (github) {
    fields.github_connection_id = github.connectionId;
    fields.github_repository_id = github.repositoryId;
  }
  return { fields, isAssumedDualBinding: true };
}

/** Parse a pasted GitHub repo reference into `{owner, name}` — the "paste a
 *  repo URL as a shortcut" affordance. Accepts:
 *    - "owner/repo"
 *    - "https://github.com/owner/repo", with or without a trailing
 *      ".git"/"/" /query/hash
 *    - "git@github.com:owner/repo.git"
 *  Returns null for anything else (the search box then just filters by
 *  substring, same as before). */
export function parseGitHubRepoRef(text: string): { owner: string; name: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const patterns = [
    /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[?#].*)?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i,
    /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return { owner: match[1], name: match[2] };
  }
  return null;
}

/** Plain-language confirmation copy, e.g.:
 *    "Files will live in native-app · Pushes to github.com/octocat/native-app"
 *    "Files will live at /Users/you/code/thing · No remote"
 *  Never fabricates a path the browser doesn't actually know (see
 *  localSourceLocation above) — a runner-picked folder is described by its
 *  safe display name, not an invented path. */
export function describeSetup(
  local: ResolvedLocalFolder | null,
  github: ResolvedGitHubRepository | null,
): string {
  const localPart = local
    ? local.kind === "path"
      ? `Files will live at ${local.path}`
      : `Files will live in ${local.displayName}`
    : "No local folder chosen yet";
  const remotePart = github ? `Pushes to github.com/${github.fullName}` : "No remote";
  return `${localPart} · ${remotePart}`;
}
