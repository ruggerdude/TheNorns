import { useEffect, useState } from "react";
import { UnauthorizedError, authHeaders } from "./auth";

export function artifactContentPath(projectId: string, artifactId: string): string {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(
    artifactId,
  )}/content`;
}

export async function openAuthenticatedArtifact(
  projectId: string,
  artifactId: string,
  onUnauthorized?: () => void,
): Promise<void> {
  const opened = window.open("about:blank", "_blank");
  try {
    const response = await fetch(artifactContentPath(projectId, artifactId), {
      credentials: "include",
      headers: authHeaders(),
    });
    if (response.status === 401) {
      onUnauthorized?.();
      throw new UnauthorizedError();
    }
    if (!response.ok) throw new Error(`artifact unavailable: ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    if (!opened) throw new Error("The browser blocked the artifact tab.");
    opened.opener = null;
    opened.location.href = objectUrl;
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    opened?.close();
    throw error;
  }
}

export function ArtifactImage({
  projectId,
  artifactId,
  alt,
  className,
  onUnauthorized,
}: {
  projectId: string;
  artifactId: string;
  alt: string;
  className?: string;
  onUnauthorized?: () => void;
}): React.ReactElement {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const path = artifactContentPath(projectId, artifactId);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setSource(null);
    setFailed(false);

    void fetch(path, {
      credentials: "include",
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) throw new UnauthorizedError();
        if (!response.ok) throw new Error(`artifact image unavailable: ${response.status}`);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof UnauthorizedError) onUnauthorized?.();
        setFailed(true);
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [onUnauthorized, path]);

  if (failed) {
    return (
      <span className="artifact-image-fallback">
        <button
          type="button"
          onClick={() => {
            setOpenError(null);
            void openAuthenticatedArtifact(projectId, artifactId, onUnauthorized).catch(
              (error: unknown) =>
                setOpenError(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          Open {alt}
        </button>
        {openError ? <span role="alert">{openError}</span> : null}
      </span>
    );
  }
  if (!source) {
    return <output className="artifact-image-loading">Loading {alt}…</output>;
  }
  return <img className={className} src={source} alt={alt} />;
}
