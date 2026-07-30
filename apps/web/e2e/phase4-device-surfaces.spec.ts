import { type Page, type Route, expect, test } from "@playwright/test";

const projectId = "phase4-project";
const deviceId = "phase4-device";

const project = {
  id: projectId,
  name: "Phase 4 QA",
  description: "Repository authorization surface verification",
  pm_provider: "anthropic",
  pm_model: "claude-sonnet-5",
  reviewer_provider: "openai",
  status: "active",
  created_at: "2026-07-30T12:00:00.000Z",
  plan_objective: null,
  source_type: "local",
  source_location: "phase4-qa",
  onboarding_scenario: null,
};

const device = {
  device_id: deviceId,
  owner_user_id: "phase4-owner",
  name: "Office Mac mini",
  location_label: "Office",
  os_family: "macos",
  os_version: "15.5",
  lifecycle: "active",
  status: {
    availability: "online",
    compatibility: "ready",
    workload: "idle",
    access: "owned",
  },
  last_seen_at: "2026-07-30T14:30:00.000Z",
  active_credential: {
    device_id: deviceId,
    credential_id: "phase4-credential",
    generation: 1,
    public_key_fingerprint: "a".repeat(64),
    state: "active",
    activated_at: "2026-07-29T12:00:00.000Z",
  },
  agent: {
    version: "1.4.0",
    protocol_version: "1",
    capabilities: ["shell", "visual-evidence"],
  },
  repository_grants: [],
  activity: {
    active_run_count: 0,
    queued_command_count: 0,
  },
};

const repositoryAccess = {
  device_id: deviceId,
  registrations: [
    {
      registration_id: "phase4-registration",
      repository_id: "phase4-repository",
      repository_display_name: "The Norns",
      default_branch: "main",
      state: "active",
      grants: [
        {
          grant_id: "phase4-current-grant",
          project_id: projectId,
          state: "active",
        },
      ],
    },
  ],
  eligible_projects: [
    { project_id: projectId, name: "Phase 4 QA" },
    { project_id: "phase4-second-project", name: "Release Lab" },
  ],
};

const executionTargets = {
  project_id: projectId,
  selected_execution_target_id: "phase4-current-grant",
  work_active: false,
  execution_targets: [
    {
      project_id: projectId,
      execution_target_id: "phase4-current-grant",
      name: "Office Mac mini",
      location_label: "Office",
      os_family: "macos",
      status: {
        availability: "online",
        compatibility: "ready",
        workload: "idle",
        access: "shared",
      },
      last_seen_at: "2026-07-30T14:30:00.000Z",
    },
    {
      project_id: projectId,
      execution_target_id: "phase4-second-grant",
      name: "Studio PC",
      location_label: "Studio",
      os_family: "windows",
      status: {
        availability: "offline",
        compatibility: "limited",
        workload: "busy",
        access: "pending",
      },
      last_seen_at: "2026-07-29T10:00:00.000Z",
    },
  ],
};

async function fulfill(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem("norns_cookie_session", "present");
    localStorage.setItem("norns_theme", "light");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/auth/me") {
      return fulfill(route, {
        id: "phase4-owner",
        email: "phase4-owner@norns.test",
        name: "Phase 4 Owner",
        role: "admin",
        status: "active",
      });
    }
    if (path === "/api/admin/users") return fulfill(route, []);
    if (path === "/api/admin/projects/archived") return fulfill(route, []);
    if (path === "/api/v2/admin/rules") {
      return fulfill(route, {
        filename: "NORN.md",
        content: "",
        version: 0,
        updated_at: null,
      });
    }
    if (path === "/api/auth/sessions") return fulfill(route, { sessions: [] });
    if (path === "/api/projects" && method === "GET") return fulfill(route, [project]);
    if (path === "/api/v2/attention") return fulfill(route, {}, 404);
    if (path === "/api/devices" && method === "GET") {
      return fulfill(route, { devices: [device] });
    }
    if (path === `/api/devices/${deviceId}` && method === "GET") {
      return fulfill(route, device);
    }
    if (path === `/api/devices/${deviceId}/repository-access` && method === "GET") {
      return fulfill(route, repositoryAccess);
    }
    if (path === `/api/v2/projects/${projectId}/access`) {
      return fulfill(route, {
        schema_version: 2,
        project_id: projectId,
        user_id: "phase4-owner",
        owner_user_id: "phase4-owner",
        can_access: true,
        can_manage_members: true,
        source: "owner",
      });
    }
    if (path === `/api/projects/${projectId}/execution-targets`) {
      return fulfill(route, executionTargets);
    }
    if (path === `/api/v2/projects/${projectId}/rules`) {
      return fulfill(route, {
        filename: "NORN.md",
        content: "",
        version: 0,
        updated_at: null,
      });
    }
    return fulfill(route, { error: "not_found" }, 404);
  });
}

