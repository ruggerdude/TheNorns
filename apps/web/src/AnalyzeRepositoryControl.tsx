// POLISH P3: the web trigger for POST /api/v2/projects/:id/analyze-repository.
// The resume payload has recommended "Analyze the repository and record its
// architecture" since Phase 3, and until now no button anywhere could perform
// it (the ingest route had zero web callers). Modeled on StartPhaseControl:
// one button, an honest in-progress state, and on failure the SERVER'S error
// message — never a generic one. Success is not announced separately: the
// caller reloads the resume payload, whose `architecture` block then renders
// the recorded title/summary.
import { useCallback, useState } from "react";
import { UnauthorizedError, authHeaders } from "./auth";
import { Alert, Button } from "./ui";

export interface AnalyzeRepositoryResultDto {
  architecture_revision_id: string;
  architecture_revision: number;
  replayed: boolean;
  title: string;
  summary: string;
  repository_revision: string;
  model: { provider: string; model: string };
}

export function AnalyzeRepositoryControl({
  projectId,
  onAnalyzed,
  onUnauthorized,
}: {
  projectId: string;
  onAnalyzed?: (result: AnalyzeRepositoryResultDto) => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/v2/projects/${projectId}/analyze-repository`, {
        method: "POST",
        // No body → no content-type. `authHeaders(true)` sets
        // `content-type: application/json`, and Fastify rejects that header on
        // an EMPTY body ("Body cannot be empty when content-type is set to
        // 'application/json'") before the route handler runs — a defect the
        // product owner hit in production. Same convention as the other
        // body-less POST in App.tsx (workflow trigger at ~1224).
        headers: authHeaders(),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      const json = (await res.json()) as AnalyzeRepositoryResultDto & {
        error?: string;
        message?: string;
        detail?: string;
      };
      if (!res.ok) {
        setError(json.message ?? json.detail ?? json.error ?? `request failed: ${res.status}`);
        return;
      }
      onAnalyzed?.(json);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [projectId, onAnalyzed, onUnauthorized]);

  return (
    <>
      <Button
        className="btn-small"
        variant="primary"
        disabled={running}
        data-testid="analyze-repository-button"
        onClick={() => void analyze()}
      >
        {running ? "Analyzing repository…" : "Analyze repository"}
      </Button>
      {error ? <Alert testId="analyze-repository-error">{error}</Alert> : null}
    </>
  );
}
