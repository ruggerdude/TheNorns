import { useEffect, useState } from "react";
import { UnauthorizedError } from "./auth";
import {
  type ConversationUsageSummary,
  type WorkItemConversationGroup,
  listWorkItemConversations,
} from "./conversationApi";
import { Alert, Badge, Button, Spinner } from "./ui";

function kindLabel(kind: WorkItemConversationGroup["conversations"][number]["kind"]): string {
  if (kind === "planning") return "Plan with PM";
  if (kind === "execution_pm") return "Development chat";
  return "Task";
}

function usageLabel(usage: ConversationUsageSummary | undefined): string {
  if (!usage || usage.usage_status === "unavailable") return "Usage unavailable";
  if (usage.usage_status === "pending") return "Usage settling";
  const tokens = usage.input_tokens + usage.output_tokens;
  const cost =
    usage.cost_usd === null
      ? "cost unavailable"
      : `${usage.exact_cost ? "" : "estimated "}$${usage.cost_usd.toFixed(4)}`;
  return `${tokens.toLocaleString()} tokens · ${cost}`;
}

export function ConversationOverview({
  projectId,
  onOpenConversation,
  onUnauthorized,
}: {
  projectId: string;
  onOpenConversation: (conversationId: string) => void;
  onUnauthorized: () => void;
}): React.ReactElement {
  const [groups, setGroups] = useState<WorkItemConversationGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setError(null);
    void listWorkItemConversations(projectId)
      .then((result) => {
        if (cancelled) return;
        setGroups(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setGroups([]);
        setError(caught instanceof Error ? caught.message : "Conversations could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized, projectId]);

  const conversationCount =
    groups?.reduce((total, group) => total + group.conversations.length, 0) ?? 0;

  return (
    <section
      className="card project-conversation-overview"
      data-testid="project-conversation-overview"
      aria-labelledby="project-conversation-overview-title"
    >
      <div className="section-head">
        <div>
          <div className="eyebrow">Work items</div>
          <h2 id="project-conversation-overview-title">Planning and development chats</h2>
        </div>
        <span className="muted">{groups ? `${conversationCount} total` : "Loading…"}</span>
      </div>
      {error ? <Alert testId="conversation-overview-error">{error}</Alert> : null}
      {!groups ? <Spinner label="Loading project work items…" /> : null}
      {groups?.length === 0 && !error ? (
        <div className="history-empty">
          <strong>No work items yet</strong>
          <span>Planning and Development chats will remain linked here.</span>
        </div>
      ) : null}
      <div className="project-conversation-overview-list">
        {groups?.map((group) => (
          <article className="project-conversation-overview-item" key={group.work_item.id}>
            <header>
              <div>
                <h3>{group.work_item.title}</h3>
                <p>{group.work_item.objective}</p>
              </div>
              <Badge
                tone={
                  group.work_item.status === "completed"
                    ? "success"
                    : group.work_item.status === "planning"
                      ? "warn"
                      : "info"
                }
              >
                {group.work_item.status.replaceAll("_", " ")}
              </Badge>
            </header>
            <ol aria-label={`Conversations for ${group.work_item.title}`}>
              {group.conversations.map((conversation) => {
                const usage = group.conversation_usage?.[conversation.id];
                return (
                  <li key={conversation.id}>
                    <div>
                      <span className="project-conversation-kind">
                        {kindLabel(conversation.kind)}
                      </span>
                      <strong>{conversation.status.replaceAll("_", " ")}</strong>
                      <small>{usageLabel(usage)}</small>
                    </div>
                    <Button
                      className="btn-small"
                      aria-label={`Open ${kindLabel(conversation.kind)} conversation for ${group.work_item.title}`}
                      onClick={() => onOpenConversation(conversation.id)}
                    >
                      Open
                    </Button>
                  </li>
                );
              })}
            </ol>
          </article>
        ))}
      </div>
    </section>
  );
}
