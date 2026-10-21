import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS chats (
    chat_id    TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    message_id TEXT NOT NULL,
    workspace  TEXT NOT NULL,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'running',
    created_at INTEGER NOT NULL,
    done_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    at       INTEGER NOT NULL
  );
`);

export type TaskStatus = "running" | "done";

export type Task = {
  id: string;
  chat_id: string;
  message_id: string;
  workspace: string;
  title: string;
  status: TaskStatus;
  created_at: number;
  done_at: number | null;
};

// ─── Chat ↔ Claude session ───────────────────────────────────────────────────

export function getSessionId(chatId: string): string | undefined {
  const row = db.prepare("SELECT session_id FROM chats WHERE chat_id = ?").get(chatId);
  return row?.session_id as string | undefined;
}

export function saveSessionId(chatId: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO chats (chat_id, session_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
  ).run(chatId, sessionId, Date.now());
}

export function clearSessionId(chatId: string): void {
  db.prepare("DELETE FROM chats WHERE chat_id = ?").run(chatId);
}

// ─── Task giao cho workspace khác ────────────────────────────────────────────

export function createTask(input: Pick<Task, "chat_id" | "message_id" | "workspace" | "title">): Task {
  const id = `T${Date.now().toString(36).toUpperCase()}`;
  const task: Task = { id, ...input, status: "running", created_at: Date.now(), done_at: null };
  db.prepare(
    "INSERT INTO tasks (id, chat_id, message_id, workspace, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(task.id, task.chat_id, task.message_id, task.workspace, task.title, task.status, task.created_at);
  return task;
}

export function getTask(id: string): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function deleteTask(id: string): void {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function completeTask(id: string): void {
  db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?").run(Date.now(), id);
}

export function listTasks(chatId: string, limit = 10): Task[] {
  return db
    .prepare("SELECT * FROM tasks WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(chatId, limit) as Task[];
}

// ─── Dedup event (WS có thể giao lại event khi reconnect) ────────────────────

export function markEventSeen(eventId: string): boolean {
  const res = db.prepare("INSERT OR IGNORE INTO events (event_id, at) VALUES (?, ?)").run(eventId, Date.now());
  return res.changes > 0;
}

export function pruneEvents(): void {
  db.prepare("DELETE FROM events WHERE at < ?").run(Date.now() - 24 * 3600_000);
}
