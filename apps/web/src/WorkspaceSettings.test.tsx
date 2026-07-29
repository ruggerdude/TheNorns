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
