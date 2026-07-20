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
    {
      id: "github:43",
      provider: "github",
      display_name: "acme on GitHub",
      owner_type: "organization",
      owner_login: "acme",
      installation_id: "43",
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

const runner = {
  runner_id: "runner-local-1",
  generation: 4,
  connected: true,
  last_seen_at: "2026-07-18T15:00:00Z",
  workspace_picker_ready: true,
  local_project_onboarding_ready: true,
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
    mock.get("/api/integrations/github/connections/github%3A43/repositories", {
      body: [repository],
    });
    mock.get("/api/runners", { body: [runner] });
    mock.get("/api/runners/runner-local-1/workspaces", {
      body: {
        runner_id: runner.runner_id,
        generation: runner.generation,
        workspaces: [{ workspace_id: "workspace-1", label: "Development" }],
      },
    });
    mock.post("/api/runners/runner-local-1/workspaces/browse", (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { workspace_id: string; entry_id?: string };
      return body.entry_id === "folder-apps"
        ? {
            body: {
              runner_id: runner.runner_id,
              workspace_id: body.workspace_id,
              breadcrumb: ["Development", "Apps"],
              entries: [
                {
                  entry_id: "repository-local-app",
                  label: "local-app",
                  kind: "repository",
                  can_browse: false,
                },
              ],
            },
          }
        : {
            body: {
              runner_id: runner.runner_id,
              workspace_id: body.workspace_id,
              breadcrumb: ["Development"],
              entries: [
                { entry_id: "folder-apps", label: "Apps", kind: "folder", can_browse: true },
              ],
            },
          };
    });
    mock.post("/api/runners/runner-local-1/workspaces/validate", {
      body: {
        selection_token: "opaque-selection-token",
        expires_at: "2099-07-18T16:00:00Z",
        repository: {
          runner_id: runner.runner_id,
          workspace_id: "workspace-1",
          repository_id: "repository-local-app",
          repository_display_name: "local-app",
          default_branch: "main",
          observed_head: "abcdef",
        },
      },
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
    mock.post("/api/v2/projects/project-created/source-bindings/local", { status: 201, body: {} });
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

  it("keeps a successful repository refresh when an older request fails later", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    mock.get(
      "/api/integrations/github/connections/github%3A42/repositories",
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await waitFor(() => expect(rejectFirst).toBeDefined());
    await user.selectOptions(screen.getByTestId("github-connection"), "github:43");

    expect(
      await screen.findByRole("button", { name: /octocat\/existing-app/i }),
    ).toBeInTheDocument();
    rejectFirst?.(new TypeError("No server is currently available to service your request"));

    await waitFor(() =>
      expect(
        screen.queryByText(/No server is currently available to service your request/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("creates an existing project from a local runner without ever sending a raw path", async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    await user.click(await screen.findByRole("button", { name: /development/i }));
    await user.click(await screen.findByRole("button", { name: /apps/i }));
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(await screen.findByRole("button", { name: /apps/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /apps/i }));
    await user.click(await screen.findByRole("button", { name: /local-app/i }));
    expect(await screen.findByTestId("local-selection-summary")).toHaveTextContent("local-app");
    expect(screen.getByTestId("project-name")).toHaveValue("local-app");

    await user.click(screen.getByRole("button", { name: /create and open project/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());

    expect(
      mock.calls.find((call) => call.method === "POST" && call.url === "/api/projects"),
    ).toMatchObject({ body: { name: "local-app", description: expect.any(String) } });
    expect(
      mock.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v2/projects/project-created/source-bindings/local",
      ),
    ).toMatchObject({
      body: {
        selection_token: "opaque-selection-token",
        verification_policy_ref: "verification-policy:default-v1",
      },
    });
    expect(JSON.stringify(mock.calls)).not.toMatch(/Users|Development\/Apps|local-app\//);
  });

  it("does not bind a previously selected local folder after switching to a new project", async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    await user.click(await screen.findByRole("button", { name: /development/i }));
    await user.click(await screen.findByRole("button", { name: /apps/i }));
    await user.click(await screen.findByRole("button", { name: /local-app/i }));
    expect(await screen.findByTestId("local-selection-summary")).toHaveTextContent("local-app");

    await user.click(screen.getByRole("button", { name: /^new project/i }));
    const nameInput = screen.getByTestId("project-name");
    await user.clear(nameInput);
    await user.type(nameInput, "Fresh local-free project");
    await user.click(screen.getByRole("button", { name: /create and open project/i }));

    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.find((call) => call.method === "POST" && call.url === "/api/projects"),
    ).toMatchObject({ body: { name: "Fresh local-free project" } });
    expect(
      mock.calls.find(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v2/projects/project-created/source-bindings/local",
      ),
    ).toBeUndefined();
  });

  it("ignores a late validation response after the selected runner changes", async () => {
    const secondRunner = { ...runner, runner_id: "runner-local-2", generation: 1 };
    mock.get("/api/runners", { body: [runner, secondRunner] });
    mock.get("/api/runners/runner-local-2/workspaces", { body: { workspaces: [] } });
    let resolveValidation:
      | ((value: {
          body: { selection_token: string; expires_at: string; repository: object };
        }) => void)
      | undefined;
    mock.post(
      "/api/runners/runner-local-1/workspaces/validate",
      () =>
        new Promise((resolve) => {
          resolveValidation = resolve;
        }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    await user.click(await screen.findByRole("button", { name: /development/i }));
    await user.click(await screen.findByRole("button", { name: /apps/i }));
    await user.click(await screen.findByRole("button", { name: /local-app/i }));
    await user.selectOptions(screen.getByTestId("local-runner"), "runner-local-2");
    resolveValidation?.({
      body: {
        selection_token: "stale-runner-a-token",
        expires_at: "2099-07-18T16:00:00Z",
        repository: {
          runner_id: runner.runner_id,
          workspace_id: "workspace-1",
          repository_id: "repository-local-app",
          repository_display_name: "local-app",
          default_branch: "main",
          observed_head: "abcdef",
        },
      },
    });

    await waitFor(() =>
      expect(screen.queryByTestId("local-selection-summary")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /create and open project/i })).toBeDisabled();
  });

  it("revalidates an ambiguous local binding without creating a duplicate project", async () => {
    let bindingAttempts = 0;
    mock.post("/api/v2/projects/project-created/source-bindings/local", () => {
      bindingAttempts += 1;
      if (bindingAttempts === 1) throw new TypeError("connection reset after commit");
      return { status: 201, body: {} };
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    await user.click(await screen.findByRole("button", { name: /development/i }));
    await user.click(await screen.findByRole("button", { name: /apps/i }));
    await user.click(await screen.findByRole("button", { name: /local-app/i }));
    await user.click(screen.getByRole("button", { name: /create and open project/i }));

    expect(await screen.findByText(/existing project will be reused/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create and open project/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /local-app/i }));
    await user.click(await screen.findByRole("button", { name: /retry repository binding/i }));
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledOnce());
    expect(
      mock.calls.filter((call) => call.method === "POST" && call.url === "/api/projects"),
    ).toHaveLength(1);
    expect(
      mock.calls.filter(
        (call) =>
          call.method === "POST" &&
          call.url === "/api/v2/projects/project-created/source-bindings/local",
      ),
    ).toHaveLength(2);
  });

  it("explains how to recover when no local runner is online", async () => {
    mock.get("/api/runners", { body: [] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    expect(await screen.findByText(/no local runner is online/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /manage runners/i })).toBeInTheDocument();
  });

  it("requires a runner upgrade before offering a legacy runner for folder selection", async () => {
    mock.get("/api/runners", {
      body: [{ ...runner, workspace_picker_ready: false }],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    expect(await screen.findByText(/local runner update required/i)).toBeInTheDocument();
    expect(screen.queryByTestId("local-runner")).not.toBeInTheDocument();
  });

  it("requires relational new-project storage before offering folder selection", async () => {
    mock.get("/api/runners", {
      body: [{ ...runner, local_project_onboarding_ready: false }],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.click(screen.getByRole("button", { name: /existing codebase/i }));
    await user.click(screen.getByRole("button", { name: /local folder/i }));
    expect(await screen.findByText(/project storage activation required/i)).toBeInTheDocument();
    expect(screen.queryByTestId("local-runner")).not.toBeInTheDocument();
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
