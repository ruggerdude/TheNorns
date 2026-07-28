import { useCallback, useEffect, useState } from "react";
import { type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import {
  type LocalRepositoryInventory,
  chooseLocalRepository,
  loadLocalRepositories,
} from "./localSources";
import { Alert, Badge, Brand, Button, Field, Input, PageHeader, Select, Spinner } from "./ui";

interface SessionSummary {
  id: string;
  status: "active" | "revoked" | "expired";
  created_at: string;
  last_seen_at: string | null;
  current: boolean;
}

export interface GitHubConnection {
  id: string;
  provider: "github";
  display_name: string;
  owner_type: "user" | "organization";
  owner_login: string;
  installation_id: string;
  repository_selection: "all" | "selected";
  status: "connected" | "action_required" | "disconnected";
  last_validated_at: string | null;
}

export interface GitHubIntegrationStatus {
  configured: boolean;
  setup_available: boolean;
  configuration_source: "environment" | "manifest" | null;
  user_authorization: { connected: boolean; login: string | null };
  connections: GitHubConnection[];
}

interface AiIntegrationStatus {
  cross_provider_ready: boolean;
  providers: Array<{
    id: "anthropic" | "openai";
    name: string;
    configured: boolean;
    model: string;
    required_environment: string[];
  }>;
}

interface LocalAgentSetup {
  code: string;
  expires_at: string;
  runner_id: string;
  pairing_uri: string;
  downloads: {
    windows: string | null;
    macos: string | null;
    macos_release: "notarized" | "unsigned_preview" | null;
  };
  install_command: string;
  install_command_windows: string;
}

type ConnectionPanel = "github" | "local" | "ai";

export type SettingsTab = "profile" | "connections" | "security";

function githubCallbackError(code: string | null): string | null {
  switch (code) {
    case null:
    case "connected":
    case "installed":
      return null;
    case "denied":
      return "GitHub did not return the information needed to finish App setup. Please start the setup again.";
    case "invalid_oauth_state":
      return "GitHub setup expired or could not be verified. Please start the setup again.";
    case "github_manifest_conversion_failed":
      return "GitHub created the App, but The Norns could not exchange GitHub's one-time setup code. Please try once more; the server has recorded the exact failure.";
    case "github_manifest_conversion_invalid":
      return "GitHub created the App, but returned incomplete configuration credentials. The server has recorded the exact failure.";
    case "disabled":
      return "GitHub setup is not available on this deployment.";
    default:
      return "The Norns could not save the GitHub App configuration. The server has recorded the exact failure.";
  }
}

async function integrationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      // Content-type follows the body, never the method. The old
      // `|| init?.method === "DELETE"` clause forced
      // `content-type: application/json` onto body-less DELETEs, and Fastify
      // runs the JSON body parser for DELETE too (`bodywith` method set) —
      // rejecting the empty body with 400 FST_ERR_CTP_EMPTY_JSON_BODY before
      // the route handler runs, so "Disconnect" on a GitHub connection always
      // failed (POLISH P3 hotfix sweep, same defect as the Analyze /
      // Start-phase / session-revoke buttons).
      ...authHeaders(Boolean(init?.body)),
      ...init?.headers,
    },
    credentials: "include",
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Connection request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export function Account({
  user,
  onClose,
  onSignOut,
  onUnauthorized = onSignOut,
  initialTab = "profile",
  githubCallback = null,
}: {
  user: CurrentUser;
  onClose: () => void;
  onSignOut: () => void;
  onUnauthorized?: () => void;
  initialTab?: SettingsTab;
  githubCallback?: string | null;
}): React.ReactElement {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [github, setGitHub] = useState<GitHubIntegrationStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [openConnection, setOpenConnection] = useState<ConnectionPanel | null>(
    githubCallback ? "github" : null,
  );
  const [aiStatus, setAiStatus] = useState<AiIntegrationStatus | null>(null);
  const [localSources, setLocalSources] = useState<LocalRepositoryInventory | null>(null);
  const [localAgentSetup, setLocalAgentSetup] = useState<LocalAgentSetup | null>(null);
  const [githubOwnerType, setGitHubOwnerType] = useState<"personal" | "organization">("personal");
  const [githubOrganization, setGitHubOrganization] = useState("");

  const loadSessions = useCallback((): void => {
    fetch("/api/auth/sessions", { headers: authHeaders(), credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) throw new UnauthorizedError();
        if (!response.ok) throw new Error(`session inventory unavailable (${response.status})`);
        return (await response.json()) as { sessions: SessionSummary[] };
      })
      .then((body) => setSessions(body.sessions))
      .catch((error: unknown) => {
        if (error instanceof UnauthorizedError) onUnauthorized();
        else
          setSessionError(error instanceof Error ? error.message : "Session inventory unavailable");
      });
  }, [onUnauthorized]);

  const loadGitHub = useCallback(async (): Promise<void> => {
    setConnectionError(null);
    try {
      setGitHub(
        await integrationRequest<GitHubIntegrationStatus>("/api/integrations/github/status"),
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [onUnauthorized]);

  const loadLocalSources = useCallback(async (): Promise<void> => {
    try {
      const inventory = await loadLocalRepositories();
      setLocalSources(inventory);
      if (inventory.state === "connected") setLocalAgentSetup(null);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [onUnauthorized]);

  useEffect(() => loadSessions(), [loadSessions]);
  useEffect(() => void loadGitHub(), [loadGitHub]);
  useEffect(() => void loadLocalSources(), [loadLocalSources]);
  useEffect(() => {
    if (openConnection !== "local" || localSources?.state === "connected") return;
    const timer = window.setInterval(() => void loadLocalSources(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadLocalSources, localSources?.state, openConnection]);

  const revoke = async (sessionId: string): Promise<void> => {
    const response = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      // No body → no content-type. `authHeaders(true)` sets
      // `content-type: application/json`, and Fastify runs the JSON body
      // parser for DELETE too (it is in the `bodywith` method set), rejecting
      // an EMPTY body with 400 FST_ERR_CTP_EMPTY_JSON_BODY before the route
      // handler runs — the same defect the Analyze and Start-phase buttons
      // shipped (POLISH P3 hotfix).
      headers: authHeaders(),
      credentials: "include",
    });
    if (response.status === 401) return onUnauthorized();
    if (!response.ok) {
      setSessionError(`Could not revoke session (${response.status})`);
      return;
    }
    loadSessions();
  };

  const openGitHubFlow = async (kind: "authorize" | "install"): Promise<void> => {
    setConnectionBusy(kind);
    setConnectionError(null);
    try {
      const response = await integrationRequest<
        { authorization_url: string } | { installation_url: string }
      >(`/api/integrations/github/${kind}`);
      const url =
        "authorization_url" in response ? response.authorization_url : response.installation_url;
      window.location.assign(url);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
      setConnectionBusy(null);
    }
  };

  const disconnect = async (connection: GitHubConnection): Promise<void> => {
    setConnectionBusy(connection.id);
    setConnectionError(null);
    try {
      await integrationRequest<void>(
        `/api/integrations/github/connections/${encodeURIComponent(connection.id)}`,
        { method: "DELETE" },
      );
      await loadGitHub();
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const reconnect = async (connection: GitHubConnection): Promise<void> => {
    setConnectionBusy(connection.id);
    setConnectionError(null);
    try {
      await integrationRequest<{ status: "connected" }>(
        `/api/integrations/github/connections/${encodeURIComponent(connection.id)}/reconnect`,
        { method: "POST", body: JSON.stringify({}) },
      );
      await loadGitHub();
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const toggleConnection = async (panel: ConnectionPanel): Promise<void> => {
    if (openConnection === panel) {
      setOpenConnection(null);
      return;
    }
    setOpenConnection(panel);
    setConnectionError(null);
    try {
      if (panel === "ai" && aiStatus === null) {
        setConnectionBusy("ai");
        setAiStatus(await integrationRequest<AiIntegrationStatus>("/api/integrations/ai/status"));
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const refreshAiStatus = async (): Promise<void> => {
    setConnectionBusy("ai");
    setConnectionError(null);
    try {
      setAiStatus(await integrationRequest<AiIntegrationStatus>("/api/integrations/ai/status"));
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const prepareLocalHelper = async (): Promise<void> => {
    setConnectionBusy("local-setup");
    setConnectionError(null);
    try {
      const setup = await integrationRequest<LocalAgentSetup>("/api/pairing/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setLocalAgentSetup(setup);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const addLocalRepository = async (): Promise<void> => {
    setConnectionBusy("local-choose");
    setConnectionError(null);
    try {
      const selection = await chooseLocalRepository();
      if (!("cancelled" in selection)) await loadLocalSources();
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  return (
    <div className="full-page-view" data-testid="account-panel">
      <header className="full-page-header">
        <div className="full-page-header-title">
          <Brand />
          <span>Settings</span>
        </div>
        <Button variant="ghost" className="btn-small" onClick={onClose}>
          Close
        </Button>
      </header>
      <main className="page-container page-container-narrow settings-page">
        <PageHeader
          eyebrow="Workspace"
          title="Settings"
          lede="Manage your profile, integrations, and active sessions."
        />
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <button
              type="button"
              className={tab === "profile" ? "is-active" : ""}
              onClick={() => setTab("profile")}
            >
              Profile
            </button>
            <button
              type="button"
              className={tab === "connections" ? "is-active" : ""}
              onClick={() => setTab("connections")}
            >
              Connections
            </button>
            <button
              type="button"
              className={tab === "security" ? "is-active" : ""}
              onClick={() => setTab("security")}
            >
              Security & sessions
            </button>
          </nav>

          <section className="settings-content">
            {tab === "profile" ? (
              <div className="form-stack">
                <div>
                  <div className="field-label">Email</div>
                  <p className="mono">{user.email}</p>
                </div>
                {user.name ? (
                  <div>
                    <div className="field-label">Name</div>
                    <p>{user.name}</p>
                  </div>
                ) : null}
                <div>
                  <div className="field-label">Workspace role</div>
                  <p>
                    <Badge tone={user.role === "admin" ? "info" : "default"}>{user.role}</Badge>
                  </p>
                </div>
                <div className="session-row">
                  <span className="muted">End your session on this device.</span>
                  <Button variant="danger" onClick={onSignOut}>
                    Sign out
                  </Button>
                </div>
              </div>
            ) : null}

            {tab === "connections" ? (
              <div className="form-stack" data-testid="connections-panel">
                <div>
                  <div className="eyebrow">Workspace integrations</div>
                  <h3>Connected services</h3>
                  <p className="muted">
                    Authorize providers once, then select their resources while creating projects.
                  </p>
                </div>
                {githubCallbackError(githubCallback) ? (
                  <Alert>{githubCallbackError(githubCallback)}</Alert>
                ) : null}
                {connectionError ? <Alert>{connectionError}</Alert> : null}
                {github === null ? (
                  <Spinner label="Loading GitHub connection…" />
                ) : (
                  <article
                    className={`connection-card ${openConnection === "github" ? "is-open" : ""}`}
                  >
                    <div className="connection-card-head">
                      <div className="connection-brand">
                        <span className="connection-icon">GH</span>
                        <div>
                          <h4>GitHub</h4>
                          <p>Repository discovery, creation, branches, and pull requests</p>
                        </div>
                      </div>
                      <div className="connection-card-controls">
                        <Badge
                          tone={
                            !github.configured
                              ? "default"
                              : github.user_authorization.connected
                                ? "success"
                                : "warn"
                          }
                        >
                          {!github.configured
                            ? "Not configured"
                            : github.user_authorization.connected
                              ? `Authorized as ${github.user_authorization.login}`
                              : "Authorization required"}
                        </Badge>
                        <Button
                          variant={github.configured ? "ghost" : "primary"}
                          className="btn-small"
                          aria-expanded={openConnection === "github"}
                          aria-controls="github-connection-details"
                          onClick={() => void toggleConnection("github")}
                        >
                          {openConnection === "github"
                            ? "Hide"
                            : github.configured
                              ? "Manage GitHub"
                              : "Set up GitHub"}
                        </Button>
                      </div>
                    </div>
                    {openConnection === "github" ? (
                      <div className="connection-details" id="github-connection-details">
                        {!github.configured ? (
                          <div className="connection-setup">
                            <div>
                              <strong>Connect GitHub with guided setup</strong>
                              <p className="muted">
                                The Norns will preconfigure the App, securely store the credentials,
                                and continue directly into repository access.
                              </p>
                            </div>
                            {github.setup_available && user.role === "admin" ? (
                              <form
                                className="github-manifest-form"
                                action="/api/integrations/github/manifest/start"
                                method="get"
                              >
                                <Field label="Create the GitHub App under">
                                  <Select
                                    name="owner_type"
                                    value={githubOwnerType}
                                    onChange={(event) =>
                                      setGitHubOwnerType(
                                        event.currentTarget.value as "personal" | "organization",
                                      )
                                    }
                                  >
                                    <option value="personal">My personal GitHub account</option>
                                    <option value="organization">A GitHub organization</option>
                                  </Select>
                                </Field>
                                {githubOwnerType === "organization" ? (
                                  <Field label="Organization name">
                                    <Input
                                      name="organization"
                                      value={githubOrganization}
                                      onChange={(event) =>
                                        setGitHubOrganization(event.currentTarget.value)
                                      }
                                      placeholder="your-organization"
                                      autoComplete="off"
                                      required
                                    />
                                  </Field>
                                ) : null}
                                <Button
                                  type="submit"
                                  variant="primary"
                                  disabled={
                                    githubOwnerType === "organization" &&
                                    githubOrganization.trim().length === 0
                                  }
                                >
                                  Continue with GitHub
                                </Button>
                                <p className="field-help">
                                  GitHub will show the prefilled App for confirmation. No keys or
                                  callback URLs need to be copied.
                                </p>
                              </form>
                            ) : (
                              <Alert>
                                {user.role === "admin"
                                  ? "Guided setup needs relational identity persistence on this deployment."
                                  : "A workspace administrator must connect the GitHub App."}
                              </Alert>
                            )}
                            <details>
                              <summary>Advanced: manage the GitHub App manually</summary>
                              <p className="muted">
                                Environment-managed configuration remains available for operators
                                who do not want The Norns to store App credentials.
                              </p>
                              <div className="connection-actions">
                                <a
                                  className="btn btn-ghost btn-small"
                                  href="https://github.com/settings/apps/new"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Create GitHub App manually ↗
                                </a>
                              </div>
                            </details>
                          </div>
                        ) : (
                          <>
                            <div className="connection-actions">
                              <Button
                                variant={github.user_authorization.connected ? "ghost" : "primary"}
                                className="btn-small"
                                disabled={connectionBusy !== null}
                                onClick={() => void openGitHubFlow("authorize")}
                              >
                                {github.user_authorization.connected
                                  ? "Reconnect identity"
                                  : "Connect GitHub"}
                              </Button>
                              {github.user_authorization.connected ? (
                                <Button
                                  className="btn-small"
                                  disabled={connectionBusy !== null}
                                  onClick={() => void openGitHubFlow("install")}
                                >
                                  Add GitHub account or organization
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                className="btn-small"
                                disabled={connectionBusy !== null}
                                onClick={() => void loadGitHub()}
                              >
                                Refresh
                              </Button>
                            </div>
                            {github.connections.length ? (
                              <div className="connection-list">
                                {github.connections.map((connection) => (
                                  <div className="connection-row" key={connection.id}>
                                    <div>
                                      <strong>{connection.owner_login}</strong>
                                      <span>
                                        {connection.owner_type} · {connection.repository_selection}{" "}
                                        repositories
                                      </span>
                                    </div>
                                    <Badge
                                      tone={connection.status === "connected" ? "success" : "warn"}
                                    >
                                      {connection.status.replaceAll("_", " ")}
                                    </Badge>
                                    {user.role === "admin" && connection.status === "connected" ? (
                                      <Button
                                        variant="ghost"
                                        className="btn-small"
                                        disabled={connectionBusy !== null}
                                        onClick={() => void disconnect(connection)}
                                      >
                                        Disconnect
                                      </Button>
                                    ) : user.role === "admin" ? (
                                      <Button
                                        className="btn-small"
                                        disabled={connectionBusy !== null}
                                        onClick={() => void reconnect(connection)}
                                      >
                                        Reconnect
                                      </Button>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="muted">
                                Authorize GitHub, then install The Norns for the account or
                                organization you want to use.
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    ) : null}
                  </article>
                )}

                <article
                  className={`connection-card ${openConnection === "local" ? "is-open" : ""}`}
                >
                  <div className="connection-card-head">
                    <div className="connection-brand">
                      <span className="connection-icon">⌂</span>
                      <div>
                        <h4>Norns Local Agent</h4>
                        <p>Local coding and approved project folders on this computer</p>
                      </div>
                    </div>
                    <div className="connection-card-controls">
                      <Badge tone={localSources?.state === "connected" ? "success" : "warn"}>
                        {localSources?.state === "connected"
                          ? `${localSources.repositories.length} ready`
                          : (localSources?.state.replaceAll("_", " ") ?? "Checking")}
                      </Badge>
                      <Button
                        variant="ghost"
                        className="btn-small"
                        aria-expanded={openConnection === "local"}
                        aria-controls="local-connection-details"
                        onClick={() => void toggleConnection("local")}
                      >
                        {openConnection === "local" ? "Hide" : "Manage agent"}
                      </Button>
                    </div>
                  </div>
                  {openConnection === "local" ? (
                    <div className="connection-details" id="local-connection-details">
                      {localSources === null ? (
                        <Spinner label="Checking Norns Local Agent…" />
                      ) : (
                        <>
                          <p className="muted">{localSources.message}</p>
                          {localSources.state === "connected" ? (
                            <>
                              <div className="connection-actions">
                                <Button
                                  className="btn-small"
                                  disabled={connectionBusy !== null}
                                  onClick={() => void addLocalRepository()}
                                >
                                  {connectionBusy === "local-choose"
                                    ? "Opening folder picker…"
                                    : "Add local repository"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  className="btn-small"
                                  disabled={connectionBusy !== null}
                                  onClick={() => void loadLocalSources()}
                                >
                                  Refresh
                                </Button>
                              </div>
                              {localSources.repositories.length ? (
                                <div className="connection-list">
                                  {localSources.repositories.map(({ repository }) => (
                                    <div className="connection-row" key={repository.repository_id}>
                                      <div>
                                        <strong>{repository.repository_display_name}</strong>
                                        <span>
                                          {repository.default_branch} · committed{" "}
                                          {repository.observed_head.slice(0, 8)}
                                        </span>
                                      </div>
                                      <Badge tone="success">Ready</Badge>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="muted">
                                  Add a Git repository once; it will then appear in every adoption
                                  workflow on this computer.
                                </p>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="connection-actions">
                                <Button
                                  className="btn-small"
                                  disabled={connectionBusy !== null}
                                  onClick={() => void prepareLocalHelper()}
                                >
                                  {connectionBusy === "local-setup"
                                    ? "Preparing…"
                                    : localSources.state === "degraded"
                                      ? "Update Norns Local Agent"
                                      : "Set up Norns Local Agent"}
                                </Button>
                              </div>
                              {localAgentSetup ? (
                                <div className="local-agent-setup">
                                  {localAgentSetup.downloads.windows ||
                                  localAgentSetup.downloads.macos ? (
                                    <>
                                      <div>
                                        <strong>1. Install Norns Local Agent</strong>
                                        <p className="muted">
                                          The installer includes everything the agent needs.
                                        </p>
                                      </div>
                                      <div className="connection-actions">
                                        {localAgentSetup.downloads.windows ? (
                                          <a
                                            className="btn btn-primary btn-small"
                                            href={localAgentSetup.downloads.windows}
                                          >
                                            Download for Windows
                                          </a>
                                        ) : null}
                                        {localAgentSetup.downloads.macos ? (
                                          <a
                                            className="btn btn-primary btn-small"
                                            href={localAgentSetup.downloads.macos}
                                          >
                                            {localAgentSetup.downloads.macos_release ===
                                            "unsigned_preview"
                                              ? "Download unsigned Mac preview"
                                              : "Download for Mac"}
                                          </a>
                                        ) : null}
                                      </div>
                                      {localAgentSetup.downloads.macos_release ===
                                      "unsigned_preview" ? (
                                        <Alert>
                                          This Mac preview is not yet Developer ID signed or
                                          notarized. macOS may block it. Only use the release from
                                          the official Norns GitHub repository; if prompted, open
                                          System Settings → Privacy &amp; Security and choose Open
                                          Anyway.
                                        </Alert>
                                      ) : null}
                                      <div>
                                        <strong>2. Connect this computer</strong>
                                        <p className="muted">
                                          After installation, this one-use link securely pairs the
                                          agent with your account.
                                        </p>
                                      </div>
                                      <div className="connection-actions">
                                        <a
                                          className="btn btn-primary btn-small"
                                          href={localAgentSetup.pairing_uri}
                                        >
                                          Connect installed agent
                                        </a>
                                      </div>
                                    </>
                                  ) : (
                                    <Alert>
                                      Downloadable installers are not published for this deployment
                                      yet. Advanced setup remains available below.
                                    </Alert>
                                  )}
                                  <details>
                                    <summary>Advanced command-line setup</summary>
                                    <div className="local-helper-command">
                                      <code>{localAgentSetup.install_command}</code>
                                      <Button
                                        variant="ghost"
                                        className="btn-small"
                                        onClick={() =>
                                          void navigator.clipboard.writeText(
                                            localAgentSetup.install_command,
                                          )
                                        }
                                      >
                                        Copy Mac/Linux command
                                      </Button>
                                    </div>
                                    <div className="local-helper-command">
                                      <code>{localAgentSetup.install_command_windows}</code>
                                      <Button
                                        variant="ghost"
                                        className="btn-small"
                                        onClick={() =>
                                          void navigator.clipboard.writeText(
                                            localAgentSetup.install_command_windows,
                                          )
                                        }
                                      >
                                        Copy Windows command
                                      </Button>
                                    </div>
                                  </details>
                                </div>
                              ) : null}
                            </>
                          )}
                          <p className="meta">
                            Folder paths stay on this computer. The Norns receives an opaque
                            repository handle and reads only bounded files from committed revisions.
                          </p>
                        </>
                      )}
                    </div>
                  ) : null}
                </article>

                <article
                  className={`connection-card is-secondary ${openConnection === "ai" ? "is-open" : ""}`}
                >
                  <div className="connection-card-head">
                    <div className="connection-brand">
                      <span className="connection-icon">MP</span>
                      <div>
                        <h4>Model providers</h4>
                        <p>OpenAI and Anthropic execution credentials</p>
                      </div>
                    </div>
                    <div className="connection-card-controls">
                      <Badge tone={aiStatus?.cross_provider_ready ? "success" : "default"}>
                        {aiStatus?.cross_provider_ready ? "Ready" : "Deployment managed"}
                      </Badge>
                      <Button
                        variant="ghost"
                        className="btn-small"
                        aria-expanded={openConnection === "ai"}
                        aria-controls="ai-connection-details"
                        onClick={() => void toggleConnection("ai")}
                      >
                        {openConnection === "ai" ? "Hide" : "Manage providers"}
                      </Button>
                    </div>
                  </div>
                  {openConnection === "ai" ? (
                    <div className="connection-details" id="ai-connection-details">
                      <p className="muted">
                        Keys remain in the server secret store. This page shows configuration status
                        and model routing without exposing secret values.
                      </p>
                      <div className="connection-actions">
                        <Button
                          variant="ghost"
                          className="btn-small"
                          disabled={connectionBusy !== null}
                          onClick={() => void refreshAiStatus()}
                        >
                          Refresh status
                        </Button>
                      </div>
                      {aiStatus === null || connectionBusy === "ai" ? (
                        <Spinner label="Checking provider configuration…" />
                      ) : (
                        <div className="connection-list">
                          {aiStatus.providers.map((provider) => (
                            <div className="connection-row provider-row" key={provider.id}>
                              <div>
                                <strong>{provider.name}</strong>
                                <span className="mono">{provider.model}</span>
                                {!provider.configured ? (
                                  <span>Required: {provider.required_environment.join(", ")}</span>
                                ) : null}
                              </div>
                              <Badge tone={provider.configured ? "success" : "warn"}>
                                {provider.configured ? "Configured" : "Action required"}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </article>
              </div>
            ) : null}

            {tab === "security" ? (
              <div className="form-stack">
                <div>
                  <div className="eyebrow">Account security</div>
                  <h3>Active sessions</h3>
                </div>
                {sessions.length === 0 ? (
                  <p className="muted">No session inventory available.</p>
                ) : null}
                {sessions.map((session) => (
                  <div className="session-row" key={session.id}>
                    <div>
                      <Badge tone={session.status === "active" ? "success" : "default"}>
                        {session.current ? "This session" : session.status}
                      </Badge>
                      <p className="muted mono">{session.id.slice(0, 12)}</p>
                    </div>
                    {session.status === "active" && !session.current ? (
                      <Button
                        variant="ghost"
                        className="btn-small"
                        onClick={() => void revoke(session.id)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                ))}
                {sessionError ? <Alert>{sessionError}</Alert> : null}
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </div>
  );
}
