import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { askBrain } from "./brain.ts";
import { config } from "./config.ts";
import { buildItPrompt } from "./context.ts";
import { type ChatLine, sendToUser, splitMarkdown } from "./lark.ts";
import { log } from "./logger.ts";
import { markEventSeen } from "./store.ts";

/**
 * Kênh it@: account Lark cá nhân nói chuyện qua giao thức Lark web (bridge/it_bridge.py + larkx).
 * Vào được nhóm external — nơi bot của app không vào được.
 * Chỉ xử lý tin của owner: DM trực tiếp, hoặc @it trong nhóm.
 */

export const IT_PREFIX = "it:";

/** Tin của owner do bridge đẩy lên — tin người khác bị lọc ngay trong bridge. */
type ItMessage = {
  msg_id: string;
  chat_id: string;
  chat_type: number; // 1 = DM, 2 = nhóm, 3 = nhóm topic
  chat_name: string;
  from_id: string;
  sender_name: string;
  msg_type: string;
  text: string;
  image_keys: string[];
  mentions_me: boolean;
  thread_id: string; // khác rỗng = tin nằm trong thread
  parent_id: string;
  create_time: number; // giây
};

type ItLine = { msg_id: string; sender: string; is_me: boolean; text: string; image_keys: string[]; time: string };
type History = { root: ItLine | null; lines: ItLine[] };
type ImageRef = { msgId: string; key: string };

type BridgeEvent =
  | ({ type: "message" } & ItMessage)
  | { type: "ready"; user_id: string }
  | { type: "auth_expired"; reason: string }
  | { type: "result"; id: number; ok: true; data: unknown }
  | { type: "result"; id: number; ok: false; error: string };

export type ItDeps = {
  enqueue: (chatId: string, job: () => Promise<void>) => void;
  handleCommand: (text: string, chatId: string, reply: (text: string) => Promise<void>) => Promise<boolean>;
};

// Restart daemon / reconnect có thể đẩy lại tin cũ → bỏ tin quá 1 giờ
const MAX_AGE_S = 3600;
// Giới hạn độ dài 1 tin text của Lark web chưa rõ → chia nhỏ cho chắc
const MAX_CHUNK = 4000;
const CALL_TIMEOUT_MS = 30_000;
// Ảnh trong bối cảnh (thread / nhóm) chỉ lấy N cái gần nhất — ảnh của tin hiện tại và tin quote luôn lấy
const MAX_CONTEXT_IMAGES = 5;

const bridgeEnv = {
  ...process.env,
  LARKX_HOME: config.larkxHome,
  LARKX_REGION: config.domain,
  LARKX_MARK_READ: "false",
  PYTHONUNBUFFERED: "1",
};

// ─── Bridge process ──────────────────────────────────────────────────────────

let proc: ChildProcess | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
let authExpired = false;
let restartDelay = 3000;
/** Tin gần nhất của mỗi chat — đích reply cho lượt tự phát của Brain */
const lastMessage = new Map<string, ItMessage>();

