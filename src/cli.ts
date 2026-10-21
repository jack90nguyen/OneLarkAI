#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { config } from "./config.ts";
import { replyMarkdown } from "./lark.ts";
import { completeTask, createTask, deleteTask, getTask, listTasks } from "./store.ts";

const USAGE = `onelark — CLI cho Brain / session worker

  delegate <workspace> --chat <chat_id> --msg <message_id> --title <t> [text|stdin]
      Giao việc cho session Claude Code trong cmux workspace, in ra task id.
  report <task_id> [text|stdin]
      Gửi báo cáo của task về đúng tin nhắn gốc trên Lark, đánh dấu done.
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

function cmuxMessage(workspace: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cmux", ["agent", "message", workspace, "--from", "OneLark", "--", "-"], {
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
EOF`;

  try {
    await cmuxMessage(workspace, text);
  } catch (err) {
    deleteTask(task.id);
    throw err;
  }
  console.log(`Đã giao task ${task.id} cho workspace "${workspace}"`);
}

async function report(args: string[]): Promise<void> {
  const [taskId, ...rest] = args;
  const task = taskId ? getTask(taskId) : undefined;
  if (!task) throw new Error(`Không tìm thấy task ${taskId ?? ""}`);
  const body = await readBody(rest);
  await replyMarkdown(task.message_id, `**📋 Báo cáo task ${task.id}** · \`${task.workspace}\`\n\n${body}`);
  completeTask(task.id);
  console.log(`Đã gửi báo cáo task ${task.id} lên Lark`);
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
  else if (command === "report") await report(args);
  else if (command === "tasks") tasks(args);
  else console.log(USAGE);
} catch (err) {
  console.error(`❌ ${(err as Error).message}`);
  process.exitCode = 1;
}
