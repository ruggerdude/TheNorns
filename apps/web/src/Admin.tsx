import { useCallback, useEffect, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Brand, Button, Field, Input, PageHeader, Select } from "./ui";
import "./Admin.css";

interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "invited" | "disabled";
  created_at: string;
}

async function adminRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "include",
    headers: authHeaders(body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      payload.message ?? payload.error ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return payload;
}

type InviteOutcome =
  | { ok: true }
  | { ok: false; recoverable: true; message: string; url: string }
  | { ok: false; recoverable: false; message: string };

/** A 502 means the invited user exists but email delivery failed, so the
 * response still carries a link the administrator can share manually. */
async function inviteRequest(body: unknown): Promise<InviteOutcome> {
  const response = await fetch("/api/admin/users/invite", {
    method: "POST",
    credentials: "include",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    invite_url?: string;
  };
  if (response.status === 201) return { ok: true };
  if (response.status === 502) {
    return {
      ok: false,
      recoverable: true,
      message: payload.message ?? "The invite email failed to send.",
      url: payload.invite_url ?? "",
    };
  }
  return {
    ok: false,
    recoverable: false,
    message: payload.message ?? payload.error ?? `request failed: ${response.status}`,
  };
}

export function Admin({
  onClose,
  onUnauthorized,
  currentUserId,
  onCurrentUserRoleChanged,
  embedded = false,
}: {
  onClose: () => void;
  onUnauthorized: () => void;
  currentUserId?: string;
  onCurrentUserRoleChanged?: (role: "admin" | "member") => void;
  embedded?: boolean;
}): React.ReactElement {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleBusyUserId, setRoleBusyUserId] = useState<string | null>(null);
  const [actionPanel, setActionPanel] = useState<"invite" | "create" | null>(null);

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
    (caught: unknown) => {
      if (caught instanceof UnauthorizedError) onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    },
    [onUnauthorized],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setUsers(await adminRequest<UserSummary[]>("GET", "/api/admin/users"));
    } catch (caught) {
      fail(caught);
    }
  }, [fail]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (actionPanel === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionPanel(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [actionPanel]);

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
    } catch (caught) {
      fail(caught);
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
    } catch (caught) {
      fail(caught);
    } finally {
      setInviting(false);
    }
  }, [inviteEmail, inviteName, inviteRole, fail, refresh]);

  const changeRole = useCallback(
    async (user: UserSummary) => {
      const nextRole = user.role === "admin" ? "member" : "admin";
      const confirmed = window.confirm(
        nextRole === "admin"
          ? `Make ${user.email} an administrator?`
          : `Remove administrator access from ${user.email}?`,
      );
      if (!confirmed) return;

      setRoleBusyUserId(user.id);
      setError(null);
      try {
        const updated = await adminRequest<UserSummary>(
          "PATCH",
          `/api/admin/users/${encodeURIComponent(user.id)}/role`,
          { role: nextRole },
        );
        setUsers(
          (current) =>
            current?.map((candidate) => (candidate.id === updated.id ? updated : candidate)) ??
            null,
        );
        if (updated.id === currentUserId) onCurrentUserRoleChanged?.(updated.role);
      } catch (caught) {
        fail(caught);
      } finally {
        setRoleBusyUserId(null);
      }
    },
    [currentUserId, fail, onCurrentUserRoleChanged],
  );

  const removeUser = useCallback(
    async (id: string, email: string) => {
      if (!window.confirm(`Remove ${email}? This immediately ends any active session.`)) return;
      try {
        await adminRequest("DELETE", `/api/admin/users/${encodeURIComponent(id)}`);
        await refresh();
      } catch (caught) {
        fail(caught);
      }
    },
    [fail, refresh],
  );

  return (
    <div className={embedded ? "embedded-page-view" : "full-page-view"} data-testid="admin-panel">
      {!embedded ? (
        <header className="full-page-header">
          <div className="full-page-header-title">
            <Brand />
            <span>Administration</span>
          </div>
          <Button variant="ghost" className="btn-small" onClick={onClose}>
            Close
          </Button>
        </header>
      ) : null}
      <main className="page-container admin-page">
        <div className="admin-page-heading">
          <PageHeader
            eyebrow="Workspace administration"
            title="People"
            lede="Manage membership, invitations, and administrator access."
          />
          <div className="admin-primary-actions" aria-label="People actions">
            <Button onClick={() => setActionPanel("create")}>Create manually</Button>
            <Button variant="primary" onClick={() => setActionPanel("invite")}>
              Invite people
            </Button>
          </div>
        </div>
        {error ? <Alert testId="admin-error">{error}</Alert> : null}

        <div className="admin-layout">
          <section className="admin-roster" aria-labelledby="admin-roster-title">
            <div className="admin-section-heading">
              <div>
                <h2 id="admin-roster-title">Workspace members</h2>
                <p>People with access to projects and conversations in this workspace.</p>
              </div>
              <span className="admin-member-count" aria-label={`${users?.length ?? 0} members`}>
                {users === null ? "—" : users.length}
              </span>
            </div>
            {users === null ? (
              <p className="admin-loading muted">Loading members…</p>
            ) : (
              <ul className="user-list" data-testid="user-list">
                {users.map((user) => (
                  <li key={user.id} className="user-row">
                    <div className="user-identity">
                      <span className="user-avatar" aria-hidden="true">
                        {(user.name ?? user.email).trim().slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{user.name ?? user.email}</strong>
                        {user.name ? <span className="user-email">{user.email}</span> : null}
                      </div>
                    </div>
                    <div className="user-access">
                      <div className="meta" aria-label={`${user.role}, ${user.status}`}>
                        <Badge tone={user.role === "admin" ? "info" : "default"}>{user.role}</Badge>{" "}
                        <Badge tone={user.status === "active" ? "success" : "warn"}>
                          {user.status}
                        </Badge>
                      </div>
                    </div>
                    <div className="user-row-actions">
                      {user.status !== "disabled" ? (
                        <Button
                          className="btn-small"
                          disabled={roleBusyUserId === user.id}
                          onClick={() => void changeRole(user)}
                        >
                          {roleBusyUserId === user.id
                            ? "Saving…"
                            : user.role === "admin"
                              ? "Remove admin"
                              : "Make admin"}
                        </Button>
                      ) : null}
                      <Button
                        variant="danger"
                        className="btn-small"
                        onClick={() => void removeUser(user.id, user.email)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {actionPanel ? (
          <div
            className="admin-drawer-backdrop"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) setActionPanel(null);
            }}
          >
            <dialog
              open
              className="admin-drawer"
              aria-modal="true"
              aria-labelledby="admin-drawer-title"
            >
              <div className="admin-drawer-header">
                <div>
                  <span className="eyebrow">Add workspace access</span>
                  <h2 id="admin-drawer-title">
                    {actionPanel === "invite" ? "Invite people" : "Create a member"}
                  </h2>
                  <p>
                    {actionPanel === "invite"
                      ? "Send a secure invitation so your teammate can choose their password."
                      : "Create credentials directly when email invitation is not appropriate."}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="btn-small"
                  aria-label="Close people panel"
                  onClick={() => setActionPanel(null)}
                >
                  Close
                </Button>
              </div>

              <div className="admin-method-switch" aria-label="Choose how to add a member">
                <Button
                  variant={actionPanel === "invite" ? "primary" : "ghost"}
                  onClick={() => setActionPanel("invite")}
                >
                  Invite by email
                </Button>
                <Button
                  variant={actionPanel === "create" ? "primary" : "ghost"}
                  onClick={() => setActionPanel("create")}
                >
                  Create manually
                </Button>
              </div>

              {actionPanel === "create" ? (
                <div className="admin-drawer-form form-stack">
                  <Field label="Email">
                    <Input
                      type="email"
                      value={addEmail}
                      onChange={(event) => setAddEmail(event.target.value)}
                      placeholder="teammate@example.com"
                    />
                  </Field>
                  <Field label="Name (optional)">
                    <Input value={addName} onChange={(event) => setAddName(event.target.value)} />
                  </Field>
                  <Field label="Password">
                    <Input
                      type="password"
                      value={addPassword}
                      onChange={(event) => setAddPassword(event.target.value)}
                      placeholder="At least 8 characters"
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label="Role">
                    <Select
                      value={addRole}
                      onChange={(event) => setAddRole(event.target.value as "admin" | "member")}
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
                    {adding ? "Creating…" : "Create member"}
                  </Button>
                </div>
              ) : (
                <div className="admin-drawer-form form-stack">
                  <Field label="Email">
                    <Input
                      type="email"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                      placeholder="teammate@example.com"
                    />
                  </Field>
                  <Field label="Name (optional)">
                    <Input
                      value={inviteName}
                      onChange={(event) => setInviteName(event.target.value)}
                    />
                  </Field>
                  <Field label="Role">
                    <Select
                      value={inviteRole}
                      onChange={(event) => setInviteRole(event.target.value as "admin" | "member")}
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
                </div>
              )}
            </dialog>
          </div>
        ) : null}
      </main>
    </div>
  );
}
