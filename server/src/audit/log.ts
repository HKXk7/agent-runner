import type { AuditEventType } from '@agent-runner/shared';
import { db, nowIso } from '../db/database.js';
import { mapAudit } from '../db/rows.js';
import { bus } from '../sse/bus.js';

/**
 * append-only 审计事件。
 * 只 INSERT —— UPDATE/DELETE 由 SQLite 触发器在数据库层面直接 ABORT（见 schema.sql），
 * 任何代码路径（包括未来迁移脚本）都无法篡改历史，这是审计可信的根基。
 */
export function appendAudit(
  jobId: string,
  type: AuditEventType,
  actor: string,
  payload?: Record<string, unknown>,
): void {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO audit_events (job_id, ts, type, actor, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(jobId, ts, type, actor, payload ? JSON.stringify(payload) : null);

  const row = db
    .prepare(`SELECT * FROM audit_events WHERE id = ?`)
    .get(info.lastInsertRowid) as Record<string, unknown>;
  const event = mapAudit(row as never);
  bus.publish(jobId, { kind: 'audit', event });
}

export function listAudit(jobId: string, limit = 200) {
  const rows = db
    .prepare(`SELECT * FROM audit_events WHERE job_id = ? ORDER BY id ASC LIMIT ?`)
    .all(jobId, limit) as unknown[];
  return rows.map((r) => mapAudit(r as never));
}

/** 演示/测试用：证明审计不可篡改（会抛出 SQLite 异常） */
export function proveAppendOnly(): { protected: true; error: string } {
  try {
    db.prepare(`UPDATE audit_events SET actor = 'hacker' WHERE id = 1`).run();
    throw new Error('UNREACHABLE: audit update succeeded!');
  } catch (e) {
    return { protected: true, error: String(e) };
  }
}
