import type {
  V2ConversationTurnAttemptT,
  V2WorkConversationT,
  V2WorkItemT,
  V2WorkMessagePartT,
  V2WorkMessageT,
} from "@norns/contracts";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

export interface WorkItemConversationGroup {
  work_item: V2WorkItemT;
  conversations: V2WorkConversationT[];
}

export interface ConversationDetail {
  work_item: V2WorkItemT;
  conversation: V2WorkConversationT;
  messages: V2WorkMessageT[];
  active_attempt: V2ConversationTurnAttemptT | null;
  retryable_attempt: V2ConversationTurnAttemptT | null;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...authHeaders(init.body !== undefined),
      ...init.headers,
    },
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      payload.message ?? payload.error ?? `request failed: ${response.status}`,
      response.status,
    );
  }
  return payload;
}

export async function listWorkItemConversations(
  projectId: string,
): Promise<WorkItemConversationGroup[]> {
  const result = await requestJson<{ work_items: WorkItemConversationGroup[] }>(
    `/api/v2/projects/${projectId}/work-items`,
  );
  return result.work_items;
}

export function getConversation(
  projectId: string,
  workItemId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  return requestJson(
    `/api/v2/projects/${projectId}/work-items/${workItemId}/conversations/${conversationId}`,
  );
}

export function resolveConversation(
  projectId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  return requestJson(`/api/v2/projects/${projectId}/conversations/${conversationId}`);
}

export function createPlanningWorkItem(
  projectId: string,
  input: { title: string; objective: string },
): Promise<{
  work_item: V2WorkItemT;
  conversation: V2WorkConversationT;
}> {
  return requestJson(`/api/v2/projects/${projectId}/work-items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function messageEndpoint(
  projectId: string,
  workItemId: string,
  conversationId: string,
): string {
  return `/api/v2/projects/${projectId}/work-items/${workItemId}/conversations/${conversationId}`;
}

export interface SubmitConversationMessageBody {
  client_message_id: string;
  parts: V2WorkMessagePartT[];
}
