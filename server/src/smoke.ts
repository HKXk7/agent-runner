import { runMigrations } from './db/migrate.js';
import { tick } from './queue/scheduler.js';
import { createJob, getJob, updateBudget } from './queue/jobs-repo.js';
import { listApprovals, decideApproval } from './approvals/store.js';
import { listSteps } from './steps/idempotency.js';
import { listDigests } from './jobs/digest.js';
import { proveAppendOnly, listAudit } from './audit/log.js';
import { getDefinition, register } from './jobs/registry.js';
import { db } from './db/database.js';
import type { JobDefinition } from '@agent-runner/shared';

/**
 * 冒烟测试：不开 HTTP，直接驱动调度循环，覆盖五大机制：
 *   A. 审批门：paused_approval -> grant -> 续跑 -> done（含收件箱落盘）
 *   B. 成本熔断：小预算 -> breached；预算上调 -> 断点续跑 -> done
 *   C. 幂等重放：breach 恢复后已完成步骤不重复执行
 *   D. 审计不可篡改：UPDATE audit_events 必须被触发器 ABORT
 *   E. 全链路 mock：零 API key
 */
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// ---- flaky job：验证步级 / 任务级重试机制 ----
let stepFlakyCounter = 0;
let jobFlakyCounter = 0;

// 步级重试：同一次 job 执行内，flaky 步前 2 次失败、第 3 次成功（maxRetries=2）
const stepRetryJob: JobDefinition = {
  type: 'smoke_step_retry',
  description: 'smoke 专用：步级重试',
  defaultBudget: { tokens: 100_000, costUsd: 1 },
  steps: [
    {
      name: 'flaky_step',
      maxRetries: 2,
      retryDelayMs: 30,
      async run(ctx) {
        stepFlakyCounter++;
        if (stepFlakyCounter < 3) throw new Error(`flaky fail #${stepFlakyCounter}`);
        return { output: { ok: true, attempts: stepFlakyCounter } };
      },
    },
  ],
};

// 任务级重试：首次执行必失败（无步级重试），job 回 pending 重跑后第二次成功
const jobRetryJob: JobDefinition = {
  type: 'smoke_job_retry',
  description: 'smoke 专用：任务级重试',
  defaultBudget: { tokens: 100_000, costUsd: 1 },
  steps: [
    {
      name: 'flaky_step',
      maxRetries: 0,
      async run() {
        jobFlakyCounter++;
        if (jobFlakyCounter === 1) throw new Error('first run fails');
        return { output: { ok: true, run: jobFlakyCounter } };
      },
    },
  ],
};

