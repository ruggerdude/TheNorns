import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionTargetSettings } from "./ExecutionTargetSettings";
import { MockFetch, type MockResponseInit } from "./test/mockFetch";

const projectId = "project-targets";
const executionTargetStyles = readFileSync(resolve("src/ExecutionTargetSettings.css"), "utf8");

function access(source: "owner" | "membership" | "admin" = "owner") {
  return {
    schema_version: 2,
    project_id: projectId,
    user_id: source === "owner" ? "owner-1" : `${source}-1`,
    owner_user_id: "owner-1",
    can_access: true,
    can_manage_members: source !== "membership",
    source,
  };
}

function target(
  executionTargetId: string,
  name: string,
  accessStatus: "shared" | "pending",
  overrides: Record<string, unknown> = {},
) {
  return {
    project_id: projectId,
    execution_target_id: executionTargetId,
    name,
    location_label: name === "Office Mac mini" ? "Office" : "Studio",
    os_family: name === "Office Mac mini" ? "macos" : "windows",
    status: {
      availability: "online",
      compatibility: "ready",
      workload: name === "Office Mac mini" ? "busy" : "idle",
      access: accessStatus,
    },
    last_seen_at: "2026-07-30T14:30:00.000Z",
    ...overrides,
  };
}

function envelope(
  selectedExecutionTargetId: string | null,
  executionTargets: unknown[],
  workActive = false,
) {
  return {
    project_id: projectId,
    selected_execution_target_id: selectedExecutionTargetId,
    work_active: workActive,
    execution_targets: executionTargets,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let settle!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      settle = resolve;
    }),
    resolve: (value) => settle(value),
  };
}