function call<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const stdin = proc?.stdin;
  if (!stdin?.writable) return Promise.reject(new Error("Kênh it@ chưa sẵn sàng"));
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`it bridge ${op} quá ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      pending.delete(id);
    };
    pending.set(id, {
      resolve: (data) => (done(), resolve(data as T)),
      reject: (err) => (done(), reject(err)),
    });
    stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  });
}

async function notifyOwners(text: string): Promise<void> {
  for (const openId of config.ownerOpenIds) {
    await sendToUser(openId, text).catch((err) => log("[IT] notify owner failed", err));
  }
}

function startBridge(deps: ItDeps): void {
  const child = spawn(config.itPython, [config.itBridge, "serve", "--owners", config.itOwnerIds.join(",")], {
    env: bridgeEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc = child;
  readline.createInterface({ input: child.stdout }).on("line", (line) => onLine(line, deps));
  readline.createInterface({ input: child.stderr }).on("line", (line) => log(`[IT] ${line}`));
  child.on("error", (err) => log("[IT] không chạy được bridge", err.message));
  child.on("exit", (code) => {
    proc = undefined;
    for (const p of pending.values()) p.reject(new Error("it bridge đã dừng"));
    pending.clear();
    if (authExpired) return; // chờ anh login lại rồi restart daemon
    log(`[IT] bridge exit code=${code}, restart sau ${restartDelay / 1000}s`);
    setTimeout(() => startBridge(deps), restartDelay).unref();
    restartDelay = Math.min(restartDelay * 2, 60_000);
  });
}

function onLine(line: string, deps: ItDeps): void {
  let event: BridgeEvent;
  try {
    event = JSON.parse(line) as BridgeEvent;
  } catch {
    log("[IT] dòng stdout không phải JSON", line.slice(0, 200));
    return;
  }
  switch (event.type) {
    case "ready":
      restartDelay = 3000;
      log(`[IT] bridge ready user_id=${event.user_id}`);
      return;
    case "auth_expired":
      if (authExpired) return;
      authExpired = true;
      log("[IT] session it@ hết hạn", event.reason);
      void notifyOwners(
        "⚠️ Session Lark web của it@ đã hết hạn, kênh it@ tạm dừng.\n" +
          "Chạy `npm run it:login` (quét QR bằng app Lark của it@) rồi `pm2 restart onelark --update-env` trong cmux.",
      );
      return;
    case "result": {
      const p = pending.get(event.id);
      if (!p) return;
      if (event.ok) p.resolve(event.data);
      else p.reject(new Error(event.error));
      return;
    }
    case "message":
      onMessage(event, deps);
  }
}

// ─── Gửi ─────────────────────────────────────────────────────────────────────

// larkx chỉ gửi được text thuần → bỏ các ký hiệu markdown hay gặp cho dễ đọc
function toPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^```.*\n?/gm, "");
}

/** Trả lời đúng chỗ: trong thread nếu tin nằm trong thread, ngược lại quote tin đó. */
async function reply(msg: ItMessage, text: string): Promise<void> {
  for (const chunk of splitMarkdown(toPlain(text), MAX_CHUNK)) {
    const target = msg.thread_id ? { thread: msg.thread_id } : { reply_to: msg.msg_id };
    await call("send", { chat_id: msg.chat_id, text: chunk, ...target });
  }
}

/** Kết quả tự phát của Brain (task nền xong…) → quote tin gần nhất của chat. */
export async function replyItBackground(chatKey: string, text: string): Promise<void> {
  const msg = lastMessage.get(chatKey);
  if (!msg) throw new Error(`Không có tin nào của ${chatKey} để trả lời`);
  await reply(msg, text);
}

/** Gửi 1 tin rồi thoát — dùng cho process ngoài daemon (`onelark report`). */
export function sendItOnce(chatKey: string, replyTo: string, text: string): Promise<void> {
  const chatId = chatKey.slice(IT_PREFIX.length);
  return new Promise((resolve, reject) => {
    const child = spawn(config.itPython, [config.itBridge, "send", "--chat", chatId, "--reply-to", replyTo], {
      env: bridgeEnv,
      stdio: ["pipe", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`it_bridge send exit ${code}`))));
    child.stdin.end(toPlain(text));
  });
}

// ─── Nhận tin ────────────────────────────────────────────────────────────────

function toChatLine(l: ItLine): ChatLine {
  return { id: l.msg_id, msgType: "", time: l.time, sender: l.is_me ? "it@ (em)" : l.sender, text: l.text, attachments: [] };
}

const toRefs = (msgId: string, keys: string[] = []): ImageRef[] => keys.map((key) => ({ msgId, key }));

/** Tải ảnh về brain/inbox/<msg_id>/ (pruneInbox dọn sau 7 ngày); ảnh lỗi thì bỏ qua. */
async function downloadImages(chatId: string, images: ImageRef[]): Promise<string[]> {
  const unique = [...new Map(images.map((img) => [img.key, img])).values()];
  const paths = await Promise.all(
    unique.map((img) =>
      call<{ path: string }>("download", {
        chat_id: chatId,
        msg_id: img.msgId,
        key: img.key,
        dir: path.join(config.inboxDir, img.msgId),
      })
        .then((r) => r.path)
        .catch((err) => (log(`[IT] tải ảnh ${img.key} lỗi`, (err as Error).message), "")),
    ),
  );
  return paths.filter(Boolean);
}