test("Computers repository access stays usable on narrow and forced-color layouts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page.getByRole("tab", { name: "Computers", exact: true }).click();
  await page.getByRole("button", { name: "View details for Office Mac mini" }).click();

  const access = page.getByRole("region", { name: "Repository access" });
  await expect(access).toBeVisible();
  await expect(access.getByRole("article", { name: "The Norns" })).toContainText(
    "Default branch main",
  );
  await expect(access.getByText("Phase 4 QA", { exact: true })).toBeVisible();
  await expect(access).not.toContainText("phase4-registration");
  await expect(access).not.toContainText("phase4-repository");
  await expect(page.getByText(/hostname/i)).toHaveCount(0);

  const projectPicker = access.getByRole("combobox", { name: "Project for The Norns" });
  await projectPicker.focus();
  await page.keyboard.press("ArrowDown");
  await expect(projectPicker).toHaveValue("phase4-second-project");
  await access.getByRole("button", { name: "Remove Phase 4 QA access" }).click();
  await expect(access.getByText(/local files will not be deleted/i)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  const repositoryBox = await access.getByRole("article", { name: "The Norns" }).boundingBox();
  const grantButtonBox = await access
    .getByRole("button", { name: "Grant project access" })
    .boundingBox();
  expect(repositoryBox).not.toBeNull();
  expect(grantButtonBox).not.toBeNull();
  expect(grantButtonBox?.width ?? 0).toBeGreaterThan((repositoryBox?.width ?? 0) * 0.85);

  if (testInfo.project.name === "chromium") {
    await page.emulateMedia({ forcedColors: "active" });
    await projectPicker.focus();
    await expect
      .poll(() =>
        access
          .getByRole("article", { name: "The Norns" })
          .evaluate((element) => getComputedStyle(element).borderTopColor),
      )
      .not.toBe("rgba(0, 0, 0, 0)");
  }
});

test("Project Settings target choice stays keyboard operable and privacy reduced", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Enter Phase 4 QA", exact: true }).click();

  const workspaceNavigation = page.getByRole("navigation", { name: "Workspace sections" });
  await workspaceNavigation.getByRole("button", { name: "Settings", exact: true }).click();
  const targetRegion = page.getByRole("region", { name: "Execution target" });
  await expect(targetRegion).toBeVisible();

  const officeTarget = targetRegion.getByRole("radio", { name: /Office Mac mini/i });
  const studioTarget = targetRegion.getByRole("radio", { name: /Studio PC/i });
  await expect(officeTarget).toBeChecked();
  await officeTarget.focus();
  await page.keyboard.press("ArrowDown");
  await expect(studioTarget).toBeChecked();
  await expect(targetRegion.getByRole("button", { name: "Save execution target" })).toBeEnabled();
  await expect(targetRegion).not.toContainText("phase4-current-grant");
  await expect(targetRegion).not.toContainText("phase4-second-grant");
  await expect(targetRegion).not.toContainText("phase4-repository");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  const saveBox = await targetRegion
    .getByRole("button", { name: "Save execution target" })
    .boundingBox();
  const regionBox = await targetRegion.boundingBox();
  expect(saveBox).not.toBeNull();
  expect(regionBox).not.toBeNull();
  expect(saveBox?.width ?? 0).toBeGreaterThan((regionBox?.width ?? 0) * 0.8);

  if (testInfo.project.name === "chromium") {
    await page.emulateMedia({ forcedColors: "active" });
    await studioTarget.focus();
    await expect
      .poll(() =>
        studioTarget
          .locator("xpath=..")
          .evaluate((element) => getComputedStyle(element).borderTopWidth),
      )
      .toBe("3px");
  }
});
