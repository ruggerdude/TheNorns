import type { CurrentUser } from "./auth";
import { Badge, Button } from "./ui";

export function Account({
  user,
  onClose,
  onSignOut,
}: {
  user: CurrentUser;
  onClose: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-backdrop" aria-label="Dismiss" onClick={onClose} />
      <div className="modal card" data-testid="account-panel">
        <div className="section-head">
          <h2>Account</h2>
          <Button variant="ghost" className="btn-small" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="form-stack">
          <div>
            <div className="field-label">Email</div>
            <p className="mono">{user.email}</p>
          </div>
          {user.name ? (
            <div>
              <div className="field-label">Name</div>
              <p>{user.name}</p>
            </div>
          ) : null}
          <div>
            <div className="field-label">Role</div>
            <Badge tone={user.role === "admin" ? "info" : "default"}>{user.role}</Badge>
          </div>
          <Button variant="danger" className="btn-block" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
