import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { Account } from "./Account";
import type { CurrentUser } from "./auth";

const admin: CurrentUser = {
  id: "u1",
  email: "admin@x.com",
  name: "Ada",
  role: "admin",
  status: "active",
};

describe("Account panel", () => {
  test("shows the signed-in user's email, name, and role", () => {
    render(<Account user={admin} onClose={vi.fn()} onSignOut={vi.fn()} />);
    const panel = screen.getByTestId("account-panel");
    expect(panel).toHaveTextContent("admin@x.com");
    expect(panel).toHaveTextContent("Ada");
    expect(panel).toHaveTextContent("admin");
  });

  test("Close calls onClose, Sign out calls onSignOut", async () => {
    const onClose = vi.fn();
    const onSignOut = vi.fn();
    const user = userEvent.setup();
    render(<Account user={admin} onClose={onClose} onSignOut={onSignOut} />);

    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(onSignOut).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("clicking the backdrop dismisses the panel", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Account user={admin} onClose={onClose} onSignOut={vi.fn()} />);

    const backdrop = document.querySelector(".modal-backdrop");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
