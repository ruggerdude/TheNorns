import { type Locator, type Page, type Route, expect, test } from "@playwright/test";

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
  mode: "planned",
  objective: "Improve the deployment workflow and implement it",
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
  execution: null,
};

async function fulfill(route: Route, payload: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function prepare(
  page: Page,
  mode: "github" | "local" | "new",
  options: { githubInitiallyInstalled?: boolean; conversationWorkspace?: boolean } = {},
) {
  let projects: ReturnType<typeof project>[] = [];
  let planningCreated = false;
  let githubInstalled = options.githubInitiallyInstalled ?? true;
  const observed = {
    installRequests: 0,
    onboardingRequests: [] as unknown[],
    localProjectRequests: [] as unknown[],
    planningRequests: [] as unknown[],
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
    if (path === "/api/auth/sessions") {
      return fulfill(route, { sessions: [] });
    }
    if (path === "/api/admin/users") {
      return fulfill(route, []);
    }
    if (path === "/api/v2/admin/rules") {
      return fulfill(route, {
        filename: "NORN.md",
        content: "",
        version: 1,
        updated_at: null,
      });
    }
    if (path === "/api/v2/capabilities/execution-models") {
      return fulfill(route, {
        ready: true,
        required_environment: [],
        models: [
          {
            id: "claude-sonnet-5",
            provider: "anthropic",
            label: "Claude Sonnet 5",
            available: true,
            unavailable_reason: null,
          },
          {
            id: "gpt-5.6-sol",
            provider: "openai",
            label: "GPT-5.6 Sol",
            available: true,
            unavailable_reason: null,
          },
        ],
      });
    }
    if (path === "/api/projects" && request.method() === "GET") {
      return fulfill(route, projects);
    }
    if (path === "/api/v2/attention") return fulfill(route, {}, 404);
    if (path === "/api/integrations/github/status") {
      return fulfill(route, githubInstalled ? githubStatus : { ...githubStatus, connections: [] });
    }
    if (path === "/api/integrations/github/install") {
      observed.installRequests += 1;
      githubInstalled = true;
      return fulfill(route, {
        installation_url: `${url.origin}/?github=installed`,
      });
    }
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
    if (path.startsWith("/api/usage/") && path.endsWith("/summary")) {
      return fulfill(route, {
        requests: 1,
        succeeded_requests: 1,
        failed_requests: 0,
        in_progress_requests: 0,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0.01,
        known_cost_usd: 0.01,
        priced_requests: 1,
        unpriced_requests: 0,
        average_latency_ms: 200,
        average_output_tokens: 20,
        average_known_cost_usd: 0.01,
      });
    }
    if (path.startsWith("/api/usage/") && path.endsWith("/timeseries")) {
      return fulfill(route, { interval: "day", points: [] });
    }
    if (path.startsWith("/api/usage/") && path.endsWith("/events")) {
      return fulfill(route, { events: [], limit: 100, offset: 0, has_more: false });
    }
    if (path.startsWith("/api/usage/") && path.endsWith("/breakdown")) {
      return fulfill(route, { breakdowns: [] });
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
      observed.localProjectRequests.push(request.postDataJSON());
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
      observed.planningRequests.push(request.postDataJSON());
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
    if (
      options.conversationWorkspace &&
      /^\/api\/v2\/projects\/project-[^/]+\/work-items$/.test(path) &&
      request.method() === "GET"
    ) {
      return fulfill(route, {
        work_items: [
          {
            work_item: {
              schema_version: 2,
              id: "work-e2e",
              project_id: "project-github",
              created_by_user_id: "user-e2e",
              title: "# Release readiness",
              objective: "Plan the release dashboard and deployment health workflow.",
              status: "planning",
              planning_run_id: null,
              phase_id: null,
              approved_plan_version_id: null,
              aggregate_version: 1,
              created_at: "2026-07-28T12:00:00.000Z",
              updated_at: "2026-07-28T12:00:00.000Z",
              execution_started_at: null,
              completed_at: null,
            },
            conversations: [
              {
                schema_version: 2,
                id: "conversation-e2e",
                project_id: "project-github",
                work_item_id: "work-e2e",
                created_by_user_id: "user-e2e",
                kind: "planning",
                status: "active",
                provider: "anthropic",
                model: "claude-sonnet-5",
                next_message_sequence: 2,
                created_at: "2026-07-28T12:00:00.000Z",
                updated_at: "2026-07-28T12:00:00.000Z",
                archived_at: null,
              },
            ],
          },
        ],
      });
    }
    if (
      options.conversationWorkspace &&
      path.endsWith("/work-items/work-e2e/conversations/conversation-e2e")
    ) {
      return fulfill(route, {
        work_item: {
          schema_version: 2,
          id: "work-e2e",
          project_id: "project-github",
          created_by_user_id: "user-e2e",
          title: "# Release readiness",
          objective: "Plan the release dashboard and deployment health workflow.",
          status: "planning",
          planning_run_id: null,
          phase_id: null,
          approved_plan_version_id: null,
          aggregate_version: 1,
          created_at: "2026-07-28T12:00:00.000Z",
          updated_at: "2026-07-28T12:00:00.000Z",
          execution_started_at: null,
          completed_at: null,
        },
        conversation: {
          schema_version: 2,
          id: "conversation-e2e",
          project_id: "project-github",
          work_item_id: "work-e2e",
          created_by_user_id: "user-e2e",
          kind: "planning",
          status: "active",
          provider: "anthropic",
          model: "claude-sonnet-5",
          next_message_sequence: 2,
          created_at: "2026-07-28T12:00:00.000Z",
          updated_at: "2026-07-28T12:00:00.000Z",
          archived_at: null,
        },
        messages: [
          {
            schema_version: 2,
            id: "message-e2e",
            project_id: "project-github",
            work_item_id: "work-e2e",
            conversation_id: "conversation-e2e",
            initiated_by_user_id: "user-e2e",
            actor: { actor_type: "agent", actor_id: "project-pm" },
            role: "assistant",
            visibility_status: "complete",
            sequence: 1,
            parts: [
              {
                type: "text",
                format: "markdown",
                text: "I mapped the release workflow and the remaining deployment risks.",
              },
            ],
            client_message_id: null,
            request_fingerprint: null,
            created_at: "2026-07-28T12:00:00.000Z",
          },
        ],
        active_attempt: null,
        retryable_attempt: null,
        plan_versions: [],
        actions: [],
        plan_reviews: [],
        action_effects: [],
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

async function expectWorkspaceNavigation(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Workspace sections" });
  const overview = navigation.getByRole("button", { name: /overview/i });
  const work = navigation.getByRole("button", { name: /work$/i });

  await expect(navigation).toBeVisible();
  await expect(overview).toHaveAttribute("aria-current", "page");
  await expect(work).toBeVisible();
  await work.click();
  await expect(work).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("workspace-tab-work")).toBeVisible();
}

async function clickUntilVisible(trigger: Locator, result: Locator) {
  await expect(async () => {
    if (await result.isVisible()) return;
    await trigger.click();
    await expect(result).toBeVisible({ timeout: 2_000 });
  }).toPass({ intervals: [100, 250, 500], timeout: 10_000 });
}

async function openExistingProjectWizard(page: Page) {
  const existing = page.getByRole("button", { name: /^existing/i });
  await clickUntilVisible(page.getByRole("button", { name: /new project/i }), existing);
  await clickUntilVisible(
    existing,
    page.getByRole("group", { name: /where is the existing code/i }),
  );
  return existing;
}

async function selectExistingGitHubRepository(page: Page) {
  const existing = await openExistingProjectWizard(page);
  const repository = page.getByRole("button", { name: /octocat\/front-door-app/i });
  await clickUntilVisible(existing, repository);
  await repository.click();
}

test("GitHub front door creates and immediately enters the project", async ({ page }) => {
  await prepare(page, "github");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();
  await expect(page.getByText("front-door-app", { exact: true }).first()).toBeVisible();
  await expectWorkspaceNavigation(page);
});

test("Local front door uses the helper selection and opens a nonblank workspace", async ({
  page,
}) => {
  await prepare(page, "local");
  await page.goto("/");
  await openExistingProjectWizard(page);
  await page.getByRole("button", { name: /^approved local git repository/i }).click();
  await page.getByRole("button", { name: /local-front-door/i }).click();
  await page.getByRole("button", { name: /adopt project/i }).click();
  await expect(page.getByText("local-front-door", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/loading graph/i)).toHaveCount(0);
  await expectWorkspaceNavigation(page);
});

// DESIGN R2: the wizard is name-first and never starts a planning run —
// planning begins in the conversation after creation, so this journey ends at
// the opened workspace.
test("New work can use an approved local Git repository and open the workspace", async ({
  page,
}) => {
  const observed = await prepare(page, "local");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByTestId("project-name").fill("Local release readiness dashboard");
  await page.getByRole("button", { name: /^approved local git repository/i }).click();
  await expect(page.getByTestId("setup-confirmation")).toContainText(
    "will not create a folder or initialize Git",
  );
  await page.getByRole("button", { name: /local-front-door/i }).click();
  await expect(page.getByTestId("derived-project-summary")).toContainText(
    "New Norns project in local-front-door",
  );
  await page.getByRole("button", { name: /create project/i }).click();

  await expectWorkspaceNavigation(page);
  expect(observed.onboardingRequests).toEqual([]);
  expect(observed.localProjectRequests).toEqual([
    expect.objectContaining({
      name: "Local release readiness dashboard",
      description: "",
      selection_token: "selection:e2e",
    }),
  ]);
  expect(observed.planningRequests).toEqual([]);
});

test("Directed adoption reaches one approval and starts the first coding task", async ({
  page,
}) => {
  const observed = await prepare(page, "github");
  await page.goto("/");
  await selectExistingGitHubRepository(page);
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

// DESIGN R2: the wizard collects only the project name and creates the
// project — planning (and the approval that used to follow in this spec)
// now happens in the conversation workspace after creation, so this journey
// is create-with-name → land in the workspace. The directed-adoption test
// above still covers the plan-approval → first-coding-task leg.
test("New project creates from a name and lands in the workspace", async ({ page }) => {
  const observed = await prepare(page, "new");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();

  // DESIGN R2: no in-page "Project setup" heading — the topbar location
  // "New project" is the title — and the standard wide container replaces
  // the narrow one.
  await expect(page.getByRole("heading", { name: "Project setup" })).toHaveCount(0);
  await expect(page.locator(".full-page-header")).toBeVisible();
  await expect(page.locator(".full-page-header")).toContainText("New project");
  await expect(page.getByText("Guided setup")).toHaveCount(0);
  const setupPage = await page.getByRole("main", { name: "New project" }).boundingBox();
  const setupWidth = setupPage?.width ?? 0;
  expect(setupWidth).toBeGreaterThan(900);
  expect(setupWidth).toBeLessThanOrEqual(1216);

  await expect(page.getByTestId("automatic-github-destination")).toContainText("octocat");
  await page.getByTestId("project-name").fill("Deployment workflow dashboard for release managers");
  await expect(page.getByTestId("derived-project-summary")).toContainText(
    "Deployment workflow dashboard for release managers",
  );
  await page.getByRole("button", { name: /create project/i }).click();

  await expectWorkspaceNavigation(page);
  expect(observed.onboardingRequests).toEqual([
    expect.objectContaining({
      scenario: "new_repo",
      name: "Deployment workflow dashboard for release managers",
      description: "",
      repository_name: "deployment-workflow-dashboard-for-release-managers",
    }),
  ]);
  expect(observed.planningRequests).toEqual([]);
});

test("Authorized-only GitHub setup finishes installation before creating a new project", async ({
  page,
}) => {
  const observed = await prepare(page, "new", { githubInitiallyInstalled: false });
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();

  await expect(page.getByText("Finish GitHub setup", { exact: true })).toBeVisible();
  await expect(page.getByText(/identity is authorized as octocat/i)).toBeVisible();
  await page.getByRole("button", { name: "Install The Norns on GitHub" }).click();
  await page.waitForURL("/");

  await page.getByRole("button", { name: /new project/i }).click();
  await expect(page.getByTestId("automatic-github-destination")).toContainText("octocat");
  await page.getByTestId("project-name").fill("Verified setup journey");
  await page.getByRole("button", { name: /create project/i }).click();

  await expectWorkspaceNavigation(page);
  expect(observed.installRequests).toBe(1);
  expect(observed.onboardingRequests).toEqual([
    expect.objectContaining({
      scenario: "new_repo",
      name: "Verified setup journey",
      repository_name: "verified-setup-journey",
    }),
  ]);
});

test("Workspace uses left navigation and gives the conversation nearly the full viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await prepare(page, "github", { conversationWorkspace: true });
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  const workspace = page.locator(".workspace-page");
  await expect(workspace).toBeVisible();
  const workspaceBox = await workspace.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(workspaceBox?.width ?? 0).toBeGreaterThanOrEqual(1280);
  expect(workspaceBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1360);
  expect(workspaceBox?.x ?? 0).toBeGreaterThan(248);

  const navigationRail = page.locator(".workspace-shell > .topbar");
  const railBox = await navigationRail.boundingBox();
  expect(railBox).not.toBeNull();
  expect(railBox?.x).toBe(0);
  expect(railBox?.width).toBe(248);
  expect(railBox?.height).toBe(1080);
  const projectContext = page.getByTestId("workspace-project-context");
  await expect(projectContext.getByText("Project", { exact: true })).toBeVisible();
  await expect(projectContext.getByText("front-door-app", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Open projects" })).toHaveCount(0);

  const workspaceNavigation = page.getByRole("navigation", { name: "Workspace sections" });
  const projectContextBox = await projectContext.boundingBox();
  const workspaceNavigationBox = await workspaceNavigation.boundingBox();
  expect(projectContextBox).not.toBeNull();
  expect(workspaceNavigationBox).not.toBeNull();
  expect(workspaceNavigationBox?.y ?? 0).toBeGreaterThanOrEqual(
    (projectContextBox?.y ?? 0) + (projectContextBox?.height ?? 0) + 8,
  );

  const portfolioButtonBox = await page.getByRole("button", { name: "← Portfolio" }).boundingBox();
  const usageButtonBox = await page
    .getByRole("button", { name: "Usage", exact: true })
    .boundingBox();
  expect(portfolioButtonBox?.x).toBe(16);
  expect(usageButtonBox?.x).toBe(16);
  expect(portfolioButtonBox?.width ?? 0).toBeGreaterThanOrEqual(214);
  expect(usageButtonBox?.width).toBe(portfolioButtonBox?.width);

  const workTab = workspaceNavigation.getByRole("button", { name: /work$/i });
  await workTab.click();
  await expect(workTab).toHaveAttribute("aria-current", "page");
  // The active-tab background fades in over a .14s transition; an instant
  // read races it (this assertion used to flake). Poll until it settles.
  await expect
    .poll(async () => workTab.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)");
  expect(await workTab.evaluate((element) => getComputedStyle(element, "::before").content)).toBe(
    "none",
  );

  await expect(page.getByText("I mapped the release workflow")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release readiness" })).toBeVisible();
  await expect(page.getByText("# Release readiness", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Conversation", { exact: true })).toBeVisible();
  const planningComposer = page.getByRole("textbox", { name: "Message the project PM" });
  await expect(planningComposer).toBeVisible();
  await expect(planningComposer).toHaveAttribute(
    "placeholder",
    "Message the PM, or say “Use this as the plan”…",
  );
  await expect(page.getByRole("button", { name: "Use conversation as plan" })).toHaveText("Plan");
  await page.getByRole("button", { name: "Use conversation as plan" }).click();
  const planHandoff = page.getByRole("dialog", { name: "How should this plan proceed?" });
  await expect(planHandoff).toContainText(
    "The PM uses the whole chat as context, then keeps only the latest agreed plan",
  );
  await expect(planHandoff.getByRole("combobox", { name: "Execution agent" })).toBeVisible();
  await expect(planHandoff.getByRole("combobox", { name: "QC agent" })).toBeVisible();
  await expect(planHandoff.getByRole("combobox", { name: "QC rounds" })).toBeVisible();
  await planHandoff.getByRole("radio", { name: /Skip QC/ }).check();
  await expect(planHandoff.getByRole("combobox", { name: "QC agent" })).toHaveCount(0);
  await expect(planHandoff.getByRole("button", { name: "Create plan & start" })).toBeVisible();
  await planHandoff.getByRole("button", { name: "Cancel" }).click();
  await expect(planHandoff).toHaveCount(0);
  const planningWorkflow = page.getByRole("region", { name: "Planning workflow" });
  await expect(planningWorkflow).toBeVisible();
  await expect(planningWorkflow.locator('[aria-current="step"]')).toHaveText("Chat");
  await expect(planningWorkflow.getByRole("button", { name: "Create plan" })).toBeVisible();
  await expect(page.locator(".conversation-sidebar")).toHaveCount(0);
  await expect(
    page.getByText("Plan the release dashboard and deployment health workflow.", { exact: true }),
  ).toHaveCount(0);

  const conversationBox = await page.locator(".conversation-workspace").boundingBox();
  const conversationMainBox = await page.locator(".conversation-main").boundingBox();
  const conversationChromeBox = await page.locator(".conversation-thread-chrome").boundingBox();
  const conversationToolsBox = await page.locator(".conversation-thread-tools").boundingBox();
  const transcriptBox = await page.locator(".conversation-thread-viewport").boundingBox();
  expect(conversationBox?.height ?? 0).toBeGreaterThan(1020);
  expect(conversationMainBox?.width ?? 0).toBeGreaterThan((conversationBox?.width ?? 0) - 3);
  expect(conversationChromeBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(76);
  expect(conversationToolsBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(56);
  expect(conversationToolsBox?.y ?? 0).toBeGreaterThanOrEqual(conversationChromeBox?.y ?? 0);
  expect((conversationToolsBox?.y ?? 0) + (conversationToolsBox?.height ?? 0)).toBeLessThanOrEqual(
    (conversationChromeBox?.y ?? 0) + (conversationChromeBox?.height ?? 0) + 1,
  );
  expect(transcriptBox?.height ?? 0).toBeGreaterThan(740);

  await page.getByRole("button", { name: "Open conversations" }).click();
  const conversationDrawer = page.getByRole("complementary", { name: "Project conversations" });
  await expect(conversationDrawer).toBeVisible();
  const drawerBox = await conversationDrawer.boundingBox();
  expect(drawerBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(256);
  await expect(conversationDrawer).not.toContainText(/tokens|requests|\$/i);
  const conversationPickerRow = conversationDrawer.locator(".conversation-list-item").first();
  const conversationPickerRowBox = await conversationPickerRow.boundingBox();
  expect(conversationPickerRowBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(48);
  await page.keyboard.press("Escape");
  await expect(conversationDrawer).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 720 });
  const shortRailBox = await navigationRail.boundingBox();
  const userMenuBox = await page.locator(".user-chip").boundingBox();
  expect(shortRailBox?.height).toBe(720);
  expect((userMenuBox?.y ?? 0) + (userMenuBox?.height ?? 0)).toBeLessThanOrEqual(704);

  await page.setViewportSize({ width: 820, height: 900 });
  const compactHeaderBox = await navigationRail.boundingBox();
  expect(compactHeaderBox).not.toBeNull();
  expect(compactHeaderBox?.x).toBe(0);
  expect(compactHeaderBox?.width).toBe(820);
  expect(compactHeaderBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(160);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(820);
});

test("Mobile workspace opens navigation as a drawer and keeps chat usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, "github", { conversationWorkspace: true });
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  const navigation = page.getByRole("navigation", { name: "Workspace sections" });
  await expect(navigation).toBeInViewport();
  await navigation.getByRole("button", { name: "Work", exact: true }).click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  await expect(page.getByText("I mapped the release workflow")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message the project PM" });
  await expect(composer).toBeVisible();
  const workspaceHeader = page.locator(".workspace-page-work > .workspace-header");
  await expect(workspaceHeader).toBeHidden();

  const topbarBox = await page.locator(".workspace-shell > .topbar").boundingBox();
  const conversationBox = await page.locator(".conversation-workspace").boundingBox();
  const composerBox = await composer.boundingBox();
  expect(topbarBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(58);
  expect(conversationBox?.height ?? 0).toBeGreaterThan(775);
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Open conversations" }).click();
  const conversationDrawer = page.getByRole("complementary", {
    name: "Project conversations",
  });
  await expect(conversationDrawer).toBeVisible();
  const drawerBox = await conversationDrawer.boundingBox();
  expect(drawerBox?.width ?? 0).toBeGreaterThan(260);
  expect(drawerBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(382);
  await page.getByRole("button", { name: "Close conversations" }).click();

  await page.getByRole("button", { name: "Use conversation as plan" }).click();
  const planDialog = page.getByRole("dialog", { name: "How should this plan proceed?" });
  await expect(planDialog).toBeVisible();
  const dialogBox = await planDialog.boundingBox();
  expect(dialogBox?.width ?? 0).toBeGreaterThanOrEqual(385);
  expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThanOrEqual(844);
});

test("Usage, Settings, and Admin use the regular application sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await prepare(page, "github");
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();
  await expectWorkspaceNavigation(page);

  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByTestId("usage-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Usage", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("navigation", { name: "Open projects" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);

  const globalRail = page.locator(".global-page-shell > .topbar");
  const globalRailBox = await globalRail.boundingBox();
  expect(globalRailBox).not.toBeNull();
  expect(globalRailBox?.x).toBe(0);
  expect(globalRailBox?.width).toBe(248);
  expect(globalRailBox?.height).toBe(1080);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("account-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(globalRail).toBeVisible();

  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await expect(page.getByTestId("admin-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(globalRail).toBeVisible();

  await page.getByRole("button", { name: "Return to front-door-app" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace sections" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".project-tabs")).toHaveCount(0);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByTestId("usage-panel")).toBeVisible();
});
