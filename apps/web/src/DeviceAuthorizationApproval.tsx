import { useEffect, useRef, useState } from "react";
import "./UtilitySurfaces.css";
import type { CurrentUser } from "./auth";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Spinner } from "./ui";

interface DeviceAuthorizationSummary {
  authorization_request_id: string;
  authorization_context: string;
  proposed_name: string;
  os_family: "macos" | "windows" | "linux" | "other";
  architecture: string;
  public_key_fingerprint: string;
  expires_at: string;
}

type ApprovalOutcome = "approved_pending_redemption" | "active" | "denied" | "expired";

function normalizeHandoff(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    detail?: string;
  };
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    throw new ApiError(
      payload.detail ?? payload.error ?? `request failed: ${response.status}`,
      response.status,
      payload.error ?? null,
    );
  }
  return payload;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "include",
    headers: authHeaders(),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    detail?: string;
  };
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    throw new ApiError(
      payload.detail ?? payload.error ?? `request failed: ${response.status}`,
      response.status,
      payload.error ?? null,
    );
  }
  return payload;
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "recent_auth_required") {
      return "For your security, sign in again before syncing this computer. The request was not retried.";
    }
    if (error.status === 404) return "This sync request is invalid or no longer available.";
    if (error.status === 429) return "Too many sync attempts. Wait a moment and try again.";
    if (error.status === 409) return "This sync request has already been completed or expired.";
    return "This computer could not be synced.";
  }
  return "The authorization service is unavailable. Try again shortly.";
}

