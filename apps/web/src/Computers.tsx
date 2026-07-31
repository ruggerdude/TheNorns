import { OwnedDeviceProjection, type OwnedDeviceProjectionT } from "@norns/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Field, Input, PageHeader, Select, Spinner, TextArea } from "./ui";
import "./Computers.css";

type Device = OwnedDeviceProjectionT;

const LocalAgentDownloadsProjection = z
  .object({
    windows: z.string().url().nullable(),
    macos: z.string().url().nullable(),
    macos_release: z.enum(["notarized", "unsigned_preview"]).nullable(),
  })
  .strict();

type LocalAgentDownloads = z.infer<typeof LocalAgentDownloadsProjection>;

const RepositoryAccessProjection = z
  .object({
    device_id: z.string().trim().min(1),
    registrations: z.array(
      z
        .object({
          registration_id: z.string().trim().min(1),
          repository_id: z.string().trim().min(1),
          repository_display_name: z.string().trim().min(1).max(240),
          default_branch: z.string().trim().min(1).max(240),
          state: z.enum(["active", "revoked"]),
          grants: z.array(
            z
              .object({
                grant_id: z.string().trim().min(1),
                project_id: z.string().trim().min(1),
                state: z.enum(["active", "revoked"]),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    eligible_projects: z.array(
      z
        .object({
          project_id: z.string().trim().min(1),
          name: z.string().trim().min(1).max(200),
        })
        .strict(),
    ),
  })
  .strict();

type RepositoryAccess = z.infer<typeof RepositoryAccessProjection>;
type RepositoryRegistration = RepositoryAccess["registrations"][number];

function unwrapDevice(payload: unknown): Device {
  const candidate =
    payload && typeof payload === "object" && "device" in payload
      ? (payload as { device: unknown }).device
      : payload;
  return OwnedDeviceProjection.parse(candidate);
}

function unwrapDevices(payload: unknown): Device[] {
  const candidate =
    payload && typeof payload === "object" && "devices" in payload
      ? (payload as { devices: unknown }).devices
      : payload;
  if (!Array.isArray(candidate)) throw new Error("Computer inventory response is invalid.");
  return candidate.map(unwrapDevice);
}

function unwrapLocalAgentDownloads(payload: unknown): LocalAgentDownloads | null {
  if (!payload || typeof payload !== "object" || !("downloads" in payload)) return null;
  const parsed = LocalAgentDownloadsProjection.safeParse(
    (payload as { downloads: unknown }).downloads,
  );
  return parsed.success ? parsed.data : null;
}

async function deviceRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...authHeaders(Boolean(init?.body)),
      ...init?.headers,
    },
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = payload as { error?: string; message?: string } | null;
    throw new ApiError(
      errorPayload?.message ??
        errorPayload?.error ??
        `Computer request failed (${response.status}).`,
      response.status,
      errorPayload?.error ?? null,
    );
  }
  return payload;
}

function describeDeviceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You do not have permission to manage this computer.";
    if (error.status === 404) return "This computer is no longer available.";
    if (error.status === 409)
      return "The computer changed while this page was open. Refresh and try again.";
    return error.message;
  }
  return error instanceof Error ? error.message : "The computer service is unavailable.";
}

function unwrapRepositoryAccess(payload: unknown, deviceId: string): RepositoryAccess {
  const parsed = RepositoryAccessProjection.safeParse(payload);
  if (!parsed.success || parsed.data.device_id !== deviceId) {
    throw new Error("Repository access response is invalid.");
  }

  const registrationIds = new Set<string>();
  const grantIds = new Set<string>();
  for (const registration of parsed.data.registrations) {
    if (registrationIds.has(registration.registration_id)) {
      throw new Error("Repository access response is invalid.");
    }
    registrationIds.add(registration.registration_id);
    for (const grant of registration.grants) {
      if (grantIds.has(grant.grant_id)) {
        throw new Error("Repository access response is invalid.");
      }
      grantIds.add(grant.grant_id);
    }
  }

  const projectIds = new Set<string>();
  for (const project of parsed.data.eligible_projects) {
    if (projectIds.has(project.project_id)) {
      throw new Error("Repository access response is invalid.");
    }
    projectIds.add(project.project_id);
  }
  return parsed.data;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function osLabel(device: Device): string {
  const family = {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
    other: "Other OS",
  }[device.os_family];
  return device.os_version ? `${family} ${device.os_version}` : family;
}

function lastSeen(value: string | null): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function fingerprint(value: string): string {
  return value.match(/.{1,4}/g)?.join(" ") ?? value;
}

type StatusTone = "default" | "success" | "warn" | "info";

function statusTone(
  dimension: "availability" | "compatibility" | "workload" | "access",
  value: string,
): StatusTone {
  if (dimension === "availability") {
    return value === "online" ? "success" : value === "connecting" ? "info" : "default";
  }
  if (dimension === "compatibility") {
    return value === "ready" ? "success" : value === "update_required" ? "warn" : "info";
  }
  if (dimension === "workload") return value === "busy" ? "info" : "default";
  return value === "owned" ? "success" : "default";
}

function Status({
  dimension,
  value,
}: {
  dimension: "availability" | "compatibility" | "workload" | "access";
  value: string;
}): React.ReactElement {
  return (
    <span className="computer-status">
      <span className="computer-status-label">{humanize(dimension)}</span>
      <Badge tone={statusTone(dimension, value)}>{humanize(value)}</Badge>
    </span>
  );
}

function ComputerCard({
  device,
  selected,
  onSelect,
}: {
  device: Device;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <li>
      <button
        type="button"
        className={`computer-card${selected ? " is-selected" : ""}${
          device.lifecycle === "revoked" ? " is-revoked" : ""
        }`}
        aria-pressed={selected}
        aria-label={`View details for ${device.name}`}
        onClick={onSelect}
      >
        <span className="computer-card-head">
          <span>
            <strong>{device.name}</strong>
            {device.location_label ? <small>{device.location_label}</small> : null}
          </span>
          <span className="computer-card-os">{osLabel(device)}</span>
        </span>
        <span className="computer-card-statuses" aria-label={`${device.name} current status`}>
          <Status dimension="availability" value={device.status.availability} />
          <Status dimension="workload" value={device.status.workload} />
        </span>
        <span className="computer-card-last-seen">
          <span>Last seen</span>
          <time dateTime={device.last_seen_at ?? undefined}>{lastSeen(device.last_seen_at)}</time>
        </span>
      </button>
    </li>
  );
}

function ManualUpdateGuidance({ device }: { device: Device }): React.ReactElement {
  const isRevoked = device.lifecycle === "revoked";
  return (
    <section className="computer-detail-section" aria-labelledby="computer-update-title">
      <div className="computer-detail-heading">
        <div>
          <div className="eyebrow">Maintenance</div>
          <h3 id="computer-update-title">Manual updates</h3>
        </div>
        {!isRevoked && device.status.compatibility === "update_required" ? (
          <Badge tone="warn">Update required</Badge>
        ) : null}
      </div>
      <p className="muted">
        {isRevoked
          ? "This installation is revoked. Updating or reinstalling it does not restore access; enroll it as a new computer if it will be used again."
          : device.status.compatibility === "update_required"
            ? "Install a newer signed Local Agent package on this computer before using it for new work."
            : "To update, install a newer signed Local Agent package on this computer."}{" "}
        {!isRevoked
          ? "The installer stops the service safely, preserves local state, replaces the binaries, and restarts it. Uninstalling the package does not revoke this computer, and revoking it does not uninstall the package."
          : "Uninstalling the package remains a separate local action."}
      </p>
    </section>
  );
}

function activeGrants(registration: RepositoryRegistration): RepositoryRegistration["grants"] {
  return registration.grants.filter((grant) => grant.state === "active");
}

function RepositoryAccessManager({
  deviceId,
  lifecycle,
  onUnauthorized,
}: {
  deviceId: string;
  lifecycle: Device["lifecycle"];
  onUnauthorized: () => void;
}): React.ReactElement | null {
  const [access, setAccess] = useState<RepositoryAccess | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(lifecycle === "active");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const [confirmingGrantId, setConfirmingGrantId] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const requestGeneration = useRef(0);

  const acceptProjection = useCallback(
    (payload: unknown): RepositoryAccess => {
      const projected = unwrapRepositoryAccess(payload, deviceId);
      setAccess(projected);
      setSelections((current) => {
        const next: Record<string, string> = {};
        for (const registration of projected.registrations) {
          const grantedProjects = new Set(
            activeGrants(registration).map((grant) => grant.project_id),
          );
          const candidates = projected.eligible_projects.filter(
            (project) => !grantedProjects.has(project.project_id),
          );
          const selected = current[registration.registration_id];
          next[registration.registration_id] =
            selected && candidates.some((project) => project.project_id === selected)
              ? selected
              : (candidates[0]?.project_id ?? "");
        }
        return next;
      });
      return projected;
    },
    [deviceId],
  );

  const fetchAccess = useCallback(
    async (clearError = true): Promise<void> => {
      const generation = ++requestGeneration.current;
      if (clearError) setError(null);
      setLoading(true);
      try {
        const payload = await deviceRequest(
          `/api/devices/${encodeURIComponent(deviceId)}/repository-access`,
        );
        if (generation !== requestGeneration.current) return;
        acceptProjection(payload);
        setUnavailable(false);
      } catch (caught) {
        if (generation !== requestGeneration.current) return;
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (caught instanceof ApiError && caught.status === 404) {
          setUnavailable(true);
          setAccess(null);
          return;
        }
        setError(
          caught instanceof ApiError && caught.status === 409
            ? "Repository access changed while this page was open. Reload it and try again."
            : caught instanceof Error
              ? caught.message
              : "Repository access is unavailable.",
        );
      } finally {
        if (generation === requestGeneration.current) setLoading(false);
      }
    },
    [acceptProjection, deviceId, onUnauthorized],
  );

  useEffect(() => {
    if (lifecycle === "active") {
      void fetchAccess();
    } else {
      requestGeneration.current += 1;
      setLoading(false);
    }
    return () => {
      requestGeneration.current += 1;
    };
  }, [fetchAccess, lifecycle]);

  const handleMutationError = async (caught: unknown): Promise<void> => {
    if (caught instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    if (caught instanceof ApiError && caught.status === 404) {
      setError(
        "That repository access choice is no longer available. The current state was reloaded.",
      );
      await fetchAccess(false);
      return;
    }
    if (caught instanceof ApiError && caught.status === 409) {
      setError(
        "Repository access changed while this page was open. The current state was reloaded.",
      );
      await fetchAccess(false);
      return;
    }
    setError(caught instanceof Error ? caught.message : "Repository access could not be changed.");
  };

  const grantProject = async (registrationId: string, projectId: string): Promise<void> => {
    if (!projectId || mutating) return;
    setMutating(`grant:${registrationId}`);
    setError(null);
    setNotice(null);
    try {
      acceptProjection(
        await deviceRequest(`/api/devices/${encodeURIComponent(deviceId)}/repository-grants`, {
          method: "POST",
          body: JSON.stringify({
            repository_registration_id: registrationId,
            project_id: projectId,
          }),
        }),
      );
      const project = access?.eligible_projects.find(
        (candidate) => candidate.project_id === projectId,
      );
      setNotice(`Repository access granted${project ? ` to ${project.name}` : ""}.`);
    } catch (caught) {
      await handleMutationError(caught);
    } finally {
      setMutating(null);
    }
  };

  const revokeGrant = async (grantId: string, projectName: string): Promise<void> => {
    if (mutating) return;
    setMutating(`revoke:${grantId}`);
    setError(null);
    setNotice(null);
    try {
      acceptProjection(
        await deviceRequest(
          `/api/devices/${encodeURIComponent(deviceId)}/repository-grants/${encodeURIComponent(
            grantId,
          )}/revoke`,
          {
            method: "POST",
            body: JSON.stringify({}),
          },
        ),
      );
      setConfirmingGrantId(null);
      setNotice(`Repository access removed from ${projectName}. Local files were not deleted.`);
    } catch (caught) {
      await handleMutationError(caught);
    } finally {
      setMutating(null);
    }
  };

  if (lifecycle === "revoked") {
    return (
      <section className="computer-detail-section" aria-labelledby="computer-access-title">
        <div className="eyebrow">Authorization</div>
        <h3 id="computer-access-title">Repository access</h3>
        <p className="muted">
          This computer is revoked. Its project grants can no longer authorize work.
        </p>
      </section>
    );
  }

  if (unavailable) return null;

  const projectNames = new Map(
    access?.eligible_projects.map((project) => [project.project_id, project.name]),
  );
  const activeGrantCount =
    access?.registrations.reduce(
      (count, registration) => count + activeGrants(registration).length,
      0,
    ) ?? 0;

  return (
    <section className="computer-detail-section" aria-labelledby="computer-access-title">
      <div className="computer-detail-heading">
        <div>
          <div className="eyebrow">Authorization</div>
          <h3 id="computer-access-title">Repository access</h3>
        </div>
        {access ? <Badge>{activeGrantCount}</Badge> : null}
      </div>
      <p className="muted">
        Choose which of your projects may use a repository approved on this computer. Removing
        access never deletes local files.
      </p>
      {error ? (
        <div className="computer-access-error">
          <Alert testId="repository-access-error">{error}</Alert>
          <Button
            type="button"
            variant="ghost"
            className="btn-small"
            disabled={loading || Boolean(mutating)}
            onClick={() => void fetchAccess()}
          >
            Reload access
          </Button>
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {notice}
      </div>
      {loading && !access ? (
        <Spinner label="Loading repository access…" />
      ) : access?.registrations.length ? (
        <div className="computer-repository-list">
          {access.registrations.map((registration) => {
            const grants = activeGrants(registration);
            const grantedProjectIds = new Set(grants.map((grant) => grant.project_id));
            const candidates =
              registration.state === "active"
                ? access.eligible_projects.filter(
                    (project) => !grantedProjectIds.has(project.project_id),
                  )
                : [];
            const selection = selections[registration.registration_id] ?? "";
            return (
              <article
                className={`computer-repository${registration.state === "revoked" ? " is-revoked" : ""}`}
                key={registration.registration_id}
                aria-label={registration.repository_display_name}
              >
                <header>
                  <div>
                    <h4>{registration.repository_display_name}</h4>
                    <p>
                      Default branch <strong>{registration.default_branch}</strong>
                    </p>
                  </div>
                  <Badge tone={registration.state === "active" ? "success" : "default"}>
                    {registration.state}
                  </Badge>
                </header>

                {grants.length ? (
                  <ul className="computer-grant-list" aria-label="Active project access">
                    {grants.map((grant) => {
                      const projectName =
                        projectNames.get(grant.project_id) ?? "Unavailable project";
                      return (
                        <li key={grant.grant_id}>
                          <span>
                            <strong>{projectName}</strong>
                            <small>Active project access</small>
                          </span>
                          {confirmingGrantId === grant.grant_id ? (
                            <div className="computer-grant-confirmation">
                              <span>Remove Norns access? Local files will not be deleted.</span>
                              <div>
                                <Button
                                  type="button"
                                  variant="danger"
                                  className="btn-small"
                                  disabled={Boolean(mutating)}
                                  onClick={() => void revokeGrant(grant.grant_id, projectName)}
                                >
                                  {mutating === `revoke:${grant.grant_id}`
                                    ? "Removing…"
                                    : "Remove access"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  className="btn-small"
                                  disabled={Boolean(mutating)}
                                  onClick={() => setConfirmingGrantId(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              className="btn-small"
                              disabled={Boolean(mutating)}
                              aria-label={`Remove ${projectName} access`}
                              onClick={() => setConfirmingGrantId(grant.grant_id)}
                            >
                              Remove
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="muted computer-repository-empty">
                    No projects can use this repository.
                  </p>
                )}

                {candidates.length ? (
                  <form
                    className="computer-grant-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void grantProject(registration.registration_id, selection);
                    }}
                  >
                    <Field label={`Project for ${registration.repository_display_name}`}>
                      <Select
                        value={selection}
                        disabled={Boolean(mutating)}
                        onChange={(event) =>
                          setSelections((current) => ({
                            ...current,
                            [registration.registration_id]: event.target.value,
                          }))
                        }
                      >
                        {candidates.map((project) => (
                          <option key={project.project_id} value={project.project_id}>
                            {project.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!selection || Boolean(mutating)}
                    >
                      {mutating === `grant:${registration.registration_id}`
                        ? "Granting…"
                        : "Grant project access"}
                    </Button>
                  </form>
                ) : registration.state === "active" ? (
                  <p className="muted computer-repository-empty">
                    No additional eligible projects.
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : access ? (
        <p className="muted">
          Approve a repository in the Local Control Center before sharing it with a project.
        </p>
      ) : null}
    </section>
  );
}

function ComputerDetails({
  device,
  loading,
  onRename,
  onRevoke,
  onUnauthorized,
  detailRef,
}: {
  device: Device;
  loading: boolean;
  onRename: (input: { name: string; location_label: string | null }) => Promise<void>;
  onRevoke: (reason: string) => Promise<void>;
  onUnauthorized: () => void;
  detailRef: React.RefObject<HTMLElement | null>;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [name, setName] = useState(device.name);
  const [location, setLocation] = useState(device.location_label ?? "");
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const isRevoked = device.lifecycle === "revoked";

  useEffect(() => {
    setEditing(false);
    setConfirmingRevoke(false);
    setName(device.name);
    setLocation(device.location_label ?? "");
    setConfirmation("");
    setReason("");
  }, [device.location_label, device.name]);

  const saveRename = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onRename({
        name: name.trim(),
        location_label: location.trim() || null,
      });
      setEditing(false);
    } catch {
      // The parent presents the actionable API error and the form stays open.
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (confirmation !== device.name || !reason.trim()) return;
    setSaving(true);
    try {
      await onRevoke(reason.trim());
      setConfirmingRevoke(false);
    } catch {
      // The parent presents the actionable API error and confirmation remains.
    } finally {
      setSaving(false);
    }
  };

  return (
    <article
      ref={detailRef}
      tabIndex={-1}
      className={`card computer-detail${isRevoked ? " is-revoked" : ""}`}
      aria-labelledby="computer-detail-title"
      aria-busy={loading}
    >
      <header className="computer-detail-header">
        <div>
          <div className="eyebrow">Owned computer</div>
          <h2 id="computer-detail-title">{device.name}</h2>
          <p>{device.location_label ?? osLabel(device)}</p>
        </div>
        {!isRevoked ? (
          <div className="computer-detail-actions">
            <Button
              className="btn-small"
              variant="ghost"
              onClick={() => {
                setConfirmingRevoke(false);
                setEditing((current) => !current);
              }}
            >
              Rename
            </Button>
            <Button
              className="btn-small"
              variant="danger"
              onClick={() => {
                setEditing(false);
                setConfirmingRevoke((current) => !current);
              }}
            >
              Revoke
            </Button>
          </div>
        ) : (
          <Badge>Revoked</Badge>
        )}
      </header>

      <div className="computer-status-grid" aria-label="Computer status">
        <Status dimension="availability" value={device.status.availability} />
        <Status dimension="compatibility" value={device.status.compatibility} />
        <Status dimension="workload" value={device.status.workload} />
        <Status dimension="access" value={device.status.access} />
      </div>

      {editing ? (
        <form
          className="computer-management-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <Field label="Computer name">
            <Input
              value={name}
              maxLength={200}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field label="Location label (optional)">
            <Input
              value={location}
              maxLength={200}
              disabled={saving}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Office"
            />
          </Field>
          <div className="computer-form-actions">
            <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {confirmingRevoke ? (
        <form
          className="computer-management-form computer-revoke-form"
          onSubmit={(event) => {
            event.preventDefault();
            void revoke();
          }}
        >
          <div>
            <strong>Revoke this computer?</strong>
            <p className="muted">
              New work and publication will be blocked immediately. An offline or compromised
              computer may not have stopped its local process, and uninstalling remains a separate
              action.
            </p>
          </div>
          <Field label="Reason">
            <TextArea
              value={reason}
              maxLength={500}
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </Field>
          <Field label={`Type ${device.name} to confirm`}>
            <Input
              value={confirmation}
              disabled={saving}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <div className="computer-form-actions">
            <Button
              type="submit"
              variant="danger"
              disabled={saving || confirmation !== device.name || !reason.trim()}
            >
              {saving ? "Revoking…" : "Revoke computer"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setConfirmingRevoke(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <section className="computer-detail-section" aria-labelledby="computer-security-title">
        <div className="eyebrow">Security and protocol</div>
        <h3 id="computer-security-title">Installation details</h3>
        <dl className="computer-detail-list">
          <div>
            <dt>Operating system</dt>
            <dd>{osLabel(device)}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>
              <time dateTime={device.last_seen_at ?? undefined}>
                {lastSeen(device.last_seen_at)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Agent version</dt>
            <dd>{device.agent?.version ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{device.agent?.protocol_version ?? "Not reported"}</dd>
          </div>
          <div>
            <dt>Active runs</dt>
            <dd>{device.activity.active_run_count}</dd>
          </div>
          <div>
            <dt>Queued commands</dt>
            <dd>{device.activity.queued_command_count}</dd>
          </div>
          <div>
            <dt>Credential</dt>
            <dd>{device.active_credential?.credential_id ?? "No active credential"}</dd>
          </div>
          <div>
            <dt>Generation</dt>
            <dd>{device.active_credential?.generation ?? "Not active"}</dd>
          </div>
          <div>
            <dt>Credential activated</dt>
            <dd>
              {device.active_credential ? lastSeen(device.active_credential.activated_at) : "Never"}
            </dd>
          </div>
          <div className="computer-detail-wide">
            <dt>Public-key fingerprint</dt>
            <dd className="mono computer-fingerprint">
              {device.active_credential
                ? fingerprint(device.active_credential.public_key_fingerprint)
                : "No active credential"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="computer-detail-section" aria-labelledby="computer-capabilities-title">
        <div className="computer-detail-heading">
          <div>
            <div className="eyebrow">Agent</div>
            <h3 id="computer-capabilities-title">Capabilities</h3>
          </div>
          {device.agent ? <Badge tone="info">{device.agent.capabilities.length}</Badge> : null}
        </div>
        {device.agent?.capabilities.length ? (
          <ul className="computer-token-list">
            {device.agent.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No capabilities have been reported.</p>
        )}
      </section>

      <RepositoryAccessManager
        deviceId={device.device_id}
        lifecycle={device.lifecycle}
        onUnauthorized={onUnauthorized}
      />

      <ManualUpdateGuidance device={device} />
    </article>
  );
}

export function Computers({
  onUnauthorized,
  embedded = false,
}: {
  onUnauthorized: () => void;
  embedded?: boolean;
}): React.ReactElement {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [downloads, setDownloads] = useState<LocalAgentDownloads | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Device | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailHeading = useRef<HTMLElement | null>(null);
  const detailRequestGeneration = useRef(0);

  const handleError = useCallback(
    (caught: unknown): void => {
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(describeDeviceError(caught));
    },
    [onUnauthorized],
  );

  const loadDevices = useCallback(async (): Promise<Device[]> => {
    const payload = await deviceRequest("/api/devices");
    const loaded = unwrapDevices(payload);
    setDownloads(unwrapLocalAgentDownloads(payload));
    setDevices(loaded);
    return loaded;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadDevices().catch((caught) => {
      if (!cancelled) handleError(caught);
    });
    return () => {
      cancelled = true;
    };
  }, [handleError, loadDevices]);

  const loadDetail = useCallback(
    async (deviceId: string, focus = false): Promise<void> => {
      const requestGeneration = ++detailRequestGeneration.current;
      setSelectedId(deviceId);
      if (focus) setDetail(null);
      setDetailLoading(true);
      setError(null);
      try {
        const loaded = unwrapDevice(
          await deviceRequest(`/api/devices/${encodeURIComponent(deviceId)}`),
        );
        if (requestGeneration !== detailRequestGeneration.current) return;
        setDetail(loaded);
        if (focus) requestAnimationFrame(() => detailHeading.current?.focus());
      } catch (caught) {
        if (requestGeneration === detailRequestGeneration.current) handleError(caught);
      } finally {
        if (requestGeneration === detailRequestGeneration.current) setDetailLoading(false);
      }
    },
    [handleError],
  );

  const refreshSelected = useCallback(
    async (deviceId: string): Promise<void> => {
      await loadDevices();
      await loadDetail(deviceId);
    },
    [loadDetail, loadDevices],
  );

  const rename = async (input: {
    name: string;
    location_label: string | null;
  }): Promise<void> => {
    if (!detail) return;
    setError(null);
    setNotice(null);
    try {
      await deviceRequest(`/api/devices/${encodeURIComponent(detail.device_id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      await refreshSelected(detail.device_id);
      setNotice("Computer details saved.");
    } catch (caught) {
      handleError(caught);
      throw caught;
    }
  };

  const revoke = async (reason: string): Promise<void> => {
    if (!detail) return;
    setError(null);
    setNotice(null);
    try {
      await deviceRequest(`/api/devices/${encodeURIComponent(detail.device_id)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      await refreshSelected(detail.device_id);
      setNotice("Computer revoked. New authorization and publication are blocked.");
    } catch (caught) {
      handleError(caught);
      throw caught;
    }
  };

  const content = (
    <>
      <PageHeader
        eyebrow="Local execution"
        title="Computers"
        lede="Manage Local Agent installations enrolled under your OS user. Reinstalling without recovering its credential creates a new computer entry."
      />

      <section className="card computers-installer" aria-labelledby="local-agent-installer-title">
        <div>
          <div className="eyebrow">Install or update</div>
          <h2 id="local-agent-installer-title">Norns Local Agent</h2>
          <p className="muted">
            Install the agent on each computer you want Norns to use, then authorize it here.
          </p>
          {downloads?.macos_release === "unsigned_preview" ? (
            <small className="computers-installer-warning">
              The current macOS download is an unsigned preview and will trigger a security warning.
            </small>
          ) : null}
        </div>
        <div className="computers-installer-actions">
          {downloads?.macos ? (
            <a className="btn btn-primary" href={downloads.macos}>
              Download for macOS
            </a>
          ) : null}
          {downloads?.windows ? (
            <a className="btn" href={downloads.windows}>
              Download for Windows
            </a>
          ) : null}
          {!downloads?.macos && !downloads?.windows ? (
            <span className="muted">Installer downloads have not been published yet.</span>
          ) : null}
        </div>
      </section>

      {error ? <Alert testId="computers-error">{error}</Alert> : null}
      <div className="sr-only" aria-live="polite">
        {notice}
      </div>

      {devices === null ? (
        <Spinner label="Loading computers…" />
      ) : devices.length === 0 ? (
        <section className="card computers-empty" aria-labelledby="computers-empty-title">
          <div>
            <div className="eyebrow">No enrolled computers</div>
            <h2 id="computers-empty-title">Authorize a Local Agent to get started</h2>
            <p className="muted">
              Enrollment begins on the computer. Enter its human verification code on the
              authorization page when prompted.
            </p>
          </div>
        </section>
      ) : (
        <div className="computers-layout">
          <section className="computers-inventory" aria-labelledby="computers-inventory-title">
            <div className="computers-section-heading">
              <div>
                <div className="eyebrow">Owned by you</div>
                <h2 id="computers-inventory-title">Your computers</h2>
              </div>
              <Badge>{devices.length}</Badge>
            </div>
            <ul className="computer-list">
              {devices.map((device) => (
                <ComputerCard
                  key={device.device_id}
                  device={device}
                  selected={device.device_id === selectedId}
                  onSelect={() => void loadDetail(device.device_id, true)}
                />
              ))}
            </ul>
          </section>

          <section className="computers-detail-region" aria-label="Computer details">
            {detail ? (
              <ComputerDetails
                key={detail.device_id}
                detailRef={detailHeading}
                device={detail}
                loading={detailLoading}
                onRename={rename}
                onRevoke={revoke}
                onUnauthorized={onUnauthorized}
              />
            ) : (
              <div className="card computers-detail-empty">
                <div>
                  <div className="eyebrow">Installation details</div>
                  <h2>Select a computer</h2>
                  <p className="muted">
                    Review its credential, compatibility, capabilities, grants, and manual update
                    guidance.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="computers-page embedded-computers-page" data-testid="computers-page">
        {content}
      </div>
    );
  }

  return (
    <div className="full-page-view" data-testid="computers-page">
      <main className="page-container computers-page">{content}</main>
    </div>
  );
}
