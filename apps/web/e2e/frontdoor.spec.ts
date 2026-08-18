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
    phasePlan?: boolean;
  } = {},
) {
  let projects: ReturnType<typeof project>[] = [];
  let planningCreated = false;
  let githubInstalled = options.githubInitiallyInstalled ?? true;
  let attachmentCount = 0;
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
    if (/^\/api\/v2\/projects\/project-[^/]+\/attachments$/.test(path)) {
      attachmentCount += 1;
      return fulfill(route, {
        id: `attachment-e2e-${attachmentCount}`,
        mime: request.headers()["content-type"] ?? "text/plain",
        bytes: request.postDataBuffer()?.byteLength ?? 0,
        width: null,
        height: null,
        purpose: "objective",
      });
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
                text: options.phasePlan
                  ? [
                      "## Execution plan · Release dashboard",
                      "",
                      "| Phase | Deliverable | Done when |",
                      "| --- | --- | --- |",
                      "| 1. Scaffold + data | Dashboard shell and deployment feed | Current deployment state loads reliably |",
                      "| 2. Release verification | Health checks and release summary | The release is verified end to end |",
                    ].join("\n")
                  : "I mapped the release workflow and the remaining deployment risks.",
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
      const selection = request.postDataJSON() as { delete_github_repository?: boolean };
      if (!selection.delete_github_repository) {
        projects = [];
        return route.fulfill({ status: 204, body: "" });
      }
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
  if (await existing.isVisible()) return existing;
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

test("New-work actions remain reachable across viewport layouts", async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 });
  await prepare(page, "github");
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();
  await expectNewWorkEntry(page);
  await page.getByTestId("attachment-file-input").setInputFiles([
    {
      name: "project-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Project notes"),
    },
    {
      name: "acceptance-criteria.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Acceptance criteria"),
    },
  ]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(2);

  const workTabPanel = page.getByTestId("workspace-tab-work");
  const workSurface = page.locator(".conversation-main.is-new-work");
  const startPlanning = page.getByRole("button", { name: "Start Planning" });
  const viewports = [
    { width: 2048, height: 1152 },
    { width: 1280, height: 720 },
    { width: 820, height: 900 },
    { width: 390, height: 844 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect(workSurface).toBeVisible();
    expect(await workTabPanel.evaluate((node) => getComputedStyle(node).overflowY)).toBe("auto");
    const dimensions = await workSurface.evaluate((node) => ({
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
    }));
    expect(dimensions.overflowY).toBe("auto");

    await workSurface.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    if (dimensions.scrollHeight > dimensions.clientHeight) {
      await expect.poll(() => workSurface.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    }
    await expect(startPlanning).toBeInViewport();
  }
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

  // Portfolio remains the stable landing page even before the first project.
  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create your first project" })).toBeVisible();
  await expect(page.locator(".portfolio-empty-mark svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
  const newProjectButton = page.getByRole("button", { name: "New project", exact: true }).first();
  const portfolioButton = page.getByRole("button", { name: "Portfolio", exact: true }).first();
  const [newProjectBox, portfolioBox] = await Promise.all([
    newProjectButton.boundingBox(),
    portfolioButton.boundingBox(),
  ]);
  expect(newProjectBox?.height).toBe(portfolioBox?.height);
  await newProjectButton.click();
  await expect(page.getByRole("main", { name: "New project" })).toBeVisible();

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
  const globalTopMenu = page.locator(".global-compact-shell > .global-top-menu");
  const globalTopMenuBox = await globalTopMenu.boundingBox();
  expect(globalTopMenuBox?.x).toBe(0);
  expect(globalTopMenuBox?.y).toBe(0);
  expect(globalTopMenuBox?.width).toBe(page.viewportSize()?.width);
  expect(globalTopMenuBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(58);
  await expect(page.locator(".navigation-rail-toggle")).toHaveCount(0);
  const setupPage = await page.getByRole("main", { name: "New project" }).boundingBox();
  const setupWidth = setupPage?.width ?? 0;
  expect(setupWidth).toBeGreaterThan(900);
  expect(setupWidth).toBeLessThanOrEqual(page.viewportSize()?.width ?? Number.POSITIVE_INFINITY);

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

test("Workspace uses a compact top menu and one phase-chat sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await prepare(page, "github", { conversationWorkspace: true });
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  const workspace = page.locator(".workspace-page");
  await expect(workspace).toBeVisible();
  const workspaceBox = await workspace.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(workspaceBox?.width).toBe(1920);
  expect(workspaceBox?.x).toBe(0);

  const topMenu = page.locator(".workspace-shell > .topbar");
  const topMenuBox = await topMenu.boundingBox();
  expect(topMenuBox).not.toBeNull();
  expect(topMenuBox?.x).toBe(0);
  expect(topMenuBox?.width).toBe(1920);
  expect(topMenuBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
  const projectContext = page.getByTestId("workspace-project-context");
  await expect(projectContext.getByText("front-door-app", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Open projects" })).toHaveCount(0);

  const workspaceNavigation = page.getByRole("navigation", { name: "Workspace sections" });
  const projectContextBox = await projectContext.boundingBox();
  const workspaceNavigationBox = await workspaceNavigation.boundingBox();
  expect(projectContextBox).not.toBeNull();
  expect(workspaceNavigationBox).not.toBeNull();
  expect(projectContextBox?.width ?? 0).toBeGreaterThanOrEqual(192);
  expect(await projectContext.evaluate((element) => getComputedStyle(element).maxWidth)).toBe(
    "none",
  );
  await expect(page.getByLabel("Current workflow phase")).toHaveCount(0);
  expect(
    Math.abs(
      (workspaceNavigationBox?.y ?? 0) +
        (workspaceNavigationBox?.height ?? 0) / 2 -
        ((projectContextBox?.y ?? 0) + (projectContextBox?.height ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(1);

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
  expect(newProjectButtonBox?.y).toBe(portfolioButtonBox?.y);
  expect(newProjectButtonBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(40);
  expect(portfolioControlBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);
  expect((portfolioControlBox?.y ?? 0) + (portfolioControlBox?.height ?? 0)).toBeLessThanOrEqual(
    topMenuBox?.height ?? 0,
  );

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
  await expect(planHandoff.getByRole("combobox", { name: "Design Agent" })).toBeVisible();
  await expect(
    planHandoff.getByText(/The PM assigns the best available agent to each phase/),
  ).toHaveCount(0);
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
  const phaseChats = page.getByRole("complementary", { name: "Phase chats" });
  await expect(phaseChats).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(1);
  await expect(phaseChats.getByText("Project chats", { exact: true })).toHaveCount(0);
  await expect(phaseChats.getByRole("heading", { name: "Chats" })).toBeVisible();
  await expect(phaseChats.getByText("1. Define", { exact: true })).toHaveCount(0);
  await expect(phaseChats.getByText("2. Project Manager", { exact: true })).toHaveCount(0);
  await expect(phaseChats.getByRole("button", { name: "Define", exact: true })).toHaveAttribute(
    "data-state",
    "complete",
  );
  await expect(phaseChats.getByRole("button", { name: /Project Manager/ })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(
    page.getByText("Plan the release dashboard and deployment health workflow.", { exact: true }),
  ).toHaveCount(0);

  const conversationBox = await page.locator(".conversation-workspace").boundingBox();
  const conversationMainBox = await page.locator(".conversation-main").boundingBox();
  const conversationChromeBox = await page.locator(".conversation-thread-chrome").boundingBox();
  const transcriptBox = await page.locator(".conversation-thread-viewport").boundingBox();
  const composerShellBox = await page.locator(".conversation-composer").boundingBox();
  await expect(page.getByRole("navigation", { name: "Project journey" })).toHaveCount(0);
  expect(conversationBox?.y ?? 0).toBeGreaterThanOrEqual(
    (topMenuBox?.y ?? 0) + (topMenuBox?.height ?? 0),
  );
  expect((conversationBox?.y ?? 0) + (conversationBox?.height ?? 0)).toBeGreaterThanOrEqual(
    (page.viewportSize()?.height ?? 0) - 12,
  );
  expect(
    Math.abs((conversationMainBox?.width ?? 0) - (conversationBox?.width ?? 0)),
  ).toBeLessThanOrEqual(2);
  expect(conversationChromeBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
  await expect(conversationHeader.getByText("Planning", { exact: true })).toHaveCount(0);
  await expect(conversationHeader.getByText("Stage", { exact: true })).toHaveCount(0);
  expect(transcriptBox?.height ?? 0).toBeGreaterThan(740);
  expect(composerShellBox?.width ?? 0).toBeGreaterThan((conversationMainBox?.width ?? 0) - 320);
  expect(composerShellBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    conversationMainBox?.width ?? 0,
  );

  const phaseChatsBox = await phaseChats.boundingBox();
  expect(phaseChatsBox?.width ?? 0).toBeGreaterThanOrEqual(180);
  expect(phaseChatsBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(190);
  expect(await phaseChats.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  expect(await phaseChats.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  expect(Math.abs((phaseChatsBox?.y ?? 0) - (conversationChromeBox?.y ?? 0))).toBeLessThanOrEqual(
    1,
  );
  expect(conversationChromeBox?.x ?? 0).toBeGreaterThanOrEqual(
    (phaseChatsBox?.x ?? 0) + (phaseChatsBox?.width ?? 0) - 1,
  );
  const defineChatButton = phaseChats.getByRole("button", { name: "Define", exact: true });
  expect(
    (await defineChatButton.boundingBox())?.height ?? Number.POSITIVE_INFINITY,
  ).toBeLessThanOrEqual(38);
  expect(
    await defineChatButton
      .locator(".conversation-stage-label")
      .evaluate((label) => getComputedStyle(label).fontWeight),
  ).toBe("400");

  const sidebarScroll = await phaseChats.evaluate((sidebar) => {
    const filler = document.createElement("div");
    filler.dataset.testScrollFiller = "true";
    filler.style.height = "1600px";
    filler.style.flex = "0 0 auto";
    sidebar.append(filler);
    const topBeforeScroll = sidebar.getBoundingClientRect().top;
    sidebar.scrollTop = sidebar.scrollHeight;
    return {
      clientHeight: sidebar.clientHeight,
      scrollHeight: sidebar.scrollHeight,
      scrollTop: sidebar.scrollTop,
      topBeforeScroll,
      topAfterScroll: sidebar.getBoundingClientRect().top,
    };
  });
  expect(sidebarScroll.scrollHeight).toBeGreaterThan(sidebarScroll.clientHeight);
  expect(sidebarScroll.scrollTop).toBeGreaterThan(0);
  expect(sidebarScroll.topAfterScroll).toBe(sidebarScroll.topBeforeScroll);
  await phaseChats.evaluate((sidebar) => {
    sidebar.querySelector("[data-test-scroll-filler]")?.remove();
    sidebar.scrollTop = 0;
  });

  await phaseChats.getByRole("button", { name: "Collapse phase chats" }).click();
  await expect
    .poll(async () => (await phaseChats.boundingBox())?.width ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(64);
  await expect(phaseChats.getByTitle("Define")).toBeVisible();
  await expect(phaseChats.getByTitle("Project Manager")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  const compactTopMenuBox = await topMenu.boundingBox();
  const userMenuBox = await page.locator(".user-chip").boundingBox();
  expect(compactTopMenuBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
  expect((userMenuBox?.y ?? 0) + (userMenuBox?.height ?? 0)).toBeLessThanOrEqual(64);

  await page.setViewportSize({ width: 820, height: 900 });
  const compactHeaderBox = await topMenu.boundingBox();
  expect(compactHeaderBox).not.toBeNull();
  expect(compactHeaderBox?.x).toBe(0);
  expect(compactHeaderBox?.width).toBe(820);
  expect(compactHeaderBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
  expect(await phaseChats.evaluate((element) => getComputedStyle(element).position)).toBe(
    "relative",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(820);
});

test("Phase plans use full-width sections instead of a squeezed three-column table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, "github", { conversationWorkspace: true, phasePlan: true });
  await page.goto("/");
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();
  await page
    .getByRole("navigation", { name: "Workspace sections" })
    .getByRole("button", {
      name: /work$/i,
    })
    .click();
  await page.getByRole("button", { name: "Open work item Release readiness" }).click();

  const table = page.locator(".conversation-phase-table");
  await expect(table).toBeVisible();
  const firstPhase = table.locator("tbody tr").first();
  const cells = firstPhase.locator("td");
  const [phaseBox, deliverableBox, doneWhenBox] = await Promise.all([
    cells.nth(0).boundingBox(),
    cells.nth(1).boundingBox(),
    cells.nth(2).boundingBox(),
  ]);

  expect(phaseBox).not.toBeNull();
  expect(deliverableBox).not.toBeNull();
  expect(doneWhenBox).not.toBeNull();
  expect(phaseBox?.width ?? 0).toBeGreaterThan((deliverableBox?.width ?? 0) * 1.9);
  expect(deliverableBox?.y).toBe(doneWhenBox?.y);
  expect(deliverableBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(doneWhenBox?.x ?? 0);

  await page.setViewportSize({ width: 640, height: 900 });
  const compactDeliverableBox = await cells.nth(1).boundingBox();
  const compactDoneWhenBox = await cells.nth(2).boundingBox();
  expect(compactDeliverableBox).not.toBeNull();
  expect(compactDoneWhenBox?.y ?? 0).toBeGreaterThan(
    (compactDeliverableBox?.y ?? 0) + (compactDeliverableBox?.height ?? 0) - 1,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
});

test("Development rail, phases, dialogue, and recovery controls never overlap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto("/");
  await page.setContent(`
    <link rel="stylesheet" href="http://localhost:5173/src/styles.css" />
    <link rel="stylesheet" href="http://localhost:5173/src/ConversationWorkspace.css" />
    <main
      class="conversation-has-phase-chats conversation-work-tab-development-chat"
      style="height: 820px"
    >
      <aside class="conversation-stage-sidebar" aria-label="Phase chats">
        <header><h2>Chats</h2></header>
        <button class="conversation-stage-new"><span>＋</span><span class="conversation-stage-label">New work</span></button>
        <nav>
          <button data-state="complete"><span>1</span><span class="conversation-stage-label">Define</span></button>
          <button data-state="complete"><span>2</span><span class="conversation-stage-label">Project Manager</span></button>
          <button data-state="active"><span>6</span><span class="conversation-stage-label">Development</span></button>
        </nav>
      </aside>
      <section class="conversation-development-phases" aria-label="Development phases">
        <header><div><h2>Phases</h2></div></header>
        <div class="conversation-development-phase-list">
          <ol>
            ${[
              "Foundation: scaffold, auth, and database",
              "Core engine: GP parsing, track picker, one-page cheat sheet",
              "AI providers and settings",
              "End-to-end verification against reference sheet",
            ]
              .map(
                (title, index) => `
                  <li data-state="${index === 0 ? "blocked" : "queued"}">
                    <button><span class="conversation-development-phase-index">${index + 1}</span><span><strong>${title}</strong><small>${index === 0 ? "Blocked" : "Queued"}</small></span></button>
                  </li>`,
              )
              .join("")}
          </ol>
        </div>
      </section>
      <section class="conversation-agent-dialogue" aria-label="Agent dialogue">
        <header><div><h3>Agent dialogue</h3></div><span class="badge">Blocked</span></header>
        <div class="conversation-development-recovery">
          <div><h4>Development needs a decision</h4><p>The agent reached its turn limit before it finished.</p></div>
          <div class="conversation-development-recovery-actions">
            <button class="btn btn-primary">Continue current agent</button>
            <div class="conversation-development-agent-switch">
              <select class="select"><option>Claude Opus 4.8</option></select>
              <button class="btn">Switch agent and retry</button>
            </div>
            <button class="btn btn-danger">Stop development</button>
          </div>
        </div>
      </section>
    </main>
  `);
  await page.waitForFunction(() => {
    const sidebar = document.querySelector(".conversation-stage-sidebar");
    return sidebar !== null && getComputedStyle(sidebar).position === "fixed";
  });

  for (const viewport of [
    { width: 1920, height: 900 },
    { width: 1280, height: 720 },
    { width: 820, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const rail = page.getByRole("complementary", { name: "Phase chats" });
    const phases = page.getByRole("region", { name: "Development phases" });
    const dialogue = page.getByRole("region", { name: "Agent dialogue" });
    const recovery = page.locator(".conversation-development-recovery");
    const [railBox, phasesBox, dialogueBox, recoveryBox] = await Promise.all([
      rail.boundingBox(),
      phases.boundingBox(),
      dialogue.boundingBox(),
      recovery.boundingBox(),
    ]);

    expect(railBox).not.toBeNull();
    expect(phasesBox).not.toBeNull();
    expect(dialogueBox).not.toBeNull();
    expect(recoveryBox).not.toBeNull();
    if (viewport.width > 900) {
      expect(await rail.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
      expect(phasesBox?.x ?? 0).toBeGreaterThanOrEqual(
        (railBox?.x ?? 0) + (railBox?.width ?? 0) - 1,
      );
      expect(dialogueBox?.x ?? 0).toBeGreaterThanOrEqual(
        (railBox?.x ?? 0) + (railBox?.width ?? 0) - 1,
      );
    } else {
      expect(await rail.evaluate((element) => getComputedStyle(element).position)).toBe("relative");
      expect(phasesBox?.x ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
      expect(phasesBox?.y ?? 0).toBeGreaterThanOrEqual(
        (railBox?.y ?? 0) + (railBox?.height ?? 0) - 1,
      );
    }
    expect(dialogueBox?.y ?? 0).toBeGreaterThanOrEqual(
      (phasesBox?.y ?? 0) + (phasesBox?.height ?? 0) - 1,
    );
    expect(recoveryBox?.x ?? 0).toBeGreaterThanOrEqual(dialogueBox?.x ?? 0);
    expect((recoveryBox?.x ?? 0) + (recoveryBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
  }

  await page.setViewportSize({ width: 1920, height: 900 });
  await page
    .getByRole("complementary", { name: "Phase chats" })
    .evaluate((element) => element.classList.add("is-collapsed"));
  await expect
    .poll(
      async () =>
        (await page.getByRole("complementary", { name: "Phase chats" }).boundingBox())?.width ??
        Number.POSITIVE_INFINITY,
    )
    .toBeLessThanOrEqual(64);
  const [collapsedRailBox, collapsedPhasesBox] = await Promise.all([
    page.getByRole("complementary", { name: "Phase chats" }).boundingBox(),
    page.getByRole("region", { name: "Development phases" }).boundingBox(),
  ]);
  expect(collapsedPhasesBox?.x ?? 0).toBeGreaterThanOrEqual(
    (collapsedRailBox?.x ?? 0) + (collapsedRailBox?.width ?? 0) - 1,
  );
});

test("A project with focused work still opens on Overview after adoption", async ({ page }) => {
  await prepare(page, "github", { conversationWorkspace: true, focusedPlanningRun: true });
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Name of project" })).toBeVisible();
  await selectExistingGitHubRepository(page);
  await page.getByRole("button", { name: /adopt project/i }).click();

  await expect(page.getByRole("heading", { name: "Describe the project" })).toBeVisible();

  const portfolioNavigation = page
    .locator(".workspace-nav-start")
    .getByRole("navigation", { name: "Portfolio navigation" });
  await portfolioNavigation.getByRole("button", { name: "Portfolio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Portfolio overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Status", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
  const portfolioLandingNavigation = page.getByRole("navigation", {
    name: "Portfolio navigation",
  });
  await expect(
    portfolioLandingNavigation.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Enter front-door-app" })).toBeVisible();
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
  await expect(page.getByRole("navigation", { name: "Project journey" })).toHaveCount(0);
  expect(conversationBox?.y ?? 0).toBeGreaterThanOrEqual(
    (topbarBox?.y ?? 0) + (topbarBox?.height ?? 0),
  );
  expect((conversationBox?.y ?? 0) + (conversationBox?.height ?? 0)).toBeGreaterThanOrEqual(
    (page.viewportSize()?.height ?? 0) - 12,
  );
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const phaseChats = page.getByRole("complementary", { name: "Phase chats" });
  await expect(phaseChats).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(1);
  const phaseChatsBox = await phaseChats.boundingBox();
  expect(phaseChatsBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(390);
  await expect(phaseChats.getByTitle("Define")).toBeVisible();
  await expect(phaseChats.getByTitle("Project Manager")).toBeVisible();

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
  await deleteDialog.getByRole("button", { name: "Keep GitHub repository instead" }).click();
  await deleteDialog.getByRole("button", { name: "Yes, delete project" }).click();
  await expect(deleteDialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await expect(page.getByRole("main", { name: "New project" })).toBeHidden();
});

test("Usage, Settings, and Admin use the compact global top menu", async ({ page }) => {
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

  const globalTopMenu = page.locator(".global-page-shell > .global-top-menu");
  const globalTopMenuBox = await globalTopMenu.boundingBox();
  expect(globalTopMenuBox).not.toBeNull();
  expect(globalTopMenuBox?.x).toBe(0);
  expect(globalTopMenuBox?.y).toBe(0);
  expect(globalTopMenuBox?.width).toBe(1920);
  expect(globalTopMenuBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(58);
  await expect(page.locator(".navigation-rail-toggle")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("account-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(globalTopMenu).toBeVisible();

  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await expect(page.getByTestId("admin-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(globalTopMenu).toBeVisible();

  await page.getByRole("button", { name: "Show active projects" }).click();
  await page.getByRole("button", { name: "front-door-app" }).click();
  await expect(page.getByRole("navigation", { name: "Workspace sections" })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".project-tabs")).toHaveCount(0);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByTestId("usage-panel")).toBeVisible();
});
