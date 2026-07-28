import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, ThemeToggle } from "./theme";

describe("application theme", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    storage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    storage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("defaults to light, switches to dark, and restores the persisted preference", async () => {
    const user = userEvent.setup();
    const first = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: /switch to dark mode/i }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(storage.getItem("norns_theme")).toBe("dark");

    first.unmount();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it("renders the toggle icon-only: no visible Dark/Light text, label via aria-label", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const button = screen.getByRole("button", { name: /switch to dark mode/i });
    expect(button.textContent).not.toMatch(/dark|light/i);
  });
});
