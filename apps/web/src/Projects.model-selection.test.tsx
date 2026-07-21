import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject, projectAlpha } from "./test/fixtures";
import { MockFetch } from "./test/mockFetch";

const githubStatus = {
  configured: true,
  user_authorization: { connected: true, login: "octocat" },
  connections: [
    {
      id: "github:42",
      provider: "github",
      display_name: "octocat on GitHub",
      owner_type: "user",
      owner_login: "octocat",
      installation_id: "42",
      repository_selection: "all",
      status: "connected",
      last_validated_at: "2026-07-16T20:00:00Z",
    },
  ],
};

describe("project manager model selection", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [projectAlpha] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get("/api/integrations/github/status", { body: githubStatus });
    // O1: onboarding always creates/binds a GitHub repository — POST
    // /api/v2/projects/onboarding is the single creation endpoint, returning
    // a lean { project_id, scenario, replayed, ... } summary rather than the
    // full project record (fetched separately via GET /api/projects/:id).
    mock.post("/api/v2/projects/onboarding", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { scenario: string };
      return {
        status: 201,
        body: {
          project_id: "proj_created",
          scenario: body.scenario,
          replayed: false,
          workspace: null,
          remote: null,
          push: null,
          blockers: [],
        },
      };
    });
    mock.get("/api/projects/proj_created", (_url2, init2) => {
      // Not reachable via init2 (GET has no body) — the project's fields
      // come from the onboarding POST body instead, captured via the call
      // log rather than re-parsed here.
      const onboardingCall = mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
      );
      const body = (onboardingCall?.body ?? {}) as {
        name: string;
        description: string;
        pm_provider: "anthropic" | "openai";
        pm_model: Exclude<ProjectSummary["pm_model"], null>;
      };
      return {
        body: makeProject({
          id: "proj_created",
          name: body.name,
          description: body.description,
          pm_provider: body.pm_provider,
          pm_model: body.pm_model,
          reviewer_provider: body.pm_provider === "anthropic" ? "openai" : "anthropic",
          status: "draft",
          plan_objective: null,
        }),
      };
    });
    mock.install();
    render(
      <Projects
        onOpenProject={onOpenProject}
        openProjects={[]}
        onCloseProject={vi.fn()}
        onUnauthorized={vi.fn()}
        onSignOut={vi.fn()}
        user={null}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
      />,
    );
  });

  afterEach(() => mock.restore());

  async function openCreateDialog() {
    await screen.findByText(projectAlpha.name);
    await userEvent.click(screen.getByRole("button", { name: /new project/i }));
    return screen.findByTestId("pm-model");
  }

  async function submit(name: string) {
    await userEvent.type(screen.getByTestId("project-name"), name);
    await userEvent.type(screen.getByTestId("project-description"), "Plan the delivery");
    // "Start something new" always creates a GitHub repository now — give
    // it a name so the create button is enabled.
    await userEvent.type(
      await screen.findByTestId("github-new-repository-name"),
      "plan-the-delivery",
    );
    // A "new" project with an objective moves to the wizard's attach-and-launch
    // step (FRONT DOOR P1) instead of navigating away immediately; skip it here
    // since this suite is only exercising the PM-model selection, not planning.
    await userEvent.click(screen.getByRole("button", { name: /create & draft plan/i }));
    await userEvent.click(await screen.findByRole("button", { name: /skip for now/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    return mock.calls.find(
      (call) => call.method === "POST" && call.url === "/api/v2/projects/onboarding",
    );
  }

  it("offers current Anthropic and OpenAI models and defaults to Sonnet", async () => {
    const select = await openCreateDialog();

    expect(within(select).getByRole("option", { name: "Claude Fable 5" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "GPT-5.6 Sol" })).toBeInTheDocument();
    expect(select).toHaveValue("claude-sonnet-5");
  });

  it("submits Fable with Anthropic as PM and previews OpenAI review", async () => {
    const select = await openCreateDialog();
    await userEvent.selectOptions(select, "claude-fable-5");

    expect(screen.getByText(/Claude Fable 5 will lead planning.*OpenAI/i)).toBeInTheDocument();
    expect(await submit("Fable project")).toMatchObject({
      body: {
        pm_provider: "anthropic",
        pm_model: "claude-fable-5",
      },
    });
  });

  it("submits Sol with OpenAI as PM and flips review to Anthropic", async () => {
    const select = await openCreateDialog();
    await userEvent.selectOptions(select, "gpt-5.6-sol");

    expect(screen.getByText(/GPT-5.6 Sol will lead planning.*Anthropic/i)).toBeInTheDocument();
    expect(await submit("Sol project")).toMatchObject({
      body: {
        pm_provider: "openai",
        pm_model: "gpt-5.6-sol",
      },
    });
  });

  it("shows the selected PM model on project cards", async () => {
    await screen.findByText(projectAlpha.name);
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
  });
});
