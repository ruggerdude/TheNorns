// POLISH P3: the web trigger for the analyze-repository step. The honesty
// constraints under test: an in-progress state while the analysis runs, the
// SERVER'S error message on failure (never a generic one), and the recorded
// result handed to the caller on success.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzeRepositoryControl } from "./AnalyzeRepositoryControl";
import { MockFetch, type MockResponseInit } from "./test/mockFetch";
import { NextStep } from "./ui";

const ANALYZE_URL = "/api/v2/projects/proj-1/analyze-repository";

const SUCCESS_BODY = {
  architecture_revision_id: "architecture-revision:abc",
  architecture_revision: 1,
  replayed: false,
  title: "Acme App architecture",
  summary: "A small TypeScript service.",
  repository_revision: "c0ffee".padEnd(40, "0"),
  model: { provider: "anthropic", model: "claude-sonnet-5" },
};

describe("AnalyzeRepositoryControl (POLISH P3)", () => {
  let mock: MockFetch;

  beforeEach(() => {
    mock = new MockFetch();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  it("shows an in-progress state, then reports the recorded architecture to its caller", async () => {
    let release: (value: MockResponseInit) => void = () => undefined;
    mock.post(
      ANALYZE_URL,
      () =>
        new Promise<MockResponseInit>((resolve) => {
          release = resolve;
        }),
    );
    const onAnalyzed = vi.fn();
    render(
      <AnalyzeRepositoryControl
        projectId="proj-1"
        onAnalyzed={onAnalyzed}
        onUnauthorized={vi.fn()}
      />,
    );
    const button = screen.getByTestId("analyze-repository-button");
    expect(button).toHaveTextContent("Analyze repository");
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Analyzing repository…");
    release({ body: SUCCESS_BODY });
    await waitFor(() => expect(onAnalyzed).toHaveBeenCalledWith(SUCCESS_BODY));
    expect(button).toBeEnabled();
    expect(screen.queryByTestId("analyze-repository-error")).not.toBeInTheDocument();
  });

  it("sends a body-less POST without a JSON content-type (Fastify 400s that combination)", async () => {
    // Production regression: the control originally sent
    // `content-type: application/json` with NO body, and Fastify rejected it
    // ("Body cannot be empty when content-type is set to 'application/json'")
    // before the route handler ever ran. Assert on the REAL fetch invocation —
    // a mock that only checks the URL is exactly what let that slip.
    mock.post(ANALYZE_URL, { body: SUCCESS_BODY });
    render(
      <AnalyzeRepositoryControl projectId="proj-1" onAnalyzed={vi.fn()} onUnauthorized={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId("analyze-repository-button"));
    await waitFor(() =>
      expect(mock.calls.some((call) => call.method === "POST" && call.url === ANALYZE_URL)).toBe(
        true,
      ),
    );
    const call = mock.calls.find((entry) => entry.method === "POST" && entry.url === ANALYZE_URL);
    expect(call?.body).toBeUndefined();
    expect(call?.headers["content-type"]).toBeUndefined();
  });

  it("shows the server's own error message on failure, not a generic one", async () => {
    mock.post(ANALYZE_URL, {
      status: 503,
      body: {
        error: "github_not_configured",
        message:
          "Repository analysis reads the repository through the GitHub App, which is not configured on this deployment.",
      },
    });
    const onAnalyzed = vi.fn();
    render(
      <AnalyzeRepositoryControl
        projectId="proj-1"
        onAnalyzed={onAnalyzed}
        onUnauthorized={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("analyze-repository-button"));
    const error = await screen.findByTestId("analyze-repository-error");
    expect(error).toHaveTextContent("which is not configured on this deployment");
    expect(onAnalyzed).not.toHaveBeenCalled();
    expect(screen.getByTestId("analyze-repository-button")).toBeEnabled();
  });

  it("signs the user out of the flow on a 401 instead of showing an error", async () => {
    mock.post(ANALYZE_URL, { status: 401, body: { error: "unauthorized" } });
    const onUnauthorized = vi.fn();
    render(<AnalyzeRepositoryControl projectId="proj-1" onUnauthorized={onUnauthorized} />);
    await userEvent.click(screen.getByTestId("analyze-repository-button"));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(screen.queryByTestId("analyze-repository-error")).not.toBeInTheDocument();
  });
});

describe("NextStep (POLISH P3)", () => {
  it("renders guidance neutrally — no alert styling, with a Next step label", () => {
    render(<NextStep testId="next-step">Analyze the repository</NextStep>);
    const step = screen.getByTestId("next-step");
    expect(step).toHaveClass("next-step");
    expect(step).not.toHaveClass("alert");
    expect(step).toHaveTextContent("Next step");
    expect(step).toHaveTextContent("Analyze the repository");
  });

  it("hosts an inline action when the step has a real button", () => {
    render(
      <NextStep testId="next-step" action={<button type="button">Do it</button>}>
        Analyze the repository
      </NextStep>,
    );
    expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
  });
});