/** Bối cảnh: DM chỉ cần tin được quote (session đã nhớ hội thoại); nhóm lấy N tin gần nhất của chat / thread. */
async function gatherContext(msg: ItMessage): Promise<{ context: ChatLine[]; quoted?: ChatLine; attachments: string[] }> {
  let lines: ItLine[] = [];
  if (msg.chat_type !== 1) {
    const h = await call<History>("history", {
      chat_id: msg.chat_id,
      msg_id: msg.msg_id,
      count: config.groupContextLimit,
      thread_id: msg.thread_id,
    });
    lines = [...(h.root ? [h.root] : []), ...h.lines].filter((l) => l.msg_id !== msg.msg_id);
  }
  // Tin được quote: chỉ fetch riêng (và đưa vào <quoted>) khi không nằm sẵn trong bối cảnh
  const inContext = lines.find((l) => l.msg_id === msg.parent_id);
  const quoted =
    msg.parent_id && !inContext
      ? (await call<ItLine[]>("messages", { chat_id: msg.chat_id, ids: [msg.parent_id] }))[0]
      : undefined;
  const parent = inContext ?? quoted;
  const attachments = await downloadImages(msg.chat_id, [
    ...toRefs(msg.msg_id, msg.image_keys),
    ...(parent ? toRefs(parent.msg_id, parent.image_keys) : []),
    ...lines.flatMap((l) => toRefs(l.msg_id, l.image_keys)).slice(-MAX_CONTEXT_IMAGES),
  ]);
  return { context: lines.map(toChatLine), quoted: quoted && toChatLine(quoted), attachments };
}

async function runTurn(msg: ItMessage): Promise<void> {
  const chatKey = IT_PREFIX + msg.chat_id;
  try {
    const { context, quoted, attachments } = await gatherContext(msg).catch((err) => {
      log(`[IT] chat=${msg.chat_id} lấy bối cảnh lỗi`, (err as Error).message);
      return { context: [], quoted: undefined, attachments: [] };
    });
    const prompt = buildItPrompt({
      source: msg.chat_type === 1 ? "it-dm" : "it-group",
      chatId: chatKey,
      messageId: msg.msg_id,
      chatName: msg.chat_name,
      context,
      quoted,
      attachments,
      text: msg.text,
    });
    log(`[IT] chat=${msg.chat_id} msg=${msg.msg_id} prompt=${prompt.length} chars`);
    const result = await askBrain(chatKey, prompt, msg.msg_id);
    log(`[IT] chat=${msg.chat_id} done error=${result.isError} cost_total=$${result.costUsd.toFixed(4)}`);
    const text = result.text.trim() || "(Không có nội dung trả lời)";
    await reply(msg, result.isError ? `❌ ${text}` : text);
  } catch (err) {
    log(`[IT] chat=${msg.chat_id} failed`, err);
    await reply(msg, `❌ Lỗi OneLark: ${(err as Error).message}`).catch(() => {});
  }
}

function onMessage(msg: ItMessage, deps: ItDeps): void {
  if (!config.itOwnerIds.includes(msg.from_id)) return;
  const isDm = msg.chat_type === 1;
  if (!isDm && !msg.mentions_me) return;
  if (!msg.text) return;
  if (Date.now() / 1000 - msg.create_time > MAX_AGE_S) return;
  if (!markEventSeen(IT_PREFIX + msg.msg_id)) return;

  const chatKey = IT_PREFIX + msg.chat_id;
  lastMessage.set(chatKey, msg);
  log(`[IT] chat=${msg.chat_id} ${isDm ? "dm" : "group"}: ${msg.text.slice(0, 80)}`);
  const replyCmd = (text: string) => reply(msg, text);

  // /stop phải chạy ngay, không xếp hàng sau lượt đang chạy
  if (msg.text.startsWith("/stop")) {
    void deps.handleCommand(msg.text, chatKey, replyCmd);
    return;
  }
  deps.enqueue(chatKey, async () => {
    if (await deps.handleCommand(msg.text, chatKey, replyCmd)) return;
    await runTurn(msg);
  });
}

/** Bật kênh it@ nếu đã cấu hình IT_OWNER_IDS và đã chạy `npm run it:setup`. */
export function startIt(deps: ItDeps): void {
  if (!config.itOwnerIds.length) return;
  if (!fs.existsSync(config.itPython)) {
    log(`[IT] chưa setup (${config.itPython} không tồn tại) — chạy \`npm run it:setup\``);
    return;
  }
  log(`[IT] start, owners=${config.itOwnerIds.join(",")}`);
  startBridge(deps);
}
