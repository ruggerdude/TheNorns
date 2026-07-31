import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type {
  DeviceEnrollmentCoordinator,
  PublicDeviceEnrollmentStatus,
} from "./deviceEnrollment.js";
import type {
  PendingDeviceCredentialStore,
  PendingDeviceCredentialSummary,
} from "./pendingDeviceCredential.js";
import { Redactor } from "./redact.js";
import { LocalRepositoryAccessController } from "./repositoryAccess.js";
import { WorkspaceRegistry } from "./workspaceRegistry.js";

export const AGENT_HOST_LOCK_FILENAME = "agent-host.lock";
export const AGENT_HOST_PORT_FILENAME = "agent-host.json";
export const AGENT_HOST_SESSION_COOKIE = "norns_agent_session";
export const AGENT_HOST_CSRF_HEADER = "x-norns-agent-csrf";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"] as const);
const DEFAULT_BOOTSTRAP_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_NATIVE_LAUNCH_REQUEST_IDS = 4_096;
const NATIVE_LAUNCH_REQUEST_PURPOSE = "norns:agent-host-native-launch-request:v1";
const NATIVE_LAUNCH_RESPONSE_PURPOSE = "norns:agent-host-native-launch-response:v1";
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const AGENT_HOST_VERSION = process.env.NORNS_LOCAL_AGENT_VERSION ?? "0.1.0";
const EMERGENCY_STOP_CONFIRMATION = "STOP ALL NORNS WORK";
const MANUAL_UPDATE_GUIDANCE =
  "Install a newer signed Norns Local Agent package manually. Automatic updates are not enabled.";
