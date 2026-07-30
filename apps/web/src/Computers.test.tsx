import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Computers } from "./Computers";

function device(overrides: Record<string, unknown> = {}) {
  return {
    device_id: "device-1",
    owner_user_id: "owner-1",
    name: "Office Mac mini",
    location_label: "Office",
    os_family: "macos",
    os_version: "15.5",
    lifecycle: "active",
    status: {
      availability: "online",
      compatibility: "ready",
      workload: "busy",
      access: "owned",
    },
    last_seen_at: "2026-07-30T14:30:00.000Z",
    active_credential: {
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 1,
      public_key_fingerprint: "a".repeat(64),
      state: "active",
      activated_at: "2026-07-29T12:00:00.000Z",
    },
    agent: {
      version: "1.4.0",
      protocol_version: "device-v1",
      capabilities: ["shell", "visual-evidence"],
    },
    repository_grants: [
      {
        grant_id: "grant-1",
        project_id: "project-1",
        repository_registration_id: "registration-1",
        state: "active",
      },
    ],
    activity: {
      active_run_count: 1,
      queued_command_count: 0,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((settle) => {
      resolve = settle;
    }),
    resolve: (response) => resolve(response),
  };
}

describe("Computers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps cards minimal and opens full details with native keyboard controls", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ devices: [device()] }))
      .mockResolvedValueOnce(jsonResponse(device()));
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);

    const card = await screen.findByRole("button", { name: "View details for Office Mac mini" });
    expect(card).toHaveTextContent("Office");
    expect(card).toHaveTextContent("macOS 15.5");
    expect(card).toHaveTextContent("online");
    expect(card).toHaveTextContent("busy");
    expect(card).toHaveTextContent("Last seen");
    expect(card).not.toHaveTextContent("device-v1");
    expect(card).not.toHaveTextContent("visual-evidence");
    expect(card).not.toHaveTextContent("grant-1");
    expect(card).not.toHaveTextContent("aaaa aaaa");
    expect(within(card).getByText("busy")).toHaveClass("badge-info");
    expect(within(card).getByLabelText("Office Mac mini current status")).toHaveTextContent(
      "availabilityonlineworkloadbusy",
    );

    card.focus();
    await user.keyboard("{Enter}");

    await screen.findByRole("heading", { name: "Installation details" });
    expect(screen.getByLabelText("Computer status")).toHaveTextContent(
      "availabilityonlinecompatibilityreadyworkloadbusyaccessowned",
    );
    expect(screen.getByText("device-v1")).toBeInTheDocument();
    expect(screen.getByText("visual-evidence")).toBeInTheDocument();
    expect(screen.getByText("project-1")).toBeInTheDocument();
    expect(screen.getByText(/aaaa aaaa aaaa/)).toBeInTheDocument();
    const details = screen.getByRole("article", { name: "Office Mac mini" });
    expect(details).toHaveTextContent("Active runs1");
    expect(details).toHaveTextContent("Queued commands0");
    expect(details).toHaveTextContent("Credentialcredential-1");
    expect(details).toHaveTextContent("Generation1");
    expect(details).toHaveTextContent("Credential activated");
    await waitFor(() => expect(details).toHaveFocus());
    expect(screen.queryByText(/hostname/i)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/devices/device-1");
  });

  it("renames only the selected owned device and refreshes its projection", async () => {
    const renamed = device({ name: "Build Mac", location_label: "Studio" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ devices: [device()] }))
      .mockResolvedValueOnce(jsonResponse(device()))
      .mockResolvedValueOnce(jsonResponse(renamed))
      .mockResolvedValueOnce(jsonResponse({ devices: [renamed] }))
      .mockResolvedValueOnce(jsonResponse(renamed));
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "View details for Office Mac mini" }),
    );
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    await user.clear(screen.getByLabelText("Computer name"));
    await user.type(screen.getByLabelText("Computer name"), "Build Mac");
    await user.clear(screen.getByLabelText("Location label (optional)"));
    await user.type(screen.getByLabelText("Location label (optional)"), "Studio");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Build Mac" });
    const patch = fetchMock.mock.calls[2];
    expect(patch?.[0]).toBe("/api/devices/device-1");
    expect(patch?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ name: "Build Mac", location_label: "Studio" }),
    });
  });

  it("removes stale destructive controls and ignores out-of-order detail responses", async () => {
    const first = device();
    const second = device({
      device_id: "device-2",
      name: "Travel Mac",
      location_label: "Travel",
      active_credential: {
        device_id: "device-2",
        credential_id: "credential-2",
        generation: 1,
        public_key_fingerprint: "b".repeat(64),
        state: "active",
        activated_at: "2026-07-29T12:00:00.000Z",
      },
    });
    const firstDetail = deferredResponse();
    const secondDetail = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ devices: [first, second] }))
      .mockReturnValueOnce(firstDetail.promise)
      .mockReturnValueOnce(secondDetail.promise);
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "View details for Office Mac mini" }),
    );
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View details for Travel Mac" }));

    secondDetail.resolve(jsonResponse(second));
    expect(await screen.findByRole("heading", { name: "Travel Mac" })).toBeInTheDocument();
    firstDetail.resolve(jsonResponse(first));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Office Mac mini" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("heading", { name: "Travel Mac" })).toBeInTheDocument();
  });

  it("uses typed revocation confirmation and renders revoked as a muted terminal state", async () => {
    const revoked = device({
      lifecycle: "revoked",
      status: {
        availability: "offline",
        compatibility: "update_required",
        workload: "idle",
        access: "revoked",
      },
      active_credential: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ devices: [device()] }))
      .mockResolvedValueOnce(jsonResponse(device()))
      .mockResolvedValueOnce(jsonResponse(revoked))
      .mockResolvedValueOnce(jsonResponse({ devices: [revoked] }))
      .mockResolvedValueOnce(jsonResponse(revoked));
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "View details for Office Mac mini" }),
    );
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    const revokeButton = screen.getByRole("button", { name: "Revoke computer" });
    expect(revokeButton).toBeDisabled();
    await user.type(screen.getByLabelText("Reason"), "Retiring this installation");
    await user.type(screen.getByLabelText("Type Office Mac mini to confirm"), "Office Mac mini");
    expect(revokeButton).toBeEnabled();
    await user.click(revokeButton);

    await waitFor(() =>
      expect(screen.getByLabelText("Computer status")).toHaveTextContent("accessrevoked"),
    );
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    expect(screen.queryByText("Update required")).not.toBeInTheDocument();
    expect(
      screen.getByText(/updating or reinstalling it does not restore access/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveClass("is-revoked");
    expect(within(screen.getByLabelText("Computer status")).getByText("revoked")).toHaveClass(
      "badge-default",
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reason: "Retiring this installation" }),
    });
  });

  it("returns an expired session to the application", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );
    const onUnauthorized = vi.fn();
    render(<Computers embedded onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });
});
