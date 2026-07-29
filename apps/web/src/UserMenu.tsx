import { useEffect, useState } from "react";
import type { SettingsTab } from "./Account";
import type { CurrentUser } from "./auth";
import { ThemeToggle } from "./theme";
import { Button } from "./ui";

export function HeaderUserMenu({
  user,
  onOpenAccount,
  onSignOut,
}: {
  user: CurrentUser;
  onOpenAccount: (tab?: SettingsTab) => void;
  onSignOut: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const label = user.name ?? user.email;

  return (
    <div className="header-user-menu">
      <button
        type="button"
        className="user-chip user-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="user-avatar" aria-hidden="true">
          {label.slice(0, 1).toUpperCase()}
        </span>
        <span>{label}</span>
        <span className="user-menu-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="user-menu-popover" role="menu">
          <div className="user-menu-identity">
            <strong>{label}</strong>
            {user.name ? <span>{user.email}</span> : null}
          </div>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenAccount("profile");
            }}
          >
            User settings
          </Button>
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
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
}: {
  user: CurrentUser;
  onOpenUsage: () => void;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
  activeView?: "usage" | "settings" | "admin" | null;
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
      <Button
        className={`btn-small${activeView === "usage" ? " is-active" : ""}`}
        variant="ghost"
        aria-current={activeView === "usage" ? "page" : undefined}
        onClick={onOpenUsage}
      >
        Usage
      </Button>
      <Button
        className={`btn-small${activeView === "settings" ? " is-active" : ""}`}
        variant="ghost"
        aria-current={activeView === "settings" ? "page" : undefined}
        onClick={() => onOpenAccount()}
      >
        Settings
      </Button>
      {user.role === "admin" ? (
        <Button
          className={`btn-small${activeView === "admin" ? " is-active" : ""}`}
          variant="ghost"
          aria-current={activeView === "admin" ? "page" : undefined}
          onClick={onOpenAdmin}
        >
          Admin
        </Button>
      ) : null}
      <ThemeToggle />
      <HeaderUserMenu user={user} onOpenAccount={onOpenAccount} onSignOut={onSignOut} />
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
            Settings
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
