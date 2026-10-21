import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

const envFile = path.join(ROOT, ".env");
try {
  process.loadEnvFile(envFile);
} catch {
  // .env không bắt buộc — có thể set env từ ngoài
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name} (xem .env.example)`);
  return value;
}

function int(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  appId: required("LARK_APP_ID"),
  appSecret: required("LARK_APP_SECRET"),
  domain: (process.env.LARK_DOMAIN ?? "lark").toLowerCase() === "feishu" ? "feishu" : "lark",
  ownerOpenIds: (process.env.OWNER_OPEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  groupContextLimit: int("GROUP_CONTEXT_LIMIT", 30),
  brainIdleMs: int("BRAIN_IDLE_MINUTES", 30) * 60_000,
  brainModel: process.env.BRAIN_MODEL || undefined,
  brainCwd: path.join(ROOT, "brain"),
  inboxDir: path.join(ROOT, "brain", "inbox"),
  todoPath: path.join(ROOT, "brain", "TODO.md"),
  dbPath: path.join(ROOT, "data", "onelark.db"),
  cliPath: path.join(ROOT, "src", "cli.ts"),
} as const;
