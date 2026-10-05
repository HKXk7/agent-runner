import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { JobStatus } from '@agent-runner/shared';
import { bus } from '../sse/bus.js';
import { listAudit } from '../audit/log.js';
import {
  createJob,
  getJob,
  listJobs,
  releaseLease,
  setJobStatus,
  updateBudget,
  isTerminal,
} from '../queue/jobs-repo.js';
import { listSteps } from '../steps/idempotency.js';
import {
  decideApproval,
  getApproval,
  listApprovals,
} from '../approvals/store.js';
import { listDigests, getDigest } from '../jobs/digest.js';
import { listDefinitions, getDefinition } from '../jobs/registry.js';
import { getProvider } from '../llm/provider.js';
import { db } from '../db/database.js';

export const api = new Hono();

// ---------- meta ----------
api.get('/meta', (c) =>
  c.json({
    provider: getProvider().name,
    definitions: listDefinitions().map((d) => ({
      type: d.type,
      description: d.description,
      defaultBudget: d.defaultBudget,
      steps: d.steps.map((s) => ({
        name: s.name,
        requiresApproval: typeof s.requiresApproval === 'function' ? 'dynamic' : !!s.requiresApproval,
      })),
    })),
  }),
);

// ---------- jobs ----------
api.get('/jobs', (c) => {
  const status = c.req.query('status') as JobStatus | undefined;
  return c.json(listJobs({ status }));
});

api.post('/jobs', async (c) => {
  const body = (await c.req.json()) as {
    type: string;
    name?: string;
    payload?: unknown;
    priority?: number;
    budgetTokens?: number;
    budgetCostUsd?: number;
    cronExpr?: string;
    idempotencyNs?: string;
    maxAttempts?: number;
  };
  const def = getDefinition(body.type);
  if (!def) return c.json({ error: `unknown job type: ${body.type}` }, 400);

  const { job, deduped } = createJob(
    {
      type: body.type,
      name: body.name ?? `${def.type}-${new Date().toISOString().slice(5, 16)}`,
      payload: body.payload ?? {},
      priority: body.priority ?? 0,
      budgetTokens: body.budgetTokens ?? def.defaultBudget.tokens,
      budgetCostUsd: body.budgetCostUsd ?? def.defaultBudget.costUsd,
      cronExpr: body.cronExpr,
      idempotencyNs: body.idempotencyNs,
      maxAttempts: body.maxAttempts,
    },
    'user',
  );
  return c.json({ job, deduped }, deduped ? 200 : 201);
});

api.get('/jobs/:id', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  return c.json({ job, steps: listSteps(job.id), approvals: listApprovals().filter((a) => a.jobId === job.id) });
});

api.post('/jobs/:id/cancel', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  if (isTerminal(job)) return c.json({ error: `job already ${job.status}` }, 409);
  releaseLease(job.id);
  const updated = setJobStatus(job.id, 'cancelled', {}, 'user');
  return c.json({ job: updated });
});

api.post('/jobs/:id/budget', async (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json()) as { budgetTokens?: number; budgetCostUsd?: number };
  // 领域层处理：breached 且预算已覆盖 -> 自动回 running 断点续跑
  const result = updateBudget(job.id, body.budgetTokens, body.budgetCostUsd, 'user');
  return c.json({ job: result.job, resumed: result.resumed });
});

// ---------- approvals ----------
api.get('/approvals', (c) =>
  c.json(listApprovals(c.req.query('status') as 'pending' | 'granted' | 'denied' | undefined)),
);

api.post('/approvals/:id/decide', async (c) => {
  const body = (await c.req.json()) as { decision: 'grant' | 'deny'; by?: string };
  if (body.decision !== 'grant' && body.decision !== 'deny') {
    return c.json({ error: 'decision must be grant|deny' }, 400);
  }
  try {
    // 领域层处理：grant -> paused_approval 回 running；deny -> 取消
    const { approval } = decideApproval(c.req.param('id'), body.decision, body.by ?? 'user');
    return c.json({ approval });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
});

// ---------- digests（收件箱） ----------
api.get('/digests', (c) => c.json(listDigests()));
api.get('/digests/:id', (c) => {
  const d = getDigest(c.req.param('id'));
  return d ? c.json(d) : c.json({ error: 'not found' }, 404);
});

// ---------- audit ----------
api.get('/audit', (c) =>
  c.json(listAudit(c.req.query('jobId') ?? '', Number(c.req.query('limit') ?? 200))),
);

// ---------- 成本面板聚合 ----------
api.get('/stats', (c) => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS totalJobs,
              COALESCE(SUM(used_tokens), 0) AS usedTokens,
              COALESCE(SUM(used_cost_usd), 0) AS usedCostUsd
       FROM jobs`,
    )
    .get() as Record<string, number>;
  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
    .all() as { status: string; n: number }[];
  const byType = db
    .prepare(
      `SELECT type, COUNT(*) AS jobs, COALESCE(SUM(used_tokens),0) AS tokens,
              COALESCE(SUM(used_cost_usd),0) AS costUsd
       FROM jobs GROUP BY type`,
    )
    .all() as Record<string, unknown>[];
  return c.json({ ...row, byStatus, byType });
});

// ---------- SSE ----------
/** 全局流：看板实时刷新 */
api.get('/stream', (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ kind: 'heartbeat', ts: Date.now() }) });
    const off = bus.subscribeAll(async (_jobId, ev) => {
      try {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      } catch {
        /* 连接已断 */
      }
    });
    const hb = setInterval(async () => {
      try {
        await stream.writeSSE({ event: 'ping', data: '{}' });
      } catch {
        /* noop */
      }
    }, 15_000);
    try {
      while (!stream.aborted) await stream.sleep(1000);
    } finally {
      clearInterval(hb);
      off();
    }
  }),
);

/** 单 job 流：详情页 trace 时间轴 */
api.get('/jobs/:id/stream', (c) => {
  const jobId = c.req.param('id');
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ kind: 'heartbeat', ts: Date.now() }) });
    const off = bus.subscribe(jobId, async (ev) => {
      try {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      } catch {
        /* 连接已断 */
      }
    });
    const hb = setInterval(async () => {
      try {
        await stream.writeSSE({ event: 'ping', data: '{}' });
      } catch {
        /* noop */
      }
    }, 15_000);
    try {
      while (!stream.aborted) await stream.sleep(1000);
    } finally {
      clearInterval(hb);
      off();
    }
  });
});
