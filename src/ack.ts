import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./logger.ts";

const FALLBACK = "Dạ em nhận rồi, để em kiểm tra nhé 👀";
const TIMEOUT_MS = 15_000;

const SYSTEM = `Em là trợ lý AI của team IT trên Lark. Anh Thành vừa tag em trong một nhóm chat.
Viết ĐÚNG 1 câu ngắn (tối đa 20 từ) báo đã nhận tin và sẽ kiểm tra / xử lý.
- Tiếng Việt, xưng "em", gọi "anh". Có 1-2 emoji.
- Hóm hỉnh, lém lỉnh một chút nhưng lễ phép, tôn trọng. Đừng mở đầu kiểu "Dạ anh, em nhận được…" — mỗi lần một cách diễn đạt khác hẳn.
- Không hứa thời gian hay kết quả. TUYỆT ĐỐI không lặp lại từ khoá nào trong tin: không tên app / workspace / hệ thống, mã đơn, số liệu, tên người.
- Chỉ trả về đúng câu đó, không giải thích, không ngoặc kép.
Ví dụ về giọng (đừng chép lại): "Có em đây, để em xắn tay áo soi liền 🕵️" · "Ok anh, em đi đào bới một chút rồi báo anh nha ⛏️" · "Nhận lệnh! Em lượn đi kiểm tra cái đã 🏃‍♂️"`;

const EXTERNAL = `
- Nhóm có người ngoài công ty / khách hàng: giọng nhân viên IT lịch sự, chuyên nghiệp, đùa rất nhẹ.`;

/** Câu xác nhận ngắn tại nhóm khi anh tag bot — Haiku viết, không tool, không load CLAUDE.md; lỗi / chậm thì dùng câu dự phòng. */
export async function makeAck(request: string, external: boolean): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    const q = query({
      prompt: `Tin anh vừa nhắn:\n${request.slice(0, 500)}`,
      options: {
        model: "haiku",
        systemPrompt: SYSTEM + (external ? EXTERNAL : ""),
        tools: [],
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        thinking: { type: "disabled" },
        abortController,
      },
    });
    for await (const msg of q) {
      if (msg.type !== "result") continue;
      const line = msg.subtype === "success" && !msg.is_error ? msg.result.trim().split("\n")[0].trim() : "";
      return line || FALLBACK;
    }
  } catch (err) {
    log("[ACK] Haiku lỗi, dùng câu dự phòng", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
  return FALLBACK;
}