const SUPPORT_BUNDLE_REDACTOR = new Redactor();
const SUPPORT_PATH_PATTERN =
  /(?:[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]+|\/(?:(?:Users|home|tmp|var|etc|opt|private|Volumes|Applications)(?:\/[^/\s"'<>]+)*|[^/\s"'<>]+\/[^/\s"'<>]+(?:\/[^/\s"'<>]+)*))/g;
const SUPPORT_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function redactSupportValue(value: string): string {
  return SUPPORT_BUNDLE_REDACTOR.redact(value)
    .replace(SUPPORT_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(SUPPORT_EMAIL_PATTERN, "[REDACTED_IDENTITY]")
    .slice(0, 200);
}

const CONTROL_CENTER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Norns Local Agent Control Center</title>
  <link rel="stylesheet" href="/agent-host.css">
  <script defer src="/agent-host.js"></script>
</head>
<body>
  <header>
    <p class="eyebrow">Norns Local Agent</p>
    <h1>Control Center</h1>
    <p id="message" role="status">Opening the local Control Center…</p>
  </header>
  <nav aria-label="Control Center sections" role="tablist">
    <button class="tab" id="tab-home" role="tab" type="button" data-panel="home" aria-controls="home" aria-selected="true" tabindex="0">Home</button>
    <button class="tab" id="tab-security" role="tab" type="button" data-panel="security" aria-controls="security" aria-selected="false" tabindex="-1">Security</button>
    <button class="tab" id="tab-repositories" role="tab" type="button" data-panel="repositories" aria-controls="repositories" aria-selected="false" tabindex="-1">Repositories</button>
    <button class="tab" id="tab-diagnostics" role="tab" type="button" data-panel="diagnostics" aria-controls="diagnostics" aria-selected="false" tabindex="-1">Diagnostics</button>
  </nav>
  <main>
    <section id="home" role="tabpanel" aria-labelledby="tab-home" tabindex="0">
      <h2 id="home-heading">Home</h2>
      <p class="device-name" id="device-name">This computer</p>
      <p id="location" class="muted">No location label</p>
      <p id="connection-copy" class="connection-copy">Connect this Mac to the same Norns account you use on the website.</p>
      <dl>
        <dt>Account connection</dt><dd id="enrollment">Checking…</dd>
        <dt>Availability</dt><dd id="availability">Checking…</dd>
        <dt>Compatibility</dt><dd id="compatibility">Checking…</dd>
        <dt>Workload</dt><dd id="workload">Checking…</dd>
        <dt>Start at login</dt><dd id="start-at-login">Checking…</dd>
        <dt>Agent version</dt><dd id="agent-version">Checking…</dd>
      </dl>
      <p id="recent-activity" class="muted">No recent local Norns activity.</p>
      <div class="actions">
        <button id="prepare" type="button">Connect this Mac</button>
        <a id="verification-uri" class="button-link" rel="noreferrer noopener" target="_blank" hidden>Continue in browser</a>
      </div>
      <section class="emergency-control" aria-labelledby="emergency-heading">
        <h3 id="emergency-heading">Emergency stop</h3>
        <p>Stops every process currently managed by Norns on this OS-user installation, fences publication, and preserves recovery worktrees. The Control Center stays open.</p>
        <label for="emergency-confirmation">Type <code>STOP ALL NORNS WORK</code> to confirm</label>
        <input id="emergency-confirmation" type="text" autocomplete="off" spellcheck="false">
        <button id="emergency-stop" class="danger" type="button">Emergency stop all Norns work</button>
        <p id="emergency-result" class="muted">No local emergency stop has been requested.</p>
      </section>
    </section>

    <section id="security" role="tabpanel" aria-labelledby="tab-security" tabindex="0" hidden>
      <h2 id="security-heading">Security</h2>
      <dl>
        <dt>Enrolled account</dt><dd id="account">Not enrolled</dd>
        <dt>Device fingerprint</dt><dd><code id="fingerprint">Not prepared</code></dd>
        <dt>Repository access</dt><dd id="repository-access">No repository access is configured.</dd>
      </dl>
      <h3>Authorization notices</h3>
      <ul id="authorization-notices"><li>None</li></ul>
      <p class="boundary">This Control Center protects against malicious websites and other OS users. It cannot protect against a compromised process running as this same OS user.</p>
    </section>

    <section id="repositories" role="tabpanel" aria-labelledby="tab-repositories" tabindex="0" hidden>
      <h2 id="repositories-heading">Repositories</h2>
      <p>Choose a Git repository on this computer to give Norns access. Its local path stays in this Control Center.</p>
      <div class="actions">
        <button id="choose-repository" type="button">Choose repository</button>
      </div>
      <ul id="repository-list" class="repository-list"><li>No repositories approved.</li></ul>
      <h3>Local access history</h3>
      <ul id="repository-history"><li>No repository access changes recorded.</li></ul>
      <p class="muted">Removing access never deletes or changes the repository or its files.</p>
    </section>

    <section id="diagnostics" role="tabpanel" aria-labelledby="tab-diagnostics" tabindex="0" hidden>
      <h2 id="diagnostics-heading">Diagnostics</h2>
      <dl>
        <dt>Server connectivity</dt><dd id="connectivity">Checking…</dd>
        <dt>Work service</dt><dd id="daemon">Checking…</dd>
        <dt>Protocol</dt><dd id="protocol-version">Checking…</dd>
        <dt>Capabilities</dt><dd id="capabilities">Checking…</dd>
        <dt>Git</dt><dd id="git-version">Not detected</dd>
        <dt>Runtimes</dt><dd id="runtimes">Not detected</dd>
      </dl>
      <h3>Updates</h3>
      <p id="update-guidance"></p>
      <p class="muted">Uninstalling the package and revoking this computer on the server are separate actions.</p>
      <div class="actions">
        <button id="restart" type="button">Restart daemon</button>
        <a class="button-link" href="/api/diagnostics/support" download="norns-agent-support.json">Download redacted support bundle</a>
      </div>
    </section>
  </main>
</body>
</html>
`;

const CONTROL_CENTER_CSS = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;background:Canvas;color:CanvasText}
header,nav,main{width:min(48rem,calc(100% - 2rem));margin-inline:auto}
header{padding-top:2rem}nav{display:flex;gap:.5rem;margin-block:1.25rem}
main{padding:1.5rem;border:1px solid GrayText;border-radius:1rem;margin-bottom:2rem}
.eyebrow{font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.device-name{font-size:1.25rem;font-weight:700}.muted{color:GrayText}
.connection-copy{max-width:40rem;font-size:1.05rem}
dl{display:grid;grid-template-columns:minmax(9rem,max-content) 1fr;gap:.65rem 1rem}
dt{font-weight:700}.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
button,.button-link{font:inherit;padding:.65rem .9rem;border:1px solid ButtonText;background:ButtonFace;color:ButtonText;border-radius:.4rem}
.button-link{text-decoration:none}button:focus-visible,.button-link:focus-visible{outline:3px solid Highlight;outline-offset:2px}
.tab[aria-selected="true"]{background:Highlight;color:HighlightText}
.boundary{padding:1rem;border-left:.3rem solid GrayText}
.repository-list{display:grid;gap:1rem;padding:0;list-style:none}.repository-list>li{padding:1rem;border:1px solid GrayText;border-radius:.6rem}
.repository-list p{margin:.25rem 0}.repository-path{overflow-wrap:anywhere}
.emergency-control{margin-top:1.5rem;padding:1rem;border:2px solid GrayText;border-radius:.6rem}
.emergency-control label{display:block;font-weight:700}.emergency-control input{display:block;width:min(100%,24rem);font:inherit;margin:.5rem 0;padding:.6rem}
.danger{border-width:2px}
code{overflow-wrap:anywhere}
@media(max-width:34rem){dl{grid-template-columns:1fr;gap:.2rem}dd{margin:0 0 .8rem}nav{overflow-x:auto}}
@media(forced-colors:active){main,.boundary,button,.button-link{forced-color-adjust:auto}.tab[aria-selected="true"]{border-width:3px}}
`;

const CONTROL_CENTER_JAVASCRIPT = `(() => {
  let csrf = null;
  const message = document.querySelector("#message");
  const enrollment = document.querySelector("#enrollment");
  const daemon = document.querySelector("#daemon");
  const text = (selector, value) => {
    document.querySelector(selector).textContent = value == null || value === "" ? "Not available" : String(value);
  };
  const enrollmentLabels = {
    not_enrolled: "Not connected",
    credential_prepared: "Ready to connect",
    pending: "Waiting for approval",
    approved_pending_redemption: "Finishing connection",
    active: "Connected",
    denied: "Approval declined",
    expired: "Approval expired",
  };

  function approvalUrl(enrollmentStatus) {
    if (!enrollmentStatus.verification_uri || !enrollmentStatus.user_code) return null;
    const url = new URL(enrollmentStatus.verification_uri);
    url.hash = new URLSearchParams({ code: enrollmentStatus.user_code }).toString();
    return url.toString();
  }

  async function request(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (csrf) headers["x-norns-agent-csrf"] = csrf;
    const response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Local Agent request failed");
    return body;
  }

  function render(status) {
    enrollment.textContent = enrollmentLabels[status.enrollment_state] || status.enrollment_state;
    const verificationLink = document.querySelector("#verification-uri");
    const completeApprovalUrl = approvalUrl(status.enrollment);
    if (completeApprovalUrl) {
      verificationLink.href = completeApprovalUrl;
      verificationLink.hidden = false;
    } else {
      verificationLink.removeAttribute("href");
      verificationLink.hidden = true;
    }
    const connectButton = document.querySelector("#prepare");
    connectButton.hidden = status.enrollment_state === "active";
    connectButton.textContent =
      status.enrollment_state === "pending" ||
      status.enrollment_state === "approved_pending_redemption"
        ? "Open approval page"
        : status.enrollment_state === "denied" || status.enrollment_state === "expired"
          ? "Try connecting again"
          : "Connect this Mac";
    daemon.textContent = status.daemon_state;
    text("#device-name", status.home.device_name);
    text("#location", status.home.location_label || "No location label");
    text("#availability", status.home.availability);
    text("#compatibility", status.home.compatibility);
    text("#workload", status.home.workload);
    text("#start-at-login", status.home.start_at_login ? "Enabled" : "Not configured");
    text("#agent-version", status.home.agent_version);
    text("#recent-activity", status.home.recent_activity || "No recent local Norns activity.");
    if (status.home.emergency_stop) {
      const result = status.home.emergency_stop;
      text("#emergency-result",
        "Last emergency stop: " + result.requested_at + " · " +
        result.stop_requested + " stop requested · " +
        result.process_trees_reaped + " process trees exited · " +
        result.unconfirmed + " unconfirmed");
    }
    text("#account", status.security.enrolled_account || "Not enrolled");
    text("#fingerprint", status.security.public_key_fingerprint || "Not prepared");
    text("#repository-access", status.security.repository_access_summary);
    const notices = document.querySelector("#authorization-notices");
    notices.replaceChildren(...(status.security.failed_authorization_notices.length
      ? status.security.failed_authorization_notices
      : ["None"]).map((notice) => {
        const item = document.createElement("li");
        item.textContent = notice;
        return item;
      }));
    text("#connectivity", status.diagnostics.connectivity);
    text("#protocol-version", status.diagnostics.protocol_version);
    text("#capabilities", status.diagnostics.capabilities.join(", ") || "None reported");
    text("#git-version", status.diagnostics.git_version || "Not detected");
    text("#runtimes", status.diagnostics.runtimes.join(", ") || "Not detected");
    text("#update-guidance", status.diagnostics.manual_update_guidance);
    const connectionCopy = document.querySelector("#connection-copy");
    if (status.enrollment_state === "active") {
      connectionCopy.textContent = "This Mac is connected to your Norns account.";
      message.textContent = "Connected. You can return to The Norns.";
    } else if (
      status.enrollment_state === "pending" ||
      status.enrollment_state === "approved_pending_redemption"
    ) {
      connectionCopy.textContent = "Approve this Mac in the Norns browser page to finish connecting.";
      message.textContent = "Waiting for approval in your browser.";
    } else {
      connectionCopy.textContent = "Connect this Mac to the same Norns account you use on the website.";
      message.textContent = "The Local Agent is ready to connect.";
    }
  }

  function renderRepositories(result) {
    const list = document.querySelector("#repository-list");
    const repositories = Array.isArray(result.repositories) ? result.repositories : [];
    if (repositories.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No repositories approved.";
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...repositories.map((repository) => {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = repository.repository_display_name;
        const path = document.createElement("p");
        path.className = "repository-path";
        path.textContent = repository.local_path;
        const details = document.createElement("p");
        details.className = "muted";
        details.textContent = repository.default_branch + " · " + repository.git_status + " · " +
          (repository.sync_state === "active" ? "registered" : "registration pending");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove Norns access";
        remove.setAttribute("aria-label", "Remove Norns access to " + repository.repository_display_name);
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            const result = await request("/api/repositories/remove", {
              method: "POST",
              body: JSON.stringify({
                workspace_id: repository.workspace_id,
                repository_id: repository.repository_id,
              }),
            });
            message.textContent = result.server_sync === "complete"
              ? "Norns access was removed. Local files were not changed."
              : "Local access was removed. Server revocation will retry when connected.";
            await refreshRepositories();
            await refresh();
          } catch (error) {
            message.textContent = error.message;
            remove.disabled = false;
          }
        });
        item.append(name, path, details, remove);
        return item;
      }));
    }

    const history = document.querySelector("#repository-history");
    const entries = Array.isArray(result.history) ? result.history : [];
    history.replaceChildren(...(entries.length ? entries : [{
      action: "none",
      repository_display_name: "No repository access changes recorded.",
      occurred_at: "",
      server_sync: "complete",
    }]).map((entry) => {
      const item = document.createElement("li");
      if (entry.action === "none") {
        item.textContent = entry.repository_display_name;
      } else {
        item.textContent = entry.repository_display_name + " · " + entry.action + " · " +
          entry.occurred_at + (entry.server_sync === "pending" ? " · server sync pending" : "");
      }
      return item;
    }));
  }

  async function refresh() {
    render(await request("/api/status", { method: "GET", headers: {} }));
  }

  async function refreshRepositories() {
    renderRepositories(await request("/api/repositories", { method: "GET", headers: {} }));
  }

  async function bootstrap() {
    const token = new URLSearchParams(location.hash.slice(1)).get("bootstrap");
    if (token) {
      const result = await request("/api/session/bootstrap", {
        method: "POST",
        body: JSON.stringify({ bootstrap_token: token }),
      });
      csrf = result.csrf_token;
      history.replaceState(null, "", "/");
    } else {
      const result = await request("/api/session", { method: "GET", headers: {} });
      csrf = result.csrf_token;
    }
    await Promise.all([refresh(), refreshRepositories()]);
    setInterval(() => {
      refresh().catch(() => {});
    }, 2000);
  }

  document.querySelector("#prepare").addEventListener("click", async () => {
    const button = document.querySelector("#prepare");
    const approvalWindow = window.open("about:blank", "norns-device-approval");
    if (approvalWindow) {
      approvalWindow.document.title = "Connecting Norns Local Agent";
      approvalWindow.document.body.textContent = "Opening The Norns…";
    }
    button.disabled = true;
    try {
      const result = await request("/api/enrollment/start", { method: "POST", body: "{}" });
      const target = approvalUrl({
        verification_uri: result.verification_uri,
        user_code: result.user_code,
      });
      if (target && approvalWindow) {
        approvalWindow.opener = null;
        approvalWindow.location.replace(target);
      } else if (target) {
        window.open(target, "_blank", "noopener,noreferrer");
      } else if (approvalWindow) {
        approvalWindow.close();
      }
      await refresh();
      message.textContent = target
        ? "Approve this Mac in the Norns page that just opened."
        : "This Mac is already connected.";
    } catch (error) {
      if (approvalWindow) approvalWindow.close();
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#restart").addEventListener("click", async () => {
    await request("/api/daemon/restart", { method: "POST", body: "{}" });
    await refresh();
  });
  document.querySelector("#emergency-stop").addEventListener("click", async () => {
    const button = document.querySelector("#emergency-stop");
    const confirmation = document.querySelector("#emergency-confirmation");
    button.disabled = true;
    try {
      const result = await request("/api/emergency-stop", {
        method: "POST",
        body: JSON.stringify({ confirmation: confirmation.value }),
      });
      confirmation.value = "";
      text("#emergency-result",
        "Emergency stop: " + result.emergency_stop.stop_requested +
        " stop requested · " + result.emergency_stop.process_trees_reaped +
        " process trees exited · " + result.emergency_stop.unconfirmed + " unconfirmed");
      message.textContent = result.emergency_stop.unconfirmed === 0
        ? "All registered Norns-managed process trees stopped. Recovery worktrees were preserved."
        : "Emergency stop was requested, but some process trees remain unconfirmed.";
      await refresh();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#choose-repository").addEventListener("click", async () => {
    const button = document.querySelector("#choose-repository");
    button.disabled = true;
    message.textContent = "Choose a Git repository in the system folder picker.";
    try {
      const result = await request("/api/repositories/choose", {
        method: "POST",
        body: "{}",
      });
      message.textContent = result.cancelled
        ? "Repository selection was cancelled."
        : result.repository.sync_state === "active"
          ? "Repository access approved and registered."
          : "Repository access approved locally; server registration is pending.";
      await refreshRepositories();
      await refresh();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(tab, moveFocus) {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      document.querySelector("#" + candidate.dataset.panel).hidden = !selected;
    }
    if (moveFocus) tab.focus();
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab, false));
    tab.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(tab);
      const target = event.key === "ArrowRight"
        ? tabs[(current + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(current - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[tabs.length - 1]
              : null;
      if (target) {
        event.preventDefault();
        selectTab(target, true);
      }
    });
  }

  bootstrap().catch((error) => {
    message.textContent = error.message;
    enrollment.textContent = "Unavailable";
    daemon.textContent = "Unavailable";
  });
})();
`;

export type AgentHostLoopbackAddress = "127.0.0.1" | "::1";
export type AgentDaemonState = "stopped" | "starting" | "running" | "stopping" | "failed";
export type AgentAvailabilityState = "online" | "connecting" | "offline";
export type AgentCompatibilityState = "ready" | "limited" | "update_required";
export type AgentWorkloadState = "idle" | "busy";
export type AgentEnrollmentState =
  | "not_enrolled"
  | "credential_prepared"
  | "pending"
  | "approved_pending_redemption"
  | "active"
  | "denied"
  | "expired";

export interface AgentHostLocalState {
  device_name: string;
  location_label: string | null;
  enrolled_account: string | null;
  availability: AgentAvailabilityState;
  compatibility: AgentCompatibilityState;
  workload: AgentWorkloadState;
  agent_version: string;
  protocol_version: string;
  capabilities: string[];
  start_at_login: boolean;
  recent_activity: string | null;
  repository_access_summary: string;
  failed_authorization_notices: string[];
  connectivity: "connected" | "connecting" | "disconnected";
  git_version: string | null;
  runtimes: string[];
}

export interface AgentDaemonLifecycle {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  emergencyStop?(): Promise<AgentEmergencyStopResult>;
}

export interface AgentEmergencyStopResult {
  stop_requested: number;
  process_trees_reaped: number;
  unconfirmed: number;
}

export interface AgentHostSingleInstanceLock {
  acquire(): void;
  release(): void;
}

export interface AgentHostPortRecord {
  version: 1;
  host: AgentHostLoopbackAddress;
  port: number;
  origin: string;
  native_launch_secret: string;
}

export interface AgentHostPortDiscovery {
  publish(record: AgentHostPortRecord): void;
  clear(): void;
}

export interface AgentHostStartResult {
  version: 1;
  host: AgentHostLoopbackAddress;
  port: number;
  origin: string;
  bootstrap_url: string;
}

export interface AgentHostOptions {
  dataDir: string;
  daemon: AgentDaemonLifecycle;
  host?: AgentHostLoopbackAddress;
  port?: number;
  bootstrapTokenTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
  lock?: AgentHostSingleInstanceLock;
  portDiscovery?: AgentHostPortDiscovery;
  credentialStore?: PendingDeviceCredentialStore;
  enrollment?: DeviceEnrollmentCoordinator;
  repositoryAccess?: LocalRepositoryAccessController;
  localState?: Partial<AgentHostLocalState>;
  detectLocalTools?: boolean;
  /** Persistent installed mode starts the owned daemon with the loopback host. */
  startDaemonOnHostStart?: boolean;
}

function commandVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 1_500,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const firstLine = [...(result.stdout.split(/\r?\n/, 1)[0] ?? "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return firstLine ? firstLine.slice(0, 200) : null;
}

function detectLocalTools(): Pick<AgentHostLocalState, "git_version" | "runtimes"> {
  const runtimes = [
    ["Codex", commandVersion("codex")],
    ["Claude Code", commandVersion("claude")],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([name, version]) => `${name} · ${version}`);
  return {
    git_version: commandVersion("git"),
    runtimes,
  };
}

function defaultLocalState(): AgentHostLocalState {
  return {
    device_name: "This computer",
    location_label: null,
    enrolled_account: null,
    availability: "offline",
    compatibility: "limited",
    workload: "idle",
    agent_version: AGENT_HOST_VERSION,
    protocol_version: "Not negotiated",
    capabilities: [],
    start_at_login: false,
    recent_activity: null,
    repository_access_summary: "No repository access is configured.",
    failed_authorization_notices: [],
    connectivity: "disconnected",
    git_version: null,
    runtimes: [],
  };
}

interface BoundAgentHost {
  version: 1;
  host: AgentHostLoopbackAddress;
  port: number;
  origin: string;
  expectedHostHeader: string;
  nativeLaunchSecret: string;
}

interface BootstrapGrant {
  digest: Buffer;
  expiresAt: number;
}

interface LocalSession {
  csrfToken: string;
  csrfDigest: Buffer;
  expiresAt: number;
}

class AgentHostHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AgentHostAlreadyRunningError extends Error {
  constructor() {
    super("Norns Local Agent is already running for this OS user");
  }
}

function ensurePrivateDirectory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretMatches(candidate: string, expected: Buffer): boolean {
  const actual = sha256(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function nativeLaunchKey(secret: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("native launch secret is malformed");
  }
  const key = Buffer.from(secret, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== secret) {
    throw new Error("native launch secret is malformed");
  }
  return key;
}

function nativeLaunchTranscript(
  purpose: string,
  fields: readonly (readonly [name: string, value: string])[],
): string {
  let transcript = `${purpose}\n`;
  for (const [name, value] of fields) {
    transcript += `${name}:${Buffer.byteLength(value, "utf8")}:${value}\n`;
  }
  return transcript;
}

export function createAgentHostNativeLaunchRequestProof(input: {
  native_launch_secret: string;
  origin: string;
  request_id: string;
}): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.request_id)) {
    throw new Error("native launch request ID is malformed");
  }
  return createHmac("sha256", nativeLaunchKey(input.native_launch_secret))
    .update(
      nativeLaunchTranscript(NATIVE_LAUNCH_REQUEST_PURPOSE, [
        ["origin", input.origin],
        ["request_id", input.request_id],
      ]),
      "utf8",
    )
    .digest("base64url");
}

export function createAgentHostNativeLaunchResponseProof(input: {
  native_launch_secret: string;
  origin: string;
  request_id: string;
  bootstrap_url: string;
}): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.request_id)) {
    throw new Error("native launch request ID is malformed");
  }
  return createHmac("sha256", nativeLaunchKey(input.native_launch_secret))
    .update(
      nativeLaunchTranscript(NATIVE_LAUNCH_RESPONSE_PURPOSE, [
        ["origin", input.origin],
        ["request_id", input.request_id],
        ["bootstrap_url", input.bootstrap_url],
      ]),
      "utf8",
    )
    .digest("base64url");
}

function proofMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(candidate)) return false;
  const actualBytes = Buffer.from(candidate, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actualBytes.toString("base64url") === candidate &&
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function loopbackOrigin(host: AgentHostLoopbackAddress, port: number): string {
  return `http://${host === "::1" ? `[${host}]` : host}:${port}`;
}

function expectedHostHeader(host: AgentHostLoopbackAddress, port: number): string {
  return `${host === "::1" ? `[${host}]` : host}:${port}`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() === name) {
      return entry.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new AgentHostHttpError(415, "application/json is required");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new AgentHostHttpError(413, "request body is too large");
    }
    chunks.push(bytes);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AgentHostHttpError(400, "request body must be a JSON object");
  }
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body).toString(),
    ...extraHeaders,
  });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body), extraHeaders);
}

