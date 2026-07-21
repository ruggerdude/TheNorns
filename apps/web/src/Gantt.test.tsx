// FRONT DOOR P1b: the Tracking screen's Gantt (approved mockup), pure
// CSS/SVG, no charting library. Covers: no-signal degradation (empty
// phases), ordinal placement without fabricated dates, solid/hatched fill
// split, blocked-decision red gates vs. plan-approval/passed gates, the
// Today line, and the mini variant used on the workspace phase board.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Gantt, type GanttPhase } from "./Gantt";

function phase(overrides: Partial<GanttPhase> & Pick<GanttPhase, "id" | "name">): GanttPhase {
  return {
    status: "active",
    percentComplete: 0,
    etaAt: null,
    ...overrides,
  };
}

describe("Gantt", () => {
  it("degrades to a no-signal message when there are no phases yet — never a fabricated timeline", () => {
    render(<Gantt phases={[]} />);
    expect(screen.getByTestId("gantt-empty")).toHaveTextContent(/no phases yet/i);
    expect(screen.queryByTestId("gantt")).not.toBeInTheDocument();
  });

  it("places one bar per phase (ordinal placement, no dates) with solid/hatched fill matching percent_complete", () => {
    render(
      <Gantt
        phases={[
          phase({ id: "p1", name: "Discovery", status: "completed", percentComplete: 100 }),
          phase({ id: "p2", name: "Schema & ingest", status: "active", percentComplete: 78 }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId("gantt-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Discovery");
    expect(rows[1]).toHaveTextContent("Schema & ingest");

    const bars = screen.getAllByTestId("gantt-bar");
    expect(bars[1]).toHaveAttribute("data-status", "active");
    // The fill span's width reflects percent_complete for the in-progress bar.
    const fill = within(bars[1] as HTMLElement).getByText("", { selector: ".fill" });
    expect(fill).toHaveStyle({ width: "78%" });
    expect(within(rows[1] as HTMLElement).getByText("78%")).toBeInTheDocument();
  });

  it("renders a red blocked gate with its decision label when a phase has a blocking decision", () => {
    render(
      <Gantt
        phases={[
          phase({ id: "p1", name: "Schema & ingest", status: "active", percentComplete: 40 }),
          phase({
            id: "p2",
            name: "Reconciliation",
            status: "active",
            percentComplete: 0,
            blockedLabel: "Confirm the reconciliation window: 24h or 72h?",
          }),
        ]}
      />,
    );
    const gates = screen.getAllByTestId("gantt-gate");
    expect(gates[0]).toHaveAttribute("data-state", "passed");
    expect(gates[1]).toHaveAttribute("data-state", "blocked");
    expect(gates[1]).toHaveTextContent(/confirm the reconciliation window/i);

    const bars = screen.getAllByTestId("gantt-bar");
    expect(bars[1]).toHaveAttribute("data-blocked", "true");
    expect(screen.getByText("Blocked")).toBeInTheDocument();
  });

  it("shows an upcoming (outline) gate for a plan awaiting approval, distinct from a passed gate", () => {
    render(
      <Gantt
        phases={[
          phase({ id: "p1", name: "Index foundation", status: "completed", percentComplete: 100 }),
          phase({
            id: "p2",
            name: "Ranking & UI parity",
            status: "awaiting_approval",
            percentComplete: 0,
          }),
        ]}
      />,
    );
    const gates = screen.getAllByTestId("gantt-gate");
    expect(gates[0]).toHaveAttribute("data-state", "passed");
    expect(gates[1]).toHaveAttribute("data-state", "upcoming");
  });

  it("renders a Today marker positioned by overall ordinal progress, not a fabricated date", () => {
    render(
      <Gantt
        phases={[
          phase({ id: "p1", name: "Discovery", status: "completed", percentComplete: 100 }),
          phase({ id: "p2", name: "Build", status: "active", percentComplete: 50 }),
          phase({ id: "p3", name: "QA", status: "proposed", percentComplete: 0 }),
        ]}
      />,
    );
    const today = screen.getByTestId("gantt-today");
    // 1 of 3 phases fully done (1/3) plus half of the second phase's slot
    // (0.5 * 1/3) = 1/3 + 1/6 = 1/2.
    expect(today).toHaveStyle({ "--today": "0.500" });
  });

  it("renders a compact mini variant (workspace phase board strip) without per-row names or the legend", () => {
    render(
      <Gantt
        mini
        phases={[phase({ id: "p1", name: "Discovery", status: "completed", percentComplete: 100 })]}
      />,
    );
    expect(screen.getByTestId("gantt")).toHaveAttribute("data-mini", "true");
    expect(screen.queryByText("Discovery")).not.toBeInTheDocument();
    expect(screen.queryByText(/gate passed/i)).not.toBeInTheDocument();
  });

  it("shows an agent-count chip per phase when known, and a non-fabricated placeholder when not", () => {
    render(
      <Gantt
        phases={[
          phase({ id: "p1", name: "Schema & ingest", status: "active", agentCount: 3 }),
          phase({ id: "p2", name: "Reconciliation", status: "active" }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId("gantt-row");
    expect(within(rows[0] as HTMLElement).getByText("3")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("—")).toBeInTheDocument();
  });
});
