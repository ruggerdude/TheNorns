import { type Page, type Route, expect, test } from "@playwright/test";

const githubStatus = {
  configured: true,
  user_authorization: { connected: true, login: "octocat" },
  connections: [
    {
      id: "github:42",
      provider: "github",
      display_name: "octocat",
      owner_type: "user",
      owner_login: "octocat",
      installation_id: "42",
      repository_selection: "all",
      status: "connected",
      last_validated_at: "2026-07-23T12:00:00Z",
    },
  ],
};

const repository = {
  id: "9001",
  connection_id: "github:42",
  owner: "octocat",
  name: "front-door-app",
  full_name: "octocat/front-door-app",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/octocat/front-door-app",
  clone_url: "https://github.com/octocat/front-door-app.git",
  description: "Browser journey repository",
  language: "TypeScript",
  archived: false,
  updated_at: "2026-07-23T12:00:00Z",
};

function project(id: string, source: "github" | "local") {
  return {
    id,
    name: source === "github" ? "front-door-app" : "local-front-door",
    description: "Browser-created project",
    pm_provider: "anthropic",
    pm_model: "claude-sonnet-5",
    reviewer_provider: "openai",
    status: "draft",
    created_at: "2026-07-23T12:00:00Z",
    plan_objective: null,
    source_type: source,
    source_location:
      source === "github" ? "https://github.com/octocat/front-door-app.git" : "local-front-door",
  };
}

async function fulfill(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function prepare(page: Page, mode: "github" | "local") {
  let projects: ReturnType<typeof project>[] = [];
  await page.addInitScript(() => {
    sessionStorage.setItem("norns_cookie_session", "present");
    localStorage.setItem("norns_theme", "light");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/auth/me") {
      return fulfill(route, {
        id: "user-e2e",
        email: "e2e@norns.test",
        name: "E2E",
        role: "admin",
        status: "active",
      });
    }
    if (path === "/api/projects" && request.method() === "GET") {
      return fulfill(route, projects);
    }
    if (path === "/api/v2/attention") return fulfill(route, {}, 404);
    if (path === "/api/integrations/github/status") return fulfill(route, githubStatus);
    if (path.endsWith("/repositories")) return fulfill(route, [repository]);
    if (path === "/api/runners/helper/status") {
      return fulfill(route, {
        state: "connected",
        runner_id: "runner-local",
        message: "The Norns helper is ready.",
        install_command: "",
        install_command_windows: "",
      });
    }
    if (path === "/api/runners/runner-local/workspaces/choose") {
      return fulfill(route, {
        selection_token: "selection:e2e",
        expires_at: "2026-07-23T12:05:00Z",
        repository: {
          runner_id: "runner-local",
          repository_id: "repo-local",
          repository_display_name: "local-front-door",
          default_branch: "main",
          observed_head: "abc123",
        },
      });
    }
    if (path === "/api/v2/projects/onboarding") {
      projects = [project("project-github", "github")];
      return fulfill(
        route,
        {
          project_id: "project-github",
          scenario: "existing_repo",
          replayed: false,
          blockers: [],
        },
        201,
      );
    }
    if (path === "/api/v2/projects/local") {
      projects = [project("project-local", "local")];
      return fulfill(route, projects[0], 201);
    }
    if (/^\/api\/projects\/project-[^/]+$/.test(path) && request.method() === "GET") {
      return fulfill(route, projects[0]);
    }
    if (path.includes("/planning-reviewer") && request.method() === "DELETE") {
      return route.fulfill({ status: 204, body: "" });
    }
    if (path.endsWith("/resume")) return fulfill(route, {}, 404);
    if (path.endsWith("/graph")) return fulfill(route, { error: "not_planned" }, 409);
    return fulfill(route, { error: `Unexpected ${request.method()} ${path} (${mode})` }, 404);
  });
}

test("GitHub front door creates and immediately enters the project", async ({ page }) => {
  await prepare(page, "github");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByRole("button", { name: /^existing/i }).click();
  await page.getByRole("button", { name: /octocat\/front-door-app/i }).click();
  await page.getByRole("button", { name: /create and open project/i }).click();
  await expect(page.getByText("front-door-app", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /main menu/i })).toBeVisible();
});

test("Local front door uses the helper selection and opens a nonblank workspace", async ({
  page,
}) => {
  await prepare(page, "local");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByRole("button", { name: /^existing/i }).click();
  await page.getByRole("button", { name: /^local folder/i }).click();
  await page.getByRole("button", { name: /^choose folder$/i }).click();
  await expect(page.getByTestId("local-folder-selection")).toContainText("local-front-door");
  await page.getByRole("button", { name: /create and open project/i }).click();
  await expect(page.getByText("local-front-door", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/loading graph/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /main menu/i })).toBeVisible();
});
