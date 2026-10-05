import {
  stepRequiresApproval,
  type Job,
  type JobDefinition,
  type JobRunContext,
  type Step,
  type StepSpec,
} from '@agent-runner/shared';
import { appendAudit } from '../audit/log.js';
import { bus } from '../sse/bus.js';
import { getProvider } from '../llm/provider.js';
import { getDefinition } from '../jobs/registry.js';
import { getJob, setJobStatus, accrueCost, resolveJobFailure } from './jobs-repo.js';
import { renewLease, releaseLeaseWithAudit, WORKER_ID } from './lease.js';
import {
  ensureStepRow,
  getStepByKey,
  markStepStarted,
  updateStep,
} from '../steps/idempotency.js';
import { isOverBudget, breach } from '../steps/cost.js';
import { ensureApprovalGate } from '../approvals/store.js';

/**
 * ============================================================
 * Worker 执行引擎（面试核心考点：长任务如何可靠跑完）
 *
 * 每个步骤的完整防护序列：
 *   0. 归属检查   —— job 仍被我持有且 status=running（可能被取消/回收）
 *   1. 幂等跳过   —— 该步已 done 则直接复用 output（at-least-once 去重）
 *   2. 审批门     —— 需审批则持久化 pending 审批 + job 暂停 + 释放租约退出
 *   3. 执行 + 步级重试 —— 失败按指数退避重试 maxRetries 次（attempt 持久化）
 *   4. 成本累加   —— 步完成即累加，超预算 -> breached + 释放租约退出
 *   5. 失败收口   —— 步重试耗尽 -> job 级重试（attempt 未用尽回 pending）或终态 failed
 * 全程写审计事件 + SSE 推流。
 * ============================================================
 */
