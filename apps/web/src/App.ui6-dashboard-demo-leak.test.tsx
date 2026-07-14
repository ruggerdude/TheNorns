// UI-6 (containment): opening a real project's workspace used to expose a
// "Dashboard ↗" entry that fetched and rendered an unrelated hardcoded global
// demo session's data (GET /api/dashboard, since moved by Agent C to
// /api/demo/dashboard). The approved fix is containment-only: hide the
// Dashboard entry for real projects — a durable per-project dashboard is
// deferred.
//
// This test was rewritten (not merely flipped) once containment landed: it now
// asserts the entry is gone and that NO dashboard fetch fires for a real
// project — neither the old /api/dashboard path nor Agent C's new
// /api/demo/dashboard one.
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { renderAppAndOpenProject, seedAuth } from "./test/appHarness";
import { fullyAllocatedGraph, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

describe("UI-6 (contained): a real project's workspace exposes no demo Dashboard entry", () => {
  let mock: MockFetch;

  beforeEach(() => {
    seedAuth();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get(`/api/projects/${projectAlpha.id}/graph`, { body: fullyAllocatedGraph });
    // Deliberately register the demo dashboard routes so that, if the workspace
    // ever fetched one, the call would succeed and be recorded (making a
    // regression loud) rather than throwing "no route".
    mock.get("/api/dashboard", { body: { pm_summary: "SHOULD NEVER RENDER" } });
    mock.get("/api/demo/dashboard", { body: { pm_summary: "SHOULD NEVER RENDER" } });
    mock.install();
  });

  test("no Dashboard button is rendered and no dashboard fetch fires", async () => {
    await renderAppAndOpenProject(projectAlpha.name);
    await screen.findByTestId("graph-version");

    // The entry point is gone entirely.
    expect(screen.queryByRole("button", { name: /dashboard/i })).not.toBeInTheDocument();

    // And nothing about opening a real project reached any dashboard surface.
    expect(mock.calls.some((c) => c.url === "/api/dashboard")).toBe(false);
    expect(mock.calls.some((c) => c.url === "/api/demo/dashboard")).toBe(false);
  });
});
