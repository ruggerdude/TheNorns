// ---------------------------------------------------------------------------
// TODO(O3): local-helper adapter.
//
// Phase O3 (in parallel with this one) is defining the exact install
// command, pairing contract, and status shape for the local companion
// ("helper"/"runner"). Until that contract lands, this module is a thin,
// clearly-isolated adapter over TODAY's endpoints — /api/runners,
// /api/runners/:id/workspaces/choose, and /api/pairing/start — reusing the
// exact shapes already consumed by Account.tsx (the pairing panel) and
// Projects.tsx (the native folder chooser). When O3's contract lands, only
// this file should need to change; every caller in the wizard goes through
// the functions/types exported here rather than touching /api/runners or
// /api/pairing directly.
// ---------------------------------------------------------------------------
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: authHeaders(body !== undefined),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as T & { message?: string };
  if (!res.ok) throw new ApiError(json.message ?? `request failed: ${res.status}`, res.status);
  return json;
}

/** Today's `/api/runners` row shape (a subset — only the fields this adapter
 *  reads). Kept local rather than imported so this module has no dependency
 *  on Projects.tsx's internal types. */
interface RunnerRow {
  runner_id: string;
  connected: boolean;
  workspace_picker_ready?: boolean;
  local_project_onboarding_ready?: boolean;
}

/** Whether a paired local helper is ready to open a native folder dialog.
 *  `"connected"` names the runner the wizard should target; `"not_installed"`
 *  covers both "never paired" and "paired but currently offline/outdated" —
 *  the wizard shows the same single install step either way. */
export type LocalHelperStatus =
  | { state: "connected"; runnerId: string }
  | { state: "not_installed" };

/** Poll `/api/runners` once and report whether an eligible, connected helper
 *  exists. "Eligible" mirrors the gating FRONT DOOR P2b already applied
 *  before offering the native picker (workspace_picker_ready +
 *  local_project_onboarding_ready) — an older/stale runner is treated the
 *  same as "not installed" rather than a third state, matching the brief's
 *  "two states, neither a dead end". */
export async function getLocalHelperStatus(): Promise<LocalHelperStatus> {
  const runners = await request<RunnerRow[]>("/api/runners");
  const eligible = runners.find(
    (runner) =>
      runner.connected &&
      runner.workspace_picker_ready === true &&
      runner.local_project_onboarding_ready === true,
  );
  return eligible
    ? { state: "connected", runnerId: eligible.runner_id }
    : { state: "not_installed" };
}

/** A folder chosen (and, today, validated as a Git repository) through the
 *  runner's native OS dialog. The raw filesystem path never reaches the
 *  browser — only this safe, presentation-ready metadata does. */
export interface LocalFolderSelection {
  selectionToken: string;
  expiresAt: string;
  runnerId: string;
  workspaceId: string;
  displayName: string;
  defaultBranch: string | null;
}

interface ChooseWorkspaceResponse {
  selection_token: string;
  expires_at: string;
  repository: {
    runner_id: string;
    workspace_id: string;
    repository_display_name: string;
    default_branch: string | null;
  };
}

/** Open the native folder dialog on the paired helper machine. Resolves to
 *  `{ cancelled: true }` if the human dismissed the dialog without choosing
 *  anything — not an error. */
export async function chooseLocalFolder(
  runnerId: string,
): Promise<LocalFolderSelection | { cancelled: true }> {
  const result = await request<ChooseWorkspaceResponse | { cancelled: true }>(
    `/api/runners/${encodeURIComponent(runnerId)}/workspaces/choose`,
    {},
  );
  if ("cancelled" in result) return result;
  return {
    selectionToken: result.selection_token,
    expiresAt: result.expires_at,
    runnerId: result.repository.runner_id,
    workspaceId: result.repository.workspace_id,
    displayName: result.repository.repository_display_name,
    defaultBranch: result.repository.default_branch,
  };
}

/** A pairing code plus the one-line install command that pairs it — same
 *  template Account.tsx's runner panel already shows (`install-runner.sh`
 *  piped through `sh`, taking the pairing code and this origin). */
export interface LocalHelperPairing {
  code: string;
  expiresAt: string;
  installCommand: string;
}

/** Start a pairing session so the wizard can show a single copyable install
 *  command instead of sending the human to Settings mid-setup. */
export async function startLocalHelperPairing(
  origin: string = window.location.origin,
): Promise<LocalHelperPairing> {
  const pairing = await request<{ code: string; expires_at: string }>("/api/pairing/start", {});
  return {
    code: pairing.code,
    expiresAt: pairing.expires_at,
    installCommand: `curl -fsSL ${origin}/install-runner.sh | sh -s -- ${pairing.code} ${origin}`,
  };
}

/** Poll `getLocalHelperStatus` until a connected, eligible helper shows up,
 *  then invoke `onConnected` once and stop — "poll for the helper to come
 *  online, then continue automatically" from the brief. Returns a cleanup
 *  function; callers must invoke it on unmount/step-change to avoid a stray
 *  timer outliving the component. Best-effort: a transient poll failure is
 *  swallowed and retried on the next tick rather than surfaced as an error. */
export function watchForLocalHelper(
  onConnected: (runnerId: string) => void,
  { intervalMs = 3000 }: { intervalMs?: number } = {},
): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const status = await getLocalHelperStatus();
      if (!stopped && status.state === "connected") {
        stopped = true;
        onConnected(status.runnerId);
      }
    } catch {
      // Transient — retried on the next tick.
    } finally {
      inFlight = false;
    }
  };
  const timer = window.setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
