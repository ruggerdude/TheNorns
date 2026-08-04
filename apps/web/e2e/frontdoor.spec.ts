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
    focus_planning_run_id: null as string | null,
    // API records can retain an old setup hint. Opening a project from the
    // portfolio must not replay that one-time navigation intent.
    entry_flow: null as "adoption" | "new" | null,
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
  options: {
    githubInitiallyInstalled?: boolean;
    conversationWorkspace?: boolean;
    focusedPlanningRun?: boolean;
  } = {},
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
    if (path === "/api/admin/projects/archived") {
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
    if (path === "/api/v2/capabilities/local-execution") {
      return fulfill(route, {
        schema_version: 1,
        enrollment_available: true,
        computers_available: true,
        repository_grants_available: true,
        legacy_claim_available: false,
        legacy_local_creation_available: true,
      });
    }
    if (path === "/api/devices") {
      return fulfill(route, {
        devices: [
          {
            device_id: "device-e2e",
            owner_user_id: "admin-1",
            name: "Front Door Mac",
            location_label: "Test desk",
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
              device_id: "device-e2e",
              credential_id: "credential-e2e",
              generation: 1,
              public_key_fingerprint: "a".repeat(64),
              state: "active",
              activated_at: "2026-07-29T12:00:00.000Z",
            },
            agent: {
              version: "0.4.0",
              protocol_version: "1",
              capabilities: [
                "device_control",
                "repository_access",
                "workspace_picker",
                "workspace_repository_inventory",
                "workspace_clone",
                "workspace_clone_destination",
              ],
            },
            repository_grants: [],
            activity: { active_run_count: 0, queued_command_count: 0 },
          },
        ],
      });
    }
    if (path === "/api/v2/computers/device-e2e/clone-destination") {
      return fulfill(route, {
        clone_destination_id: "local:e2e-destination",
        label: "Projects",
      });
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
          focus_planning_run_id: options.focusedPlanningRun ? "planning-adoption" : null,
          entry_flow: body.scenario === "new_repo" ? "new" : "adoption",
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
      /^\/api\/v2\/projects\/project-[^/]+\/work-items$/.test(path) &&
      request.method() === "GET"
    ) {
      return fulfill(route, {
        work_items: options.conversationWorkspace
          ? [
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
            ]
          : [],
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
    if (path.endsWith("/deletion-options") && request.method() === "GET") {
      return fulfill(route, {
        project_name: projects[0]?.name ?? "front-door-app",
        local_folder: { available: false, label: null },
        github_repository: { available: true, label: "octocat/front-door-app" },
      });
    }
    if (path.endsWith("/destroy") && request.method() === "DELETE") {
      return fulfill(
        route,
        {
          error: "github_app_permission_missing",
          message:
            "The GitHub App's permission grant on this installation does not cover administration: write.",
        },
        409,
      );
    }
    if (/^\/api\/v2\/projects\/project-[^/]+\/rules$/.test(path) && request.method() === "GET") {
      return fulfill(route, {
        filename: "NORN.md",
        content: "",
        version: 0,
        updated_at: null,
      });
    }
    if (path.includes("/planning-reviewer") && request.method() === "GET") {
      return fulfill(route, {
        provider: "openai",
        model: "gpt-5.6-terra",
        mode: "explicit",
        qc_mode: "automatic",
        allow_unadjudicated_rebuttals: false,
        default_max_rounds: 2,
      });
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

async function expectNewWorkEntry(page: Page, initialBrief = "") {
  const navigation = page.getByRole("navigation", { name: "Workspace sections" });
  const overview = navigation.getByRole("button", { name: /overview/i });
  const work = navigation.getByRole("button", { name: /work$/i });

  await expect(navigation).toBeVisible();
  await expect(overview).toBeVisible();
  await expect(work).toBeVisible();
  await expect(work).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("workspace-tab-work")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Describe the project" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Describe the work" })).toHaveValue(initialBrief);
  await expect(page.getByRole("radio", { name: /Phased work/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Start Planning" })).toBeVisible();
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
  const newProject = page.getByRole("button", { name: "New project", exact: true });
  if (await newProject.isVisible()) {
    await clickUntilVisible(newProject, existing);
  } else {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await clickUntilVisible(
      navigation.getByRole("button", { name: "New project", exact: true }),
      existing,
    );
  }
  await existing.click();
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
  await expectNewWorkEntry(page);
});

// DESIGN R2: the wizard is name-first and never starts a planning run —
// planning begins in the conversation after creation, so this journey ends at
// the opened workspace.
test("New work can create a GitHub repository and folder on an enrolled computer", async ({
  page,
}) => {
  const observed = await prepare(page, "new");
  await page.goto("/");
  await page.getByRole("button", { name: /new project/i }).click();
  await page.getByTestId("project-name").fill("Local release readiness dashboard");
  await page.getByRole("button", { name: /^this computer/i }).click();
  await expect(page.getByTestId("project-computer")).toHaveValue("device-e2e");
  await page.getByRole("button", { name: "Select folder" }).click();
  await expect(page.locator(".folder-destination")).toContainText("Projects");
  await expect(page.getByTestId("setup-confirmation")).toHaveCount(0);
  await page.getByRole("button", { name: /create project/i }).click();

  await expectNewWorkEntry(page);
  expect(observed.onboardingRequests).toEqual([
    expect.objectContaining({
      name: "Local release readiness dashboard",
      description: "",
      scenario: "new_repo",
      local_working_copy: true,
      computer_id: "device-e2e",
      clone_destination_id: "local:e2e-destination",
    }),
  ]);
  expect(observed.localProjectRequests).toEqual([]);
});

test("Directed adoption carries its direction into the brief-first phased journey", async ({
  page,
}) => {
  const observed = await prepare(page, "github");
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page
    .getByTestId("project-description")
    .fill("Improve the deployment workflow and implement it");
  await page.getByRole("button", { name: /adopt project/i }).click();

  await expectNewWorkEntry(page, "Improve the deployment workflow and implement it");
  await expect(page.getByText("Plan with PM → optional QC → Development chat")).toBeVisible();
  expect(observed.planningRequests).toEqual([]);
  expect(observed.planningDecisions).toEqual([]);
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

  // DESIGN R2: setup replaces only the main content. The application rail
  // and its Portfolio/New project navigation remain stable.
  await expect(page.getByRole("heading", { name: "Project setup" })).toHaveCount(0);
  await expect(page.locator(".full-page-header")).toHaveCount(0);
  const portfolioNavigation = page.getByRole("navigation", { name: "Portfolio navigation" });
  await expect(portfolioNavigation).toBeVisible();
  await expect(
    portfolioNavigation.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  await expect(
    portfolioNavigation.getByRole("button", { name: "Portfolio", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Guided setup")).toHaveCount(0);
  const setupPage = await page.getByRole("main", { name: "New project" }).boundingBox();
  const setupWidth = setupPage?.width ?? 0;
  expect(setupWidth).toBeGreaterThan(900);
  expect(setupWidth).toBeLessThanOrEqual(1216);

  // The wizard shell carries card chrome, so it needs a card's breathing room.
  // It previously had padding: 0 and no surface, which put every label and
  // input flush against the edge and made the page read as a different design
  // language from the rest of the app.
  const shellPadding = await page.locator(".wizard-shell").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      left: Number.parseFloat(style.paddingLeft),
      right: Number.parseFloat(style.paddingRight),
      background: style.backgroundColor,
    };
  });
  expect(shellPadding.left).toBeGreaterThanOrEqual(24);
  expect(shellPadding.right).toBeGreaterThanOrEqual(24);
  expect(shellPadding.background).not.toBe("rgba(0, 0, 0, 0)");

  await expect(page.getByText(/repository destination/i)).toHaveCount(0);
  await page.getByTestId("project-name").fill("Deployment workflow dashboard for release managers");
  const repositorySummary = page.getByTestId("derived-project-summary");
  await expect(repositorySummary).toContainText(
    "octocat/deployment-workflow-dashboard-for-release-managers",
  );
  await expect(repositorySummary.locator("strong")).toHaveCount(0);
  await page.getByRole("button", { name: /create project/i }).click();

  await expectNewWorkEntry(page);
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
  await expect(page.getByText(/repository destination/i)).toHaveCount(0);
  await page.getByTestId("project-name").fill("Verified setup journey");
  await page.getByRole("button", { name: /create project/i }).click();

  await expectNewWorkEntry(page);
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
  expect(workspaceBox?.width).toBe(1680);
  expect(workspaceBox?.x).toBe(240);

  const navigationRail = page.locator(".workspace-shell > .topbar");
  const railBox = await navigationRail.boundingBox();
  expect(railBox).not.toBeNull();
  expect(railBox?.x).toBe(0);
  expect(railBox?.width).toBe(240);
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

  const workspacePortfolioNavigation = page
    .locator(".workspace-nav-start")
    .getByRole("navigation", { name: "Portfolio navigation" });
  const newProjectButtonBox = await workspacePortfolioNavigation
    .getByRole("button", { name: "New project", exact: true })
    .boundingBox();
  const portfolioButtonBox = await workspacePortfolioNavigation
    .getByRole("button", { name: "Portfolio", exact: true })
    .boundingBox();
  const portfolioControlBox = await workspacePortfolioNavigation
    .locator(".portfolio-switcher")
    .boundingBox();
  const usageButtonBox = await page
    .getByRole("button", { name: "Usage", exact: true })
    .boundingBox();
  expect(portfolioButtonBox?.x).toBe(16);
  expect(newProjectButtonBox?.x).toBe(16);
  expect(newProjectButtonBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    portfolioButtonBox?.y ?? 0,
  );
  expect(usageButtonBox?.x).toBe(16);
  expect(portfolioControlBox?.width ?? 0).toBeGreaterThanOrEqual(200);
  expect(usageButtonBox?.width).toBe(portfolioControlBox?.width);

  await expect(page.getByRole("heading", { name: "Describe the project" })).toBeVisible();
  await workspaceNavigation.getByRole("button", { name: "Overview", exact: true }).click();
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
  await expect(page.getByText("Conversation", { exact: true })).toBeHidden();
  const planningComposer = page.getByRole("textbox", { name: "Message the project PM" });
  await expect(planningComposer).toBeVisible();
  const conversationHeader = page.locator(".conversation-thread-chrome");
  const conversationIdentity = conversationHeader.locator(".conversation-header-identity");
  const chatOptionsButton = conversationHeader.getByRole("button", { name: "Chat options" });
  const conversationModel = page.getByRole("combobox", { name: "Conversation model" });
  await expect(chatOptionsButton).toBeVisible();
  await expect(conversationModel).toBeHidden();
  await expect(page.getByRole("button", { name: "Refresh conversation" })).toBeHidden();
  const identityBox = await conversationIdentity.boundingBox();
  const optionsButtonBox = await chatOptionsButton.boundingBox();
  expect(identityBox).not.toBeNull();
  expect(optionsButtonBox).not.toBeNull();
  expect((identityBox?.x ?? 0) + (identityBox?.width ?? 0)).toBeLessThanOrEqual(
    optionsButtonBox?.x ?? 0,
  );
  await chatOptionsButton.click();
  const chatOptionsDialog = page.getByRole("dialog", { name: "Chat options" });
  await expect(chatOptionsDialog).toBeVisible();
  await expect(conversationModel).toHaveValue("claude-sonnet-5");
  await expect(conversationModel.locator('option[value="gpt-5.6-sol"]')).toHaveCount(0);
  await expect(
    chatOptionsDialog.getByRole("button", { name: "Refresh conversation" }),
  ).toBeVisible();
  await chatOptionsButton.click();
  await expect(chatOptionsDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Add file" })).toHaveText("+");
  await expect(planningComposer).toHaveAttribute(
    "placeholder",
    "Message the PM, or say “Use this as the plan”…",
  );
  await expect(page.getByRole("button", { name: "Use conversation as plan" })).toHaveText("Plan");
  await expect(page.getByText("UI preview", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Use conversation as plan" }).click();
  const planHandoff = page.getByRole("dialog", { name: "Confirm QC Settings" });
  expect(
    await planHandoff.evaluate(
      (dialog) => dialog.closest(".plan-handoff-backdrop")?.parentElement === document.body,
    ),
  ).toBe(true);
  const planHandoffBackdropBox = await page.locator(".plan-handoff-backdrop").boundingBox();
  expect(planHandoffBackdropBox?.x).toBe(0);
  expect(planHandoffBackdropBox?.width).toBe(1920);
  const planHandoffBox = await planHandoff.boundingBox();
  expect(planHandoffBox).not.toBeNull();
  // Centered in the viewport, not pinned to a corner by the UA dialog styles.
  expect(
    Math.abs((planHandoffBox?.x ?? 0) + (planHandoffBox?.width ?? 0) / 2 - 1920 / 2),
  ).toBeLessThanOrEqual(1);
  await expect(planHandoff.getByRole("combobox", { name: "Execution agent" })).toBeVisible();
  await expect(planHandoff.getByRole("combobox", { name: "QC agent" })).toHaveValue(
    "gpt-5.6-terra",
  );
  await expect(planHandoff.getByRole("combobox", { name: "QC rounds" })).toHaveValue("2");
  await planHandoff.getByRole("radio", { name: /Skip QC/ }).check();
  await expect(planHandoff.getByRole("combobox", { name: "QC agent" })).toHaveCount(0);
  await expect(planHandoff.getByRole("button", { name: "Build plan for review" })).toBeVisible();
  await planHandoff.getByRole("button", { name: "Cancel" }).click();
  await expect(planHandoff).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Planning workflow" })).toHaveCount(0);
  const conversationSidebar = page.getByRole("complementary", {
    name: "Project work items",
  });
  await expect(conversationSidebar).toBeVisible();
  await expect(
    page.getByText("Plan the release dashboard and deployment health workflow.", { exact: true }),
  ).toHaveCount(0);

  const conversationBox = await page.locator(".conversation-workspace").boundingBox();
  const conversationMainBox = await page.locator(".conversation-main").boundingBox();
  const conversationChromeBox = await page.locator(".conversation-thread-chrome").boundingBox();
  const transcriptBox = await page.locator(".conversation-thread-viewport").boundingBox();
  const composerShellBox = await page.locator(".conversation-composer").boundingBox();
  const journeyBox = await page.getByRole("navigation", { name: "Project journey" }).boundingBox();
  expect(conversationBox?.y ?? 0).toBeGreaterThanOrEqual(
    (journeyBox?.y ?? 0) + (journeyBox?.height ?? 0),
  );
  expect((conversationBox?.y ?? 0) + (conversationBox?.height ?? 0)).toBeGreaterThanOrEqual(
    (page.viewportSize()?.height ?? 0) - 12,
  );
  expect(conversationMainBox?.width ?? 0).toBeGreaterThan((conversationBox?.width ?? 0) - 280);
  expect(conversationMainBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(
    (conversationBox?.width ?? 0) - 260,
  );
  expect(conversationChromeBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
  await expect(conversationHeader.getByText("Planning", { exact: true })).toHaveCount(0);
  await expect(conversationHeader.getByText("Stage", { exact: true })).toHaveCount(0);
  expect(transcriptBox?.height ?? 0).toBeGreaterThan(740);
  expect(composerShellBox?.width ?? 0).toBeGreaterThan(700);
  expect(composerShellBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1108);

  const sidebarBox = await conversationSidebar.boundingBox();
  expect(sidebarBox?.width ?? 0).toBeGreaterThanOrEqual(268);
  expect(sidebarBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(276);
  await expect(conversationSidebar).not.toContainText(/tokens|requests|\$/i);
  const conversationPickerRow = conversationSidebar.locator(".conversation-family-button").first();
  const conversationPickerRowBox = await conversationPickerRow.boundingBox();
  expect(conversationPickerRowBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(58);
  await conversationPickerRow.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(0);
  await expect(conversationSidebar).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  const shortRailBox = await navigationRail.boundingBox();
  const userMenuBox = await page.locator(".user-chip").boundingBox();
  expect(shortRailBox?.height).toBe(720);
  expect((userMenuBox?.y ?? 0) + (userMenuBox?.height ?? 0)).toBeLessThanOrEqual(710);

  await page.setViewportSize({ width: 820, height: 900 });
  const compactHeaderBox = await navigationRail.boundingBox();
  expect(compactHeaderBox).not.toBeNull();
  expect(compactHeaderBox?.x).toBe(0);
  expect(compactHeaderBox?.width).toBe(820);
  expect(compactHeaderBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(160);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(820);
});

test("A project with focused work still opens on Overview from Portfolio", async ({ page }) => {
  await prepare(page, "github", { conversationWorkspace: true, focusedPlanningRun: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  await expect(page.getByRole("heading", { name: "Describe the project" })).toBeVisible();

  const portfolioNavigation = page
    .locator(".workspace-nav-start")
    .getByRole("navigation", { name: "Portfolio navigation" });
  await portfolioNavigation.getByRole("button", { name: "Portfolio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show active projects" }).click();
  await page.getByRole("button", { name: "front-door-app", exact: true }).click();

  const restoredWorkspaceNavigation = page.getByRole("navigation", {
    name: "Workspace sections",
  });
  await expect(
    restoredWorkspaceNavigation.getByRole("button", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).pathname).toBe("/projects/project-github");
  await restoredWorkspaceNavigation.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByText("I mapped the release workflow")).toBeVisible();
});

test("Mobile workspace opens navigation as a drawer and keeps chat usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, "github", { conversationWorkspace: true });
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await expect(menu).toBeVisible();
  await menu.click();
  const navigation = page.getByRole("navigation", { name: "Workspace sections" });
  await expect(navigation).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Describe the project" })).toBeVisible();
  await navigation.getByRole("button", { name: "Overview", exact: true }).click();
  await menu.click();
  await navigation.getByRole("button", { name: "Work", exact: true }).click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  await expect(page.getByText("I mapped the release workflow")).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message the project PM" });
  await expect(composer).toBeVisible();
  const chatOptions = page.getByRole("button", { name: "Chat options" });
  await expect(chatOptions).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Conversation model" })).toBeHidden();
  await chatOptions.click();
  const mobileOptionsDialog = page.getByRole("dialog", { name: "Chat options" });
  await expect(mobileOptionsDialog).toBeVisible();
  const mobileOptionsBox = await mobileOptionsDialog.boundingBox();
  expect(mobileOptionsBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((mobileOptionsBox?.x ?? 0) + (mobileOptionsBox?.width ?? 0)).toBeLessThanOrEqual(390);
  await chatOptions.click();
  const workspaceHeader = page.locator(".workspace-page-work > .workspace-header");
  await expect(workspaceHeader).toBeHidden();

  const topbarBox = await page.locator(".workspace-shell > .topbar").boundingBox();
  const conversationBox = await page.locator(".conversation-workspace").boundingBox();
  const composerBox = await composer.boundingBox();
  expect(topbarBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(58);
  const journeyBox = await page.getByRole("navigation", { name: "Project journey" }).boundingBox();
  expect(conversationBox?.y ?? 0).toBeGreaterThanOrEqual(
    (journeyBox?.y ?? 0) + (journeyBox?.height ?? 0),
  );
  expect((conversationBox?.y ?? 0) + (conversationBox?.height ?? 0)).toBeGreaterThanOrEqual(
    (page.viewportSize()?.height ?? 0) - 12,
  );
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Expand work items" }).click();
  const conversationDrawer = page.getByRole("complementary", {
    name: "Project work items",
  });
  await expect(conversationDrawer).toBeVisible();
  const drawerBox = await conversationDrawer.boundingBox();
  expect(drawerBox?.width ?? 0).toBeGreaterThan(260);
  expect(drawerBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(382);
  await page.getByRole("button", { name: "Close work items" }).click();
  await expect(conversationDrawer).toBeHidden();

  await page.getByRole("button", { name: "Use conversation as plan" }).click();
  const planDialog = page.getByRole("dialog", { name: "Confirm QC Settings" });
  await expect(planDialog).toBeVisible();
  const dialogBox = await planDialog.boundingBox();
  expect(dialogBox?.width ?? 0).toBeGreaterThanOrEqual(385);
  expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThanOrEqual(844);
});

test("Mobile Portfolio exposes the global navigation drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, "github");
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Open navigation menu" });
  await expect(menu).toBeVisible();
  await menu.click();

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation).toBeInViewport();
  await expect
    .poll(async () => Math.round((await navigation.boundingBox())?.x ?? -999))
    .toBeGreaterThanOrEqual(0);
  await expect(navigation.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Admin", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await navigation.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByTestId("usage-panel")).toBeVisible();
  await expect(navigation).not.toBeInViewport();
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
});

test("Project archiving lives only in project Settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, "github");
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const workspaceNavigation = page.getByRole("navigation", { name: "Workspace sections" });
  await workspaceNavigation.getByRole("button", { name: "Settings", exact: true }).click();
  const dangerZone = page.getByRole("region", { name: "Remove project" });
  await expect(dangerZone).toBeVisible();
  await expect(dangerZone.getByRole("button", { name: "Archive project" })).toBeVisible();

  await dangerZone.getByRole("button", { name: "Delete project" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete front-door-app?" });
  await expect(deleteDialog).toBeVisible();
  const dialogBox = await deleteDialog.boundingBox();
  expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) / 2).toBeCloseTo(390 / 2, 0);
  expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0) / 2).toBeCloseTo(844 / 2, 0);
  expect(dialogBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(390);

  await deleteDialog.getByRole("checkbox", { name: /delete github repository/i }).check();
  await deleteDialog.getByRole("button", { name: "Yes, delete project" }).click();
  await expect(
    deleteDialog.getByText(
      "The GitHub App's permission grant on this installation does not cover administration: write.",
    ),
  ).toBeVisible();
  await expect(
    deleteDialog.getByRole("button", { name: "Keep GitHub repository instead" }),
  ).toBeVisible();
  const errorDialogBox = await deleteDialog.boundingBox();
  expect((errorDialogBox?.x ?? 0) + (errorDialogBox?.width ?? 0) / 2).toBeCloseTo(390 / 2, 0);
  expect((errorDialogBox?.y ?? 0) + (errorDialogBox?.height ?? 0) / 2).toBeCloseTo(844 / 2, 0);
  expect((errorDialogBox?.y ?? 0) + (errorDialogBox?.height ?? 0)).toBeLessThanOrEqual(844);
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteDialog).toBeHidden();

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await workspaceNavigation.getByRole("button", { name: "Portfolio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive project" })).toHaveCount(0);
});

test("Usage, Settings, and Admin use the regular application sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await prepare(page, "github");
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();
  await expectNewWorkEntry(page);

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
  expect(globalRailBox?.width).toBe(240);
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

  await page.getByRole("button", { name: "Show active projects" }).click();
  await page.getByRole("button", { name: "front-door-app" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace sections" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".project-tabs")).toHaveCount(0);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByTestId("usage-panel")).toBeVisible();
});
