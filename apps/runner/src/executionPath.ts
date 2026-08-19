import { dirname } from "node:path";

/**
 * PATH for child processes the runner spawns (coding runtimes, verification
 * commands). Under launchd the agent inherits only /usr/bin:/bin:/usr/sbin:
 * /sbin, so `npm test` verification failed with `spawn npm ENOENT` even
 * though the work was fine. Prepend the directory of the node binary running
 * this agent plus the standard Homebrew locations where developer toolchains
 * actually live.
 */
// ponytail: hardcoded Homebrew locations; resolve the user's login-shell PATH if these ever miss.
export function executionPath(basePath: string | undefined = process.env.PATH): string {
  const entries = [
    dirname(process.execPath),
    ...(basePath ? basePath.split(":") : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [...new Set(entries.filter((entry) => entry.length > 0))].join(":");
}
