import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageAnalytics } from "./UsageAnalytics";
import { MockFetch } from "./test/mockFetch";

function installAnalyticsApi(mock: MockFetch, status = 200): void {
  const error = { error: "unauthorized" };
  mock.get(/\/api\/usage\/analytics\/trends(?:\?.*)?$/, {
    status,
    body:
      status === 200
        ? {
            current: {
              requests: 20,
              failed_requests: 3,
              retried_requests: 2,
              known_cost_usd: 12.5,
              priced_requests: 19,
              unpriced_requests: 1,
              failure_rate: 0.15,
              retry_rate: 0.1,
              cache_efficiency: 0.25,
              average_input_tokens: 12_000,
              average_output_tokens: 1_200,
              average_known_cost_usd: 0.657895,
            },
            previous: {
              requests: 10,
              failed_requests: 1,
              retried_requests: 1,
              known_cost_usd: 10,
              priced_requests: 10,
              unpriced_requests: 0,
              failure_rate: 0.1,
              retry_rate: 0.1,
              cache_efficiency: 0.2,
              average_input_tokens: 10_000,
              average_output_tokens: 1_000,
              average_known_cost_usd: 1,
            },
            change: {
              requests_percent: 100,
              known_cost_percent: 25,
              failure_rate_points: 5,
            },
          }
        : error,
  });
  mock.get(/\/api\/usage\/analytics\/hot-spots(?:\?.*)?$/, {
    status,
    body:
      status === 200
        ? {
            hot_spots: [
              {
                value: "anthropic",
                requests: 12,
                failed_requests: 2,
                known_cost_usd: 8,
                unpriced_requests: 0,
              },
            ],
          }
        : error,
  });
  mock.get(/\/api\/usage\/analytics\/recommendations(?:\?.*)?$/, {
    status,
    body:
      status === 200
        ? {
            recommendations: [
              {
                id: "reduce-failed-request-spend",
                priority: "high",
                title: "Reduce failed request spend",
                recommendation: "Stop non-retryable calls before provider dispatch.",
                evidence: ["3 of 20 requests failed."],
                estimated_savings_usd: 1.25,
                confidence: 0.8,
                assumptions: ["Half is preventable."],
              },
            ],
          }
        : error,
  });
  mock.get(/\/api\/usage\/analytics\/calibration(?:\?.*)?$/, {
    status,
    body:
      status === 200
        ? {
            comparisons: [{ observation_id: "observation-1" }],
            mean_absolute_error_percent: 8.2,
            mean_actual_to_estimated_ratio: 1.05,
          }
        : error,
  });
  mock.get(/\/api\/usage\/analytics\/forecast\/anthropic$/, {
    status,
    body:
      status === 200
        ? {
            plan_name: "Team cycle",
            allowance_unit: "credits",
            observed_remaining: 400,
            estimated_weekly_limit: 1_000,
            estimated_monthly_limit: 4_348,
            confidence_interval_low: 900,
            confidence_interval_high: 1_100,
            confidence_rating: "medium",
            utilization_percent: 60,
            daily_burn_rate: 50,
            forecast_exhaustion_at: "2026-07-23T00:00:00.000Z",
            status: "at_risk",
            confidence: 0.8,
          }
        : error,
  });
  mock.install();
}

describe("UsageAnalytics", () => {
  let mock: MockFetch | undefined;

  afterEach(() => mock?.restore());

  it("shows evidence-backed analytics and forecasts after filtering like an admin user", async () => {
    mock = new MockFetch();
    installAnalyticsApi(mock);
    const user = userEvent.setup();
    render(<UsageAnalytics onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText("+100.0% vs prior period")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("Reduce failed request spend")).toBeInTheDocument();
    expect(screen.getByText(/Mean absolute error:/)).toHaveTextContent("8.2%");

    await user.type(screen.getByLabelText("Provider"), "anthropic");
    await user.selectOptions(screen.getByLabelText("Hot spot"), "phase");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByText("Cycle forecast · Team cycle")).toBeInTheDocument();
    expect(screen.getByText("at risk")).toBeInTheDocument();
    expect(screen.getByText(/400 credits remaining/)).toBeInTheDocument();
    expect(screen.getByText(/1,000 weekly/)).toBeInTheDocument();
    await waitFor(() => expect(mock?.calls).toHaveLength(9));
    expect(
      mock?.calls.some(
        (call) =>
          call.url.includes("/hot-spots?") &&
          call.url.includes("provider=anthropic") &&
          call.url.includes("dimension=phase"),
      ),
    ).toBe(true);
  });

  it("returns an expired admin session to the host app", async () => {
    mock = new MockFetch();
    installAnalyticsApi(mock, 401);
    const onUnauthorized = vi.fn();
    render(<UsageAnalytics onUnauthorized={onUnauthorized} />);

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("usage-analytics-error")).not.toBeInTheDocument();
  });
});
