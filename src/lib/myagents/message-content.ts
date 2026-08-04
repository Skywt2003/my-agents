import type { ContentBlock } from "@agentclientprotocol/sdk";

import type {
  ChatMessage,
  MessageContentBlock,
} from "@/lib/myagents/types";

const LEGACY_DATA_IMAGE_LINK = /\[@image\]\(data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/_=-]+)\)/g;

export const DISPLAYABLE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function textContentBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

export function parseLegacyMessageContent(text: string): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LEGACY_DATA_IMAGE_LINK)) {
    const index = match.index;
    if (index > cursor) blocks.push(textContentBlock(text.slice(cursor, index)));
    blocks.push({ type: "image", mimeType: match[1], data: match[2] });
    cursor = index + match[0].length;
  }

  if (blocks.length === 0) return [textContentBlock(text)];
  if (cursor < text.length) blocks.push(textContentBlock(text.slice(cursor)));
  return blocks;
}

export function normalizeMessageContentBlocks(
  content: string,
  blocks?: MessageContentBlock[],
  parseLegacyImages = false,
): MessageContentBlock[] {
  if (blocks?.length) return mergeAdjacentTextBlocks(blocks);
  return parseLegacyImages ? parseLegacyMessageContent(content) : [textContentBlock(content)];
}

export function messageText(blocks: MessageContentBlock[]): string {
  return blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

export function appendMessageContent(
  message: ChatMessage,
  blocks: MessageContentBlock[],
): ChatMessage {
  const contentBlocks = mergeAdjacentTextBlocks([
    ...normalizeMessageContentBlocks(
      message.content,
      message.contentBlocks,
      message.role === "user",
    ),
    ...blocks,
  ]);
  return { ...message, content: messageText(contentBlocks), contentBlocks };
}

export function messageContentBlocksFromAcp(
  content: ContentBlock,
  parseLegacyImages = false,
): MessageContentBlock[] {
  if (content.type === "text") {
    return parseLegacyImages
      ? parseLegacyMessageContent(content.text)
      : [textContentBlock(content.text)];
  }
  if (content.type === "image") {
    return [{
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
      ...(content.uri ? { uri: content.uri } : {}),
    }];
  }
  return [];
}

export function imageDataUrl(block: Extract<MessageContentBlock, { type: "image" }>) {
  return DISPLAYABLE_IMAGE_MIME_TYPES.has(block.mimeType)
    ? `data:${block.mimeType};base64,${block.data}`
    : null;
}

export function isMessageContentBlock(value: unknown): value is MessageContentBlock {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "text") return "text" in value && typeof value.text === "string";
  return value.type === "image" &&
    "data" in value && typeof value.data === "string" &&
    "mimeType" in value && typeof value.mimeType === "string" &&
    (!("uri" in value) || value.uri === undefined || typeof value.uri === "string");
}

function mergeAdjacentTextBlocks(blocks: MessageContentBlock[]): MessageContentBlock[] {
  const merged: MessageContentBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (block.type === "text" && previous?.type === "text") {
      previous.text += block.text;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}
