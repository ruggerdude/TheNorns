import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedHeaderActions } from "./UserMenu";

const user = {
  id: "owner-1",
  email: "owner@example.com",
  name: "Device Owner",
  role: "member" as const,
  status: "active" as const,
};

describe("Computers navigation", () => {
  it("exposes the active page in desktop and keyboard-operable mobile navigation", async () => {
    const onOpenComputers = vi.fn();
    const interaction = userEvent.setup();
    render(
      <AuthenticatedHeaderActions
        user={user}
        activeView="computers"
        onOpenComputers={onOpenComputers}
        onOpenUsage={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenAdmin={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    const desktopLink = screen.getByRole("button", { name: "Computers" });
    expect(desktopLink).toHaveAttribute("aria-current", "page");
    await interaction.click(desktopLink);
    expect(onOpenComputers).toHaveBeenCalledOnce();

    await interaction.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    const mobileLink = screen.getAllByRole("button", { name: "Computers" })[1];
    expect(navigation).toContainElement(mobileLink ?? null);
    expect(mobileLink).toHaveAttribute("aria-current", "page");
    await interaction.click(mobileLink as HTMLElement);
    expect(onOpenComputers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });
});
