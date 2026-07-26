import { type Page, type Route, expect, test } from "@playwright/test";

type WorkspaceRole = "admin" | "member";

interface ObservedRequests {
  usage: string[];
  exports: string[];
  memberMutations: Array<{ method: string; path: string; body?: unknown }>;
  globalRuleMutations: Array<{ content: string }>;
}

const project = {
  id: "project-usage-e2e",
  name: "Usage Intelligence",
  description: "Acceptance project for usage intelligence",
  pm_provider: "anthropic",
  pm_model: "claude-sonnet-5",
  reviewer_provider: "openai",
  status: "draft",
  created_at: "2026-07-20T12:00:00.000Z",
  plan_objective: null,
  source_type: "github",
  source_location: "https://github.com/example/usage-intelligence.git",
  onboarding_scenario: "existing_repo",
};

const owner = {
  user_id: "owner-1",
  email: "owner@norns.test",
  name: "Project Owner",
  workspace_role: "member" as const,
  identity_status: "active" as const,
  project_role: "owner" as const,
  membership_status: "active" as const,
};

const existingMember = {
  user_id: "member-existing",
  email: "existing@norns.test",
  name: "Existing Member",
  workspace_role: "member" as const,
  identity_status: "active" as const,
  project_role: "member" as const,
  membership_status: "active" as const,
};

const candidate = {
  user_id: "member-new",
  email: "new.member@norns.test",
  name: "New Teammate",
  workspace_role: "member" as const,
};

const summary = {
  requests: 3,
  succeeded_requests: 2,
  failed_requests: 1,
  in_progress_requests: 0,
  input_tokens: 1_250,
  output_tokens: 320,
  cache_read_tokens: 500,
  cache_write_tokens: 100,
  cost_usd: null,
  known_cost_usd: 0.15,
  priced_requests: 2,
  unpriced_requests: 1,
  average_latency_ms: 840,
  average_output_tokens: 106.67,
  average_known_cost_usd: 0.075,
};

const usageEvent = {
  id: "event-usage-e2e",
  request_id: "request-usage-e2e",
  event_type: "request_failed",
  occurred_at: "2026-07-20T12:00:00.000Z",
  provider: "anthropic",
  model: "claude-sonnet-5",
  status: "failed",
  project_id: project.id,
  phase_id: "phase-1",
  initiated_by_user_id: "user-e2e",
  input_tokens: 1_250,
  output_tokens: 320,
  cost_usd: null,
  latency_ms: 840,
  error_code: "rate_limit",
};

const trend = {
  current: {
    requests: 20,
    failed_requests: 3,
    retried_requests: 2,
    known_cost_usd: 12.5,
    priced_requests: 19,
    unpriced_requests: 1,
    failure_rate: 0.15,
    retry_rate: 0.1,
    cache_efficiency: 0.25,
    average_input_tokens: 12_000,
    average_output_tokens: 1_200,
    average_known_cost_usd: 0.657895,
  },
  previous: {
    requests: 10,
    failed_requests: 1,
    retried_requests: 1,
    known_cost_usd: 10,
    priced_requests: 10,
    unpriced_requests: 0,
    failure_rate: 0.1,
    retry_rate: 0.1,
    cache_efficiency: 0.2,
    average_input_tokens: 10_000,
    average_output_tokens: 1_000,
    average_known_cost_usd: 1,
  },
  change: {
    requests_percent: 100,
    known_cost_percent: 25,
    failure_rate_points: 5,
  },
};

