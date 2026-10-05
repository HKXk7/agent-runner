import type { Job } from '@agent-runner/shared';
import { appendAudit } from '../audit/log.js';
import { releaseLeaseWithAudit } from '../queue/lease.js';
import { setJobStatus } from '../queue/jobs-repo.js';

/**
 * ============================================================
 * 成本熔断（面试核心考点）
 *
 * 检查点在"每步完成后"：累加本步 token/金额 -> 立即对比预算。
 * 超限则 job -> breached（终态前的可恢复暂停态）+ 释放租约 + 审计。
 * 可恢复性：预算上调后 status 回 running，调度器重新拉起，
 * 已完成步骤被幂等跳过，从中断处续跑（不重复花钱）。
 * ============================================================
 */
export function isOverBudget(job: Job): boolean {
  return job.usedTokens > job.budgetTokens || job.usedCostUsd > job.budgetCostUsd;
}

export function breach(job: Job, workerId: string): void {
  releaseLeaseWithAudit(job.id, workerId);
  setJobStatus(job.id, 'breached', {}, workerId);
  appendAudit(job.id, 'budget_breach', workerId, {
    usedTokens: job.usedTokens,
    usedCostUsd: job.usedCostUsd,
    budgetTokens: job.budgetTokens,
    budgetCostUsd: job.budgetCostUsd,
  });
}
