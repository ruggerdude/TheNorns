import type {
  ConversationExecutionProjectionT,
  PmModelT,
  PmProviderT,
  PonytailModeT,
  ProjectPonytailModeT,
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
  V2PhaseExecutionT,
  V2PlanHandoffPreferenceT,
  V2QcModeT,
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
import { jsonSchema, parseJsonEventStream } from "ai";
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
  project_runs_qc: boolean;
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

export function archivePlanningWorkItem(
  projectId: string,
  workItemId: string,
): Promise<{ archived_work_item_id: string; archived_conversation_count: number }> {
  return requestJson(
    `/api/v2/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}`,
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

/**
 * The execution conversation's live, task-level view. This is the same
 * durable phase projection used by the project execution screen, exposed
 * here so Development can present the agents and their progress in-context.
 */
export function getConversationPhaseExecution(
  projectId: string,
  phaseId: string,
): Promise<V2PhaseExecutionT> {
  return requestJson(
    `/api/v2/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}/execution`,
  );
}

export interface DevelopmentTaskRetryResult {
  action: "retry";
  replayed: boolean;
  started: boolean;
  phase_id: string;
  task_id: string;
  prior_run_id: string;
  run_id: string | null;
  attempt: number | null;
  dispatch_job_id: string | null;
  detail: string;
}

export interface DevelopmentTaskCancelResult {
  action: "cancel";
  replayed: boolean;
  phase_id: string;
  task_id: string;
  prior_run_id: string;
  phase_status: "cancelled";
}

export function recoverDevelopmentTask(
  projectId: string,
  phaseId: string,
  taskId: string,
  body:
    | {
        action: "retry";
        failed_run_id: string;
        expected_task_version: number;
        idempotency_key: string;
        adjustment?: {
          budget_limit_usd?: number;
          provider?: string;
          model?: string;
        };
      }
    | {
        action: "cancel";
        failed_run_id: string;
        expected_task_version: number;
        idempotency_key: string;
        reason: string;
      },
): Promise<DevelopmentTaskRetryResult | DevelopmentTaskCancelResult> {
  return requestJson(
    `/api/v2/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}/tasks/${encodeURIComponent(taskId)}/recovery`,
    { method: "POST", body: JSON.stringify(body) },
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

export async function cancelAllProjectRuns(
  projectId: string,
  input: ProjectRunCancellationRequestT,
): Promise<{
  cancellations: ProjectRunCancellationProjectionT[];
  failed_run_ids: string[];
}> {
  const body = ProjectRunCancellationRequest.parse(input);
  const result = await requestJson<{
    cancellations: unknown[];
    failed_run_ids: string[];
  }>(`/api/projects/${encodeURIComponent(projectId)}/runs/cancel-all`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    cancellations: result.cancellations.map((item) => ProjectRunCancellationProjection.parse(item)),
    failed_run_ids: result.failed_run_ids,
  };
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
  input: {
    title: string;
    objective: string;
    model?: PmModelT;
    workflow: "phased" | "quick";
  },
): Promise<{
  work_item: V2WorkItemT;
  conversation: V2WorkConversationT;
}> {
  return requestJson(`/api/v2/projects/${projectId}/work-items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getProjectConversationPin(projectId: string): Promise<{
  provider: PmProviderT;
  model: PmModelT;
  project: {
    name: string | null;
    workspaceLocation: string | null;
    remoteLocation: string | null;
  };
}> {
  const project = await requestJson<{
    pm_provider: PmProviderT;
    pm_model: PmModelT | null;
    name?: string | null;
    workspace_location?: string | null;
    remote_location?: string | null;
  }>(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!project.pm_model) {
    throw new Error("This project does not have a conversation model configured.");
  }
  return {
    provider: project.pm_provider,
    model: project.pm_model,
    project: {
      name: project.name ?? null,
      workspaceLocation: project.workspace_location ?? null,
      remoteLocation: project.remote_location ?? null,
    },
  };
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
  qcMode?: QcModeT,
): Promise<V2ConfirmConversationActionResponseT> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/actions/${encodeURIComponent(actionId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        ...(qcMode ? { qc_mode: qcMode } : {}),
      }),
    },
  );
}

export interface ConversationDevelopmentStart {
  status: "held" | "pending" | "leased" | "succeeded" | "refused" | "failed";
  execution_started: boolean | null;
  execution_detail: string | null;
  planning_run_id: string;
  ponytail_mode: PonytailModeT;
}

export function startConversationDevelopment(
  projectId: string,
  workItemId: string,
  conversationId: string,
  ponytailMode?: ProjectPonytailModeT,
): Promise<ConversationDevelopmentStart> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/start-development`,
    {
      method: "POST",
      ...(ponytailMode ? { body: JSON.stringify({ ponytail_mode: ponytailMode }) } : {}),
    },
  );
}

export function configureConversationDevelopmentPausePoints(
  projectId: string,
  workItemId: string,
  conversationId: string,
  taskIds: string[],
  pauseAfterCompletion: boolean,
): Promise<{
  phase_id: string;
  pause_points: {
    task_id: string;
    phase_position: number;
    pause_after_completion: boolean;
  }[];
}> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/development-pause-points`,
    {
      method: "PUT",
      body: JSON.stringify({
        task_ids: taskIds,
        pause_after_completion: pauseAfterCompletion,
      }),
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

export function resumeConversationPlanReview(
  projectId: string,
  workItemId: string,
  conversationId: string,
  reviewId: string,
  input: {
    exit: "continue" | "note";
    note?: { channel: "reviewer" | "pm"; message: string };
    findingDecisions?: Record<string, "accept" | "reject">;
    idempotency_key?: string;
    /** Compound exit "Continue, and stop asking" — sets qc_mode=automatic
     *  for the rest of this run and continues. */
    stopAsking?: boolean;
  },
): Promise<{ review: V2ConversationPlanReviewT }> {
  const { stopAsking, findingDecisions, ...rest } = input;
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-reviews/${encodeURIComponent(
      reviewId,
    )}/resume`,
    {
      method: "POST",
      body: JSON.stringify({
        ...rest,
        ...(findingDecisions ? { finding_decisions: findingDecisions } : {}),
        ...(stopAsking !== undefined ? { stop_asking: stopAsking } : {}),
      }),
    },
  );
}

export type QcModeT = V2QcModeT;

export interface PlanningReviewerSettings {
  provider: PmProviderT;
  model: string | null;
  mode: "explicit" | "automatic";
  qc_mode: QcModeT;
  allow_unadjudicated_rebuttals: boolean;
  /** Zero means review is off for this project. This — not whether a given
   *  conversation already has reviews — is what decides whether QC surfaces
   *  are shown at all. */
  default_max_rounds: number;
  ponytail_mode: ProjectPonytailModeT;
  effective_ponytail_mode: PonytailModeT;
}

/** The project-layer QC defaults (QC-PAUSE-POINTS.md "Settings: three
 *  layers") — read at kickoff to pre-fill the send-to-QC control. */
export function fetchPlanningReviewerSettings(
  projectId: string,
): Promise<PlanningReviewerSettings> {
  return requestJson(`/api/v2/projects/${encodeURIComponent(projectId)}/planning-reviewer`);
}

/** Gate C ruling (QC-PAUSE-POINTS.md "Outcomes") — one ruling per finding,
 *  batched in a single submit. `raiseMaxRounds` answers the
 *  `round_cap_requires_raise` error rather than being sent speculatively. */
export function adjudicateConversationPlanReview(
  projectId: string,
  workItemId: string,
  conversationId: string,
  reviewId: string,
  input: {
    rulings: Record<string, { ruling: "reviewer" | "pm" | "supplied_fact"; rationale: string }>;
    note?: { channel: "reviewer" | "pm"; message: string };
    raiseMaxRounds?: boolean;
    idempotencyKey?: string;
  },
): Promise<{ review: V2ConversationPlanReviewT }> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-reviews/${encodeURIComponent(
      reviewId,
    )}/adjudicate`,
    {
      method: "POST",
      body: JSON.stringify({
        rulings: input.rulings,
        ...(input.note ? { note: input.note } : {}),
        ...(input.raiseMaxRounds !== undefined ? { raise_max_rounds: input.raiseMaxRounds } : {}),
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      }),
    },
  );
}

/** Mid-flight cadence edit (QC-PAUSE-POINTS.md "Mutability mid-flight") —
 *  qc_mode freely, max_rounds raise-only. Reviewer identity has no field. */
export function patchConversationPlanReview(
  projectId: string,
  workItemId: string,
  conversationId: string,
  reviewId: string,
  input: {
    qcMode?: QcModeT;
    maxRounds?: number;
  },
): Promise<{ review: V2ConversationPlanReviewT }> {
  return requestJson(
    `${messageEndpoint(projectId, workItemId, conversationId)}/plan-reviews/${encodeURIComponent(
      reviewId,
    )}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        ...(input.qcMode ? { qc_mode: input.qcMode } : {}),
        ...(input.maxRounds !== undefined ? { max_rounds: input.maxRounds } : {}),
      }),
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

export interface PlanProposalProgress {
  stage: "generating" | "validating" | "saving";
  modules: string[];
  output_tokens_estimate?: number;
}

type PlanProposalResult = { message: V2WorkMessageT; action: V2ConversationActionT };

type PlanStreamChunk =
  | { type: "data-plan-progress"; data: PlanProposalProgress }
  | { type: "data-plan-proposal"; data: PlanProposalResult }
  | { type: "data-plan-error"; data: { error: string; message: string } }
  | { type: "start" | "finish" };

/** Streaming twin of `generateConversationPlanProposal`. Same request body and
 *  same `data-plan-proposal` payload; the only difference is that module titles
 *  reach `onProgress` while the model is still generating. Any transport failure
 *  before a proposal arrives falls back to the non-streaming route with the same
 *  idempotency key, so streaming is never less reliable than the JSON call. */
export async function streamConversationPlanProposal(
  projectId: string,
  workItemId: string,
  conversationId: string,
  idempotencyKey: string,
  onProgress: (progress: PlanProposalProgress) => void,
  intentMessage?: string,
  handoff?: V2PlanHandoffPreferenceT,
): Promise<PlanProposalResult> {
  try {
    const response = await fetch(
      `${messageEndpoint(projectId, workItemId, conversationId)}/plan-proposals/stream`,
      {
        method: "POST",
        credentials: "include",
        headers: authHeaders(true),
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          ...(intentMessage ? { intent_message: intentMessage } : {}),
          ...(handoff ? { handoff } : {}),
        }),
      },
    );
    if (response.status === 401) throw new UnauthorizedError();
    if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`);
    const reader = parseJsonEventStream({
      stream: response.body,
      schema: jsonSchema<PlanStreamChunk>({}),
    }).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.success) continue;
      const chunk = value.value;
      if (chunk.type === "data-plan-progress") onProgress(chunk.data);
      if (chunk.type === "data-plan-proposal") {
        void reader.cancel();
        return chunk.data;
      }
      if (chunk.type === "data-plan-error") {
        void reader.cancel();
        throw new ApiError(chunk.data.message, 500, chunk.data.error);
      }
    }
    throw new Error("The plan stream ended without a proposal.");
  } catch (error) {
    // A rejected proposal is terminal; only transport trouble falls back.
    if (error instanceof ApiError || error instanceof UnauthorizedError) throw error;
  }
  return generateConversationPlanProposal(
    projectId,
    workItemId,
    conversationId,
    idempotencyKey,
    intentMessage,
    handoff,
  );
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
