import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import {
  type Attachment,
  type ChatLine,
  type ReceiveEvent,
  downloadAttachment,
  extractAttachments,
  getChatName,
  getForwardedLines,
  getMessage,
  listRecent,
  renderContent,
} from "./lark.ts";
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

async function downloadAll(attachments: Attachment[]): Promise<string[]> {
  const paths = await Promise.all(
    attachments.map((att) =>
      safe(`download ${att.key}`, () => downloadAttachment(att, path.join(config.inboxDir, att.messageId)), ""),
    ),
  );
  return paths.filter(Boolean);
}

/** Gom bối cảnh + yêu cầu thành prompt cho Brain. */
export async function buildPrompt(event: ReceiveEvent, incoming: Incoming): Promise<string> {
  const { message } = event;
  const sections: string[] = [];

  let lines: ChatLine[] = [];
  if (message.thread_id) {
    lines = await safe("thread", () => listRecent("thread", message.thread_id!, config.groupContextLimit), []);
  } else if (incoming.isGroup) {
    lines = await safe("chat", () => listRecent("chat", incoming.chatId, config.groupContextLimit), []);
  }
  // Bỏ chính tin vừa nhận để không lặp với <request>
  lines = lines.filter((l) => l.id !== incoming.messageId);
  if (lines.length) sections.push(`<context>\n${formatLines(lines)}\n</context>`);

  // Tin được quote: chỉ fetch riêng khi không nằm sẵn trong bối cảnh đã gom
  let quoted = lines.find((l) => l.id === message.parent_id);
  if (message.parent_id && !quoted) {
    quoted = await safe("quoted", () => getMessage(message.parent_id!), undefined);
    if (quoted) sections.push(`<quoted>\n${formatLines([quoted])}\n</quoted>`);
  }

  // Forward gộp: của chính tin này, hoặc của tin đang được quote
  const forwardId =
    message.message_type === "merge_forward" ? incoming.messageId : quoted?.msgType === "merge_forward" ? quoted.id : "";
  const forwarded = forwardId ? await safe("forwarded", () => getForwardedLines(forwardId), []) : [];
  if (forwarded.length) sections.push(`<forwarded>\n${formatLines(forwarded)}\n</forwarded>`);

  // Ảnh / file của tin hiện tại + tin được quote + tin forward → tải về cho Brain đọc bằng Read
  const files = await downloadAll([
    ...extractAttachments(incoming.messageId, message.message_type, message.content),
    ...(quoted?.attachments ?? []),
    ...forwarded.flatMap((l) => l.attachments),
  ]);
  if (files.length) sections.push(`<attachments>\n${files.map((f) => `- ${f}`).join("\n")}\n</attachments>`);

  const chatName = incoming.isGroup ? await safe("chat name", () => getChatName(incoming.chatId), incoming.chatId) : "DM";
  const source = incoming.isGroup ? "group" : "dm";
  return wrapPrompt(source, incoming.chatId, incoming.messageId, chatName, sections, incoming.text);
}

function wrapPrompt(source: string, chatId: string, messageId: string, chatName: string, sections: string[], request: string): string {
  const attrs = `source="${source}" chat_id="${chatId}" message_id="${messageId}" chat_name="${chatName}"`;
  return [`<lark ${attrs}>`, ...sections, `<request>\n${request}\n</request>`, `</lark>`].join("\n");
}

export type ItPromptInput = {
  source: "it-dm" | "it-group";
  chatId: string;
  messageId: string;
  chatName: string;
  context: ChatLine[];
  quoted?: ChatLine;
  /** Đường dẫn local của ảnh đã tải */
  attachments: string[];
  text: string;
};

/** Prompt cho kênh it@ — bối cảnh đã được bridge lấy sẵn. */
export function buildItPrompt(input: ItPromptInput): string {
  const sections: string[] = [];
  if (input.context.length) sections.push(`<context>\n${formatLines(input.context)}\n</context>`);
  if (input.quoted) sections.push(`<quoted>\n${formatLines([input.quoted])}\n</quoted>`);
  if (input.attachments.length) sections.push(`<attachments>\n${input.attachments.map((f) => `- ${f}`).join("\n")}\n</attachments>`);
  return wrapPrompt(input.source, input.chatId, input.messageId, input.chatName, sections, input.text);
}

const INBOX_TTL_MS = 7 * 24 * 3600_000;

/** Xoá thư mục attachment cũ hơn 7 ngày. */
export function pruneInbox(): void {
  if (!fs.existsSync(config.inboxDir)) return;
  for (const name of fs.readdirSync(config.inboxDir)) {
    const dir = path.join(config.inboxDir, name);
    if (Date.now() - fs.statSync(dir).mtimeMs > INBOX_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}
