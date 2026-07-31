import type {
  ConversationExecutionProjectionT,
  PmModelT,
  PmProviderT,
  ProjectRunCancellationProjectionT,
  ProjectRunCancellationRequestT,
  V2ConfirmConversationActionResponseT,
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2ConversationFolderT,
  V2ConversationHandoffT,
  V2ConversationMessageBranchT,
  V2ConversationNavigationPageT,
  V2ConversationPlanActionEffectT,
  V2ConversationPlanReviewT,
  V2ConversationPlanningExcerptReceiptT,
  V2ConversationPmUpdateSettingsT,
  V2ConversationPmUpdateT,
  V2ConversationSummaryT,
  V2ConversationTurnAttemptT,
  V2ConversationUsageT,
  V2CreateExecutionActionProposalInputT,
  V2CreateHumanWaitAnswerProposalInputT,
  V2HumanWaitAnswerT,
  V2HumanWaitContinuationT,
  V2HumanWaitT,
  V2PlanHandoffPreferenceT,
  V2WorkConversationT,
  V2WorkItemOrganizationT,
  V2WorkItemT,
  V2WorkMessagePartT,
  V2WorkMessageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import {
  ConversationExecutionProjection,
  ProjectRunCancellationProjection,
  ProjectRunCancellationRequest,
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
  human_waits?: Array<{
    wait: V2HumanWaitT;
    answer: V2HumanWaitAnswerT | null;
    continuation: V2HumanWaitContinuationT | null;
  }>;
  action_delivery_events?: V2ConversationActionDeliveryEventT[];
  pm_updates?: V2ConversationPmUpdateT[];
  pm_update_settings?: V2ConversationPmUpdateSettingsT | null;
  branch_lineage?: V2ConversationMessageBranchT | null;
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

export function listConversationNavigation(
  projectId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<V2ConversationNavigationPageT> {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 100),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return requestJson(
    `/api/v2/projects/${encodeURIComponent(projectId)}/conversation-navigation?${query}`,
  );
}

export async function createConversationFolder(
  projectId: string,
  name: string,
): Promise<V2ConversationFolderT> {
  const result = await requestJson<{ folder: V2ConversationFolderT }>(
    `/api/v2/projects/${encodeURIComponent(projectId)}/conversation-folders`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  return result.folder;
}

export async function updateConversationFolder(
  projectId: string,
  folderId: string,
  name: string,
): Promise<V2ConversationFolderT> {
  const result = await requestJson<{ folder: V2ConversationFolderT }>(
    `/api/v2/projects/${encodeURIComponent(projectId)}/conversation-folders/${encodeURIComponent(folderId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return result.folder;
}

export function deleteConversationFolder(
  projectId: string,
  folderId: string,
): Promise<{ deleted_folder_id: string; unfiled_work_item_count: number }> {
  return requestJson(
    `/api/v2/projects/${encodeURIComponent(projectId)}/conversation-folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

export async function updateWorkItemOrganization(
  projectId: string,
  workItemId: string,
  input: { folder_id?: string | null; pinned?: boolean },
): Promise<V2WorkItemOrganizationT> {
  const result = await requestJson<{ organization: V2WorkItemOrganizationT }>(
    `/api/v2/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/organization`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return result.organization;
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

export async function getConversationExecution(
  projectId: string,
  conversationId: string,
): Promise<ConversationExecutionProjectionT> {
  return ConversationExecutionProjection.parse(
    await requestJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/execution`,
    ),
  );
}

export async function getProjectRunCancellation(
  projectId: string,
  runId: string,
): Promise<ProjectRunCancellationProjectionT> {
  return ProjectRunCancellationProjection.parse(
    await requestJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancellation`,
    ),
  );
}

export async function cancelProjectRun(
  projectId: string,
  runId: string,
  input: ProjectRunCancellationRequestT,
): Promise<ProjectRunCancellationProjectionT> {
  const body = ProjectRunCancellationRequest.parse(input);
  return ProjectRunCancellationProjection.parse(
    await requestJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  );
}

export function createConversationMessageBranch(
  projectId: string,
  workItemId: string,
  conversationId: string,
  sourceMessageId: string,
): Promise<{
  conversation: V2WorkConversationT;
  branch_lineage: V2ConversationMessageBranchT;
}> {
  return requestJson(
    `/api/v2/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/conversations/${encodeURIComponent(conversationId)}/branches`,
    {
      method: "POST",
      body: JSON.stringify({ source_message_id: sourceMessageId }),
    },
  );
}

export function createPlanningWorkItem(
  projectId: string,
  input: { title: string; objective: string; model?: PmModelT },
): Promise<{
  work_item: V2WorkItemT;
  conversation: V2WorkConversationT;
}> {
  return requestJson(`/api/v2/projects/${projectId}/work-items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getProjectConversationPin(
  projectId: string,
): Promise<{ provider: PmProviderT; model: PmModelT }> {
  const project = await requestJson<{
    pm_provider: PmProviderT;
    pm_model: PmModelT | null;
  }>(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!project.pm_model) {
    throw new Error("This project does not have a conversation model configured.");
  }
  return { provider: project.pm_provider, model: project.pm_model };
}

export async function switchConversationModel(
  projectId: string,
  workItemId: string,
  conversationId: string,
  model: PmModelT,
): Promise<V2WorkConversationT> {
  const result = await requestJson<{ conversation: V2WorkConversationT }>(
    `${messageEndpoint(projectId, workItemId, conversationId)}/model`,
    {
      method: "PATCH",
      body: JSON.stringify({ model }),
    },
  );
  return result.conversation;
}

export async function renamePlanningWorkItem(
  projectId: string,
  workItemId: string,
  title: string,
): Promise<V2WorkItemT> {
  const result = await requestJson<{ work_item: V2WorkItemT }>(
    `/api/v2/projects/${projectId}/work-items/${workItemId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ title }),
    },
  );
  return result.work_item;
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
): Promise<V2ConfirmConversationActionResponseT> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/actions/${encodeURIComponent(actionId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    },
  );
}

export function cancelConversationPlanReview(
  projectId: string,
  workItemId: string,
  conversationId: string,
  reviewId: string,
  reason: string,
): Promise<{ review: V2ConversationPlanReviewT }> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-reviews/${encodeURIComponent(
      reviewId,
    )}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({ reason }),
    },
  );
}

