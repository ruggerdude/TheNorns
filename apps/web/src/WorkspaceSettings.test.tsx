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
    expect(await screen.findByText("QC settings saved")).toBeVisible();
  });

  it("QCP-14: allows the rounds stepper down to 0 and labels it as review off", async () => {
    const user = userEvent.setup();
    setup();

    const decrement = await screen.findByRole("button", { name: "Fewer rounds" });
    await user.click(decrement);
    await user.click(decrement);
    await user.click(decrement);
    await user.click(decrement);

    expect(screen.getByTestId("qc-settings-rounds")).toHaveTextContent("0");
    expect(decrement).toBeDisabled();
    expect(screen.getByText(/review is off/i)).toBeVisible();
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
