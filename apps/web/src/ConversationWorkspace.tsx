import type {
  AppendMessage,
  AttachmentAdapter,
  DataMessagePartProps,
  FileMessagePartProps,
  PendingAttachment,
} from "@assistant-ui/react";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAttachment,
  useComposer,
  useComposerRuntime,
  useMessage,
  useThread,
} from "@assistant-ui/react";
import { AssistantChatTransport, useAISDKChat, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type {
  ConversationExecutionProjectionT,
  PmModelT,
  PmProviderT,
  V2ConfirmConversationActionResponseT,
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2ConversationFolderT,
  V2ConversationHandoffT,
  V2ConversationMockupVersionT,
  V2ConversationNavigationItemT,
  V2ConversationNavigationPageT,
  V2ConversationPlanActionEffectValueT,
  V2ConversationPlanReviewFindingT,
  V2ConversationPlanReviewT,
  V2ConversationPlanningExcerptReceiptT,
  V2ConversationPmUpdateSettingsT,
  V2ConversationSummaryT,
  V2ConversationUsageT,
  V2CreateExecutionActionProposalInputT,
  V2CreateHumanWaitAnswerProposalInputT,
  V2HumanWaitT,
  V2ImplementationVisualEvidenceT,
  V2PlanHandoffPreferenceT,
  V2RequestPlanChangesParametersT,
  V2VisualComparisonReceiptT,
  V2WorkConversationT,
  V2WorkMessagePartT,
  V2WorkMessageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import {
  DEFAULT_PM_MODEL,
  PM_MODEL_OPTIONS,
  V2ConversationMockupVersion,
  V2CreateExecutionActionProposalInput,
  V2CreateHumanWaitAnswerProposalInput,
  V2ImplementationVisualEvidence,
  V2VisualComparisonReceipt,
} from "@norns/contracts";
import type { ChatRequestOptions, CreateUIMessage, UIMessage, UIMessageChunk } from "ai";
import {
  type FormEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import { ArtifactImage } from "./ArtifactImage";
import { ConversationActionCard } from "./ConversationActionCard";
import { ProjectRunStopControl, executionTargetHeaderLabel } from "./ConversationExecutionTarget";
import { ConversationPlanCard } from "./ConversationPlanCard";
import {
  ExecutionActionComposer,
  ExecutionActionHistory,
  HumanWaitCard,
  type HumanWaitView,
  MockupRequestComposer,
  PmUpdateControls,
} from "./ExecutionConversationControls";
import { QcWorkspace } from "./QcWorkspace";
import {
  AI_PROVIDERS,
  aiProviderLabel,
  asAiProvider,
  defaultReviewerProviderFor,
} from "./aiProviders";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import {
  type ConversationDetail,
  type PlanProposalProgress,
  type QcModeT,
  type SubmitConversationMessageBody,
  type WorkItemConversationGroup,
  adjudicateConversationPlanReview,
  archivePlanningWorkItem,
  cancelAllProjectRuns,
  cancelConversationPlanReview,
  confirmConversationAction,
  continueConversationPlanReviewChat,
  continueConversationWithoutQc,
  createConversationFolder,
  createConversationMessageBranch,
  createPlanningWorkItem,
  deleteConversationFolder,
  generateConversationPlanChangeProposal,
  getConversation,
  getConversationExecution,
  getProjectConversationPin,
  getProjectRunCancellation,
  listConversationNavigation,
  listWorkItemConversations,
  messageEndpoint,
  patchConversationPlanReview,
  proposeExecutionConversationAction,
  proposeHumanWaitAnswer,
  renamePlanningWorkItem,
  resolveConversation,
  resumeConversationPlanReview,
  retrieveConversationPlanningExcerpt,
  streamConversationPlanProposal,
  switchConversationModel,
  updateConversationFolder,
  updateConversationPmSettings,
  updateWorkItemOrganization,
} from "./conversationApi";
import { type ExecutionModelCapability, getExecutionModelCapabilities } from "./phaseTabApi";
import { Alert, Badge, Button, Field, Input, Select, Spinner, TextArea } from "./ui";
import "./ConversationWorkspace.css";

type Ruling = "reviewer" | "pm" | "supplied_fact";

function ChatIcon(): React.ReactElement {
  return (
    <svg
      className="conversation-sidebar-item-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.25 7.25a5.25 5.25 0 0 1-5.25 5.25 5.7 5.7 0 0 1-2.2-.44L2.75 13l.94-2.6A5.25 5.25 0 1 1 13.25 7.25Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon(): React.ReactElement {
  return (
    <svg
      className="conversation-sidebar-item-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.75 4.5c0-.69.56-1.25 1.25-1.25h3l1.35 1.5H13c.69 0 1.25.56 1.25 1.25v5.25c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.5Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ArtifactData = {
  artifact_id: string;
  label: string;
  media_type: string;
};

type ReferenceData = {
  id: string;
  label: string;
};

type PlanData = ReferenceData & {
  version: V2WorkPlanVersionT | null;
  reviews: V2ConversationPlanReviewT[];
};

type ActionData = ReferenceData & {
  action: V2ConversationActionT | null;
};

type AttemptData = {
  attempt_id: string;
  status: string;
};

type UsageData = {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

type MessageStatusData = {
  status: "interrupted";
};

type HandoffData = ReferenceData & {
  handoff: V2ConversationHandoffT | null;
};

type PlanningExcerptData = ReferenceData & {
  receipt: V2ConversationPlanningExcerptReceiptT | null;
};

type HumanWaitData = ReferenceData & {
  view: HumanWaitView | null;
};

type HumanWaitUpdateData = HumanWaitData & {
  status: "continuation_queued" | "resumed" | "expired" | "cancelled" | "failed";
};

type MockupData = ReferenceData;
type ImplementationVisualEvidenceData = ReferenceData;

type NornsDataParts = {
  artifact: ArtifactData;
  plan: PlanData;
  action: ActionData;
  handoff: HandoffData;
  "planning-excerpt": PlanningExcerptData;
  "human-wait": HumanWaitData;
  "human-wait-update": HumanWaitUpdateData;
  mockup: MockupData;
  "implementation-visual-evidence": ImplementationVisualEvidenceData;
  attempt: AttemptData;
  usage: UsageData;
  "message-status": MessageStatusData;
};

type NornsMessageCustomMetadata = {
  sequence?: number;
  visibility_status?: V2WorkMessageT["visibility_status"];
  actor?: V2WorkMessageT["actor"];
};

type NornsMessageMetadata = {
  custom?: NornsMessageCustomMetadata;
};

type NornsUIMessage = UIMessage<NornsMessageMetadata, NornsDataParts>;

type SidebarConversationFamily = {
  group: WorkItemConversationGroup;
  organization: V2ConversationNavigationItemT | null;
};

interface ConversationWorkspaceProps {
  projectId: string;
  initialConversationId?: string | null;
  initialNewConversation?: boolean;
  initialBrief?: string | null;
  onConversationSelected?: (conversationId: string, replace?: boolean) => void;
  onNewConversation?: () => void;
  onUnsupported?: () => void;
  onUnauthorized: () => void;
}

function conversationPath(projectId: string, workItemId: string, conversationId: string): string {
  return messageEndpoint(projectId, workItemId, conversationId);
}

function titleForObjective(objective: string): string {
  const firstThought =
    objective
      .trim()
      .replace(/^#+\s*/, "")
      .split(/(?:\r?\n|[.!?]\s)/, 1)[0]
      ?.replace(/^(?:please\s+)?(?:i|we)\s+(?:would like|want|need)\s+to\s+/i, "")
      .replace(/^please\s+/i, "")
      .trim() || "New conversation";
  const titled = `${firstThought.charAt(0).toUpperCase()}${firstThought.slice(1)}`;
  return titled.length > 72 ? `${titled.slice(0, 69).trimEnd()}…` : titled;
}

function conversationKindLabel(kind: V2WorkConversationT["kind"]): string {
  if (kind === "planning") return "Plan with PM";
  if (kind === "execution_pm") return "Development chat";
  return "Task";
}

function displayConversationTitle(title: string): string {
  return title.replace(/^#{1,6}\s+/, "").trim() || "Untitled conversation";
}

type ActorPresentation = {
  className: "human" | "pm" | "agent" | "reviewer" | "system";
  label: string;
  actorId: string | null;
};

function actorPresentation(
  actor: V2WorkMessageT["actor"] | undefined,
  fallback: "user" | "assistant" | "system",
): ActorPresentation {
  if (!actor) {
    if (fallback === "user") return { className: "human", label: "You", actorId: null };
    if (fallback === "system") return { className: "system", label: "System", actorId: null };
    return { className: "pm", label: "PM", actorId: null };
  }
  const actorId = actor.actor_id;
  const normalizedId = actorId?.toLocaleLowerCase() ?? "";
  if (actor.actor_type === "human") return { className: "human", label: "You", actorId };
  if (actor.actor_type === "system") return { className: "system", label: "System", actorId };
  if (
    actor.actor_type === "coordinator" ||
    normalizedId.includes("review") ||
    normalizedId.includes("qc")
  ) {
    return {
      className: "reviewer",
      label: actor.actor_type === "coordinator" ? "Coordinator" : "Reviewer",
      actorId,
    };
  }
  if (normalizedId.includes("pm")) return { className: "pm", label: "PM", actorId };
  if (actor.actor_type === "agent" || actor.actor_type === "runner") {
    return {
      className: "agent",
      label: actor.actor_type === "runner" ? "Runner" : "Agent",
      actorId,
    };
  }
  return { className: "pm", label: "PM", actorId };
}

function useCurrentActorPresentation(fallback: "user" | "assistant" | "system"): ActorPresentation {
  const actor = useMessage(
    (message) => (message.metadata.custom as NornsMessageCustomMetadata | undefined)?.actor,
  );
  return actorPresentation(actor, fallback);
}

const conversationModelOptions = (
  Object.entries(PM_MODEL_OPTIONS) as Array<[PmProviderT, (typeof PM_MODEL_OPTIONS)[PmProviderT]]>
).flatMap(([provider, models]) =>
  models.map((model) => ({
    provider,
    id: model.id,
    label: model.label,
  })),
);

function attachmentIdFromUrl(url: string): string | null {
  const match = /\/attachments\/([^/?#]+)(?:[?#]|$)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const CONVERSATION_ATTACHMENT_ACCEPT = "*";

const ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
};

function resolvedAttachmentMime(file: File): string {
  const declared = file.type.trim().toLocaleLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  const extension = file.name.split(".").pop()?.toLocaleLowerCase();
  return (extension ? ATTACHMENT_MIME_BY_EXTENSION[extension] : null) ?? "application/octet-stream";
}

function attachmentTypeLabel(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "application/json") return "JSON";
  if (mimeType === "text/markdown") return "Markdown";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType.startsWith("text/")) return "Text file";
  return "File";
}

function toSubmissionParts(message: NornsUIMessage): V2WorkMessagePartT[] {
  return message.parts.flatMap((part): V2WorkMessagePartT[] => {
    if (part.type === "text" && part.text.trim()) {
      return [{ type: "text", format: "markdown", text: part.text }];
    }
    if (part.type === "file") {
      const attachmentId = attachmentIdFromUrl(part.url);
      if (!attachmentId) return [];
      return [
        {
          type: "attachment",
          attachment_id: attachmentId,
          name:
            part.filename?.trim() ||
            (part.mediaType.startsWith("image/") ? "Image attachment" : "File attachment"),
          media_type: part.mediaType,
        },
      ];
    }
    return [];
  });
}

function toCreateNornsMessage<UI_MESSAGE extends UIMessage = UIMessage>(
  projectId: string,
  message: AppendMessage,
): CreateUIMessage<UI_MESSAGE> {
  const parts: NornsUIMessage["parts"] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      parts.push({
        type: "file",
        mediaType: "image/png",
        ...(part.filename ? { filename: part.filename } : {}),
        url: part.image,
      });
      continue;
    }
    if (part.type === "file") {
      parts.push({
        type: "file",
        mediaType: part.mimeType,
        ...(part.filename ? { filename: part.filename } : {}),
        url: part.data,
      });
    }
  }
  for (const attachment of message.attachments ?? []) {
    parts.push({
      type: "file",
      mediaType: attachment.contentType ?? "image/png",
      filename: attachment.name,
      url: `/api/v2/projects/${projectId}/attachments/${encodeURIComponent(attachment.id)}`,
    });
  }
  return {
    role: message.role,
    parts,
    metadata: message.metadata as NornsMessageMetadata,
  } as unknown as CreateUIMessage<UI_MESSAGE>;
}

function precedingUserMessage(
  messages: NornsUIMessage[],
  targetMessageId?: string,
): NornsUIMessage | undefined {
  const targetIndex = targetMessageId
    ? messages.findIndex((message) => message.id === targetMessageId)
    : messages.length;
  const end = targetIndex < 0 ? messages.length : targetIndex;
  for (let index = end - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === "user") return candidate;
  }
  return [...messages].reverse().find((message) => message.role === "user");
}

const conversationFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) throw new UnauthorizedError();
  if (response.status === 415) {
    throw new ApiError(
      "The message request was rejected. Refresh the page and try sending it again.",
      415,
      "unsupported_media_type",
    );
  }
  return response;
};

class NornsConversationTransport extends AssistantChatTransport<NornsUIMessage> {
  constructor(private readonly conversationBase: string) {
    super({
      api: `${conversationBase}/messages`,
      credentials: "include",
      fetch: conversationFetch,
      // DefaultChatTransport owns the JSON Content-Type header. Adding our
      // lower-case variant makes browsers combine both values into an invalid
      // media type ("application/json, application/json").
      headers: () => authHeaders(false),
      prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
        if (trigger === "regenerate-message") {
          const triggeringMessage = precedingUserMessage(messages, messageId);
          if (!triggeringMessage) throw new Error("No user message is available to retry.");
          return {
            api: `${conversationBase}/retry`,
            credentials: "include",
            headers: authHeaders(false),
            body: { triggering_message_id: triggeringMessage.id },
          };
        }

        const userMessage = [...messages].reverse().find((message) => message.role === "user");
        if (!userMessage) throw new Error("No user message is available to send.");
        const body: SubmitConversationMessageBody = {
          client_message_id: userMessage.id,
          parts: toSubmissionParts(userMessage),
        };
        return {
          api: `${conversationBase}/messages`,
          credentials: "include",
          headers: authHeaders(false),
          body,
        };
      },
    });
  }

  override async reconnectToStream(
    options: { chatId: string } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const response = await conversationFetch(`${this.conversationBase}/resume`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify(options.body ?? {}),
    });
    if (response.status === 404 || response.status === 409) {
      throw new ApiError(
        "This response is no longer retryable. Refresh the conversation status.",
        response.status,
      );
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      throw new ApiError(
        payload.message ?? payload.error ?? `request failed: ${response.status}`,
        response.status,
      );
    }
    if (!response.body) throw new Error("The retried response did not include a stream.");
    return this.processResponseStream(response.body);
  }
}

type ConversationResources = {
  planVersions: Map<string, V2WorkPlanVersionT>;
  actions: Map<string, V2ConversationActionT>;
  reviews: V2ConversationPlanReviewT[];
  handoff: V2ConversationHandoffT | null;
  excerptReceipts: Map<string, V2ConversationPlanningExcerptReceiptT>;
  humanWaits: Map<string, HumanWaitView>;
};

type ConversationActionEffect = V2ConfirmConversationActionResponseT["effect"];

/** A review action's last failure. `capBlocked` is set when it failed with
 *  `round_cap_requires_raise` (QC-PAUSE-POINTS.md "Outcomes") — the gate card
 *  offers to raise the cap instead of just showing the message. */
type ReviewActionError = { message: string; capBlocked?: boolean };

type ConversationActionContextValue = {
  projectId: string;
  workItemId: string;
  conversationId: string;
  actions: Map<string, V2ConversationActionT>;
  effects: Map<string, ConversationActionEffect>;
  deliveryEvents: V2ConversationActionDeliveryEventT[];
  busyActionId: string | null;
  errors: Map<string, string>;
  /** `qcMode` pins the kickoff cadence chosen on a proposed send_plan_to_qc
   *  action's control (QC-PAUSE-POINTS.md "Settings: three layers"). It rides
   *  the confirm body straight into the review row, so the pin is atomic with
   *  review creation. Ignored for every other action type. */
  confirm: (action: V2ConversationActionT, qcMode?: QcModeT) => Promise<void>;
  prepareHumanWaitAnswer: (
    wait: V2HumanWaitT,
    answer: string,
    rationale: string | null,
  ) => Promise<boolean>;
  lockedHumanWaitAnswerIds: Set<string>;
  refresh: () => void;
  planChangeBusyId: string | null;
  planChangeErrors: Map<string, string>;
  planChangeLockedIds: Set<string>;
  proposePlanChanges: (version: V2WorkPlanVersionT, direction: string) => Promise<boolean>;
  reviewBusyId: string | null;
  reviewErrors: Map<string, ReviewActionError>;
  cancelReview: (review: V2ConversationPlanReviewT, reason: string) => Promise<void>;
  stopAllWork: (review: V2ConversationPlanReviewT) => Promise<void>;
  continueReviewChat: (
    review: V2ConversationPlanReviewT,
    channel: "reviewer" | "pm",
    message: string,
  ) => Promise<void>;
  continueWithoutQc: (review: V2ConversationPlanReviewT) => Promise<void>;
  resumeReview: (
    review: V2ConversationPlanReviewT,
    exit: "continue" | "note",
    note?: { channel: "reviewer" | "pm"; message: string },
    stopAsking?: boolean,
  ) => Promise<void>;
  triageReview: (
    review: V2ConversationPlanReviewT,
    decisions: Record<string, "accept" | "reject">,
  ) => Promise<void>;
  adjudicateReview: (
    review: V2ConversationPlanReviewT,
    rulings: Record<string, { ruling: Ruling; rationale: string }>,
    note: { channel: "reviewer" | "pm"; message: string } | undefined,
    raiseMaxRounds: boolean,
  ) => Promise<void>;
  /** Mid-flight cadence edit and "hold at the next checkpoint" (QC-PAUSE-
   *  POINTS.md "Settings: three layers") — PATCH .../plan-reviews/:reviewId. */
  patchReview: (review: V2ConversationPlanReviewT, patch: { qcMode?: QcModeT }) => Promise<void>;
  prepareExecutionAction: (
    actionType: V2CreateExecutionActionProposalInputT["action_type"],
    parameters: Record<string, unknown>,
  ) => Promise<boolean>;
  executionProposalBusy: boolean;
  executionProposalError: string | null;
  messageActionIds: Set<string>;
  onUnauthorized: () => void;
};

const ConversationActionContext = createContext<ConversationActionContextValue | null>(null);

type EditableConversationMessage = {
  text: string;
};

type ConversationEditContextValue = {
  messages: Map<string, EditableConversationMessage>;
  editMessage: (sourceMessageId: string, text: string) => Promise<void>;
};

const ConversationEditContext = createContext<ConversationEditContextValue | null>(null);

function messagePartToUi(
  projectId: string,
  part: V2WorkMessagePartT,
  resources: ConversationResources,
): NornsUIMessage["parts"] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "code": {
      const language = part.language?.trim() ?? "";
      return [{ type: "text", text: `\`\`\`${language}\n${part.code}\n\`\`\`` }];
    }
    case "attachment":
      return [
        {
          type: "file",
          mediaType: part.media_type,
          filename: part.name,
          url: `/api/v2/projects/${projectId}/attachments/${encodeURIComponent(part.attachment_id)}`,
        },
      ];
    case "artifact":
      return [
        {
          type: "data-artifact",
          data: {
            artifact_id: part.artifact_id,
            label: part.label,
            media_type: part.media_type,
          },
        },
      ];
    case "plan":
      return [
        {
          type: "data-plan",
          data: {
            id: part.plan_version_id,
            label: "Plan candidate",
            version: resources.planVersions.get(part.plan_version_id) ?? null,
            reviews: resources.reviews.filter(
              (review) => review.plan_version_id === part.plan_version_id,
            ),
          },
        },
      ];
    case "action":
      return [
        {
          type: "data-action",
          data: {
            id: part.action_id,
            label: "Action awaiting confirmation",
            action: resources.actions.get(part.action_id) ?? null,
          },
        },
      ];
    case "handoff":
      return [
        {
          type: "data-handoff",
          data: {
            id: part.handoff_id,
            label: "Compact execution handoff",
            handoff: resources.handoff?.id === part.handoff_id ? resources.handoff : null,
          },
        },
      ];
    case "planning_excerpt":
      return [
        {
          type: "data-planning-excerpt",
          data: {
            id: part.excerpt_receipt_id,
            label: "Retrieved planning excerpt",
            receipt: resources.excerptReceipts.get(part.excerpt_receipt_id) ?? null,
          },
        },
      ];
    case "human_wait":
      return [
        {
          type: "data-human-wait",
          data: {
            id: part.human_wait_id,
            label: "Question awaiting your answer",
            view: resources.humanWaits.get(part.human_wait_id) ?? null,
          },
        },
      ];
    case "human_wait_update":
      return [
        {
          type: "data-human-wait-update",
          data: {
            id: part.human_wait_id,
            label: "Human wait update",
            status: part.status,
            view: resources.humanWaits.get(part.human_wait_id) ?? null,
          },
        },
      ];
    case "mockup":
      return [
        {
          type: "data-mockup",
          data: {
            id: part.mockup_version_id,
            label: "Mockup version",
          },
        },
      ];
    case "implementation_visual_evidence":
      return [
        {
          type: "data-implementation-visual-evidence",
          data: {
            id: part.visual_evidence_id,
            label: "Verified implementation visual evidence",
          },
        },
      ];
  }
}

function toUiMessage(
  projectId: string,
  message: V2WorkMessageT,
  resources: ConversationResources,
): NornsUIMessage {
  const parts = message.parts.flatMap((part) => messagePartToUi(projectId, part, resources));
  const role =
    message.role === "system" && (parts.length !== 1 || parts[0]?.type !== "text")
      ? "assistant"
      : message.role;
  if (message.visibility_status === "interrupted") {
    parts.push({
      type: "data-message-status",
      data: { status: "interrupted" },
    });
  }
  return {
    id: message.id,
    role,
    metadata: {
      custom: {
        sequence: message.sequence,
        visibility_status: message.visibility_status,
        actor: message.actor,
      },
    },
    parts,
  };
}

function createConversationAttachmentAdapter(
  projectId: string,
  onUnauthorized: () => void,
): AttachmentAdapter {
  return {
    accept: CONVERSATION_ATTACHMENT_ACCEPT,
    async add({ file }): Promise<PendingAttachment> {
      const contentType = resolvedAttachmentMime(file);
      const response = await fetch(`/api/v2/projects/${projectId}/attachments`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...authHeaders(),
          "content-type": contentType,
          "x-attachment-purpose": "conversation",
          "x-attachment-filename": file.name,
        },
        body: file,
      });
      if (response.status === 401) {
        onUnauthorized();
        throw new UnauthorizedError();
      }
      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok || !payload.id) {
        throw new Error(
          payload.message ??
            payload.error ??
            `The file could not be uploaded (${response.status}).`,
        );
      }
      return {
        id: payload.id,
        type: contentType.startsWith("image/") ? "image" : "file",
        name: file.name,
        contentType,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment) {
      const url = `/api/v2/projects/${projectId}/attachments/${encodeURIComponent(attachment.id)}`;
      return {
        ...attachment,
        status: { type: "complete" },
        content: attachment.contentType?.startsWith("image/")
          ? [{ type: "image", image: url, filename: attachment.name }]
          : [
              {
                type: "file",
                data: url,
                filename: attachment.name,
                mimeType: attachment.contentType ?? "text/plain",
              },
            ],
      };
    },
    async remove(attachment) {
      const response = await fetch(
        `/api/v2/projects/${projectId}/attachments/${encodeURIComponent(attachment.id)}`,
        {
          method: "DELETE",
          credentials: "include",
          headers: authHeaders(),
        },
      );
      if (response.status === 401) onUnauthorized();
      if (!response.ok && response.status !== 404) {
        throw new Error(`Could not remove the file (${response.status}).`);
      }
    },
  };
}

