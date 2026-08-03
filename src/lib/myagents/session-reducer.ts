import type {
  ChatMessage,
  ConversationItem,
  SessionStreamEvent,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";

function appendAssistant(
  messages: ChatMessage[],
  id: string,
  text: string,
): ChatMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === id);
  if (index < 0) {
    next.push({
      id,
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString(),
    });
  } else {
    next[index] = { ...next[index], content: next[index].content + text };
  }
  return next;
}

function appendAssistantToConversation(
  conversation: ConversationItem[],
  id: string,
  text: string,
): ConversationItem[] {
  const next = [...conversation];
  const index = next.findIndex(
    (item) => item.type === "message" && item.message.id === id,
  );
  if (index < 0) {
    next.push({
      type: "message",
      message: {
        id,
        role: "assistant",
        content: text,
        createdAt: new Date().toISOString(),
      },
    });
  } else {
    const item = next[index];
    if (item.type === "message") {
      next[index] = {
        type: "message",
        message: { ...item.message, content: item.message.content + text },
      };
    }
  }
  return next;
}

function upsertActivity(
  items: ToolActivity[],
  activity: ToolActivity,
): ToolActivity[] {
  const next = [...items];
  const index = next.findIndex((item) => item.id === activity.id);
  if (index < 0) next.push(activity);
  else next[index] = activity;
  return next;
}

function upsertConversationActivity(
  conversation: ConversationItem[],
  activity: ToolActivity,
): ConversationItem[] {
  const next = [...conversation];
  const index = next.findIndex(
    (item) => item.type === "tool" && item.activity.id === activity.id,
  );
  if (index < 0) next.push({ type: "tool", activity });
  else next[index] = { type: "tool", activity };
  return next;
}

export function applySessionEvent(
  session: SessionSummary,
  event: SessionStreamEvent,
): SessionSummary {
  if (event.type === "assistant_delta") {
    return {
      ...session,
      messages: appendAssistant(session.messages, event.messageId, event.text),
      conversation: appendAssistantToConversation(
        session.conversation,
        event.messageId,
        event.text,
      ),
    };
  }
  if (event.type === "tool") {
    return {
      ...session,
      activities: upsertActivity(session.activities, event.activity),
      conversation: upsertConversationActivity(
        session.conversation,
        event.activity,
      ),
    };
  }
  if (event.type === "permission") {
    return {
      ...session,
      pendingPermissions: [
        ...session.pendingPermissions.filter(
          (item) => item.id !== event.permission.id,
        ),
        event.permission,
      ],
      conversation: [
        ...session.conversation.filter(
          (item) =>
            item.type !== "permission" ||
            item.permission.id !== event.permission.id,
        ),
        { type: "permission", permission: event.permission },
      ],
    };
  }
  if (event.type === "permission_resolved") {
    return {
      ...session,
      pendingPermissions: session.pendingPermissions.filter(
        (item) => item.id !== event.permissionId,
      ),
      conversation: session.conversation.filter(
        (item) =>
          item.type !== "permission" ||
          item.permission.id !== event.permissionId,
      ),
    };
  }
  if (event.type === "status") return { ...session, status: event.status };
  if (event.type === "config_options") {
    return { ...session, configOptions: event.configOptions };
  }
  if (event.type === "error") {
    return { ...session, status: "error", error: event.message };
  }
  return session;
}
