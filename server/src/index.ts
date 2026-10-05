import { runMigrations } from './db/migrate.js';
import { buildApp, startHttpServer } from './http/app.js';
import { startScheduler } from './queue/scheduler.js';
import { createJob } from './queue/jobs-repo.js';
import { getDefinition } from './jobs/registry.js';
import { getProvider } from './llm/provider.js';
import cron from 'node-cron';

async function main(): Promise<void> {
  runMigrations();
  getProvider(); // 初始化并打印 provider 选择

  const app = buildApp();
  startHttpServer(app);
  startScheduler();

  // 每日 07:30 自动入队 school_notice（幂等 ns 防重复；默认 mock fixture，零 key）
  const cronEnabled = process.env.AGENT_RUNNER_CRON !== '0';
  if (cronEnabled) {
    const def = getDefinition('school_notice')!;
    cron.schedule('30 7 * * *', () => {
      const day = new Date().toISOString().slice(0, 10);
      createJob(
        {
          type: 'school_notice',
          name: `校园通知日报-${day}`,
          payload: { approve: false }, // 定时任务无人值守时不挂审批门，改事后看审计
          priority: 5,
          budgetTokens: def.defaultBudget.tokens,
          budgetCostUsd: def.defaultBudget.costUsd,
          idempotencyNs: `daily-${day}`, // 同一天重复触发只入队一次
          maxAttempts: 2, // 网络抓取类任务：瞬时故障自动重跑一次
        },
        'cron',
      );
      console.log(`[cron] enqueued school_notice for ${day}`);
    });
    console.log('[cron] school_notice scheduled at 07:30 daily (AGENT_RUNNER_CRON=0 to disable)');
  }
}

void main();
