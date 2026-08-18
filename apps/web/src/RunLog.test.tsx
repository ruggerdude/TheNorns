import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunLog, readableRunActivities } from "./RunLog";
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
        projectId="project:1"
        phaseId="phase:1"
        taskId="task:phase%3Aphase-1:task-1"
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
    expect(screen.getByText(/Development chat · 2 readable updates/)).toBeVisible();
    expect(mock.calls.some((call) => call.url.endsWith("/run-log?after=100"))).toBe(true);
    expect(mock.calls.filter((call) => call.url.endsWith("/run-log"))).toHaveLength(2);
    expect(mock.calls[0]?.url).toContain(
      "/api/v2/projects/project%3A1/phases/phase%3A1/tasks/task%3Aphase%253Aphase-1%3Atask-1/run-log",
    );
  });
});

describe("readable RunLog activity", () => {
  it("turns runner protocol data into concise human updates", () => {
    const activities = readableRunActivities([
      {
        sequence: 1,
        occurred_at: "2026-07-25T17:00:00.000Z",
        chunk: JSON.stringify({ type: "system", subtype: "init" }),
      },
      {
        sequence: 2,
        occurred_at: "2026-07-25T17:00:01.000Z",
        chunk: JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 80 }),
      },
      {
        sequence: 3,
        occurred_at: "2026-07-25T17:00:02.000Z",
        chunk: JSON.stringify({
          type: "system",
          subtype: "thinking_tokens",
          estimated_tokens: 250,
        }),
      },
      {
        sequence: 4,
        occurred_at: "2026-07-25T17:00:03.000Z",
        chunk: JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        }),
      },
      {
        sequence: 5,
        occurred_at: "2026-07-25T17:00:04.000Z",
        chunk: JSON.stringify({
          type: "norns_activity",
          text: "Editing apps/web/src/RunLog.tsx",
        }),
      },
      {
        sequence: 6,
        occurred_at: "2026-07-25T17:00:05.000Z",
        chunk: JSON.stringify({
          type: "norns_activity",
          kind: "message",
          text: "I updated the run transcript and am verifying it now.",
        }),
      },
      {
        sequence: 7,
        occurred_at: "2026-07-25T17:00:06.000Z",
        chunk: JSON.stringify({
          type: "norns_activity",
          kind: "notification",
          text: "50 agent turns completed — development is continuing. Use Stop whenever you want to end it.",
        }),
      },
    ]);

    expect(activities.map((activity) => activity.text)).toEqual([
      "Running a development command",
      "Editing apps/web/src/RunLog.tsx",
      "I updated the run transcript and am verifying it now.",
      "50 agent turns completed — development is continuing. Use Stop whenever you want to end it.",
    ]);
    expect(activities.at(-1)?.kind).toBe("notification");
  });

  it("recovers safe activity labels from truncated legacy Claude events", () => {
    const activities = readableRunActivities([
      {
        sequence: 10,
        occurred_at: "2026-07-25T17:00:00.000Z",
        chunk:
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"[LOCAL_PATH]/private-file",',
      },
      {
        sequence: 11,
        occurred_at: "2026-07-25T17:00:01.000Z",
        chunk:
          '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"secret command contents",',
      },
      {
        sequence: 12,
        occurred_at: "2026-07-25T17:00:02.000Z",
        chunk:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"I created the scaffold.\\nNext I will verify the authentication flow',
      },
    ]);

    expect(activities.map((activity) => activity.text)).toEqual([
      "Reading project files",
      "Running a development command",
      "I created the scaffold.\nNext I will verify the authentication flow…",
    ]);
    expect(activities.map((activity) => activity.text).join(" ")).not.toContain("private-file");
    expect(activities.map((activity) => activity.text).join(" ")).not.toContain("secret command");
  });

  it("shows an active session when a legacy runner has only emitted internal events", () => {
    const activities = readableRunActivities([
      {
        sequence: 20,
        occurred_at: "2026-07-25T17:00:00.000Z",
        chunk: JSON.stringify({
          type: "system",
          subtype: "thinking_tokens",
          estimated_tokens: 250,
        }),
      },
    ]);

    expect(activities.map((activity) => activity.text)).toEqual(["Agent session is active"]);
  });
});
