import { config } from "./config.ts";
import { type ChatLine, type ReceiveEvent, getChatName, getMessage, listRecent, renderContent } from "./lark.ts";
import { log } from "./logger.ts";

export type Incoming = {
  chatId: string;
  messageId: string;
  isGroup: boolean;
  inThread: boolean;
  senderOpenId: string;
  /** Nội dung tin, đã bỏ @bot */
  text: string;
  mentionsBot: boolean;
};

export function parseIncoming(event: ReceiveEvent, botOpenId: string): Incoming {
  const { message, sender } = event;
  const mentions = message.mentions ?? [];
  const botKeys = mentions.filter((m) => m.id.open_id === botOpenId).map((m) => m.key);
  let raw = message.content;
  for (const key of botKeys) raw = raw.replaceAll(key, "");
  return {
    chatId: message.chat_id,
    messageId: message.message_id,
    isGroup: message.chat_type === "group",
    inThread: Boolean(message.thread_id),
    senderOpenId: sender.sender_id?.open_id ?? "",
    text: renderContent(message.message_type, raw, mentions),
    mentionsBot: botKeys.length > 0,
  };
}

function formatLines(lines: ChatLine[]): string {
  return lines.map((l) => `[${l.time}] ${l.sender}: ${l.text}`).join("\n");
}

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log(`[CONTEXT] ${label} failed`, (err as Error).message);
    return fallback;
  }
}

/** Gom bối cảnh + yêu cầu thành prompt cho Brain. */
export async function buildPrompt(event: ReceiveEvent, incoming: Incoming): Promise<string> {
  const { message } = event;
  let context = "";

  if (message.thread_id) {
    const lines = await safe("thread", () => listRecent("thread", message.thread_id!, config.groupContextLimit), []);
    context = formatLines(lines.filter((l) => l.id !== incoming.messageId));
  } else if (incoming.isGroup) {
    const lines = await safe("chat", () => listRecent("chat", incoming.chatId, config.groupContextLimit), []);
    // Bỏ chính tin vừa nhận để không lặp với <request>
    context = formatLines(lines.filter((l) => l.id !== incoming.messageId));
  } else if (message.parent_id) {
    const parent = await safe("parent", () => getMessage(message.parent_id!), undefined);
    if (parent) context = `Tin được quote:\n${formatLines([parent])}`;
  }

  const chatName = incoming.isGroup ? await safe("chat name", () => getChatName(incoming.chatId), incoming.chatId) : "DM";
  const attrs = `source="${incoming.isGroup ? "group" : "dm"}" chat_id="${incoming.chatId}" message_id="${incoming.messageId}" chat_name="${chatName}"`;

  return [
    `<lark ${attrs}>`,
    context ? `<context>\n${context}\n</context>` : "",
    `<request>\n${incoming.text}\n</request>`,
    `</lark>`,
  ]
    .filter(Boolean)
    .join("\n");
}
