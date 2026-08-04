import type {
  ChatMessage,
  ConversationItem,
  MessageContentBlock,
  SessionStreamEvent,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import {
  appendMessageContent,
  messageText,
  textContentBlock,
} from "@/lib/myagents/message-content";

function appendAssistant(
  messages: ChatMessage[],
  id: string,
  blocks: MessageContentBlock[],
): ChatMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === id);
  if (index < 0) {
    next.push({
      id,
      role: "assistant",
      content: messageText(blocks),
      contentBlocks: blocks,
      createdAt: new Date().toISOString(),
    });
  } else {
    next[index] = appendMessageContent(next[index], blocks);
  }
  return next;
}

function appendAssistantToConversation(
  conversation: ConversationItem[],
  id: string,
  blocks: MessageContentBlock[],
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
        content: messageText(blocks),
        contentBlocks: blocks,
        createdAt: new Date().toISOString(),
      },
    });
  } else {
    const item = next[index];
    if (item.type === "message") {
      next[index] = {
        type: "message",
        message: appendMessageContent(item.message, blocks),
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
    const blocks = [textContentBlock(event.text)];
    return {
      ...session,
      messages: appendAssistant(session.messages, event.messageId, blocks),
      conversation: appendAssistantToConversation(
        session.conversation,
        event.messageId,
        blocks,
      ),
    };
  }
  if (event.type === "assistant_content") {
    const blocks = [event.block];
    return {
      ...session,
      messages: appendAssistant(session.messages, event.messageId, blocks),
      conversation: appendAssistantToConversation(
        session.conversation,
        event.messageId,
        blocks,
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
