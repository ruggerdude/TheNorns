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
  const body = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    throw new Error(body.message ?? `Local source request failed (${response.status})`);
  }
  return body;
}

export function loadLocalRepositories(): Promise<LocalRepositoryInventory> {
  return localSourceRequest("/api/runners/helper/repositories", "GET");
}

export function chooseLocalRepository(): Promise<LocalRepositorySelection | { cancelled: true }> {
  return localSourceRequest("/api/runners/helper/repositories/choose", "POST");
}
