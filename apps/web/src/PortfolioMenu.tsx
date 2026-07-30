import { useEffect, useId, useState } from "react";
import type { ProjectSummary } from "./Projects";
import { UnauthorizedError, authHeaders } from "./auth";

export function PortfolioMenu({
  projects,
  activeProjectId = null,
  onNewProject,
  onOpenPortfolio,
  onOpenProject,
  onUnauthorized,
}: {
  projects?: ProjectSummary[] | null;
  activeProjectId?: string | null;
  onNewProject: () => void;
  onOpenPortfolio: () => void;
  onOpenProject: (project: ProjectSummary) => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const projectListId = useId();
  const [projectListOpen, setProjectListOpen] = useState(false);
  const [loadedProjects, setLoadedProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const visibleProjects = projects === undefined ? loadedProjects : projects;

  useEffect(() => {
    if (projects !== undefined) return;
    let current = true;
    void fetch("/api/projects", { credentials: "include", headers: authHeaders() })
      .then(async (response) => {
        if (response.status === 401) throw new UnauthorizedError();
        const body = (await response.json().catch(() => [])) as ProjectSummary[];
        if (!response.ok) throw new Error(`Projects could not be loaded (${response.status}).`);
        if (current) setLoadedProjects(body);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        if (caught instanceof UnauthorizedError) onUnauthorized();
        else setLoadError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [onUnauthorized, projects]);

  const choose = (action: () => void) => {
    setProjectListOpen(false);
    action();
  };

  return (
    <nav className="portfolio-navigation" aria-label="Portfolio navigation">
      <button type="button" className="portfolio-new-project" onClick={() => choose(onNewProject)}>
        <span aria-hidden="true">+</span>
        <span>New project</span>
      </button>
      <div className={`portfolio-switcher${projectListOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="portfolio-overview-link"
          onClick={() => choose(onOpenPortfolio)}
        >
          Portfolio
        </button>
        <button
          type="button"
          className="portfolio-project-toggle"
          aria-label={`${projectListOpen ? "Hide" : "Show"} active projects`}
          aria-expanded={projectListOpen}
          aria-controls={projectListId}
          onClick={() => setProjectListOpen((open) => !open)}
        >
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {projectListOpen ? (
        <div className="portfolio-switcher-panel" id={projectListId}>
          <div className="portfolio-project-menu-label">Active projects</div>
          {visibleProjects === null ? (
            <span className="portfolio-project-menu-state">Loading…</span>
          ) : visibleProjects.length === 0 ? (
            <span className="portfolio-project-menu-state">No active projects</span>
          ) : (
            <div className="portfolio-project-menu-list">
              {visibleProjects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  className={project.id === activeProjectId ? "is-active" : ""}
                  aria-current={project.id === activeProjectId ? "page" : undefined}
                  onClick={() => choose(() => onOpenProject(project))}
                >
                  <span className="portfolio-project-menu-mark" aria-hidden="true">
                    {project.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>{project.name}</span>
                </button>
              ))}
            </div>
          )}
          {loadError ? (
            <span className="portfolio-project-menu-state is-error">{loadError}</span>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
