import type { Job, Step } from '@agent-runner/shared';
import { ulid } from 'ulid';
import { db, nowIso } from '../db/database.js';
import { mapStep } from '../db/rows.js';
import { bus } from '../sse/bus.js';

/**
 * ============================================================
 * 步骤幂等（面试核心考点）
 *
 * 幂等键 = `${jobId}:${stepIndex}:${name}`，UNIQUE 约束兜底。
 * 语义：at-least-once 投递下（租约回收/worker 崩溃后重跑），
 * 已 done 的步骤不再执行，直接复用上次的 output —— 副作用不重复发生。
 * ============================================================
 */
export function stepIdempotencyKey(jobId: string, stepIndex: number, name: string): string {
  return `${jobId}:${String(stepIndex).padStart(3, '0')}:${name}`;
}

interface StepRow {
  id: string; job_id: string; step_index: number; name: string;
  idempotency_key: string; status: string; requires_approval: number;
  input_json: string | null; output_json: string | null;
  tokens_in: number; tokens_out: number; cost_usd: number;
  started_at: string | null; finished_at: string | null; error: string | null;
  attempt: number;
}

export function getStepByKey(key: string): Step | undefined {
  const row = db.prepare(`SELECT * FROM steps WHERE idempotency_key = ?`).get(key) as
    | StepRow
    | undefined;
  return row ? mapStep(row) : undefined;
}

export function listSteps(jobId: string): Step[] {
  const rows = db
    .prepare(`SELECT * FROM steps WHERE job_id = ? ORDER BY step_index ASC`)
    .all(jobId) as StepRow[];
  return rows.map(mapStep);
}

/** 取已有步骤行（幂等重入），不存在则创建 pending 行 */
export function ensureStepRow(
  job: Job,
  stepIndex: number,
  name: string,
  requiresApproval: boolean,
): Step {
  const key = stepIdempotencyKey(job.id, stepIndex, name);
  const existing = getStepByKey(key);
  if (existing) return existing;

  db.prepare(
    `INSERT INTO steps (id, job_id, step_index, name, idempotency_key, status, requires_approval)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(ulid(), job.id, stepIndex, name, key, requiresApproval ? 1 : 0);

  const step = getStepByKey(key)!;
  bus.publish(job.id, { kind: 'step_update', step });
  return step;
}

export function updateStep(
  jobId: string,
  stepId: string,
  fields: Partial<{
    status: Step['status'];
    inputJson: string | null;
    outputJson: string | null;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    attempt: number;
  }>,
): Step {
  const f: string[] = [];
  const v: unknown[] = [];
  for (const [k, val] of Object.entries(fields)) {
    const col = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    f.push(`${col} = ?`);
    v.push(val);
  }
  db.prepare(`UPDATE steps SET ${f.join(', ')} WHERE id = ?`).run(...v, stepId);
  const row = db.prepare(`SELECT * FROM steps WHERE id = ?`).get(stepId) as StepRow;
  const step = mapStep(row);
  bus.publish(jobId, { kind: 'step_update', step });
  return step;
}

export function markStepStarted(jobId: string, stepId: string, inputJson: string, attempt = 1): Step {
  return updateStep(jobId, stepId, {
    status: 'running',
    inputJson,
    startedAt: nowIso(),
    error: null,
    attempt,
  });
}