export function continueConversationPlanReviewChat(
  projectId: string,
  workItemId: string,
  conversationId: string,
  reviewId: string,
  channel: "reviewer" | "pm",
  message: string,
): Promise<{ review: V2ConversationPlanReviewT }> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-reviews/${encodeURIComponent(
      reviewId,
    )}/chat`,
    {
      method: "POST",
      body: JSON.stringify({ channel, message }),
    },
  );
}

export function continueConversationWithoutQc(
  projectId: string,
  workItemId: string,
  conversationId: string,
  reviewId: string,
  idempotencyKey: string,
): Promise<V2ConfirmConversationActionResponseT> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-reviews/${encodeURIComponent(
      reviewId,
    )}/continue-without-qc`,
    {
      method: "POST",
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    },
  );
}

export function proposeExecutionConversationAction(
  projectId: string,
  workItemId: string,
  conversationId: string,
  input: V2CreateExecutionActionProposalInputT,
): Promise<{ message: V2WorkMessageT; action: V2ConversationActionT }> {
  return requestJson(`${messageEndpoint(projectId, workItemId, conversationId)}/actions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function proposeHumanWaitAnswer(
  projectId: string,
  workItemId: string,
  conversationId: string,
  waitId: string,
  input: V2CreateHumanWaitAnswerProposalInputT,
): Promise<{ message: V2WorkMessageT; action: V2ConversationActionT }> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/human-waits/${encodeURIComponent(
      waitId,
    )}/answer-proposals`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function updateConversationPmSettings(
  projectId: string,
  input: {
    update_interval_seconds?: number | null;
    content_level?: "concise" | "standard" | "detailed" | null;
  },
): Promise<V2ConversationPmUpdateSettingsT> {
  return requestJson(`/api/v2/projects/${projectId}/conversation-pm-settings`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function generateConversationPlanProposal(
  projectId: string,
  workItemId: string,
  conversationId: string,
  idempotencyKey: string,
  intentMessage?: string,
  handoff?: V2PlanHandoffPreferenceT,
): Promise<{
  message: V2WorkMessageT;
  action: V2ConversationActionT;
}> {
  return requestJson(`${messageEndpoint(projectId, workItemId, conversationId)}/plan-proposals`, {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      ...(intentMessage ? { intent_message: intentMessage } : {}),
      ...(handoff ? { handoff } : {}),
    }),
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
