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
import type { V2WorkConversationT, V2WorkMessagePartT, V2WorkMessageT } from "@norns/contracts";
import type { ChatRequestOptions, CreateUIMessage, UIMessage, UIMessageChunk } from "ai";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { ApiError, UnauthorizedError, authHeaders } from "./auth";
import {
  type ConversationDetail,
  type SubmitConversationMessageBody,
  type WorkItemConversationGroup,
  createPlanningWorkItem,
  getConversation,
  listWorkItemConversations,
  messageEndpoint,
  resolveConversation,
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

type NornsDataParts = {
  artifact: ArtifactData;
  plan: ReferenceData;
  action: ReferenceData;
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

function messagePartToUi(projectId: string, part: V2WorkMessagePartT): NornsUIMessage["parts"] {
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
          data: { id: part.plan_version_id, label: "Plan candidate" },
        },
      ];
    case "action":
      return [
        {
          type: "data-action",
          data: { id: part.action_id, label: "Action awaiting confirmation" },
        },
      ];
  }
}

function toUiMessage(projectId: string, message: V2WorkMessageT): NornsUIMessage {
  const parts = message.parts.flatMap((part) => messagePartToUi(projectId, part));
  if (message.visibility_status === "interrupted") {
    parts.push({
      type: "data-message-status",
      data: { status: "interrupted" },
    });
  }
  return {
    id: message.id,
    role: message.role,
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

function ReferencePreview({ data }: DataMessagePartProps<ReferenceData>): React.ReactElement {
  return (
    <article className="conversation-reference-card">
      <strong>{data.label}</strong>
      <code>{data.id}</code>
    </article>
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
                plan: ReferencePreview,
                action: ReferencePreview,
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
                plan: ReferencePreview,
                action: ReferencePreview,
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
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
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

function ConversationThread({
  detail,
  onRefresh,
  onUnauthorized,
}: {
  detail: ConversationDetail;
  onRefresh: () => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [streamError, setStreamError] = useState<string | null>(null);
  const [latestAttempt, setLatestAttempt] = useState<AttemptData | null>(null);
  const [latestUsage, setLatestUsage] = useState<UsageData | null>(null);
  const refreshTimer = useRef<number | null>(null);
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
  const initialMessages = useMemo(
    () => detail.messages.map((message) => toUiMessage(detail.work_item.project_id, message)),
    [detail.messages, detail.work_item.project_id],
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="conversation-thread" aria-label="Planning conversation">
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
        <ThreadPrimitive.Root className="conversation-thread-root">
          <ThreadPrimitive.Viewport
            className="conversation-thread-viewport"
            turnAnchor="top"
            scrollToBottomOnThreadSwitch
          >
            <AuiIf condition={(state) => state.thread.messages.length === 0}>
              <div className="conversation-welcome" data-testid="conversation-welcome">
                <div className="eyebrow">Planning conversation</div>
                <h2>Talk through the work with your PM</h2>
                <p>
                  Discuss the objective, constraints, risks, or possible approaches. Project state
                  changes will always appear as explicit actions for you to confirm.
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
              <ComposerPrimitive.Root className="conversation-composer">
                <ComposerPrimitive.Attachments>
                  {() => <ComposerAttachment />}
                </ComposerPrimitive.Attachments>
                <ComposerPrimitive.Input
                  className="conversation-composer-input"
                  placeholder="Message the project PM…"
                  aria-label="Message the project PM"
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
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </section>
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
                return (
                  <button
                    type="button"
                    className={`conversation-list-item${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    key={conversation.id}
                    onClick={() => chooseConversation(group.work_item.id, conversation)}
                  >
                    <span>
                      {conversation.kind === "planning"
                        ? "Planning"
                        : conversation.kind === "execution_pm"
                          ? "Execution PM"
                          : "Task"}
                    </span>
                    <strong>
                      {conversation.provider} · {conversation.model}
                    </strong>
                    <small>{conversation.status}</small>
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
                  {detail.conversation.kind === "planning"
                    ? "Planning conversation"
                    : detail.conversation.kind.replaceAll("_", " ")}
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