async function json(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function prepare(
  page: Page,
  role: WorkspaceRole,
  options: { expireFirstUsageRequest?: boolean } = {},
): Promise<ObservedRequests> {
  const userId = role === "admin" ? "admin-e2e" : "member-e2e";
  const currentUser = {
    id: userId,
    email: `${role}@norns.test`,
    name: role === "admin" ? "Usage Administrator" : "Usage Member",
    role,
    status: "active",
  };
  let roster =
    role === "admin"
      ? [owner, existingMember]
      : [
          owner,
          {
            ...existingMember,
            user_id: userId,
            email: currentUser.email,
            name: currentUser.name,
          },
        ];
  let globalRules = {
    filename: "NORN.md" as const,
    content: "",
    version: 0,
    updated_at: null as string | null,
  };
  const expireUsage = options.expireFirstUsageRequest ?? false;
  const observed: ObservedRequests = {
    usage: [],
    exports: [],
    memberMutations: [],
    globalRuleMutations: [],
  };

  await page.addInitScript(() => {
    sessionStorage.setItem("norns_cookie_session", "present");
    localStorage.setItem("norns_theme", "light");
  });

  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/me") return json(route, currentUser);
    if (path === "/api/auth/logout") return route.fulfill({ status: 204, body: "" });
    if (path === "/api/auth/status") return json(route, { needs_bootstrap: false });
    if (path === "/api/projects" && method === "GET") return json(route, [project]);
    if (path === "/api/admin/users" && method === "GET") {
      return json(route, [
        {
          id: currentUser.id,
          email: currentUser.email,
          name: currentUser.name,
          role: currentUser.role,
          status: currentUser.status,
          created_at: "2026-07-20T12:00:00.000Z",
        },
      ]);
    }
    if (path === "/api/v2/admin/rules" && method === "GET") {
      return json(route, globalRules);
    }
    if (path === "/api/v2/admin/rules" && method === "PUT") {
      const body = request.postDataJSON() as { content: string };
      observed.globalRuleMutations.push(body);
      globalRules = {
        filename: "NORN.md",
        content: body.content,
        version: globalRules.version + 1,
        updated_at: "2026-07-20T12:05:00.000Z",
      };
      return json(route, globalRules);
    }
    if (path === "/api/v2/attention") return json(route, {}, 404);
    if (path === "/api/integrations/github/status") {
      return json(route, {
        configured: false,
        user_authorization: { connected: false, login: null },
        connections: [],
      });
    }
    if (path === "/api/runners/helper/repositories") {
      return json(route, {
        state: "unavailable",
        runner_id: null,
        message: "No local helper connected.",
        install_command: "",
        install_command_windows: "",
        repositories: [],
      });
    }
    if (path === `/api/projects/${project.id}/graph`) {
      return json(route, { error: "not_planned" }, 409);
    }
    if (path === `/api/v2/projects/${project.id}/resume`) return json(route, {}, 404);
    if (path === `/api/v2/projects/${project.id}/planning-runs/latest`) {
      return json(route, { planning_run: null });
    }
    if (path === `/api/v2/projects/${project.id}/execution-status`) {
      return json(route, { project_id: project.id, phases: [] });
    }

    if (path === `/api/v2/projects/${project.id}/access`) {
      return json(route, {
        owner_user_id: owner.user_id,
        can_access: true,
        can_manage_members: role === "admin",
        source: role === "admin" ? "admin" : "membership",
      });
    }
    if (path === `/api/v2/projects/${project.id}/members` && method === "GET") {
      return json(route, { owner_user_id: owner.user_id, members: roster });
    }
    if (path === `/api/v2/projects/${project.id}/member-candidates`) {
      return json(route, {
        candidates: roster.some((member) => member.user_id === candidate.user_id)
          ? []
          : [candidate],
      });
    }
    if (path === `/api/v2/projects/${project.id}/members` && method === "POST") {
      const body = request.postDataJSON() as { user_id: string };
      observed.memberMutations.push({ method, path, body });
      if (body.user_id !== candidate.user_id) {
        return json(route, { message: "Workspace member not found." }, 404);
      }
      roster = [
        ...roster,
        {
          ...candidate,
          identity_status: "active" as const,
          project_role: "member" as const,
          membership_status: "active" as const,
        },
      ];
      return json(route, { owner_user_id: owner.user_id, members: roster }, 201);
    }
    if (
      path === `/api/v2/projects/${project.id}/members/${candidate.user_id}` &&
      method === "DELETE"
    ) {
      observed.memberMutations.push({ method, path });
      roster = roster.filter((member) => member.user_id !== candidate.user_id);
      return json(route, {
        owner_user_id: owner.user_id,
        members: roster,
      });
    }

    if (path.startsWith("/api/usage")) {
      observed.usage.push(`${path}${url.search}`);
      if (expireUsage) {
        return json(route, { error: "unauthorized" }, 401);
      }

      if (path === "/api/usage/analytics/trends") return json(route, trend);
      if (path === "/api/usage/analytics/hot-spots") {
        return json(route, {
          hot_spots: [
            {
              value: url.searchParams.get("dimension") === "phase" ? "phase-1" : "anthropic",
              requests: 12,
              failed_requests: 2,
              known_cost_usd: 8,
              unpriced_requests: 0,
            },
          ],
        });
      }
      if (path === "/api/usage/analytics/recommendations") {
        return json(route, {
          recommendations: [
            {
              id: "reduce-failed-request-spend",
              priority: "high",
              title: "Reduce failed request spend",
              recommendation: "Stop non-retryable calls before provider dispatch.",
              evidence: ["3 of 20 requests failed."],
              estimated_savings_usd: 1.25,
              confidence: 0.8,
              assumptions: ["Half is preventable."],
            },
          ],
        });
      }
      if (path === "/api/usage/analytics/calibration") {
        return json(route, {
          comparisons: [{ observation_id: "observation-1" }],
          mean_absolute_error_percent: 8.2,
          mean_actual_to_estimated_ratio: 1.05,
        });
      }
      if (path === "/api/usage/analytics/forecast/anthropic") {
        return json(route, {
          plan_name: "Team cycle",
          allowance_unit: "credits",
          observed_remaining: 400,
          estimated_weekly_limit: 1_000,
          estimated_monthly_limit: 4_348,
          confidence_interval_low: 900,
          confidence_interval_high: 1_100,
          confidence_rating: "medium",
          utilization_percent: 60,
          daily_burn_rate: 50,
          forecast_exhaustion_at: "2026-07-30T00:00:00.000Z",
          status: "at_risk",
          confidence: 0.8,
        });
      }

      if (path.endsWith("/export.csv")) {
        observed.exports.push(`${path}${url.search}`);
        return route.fulfill({
          status: 200,
          contentType: "text/csv",
          headers: { "Content-Disposition": 'attachment; filename="ai-usage.csv"' },
          body: [
            "request_id,provider,model,status,input_tokens,output_tokens",
            `${usageEvent.request_id},${usageEvent.provider},${usageEvent.model},${usageEvent.status},${usageEvent.input_tokens},${usageEvent.output_tokens}`,
          ].join("\n"),
        });
      }
      if (path.endsWith("/summary")) return json(route, summary);
      if (path.endsWith("/timeseries")) {
        return json(route, {
          interval: url.searchParams.get("interval") ?? "day",
          points: [
            {
              bucket: "2026-07-20T00:00:00.000Z",
              requests: 3,
              input_tokens: 1_250,
              output_tokens: 320,
              cost_usd: null,
              known_cost_usd: 0.15,
              unpriced_requests: 1,
            },
          ],
        });
      }
      if (path.endsWith("/events")) {
        return json(route, {
          events: [usageEvent],
          limit: 100,
          offset: 0,
          has_more: false,
        });
      }
      if (path.endsWith("/breakdown")) {
        const dimensions = url.searchParams.get("dimensions")?.split(",") ?? ["provider"];
        return json(route, {
          breakdowns: dimensions.map((dimension) => ({
            dimension,
            value:
              dimension === "model"
                ? usageEvent.model
                : dimension === "project"
                  ? project.name
                  : dimension === "phase"
                    ? "phase-1"
                    : dimension === "user"
                      ? currentUser.email
                      : usageEvent.provider,
            requests: 3,
            failed_requests: 1,
            input_tokens: 1_250,
            output_tokens: 320,
            cost_usd: null,
            known_cost_usd: 0.15,
            unpriced_requests: 1,
          })),
        });
      }
    }

    return json(route, { error: `Unexpected ${method} ${path}` }, 404);
  });

  return observed;
}

