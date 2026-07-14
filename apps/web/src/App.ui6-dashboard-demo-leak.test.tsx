// UI-6: opening any real project's "Dashboard" currently fetches and fully
// renders an unrelated hardcoded global demo project's data (GET
// /api/dashboard, backed by main.ts's demoSession). A disclosure banner
// exists but the wrong data still renders. The approved fix (not yet
// implemented, containment-only per the accepted remediation plan) is to
// hide/disable the Dashboard entry for real projects — a durable
// per-project dashboard is deferred.
//
// Unlike every other test in this suite, this one is NOT written to assert
// the eventual-correct behavior — there is no way to know today whether the
// future fix hides the button, disables it, or something else, and "assert
// it's gone" would just be a different guess. Instead it documents today's
// actual (buggy) behavior precisely: the entry is present, clickable, and
// renders the demo session's data inside a real project's workspace. This
// test is EXPECTED TO PASS now. Once containment lands, this test will need
// to be rewritten (not just flipped) to match whatever the real fix does —
// flag that explicitly to whichever agent implements Workstream C.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { demoDashboard, fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-6 (documents current behavior, not yet fixed): Dashboard entry leaks demo data", () => {
  let mock: MockFetch;

  beforeEach(() => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    mock.get("/api/dashboard", { body: demoDashboard });
    mock.install();
  });

  test("a real project's Dashboard entry is present, clickable, and shows the demo session's data", async () => {
    const { user } = await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("graph-version");

    const dashboardButton = screen.getByRole("button", { name: /dashboard/i });
    expect(dashboardButton).not.toBeDisabled();
    await user.click(dashboardButton);

    // The disclosure banner exists...
    expect(await screen.findByText(/demo data/i)).toBeInTheDocument();
    // ...but the actual figures rendered are the demo session's, not
    // anything scoped to projectAlpha — nothing about this project (its id,
    // its graph, its plan) informed this fetch at all.
    expect(mock.calls.some((c) => c.url === "/api/dashboard")).toBe(true);
    expect(screen.getByTestId("pm-summary")).toHaveTextContent(demoDashboard.pm_summary);
  });
});
