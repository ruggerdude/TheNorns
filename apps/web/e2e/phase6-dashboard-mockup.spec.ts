import { type Page, type Route, expect, test } from "@playwright/test";

const now = "2026-07-27T12:00:00.000Z";
const hash = "a".repeat(64);
const projectId = "project-phase6";
const workItemId = "work-phase6";
const conversationId = "planning-phase6";

async function json(route: Route, payload: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function artifact(artifact_id: string, media_type: string, label: string) {
  return { artifact_id, content_hash: hash, media_type, label };
}

function mockup() {
  const renderer = {
    renderer: "norns-deterministic-v1",
    renderer_revision: hash,
    font_revision: hash,
    pixel_ratio: 1,
    network: "disabled",
    scripts: "disabled",
    locale: "en-US",
    timezone: "UTC",
    fixed_clock: now,
    seed: hash,
  };
  return {
    schema_version: 2,
    id: "mockup-version-1",
    root_request_id: "mockup-request-1",
    request_id: "mockup-request-1",
    project_id: projectId,
    work_item_id: workItemId,
    conversation_id: conversationId,
    task_id: "checkout",
    created_by_action_id: "action-create-mockup",
    version: 1,
    status: "candidate",
    brief: "Show a calm checkout review flow.",
    target: "responsive",
    interaction_notes: ["Approval is explicit and keyboard reachable."],
    manifest: artifact("manifest-1", "application/json", "Mockup manifest"),
    renderer_profile: renderer,
    screenshots: [
      {
        viewport: "desktop",
        artifact: artifact("desktop-1", "image/png", "Desktop mockup"),
        width: 1440,
        height: 1024,
        capture_profile: renderer,
      },
      {
        viewport: "mobile",
        artifact: artifact("mobile-1", "image/png", "Mobile mockup"),
        width: 390,
        height: 844,
        capture_profile: renderer,
      },
    ],
    supersedes_mockup_version_id: null,
    created_at: now,
  };
}

async function prepare(page: Page) {
  const project = {
    id: projectId,
    name: "Phase 6 storefront",
    description: "Reviewable visual delivery",
    pm_provider: "anthropic",
    pm_model: "claude-sonnet-5",
    reviewer_provider: "openai",
    status: "planned",
    created_at: now,
    plan_objective: "Ship the storefront",
    source_type: "github",
    source_location: "https://github.com/example/storefront.git",
    onboarding_scenario: "existing_repo",
  };
  const workItem = {
    schema_version: 2,
    id: workItemId,
    project_id: projectId,
    created_by_user_id: "user-e2e",
    title: "Storefront visual review",
    objective: "Review checkout before implementation.",
    status: "planning",
    planning_run_id: null,
    phase_id: null,
    approved_plan_version_id: null,
    aggregate_version: 1,
    created_at: now,
    updated_at: now,
    execution_started_at: null,
    completed_at: null,
  };
  const conversation = {
    schema_version: 2,
    id: conversationId,
    project_id: projectId,
    work_item_id: workItemId,
    created_by_user_id: "user-e2e",
    kind: "planning",
    status: "active",
    provider: "anthropic",
    model: "claude-sonnet-5",
    next_message_sequence: 2,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  let action: Record<string, unknown> | null = null;
  const observedProposals: unknown[] = [];
  await page.addInitScript(() => {
    sessionStorage.setItem("norns_cookie_session", "present");
    localStorage.setItem("norns_theme", "light");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") {
      return json(route, {
        id: "user-e2e",
        email: "e2e@norns.test",
        name: "E2E",
        role: "admin",
        status: "active",
      });
    }
    if (path === "/api/projects") return json(route, [project]);
    if (path === `/api/projects/${projectId}`) return json(route, project);
    if (path === "/api/v2/attention") return json(route, {}, 404);
    if (path.endsWith("/resume")) {
      return json(route, {
        project_id: projectId,
        architecture: null,
        repositories: [],
        phases: [],
        attention: { open_decisions: 0, active_runs: 0, blocked_tasks: 0 },
        next_recommended_action: "Continue visual review",
      });
    }
    if (path.endsWith("/dashboard")) {
      const available = (source: string, data: unknown) => ({
        availability: "available",
        source,
        observed_at: now,
        data,
      });
      return json(route, {
        schema_version: 2,
        project_id: projectId,
        generated_at: now,
        active_work: available("workflow_state", [
          {
            work_item: workItem,
            conversation_id: conversationId,
            deep_link: `/projects/${projectId}/work/${conversationId}`,
            phase_progress: null,
          },
        ]),
        needs_attention: available("attention_projection", [
          {
            project_id: projectId,
            key: "mockup:1",
            source_type: "mockup",
            source_id: "mockup-version-1",
            work_item_id: workItemId,
            conversation_id: conversationId,
            phase_id: null,
            task_id: "checkout",
            title: "Review checkout mockup",
            summary: "Desktop and mobile are ready.",
            severity: "high",
            deep_link: `/projects/${projectId}/work/${conversationId}`,
            occurred_at: now,
          },
        ]),
        open_decisions: available("human_waits_and_decisions", []),
        budget: available("usage_ledger_and_approved_plan", {
          project_id: projectId,
          current_spend_usd: 8,
          projected_budget_usd: null,
          projection_source: "usage_only",
        }),
        recent_deployments: available("deployment_observations", []),
        recent_verification: available("verification_results", []),
        conversations: available("work_conversations", [conversation]),
        approved_mockups: available("mockup_decisions", []),
        recent_artifacts: available("artifact_metadata", []),
        legacy_planning_runs: available("legacy_planning_runs", []),
      });
    }
    if (path.endsWith("/work-items")) {
      return json(route, { work_items: [{ work_item: workItem, conversations: [conversation] }] });
    }
    if (path.endsWith(`/conversations/${conversationId}`) && request.method() === "GET") {
      const actionMessage = action
        ? [
            {
              schema_version: 2,
              id: "message-action-1",
              project_id: projectId,
              work_item_id: workItemId,
              conversation_id: conversationId,
              attempt_id: null,
              role: "user",
              sequence: 2,
              parts: [
                { type: "text", format: "markdown", text: "Approve this exact mockup." },
                { type: "action", action_id: "action-approve-1" },
              ],
              initiated_by_user_id: "user-e2e",
              actor: { actor_type: "human", actor_id: "user-e2e" },
              visibility_status: "complete",
              client_message_id: "client-action-1",
              request_fingerprint: hash,
              created_at: now,
            },
          ]
        : [];
      return json(route, {
        work_item: workItem,
        conversation,
        messages: [
          {
            schema_version: 2,
            id: "message-mockup-1",
            project_id: projectId,
            work_item_id: workItemId,
            conversation_id: conversationId,
            attempt_id: null,
            role: "assistant",
            sequence: 1,
            parts: [{ type: "mockup", mockup_version_id: "mockup-version-1" }],
            initiated_by_user_id: null,
            actor: { actor_type: "agent", actor_id: "project-pm" },
            visibility_status: "complete",
            client_message_id: null,
            request_fingerprint: null,
            created_at: now,
          },
          ...actionMessage,
        ],
        active_attempt: null,
        retryable_attempt: null,
        plan_versions: [],
        actions: action ? [action] : [],
        plan_reviews: [],
        action_effects: [],
        handoff: null,
        latest_summary: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
          exact_cost: false,
          usage_status: "unavailable",
          attempt_count: 0,
        },
        planning_excerpt_receipts: [],
        human_waits: [],
        action_delivery_events: [],
        pm_updates: [],
        pm_update_settings: null,
      });
    }
    if (path.endsWith("/mockups/mockup-version-1")) return json(route, mockup());
    if (path.includes("/artifacts/") && path.endsWith("/content")) {
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2sAAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    }
    if (path.endsWith(`/conversations/${conversationId}/actions`) && request.method() === "POST") {
      const proposal = request.postDataJSON() as Record<string, unknown>;
      observedProposals.push(proposal);
      action = {
        schema_version: 2,
        id: "action-approve-1",
        project_id: projectId,
        work_item_id: workItemId,
        conversation_id: conversationId,
        initiated_by_user_id: "user-e2e",
        actor: { actor_type: "human", actor_id: "user-e2e" },
        source_message_id: "message-action-1",
        action_type: proposal.action_type,
        interaction_class: "approval",
        payload: proposal.payload,
        payload_hash: hash,
        status: "proposed",
        confirmed_by_user_id: null,
        confirmation_idempotency_key: null,
        confirmation_request_fingerprint: null,
        confirmed_at: null,
        recorded_at: null,
        sent_at: null,
        acknowledged_at: null,
        applied_at: null,
        failure_code: null,
        created_at: now,
        updated_at: now,
      };
      return json(route, { message: {}, action }, 201);
    }
    if (path.endsWith("/actions/action-approve-1/confirm")) {
      action = {
        ...action,
        status: "applied",
        confirmed_by_user_id: "user-e2e",
        confirmation_idempotency_key: "confirm-e2e",
        confirmation_request_fingerprint: hash,
        confirmed_at: now,
        recorded_at: now,
        sent_at: now,
        acknowledged_at: now,
        applied_at: now,
      };
      return json(route, {
        action,
        effect: {
          kind: "state_mutation_recorded",
          resource_type: "mockup",
          resource_id: "mockup-decision-1",
          state: "approved",
        },
      });
    }
    if (path.endsWith("/graph")) return json(route, { error: "not_planned" }, 409);
    return json(route, { error: `Unexpected ${request.method()} ${path}` }, 404);
  });
  return observedProposals;
}

