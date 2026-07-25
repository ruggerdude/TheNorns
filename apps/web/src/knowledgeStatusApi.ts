import type {
  V2CompletionGateT,
  V2KnowledgePackageT,
  V2KnowledgePackageVersionT,
  V2PhaseKnowledgeStatusT,
} from "@norns/contracts";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

export interface KnowledgePackageHistory {
  package: V2KnowledgePackageT;
  versions: V2KnowledgePackageVersionT[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders(false) });
  if (response.status === 401) throw new UnauthorizedError();
  const body = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    throw new ApiError(body.message ?? `request failed: ${response.status}`, response.status);
  }
  return body;
}

export function getPhaseKnowledgeStatus(
  projectId: string,
  phaseId: string,
): Promise<V2PhaseKnowledgeStatusT> {
  return getJson(`/api/v2/projects/${projectId}/phases/${phaseId}/knowledge/status`);
}

export function getPhaseCompletionGate(
  projectId: string,
  phaseId: string,
): Promise<V2CompletionGateT> {
  return getJson(`/api/v2/projects/${projectId}/phases/${phaseId}/knowledge/completion`);
}

export function getProjectKnowledgePackages(projectId: string): Promise<KnowledgePackageHistory[]> {
  return getJson(`/api/v2/projects/${projectId}/knowledge/packages`);
}
