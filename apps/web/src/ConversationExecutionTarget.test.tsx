import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CancellationConfirmationStateT,
  ConversationExecutionProjectionT,
  ProjectRunCancellationProjectionT,
} from "@norns/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRunStopControl, executionTargetHeaderLabel } from "./ConversationExecutionTarget";

const projectId = "project-conversation";
const runId = "run-office-1";
const requestedAt = "2026-07-30T14:00:00.000Z";
const later = "2026-07-30T14:01:00.000Z";
const latest = "2026-07-30T14:02:00.000Z";
const styles = readFileSync(resolve("src/ConversationWorkspace.css"), "utf8");

function executionProjection(
  presentation: ConversationExecutionProjectionT["presentation"],
): ConversationExecutionProjectionT {
  return {
    project_id: projectId,
    conversation_id: "conversation-1",
    presentation,
    target: {
      execution_target_id: "grant-office",
      name: "Office Mac mini",
    },
    run:
      presentation === "idle"
        ? null
        : {
            run_id: runId,
            state: presentation === "active" ? "running" : "succeeded",
            can_stop: presentation === "active",
            cancellation: null,
          },
  };
}

function cancellation(state: CancellationConfirmationStateT): ProjectRunCancellationProjectionT {
  return {
    project_id: projectId,
    run_id: runId,
    state,
    cancellation_requested_at: requestedAt,
    runner_acknowledged_at:
      state === "runner_acknowledged" || state === "process_exited" ? later : null,
    process_exited_at: state === "process_exited" ? latest : null,
    unconfirmed_offline_at: state === "unconfirmed_offline" ? later : null,
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("conversation execution target", () => {
  it.each([
    ["idle", "Execution target · Office Mac mini"],
    ["active", "Running on · Office Mac mini"],
    ["historical", "Last ran on · Office Mac mini"],
  ] as const)("uses the exact %s header wording", (presentation, expected) => {
    expect(executionTargetHeaderLabel(executionProjection(presentation))).toBe(expected);
  });

  it("does not call a merely dispatched run active coding", () => {
    expect(
      executionTargetHeaderLabel({
        ...executionProjection("active"),
        run: {
          run_id: runId,
          state: "dispatched",
          can_stop: true,
          cancellation: null,
        },
      }),
    ).toBe("Preparing on · Office Mac mini");
  });

  it("renders no execution-target wording when the authoritative target is absent", () => {
    expect(
      executionTargetHeaderLabel({
        ...executionProjection("idle"),
        target: null,
      }),
    ).toBeNull();
  });

  it.each([
    ["cancellation_requested", "Cancellation requested"],
    ["runner_acknowledged", "Runner acknowledged"],
    ["process_exited", "Process exited"],
    ["unconfirmed_offline", "Unconfirmed offline"],
  ] as const)("shows %s without claiming more evidence than exists", (state, label) => {
    render(
      <ProjectRunStopControl
        projectId={projectId}
        run={{
          run_id: runId,
          state: "cancelled",
          can_stop: false,
          cancellation: cancellation(state),
        }}
        onCancellation={vi.fn()}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-cancellation-state", state);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(state)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop project work" })).not.toBeInTheDocument();
    if (state === "unconfirmed_offline") {
      expect(screen.getByText(/cannot confirm that its local process has exited/i)).toBeVisible();
    }
  });

  it("submits a reasoned stop for only the authoritative selected run", async () => {
    const onCancellation = vi.fn();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(urlOf(input)).toBe(`/api/projects/${projectId}/runs/${runId}/cancel`);
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(cancellation("cancellation_requested"));
      }),
    );
    const user = userEvent.setup();

    render(
      <ProjectRunStopControl
        projectId={projectId}
        run={{ run_id: runId, state: "running", can_stop: true, cancellation: null }}
        onCancellation={onCancellation}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(screen.getByText(runId)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Stop reason" }),
      "Stop this selected run for review.",
    );
    await user.click(screen.getByRole("button", { name: "Stop project work" }));

    await waitFor(() => expect(onCancellation).toHaveBeenCalledTimes(1));
    expect(bodies).toEqual([
      {
        reason: "Stop this selected run for review.",
        idempotency_key: expect.stringContaining(`stop-${runId}-`),
      },
    ]);
  });

  it.each(["network", "5xx"] as const)(
    "locks and retries the exact reason and key after an ambiguous %s response",
    async (failure) => {
      const bodies: Array<{ reason: string; idempotency_key: string }> = [];
      let attempt = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          attempt += 1;
          if (attempt === 1) {
            if (failure === "network") throw new TypeError("connection lost");
            return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
          }
          return Response.json(cancellation("cancellation_requested"));
        }),
      );
      const onCancellation = vi.fn();
      const user = userEvent.setup();

      render(
        <ProjectRunStopControl
          projectId={projectId}
          run={{ run_id: runId, state: "running", can_stop: true, cancellation: null }}
          onCancellation={onCancellation}
          onUnauthorized={vi.fn()}
        />,
      );

      const reason = screen.getByRole("textbox", { name: "Stop reason" });
      await user.type(reason, "Preserve this exact cancellation request.");
      await user.click(screen.getByRole("button", { name: "Stop project work" }));

      expect(
        await screen.findByText(/exact reason and request are locked for a safe retry/i),
      ).toBeVisible();
      expect(reason).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Retry exact stop request" }));

      await waitFor(() => expect(onCancellation).toHaveBeenCalledTimes(1));
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
    },
  );

  it("keeps the destructive control responsive and legible in forced colors", () => {
    expect(styles).toContain(".project-run-stop");
    expect(styles).toContain(".project-run-stop form .btn");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.project-run-stop,[\s\S]*\.project-run-cancellation-status/,
    );
  });
});
