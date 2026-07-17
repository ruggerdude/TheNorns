import { useCallback, useEffect, useState } from "react";
import { type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Spinner } from "./ui";

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
  user_authorization: { connected: boolean; login: string | null };
  connections: GitHubConnection[];
}

type SettingsTab = "profile" | "connections" | "security";

async function integrationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...authHeaders(Boolean(init?.body) || init?.method === "DELETE"),
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
}: {
  user: CurrentUser;
  onClose: () => void;
  onSignOut: () => void;
  onUnauthorized?: () => void;
  initialTab?: SettingsTab;
}): React.ReactElement {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [github, setGitHub] = useState<GitHubIntegrationStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);

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

  useEffect(() => loadSessions(), [loadSessions]);
  useEffect(() => void loadGitHub(), [loadGitHub]);

  const revoke = async (sessionId: string): Promise<void> => {
    const response = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: authHeaders(true),
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

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-backdrop" aria-label="Dismiss" onClick={onClose} />
      <div className="modal modal-wide settings-modal card" data-testid="account-panel">
        <div className="section-head settings-head">
          <div>
            <div className="eyebrow">Workspace</div>
            <h2>Settings</h2>
          </div>
          <Button variant="ghost" className="btn-small" onClick={onClose}>
            Close
          </Button>
        </div>
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
                <Button variant="danger" onClick={onSignOut}>
                  Sign out
                </Button>
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
                {connectionError ? <Alert>{connectionError}</Alert> : null}
                {github === null ? (
                  <Spinner label="Loading GitHub connection…" />
                ) : (
                  <article className="connection-card">
                    <div className="connection-card-head">
                      <div className="connection-brand">
                        <span className="connection-icon">GH</span>
                        <div>
                          <h4>GitHub</h4>
                          <p>Repository discovery, creation, branches, and pull requests</p>
                        </div>
                      </div>
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
                    </div>
                    {!github.configured ? (
                      <p className="muted">
                        An administrator must configure the Norns GitHub App deployment secrets.
                      </p>
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
                            Authorize GitHub, then install The Norns for the account or organization
                            you want to use.
                          </p>
                        )}
                      </>
                    )}
                  </article>
                )}

                <article className="connection-card is-secondary">
                  <div className="connection-card-head">
                    <div className="connection-brand">
                      <span className="connection-icon">LR</span>
                      <div>
                        <h4>Local runners</h4>
                        <p>Approved folders and local execution environments</p>
                      </div>
                    </div>
                    <Badge>Runner managed</Badge>
                  </div>
                  <p className="muted">
                    Folder access is granted by a paired runner. Raw server paths are never stored
                    as workspace credentials.
                  </p>
                </article>

                <article className="connection-card is-secondary">
                  <div className="connection-card-head">
                    <div className="connection-brand">
                      <span className="connection-icon">AI</span>
                      <div>
                        <h4>AI providers</h4>
                        <p>OpenAI and Anthropic execution credentials</p>
                      </div>
                    </div>
                    <Badge>Deployment managed</Badge>
                  </div>
                  <p className="muted">
                    Provider keys remain in the server secret store and are never exposed to
                    projects or browsers.
                  </p>
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
      </div>
    </div>
  );
}