export async function runJob(job: Job): Promise<void> {
  const def: JobDefinition | undefined = getDefinition(job.type);
  if (!def) {
    await failJobTerminal(job.id, `unknown job type: ${job.type}`);
    return;
  }

  // 心跳：步内任意长操作期间维持租约有效（LEASE_TTL/3 续一次）
  const heartbeat = setInterval(() => {
    renewLease(job.id, WORKER_ID); // 续约失败=租约被回收，归属检查会兜底
  }, 10_000);

  try {
    const bag = new Map<string, unknown>();
    let prev: unknown = null;

    for (let i = 0; i < def.steps.length; i++) {
      const spec = def.steps[i]!;

      // ---- 0. 归属检查 ----
      const cur = getJob(job.id);
      if (!cur || cur.status !== 'running' || cur.leaseOwner !== WORKER_ID) {
        return; // 已被取消 / 租约被回收 / 其他状态
      }

      // ---- 1. 幂等跳过 ----
      const stepRow = ensureStepRow(cur, i, spec.name, stepRequiresApproval(spec, cur.payload));
      if (stepRow.status === 'done') {
        appendAudit(job.id, 'step_skipped', WORKER_ID, {
          stepIndex: i,
          name: spec.name,
          reason: 'idempotent replay: step already done',
        });
        prev = stepRow.outputJson ? JSON.parse(stepRow.outputJson) : null;
        continue;
      }

      // ---- 2. 审批门 ----
      if (stepRequiresApproval(spec, cur.payload)) {
        const gate = ensureApprovalGate(
          cur,
          stepRow,
          `Step "${spec.name}" (#{i + 1}) of job "${cur.name}" requires human approval before execution.`,
        );
        if (gate === 'pending') {
          releaseLeaseWithAudit(job.id, WORKER_ID);
          setJobStatus(job.id, 'paused_approval', {}, WORKER_ID);
          return; // 等待批准，调度器稍后重拉
        }
        if (gate === 'denied') {
          setJobStatus(job.id, 'cancelled', {}, WORKER_ID);
          appendAudit(job.id, 'job_cancelled', WORKER_ID, { reason: 'approval denied' });
          return;
        }
        // granted -> 继续执行本步
      }

      // ---- 3. 执行（含步级重试 + 指数退避） ----
      const result = await runStepWithRetry(cur, spec, i, prev, bag);
      if (result === null) return; // 重试耗尽已转 job 失败/重试，或归属丢失

      // ---- 4. 成本累加 + 熔断 ----
      const usage = result.usage ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
      const after = accrueCost(job.id, usage);
      if (isOverBudget(after)) {
        breach(after, WORKER_ID);
        return;
      }
      prev = result.output;
    }

    // 全部步骤完成
    releaseLeaseWithAudit(job.id, WORKER_ID);
    setJobStatus(job.id, 'done', {}, WORKER_ID);
    appendAudit(job.id, 'job_done', WORKER_ID, {
      usedTokens: getJob(job.id)?.usedTokens,
      usedCostUsd: getJob(job.id)?.usedCostUsd,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * 执行单个步骤，带步级重试 + 指数退避。
 * 返回 StepResult；若返回 null 表示本 job 已进入其他状态（失败/重试/取消），调用方应直接 return。
 */
async function runStepWithRetry(
  job: Job,
  spec: StepSpec,
  stepIndex: number,
  prev: unknown,
  bag: Map<string, unknown>,
): Promise<{ output: unknown; usage: { tokensIn: number; tokensOut: number; costUsd: number } } | null> {
  const maxRetries = spec.maxRetries ?? 0;
  const retryDelayMs = spec.retryDelayMs ?? 1000;
  const stepRow = getStepByKey(`${job.id}:${String(stepIndex).padStart(3, '0')}:${spec.name}`)!;

  const ctx: JobRunContext = {
    jobId: job.id,
    payload: job.payload,
    prev,
    bag,
    llm: getProvider(),
    log: (msg) => appendAudit(job.id, 'step_start', WORKER_ID, { stepIndex, name: spec.name, msg }),
  };

  let attempt = 0;
  for (;;) {
    // 重试前重新检查归属（退避等待期间 job 可能被取消/回收）
    const cur = getJob(job.id);
    if (!cur || cur.status !== 'running' || cur.leaseOwner !== WORKER_ID) return null;

    attempt++;
    markStepStarted(job.id, stepRow.id, JSON.stringify({ prev: truncate(prev) }), attempt);
    appendAudit(job.id, 'step_start', WORKER_ID, { stepIndex, name: spec.name, attempt });

    try {
      const result = await spec.run(ctx);
      const usage = result.usage ?? { tokensIn: 0, tokensOut: 0, costUsd: 0 };
      updateStep(job.id, stepRow.id, {
        status: 'done',
        outputJson: JSON.stringify(truncate(result.output)),
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.costUsd,
        finishedAt: new Date().toISOString(),
        attempt,
      });
      appendAudit(job.id, 'step_done', WORKER_ID, {
        stepIndex,
        name: spec.name,
        attempt,
        ...usage,
      });
      return { output: result.output, usage };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (attempt <= maxRetries) {
        // 步级重试：置回 pending，指数退避后重试（attempt 已持久化，崩溃可续）
        updateStep(job.id, stepRow.id, { status: 'pending', error: msg, attempt });
        const delay = retryDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
        appendAudit(job.id, 'step_retry', WORKER_ID, {
          stepIndex,
          name: spec.name,
          attempt,
          maxRetries,
          delayMs: delay,
          error: msg,
        });
        await sleep(delay);
        continue;
      }

      // 重试耗尽 -> 步终态 failed，再走 job 级重试/失败收口
      updateStep(job.id, stepRow.id, {
        status: 'failed',
        error: msg,
        finishedAt: new Date().toISOString(),
        attempt,
      });
      appendAudit(job.id, 'step_failed', WORKER_ID, {
        stepIndex,
        name: spec.name,
        attempt,
        error: msg,
      });
      resolveJobFailure(job.id, `step "${spec.name}" failed after ${attempt} attempt(s): ${msg}`, WORKER_ID);
      return null;
    }
  }
}

async function failJobTerminal(jobId: string, message: string): Promise<void> {
  resolveJobFailure(jobId, message, WORKER_ID);
}

/** output JSON 序列化前的体积保护（超大 HTML 等只存前 32KB） */
function truncate(v: unknown, max = 32_000): unknown {
  const s = JSON.stringify(v ?? null);
  if (s.length <= max) return v ?? null;
  return { _truncated: true, preview: s.slice(0, max) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 保留 bus 引用避免未使用告警（步骤事件由 idempotency/store 层发布）
void bus;
