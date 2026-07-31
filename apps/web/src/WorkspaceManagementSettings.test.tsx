import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ArchivedProjectsSettings, GlobalRulesSettings } from "./WorkspaceManagementSettings";
import { MockFetch } from "./test/mockFetch";

describe("workspace management settings", () => {
  let mock: MockFetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mock = new MockFetch();
  });

  test("loads and saves the global NORN.md from Settings", async () => {
    mock.get("/api/v2/admin/rules", {
      body: { filename: "NORN.md", content: "", version: 0, updated_at: null },
    });
    mock.put("/api/v2/admin/rules", (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ content: "# Global rules\n\n- Keep updates concise." });
      return {
        body: {
          filename: "NORN.md",
          content: body.content,
          version: 1,
          updated_at: "2026-07-31T01:00:00.000Z",
        },
      };
    });
    mock.install();

    const user = userEvent.setup();
    render(<GlobalRulesSettings onUnauthorized={vi.fn()} />);
    const editor = await screen.findByRole("textbox", { name: "Global NORN.md" });
    await user.type(editor, "# Global rules\n\n- Keep updates concise.");
    await user.click(screen.getByRole("button", { name: "Save global rules" }));

    expect(await screen.findByText("v1")).toBeVisible();
    expect(editor).toHaveValue("# Global rules\n\n- Keep updates concise.");
  });

  test("unarchives a project from Settings", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let restored = false;
    mock.get("/api/admin/projects/archived", () => ({
      body: restored
        ? []
        : [
            {
              id: "project-archived",
              name: "Archived project",
              description: "Return this project to Portfolio",
              archived_at: "2026-07-28T12:00:00.000Z",
            },
          ],
    }));
    mock.post("/api/admin/projects/project-archived/restore", () => {
      restored = true;
      return { body: { ok: true } };
    });
    mock.install();

    const user = userEvent.setup();
    render(<ArchivedProjectsSettings onUnauthorized={vi.fn()} />);

    expect(await screen.findByTestId("archived-project-list")).toHaveTextContent(
      "Archived project",
    );
    await user.click(screen.getByRole("button", { name: "Unarchive" }));

    expect(await screen.findByText("No archived projects.")).toBeVisible();
  });
});
