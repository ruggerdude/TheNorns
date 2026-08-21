import { useEffect, useRef, useState } from "react";
import type { SettingsTab } from "./Account";
import { PortfolioMenu } from "./PortfolioMenu";
import type { ProjectSummary } from "./Projects";
import type { CurrentUser } from "./auth";
import { ThemeToggle, useTheme } from "./theme";
import { Button } from "./ui";

export function HeaderUserMenu({
  user,
  onOpenUsage,
  onOpenAccount,
  onOpenAdmin,
  onSignOut,
  activeView = null,
}: {
  user: CurrentUser;
  onOpenUsage: () => void;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
  activeView?: "usage" | "settings" | "admin" | null;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = user.name ?? user.email;
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!open) return;
    const closeMenu = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", closeMenu);
    window.addEventListener("pointerdown", closeMenu);
    return () => {
      window.removeEventListener("keydown", closeMenu);
      window.removeEventListener("pointerdown", closeMenu);
    };
  }, [open]);

  return (
    <div className="header-user-menu global-settings-menu" ref={menuRef}>
      <button
        type="button"
        className={`global-settings-trigger${activeView ? " is-active" : ""}`}
        aria-label={open ? "Close application settings" : "Open application settings"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z" />
          <path d="M19.2 13.05a7.8 7.8 0 0 0 0-2.1l2.02-1.58-2-3.46-2.52 1.02a8 8 0 0 0-1.82-1.05L14.5 3.2h-4l-.39 2.68A8 8 0 0 0 8.3 6.93L5.78 5.91l-2 3.46 2.02 1.58a7.8 7.8 0 0 0 0 2.1l-2.02 1.58 2 3.46 2.52-1.02c.56.43 1.17.78 1.82 1.05l.39 2.68h4l.39-2.68a8 8 0 0 0 1.82-1.05l2.52 1.02 2-3.46-2.04-1.58Z" />
        </svg>
      </button>
      {open ? (
        <dialog
          className="user-menu-popover global-settings-popover"
          aria-label="Application settings"
          open
        >
          <div className="user-menu-identity">
            <span className="user-avatar" aria-hidden="true">
              {label.slice(0, 1).toUpperCase()}
            </span>
            <span className="user-menu-identity-copy">
              <strong>{label}</strong>
              {user.name ? <span>{user.email}</span> : null}
            </span>
          </div>
          <Button
            variant="ghost"
            aria-current={activeView === "usage" ? "page" : undefined}
            onClick={() => {
              setOpen(false);
              onOpenUsage();
            }}
          >
            Usage
          </Button>
          <Button
            variant="ghost"
            aria-current={activeView === "settings" ? "page" : undefined}
            onClick={() => {
              setOpen(false);
              onOpenAccount();
            }}
          >
            App Settings
          </Button>
          {user.role === "admin" ? (
            <Button
              variant="ghost"
              aria-current={activeView === "admin" ? "page" : undefined}
              onClick={() => {
                setOpen(false);
                onOpenAdmin();
              }}
            >
              Administration
            </Button>
          ) : null}
          <fieldset className="user-menu-appearance">
            <legend>Appearance</legend>
            <div>
              <button
                type="button"
                aria-pressed={theme === "light"}
                onClick={() => setTheme("light")}
              >
                Light
              </button>
              <button
                type="button"
                aria-pressed={theme === "dark"}
                onClick={() => setTheme("dark")}
              >
                Dark
              </button>
            </div>
          </fieldset>
          <Button
            className="user-menu-sign-out"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </dialog>
      ) : null}
    </div>
  );
}

export function AuthenticatedHeaderActions({
  user,
  onOpenUsage,
  onOpenAccount,
  onOpenAdmin,
  onSignOut,
  activeView = null,
  portfolioNavigation,
}: {
  user: CurrentUser;
  onOpenUsage: () => void;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
  activeView?: "usage" | "settings" | "admin" | null;
  portfolioNavigation?: {
    projects?: ProjectSummary[] | null;
    activeProjectId?: string | null;
    onNewProject: () => void;
    onOpenPortfolio: () => void;
    onOpenProject: (project: ProjectSummary) => void;
    onUnauthorized: () => void;
  };
}): React.ReactElement {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const closeMobileNavigation = () => setMobileNavigationOpen(false);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);

  return (
    <div className="header-actions">
      <Button
        className="btn-small global-mobile-menu"
        variant="ghost"
        aria-label="Open navigation menu"
        aria-controls="global-mobile-navigation"
        aria-expanded={mobileNavigationOpen}
        onClick={() => setMobileNavigationOpen((open) => !open)}
      >
        <span aria-hidden="true">☰</span>
        Menu
      </Button>
      <HeaderUserMenu
        user={user}
        activeView={activeView}
        onOpenUsage={onOpenUsage}
        onOpenAccount={onOpenAccount}
        onOpenAdmin={onOpenAdmin}
        onSignOut={onSignOut}
      />
      {mobileNavigationOpen ? (
        <button
          type="button"
          className="global-mobile-backdrop"
          aria-label="Close navigation menu"
          onClick={closeMobileNavigation}
        />
      ) : null}
      {mobileNavigationOpen ? (
        <nav
          id="global-mobile-navigation"
          className="global-mobile-navigation is-open"
          aria-label="Main navigation"
        >
          <div className="global-mobile-navigation-head">
            <div>
              <span>Navigation</span>
              <strong>The Norns</strong>
            </div>
            <Button
              className="btn-small"
              variant="ghost"
              aria-label="Close navigation menu"
              onClick={closeMobileNavigation}
            >
              ×
            </Button>
          </div>
          {portfolioNavigation ? (
            <PortfolioMenu
              projects={portfolioNavigation.projects}
              activeProjectId={portfolioNavigation.activeProjectId}
              onNewProject={() => {
                closeMobileNavigation();
                portfolioNavigation.onNewProject();
              }}
              onOpenPortfolio={() => {
                closeMobileNavigation();
                portfolioNavigation.onOpenPortfolio();
              }}
              onOpenProject={(project) => {
                closeMobileNavigation();
                portfolioNavigation.onOpenProject(project);
              }}
              onUnauthorized={portfolioNavigation.onUnauthorized}
            />
          ) : null}
          <Button
            className={activeView === "usage" ? "is-active" : ""}
            variant="ghost"
            aria-current={activeView === "usage" ? "page" : undefined}
            onClick={() => {
              closeMobileNavigation();
              onOpenUsage();
            }}
          >
            Usage
          </Button>
          <Button
            className={activeView === "settings" ? "is-active" : ""}
            variant="ghost"
            aria-current={activeView === "settings" ? "page" : undefined}
            onClick={() => {
              closeMobileNavigation();
              onOpenAccount();
            }}
          >
            App Settings
          </Button>
          {user.role === "admin" ? (
            <Button
              className={activeView === "admin" ? "is-active" : ""}
              variant="ghost"
              aria-current={activeView === "admin" ? "page" : undefined}
              onClick={() => {
                closeMobileNavigation();
                onOpenAdmin();
              }}
            >
              Admin
            </Button>
          ) : null}
          <div className="global-mobile-navigation-account">
            <span className="user-avatar" aria-hidden="true">
              {(user.name ?? user.email).slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{user.name ?? user.email}</strong>
              {user.name ? <small>{user.email}</small> : null}
            </span>
          </div>
          <div className="global-mobile-navigation-theme">
            <span>Appearance</span>
            <ThemeToggle />
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              closeMobileNavigation();
              onOpenAccount("profile");
            }}
          >
            Profile
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              closeMobileNavigation();
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
