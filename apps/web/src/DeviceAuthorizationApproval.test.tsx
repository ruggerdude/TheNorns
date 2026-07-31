import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceAuthorizationApproval } from "./DeviceAuthorizationApproval";

const user = {
  id: "user-1",
  email: "owner@example.com",
  name: "Device Owner",
  role: "member" as const,
  status: "active" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DeviceAuthorizationApproval", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("accepts the invisible Local Agent handoff and syncs the exact Mac", async () => {
    window.history.replaceState(null, "", "/device-authorization#handoff=ABCD-EFGH");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          authorization_request_id: "authorization-1",
          authorization_context: "context-1",
          proposed_name: "Office Mac mini",
          os_family: "macos",
          architecture: "arm64",
          public_key_fingerprint: "a".repeat(64),
          expires_at: "2026-07-29T13:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ state: "approved_pending_redemption" }))
      .mockResolvedValueOnce(
        jsonResponse({
          authorization_request_id: "authorization-1",
          state: "active",
        }),
      );

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);

    await screen.findByText("Office Mac mini");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/human.*code/i)).not.toBeInTheDocument();
    const lookup = fetchMock.mock.calls[0];
    expect(lookup?.[0]).toBe("/api/device-authorizations/lookup");
    expect(lookup?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ user_code: "ABCDEFGH" }),
    });
    expect(String(lookup?.[0])).not.toContain("ABCDEFGH");

    fireEvent.click(screen.getByRole("button", { name: "Sync this Mac" }));
    await screen.findByText(/this mac is synced/i);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/device-authorizations/authorization-1/approve");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ authorization_context: "context-1" }),
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/device-authorizations/authorization-1/status");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
    expect(screen.getByRole("link", { name: /continue to connections/i })).toHaveAttribute(
      "href",
      "/?settings=connections",
    );
  });

  it("never offers manual code entry when opened without a Local Agent handoff", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);

    expect(screen.getByText(/start from the local agent/i)).toBeVisible();
    expect(screen.getByText(/open local control center/i)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/human.*code/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a throttled automatic handoff without exposing code entry", async () => {
    window.history.replaceState(null, "", "/device-authorization#handoff=ABCD-EFGH");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "throttled" }, 429));

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);

    await screen.findByText(/too many sync attempts/i);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps compatibility with an older Local Agent handoff", async () => {
    window.history.replaceState(null, "", "/?device_authorization=true#code=ABCD-EFGH");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        authorization_request_id: "authorization-handoff",
        authorization_context: "context-handoff",
        proposed_name: "David’s MacBook Pro",
        os_family: "macos",
        architecture: "arm64",
        public_key_fingerprint: "b".repeat(64),
        expires_at: "2026-07-30T23:00:00.000Z",
      }),
    );

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);

    await screen.findByText("David’s MacBook Pro");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/device-authorizations/lookup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_code: "ABCDEFGH" }),
      }),
    );
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?device_authorization=true");
  });

  it("returns an expired session to the app", async () => {
    window.history.replaceState(null, "", "/device-authorization#handoff=ABCD-EFGH");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );
    const onUnauthorized = vi.fn();
    render(<DeviceAuthorizationApproval user={user} onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it("requires a fresh sign-in for a stale approval session without retrying the decision", async () => {
    window.history.replaceState(null, "", "/device-authorization#handoff=ABCD-EFGH");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          authorization_request_id: "authorization-1",
          authorization_context: "context-1",
          proposed_name: "Office Mac mini",
          os_family: "macos",
          architecture: "arm64",
          public_key_fingerprint: "a".repeat(64),
          expires_at: "2026-07-29T13:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "recent_auth_required" }, 403));
    const onUnauthorized = vi.fn();

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={onUnauthorized} />);
    await screen.findByText("Office Mac mini");
    fireEvent.click(screen.getByRole("button", { name: "Sync this Mac" }));

    expect(await screen.findByText(/sign in again before syncing this computer/i)).toBeVisible();
    expect(screen.getByText(/request was not retried/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Sync this Mac" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("lets the signed-in user decline without syncing the Mac", async () => {
    window.history.replaceState(null, "", "/device-authorization#handoff=ABCD-EFGH");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          authorization_request_id: "authorization-1",
          authorization_context: "context-1",
          proposed_name: "Office Mac mini",
          os_family: "macos",
          architecture: "arm64",
          public_key_fingerprint: "a".repeat(64),
          expires_at: "2026-07-29T13:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ state: "denied" }));

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);
    await screen.findByText("Office Mac mini");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    await screen.findByText(/this mac was not synced/i);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/device-authorizations/authorization-1/deny");
  });
});
