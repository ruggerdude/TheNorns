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
  });

  it("submits the human code only in a POST body and approves the exact request", async () => {
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
      .mockResolvedValueOnce(jsonResponse({ state: "approved_pending_redemption" }));

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/human verification code/i), {
      target: { value: "abcd-efgh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText("Office Mac mini");
    const lookup = fetchMock.mock.calls[0];
    expect(lookup?.[0]).toBe("/api/device-authorizations/lookup");
    expect(lookup?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ user_code: "ABCDEFGH" }),
    });
    expect(String(lookup?.[0])).not.toContain("ABCDEFGH");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText(/must redeem this approval with its persisted private key/i);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/device-authorizations/authorization-1/approve");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ authorization_context: "context-1" }),
    });
  });

  it("denies without exposing a device code and reports throttling", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "throttled" }, 429));

    render(<DeviceAuthorizationApproval user={user} onUnauthorized={vi.fn()} />);
    expect(screen.queryByText(/device_code/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/human verification code/i), {
      target: { value: "ABCD-EFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByText(/too many attempts/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an expired session to the app", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );
    const onUnauthorized = vi.fn();
    render(<DeviceAuthorizationApproval user={user} onUnauthorized={onUnauthorized} />);
    fireEvent.change(screen.getByLabelText(/human verification code/i), {
      target: { value: "ABCD-EFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it("requires a fresh sign-in for a stale approval session without retrying the decision", async () => {
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
    fireEvent.change(screen.getByLabelText(/human verification code/i), {
      target: { value: "ABCD-EFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Office Mac mini");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText(/sign in again before approving or denying this computer/i),
    ).toBeVisible();
    expect(screen.getByText(/decision was not retried/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
