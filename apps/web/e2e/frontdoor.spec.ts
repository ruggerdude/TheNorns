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
    onboarding_scenario: source === "github" ? "existing_repo" : null,
  };
}

const convergedAdoptionRun = {
  id: "planning-adoption",
  status: "converged",
  round: 1,
  max_rounds: 3,
  review_rounds_total: 3,
  rounds_completed: 1,
  worker_providers: "both",
  decision: null,
  transcript: [],
  result: {
    plan: {
      modules: [
        {
          id: "implementation",
          title: "Deployment workflow",
          description: "Implement and verify the requested deployment improvements.",
        },
      ],
    },
    content_hash: "a".repeat(64),
    total_cost_usd: 1.25,
    staffing_proposal: {
      summary: "One implementation agent with cross-provider review.",
      recommendations: [
        {
          node_id: "implementation",
          provider: "anthropic",
          model: "claude-sonnet-5",
          worker_count: 1,
          reviewer_model: "gpt-5.6-sol",
          budget_usd: 25,
          rationale: "Focused implementation.",
        },
      ],
    },
  },
  error: null,
};

async function fulfill(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function prepare(page: Page, mode: "github" | "local" | "new") {
  let projects: ReturnType<typeof project>[] = [];
  let planningCreated = false;
  const observed = {
    onboardingRequests: [] as unknown[],
    planningDecisions: [] as unknown[],
  };
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
    if (
      path.startsWith("/api/integrations/github/connections/") &&
      path.endsWith("/repositories")
    ) {
      return fulfill(route, [repository]);
    }
    if (path === "/api/runners/helper/repositories") {
      return fulfill(route, {
        state: "connected",
        runner_id: "runner-local",
        message: "The Norns helper is ready.",
        install_command: "",
        install_command_windows: "",
        repositories: [
          {
            selection_token: "selection:e2e",
            expires_at: "2026-07-23T12:05:00Z",
            repository: {
              runner_id: "runner-local",
              workspace_id: "workspace-local",
              repository_id: "repo-local",
              repository_display_name: "local-front-door",
              default_branch: "main",
              observed_head: "abc123",
            },
          },
        ],
      });
    }
    if (path === "/api/v2/projects/onboarding") {
      const body = request.postDataJSON() as {
        name: string;
        description: string;
        scenario: "new_repo" | "existing_repo";
      };
      observed.onboardingRequests.push(body);
      projects = [
        {
          ...project("project-github", "github"),
          name: body.name,
          description: body.description,
          onboarding_scenario: body.scenario,
        },
      ];
      return fulfill(
        route,
        {
          project_id: "project-github",
          scenario: body.scenario,
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
    if (path.endsWith("/analyze-repository")) {
      return fulfill(route, {
        architecture_revision: 1,
        title: "Repository architecture",
        summary: "Understood",
      });
    }
    if (path.endsWith("/planning-runs") && request.method() === "POST") {
      planningCreated = true;
      return fulfill(route, { planning_run_id: "planning-adoption" }, 202);
    }
    if (path.endsWith("/planning-runs/latest")) {
      return fulfill(route, { planning_run: planningCreated ? convergedAdoptionRun : null });
    }
    if (path.endsWith("/planning-runs/planning-adoption") && request.method() === "GET") {
      return fulfill(route, convergedAdoptionRun);
    }
    if (path.endsWith("/planning-runs/planning-adoption/decision") && request.method() === "POST") {
      observed.planningDecisions.push(request.postDataJSON());
      return fulfill(route, {
        ...convergedAdoptionRun,
        status: "approved",
        decision: {
          decision: "approve",
          direction: null,
          staffing: null,
          decided_at: "2026-07-25T12:00:00Z",
        },
        execution: {
          started: true,
          detail: "Started phase: 1 task dispatched.",
        },
      });
    }
    if (path.endsWith("/execution-status")) {
      return fulfill(route, {
        project_id: projects[0]?.id ?? "project-e2e",
        phases: [
          {
            phase_id: "phase-implementation",
            name: "Deployment workflow",
            state: "active",
            percent_complete: 0,
            est_completion: null,
            notes: "1 run active",
          },
        ],
      });
    }
    if (/^\/api\/projects\/project-[^/]+$/.test(path) && request.method() === "GET") {
      return fulfill(route, projects[0]);
    }
    if (path.includes("/planning-reviewer") && request.method() === "DELETE") {
      return route.fulfill({ status: 204, body: "" });
    }
    if (path.endsWith("/resume")) {
      return fulfill(route, {
        project_id: projects[0]?.id ?? "project-e2e",
        architecture: null,
        repositories: [],
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        next_recommended_action: "Create the project's next phase",
      });
    }
    if (path.endsWith("/graph")) return fulfill(route, { error: "not_planned" }, 409);
    return fulfill(route, { error: `Unexpected ${request.method()} ${path} (${mode})` }, 404);
  });
  return observed;
}

test("GitHub front door creates and immediately enters the project", async ({ page }) => {
  await prepare(page, "github");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByRole("button", { name: /^existing/i }).click();
  await page.getByRole("button", { name: /octocat\/front-door-app/i }).click();
  await page.getByRole("button", { name: /adopt project/i }).click();
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
  await page.getByRole("button", { name: /local-front-door/i }).click();
  await page.getByRole("button", { name: /adopt project/i }).click();
  await expect(page.getByText("local-front-door", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/loading graph/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /main menu/i })).toBeVisible();
});

test("Directed adoption reaches one approval and starts the first coding task", async ({
  page,
}) => {
  const observed = await prepare(page, "github");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByRole("button", { name: /^existing/i }).click();
  await page.getByRole("button", { name: /octocat\/front-door-app/i }).click();
  await page
    .getByTestId("project-description")
    .fill("Improve the deployment workflow and implement it");
  await page.getByRole("button", { name: /adopt project/i }).click();

  await expect(page.getByTestId("phase-decision-panel")).toBeVisible();
  await page.getByRole("button", { name: /approve & start coding/i }).click();
  await expect(page.getByTestId("phase-execution-kickoff-note")).toContainText(
    "Execution started automatically",
  );
  await expect(page.getByTestId("phase-execution-table")).toContainText("active");
  expect(observed.planningDecisions).toEqual([expect.objectContaining({ decision: "approve" })]);
});

test("New project goes from one brief to the first coding task", async ({ page }) => {
  const observed = await prepare(page, "new");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();

  await expect(page.getByTestId("automatic-github-destination")).toContainText("octocat");
  await page
    .getByTestId("project-description")
    .fill("Build a deployment workflow dashboard for release managers.");
  await expect(page.getByTestId("derived-project-summary")).toContainText(
    "Deployment workflow dashboard for release managers",
  );
  await page.getByRole("button", { name: /create & start planning/i }).click();

  await expect(page.getByTestId("phase-decision-panel")).toBeVisible();
  await page.getByRole("button", { name: /approve & start coding/i }).click();
  await expect(page.getByTestId("phase-execution-kickoff-note")).toContainText(
    "Execution started automatically",
  );
  await expect(page.getByTestId("phase-execution-table")).toContainText("active");
  expect(observed.onboardingRequests).toEqual([
    expect.objectContaining({
      scenario: "new_repo",
      name: "Deployment workflow dashboard for release managers",
      repository_name: "deployment-workflow-dashboard-for-release-managers",
    }),
  ]);
  expect(observed.planningDecisions).toEqual([expect.objectContaining({ decision: "approve" })]);
});

test("Workspace is wide, uses flat navigation, and has one integrated prompt composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await prepare(page, "github");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByRole("button", { name: /^existing/i }).click();
  await page.getByRole("button", { name: /octocat\/front-door-app/i }).click();
  await page.getByRole("button", { name: /adopt project/i }).click();

  const workspace = page.locator(".workspace-page");
  await expect(workspace).toBeVisible();
  expect((await workspace.boundingBox())?.width ?? 0).toBeGreaterThan(1400);

  const planTab = page.getByRole("button", { name: "Plan", exact: true });
  await planTab.click();
  await expect(planTab).toHaveAttribute("aria-current", "page");
  await expect(planTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const composer = page.getByTestId("attachment-dropzone");
  await expect(composer).toBeVisible();
  await expect(page.getByTestId("next-phase-objective")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add images or files" })).toBeVisible();
  await expect(page.getByText("Attach screenshots")).toHaveCount(0);
});
