import { useCallback, useEffect, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Field, Input, Select } from "./ui";

interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "invited";
  created_at: string;
}

async function adminRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(json.message ?? json.error ?? `request failed: ${res.status}`, res.status);
  }
  return json;
}

type InviteOutcome =
  | { ok: true }
  | { ok: false; recoverable: true; message: string; url: string }
  | { ok: false; recoverable: false; message: string };

/** Unlike adminRequest, a 502 here (email delivery failed) is not a plain
 *  error — the invited user record was still created, and the response
 *  carries invite_url so the admin can share it manually. */
async function inviteRequest(body: unknown): Promise<InviteOutcome> {
  const res = await fetch("/api/admin/users/invite", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const json = (await res.json()) as { error?: string; message?: string; invite_url?: string };
  if (res.status === 201) return { ok: true };
  if (res.status === 502) {
    return {
      ok: false,
      recoverable: true,
      message: json.message ?? "The invite email failed to send.",
      url: json.invite_url ?? "",
    };
  }
  return {
    ok: false,
    recoverable: false,
    message: json.message ?? json.error ?? `request failed: ${res.status}`,
  };
}

export function Admin({
  onClose,
  onUnauthorized,
}: {
  onClose: () => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [addEmail, setAddEmail] = useState("");
  const [addName, setAddName] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [addRole, setAddRole] = useState<"admin" | "member">("member");
  const [adding, setAdding] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<{ message: string; url: string } | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof UnauthorizedError) onUnauthorized();
      else setError(e instanceof Error ? e.message : String(e));
    },
    [onUnauthorized],
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setUsers(await adminRequest<UserSummary[]>("GET", "/api/admin/users"));
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addUser = useCallback(async () => {
    setAdding(true);
    setError(null);
    try {
      await adminRequest("POST", "/api/admin/users", {
        email: addEmail.trim(),
        name: addName.trim() || undefined,
        password: addPassword,
        role: addRole,
      });
      setAddEmail("");
      setAddName("");
      setAddPassword("");
      setAddRole("member");
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setAdding(false);
    }
  }, [addEmail, addName, addPassword, addRole, fail, refresh]);

  const inviteUser = useCallback(async () => {
    setInviting(true);
    setError(null);
    setInviteNotice(null);
    try {
      const outcome = await inviteRequest({
        email: inviteEmail.trim(),
        name: inviteName.trim() || undefined,
        role: inviteRole,
      });
      if (!outcome.ok && !outcome.recoverable) {
        setError(outcome.message);
        return;
      }
      if (!outcome.ok) setInviteNotice({ message: outcome.message, url: outcome.url });
      setInviteEmail("");
      setInviteName("");
      setInviteRole("member");
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setInviting(false);
    }
  }, [inviteEmail, inviteName, inviteRole, fail, refresh]);

  const removeUser = useCallback(
    async (id: string, email: string) => {
      if (!window.confirm(`Remove ${email}? This immediately ends any active session.`)) return;
      try {
        await adminRequest("DELETE", `/api/admin/users/${id}`);
        await refresh();
      } catch (e) {
        fail(e);
      }
    },
    [fail, refresh],
  );

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-backdrop" aria-label="Dismiss" onClick={onClose} />
      <div className="modal modal-wide card" data-testid="admin-panel">
        <div className="section-head">
          <h2>User administration</h2>
          <Button variant="ghost" className="btn-small" onClick={onClose}>
            Close
          </Button>
        </div>
        {error ? <Alert testId="admin-error">{error}</Alert> : null}

        <div className="admin-layout">
          <section>
            <h3>Users</h3>
            {users === null ? (
              <p className="muted">Loading…</p>
            ) : (
              <ul className="user-list" data-testid="user-list">
                {users.map((u) => (
                  <li key={u.id} className="user-row">
                    <div>
                      <strong>{u.email}</strong>
                      {u.name ? <span className="muted"> · {u.name}</span> : null}
                      <div className="meta">
                        <Badge tone={u.role === "admin" ? "info" : "default"}>{u.role}</Badge>{" "}
                        <Badge tone={u.status === "active" ? "success" : "warn"}>{u.status}</Badge>
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      className="btn-small"
                      onClick={() => void removeUser(u.id, u.email)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="form-stack">
            <h3>Add a user manually</h3>
            <Field label="Email">
              <Input
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="teammate@example.com"
              />
            </Field>
            <Field label="Name (optional)">
              <Input value={addName} onChange={(e) => setAddName(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={addPassword}
                onChange={(e) => setAddPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Role">
              <Select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as "admin" | "member")}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button
              variant="primary"
              className="btn-block"
              disabled={adding || !addEmail.trim() || addPassword.length < 8}
              onClick={() => void addUser()}
            >
              {adding ? "Adding…" : "Add user"}
            </Button>
          </section>

          <section className="form-stack">
            <h3>Invite by email</h3>
            <Field label="Email">
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@example.com"
              />
            </Field>
            <Field label="Name (optional)">
              <Input value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
            </Field>
            <Field label="Role">
              <Select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button
              variant="primary"
              className="btn-block"
              disabled={inviting || !inviteEmail.trim()}
              onClick={() => void inviteUser()}
            >
              {inviting ? "Sending…" : "Send invite"}
            </Button>
            {inviteNotice ? (
              <Alert testId="invite-notice">
                {inviteNotice.message} Share this link manually:{" "}
                <span className="mono">{inviteNotice.url}</span>
              </Alert>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
