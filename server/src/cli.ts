import { runMigrations } from './db/migrate.js';
import { createJob, listJobs } from './queue/jobs-repo.js';
import { getDefinition } from './jobs/registry.js';

/**
 * CLI 入队（不启动 HTTP/scheduler，只写 DB；server 的调度器会自动接手）：
 *   npm run enqueue -- demo_pipeline
 *   npm run enqueue -- demo_pipeline --payload '{"approve":true}'
 *   npm run enqueue -- school_notice --payload '{"approve":true}'
 *   npm run enqueue -- demo_pipeline --budget-tokens 10   # 小预算演示熔断
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

const [cmd, type] = process.argv.slice(2);
runMigrations();

if (cmd === 'list') {
  for (const j of listJobs({ limit: 30 })) {
    console.log(
      `${j.id}  ${j.status.padEnd(16)} ${j.type.padEnd(16)} tok=${j.usedTokens}/${j.budgetTokens} $${j.usedCostUsd.toFixed(5)}/${j.budgetCostUsd}`,
    );
  }
  process.exit(0);
}

if (cmd !== 'enqueue' || !type) {
  console.log('usage: cli.ts enqueue <type> [--payload json] [--name s] [--budget-tokens n] [--budget-cost n] [--priority n] [--max-attempts n] | cli.ts list');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(3));
const def = getDefinition(type);
if (!def) {
  console.error(`unknown type: ${type}`);
  process.exit(1);
}

const { job, deduped } = createJob(
  {
    type,
    name: (args['name'] as string) ?? `${type}-${new Date().toISOString().slice(5, 16)}`,
    payload: args['payload'] ? JSON.parse(args['payload'] as string) : {},
    priority: Number(args['priority'] ?? 0) || 0,
    budgetTokens: args['budget-tokens'] ? Number(args['budget-tokens']) : def.defaultBudget.tokens,
    budgetCostUsd: args['budget-cost'] ? Number(args['budget-cost']) : def.defaultBudget.costUsd,
    maxAttempts: args['max-attempts'] ? Number(args['max-attempts']) : 1,
  },
  'cli',
);

console.log(deduped ? `[cli] deduped -> existing job ${job.id}` : `[cli] enqueued ${job.id} (${job.type})`);
