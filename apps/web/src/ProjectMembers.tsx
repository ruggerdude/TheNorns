import { useCallback, useEffect, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import "./ProjectMembers.css";
import { Alert, Badge, Button, Field, Select, Spinner } from "./ui";

interface ProjectAccessDecision {
  owner_user_id: string | null;
  can_access: boolean;
  can_manage_members: boolean;
  source: "admin" | "owner" | "membership" | "legacy_unowned" | "none";
}

interface ProjectMember {
  user_id: string;
  email: string;
  name: string | null;
  workspace_role: "admin" | "member";
  identity_status: "active" | "invited" | "disabled";
  project_role: "owner" | "member";
  membership_status: "active" | "removed";
}

interface ProjectMembersResponse {
  owner_user_id: string | null;
  members: ProjectMember[];
}

interface MemberCandidate {
  user_id: string;
  email: string;
  name: string | null;
  workspace_role: "admin" | "member";
}

interface MemberCandidatesResponse {
  candidates: MemberCandidate[];
}

async function projectMembersRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: authHeaders(body !== undefined),
    credentials: "include",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      payload.message ?? payload.error ?? `Member request failed: ${response.status}`,
      response.status,
    );
  }
  return payload;
}

function memberLabel(member: Pick<ProjectMember, "name" | "email">): string {
  return member.name?.trim() || member.email;
}

export function ProjectMembers({
  projectId,
  onUnauthorized,
}: {
  projectId: string;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [access, setAccess] = useState<ProjectAccessDecision | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [candidates, setCandidates] = useState<MemberCandidate[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleFailure = useCallback(
    (failure: unknown, fallback: string) => {
      if (failure instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      if (failure instanceof ApiError && failure.status === 403) {
        setError("You do not have permission to manage this project's members.");
        return;
      }
      setError(failure instanceof Error ? failure.message : fallback);
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextAccess = await projectMembersRequest<ProjectAccessDecision>(
        `/api/v2/projects/${projectId}/access`,
      );
      setAccess(nextAccess);
      if (!nextAccess.can_access) {
        setMembers([]);
        setCandidates([]);
        setError("You do not have access to this project.");
        return;
      }
      const nextMembers = await projectMembersRequest<ProjectMembersResponse>(
        `/api/v2/projects/${projectId}/members`,
      );
      setMembers(nextMembers.members.filter((member) => member.membership_status === "active"));
      if (nextAccess.can_manage_members) {
        const available = await projectMembersRequest<MemberCandidatesResponse>(
          `/api/v2/projects/${projectId}/member-candidates`,
        );
        setCandidates(available.candidates);
        setSelectedUserId((current) =>
          available.candidates.some((candidate) => candidate.user_id === current) ? current : "",
        );
      } else {
        setCandidates([]);
        setSelectedUserId("");
      }
    } catch (failure) {
      handleFailure(failure, "Project members could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [handleFailure, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addMember = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedUserId) return;
    setBusyUserId(selectedUserId);
    setError(null);
    setNotice(null);
    try {
      await projectMembersRequest(`/api/v2/projects/${projectId}/members`, "POST", {
        user_id: selectedUserId,
      });
      setNotice("Member added.");
      await load();
    } catch (failure) {
      handleFailure(failure, "The member could not be added.");
    } finally {
      setBusyUserId(null);
    }
  };

  const removeMember = async (member: ProjectMember) => {
    if (member.project_role === "owner" || member.user_id === access?.owner_user_id) return;
    setBusyUserId(member.user_id);
    setError(null);
    setNotice(null);
    try {
      await projectMembersRequest(
        `/api/v2/projects/${projectId}/members/${member.user_id}`,
        "DELETE",
      );
      setNotice("Member removed.");
      await load();
    } catch (failure) {
      handleFailure(failure, "The member could not be removed.");
    } finally {
      setBusyUserId(null);
    }
  };

  if (loading && access === null) {
    return <Spinner label="Loading project members…" />;
  }

  return (
    <section className="project-members" aria-labelledby="project-members-title">
      <div className="section-head">
        <div>
          <div className="eyebrow">Access</div>
          <h2 id="project-members-title">Project members</h2>
        </div>
        {access?.can_manage_members ? <Badge tone="info">Manage access</Badge> : null}
      </div>

      {error ? (
        <div>
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <output className="project-members-notice" aria-live="polite">
          {notice}
        </output>
      ) : null}

      {access?.can_access ? (
        <>
          <div className="project-members-table-wrap">
            <table className="project-members-table">
              <caption className="sr-only">Active project members</caption>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Project role</th>
                  <th scope="col">Workspace role</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const owner =
                    member.project_role === "owner" || member.user_id === access.owner_user_id;
                  return (
                    <tr key={member.user_id}>
                      <td>
                        <strong>{memberLabel(member)}</strong>
                        {member.name ? <span>{member.email}</span> : null}
                      </td>
                      <td>{owner ? "Owner" : "Member"}</td>
                      <td>{member.workspace_role === "admin" ? "Administrator" : "Member"}</td>
                      <td>
                        {owner ? (
                          <span className="muted">Owner cannot be removed</span>
                        ) : access.can_manage_members ? (
                          <Button
                            className="btn-small"
                            variant="danger"
                            disabled={busyUserId !== null}
                            aria-label={`Remove ${memberLabel(member)}`}
                            onClick={() => void removeMember(member)}
                          >
                            {busyUserId === member.user_id ? "Removing…" : "Remove"}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {access.can_manage_members ? (
            <form className="project-members-add" onSubmit={(event) => void addMember(event)}>
              <Field label="Add an existing workspace member">
                <Select
                  value={selectedUserId}
                  disabled={busyUserId !== null || candidates.length === 0}
                  onChange={(event) => setSelectedUserId(event.target.value)}
                >
                  <option value="">
                    {candidates.length === 0 ? "No members available to add" : "Select a member"}
                  </option>
                  {candidates.map((candidate) => (
                    <option key={candidate.user_id} value={candidate.user_id}>
                      {candidate.name?.trim()
                        ? `${candidate.name} — ${candidate.email}`
                        : candidate.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="primary"
                type="submit"
                disabled={!selectedUserId || busyUserId !== null}
              >
                {busyUserId === selectedUserId ? "Adding…" : "Add member"}
              </Button>
            </form>
          ) : (
            <p className="muted project-members-readonly">
              You can view this member list. The project owner or a workspace administrator manages
              access.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
