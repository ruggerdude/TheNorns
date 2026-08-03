import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { MockFetch } from "./test/mockFetch";

describe("WorkspaceSettings project archiving", () => {
  const projectId = "project-settings";
  const onProjectArchived = vi.fn<(archivedProjectId: string) => void>();
  const onUnauthorized = vi.fn();
  let mock: MockFetch;

  beforeEach(() => {
    onProjectArchived.mockReset();
    onUnauthorized.mockReset();
    mock = new MockFetch();
    mock.get(`/api/v2/projects/${projectId}/rules`, {
      body: { filename: "NORN.md", content: "", version: 0, updated_at: null },
    });
    mock.get(`/api/v2/projects/${projectId}/access`, {
      body: {
        schema_version: 2,
        project_id: projectId,
        user_id: "owner-1",
        owner_user_id: "owner-1",
        can_access: true,
        can_manage_members: true,
        source: "owner",
      },
    });
    mock.get(`/api/projects/${projectId}/execution-targets`, {
      status: 404,
      body: { error: "not_found" },
    });
    mock.get(`/api/v2/projects/${projectId}/planning-reviewer`, {
      body: {
        provider: "openai",
        model: null,
        mode: "automatic",
        qc_mode: "automatic",
        allow_unadjudicated_rebuttals: false,
        default_max_rounds: 3,
      },
    });
    mock.del(`/api/projects/${projectId}`, { status: 204 });
    mock.install();
  });

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
  });

  function setup() {
    render(
      <WorkspaceSettings
        projectId={projectId}
        projectName="Settings project"
        onProjectArchived={onProjectArchived}
        onPreferencesChanged={vi.fn()}
        onUnauthorized={onUnauthorized}
      />,
    );
  }

  it("archives the project from the Settings danger zone after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup();

    const archiveButton = await screen.findByRole("button", { name: "Archive project" });
    expect(archiveButton.closest(".workspace-settings-danger")).not.toBeNull();
    await userEvent.click(archiveButton);

    await waitFor(() => expect(onProjectArchived).toHaveBeenCalledWith(projectId));
    expect(
      mock.calls.find(
        (call) => call.method === "DELETE" && call.url === `/api/projects/${projectId}`,
      ),
    ).toMatchObject({ body: undefined });
  });

  it("does not archive when removal is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    setup();

    await userEvent.click(await screen.findByRole("button", { name: "Archive project" }));

    expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(onProjectArchived).not.toHaveBeenCalled();
  });

  it("keeps the project open and shows the server safeguard when work is active", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mock.del(`/api/projects/${projectId}`, {
      status: 409,
      body: { message: "Projects with active work cannot be removed." },
    });
    setup();

    await userEvent.click(await screen.findByRole("button", { name: "Archive project" }));

    expect(await screen.findByText("Projects with active work cannot be removed.")).toBeVisible();
    expect(onProjectArchived).not.toHaveBeenCalled();
  });

  it("confirms permanent deletion and sends only the selected linked-resource options", async () => {
    mock.get(`/api/v2/projects/${projectId}/deletion-options`, {
      body: {
        project_name: "Settings project",
        local_folder: { available: true, label: "Settings project" },
        github_repository: { available: true, label: "octocat/settings-project" },
      },
    });
    mock.del(`/api/v2/projects/${projectId}/destroy`, { status: 204 });
    setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Delete project" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Settings project?" });
    expect(dialog).toHaveTextContent("Are you sure?");
    expect(dialog.closest(".confirmation-backdrop")?.parentElement).toBe(document.body);
    await user.click(screen.getByRole("checkbox", { name: /delete github repository/i }));
    await user.click(screen.getByRole("button", { name: "Yes, delete project" }));

    await waitFor(() => expect(onProjectArchived).toHaveBeenCalledWith(projectId));
    expect(
      screen.queryByRole("dialog", { name: "Delete Settings project?" }),
    ).not.toBeInTheDocument();
    expect(
      mock.calls.find(
        (call) => call.method === "DELETE" && call.url === `/api/v2/projects/${projectId}/destroy`,
      ),
    ).toMatchObject({
      body: {
        delete_local_folder: false,
        delete_github_repository: true,
      },
    });
  });

  it("keeps repository-deletion failures visible inside the dialog and allows a retry", async () => {
    mock.get(`/api/v2/projects/${projectId}/deletion-options`, {
      body: {
        project_name: "Settings project",
        local_folder: { available: false, label: null },
        github_repository: { available: true, label: "octocat/settings-project" },
      },
    });
    mock.del(`/api/v2/projects/${projectId}/destroy`, {
      status: 409,
      body: {
        error: "github_app_permission_missing",
        message:
          "The GitHub App permission grant does not cover administration: write. A human must update it.",
      },
    });
    setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Delete project" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Settings project?" });
    await user.click(screen.getByRole("checkbox", { name: /delete github repository/i }));
    await user.click(screen.getByRole("button", { name: "Yes, delete project" }));

    const message = await screen.findByText(
      "The GitHub App permission grant does not cover administration: write. A human must update it.",
    );
    expect(message.closest("dialog")).toBe(dialog);
    expect(screen.getByRole("link", { name: "Open GitHub App settings" })).toHaveAttribute(
      "href",
      "https://github.com/settings/apps",
    );
    expect(screen.getByRole("link", { name: "Open installed GitHub Apps" })).toHaveAttribute(
      "href",
      "https://github.com/settings/installations",
    );
    expect(screen.getByRole("button", { name: "Yes, delete project" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /delete github repository/i })).toBeChecked();
    expect(onProjectArchived).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep GitHub repository instead" }));
    expect(screen.getByRole("checkbox", { name: /delete github repository/i })).not.toBeChecked();
    expect(message).not.toBeInTheDocument();
  });

  it("shows repository-deletion progress until the project closes", async () => {
    mock.get(`/api/v2/projects/${projectId}/deletion-options`, {
      body: {
        project_name: "Settings project",
        local_folder: { available: false, label: null },
        github_repository: { available: true, label: "octocat/settings-project" },
      },
    });
    let finishDeletion!: (result: { status: number }) => void;
    mock.del(
      `/api/v2/projects/${projectId}/destroy`,
      () =>
        new Promise((resolve) => {
          finishDeletion = resolve;
        }),
    );
    setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Delete project" }));
    await user.click(await screen.findByRole("checkbox", { name: /delete github repository/i }));
    await user.click(screen.getByRole("button", { name: "Yes, delete project" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Deleting the linked GitHub repository and project… This can take a moment.",
    );
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();

    finishDeletion({ status: 204 });
    await waitFor(() => expect(onProjectArchived).toHaveBeenCalledWith(projectId));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the project when the permanent-deletion dialog is cancelled", async () => {
    mock.get(`/api/v2/projects/${projectId}/deletion-options`, {
      body: {
        project_name: "Settings project",
        local_folder: { available: false, label: null },
        github_repository: { available: true, label: "octocat/settings-project" },
      },
    });
    setup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Delete project" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      mock.calls.some(
        (call) => call.method === "DELETE" && call.url === `/api/v2/projects/${projectId}/destroy`,
      ),
    ).toBe(false);
    expect(onProjectArchived).not.toHaveBeenCalled();
  });
});