function MarkdownText(): React.ReactElement {
  return (
    <MarkdownTextPrimitive
      className="conversation-markdown"
      remarkPlugins={[remarkGfm]}
      smooth
      defer
    />
  );
}

function AttachmentPreview({
  filename,
  mimeType,
  data,
}: {
  filename?: string;
  mimeType: string;
  data: string;
}): React.ReactElement {
  const image = mimeType.startsWith("image/");
  const label = filename ?? "Attachment";
  return (
    <a
      className={`conversation-attachment-card${image ? " is-image" : " is-file"}`}
      href={data}
      target="_blank"
      rel="noreferrer"
      download={filename}
      aria-label={`Open ${label}`}
    >
      {image ? (
        <img src={data} alt={filename ?? "Attached image"} />
      ) : (
        <>
          <span className="conversation-attachment-icon" aria-hidden="true">
            ▧
          </span>
          <span className="conversation-attachment-copy">
            <strong>{label}</strong>
            <small>{attachmentTypeLabel(mimeType)}</small>
          </span>
        </>
      )}
      {image ? <span>{label}</span> : null}
    </a>
  );
}

function FilePreview({ filename, mimeType, data }: FileMessagePartProps): React.ReactElement {
  return <AttachmentPreview filename={filename} mimeType={mimeType} data={data} />;
}

function ArtifactPreview({ data }: DataMessagePartProps<ArtifactData>): React.ReactElement {
  return (
    <article className="conversation-artifact-card" data-testid="conversation-artifact">
      <span className="conversation-artifact-icon" aria-hidden="true">
        ◇
      </span>
      <span>
        <strong>{data.label}</strong>
        <small>{data.media_type}</small>
      </span>
      <code>{data.artifact_id}</code>
    </article>
  );
}

function ReferenceCard({ data }: { data: ReferenceData }): React.ReactElement {
  return (
    <article className="conversation-reference-card">
      <strong>{data.label}</strong>
      <code>{data.id}</code>
    </article>
  );
}

function ReferencePreview({ data }: DataMessagePartProps<ReferenceData>): React.ReactElement {
  return <ReferenceCard data={data} />;
}

async function fetchMockupVersion(
  projectId: string,
  workItemId: string,
  conversationId: string,
  mockupVersionId: string,
): Promise<V2ConversationMockupVersionT> {
  const response = await fetch(
    `/api/v2/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(
      workItemId,
    )}/conversations/${encodeURIComponent(conversationId)}/mockups/${encodeURIComponent(
      mockupVersionId,
    )}`,
    { credentials: "include", headers: authHeaders() },
  );
  if (response.status === 401) throw new UnauthorizedError();
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      payload.message ?? payload.error ?? `Mockup request failed: ${response.status}`,
      response.status,
      payload.error ?? null,
    );
  }
  return V2ConversationMockupVersion.parse(payload);
}

