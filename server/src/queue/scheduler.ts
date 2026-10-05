import { runJob } from './worker.js';
import { acquireJob, recoverExpiredLeases, WORKER_ID } from './lease.js';

/**
 * 并发调度循环。
 *
 * 模型：一个 worker 进程（一个 WORKER_ID），可并发执行多个 job 槽位。
 *   - acquireJob 是同步的（better-sqlite3 单连接串行），抢占原子安全，等价 PG SKIP LOCKED；
 *   - runJob 是异步的（LLM/网络/退避等待），多个 job 并发跑，提升吞吐。
 *
 * 多 worker 水平扩展两条路：
 *   1. 单进程并发：AGENT_RUNNER_CONCURRENCY=N（默认 1，向后兼容 MVP）
 *   2. 多进程：跑多个 server 实例共享同一 SQLite（WAL + busy_timeout），
 *      每个实例一个 WORKER_ID，lease 原子抢占天然防双跑。
 */
const CONCURRENCY = Math.max(1, Number(process.env.AGENT_RUNNER_CONCURRENCY ?? 1));

const running = new Set<Promise<void>>();

export function activeCount(): number {
  return running.size;
}

export async function tick(): Promise<void> {
  try {
    // 崩溃 worker 的过期租约自愈
    recoverExpiredLeases();

    // 填充到并发上限；无更多可抢占 job 时退出本轮
    while (running.size < CONCURRENCY) {
      const job = acquireJob(WORKER_ID);
      if (!job) break;
      const p = runJob(job).finally(() => running.delete(p));
      running.add(p);
    }
  } catch (err) {
    console.error('[scheduler] tick error:', err);
  }
}

export function startScheduler(intervalMs = 1000): void {
  console.log(
    `[scheduler] started, worker=${WORKER_ID}, concurrency=${CONCURRENCY}, interval=${intervalMs}ms`,
  );
  setInterval(() => {
    void tick();
  }, intervalMs);
}