// QCP-12: the post-creation QC settings surface — rounds/mode/rebuttals were
// previously only settable in the New Project wizard.
describe("WorkspaceSettings QC settings", () => {
  const projectId = "project-qc-settings";
  const onUnauthorized = vi.fn();
  let mock: MockFetch;

  beforeEach(() => {
    onUnauthorized.mockReset();
    mock = new MockFetch();
    mock.get(`/api/v2/projects/${projectId}/rules`, {
      body: { filename: "NORN.md", content: "", version: 0, updated_at: null },
    });
    mock.get(`/api/v2/projects/${projectId}/access`, {
      body: {
        schema_version: 2,
        project_id: projectId,
        user_id: "owner-1",
        owner_user_id: "owner-1",
        can_access: true,
        can_manage_members: true,
        source: "owner",
      },
    });
    mock.get(`/api/projects/${projectId}/execution-targets`, {
      status: 404,
      body: { error: "not_found" },
    });
    mock.get(`/api/v2/projects/${projectId}/planning-reviewer`, {
      body: {
        provider: "openai",
        model: null,
        mode: "automatic",
        qc_mode: "gated_when_contested",
        allow_unadjudicated_rebuttals: false,
        default_max_rounds: 3,
      },
    });
    mock.patch(`/api/v2/projects/${projectId}/planning-reviewer`, { status: 204 });
    mock.install();
  });

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
  });

  function setup() {
    render(
      <WorkspaceSettings
        projectId={projectId}
        projectName="QC settings project"
        onProjectArchived={vi.fn()}
        onPreferencesChanged={vi.fn()}
        onUnauthorized={onUnauthorized}
      />,
    );
  }

  it("renders the persisted rounds, mode, and rebuttals toggle on load", async () => {
    setup();

    expect(await screen.findByTestId("qc-settings-rounds")).toHaveTextContent("3");
    expect(await screen.findByTestId("qc-settings-mode")).toHaveValue("gated_when_contested");
    expect(await screen.findByTestId("qc-settings-rebuttals")).not.toBeChecked();
  });

  it("submits an edited rounds count, mode, and rebuttals toggle via PATCH", async () => {
    const user = userEvent.setup();
    setup();

    await screen.findByTestId("qc-settings-mode");
    await user.click(screen.getByRole("button", { name: "More rounds" }));
    await user.selectOptions(screen.getByTestId("qc-settings-mode"), "gated_each_round");
    await user.click(screen.getByTestId("qc-settings-rebuttals"));
    await user.click(screen.getByTestId("qc-settings-save"));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" &&
            call.url === `/api/v2/projects/${projectId}/planning-reviewer`,
        ),
      ).toMatchObject({
        body: {
          qc_mode: "gated_each_round",
          allow_unadjudicated_rebuttals: true,
          default_max_rounds: 4,
        },
      }),
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("QCP-14: allows the rounds stepper down to 0 and disables pause controls", async () => {
    const user = userEvent.setup();
    setup();

    const decrement = await screen.findByRole("button", { name: "Fewer rounds" });
    await user.click(decrement);
    await user.click(decrement);
    await user.click(decrement);
    await user.click(decrement);

    expect(screen.getByTestId("qc-settings-rounds")).toHaveTextContent("0");
    expect(decrement).toBeDisabled();
    expect(screen.getByTestId("qc-settings-mode")).toBeDisabled();
    expect(screen.getByTestId("qc-settings-rebuttals")).toBeDisabled();
  });

  it("QCP-14: submits 0 rounds via PATCH", async () => {
    const user = userEvent.setup();
    setup();

    const decrement = await screen.findByRole("button", { name: "Fewer rounds" });
    await user.click(decrement);
    await user.click(decrement);
    await user.click(decrement);
    await user.click(screen.getByTestId("qc-settings-save"));

    await waitFor(() =>
      expect(
        mock.calls.find(
          (call) =>
            call.method === "PATCH" &&
            call.url === `/api/v2/projects/${projectId}/planning-reviewer`,
        ),
      ).toMatchObject({ body: { default_max_rounds: 0 } }),
    );
  });
});
