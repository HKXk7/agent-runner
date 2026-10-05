import type { Approval, Job, Step } from '@agent-runner/shared';
import { ulid } from 'ulid';
import { db, nowIso } from '../db/database.js';
import { mapApproval } from '../db/rows.js';
import { appendAudit } from '../audit/log.js';
import { bus } from '../sse/bus.js';
import { getJob, setJobStatus, releaseLease, isTerminal } from '../queue/jobs-repo.js';

interface ApprovalRow {
  id: string; job_id: string; step_id: string | null; reason: string | null;
  status: string; requested_at: string; decided_at: string | null; decided_by: string | null;
}

function map(r: ApprovalRow): Approval {
  return mapApproval(r);
}

/**
 * ============================================================
 * 人工审批节点（面试核心考点）
 *
 * 难点：进程内 Promise/await 的等待状态无法在崩溃后幸存。
 * 解法：等待状态持久化到 approvals 表（pending 行）+ job 状态
 * paused_approval。worker 主动退出并释放租约；批准后
 * job 回 running（无租约），调度器重新拉起，靠步骤幂等
 * 从审批门处续跑 —— "等待" 不占用任何进程内资源。
 * ============================================================
 */
export type GateDecision = 'pending' | 'granted' | 'denied';

/** 幂等地为 (job, step) 取审批决定：无记录则创建 pending 并要求暂停 */
export function ensureApprovalGate(job: Job, step: Step, reason: string): GateDecision {
  const existing = db
    .prepare(`SELECT * FROM approvals WHERE job_id = ? AND step_id = ? LIMIT 1`)
    .get(job.id, step.id) as ApprovalRow | undefined;

  if (existing) return existing.status as GateDecision;

  const id = ulid();
  db.prepare(
    `INSERT INTO approvals (id, job_id, step_id, reason, status, requested_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, job.id, step.id, reason, nowIso());

  const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow;
  bus.publish(job.id, { kind: 'approval_update', approval: map(row) });
  appendAudit(job.id, 'approval_requested', 'worker', { stepId: step.id, stepName: step.name, reason });
  return 'pending';
}

export function listApprovals(status?: Approval['status']): Approval[] {
  const rows = status
    ? (db.prepare(`SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC`).all(status) as ApprovalRow[])
    : (db.prepare(`SELECT * FROM approvals ORDER BY requested_at DESC LIMIT 200`).all() as ApprovalRow[]);
  return rows.map(map);
}

export function getApproval(id: string): Approval | undefined {
  const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;
  return row ? map(row) : undefined;
}

/**
 * 批准/驳回（唯一入口：API 与冒烟测试都走这里）。
 * 批准 -> paused_approval 回 running（无租约），调度器重拉，幂等跳过已完成的步骤后续跑；
 * 驳回 -> job 取消。
 */
export function decideApproval(
  approvalId: string,
  decision: 'grant' | 'deny',
  by = 'user',
): { approval: Approval; job: Job | undefined } {
  const approval = getApproval(approvalId);
  if (!approval) throw new Error(`approval ${approvalId} not found`);
  if (approval.status !== 'pending') throw new Error(`approval already ${approval.status}`);

  const status = decision === 'grant' ? 'granted' : 'denied';
  db.prepare(
    `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
  ).run(status, nowIso(), by, approvalId);

  const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(approvalId) as ApprovalRow;
  const updated = map(row);
  bus.publish(approval.jobId, { kind: 'approval_update', approval: updated });
  appendAudit(approval.jobId, decision === 'grant' ? 'approval_granted' : 'approval_denied', by, {
    approvalId,
  });

  // ---- 任务状态转换（领域逻辑收口在此） ----
  const job = getJob(approval.jobId);
  if (job && !isTerminal(job)) {
    if (decision === 'grant' && job.status === 'paused_approval') {
      setJobStatus(job.id, 'running', {}, by);
    } else if (decision === 'deny') {
      releaseLease(job.id);
      setJobStatus(job.id, 'cancelled', {}, by);
      appendAudit(job.id, 'job_cancelled', by, { reason: 'approval denied' });
    }
  }
  return { approval: updated, job: getJob(approval.jobId) };
}
