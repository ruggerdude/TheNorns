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

function repositoryAccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: "device-1",
    registrations: [
      {
        registration_id: "registration-1",
        repository_id: "repository-1",
        repository_display_name: "The Norns",
        default_branch: "main",
        state: "active",
        grants: [
          {
            grant_id: "grant-1",
            project_id: "project-1",
            state: "active",
          },
        ],
      },
    ],
    eligible_projects: [
      { project_id: "project-1", name: "Apollo" },
      { project_id: "project-2", name: "Borealis" },
    ],
    ...overrides,
  };
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
      .mockResolvedValueOnce(
        jsonResponse({
          devices: [device()],
          downloads: {
            macos: "https://downloads.example.com/Norns-Local-Agent-macOS.pkg",
            windows: "https://downloads.example.com/Norns-Local-Agent-Setup.exe",
            macos_release: "notarized",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(device()))
      .mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);

    const card = await screen.findByRole("button", { name: "View details for Office Mac mini" });
    expect(screen.getByRole("link", { name: "Download for macOS" })).toHaveAttribute(
      "href",
      "https://downloads.example.com/Norns-Local-Agent-macOS.pkg",
    );
    expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAttribute(
      "href",
      "https://downloads.example.com/Norns-Local-Agent-Setup.exe",
    );
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
    expect(screen.queryByText("project-1")).not.toBeInTheDocument();
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
      .mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404))
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
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/devices/device-1");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
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
      .mockReturnValueOnce(secondDetail.promise)
      .mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404));
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
      .mockResolvedValueOnce(jsonResponse({ error: "not_found" }, 404))
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
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reason: "Retiring this installation" }),
    });
  });

  it("grants and removes project access without exposing repository or grant identifiers", async () => {
    let apolloActive = true;
    let borealisActive = false;
    const currentAccess = (): Record<string, unknown> =>
      repositoryAccess({
        registrations: [
          {
            registration_id: "registration-1",
            repository_id: "repository-1",
            repository_display_name: "The Norns",
            default_branch: "main",
            state: "active",
            grants: [
              ...(apolloActive
                ? [
                    {
                      grant_id: "grant-1",
                      project_id: "project-1",
                      state: "active",
                    },
                  ]
                : []),
              ...(borealisActive
                ? [
                    {
                      grant_id: "grant-2",
                      project_id: "project-2",
                      state: "active",
                    },
                  ]
                : []),
            ],
          },
        ],
      });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/devices" && method === "GET") {
        return jsonResponse({ devices: [device()] });
      }
      if (path === "/api/devices/device-1" && method === "GET") {
        return jsonResponse(device());
      }
      if (path === "/api/devices/device-1/repository-access" && method === "GET") {
        return jsonResponse(currentAccess());
      }
      if (path === "/api/devices/device-1/repository-grants" && method === "POST") {
        borealisActive = true;
        return jsonResponse(currentAccess());
      }
      if (path === "/api/devices/device-1/repository-grants/grant-1/revoke" && method === "POST") {
        apolloActive = false;
        return jsonResponse(currentAccess());
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "View details for Office Mac mini" }),
    );

    const accessHeading = await screen.findByRole("heading", { name: "Repository access" });
    const accessSection = accessHeading.closest("section");
    expect(accessSection).not.toBeNull();
    const scoped = within(accessSection as HTMLElement);
    expect(scoped.getByRole("article", { name: "The Norns" })).toHaveTextContent(
      "Default branch main",
    );
    expect(scoped.getByText("Apollo")).toBeInTheDocument();
    expect(accessSection).not.toHaveTextContent("registration-1");
    expect(accessSection).not.toHaveTextContent("repository-1");
    expect(accessSection).not.toHaveTextContent("grant-1");
    expect(accessSection).not.toHaveTextContent("project-1");

    expect(scoped.getByRole("combobox", { name: "Project for The Norns" })).toHaveValue(
      "project-2",
    );
    await user.click(scoped.getByRole("button", { name: "Grant project access" }));
    await waitFor(() => {
      const grants = scoped.getByRole("list", { name: "Active project access" });
      expect(grants).toHaveTextContent("Apollo");
      expect(grants).toHaveTextContent("Borealis");
    });

    const grantCall = fetchMock.mock.calls.find(
      ([path, init]) =>
        path === "/api/devices/device-1/repository-grants" && init?.method === "POST",
    );
    expect(grantCall?.[1]?.body).toBe(
      JSON.stringify({
        repository_registration_id: "registration-1",
        project_id: "project-2",
      }),
    );

    await user.click(scoped.getByRole("button", { name: "Remove Apollo access" }));
    expect(scoped.getByText(/local files will not be deleted/i)).toBeInTheDocument();
    await user.click(scoped.getByRole("button", { name: "Remove access" }));
    await waitFor(() =>
      expect(scoped.getByRole("list", { name: "Active project access" })).not.toHaveTextContent(
        "Apollo",
      ),
    );
    const revokeCall = fetchMock.mock.calls.find(
      ([path, init]) =>
        path === "/api/devices/device-1/repository-grants/grant-1/revoke" &&
        init?.method === "POST",
    );
    expect(revokeCall?.[1]?.body).toBe(JSON.stringify({}));
    expect(accessSection).not.toHaveTextContent("grant-2");
  });

  it("fails closed when repository access is widened with a local path", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ devices: [device()] }))
      .mockResolvedValueOnce(jsonResponse(device()))
      .mockResolvedValueOnce(
        jsonResponse(
          repositoryAccess({
            registrations: [
              {
                registration_id: "registration-1",
                repository_id: "repository-1",
                repository_display_name: "The Norns",
                default_branch: "main",
                state: "active",
                grants: [],
                workspace_path: "/Users/owner/secret-worktree",
              },
            ],
          }),
        ),
      );
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "View details for Office Mac mini" }),
    );

    expect(await screen.findByTestId("repository-access-error")).toHaveTextContent(
      "Repository access response is invalid.",
    );
    expect(screen.queryByText("/Users/owner/secret-worktree")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant project access" })).not.toBeInTheDocument();
  });

  it("reloads owner access when a project grant choice disappears during submission", async () => {
    let accessRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/devices" && method === "GET") {
        return jsonResponse({ devices: [device()] });
      }
      if (path === "/api/devices/device-1" && method === "GET") {
        return jsonResponse(device());
      }
      if (path === "/api/devices/device-1/repository-access" && method === "GET") {
        accessRequests += 1;
        return jsonResponse(
          accessRequests === 1
            ? repositoryAccess()
            : repositoryAccess({
                eligible_projects: [{ project_id: "project-1", name: "Apollo" }],
              }),
        );
      }
      if (path === "/api/devices/device-1/repository-grants" && method === "POST") {
        return jsonResponse({ error: "not_found" }, 404);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    const user = userEvent.setup();

    render(<Computers embedded onUnauthorized={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "View details for Office Mac mini" }),
    );
    await user.click(await screen.findByRole("button", { name: "Grant project access" }));

    expect(await screen.findByTestId("repository-access-error")).toHaveTextContent(
      "no longer available",
    );
    expect(accessRequests).toBe(2);
    expect(screen.getByRole("heading", { name: "Repository access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant project access" })).not.toBeInTheDocument();
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
