#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { config } from "./config.ts";
import { IT_PREFIX, sendItOnce } from "./it.ts";
import { replyFile, replyMarkdown, sendFileToUser } from "./lark.ts";
import { addReport, completeTask, createTask, deleteTask, getTask, listTasks } from "./store.ts";

const USAGE = `onelark — CLI cho Brain / session worker

  delegate <workspace> --chat <chat_id> --msg <message_id> [--thread <thread_id>] --title <t> [text|stdin]
      Giao việc cho session Claude Code trong cmux workspace, in ra task id.
  report <task_id> [text|stdin]
      (Session) Gửi report cho OneLark — anh nhận trong DM, KHÔNG đăng thẳng lên nhóm.
  send-file --task <task_id> <path...>
      (Session) Gửi file/ảnh cho anh trong DM.
  post (--task <task_id> | --chat <chat_id> --msg <message_id> [--thread <thread_id>]) [text|stdin]
      (Brain) Đăng vào tin gốc trên nhóm / thread — chỉ dùng khi anh đã duyệt.
  send-file --chat <chat_id> --msg <message_id> [--thread <thread_id>] <path...>
      (Brain) Gửi file vào tin gốc (kênh it@: upload lên S3, gửi link).
  tasks [--chat <chat_id>]
      Liệt kê task gần đây.`;

const owner = (): string => {
  const id = config.ownerOpenIds[0];
  if (!id) throw new Error("Chưa cấu hình OWNER_OPEN_IDS");
  return id;
};

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
    options: { chat: { type: "string" }, msg: { type: "string" }, thread: { type: "string" }, title: { type: "string" } },
  });
  const [workspace, ...rest] = positionals;
  if (!workspace || !values.chat || !values.msg) throw new Error("delegate cần <workspace> --chat --msg");
  const instruction = await readBody(rest);
  const task = createTask({
    chat_id: values.chat,
    message_id: values.msg,
    thread_id: values.thread || null,
    workspace,
    title: values.title ?? instruction.slice(0, 60),
  });

  const cli = `node --no-warnings ${config.cliPath}`;
  const text = `[OneLark task ${task.id}] Việc anh Thành giao qua Lark:

${instruction}

—
- Cần hỏi lại hoặc cần anh duyệt / confirm: hỏi ngay trong session này (anh sẽ vào đây trả lời), đồng thời report 1 dòng "đang chờ anh …" để anh biết mà vào.
- Khi xong, report ngắn gọn bằng markdown cho OneLark. Anh nhận trong DM, OneLark sẽ hỏi anh có đăng lên nhóm không, em KHÔNG tự đăng lên nhóm / thread:
${cli} report ${task.id} <<'EOF'
<kết quả · thay đổi chính · việc anh cần làm tiếp>
EOF
- Gửi kèm file/ảnh cho anh (screenshot, report…): ${cli} send-file --task ${task.id} <path...>
- Chỉ dùng task ${task.id} cho việc này: không mượn task khác, không tự chạy delegate.`;

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
  addReport(task.id, body);
  completeTask(task.id);
  console.log(`Đã gửi report task ${task.id} cho OneLark, anh sẽ nhận trong DM`);
}

type Target = { chatId: string; messageId: string; threadId: string | null };

const targetOptions = {
  task: { type: "string" },
  chat: { type: "string" },
  msg: { type: "string" },
  thread: { type: "string" },
} as const;

/** Tin gốc để đăng: theo task, hoặc --chat/--msg/--thread truyền thẳng. */
function resolveTarget(values: { task?: string; chat?: string; msg?: string; thread?: string }): Target {
  if (values.task) {
    const task = getTask(values.task);
    if (!task) throw new Error(`Không tìm thấy task ${values.task}`);
    return { chatId: task.chat_id, messageId: task.message_id, threadId: task.thread_id };
  }
  if (!values.chat || !values.msg) throw new Error("cần --task <task_id> hoặc --chat <chat_id> --msg <message_id>");
  return { chatId: values.chat, messageId: values.msg, threadId: values.thread || null };
}

async function post(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: targetOptions });
  const target = resolveTarget(values);
  const body = await readBody(positionals);
  if (target.chatId.startsWith(IT_PREFIX)) {
    await sendItOnce(target.chatId, { replyTo: target.messageId, thread: target.threadId }, body);
  } else {
    await replyMarkdown(target.messageId, body, Boolean(target.threadId));
  }
  console.log(`Đã đăng vào ${target.chatId}`);
}

/** Upload qua skill hub-shared → link public. ID hub gắn trước tên file trông như timestamp nên thêm hậu tố ngẫu nhiên cho khó đoán. */
async function uploadShared(file: string): Promise<string> {
  const ext = path.extname(file);
  const base = path.basename(file, ext).replace(/[^\w.-]+/g, "-");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onelark-"));
  const tmp = path.join(dir, `${base}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  try {
    fs.copyFileSync(file, tmp);
    const { stdout } = await promisify(execFile)(process.execPath, [config.sharedUploadScript, tmp]);
    // Link nằm ở dòng cuối output
    const url = stdout.trim().split("\n").at(-1)?.trim();
    if (!url?.startsWith("https://")) throw new Error(`Upload không trả về link: ${stdout.trim()}`);
    return url;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function sendFile(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: targetOptions });
  if (!positionals.length) throw new Error("send-file cần ít nhất một đường dẫn file");
  const files = positionals.map((f) => path.resolve(f));
  // Session gửi theo task → file về DM anh, không đăng nhóm
  if (values.task) {
    if (!getTask(values.task)) throw new Error(`Không tìm thấy task ${values.task}`);
    for (const file of files) await sendFileToUser(owner(), file);
    console.log(`Đã gửi ${files.length} file cho anh trong DM`);
    return;
  }
  const target = resolveTarget(values);
  // Kênh it@ chỉ gửi được text → upload rồi gửi link
  if (target.chatId.startsWith(IT_PREFIX)) {
    const links: string[] = [];
    for (const file of files) links.push(`${path.basename(file)}: ${await uploadShared(file)}`);
    await sendItOnce(target.chatId, { replyTo: target.messageId, thread: target.threadId }, links.join("\n"));
    console.log(`Đã gửi link:\n${links.join("\n")}`);
    return;
  }
  for (const file of files) {
    await replyFile(target.messageId, file, Boolean(target.threadId));
    console.log(`Đã gửi ${file}`);
  }
}

function tasks(args: string[]): void {
  const { values } = parseArgs({ args, options: { chat: { type: "string" } } });
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
  else if (command === "post") await post(args);
  else if (command === "send-file") await sendFile(args);
  else if (command === "tasks") tasks(args);
  else console.log(USAGE);
} catch (err) {
  console.error(`❌ ${(err as Error).message}`);
  process.exitCode = 1;
}
