import { useCallback, useEffect, useState } from "react";
import { type CurrentUser, authHeaders } from "./auth";
import { Badge, Button } from "./ui";

interface SessionSummary {
  id: string;
  status: "active" | "revoked" | "expired";
  created_at: string;
  last_seen_at: string | null;
  current: boolean;
}

export function Account({
  user,
  onClose,
  onSignOut,
}: {
  user: CurrentUser;
  onClose: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const loadSessions = useCallback((): void => {
    fetch("/api/auth/sessions", { headers: authHeaders(), credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`session inventory unavailable (${response.status})`);
        return (await response.json()) as { sessions: SessionSummary[] };
      })
      .then((body) => setSessions(body.sessions))
      .catch((error: unknown) =>
        setSessionError(error instanceof Error ? error.message : "Session inventory unavailable"),
      );
  }, []);
  useEffect(loadSessions, []);

  const revoke = async (sessionId: string): Promise<void> => {
    const response = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: authHeaders(true),
      credentials: "include",
    });
    if (!response.ok) {
      setSessionError(`Could not revoke session (${response.status})`);
      return;
    }
    loadSessions();
  };

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-backdrop" aria-label="Dismiss" onClick={onClose} />
      <div className="modal card" data-testid="account-panel">
        <div className="section-head">
          <h2>Account</h2>
          <Button variant="ghost" className="btn-small" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="form-stack">
          <div>
            <div className="field-label">Email</div>
            <p className="mono">{user.email}</p>
          </div>
          <div>
            <div className="field-label">Sessions</div>
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
            {sessionError ? <p className="muted">{sessionError}</p> : null}
          </div>
          {user.name ? (
            <div>
              <div className="field-label">Name</div>
              <p>{user.name}</p>
            </div>
          ) : null}
          <div>
            <div className="field-label">Role</div>
            <Badge tone={user.role === "admin" ? "info" : "default"}>{user.role}</Badge>
          </div>
          <Button variant="danger" className="btn-block" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
