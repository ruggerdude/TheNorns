import { useCallback, useEffect, useState } from "react";
import { type CurrentUser, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Field, Input, Select, Spinner } from "./ui";

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

interface RunnerSummary {
  runner_id: string;
  generation: number;
  connected: boolean;
  last_seen_at: string | null;
}

interface PairingSession {
  code: string;
  expires_at: string;
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

type ConnectionPanel = "github" | "runners" | "ai";

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
  const [openConnection, setOpenConnection] = useState<ConnectionPanel | null>(null);
  const [runners, setRunners] = useState<RunnerSummary[] | null>(null);
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiIntegrationStatus | null>(null);
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

  const toggleConnection = async (panel: ConnectionPanel): Promise<void> => {
    if (openConnection === panel) {
      setOpenConnection(null);
      return;
    }
    setOpenConnection(panel);
    setConnectionError(null);
    try {
      if (panel === "runners" && runners === null) {
        setConnectionBusy("runners");
        setRunners(await integrationRequest<RunnerSummary[]>("/api/runners"));
      }
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

  const refreshRunners = async (): Promise<void> => {
    setConnectionBusy("runners");
    setConnectionError(null);
    try {
      setRunners(await integrationRequest<RunnerSummary[]>("/api/runners"));
    } catch (error) {
      if (error instanceof UnauthorizedError) onUnauthorized();
      else setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectionBusy(null);
    }
  };

  const startPairing = async (): Promise<void> => {
    setConnectionBusy("pairing");
    setConnectionError(null);
    setPairingCopied(false);
    try {
      setPairing(
        await integrationRequest<PairingSession>("/api/pairing/start", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
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

  const pairingCommand = pairing
    ? `norns-runner pair ${pairing.code} --server ${window.location.origin}`
    : null;

  const copyPairingCommand = async (): Promise<void> => {
    if (!pairingCommand) return;
    try {
      await navigator.clipboard.writeText(pairingCommand);
      setPairingCopied(true);
    } catch {
      setConnectionError(
        "Could not copy the command. Select the command text and copy it manually.",
      );
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
                  className={`connection-card is-secondary ${openConnection === "runners" ? "is-open" : ""}`}
                >
                  <div className="connection-card-head">
                    <div className="connection-brand">
                      <span className="connection-icon">LR</span>
                      <div>
                        <h4>Local runners</h4>
                        <p>Approved folders and local execution environments</p>
                      </div>
                    </div>
                    <div className="connection-card-controls">
                      <Badge
                        tone={runners?.some((runner) => runner.connected) ? "success" : "default"}
                      >
                        {runners === null
                          ? "Runner managed"
                          : `${runners.filter((runner) => runner.connected).length} connected`}
                      </Badge>
                      <Button
                        variant="ghost"
                        className="btn-small"
                        aria-expanded={openConnection === "runners"}
                        aria-controls="runner-connection-details"
                        onClick={() => void toggleConnection("runners")}
                      >
                        {openConnection === "runners" ? "Hide" : "Manage runners"}
                      </Button>
                    </div>
                  </div>
                  {openConnection === "runners" ? (
                    <div className="connection-details" id="runner-connection-details">
                      <p className="muted">
                        Pair a runner on the computer that owns your local folders. The runner keeps
                        raw paths and execution credentials off the web service.
                      </p>
                      <div className="connection-actions">
                        <Button
                          variant="primary"
                          className="btn-small"
                          disabled={connectionBusy !== null}
                          onClick={() => void startPairing()}
                        >
                          Pair new runner
                        </Button>
                        <Button
                          variant="ghost"
                          className="btn-small"
                          disabled={connectionBusy !== null}
                          onClick={() => void refreshRunners()}
                        >
                          Refresh
                        </Button>
                      </div>
                      {pairing && pairingCommand ? (
                        <output className="pairing-panel">
                          <div>
                            <span className="field-label">Pairing code</span>
                            <strong className="pairing-code mono">{pairing.code}</strong>
                            <span className="muted">
                              Expires{" "}
                              {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(
                                new Date(pairing.expires_at),
                              )}
                            </span>
                          </div>
                          <code>{pairingCommand}</code>
                          <Button className="btn-small" onClick={() => void copyPairingCommand()}>
                            {pairingCopied ? "Copied" : "Copy pairing command"}
                          </Button>
                        </output>
                      ) : null}
                      {runners === null || connectionBusy === "runners" ? (
                        <Spinner label="Loading runners…" />
                      ) : runners.length ? (
                        <div className="connection-list">
                          {runners.map((runner) => (
                            <div className="connection-row" key={runner.runner_id}>
                              <div>
                                <strong>{runner.runner_id}</strong>
                                <span>
                                  Generation {runner.generation} ·{" "}
                                  {runner.last_seen_at
                                    ? `last seen ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(runner.last_seen_at))}`
                                    : "not seen yet"}
                                </span>
                              </div>
                              <Badge tone={runner.connected ? "success" : "default"}>
                                {runner.connected ? "Connected" : "Offline"}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">No runners are paired with this workspace yet.</p>
                      )}
                    </div>
                  ) : null}
                </article>

                <article
                  className={`connection-card is-secondary ${openConnection === "ai" ? "is-open" : ""}`}
                >
                  <div className="connection-card-head">
                    <div className="connection-brand">
                      <span className="connection-icon">AI</span>
                      <div>
                        <h4>AI providers</h4>
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
      </div>
    </div>
  );
}
