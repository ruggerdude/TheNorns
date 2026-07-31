import { useEffect, useRef, useState } from "react";
import type { CurrentUser } from "./auth";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import { Alert, Badge, Button, Field, Input } from "./ui";

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

function normalizeUserCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function formatUserCode(value: string): string {
  const normalized = normalizeUserCode(value);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
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
      return "For your security, sign in again before approving or denying this computer. This decision was not retried.";
    }
    if (error.status === 404) return "That code is invalid or no longer available.";
    if (error.status === 429) return "Too many attempts. Wait before trying another code.";
    if (error.status === 409) return "This request has already been completed or has expired.";
    return "The authorization request could not be completed.";
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
  const initialCode = normalizeUserCode(
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.hash.slice(1)).get("code") ?? ""),
  );
  const [userCode, setUserCode] = useState(initialCode);
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

  const lookup = (candidate = userCode): Promise<void> =>
    run(async () => {
      const normalized = normalizeUserCode(candidate);
      if (normalized.length !== 8) {
        setError("Enter the complete code shown by the Local Agent.");
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
  // submit the authorization code again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time URL handoff
  useEffect(() => {
    if (initialCode.length !== 8 || automaticLookupStarted.current) return;
    automaticLookupStarted.current = true;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    void lookup(initialCode);
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
      className="card settings-card form-stack"
      aria-labelledby="device-authorization-title"
      data-testid="device-authorization-approval"
    >
      <div className="section-head">
        <div>
          <div className="eyebrow">Local Agent</div>
          <h1 id="device-authorization-title">Authorize a computer</h1>
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
        Signed in as <strong>{user.name ?? user.email}</strong> ({user.email}). Enter the human code
        shown by the Local Agent. Device secrets never belong in this page or its URL.
      </p>

      {!request ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          <Field label="Human verification code">
            <Input
              name="user-code"
              autoComplete="one-time-code"
              inputMode="text"
              value={formatUserCode(userCode)}
              onChange={(event) => setUserCode(event.target.value)}
              placeholder="ABCD-EFGH"
              disabled={busy}
              required
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        </form>
      ) : (
        <div className="form-stack">
          <div className="connection-card is-open">
            <div className="connection-card-head">
              <div>
                <div className="eyebrow">Requested installation</div>
                <h3>{request.proposed_name}</h3>
              </div>
              <Badge tone="info">{request.os_family}</Badge>
            </div>
            <dl className="assignment">
              <dt>Architecture</dt>
              <dd>{request.architecture}</dd>
              <dt>Key fingerprint</dt>
              <dd className="mono">{request.public_key_fingerprint}</dd>
              <dt>Expires</dt>
              <dd>{new Date(request.expires_at).toLocaleString()}</dd>
            </dl>
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
                ? "This Mac is connected. You can close this page and return to The Norns."
                : outcome === "approved_pending_redemption"
                  ? "Approved—finishing the secure connection with the Local Agent…"
                  : outcome === "expired"
                    ? "This approval expired before the Local Agent finished connecting. Start enrollment again from the Local Agent."
                    : "Denied. This authorization request cannot be used."}
            </Alert>
          ) : (
            <div className="connection-card-controls">
              <Button
                type="button"
                variant="primary"
                disabled={busy}
                onClick={() => void decide("approve")}
              >
                {busy ? "Saving…" : "Approve"}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => void decide("deny")}
              >
                Deny
              </Button>
            </div>
          )}
        </div>
      )}

      {error ? <Alert testId="device-authorization-error">{error}</Alert> : null}
    </section>
  );
}
