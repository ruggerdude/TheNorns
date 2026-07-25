import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeStatusPanel } from "./KnowledgeStatusPanel";
import { MockFetch } from "./test/mockFetch";

const projectId = "project-k";
const phaseId = "phase-k";
const statusUrl = `/api/v2/projects/${projectId}/phases/${phaseId}/knowledge/status`;
const gateUrl = `/api/v2/projects/${projectId}/phases/${phaseId}/knowledge/completion`;
const packagesUrl = `/api/v2/projects/${projectId}/knowledge/packages`;

describe("KnowledgeStatusPanel", () => {
  let mock: MockFetch;

  afterEach(() => mock.restore());

  it("shows package and gate coverage, handoffs, heartbeats, conflicts, blockers, risks, and decisions", async () => {
    mock = new MockFetch();
    mock.get(statusUrl, {
      body: {
        schema_version: 2,
        project_id: projectId,
        phase_id: phaseId,
        overall_status: "red",
        completed: ["Repository foundation"],
        in_progress: ["Web interface"],
        blockers: ["Critical interface conflict"],
        risks: ["run-2: repeated identical status updates"],
        decisions_required: ["Choose the compatibility policy"],
        active_agents: 2,
        next_milestone: "Web interface",
        missing_heartbeat_run_ids: ["run-2"],
        generated_at: "2026-07-25T12:30:00.000Z",
      },
    });
    mock.get(gateUrl, {
      body: {
        schema_version: 2,
        scope_type: "phase",
        scope_id: phaseId,
        passed: false,
        evaluated_at: "2026-07-25T12:30:00.000Z",
        checks: [
          {
            id: "tasks",
            label: "Every required task passes its completion gate",
            passed: false,
            evidence: ["task-2: Structured completion handoff exists"],
          },
          {
            id: "integration",
            label: "Integration has no unresolved conflicts",
            passed: false,
            evidence: ["conflict-1"],
          },
        ],
        blockers: ["Every required task passes its completion gate"],
      },
    });
    mock.get(packagesUrl, {
      body: [
        {
          package: {
            schema_version: 2,
            id: "package-project",
            project_id: projectId,
            name: "Project constitution",
            type: "project",
            authority: "constitutional",
            owner: "curator",
            scope_kind: "project",
            scope_id: projectId,
            parent_package_id: null,
            created_at: "2026-07-25T12:00:00.000Z",
            updated_at: "2026-07-25T12:00:00.000Z",
          },
          versions: [{ status: "active" }],
        },
        {
          package: {
            schema_version: 2,
            id: "package-phase",
            project_id: projectId,
            name: "Phase delivery context",
            type: "phase",
            authority: "operational",
            owner: "pm",
            scope_kind: "phase",
            scope_id: phaseId,
            parent_package_id: "package-project",
            created_at: "2026-07-25T12:00:00.000Z",
            updated_at: "2026-07-25T12:00:00.000Z",
          },
          versions: [{ status: "draft" }],
        },
      ],
    });
    mock.install();

    render(
      <KnowledgeStatusPanel projectId={projectId} phaseId={phaseId} onUnauthorized={vi.fn()} />,
    );

    expect(await screen.findByRole("heading", { name: "Web interface" })).toBeInTheDocument();
    expect(screen.getByTestId("knowledge-package-coverage")).toHaveTextContent(
      "1/2packages approved or active",
    );
    expect(screen.getByTestId("knowledge-gate-summary")).toHaveTextContent(
      "Blockedphase completion gate",
    );
    expect(screen.getByTestId("knowledge-handoff-summary")).toHaveTextContent(
      "1/2completed task handoffs",
    );
    expect(screen.getByTestId("knowledge-heartbeat-summary")).toHaveTextContent(
      "1missing agent heartbeats",
    );

    const panel = screen.getByTestId("knowledge-status-panel");
    expect(within(panel).getByText("Repository foundation: handoff completed")).toBeInTheDocument();
    expect(within(panel).getByText("Web interface: handoff pending")).toBeInTheDocument();
    expect(within(panel).getByText("Project constitution: active")).toBeInTheDocument();
    expect(within(panel).getByText("Phase delivery context: draft")).toBeInTheDocument();
    expect(within(panel).getByText("Integration conflicts need attention")).toBeInTheDocument();
    expect(within(panel).getByText("Missing heartbeat: run-2")).toBeInTheDocument();
    expect(within(panel).getByText("Critical interface conflict")).toBeInTheDocument();
    expect(within(panel).getByText("run-2: repeated identical status updates")).toBeInTheDocument();
    expect(
      within(panel).getByText("Decision: Choose the compatibility policy"),
    ).toBeInTheDocument();
  });

  it("shows an honest not-yet-instrumented state when the knowledge routes have no phase data", async () => {
    mock = new MockFetch();
    mock.get(statusUrl, { status: 404, body: { message: "phase not found" } });
    mock.get(gateUrl, { status: 404, body: { message: "phase not found" } });
    mock.get(packagesUrl, { body: [] });
    mock.install();

    render(
      <KnowledgeStatusPanel projectId={projectId} phaseId={phaseId} onUnauthorized={vi.fn()} />,
    );

    expect(await screen.findByTestId("knowledge-status-unavailable")).toHaveTextContent(
      "has not started reporting knowledge packages, heartbeats, handoffs, or completion gates",
    );
  });

  it("does not request knowledge data before a phase is selected", () => {
    mock = new MockFetch();
    mock.install();

    render(<KnowledgeStatusPanel projectId={projectId} phaseId={null} onUnauthorized={vi.fn()} />);

    expect(screen.getByTestId("knowledge-status-empty")).toHaveTextContent("No phase selected");
    expect(mock.calls).toHaveLength(0);
  });

  it("names relational work honestly while it is waiting for a durable coding phase", () => {
    mock = new MockFetch();
    mock.install();

    render(
      <KnowledgeStatusPanel
        projectId={projectId}
        phaseId={null}
        relationalPhase={{
          name: "Correct workspace copy",
          status: "approved · coding needs restart",
          nextAction: "Retry coding start in Phase",
        }}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(screen.getByTestId("knowledge-status-relational")).toHaveTextContent(
      "Correct workspace copy",
    );
    expect(screen.getByTestId("knowledge-status-relational")).toHaveTextContent(
      "approved · coding needs restart",
    );
    expect(screen.getByTestId("knowledge-status-relational")).toHaveTextContent(
      "Retry coding start in Phase",
    );
    expect(screen.queryByText("No phase selected")).not.toBeInTheDocument();
    expect(mock.calls).toHaveLength(0);
  });
});
