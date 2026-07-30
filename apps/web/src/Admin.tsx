import { useCallback, useEffect, useState } from "react";
import { Computers } from "./Computers";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Brand, Button, Field, Input, PageHeader, Select, TextArea } from "./ui";

interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "invited";
  created_at: string;
}

interface GlobalRulesDto {
  filename: "NORN.md";
  content: string;
  version: number;
  updated_at: string | null;
}

interface ArchivedProjectSummary {
  id: string;
  name: string;
  description: string;
  archived_at: string;
}

async function adminRequest<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
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

type AdminTab = "users" | "computers" | "rules" | "archive";

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
  embedded = false,
}: {
  onClose: () => void;
  onUnauthorized: () => void;
  embedded?: boolean;
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [globalRules, setGlobalRules] = useState<GlobalRulesDto | null>(null);
  const [globalRulesDraft, setGlobalRulesDraft] = useState("");
  const [globalRulesSaving, setGlobalRulesSaving] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectSummary[] | null>(null);
  const [restoringProjectId, setRestoringProjectId] = useState<string | null>(null);
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
      const [nextUsers, nextRules, nextArchivedProjects] = await Promise.all([
        adminRequest<UserSummary[]>("GET", "/api/admin/users"),
        adminRequest<GlobalRulesDto>("GET", "/api/v2/admin/rules"),
        adminRequest<ArchivedProjectSummary[]>("GET", "/api/admin/projects/archived"),
      ]);
      setUsers(nextUsers);
      setGlobalRules(nextRules);
      setGlobalRulesDraft(nextRules.content);
      setArchivedProjects(nextArchivedProjects);
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

  const saveGlobalRules = useCallback(async () => {
    setGlobalRulesSaving(true);
    setError(null);
    try {
      const next = await adminRequest<GlobalRulesDto>("PUT", "/api/v2/admin/rules", {
        content: globalRulesDraft,
      });
      setGlobalRules(next);
      setGlobalRulesDraft(next.content);
    } catch (e) {
      fail(e);
    } finally {
      setGlobalRulesSaving(false);
    }
  }, [fail, globalRulesDraft]);

  const restoreProject = useCallback(
    async (project: ArchivedProjectSummary) => {
      if (
        !window.confirm(
          `Unarchive "${project.name}"?\n\nIt will return to Portfolio and the active project menu.`,
        )
      ) {
        return;
      }
      setRestoringProjectId(project.id);
      setError(null);
      try {
        await adminRequest("POST", `/api/admin/projects/${encodeURIComponent(project.id)}/restore`);
        await refresh();
      } catch (e) {
        fail(e);
      } finally {
        setRestoringProjectId(null);
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
        <PageHeader
          eyebrow="Workspace controls"
          title="Administration"
          lede="Manage members, computers, global agent rules, and archived projects."
        />
        {error ? <Alert testId="admin-error">{error}</Alert> : null}

        <nav className="admin-tabs" role="tablist" aria-label="Administration sections">
          {(
            [
              ["users", "Users"],
              ["computers", "Computers"],
              ["rules", "Rules"],
              ["archive", "Archive"],
            ] as const
          ).map(([tab, label]) => (
            <button
              key={tab}
              id={`admin-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`admin-panel-${tab}`}
              className={activeTab === tab ? "is-active" : ""}
              onClick={() => setActiveTab(tab)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div
          id="admin-panel-computers"
          role="tabpanel"
          aria-labelledby="admin-tab-computers"
          hidden={activeTab !== "computers"}
        >
          {activeTab === "computers" ? (
            <Computers embedded onUnauthorized={onUnauthorized} />
          ) : null}
        </div>

        <section
          className="card admin-archived-projects"
          aria-labelledby="admin-tab-archive archived-projects-heading"
          id="admin-panel-archive"
          role="tabpanel"
          hidden={activeTab !== "archive"}
        >
          <div className="section-head">
            <div>
              <div className="eyebrow">Project recovery</div>
              <h2 id="archived-projects-heading">Archived projects</h2>
            </div>
            <Badge tone="info">{archivedProjects?.length ?? 0}</Badge>
          </div>
          {archivedProjects === null ? (
            <p className="muted">Loading archived projects…</p>
          ) : archivedProjects.length === 0 ? (
            <p className="muted">No archived projects.</p>
          ) : (
            <ul className="admin-archived-list" data-testid="archived-project-list">
              {archivedProjects.map((project) => (
                <li key={project.id}>
                  <div>
                    <strong>{project.name}</strong>
                    <small>Archived {new Date(project.archived_at).toLocaleDateString()}</small>
                  </div>
                  <Button
                    className="btn-small"
                    disabled={restoringProjectId === project.id}
                    onClick={() => void restoreProject(project)}
                  >
                    {restoringProjectId === project.id ? "Unarchiving…" : "Unarchive"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="admin-global-rules"
          aria-labelledby="admin-tab-rules global-rules-heading"
          id="admin-panel-rules"
          role="tabpanel"
          hidden={activeTab !== "rules"}
        >
          <div className="section-head">
            <div>
              <div className="eyebrow">Global agent rules</div>
              <h3 id="global-rules-heading">{globalRules?.filename ?? "NORN.md"}</h3>
            </div>
            {globalRules?.version ? (
              <span className="mono muted">v{globalRules.version}</span>
            ) : null}
          </div>
          <p className="muted">
            These instructions are included in every project briefing. A project’s own NORN.md can
            add more specific rules.
          </p>
          {globalRules ? (
            <>
              <TextArea
                className="global-rules-editor"
                aria-label="Global NORN.md"
                value={globalRulesDraft}
                placeholder="# Global rules&#10;&#10;- Share a concise progress update every five minutes."
                onChange={(event) => setGlobalRulesDraft(event.target.value)}
              />
              <div className="settings-save-row">
                <span className="muted">
                  {globalRules.updated_at
                    ? `Last saved ${new Date(globalRules.updated_at).toLocaleString()}`
                    : "No global rules yet"}
                </span>
                <Button
                  variant="primary"
                  disabled={
                    globalRulesSaving || globalRulesDraft.trim() === globalRules.content.trim()
                  }
                  onClick={() => void saveGlobalRules()}
                >
                  {globalRulesSaving ? "Saving…" : "Save global rules"}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">Loading global rules…</p>
          )}
        </section>

        <div
          className="admin-layout"
          id="admin-panel-users"
          role="tabpanel"
          aria-labelledby="admin-tab-users"
          hidden={activeTab !== "users"}
        >
          <section className="card">
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

          <section className="card form-stack">
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

          <section className="card form-stack">
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
      </main>
    </div>
  );
}
