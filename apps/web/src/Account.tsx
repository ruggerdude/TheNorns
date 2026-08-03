import {
  OwnedDeviceProjection,
  type OwnedDeviceProjectionT,
  type PmProviderT,
} from "@norns/contracts";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import "./UtilitySurfaces.css";
import { ArchivedProjectsSettings, GlobalRulesSettings } from "./WorkspaceManagementSettings";
import { type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Brand, Button, Field, Input, PageHeader, Select, Spinner } from "./ui";

const Computers = lazy(() =>
  import("./Computers").then(({ Computers }) => ({ default: Computers })),
);

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
  refresh_error: string | null;
  user_authorization: { connected: boolean; login: string | null };
  connections: GitHubConnection[];
}

interface AiIntegrationStatus {
  cross_provider_ready: boolean;
  providers: Array<{
    id: PmProviderT;
    name: string;
    configured: boolean;
    model: string;
    credential_modes?: Array<"api" | "subscription">;
    required_environment: string[];
  }>;
}

interface LocalRepositoryRegistration {
  registration_id: string;
  repository_display_name: string;
  default_branch: string;
  state: "active" | "revoked";
}

type ConnectionPanel = "github" | "local-agent" | "ai";

export type SettingsTab =
  | "profile"
  | "connections"
  | "computers"
  | "rules"
  | "archive"
  | "security";

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
      // the route handler runs, so deleting a GitHub connection would always
      // fail (POLISH P3 hotfix sweep, same defect as the Analyze /
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
  embedded = false,
}: {
  user: CurrentUser;
  onClose: () => void;
  onSignOut: () => void;
  onUnauthorized?: () => void;
  initialTab?: SettingsTab;
  githubCallback?: string | null;
  embedded?: boolean;
}): React.ReactElement {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [github, setGitHub] = useState<GitHubIntegrationStatus | null>(null);
  const [callbackError, setCallbackError] = useState<string | null>(() =>
    githubCallbackError(githubCallback),
  );
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [openConnection, setOpenConnection] = useState<ConnectionPanel | null>(
    githubCallback ? "github" : null,
  );
  const [aiStatus, setAiStatus] = useState<AiIntegrationStatus | null>(null);
  const [localAgentDevices, setLocalAgentDevices] = useState<OwnedDeviceProjectionT[] | null>(null);
  const [localAgentRepositories, setLocalAgentRepositories] = useState<
    Record<string, LocalRepositoryRegistration[]>
  >({});
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
      const status = await integrationRequest<GitHubIntegrationStatus>(
        "/api/integrations/github/status",
      );
      setGitHub(status);
      if (
        status.refresh_error ||
        (status.configured &&
          status.user_authorization.connected &&
          !status.connections.some((connection) => connection.status === "connected"))
      ) {
        setCallbackError(null);
        setOpenConnection("github");
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [onUnauthorized]);

  const loadLocalAgent = useCallback(async (): Promise<void> => {
    try {
      const payload = await integrationRequest<{ devices: unknown[] }>("/api/devices");
      const devices = payload.devices.map((device) => OwnedDeviceProjection.parse(device));
      const repositoryEntries = await Promise.all(
        devices.map(async (device) => {
          const access = await integrationRequest<{
            registrations: LocalRepositoryRegistration[];
          }>(`/api/devices/${encodeURIComponent(device.device_id)}/repository-access`);
          return [
            device.device_id,
            access.registrations.filter((registration) => registration.state === "active"),
          ] as const;
        }),
      );
      setLocalAgentDevices(devices);
      setLocalAgentRepositories(Object.fromEntries(repositoryEntries));
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, [onUnauthorized]);

  useEffect(() => loadSessions(), [loadSessions]);
  useEffect(() => void loadGitHub(), [loadGitHub]);
  useEffect(() => void loadLocalAgent(), [loadLocalAgent]);

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

  const openGitHubFlow = async (
    kind: "authorize" | "install",
    continueToInstall = false,
  ): Promise<void> => {
    setConnectionBusy(kind);
    setConnectionError(null);
    try {
      const response = await integrationRequest<
        { authorization_url: string } | { installation_url: string }
      >(
        `/api/integrations/github/${kind}${
          kind === "authorize" && continueToInstall ? "?next=install" : ""
        }`,
      );
      const url =
        "authorization_url" in response ? response.authorization_url : response.installation_url;
      window.location.assign(url);
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
      setConnectionBusy(null);
    }
  };

  const connectedGitHubAccounts =
    github?.connections.filter((connection) => connection.status === "connected") ?? [];
  const githubReady = connectedGitHubAccounts.length > 0;
  const readyLocalAgentDevices =
    localAgentDevices?.filter(
      (device) =>
        device.status.availability === "online" && device.status.compatibility === "ready",
    ) ?? [];
  const localRepositoryCount = Object.values(localAgentRepositories).reduce(
    (count, repositories) => count + repositories.length,
    0,
  );

  const disconnect = async (connection: GitHubConnection): Promise<void> => {
    setConnectionBusy(connection.id);
    setConnectionError(null);
    try {
      await integrationRequest<void>(
        `/api/integrations/github/connections/${encodeURIComponent(connection.id)}/disconnect`,
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

  const deleteConnection = async (connection: GitHubConnection): Promise<void> => {
    const confirmed = window.confirm(
      `Delete the saved GitHub connection for ${connection.owner_login}? Projects using it will no longer be able to access GitHub until another connection is selected.`,
    );
    if (!confirmed) return;
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

  const deleteGitHubIdentity = async (): Promise<void> => {
    const confirmed = window.confirm(
      "Delete your saved GitHub identity? Norns will forget the stored authorization. Workspace installations remain available to other authorized users.",
    );
    if (!confirmed) return;
    setConnectionBusy("github-identity-delete");
    setConnectionError(null);
    setCallbackError(null);
    try {
      await integrationRequest<void>("/api/integrations/github/authorization", {
        method: "DELETE",
      });
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

  return (
    <div className={embedded ? "embedded-page-view" : "full-page-view"} data-testid="account-panel">
      {!embedded ? (
        <header className="full-page-header">
          <div className="full-page-header-title">
            <Brand />
            <span>Settings</span>
          </div>
          <Button variant="ghost" className="btn-small" onClick={onClose}>
            Close
          </Button>
        </header>
      ) : null}
      <main className="page-container page-container-narrow settings-page">
        <PageHeader title="Settings" />
        <nav className="page-subnav" aria-label="Settings sections">
          <button
            type="button"
            aria-current={tab === "profile" ? "page" : undefined}
            className={tab === "profile" ? "is-active" : ""}
            onClick={() => setTab("profile")}
          >
            Profile
          </button>
          <button
            type="button"
            aria-current={tab === "connections" ? "page" : undefined}
            className={tab === "connections" ? "is-active" : ""}
            onClick={() => setTab("connections")}
          >
            Connections
          </button>
          <button
            type="button"
            aria-current={tab === "computers" ? "page" : undefined}
            className={tab === "computers" ? "is-active" : ""}
            onClick={() => setTab("computers")}
          >
            Computers
          </button>
          {user.role === "admin" ? (
            <button
              type="button"
              aria-current={tab === "rules" ? "page" : undefined}
              className={tab === "rules" ? "is-active" : ""}
              onClick={() => setTab("rules")}
            >
              Rules
            </button>
          ) : null}
          {user.role === "admin" ? (
            <button
              type="button"
              aria-current={tab === "archive" ? "page" : undefined}
              className={tab === "archive" ? "is-active" : ""}
              onClick={() => setTab("archive")}
            >
              Archive
            </button>
          ) : null}
          <button
            type="button"
            aria-current={tab === "security" ? "page" : undefined}
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
              {callbackError ? <Alert>{callbackError}</Alert> : null}
              {connectionError ? <Alert>{connectionError}</Alert> : null}
              {github?.refresh_error ? (
                <Alert>
                  GitHub could not refresh the saved connections: {github.refresh_error} Reconnect
                  the identity or delete the saved identity below.
                </Alert>
              ) : null}
              <article
                className={`connection-card ${openConnection === "local-agent" ? "is-open" : ""}`}
              >
                <div className="connection-card-head">
                  <div className="connection-brand">
                    <span className="connection-icon" aria-hidden="true">
                      ⌂
                    </span>
                    <div>
                      <h4>Norns Local Agent</h4>
                      <p>Approved Git project folders on your computers</p>
                    </div>
                  </div>
                  <div className="connection-card-controls">
                    <Badge
                      tone={
                        readyLocalAgentDevices.length > 0
                          ? "success"
                          : localAgentDevices?.length
                            ? "warn"
                            : "default"
                      }
                    >
                      {localAgentDevices === null
                        ? "Loading"
                        : readyLocalAgentDevices.length > 0
                          ? `${readyLocalAgentDevices.length} ready`
                          : localAgentDevices.length > 0
                            ? "Connection needs attention"
                            : "Not connected"}
                    </Badge>
                    <Button
                      variant="ghost"
                      className="btn-small"
                      aria-expanded={openConnection === "local-agent"}
                      aria-controls="local-agent-connection-details"
                      onClick={() => void toggleConnection("local-agent")}
                    >
                      {openConnection === "local-agent" ? "Hide" : "Manage agent"}
                    </Button>
                  </div>
                </div>
                {openConnection === "local-agent" ? (
                  <div className="connection-details" id="local-agent-connection-details">
                    {localAgentDevices?.length ? (
                      <div className="connection-list">
                        {localAgentDevices.map((device) => {
                          const repositories = localAgentRepositories[device.device_id] ?? [];
                          return (
                            <div className="connection-row" key={device.device_id}>
                              <div>
                                <strong>{device.name}</strong>
                                <span>
                                  {device.status.availability} · {device.status.compatibility} ·{" "}
                                  {repositories.length} approved{" "}
                                  {repositories.length === 1 ? "folder" : "folders"}
                                </span>
                                {repositories.map((repository) => (
                                  <span key={repository.registration_id}>
                                    {repository.repository_display_name} ·{" "}
                                    {repository.default_branch}
                                  </span>
                                ))}
                              </div>
                              <Badge
                                tone={
                                  device.status.availability === "online" &&
                                  device.status.compatibility === "ready"
                                    ? "success"
                                    : "warn"
                                }
                              >
                                {device.status.availability}
                              </Badge>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="muted">
                        Install and sync the Norns Local Agent to approve folders on this computer.
                      </p>
                    )}
                    <div className="connection-actions">
                      <Button
                        variant="ghost"
                        className="btn-small"
                        disabled={connectionBusy !== null}
                        onClick={() => void loadLocalAgent()}
                      >
                        Refresh computers
                      </Button>
                    </div>
                    {localAgentDevices?.length ? (
                      <p className="muted">
                        Add or remove folders from the Local Agent’s Repositories tab.{" "}
                        {localRepositoryCount} approved{" "}
                        {localRepositoryCount === 1 ? "folder is" : "folders are"} synced to this
                        account.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </article>
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
                            : github.refresh_error
                              ? "danger"
                              : githubReady
                                ? "success"
                                : "warn"
                        }
                      >
                        {!github.configured
                          ? "Not configured"
                          : github.refresh_error
                            ? "Connection needs attention"
                            : githubReady
                              ? `${connectedGitHubAccounts.length} GitHub destination${
                                  connectedGitHubAccounts.length === 1 ? "" : "s"
                                } ready`
                              : github.user_authorization.connected
                                ? "Setup incomplete"
                                : "Not connected"}
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
                            ? github.user_authorization.connected && !githubReady
                              ? "Finish setup"
                              : "Manage GitHub"
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
                              Environment-managed configuration remains available for operators who
                              do not want The Norns to store App credentials.
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
                          {github.user_authorization.connected && !githubReady ? (
                            <div className="connection-required">
                              <div>
                                <strong>One step left: choose where Norns can work</strong>
                                <p>
                                  Your identity is authorized as{" "}
                                  <strong>{github.user_authorization.login}</strong>, but no GitHub
                                  account or organization has installed The Norns yet.
                                </p>
                              </div>
                              <Button
                                variant="primary"
                                className="btn-small"
                                disabled={connectionBusy !== null}
                                onClick={() => void openGitHubFlow("install")}
                              >
                                Install The Norns on GitHub
                              </Button>
                            </div>
                          ) : null}
                          <div className="connection-actions">
                            <Button
                              variant={github.user_authorization.connected ? "ghost" : "primary"}
                              className="btn-small"
                              disabled={connectionBusy !== null}
                              onClick={() =>
                                void openGitHubFlow(
                                  "authorize",
                                  !github.user_authorization.connected,
                                )
                              }
                            >
                              {github.user_authorization.connected
                                ? "Reconnect identity"
                                : "Connect GitHub"}
                            </Button>
                            {github.user_authorization.connected ? (
                              <Button
                                variant="danger"
                                className="btn-small"
                                disabled={connectionBusy !== null}
                                onClick={() => void deleteGitHubIdentity()}
                              >
                                Delete GitHub identity
                              </Button>
                            ) : null}
                            {github.user_authorization.connected && githubReady ? (
                              <Button
                                className="btn-small"
                                disabled={connectionBusy !== null}
                                onClick={() => void openGitHubFlow("install")}
                              >
                                Add another GitHub destination
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
                                  {user.role === "admin" ? (
                                    <Button
                                      variant="danger"
                                      className="btn-small"
                                      disabled={connectionBusy !== null}
                                      onClick={() => void deleteConnection(connection)}
                                    >
                                      Delete connection
                                    </Button>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="muted">
                              {github.user_authorization.connected
                                ? "Installation is still required before projects can create or select repositories."
                                : "Connect GitHub once; setup will continue directly to choosing the account or organization where Norns can work."}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  ) : null}
                </article>
              )}

              <article
                className={`connection-card is-secondary ${openConnection === "ai" ? "is-open" : ""}`}
              >
                <div className="connection-card-head">
                  <div className="connection-brand">
                    <span className="connection-icon">MP</span>
                    <div>
                      <h4>Model providers</h4>
                      <p>Anthropic, OpenAI, and DeepSeek execution credentials</p>
                      <p>
                        Anthropic and OpenAI can also use subscription sign-in for execution;
                        DeepSeek is API-only.
                      </p>
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
                    <section
                      className="connection-setup subscription-setup"
                      aria-labelledby="subscription-setup-heading"
                    >
                      <div>
                        <strong id="subscription-setup-heading">
                          Connect local Claude and Codex subscriptions
                        </strong>
                        <p className="muted">
                          Complete these steps on every execution computer, using the same operating
                          system account that runs the Norns Local Agent. The sign-in stays on that
                          computer and is never copied to the Norns server.
                        </p>
                      </div>
                      <div className="subscription-provider-grid">
                        <section
                          className="subscription-provider-instructions"
                          aria-labelledby="codex-subscription-heading"
                        >
                          <strong id="codex-subscription-heading">OpenAI via Codex</strong>
                          <ol>
                            <li>
                              Install or update the official Codex CLI, then run{" "}
                              <code>codex login</code> in a terminal on the execution computer.
                            </li>
                            <li>
                              Complete <strong>Sign in with ChatGPT</strong> in the browser. Select
                              the ChatGPT workspace whose subscription should be used; do not choose
                              API-key sign-in.
                            </li>
                            <li>
                              Run <code>codex login status</code> and confirm it reports{" "}
                              <code>Logged in using ChatGPT</code>.
                            </li>
                          </ol>
                          <a
                            href="https://learn.chatgpt.com/docs/auth#sign-in-with-chatgpt"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open the official Codex sign-in guide ↗
                          </a>
                        </section>
                        <section
                          className="subscription-provider-instructions"
                          aria-labelledby="claude-subscription-heading"
                        >
                          <strong id="claude-subscription-heading">
                            Anthropic via Claude Code
                          </strong>
                          <ol>
                            <li>
                              Install or update the official Claude Code CLI, then run{" "}
                              <code>claude auth login</code> on the execution computer.
                            </li>
                            <li>
                              Sign in with a Claude.ai Pro, Max, Team, or Enterprise subscription.
                              Do not use <code>--console</code>, which selects API billing.
                            </li>
                            <li>
                              Run <code>claude auth status --json</code>. Confirm{" "}
                              <code>loggedIn</code> is true, <code>authMethod</code> is{" "}
                              <code>claude.ai</code>, and a subscription type is present.
                            </li>
                          </ol>
                          <a
                            href="https://code.claude.com/docs/en/authentication"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open the official Claude Code sign-in guide ↗
                          </a>
                        </section>
                      </div>
                      <div className="subscription-next-step">
                        <strong>Then select the connection for work</strong>
                        <p>
                          In the project or phase staffing controls, choose{" "}
                          <strong>Subscription</strong> as the execution credential for the matching
                          provider. The Local Agent verifies the login when execution starts and
                          fails safely if it is missing or uses the wrong account type.
                        </p>
                        <p>
                          Subscription login is local, so the server API status below will not
                          change. DeepSeek does not support this connection method and remains
                          API-only.
                        </p>
                      </div>
                    </section>
                    <div className="provider-api-status-heading">
                      <div>
                        <strong>Server API connections</strong>
                        <p className="muted">
                          Keys remain in the server secret store. Status and model routing are shown
                          here without exposing secret values.
                        </p>
                      </div>
                    </div>
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
                              {provider.configured ? "API configured" : "API not configured"}
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

          {tab === "computers" ? (
            <Suspense fallback={<Spinner label="Loading computers…" />}>
              <Computers embedded onUnauthorized={onUnauthorized} />
            </Suspense>
          ) : null}

          {tab === "rules" && user.role === "admin" ? (
            <GlobalRulesSettings onUnauthorized={onUnauthorized} />
          ) : null}

          {tab === "archive" && user.role === "admin" ? (
            <ArchivedProjectsSettings onUnauthorized={onUnauthorized} />
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
      </main>
    </div>
  );
}