function MockupScreenshots({
  mockup,
  projectId,
  prefix,
  onUnauthorized,
}: {
  mockup: V2ConversationMockupVersionT;
  projectId: string;
  prefix: string;
  onUnauthorized: () => void;
}): React.ReactElement {
  return (
    <div className="conversation-mockup-screenshots">
      {mockup.screenshots.map((screenshot) => (
        <figure key={screenshot.viewport}>
          <ArtifactImage
            projectId={projectId}
            artifactId={screenshot.artifact.artifact_id}
            alt={`${prefix} mockup version ${mockup.version} ${screenshot.viewport} viewport`}
            onUnauthorized={onUnauthorized}
          />
          <figcaption>
            <strong>{screenshot.viewport}</strong>
            <span>
              {screenshot.width} × {screenshot.height}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function MockupReviewControls({
  mockup,
  context,
}: {
  mockup: V2ConversationMockupVersionT;
  context: ConversationActionContextValue;
}): React.ReactElement | null {
  const [reviewMode, setReviewMode] = useState<"revise" | "reject" | null>(null);
  const [reviewText, setReviewText] = useState("");
  const pendingAction =
    [...context.actions.values()].find(
      (action) =>
        ["approve_mockup", "revise_mockup", "reject_mockup"].includes(action.action_type) &&
        action.payload.parameters.mockup_version_id === mockup.id &&
        !context.messageActionIds.has(action.id) &&
        ["proposed", "confirmed", "recorded", "sent", "agent_acknowledged"].includes(action.status),
    ) ?? null;
  if (pendingAction) {
    return (
      <ConversationActionCard
        action={pendingAction}
        busy={context.busyActionId === pendingAction.id}
        effect={context.effects.get(pendingAction.id) ?? null}
        error={context.errors.get(pendingAction.id) ?? null}
        onConfirm={context.confirm}
      />
    );
  }
  if (mockup.status !== "candidate") return null;

  const exactReference = {
    mockup_version_id: mockup.id,
    manifest_artifact_id: mockup.manifest.artifact_id,
    manifest_artifact_hash: mockup.manifest.content_hash,
  };
  return (
    <section
      className="conversation-mockup-review"
      aria-label={`Review mockup version ${mockup.version}`}
    >
      <div>
        <Button
          className="btn-small"
          variant="primary"
          disabled={
            context.executionProposalBusy ||
            (mockup.task_id === null &&
              (mockup.plan_version_id === null || mockup.module_id === null))
          }
          title={
            mockup.task_id === null && mockup.module_id === null
              ? "Approval requires a task or plan-module scoped mockup."
              : undefined
          }
          onClick={() =>
            void context.prepareExecutionAction("approve_mockup", {
              ...exactReference,
              ...(mockup.task_id
                ? { task_id: mockup.task_id }
                : {
                    plan_version_id: mockup.plan_version_id,
                    module_id: mockup.module_id,
                  }),
            })
          }
        >
          Approve
        </Button>
        <Button
          className="btn-small"
          disabled={context.executionProposalBusy}
          aria-expanded={reviewMode === "revise"}
          onClick={() => {
            setReviewMode("revise");
            setReviewText("");
          }}
        >
          Revise
        </Button>
        <Button
          className="btn-small"
          variant="danger"
          disabled={context.executionProposalBusy}
          aria-expanded={reviewMode === "reject"}
          onClick={() => {
            setReviewMode("reject");
            setReviewText("");
          }}
        >
          Reject
        </Button>
      </div>
      {reviewMode ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void context.prepareExecutionAction(
              reviewMode === "revise" ? "revise_mockup" : "reject_mockup",
              {
                ...exactReference,
                [reviewMode === "revise" ? "direction" : "reason"]: reviewText.trim(),
              },
            );
          }}
        >
          <Field label={reviewMode === "revise" ? "Revision direction" : "Rejection reason"}>
            <TextArea
              required
              maxLength={reviewMode === "revise" ? 8_000 : 4_000}
              value={reviewText}
              onChange={(event) => setReviewText(event.target.value)}
            />
          </Field>
          <p>
            This prepares an inert {reviewMode} card bound to version {mockup.version}, manifest{" "}
            <code>{mockup.manifest.artifact_id}</code>, and hash{" "}
            <code>{mockup.manifest.content_hash.slice(0, 12)}</code>. Confirm it separately.
          </p>
          <div className="actions">
            <Button type="submit" variant="primary" disabled={context.executionProposalBusy}>
              Prepare {reviewMode} action
            </Button>
            <Button type="button" variant="ghost" onClick={() => setReviewMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {context.executionProposalError ? (
        <output className="conversation-action-error" role="alert">
          {context.executionProposalError}
        </output>
      ) : null}
    </section>
  );
}

function MockupPreview({ data }: DataMessagePartProps<MockupData>): React.ReactElement {
  const context = useContext(ConversationActionContext);
  const [mockup, setMockup] = useState<V2ConversationMockupVersionT | null>(null);
  const [previous, setPrevious] = useState<V2ConversationMockupVersionT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    setError(null);
    void fetchMockupVersion(context.projectId, context.workItemId, context.conversationId, data.id)
      .then(async (version) => {
        if (cancelled) return;
        setMockup(version);
        if (!version.supersedes_mockup_version_id) {
          setPrevious(null);
          return;
        }
        const predecessor = await fetchMockupVersion(
          context.projectId,
          context.workItemId,
          context.conversationId,
          version.supersedes_mockup_version_id,
        );
        if (!cancelled) setPrevious(predecessor);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof UnauthorizedError) context.onUnauthorized();
        else setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [context, data.id]);

  if (!context) return <ReferenceCard data={data} />;
  if (error) {
    return (
      <article className="conversation-reference-card" data-testid="conversation-mockup-error">
        <strong>Mockup version</strong>
        <span>Unavailable</span>
        <p>{error}</p>
        <code>{data.id}</code>
      </article>
    );
  }
  if (!mockup) {
    return (
      <article className="conversation-reference-card" aria-busy="true">
        <strong>Loading mockup…</strong>
        <code>{data.id}</code>
      </article>
    );
  }

  return (
    <article
      className="conversation-mockup-card"
      data-testid={`conversation-mockup-version-${mockup.version}`}
      aria-labelledby={`conversation-mockup-${mockup.id}`}
    >
      <header>
        <div>
          <span className="eyebrow">Reviewable visual artifact</span>
          <h3 id={`conversation-mockup-${mockup.id}`}>Mockup version {mockup.version}</h3>
        </div>
        <Badge
          tone={
            mockup.status === "approved"
              ? "success"
              : mockup.status === "rejected"
                ? "danger"
                : "warn"
          }
        >
          {mockup.status.replaceAll("_", " ")}
        </Badge>
      </header>
      <p>{mockup.brief}</p>
      <MockupScreenshots
        mockup={mockup}
        projectId={context.projectId}
        prefix="Current"
        onUnauthorized={context.onUnauthorized}
      />
      <dl className="conversation-mockup-evidence">
        <div>
          <dt>Version</dt>
          <dd>{mockup.version}</dd>
        </div>
        <div>
          <dt>Manifest artifact</dt>
          <dd>
            <code>{mockup.manifest.artifact_id}</code>
          </dd>
        </div>
        <div>
          <dt>Manifest hash</dt>
          <dd>
            <code title={mockup.manifest.content_hash}>
              {mockup.manifest.content_hash.slice(0, 12)}
            </code>
          </dd>
        </div>
      </dl>
      <section className="conversation-mockup-notes" aria-label="Mockup interaction notes">
        <strong>Interaction notes</strong>
        <ul>
          {mockup.interaction_notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
      {previous ? (
        <section
          className="conversation-mockup-comparison"
          aria-label={`Before and after comparison for version ${mockup.version}`}
          data-testid="conversation-mockup-comparison"
        >
          <div>
            <span className="eyebrow">Before</span>
            <strong>Version {previous.version} remains visible</strong>
            <MockupScreenshots
              mockup={previous}
              projectId={context.projectId}
              prefix="Before"
              onUnauthorized={context.onUnauthorized}
            />
          </div>
          <div>
            <span className="eyebrow">After</span>
            <strong>Version {mockup.version}</strong>
            <MockupScreenshots
              mockup={mockup}
              projectId={context.projectId}
              prefix="After"
              onUnauthorized={context.onUnauthorized}
            />
          </div>
        </section>
      ) : null}
      <MockupReviewControls mockup={mockup} context={context} />
    </article>
  );
}

function ImplementationVisualEvidencePreview({
  data,
}: DataMessagePartProps<ImplementationVisualEvidenceData>): React.ReactElement {
  const context = useContext(ConversationActionContext);
  const [evidence, setEvidence] = useState<V2ImplementationVisualEvidenceT | null>(null);
  const [comparison, setComparison] = useState<V2VisualComparisonReceiptT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    const load = async () => {
      const response = await fetch(
        `/api/v2/projects/${encodeURIComponent(context.projectId)}/work-items/${encodeURIComponent(
          context.workItemId,
        )}/conversations/${encodeURIComponent(context.conversationId)}/visual-evidence/${encodeURIComponent(
          data.id,
        )}`,
        { credentials: "include", headers: authHeaders() },
      );
      if (response.status === 401) throw new UnauthorizedError();
      if (!response.ok)
        throw new ApiError(`Visual evidence is unavailable (${response.status}).`, response.status);
      const parsed = V2ImplementationVisualEvidence.parse(await response.json());
      if (cancelled) return;
      setEvidence(parsed);
      if (!parsed.comparison_artifact) return;
      const comparisonResponse = await fetch(
        `/api/v2/projects/${encodeURIComponent(context.projectId)}/artifacts/${encodeURIComponent(
          parsed.comparison_artifact.artifact_id,
        )}/content`,
        { credentials: "include", headers: authHeaders() },
      );
      if (comparisonResponse.status === 401) throw new UnauthorizedError();
      if (!comparisonResponse.ok) {
        throw new ApiError(
          `Visual comparison is unavailable (${comparisonResponse.status}).`,
          comparisonResponse.status,
        );
      }
      const receipt = V2VisualComparisonReceipt.parse(await comparisonResponse.json());
      if (!cancelled) setComparison(receipt);
    };
    void load().catch((caught: unknown) => {
      if (cancelled) return;
      if (caught instanceof UnauthorizedError) context.onUnauthorized();
      else setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      cancelled = true;
    };
  }, [context, data.id]);

  if (!context) return <ReferenceCard data={data} />;
  if (error) {
    return (
      <output className="conversation-reference-card">
        <strong>Implementation visual evidence unavailable</strong>
        <p>{error}</p>
        <code>{data.id}</code>
      </output>
    );
  }
  if (!evidence) {
    return (
      <article className="conversation-reference-card" aria-busy="true">
        <strong>Loading implementation visual evidence…</strong>
      </article>
    );
  }
  return (
    <article
      className="conversation-mockup-card conversation-implementation-evidence"
      data-testid="implementation-visual-evidence"
    >
      <header>
        <div>
          <span className="eyebrow">Verified delivered implementation</span>
          <h3>Approved mockup vs delivered UI</h3>
        </div>
        <Badge tone="success">Commit verified</Badge>
      </header>
      <dl className="conversation-mockup-evidence">
        <div>
          <dt>Commit SHA</dt>
          <dd>
            <code title={evidence.commit_sha}>{evidence.commit_sha}</code>
          </dd>
        </div>
        <div>
          <dt>Approved mockup</dt>
          <dd>
            <code>{evidence.approved_mockup_version_id}</code>
          </dd>
        </div>
        <div>
          <dt>Comparison receipt</dt>
          <dd>
            {evidence.comparison_artifact ? (
              <code title={evidence.comparison_artifact.content_hash}>
                {evidence.comparison_artifact.artifact_id} ·{" "}
                {evidence.comparison_artifact.content_hash.slice(0, 12)}
              </code>
            ) : (
              <span>Unavailable</span>
            )}
          </dd>
        </div>
      </dl>
      {comparison ? (
        <div
          className="conversation-mockup-comparison"
          aria-label="Approved and delivered comparison"
        >
          {comparison.comparisons.map((pair) => {
            const delivered = evidence.screenshots.find(
              (screenshot) => screenshot.viewport === pair.viewport,
            );
            return (
              <section key={pair.viewport}>
                <strong>
                  {pair.viewport}
                  {delivered ? ` · ${delivered.width} × ${delivered.height}` : " · unavailable"}
                </strong>
                <div className="conversation-mockup-screenshots">
                  <figure>
                    <ArtifactImage
                      projectId={context.projectId}
                      artifactId={pair.mockup_artifact_id}
                      alt={`Approved ${pair.viewport} mockup`}
                      onUnauthorized={context.onUnauthorized}
                    />
                    <figcaption>
                      <span>Approved</span>
                      <code title={pair.mockup_artifact_hash}>
                        {pair.mockup_artifact_id} · {pair.mockup_artifact_hash.slice(0, 12)}
                      </code>
                    </figcaption>
                  </figure>
                  <figure>
                    {delivered ? (
                      <ArtifactImage
                        projectId={context.projectId}
                        artifactId={pair.implementation_artifact_id}
                        alt={`Delivered ${pair.viewport} implementation`}
                        onUnauthorized={context.onUnauthorized}
                      />
                    ) : (
                      <output>Delivered capture unavailable</output>
                    )}
                    <figcaption>
                      <span>Delivered</span>
                      <code title={pair.implementation_artifact_hash}>
                        {pair.implementation_artifact_id} ·{" "}
                        {pair.implementation_artifact_hash.slice(0, 12)}
                      </code>
                    </figcaption>
                  </figure>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <output className="muted">The approved-vs-delivered comparison is unavailable.</output>
      )}
    </article>
  );
}

function HandoffPreview({ data }: DataMessagePartProps<HandoffData>): React.ReactElement {
  if (!data.handoff) return <ReferenceCard data={data} />;
  return (
    <article className="conversation-inline-receipt" data-testid="conversation-handoff-receipt">
      <div>
        <span className="eyebrow">Compact handoff receipt</span>
        <strong>{data.handoff.package.objective}</strong>
      </div>
      <dl>
        <div>
          <dt>Approved plan</dt>
          <dd>
            <code title={data.handoff.package.approved_plan_content_hash}>
              {data.handoff.package.approved_plan_content_hash.slice(0, 12)}
            </code>
          </dd>
        </div>
        <div>
          <dt>Handoff</dt>
          <dd>
            <code title={data.handoff.content_hash}>{data.handoff.content_hash.slice(0, 12)}</code>
          </dd>
        </div>
      </dl>
    </article>
  );
}

function PlanningExcerptPreview({
  data,
}: DataMessagePartProps<PlanningExcerptData>): React.ReactElement {
  if (!data.receipt) return <ReferenceCard data={data} />;
  return (
    <article
      className="conversation-inline-receipt"
      data-testid="conversation-planning-excerpt-receipt"
    >
      <div>
        <span className="eyebrow">Explicit planning retrieval</span>
        <strong>
          {data.receipt.source_message_ids.length} planning message
          {data.receipt.source_message_ids.length === 1 ? "" : "s"} added
        </strong>
      </div>
      <code>{data.receipt.id}</code>
    </article>
  );
}

function HumanWaitPreview({ data }: DataMessagePartProps<HumanWaitData>): React.ReactElement {
  const context = useContext(ConversationActionContext);
  if (!data.view || !context) return <ReferenceCard data={data} />;
  const answerAction =
    [...context.actions.values()].find(
      (action) =>
        action.action_type === "answer_human_wait" &&
        action.payload.parameters.wait_id === data.id &&
        action.status !== "rejected",
    ) ?? null;
  return (
    <HumanWaitCard
      view={data.view}
      answerAction={answerAction}
      deliveryEvents={context.deliveryEvents}
      effect={answerAction ? (context.effects.get(answerAction.id) ?? null) : null}
      busy={context.busyActionId === (answerAction?.id ?? data.id)}
      exactRetryLocked={context.lockedHumanWaitAnswerIds.has(data.id)}
      error={context.errors.get(answerAction?.id ?? data.id) ?? context.errors.get(data.id) ?? null}
      onPrepareAnswer={context.prepareHumanWaitAnswer}
      onConfirm={context.confirm}
      onRefresh={context.refresh}
    />
  );
}

function HumanWaitUpdatePreview({
  data,
}: DataMessagePartProps<HumanWaitUpdateData>): React.ReactElement {
  const continuationStatus = data.view?.continuation?.status;
  return (
    <output
      className={`human-wait-update is-${data.status}`}
      data-testid={`human-wait-update-${data.id}`}
      aria-live="polite"
    >
      <strong>Human decision update</strong>
      <span>
        {data.status.replaceAll("_", " ")}
        {continuationStatus ? ` · continuation ${continuationStatus}` : ""}
      </span>
    </output>
  );
}

function planChangeDraftStorageKey(planVersionId: string): string {
  return `norns:conversation-plan-change-draft:${planVersionId}`;
}

function storedPlanChangeDraft(planVersionId: string): string {
  try {
    return window.sessionStorage.getItem(planChangeDraftStorageKey(planVersionId)) ?? "";
  } catch {
    return "";
  }
}

function PlanChangeControl({
  reviews,
  version,
}: {
  reviews: V2ConversationPlanReviewT[];
  version: V2WorkPlanVersionT;
}): React.ReactElement | null {
  const context = useContext(ConversationActionContext);
  const [direction, setDirection] = useState(() => storedPlanChangeDraft(version.id));
  if (!context || !["candidate", "in_qc"].includes(version.status)) {
    return null;
  }

  const pendingAction = [...context.actions.values()].find((action) => {
    if (action.action_type !== "request_plan_changes" || action.status !== "proposed") return false;
    const parameters = action.payload.parameters as V2RequestPlanChangesParametersT;
    return (
      parameters.plan_version_id === version.id && parameters.content_hash === version.content_hash
    );
  });
  const activeReview = reviews.find(
    (review) => review.status === "queued" || review.status === "running",
  );
  const retryLocked = context.planChangeLockedIds.has(version.id);
  const titleId = `conversation-plan-change-${version.id}`;

  if (pendingAction) {
    return (
      <section className="conversation-plan-change-control is-ready" aria-labelledby={titleId}>
        <div>
          <h4 id={titleId}>Request changes ready</h4>
          <p>
            The exact direction is recorded in a proposed action. Confirm that action separately to
            change project state.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="conversation-plan-change-control" aria-labelledby={titleId}>
      <div>
        <h4 id={titleId}>Request plan changes</h4>
        <p>
          Record the exact direction you want the PM to follow. Preparing it creates an inert action
          for separate confirmation.
        </p>
      </div>
      <label htmlFor={`${titleId}-direction`}>Change direction</label>
      <TextArea
        id={`${titleId}-direction`}
        value={direction}
        maxLength={2_000}
        disabled={
          activeReview !== undefined || retryLocked || context.planChangeBusyId === version.id
        }
        placeholder="Describe exactly what should change and why…"
        onChange={(event) => {
          const next = event.target.value;
          setDirection(next);
          try {
            window.sessionStorage.setItem(planChangeDraftStorageKey(version.id), next);
          } catch {
            // The current component still retains the draft when storage is unavailable.
          }
        }}
      />
      <div className="conversation-plan-change-actions">
        <span>
          {activeReview
            ? `Unavailable while QC is ${activeReview.status}.`
            : retryLocked
              ? "Direction locked until this exact request is safely retried."
              : `${direction.length.toLocaleString()} / 2,000 characters`}
        </span>
        <Button
          className="btn-small"
          disabled={
            activeReview !== undefined ||
            context.planChangeBusyId === version.id ||
            !direction.trim()
          }
          aria-label="Prepare request changes action"
          onClick={() => {
            void context.proposePlanChanges(version, direction.trim()).then((created) => {
              if (!created) return;
              setDirection("");
              try {
                window.sessionStorage.removeItem(planChangeDraftStorageKey(version.id));
              } catch {
                // The durable user-authored action is already server-owned.
              }
            });
          }}
        >
          {context.planChangeBusyId === version.id
            ? "Preparing…"
            : retryLocked
              ? "Retry preparing request changes"
              : "Prepare request changes"}
        </Button>
      </div>
      {context.planChangeErrors.get(version.id) ? (
        <output className="conversation-action-error" role="alert">
          {context.planChangeErrors.get(version.id)}
        </output>
      ) : null}
    </section>
  );
}

function StaffingReviewControl({
  reviews,
  version,
}: {
  reviews: V2ConversationPlanReviewT[];
  version: V2WorkPlanVersionT;
}): React.ReactElement | null {
  const context = useContext(ConversationActionContext);
  const [models, setModels] = useState<ExecutionModelCapability[] | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      version.plan.staffing.map((staffing) => [
        staffing.module_id,
        `${staffing.provider}:${staffing.model}`,
      ]),
    ),
  );
  const activeReview = reviews.find(
    (review) => review.status === "queued" || review.status === "running",
  );

  useEffect(() => {
    let current = true;
    void getExecutionModelCapabilities()
      .then((response) => {
        if (current) setModels(response.models.filter((model) => model.available));
      })
      .catch(() => {
        if (current) setModels([]);
      });
    return () => {
      current = false;
    };
  }, []);

  if (!context || !["candidate", "in_qc"].includes(version.status)) return null;
  const changed = version.plan.staffing.some(
    (staffing) => selection[staffing.module_id] !== `${staffing.provider}:${staffing.model}`,
  );

  return (
    <details className="conversation-staffing-review">
      <summary>Review or change implementation agents</summary>
      <div>
        <p>
          Every plan task already has one pinned role, provider, and model. Changes create a new
          immutable plan version so the final approval always shows the exact team that will run.
        </p>
        <div className="conversation-staffing-grid">
          {version.plan.staffing.map((staffing) => {
            const module = version.plan.plan.modules.find(
              (candidate) => candidate.id === staffing.module_id,
            );
            const currentValue = `${staffing.provider}:${staffing.model}`;
            const options = [...(models ?? [])];
            if (!options.some((model) => `${model.provider}:${model.id}` === currentValue)) {
              options.unshift({
                provider: staffing.provider,
                id: staffing.model,
                label: staffing.model,
                available: true,
                unavailable_reason: null,
              });
            }
            const selectId = `staffing-agent-${version.id}-${staffing.module_id}`;
            return (
              <label key={staffing.module_id} htmlFor={selectId}>
                <span>
                  <strong>{module?.title ?? staffing.module_id}</strong>
                  <small>{staffing.agent_role}</small>
                </span>
                <Select
                  id={selectId}
                  aria-label={`Agent for ${module?.title ?? staffing.module_id}`}
                  value={selection[staffing.module_id] ?? currentValue}
                  disabled={
                    models === null ||
                    activeReview !== undefined ||
                    context.planChangeBusyId === version.id
                  }
                  onChange={(event) =>
                    setSelection((current) => ({
                      ...current,
                      [staffing.module_id]: event.target.value,
                    }))
                  }
                >
                  {options.map((model) => (
                    <option
                      key={`${staffing.module_id}:${model.provider}:${model.id}`}
                      value={`${model.provider}:${model.id}`}
                    >
                      {model.label} · {model.provider}
                    </option>
                  ))}
                </Select>
              </label>
            );
          })}
        </div>
        <div className="conversation-staffing-actions">
          <span>
            {activeReview
              ? "Stop or finish QC before changing the team."
              : changed
                ? "Agent changes are ready to prepare."
                : "The displayed team is the team encoded in this plan."}
          </span>
          <Button
            disabled={
              !changed || activeReview !== undefined || context.planChangeBusyId === version.id
            }
            onClick={() => {
              const assignments = version.plan.staffing.map((staffing) => {
                const [provider, ...modelParts] = (
                  selection[staffing.module_id] ?? `${staffing.provider}:${staffing.model}`
                ).split(":");
                return `- ${staffing.module_id}: role "${staffing.agent_role}", provider "${provider}", model "${modelParts.join(":")}"`;
              });
              void context.proposePlanChanges(
                version,
                [
                  "Update only the staffing assignments in the Work Plan Contract to exactly the following:",
                  ...assignments,
                  "Preserve every task, dependency, acceptance check, verification requirement, risk, open decision, and budget unless a staffing change strictly requires a corresponding clarification.",
                ].join("\n"),
              );
            }}
          >
            {context.planChangeBusyId === version.id
              ? "Preparing team change…"
              : "Prepare team change"}
          </Button>
        </div>
      </div>
    </details>
  );
}

function PlanPreview({ data }: DataMessagePartProps<PlanData>): React.ReactElement {
  if (!data.version) return <ReferenceCard data={data} />;
  return (
    <>
      <ConversationPlanCard version={data.version} />
      <StaffingReviewControl version={data.version} reviews={data.reviews} />
      <PlanChangeControl version={data.version} reviews={data.reviews} />
    </>
  );
}

function ConversationQcActivity({
  reviews,
  planVersions,
}: {
  reviews: V2ConversationPlanReviewT[];
  planVersions: V2WorkPlanVersionT[];
}): React.ReactElement | null {
  const context = useContext(ConversationActionContext);
  const ordered = [...reviews].sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      right.attempt_number - left.attempt_number,
  );
  const latest = ordered[0] ?? null;
  if (!context || !latest) return null;
  const proposed = [...context.actions.values()].filter((action) => action.status === "proposed");
  const targetPlanId = latest.revised_plan_version_id ?? latest.plan_version_id;
  const targetPlan =
    planVersions.find((version) => version.id === targetPlanId) ??
    planVersions.find((version) => version.id === latest.plan_version_id) ??
    null;
  const approve =
    proposed.find(
      (action) =>
        action.action_type === "approve_plan" &&
        action.payload.parameters.plan_review_id === latest.id &&
        action.payload.parameters.plan_version_id === targetPlanId,
    ) ?? null;
  const reviewPlanIds = new Set(
    [latest.plan_version_id, latest.revised_plan_version_id].filter(
      (id): id is string => id !== null,
    ),
  );
  const targetsReview = (action: V2ConversationActionT): boolean =>
    reviewPlanIds.has(action.payload.parameters.plan_version_id as string);
  const repeat =
    proposed.find(
      (action) =>
        action.action_type === "send_plan_to_qc" &&
        targetsReview(action) &&
        (action.payload.parameters.review as { mode?: string } | undefined)?.mode !== "skip_qc",
    ) ?? null;
  const reject =
    proposed.find((action) => action.action_type === "reject_plan" && targetsReview(action)) ??
    null;
  const history = ordered.slice(1);

  return (
    <QcWorkspace
      review={latest}
      planVersion={targetPlan}
      history={history}
      actions={{ approve, repeat, reject }}
      busy={context.reviewBusyId === latest.id || context.busyActionId !== null}
      error={
        context.reviewErrors.get(latest.id)?.message ||
        (approve ? context.errors.get(approve.id) : null) ||
        (repeat ? context.errors.get(repeat.id) : null) ||
        (reject ? context.errors.get(reject.id) : null) ||
        null
      }
      onTriage={context.triageReview}
      onResume={(review) => context.resumeReview(review, "continue")}
      onAdjudicate={(review, rulings) =>
        context.adjudicateReview(review, rulings, undefined, false)
      }
      onContinueWithoutQc={context.continueWithoutQc}
      onCancel={context.cancelReview}
      onStopAll={context.stopAllWork}
      onConfirmAction={context.confirm}
    />
  );
}

function ActionPreview({ data }: DataMessagePartProps<ActionData>): React.ReactElement {
  const context = useContext(ConversationActionContext);
  const action = context?.actions.get(data.id) ?? data.action;
  if (!action || !context) return <ReferenceCard data={data} />;
  if (action.action_type === "answer_human_wait") return <></>;
  return (
    <ConversationActionCard
      action={action}
      busy={context.busyActionId === action.id}
      effect={context.effects.get(action.id) ?? null}
      error={context.errors.get(action.id) ?? null}
      onConfirm={context.confirm}
    />
  );
}

function AttemptStatus({ data }: DataMessagePartProps<AttemptData>): React.ReactElement {
  return (
    <output className="conversation-turn-meta" aria-live="polite">
      PM request: {data.status.replaceAll("_", " ")}
    </output>
  );
}

function UsageStatus({ data }: DataMessagePartProps<UsageData>): React.ReactElement {
  return (
    <output className="conversation-turn-meta" data-testid="conversation-usage">
      {data.input_tokens.toLocaleString()} in · {data.output_tokens.toLocaleString()} out · $
      {data.cost_usd.toFixed(4)}
    </output>
  );
}

function InterruptedStatus(): React.ReactElement {
  return (
    <output className="conversation-interrupted" data-testid="conversation-interrupted">
      Response stopped. Retry when you are ready.
    </output>
  );
}

function ConversationSummaryIndicator({
  summary,
}: {
  summary: V2ConversationSummaryT;
}): React.ReactElement {
  return (
    <details
      className="conversation-summary-indicator"
      data-testid="conversation-summary-indicator"
    >
      <summary>
        Compacted summary v{summary.version} · messages {summary.from_message_sequence}–
        {summary.through_message_sequence}
      </summary>
      <div>
        <strong>{summary.summary.objective}</strong>
        {summary.summary.constraints.length > 0 ? (
          <p>{summary.summary.constraints.join(" · ")}</p>
        ) : (
          <p>No additional compacted constraints.</p>
        )}
        <code title={summary.content_hash}>{summary.content_hash.slice(0, 12)}</code>
      </div>
    </details>
  );
}

function HandoffCard({
  handoff,
  currentConversationId,
  onOpenConversation,
}: {
  handoff: V2ConversationHandoffT;
  currentConversationId: string;
  onOpenConversation: (conversationId: string) => void;
}): React.ReactElement {
  const isTarget = handoff.target_conversation_id === currentConversationId;
  const linkedConversationId = isTarget
    ? handoff.source_conversation_id
    : handoff.target_conversation_id;
  return (
    <article
      className="conversation-handoff-card"
      data-testid="conversation-handoff-card"
      aria-labelledby={`conversation-handoff-${handoff.id}`}
    >
      <header>
        <div>
          <div className="eyebrow">
            {isTarget ? "Compact execution handoff" : "Planning handoff"}
          </div>
          <h3 id={`conversation-handoff-${handoff.id}`}>{handoff.package.objective}</h3>
        </div>
        <Badge tone="success">Immutable</Badge>
      </header>
      <dl>
        <div>
          <dt>Approved plan</dt>
          <dd>
            <code title={handoff.package.approved_plan_content_hash}>
              {handoff.package.approved_plan_content_hash.slice(0, 12)}
            </code>
          </dd>
        </div>
        <div>
          <dt>Task sequence</dt>
          <dd>{handoff.package.task_sequence.length}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>
            {handoff.package.budget.currency} {handoff.package.budget.amount.toFixed(2)}
          </dd>
        </div>
      </dl>
      <details>
        <summary>Review compact handoff</summary>
        <div className="conversation-handoff-details">
          <section>
            <strong>Decisions retained</strong>
            <p>
              {handoff.package.human_decisions.length > 0
                ? handoff.package.human_decisions.map((decision) => decision.summary).join(" · ")
                : "No human decisions were recorded."}
            </p>
          </section>
          <section>
            <strong>Open risks and questions</strong>
            <p>
              {handoff.package.unresolved_risks_and_questions.join(" · ") ||
                "No unresolved risks or questions."}
            </p>
          </section>
          <section>
            <strong>Referenced artifacts</strong>
            <p>{handoff.package.artifact_ids.join(", ") || "No artifacts were carried forward."}</p>
          </section>
        </div>
      </details>
      <Button
        className="btn-small"
        aria-label={isTarget ? "Open archived planning conversation" : "Open development chat"}
        onClick={() => onOpenConversation(linkedConversationId)}
      >
        {isTarget ? "Open archived planning" : "Open development chat"}
      </Button>
    </article>
  );
}

function planningMessagePreview(message: V2WorkMessageT): string {
  const preview = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "code") return [`Code (${part.language ?? "plain text"})`];
      if (part.type === "plan") return [`Plan version ${part.plan_version_id}`];
      if (part.type === "action") return [`Action ${part.action_id}`];
      if (part.type === "artifact") return [`Artifact ${part.label}`];
      return [];
    })
    .join(" ")
    .trim();
  if (!preview) return "No text preview. Attachments are not replayed automatically.";
  return preview.length > 180 ? `${preview.slice(0, 177)}…` : preview;
}

function planningExcerptStorageKey(
  conversationId: string,
  sourceConversationId: string,
  messageIds: readonly string[],
): string {
  return `norns:planning-excerpt:${conversationId}:${sourceConversationId}:${messageIds.join(",")}`;
}

function PlanningExcerptControl({
  detail,
  onOpenConversation,
  onRefresh,
  onUnauthorized,
}: {
  detail: ConversationDetail;
  onOpenConversation: (conversationId: string) => void;
  onRefresh: () => void;
  onUnauthorized: () => void;
}): React.ReactElement | null {
  const handoff = detail.handoff;
  const [armed, setArmed] = useState(false);
  const [sourceMessages, setSourceMessages] = useState<V2WorkMessageT[] | null>(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (
    detail.conversation.kind !== "execution_pm" ||
    !handoff ||
    handoff.target_conversation_id !== detail.conversation.id
  ) {
    return null;
  }

  const loadPlanningMessages = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const source = await getConversation(
        detail.work_item.project_id,
        detail.work_item.id,
        handoff.source_conversation_id,
      );
      setSourceMessages(source.messages);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const retrieve = async () => {
    const messageIds = [...selectedIds].sort();
    if (messageIds.length === 0 || submitting) return;
    const storageKey = planningExcerptStorageKey(
      detail.conversation.id,
      handoff.source_conversation_id,
      messageIds,
    );
    let idempotencyKey: string;
    try {
      idempotencyKey =
        window.sessionStorage.getItem(storageKey) ??
        `planning-excerpt-${detail.conversation.id}-${
          typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
        }`;
      window.sessionStorage.setItem(storageKey, idempotencyKey);
    } catch {
      idempotencyKey = `planning-excerpt-${detail.conversation.id}-${Date.now().toString(36)}`;
    }
    setSubmitting(true);
    setError(null);
    try {
      await retrieveConversationPlanningExcerpt(
        detail.work_item.project_id,
        detail.work_item.id,
        detail.conversation.id,
        {
          idempotency_key: idempotencyKey,
          source_conversation_id: handoff.source_conversation_id,
          message_ids: messageIds,
        },
      );
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        // The excerpt is already durable in the execution conversation.
      }
      setArmed(false);
      setSourceMessages(null);
      setSelectedIds(new Set());
      onRefresh();
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      const prefix =
        caught instanceof ApiError
          ? ""
          : "Excerpt delivery status is uncertain. Retry the same selection safely. ";
      setError(`${prefix}${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="conversation-excerpt-control"
      aria-labelledby={`conversation-excerpt-${detail.conversation.id}`}
    >
      <div>
        <strong id={`conversation-excerpt-${detail.conversation.id}`}>
          Need planning context?
        </strong>
        <p>
          The planning transcript is not in this execution conversation. Retrieve only the specific
          visible messages needed for the work.
        </p>
      </div>
      {!armed ? (
        <Button className="btn-small" onClick={() => setArmed(true)}>
          Retrieve planning excerpt
        </Button>
      ) : sourceMessages === null ? (
        <div className="conversation-excerpt-confirm">
          <p>
            Loading the archived planning conversation is an explicit read. Nothing will be added to
            execution until you select messages and confirm.
          </p>
          <div className="actions">
            <Button
              className="btn-small"
              disabled={loading}
              onClick={() => void loadPlanningMessages()}
            >
              {loading ? "Loading planning messages…" : "Load planning messages"}
            </Button>
            <Button className="btn-small" variant="ghost" onClick={() => setArmed(false)}>
              Cancel
            </Button>
            <Button
              className="btn-small"
              variant="ghost"
              onClick={() => onOpenConversation(handoff.source_conversation_id)}
            >
              Open full planning conversation
            </Button>
          </div>
        </div>
      ) : (
        <fieldset>
          <legend>Select planning messages to add</legend>
          {sourceMessages.length === 0 ? (
            <p>No visible planning messages are available.</p>
          ) : (
            <div className="conversation-excerpt-options">
              {sourceMessages.map((message) => {
                const selected = selectedIds.has(message.id);
                return (
                  <label key={message.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!selected && selectedIds.size >= 20}
                      onChange={(event) => {
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked && next.size < 20) next.add(message.id);
                          else if (!event.target.checked) next.delete(message.id);
                          return next;
                        });
                      }}
                    />
                    <span>
                      <strong>
                        {message.role === "user"
                          ? "You"
                          : message.role === "assistant"
                            ? "PM"
                            : "System"}{" "}
                        · message {message.sequence}
                      </strong>
                      <small>{planningMessagePreview(message)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <small className="muted" aria-live="polite">
            {selectedIds.size} of 20 messages selected
          </small>
          <div className="actions">
            <Button
              className="btn-small"
              variant="primary"
              disabled={selectedIds.size === 0 || submitting}
              onClick={() => void retrieve()}
            >
              {submitting ? "Adding excerpt…" : "Add selected excerpt to execution"}
            </Button>
            <Button
              className="btn-small"
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                setArmed(false);
                setSourceMessages(null);
                setSelectedIds(new Set());
              }}
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      )}
      {error ? (
        <output className="conversation-action-error" role="alert">
          {error}
        </output>
      ) : null}
    </section>
  );
}

function ComposerAttachment(): React.ReactElement {
  const attachment = useAttachment();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const isImage = attachment.contentType?.startsWith("image/") ?? false;
  useEffect(() => {
    if (
      !isImage ||
      !attachment.file ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.file, isImage]);

  return (
    <AttachmentPrimitive.Root
      className={`conversation-composer-attachment${isImage ? " is-image" : " is-file"}`}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" />
      ) : (
        <AttachmentPrimitive.unstable_Thumb aria-hidden="true" />
      )}
      <span className="conversation-composer-attachment-name">
        <AttachmentPrimitive.Name />
        <small>
          {attachment.contentType ? attachmentTypeLabel(attachment.contentType) : "Pending file"}
        </small>
      </span>
      <AttachmentPrimitive.Remove aria-label="Remove attachment">×</AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function UserMessage(): React.ReactElement {
  const presentation = useCurrentActorPresentation("user");
  const editContext = useContext(ConversationEditContext);
  const messageId = useMessage((message) => message.id);
  const responseRunning = useThread((thread) => thread.isRunning);
  const editable = editContext?.messages.get(messageId);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editedText, setEditedText] = useState(editable?.text ?? "");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const submitEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editable || !editContext || responseRunning || editBusy) return;
    const replacement = editedText.trim();
    if (!replacement || replacement === editable.text.trim()) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await editContext.editMessage(messageId, replacement);
    } catch (caught) {
      setEditError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setEditBusy(false);
    }
  };
  return (
    <MessagePrimitive.Root
      className={`conversation-message is-user actor-${presentation.className}`}
    >
      <div className="conversation-message-label" title={presentation.actorId ?? undefined}>
        {presentation.label}
      </div>
      <div className="conversation-bubble">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            File: FilePreview,
            data: {
              by_name: {
                artifact: ArtifactPreview,
                plan: PlanPreview,
                action: ActionPreview,
                handoff: HandoffPreview,
                "planning-excerpt": PlanningExcerptPreview,
                "human-wait": HumanWaitPreview,
                "human-wait-update": HumanWaitUpdatePreview,
                mockup: MockupPreview,
                "implementation-visual-evidence": ImplementationVisualEvidencePreview,
                attempt: AttemptStatus,
                usage: UsageStatus,
                "message-status": InterruptedStatus,
              },
            },
          }}
        />
        <MessagePrimitive.Attachments>
          {({ attachment }) => {
            const content = attachment.content[0];
            if (content?.type === "image") {
              return (
                <AttachmentPreview
                  filename={attachment.name}
                  mimeType={attachment.contentType ?? "image/png"}
                  data={content.image}
                />
              );
            }
            if (content?.type === "file") {
              return (
                <AttachmentPreview
                  filename={attachment.name}
                  mimeType={content.mimeType}
                  data={content.data}
                />
              );
            }
            return null;
          }}
        </MessagePrimitive.Attachments>
      </div>
      <ActionBarPrimitive.Root className="conversation-message-actions">
        <ActionBarPrimitive.Copy aria-label="Copy message">Copy</ActionBarPrimitive.Copy>
        {editable ? (
          <button
            type="button"
            aria-label="Edit message"
            disabled={responseRunning || editBusy}
            title={
              responseRunning
                ? "Stop the active response before editing an earlier message."
                : "Edit this message in a new conversation branch."
            }
            onClick={() => {
              setEditedText(editable.text);
              setEditError(null);
              setEditorOpen(true);
            }}
          >
            Edit
          </button>
        ) : null}
      </ActionBarPrimitive.Root>
      {editorOpen && editable ? (
        <form
          className="conversation-message-editor"
          aria-label="Edit message"
          onSubmit={(event) => void submitEdit(event)}
        >
          <strong>Edit in a new branch</strong>
          <p>The original conversation stays unchanged.</p>
          <TextArea
            aria-label="Edited message"
            value={editedText}
            rows={4}
            autoFocus
            disabled={editBusy || responseRunning}
            onChange={(event) => setEditedText(event.target.value)}
          />
          {editError ? (
            <output className="conversation-action-error" role="alert">
              {editError}
            </output>
          ) : null}
          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={
                editBusy ||
                responseRunning ||
                !editedText.trim() ||
                editedText.trim() === editable.text.trim()
              }
            >
              {editBusy ? "Creating branch…" : "Create edited branch"}
            </Button>
            <Button
              type="button"
              disabled={editBusy}
              onClick={() => {
                setEditorOpen(false);
                setEditError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function AssistantMessage(): React.ReactElement {
  const presentation = useCurrentActorPresentation("assistant");
  return (
    <MessagePrimitive.Root
      className={`conversation-message is-assistant actor-${presentation.className}`}
    >
      <div className="conversation-message-label" title={presentation.actorId ?? undefined}>
        {presentation.label}
      </div>
      <div className="conversation-bubble" aria-live="polite">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            File: FilePreview,
            data: {
              by_name: {
                artifact: ArtifactPreview,
                plan: PlanPreview,
                action: ActionPreview,
                handoff: HandoffPreview,
                "planning-excerpt": PlanningExcerptPreview,
                "human-wait": HumanWaitPreview,
                "human-wait-update": HumanWaitUpdatePreview,
                mockup: MockupPreview,
                "implementation-visual-evidence": ImplementationVisualEvidencePreview,
                attempt: AttemptStatus,
                usage: UsageStatus,
                "message-status": InterruptedStatus,
              },
            },
          }}
        />
      </div>
      <ActionBarPrimitive.Root className="conversation-message-actions">
        <ActionBarPrimitive.Copy aria-label="Copy response">Copy</ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function SystemMessage(): React.ReactElement {
  const presentation = useCurrentActorPresentation("system");
  return (
    <MessagePrimitive.Root
      className={`conversation-message is-system actor-${presentation.className}`}
    >
      <div className="conversation-message-label" title={presentation.actorId ?? undefined}>
        {presentation.label}
      </div>
      <div className="conversation-bubble">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            File: FilePreview,
            data: {
              by_name: {
                artifact: ArtifactPreview,
                plan: PlanPreview,
                action: ActionPreview,
                handoff: HandoffPreview,
                "planning-excerpt": PlanningExcerptPreview,
                "human-wait": HumanWaitPreview,
                "human-wait-update": HumanWaitUpdatePreview,
                mockup: MockupPreview,
                "implementation-visual-evidence": ImplementationVisualEvidencePreview,
                attempt: AttemptStatus,
                usage: UsageStatus,
                "message-status": InterruptedStatus,
              },
            },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function RetryTerminalResponseButton({
  onError,
}: {
  onError: (message: string) => void;
}): React.ReactElement {
  const chat = useAISDKChat<NornsUIMessage>();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="btn-small"
      disabled={busy || !chat}
      onClick={() => {
        if (!chat) return;
        setBusy(true);
        onError("");
        void chat
          .resumeStream()
          .catch((error: unknown) =>
            onError(error instanceof Error ? error.message : "Could not retry the response."),
          )
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Retrying…" : "Retry response"}
    </Button>
  );
}

function InitialConversationMessage({
  text,
  onStarted,
}: {
  text: string;
  onStarted: () => void;
}): null {
  const chat = useAISDKChat<NornsUIMessage>();
  const started = useRef(false);
  useEffect(() => {
    if (!chat || started.current) return;
    started.current = true;
    onStarted();
    void chat.sendMessage({ text });
  }, [chat, onStarted, text]);
  return null;
}

function confirmationStorageKey(actionId: string): string {
  return `norns:conversation-action-confirmation:${actionId}`;
}

function approvalTransitionStorageKey(conversationId: string): string {
  return `norns:conversation-approval-transition:${conversationId}`;
}

function executionConversationId(effect: ConversationActionEffect): string | null {
  if (
    effect.kind !== "plan_approved" ||
    effect.transition_status !== "created" ||
    effect.execution_conversation_id === null
  ) {
    return null;
  }
  return effect.execution_conversation_id;
}

function createConfirmationKey(actionId: string): string {
  const unique =
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36);
  return `action-confirm-${actionId}-${unique}`;
}

function durableRequestKey(
  namespace: string,
  subjectId: string,
  memory: Map<string, string>,
): string {
  const memoryKey = `${namespace}:${subjectId}`;
  const remembered = memory.get(memoryKey);
  if (remembered) return remembered;
  const storageKey = `norns:${namespace}:${subjectId}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) {
      memory.set(memoryKey, existing);
      return existing;
    }
    const created = `${namespace}-${subjectId}-${
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
    }`;
    memory.set(memoryKey, created);
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    const created = `${namespace}-${subjectId}-${
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
    }`;
    memory.set(memoryKey, created);
    return created;
  }
}

function clearDurableRequestKey(
  namespace: string,
  subjectId: string,
  memory: Map<string, string>,
): void {
  const memoryKey = `${namespace}:${subjectId}`;
  memory.delete(memoryKey);
  try {
    window.sessionStorage.removeItem(`norns:${namespace}:${subjectId}`);
  } catch {
    // The durable server response remains authoritative.
  }
}

function exactRequestStorageKey(namespace: string, subjectId: string): string {
  return `norns:${namespace}:request:${subjectId}`;
}

function storedExactRequest<T>(
  namespace: string,
  subjectId: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  try {
    const raw = window.sessionStorage.getItem(exactRequestStorageKey(namespace, subjectId));
    if (!raw) return null;
    const parsed = parse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function storeExactRequest(namespace: string, subjectId: string, request: unknown): void {
  try {
    window.sessionStorage.setItem(
      exactRequestStorageKey(namespace, subjectId),
      JSON.stringify(request),
    );
  } catch {
    // In-memory component state still locks the exact request for this mount.
  }
}

function clearExactRequest(namespace: string, subjectId: string): void {
  try {
    window.sessionStorage.removeItem(exactRequestStorageKey(namespace, subjectId));
  } catch {
    // The server response remains authoritative.
  }
}

function actionHasExactSourceReceipt(
  action: V2ConversationActionT,
  messages: V2WorkMessageT[],
  expectedClientMessageId: string,
  scope: {
    projectId: string;
    workItemId: string;
    conversationId: string;
  },
): boolean {
  if (
    action.project_id !== scope.projectId ||
    action.work_item_id !== scope.workItemId ||
    action.conversation_id !== scope.conversationId
  ) {
    return false;
  }
  const sourceMessage = messages.find((message) => message.id === action.source_message_id);
  return Boolean(
    sourceMessage &&
      sourceMessage.project_id === scope.projectId &&
      sourceMessage.work_item_id === scope.workItemId &&
      sourceMessage.conversation_id === scope.conversationId &&
      sourceMessage.client_message_id === expectedClientMessageId &&
      sourceMessage.parts.some((part) => part.type === "action" && part.action_id === action.id),
  );
}

function executionActionMessage(
  actionType: V2CreateExecutionActionProposalInputT["action_type"],
  parameters: Record<string, unknown>,
): string {
  for (const key of ["decision", "direction", "brief", "reason"]) {
    const value = parameters[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (actionType === "approve_plan_change") {
    return `Approve plan change ${String(parameters.proposal_action_id ?? "")}`.trim();
  }
  if (actionType === "resume_work") {
    return parameters.task_id
      ? `Resume work for task ${String(parameters.task_id)}`
      : "Resume this work item";
  }
  return actionType.replaceAll("_", " ");
}

function proposalStorageKey(conversationId: string): string {
  return `norns:conversation-plan-proposal:${conversationId}`;
}

function proposalErrorStorageKey(conversationId: string): string {
  return `norns:conversation-plan-proposal-error:${conversationId}`;
}

function planChangeProposalStorageKey(planVersionId: string): string {
  return `norns:conversation-plan-change-proposal:${planVersionId}`;
}

function planChangeProposalKeyFor(planVersionId: string, memory: Map<string, string>): string {
  const remembered = memory.get(planVersionId);
  if (remembered) return remembered;
  const storageKey = planChangeProposalStorageKey(planVersionId);
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) {
      memory.set(planVersionId, existing);
      return existing;
    }
    const created = `plan-change-${planVersionId}-${
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
    }`;
    memory.set(planVersionId, created);
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    const created = `plan-change-${planVersionId}-${
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
    }`;
    memory.set(planVersionId, created);
    return created;
  }
}

function storedProposalError(conversationId: string): string | null {
  try {
    const storageKey = proposalErrorStorageKey(conversationId);
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored?.includes('column "review_mode" does not exist')) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

function proposalKeyFor(conversationId: string, memory: Map<string, string>): string {
  const remembered = memory.get(conversationId);
  if (remembered) return remembered;
  const storageKey = proposalStorageKey(conversationId);
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) {
      memory.set(conversationId, existing);
      return existing;
    }
    const created = `plan-proposal-${conversationId}-${
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
    }`;
    memory.set(conversationId, created);
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    const created = `plan-proposal-${conversationId}-${
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36)
    }`;
    memory.set(conversationId, created);
    return created;
  }
}

function confirmationKeyFor(action: V2ConversationActionT, memory: Map<string, string>): string {
  if (action.confirmation_idempotency_key) return action.confirmation_idempotency_key;
  const remembered = memory.get(action.id);
  if (remembered) return remembered;
  const storageKey = confirmationStorageKey(action.id);
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) {
      memory.set(action.id, existing);
      return existing;
    }
    const created = createConfirmationKey(action.id);
    memory.set(action.id, created);
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    const created = createConfirmationKey(action.id);
    memory.set(action.id, created);
    return created;
  }
}

function isPlanAdoptionIntent(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
  return [
    "use this",
    "use that",
    "use this as the plan",
    "use that as the plan",
    "make this the plan",
    "turn this into the plan",
    "create the plan from this",
    "lock this in as the plan",
    "proceed with this plan",
  ].includes(normalized);
}

function conversationDraftStorageKey(conversationId: string): string {
  return `norns:conversation-composer-draft:${conversationId}`;
}

function PlanHandoffDialog({
  busy,
  pmProvider,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  pmProvider: PmProviderT;
  onCancel: () => void;
  onSubmit: (handoff: V2PlanHandoffPreferenceT) => void;
}): React.ReactElement {
  const [reviewMode, setReviewMode] = useState<"qc" | "skip_qc">("qc");
  const [rounds, setRounds] = useState(3);
  const reviewerProvider = defaultReviewerProviderFor(pmProvider);
  const reviewerOptions = PM_MODEL_OPTIONS[reviewerProvider];
  const [reviewerModel, setReviewerModel] = useState<string>(DEFAULT_PM_MODEL[reviewerProvider]);
  const [executionModels, setExecutionModels] = useState<ExecutionModelCapability[] | null>(null);
  const [executionModel, setExecutionModel] = useState("");
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void getExecutionModelCapabilities()
      .then((response) => {
        if (!current) return;
        const available = response.models.filter((model) => model.available);
        setExecutionModels(available);
        setExecutionModel(
          (selected) =>
            selected || (available[0] ? `${available[0].provider}:${available[0].id}` : ""),
        );
      })
      .catch((caught) => {
        if (!current) return;
        setExecutionModels([]);
        setCapabilityError(
          caught instanceof Error ? caught.message : "Execution agents could not be loaded.",
        );
      });
    return () => {
      current = false;
    };
  }, []);

  const selectedExecution =
    executionModels?.find((model) => `${model.provider}:${model.id}` === executionModel) ?? null;
  const canSubmit = !busy && selectedExecution !== null;

  return createPortal(
    <div className="plan-handoff-backdrop" role="presentation" onMouseDown={onCancel}>
      <dialog
        open
        className="plan-handoff-dialog"
        aria-labelledby="plan-handoff-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <div className="eyebrow">Plan handoff</div>
            <h2 id="plan-handoff-title">How should this plan proceed?</h2>
          </div>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </header>

        <div className="plan-handoff-modes" role="radiogroup" aria-label="Quality control">
          <label className={reviewMode === "qc" ? "is-selected" : undefined}>
            <input
              type="radio"
              name="plan-review-mode"
              checked={reviewMode === "qc"}
              onChange={() => setReviewMode("qc")}
            />
            <span>
              <strong>Run QC</strong>
              <small>An independent agent reviews the exact plan before execution.</small>
            </span>
          </label>
          <label className={reviewMode === "skip_qc" ? "is-selected" : undefined}>
            <input
              type="radio"
              name="plan-review-mode"
              checked={reviewMode === "skip_qc"}
              onChange={() => setReviewMode("skip_qc")}
            />
            <span>
              <strong>Skip QC</strong>
              <small>Approve this plan directly and begin with the selected agent.</small>
            </span>
          </label>
        </div>

        <div className="plan-handoff-fields">
          <Field label="Execution agent">
            <Select
              aria-label="Execution agent"
              value={executionModel}
              disabled={busy || executionModels === null}
              onChange={(event) => setExecutionModel(event.target.value)}
            >
              {executionModels === null ? <option value="">Loading agents…</option> : null}
              {(executionModels ?? []).map((model) => (
                <option
                  key={`${model.provider}:${model.id}`}
                  value={`${model.provider}:${model.id}`}
                >
                  {model.label}
                </option>
              ))}
            </Select>
          </Field>
          {reviewMode === "qc" ? (
            <>
              <Field label="QC agent">
                <Select
                  aria-label="QC agent"
                  value={reviewerModel}
                  disabled={busy}
                  onChange={(event) => setReviewerModel(event.target.value)}
                >
                  {reviewerOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="QC rounds">
                <Select
                  aria-label="QC rounds"
                  value={String(rounds)}
                  disabled={busy}
                  onChange={(event) => setRounds(Number(event.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((round) => (
                    <option key={round} value={round}>
                      {round}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          ) : null}
        </div>

        {capabilityError ? <Alert>{capabilityError}</Alert> : null}
        {executionModels?.length === 0 && !capabilityError ? (
          <Alert>No development agents are currently available.</Alert>
        ) : null}

        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          onClick={() => {
            if (!selectedExecution) return;
            onSubmit({
              execution_agent: {
                provider: selectedExecution.provider,
                model: selectedExecution.id,
              },
              review:
                reviewMode === "qc"
                  ? {
                      mode: "qc",
                      reviewer: { provider: reviewerProvider, model: reviewerModel },
                      rounds,
                    }
                  : { mode: "skip_qc" },
            });
          }}
        >
          {busy
            ? "Preparing plan…"
            : reviewMode === "qc"
              ? "Create plan & send to QC"
              : "Create plan & start"}
        </Button>
      </dialog>
    </div>,
    document.body,
  );
}

function ConversationComposer({
  conversationId,
  isExecution,
  isPlanning,
  pmProvider,
  planIntentEnabled,
  planIntentBusy,
  onUseAsPlan,
  prefillText,
  onPrefillConsumed,
}: {
  conversationId: string;
  isExecution: boolean;
  isPlanning: boolean;
  pmProvider: PmProviderT;
  planIntentEnabled: boolean;
  planIntentBusy: boolean;
  onUseAsPlan: (message: string, handoff?: V2PlanHandoffPreferenceT) => void;
  prefillText?: string | null;
  onPrefillConsumed?: () => void;
}): React.ReactElement {
  const composer = useComposerRuntime();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draftStorageReady, setDraftStorageReady] = useState(false);
  const responseRunning = useThread((thread) => thread.isRunning);
  const draftText = useComposer((state) => state.text);
  const hasDraft = useComposer((state) => state.text.trim().length > 0);
  const hasAttachments = useComposer((state) => state.attachments.length > 0);
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(conversationDraftStorageKey(conversationId));
      if (stored && !composer.getState().text) composer.setText(stored);
    } catch {
      // The mounted composer still owns the draft when storage is unavailable.
    }
    setDraftStorageReady(true);
  }, [composer, conversationId]);
  useEffect(() => {
    if (!draftStorageReady) return;
    try {
      const key = conversationDraftStorageKey(conversationId);
      if (draftText) window.sessionStorage.setItem(key, draftText);
      else window.sessionStorage.removeItem(key);
    } catch {
      // The mounted composer still owns the draft when storage is unavailable.
    }
  }, [conversationId, draftStorageReady, draftText]);
  useEffect(() => {
    if (!prefillText) return;
    composer.setText(prefillText);
    onPrefillConsumed?.();
  }, [prefillText, composer, onPrefillConsumed]);
  useEffect(() => {
    const stopListeningForErrors = composer.unstable_on("attachmentAddError", ({ message }) => {
      if (message.includes("is not accepted")) return;
      setAttachmentError(message);
    });
    const stopListeningForAdds = composer.unstable_on("attachmentAdd", () =>
      setAttachmentError(null),
    );
    return () => {
      stopListeningForErrors();
      stopListeningForAdds();
    };
  }, [composer]);
  const interceptPlanIntent = (event: FormEvent<HTMLFormElement>) => {
    const state = composer.getState();
    if (!planIntentEnabled || state.attachments.length > 0 || !isPlanAdoptionIntent(state.text)) {
      return;
    }
    event.preventDefault();
    const message = state.text.trim();
    composer.setText("");
    onUseAsPlan(message);
  };

  return (
    <ComposerPrimitive.AttachmentDropzone asChild>
      <ComposerPrimitive.Root
        className="conversation-composer"
        aria-label="Message composer and file dropzone"
        onSubmit={interceptPlanIntent}
      >
        <ComposerPrimitive.Attachments>
          {() => <ComposerAttachment />}
        </ComposerPrimitive.Attachments>
        {attachmentError ? (
          <output className="conversation-attachment-error" role="alert">
            {attachmentError}
          </output>
        ) : null}
        <ComposerPrimitive.Input
          className="conversation-composer-input"
          placeholder={
            isExecution
              ? "Message the development chat…"
              : "Message the PM, or say “Use this as the plan”…"
          }
          aria-label={isExecution ? "Message the development chat" : "Message the project PM"}
          addAttachmentOnPaste={false}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            void Promise.all(files.map((file) => composer.addAttachment(file))).catch(() => {
              // attachmentAddError exposes the readable error beside the composer.
            });
          }}
          submitMode="enter"
          unstable_insertNewlineOnTouchEnter
          rows={2}
        />
        <div className="conversation-composer-actions">
          <ComposerPrimitive.AddAttachment
            className="conversation-icon-button"
            aria-label="Add file"
            title="Add images or files"
          >
            +
          </ComposerPrimitive.AddAttachment>
          <span className="conversation-keyboard-help">
            Enter to send · Shift+Enter for a new line
          </span>
          {responseRunning ? (
            <ComposerPrimitive.Cancel
              className="conversation-stop-button"
              aria-label="Stop response"
            >
              Stop
            </ComposerPrimitive.Cancel>
          ) : null}
          {isPlanning ? (
            <button
              type="button"
              className="conversation-plan-button"
              aria-label="Use conversation as plan"
              disabled={!planIntentEnabled || hasDraft || hasAttachments}
              title={
                hasDraft || hasAttachments
                  ? "Send or clear the current draft before creating the plan."
                  : "Create and save a plan from this conversation."
              }
              onClick={() => setHandoffOpen(true)}
            >
              {planIntentBusy ? "Planning…" : "Plan"}
            </button>
          ) : null}
          {!responseRunning ? (
            <ComposerPrimitive.Send className="conversation-send-button" aria-label="Send message">
              Send
            </ComposerPrimitive.Send>
          ) : null}
        </div>
        {handoffOpen ? (
          <PlanHandoffDialog
            busy={planIntentBusy}
            pmProvider={pmProvider}
            onCancel={() => setHandoffOpen(false)}
            onSubmit={(handoff) => {
              setHandoffOpen(false);
              onUseAsPlan("Use this as the plan.", handoff);
            }}
          />
        ) : null}
      </ComposerPrimitive.Root>
    </ComposerPrimitive.AttachmentDropzone>
  );
}

function planElapsedLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")} elapsed`;
}

const PLAN_STAGE_COPY: Record<PlanProposalProgress["stage"], string> = {
  generating: "Drafting modules",
  validating: "Validating the plan",
  saving: "Saving the plan",
};

function PlanGenerationProgress({
  progress,
}: {
  progress: PlanProposalProgress | null;
}): React.ReactElement {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <output
      className="conversation-plan-generation"
      data-testid="conversation-plan-busy"
      aria-live="polite"
    >
      <div className="conversation-plan-generation-copy">
        <span className="conversation-plan-generation-spinner" aria-hidden="true" />
        <span>
          <strong>Building your plan</strong>
          <small>
            {progress
              ? PLAN_STAGE_COPY[progress.stage]
              : "Analyzing the conversation and generating an executable proposal"}
          </small>
        </span>
        <time>{planElapsedLabel(elapsedSeconds)}</time>
      </div>
      {progress && progress.modules.length > 0 ? (
        <ol
          className="conversation-plan-generation-modules"
          data-testid="conversation-plan-modules"
        >
          {progress.modules.map((title, index) => (
            <li key={`${index}-${title}`}>{title}</li>
          ))}
        </ol>
      ) : null}
      <progress
        className="sr-only"
        max={100}
        aria-label="Plan generation progress"
        aria-valuetext={`In progress, ${planElapsedLabel(elapsedSeconds)}`}
      />
      <span className="conversation-plan-generation-track" aria-hidden="true">
        <span />
      </span>
    </output>
  );
}

