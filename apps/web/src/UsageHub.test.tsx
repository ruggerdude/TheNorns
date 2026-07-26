import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageHub } from "./UsageHub";
import { MockFetch } from "./test/mockFetch";

function installUsageApis(mock: MockFetch): void {
  mock.get(/\/api\/usage(?:\/(?:projects\/project-1|users\/user-1))?\/summary(?:\?.*)?$/, {
    body: {
      requests: 1,
      succeeded_requests: 1,
      failed_requests: 0,
      in_progress_requests: 0,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      known_cost_usd: 0.01,
      priced_requests: 1,
      unpriced_requests: 0,
      average_latency_ms: 200,
      average_output_tokens: 20,
      average_known_cost_usd: 0.01,
    },
  });
  mock.get(/\/api\/usage(?:\/(?:projects\/project-1|users\/user-1))?\/timeseries(?:\?.*)?$/, {
    body: { interval: "day", points: [] },
  });
  mock.get(/\/api\/usage(?:\/(?:projects\/project-1|users\/user-1))?\/events(?:\?.*)?$/, {
    body: { events: [], limit: 100, offset: 0, has_more: false },
  });
  mock.get(/\/api\/usage(?:\/(?:projects\/project-1|users\/user-1))?\/breakdown(?:\?.*)?$/, {
    body: {
      breakdowns: [
        {
          dimension: "model",
          value: "gpt-5.6-terra",
          requests: 1,
          failed_requests: 0,
          input_tokens: 100,
          output_tokens: 20,
          cost_usd: 0.01,
          known_cost_usd: 0.01,
          unpriced_requests: 0,
        },
      ],
    },
  });
  mock.get(/\/api\/usage\/analytics\/trends(?:\?.*)?$/, {
    body: {
      current: {
        requests: 1,
        failed_requests: 0,
        retried_requests: 0,
        known_cost_usd: 0.01,
        priced_requests: 1,
        unpriced_requests: 0,
        failure_rate: 0,
        retry_rate: 0,
        cache_efficiency: 0,
        average_input_tokens: 100,
        average_output_tokens: 20,
        average_known_cost_usd: 0.01,
      },
      previous: {
        requests: 0,
        failed_requests: 0,
        retried_requests: 0,
        known_cost_usd: 0,
        priced_requests: 0,
        unpriced_requests: 0,
        failure_rate: 0,
        retry_rate: 0,
        cache_efficiency: 0,
        average_input_tokens: 0,
        average_output_tokens: 0,
        average_known_cost_usd: null,
      },
      change: {
        requests_percent: null,
        known_cost_percent: null,
        failure_rate_points: 0,
      },
    },
  });
  mock.get(/\/api\/usage\/analytics\/hot-spots(?:\?.*)?$/, {
    body: { hot_spots: [] },
  });
  mock.get(/\/api\/usage\/analytics\/recommendations(?:\?.*)?$/, {
    body: { recommendations: [] },
  });
  mock.get(/\/api\/usage\/analytics\/calibration(?:\?.*)?$/, {
    body: {
      comparisons: [],
      mean_absolute_error_percent: null,
      mean_actual_to_estimated_ratio: null,
    },
  });
  mock.install();
}

describe("UsageHub", () => {
  let mock: MockFetch | undefined;

  afterEach(() => mock?.restore());

  it("lets an admin move between project, personal, global, and analytics views", async () => {
    mock = new MockFetch();
    installUsageApis(mock);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <UsageHub
        user={{
          id: "user-1",
          email: "admin@example.com",
          name: "Admin",
          role: "admin",
          status: "active",
        }}
        project={{ id: "project-1", name: "Project One" }}
        onClose={onClose}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Project usage" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project One" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByLabelText("User")).toBeInTheDocument();
    expect(screen.getByLabelText("Phase")).toBeInTheDocument();
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "My usage" }));
    await waitFor(() =>
      expect(mock?.calls.some((call) => call.url === "/api/usage/users/user-1/summary")).toBe(true),
    );
    expect(
      await screen.findByRole("heading", { name: "Most-used models and providers" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("User")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Phase")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All usage" }));
    await waitFor(() =>
      expect(mock?.calls.some((call) => call.url === "/api/usage/summary")).toBe(true),
    );
    expect(screen.getByLabelText("User")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
    expect(screen.getByLabelText("Phase")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Analytics" }));
    expect(
      await screen.findByRole("heading", { name: "Analytics and optimization" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not expose workspace-wide analytics to a member", async () => {
    mock = new MockFetch();
    installUsageApis(mock);
    render(
      <UsageHub
        user={{
          id: "user-1",
          email: "member@example.com",
          name: "Member",
          role: "member",
          status: "active",
        }}
        onClose={vi.fn()}
        onUnauthorized={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "User usage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All usage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Analytics" })).not.toBeInTheDocument();
  });
});
