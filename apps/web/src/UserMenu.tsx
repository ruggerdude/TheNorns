import { useState } from "react";
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
}: {
  user: CurrentUser;
  onOpenUsage: () => void;
  onOpenAccount: (tab?: SettingsTab) => void;
  onOpenAdmin: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  return (
    <div className="header-actions">
      <Button className="btn-small" variant="ghost" onClick={onOpenUsage}>
        Usage
      </Button>
      <Button className="btn-small" variant="ghost" onClick={() => onOpenAccount()}>
        Settings
      </Button>
      {user.role === "admin" ? (
        <Button className="btn-small" variant="ghost" onClick={onOpenAdmin}>
          Admin
        </Button>
      ) : null}
      <ThemeToggle />
      <HeaderUserMenu user={user} onOpenAccount={onOpenAccount} onSignOut={onSignOut} />
    </div>
  );
}
