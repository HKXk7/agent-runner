import type { Job, JobStatus, NewJobRequest } from '@agent-runner/shared';
import { ulid } from 'ulid';
import { db, nowIso, type JobRow } from '../db/database.js';
import { mapJob } from '../db/rows.js';
import { appendAudit } from '../audit/log.js';
import { bus } from '../sse/bus.js';

// ---------- 查询 ----------
export function getJob(id: string): Job | undefined {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? mapJob(row) : undefined;
}

export function listJobs(opts: { status?: JobStatus; limit?: number } = {}): Job[] {
  const limit = opts.limit ?? 100;
  const rows = opts.status
    ? (db
        .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?`)
        .all(opts.status, limit) as JobRow[])
    : (db.prepare(`SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?`).all(limit) as JobRow[]);
  return rows.map(mapJob);
}

function touch(jobId: string, fields: string[], values: unknown[]): Job {
  const sets = [...fields, 'updated_at = ?'].join(', ');
  db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...values, nowIso(), jobId);
  const job = getJob(jobId);
  if (job) bus.publish(jobId, { kind: 'job_update', job });
  return job!;
}

// ---------- 创建 ----------
export interface CreateJobInput {
  type: string;
  name: string;
  payload: unknown;
  priority: number;
  budgetTokens: number;
  budgetCostUsd: number;
  cronExpr?: string | null;
  idempotencyNs?: string;
  maxAttempts?: number;
}

/**
 * 入队。job 级幂等：同 idempotency_ns + type 已存在"未终态"任务时直接返回旧任务，
 * 防止 cron/重试路径重复入队。
 */
export function createJob(input: CreateJobInput, actor = 'user'): { job: Job; deduped: boolean } {
  if (input.idempotencyNs) {
    const existing = db
      .prepare(
        `SELECT * FROM jobs
         WHERE idempotency_ns = ? AND type = ?
           AND status IN ('pending','running','paused_approval','breached')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.idempotencyNs, input.type) as JobRow | undefined;
    if (existing) return { job: mapJob(existing), deduped: true };
  }

  const id = ulid();
  const now = nowIso();
  const maxAttempts = Math.max(1, input.maxAttempts ?? 1);
  db.prepare(
    `INSERT INTO jobs (id, name, type, status, priority, idempotency_ns,
                       budget_tokens, budget_cost_usd, cron_expr, max_attempts, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.type,
    input.priority,
    input.idempotencyNs ?? '',
    input.budgetTokens,
    input.budgetCostUsd,
    input.cronExpr ?? null,
    maxAttempts,
    JSON.stringify(input.payload ?? {}),
    now,
    now,
  );

  const job = getJob(id)!;
  appendAudit(id, 'job_created', actor, { type: input.type, name: input.name });
  bus.publish(id, { kind: 'job_update', job });
  return { job, deduped: false };
}

// ---------- 状态变更（全部走这里，保证 audit + SSE 一致） ----------
export function setJobStatus(
  jobId: string,
  status: JobStatus,
  fields: { leaseOwner?: string | null; leaseExpiresAt?: string | null } = {},
  actor = 'system',
): Job {
  const f: string[] = ['status = ?'];
  const v: unknown[] = [status];
  if (fields.leaseOwner !== undefined) {
    f.push('lease_owner = ?');
    v.push(fields.leaseOwner);
  }
  if (fields.leaseExpiresAt !== undefined) {
    f.push('lease_expires_at = ?');
    v.push(fields.leaseExpiresAt);
  }
  return touch(jobId, f, v);
}

export function releaseLease(jobId: string): Job {
  return touch(jobId, ['lease_owner = NULL', 'lease_expires_at = NULL'], []);
}

/**
 * 预算调整 + 熔断恢复（唯一入口）：
 * breached 且新预算已覆盖已用量 -> 回 running（无租约），调度器重拉，
 * 已完成步骤幂等跳过，从断点续跑（不重复花钱）。
 */
export function updateBudget(
  jobId: string,
  budgetTokens?: number,
  budgetCostUsd?: number,
  actor = 'user',
): { job: Job; resumed: boolean } {
  const f: string[] = [];
  const v: unknown[] = [];
  if (budgetTokens !== undefined) {
    f.push('budget_tokens = ?');
    v.push(budgetTokens);
  }
  if (budgetCostUsd !== undefined) {
    f.push('budget_cost_usd = ?');
    v.push(budgetCostUsd);
  }
  const job = touch(jobId, f, v);
  appendAudit(jobId, 'budget_updated', actor, { budgetTokens: job.budgetTokens, budgetCostUsd: job.budgetCostUsd });

  if (
    job.status === 'breached' &&
    job.usedTokens <= job.budgetTokens &&
    job.usedCostUsd <= job.budgetCostUsd
  ) {
    const resumed = setJobStatus(jobId, 'running', {}, actor);
    return { job: resumed, resumed: true };
  }
  return { job, resumed: false };
}

/** 成本累加（步完成时调用），返回累加后的任务 */
export function accrueCost(
  jobId: string,
  usage: { tokensIn: number; tokensOut: number; costUsd: number },
): Job {
  return touch(jobId, ['used_tokens = used_tokens + ?', 'used_cost_usd = used_cost_usd + ?'], [
    usage.tokensIn + usage.tokensOut,
    usage.costUsd,
  ]);
}

export function isTerminal(job: Job): boolean {
  return job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
}

/**
 * job 级重试（唯一入口：worker 执行失败后调用）。
 * 语义：执行失败 -> 若 attempt 尚未用尽，attempt+1、释放租约、status 回 pending
 * 重新入队，调度器重拉后靠步骤幂等跳过已完成步骤，从断点续跑；
 * 否则终态 failed。写 job_retry / job_failed 审计。
 */
export function resolveJobFailure(
  jobId: string,
  error: string,
  actor = 'system',
): { job: Job; retried: boolean } {
  const job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const nextAttempt = job.attempt + 1;
  releaseLease(jobId);
  appendAudit(jobId, 'lease_released', actor, { reason: 'job failure resolution' });

  if (nextAttempt < job.maxAttempts) {
    const bumped = touch(jobId, ['attempt = ?'], [nextAttempt]);
    appendAudit(jobId, 'job_retry', actor, {
      attempt: nextAttempt,
      maxAttempts: job.maxAttempts,
      error,
    });
    const pending = setJobStatus(jobId, 'pending', {}, actor);
    return { job: pending, retried: true };
  }

  const failed = setJobStatus(jobId, 'failed', {}, actor);
  appendAudit(jobId, 'job_failed', actor, {
    error,
    attempt: nextAttempt,
    maxAttempts: job.maxAttempts,
  });
  return { job: failed, retried: false };
}
