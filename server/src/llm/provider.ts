import type { LLMProvider } from '@agent-runner/shared';
import { MockProvider } from './mock.js';
import { OpenAICompatProvider } from './openai.js';

/**
 * Provider 路由：有 OPENAI_API_KEY 用真实模型，否则 Mock。
 * Mock 保证：零 key、零网络、确定性输出 —— demo/测试/CI 全链路可跑，
 * 且成本熔断机制可以用 mock 的模拟用量真实触发。
 */
let cached: LLMProvider | null = null;

export function getProvider(): LLMProvider {
  if (cached) return cached;
  cached = createProvider();
  return cached;
}

function createProvider(): LLMProvider {
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    console.log(`[llm] provider=openai-compat model=${model}`);
    return new OpenAICompatProvider(key, baseUrl, model);
  }
  console.log('[llm] provider=mock (set OPENAI_API_KEY to use a real model)');
  return new MockProvider();
}
