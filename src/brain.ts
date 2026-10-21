import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { log } from "./logger.ts";
import { BRAIN_PROMPT } from "./prompt.ts";
import { getSessionId, saveSessionId } from "./store.ts";

export type TurnResult = { text: string; isError: boolean; costUsd: number };

/** Lượt tự phát (task nền xong, Brain tự báo) — không gắn với tin nhắn nào đang chờ. */
type BackgroundHandler = (chatId: string, replyTo: string, result: TurnResult) => void;
let onBackground: BackgroundHandler = () => {};

export function setBackgroundHandler(handler: BackgroundHandler): void {
  onBackground = handler;
}

/** Hàng đợi async để đẩy tin nhắn vào query() ở streaming input mode. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private ended = false;

  push(text: string): void {
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (this.waiter) {
      this.waiter({ value: msg, done: false });
      this.waiter = undefined;
    } else {
      this.items.push(msg);
    }
  }

  end(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

/**
 * Một Brain = một process Claude Code sống lâu cho một chat Lark.
 * Session id lưu SQLite → daemon restart hoặc idle-close vẫn resume đúng hội thoại.
 */
class Brain {
  private inbox = new Inbox();
  private q: Query;
  private pending?: { resolve: (r: TurnResult) => void; reject: (e: Error) => void };
  private idleTimer?: NodeJS.Timeout;
  /** message_id của tin gần nhất — đích reply cho lượt tự phát */
  private replyTo = "";
  private chatId: string;
  private onClosed: () => void;
  private interrupted = false;
  closed = false;
  busy = false;

  constructor(chatId: string, onClosed: () => void) {
    this.chatId = chatId;
    this.onClosed = onClosed;
    const resume = getSessionId(chatId);
    log(`[BRAIN] start chat=${chatId} resume=${resume ?? "(new)"}`);
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: config.brainCwd,
        resume,
        model: config.brainModel,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: { type: "preset", preset: "claude_code", append: BRAIN_PROMPT },
        disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
      },
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const msg of this.q) {
        if (msg.type === "system" && msg.subtype === "init") {
          saveSessionId(this.chatId, msg.session_id);
        } else if (msg.type === "result") {
          saveSessionId(this.chatId, msg.session_id);
          const text = msg.subtype === "success" ? msg.result : msg.errors.join("\n") || msg.subtype;
          this.settle({ text, isError: msg.is_error, costUsd: msg.total_cost_usd });
        }
      }
    } catch (err) {
      this.pending?.reject(err as Error);
      this.pending = undefined;
      log(`[BRAIN] chat=${this.chatId} crashed`, (err as Error).message);
    } finally {
      this.pending?.reject(new Error("Brain process đã dừng"));
      this.pending = undefined;
      this.markClosed();
    }
  }

  private settle(result: TurnResult): void {
    this.busy = false;
    if (this.interrupted) {
      // SDK trả result lỗi kiểu diagnostic khi bị interrupt → thay bằng câu dễ đọc
      this.interrupted = false;
      result = { ...result, text: "⏹️ Đã dừng theo yêu cầu.", isError: false };
    }
    if (this.pending) {
      this.pending.resolve(result);
      this.pending = undefined;
    } else if (result.text.trim()) {
      onBackground(this.chatId, this.replyTo, result);
    }
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log(`[BRAIN] chat=${this.chatId} idle → close`);
      this.close();
    }, config.brainIdleMs);
  }

  /** Gửi một lượt và chờ kết quả. Caller đảm bảo tuần tự theo chat. */
  ask(prompt: string, replyTo: string): Promise<TurnResult> {
    if (this.closed) return Promise.reject(new Error("Brain đã đóng"));
    clearTimeout(this.idleTimer);
    this.replyTo = replyTo;
    this.busy = true;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.inbox.push(prompt);
    });
  }

  async interrupt(): Promise<void> {
    if (!this.busy) return;
    this.interrupted = true;
    await this.q.interrupt();
  }

  close(): void {
    if (this.closed) return;
    this.inbox.end();
    this.q.close();
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.onClosed();
  }
}

const brains = new Map<string, Brain>();

function getBrain(chatId: string): Brain {
  let brain = brains.get(chatId);
  if (!brain || brain.closed) {
    brain = new Brain(chatId, () => {
      if (brains.get(chatId) === brain) brains.delete(chatId);
    });
    brains.set(chatId, brain);
  }
  return brain;
}

export function askBrain(chatId: string, prompt: string, replyTo: string): Promise<TurnResult> {
  return getBrain(chatId).ask(prompt, replyTo);
}

/** Dừng lượt đang chạy. Trả về false nếu chat không có lượt nào đang chạy. */
export async function interruptBrain(chatId: string): Promise<boolean> {
  const brain = brains.get(chatId);
  if (!brain?.busy) return false;
  await brain.interrupt();
  return true;
}

export function closeBrain(chatId: string): void {
  brains.get(chatId)?.close();
}

export function closeAllBrains(): void {
  for (const brain of brains.values()) brain.close();
}