async function openPortfolioUsage(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Quick access" })).toBeVisible();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByTestId("usage-intelligence")).toBeVisible();
}

async function openProject(page: Page): Promise<void> {
  await page.getByRole("link", { name: `Quick access: ${project.name}` }).click();
  await expect(page.getByRole("heading", { name: project.name })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspace sections" })).toBeVisible();
}

async function expectNoHorizontalPageOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (document.scrollingElement?.scrollWidth ?? document.body.scrollWidth) <= innerWidth + 1,
      ),
    )
    .toBe(true);
}

function assertFilteredUsageRequest(requests: string[]): void {
  const expectedFrom = new Date("2026-07-01T00:00:00").toISOString();
  const expectedToDate = new Date("2026-07-20T00:00:00");
  expectedToDate.setDate(expectedToDate.getDate() + 1);
  const expectedTo = expectedToDate.toISOString();
  const filtered = requests
    .map((request) => new URL(request, "http://norns.test"))
    .filter((url) => url.searchParams.get("provider") === "anthropic");

  expect(filtered.length).toBeGreaterThanOrEqual(4);
  for (const url of filtered) {
    expect(url.searchParams.get("from")).toBe(expectedFrom);
    expect(url.searchParams.get("to")).toBe(expectedTo);
    expect(url.searchParams.get("model")).toBe("claude-sonnet-5");
  }
  expect(filtered.some((url) => url.searchParams.get("interval") === "month")).toBe(true);
}