export function DeviceAuthorizationApproval({
  user,
  onUnauthorized,
}: {
  user: CurrentUser;
  onUnauthorized: () => void;
}): React.ReactElement {
  const initialHandoff = useRef(
    normalizeHandoff(
      typeof window === "undefined"
        ? ""
        : (new URLSearchParams(window.location.hash.slice(1)).get("handoff") ??
            new URLSearchParams(window.location.hash.slice(1)).get("code") ??
            ""),
    ),
  ).current;
  const [request, setRequest] = useState<DeviceAuthorizationSummary | null>(null);
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automaticLookupStarted = useRef(false);

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  };

  const lookup = (candidate: string): Promise<void> =>
    run(async () => {
      const normalized = normalizeHandoff(candidate);
      if (normalized.length !== 8) {
        setError("Start syncing again from the Local Agent on this Mac.");
        return;
      }
      const found = await postJson<DeviceAuthorizationSummary>(
        "/api/device-authorizations/lookup",
        { user_code: normalized },
      );
      setRequest(found);
      setOutcome(null);
    });

  // The fragment is a one-time handoff. Re-running after state changes would
  // submit the sync request again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time URL handoff
  useEffect(() => {
    if (initialHandoff.length !== 8 || automaticLookupStarted.current) return;
    automaticLookupStarted.current = true;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    void lookup(initialHandoff);
  }, []);

  useEffect(() => {
    if (outcome !== "approved_pending_redemption" || !request) return;
    let cancelled = false;
    let nextCheck: number | undefined;

    const checkStatus = async (): Promise<void> => {
      try {
        const result = await getJson<{ state: ApprovalOutcome }>(
          `/api/device-authorizations/${encodeURIComponent(request.authorization_request_id)}/status`,
        );
        if (cancelled) return;
        setOutcome(result.state);
        if (result.state === "approved_pending_redemption") {
          nextCheck = window.setTimeout(() => void checkStatus(), 1_000);
        }
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        nextCheck = window.setTimeout(() => void checkStatus(), 2_000);
      }
    };

    void checkStatus();
    return () => {
      cancelled = true;
      if (nextCheck !== undefined) window.clearTimeout(nextCheck);
    };
  }, [outcome, request, onUnauthorized]);

  const decide = (decision: "approve" | "deny"): Promise<void> =>
    run(async () => {
      if (!request) return;
      const result = await postJson<{ state: ApprovalOutcome }>(
        `/api/device-authorizations/${encodeURIComponent(request.authorization_request_id)}/${decision}`,
        { authorization_context: request.authorization_context },
      );
      setOutcome(result.state);
    });

  return (
    <section
      className="card settings-card form-stack device-authorization-card"
      aria-labelledby="device-authorization-title"
      data-testid="device-authorization-approval"
    >
      <div className="section-head">
        <div>
          <div className="eyebrow">Local Agent</div>
          <h1 id="device-authorization-title">Sync this Mac</h1>
        </div>
        <Badge
          tone={
            outcome === "active" || outcome === "approved_pending_redemption"
              ? "success"
              : outcome === "denied" || outcome === "expired"
                ? "danger"
                : "info"
          }
        >
          {outcome === "active"
            ? "Connected"
            : outcome === "approved_pending_redemption"
              ? "Approved"
              : outcome === "denied"
                ? "Denied"
                : outcome === "expired"
                  ? "Expired"
                  : "Verification"}
        </Badge>
      </div>

      <p className="muted">
        Signed in as <strong>{user.name ?? user.email}</strong> ({user.email}). Confirm that you
        want this computer connected to your Norns account.
      </p>

      {!request ? (
        initialHandoff.length === 8 && busy ? (
          <Spinner label="Checking this Mac…" />
        ) : (
          <div className="device-sync-empty">
            <div className="device-sync-icon" aria-hidden="true">
              ↗
            </div>
            <div>
              <h2>Start from the Local Agent</h2>
              <p>
                Open the Norns icon in your Mac menu bar, choose{" "}
                <strong>Open Local Control Center</strong>, then click{" "}
                <strong>Sync with The Norns</strong>.
              </p>
            </div>
            {initialHandoff.length === 8 ? (
              <Button type="button" disabled={busy} onClick={() => void lookup(initialHandoff)}>
                Try again
              </Button>
            ) : null}
          </div>
        )
      ) : (
        <div className="form-stack">
          <div className="device-sync-request">
            <div className="device-sync-request-head">
              <div className="device-sync-icon" aria-hidden="true">
                ⌘
              </div>
              <div>
                <div className="eyebrow">This computer</div>
                <h3>{request.proposed_name}</h3>
                <p>
                  Norns will run only work you approve and use only repositories you explicitly add.
                </p>
              </div>
              <Badge tone="info">{request.os_family}</Badge>
            </div>
            <details className="device-sync-security">
              <summary>Security details</summary>
              <dl className="assignment">
                <dt>Architecture</dt>
                <dd>{request.architecture}</dd>
                <dt>Device fingerprint</dt>
                <dd className="mono">{request.public_key_fingerprint}</dd>
                <dt>Request expires</dt>
                <dd>{new Date(request.expires_at).toLocaleString()}</dd>
              </dl>
            </details>
          </div>

          {outcome ? (
            <Alert
              tone={
                outcome === "active"
                  ? "success"
                  : outcome === "approved_pending_redemption"
                    ? "info"
                    : "danger"
              }
            >
              {outcome === "active"
                ? "This Mac is synced with your Norns account and ready to use."
                : outcome === "approved_pending_redemption"
                  ? "Confirmed—finishing the secure connection with your Local Agent…"
                  : outcome === "expired"
                    ? "This request expired before the Local Agent finished syncing. Start again from the Local Agent."
                    : "This Mac was not synced."}
            </Alert>
          ) : (
            <div className="connection-card-controls">
              <Button
                type="button"
                variant="primary"
                disabled={busy}
                onClick={() => void decide("approve")}
              >
                {busy ? "Syncing…" : "Sync this Mac"}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => void decide("deny")}
              >
                Not now
              </Button>
            </div>
          )}
          {outcome === "active" ? (
            <a className="btn btn-primary device-sync-finish" href="/?settings=connections">
              Continue to Connections
            </a>
          ) : null}
        </div>
      )}

      {error ? <Alert testId="device-authorization-error">{error}</Alert> : null}
    </section>
  );
}
