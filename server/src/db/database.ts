import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const DATA_DIR = resolve(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(resolve(DATA_DIR, 'agent-runner.db'));

// WAL：读写并发 + 崩溃安全；NORMAL 同步级别在 WAL 下足够安全
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// ---------- 行 -> 领域对象 映射（snake_case -> camelCase） ----------
export interface JobRow {
  id: string; name: string; type: string; status: string;
  priority: number; lease_owner: string | null; lease_expires_at: string | null;
  idempotency_ns: string; budget_tokens: number; budget_cost_usd: number;
  used_tokens: number; used_cost_usd: number; cron_expr: string | null;
  attempt: number; max_attempts: number;
  payload_json: string; created_at: string; updated_at: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}
