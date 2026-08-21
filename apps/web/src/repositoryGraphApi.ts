import type { RepositoryGraphT } from "@norns/contracts";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...authHeaders(init.body !== undefined),
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json()) as T & { message?: string; detail?: string };
  if (!response.ok) {
    throw new ApiError(
      body.message ?? body.detail ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return body;
}

function root(projectId: string): string {
  return `/api/v2/projects/${encodeURIComponent(projectId)}/repository-graph`;
}

export function loadRepositoryGraph(projectId: string): Promise<RepositoryGraphT> {
  return requestJson(root(projectId));
}

export function queryRepositoryGraph(projectId: string, query: string): Promise<RepositoryGraphT> {
  return requestJson(`${root(projectId)}/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

export function startRepositoryGraphBuild(projectId: string): Promise<{ request_id: string }> {
  return requestJson(`${root(projectId)}/index`, { method: "POST", body: JSON.stringify({}) });
}

export async function pollRepositoryGraphBuild(
  projectId: string,
  requestId: string,
): Promise<{ pending: true } | { pending: false; graph: RepositoryGraphT }> {
  const response = await fetch(`${root(projectId)}/index/${encodeURIComponent(requestId)}`, {
    headers: authHeaders(false),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json()) as RepositoryGraphT & {
    status?: string;
    message?: string;
    detail?: string;
  };
  if (response.status === 202) return { pending: true };
  if (!response.ok) {
    throw new ApiError(
      body.message ?? body.detail ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return { pending: false, graph: body };
}