export class FileAgentHostSingleInstanceLock implements AgentHostSingleInstanceLock {
  private descriptor: number | null = null;
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, AGENT_HOST_LOCK_FILENAME);
  }

  acquire(): void {
    if (this.descriptor !== null) throw new AgentHostAlreadyRunningError();
    ensurePrivateDirectory(this.dataDir);
    this.recoverStaleLock();
    try {
      this.descriptor = openSync(this.filePath, "wx", 0o600);
      writeFileSync(this.descriptor, `${process.pid}\n`, "utf8");
      fsyncSync(this.descriptor);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (this.descriptor !== null) {
        closeSync(this.descriptor);
        this.descriptor = null;
        try {
          unlinkSync(this.filePath);
        } catch {
          // Preserve the original lock persistence error.
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AgentHostAlreadyRunningError();
      }
      throw error;
    }
  }

  private recoverStaleLock(): void {
    if (!existsSync(this.filePath)) return;
    let raw: string;
    try {
      const stat = statSync(this.filePath);
      if (
        typeof process.getuid === "function" &&
        typeof stat.uid === "number" &&
        stat.uid !== process.getuid()
      ) {
        throw new AgentHostAlreadyRunningError();
      }
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!/^[1-9][0-9]*\n$/.test(raw)) {
      throw new AgentHostAlreadyRunningError();
    }
    const ownerPid = Number(raw.trim());
    if (!Number.isSafeInteger(ownerPid)) throw new AgentHostAlreadyRunningError();
    try {
      process.kill(ownerPid, 0);
      // A live PID is never deleted, even if PID reuse means it is no longer
      // AgentHost. Failing closed is safer than breaking another live owner.
      throw new AgentHostAlreadyRunningError();
    } catch (error) {
      if (error instanceof AgentHostAlreadyRunningError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw new AgentHostAlreadyRunningError();
    }
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  release(): void {
    if (this.descriptor === null) return;
    closeSync(this.descriptor);
    this.descriptor = null;
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class FileAgentHostPortDiscovery implements AgentHostPortDiscovery {
  readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, AGENT_HOST_PORT_FILENAME);
  }

  publish(record: AgentHostPortRecord): void {
    ensurePrivateDirectory(this.dataDir);
    writeFileSync(this.filePath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    chmodSync(this.filePath, 0o600);
  }

  read(): AgentHostPortRecord | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AgentHostPortRecord>;
    if (
      parsed.version !== 1 ||
      !LOOPBACK_HOSTS.has(parsed.host as AgentHostLoopbackAddress) ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65_535 ||
      parsed.origin !== loopbackOrigin(parsed.host as AgentHostLoopbackAddress, parsed.port) ||
      typeof parsed.native_launch_secret !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.native_launch_secret)
    ) {
      throw new Error("AgentHost port discovery file is malformed");
    }
    return {
      version: 1,
      host: parsed.host as AgentHostLoopbackAddress,
      port: parsed.port,
      origin: parsed.origin,
      native_launch_secret: parsed.native_launch_secret,
    };
  }

  clear(): void {
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class AgentHost {
  private readonly host: AgentHostLoopbackAddress;
  private readonly port: number;
  private readonly bootstrapTokenTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly lock: AgentHostSingleInstanceLock;
  private readonly portDiscovery: AgentHostPortDiscovery;
  private readonly credentialStore: PendingDeviceCredentialStore | null;
  private readonly repositoryAccess: LocalRepositoryAccessController;
  private readonly enrollmentCoordinator: DeviceEnrollmentCoordinator | null;
  private readonly localState: AgentHostLocalState;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly consumedNativeLaunchRequestIds = new Set<string>();
  private server: Server | null = null;
  private bound: BoundAgentHost | null = null;
  private bootstrapGrant: BootstrapGrant | null = null;
  private daemonState: AgentDaemonState = "stopped";
  private enrollmentState: AgentEnrollmentState;
  private daemonTransition: Promise<void> = Promise.resolve();
  private lastEmergencyStop: (AgentEmergencyStopResult & { requested_at: string }) | null = null;
  private shuttingDown = false;
  private unsubscribeEnrollment: (() => void) | null = null;

  constructor(private readonly options: AgentHostOptions) {
    this.host = options.host ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(this.host))
      throw new Error("AgentHost must use an IP-literal loopback");
    this.port = options.port ?? 0;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error("AgentHost port must be an integer from 0 through 65535");
    }
    this.bootstrapTokenTtlMs = options.bootstrapTokenTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    if (this.bootstrapTokenTtlMs <= 0 || this.sessionTtlMs <= 0) {
      throw new Error("AgentHost token lifetimes must be positive");
    }
    this.now = options.now ?? Date.now;
    this.lock = options.lock ?? new FileAgentHostSingleInstanceLock(options.dataDir);
    this.portDiscovery = options.portDiscovery ?? new FileAgentHostPortDiscovery(options.dataDir);
    this.credentialStore = options.credentialStore ?? null;
    this.enrollmentCoordinator = options.enrollment ?? null;
    this.repositoryAccess =
      options.repositoryAccess ??
      new LocalRepositoryAccessController(options.dataDir, new WorkspaceRegistry(options.dataDir));
    const defaults = defaultLocalState();
    const detected = options.detectLocalTools === false ? {} : detectLocalTools();
    this.localState = {
      ...defaults,
      ...detected,
      ...options.localState,
      capabilities: [...(options.localState?.capabilities ?? defaults.capabilities)],
      failed_authorization_notices: [
        ...(options.localState?.failed_authorization_notices ??
          defaults.failed_authorization_notices),
      ],
      runtimes: [...(options.localState?.runtimes ?? defaults.runtimes)],
    };
    this.enrollmentState =
      this.enrollmentCoordinator?.status.state ??
      (this.credentialStore?.exists() ? "credential_prepared" : "not_enrolled");
  }

  get localPort(): number | null {
    return this.bound?.port ?? null;
  }

  get localOrigin(): string | null {
    return this.bound?.origin ?? null;
  }

  get enrollment(): AgentEnrollmentState {
    return this.enrollmentState;
  }

  get daemon(): AgentDaemonState {
    return this.daemonState;
  }

  setEnrollmentState(state: AgentEnrollmentState): void {
    this.enrollmentState = state;
  }

  async start(): Promise<AgentHostStartResult> {
    if (this.server) throw new Error("AgentHost has already started");
    this.shuttingDown = false;
    this.lock.acquire();
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, this.host);
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("AgentHost did not receive a TCP port");
      }
      const port = (address as AddressInfo).port;
      const origin = loopbackOrigin(this.host, port);
      const nativeLaunchSecret = randomBytes(32).toString("base64url");
      this.consumedNativeLaunchRequestIds.clear();
      this.bound = {
        version: 1,
        host: this.host,
        port,
        origin,
        expectedHostHeader: expectedHostHeader(this.host, port),
        nativeLaunchSecret,
      };
      this.portDiscovery.publish({
        ...this.publicRecord(),
        native_launch_secret: nativeLaunchSecret,
      });
      void this.repositoryAccess.synchronize().catch(() => {
        this.localState.failed_authorization_notices.push(
          "Repository access reconciliation could not start safely.",
        );
      });
      this.enrollmentCoordinator?.start();
      this.unsubscribeEnrollment =
        this.enrollmentCoordinator?.subscribe((status) => {
          this.enrollmentState = status.state;
          if (status.state === "active") {
            void this.repositoryAccess.synchronize().catch(() => {
              this.localState.failed_authorization_notices.push(
                "Repository access reconciliation could not start safely.",
              );
            });
          }
          if (
            status.state === "active" &&
            this.options.startDaemonOnHostStart === true &&
            this.daemonState !== "running" &&
            this.daemonState !== "starting"
          ) {
            void this.transitionDaemon("start").catch(() => {
              // The status endpoint exposes the failed daemon state without
              // leaking enrollment or credential material.
            });
          }
        }) ?? null;
      if (
        this.options.startDaemonOnHostStart === true &&
        (!this.enrollmentCoordinator || this.enrollmentCoordinator.status.state === "active")
      ) {
        await this.transitionDaemon("start");
      }
      return { ...this.publicRecord(), bootstrap_url: this.issueBootstrapUrl() };
    } catch (error) {
      this.server = null;
      this.bound = null;
      this.unsubscribeEnrollment?.();
      this.unsubscribeEnrollment = null;
      this.enrollmentCoordinator?.stop();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      try {
        this.portDiscovery.clear();
      } finally {
        this.lock.release();
      }
      throw error;
    }
  }

  issueBootstrapUrl(): string {
    const bound = this.requireBound();
    const token = randomBytes(32).toString("base64url");
    this.bootstrapGrant = {
      digest: sha256(token),
      expiresAt: this.now() + this.bootstrapTokenTtlMs,
    };
    return `${bound.origin}/#bootstrap=${encodeURIComponent(token)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.shuttingDown = true;
    const closeServer = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    try {
      if (this.daemonState !== "stopped") {
        await this.transitionDaemon("stop");
      }
    } finally {
      try {
        await closeServer;
      } finally {
        this.unsubscribeEnrollment?.();
        this.unsubscribeEnrollment = null;
        this.enrollmentCoordinator?.stop();
        this.server = null;
        this.bound = null;
        this.bootstrapGrant = null;
        this.sessions.clear();
        this.consumedNativeLaunchRequestIds.clear();
        try {
          this.portDiscovery.clear();
        } finally {
          this.lock.release();
        }
      }
    }
  }

  private publicRecord(): Omit<AgentHostPortRecord, "native_launch_secret"> {
    const bound = this.requireBound();
    return {
      version: 1,
      host: bound.host,
      port: bound.port,
      origin: bound.origin,
    };
  }

  private requireBound(): BoundAgentHost {
    if (!this.bound) throw new Error("AgentHost has not started");
    return this.bound;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.shuttingDown) {
        throw new AgentHostHttpError(503, "AgentHost is shutting down");
      }
      const bound = this.requireBound();
      if (request.headers.host !== bound.expectedHostHeader) {
        throw new AgentHostHttpError(403, "invalid loopback Host");
      }

      const requestOrigin = request.headers.origin;
      if (
        Array.isArray(requestOrigin) ||
        (requestOrigin !== undefined && requestOrigin !== bound.origin)
      ) {
        throw new AgentHostHttpError(403, "invalid loopback Origin");
      }
      if (request.method === "POST" && requestOrigin !== bound.origin) {
        throw new AgentHostHttpError(403, "exact loopback Origin is required");
      }

      const url = new URL(request.url ?? "/", bound.origin);
      if (url.search.length > 0) {
        throw new AgentHostHttpError(400, "query parameters are not accepted");
      }

      if (request.method === "GET") {
        await this.handleGet(url.pathname, request, response);
        return;
      }
      if (request.method === "POST") {
        await this.handlePost(url.pathname, request, response);
        return;
      }
      throw new AgentHostHttpError(405, "method not allowed");
    } catch (error) {
      const status = error instanceof AgentHostHttpError ? error.status : 500;
      const message =
        error instanceof AgentHostHttpError ? error.message : "local AgentHost request failed";
      if (!response.headersSent) sendJson(response, status, { error: message });
      else response.destroy();
    }
  }

  private async handleGet(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    switch (path) {
      case "/":
        send(response, 200, "text/html; charset=utf-8", CONTROL_CENTER_HTML);
        return;
      case "/agent-host.css":
        send(response, 200, "text/css; charset=utf-8", CONTROL_CENTER_CSS);
        return;
      case "/agent-host.js":
        send(response, 200, "text/javascript; charset=utf-8", CONTROL_CENTER_JAVASCRIPT);
        return;
      case "/api/status":
        this.requireSession(request);
        sendJson(response, 200, this.statusBody());
        return;
      case "/api/repositories":
        this.requireSession(request);
        sendJson(response, 200, {
          repositories: [...this.repositoryAccess.list()],
          history: [...this.repositoryAccess.history()],
        });
        return;
      case "/api/session": {
        const session = this.requireSession(request);
        sendJson(response, 200, { csrf_token: session.csrfToken });
        return;
      }
      case "/api/diagnostics/support":
        this.requireSession(request);
        sendJson(response, 200, this.supportBundleBody(), {
          "content-disposition": 'attachment; filename="norns-agent-support.json"',
        });
        return;
      case "/api/session/bootstrap":
      case "/api/session/native-launch":
      case "/api/enrollment/prepare":
      case "/api/enrollment/start":
      case "/api/daemon/start":
      case "/api/daemon/stop":
      case "/api/daemon/restart":
      case "/api/emergency-stop":
      case "/api/repositories/choose":
      case "/api/repositories/remove":
        throw new AgentHostHttpError(405, "method not allowed");
      default:
        throw new AgentHostHttpError(404, "not found");
    }
  }

  private async handlePost(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (path === "/api/session/native-launch") {
      const body = await readJsonBody(request);
      const requestId = body.request_id;
      const requestProof = body.request_proof;
      const bound = this.requireBound();
      if (
        typeof requestId !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(requestId) ||
        !proofMatches(
          requestProof,
          createAgentHostNativeLaunchRequestProof({
            native_launch_secret: bound.nativeLaunchSecret,
            origin: bound.origin,
            request_id: requestId,
          }),
        )
      ) {
        throw new AgentHostHttpError(401, "invalid native launch credential");
      }
      if (this.consumedNativeLaunchRequestIds.has(requestId)) {
        throw new AgentHostHttpError(409, "native launch request was already consumed");
      }
      if (this.consumedNativeLaunchRequestIds.size >= MAX_NATIVE_LAUNCH_REQUEST_IDS) {
        throw new AgentHostHttpError(503, "native launch request capacity is exhausted");
      }
      this.consumedNativeLaunchRequestIds.add(requestId);
      const bootstrapUrl = this.issueBootstrapUrl();
      sendJson(response, 200, {
        bootstrap_url: bootstrapUrl,
        response_proof: createAgentHostNativeLaunchResponseProof({
          native_launch_secret: bound.nativeLaunchSecret,
          origin: bound.origin,
          request_id: requestId,
          bootstrap_url: bootstrapUrl,
        }),
      });
      return;
    }

    if (path === "/api/session/bootstrap") {
      const body = await readJsonBody(request);
      const token = body.bootstrap_token;
      if (typeof token !== "string") {
        throw new AgentHostHttpError(400, "bootstrap_token is required");
      }
      const grant = this.bootstrapGrant;
      if (!grant || !secretMatches(token, grant.digest)) {
        throw new AgentHostHttpError(401, "invalid or consumed bootstrap token");
      }
      if (this.now() >= grant.expiresAt) {
        this.bootstrapGrant = null;
        throw new AgentHostHttpError(410, "bootstrap token expired");
      }
      this.bootstrapGrant = null;

      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const sessionKey = sha256(sessionToken).toString("hex");
      this.sessions.set(sessionKey, {
        csrfToken,
        csrfDigest: sha256(csrfToken),
        expiresAt: this.now() + this.sessionTtlMs,
      });
      const maxAge = Math.max(1, Math.floor(this.sessionTtlMs / 1000));
      sendJson(
        response,
        200,
        { csrf_token: csrfToken },
        {
          "set-cookie": `${AGENT_HOST_SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        },
      );
      return;
    }

    const session = this.requireSession(request);
    const csrfToken = request.headers[AGENT_HOST_CSRF_HEADER];
    if (typeof csrfToken !== "string" || !secretMatches(csrfToken, session.csrfDigest)) {
      throw new AgentHostHttpError(403, "valid CSRF token is required");
    }
    const body = await readJsonBody(request);

    switch (path) {
      case "/api/enrollment/prepare": {
        if (!this.credentialStore) {
          throw new AgentHostHttpError(503, "device enrollment is disabled");
        }
        const prepared = this.credentialStore.prepare();
        this.enrollmentState = "credential_prepared";
        sendJson(response, 200, this.preparedCredentialBody(prepared));
        return;
      }
      case "/api/enrollment/start": {
        if (!this.enrollmentCoordinator) {
          throw new AgentHostHttpError(503, "device enrollment is disabled");
        }
        const status = await this.enrollmentCoordinator.begin({
          proposed_name: this.localState.device_name,
        });
        this.enrollmentState = status.state;
        sendJson(response, 202, this.enrollmentStatusBody(status));
        return;
      }
      case "/api/daemon/start":
        await this.transitionDaemon("start");
        sendJson(response, 200, this.statusBody());
        return;
      case "/api/daemon/stop":
        await this.transitionDaemon("stop");
        sendJson(response, 200, this.statusBody());
        return;
      case "/api/daemon/restart":
        await this.transitionDaemon("restart");
        sendJson(response, 200, this.statusBody());
        return;
      case "/api/emergency-stop": {
        if (body.confirmation !== EMERGENCY_STOP_CONFIRMATION) {
          throw new AgentHostHttpError(
            400,
            `confirmation must exactly match ${EMERGENCY_STOP_CONFIRMATION}`,
          );
        }
        const emergencyStop = this.options.daemon.emergencyStop;
        if (!emergencyStop) {
          throw new AgentHostHttpError(503, "managed-process emergency stop is unavailable");
        }
        const result = await this.emergencyStopDaemon(emergencyStop);
        sendJson(response, 200, { emergency_stop: result });
        return;
      }
      case "/api/repositories/choose": {
        const repository = await this.repositoryAccess.choose();
        sendJson(
          response,
          200,
          repository ? { cancelled: false, repository } : { cancelled: true },
        );
        return;
      }
      case "/api/repositories/remove": {
        if (typeof body.workspace_id !== "string" || typeof body.repository_id !== "string") {
          throw new AgentHostHttpError(400, "workspace_id and repository_id are required");
        }
        const removed = await this.repositoryAccess.remove({
          workspace_id: body.workspace_id,
          repository_id: body.repository_id,
        });
        if (!removed) throw new AgentHostHttpError(404, "repository access was not found");
        sendJson(response, removed.server_sync === "complete" ? 200 : 202, { ...removed });
        return;
      }
      default:
        throw new AgentHostHttpError(404, "not found");
    }
  }

  private requireSession(request: IncomingMessage): LocalSession {
    const token = cookieValue(request.headers.cookie, AGENT_HOST_SESSION_COOKIE);
    if (!token) throw new AgentHostHttpError(401, "local UI session is required");
    const key = sha256(token).toString("hex");
    const session = this.sessions.get(key);
    if (!session) throw new AgentHostHttpError(401, "local UI session is invalid");
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(key);
      throw new AgentHostHttpError(401, "local UI session expired");
    }
    return session;
  }

  private statusBody(): Record<string, unknown> {
    const prepared = this.credentialStore?.read() ?? null;
    const enrollment = this.enrollmentCoordinator?.status ?? {
      state: this.enrollmentState,
      user_code: null,
      verification_uri: null,
      expires_at: null,
      next_poll_at: null,
    };
    this.enrollmentState = enrollment.state;
    const repositoryCount = this.repositoryAccess.count();
    const availability: AgentAvailabilityState =
      this.daemonState === "running"
        ? this.localState.availability === "offline"
          ? "connecting"
          : this.localState.availability
        : "offline";
    const connectivity =
      this.daemonState === "running" && this.localState.connectivity === "disconnected"
        ? "connecting"
        : this.localState.connectivity;
    return {
      enrollment_state: this.enrollmentState,
      enrollment: {
        user_code: enrollment.user_code,
        verification_uri: enrollment.verification_uri,
        expires_at: enrollment.expires_at,
        next_poll_at: enrollment.next_poll_at,
      },
      daemon_state: this.daemonState,
      credential_prepared: prepared !== null,
      home: {
        device_name: this.localState.device_name,
        location_label: this.localState.location_label,
        availability,
        compatibility: this.localState.compatibility,
        workload: this.localState.workload,
        start_at_login: this.localState.start_at_login,
        agent_version: this.localState.agent_version,
        recent_activity: this.localState.recent_activity,
        emergency_stop: this.lastEmergencyStop ? { ...this.lastEmergencyStop } : null,
      },
      security: {
        enrolled_account: this.localState.enrolled_account,
        public_key_fingerprint: prepared?.public_key_fingerprint ?? null,
        repository_access_summary:
          repositoryCount === 0
            ? this.localState.repository_access_summary
            : `${repositoryCount} ${
                repositoryCount === 1 ? "repository" : "repositories"
              } approved for Norns.`,
        failed_authorization_notices: [...this.localState.failed_authorization_notices],
      },
      diagnostics: {
        connectivity,
        protocol_version: this.localState.protocol_version,
        capabilities: [...this.localState.capabilities],
        git_version: this.localState.git_version,
        runtimes: [...this.localState.runtimes],
        manual_update_guidance: MANUAL_UPDATE_GUIDANCE,
        automatic_updates_enabled: false,
      },
    };
  }

  private preparedCredentialBody(
    prepared: PendingDeviceCredentialSummary,
  ): Record<string, unknown> {
    return {
      enrollment_state: this.enrollmentState,
      algorithm: prepared.algorithm,
      public_key_fingerprint: prepared.public_key_fingerprint,
      created_at: prepared.created_at,
    };
  }

  private enrollmentStatusBody(status: PublicDeviceEnrollmentStatus): Record<string, unknown> {
    return {
      enrollment_state: status.state,
      user_code: status.user_code,
      verification_uri: status.verification_uri,
      expires_at: status.expires_at,
      next_poll_at: status.next_poll_at,
    };
  }

  private supportBundleBody(): Record<string, unknown> {
    const status = this.statusBody();
    const home = status.home as Record<string, unknown>;
    const diagnostics = status.diagnostics as Record<string, unknown>;
    return {
      format: "norns-agent-support-v1",
      generated_at: new Date(this.now()).toISOString(),
      enrollment_state: status.enrollment_state,
      daemon_state: status.daemon_state,
      availability: home.availability,
      compatibility: home.compatibility,
      workload: home.workload,
      agent_version: redactSupportValue(String(home.agent_version ?? "")),
      connectivity: diagnostics.connectivity,
      protocol_version: redactSupportValue(String(diagnostics.protocol_version ?? "")),
      capabilities: Array.isArray(diagnostics.capabilities)
        ? diagnostics.capabilities.map((value) => redactSupportValue(String(value)))
        : [],
      git_version:
        diagnostics.git_version === null || diagnostics.git_version === undefined
          ? null
          : redactSupportValue(String(diagnostics.git_version)),
      runtimes: Array.isArray(diagnostics.runtimes)
        ? diagnostics.runtimes.map((value) => redactSupportValue(String(value)))
        : [],
      failed_authorization_notice_count: this.localState.failed_authorization_notices.length,
      redaction: {
        includes_secrets: false,
        includes_credentials: false,
        includes_raw_paths: false,
        includes_hostname: false,
        includes_account_identity: false,
      },
    };
  }

  private transitionDaemon(action: "start" | "stop" | "restart"): Promise<void> {
    if (action !== "stop" && this.shuttingDown) {
      return Promise.reject(new AgentHostHttpError(503, "AgentHost is shutting down"));
    }
    const operation = this.daemonTransition.then(async () => {
      const startDaemon = async (): Promise<void> => {
        if (this.daemonState === "running") return;
        if (this.shuttingDown) return;
        this.daemonState = "starting";
        try {
          await this.repositoryAccess.synchronize();
          await this.options.daemon.start();
          this.daemonState = "running";
        } catch (error) {
          this.daemonState = "failed";
          throw error;
        }
      };

      const stopDaemon = async (): Promise<void> => {
        if (this.daemonState === "stopped") return;
        this.daemonState = "stopping";
        try {
          await this.options.daemon.stop();
          this.daemonState = "stopped";
        } catch (error) {
          this.daemonState = "failed";
          throw error;
        }
      };

      if (action === "start") {
        await startDaemon();
        return;
      }
      await stopDaemon();
      if (action === "restart" && !this.shuttingDown) {
        await startDaemon();
      }
    });
    this.daemonTransition = operation.catch(() => undefined);
    return operation;
  }

  private emergencyStopDaemon(
    emergencyStop: () => Promise<AgentEmergencyStopResult>,
  ): Promise<AgentEmergencyStopResult & { requested_at: string }> {
    const operation = this.daemonTransition.then(async () => {
      const result = await emergencyStop.call(this.options.daemon);
      if (
        !Number.isSafeInteger(result.stop_requested) ||
        result.stop_requested < 0 ||
        !Number.isSafeInteger(result.process_trees_reaped) ||
        result.process_trees_reaped < 0 ||
        !Number.isSafeInteger(result.unconfirmed) ||
        result.unconfirmed < 0 ||
        result.process_trees_reaped + result.unconfirmed !== result.stop_requested
      ) {
        throw new Error("daemon returned an invalid emergency-stop result");
      }
      const recorded = {
        ...result,
        requested_at: new Date(this.now()).toISOString(),
      };
      this.lastEmergencyStop = recorded;
      this.localState.workload = result.unconfirmed === 0 ? "idle" : "busy";
      this.localState.recent_activity =
        result.unconfirmed === 0
          ? "Local emergency stop completed; recovery worktrees were preserved."
          : "Local emergency stop requested; one or more process trees remain unconfirmed.";
      return recorded;
    });
    this.daemonTransition = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
