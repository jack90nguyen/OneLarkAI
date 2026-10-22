import path from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

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

const EFFORTS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

function effort(name: string): EffortLevel | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (!EFFORTS.includes(value as EffortLevel)) throw new Error(`${name} phải là một trong: ${EFFORTS.join(", ")}`);
  return value as EffortLevel;
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
  brainEffort: effort("BRAIN_EFFORT"),
  brainCwd: path.join(ROOT, "brain"),
  inboxDir: path.join(ROOT, "brain", "inbox"),
  todoPath: path.join(ROOT, "brain", "TODO.md"),
  dbPath: path.join(ROOT, "data", "onelark.db"),
  cliPath: path.join(ROOT, "src", "cli.ts"),
} as const;
