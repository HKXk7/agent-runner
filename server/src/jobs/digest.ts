import type { DigestItem } from '@agent-runner/shared';
import { ulid } from 'ulid';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, nowIso, DATA_DIR } from '../db/database.js';
import { mapDigest } from '../db/rows.js';
import { appendAudit } from '../audit/log.js';
import { bus } from '../sse/bus.js';
import { getPushChannels } from '../push/channels.js';

const DIGEST_DIR = resolve(DATA_DIR, 'digests');
mkdirSync(DIGEST_DIR, { recursive: true });

/**
 * 收件箱写入：DB 行（控制台收件箱页）+ 本地 markdown 归档（双通道）。
 */
export function writeDigest(jobId: string, title: string, bodyMd: string): DigestItem {
  const id = ulid();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO digests (id, job_id, title, body_md, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, jobId, title, bodyMd, createdAt);

  const day = createdAt.slice(0, 10);
  appendFileSync(
    resolve(DIGEST_DIR, `${day}.md`),
    `\n\n---\n\n# ${title}\n\n*${createdAt}*\n\n${bodyMd}\n`,
    'utf-8',
  );

  const row = db.prepare(`SELECT * FROM digests WHERE id = ?`).get(id) as Record<string, unknown>;
  const digest = mapDigest(row as never);
  appendAudit(jobId, 'digest_created', 'worker', { digestId: id, title });
  bus.publish(jobId, { kind: 'digest_created', digest });
  // 全局通道也广播，收件箱角标实时更新
  bus.publish('*', { kind: 'digest_created', digest });

  // 推送到外部渠道（微信等）：异步 fire-and-forget，失败只写审计不拖垮 job
  void dispatchPush(jobId, title, bodyMd);
  return digest;
}

/** 把日报分发到所有已启用的推送渠道；单个渠道失败不影响其他渠道与 job 本身 */
async function dispatchPush(jobId: string, title: string, body: string): Promise<void> {
  for (const ch of getPushChannels()) {
    try {
      await ch.send({ title, body });
      appendAudit(jobId, 'push_sent', 'worker', { channel: ch.name });
    } catch (e) {
      appendAudit(jobId, 'push_failed', 'worker', {
        channel: ch.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export function listDigests(limit = 50): DigestItem[] {
  const rows = db
    .prepare(`SELECT * FROM digests ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => mapDigest(r as never));
}

export function getDigest(id: string): DigestItem | undefined {
  const row = db.prepare(`SELECT * FROM digests WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapDigest(row as never) : undefined;
}
