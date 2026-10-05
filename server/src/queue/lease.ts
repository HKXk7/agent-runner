import type { Job } from '@agent-runner/shared';
import { randomUUID } from 'node:crypto';
import { db, nowIso, type JobRow } from '../db/database.js';
import { mapJob } from '../db/rows.js';
import { appendAudit } from '../audit/log.js';
import { bus } from '../sse/bus.js';
import { releaseLease } from './jobs-repo.js';

export const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 6)}`;
export const LEASE_TTL_MS = 30_000; // 租约时长：长步执行期间靠心跳续约

/**
 * ============================================================
 * DB-backed Lease（面试核心考点）
 *
 * 获取 = 一条原子 UPDATE...RETURNING：
 *   条件命中（可获取状态 + 租约空闲/过期）的行才会被写入新 owner，
 *   SQLite 单写者 + WAL 下天然串行，效果等价于 Postgres 的
 *   `SELECT ... FOR UPDATE SKIP LOCKED`（升级路径见 docker/postgres.yml）。
 * 两个 worker 并发抢同一行，只有一个的 WHERE 能命中 -> 防双跑。
 * ============================================================
 */
export function acquireJob(workerId: string = WORKER_ID): Job | null {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();

  const row = db
    .prepare(
      `UPDATE jobs
       SET lease_owner = ?, lease_expires_at = ?, status = 'running', updated_at = ?
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status = 'pending'
            OR (status = 'running' AND (lease_owner IS NULL OR lease_expires_at < ?))
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(workerId, expiresAt, now, now) as JobRow | undefined;

  if (!row) return null;
  const job = mapJob(row);
  appendAudit(job.id, 'lease_acquired', workerId, { leaseExpiresAt: expiresAt });
  bus.publish(job.id, { kind: 'job_update', job });
  return job;
}

/** 心跳续约：只有持有者能续（WHERE 带 lease_owner 校验），租约被回收后续约失败 */
export function renewLease(jobId: string, workerId: string = WORKER_ID): boolean {
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const info = db
    .prepare(
      `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND status = 'running'`,
    )
    .run(expiresAt, nowIso(), jobId, workerId);
  return info.changes > 0;
}

/**
 * 回收过期租约：worker 崩溃后其租约自然过期，
 * 这里清掉租约字段（status 保持 running），下一次 acquire 即可重拉。
 * 效果 = at-least-once：步骤可能被执行多次 -> 依赖步骤幂等去重。
 */
export function recoverExpiredLeases(): number {
  const now = nowIso();
  const rows = db
    .prepare(
      `SELECT id, lease_owner FROM jobs
       WHERE status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at < ?`,
    )
    .all(now) as { id: string; lease_owner: string }[];

  for (const r of rows) {
    releaseLease(r.id);
    appendAudit(r.id, 'lease_recovered', 'scheduler', { previousOwner: r.lease_owner });
  }
  return rows.length;
}

/** 显式释放（审批暂停 / 熔断 / 完成时调用），并写审计 */
export function releaseLeaseWithAudit(jobId: string, workerId: string = WORKER_ID): void {
  releaseLease(jobId);
  appendAudit(jobId, 'lease_released', workerId, {});
}
