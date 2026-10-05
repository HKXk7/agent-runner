import type { JobDefinition } from '@agent-runner/shared';
import { writeDigest } from './digest.js';

export interface DemoPayload {
  topic?: string;
  approve?: boolean; // 为 true 时 publish 步骤前需要人工审批
}

/**
 * demo_pipeline —— 30 秒演示全部机制的三步流水线：
 *   collect（纯计算） -> analyze（LLM，产生真实 token/成本）
 *   -> publish（写收件箱；payload.approve=true 时挂审批门）
 */
export const demoPipeline: JobDefinition = {
  type: 'demo_pipeline',
  description: '演示流水线：collect -> analyze(LLM) -> publish(digest)，可开审批门',
  defaultBudget: { tokens: 50_000, costUsd: 0.1 },
  steps: [
    {
      name: 'collect',
      async run(ctx) {
        const p = (ctx.payload ?? {}) as DemoPayload;
        const topic = p.topic ?? 'agent-reliability';
        // 模拟数据采集
        const items = Array.from({ length: 5 }, (_, i) => ({
          id: i + 1,
          topic,
          score: ((i * 37) % 100) / 100,
          source: `fixture-${i + 1}`,
        }));
        return { output: { topic, items, collectedAt: new Date().toISOString() } };
      },
    },
    {
      name: 'analyze',
      async run(ctx) {
        const prev = ctx.prev as { topic: string; items: { id: number; score: number }[] };
        const prompt = [
          `请分析以下关于「${prev.topic}」的采集数据，输出要点：`,
          ...prev.items.map((it) => `- [数据] 条目${it.id} 得分 ${it.score}`),
        ].join('\n');
        const res = await ctx.llm.complete({
          system: '你是数据分析助手，输出简明要点。',
          prompt,
        });
        return { output: { analysis: res.text, itemsAnalyzed: prev.items.length }, usage: { tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd } };
      },
    },
    {
      name: 'publish',
      requiresApproval: (payload) => ((payload ?? {}) as DemoPayload).approve === true,
      async run(ctx) {
        const prev = ctx.prev as { analysis: string };
        const p = (ctx.payload ?? {}) as DemoPayload;
        const title = `Demo 分析报告 - ${p.topic ?? 'agent-reliability'} - ${new Date().toLocaleString('zh-CN')}`;
        const digest = writeDigest(ctx.jobId, title, prev.analysis);
        return { output: { digestId: digest.id, title } };
      },
    },
  ],
};