test("project operations and exact mockup approval work on desktop and mobile", async ({
  page,
}) => {
  const observedProposals = await prepare(page);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/projects/${projectId}`);

  const dashboard = page.getByTestId("project-operations-dashboard");
  await expect(dashboard).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Status" })).toBeVisible();
  await expect(dashboard.getByText("Review checkout mockup")).toBeVisible();
  await expect(dashboard.getByText("$8.00")).toBeVisible();
  const desktopColumns = await dashboard
    .locator(".operations-grid")
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(desktopColumns.split(" ").length).toBeGreaterThanOrEqual(2);

  await page.goto(`/projects/${projectId}/work/${conversationId}`);
  await expect(page.getByText("Create Mockup", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mockup version 1" })).toBeVisible();
  await expect(page.getByAltText("Current mockup version 1 desktop viewport")).toBeVisible();
  await expect(page.getByAltText("Current mockup version 1 mobile viewport")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm action: Approve exact mockup" }),
  ).toBeVisible();
  expect(observedProposals).toEqual([
    expect.objectContaining({
      action_type: "approve_mockup",
      payload: {
        parameters: {
          mockup_version_id: "mockup-version-1",
          task_id: "checkout",
          manifest_artifact_id: "manifest-1",
          manifest_artifact_hash: hash,
        },
      },
    }),
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Mockup version 1" })).toBeVisible();
  const screenshots = page.locator(".conversation-mockup-screenshots").first();
  expect(
    (await screenshots.evaluate((element) => getComputedStyle(element).gridTemplateColumns)).split(
      " ",
    ),
  ).toHaveLength(1);
});
