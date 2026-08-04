import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRecoveryBoundary } from "./AppRecoveryBoundary";

function BrokenApp(): React.ReactElement {
  throw new Error("render failed");
}

describe("AppRecoveryBoundary", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  afterEach(() => {
    consoleError.mockClear();
  });

  it("replaces a failed render with a clear, actionable recovery screen", async () => {
    const reload = vi.fn();
    const user = userEvent.setup();

    render(
      <AppRecoveryBoundary reload={reload}>
        <BrokenApp />
      </AppRecoveryBoundary>,
    );

    expect(screen.getByRole("heading", { name: "The app was updated" })).toBeInTheDocument();
    expect(screen.getByText(/Your work is safe/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload app" }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
