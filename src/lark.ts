import * as lark from "@larksuiteoapi/node-sdk";
import { config } from "./config.ts";
import { log } from "./logger.ts";

const domain = config.domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;

export const client = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
  domain,
  loggerLevel: lark.LoggerLevel.warn,
});

type ReceiveHandler = NonNullable<lark.EventHandles["im.message.receive_v1"]>;
export type ReceiveEvent = Parameters<ReceiveHandler>[0];

export function startEventStream(onMessage: (event: ReceiveEvent) => void): void {
  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": (event) => {
      onMessage(event);
    },
  });
  const ws = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: lark.LoggerLevel.warn,
    onReady: () => log("[LARK] WebSocket connected"),
    onReconnected: () => log("[LARK] WebSocket reconnected"),
    onError: (err) => log("[LARK] WebSocket failed", err.message),
  });
  void ws.start({ eventDispatcher: dispatcher });
}

export async function getBotOpenId(): Promise<string> {
  const res = await client.request<{ bot?: { open_id?: string } }>({ method: "GET", url: "/open-apis/bot/v3/info" });
  const openId = res.bot?.open_id;
  if (!openId) throw new Error("Không lấy được open_id của bot (/bot/v3/info)");
  return openId;
}

// ─── Gửi tin ─────────────────────────────────────────────────────────────────

// Lark post/md không render H1-H3 → hạ về H4 (giống lark-cli --markdown)
function normalizeMarkdown(md: string): string {
  return md.replace(/^#{1,3}\s/gm, "#### ");
}

// Post content giới hạn ~30KB → cắt theo dòng, chừa biên an toàn
const MAX_CHUNK = 12_000;

function splitMarkdown(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf("\n", MAX_CHUNK);
    if (cut <= 0) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export async function replyMarkdown(messageId: string, markdown: string, inThread = false): Promise<void> {
  for (const chunk of splitMarkdown(normalizeMarkdown(markdown))) {
    const content = JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: chunk }]] } });
    const res = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "post", content, reply_in_thread: inThread },
    });
    if (res.code) throw new Error(`Reply lỗi ${res.code}: ${res.msg}`);
  }
}

export async function replyText(messageId: string, text: string, inThread = false): Promise<void> {
  await client.im.v1.message.reply({
    path: { message_id: messageId },
    data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: inThread },
  });
}

// ─── Reaction (ack trạng thái) ───────────────────────────────────────────────

export async function addReaction(messageId: string, emoji: string): Promise<string | undefined> {
  try {
    const res = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    return res.data?.reaction_id;
  } catch (err) {
    log(`[LARK] addReaction ${emoji} failed`, (err as Error).message);
    return undefined;
  }
}

export async function removeReaction(messageId: string, reactionId: string | undefined): Promise<void> {
  if (!reactionId) return;
  try {
    await client.im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } });
  } catch (err) {
    log(`[LARK] removeReaction failed`, (err as Error).message);
  }
}

// ─── Đọc tin / bối cảnh ──────────────────────────────────────────────────────

export type ChatLine = { id: string; time: string; sender: string; text: string };

type Mention = { key: string; name: string };

type PostNode = { tag?: string; text?: string; user_name?: string; href?: string; file_name?: string };

function flattenPost(post: { title?: string; content?: PostNode[][] }): string {
  const lines = (post.content ?? []).map((row) =>
    row
      .map((node) => {
        switch (node.tag) {
          case "text":
          case "md":
          case "code_block":
            return node.text ?? "";
          case "a":
            return node.href ? `[${node.text ?? node.href}](${node.href})` : (node.text ?? "");
          case "at":
            return `@${node.user_name ?? ""}`;
          case "img":
            return "[ảnh]";
          case "media":
            return "[video]";
          default:
            return node.text ?? "";
        }
      })
      .join(""),
  );
  return [post.title, ...lines].filter(Boolean).join("\n");
}

/** Chuyển content JSON của Lark thành text đọc được, thay key @_user_N bằng tên. */
export function renderContent(type: string, raw: string, mentions: Mention[] = []): string {
  let text: string;
  try {
    const data = JSON.parse(raw);
    switch (type) {
      case "text":
        text = data.text ?? "";
        break;
      case "post": {
        // Event receive: {title, content}; API list/get: có thể bọc theo locale
        const post = data.content ? data : (Object.values(data)[0] as typeof data);
        text = flattenPost(post ?? {});
        break;
      }
      case "image":
        text = "[ảnh]";
        break;
      case "file":
        text = `[file: ${data.file_name ?? ""}]`;
        break;
      case "interactive":
        text = "[card]";
        break;
      default:
        text = `[${type}]`;
    }
  } catch {
    text = raw;
  }
  for (const m of mentions) text = text.replaceAll(m.key, `@${m.name}`);
  return text.trim();
}

function formatTime(ms: string | undefined): string {
  if (!ms) return "";
  return new Date(Number(ms)).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
}

type ListedMessage = NonNullable<
  NonNullable<Awaited<ReturnType<typeof client.im.v1.message.list>>["data"]>["items"]
>[number];

function toLine(m: ListedMessage): ChatLine {
  return {
    id: m.message_id ?? "",
    time: formatTime(m.create_time),
    sender: m.sender?.sender_type === "app" ? "🤖 bot" : (m.sender?.sender_name ?? m.sender?.id ?? "?"),
    text: m.deleted ? "[đã thu hồi]" : renderContent(m.msg_type ?? "", m.body?.content ?? "", m.mentions ?? []),
  };
}

/** Lấy N tin gần nhất của chat hoặc thread, trả về theo thứ tự cũ → mới. */
export async function listRecent(containerType: "chat" | "thread", containerId: string, limit: number): Promise<ChatLine[]> {
  const res = await client.im.v1.message.list({
    params: {
      container_id_type: containerType,
      container_id: containerId,
      sort_type: "ByCreateTimeDesc",
      page_size: Math.min(limit, 50),
      with_sender_name: true,
    },
  });
  if (res.code) throw new Error(`List message lỗi ${res.code}: ${res.msg}`);
  return (res.data?.items ?? []).reverse().map(toLine);
}

export async function getMessage(messageId: string): Promise<ChatLine | undefined> {
  const res = await client.im.v1.message.get({ path: { message_id: messageId } });
  const item = res.data?.items?.[0];
  return item ? toLine(item as ListedMessage) : undefined;
}

const chatNames = new Map<string, string>();

export async function getChatName(chatId: string): Promise<string> {
  const cached = chatNames.get(chatId);
  if (cached) return cached;
  const res = await client.im.v1.chat.get({ path: { chat_id: chatId } });
  const name = res.data?.name ?? chatId;
  chatNames.set(chatId, name);
  return name;
}