test("administrator completes portfolio analytics and project access journeys", async ({
  page,
}) => {
  const observed = await prepare(page, "admin");
  await page.goto("/");

  await openPortfolioUsage(page);
  await expect(page.getByRole("heading", { name: "User usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "My usage" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  await page.getByRole("button", { name: "All usage" }).click();
  await expect(page.getByRole("heading", { name: "All usage" })).toBeVisible();
  await page.getByRole("textbox", { name: "From", exact: true }).fill("2026-07-01");
  await page.getByRole("textbox", { name: "To", exact: true }).fill("2026-07-20");
  await page.getByRole("textbox", { name: "Provider", exact: true }).fill("anthropic");
  await page.getByRole("textbox", { name: "Model", exact: true }).fill("claude-sonnet-5");
  await page.getByRole("combobox", { name: "Trend interval", exact: true }).selectOption("month");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "Monthly cost trend" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expect
    .poll(() => observed.usage.filter((request) => request.includes("provider=anthropic")).length)
    .toBeGreaterThanOrEqual(4);
  assertFilteredUsageRequest(observed.usage);

  const exportLink = page.getByRole("link", { name: "Export CSV" });
  await expect(exportLink).toHaveAttribute("download", "");
  const csvResponse = await exportLink.evaluate(async (link) => {
    const response = await fetch((link as HTMLAnchorElement).href);
    return {
      body: await response.text(),
      disposition: response.headers.get("Content-Disposition"),
    };
  });
  expect(csvResponse.disposition).toContain("ai-usage.csv");
  expect(csvResponse.body).toContain("request_id,provider,model,status");
  await expect.poll(() => observed.exports.length).toBe(1);
  expect(observed.exports[0]).toContain("provider=anthropic");

  const downloadPromise = page.waitForEvent("download");
  await exportLink.click();
  await downloadPromise;

  await page.getByRole("button", { name: "My usage" }).click();
  await expect(page.getByRole("heading", { name: "User usage" })).toBeVisible();
  await page.getByRole("button", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics and optimization" })).toBeVisible();
  await expect(page.getByText(/Mean absolute error:/)).toContainText("8.2%");
  await page.getByRole("textbox", { name: "From", exact: true }).fill("2026-07-01");
  await page.getByRole("textbox", { name: "To", exact: true }).fill("2026-07-20");
  await page.getByRole("textbox", { name: "Provider", exact: true }).fill("anthropic");
  await page.getByRole("combobox", { name: "Hot spot", exact: true }).selectOption("phase");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "Cycle forecast · Team cycle" })).toBeVisible();
  await expect(page.getByText(/400 credits remaining/)).toBeVisible();
  await expect(page.getByText(/1,000 weekly/)).toBeVisible();
  await expect(page.getByText(/95% interval/i)).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expect
    .poll(() =>
      observed.usage.some(
        (request) =>
          request.includes("/analytics/hot-spots?") &&
          request.includes("provider=anthropic") &&
          request.includes("dimension=phase"),
      ),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Close" }).click();
  await openProject(page);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: project.name })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expect(page.getByText("Manage access")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Add an existing workspace member", exact: true })
    .selectOption(candidate.user_id);
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText("Member added.")).toBeVisible();
  const addedMemberRow = page.getByRole("row", { name: new RegExp(candidate.name) });
  await expect(addedMemberRow).toBeVisible();
  await page.getByRole("button", { name: `Remove ${candidate.name}` }).click();
  await expect(page.getByText("Member removed.")).toBeVisible();
  await expect(addedMemberRow).toHaveCount(0);
  expect(observed.memberMutations).toEqual([
    {
      method: "POST",
      path: `/api/v2/projects/${project.id}/members`,
      body: { user_id: candidate.user_id },
    },
    {
      method: "DELETE",
      path: `/api/v2/projects/${project.id}/members/${candidate.user_id}`,
    },
  ]);
});