function ConversationThread({
  header,
  detail,
  initialMessage,
  onInitialMessageStarted,
  onEditMessage,
  onOpenConversation,
  onConversationModelChanged,
  onRefresh,
  onRefreshSoft,
  onUnauthorized,
}: {
  header: (
    modelControl: ReactNode,
    executionTargetLabel: string | null,
    toolControl?: ReactNode,
    primaryAction?: ReactNode,
    planSummary?: string | null,
  ) => ReactNode;
  detail: ConversationDetail;
  initialMessage?: string | null;
  onInitialMessageStarted?: () => void;
  onEditMessage: (sourceMessageId: string, text: string) => Promise<void>;
  onOpenConversation: (conversationId: string) => void;
  onConversationModelChanged: (conversation: V2WorkConversationT) => void;
  onRefresh: () => void;
  onRefreshSoft: () => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [workTab, setWorkTab] = useState<"plan" | "implementation">(() =>
    detail.conversation.kind === "execution_pm" ? "implementation" : "plan",
  );
  const [streamError, setStreamError] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [latestAttempt, setLatestAttempt] = useState<AttemptData | null>(null);
  const [latestUsage, setLatestUsage] = useState<UsageData | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalProgress, setProposalProgress] = useState<PlanProposalProgress | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(() =>
    storedProposalError(detail.conversation.id),
  );
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [planChangeBusyId, setPlanChangeBusyId] = useState<string | null>(null);
  const [planChangeErrors, setPlanChangeErrors] = useState(() => new Map<string, string>());
  const [planChangeLockedIds, setPlanChangeLockedIds] = useState(() => new Set<string>());
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);
  const [reviewErrors, setReviewErrors] = useState(() => new Map<string, ReviewActionError>());
  const [executionProposalBusy, setExecutionProposalBusy] = useState(false);
  const [executionProposalError, setExecutionProposalError] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [executionProjection, setExecutionProjection] =
    useState<ConversationExecutionProjectionT | null>(null);
  const [lockedExecutionRequest, setLockedExecutionRequest] =
    useState<V2CreateExecutionActionProposalInputT | null>(() =>
      storedExactRequest(
        "execution-action-proposal",
        detail.conversation.id,
        V2CreateExecutionActionProposalInput.safeParse,
      ),
    );
  const [lockedHumanWaitAnswerIds, setLockedHumanWaitAnswerIds] = useState(
    () =>
      new Set(
        (detail.human_waits ?? []).flatMap(({ wait }) =>
          storedExactRequest(
            "human-wait-answer-proposal",
            wait.id,
            V2CreateHumanWaitAnswerProposalInput.safeParse,
          )
            ? [wait.id]
            : [],
        ),
      ),
  );
  const [pmSettingsBusy, setPmSettingsBusy] = useState(false);
  const [pmSettingsError, setPmSettingsError] = useState<string | null>(null);
  const [pmSettingsOverride, setPmSettingsOverride] =
    useState<V2ConversationPmUpdateSettingsT | null>(null);
  const [actionOverrides, setActionOverrides] = useState(
    () => new Map<string, V2ConversationActionT>(),
  );
  const [effectOverrides, setEffectOverrides] = useState(
    () => new Map<string, ConversationActionEffect>(),
  );
  const [actionErrors, setActionErrors] = useState(() => new Map<string, string>());
  const refreshTimer = useRef<number | null>(null);
  const confirmationKeys = useRef(new Map<string, string>());
  const proposalKeys = useRef(new Map<string, string>());
  const planChangeKeys = useRef(new Map<string, string>());
  const executionActionKeys = useRef(new Map<string, string>());
  const waitAnswerKeys = useRef(new Map<string, string>());
  const reviewRecoveryKeys = useRef(new Map<string, string>());
  const base = conversationPath(
    detail.work_item.project_id,
    detail.work_item.id,
    detail.conversation.id,
  );
  const transport = useMemo(() => new NornsConversationTransport(base), [base]);
  const attachmentAdapter = useMemo(
    () => createConversationAttachmentAdapter(detail.work_item.project_id, onUnauthorized),
    [detail.work_item.project_id, onUnauthorized],
  );
  const applyRunCancellation = useCallback(
    (cancellation: NonNullable<ConversationExecutionProjectionT["run"]>["cancellation"]) => {
      if (!cancellation) return;
      setExecutionProjection((current) => {
        if (!current?.run || current.run.run_id !== cancellation.run_id) return current;
        return {
          ...current,
          run: {
            ...current.run,
            can_stop: false,
            cancellation,
          },
        };
      });
    },
    [],
  );
  const executionProjectionRefreshMarker = `${detail.conversation.updated_at}:${detail.work_item.updated_at}`;

  useEffect(() => {
    let current = true;
    // Detail refreshes also refresh the independent execution projection so an
    // idle target can become active without remounting the conversation.
    void executionProjectionRefreshMarker;
    void getConversationExecution(detail.work_item.project_id, detail.conversation.id)
      .then((projection) => {
        if (current) setExecutionProjection(projection);
      })
      .catch((caught) => {
        if (!current) return;
        if (caught instanceof UnauthorizedError) onUnauthorized();
        else if (caught instanceof ApiError && caught.status === 404) setExecutionProjection(null);
      });
    return () => {
      current = false;
    };
  }, [
    detail.conversation.id,
    detail.work_item.project_id,
    executionProjectionRefreshMarker,
    onUnauthorized,
  ]);

  useEffect(() => {
    const cancellation = executionProjection?.run?.cancellation;
    if (!cancellation || cancellation.state === "process_exited") return;
    let current = true;
    const poll = () => {
      void getProjectRunCancellation(cancellation.project_id, cancellation.run_id)
        .then(async (next) => {
          if (!current) return;
          applyRunCancellation(next);
          if (next.state === "process_exited") {
            const projection = await getConversationExecution(
              detail.work_item.project_id,
              detail.conversation.id,
            );
            if (current) setExecutionProjection(projection);
          }
        })
        .catch((caught) => {
          if (current && caught instanceof UnauthorizedError) onUnauthorized();
        });
    };
    const timer = window.setInterval(poll, 2_500);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [
    applyRunCancellation,
    detail.conversation.id,
    detail.work_item.project_id,
    executionProjection?.run?.cancellation,
    onUnauthorized,
  ]);
  const resources = useMemo<ConversationResources>(
    () => ({
      planVersions: new Map(detail.plan_versions.map((version) => [version.id, version])),
      actions: new Map(detail.actions.map((action) => [action.id, action])),
      reviews: detail.plan_reviews,
      handoff: detail.handoff ?? null,
      excerptReceipts: new Map(
        (detail.planning_excerpt_receipts ?? []).map((receipt) => [receipt.id, receipt]),
      ),
      humanWaits: new Map(
        (detail.human_waits ?? []).map((view) => [view.wait.id, view as HumanWaitView]),
      ),
    }),
    [
      detail.actions,
      detail.handoff,
      detail.plan_reviews,
      detail.plan_versions,
      detail.planning_excerpt_receipts,
      detail.human_waits,
    ],
  );
  const initialMessages = useMemo(
    () =>
      detail.messages.map((message) =>
        toUiMessage(detail.work_item.project_id, message, resources),
      ),
    [detail.messages, detail.work_item.project_id, resources],
  );
  const runtime = useChatRuntime<NornsUIMessage>({
    id: detail.conversation.id,
    messages: initialMessages,
    transport,
    adapters: { attachments: attachmentAdapter },
    toCreateMessage: (message) => toCreateNornsMessage(detail.work_item.project_id, message),
    joinStrategy: "none",
    onData: (part) => {
      if (part.type === "data-attempt") setLatestAttempt(part.data as AttemptData);
      if (part.type === "data-usage") setLatestUsage(part.data as UsageData);
    },
    onError: (error) => {
      if (error instanceof UnauthorizedError) onUnauthorized();
      setStreamError(error.message);
    },
    onFinish: ({ isAbort }) => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(onRefreshSoft, isAbort ? 0 : 120);
    },
  });

  const changeConversationModel = useCallback(
    async (model: PmModelT) => {
      if (modelBusy || model === detail.conversation.model) return;
      setModelBusy(true);
      setModelError(null);
      try {
        const updated = await switchConversationModel(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          model,
        );
        onConversationModelChanged(updated);
      } catch (caught) {
        if (caught instanceof UnauthorizedError) onUnauthorized();
        else setModelError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setModelBusy(false);
      }
    },
    [
      detail.conversation.id,
      detail.conversation.model,
      detail.work_item.id,
      detail.work_item.project_id,
      modelBusy,
      onConversationModelChanged,
      onUnauthorized,
    ],
  );

  useEffect(
    () => () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  useEffect(() => {
    const scope = {
      projectId: detail.work_item.project_id,
      workItemId: detail.work_item.id,
      conversationId: detail.conversation.id,
    };
    const resolvedWaitIds = [...lockedHumanWaitAnswerIds].filter((waitId) => {
      const storedRequest = storedExactRequest(
        "human-wait-answer-proposal",
        waitId,
        V2CreateHumanWaitAnswerProposalInput.safeParse,
      );
      if (!storedRequest) return false;
      return detail.actions.some(
        (action) =>
          action.action_type === "answer_human_wait" &&
          action.payload.parameters.wait_id === waitId &&
          actionHasExactSourceReceipt(
            action,
            detail.messages,
            storedRequest.idempotency_key,
            scope,
          ),
      );
    });
    if (resolvedWaitIds.length === 0) return;
    for (const waitId of resolvedWaitIds) {
      clearDurableRequestKey("human-wait-answer-proposal", waitId, waitAnswerKeys.current);
      clearExactRequest("human-wait-answer-proposal", waitId);
    }
    setLockedHumanWaitAnswerIds((current) => {
      const next = new Set(current);
      for (const waitId of resolvedWaitIds) next.delete(waitId);
      return next;
    });
  }, [
    detail.actions,
    detail.conversation.id,
    detail.messages,
    detail.work_item.id,
    detail.work_item.project_id,
    lockedHumanWaitAnswerIds,
  ]);

  useEffect(() => {
    if (!lockedExecutionRequest) return;
    const resolved = detail.actions.some(
      (action) =>
        action.action_type === lockedExecutionRequest.action_type &&
        actionHasExactSourceReceipt(
          action,
          detail.messages,
          lockedExecutionRequest.idempotency_key,
          {
            projectId: detail.work_item.project_id,
            workItemId: detail.work_item.id,
            conversationId: detail.conversation.id,
          },
        ),
    );
    if (!resolved) return;
    clearDurableRequestKey(
      "execution-action-proposal",
      detail.conversation.id,
      executionActionKeys.current,
    );
    clearExactRequest("execution-action-proposal", detail.conversation.id);
    setLockedExecutionRequest(null);
  }, [
    detail.actions,
    detail.conversation.id,
    detail.messages,
    detail.work_item.id,
    detail.work_item.project_id,
    lockedExecutionRequest,
  ]);

  useEffect(() => {
    if (detail.conversation.kind !== "planning") return;
    let pendingActionId: string | null = null;
    try {
      pendingActionId = window.sessionStorage.getItem(
        approvalTransitionStorageKey(detail.conversation.id),
      );
    } catch {
      return;
    }
    if (!pendingActionId) return;
    const approval = detail.action_effects.find(
      (record) => record.action_id === pendingActionId && record.effect.kind === "plan_approved",
    );
    const targetId = approval ? executionConversationId(approval.effect) : null;
    if (!targetId) return;
    try {
      window.sessionStorage.removeItem(approvalTransitionStorageKey(detail.conversation.id));
    } catch {
      // Routing remains correct even when browser storage cannot be cleared.
    }
    onOpenConversation(targetId);
  }, [detail.action_effects, detail.conversation.id, detail.conversation.kind, onOpenConversation]);

  const awaitingBackgroundSettlement =
    detail.plan_reviews.some(
      (review) => review.status === "queued" || review.status === "running",
    ) ||
    detail.action_effects.some(
      (record) =>
        record.effect.kind === "plan_approved" && record.effect.execution.status === "pending",
    ) ||
    detail.actions.some((action) =>
      ["confirmed", "recorded", "sent", "agent_acknowledged"].includes(action.status),
    ) ||
    (detail.human_waits ?? []).some(
      ({ wait, continuation }) =>
        ["answered", "continuation_queued"].includes(wait.status) ||
        (continuation !== null &&
          ["queued", "dispatched", "acknowledged"].includes(continuation.status)),
    );

  useEffect(() => {
    if (!awaitingBackgroundSettlement) return;
    const timer = window.setTimeout(onRefreshSoft, 2_500);
    return () => window.clearTimeout(timer);
  }, [awaitingBackgroundSettlement, onRefreshSoft]);

  const generatePlanProposal = useCallback(
    async (intentMessage?: string, saveWhenReady = false, handoff?: V2PlanHandoffPreferenceT) => {
      if (proposalBusy) return;
      const conversationId = detail.conversation.id;
      const idempotencyKey = proposalKeyFor(conversationId, proposalKeys.current);
      setProposalBusy(true);
      setProposalProgress(null);
      setProposalError(null);
      try {
        window.sessionStorage.removeItem(proposalErrorStorageKey(conversationId));
      } catch {
        // Browser storage is optional; the current component still shows request state.
      }
      try {
        const generated = await streamConversationPlanProposal(
          detail.work_item.project_id,
          detail.work_item.id,
          conversationId,
          idempotencyKey,
          setProposalProgress,
          intentMessage,
          handoff,
        );
        proposalKeys.current.delete(conversationId);
        try {
          window.sessionStorage.removeItem(proposalStorageKey(conversationId));
          window.sessionStorage.removeItem(proposalErrorStorageKey(conversationId));
        } catch {
          // The durable proposal and action are already server-owned.
        }
        if (saveWhenReady) {
          const confirmationKey = confirmationKeyFor(generated.action, confirmationKeys.current);
          try {
            const saved = await confirmConversationAction(
              detail.work_item.project_id,
              detail.work_item.id,
              conversationId,
              generated.action.id,
              confirmationKey,
            );
            setActionOverrides((current) =>
              new Map(current).set(generated.action.id, saved.action),
            );
            setEffectOverrides((current) =>
              new Map(current).set(generated.action.id, saved.effect),
            );
            confirmationKeys.current.delete(generated.action.id);
            try {
              window.sessionStorage.removeItem(confirmationStorageKey(generated.action.id));
            } catch {
              // The plan is already durably saved.
            }
            if (handoff) {
              const afterSave = await getConversation(
                detail.work_item.project_id,
                detail.work_item.id,
                conversationId,
              );
              const handoffAction = afterSave.actions.find(
                (action) =>
                  action.action_type === "send_plan_to_qc" && action.status === "proposed",
              );
              if (!handoffAction) {
                throw new Error("The saved plan is missing its QC or start handoff.");
              }
              const handoffConfirmationKey = confirmationKeyFor(
                handoffAction,
                confirmationKeys.current,
              );
              const handedOff = await confirmConversationAction(
                detail.work_item.project_id,
                detail.work_item.id,
                conversationId,
                handoffAction.id,
                handoffConfirmationKey,
              );
              setActionOverrides((current) =>
                new Map(current).set(handoffAction.id, handedOff.action),
              );
              setEffectOverrides((current) =>
                new Map(current).set(handoffAction.id, handedOff.effect),
              );
              confirmationKeys.current.delete(handoffAction.id);
              if (handoff.review.mode === "skip_qc") {
                const afterWaiver = await getConversation(
                  detail.work_item.project_id,
                  detail.work_item.id,
                  conversationId,
                );
                const approvalAction = afterWaiver.actions.find(
                  (action) => action.action_type === "approve_plan" && action.status === "proposed",
                );
                if (!approvalAction) {
                  throw new Error("QC was skipped, but the plan is missing its start action.");
                }
                const approvalKey = confirmationKeyFor(approvalAction, confirmationKeys.current);
                const approved = await confirmConversationAction(
                  detail.work_item.project_id,
                  detail.work_item.id,
                  conversationId,
                  approvalAction.id,
                  approvalKey,
                );
                confirmationKeys.current.delete(approvalAction.id);
                setActionOverrides((current) =>
                  new Map(current).set(approvalAction.id, approved.action),
                );
                setEffectOverrides((current) =>
                  new Map(current).set(approvalAction.id, approved.effect),
                );
                const targetId = executionConversationId(approved.effect);
                if (targetId) {
                  onOpenConversation(targetId);
                  return;
                }
              }
            }
          } catch (caught) {
            if (caught instanceof UnauthorizedError) {
              onUnauthorized();
              return;
            }
            setProposalError(
              `The plan was created, but its handoff did not finish. Use the visible workflow action to retry. ${
                caught instanceof Error ? caught.message : String(caught)
              }`,
            );
          }
        }
        onRefresh();
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const prefix =
          caught instanceof ApiError
            ? ""
            : "Proposal generation status is uncertain. Retry to check the same request safely. ";
        const message = caught instanceof Error ? caught.message : String(caught);
        const visibleError = `${prefix}${message}`;
        setProposalError(visibleError);
        if (caught instanceof ApiError && caught.code === "proposal_failed") {
          proposalKeys.current.delete(conversationId);
          try {
            window.sessionStorage.removeItem(proposalStorageKey(conversationId));
          } catch {
            // A new user attempt will receive a fresh in-memory key.
          }
        }
        if (!(caught instanceof ApiError)) {
          try {
            window.sessionStorage.setItem(proposalErrorStorageKey(conversationId), visibleError);
          } catch {
            // The current component retains the visible uncertain status.
          }
          onRefresh();
        }
      } finally {
        setProposalBusy(false);
      }
    },
    [
      detail.conversation.id,
      detail.work_item.id,
      detail.work_item.project_id,
      onOpenConversation,
      onRefresh,
      onUnauthorized,
      proposalBusy,
    ],
  );

  const proposePlanChanges = useCallback(
    async (version: V2WorkPlanVersionT, direction: string): Promise<boolean> => {
      if (planChangeBusyId !== null) return false;
      const idempotencyKey = planChangeProposalKeyFor(version.id, planChangeKeys.current);
      setPlanChangeBusyId(version.id);
      setPlanChangeErrors((current) => {
        const next = new Map(current);
        next.delete(version.id);
        return next;
      });
      try {
        const result = await generateConversationPlanChangeProposal(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          {
            idempotency_key: idempotencyKey,
            plan_version_id: version.id,
            plan_hash: version.content_hash,
            direction,
          },
        );
        setActionOverrides((current) => new Map(current).set(result.action.id, result.action));
        planChangeKeys.current.delete(version.id);
        setPlanChangeLockedIds((current) => {
          const next = new Set(current);
          next.delete(version.id);
          return next;
        });
        try {
          window.sessionStorage.removeItem(planChangeProposalStorageKey(version.id));
        } catch {
          // The exact user-authored action is already durable.
        }
        onRefresh();
        return true;
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return false;
        }
        const uncertain = !(caught instanceof ApiError);
        const prefix = uncertain
          ? "Request status is uncertain. Retry the same locked direction safely. "
          : "";
        const message = caught instanceof Error ? caught.message : String(caught);
        setPlanChangeErrors((current) => new Map(current).set(version.id, `${prefix}${message}`));
        if (uncertain) {
          setPlanChangeLockedIds((current) => new Set(current).add(version.id));
        } else if (
          ["stale_plan_version", "stale_plan_hash", "proposal_failed"].includes(caught.code ?? "")
        ) {
          planChangeKeys.current.delete(version.id);
          try {
            window.sessionStorage.removeItem(planChangeProposalStorageKey(version.id));
          } catch {
            // A fresh request key will be created in component memory.
          }
        }
        return false;
      } finally {
        setPlanChangeBusyId(null);
      }
    },
    [
      detail.conversation.id,
      detail.work_item.id,
      detail.work_item.project_id,
      onRefresh,
      onUnauthorized,
      planChangeBusyId,
    ],
  );

  // Shared busy/error state machine for every review action below: guard
  // against a concurrent action on the same review, clear its prior error,
  // run the (possibly key-bearing) API call, then refresh or record the
  // failure. `round_cap_requires_raise` (QC-PAUSE-POINTS "Outcomes") is the
  // one error code with its own UI treatment — the gate offers to raise the
  // cap instead of just showing the message — so it's handled once here
  // rather than in each caller.
  const runReviewAction = useCallback(
    async <T,>(
      review: V2ConversationPlanReviewT,
      apiCall: () => Promise<T>,
      onSuccess?: (result: T) => void,
    ): Promise<void> => {
      if (reviewBusyId !== null) return;
      setReviewBusyId(review.id);
      // Clear the message but keep a capBlocked flag standing through the
      // retry — the raise-cap offer stays up while the raise request is in
      // flight, same as before this was one map instead of two containers.
      setReviewErrors((current) => {
        const next = new Map(current);
        const capBlocked = next.get(review.id)?.capBlocked;
        if (capBlocked) next.set(review.id, { message: "", capBlocked: true });
        else next.delete(review.id);
        return next;
      });
      try {
        const result = await apiCall();
        onSuccess?.(result);
        setReviewErrors((current) => {
          if (!current.has(review.id)) return current;
          const next = new Map(current);
          next.delete(review.id);
          return next;
        });
        onRefresh();
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const capBlocked = caught instanceof ApiError && caught.code === "round_cap_requires_raise";
        setReviewErrors((current) =>
          new Map(current).set(review.id, {
            message: caught instanceof Error ? caught.message : String(caught),
            ...(capBlocked ? { capBlocked: true } : {}),
          }),
        );
      } finally {
        setReviewBusyId(null);
      }
    },
    [onRefresh, onUnauthorized, reviewBusyId],
  );

  const cancelReview = useCallback(
    (review: V2ConversationPlanReviewT, reason: string): Promise<void> =>
      runReviewAction(review, () =>
        cancelConversationPlanReview(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          review.id,
          reason,
        ),
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  const stopAllWork = useCallback(
    async (review: V2ConversationPlanReviewT): Promise<void> => {
      if (reviewBusyId !== null) return;
      setReviewBusyId(review.id);
      setReviewErrors((current) => {
        const next = new Map(current);
        next.delete(review.id);
        return next;
      });
      const key = durableRequestKey("stop-all-work", review.id, reviewRecoveryKeys.current);
      try {
        const [qcResult, runsResult] = await Promise.allSettled([
          cancelConversationPlanReview(
            detail.work_item.project_id,
            detail.work_item.id,
            detail.conversation.id,
            review.id,
            "Stopped with all plan work by the user.",
          ),
          cancelAllProjectRuns(detail.work_item.project_id, {
            reason: "Stopped with the QC plan by the user.",
            idempotency_key: key,
          }),
        ]);
        const failure = [qcResult, runsResult].find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) throw failure.reason;
        if (runsResult.status === "fulfilled" && runsResult.value.failed_run_ids.length > 0) {
          throw new Error(
            `QC stopped, but ${runsResult.value.failed_run_ids.length} agent run${runsResult.value.failed_run_ids.length === 1 ? "" : "s"} could not be stopped.`,
          );
        }
        clearDurableRequestKey("stop-all-work", review.id, reviewRecoveryKeys.current);
        onRefresh();
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setReviewErrors((current) =>
          new Map(current).set(review.id, {
            message: caught instanceof Error ? caught.message : String(caught),
          }),
        );
        onRefreshSoft();
      } finally {
        setReviewBusyId(null);
      }
    },
    [
      detail.conversation.id,
      detail.work_item.id,
      detail.work_item.project_id,
      onRefresh,
      onRefreshSoft,
      onUnauthorized,
      reviewBusyId,
    ],
  );

  const continueReviewChat = useCallback(
    (
      review: V2ConversationPlanReviewT,
      channel: "reviewer" | "pm",
      message: string,
    ): Promise<void> =>
      runReviewAction(review, () =>
        continueConversationPlanReviewChat(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          review.id,
          channel,
          message,
        ),
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  const continueWithoutQc = useCallback(
    (review: V2ConversationPlanReviewT): Promise<void> =>
      runReviewAction(
        review,
        () => {
          const key = durableRequestKey("qc-waiver", review.id, reviewRecoveryKeys.current);
          return continueConversationWithoutQc(
            detail.work_item.project_id,
            detail.work_item.id,
            detail.conversation.id,
            review.id,
            key,
          );
        },
        (result) => {
          setActionOverrides((current) => new Map(current).set(result.action.id, result.action));
          setEffectOverrides((current) => new Map(current).set(result.action.id, result.effect));
          clearDurableRequestKey("qc-waiver", review.id, reviewRecoveryKeys.current);
        },
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  // Gate exits "Continue" and "Continue with a note" (QC-PAUSE-POINTS "Gate
  // exits" table) — both go through the one resume endpoint, distinguished by
  // `exit`. Idempotency keyed per exit so a retried click reuses the same
  // key while a distinct note send gets a fresh one.
  const resumeReview = useCallback(
    (
      review: V2ConversationPlanReviewT,
      exit: "continue" | "note",
      note?: { channel: "reviewer" | "pm"; message: string },
      stopAsking?: boolean,
    ): Promise<void> =>
      runReviewAction(
        review,
        () => {
          const key = durableRequestKey(`qc-resume-${exit}`, review.id, reviewRecoveryKeys.current);
          return resumeConversationPlanReview(
            detail.work_item.project_id,
            detail.work_item.id,
            detail.conversation.id,
            review.id,
            {
              exit,
              ...(note ? { note } : {}),
              ...(stopAsking ? { stopAsking: true } : {}),
              idempotency_key: key,
            },
          );
        },
        () => clearDurableRequestKey(`qc-resume-${exit}`, review.id, reviewRecoveryKeys.current),
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  const triageReview = useCallback(
    (
      review: V2ConversationPlanReviewT,
      decisions: Record<string, "accept" | "reject">,
    ): Promise<void> =>
      runReviewAction(
        review,
        () => {
          const key = durableRequestKey("qc-triage", review.id, reviewRecoveryKeys.current);
          return resumeConversationPlanReview(
            detail.work_item.project_id,
            detail.work_item.id,
            detail.conversation.id,
            review.id,
            {
              exit: "continue",
              findingDecisions: decisions,
              idempotency_key: key,
            },
          );
        },
        () => clearDurableRequestKey("qc-triage", review.id, reviewRecoveryKeys.current),
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  // Gate C ruling (QC-PAUSE-POINTS "Outcomes") — one ruling per contested
  // finding, submitted together. `raiseMaxRounds` is only ever true when the
  // caller is answering a prior `round_cap_requires_raise` failure, never
  // sent speculatively.
  const adjudicateReview = useCallback(
    (
      review: V2ConversationPlanReviewT,
      rulings: Record<string, { ruling: Ruling; rationale: string }>,
      note: { channel: "reviewer" | "pm"; message: string } | undefined,
      raiseMaxRounds: boolean,
    ): Promise<void> =>
      runReviewAction(
        review,
        () => {
          const key = durableRequestKey("qc-adjudicate", review.id, reviewRecoveryKeys.current);
          return adjudicateConversationPlanReview(
            detail.work_item.project_id,
            detail.work_item.id,
            detail.conversation.id,
            review.id,
            {
              rulings,
              ...(note ? { note } : {}),
              ...(raiseMaxRounds ? { raiseMaxRounds: true } : {}),
              idempotencyKey: key,
            },
          );
        },
        () => clearDurableRequestKey("qc-adjudicate", review.id, reviewRecoveryKeys.current),
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  // Mid-flight cadence edit and "hold at the next checkpoint" (QC-PAUSE-
  // POINTS.md "Settings: three layers", "Gate exits"). Both are the one
  // PATCH — checkpoints re-read qc_mode the next time they're reached.
  const patchReview = useCallback(
    (review: V2ConversationPlanReviewT, patch: { qcMode?: QcModeT }): Promise<void> =>
      runReviewAction(review, () =>
        patchConversationPlanReview(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          review.id,
          patch,
        ),
      ),
    [detail.conversation.id, detail.work_item.id, detail.work_item.project_id, runReviewAction],
  );

  const submitExecutionAction = useCallback(
    async (request: V2CreateExecutionActionProposalInputT): Promise<boolean> => {
      if (executionProposalBusy) return false;
      const subjectId = detail.conversation.id;
      setExecutionProposalBusy(true);
      setExecutionProposalError(null);
      setLockedExecutionRequest(request);
      storeExactRequest("execution-action-proposal", subjectId, request);
      try {
        const result = await proposeExecutionConversationAction(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          request,
        );
        setActionOverrides((current) => new Map(current).set(result.action.id, result.action));
        clearDurableRequestKey("execution-action-proposal", subjectId, executionActionKeys.current);
        clearExactRequest("execution-action-proposal", subjectId);
        setLockedExecutionRequest(null);
        onRefresh();
        return true;
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return false;
        }
        const uncertain = !(caught instanceof ApiError);
        setExecutionProposalError(
          `${
            uncertain ? "Proposal status is uncertain. Retry the same action values safely. " : ""
          }${caught instanceof Error ? caught.message : String(caught)}`,
        );
        if (!uncertain) {
          clearDurableRequestKey(
            "execution-action-proposal",
            subjectId,
            executionActionKeys.current,
          );
          clearExactRequest("execution-action-proposal", subjectId);
          setLockedExecutionRequest(null);
        }
        return false;
      } finally {
        setExecutionProposalBusy(false);
      }
    },
    [
      detail.conversation.id,
      detail.work_item.id,
      detail.work_item.project_id,
      executionProposalBusy,
      onRefresh,
      onUnauthorized,
    ],
  );

  const proposeExecutionAction = useCallback(
    async (
      actionType: V2CreateExecutionActionProposalInputT["action_type"],
      parameters: Record<string, unknown>,
    ): Promise<boolean> => {
      if (lockedExecutionRequest) return submitExecutionAction(lockedExecutionRequest);
      const subjectId = detail.conversation.id;
      const request: V2CreateExecutionActionProposalInputT = {
        idempotency_key: durableRequestKey(
          "execution-action-proposal",
          subjectId,
          executionActionKeys.current,
        ),
        message: executionActionMessage(actionType, parameters),
        action_type: actionType,
        payload: { parameters },
      };
      return submitExecutionAction(request);
    },
    [detail.conversation.id, lockedExecutionRequest, submitExecutionAction],
  );

  const prepareHumanWaitAnswer = useCallback(
    async (wait: V2HumanWaitT, answer: string, rationale: string | null): Promise<boolean> => {
      if (busyActionId !== null) return false;
      const storedRequest = storedExactRequest(
        "human-wait-answer-proposal",
        wait.id,
        V2CreateHumanWaitAnswerProposalInput.safeParse,
      );
      const request: V2CreateHumanWaitAnswerProposalInputT = storedRequest ?? {
        idempotency_key: durableRequestKey(
          "human-wait-answer-proposal",
          wait.id,
          waitAnswerKeys.current,
        ),
        expected_version: wait.version,
        question_hash: wait.question_hash,
        answer,
        rationale,
      };
      setBusyActionId(wait.id);
      storeExactRequest("human-wait-answer-proposal", wait.id, request);
      setLockedHumanWaitAnswerIds((current) => new Set(current).add(wait.id));
      setActionErrors((current) => {
        const next = new Map(current);
        next.delete(wait.id);
        return next;
      });
      try {
        const result = await proposeHumanWaitAnswer(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          wait.id,
          request,
        );
        setActionOverrides((current) => new Map(current).set(result.action.id, result.action));
        clearDurableRequestKey("human-wait-answer-proposal", wait.id, waitAnswerKeys.current);
        clearExactRequest("human-wait-answer-proposal", wait.id);
        setLockedHumanWaitAnswerIds((current) => {
          const next = new Set(current);
          next.delete(wait.id);
          return next;
        });
        onRefresh();
        return true;
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return false;
        }
        const uncertain = !(caught instanceof ApiError);
        setActionErrors((current) =>
          new Map(current).set(
            wait.id,
            `${
              uncertain
                ? "Answer status is uncertain. The exact draft is locked for a safe retry. "
                : ""
            }${caught instanceof Error ? caught.message : String(caught)}`,
          ),
        );
        if (!uncertain) {
          clearDurableRequestKey("human-wait-answer-proposal", wait.id, waitAnswerKeys.current);
          clearExactRequest("human-wait-answer-proposal", wait.id);
          setLockedHumanWaitAnswerIds((current) => {
            const next = new Set(current);
            next.delete(wait.id);
            return next;
          });
          onRefresh();
        }
        return false;
      } finally {
        setBusyActionId(null);
      }
    },
    [
      busyActionId,
      detail.conversation.id,
      detail.work_item.id,
      detail.work_item.project_id,
      onRefresh,
      onUnauthorized,
    ],
  );

  const savePmSettings = useCallback(
    async (input: {
      update_interval_seconds?: number | null;
      content_level?: "concise" | "standard" | "detailed" | null;
    }): Promise<void> => {
      if (pmSettingsBusy) return;
      setPmSettingsBusy(true);
      setPmSettingsError(null);
      try {
        setPmSettingsOverride(
          await updateConversationPmSettings(detail.work_item.project_id, input),
        );
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setPmSettingsError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setPmSettingsBusy(false);
      }
    },
    [detail.work_item.project_id, onUnauthorized, pmSettingsBusy],
  );

  const confirmAction = useCallback(
    async (action: V2ConversationActionT, qcMode?: QcModeT) => {
      if (busyActionId !== null) return;
      const idempotencyKey = confirmationKeyFor(action, confirmationKeys.current);
      if (action.action_type === "approve_plan") {
        try {
          window.sessionStorage.setItem(
            approvalTransitionStorageKey(detail.conversation.id),
            action.id,
          );
        } catch {
          // The response still carries the exact execution conversation target.
        }
      }
      setBusyActionId(action.id);
      setActionErrors((current) => {
        const next = new Map(current);
        next.delete(action.id);
        return next;
      });
      try {
        const startsQc =
          action.action_type === "send_plan_to_qc" &&
          (action.payload.parameters.review as { mode?: string } | undefined)?.mode !== "skip_qc";
        const result = await confirmConversationAction(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          action.id,
          idempotencyKey,
          startsQc ? "gated_when_contested" : qcMode,
        );
        setActionOverrides((current) => new Map(current).set(action.id, result.action));
        const effect = result.effect;
        setEffectOverrides((current) => new Map(current).set(action.id, effect));
        confirmationKeys.current.delete(action.id);
        try {
          window.sessionStorage.removeItem(confirmationStorageKey(action.id));
        } catch {
          // Durable server state remains authoritative when browser storage is unavailable.
        }
        const targetId = executionConversationId(result.effect);
        if (targetId) {
          try {
            window.sessionStorage.removeItem(approvalTransitionStorageKey(detail.conversation.id));
          } catch {
            // The exact target came from the approval response, so routing can continue.
          }
          onOpenConversation(targetId);
        } else {
          onRefresh();
        }
      } catch (caught) {
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const prefix =
          caught instanceof ApiError
            ? ""
            : "Confirmation status is uncertain. Retry this same action to check it safely. ";
        const message = caught instanceof Error ? caught.message : String(caught);
        setActionErrors((current) => new Map(current).set(action.id, `${prefix}${message}`));
        if (caught instanceof ApiError && action.action_type === "approve_plan") {
          try {
            window.sessionStorage.removeItem(approvalTransitionStorageKey(detail.conversation.id));
          } catch {
            // The current component still shows the authoritative API failure.
          }
        }
      } finally {
        setBusyActionId(null);
      }
    },
    [
      busyActionId,
      detail.conversation.id,
      detail.work_item.id,
      detail.work_item.project_id,
      onRefresh,
      onOpenConversation,
      onUnauthorized,
    ],
  );

  const actionContext = useMemo<ConversationActionContextValue>(() => {
    const actions = new Map(resources.actions);
    for (const [id, action] of actionOverrides) actions.set(id, action);
    const messageActionIds = new Set(
      detail.messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "action" ? [part.action_id] : [])),
      ),
    );
    const effects = new Map<string, ConversationActionEffect>(
      detail.action_effects.map((record) => [record.action_id, record.effect]),
    );
    for (const [id, effect] of effectOverrides) effects.set(id, effect);
    return {
      projectId: detail.work_item.project_id,
      workItemId: detail.work_item.id,
      conversationId: detail.conversation.id,
      actions,
      effects,
      deliveryEvents: detail.action_delivery_events ?? [],
      busyActionId,
      errors: actionErrors,
      confirm: confirmAction,
      prepareHumanWaitAnswer,
      lockedHumanWaitAnswerIds,
      refresh: onRefresh,
      planChangeBusyId,
      planChangeErrors,
      planChangeLockedIds,
      proposePlanChanges,
      reviewBusyId,
      reviewErrors,
      cancelReview,
      stopAllWork,
      continueReviewChat,
      continueWithoutQc,
      resumeReview,
      triageReview,
      adjudicateReview,
      patchReview,
      prepareExecutionAction: proposeExecutionAction,
      executionProposalBusy,
      executionProposalError,
      messageActionIds,
      onUnauthorized,
    };
  }, [
    actionErrors,
    actionOverrides,
    busyActionId,
    confirmAction,
    detail.conversation.id,
    detail.action_delivery_events,
    detail.action_effects,
    detail.work_item.id,
    detail.work_item.project_id,
    detail.messages,
    effectOverrides,
    executionProposalBusy,
    executionProposalError,
    lockedHumanWaitAnswerIds,
    planChangeBusyId,
    planChangeErrors,
    planChangeLockedIds,
    reviewBusyId,
    reviewErrors,
    cancelReview,
    stopAllWork,
    continueReviewChat,
    continueWithoutQc,
    resumeReview,
    triageReview,
    adjudicateReview,
    patchReview,
    prepareHumanWaitAnswer,
    proposePlanChanges,
    proposeExecutionAction,
    onUnauthorized,
    onRefresh,
    resources.actions,
  ]);

  const activePlanReview = detail.plan_reviews.find(
    (review) => review.status === "queued" || review.status === "running",
  );
  const hasApprovedPlan = detail.plan_versions.some((version) => version.status === "approved");
  const proposalBlockedReason = activePlanReview
    ? `Plan proposal updates are unavailable while QC is ${activePlanReview.status}.`
    : hasApprovedPlan
      ? "The approved plan is locked. Continue from the current execution state."
      : detail.work_item.status !== "planning"
        ? `Plan proposal updates are unavailable while work is ${detail.work_item.status.replaceAll("_", " ")}.`
        : null;
  const isPlanning = detail.conversation.kind === "planning";
  const isExecution = detail.conversation.kind === "execution_pm";
  const isReadOnly = detail.conversation.status !== "active";
  const conversationProvider = asAiProvider(detail.conversation.provider) ?? "anthropic";
  const hasEnteredQc = isPlanning && detail.plan_reviews.length > 0;
  const linkedExecutionConversationId = isPlanning
    ? (detail.handoff?.target_conversation_id ??
      [...actionContext.effects.values()]
        .map((effect) => executionConversationId(effect))
        .find((conversationId) => conversationId !== null) ??
      null)
    : null;
  // QCP-2B — QC-interim versions are never offered as a default target (for
  // execution, approval, or diff); the review's result version is.
  const latestPlan = [...detail.plan_versions]
    .filter(
      (version) =>
        version.origin !== "qc_interim" &&
        ["candidate", "in_qc", "changes_requested", "approved"].includes(version.status),
    )
    .sort((left, right) => right.version - left.version)[0];
  const taskOptions = Array.from(
    new Map(
      (isPlanning
        ? (latestPlan?.plan.plan.modules.map((module) => ({
            id: module.id,
            label: `${module.title} · ${module.id}`,
          })) ?? [])
        : (detail.handoff?.package.task_ids.map((taskId) => ({
            id: taskId,
            label: taskId,
          })) ?? [])
      ).map((option) => [option.id, option]),
    ).values(),
  );
  const latestReview = [...detail.plan_reviews].sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) ||
      right.attempt_number - left.attempt_number,
  )[0];
  const pendingQcPreference = [...actionContext.actions.values()]
    .filter((action) => action.action_type === "send_plan_to_qc")
    .map(
      (action) =>
        (action.payload.parameters.review as { mode?: string; rounds?: number } | undefined) ??
        null,
    )
    .find((review) => review?.mode === "qc");
  const plannedQcChecks = latestReview?.max_rounds ?? pendingQcPreference?.rounds ?? 0;
  const planHeaderSummary = latestPlan
    ? `QC checks planned: ${plannedQcChecks} · Agents: ${taskOptions.length}`
    : null;
  const artifactOptions = Array.from(
    new Set([
      ...(detail.handoff?.package.artifact_ids ?? []),
      ...(detail.latest_summary?.summary.artifact_ids ?? []),
    ]),
  ).map((artifactId) => ({ id: artifactId, label: artifactId }));
  const referencedActionIds = new Set(
    detail.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "action" ? [part.action_id] : [])),
    ),
  );
  const pendingSaveAction =
    [...actionContext.actions.values()].find(
      (action) => action.action_type === "save_plan_candidate" && action.status === "proposed",
    ) ?? null;
  const planIntentEnabled =
    isPlanning &&
    pendingSaveAction === null &&
    proposalBusy === false &&
    detail.active_attempt === null &&
    proposalBlockedReason === null;
  const editableMessages = useMemo(() => {
    if (
      !isPlanning ||
      isReadOnly ||
      detail.active_attempt !== null ||
      proposalBusy ||
      busyActionId !== null
    ) {
      return new Map<string, EditableConversationMessage>();
    }
    return new Map(
      detail.messages.flatMap((message): Array<[string, EditableConversationMessage]> => {
        const text = message.parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n\n")
          .trim();
        const safeParts = message.parts.every((part) => part.type === "text");
        if (
          message.role !== "user" ||
          message.actor.actor_type !== "human" ||
          message.visibility_status !== "complete" ||
          !safeParts ||
          !text
        ) {
          return [];
        }
        return [[message.id, { text }]];
      }),
    );
  }, [busyActionId, detail.active_attempt, detail.messages, isPlanning, isReadOnly, proposalBusy]);
  const editContext = useMemo<ConversationEditContextValue>(
    () => ({ messages: editableMessages, editMessage: onEditMessage }),
    [editableMessages, onEditMessage],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {initialMessage ? (
        <InitialConversationMessage
          text={initialMessage}
          onStarted={onInitialMessageStarted ?? (() => undefined)}
        />
      ) : null}
      <ConversationActionContext.Provider value={actionContext}>
        <ConversationEditContext.Provider value={editContext}>
          <section
            className="conversation-thread"
            aria-label={
              hasEnteredQc
                ? "Quality control workspace"
                : `${conversationKindLabel(detail.conversation.kind)} conversation`
            }
          >
            <div className="conversation-thread-chrome">
              {header(
                <>
                  <div className="conversation-header-model">
                    <span className="sr-only">Conversation model</span>
                    <Select
                      aria-label="Conversation model"
                      value={detail.conversation.model}
                      disabled={
                        modelBusy ||
                        detail.active_attempt !== null ||
                        proposalBusy ||
                        busyActionId !== null ||
                        isReadOnly
                      }
                      title={`${aiProviderLabel(conversationProvider)} ecosystem is locked for this conversation`}
                      onChange={(event) =>
                        void changeConversationModel(event.target.value as PmModelT)
                      }
                    >
                      {PM_MODEL_OPTIONS[conversationProvider].map((model) => (
                        <option key={model.id} value={model.id}>
                          {aiProviderLabel(conversationProvider)} · {model.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {isExecution ? (
                    <Button
                      className="btn-small conversation-agents-button"
                      aria-label={`Agents ${taskOptions.length}`}
                      aria-expanded={agentsOpen}
                      onClick={() => setAgentsOpen((open) => !open)}
                    >
                      Agents {taskOptions.length}
                    </Button>
                  ) : null}
                </>,
                executionTargetHeaderLabel(executionProjection),
                !isReadOnly && (!isPlanning || latestPlan !== undefined) ? (
                  <MockupRequestComposer
                    taskOptions={taskOptions}
                    planningPlanVersionId={isPlanning ? (latestPlan?.id ?? null) : null}
                    artifactOptions={artifactOptions}
                    busy={executionProposalBusy}
                    error={executionProposalError}
                    disabledReason={
                      lockedExecutionRequest ? "Retry the locked exact request first." : null
                    }
                    onPrepare={(parameters) => proposeExecutionAction("create_mockup", parameters)}
                  />
                ) : null,
                linkedExecutionConversationId ? (
                  <Button
                    className="btn-small"
                    aria-label="Open linked development chat"
                    onClick={() => onOpenConversation(linkedExecutionConversationId)}
                  >
                    Development chat
                  </Button>
                ) : null,
                planHeaderSummary,
              )}
            </div>
            {detail.branch_lineage ? (
              <aside
                className="conversation-branch-lineage"
                aria-label="Edited conversation branch"
              >
                <span aria-hidden="true">⑂</span>
                <div>
                  <strong>Edited branch</strong>
                  <small>
                    Created from message <code>{detail.branch_lineage.source_message_id}</code>. The
                    original conversation is unchanged.
                  </small>
                </div>
                <Button
                  className="btn-small"
                  variant="ghost"
                  onClick={() => {
                    const parentConversationId = detail.branch_lineage?.parent_conversation_id;
                    if (parentConversationId) onOpenConversation(parentConversationId);
                  }}
                >
                  Open original
                </Button>
              </aside>
            ) : null}
            {agentsOpen && isExecution ? (
              <>
                <button
                  type="button"
                  className="conversation-agents-backdrop"
                  aria-label="Close agent activity"
                  onClick={() => setAgentsOpen(false)}
                />
                <aside className="conversation-agents-drawer" aria-label="Agent activity">
                  <header>
                    <div>
                      <span className="eyebrow">Development</span>
                      <h2>Agent activity</h2>
                    </div>
                    <Button
                      className="btn-small"
                      variant="ghost"
                      aria-label="Close agent activity"
                      onClick={() => setAgentsOpen(false)}
                    >
                      ×
                    </Button>
                  </header>
                  <p>
                    {taskOptions.length} planned{" "}
                    {taskOptions.length === 1 ? "agent task" : "agent tasks"}. Direction and pause
                    requests remain proposals that must still be confirmed.
                  </p>
                  {taskOptions.length > 0 ? (
                    <ol className="conversation-agent-list">
                      {taskOptions.map((option) => (
                        <li key={`agent:${option.id}`}>
                          <span className="conversation-agent-indicator" aria-hidden="true" />
                          <div>
                            <strong>{option.label}</strong>
                            <small>Plan task · status available after dispatch</small>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="conversation-list-empty">
                      No development agents are configured yet.
                    </p>
                  )}
                  {executionProjection?.run ? (
                    <ProjectRunStopControl
                      key={executionProjection.run.run_id}
                      projectId={detail.work_item.project_id}
                      run={executionProjection.run}
                      onCancellation={applyRunCancellation}
                      onUnauthorized={onUnauthorized}
                    />
                  ) : null}
                </aside>
              </>
            ) : null}
            {!hasEnteredQc ? (
              <nav className="conversation-work-tabs" aria-label="Work sections">
                {isPlanning ? (
                  <button
                    type="button"
                    className={workTab === "plan" ? "on" : ""}
                    aria-current={workTab === "plan" ? "page" : undefined}
                    onClick={() => setWorkTab("plan")}
                  >
                    Plan with PM
                  </button>
                ) : (
                  <>
                    <span className="conversation-work-step is-complete">
                      {detail.handoff ? "Plan with PM ✓" : "Brief ✓"}
                    </span>
                    {detail.handoff && detail.project_runs_qc ? (
                      <span className="conversation-work-step is-complete">QC ✓</span>
                    ) : null}
                  </>
                )}
                <button
                  type="button"
                  className={workTab === "implementation" ? "on" : ""}
                  aria-current={workTab === "implementation" ? "page" : undefined}
                  onClick={() => {
                    if (isPlanning && linkedExecutionConversationId) {
                      onOpenConversation(linkedExecutionConversationId);
                      return;
                    }
                    setWorkTab("implementation");
                  }}
                >
                  Development chat
                </button>
              </nav>
            ) : null}
            {!hasEnteredQc &&
            ((isPlanning && workTab === "plan") ||
              (isExecution && workTab === "implementation")) ? (
              <div
                className={`workspace-tab-panel ${
                  isExecution
                    ? "conversation-work-tab-development-chat"
                    : "conversation-work-tab-plan"
                }`}
                data-testid={
                  isExecution ? "conversation-development-chat" : "conversation-work-tab-plan"
                }
              >
                {proposalBusy ? <PlanGenerationProgress progress={proposalProgress} /> : null}
                {proposalError ? (
                  <div className="conversation-thread-alert">
                    <Alert testId="conversation-plan-proposal-error">{proposalError}</Alert>
                  </div>
                ) : null}
                {detail.active_attempt ? (
                  <output className="conversation-active-run">
                    <span>
                      A PM response is {detail.active_attempt.status.replaceAll("_", " ")}.
                    </span>
                    <Button className="btn-small" onClick={onRefresh}>
                      Refresh status
                    </Button>
                  </output>
                ) : null}
                {!detail.active_attempt && detail.retryable_attempt ? (
                  <output className="conversation-active-run conversation-retryable-run">
                    <span>
                      The last PM response{" "}
                      {detail.retryable_attempt.status === "failed"
                        ? "failed before it completed"
                        : "was interrupted"}
                      .
                    </span>
                    <RetryTerminalResponseButton
                      onError={(message) => setStreamError(message || null)}
                    />
                  </output>
                ) : null}
                {streamError ? (
                  <div className="conversation-thread-alert">
                    <Alert testId="conversation-stream-error">{streamError}</Alert>
                  </div>
                ) : null}
                {modelError ? (
                  <div className="conversation-thread-alert">
                    <Alert testId="conversation-model-error">{modelError}</Alert>
                  </div>
                ) : null}
                {latestAttempt || latestUsage ? (
                  <div className="conversation-live-telemetry" aria-live="polite">
                    {latestAttempt ? (
                      <output className="conversation-turn-meta">
                        PM request: {latestAttempt.status.replaceAll("_", " ")}
                      </output>
                    ) : null}
                    {latestUsage ? (
                      <output className="conversation-turn-meta" data-testid="conversation-usage">
                        {latestUsage.input_tokens.toLocaleString()} in ·{" "}
                        {latestUsage.output_tokens.toLocaleString()} out · $
                        {latestUsage.cost_usd.toFixed(4)}
                      </output>
                    ) : null}
                  </div>
                ) : null}
                {detail.handoff || detail.latest_summary ? (
                  <section
                    className="conversation-context-receipt"
                    aria-label="Conversation context and usage"
                  >
                    {detail.handoff ? (
                      <HandoffCard
                        handoff={detail.handoff}
                        currentConversationId={detail.conversation.id}
                        onOpenConversation={onOpenConversation}
                      />
                    ) : null}
                    <div className="conversation-context-indicators">
                      {detail.latest_summary ? (
                        <ConversationSummaryIndicator summary={detail.latest_summary} />
                      ) : null}
                    </div>
                    <PlanningExcerptControl
                      key={`${detail.conversation.id}:${detail.handoff?.id ?? "no-handoff"}`}
                      detail={detail}
                      onOpenConversation={onOpenConversation}
                      onRefresh={onRefresh}
                      onUnauthorized={onUnauthorized}
                    />
                  </section>
                ) : null}
                <ThreadPrimitive.Root className="conversation-thread-root">
                  <ThreadPrimitive.Viewport
                    className="conversation-thread-viewport"
                    turnAnchor="bottom"
                    scrollToBottomOnThreadSwitch
                  >
                    <AuiIf condition={(state) => state.thread.messages.length === 0}>
                      <div className="conversation-welcome" data-testid="conversation-welcome">
                        <p>
                          {isExecution
                            ? detail.handoff
                              ? "Continue delivery with your PM. Planning context is available from the approved handoff."
                              : "Work directly with your development PM. The submitted brief defines this quick push."
                            : "Ask your PM about the work, constraints, risks, or next steps."}
                        </p>
                      </div>
                    </AuiIf>
                    <ThreadPrimitive.Messages>
                      {({ message }) =>
                        message.role === "user" ? (
                          <UserMessage />
                        ) : message.role === "system" ? (
                          <SystemMessage />
                        ) : (
                          <AssistantMessage />
                        )
                      }
                    </ThreadPrimitive.Messages>
                    <ThreadPrimitive.ViewportFooter className="conversation-composer-footer">
                      <ThreadPrimitive.ScrollToBottom
                        className="conversation-scroll-button"
                        aria-label="Scroll to latest message"
                      >
                        ↓ Latest
                      </ThreadPrimitive.ScrollToBottom>
                      {isReadOnly ? (
                        <output className="conversation-read-only">
                          <strong>
                            This {conversationKindLabel(detail.conversation.kind).toLowerCase()}{" "}
                            conversation is {detail.conversation.status.replaceAll("_", " ")}.
                          </strong>
                          <span>
                            {isPlanning
                              ? "Its visible history remains readable. Continue work in the linked Development chat."
                              : "Its visible history remains readable, but it no longer accepts messages."}
                          </span>
                        </output>
                      ) : (
                        <ConversationComposer
                          conversationId={detail.conversation.id}
                          isExecution={isExecution}
                          isPlanning={isPlanning}
                          pmProvider={conversationProvider}
                          planIntentEnabled={planIntentEnabled}
                          planIntentBusy={proposalBusy || busyActionId !== null}
                          onUseAsPlan={(message, handoff) => {
                            if (pendingSaveAction) {
                              void confirmAction(pendingSaveAction);
                              return;
                            }
                            void generatePlanProposal(message, true, handoff);
                          }}
                          prefillText={null}
                        />
                      )}
                    </ThreadPrimitive.ViewportFooter>
                  </ThreadPrimitive.Viewport>
                </ThreadPrimitive.Root>
              </div>
            ) : null}
            {hasEnteredQc ? (
              <div
                className="workspace-tab-panel conversation-work-tab-qc"
                data-testid="conversation-work-tab-qc"
              >
                <ConversationQcActivity
                  reviews={detail.plan_reviews}
                  planVersions={detail.plan_versions}
                />
              </div>
            ) : null}
            {!hasEnteredQc && workTab === "implementation" ? (
              <div
                className="workspace-tab-panel conversation-work-tab-implementation"
                data-testid="conversation-work-tab-implementation"
              >
                {isExecution && !isReadOnly ? (
                  <section
                    className="execution-conversation-controls"
                    aria-label="Execution controls"
                  >
                    <details>
                      <summary>Decisions, direction, pause, and artifacts</summary>
                      <ExecutionActionComposer
                        actions={[...actionContext.actions.values()]}
                        planVersions={detail.plan_versions}
                        busy={executionProposalBusy}
                        error={executionProposalError}
                        disabledReason={null}
                        lockedRequest={lockedExecutionRequest}
                        onPrepare={proposeExecutionAction}
                        onRetryLocked={() =>
                          lockedExecutionRequest
                            ? submitExecutionAction(lockedExecutionRequest)
                            : Promise.resolve(false)
                        }
                      />
                    </details>
                    <ExecutionActionHistory
                      actions={[...actionContext.actions.values()].filter(
                        (action) => !referencedActionIds.has(action.id),
                      )}
                      deliveryEvents={detail.action_delivery_events ?? []}
                      effects={actionContext.effects}
                      busyActionId={busyActionId}
                      errors={actionErrors}
                      onConfirm={confirmAction}
                    />
                    {(pmSettingsOverride ?? detail.pm_update_settings) ? (
                      <PmUpdateControls
                        settings={
                          (pmSettingsOverride ??
                            detail.pm_update_settings) as V2ConversationPmUpdateSettingsT
                        }
                        updates={detail.pm_updates ?? []}
                        busy={pmSettingsBusy}
                        error={pmSettingsError}
                        onSave={savePmSettings}
                      />
                    ) : null}
                  </section>
                ) : (
                  <div className="conversation-stage-placeholder">
                    <strong>Development has not started yet.</strong>
                    <p>
                      Approve the plan when it is ready. The Development chat will open here with
                      the approved scope and context.
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </ConversationEditContext.Provider>
      </ConversationActionContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function NewWorkForm({
  busy,
  defaultPin,
  modelError,
  projectContext,
  initialBrief,
  onCreate,
}: {
  busy: boolean;
  defaultPin: { provider: PmProviderT; model: PmModelT } | null;
  modelError: string | null;
  projectContext: {
    name: string | null;
    workspaceLocation: string | null;
    remoteLocation: string | null;
  } | null;
  initialBrief?: string | null;
  onCreate: (message: string, model: PmModelT, workflow: "phased" | "quick") => Promise<void>;
}): React.ReactElement {
  const [message, setMessage] = useState(initialBrief ?? "");
  const [model, setModel] = useState<PmModelT | null>(defaultPin?.model ?? null);
  const [workflow, setWorkflow] = useState<"phased" | "quick">("phased");
  useEffect(() => {
    if (defaultPin) setModel((current) => current ?? defaultPin.model);
  }, [defaultPin]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanMessage = message.trim();
    if (!cleanMessage || !model) return;
    void onCreate(cleanMessage, model, workflow);
  };
  const buildTarget =
    projectContext?.workspaceLocation ??
    projectContext?.remoteLocation ??
    "Configured during project setup";
  return (
    <section className="conversation-new-work" aria-labelledby="conversation-new-title">
      <div className="conversation-new-intro">
        <h2 id="conversation-new-title">Describe the project</h2>
      </div>
      <dl className="conversation-new-context" aria-label="Project setup context">
        <div>
          <dt>Project</dt>
          <dd>{projectContext?.name ?? "Current project"}</dd>
        </div>
        <div>
          <dt>Build target</dt>
          <dd title={buildTarget}>{buildTarget}</dd>
        </div>
      </dl>
      <fieldset className="conversation-workflow-picker">
        <legend>Choose how to start</legend>
        <label className={workflow === "phased" ? "is-selected" : ""}>
          <input
            type="radio"
            name="work-workflow"
            value="phased"
            checked={workflow === "phased"}
            disabled={busy}
            onChange={() => setWorkflow("phased")}
          />
          <span>
            <strong>Phased work</strong>
            <small>Plan with PM → optional QC → Development chat</small>
          </span>
        </label>
        <label className={workflow === "quick" ? "is-selected" : ""}>
          <input
            type="radio"
            name="work-workflow"
            value="quick"
            checked={workflow === "quick"}
            disabled={busy}
            onChange={() => setWorkflow("quick")}
          />
          <span>
            <strong>Quick push</strong>
            <small>Go directly to a Development chat for a small, clear change</small>
          </span>
        </label>
      </fieldset>
      <form className="conversation-new-composer" onSubmit={submit}>
        <TextArea
          data-testid="conversation-first-message"
          aria-label="Describe the work"
          rows={10}
          value={message}
          disabled={busy}
          placeholder="What should we build, change, or understand?"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="conversation-new-composer-actions">
          <div className="conversation-model-select">
            <span className="sr-only">Conversation model</span>
            <Select
              aria-label="Conversation model"
              value={model ?? ""}
              disabled={busy || defaultPin === null}
              onChange={(event) => setModel(event.target.value as PmModelT)}
            >
              {defaultPin === null ? <option value="">Loading model…</option> : null}
              {AI_PROVIDERS.map((provider) => (
                <optgroup key={provider} label={aiProviderLabel(provider)}>
                  {conversationModelOptions
                    .filter((option) => option.provider === provider)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <span>Enter to send · Shift+Enter for a new line</span>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !message.trim() || model === null}
            data-testid="conversation-create"
          >
            {busy ? "Starting…" : workflow === "phased" ? "Start Planning" : "Start Development"}
          </Button>
        </div>
      </form>
      {modelError ? <Alert>{modelError}</Alert> : null}
    </section>
  );
}

export function ConversationWorkspace({
  projectId,
  initialConversationId = null,
  initialNewConversation = false,
  initialBrief = null,
  onConversationSelected,
  onNewConversation,
  onUnsupported,
  onUnauthorized,
}: ConversationWorkspaceProps): React.ReactElement {
  const callbacks = useRef({
    onConversationSelected,
    onNewConversation,
    onUnauthorized,
    onUnsupported,
  });
  callbacks.current = {
    onConversationSelected,
    onNewConversation,
    onUnauthorized,
    onUnsupported,
  };
  const [groups, setGroups] = useState<WorkItemConversationGroup[] | null>(null);
  const [groupsLoadFailed, setGroupsLoadFailed] = useState(false);
  const [selected, setSelected] = useState<{
    workItemId: string;
    conversationId: string;
  } | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(initialNewConversation);
  const [newWorkInitialBrief, setNewWorkInitialBrief] = useState(initialBrief);
  const [projectPin, setProjectPin] = useState<{
    provider: PmProviderT;
    model: PmModelT;
  } | null>(null);
  const [projectContext, setProjectContext] = useState<{
    name: string | null;
    workspaceLocation: string | null;
    remoteLocation: string | null;
  } | null>(null);
  const [projectPinError, setProjectPinError] = useState<string | null>(null);
  const [conversationListOpen, setConversationListOpen] = useState(false);
  const [conversationSidebarCollapsed, setConversationSidebarCollapsed] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const [navigation, setNavigation] = useState<V2ConversationNavigationPageT | null>(null);
  const [organizationAvailable, setOrganizationAvailable] = useState<boolean | null>(null);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [organizationBusyWorkItemId, setOrganizationBusyWorkItemId] = useState<string | null>(null);
  const [folderEditor, setFolderEditor] = useState<{
    mode: "create" | "rename";
    folderId: string | null;
    name: string;
  } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [deleteWorkItemId, setDeleteWorkItemId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [lastResponseCopied, setLastResponseCopied] = useState(false);
  const [initialMessage, setInitialMessage] = useState<{
    conversationId: string;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renamingWorkItemId, setRenamingWorkItemId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<{
    workItemId: string;
    title: string;
    x: number;
    y: number;
    confirmDelete?: boolean;
  } | null>(null);
  const [threadVersion, setThreadVersion] = useState(0);
  const initialSelectionHandled = useRef<string | null>(null);
  const handleUnauthorized = useCallback(() => callbacks.current.onUnauthorized(), []);

  useEffect(() => {
    if (!conversationListOpen && !conversationMenu && !headerMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConversationMenu(null);
        setHeaderMenuOpen(false);
        setConversationListOpen(false);
      }
    };
    const closeMenu = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        (event.target.closest(".conversation-header-menu") !== null ||
          event.target.closest(".conversation-context-menu") !== null)
      ) {
        return;
      }
      setConversationMenu(null);
      setHeaderMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("click", closeMenu);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("click", closeMenu);
    };
  }, [conversationListOpen, conversationMenu, headerMenuOpen]);

  useEffect(() => {
    if (!showNew || projectPin) return;
    let current = true;
    setProjectPinError(null);
    void getProjectConversationPin(projectId)
      .then((pin) => {
        if (current) {
          setProjectPin(pin);
          setProjectContext(pin.project);
        }
      })
      .catch((caught) => {
        if (!current) return;
        if (caught instanceof UnauthorizedError) handleUnauthorized();
        else
          setProjectPinError(
            caught instanceof Error
              ? caught.message
              : "The conversation model could not be loaded.",
          );
      });
    return () => {
      current = false;
    };
  }, [handleUnauthorized, projectId, projectPin, showNew]);

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    },
    [handleUnauthorized],
  );

  const loadNavigation = useCallback(async () => {
    try {
      const firstPage = await listConversationNavigation(projectId);
      const items = [...firstPage.items];
      let cursor = firstPage.next_cursor;
      let pageCount = 1;
      while (cursor && pageCount < 5) {
        const page = await listConversationNavigation(projectId, { cursor });
        items.push(...page.items);
        cursor = page.next_cursor;
        pageCount += 1;
      }
      setNavigation({ ...firstPage, items, next_cursor: cursor });
      setOrganizationAvailable(true);
      setOrganizationError(
        cursor
          ? "Only the first 500 organized work items are shown. Refine your search to find older work."
          : null,
      );
      return;
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      if (
        (caught instanceof ApiError && (caught.status === 404 || caught.status === 501)) ||
        (caught instanceof Error && caught.message.includes("no route registered"))
      ) {
        setNavigation(null);
        setOrganizationAvailable(false);
        setOrganizationError(null);
        return;
      }
      setNavigation(null);
      setOrganizationAvailable(false);
      setOrganizationError(
        caught instanceof Error
          ? `Folders and pins are temporarily unavailable. ${caught.message}`
          : "Folders and pins are temporarily unavailable.",
      );
    }
  }, [handleUnauthorized, projectId]);

  const loadGroups = useCallback(async () => {
    try {
      const next = await listWorkItemConversations(projectId);
      setGroups(next);
      setGroupsLoadFailed(false);
      setError(null);
      return next;
    } catch (caught) {
      if (
        (caught instanceof ApiError && (caught.status === 404 || caught.status === 501)) ||
        (caught instanceof Error && caught.message.includes("no route registered"))
      ) {
        callbacks.current.onUnsupported?.();
        return null;
      }
      handleError(caught);
      setGroups([]);
      setGroupsLoadFailed(true);
      return null;
    }
  }, [handleError, projectId]);

  useEffect(() => {
    setGroups(null);
    setGroupsLoadFailed(false);
    setSelected(null);
    setDetail(null);
    setShowNew(initialNewConversation);
    setNewWorkInitialBrief(initialBrief);
    setProjectPin(null);
    setProjectContext(null);
    setProjectPinError(null);
    setConversationListOpen(false);
    setConversationSearch("");
    setNavigation(null);
    setOrganizationAvailable(null);
    setOrganizationError(null);
    setOrganizationBusyWorkItemId(null);
    setFolderEditor(null);
    setDeleteFolderId(null);
    setDeleteWorkItemId(null);
    setHeaderMenuOpen(false);
    setLastResponseCopied(false);
    setInitialMessage(null);
    setRenamingWorkItemId(null);
    setConversationMenu(null);
    initialSelectionHandled.current = null;
    void Promise.all([loadGroups(), loadNavigation()]);
  }, [initialBrief, initialNewConversation, loadGroups, loadNavigation]);

  useEffect(() => {
    if (!groups) return;
    if (initialConversationId) {
      const match = groups
        .flatMap((group) =>
          group.conversations.map((conversation) => ({
            workItemId: group.work_item.id,
            conversation,
          })),
        )
        .find(({ conversation }) => conversation.id === initialConversationId);
      if (match) {
        if (initialSelectionHandled.current !== initialConversationId) {
          if (
            selected?.workItemId !== match.workItemId ||
            selected.conversationId !== match.conversation.id
          ) {
            setSelected({
              workItemId: match.workItemId,
              conversationId: match.conversation.id,
            });
          }
          initialSelectionHandled.current = initialConversationId;
        }
        return;
      }
      if (initialSelectionHandled.current !== initialConversationId) {
        initialSelectionHandled.current = initialConversationId;
        setLoadingDetail(true);
        void resolveConversation(projectId, initialConversationId)
          .then((resolved) => {
            setSelected({
              workItemId: resolved.work_item.id,
              conversationId: resolved.conversation.id,
            });
            setDetail(resolved);
          })
          .catch(handleError)
          .finally(() => setLoadingDetail(false));
      }
      return;
    }

    if (selected || showNew || groupsLoadFailed) return;
    const latest = groups.flatMap((group) =>
      group.conversations.map((conversation) => ({
        workItemId: group.work_item.id,
        conversation,
      })),
    )[0];
    if (latest) {
      setSelected({
        workItemId: latest.workItemId,
        conversationId: latest.conversation.id,
      });
      callbacks.current.onConversationSelected?.(latest.conversation.id, true);
    } else {
      setShowNew(true);
    }
  }, [groups, groupsLoadFailed, handleError, initialConversationId, projectId, selected, showNew]);

  const loadDetail = useCallback(
    async (forceRemount = false) => {
      if (!selected) return;
      setLoadingDetail(true);
      try {
        const next = await getConversation(projectId, selected.workItemId, selected.conversationId);
        setDetail(next);
        setError(null);
        if (forceRemount) setThreadVersion((version) => version + 1);
      } catch (caught) {
        handleError(caught);
      } finally {
        setLoadingDetail(false);
      }
    },
    [handleError, projectId, selected],
  );

  useEffect(() => {
    if (!selected) return;
    if (
      detail?.conversation.id === selected.conversationId &&
      detail.work_item.id === selected.workItemId
    ) {
      return;
    }
    void loadDetail(true);
  }, [detail, loadDetail, selected]);

  const chooseConversation = (workItemId: string, conversation: V2WorkConversationT) => {
    setShowNew(false);
    setConversationListOpen(false);
    setInitialMessage(null);
    setRenamingWorkItemId(null);
    setConversationMenu(null);
    setDetail(null);
    setSelected({ workItemId, conversationId: conversation.id });
    callbacks.current.onConversationSelected?.(conversation.id);
  };

  const openConversationById = useCallback(
    async (conversationId: string) => {
      setShowNew(false);
      setLoadingDetail(true);
      try {
        const nextGroups = await loadGroups();
        const listed = nextGroups
          ?.flatMap((group) =>
            group.conversations.map((conversation) => ({
              workItemId: group.work_item.id,
              conversation,
            })),
          )
          .find((candidate) => candidate.conversation.id === conversationId);
        if (listed) {
          setDetail(null);
          setSelected({
            workItemId: listed.workItemId,
            conversationId: listed.conversation.id,
          });
        } else {
          const resolved = await resolveConversation(projectId, conversationId);
          setDetail(resolved);
          setSelected({
            workItemId: resolved.work_item.id,
            conversationId: resolved.conversation.id,
          });
          setThreadVersion((version) => version + 1);
        }
        callbacks.current.onConversationSelected?.(conversationId);
        setError(null);
      } catch (caught) {
        handleError(caught);
      } finally {
        setLoadingDetail(false);
      }
    },
    [handleError, loadGroups, projectId],
  );

  const editConversationMessage = useCallback(
    async (sourceMessageId: string, text: string) => {
      if (!detail) throw new Error("The conversation is no longer available to edit.");
      const parent = detail;
      try {
        const created = await createConversationMessageBranch(
          projectId,
          parent.work_item.id,
          parent.conversation.id,
          sourceMessageId,
        );
        setGroups(
          (current) =>
            current?.map((group) =>
              group.work_item.id === parent.work_item.id
                ? {
                    ...group,
                    conversations: group.conversations.some(
                      (candidate) => candidate.id === created.conversation.id,
                    )
                      ? group.conversations
                      : [...group.conversations, created.conversation],
                  }
                : group,
            ) ?? current,
        );
        setNavigation((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.id === parent.work_item.id
                    ? {
                        ...item,
                        conversation_count: item.conversation_count + 1,
                        latest_activity_at: created.conversation.updated_at,
                        latest_conversation: {
                          id: created.conversation.id,
                          kind: created.conversation.kind,
                          status: created.conversation.status,
                          provider: created.conversation.provider,
                          model: created.conversation.model,
                        },
                      }
                    : item,
                ),
              }
            : current,
        );
        setShowNew(false);
        setConversationListOpen(false);
        setConversationMenu(null);
        setDetail(null);
        setSelected({
          workItemId: parent.work_item.id,
          conversationId: created.conversation.id,
        });
        setInitialMessage({ conversationId: created.conversation.id, text });
        setThreadVersion((version) => version + 1);
        callbacks.current.onConversationSelected?.(created.conversation.id);
        setError(null);
      } catch (caught) {
        if (caught instanceof UnauthorizedError) handleUnauthorized();
        throw caught;
      }
    },
    [detail, handleUnauthorized, projectId],
  );

  const createWork = async (message: string, model: PmModelT, workflow: "phased" | "quick") => {
    setCreating(true);
    setError(null);
    try {
      const created = await createPlanningWorkItem(projectId, {
        title: titleForObjective(message),
        objective: message,
        model,
        workflow,
      });
      setNewWorkInitialBrief(null);
      setShowNew(false);
      setConversationListOpen(false);
      setInitialMessage({ conversationId: created.conversation.id, text: message });
      setDetail({
        work_item: created.work_item,
        conversation: created.conversation,
        messages: [],
        active_attempt: null,
        retryable_attempt: null,
        plan_versions: [],
        actions: [],
        plan_reviews: [],
        action_effects: [],
        project_runs_qc: false,
      });
      setSelected({
        workItemId: created.work_item.id,
        conversationId: created.conversation.id,
      });
      setThreadVersion((version) => version + 1);
      callbacks.current.onConversationSelected?.(created.conversation.id);
      void Promise.all([loadGroups(), loadNavigation()]);
    } catch (caught) {
      handleError(caught);
    } finally {
      setCreating(false);
    }
  };

  const renameWork = async (event: FormEvent, workItemId: string) => {
    event.preventDefault();
    if (!renameTitle.trim()) return;
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await renamePlanningWorkItem(projectId, workItemId, renameTitle.trim());
      setDetail((current) =>
        current?.work_item.id === updated.id ? { ...current, work_item: updated } : current,
      );
      setGroups(
        (current) =>
          current?.map((group) =>
            group.work_item.id === updated.id ? { ...group, work_item: updated } : group,
          ) ?? current,
      );
      setNavigation((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === updated.id ? { ...item, title: updated.title } : item,
              ),
            }
          : current,
      );
      setRenamingWorkItemId(null);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRenameBusy(false);
    }
  };

  const deleteWork = async (workItemId: string) => {
    if (deleteWorkItemId) return;
    setDeleteWorkItemId(workItemId);
    setError(null);
    try {
      await archivePlanningWorkItem(projectId, workItemId);
      setGroups(
        (current) => current?.filter((group) => group.work_item.id !== workItemId) ?? current,
      );
      setNavigation((current) =>
        current
          ? { ...current, items: current.items.filter((item) => item.id !== workItemId) }
          : current,
      );
      setConversationMenu(null);
      if (selected?.workItemId === workItemId) {
        setSelected(null);
        setDetail(null);
        setInitialMessage(null);
        setShowNew(true);
        callbacks.current.onNewConversation?.();
      }
      void Promise.all([loadGroups(), loadNavigation()]);
    } catch (caught) {
      handleError(caught);
    } finally {
      setDeleteWorkItemId(null);
    }
  };

  const refresh = useCallback(() => {
    void Promise.all([loadDetail(true), loadGroups(), loadNavigation()]);
  }, [loadDetail, loadGroups, loadNavigation]);

  const refreshSoft = useCallback(() => {
    void loadDetail(false);
  }, [loadDetail]);

  const sidebarFamilies = useMemo<SidebarConversationFamily[]>(() => {
    if (!groups) return [];
    const groupsById = new Map(groups.map((group) => [group.work_item.id, group]));
    const organized =
      navigation?.items.flatMap((item) => {
        const group = groupsById.get(item.id);
        if (!group) return [];
        groupsById.delete(item.id);
        return [{ group, organization: item }];
      }) ?? [];
    return [
      ...organized,
      ...groups
        .filter((group) => groupsById.has(group.work_item.id))
        .map((group) => ({ group, organization: null })),
    ];
  }, [groups, navigation]);

  const visibleFamilies = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase();
    if (!query) return sidebarFamilies;
    return sidebarFamilies.filter(
      ({ group, organization }) =>
        displayConversationTitle(organization?.title ?? group.work_item.title)
          .toLocaleLowerCase()
          .includes(query) ||
        group.conversations.some((conversation) =>
          `${conversationKindLabel(conversation.kind)} ${conversation.status}`
            .toLocaleLowerCase()
            .includes(query),
        ),
    );
  }, [conversationSearch, sidebarFamilies]);

  const searching = conversationSearch.trim().length > 0;
  const pinnedFamilies = searching
    ? []
    : visibleFamilies.filter(({ organization }) => organization?.pinned_at != null);
  const folderFamilies = (folderId: string) =>
    searching
      ? []
      : visibleFamilies.filter(
          ({ organization }) =>
            organization?.folder_id === folderId && organization.pinned_at === null,
        );
  const recentFamilies = searching
    ? visibleFamilies
    : visibleFamilies.filter(
        ({ organization }) =>
          organization === null ||
          (organization.folder_id === null && organization.pinned_at === null),
      );

  const changeOrganization = async (
    workItemId: string,
    input: { folder_id?: string | null; pinned?: boolean },
  ) => {
    if (!navigation || organizationBusyWorkItemId) return;
    const previous = navigation;
    setOrganizationBusyWorkItemId(workItemId);
    setOrganizationError(null);
    const now = new Date().toISOString();
    setNavigation((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.id === workItemId
                ? {
                    ...item,
                    ...(input.folder_id !== undefined ? { folder_id: input.folder_id } : {}),
                    ...(input.pinned !== undefined ? { pinned_at: input.pinned ? now : null } : {}),
                  }
                : item,
            ),
          }
        : current,
    );
    try {
      const organization = await updateWorkItemOrganization(projectId, workItemId, input);
      setNavigation((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === workItemId
                  ? {
                      ...item,
                      folder_id: organization.folder_id,
                      pinned_at: organization.pinned_at,
                    }
                  : item,
              ),
            }
          : current,
      );
      setConversationMenu(null);
    } catch (caught) {
      setNavigation(previous);
      setOrganizationError(caught instanceof Error ? caught.message : String(caught));
      void loadNavigation();
    } finally {
      setOrganizationBusyWorkItemId(null);
    }
  };

  const saveFolder = async (event: FormEvent) => {
    event.preventDefault();
    if (!folderEditor?.name.trim() || folderBusy) return;
    setFolderBusy(true);
    setOrganizationError(null);
    const previous = navigation;
    try {
      if (folderEditor.mode === "create") {
        const folder = await createConversationFolder(projectId, folderEditor.name.trim());
        setNavigation((current) =>
          current ? { ...current, folders: [...current.folders, folder] } : current,
        );
      } else if (folderEditor.folderId) {
        const folder = await updateConversationFolder(
          projectId,
          folderEditor.folderId,
          folderEditor.name.trim(),
        );
        setNavigation((current) =>
          current
            ? {
                ...current,
                folders: current.folders.map((candidate) =>
                  candidate.id === folder.id ? folder : candidate,
                ),
              }
            : current,
        );
      }
      setFolderEditor(null);
    } catch (caught) {
      setNavigation(previous);
      setOrganizationError(caught instanceof Error ? caught.message : String(caught));
      void loadNavigation();
    } finally {
      setFolderBusy(false);
    }
  };

  const confirmDeleteFolder = async (folder: V2ConversationFolderT) => {
    if (!navigation || folderBusy) return;
    const previous = navigation;
    setFolderBusy(true);
    setOrganizationError(null);
    setNavigation((current) =>
      current
        ? {
            ...current,
            folders: current.folders.filter((candidate) => candidate.id !== folder.id),
            items: current.items.map((item) =>
              item.folder_id === folder.id ? { ...item, folder_id: null } : item,
            ),
          }
        : current,
    );
    try {
      await deleteConversationFolder(projectId, folder.id);
      setDeleteFolderId(null);
    } catch (caught) {
      setNavigation(previous);
      setOrganizationError(caught instanceof Error ? caught.message : String(caught));
      void loadNavigation();
    } finally {
      setFolderBusy(false);
    }
  };

  const lastResponseText = useMemo(() => {
    const lastResponse = [...(detail?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!lastResponse) return null;
    const text = lastResponse.parts
      .flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "code") return [`\`\`\`${part.language ?? ""}\n${part.code}\n\`\`\``];
        return [];
      })
      .join("\n\n")
      .trim();
    return text || null;
  }, [detail?.messages]);

  const copyLastResponse = async () => {
    if (!lastResponseText) return;
    await navigator.clipboard.writeText(lastResponseText);
    setLastResponseCopied(true);
    window.setTimeout(() => setLastResponseCopied(false), 1500);
  };

  const renderConversationFamily = ({
    group,
    organization,
  }: SidebarConversationFamily): ReactNode => {
    const selectedInGroup =
      !showNew && selected?.workItemId === group.work_item.id
        ? group.conversations.find((conversation) => conversation.id === selected.conversationId)
        : null;
    const primaryConversation =
      selectedInGroup ??
      group.conversations.find((conversation) => conversation.status === "active") ??
      group.conversations[0];
    const familyActive = selectedInGroup !== null;
    const displayTitle = displayConversationTitle(organization?.title ?? group.work_item.title);
    return (
      <div
        className="conversation-work-group"
        data-folder-id={organization?.folder_id ?? undefined}
        key={group.work_item.id}
      >
        {renamingWorkItemId === group.work_item.id ? (
          <form
            className="conversation-list-rename"
            onSubmit={(event) => void renameWork(event, group.work_item.id)}
          >
            <Input
              aria-label="Work item title"
              value={renameTitle}
              maxLength={120}
              disabled={renameBusy}
              autoFocus
              onChange={(event) => setRenameTitle(event.target.value)}
            />
            <div>
              <Button
                className="btn-small"
                variant="primary"
                type="submit"
                disabled={renameBusy || !renameTitle.trim()}
              >
                {renameBusy ? "Saving…" : "Save"}
              </Button>
              <Button
                className="btn-small"
                type="button"
                disabled={renameBusy}
                onClick={() => setRenamingWorkItemId(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="conversation-family-row">
              <button
                type="button"
                className={`conversation-family-button${familyActive ? " is-active" : ""}`}
                data-status={primaryConversation?.status}
                aria-current={familyActive ? "page" : undefined}
                aria-label={`Open work item ${displayTitle}`}
                onClick={() => {
                  if (primaryConversation) {
                    chooseConversation(group.work_item.id, primaryConversation);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setConversationMenu({
                    workItemId: group.work_item.id,
                    title: group.work_item.title,
                    x: Math.min(event.clientX, window.innerWidth - 208),
                    y: Math.min(event.clientY, window.innerHeight - 240),
                  });
                }}
              >
                <ChatIcon />
                <span className="conversation-family-title" title={group.work_item.title}>
                  {displayTitle}
                </span>
              </button>
              <button
                type="button"
                className="conversation-family-menu"
                aria-label={`Actions for ${displayTitle}`}
                disabled={organizationBusyWorkItemId === group.work_item.id}
                onClick={(event) => {
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setConversationMenu({
                    workItemId: group.work_item.id,
                    title: group.work_item.title,
                    x: Math.min(bounds.right - 184, window.innerWidth - 208),
                    y: Math.min(bounds.bottom + 4, window.innerHeight - 240),
                  });
                }}
              >
                <span aria-hidden="true">•••</span>
              </button>
            </div>
            {group.conversations.length > 1 ? (
              <div className="conversation-thread-list" aria-label={`Threads in ${displayTitle}`}>
                {group.conversations.map((conversation) => {
                  const active = selected?.conversationId === conversation.id && !showNew;
                  return (
                    <button
                      type="button"
                      className={`conversation-list-item${active ? " is-active" : ""}`}
                      data-status={conversation.status}
                      aria-current={active ? "page" : undefined}
                      aria-label={`Open ${conversationKindLabel(conversation.kind)} conversation for ${group.work_item.title} (${conversation.status})`}
                      key={conversation.id}
                      onClick={() => chooseConversation(group.work_item.id, conversation)}
                    >
                      <ChatIcon />
                      <span className="conversation-list-item-title">
                        {conversationKindLabel(conversation.kind)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  };
  const menuOrganization = conversationMenu
    ? (navigation?.items.find((item) => item.id === conversationMenu.workItemId) ?? null)
    : null;

  const startNewWork = () => {
    if (!showNew) setNewWorkInitialBrief(null);
    setSelected(null);
    setDetail(null);
    setInitialMessage(null);
    setRenamingWorkItemId(null);
    setConversationMenu(null);
    setShowNew(true);
    setConversationListOpen(false);
    callbacks.current.onNewConversation?.();
  };

  const conversationHeader = (
    modelControl?: ReactNode,
    executionTargetLabel: string | null = null,
    toolControl?: ReactNode,
    primaryAction?: ReactNode,
    planSummary?: string | null,
  ) => (
    <header className="conversation-header">
      <Button
        className="btn-small conversation-sidebar-toggle"
        aria-expanded={!conversationSidebarCollapsed || conversationListOpen}
        aria-controls="project-conversations"
        aria-label="Expand work items"
        onClick={() => {
          setConversationSidebarCollapsed(false);
          setConversationListOpen(true);
        }}
      >
        <span aria-hidden="true">☰</span>
      </Button>
      <div className="conversation-header-identity">
        {executionTargetLabel ? (
          <span className="conversation-header-target">{executionTargetLabel}</span>
        ) : null}
        <h2>
          {showNew
            ? "Start new work"
            : detail
              ? displayConversationTitle(detail.work_item.title)
              : "Conversation"}
        </h2>
        {planSummary ? (
          <span className="conversation-header-plan-summary">{planSummary}</span>
        ) : null}
      </div>
      {!showNew && detail ? (
        <div className="conversation-header-actions">
          {primaryAction}
          <div className="conversation-header-menu">
            <Button
              className="btn-small"
              variant="ghost"
              aria-label="Chat options"
              aria-haspopup="dialog"
              aria-expanded={headerMenuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setHeaderMenuOpen((open) => !open);
              }}
            >
              <span aria-hidden="true">•••</span>
            </Button>
            <dialog
              className="conversation-header-menu-popover"
              aria-label="Chat options"
              open={headerMenuOpen}
            >
              <div className="conversation-header-menu-status">
                <span>Conversation</span>
                <Badge tone={detail.conversation.status === "active" ? "success" : "default"}>
                  {detail.conversation.status.replaceAll("_", " ")}
                </Badge>
              </div>
              {modelControl ? (
                <div
                  className="conversation-header-menu-section"
                  onClick={(event) => {
                    if (
                      event.target instanceof Element &&
                      event.target.closest(".conversation-agents-button") !== null
                    ) {
                      setHeaderMenuOpen(false);
                    }
                  }}
                  onKeyUp={(event) => {
                    if (
                      (event.key === "Enter" || event.key === " ") &&
                      event.target instanceof Element &&
                      event.target.closest(".conversation-agents-button") !== null
                    ) {
                      setHeaderMenuOpen(false);
                    }
                  }}
                >
                  <span>Model and agents</span>
                  {modelControl}
                </div>
              ) : null}
              {toolControl ? (
                <div className="conversation-header-menu-section">
                  <span>Tools</span>
                  {toolControl}
                </div>
              ) : null}
              <div className="conversation-header-menu-actions">
                <button
                  type="button"
                  disabled={loadingDetail}
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    void refresh();
                  }}
                >
                  {loadingDetail ? "Refreshing…" : "Refresh conversation"}
                </button>
                <button
                  type="button"
                  disabled={!lastResponseText}
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    void copyLastResponse();
                  }}
                >
                  {lastResponseCopied ? "Copied" : "Copy last response"}
                </button>
              </div>
            </dialog>
          </div>
        </div>
      ) : null}
    </header>
  );

  return (
    <div
      className={`conversation-workspace${conversationSidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
      data-testid="conversation-workspace"
    >
      {conversationListOpen ? (
        <button
          type="button"
          className="conversation-sidebar-backdrop"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setConversationListOpen(false)}
        />
      ) : null}
      <aside
        className={`conversation-sidebar${conversationSidebarCollapsed ? " is-collapsed" : ""}${conversationListOpen ? " is-mobile-open" : ""}`}
        id="project-conversations"
        aria-label="Project work items"
      >
        <div className="conversation-sidebar-head">
          <div className="conversation-sidebar-title">
            <span className="conversation-sidebar-mark" aria-hidden="true">
              N
            </span>
            <h2>Work items</h2>
          </div>
          <div>
            <Button
              className="btn-small conversation-sidebar-collapse"
              variant="ghost"
              aria-label={
                conversationSidebarCollapsed ? "Expand work items" : "Collapse work items"
              }
              onClick={() => setConversationSidebarCollapsed((collapsed) => !collapsed)}
            >
              <span aria-hidden="true">{conversationSidebarCollapsed ? "›" : "‹"}</span>
            </Button>
            <Button
              className="btn-small conversation-sidebar-close"
              variant="ghost"
              aria-label="Close work items"
              onClick={() => setConversationListOpen(false)}
            >
              <span aria-hidden="true">×</span>
            </Button>
          </div>
        </div>
        <div className="conversation-sidebar-content">
          <Button
            className="conversation-sidebar-new"
            aria-label="Start new work"
            onClick={startNewWork}
          >
            New work
          </Button>
          <div className="conversation-search">
            <Input
              type="search"
              aria-label="Search work"
              placeholder="Search work"
              value={conversationSearch}
              onChange={(event) => setConversationSearch(event.target.value)}
            />
          </div>
          {organizationError ? (
            <Alert testId="conversation-organization-error">{organizationError}</Alert>
          ) : null}
          {!searching ? (
            <>
              <section
                className="conversation-sidebar-section"
                aria-labelledby="conversation-pinned"
                data-organization-state={
                  organizationAvailable === null
                    ? "loading"
                    : organizationAvailable
                      ? "available"
                      : "legacy"
                }
              >
                <h3 id="conversation-pinned">Pinned</h3>
                {organizationAvailable === null ? (
                  <Spinner label="Loading pins…" />
                ) : pinnedFamilies.length > 0 ? (
                  <div className="conversation-list">
                    {pinnedFamilies.map(renderConversationFamily)}
                  </div>
                ) : (
                  <p className="conversation-list-empty">
                    {organizationAvailable
                      ? "No pinned work yet."
                      : "Pins are unavailable on this deployment."}
                  </p>
                )}
              </section>
              <section
                className="conversation-sidebar-section conversation-folder-section"
                aria-labelledby="conversation-folders"
                data-organization-state={
                  organizationAvailable === null
                    ? "loading"
                    : organizationAvailable
                      ? "available"
                      : "legacy"
                }
              >
                <div className="conversation-folder-heading">
                  <h3 id="conversation-folders">Folders</h3>
                  {organizationAvailable ? (
                    <button
                      type="button"
                      aria-label="Create folder"
                      onClick={() => setFolderEditor({ mode: "create", folderId: null, name: "" })}
                    >
                      ＋
                    </button>
                  ) : null}
                </div>
                {folderEditor ? (
                  <form className="conversation-folder-editor" onSubmit={saveFolder}>
                    <Input
                      aria-label={
                        folderEditor.mode === "create" ? "Folder name" : "New folder name"
                      }
                      value={folderEditor.name}
                      maxLength={80}
                      autoFocus
                      disabled={folderBusy}
                      onChange={(event) =>
                        setFolderEditor((current) =>
                          current ? { ...current, name: event.target.value } : current,
                        )
                      }
                    />
                    <div>
                      <Button
                        className="btn-small"
                        variant="primary"
                        type="submit"
                        disabled={folderBusy || !folderEditor.name.trim()}
                      >
                        {folderBusy
                          ? "Saving…"
                          : folderEditor.mode === "create"
                            ? "Create"
                            : "Rename"}
                      </Button>
                      <Button
                        className="btn-small"
                        type="button"
                        disabled={folderBusy}
                        onClick={() => setFolderEditor(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}
                {organizationAvailable === false ? (
                  <p className="conversation-list-empty">
                    Folders are unavailable on this deployment.
                  </p>
                ) : null}
                {organizationAvailable && navigation?.folders.length === 0 && !folderEditor ? (
                  <p className="conversation-list-empty">No folders yet.</p>
                ) : null}
                {navigation?.folders.map((folder) => {
                  const families = folderFamilies(folder.id);
                  return (
                    <div className="conversation-folder" key={folder.id}>
                      <div className="conversation-folder-row">
                        <FolderIcon />
                        <strong>{folder.name}</strong>
                        <span>{families.length}</span>
                        <button
                          type="button"
                          aria-label={`Rename folder ${folder.name}`}
                          disabled={folderBusy}
                          onClick={() =>
                            setFolderEditor({
                              mode: "rename",
                              folderId: folder.id,
                              name: folder.name,
                            })
                          }
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete folder ${folder.name}`}
                          disabled={folderBusy}
                          onClick={() => setDeleteFolderId(folder.id)}
                        >
                          Delete
                        </button>
                      </div>
                      {deleteFolderId === folder.id ? (
                        <div className="conversation-folder-delete" role="alert">
                          <span>Delete {folder.name}? Its work items move to Recent.</span>
                          <div>
                            <Button
                              className="btn-small"
                              variant="danger"
                              disabled={folderBusy}
                              onClick={() => void confirmDeleteFolder(folder)}
                            >
                              {folderBusy ? "Deleting…" : "Confirm delete"}
                            </Button>
                            <Button
                              className="btn-small"
                              disabled={folderBusy}
                              onClick={() => setDeleteFolderId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {families.length > 0 ? (
                        <div className="conversation-list">
                          {families.map(renderConversationFamily)}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            </>
          ) : null}
          <section
            className="conversation-sidebar-section conversation-recent"
            aria-labelledby="conversation-recent"
          >
            <h3 id="conversation-recent">{searching ? "Results" : "Recent"}</h3>
            {groups === null ? <Spinner label="Loading work items…" /> : null}
            {groups?.length === 0 ? (
              <p className="conversation-list-empty">No work items yet.</p>
            ) : null}
            {groups?.length && visibleFamilies.length === 0 ? (
              <p className="conversation-list-empty">No work items match your search.</p>
            ) : null}
            <div className="conversation-list">{recentFamilies.map(renderConversationFamily)}</div>
          </section>
        </div>
        {conversationSidebarCollapsed ? (
          <Button
            className="conversation-sidebar-collapsed-new"
            variant="ghost"
            aria-label="Start new work"
            onClick={startNewWork}
          >
            <ChatIcon />
          </Button>
        ) : null}
        {conversationMenu ? (
          <div
            className="conversation-context-menu"
            role="menu"
            aria-label="Conversation actions"
            style={{ left: conversationMenu.x, top: conversationMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setRenameTitle(conversationMenu.title);
                setRenamingWorkItemId(conversationMenu.workItemId);
                setConversationMenu(null);
              }}
            >
              Rename
            </button>
            {organizationAvailable && menuOrganization ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={organizationBusyWorkItemId === conversationMenu.workItemId}
                  onClick={() =>
                    void changeOrganization(conversationMenu.workItemId, {
                      pinned: menuOrganization.pinned_at === null,
                    })
                  }
                >
                  {menuOrganization.pinned_at ? "Unpin" : "Pin"}
                </button>
                <div className="conversation-context-menu-label">Move to folder</div>
                {menuOrganization.folder_id ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={organizationBusyWorkItemId === conversationMenu.workItemId}
                    onClick={() =>
                      void changeOrganization(conversationMenu.workItemId, { folder_id: null })
                    }
                  >
                    Remove from folder
                  </button>
                ) : null}
                {navigation?.folders.map((folder) => (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={
                      organizationBusyWorkItemId === conversationMenu.workItemId ||
                      menuOrganization.folder_id === folder.id
                    }
                    key={`move:${conversationMenu.workItemId}:${folder.id}`}
                    onClick={() =>
                      void changeOrganization(conversationMenu.workItemId, {
                        folder_id: folder.id,
                      })
                    }
                  >
                    {folder.name}
                  </button>
                ))}
              </>
            ) : null}
            <div className="conversation-context-menu-danger">
              {conversationMenu.confirmDelete ? (
                <>
                  <span>Delete this chat? Its history will be archived.</span>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={deleteWorkItemId === conversationMenu.workItemId}
                    onClick={() => void deleteWork(conversationMenu.workItemId)}
                  >
                    {deleteWorkItemId === conversationMenu.workItemId
                      ? "Deleting…"
                      : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={deleteWorkItemId === conversationMenu.workItemId}
                    onClick={() =>
                      setConversationMenu((current) =>
                        current ? { ...current, confirmDelete: false } : current,
                      )
                    }
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  onClick={() =>
                    setConversationMenu((current) =>
                      current ? { ...current, confirmDelete: true } : current,
                    )
                  }
                >
                  Delete chat
                </button>
              )}
            </div>
          </div>
        ) : null}
      </aside>

      <main className="conversation-main">
        {error ? (
          <div className="conversation-main-error">
            <Alert testId="conversation-error">{error}</Alert>
          </div>
        ) : null}
        {showNew ? conversationHeader() : null}
        {showNew ? (
          <NewWorkForm
            busy={creating}
            defaultPin={projectPin}
            modelError={projectPinError}
            projectContext={projectContext}
            initialBrief={newWorkInitialBrief}
            onCreate={createWork}
          />
        ) : null}
        {!showNew && detail ? (
          <>
            <ConversationThread
              key={`${detail.conversation.id}:${threadVersion}`}
              header={conversationHeader}
              detail={detail}
              initialMessage={
                initialMessage?.conversationId === detail.conversation.id
                  ? initialMessage.text
                  : null
              }
              onInitialMessageStarted={() => setInitialMessage(null)}
              onEditMessage={editConversationMessage}
              onOpenConversation={(conversationId) => void openConversationById(conversationId)}
              onConversationModelChanged={(conversation) => {
                setDetail((current) => (current ? { ...current, conversation } : current));
                setGroups(
                  (current) =>
                    current?.map((group) => ({
                      ...group,
                      conversations: group.conversations.map((candidate) =>
                        candidate.id === conversation.id ? conversation : candidate,
                      ),
                    })) ?? current,
                );
              }}
              onRefresh={refresh}
              onRefreshSoft={refreshSoft}
              onUnauthorized={handleUnauthorized}
            />
          </>
        ) : null}
        {!showNew && !detail && (groups === null || loadingDetail) ? (
          <div className="conversation-main-loading">
            <Spinner label={groups === null ? "Loading conversations…" : "Loading conversation…"} />
          </div>
        ) : null}
        {!showNew && !detail && groupsLoadFailed ? (
          <div className="conversation-main-loading conversation-load-retry">
            <p>Conversations could not be loaded.</p>
            <Button
              onClick={() => {
                setGroups(null);
                setGroupsLoadFailed(false);
                setError(null);
                void loadGroups();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
