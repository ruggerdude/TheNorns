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
} from "@assistant-ui/react";
import { AssistantChatTransport, useAISDKChat, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type {
  V2ConfirmConversationActionResponseT,
  V2ConversationActionDeliveryEventT,
  V2ConversationActionT,
  V2ConversationHandoffT,
  V2ConversationMockupVersionT,
  V2ConversationPlanActionEffectValueT,
  V2ConversationPlanReviewT,
  V2ConversationPlanningExcerptReceiptT,
  V2ConversationPmUpdateSettingsT,
  V2ConversationSummaryT,
  V2CreateExecutionActionProposalInputT,
  V2CreateHumanWaitAnswerProposalInputT,
  V2HumanWaitT,
  V2RequestPlanChangesParametersT,
  V2WorkConversationT,
  V2WorkMessagePartT,
  V2WorkMessageT,
  V2WorkPlanVersionT,
} from "@norns/contracts";
import {
  V2ConversationMockupVersion,
  V2CreateExecutionActionProposalInput,
  V2CreateHumanWaitAnswerProposalInput,
} from "@norns/contracts";
import type { ChatRequestOptions, CreateUIMessage, UIMessage, UIMessageChunk } from "ai";
import {
  type FormEvent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import remarkGfm from "remark-gfm";
import { ArtifactImage } from "./ArtifactImage";
import { ConversationActionCard } from "./ConversationActionCard";
import { ConversationPlanCard } from "./ConversationPlanCard";
import { ConversationQcCard } from "./ConversationQcCard";
import {
  ExecutionActionComposer,
  ExecutionActionHistory,
  HumanWaitCard,
  type HumanWaitView,
  MockupRequestComposer,
  PmUpdateControls,
} from "./ExecutionConversationControls";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import {
  type ConversationDetail,
  type ConversationUsageSummary,
  type SubmitConversationMessageBody,
  type WorkItemConversationGroup,
  confirmConversationAction,
  createPlanningWorkItem,
  generateConversationPlanChangeProposal,
  generateConversationPlanProposal,
  getConversation,
  listWorkItemConversations,
  messageEndpoint,
  proposeExecutionConversationAction,
  proposeHumanWaitAnswer,
  resolveConversation,
  retrieveConversationPlanningExcerpt,
  updateConversationPmSettings,
} from "./conversationApi";
import { Alert, Badge, Button, Field, Input, Spinner, TextArea } from "./ui";
import "./ConversationWorkspace.css";

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

type NornsDataParts = {
  artifact: ArtifactData;
  plan: PlanData;
  action: ActionData;
  handoff: HandoffData;
  "planning-excerpt": PlanningExcerptData;
  "human-wait": HumanWaitData;
  "human-wait-update": HumanWaitUpdateData;
  mockup: MockupData;
  attempt: AttemptData;
  usage: UsageData;
  "message-status": MessageStatusData;
};

type NornsMessageMetadata = {
  sequence?: number;
  visibility_status?: V2WorkMessageT["visibility_status"];
};

type NornsUIMessage = UIMessage<NornsMessageMetadata, NornsDataParts>;

interface ConversationWorkspaceProps {
  projectId: string;
  initialConversationId?: string | null;
  initialNewConversation?: boolean;
  onConversationSelected?: (conversationId: string, replace?: boolean) => void;
  onNewConversation?: () => void;
  onUnsupported?: () => void;
  onUnauthorized: () => void;
}

function conversationPath(projectId: string, workItemId: string, conversationId: string): string {
  return messageEndpoint(projectId, workItemId, conversationId);
}

function titleForObjective(objective: string): string {
  const firstLine = objective.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

function conversationKindLabel(kind: V2WorkConversationT["kind"]): string {
  if (kind === "planning") return "Planning";
  if (kind === "execution_pm") return "Execution PM";
  return "Task";
}

function attachmentIdFromUrl(url: string): string | null {
  const match = /\/attachments\/([^/?#]+)(?:[?#]|$)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
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
          name: part.filename?.trim() || "Image attachment",
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
  return response;
};

class NornsConversationTransport extends AssistantChatTransport<NornsUIMessage> {
  constructor(private readonly conversationBase: string) {
    super({
      api: `${conversationBase}/messages`,
      credentials: "include",
      fetch: conversationFetch,
      headers: () => authHeaders(true),
      prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
        if (trigger === "regenerate-message") {
          const triggeringMessage = precedingUserMessage(messages, messageId);
          if (!triggeringMessage) throw new Error("No user message is available to retry.");
          return {
            api: `${conversationBase}/retry`,
            credentials: "include",
            headers: authHeaders(true),
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
          headers: authHeaders(true),
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

type ConversationActionContextValue = {
  projectId: string;
  workItemId: string;
  conversationId: string;
  actions: Map<string, V2ConversationActionT>;
  effects: Map<string, ConversationActionEffect>;
  deliveryEvents: V2ConversationActionDeliveryEventT[];
  busyActionId: string | null;
  errors: Map<string, string>;
  confirm: (action: V2ConversationActionT) => Promise<void>;
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
  prepareExecutionAction: (
    actionType: V2CreateExecutionActionProposalInputT["action_type"],
    parameters: Record<string, unknown>,
  ) => Promise<boolean>;
  executionProposalBusy: boolean;
  executionProposalError: string | null;
  onUnauthorized: () => void;
};

const ConversationActionContext = createContext<ConversationActionContextValue | null>(null);

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
      sequence: message.sequence,
      visibility_status: message.visibility_status,
    },
    parts,
  };
}

function createConversationAttachmentAdapter(
  projectId: string,
  onUnauthorized: () => void,
): AttachmentAdapter {
  return {
    accept: "image/png,image/jpeg,image/webp,image/gif",
    async add({ file }): Promise<PendingAttachment> {
      const response = await fetch(`/api/v2/projects/${projectId}/attachments`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...authHeaders(),
          "content-type": file.type,
          "x-attachment-purpose": "conversation",
        },
        body: file,
      });
      if (response.status === 401) {
        onUnauthorized();
        throw new UnauthorizedError();
      }
      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
      };
      if (!response.ok || !payload.id) {
        throw new Error(payload.message ?? `Upload failed (${response.status}).`);
      }
      return {
        id: payload.id,
        type: "image",
        name: file.name,
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
    },
    async send(attachment) {
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          {
            type: "image",
            image: `/api/v2/projects/${projectId}/attachments/${encodeURIComponent(attachment.id)}`,
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
        throw new Error(`Could not remove the image (${response.status}).`);
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

function FilePreview({ filename, mimeType, data }: FileMessagePartProps): React.ReactElement {
  const image = mimeType.startsWith("image/");
  return (
    <a
      className="conversation-attachment-card"
      href={data}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${filename ?? "attachment"}`}
    >
      {image ? (
        <img src={data} alt={filename ?? "Attached image"} />
      ) : (
        <span aria-hidden="true">▧</span>
      )}
      <span>{filename ?? "Attachment"}</span>
    </a>
  );
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
        action.status !== "rejected",
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
          disabled={context.executionProposalBusy || mockup.task_id === null}
          title={mockup.task_id === null ? "Approval requires a task-scoped mockup." : undefined}
          onClick={() =>
            void context.prepareExecutionAction("approve_mockup", {
              ...exactReference,
              task_id: mockup.task_id,
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

function PlanPreview({ data }: DataMessagePartProps<PlanData>): React.ReactElement {
  if (!data.version) return <ReferenceCard data={data} />;
  return (
    <>
      <ConversationPlanCard version={data.version} />
      {data.reviews.map((review: V2ConversationPlanReviewT) => (
        <ConversationQcCard key={review.id} planVersion={data.version} review={review} />
      ))}
      <PlanChangeControl version={data.version} reviews={data.reviews} />
    </>
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

function usageSummary(usage: ConversationUsageSummary): string {
  if (usage.usage_status === "pending") return "Usage is still settling";
  if (usage.usage_status === "unavailable") return "Usage is unavailable";
  const tokens = usage.input_tokens + usage.output_tokens;
  const cost =
    usage.cost_usd === null
      ? "cost unavailable"
      : `${usage.exact_cost ? "" : "estimated "}$${usage.cost_usd.toFixed(4)}`;
  return `${tokens.toLocaleString()} tokens · ${cost} · ${usage.attempt_count.toLocaleString()} request${
    usage.attempt_count === 1 ? "" : "s"
  }`;
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
        aria-label={
          isTarget ? "Open archived planning conversation" : "Open execution PM conversation"
        }
        onClick={() => onOpenConversation(linkedConversationId)}
      >
        {isTarget ? "Open archived planning" : "Open execution PM"}
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
  return (
    <AttachmentPrimitive.Root className="conversation-composer-attachment">
      <AttachmentPrimitive.unstable_Thumb />
      <AttachmentPrimitive.Name />
      <AttachmentPrimitive.Remove aria-label="Remove attachment">×</AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function UserMessage(): React.ReactElement {
  return (
    <MessagePrimitive.Root className="conversation-message is-user">
      <div className="conversation-message-label">You</div>
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

function AssistantMessage(): React.ReactElement {
  return (
    <MessagePrimitive.Root className="conversation-message is-assistant">
      <div className="conversation-message-label">PM</div>
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
  return (
    <MessagePrimitive.Root className="conversation-message is-system">
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
    return window.sessionStorage.getItem(proposalErrorStorageKey(conversationId));
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

function ConversationThread({
  detail,
  onOpenConversation,
  onRefresh,
  onUnauthorized,
}: {
  detail: ConversationDetail;
  onOpenConversation: (conversationId: string) => void;
  onRefresh: () => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [streamError, setStreamError] = useState<string | null>(null);
  const [latestAttempt, setLatestAttempt] = useState<AttemptData | null>(null);
  const [latestUsage, setLatestUsage] = useState<UsageData | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(() =>
    storedProposalError(detail.conversation.id),
  );
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [planChangeBusyId, setPlanChangeBusyId] = useState<string | null>(null);
  const [planChangeErrors, setPlanChangeErrors] = useState(() => new Map<string, string>());
  const [planChangeLockedIds, setPlanChangeLockedIds] = useState(() => new Set<string>());
  const [executionProposalBusy, setExecutionProposalBusy] = useState(false);
  const [executionProposalError, setExecutionProposalError] = useState<string | null>(null);
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
      refreshTimer.current = window.setTimeout(onRefresh, isAbort ? 0 : 120);
    },
  });

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
    const timer = window.setTimeout(onRefresh, 2_500);
    return () => window.clearTimeout(timer);
  }, [awaitingBackgroundSettlement, onRefresh]);

  const generatePlanProposal = useCallback(async () => {
    if (proposalBusy) return;
    const conversationId = detail.conversation.id;
    const idempotencyKey = proposalKeyFor(conversationId, proposalKeys.current);
    setProposalBusy(true);
    setProposalError(null);
    try {
      window.sessionStorage.removeItem(proposalErrorStorageKey(conversationId));
    } catch {
      // Browser storage is optional; the current component still shows request state.
    }
    try {
      await generateConversationPlanProposal(
        detail.work_item.project_id,
        detail.work_item.id,
        conversationId,
        idempotencyKey,
      );
      proposalKeys.current.delete(conversationId);
      try {
        window.sessionStorage.removeItem(proposalStorageKey(conversationId));
        window.sessionStorage.removeItem(proposalErrorStorageKey(conversationId));
      } catch {
        // The durable proposal and action are already server-owned.
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
  }, [
    detail.conversation.id,
    detail.work_item.id,
    detail.work_item.project_id,
    onRefresh,
    onUnauthorized,
    proposalBusy,
  ]);

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
    async (action: V2ConversationActionT) => {
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
        const result = await confirmConversationAction(
          detail.work_item.project_id,
          detail.work_item.id,
          detail.conversation.id,
          action.id,
          idempotencyKey,
        );
        setActionOverrides((current) => new Map(current).set(action.id, result.action));
        setEffectOverrides((current) => new Map(current).set(action.id, result.effect));
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
      prepareExecutionAction: proposeExecutionAction,
      executionProposalBusy,
      executionProposalError,
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
    effectOverrides,
    executionProposalBusy,
    executionProposalError,
    lockedHumanWaitAnswerIds,
    planChangeBusyId,
    planChangeErrors,
    planChangeLockedIds,
    prepareHumanWaitAnswer,
    proposePlanChanges,
    proposeExecutionAction,
    onUnauthorized,
    onRefresh,
    resources.actions,
  ]);

  const hasPlanProposal =
    detail.plan_versions.length > 0 ||
    detail.actions.some(
      (action) => action.action_type === "save_plan_candidate" && action.status === "proposed",
    );
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
  const proposalHelpId = `conversation-plan-proposal-help-${detail.conversation.id}`;
  const isPlanning = detail.conversation.kind === "planning";
  const isExecution = detail.conversation.kind === "execution_pm";
  const isReadOnly = detail.conversation.status !== "active";
  const latestPlan = detail.plan_versions.at(-1);
  const taskOptions = Array.from(
    new Map(
      [
        ...(latestPlan?.plan.plan.modules.map((module) => ({
          id: module.id,
          label: `${module.title} · ${module.id}`,
        })) ?? []),
        ...(detail.handoff?.package.task_ids.map((taskId) => ({
          id: taskId,
          label: taskId,
        })) ?? []),
      ].map((option) => [option.id, option]),
    ).values(),
  );
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ConversationActionContext.Provider value={actionContext}>
        <section
          className="conversation-thread"
          aria-label={`${conversationKindLabel(detail.conversation.kind)} conversation`}
        >
          {detail.conversation.kind === "planning" && detail.conversation.status === "active" ? (
            <div className="conversation-plan-proposal-control">
              <div>
                <strong>
                  {hasPlanProposal ? "Update the plan proposal" : "Ready for a plan?"}
                </strong>
                <span id={proposalHelpId}>
                  {proposalBlockedReason ??
                    "The PM will create a structured draft from this conversation. Saving it remains a separate confirmation."}
                </span>
              </div>
              <Button
                className="btn-small"
                disabled={
                  proposalBusy || detail.active_attempt !== null || proposalBlockedReason !== null
                }
                aria-describedby={proposalHelpId}
                aria-label={hasPlanProposal ? "Update plan proposal" : "Create plan proposal"}
                onClick={() => void generatePlanProposal()}
              >
                {proposalBusy
                  ? "Generating proposal…"
                  : hasPlanProposal
                    ? "Update plan proposal"
                    : "Create plan proposal"}
              </Button>
            </div>
          ) : null}
          {(isPlanning || isExecution) && !isReadOnly ? (
            <MockupRequestComposer
              taskOptions={isExecution ? taskOptions : []}
              artifactOptions={artifactOptions}
              busy={executionProposalBusy}
              error={executionProposalError}
              disabledReason={
                lockedExecutionRequest ? "Retry the locked exact request first." : null
              }
              onPrepare={(parameters) => proposeExecutionAction("create_mockup", parameters)}
            />
          ) : null}
          {isExecution && !isReadOnly ? (
            <section className="execution-conversation-controls" aria-label="Execution controls">
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
          ) : null}
          {proposalError ? (
            <div className="conversation-thread-alert">
              <Alert testId="conversation-plan-proposal-error">{proposalError}</Alert>
            </div>
          ) : null}
          {detail.active_attempt ? (
            <output className="conversation-active-run">
              <span>A PM response is {detail.active_attempt.status.replaceAll("_", " ")}.</span>
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
              <RetryTerminalResponseButton onError={(message) => setStreamError(message || null)} />
            </output>
          ) : null}
          {streamError ? (
            <div className="conversation-thread-alert">
              <Alert testId="conversation-stream-error">{streamError}</Alert>
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
          {detail.handoff || detail.latest_summary || detail.usage ? (
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
                ) : (
                  <span data-testid="conversation-summary-empty">No compacted summary</span>
                )}
                {detail.usage ? (
                  <output data-testid="conversation-total-usage">
                    <strong>Conversation usage</strong>
                    <span>{usageSummary(detail.usage)}</span>
                  </output>
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
              turnAnchor="top"
              scrollToBottomOnThreadSwitch
            >
              <AuiIf condition={(state) => state.thread.messages.length === 0}>
                <div className="conversation-welcome" data-testid="conversation-welcome">
                  <div className="eyebrow">
                    {isExecution ? "Execution PM conversation" : "Planning conversation"}
                  </div>
                  <h2>
                    {isExecution
                      ? "Continue delivery with your PM"
                      : "Talk through the work with your PM"}
                  </h2>
                  <p>
                    {isExecution
                      ? "This fresh conversation starts from the approved compact handoff. Planning discussion is available only when you explicitly retrieve an excerpt."
                      : "Discuss the objective, constraints, risks, or possible approaches. Project state changes will always appear as explicit actions for you to confirm."}
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
                        ? "Its visible history remains readable. Continue work in the linked execution PM conversation."
                        : "Its visible history remains readable, but it no longer accepts messages."}
                    </span>
                  </output>
                ) : (
                  <ComposerPrimitive.Root className="conversation-composer">
                    <ComposerPrimitive.Attachments>
                      {() => <ComposerAttachment />}
                    </ComposerPrimitive.Attachments>
                    <ComposerPrimitive.Input
                      className="conversation-composer-input"
                      placeholder={
                        isExecution ? "Message the execution PM…" : "Message the project PM…"
                      }
                      aria-label={
                        isExecution ? "Message the execution PM" : "Message the project PM"
                      }
                      submitMode="enter"
                      unstable_insertNewlineOnTouchEnter
                      rows={2}
                    />
                    <div className="conversation-composer-actions">
                      <ComposerPrimitive.AddAttachment
                        className="conversation-icon-button"
                        aria-label="Add image"
                      >
                        + Image
                      </ComposerPrimitive.AddAttachment>
                      <span className="conversation-keyboard-help">
                        Enter to send · Shift+Enter for a new line
                      </span>
                      <ComposerPrimitive.Cancel
                        className="conversation-stop-button"
                        aria-label="Stop response"
                      >
                        Stop
                      </ComposerPrimitive.Cancel>
                      <ComposerPrimitive.Send
                        className="conversation-send-button"
                        aria-label="Send message"
                      >
                        Send
                      </ComposerPrimitive.Send>
                    </div>
                  </ComposerPrimitive.Root>
                )}
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </section>
      </ConversationActionContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function NewWorkForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (title: string, objective: string) => Promise<void>;
}): React.ReactElement {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanObjective = objective.trim();
    if (!cleanObjective) return;
    void onCreate(title.trim() || titleForObjective(cleanObjective), cleanObjective);
  };
  return (
    <section className="conversation-new-work" aria-labelledby="conversation-new-title">
      <div>
        <div className="eyebrow">New planning conversation</div>
        <h2 id="conversation-new-title">What work should the PM help you plan?</h2>
        <p className="muted">
          This creates a durable work item and pins the project’s current PM provider and model for
          the full conversation.
        </p>
      </div>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Title (optional)">
          <Input
            value={title}
            disabled={busy}
            placeholder="Short name for this work"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Objective">
          <TextArea
            data-testid="conversation-objective"
            value={objective}
            disabled={busy}
            placeholder="Describe the outcome, constraints, and anything the PM should know…"
            onChange={(event) => setObjective(event.target.value)}
          />
        </Field>
        <Button
          variant="primary"
          type="submit"
          disabled={busy || !objective.trim()}
          data-testid="conversation-create"
        >
          {busy ? "Creating…" : "Start planning conversation"}
        </Button>
      </form>
    </section>
  );
}

export function ConversationWorkspace({
  projectId,
  initialConversationId = null,
  initialNewConversation = false,
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
  const [selected, setSelected] = useState<{
    workItemId: string;
    conversationId: string;
  } | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(initialNewConversation);
  const [error, setError] = useState<string | null>(null);
  const [threadVersion, setThreadVersion] = useState(0);
  const initialSelectionHandled = useRef<string | null>(null);

  const handleUnauthorized = useCallback(() => callbacks.current.onUnauthorized(), []);

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

  const loadGroups = useCallback(async () => {
    try {
      const next = await listWorkItemConversations(projectId);
      setGroups(next);
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
      return null;
    }
  }, [handleError, projectId]);

  useEffect(() => {
    setGroups(null);
    setSelected(null);
    setDetail(null);
    setShowNew(initialNewConversation);
    initialSelectionHandled.current = null;
    void loadGroups();
  }, [initialNewConversation, loadGroups]);

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

    if (selected || showNew) return;
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
  }, [groups, handleError, initialConversationId, projectId, selected, showNew]);

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

  const createWork = async (title: string, objective: string) => {
    setCreating(true);
    setError(null);
    try {
      const created = await createPlanningWorkItem(projectId, { title, objective });
      await loadGroups();
      setShowNew(false);
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
      });
      setSelected({
        workItemId: created.work_item.id,
        conversationId: created.conversation.id,
      });
      setThreadVersion((version) => version + 1);
      callbacks.current.onConversationSelected?.(created.conversation.id);
    } catch (caught) {
      handleError(caught);
    } finally {
      setCreating(false);
    }
  };

  const refresh = useCallback(() => {
    void Promise.all([loadDetail(true), loadGroups()]);
  }, [loadDetail, loadGroups]);

  return (
    <div className="conversation-workspace" data-testid="conversation-workspace">
      <aside className="conversation-sidebar" aria-label="Project conversations">
        <div className="conversation-sidebar-head">
          <div>
            <div className="eyebrow">Work</div>
            <h2>Conversations</h2>
          </div>
          <Button
            className="btn-small"
            aria-label="Start new work"
            onClick={() => {
              setSelected(null);
              setDetail(null);
              setShowNew(true);
              callbacks.current.onNewConversation?.();
            }}
          >
            New
          </Button>
        </div>
        {groups === null ? <Spinner label="Loading conversations…" /> : null}
        {groups?.length === 0 ? (
          <p className="conversation-list-empty">No conversations yet.</p>
        ) : null}
        <div className="conversation-list">
          {groups?.map((group) => (
            <section className="conversation-work-group" key={group.work_item.id}>
              <h3>{group.work_item.title}</h3>
              <p>{group.work_item.objective}</p>
              {group.conversations.map((conversation) => {
                const active = selected?.conversationId === conversation.id && !showNew;
                const usage = group.conversation_usage?.[conversation.id];
                return (
                  <button
                    type="button"
                    className={`conversation-list-item${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={`Open ${conversationKindLabel(conversation.kind)} conversation for ${group.work_item.title} (${conversation.status})`}
                    key={conversation.id}
                    onClick={() => chooseConversation(group.work_item.id, conversation)}
                  >
                    <span>{conversationKindLabel(conversation.kind)}</span>
                    <strong>
                      {conversation.provider} · {conversation.model}
                    </strong>
                    <small>
                      {conversation.status}
                      {usage ? ` · ${usageSummary(usage)}` : " · usage unavailable"}
                    </small>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      </aside>

      <main className="conversation-main">
        {error ? (
          <div className="conversation-main-error">
            <Alert testId="conversation-error">{error}</Alert>
          </div>
        ) : null}
        {showNew ? <NewWorkForm busy={creating} onCreate={createWork} /> : null}
        {!showNew && detail ? (
          <>
            <header className="conversation-header">
              <div>
                <div className="eyebrow">
                  {conversationKindLabel(detail.conversation.kind)} conversation
                </div>
                <h2>{detail.work_item.title}</h2>
                <p>{detail.work_item.objective}</p>
              </div>
              <div className="conversation-header-actions">
                <div className="conversation-model-pin" data-testid="conversation-model-pin">
                  <span aria-hidden="true">●</span>
                  <span>
                    <small>PM pinned for this conversation</small>
                    <strong>
                      {detail.conversation.provider} · {detail.conversation.model}
                    </strong>
                  </span>
                </div>
                <Badge tone={detail.conversation.status === "active" ? "success" : "default"}>
                  {detail.conversation.status}
                </Badge>
                <Button
                  className="btn-small"
                  disabled={loadingDetail}
                  onClick={refresh}
                  aria-label="Refresh conversation"
                >
                  {loadingDetail ? "Refreshing…" : "Refresh"}
                </Button>
              </div>
            </header>
            <ConversationThread
              key={`${detail.conversation.id}:${threadVersion}`}
              detail={detail}
              onOpenConversation={(conversationId) => void openConversationById(conversationId)}
              onRefresh={refresh}
              onUnauthorized={handleUnauthorized}
            />
          </>
        ) : null}
        {!showNew && !detail && loadingDetail ? (
          <div className="conversation-main-loading">
            <Spinner label="Loading conversation…" />
          </div>
        ) : null}
      </main>
    </div>
  );
}
