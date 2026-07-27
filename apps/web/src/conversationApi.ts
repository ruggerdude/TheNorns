import type {
  V2ConfirmConversationPlanActionResponseT,
  V2ConversationActionT,
  V2ConversationHandoffT,
  V2ConversationPlanActionEffectT,
  V2ConversationPlanReviewT,
  V2ConversationPlanningExcerptReceiptT,
  V2ConversationSummaryT,
  V2ConversationTurnAttemptT,
  V2ConversationUsageT,
  V2WorkConversationT,
  V2WorkItemT,
  V2WorkMessagePartT,
  V2WorkMessageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";

export type ConversationUsageSummary = V2ConversationUsageT;

export interface WorkItemConversationGroup {
  work_item: V2WorkItemT;
  conversations: V2WorkConversationT[];
  conversation_usage?: Record<string, ConversationUsageSummary>;
}

export interface ConversationDetail {
  work_item: V2WorkItemT;
  conversation: V2WorkConversationT;
  messages: V2WorkMessageT[];
  active_attempt: V2ConversationTurnAttemptT | null;
  retryable_attempt: V2ConversationTurnAttemptT | null;
  plan_versions: V2WorkPlanVersionT[];
  actions: V2ConversationActionT[];
  plan_reviews: V2ConversationPlanReviewT[];
  action_effects: V2ConversationPlanActionEffectT[];
  handoff?: V2ConversationHandoffT | null;
  latest_summary?: V2ConversationSummaryT | null;
  usage?: ConversationUsageSummary | null;
  planning_excerpt_receipts?: V2ConversationPlanningExcerptReceiptT[];
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
      payload.error ?? null,
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

export function confirmConversationAction(
  projectId: string,
  workItemId: string,
  conversationId: string,
  actionId: string,
  idempotencyKey: string,
): Promise<V2ConfirmConversationPlanActionResponseT> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/actions/${encodeURIComponent(actionId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    },
  );
}

export function generateConversationPlanProposal(
  projectId: string,
  workItemId: string,
  conversationId: string,
  idempotencyKey: string,
): Promise<{
  message: V2WorkMessageT;
  action: V2ConversationActionT;
}> {
  return requestJson(`${messageEndpoint(projectId, workItemId, conversationId)}/plan-proposals`, {
    method: "POST",
    body: JSON.stringify({ idempotency_key: idempotencyKey }),
  });
}

export function generateConversationPlanChangeProposal(
  projectId: string,
  workItemId: string,
  conversationId: string,
  input: {
    idempotency_key: string;
    plan_version_id: string;
    plan_hash: string;
    direction: string;
  },
): Promise<{
  message: V2WorkMessageT;
  action: V2ConversationActionT;
}> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-change-proposals`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function retrieveConversationPlanningExcerpt(
  projectId: string,
  workItemId: string,
  conversationId: string,
  input: {
    idempotency_key: string;
    source_conversation_id: string;
    message_ids: string[];
  },
): Promise<{
  message: V2WorkMessageT;
  receipt: V2ConversationPlanningExcerptReceiptT;
}> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/planning-excerpts`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export interface SubmitConversationMessageBody {
  client_message_id: string;
  parts: V2WorkMessagePartT[];
}
