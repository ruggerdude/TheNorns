import { UnauthorizedError, authHeaders } from "./auth";

export interface LocalHelperStatus {
  state: "connected" | "degraded" | "disconnected" | "not_installed";
  runner_id: string | null;
  workspace_clone_ready: boolean;
  message: string;
  downloads: {
    windows: string | null;
    macos: string | null;
    macos_release: "notarized" | "unsigned_preview" | null;
  };
  install_command: string;
  install_command_windows: string;
}

export interface LocalRepositorySelection {
  selection_token: string;
  expires_at: string;
  repository: {
    runner_id: string;
    workspace_id: string;
    repository_id: string;
    repository_display_name: string;
    default_branch: string;
    observed_head: string;
  };
}

export interface LocalRepositoryInventory extends LocalHelperStatus {
  repositories: LocalRepositorySelection[];
}

async function localSourceRequest<T>(path: string, method: "GET" | "POST"): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: authHeaders(method === "POST"),
    ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json().catch(() => ({}))) as T & {
    detail?: string;
    message?: string;
  };
  if (!response.ok) {
    const serverMessage = body.message?.trim() || body.detail?.trim();
    const usefulMessage =
      serverMessage && !/^request failed(?::|\s|\()/i.test(serverMessage)
        ? serverMessage
        : undefined;
    throw new Error(
      usefulMessage ??
        (response.status >= 500
          ? "Norns couldn't check the Local Agent. Try again, or open Connections to verify it."
          : `Local Agent request failed (${response.status}).`),
    );
  }
  return body;
}

export function loadLocalRepositories(): Promise<LocalRepositoryInventory> {
  return localSourceRequest("/api/runners/helper/repositories", "GET");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Choose a local folder without holding one long-lived request open.
 *
 * A folder pick can take minutes; a single request that waits for it gets
 * killed by the edge proxy (502) or a redeploy — the recurring "upstream error"
 * / "Failed to fetch" failure. So this initiates the pick (a fast request that
 * returns an id) and then polls for the outcome with a short series of fast
 * requests, treating a transient network blip or 5xx as "keep waiting" rather
 * than a failure. Only a definitive answer (a chosen folder, a cancel, "not a
 * Git repo", or the request being lost) ends the loop.
 */
export async function chooseLocalRepository(): Promise<
  LocalRepositorySelection | { cancelled: true }
> {
  const { request_id } = await localSourceRequest<{ request_id: string }>(
    "/api/runners/helper/repositories/choose",
    "POST",
  );
  const pollPath = `/api/runners/helper/repositories/choose/${encodeURIComponent(request_id)}`;
  const deadline = Date.now() + 6 * 60_000;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    await sleep(1_500);
    let response: Response;
    try {
      response = await fetch(pollPath, { headers: authHeaders(false) });
    } catch {
      // Network blip: the pick is still alive server-side. Keep polling.
      continue;
    }
    if (response.status === 401) throw new UnauthorizedError();
    if (response.status === 202) continue; // still choosing
    const body = (await response.json().catch(() => ({}))) as (
      | LocalRepositorySelection
      | { cancelled: true }
    ) & { detail?: string; message?: string };
    if (response.ok) return body as LocalRepositorySelection | { cancelled: true };
    const message = body.message?.trim() || body.detail?.trim();
    // 422 = not a Git repo, 404 = the request was lost (e.g. a mid-pick
    // restart). Those are final; everything else (409/429/5xx) is transient and
    // we keep polling until the deadline.
    if (response.status === 422 || response.status === 404) {
      throw new Error(message ?? "Choose the root folder of a Git repository with a commit.");
    }
    lastError = message;
  }
  throw new Error(lastError ?? "The folder chooser timed out. Try again.");
}
