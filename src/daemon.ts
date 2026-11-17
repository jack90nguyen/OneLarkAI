import fs from "node:fs";
import { makeAck } from "./ack.ts";
import { HOME, askBrain, closeAllBrains, closeBrain, interruptBrain, setBackgroundHandler } from "./brain.ts";
import { config } from "./config.ts";
import { type Incoming, buildPrompt, isCommand, parseIncoming, pruneInbox } from "./context.ts";
import { IT_PREFIX, replyItBackground, startIt } from "./it.ts";
import {
  type ReceiveEvent,
  addReaction,
  getBotOpenId,
  removeReaction,
  replyMarkdown,
  replyText,
  sendMarkdownToUser,
  startEventStream,
} from "./lark.ts";
import { log } from "./logger.ts";
import { Progress } from "./progress.ts";
import { type Report, clearSessionId, getSessionId, listTasks, markEventSeen, pruneEvents, takeReports } from "./store.ts";

const REPORT_POLL_MS = 5_000;

const HELP = `**OneLark** — giao việc cho Claude Code
- Nhắn trực tiếp, hoặc @bot trong nhóm (bot xác nhận tại nhóm, xử lý và trả lời trong DM)
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

/** Dùng chung cho kênh bot và kênh it@ — reply do kênh truyền vào. */
async function handleCommand(text: string, chatId: string, reply: (md: string) => Promise<void>): Promise<boolean> {
  const [cmd] = text.split(/\s+/);

  switch (cmd) {
    case "/help":
      await reply(HELP);
      return true;
    case "/new":
      closeBrain(chatId);
      clearSessionId(chatId);
      await reply("🧹 Đã reset, tin tiếp theo sẽ bắt đầu session mới.");
      return true;
    case "/stop": {
      // Dừng được thì lượt đang chạy tự reply "Đã dừng" → chỉ báo khi không có gì để dừng
      if (!(await interruptBrain(chatId))) await reply("Không có lượt nào đang chạy.");
      return true;
    }
    case "/todo": {
      const todo = fs.existsSync(config.todoPath) ? fs.readFileSync(config.todoPath, "utf8").trim() : "";
      await reply(todo || "📭 Chưa có việc tồn nào.");
      return true;
    }
    case "/status": {
      const sessionId = getSessionId(chatId);
      const tasks = listTasks(undefined, 5)
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

const owner = (): string => config.ownerOpenIds[0];

/**
 * Một lượt của Brain DM. Card tiến độ + câu trả lời reply vào `replyTo` (tin trong DM).
 * `react`: thả OnIt / DONE lên chính tin đó (chỉ dùng khi đó là tin anh nhắn).
 */
async function runTurn(replyTo: string, inThread: boolean, makePrompt: () => Promise<string>, react = false): Promise<void> {
  const ack = react ? await addReaction(replyTo, "OnIt") : undefined;
  const progress = new Progress(replyTo, inThread);
  try {
    const prompt = await makePrompt();
    log(`[TURN] msg=${replyTo} prompt=${prompt.length} chars`);
    const result = await askBrain(HOME, prompt, replyTo, (label, sub) => progress.step(sub ? `↳ ${label}` : label));
    log(`[TURN] done error=${result.isError}`);
    await progress.finish(result.stopped ? "stopped" : result.isError ? "error" : "done");
    const text = result.text.trim() || "(Không có nội dung trả lời)";
    await replyMarkdown(replyTo, result.isError ? `❌ ${text}` : text, inThread);
    if (react) await addReaction(replyTo, result.isError ? "ERROR" : "DONE");
  } catch (err) {
    log(`[TURN] msg=${replyTo} failed`, err);
    await progress.finish("error");
    await replyText(replyTo, `❌ Lỗi OneLark: ${(err as Error).message}`, inThread).catch(() => {});
  } finally {
    await removeReaction(replyTo, ack);
  }
}

/** Việc ngoài DM (anh tag ở nhóm, report của session) → mở 1 tin tiêu đề trong DM rồi chạy lượt Brain dưới tin đó. */
function routeHome(build: () => Promise<{ header: string; prompt: string }>): void {
  enqueue(HOME, async () => {
    let built: { header: string; prompt: string };
    try {
      built = await build();
    } catch (err) {
      log("[ROUTE] dựng prompt lỗi", err);
      await sendMarkdownToUser(owner(), `❌ Lỗi OneLark: ${(err as Error).message}`).catch(() => {});
      return;
    }
    const header = await sendMarkdownToUser(owner(), built.header);
    await runTurn(header, false, async () => built.prompt);
  });
}

/** Câu xác nhận ngắn tại nhóm — không chặn lượt xử lý. */
function sendAck(text: string, external: boolean, send: (ack: string) => Promise<void>): void {
  void makeAck(text, external)
    .then(send)
    .catch((err) => log("[ACK] gửi lỗi", err));
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
    // Người khác @bot trong nhóm → chỉ thả react trung tính, không chạy Brain
    if (incoming.isGroup) void addReaction(incoming.messageId, "ColdSweat");
    return;
  }
  if (!incoming.text) return;

  log(`[MSG] chat=${incoming.chatId} ${incoming.isGroup ? "group" : "dm"}: ${incoming.text.slice(0, 80)}`);

  const reply = (md: string) => replyMarkdown(incoming.messageId, md, incoming.inThread);
  // /stop phải chạy ngay, không xếp hàng sau lượt đang chạy
  if (incoming.text.startsWith("/stop")) {
    void handleCommand(incoming.text, HOME, reply);
    return;
  }
  if (!incoming.isGroup) {
    enqueue(HOME, async () => {
      if (await handleCommand(incoming.text, HOME, reply)) return;
      await runTurn(incoming.messageId, incoming.inThread, async () => (await buildPrompt(event, incoming)).prompt, true);
    });
    return;
  }
  // Nhóm: lệnh /… xử lý tại chỗ; còn lại xác nhận ngắn tại nhóm, xử lý + trả lời trong DM
  if (isCommand(incoming.text)) {
    enqueue(HOME, async () => void (await handleCommand(incoming.text, HOME, reply)));
    return;
  }
  sendAck(incoming.text, false, (ack) => replyText(incoming.messageId, ack, incoming.inThread));
  routeHome(async () => {
    const { prompt, chatName } = await buildPrompt(event, incoming);
    return { header: `📍 **${chatName}** · anh nhắn: ${incoming.text}`, prompt };
  });
}

/** Report session gửi qua `onelark report` → một lượt của Brain DM. */
function deliverReport({ task, body }: Report): void {
  log(`[REPORT] task=${task.id} workspace=${task.workspace}`);
  const thread = task.thread_id ? ` thread_id="${task.thread_id}"` : "";
  const attrs = `task_id="${task.id}" workspace="${task.workspace}" title="${task.title}" chat_id="${task.chat_id}" message_id="${task.message_id}"${thread}`;
  routeHome(async () => ({
    header: `📋 **${task.workspace}** báo cáo task \`${task.id}\` · ${task.title}`,
    prompt: `<report ${attrs}>\n${body}\n</report>`,
  }));
}

setBackgroundHandler((chatId, _replyTo, result) => {
  log(`[TURN] chat=${chatId} background result error=${result.isError}`);
  const text = result.isError ? `❌ ${result.text}` : result.text;
  const send = chatId.startsWith(IT_PREFIX) ? replyItBackground(chatId, text) : sendMarkdownToUser(owner(), text);
  send.catch((err) => log(`[TURN] background reply failed`, err));
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
  setInterval(() => takeReports().forEach(deliverReport), REPORT_POLL_MS).unref();
  startEventStream((event) => onMessage(event, botOpenId));
  startIt({ enqueue, handleCommand, routeHome, sendAck });
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
