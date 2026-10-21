import path from "node:path";
import { patchCard, replyCard } from "./lark.ts";
import { log } from "./logger.ts";

const SHOW_AFTER_MS = 10_000;
const PATCH_EVERY_MS = 3_000;
const RECENT_STEPS = 4;

function short(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Mô tả ngắn một bước tool_use để hiện trên card. */
export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : "");
  switch (name) {
    case "Bash":
      return `Bash: ${short(str("description") || str("command"))}`;
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return `${name} ${path.basename(str("file_path") || str("notebook_path"))}`;
    case "Grep":
    case "Glob":
      return `${name} \`${short(str("pattern"), 40)}\``;
    case "WebFetch":
      return `WebFetch ${short(str("url"))}`;
    case "WebSearch":
      return `WebSearch ${short(str("query"))}`;
    case "Skill":
      return `Skill ${str("skill")}`;
    case "Agent":
    case "Task":
      return `Agent: ${short(str("description"))}`;
    default:
      // mcp__server__tool → server/tool
      return name.startsWith("mcp__") ? name.slice(5).replace("__", "/") : name;
  }
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export type Outcome = "done" | "error" | "stopped";

const OUTCOME_LABEL: Record<Outcome, string> = { done: "✅ Xong", error: "❌ Lỗi", stopped: "⏹️ Đã dừng" };

/**
 * Card tiến độ cho lượt chạy lâu: chỉ hiện khi lượt quá 10s,
 * patch tại chỗ tối đa ~3s/lần, cuối lượt chốt trạng thái.
 */
export class Progress {
  private replyTo: string;
  private inThread: boolean;
  private startedAt = Date.now();
  private steps: string[] = [];
  private cardId?: Promise<string | undefined>;
  private timer?: NodeJS.Timeout;
  private finished = false;

  constructor(replyTo: string, inThread: boolean) {
    this.replyTo = replyTo;
    this.inThread = inThread;
    this.timer = setTimeout(() => this.show(), SHOW_AFTER_MS);
  }

  step(label: string): void {
    this.steps.push(label);
  }

  private render(header: string): string {
    const recent = this.steps.slice(-RECENT_STEPS);
    const lines = recent.map((s, idx) => (idx === recent.length - 1 && !this.finished ? `▶ ${s}` : `✓ ${s}`));
    const hidden = this.steps.length - recent.length;
    return [
      `**${header}** · ${this.steps.length} bước · ${formatElapsed(Date.now() - this.startedAt)}`,
      hidden > 0 ? `… ${hidden} bước trước` : "",
      ...lines,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private show(): void {
    if (this.finished) return;
    this.cardId = replyCard(this.replyTo, this.render("⏳ Đang làm"), this.inThread).catch((err) => {
      log("[PROGRESS] gửi card lỗi", (err as Error).message);
      return undefined;
    });
    this.timer = setInterval(() => void this.flush(), PATCH_EVERY_MS);
  }

  private async flush(): Promise<void> {
    // Thời gian chạy đổi liên tục → vẫn patch dù không có bước mới, để anh thấy bot còn sống
    const cardId = await this.cardId;
    if (!cardId || this.finished) return;
    await patchCard(cardId, this.render("⏳ Đang làm")).catch((err) =>
      log("[PROGRESS] patch lỗi", (err as Error).message),
    );
  }

  async finish(outcome: Outcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    const cardId = await this.cardId;
    if (!cardId) return;
    await patchCard(cardId, this.render(OUTCOME_LABEL[outcome])).catch((err) =>
      log("[PROGRESS] chốt card lỗi", (err as Error).message),
    );
  }
}
