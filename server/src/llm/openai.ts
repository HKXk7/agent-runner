import type { LLMProvider, LLMRequest, LLMResponse } from '@agent-runner/shared';

/**
 * OpenAI 兼容 provider（可选）：任何 /v1/chat/completions 兼容端点
 * （OpenAI / DeepSeek / 智谱 / 本地 vLLM 等）都可接。
 * env: OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
 */
// 与 MockProvider 同牌价口径；换模型请同步调整
const PRICE_IN = 0.15 / 1_000_000;
const PRICE_OUT = 0.6 / 1_000_000;

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;

  constructor(
    private key: string,
    private baseUrl: string,
    private model: string,
  ) {
    this.name = `openai-compat:${model}`;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.key}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          { role: 'user', content: req.prompt },
        ],
        max_tokens: req.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices[0]?.message?.content ?? '';
    const tokensIn = data.usage?.prompt_tokens ?? Math.ceil(req.prompt.length / 2);
    const tokensOut = data.usage?.completion_tokens ?? Math.ceil(text.length / 2);
    return {
      text,
      tokensIn,
      tokensOut,
      costUsd: tokensIn * PRICE_IN + tokensOut * PRICE_OUT,
    };
  }
}
