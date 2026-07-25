import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunLog } from "./RunLog";
import { MockFetch } from "./test/mockFetch";

describe("RunLog polling", () => {
  let mock: MockFetch;

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    mock.restore();
    vi.useRealTimers();
  });

  it("resets the cursor and visible output when the designated run changes", async () => {
    mock = new MockFetch();
    let run = "run-1";
    mock.get(/\/run-log(\?.*)?$/, (url) => {
      if (run === "run-1") {
        return {
          body: {
            run_id: "run-1",
            entries: [
              {
                sequence: 100,
                occurred_at: "2026-07-25T17:00:00.000Z",
                chunk: "old run output\n",
              },
            ],
            truncated: false,
            total_entries: 1,
          },
        };
      }
      if (url.includes("?after=100")) {
        return {
          body: {
            run_id: "run-2",
            entries: [],
            truncated: false,
            total_entries: 2,
          },
        };
      }
      return {
        body: {
          run_id: "run-2",
          entries: [
            {
              sequence: 1,
              occurred_at: "2026-07-25T17:01:00.000Z",
              chunk: "new run first line\n",
            },
            {
              sequence: 2,
              occurred_at: "2026-07-25T17:01:01.000Z",
              chunk: "new run second line\n",
            },
          ],
          truncated: false,
          total_entries: 2,
        },
      };
    });
    mock.install();

    render(
      <RunLog
        projectId="project-1"
        phaseId="phase-1"
        taskId="task-1"
        active
        onUnauthorized={vi.fn()}
      />,
    );
    expect(await screen.findByText(/old run output/)).toBeVisible();

    run = "run-2";
    await act(() => vi.advanceTimersByTimeAsync(3_001));
    await waitFor(() => expect(screen.getByText(/new run first line/)).toBeVisible());

    expect(screen.queryByText(/old run output/)).not.toBeInTheDocument();
    expect(screen.getByText(/new run second line/)).toBeVisible();
    expect(screen.getByText(/Run log · 2 lines/)).toBeVisible();
    expect(mock.calls.some((call) => call.url.endsWith("/run-log?after=100"))).toBe(true);
    expect(mock.calls.filter((call) => call.url.endsWith("/run-log"))).toHaveLength(2);
  });
});
