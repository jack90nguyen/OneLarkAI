import fs from "node:fs";
import { askBrain, closeAllBrains, closeBrain, interruptBrain, setBackgroundHandler } from "./brain.ts";
import { config } from "./config.ts";
import { type Incoming, buildPrompt, parseIncoming, pruneInbox } from "./context.ts";
import {
  type ReceiveEvent,
  addReaction,
  getBotOpenId,
  removeReaction,
  replyMarkdown,
  replyText,
  startEventStream,
} from "./lark.ts";
import { log } from "./logger.ts";
import { Progress } from "./progress.ts";
import { clearSessionId, getSessionId, listTasks, markEventSeen, pruneEvents } from "./store.ts";

const HELP = `**OneLark** — giao việc cho Claude Code
- Nhắn trực tiếp, hoặc @bot trong nhóm (bot đọc kèm tin gần đây / cả thread)
- \`/new\` bắt đầu session mới cho chat này
- \`/stop\` dừng lượt đang chạy
- \`/status\` xem session và task đã giao
- \`/todo\` xem danh sách việc tồn`;

// ─── Queue tuần tự theo chat, các chat khác nhau chạy song song ──────────────

const chains = new Map<string, Promise<void>>();

function enqueue(chatId: string, job: () => Promise<void>): void {
  const prev = chains.get(chatId) ?? Promise.resolve();
  const next = prev.then(job).catch((err) => log(`[QUEUE] chat=${chatId} job failed`, err));
  chains.set(chatId, next);
  void next.finally(() => {
    if (chains.get(chatId) === next) chains.delete(chatId);
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function handleCommand(incoming: Incoming): Promise<boolean> {
  const [cmd] = incoming.text.split(/\s+/);
  const reply = (md: string) => replyMarkdown(incoming.messageId, md, incoming.inThread);

  switch (cmd) {
    case "/help":
      await reply(HELP);
      return true;
    case "/new":
      closeBrain(incoming.chatId);
      clearSessionId(incoming.chatId);
      await reply("🧹 Đã reset, tin tiếp theo sẽ bắt đầu session mới.");
      return true;
    case "/stop": {
      // Dừng được thì lượt đang chạy tự reply "Đã dừng" → chỉ báo khi không có gì để dừng
      if (!(await interruptBrain(incoming.chatId))) await reply("Không có lượt nào đang chạy.");
      return true;
    }
    case "/todo": {
      const todo = fs.existsSync(config.todoPath) ? fs.readFileSync(config.todoPath, "utf8").trim() : "";
      await reply(todo || "📭 Chưa có việc tồn nào.");
      return true;
    }
    case "/status": {
      const sessionId = getSessionId(incoming.chatId);
      const tasks = listTasks(incoming.chatId, 5)
        .map((t) => `- ${t.status === "done" ? "✅" : "⏳"} \`${t.id}\` · ${t.workspace} · ${t.title}`)
        .join("\n");
      await reply(
        `**Session:** ${sessionId ? `\`${sessionId}\`` : "(chưa có)"}\n` +
          `Mở trong terminal: \`cd ${config.brainCwd} && claude --resume ${sessionId ?? "<id>"}\`\n\n` +
          `**Task gần đây:**\n${tasks || "(chưa có)"}`,
      );
      return true;
    }
    default:
      return false;
  }
}

// ─── Xử lý tin nhắn ──────────────────────────────────────────────────────────

async function runTurn(event: ReceiveEvent, incoming: Incoming): Promise<void> {
  const { chatId, messageId, inThread } = incoming;
  const ack = await addReaction(messageId, "OnIt");
  // Card tiến độ chỉ hiện ở DM — trong nhóm không để lộ các bước xử lý cho người khác
  const progress = incoming.isGroup ? undefined : new Progress(messageId, inThread);
  try {
    const prompt = await buildPrompt(event, incoming);
    log(`[TURN] chat=${chatId} msg=${messageId} prompt=${prompt.length} chars`);
    const result = await askBrain(chatId, prompt, messageId, (label, sub) => progress?.step(sub ? `↳ ${label}` : label));
    log(`[TURN] chat=${chatId} done error=${result.isError} cost_total=$${result.costUsd.toFixed(4)}`);
    await progress?.finish(result.stopped ? "stopped" : result.isError ? "error" : "done");
    const text = result.text.trim() || "(Không có nội dung trả lời)";
    await replyMarkdown(messageId, result.isError ? `❌ ${text}` : text, inThread);
    await addReaction(messageId, result.isError ? "ERROR" : "DONE");
  } catch (err) {
    log(`[TURN] chat=${chatId} failed`, err);
    await progress?.finish("error");
    await replyText(messageId, `❌ Lỗi OneLark: ${(err as Error).message}`, inThread).catch(() => {});
  } finally {
    await removeReaction(messageId, ack);
  }
}

function onMessage(event: ReceiveEvent, botOpenId: string): void {
  const dedupKey = event.event_id ?? event.message.message_id;
  if (!markEventSeen(dedupKey)) return;
  if (event.sender.sender_type !== "user") return;

  const incoming = parseIncoming(event, botOpenId);
  if (incoming.isGroup && !incoming.mentionsBot) return;

  // Chưa cấu hình allowlist → chỉ báo open_id cho anh điền vào .env, không chạy gì
  if (config.ownerOpenIds.length === 0) {
    if (!incoming.isGroup) {
      void replyText(incoming.messageId, `OneLark chưa cấu hình OWNER_OPEN_IDS.\nopen_id của bạn: ${incoming.senderOpenId}`);
    }
    return;
  }
  if (!config.ownerOpenIds.includes(incoming.senderOpenId)) {
    log(`[GUARD] ignore sender=${incoming.senderOpenId} chat=${incoming.chatId}`);
    return;
  }
  if (!incoming.text) return;

  log(`[MSG] chat=${incoming.chatId} ${incoming.isGroup ? "group" : "dm"}: ${incoming.text.slice(0, 80)}`);

  // /stop phải chạy ngay, không xếp hàng sau lượt đang chạy
  if (incoming.text.startsWith("/stop")) {
    void handleCommand(incoming);
    return;
  }
  enqueue(incoming.chatId, async () => {
    if (await handleCommand(incoming)) return;
    await runTurn(event, incoming);
  });
}

setBackgroundHandler((chatId, replyTo, result) => {
  log(`[TURN] chat=${chatId} background result error=${result.isError}`);
  const text = result.isError ? `❌ ${result.text}` : result.text;
  replyMarkdown(replyTo, text).catch((err) => log(`[TURN] background reply failed`, err));
});

async function main(): Promise<void> {
  const botOpenId = await getBotOpenId();
  log(`[INIT] bot open_id=${botOpenId}, owners=${config.ownerOpenIds.join(",") || "(chưa cấu hình)"}`);
  const prune = () => {
    pruneEvents();
    pruneInbox();
  };
  prune();
  setInterval(prune, 3600_000).unref();
  startEventStream((event) => onMessage(event, botOpenId));
}

function shutdown(): void {
  log("[INIT] shutting down");
  closeAllBrains();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("❌ OneLark init failed:", err);
  process.exit(1);
});
