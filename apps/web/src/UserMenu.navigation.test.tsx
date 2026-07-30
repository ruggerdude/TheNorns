import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedHeaderActions } from "./UserMenu";

const user = {
  id: "owner-1",
  email: "owner@example.com",
  name: "Device Owner",
  role: "admin" as const,
  status: "active" as const,
};

describe("Global navigation", () => {
  it("keeps Computers inside Administration instead of duplicating it globally", async () => {
    const interaction = userEvent.setup();
    render(
      <AuthenticatedHeaderActions
        user={user}
        activeView="admin"
        onOpenUsage={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Computers" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-current", "page");

    await interaction.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(navigation).not.toHaveTextContent("Computers");
    expect(navigation).toHaveTextContent("Admin");
  });
});