describe("ExecutionTargetSettings", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
  });

  afterEach(() => {
    mock.restore();
    vi.restoreAllMocks();
  });

  function installOwnerTargets(
    selectedExecutionTargetId = "grant-office",
    workActive = false,
  ): void {
    mock.get(`/api/v2/projects/${projectId}/access`, { body: access() });
    mock.get(`/api/projects/${projectId}/execution-targets`, {
      body: envelope(
        selectedExecutionTargetId,
        [
          target(
            "grant-office",
            "Office Mac mini",
            selectedExecutionTargetId === "grant-office" ? "shared" : "pending",
          ),
          target(
            "grant-studio",
            "Studio workstation",
            selectedExecutionTargetId === "grant-studio" ? "shared" : "pending",
          ),
        ],
        workActive,
      ),
    });
  }

  it("lets only the project owner select a grant with native keyboard controls and CAS", async () => {
    installOwnerTargets();
    mock.put(`/api/projects/${projectId}/execution-target`, {
      body: envelope("grant-studio", [
        target("grant-office", "Office Mac mini", "pending"),
        target("grant-studio", "Studio workstation", "shared"),
      ]),
    });
    mock.install();
    const user = userEvent.setup();

    const { container } = render(
      <ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />,
    );

    const group = await screen.findByRole("group", {
      name: "Eligible project execution targets",
    });
    expect(within(group).getByText("Current")).toBeVisible();
    expect(within(group).getByText("Eligible")).toBeVisible();
    expect(within(group).getByText("busy")).toHaveClass("badge-info");
    expect(container).not.toHaveTextContent("grant-office");
    expect(container).not.toHaveTextContent("grant-studio");

    const studio = within(group).getByRole("radio", { name: /Studio workstation/ });
    studio.focus();
    await user.keyboard(" ");
    expect(studio).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save execution target" }));

    expect(await screen.findByText("Execution target updated.")).toBeVisible();
    expect(studio).toBeChecked();
    const mutation = mock.calls.find((call) => call.method === "PUT");
    expect(mutation).toMatchObject({
      url: `/api/projects/${projectId}/execution-target`,
      body: {
        execution_target_id: "grant-studio",
        expected_current_execution_target_id: "grant-office",
      },
    });
    expect(mutation?.headers["content-type"]).toBe("application/json");
  });

  it("renders only the accepted target as read-only for a project member", async () => {
    mock.get(`/api/v2/projects/${projectId}/access`, { body: access("membership") });
    mock.get(`/api/projects/${projectId}/execution-targets`, {
      body: envelope("grant-office", [target("grant-office", "Office Mac mini", "shared")]),
    });
    mock.install();

    const { container } = render(
      <ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />,
    );

    expect(await screen.findByText("Read only")).toBeVisible();
    expect(screen.getByText("Only the project owner can change this setting.")).toBeVisible();
    expect(screen.getByText("Office Mac mini")).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save execution target" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("grant-office");
  });

  it("blocks every selection control while project work is active", async () => {
    installOwnerTargets("grant-office", true);
    mock.install();
    const user = userEvent.setup();

    render(<ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />);

    const studio = await screen.findByRole("radio", { name: /Studio workstation/ });
    expect(studio).toBeDisabled();
    expect(
      screen.getByText("Target changes are blocked while project work is active."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save execution target" })).toBeDisabled();
    await user.click(studio);
    expect(mock.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("restores the current target when work starts during a selection request", async () => {
    installOwnerTargets();
    mock.put(`/api/projects/${projectId}/execution-target`, {
      status: 409,
      body: { error: "project_work_active" },
    });
    mock.install();
    const user = userEvent.setup();

    render(<ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />);
    const office = await screen.findByRole("radio", { name: /Office Mac mini/ });
    const studio = screen.getByRole("radio", { name: /Studio workstation/ });
    await user.click(studio);
    await user.click(screen.getByRole("button", { name: "Save execution target" }));

    expect(
      await screen.findByText("Execution target cannot be changed while project work is active."),
    ).toBeVisible();
    expect(office).toBeChecked();
    expect(office).toBeDisabled();
    expect(studio).not.toBeChecked();
    expect(studio).toBeDisabled();
  });

  it("reloads the current selection after a stale-tab conflict", async () => {
    let reads = 0;
    mock.get(`/api/v2/projects/${projectId}/access`, { body: access() });
    mock.get(`/api/projects/${projectId}/execution-targets`, () => {
      reads += 1;
      return {
        body:
          reads === 1
            ? envelope("grant-office", [
                target("grant-office", "Office Mac mini", "shared"),
                target("grant-studio", "Studio workstation", "pending"),
              ])
            : envelope("grant-studio", [
                target("grant-office", "Office Mac mini", "pending"),
                target("grant-studio", "Studio workstation", "shared"),
              ]),
      };
    });
    mock.put(`/api/projects/${projectId}/execution-target`, {
      status: 409,
      body: { error: "execution_target_changed" },
    });
    mock.install();
    const user = userEvent.setup();

    render(<ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />);
    const studio = await screen.findByRole("radio", { name: /Studio workstation/ });
    await user.click(studio);
    await user.click(screen.getByRole("button", { name: "Save execution target" }));

    expect(
      await screen.findByText(
        "The execution target changed in another session. Review the latest selection.",
      ),
    ).toBeVisible();
    expect(studio).toBeChecked();
    expect(reads).toBe(2);
  });

  it("ignores an out-of-order response after navigating to another project", async () => {
    const firstProjectId = "project-first";
    const secondProjectId = "project-second";
    const firstTargets = deferred<MockResponseInit>();
    mock.get(`/api/v2/projects/${firstProjectId}/access`, {
      body: { ...access(), project_id: firstProjectId },
    });
    mock.get(`/api/projects/${firstProjectId}/execution-targets`, () => firstTargets.promise);
    mock.get(`/api/v2/projects/${secondProjectId}/access`, {
      body: { ...access(), project_id: secondProjectId },
    });
    mock.get(`/api/projects/${secondProjectId}/execution-targets`, {
      body: {
        ...envelope("grant-second", [
          {
            ...target("grant-second", "Second project Mac", "shared"),
            project_id: secondProjectId,
          },
        ]),
        project_id: secondProjectId,
      },
    });
    mock.install();

    const { rerender } = render(
      <ExecutionTargetSettings projectId={firstProjectId} onUnauthorized={vi.fn()} />,
    );
    rerender(<ExecutionTargetSettings projectId={secondProjectId} onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("Second project Mac")).toBeVisible();
    firstTargets.resolve({
      body: {
        ...envelope("grant-first", [
          {
            ...target("grant-first", "Stale project Mac", "shared"),
            project_id: firstProjectId,
          },
        ]),
        project_id: firstProjectId,
      },
    });
    await waitFor(() => expect(screen.queryByText("Stale project Mac")).not.toBeInTheDocument());
    expect(screen.getByText("Second project Mac")).toBeVisible();
  });

  it("fails closed on a privacy-widened target DTO", async () => {
    mock.get(`/api/v2/projects/${projectId}/access`, { body: access() });
    mock.get(`/api/projects/${projectId}/execution-targets`, {
      body: envelope("grant-office", [
        target("grant-office", "Office Mac mini", "shared", {
          public_key_fingerprint: "sensitive-fingerprint",
        }),
      ]),
    });
    mock.install();

    render(<ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText("Execution target response is invalid.")).toBeVisible();
    expect(screen.queryByText("sensitive-fingerprint")).not.toBeInTheDocument();
  });

  it("hides cleanly when the independent Phase 4 gate is off", async () => {
    mock.get(`/api/v2/projects/${projectId}/access`, { body: access() });
    mock.get(`/api/projects/${projectId}/execution-targets`, {
      status: 404,
      body: { error: "not_found" },
    });
    mock.install();

    render(<ExecutionTargetSettings projectId={projectId} onUnauthorized={vi.fn()} />);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Execution target" })).not.toBeInTheDocument(),
    );
  });

  it("keeps the target layout usable on narrow and forced-color displays", () => {
    expect(executionTargetStyles).toMatch(/@media \(max-width: 620px\)/);
    expect(executionTargetStyles).toMatch(
      /\.execution-target-option[\s\S]*grid-template-columns: 1fr/,
    );
    expect(executionTargetStyles).toMatch(/\.execution-target-save-row \.btn[\s\S]*width: 100%/);
    expect(executionTargetStyles).toMatch(/@media \(forced-colors: active\)/);
    expect(executionTargetStyles).toMatch(/\.execution-target-option:focus-within/);
  });
});
