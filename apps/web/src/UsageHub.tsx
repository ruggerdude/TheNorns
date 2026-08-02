import { useState } from "react";
import { UsageAnalytics } from "./UsageAnalytics";
import { UsageIntelligence, type UsageScope } from "./UsageIntelligence";
import type { CurrentUser } from "./auth";
import { Brand, Button, PageHeader } from "./ui";
import "./UsageHub.css";

type UsageView = "project" | "personal" | "global" | "analytics";

export function UsageHub({
  user,
  project,
  onClose,
  onUnauthorized,
  embedded = false,
}: {
  user: CurrentUser;
  project?: { id: string; name: string };
  onClose: () => void;
  onUnauthorized: () => void;
  embedded?: boolean;
}): React.ReactElement {
  const [view, setView] = useState<UsageView>(project ? "project" : "personal");
  const scope: UsageScope =
    view === "project" && project
      ? { kind: "project", id: project.id }
      : view === "global"
        ? { kind: "global" }
        : { kind: "user", id: user.id };

  return (
    <div className={embedded ? "embedded-page-view" : "full-page-view"} data-testid="usage-panel">
      {/* Scope tabs remain local to Usage while the application shell owns
          global navigation. Standalone renders retain their close header. */}
      {!embedded ? (
        <header className="full-page-header">
          <div className="full-page-header-title">
            <Brand />
            <span>Usage</span>
          </div>
          <Button className="btn-small" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
      ) : null}
      <main className="page-container usage-hub-body">
        <PageHeader
          eyebrow="Workspace reporting"
          title="Usage"
          lede="Understand model activity, cost, reliability, and optimization opportunities."
        />
        <nav aria-label="Usage scope" className="page-subnav">
          {project ? (
            <button
              type="button"
              aria-current={view === "project" ? "page" : undefined}
              className={view === "project" ? "is-active" : ""}
              onClick={() => setView("project")}
            >
              {project.name}
            </button>
          ) : null}
          <button
            type="button"
            aria-current={view === "personal" ? "page" : undefined}
            className={view === "personal" ? "is-active" : ""}
            onClick={() => setView("personal")}
          >
            My usage
          </button>
          {user.role === "admin" ? (
            <>
              <button
                type="button"
                aria-current={view === "global" ? "page" : undefined}
                className={view === "global" ? "is-active" : ""}
                onClick={() => setView("global")}
              >
                All usage
              </button>
              <button
                type="button"
                aria-current={view === "analytics" ? "page" : undefined}
                className={view === "analytics" ? "is-active" : ""}
                onClick={() => setView("analytics")}
              >
                Analytics
              </button>
            </>
          ) : null}
        </nav>
        {view === "analytics" ? (
          <UsageAnalytics key="analytics" onUnauthorized={onUnauthorized} />
        ) : (
          <UsageIntelligence
            key={`${scope.kind}-${"id" in scope ? scope.id : "all"}`}
            scope={scope}
            onUnauthorized={onUnauthorized}
          />
        )}
      </main>
    </div>
  );
}