async function waitJobTerminalOr(id: string, statuses: string[], timeoutMs = 15_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const j = getJob(id);
    if (j && statuses.includes(j.status)) return j.status;
    if (Date.now() - t0 > timeoutMs) return j?.status ?? 'missing';
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  console.log('=== Agent Runner smoke test (mock provider, zero API key) ===\n');
  runMigrations();
  register(stepRetryJob);
  register(jobRetryJob);

  // ---------- A. 审批门 ----------
  console.log('[A] approval gate');
  const { job: a } = createJob({
    type: 'demo_pipeline',
    name: 'smoke-approval',
    payload: { topic: 'smoke', approve: true },
    priority: 100,
    budgetTokens: getDefinition('demo_pipeline')!.defaultBudget.tokens,
    budgetCostUsd: getDefinition('demo_pipeline')!.defaultBudget.costUsd,
  }, 'smoke');
  await tick();
  let status = await waitJobTerminalOr(a.id, ['paused_approval', 'done', 'failed']);
  ok('A1 job paused at approval gate', status === 'paused_approval', `status=${status}`);

  const pending = listApprovals('pending');
  ok('A2 pending approval exists', pending.length === 1);
  decideApproval(pending[0]!.id, 'grant', 'smoke');
  ok('A3 approval granted -> job back to running', getJob(a.id)?.status === 'running');

  await tick();
  status = await waitJobTerminalOr(a.id, ['done', 'failed']);
  ok('A4 job resumed and done', status === 'done', `status=${status}`);
  ok(
    'A5 digest written to inbox',
    listDigests().some((d) => d.jobId === a.id),
  );

  // ---------- B. 成本熔断 + 恢复 ----------
  console.log('\n[B] cost circuit breaker + resume');
  const { job: b } = createJob({
    type: 'demo_pipeline',
    name: 'smoke-breach',
    payload: { topic: 'smoke-breach' },
    priority: 90,
    budgetTokens: 10, // analyze 步必然超出
    budgetCostUsd: getDefinition('demo_pipeline')!.defaultBudget.costUsd,
  }, 'smoke');
  await tick();
  status = await waitJobTerminalOr(b.id, ['breached', 'done', 'failed']);
  ok('B1 tiny budget -> breached', status === 'breached', `status=${status}, usedTokens=${getJob(b.id)?.usedTokens}`);

  const stepsBefore = listSteps(b.id);
  const doneBefore = stepsBefore.filter((s) => s.status === 'done').map((s) => s.name);
  ok('B2 collect/analyze done before breach', doneBefore.includes('collect') && doneBefore.includes('analyze'), doneBefore.join(','));

  updateBudget(b.id, 100_000, undefined, 'smoke'); // 上调预算 -> running
  ok('B3 budget raised -> running', getJob(b.id)?.status === 'running');
  await tick();
  status = await waitJobTerminalOr(b.id, ['done', 'failed']);
  ok('B4 resumed from breakpoint -> done', status === 'done', `status=${status}`);

  // ---------- C. 幂等重放 ----------
  console.log('\n[C] idempotent replay');
  const stepsAfter = listSteps(b.id);
  const analyzeAfter = stepsAfter.find((s) => s.name === 'analyze');
  const analyzeBefore = stepsBefore.find((s) => s.name === 'analyze');
  ok(
    'C1 analyze step output unchanged after replay (idempotent)',
    !!analyzeAfter?.outputJson && analyzeAfter?.outputJson === analyzeBefore?.outputJson,
  );
  const audits = listAudit(b.id, 500);
  ok(
    'C2 step_skipped audit events present',
    audits.some((e) => e.type === 'step_skipped'),
  );

  // ---------- D. 审计不可篡改 ----------
  console.log('\n[D] append-only audit');
  const proof = proveAppendOnly();
  ok('D1 UPDATE audit_events aborted by trigger', proof.protected && proof.error.includes('append-only'), proof.error.slice(0, 80));

  // ---------- E. lease 记录 ----------
  console.log('\n[E] audit trail sanity');
  ok(
    'E1 full lifecycle audited',
    ['job_created', 'lease_acquired', 'step_start', 'step_done', 'job_done', 'budget_breach'].every((t) =>
      listAudit(b.id, 500).some((e) => e.type === t) || t === 'job_done' || t === 'budget_breach' ? listAudit(b.id, 500).some((e) => e.type === t) : false,
    ),
  );

  // ---------- F. 步级重试 + 指数退避 ----------
  console.log('\n[F] step-level retry (exponential backoff)');
  const { job: f } = createJob({
    type: 'smoke_step_retry',
    name: 'smoke-step-retry',
    payload: {},
    priority: 80,
    budgetTokens: 100_000,
    budgetCostUsd: 1,
  }, 'smoke');
  await tick();
  status = await waitJobTerminalOr(f.id, ['done', 'failed'], 10_000);
  ok('F1 flaky step retried to success', status === 'done', `status=${status}`);
  ok('F2 step_retry audit events present', listAudit(f.id, 500).some((e) => e.type === 'step_retry'));
  const stepF = listSteps(f.id)[0];
  ok('F3 final step attempt = 3', stepF?.attempt === 3, `attempt=${stepF?.attempt}`);

  // ---------- G. 任务级重试（maxAttempts） ----------
  console.log('\n[G] job-level retry (maxAttempts)');
  const { job: g } = createJob({
    type: 'smoke_job_retry',
    name: 'smoke-job-retry',
    payload: {},
    priority: 70,
    budgetTokens: 100_000,
    budgetCostUsd: 1,
    maxAttempts: 2,
  }, 'smoke');
  // 第一次执行会失败 -> job 回 pending 重跑 -> 第二次成功
  const t0 = Date.now();
  for (;;) {
    await tick();
    const j = getJob(g.id);
    if (j && (j.status === 'done' || j.status === 'failed')) break;
    if (Date.now() - t0 > 10_000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('G1 job retried then done', getJob(g.id)?.status === 'done', `status=${getJob(g.id)?.status}`);
  ok('G2 job_retry audit event present', listAudit(g.id, 500).some((e) => e.type === 'job_retry'));
  ok('G3 job attempt = 1 (failed once, retried to success)', getJob(g.id)?.attempt === 1, `attempt=${getJob(g.id)?.attempt}`);

  // ---------- H. 推送降级（无外部凭据时走 FileChannel） ----------
  console.log('\n[H] push channel fallback');
  // dispatchPush 是异步 fire-and-forget，给一个微任务时间窗
  await new Promise((r) => setTimeout(r, 100));
  const pushSent = db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE type = 'push_sent'`).get() as { n: number };
  ok('H1 push_sent audit present (file fallback, no creds)', pushSent.n > 0, `push_sent=${pushSent.n}`);

  const counts = db.prepare(`SELECT COUNT(*) n FROM audit_events`).get() as { n: number };
  console.log(`\n=== done: ${counts.n} audit events recorded ===`);
  process.exit(process.exitCode ?? 0);
}

void main();
