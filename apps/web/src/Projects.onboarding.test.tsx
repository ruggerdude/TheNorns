import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectSummary, Projects } from "./Projects";
import { makeProject } from "./test/fixtures";
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

const repository = {
  id: "9001",
  connection_id: "github:42",
  owner: "octocat",
  name: "existing-app",
  full_name: "octocat/existing-app",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/octocat/existing-app",
  clone_url: "https://github.com/octocat/existing-app.git",
  description: "Existing application",
  language: "TypeScript",
  archived: false,
  updated_at: "2026-07-16T20:00:00Z",
};

describe("unified project onboarding", () => {
  let mock: MockFetch;
  const onOpenProject = vi.fn<(project: ProjectSummary) => void>();

  beforeEach(() => {
    onOpenProject.mockReset();
    mock = new MockFetch();
    mock.get("/api/projects", { body: [] });
    mock.get("/api/v2/attention", { status: 404, body: {} });
    mock.get("/api/integrations/github/status", { body: githubStatus });
    mock.get("/api/integrations/github/connections/github%3A42/repositories", {
      body: [repository],
    });
    mock.post("/api/projects", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        description: string;
        pm_provider: "anthropic" | "openai";
        pm_model: ProjectSummary["pm_model"];
      };
      return {
        status: 201,
        body: makeProject({
          id: "project-created",
          name: body.name,
          description: body.description,
          pm_provider: body.pm_provider,
          pm_model: body.pm_model ?? undefined,
          reviewer_provider: body.pm_provider === "anthropic" ? "openai" : "anthropic",
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

  it("removes the redundant Add existing action", async () => {
    await screen.findByRole("button", { name: /new project/i });
    expect(screen.queryByRole("button", { name: /add existing/i })).not.toBeInTheDocument();
  });

  it("selects existing code from a connected GitHub repository picker", async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(await screen.findByRole("button", { name: /octocat\/existing-app/i }));
    expect(screen.getByTestId("project-name")).toHaveValue("existing-app");
    expect(screen.getByTestId("project-description")).toHaveValue("Existing application");

    await user.click(screen.getByRole("button", { name: /create and open project/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find((call) => call.method === "POST" && call.url === "/api/projects"),
    ).toMatchObject({
      body: {
        source_type: "github",
        github_connection_id: "github:42",
        github_repository_id: "9001",
      },
    });
  });

  it("creates a GitHub repository before binding a new project", async () => {
    mock.post("/api/integrations/github/repositories", {
      status: 201,
      body: {
        ...repository,
        id: "9002",
        name: "fresh-app",
        full_name: "octocat/fresh-app",
        binding_ready: true,
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /create on github/i }));
    await user.type(screen.getByTestId("github-new-repository-name"), "fresh-app");
    await user.type(screen.getByTestId("project-name"), "Fresh app");
    await user.type(screen.getByTestId("project-description"), "Build a fresh application");
    await user.click(screen.getByRole("button", { name: /create and open project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find(
        (call) => call.method === "POST" && call.url === "/api/integrations/github/repositories",
      ),
    ).toMatchObject({
      body: {
        connection_id: "github:42",
        name: "fresh-app",
        private: true,
      },
    });
    expect(
      mock.calls.find((call) => call.method === "POST" && call.url === "/api/projects"),
    ).toMatchObject({ body: { github_repository_id: "9002" } });
  });
});
