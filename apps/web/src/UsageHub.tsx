import { useState } from "react";
import { UsageAnalytics } from "./UsageAnalytics";
import { UsageIntelligence, type UsageScope } from "./UsageIntelligence";
import type { CurrentUser } from "./auth";
import { Brand, Button } from "./ui";
import "./UsageHub.css";

type UsageView = "project" | "personal" | "global" | "analytics";

export function UsageHub({
  user,
  project,
  onClose,
  onUnauthorized,
}: {
  user: CurrentUser;
  project?: { id: string; name: string };
  onClose: () => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [view, setView] = useState<UsageView>(project ? "project" : "personal");
  const scope: UsageScope =
    view === "project" && project
      ? { kind: "project", id: project.id }
      : view === "global"
        ? { kind: "global" }
        : { kind: "user", id: user.id };

  return (
    <div className="usage-hub">
      <header className="usage-hub-header">
        <Brand />
        <nav aria-label="Usage scope" className="usage-hub-scopes">
          {project ? (
            <button
              type="button"
              aria-current={view === "project" ? "page" : undefined}
              className={view === "project" ? "on" : ""}
              onClick={() => setView("project")}
            >
              {project.name}
            </button>
          ) : null}
          <button
            type="button"
            aria-current={view === "personal" ? "page" : undefined}
            className={view === "personal" ? "on" : ""}
            onClick={() => setView("personal")}
          >
            My usage
          </button>
          {user.role === "admin" ? (
            <>
              <button
                type="button"
                aria-current={view === "global" ? "page" : undefined}
                className={view === "global" ? "on" : ""}
                onClick={() => setView("global")}
              >
                All usage
              </button>
              <button
                type="button"
                aria-current={view === "analytics" ? "page" : undefined}
                className={view === "analytics" ? "on" : ""}
                onClick={() => setView("analytics")}
              >
                Analytics
              </button>
            </>
          ) : null}
        </nav>
        <Button className="btn-small" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>
      {view === "analytics" ? (
        <UsageAnalytics key="analytics" onUnauthorized={onUnauthorized} />
      ) : (
        <UsageIntelligence
          key={`${scope.kind}-${"id" in scope ? scope.id : "all"}`}
          scope={scope}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}
