import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type UsageEventItem,
  UsageIntelligence,
  type UsageSummary,
  type UsageTimePoint,
} from "./UsageIntelligence";
import { MockFetch } from "./test/mockFetch";

const summary: UsageSummary = {
  requests: 3,
  succeeded_requests: 2,
  failed_requests: 1,
  in_progress_requests: 0,
  input_tokens: 1_250,
  output_tokens: 320,
  cache_read_tokens: 500,
  cache_write_tokens: 100,
  cost_usd: null,
  known_cost_usd: 0.15,
  priced_requests: 2,
  unpriced_requests: 1,
  average_latency_ms: 840,
  average_output_tokens: 106.67,
  average_known_cost_usd: 0.075,
};

const points: UsageTimePoint[] = [
  {
    bucket: "2026-07-20T00:00:00.000Z",
    requests: 3,
    input_tokens: 1_250,
    output_tokens: 320,
    cost_usd: null,
    known_cost_usd: 0.15,
    unpriced_requests: 1,
  },
];

const events: UsageEventItem[] = [
  {
    id: "event-1",
    request_id: "request-1",
    event_type: "request_failed",
    occurred_at: "2026-07-20T12:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "failed",
    project_id: "project-1",
    phase_id: "phase-1",
    initiated_by_user_id: "user-1",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
    latency_ms: 900,
    error_code: "rate_limit",
  },
];

function installUsageApi(mock: MockFetch, status = 200): void {
  mock.get(/\/api\/usage\/projects\/project-1\/summary(?:\?.*)?$/, {
    status,
    body: status === 200 ? summary : { error: "unauthorized" },
  });
  mock.get(/\/api\/usage\/projects\/project-1\/timeseries(?:\?.*)?$/, {
    status,
    body: status === 200 ? { interval: "day", points } : { error: "unauthorized" },
  });
  mock.get(/\/api\/usage\/projects\/project-1\/events(?:\?.*)?$/, {
    status,
    body:
      status === 200
        ? { events, limit: 100, offset: 0, has_more: false }
        : { error: "unauthorized" },
  });
  mock.get(/\/api\/usage\/projects\/project-1\/breakdown(?:\?.*)?$/, {
    status,
    body:
      status === 200
        ? {
            breakdowns: [
              {
                dimension: "model",
                value: "claude-sonnet-5",
                requests: 3,
                failed_requests: 1,
                input_tokens: 1_250,
                output_tokens: 320,
                cost_usd: null,
                known_cost_usd: 0.15,
                unpriced_requests: 1,
              },
            ],
          }
        : { error: "unauthorized" },
  });
  mock.install();
}

describe("UsageIntelligence", () => {
  let mock: MockFetch | undefined;

  afterEach(() => mock?.restore());

  it("presents incomplete cost honestly with an accessible chart and activity table", async () => {
    mock = new MockFetch();
    installUsageApi(mock);

    render(
      <UsageIntelligence scope={{ kind: "project", id: "project-1" }} onUnauthorized={vi.fn()} />,
    );

    expect(await screen.findByText("1,250")).toBeInTheDocument();
    expect(screen.getAllByText("$0.15 known")).toHaveLength(2);
    expect(screen.getByText(/average across 2 priced requests/)).toBeInTheDocument();
    expect(screen.getByText(/1 unpriced/)).toBeInTheDocument();
    expect(screen.getByText("107 average per request")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Daily cost in US dollars" })).toBeInTheDocument();
    expect(screen.getAllByText("claude-sonnet-5")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /Project users, models/i })).toBeInTheDocument();
    expect(screen.getByText(/rate_limit/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
      "href",
      "/api/usage/projects/project-1/export.csv",
    );
  });

  it("applies filters to every view and the export link", async () => {
    mock = new MockFetch();
    installUsageApi(mock);
    const user = userEvent.setup();

    render(
      <UsageIntelligence scope={{ kind: "project", id: "project-1" }} onUnauthorized={vi.fn()} />,
    );
    await screen.findByText("1,250");

    await user.type(screen.getByLabelText("From"), "2026-07-01");
    await user.type(screen.getByLabelText("To"), "2026-07-01");
    await user.type(screen.getByLabelText("Provider"), "openai");
    await user.type(screen.getByLabelText("Model"), "gpt-5.6-terra");
    await user.type(screen.getByLabelText("Phase"), "phase-1");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await user.selectOptions(screen.getByLabelText("Trend interval"), "month");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(mock?.calls).toHaveLength(8));
    const refreshUrls = mock?.calls.slice(4).map((call) => call.url) ?? [];
    for (const url of refreshUrls) {
      expect(new URL(url, "http://norns.test").searchParams.get("from")).toBe(
        new Date("2026-07-01T00:00:00").toISOString(),
      );
      expect(new URL(url, "http://norns.test").searchParams.get("to")).toBe(
        new Date("2026-07-02T00:00:00").toISOString(),
      );
      expect(url).toContain("provider=openai");
      expect(url).toContain("model=gpt-5.6-terra");
      expect(url).toContain("phase=phase-1");
      expect(url).toContain("status=failed");
    }
    expect(refreshUrls.some((url) => url.includes("interval=month"))).toBe(true);
    // DESIGN R2: the per-scope H1 ("Phase usage") was removed; the phase
    // filter still swaps the breakdown heading to the phase-focused wording.
    expect(
      await screen.findByRole("heading", { name: "Phase users, models, and providers" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Monthly cost trend" })).toBeInTheDocument();
    expect(screen.getByText(/2 completed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toContain(
      "provider=openai",
    );
  });

  it("hands an expired session back to the app", async () => {
    mock = new MockFetch();
    installUsageApi(mock, 401);
    const onUnauthorized = vi.fn();

    render(
      <UsageIntelligence
        scope={{ kind: "project", id: "project-1" }}
        onUnauthorized={onUnauthorized}
      />,
    );

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("usage-error")).not.toBeInTheDocument();
  });
});
