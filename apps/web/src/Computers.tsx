import { OwnedDeviceProjection, type OwnedDeviceProjectionT } from "@norns/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Field, Input, PageHeader, Spinner, TextArea } from "./ui";
import "./Computers.css";

type Device = OwnedDeviceProjectionT;

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

function ComputerDetails({
  device,
  loading,
  onRename,
  onRevoke,
  detailRef,
}: {
  device: Device;
  loading: boolean;
  onRename: (input: { name: string; location_label: string | null }) => Promise<void>;
  onRevoke: (reason: string) => Promise<void>;
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

      <section className="computer-detail-section" aria-labelledby="computer-grants-title">
        <div className="computer-detail-heading">
          <div>
            <div className="eyebrow">Authorization</div>
            <h3 id="computer-grants-title">Repository grants</h3>
          </div>
          <Badge>{device.repository_grants.length}</Badge>
        </div>
        {device.repository_grants.length ? (
          <ul className="computer-grant-list">
            {device.repository_grants.map((grant) => (
              <li key={grant.grant_id}>
                <span>
                  <strong>{grant.project_id}</strong>
                  <small>{grant.repository_registration_id}</small>
                </span>
                <Badge tone={grant.state === "active" ? "success" : "default"}>{grant.state}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No repository grants.</p>
        )}
      </section>

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
    const loaded = unwrapDevices(await deviceRequest("/api/devices"));
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

  return (
    <div
      className={embedded ? "embedded-page-view" : "full-page-view"}
      data-testid="computers-page"
    >
      <main className="page-container computers-page">
        <PageHeader
          eyebrow="Local execution"
          title="Computers"
          lede="Manage Local Agent installations enrolled under your OS user. Reinstalling without recovering its credential creates a new computer entry."
        />

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
      </main>
    </div>
  );
}