test("standard member can inspect personal and project usage without admin controls", async ({
  page,
}) => {
  const observed = await prepare(page, "member");
  await page.goto("/");

  await openPortfolioUsage(page);
  await expect(page.getByRole("heading", { name: "User usage" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expect(page.getByRole("button", { name: "My usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "All usage" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Analytics" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();

  await openProject(page);
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: project.name })).toBeVisible();
  await expect(page.getByRole("button", { name: "My usage" })).toBeVisible();
  await expect(page.getByRole("button", { name: "All usage" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Analytics" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Project members" })).toBeVisible();
  await expect(page.getByText(/you can view this member list/i)).toBeVisible();
  await expect(page.getByText("Manage access")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  expect(observed.memberMutations).toEqual([]);
});

test("administrator edits global NORN.md without losing the current workspace", async ({
  page,
}) => {
  const observed = await prepare(page, "admin");
  await page.goto("/");
  await openProject(page);

  const workspaceNavigation = page.getByRole("navigation", { name: "Workspace sections" });
  await expect(workspaceNavigation.getByRole("button").allTextContents()).resolves.toEqual([
    "Overview",
    "Work",
    "Graph",
    "Members",
    "Debates",
    "Settings",
  ]);

  await page.getByRole("button", { name: "Admin", exact: true }).click();
  const adminPanel = page.getByTestId("admin-panel");
  await expect(adminPanel).toBeVisible();
  const editor = adminPanel.getByRole("textbox", { name: "Global NORN.md" });
  await editor.fill("# Global rules\n\n- Report blockers every five minutes.");
  await adminPanel.getByRole("button", { name: "Save global rules" }).click();

  await expect(adminPanel.getByText("v1")).toBeVisible();
  await expect(editor).toHaveValue("# Global rules\n\n- Report blockers every five minutes.");
  expect(observed.globalRuleMutations).toEqual([
    { content: "# Global rules\n\n- Report blockers every five minutes." },
  ]);

  await adminPanel.getByRole("button", { name: "Close" }).click();
  await expect(workspaceNavigation).toBeVisible();
  await expect(workspaceNavigation.getByRole("button", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("an unauthorized usage response returns the user to session-expired sign in", async ({
  page,
}) => {
  await prepare(page, "member", { expireFirstUsageRequest: true });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Quick access" })).toBeVisible();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(page.getByText("Session expired. Sign in again.")).toBeVisible();
  await expect(page.getByText("Welcome back")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByTestId("usage-intelligence")).toHaveCount(0);
});
