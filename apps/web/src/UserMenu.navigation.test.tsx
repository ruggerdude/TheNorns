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
    await interaction.click(screen.getByRole("button", { name: "Open application settings" }));
    expect(screen.getByRole("button", { name: "Administration" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Device Owner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dark" })).toBeInTheDocument();

    await interaction.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(navigation).not.toHaveTextContent("Computers");
    expect(navigation).toHaveTextContent("Admin");
  });

  it("dismisses the application settings menu with Escape", async () => {
    const interaction = userEvent.setup();
    render(
      <AuthenticatedHeaderActions
        user={user}
        onOpenUsage={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    await interaction.click(screen.getByRole("button", { name: "Open application settings" }));
    expect(screen.getByRole("dialog", { name: "Application settings" })).toBeInTheDocument();
    await interaction.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Application settings" })).not.toBeInTheDocument();
  });
});
