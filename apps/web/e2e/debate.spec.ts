import { expect, test } from "@playwright/test";

type Json = Record<string, unknown>;

const project = {
  id: "proj-debate-e2e",
  name: "Debate E2E Project",
  description: "A browser-tested debate workspace.",
  pm_provider: "openai",
  pm_model: "gpt-5.6-terra",
  reviewer_provider: "anthropic",
  status: "planned",
  created_at: "2026-07-18T12:00:00.000Z",
  plan_objective: "Exercise a durable debate.",
};

const graph = {
  version: 1,
  nodes: [],
  cost: { total_usd: 0, unallocated: [] },
};

/**
 * This is deliberately browser-level but provider-free. It validates that the
 * real app sends the durable command protocol correctly, while the network
 * fixture supplies a deterministic completed turn instead of a paid model
 * invocation. Provider execution/recovery belongs to the server suite.
 */
test("creates, controls, directs, replays, and reruns a debate", async ({ page }) => {
  let debateState: "ready" | "running" | "paused" | "cancelled" = "ready";
  let runVersion = 1;
  let startedRuns = 0;
  const requests: Array<{ path: string; body: Json }> = [];

  const definition = (): Json => ({
    id: "debate-e2e",
    project_id: project.id,
    status: debateState,
    revision: 7,
    // Deliberately unrelated to `revision`: rerun must never use this value.
    aggregate_version: 41,
    current_round: debateState === "ready" ? 0 : 1,
    current_turn: debateState === "ready" ? 0 : 2,
    latest_event_sequence: 1,
    reserved_usd: 0,
    settled_usd: 0.12,
    retained_ambiguous_usd: 0,
    stop_reason: debateState === "cancelled" ? "human_cancelled" : null,
    updated_at: "2026-07-18T12:00:00.000Z",
    active_run_id: debateState === "ready" ? null : `run-${startedRuns}`,
    run:
      debateState === "ready"
        ? null
        : { id: `run-${startedRuns}`, status: debateState, aggregate_version: runVersion },
    configuration: {
      title: "Browser debate",
      question: "How should we deploy this migration?",
      actors: [
        {
          id: "actor-reliability",
          kind: "participant",
          display_name: "Reliability lead",
          role_label: "Skeptic",
          instructions: "Demand recovery evidence.",
          provider: "anthropic",
          model: "claude-sonnet-5",
          enabled: true,
          position: 0,
          max_turns: 3,
          max_input_tokens: 12000,
          max_output_tokens: 4000,
          budget_limit_usd: 10,
        },
        {
          id: "actor-delivery",
          kind: "participant",
          display_name: "Delivery lead",
          role_label: "Advocate",
          instructions: "Make the delivery case.",
          provider: "openai",
          model: "gpt-5.6-terra",
          enabled: true,
          position: 1,
          max_turns: 3,
          max_input_tokens: 12000,
          max_output_tokens: 4000,
          budget_limit_usd: 10,
        },
      ],
      schedule: { kind: "round_robin", participant_ids: ["actor-reliability", "actor-delivery"] },
      policy: {
        exact_rounds: null,
        max_rounds: 3,
        max_duration_seconds: 1800,
        max_total_input_tokens: 120000,
        max_total_output_tokens: 40000,
        max_total_cost_usd: 50,
        stop_on_consensus: true,
        no_material_change_rounds: 2,
        repeated_disagreement_rounds: 2,
        provider_failure_threshold: 2,
      },
    },
  });

  const run = (): Json => ({
    id: `run-${startedRuns}`,
    debate_id: "debate-e2e",
    status: debateState,
    aggregate_version: runVersion,
    current_round: 1,
    current_turn: 2,
    reserved_usd: 0,
    settled_usd: 0.12,
    retained_ambiguous_usd: 0,
    final_output:
      debateState === "cancelled"
        ? { title: "Captured output", content: "The final browser artifact is available." }
        : null,
  });

  await page.addInitScript(() => sessionStorage.setItem("norns_cookie_session", "present"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON() as Json | null;
    if (body) requests.push({ path, body });
    const fulfill = (payload: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

    if (path === "/api/auth/me")
      return fulfill({ id: "user-e2e", email: "e2e@norns.test", name: "E2E", role: "admin", status: "active" });
    if (path === "/api/projects") return fulfill([project]);
    if (path === `/api/projects/${project.id}/graph`) return fulfill(graph);
    if (path === `/api/v2/projects/${project.id}/resume`) return fulfill({}, 404);
    if (path === "/api/v2/capabilities/ai-models")
      return fulfill({
        models: [
          { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", configured: true },
          { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai", configured: true },
        ],
      });
    if (path === `/api/v2/projects/${project.id}/debates` && request.method() === "GET")
      return fulfill([definition()]);
    if (path === `/api/v2/projects/${project.id}/debates` && request.method() === "POST")
      return fulfill(definition(), 201);
    if (path === `/api/v2/projects/${project.id}/debates/debate-e2e`) return fulfill(definition());
    if (path.endsWith("/events"))
      return fulfill({
        events: [
          {
            id: "event-1",
            sequence: 1,
            type: "turn_completed",
            round_number: 1,
            turn_number: 1,
            actor_snapshot: definition().configuration.actors[0],
            payload: { content: "Run a rollback drill before deploying." },
            artifact_ids: [],
            usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.12 },
            occurred_at: "2026-07-18T12:00:00.000Z",
          },
        ],
        latest_version: 1,
        next_after_version: 1,
      });
    if (path.endsWith("/runs") && request.method() === "POST") {
      startedRuns += 1;
      debateState = "running";
      runVersion = 1;
      return fulfill(run(), 201);
    }
    if (path.endsWith("/control") && request.method() === "POST") {
      const action = body?.action;
      debateState = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
      runVersion += 1;
      return fulfill(run());
    }
    if (path.endsWith("/interventions") && request.method() === "POST") return fulfill({}, 202);
    if (path.includes("/runs/")) return fulfill(run());
    return fulfill({ error: `Unexpected route: ${path}` }, 404);
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Debate E2E Project" }).click();
  await page.getByRole("button", { name: "Debates" }).click();
  await page.getByRole("button", { name: "New debate" }).click();

  await page.getByLabel("Debate title").fill("Browser debate");
  await page.getByLabel("Question").fill("How should we deploy this migration?");
  const names = page.getByLabel("Display name");
  const roles = page.getByLabel("Role label");
  const instructions = page.getByLabel("Instructions");
  const providers = page.getByLabel("Provider");
  const models = page.getByLabel("Exact model");
  await names.nth(0).fill("Reliability lead");
  await names.nth(1).fill("Delivery lead");
  await roles.nth(0).fill("Skeptic");
  await roles.nth(1).fill("Advocate");
  await instructions.nth(0).fill("Demand recovery evidence.");
  await instructions.nth(1).fill("Make the delivery case.");
  await models.nth(0).selectOption("claude-sonnet-5");
  await providers.nth(1).selectOption("openai");
  await models.nth(1).selectOption("gpt-5.6-terra");
  await page.getByRole("button", { name: "Create debate" }).click();

  await page.getByRole("button", { name: "Start debate" }).click();
  await expect(page.getByText("Run a rollback drill before deploying.")).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();

  await page.getByLabel("Target").selectOption("actor-reliability");
  await page.getByLabel("Message").fill("Show the rollback evidence in the next turn.");
  await page.getByRole("button", { name: "Record intervention" }).click();
  await expect
    .poll(() =>
      requests.find((entry) => entry.path.endsWith("/interventions"))?.body.expected_version,
    )
    .toBe(runVersion);

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("The final browser artifact is available.")).toBeVisible();
  await page.getByRole("button", { name: "Rerun debate (new run)" }).click();
  await expect
    .poll(() => requests.filter((entry) => entry.path.endsWith("/runs")).at(-1)?.body.expected_debate_version)
    .toBe(7);
});
