#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "./config.ts";
import { IT_PREFIX, sendItOnce } from "./it.ts";
import { replyFile, replyMarkdown } from "./lark.ts";
import { completeTask, createTask, deleteTask, getTask, listTasks } from "./store.ts";

const USAGE = `onelark — CLI cho Brain / session worker

  delegate <workspace> --chat <chat_id> --msg <message_id> --title <t> [text|stdin]
      Giao việc cho session Claude Code trong cmux workspace, in ra task id.
  message <workspace> [text|stdin]
      Nhắn một chiều cho session trong cmux workspace (không tạo task, không cần báo cáo).
  report <task_id> [text|stdin]
      Gửi báo cáo của task về đúng tin nhắn gốc trên Lark, đánh dấu done.
  send-file (--msg <message_id> | --task <task_id>) <path...>
      Upload file/ảnh local và reply vào tin nhắn trên Lark.
  tasks --chat <chat_id>
      Liệt kê task gần đây của chat.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readBody(positionals: string[]): Promise<string> {
  const body = positionals.join(" ").trim() || (await readStdin());
  if (!body) throw new Error("Thiếu nội dung (truyền qua tham số hoặc stdin)");
  return body;
}

// pm2 có thể mang danh tính surface của terminal đã start nó → cmux coi tin là của surface đó và
// reply rơi vào session kia. Bỏ đi để tin không có đường reply: kết quả phải về qua `report`.
const { CMUX_SURFACE_ID, CMUX_PANEL_ID, CMUX_WORKSPACE_ID, ...cmuxEnv } = process.env;

function cmuxMessage(workspace: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cmux", ["agent", "message", workspace, "--from", "OneLark", "--", "-"], {
      env: cmuxEnv,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cmux agent message exit ${code}`))));
    child.stdin.end(text);
  });
}

async function delegate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { chat: { type: "string" }, msg: { type: "string" }, title: { type: "string" } },
  });
  const [workspace, ...rest] = positionals;
  if (!workspace || !values.chat || !values.msg) throw new Error("delegate cần <workspace> --chat --msg");
  const instruction = await readBody(rest);
  const task = createTask({
    chat_id: values.chat,
    message_id: values.msg,
    workspace,
    title: values.title ?? instruction.slice(0, 60),
  });

  const text = `[OneLark task ${task.id}] Việc anh Thành giao qua Lark:

${instruction}

—
Khi xong (hoặc khi cần anh quyết định), gửi báo cáo ngắn gọn bằng markdown về Lark:
node --no-warnings ${config.cliPath} report ${task.id} <<'EOF'
<kết quả · thay đổi chính · việc anh cần làm tiếp>
EOF
Cần gửi kèm file/ảnh (screenshot, report…): node --no-warnings ${config.cliPath} send-file --task ${task.id} <path...>`;

  try {
    await cmuxMessage(workspace, text);
  } catch (err) {
    deleteTask(task.id);
    throw err;
  }
  console.log(`Đã giao task ${task.id} cho workspace "${workspace}"`);
}

async function message(args: string[]): Promise<void> {
  const [workspace, ...rest] = args;
  if (!workspace) throw new Error("message cần <workspace>");
  const body = await readBody(rest);
  await cmuxMessage(workspace, `[OneLark] Anh Thành nhắn qua Lark:\n\n${body}`);
  console.log(`Đã nhắn cho workspace "${workspace}"`);
}

async function report(args: string[]): Promise<void> {
  const [taskId, ...rest] = args;
  const task = taskId ? getTask(taskId) : undefined;
  if (!task) throw new Error(`Không tìm thấy task ${taskId ?? ""}`);
  const body = await readBody(rest);
  const text = `**📋 Báo cáo task ${task.id}** · \`${task.workspace}\`\n\n${body}`;
  if (task.chat_id.startsWith(IT_PREFIX)) await sendItOnce(task.chat_id, task.message_id, text);
  else await replyMarkdown(task.message_id, text);
  completeTask(task.id);
  console.log(`Đã gửi báo cáo task ${task.id} lên Lark`);
}

async function sendFile(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { msg: { type: "string" }, task: { type: "string" } },
  });
  const task = values.task ? getTask(values.task) : undefined;
  if (task?.chat_id.startsWith(IT_PREFIX)) throw new Error("Kênh it@ chưa hỗ trợ send-file");
  const messageId = values.msg ?? task?.message_id;
  if (!messageId) throw new Error("send-file cần --msg <message_id> hoặc --task <task_id> hợp lệ");
  if (!positionals.length) throw new Error("send-file cần ít nhất một đường dẫn file");
  for (const file of positionals) {
    await replyFile(messageId, path.resolve(file));
    console.log(`Đã gửi ${file}`);
  }
}

function tasks(args: string[]): void {
  const { values } = parseArgs({ args, options: { chat: { type: "string" } } });
  if (!values.chat) throw new Error("tasks cần --chat");
  const rows = listTasks(values.chat);
  if (!rows.length) return console.log("Chưa có task nào.");
  for (const t of rows) {
    const at = new Date(t.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    console.log(`${t.status === "done" ? "✅" : "⏳"} ${t.id}  ${t.workspace}  ${t.title}  (${at})`);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "delegate") await delegate(args);
  else if (command === "message") await message(args);
  else if (command === "report") await report(args);
  else if (command === "send-file") await sendFile(args);
  else if (command === "tasks") tasks(args);
  else console.log(USAGE);
} catch (err) {
  console.error(`❌ ${(err as Error).message}`);
  process.exitCode = 1;
}
